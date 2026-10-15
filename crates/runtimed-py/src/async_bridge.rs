//! Keep result delivery alive until Python has finished using its captures.
//!
//! A Future can wake its event loop inside call_soon_threadsafe's socket write,
//! before the worker re-acquires the GIL and drops TaskLocals. Python must not
//! finalize in that interval: CPython can force the worker to exit while PyO3's
//! attachment guard still exists. Drain these callbacks at atexit, not RPCs or
//! the process-wide Tokio runtime. This retains the extension's existing single
//! interpreter lifetime; it does not add subinterpreter/reinitialization support.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};

use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3_async_runtimes::generic::{ContextExt, Runtime};
use pyo3_async_runtimes::{tokio as py_tokio, TaskLocals};

mod delivery;
use delivery::Deliveries;

static DELIVERIES: LazyLock<Arc<Deliveries>> = LazyLock::new(Arc::default);

struct DeliveryRuntime;

tokio::task_local! {
    static TASK_LOCALS: TaskLocals;
}

impl Runtime for DeliveryRuntime {
    type JoinError = tokio::task::JoinError;
    type JoinHandle = tokio::task::JoinHandle<()>;

    fn spawn<F>(future: F) -> Self::JoinHandle
    where
        F: Future<Output = ()> + Send + 'static,
    {
        py_tokio::get_runtime().spawn(future)
    }

    fn spawn_blocking<F>(callback: F) -> Self::JoinHandle
    where
        F: FnOnce() + Send + 'static,
    {
        // Upstream calls this from unattached Rust tasks for both normal and
        // panic delivery. Late captures can therefore use PyO3's deferred drop
        // path without executing Python after admission closes.
        match DELIVERIES.admit() {
            Some(permit) => {
                let callback = permit.wrap(callback);
                py_tokio::get_runtime().spawn_blocking(move || callback.run())
            }
            None => {
                drop(callback);
                py_tokio::get_runtime().spawn(async {})
            }
        }
    }
}

impl ContextExt for DeliveryRuntime {
    fn scope<F, R>(locals: TaskLocals, future: F) -> Pin<Box<dyn Future<Output = R> + Send>>
    where
        F: Future<Output = R> + Send + 'static,
    {
        // Keep the public Tokio context helpers working inside the future as
        // well as generic helpers parameterized with our delivery runtime.
        Box::pin(async move {
            TASK_LOCALS
                .scope(locals.clone(), py_tokio::scope(locals, future))
                .await
        })
    }

    fn get_task_locals() -> Option<TaskLocals> {
        TASK_LOCALS.try_with(Clone::clone).ok()
    }
}

pub(crate) fn future_into_py<F, T>(py: Python<'_>, future: F) -> PyResult<Bound<'_, PyAny>>
where
    F: Future<Output = PyResult<T>> + Send + 'static,
    T: for<'py> IntoPyObject<'py> + Send + 'static,
{
    if DELIVERIES.is_closed() {
        return Err(PyRuntimeError::new_err(
            "runtimed async result delivery is shutting down",
        ));
    }
    pyo3_async_runtimes::generic::future_into_py_with_locals::<DeliveryRuntime, _, _>(
        py,
        py_tokio::get_current_locals(py)?,
        future,
    )
}

#[pyfunction]
fn _drain_async_deliveries(py: Python<'_>) -> PyResult<()> {
    if delivery::in_callback() {
        return Err(PyRuntimeError::new_err(
            "cannot drain runtimed async deliveries from a delivery callback",
        ));
    }
    DELIVERIES.close();
    // Never resume finalization with a live delivery, and never hold the GIL
    // while waiting for a callback that may need it. Closing is idempotent.
    py.detach(|| DELIVERIES.wait());
    Ok(())
}

pub(crate) fn register_shutdown(module: &Bound<'_, PyModule>) -> PyResult<()> {
    let callback = wrap_pyfunction!(_drain_async_deliveries, module)?;
    module
        .py()
        .import("atexit")?
        .call_method1("register", (&callback,))?;
    // Private test/embedding seam; ordinary callers do not need a new close API.
    module.add_function(callback)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // CI only: this loads Python. Local lifecycle tests compile delivery.rs
    // separately so they cannot import the native extension or an interpreter.
    #[test]
    fn nested_tokio_context_and_error_delivery_are_preserved() {
        Python::initialize();
        Python::attach(|py| {
            let asyncio = py.import("asyncio").unwrap();
            let loop_ = asyncio.call_method0("new_event_loop").unwrap();
            let vars = py.import("contextvars").unwrap();
            let variable = vars
                .getattr("ContextVar")
                .unwrap()
                .call1(("bridge",))
                .unwrap();
            variable.call_method1("set", ("outer",)).unwrap();
            let context = vars.call_method0("copy_context").unwrap();
            let variable = variable.unbind();
            let locals = TaskLocals::new(loop_.clone()).with_context(context);
            let future = pyo3_async_runtimes::generic::future_into_py_with_locals::<
                DeliveryRuntime,
                _,
                (),
            >(py, locals, async move {
                let nested_result = Python::attach(|py| {
                    let public = py_tokio::get_current_locals(py)?;
                    let generic = DeliveryRuntime::get_task_locals().unwrap();
                    assert!(public.context(py).is(generic.context(py)));
                    let read = variable.bind(py).getattr("get")?;
                    let value: String =
                        public.context(py).call_method1("run", (read,))?.extract()?;
                    assert_eq!(value, "outer");
                    let reader = PyModule::from_code(
                        py,
                        c"import asyncio\nasync def read(variable):\n    await asyncio.sleep(0)\n    return variable.get()\n",
                        c"bridge_context.py",
                        c"bridge_context",
                    )?;
                    let awaitable = reader.getattr("read")?.call1((variable.bind(py),))?;
                    py_tokio::into_future(awaitable)
                })?
                .await?;
                Python::attach(|py| {
                    assert_eq!(nested_result.bind(py).extract::<String>()?, "outer");
                    PyResult::Ok(())
                })?;
                Err(PyRuntimeError::new_err("nested bridge error"))
            })
            .unwrap();
            let error = loop_
                .call_method1("run_until_complete", (future,))
                .unwrap_err();
            assert!(error.to_string().contains("nested bridge error"));

            let future = pyo3_async_runtimes::generic::future_into_py_with_locals::<
                DeliveryRuntime,
                _,
                (),
            >(py, TaskLocals::new(loop_.clone()), async {
                panic!("bridge panic delivery");
            })
            .unwrap();
            let error = loop_
                .call_method1("run_until_complete", (future,))
                .unwrap_err();
            assert!(error.is_instance_of::<pyo3_async_runtimes::err::RustPanic>(py));
            // Preserve the locked upstream panic contract, including its
            // payload formatting; do not require a stronger message contract.
            let upstream = py_tokio::future_into_py_with_locals::<_, ()>(
                py,
                TaskLocals::new(loop_.clone()),
                async { panic!("bridge panic delivery") },
            )
            .unwrap();
            let upstream_error = loop_
                .call_method1("run_until_complete", (upstream,))
                .unwrap_err();
            assert!(upstream_error.is_instance_of::<pyo3_async_runtimes::err::RustPanic>(py));
            assert_eq!(error.to_string(), upstream_error.to_string());

            struct Cancelled(std::sync::mpsc::Sender<()>);
            impl Drop for Cancelled {
                fn drop(&mut self) {
                    self.0.send(()).unwrap();
                }
            }
            let (tx, rx) = std::sync::mpsc::channel();
            let cancelled = Cancelled(tx);
            let future = pyo3_async_runtimes::generic::future_into_py_with_locals::<
                DeliveryRuntime,
                _,
                (),
            >(py, TaskLocals::new(loop_.clone()), async move {
                let _cancelled = cancelled;
                std::future::pending::<()>().await;
                Ok(())
            })
            .unwrap();
            future.call_method0("cancel").unwrap();
            let error = loop_
                .call_method1("run_until_complete", (future,))
                .unwrap_err();
            assert!(error.is_instance(py, &asyncio.getattr("CancelledError").unwrap()));
            py.detach(move || rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap());
            py.detach(|| DELIVERIES.wait());
            loop_.call_method0("close").unwrap();

            _drain_async_deliveries(py).unwrap();
            _drain_async_deliveries(py).unwrap();
            let rejected = future_into_py(py, async { Ok(()) }).unwrap_err();
            assert!(rejected.to_string().contains("shutting down"));

            struct LateCapture(Arc<std::sync::atomic::AtomicBool>);
            impl Drop for LateCapture {
                fn drop(&mut self) {
                    self.0.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
            let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let capture = LateCapture(Arc::clone(&dropped));
            // Like upstream generic conversion, request delivery from an
            // unattached Rust task after the shutdown gate has closed.
            let late = py_tokio::get_runtime().spawn(async move {
                DeliveryRuntime::spawn_blocking(move || {
                    drop(capture);
                    panic!("late Python delivery must never execute");
                })
                .await
                .unwrap();
            });
            py.detach(|| py_tokio::get_runtime().block_on(late).unwrap());
            assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
        });
    }
}
