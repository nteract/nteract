//! Admission and lifetime tracking for callbacks which may attach to Python.
//!
//! This module has no Python/runtime dependencies so its shutdown ordering can
//! also be tested without loading an interpreter or starting a runtime.

use std::cell::Cell;
use std::sync::{Arc, Condvar, Mutex};

thread_local! {
    static CALLBACK_DEPTH: Cell<usize> = const { Cell::new(0) };
}

pub(super) fn in_callback() -> bool {
    CALLBACK_DEPTH.get() != 0
}

struct CallbackThread;

impl Drop for CallbackThread {
    fn drop(&mut self) {
        CALLBACK_DEPTH.set(CALLBACK_DEPTH.get() - 1);
    }
}

#[derive(Default)]
struct State {
    closed: bool,
    active: usize,
}

#[derive(Default)]
pub(super) struct Deliveries {
    state: Mutex<State>,
    drained: Condvar,
}

impl Deliveries {
    pub(super) fn is_closed(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).closed
    }

    /// Admit before enqueue, so shutdown also waits for queued callbacks.
    pub(super) fn admit(self: &Arc<Self>) -> Option<Permit> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return None;
        }
        state.active += 1;
        Some(Permit(Arc::clone(self)))
    }

    pub(super) fn close(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
    }

    /// Must run detached from Python: admitted callbacks may need the GIL.
    pub(super) fn wait(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.active != 0 {
            state = self.drained.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }
}

pub(super) struct Permit(Arc<Deliveries>);

impl Permit {
    pub(super) fn wrap<F: FnOnce()>(self, callback: F) -> Callback<F> {
        Callback {
            callback,
            permit: self,
        }
    }
}

pub(super) struct Callback<F> {
    // Field order also protects callbacks dropped without ever being run.
    callback: F,
    permit: Permit,
}

impl<F: FnOnce()> Callback<F> {
    pub(super) fn run(self) {
        let Self { callback, permit } = self;
        // callback owns all Python captures. They (and its attachment guard)
        // must be destroyed before the permit, including during unwinding.
        let _permit = permit;
        CALLBACK_DEPTH.set(CALLBACK_DEPTH.get() + 1);
        let _callback_thread = CallbackThread;
        callback();
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.active -= 1;
        if state.active == 0 {
            self.0.drained.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Barrier};
    use std::thread;

    #[test]
    fn close_rejects_admission_and_is_idempotent() {
        let deliveries = Arc::new(Deliveries::default());
        deliveries.close();
        deliveries.close();
        assert!(deliveries.is_closed());
        assert!(deliveries.admit().is_none());
        deliveries.wait();
        deliveries.wait();
    }

    #[test]
    fn queued_callback_is_counted_before_it_runs() {
        let deliveries = Arc::new(Deliveries::default());
        let queued = deliveries.admit().unwrap();
        deliveries.close();
        assert_eq!(deliveries.state.lock().unwrap().active, 1);
        assert!(deliveries.admit().is_none());
        queued.wrap(|| {}).run();
        deliveries.wait();
        assert_eq!(deliveries.state.lock().unwrap().active, 0);
    }

    #[test]
    fn capture_drops_before_permit_on_return_and_unwind() {
        struct Capture(Arc<Deliveries>);
        impl Drop for Capture {
            fn drop(&mut self) {
                assert_eq!(self.0.state.lock().unwrap().active, 1);
            }
        }
        for panic in [false, true] {
            let deliveries = Arc::new(Deliveries::default());
            let permit = deliveries.admit().unwrap();
            let capture = Capture(Arc::clone(&deliveries));
            let result = std::panic::catch_unwind(move || {
                permit
                    .wrap(move || {
                        let _capture = capture;
                        assert!(in_callback());
                        assert!(!panic, "exercise callback unwind");
                    })
                    .run();
            });
            assert_eq!(result.is_err(), panic);
            assert!(!in_callback());
            deliveries.close();
            deliveries.wait();
            assert_eq!(deliveries.state.lock().unwrap().active, 0);
        }
    }

    #[test]
    fn drain_waits_for_active_callback_and_wakes_all_waiters() {
        let deliveries = Arc::new(Deliveries::default());
        let permit = deliveries.admit().unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            permit
                .wrap(|| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
                .run();
        });
        entered_rx.recv().unwrap();
        deliveries.close();
        let (done_tx, done_rx) = mpsc::channel();
        let (waiting_tx, waiting_rx) = mpsc::channel();
        let waiters: Vec<_> = (0..2)
            .map(|_| {
                let deliveries = Arc::clone(&deliveries);
                let done_tx = done_tx.clone();
                let waiting_tx = waiting_tx.clone();
                thread::spawn(move || {
                    waiting_tx.send(()).unwrap();
                    deliveries.wait();
                    done_tx.send(()).unwrap();
                })
            })
            .collect();
        for _ in 0..2 {
            waiting_rx.recv().unwrap();
        }
        assert!(matches!(
            done_rx.recv_timeout(std::time::Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        for waiter in waiters {
            waiter.join().unwrap();
            done_rx.recv().unwrap();
        }
    }

    #[test]
    fn queued_callback_capture_drops_before_permit_without_running() {
        struct Capture(Arc<Deliveries>);
        impl Drop for Capture {
            fn drop(&mut self) {
                assert_eq!(self.0.state.lock().unwrap().active, 1);
            }
        }
        let deliveries = Arc::new(Deliveries::default());
        let permit = deliveries.admit().unwrap();
        let capture = Capture(Arc::clone(&deliveries));
        let callback = permit.wrap(move || {
            drop(capture);
            panic!("queued callback must not run");
        });
        deliveries.close();
        drop(callback);
        deliveries.wait();
    }

    #[test]
    fn admission_racing_close_is_either_rejected_or_counted() {
        for _ in 0..32 {
            let deliveries = Arc::new(Deliveries::default());
            let start = Arc::new(Barrier::new(2));
            let worker = {
                let deliveries = Arc::clone(&deliveries);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    deliveries.admit()
                })
            };
            start.wait();
            deliveries.close();
            let permit = worker.join().unwrap();
            assert_eq!(
                deliveries.state.lock().unwrap().active,
                usize::from(permit.is_some())
            );
            assert!(deliveries.admit().is_none());
            drop(permit);
            deliveries.wait();
        }
    }
}
