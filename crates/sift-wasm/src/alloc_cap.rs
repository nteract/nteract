//! A counting global allocator with an optional cap on live heap bytes.
//!
//! Every heap allocation in the instance goes through here, including the
//! buffers wasm-bindgen allocates for strings and byte arrays passed in from
//! JS (`__wbindgen_malloc` calls the global allocator). An allocation that
//! would push live bytes past the cap returns null:
//!
//! - inside Rust, `handle_alloc_error` aborts, and the host sees a
//!   `WebAssembly.RuntimeError`;
//! - inside `__wbindgen_malloc` (JS handing Rust a large argument), a release
//!   build aborts the same way, while a debug build throws a plain `Error`
//!   ("invalid malloc request") before any Rust code runs.
//!
//! The count is of requested bytes, not linear memory. Allocator overhead and
//! fragmentation sit on top, and `memory.grow` never shrinks, so the
//! link-time `--max-memory` in `build.rs` is the backstop for what this
//! cannot see.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use wasm_bindgen::prelude::*;

/// Live-byte accounting against a cap. 0 means no cap.
pub(crate) struct AllocationCounter {
    live: AtomicUsize,
    peak: AtomicUsize,
    cap: AtomicUsize,
}

impl AllocationCounter {
    pub(crate) const fn new() -> Self {
        Self {
            live: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            cap: AtomicUsize::new(0),
        }
    }

    /// Whether `size` more bytes would exceed the cap right now.
    #[cfg(test)]
    pub(crate) fn would_exceed(&self, size: usize) -> bool {
        exceeds(
            self.live.load(Ordering::Relaxed),
            size,
            self.cap.load(Ordering::Relaxed),
        )
    }

    /// Count `size` more live bytes unless that would exceed the cap.
    fn try_reserve(&self, size: usize) -> bool {
        let cap = self.cap.load(Ordering::Relaxed);
        let mut live = self.live.load(Ordering::Relaxed);
        loop {
            if exceeds(live, size, cap) {
                return false;
            }
            let next = live + size;
            match self
                .live
                .compare_exchange_weak(live, next, Ordering::Relaxed, Ordering::Relaxed)
            {
                Ok(_) => {
                    self.peak.fetch_max(next, Ordering::Relaxed);
                    return true;
                }
                Err(current) => live = current,
            }
        }
    }

    fn release(&self, size: usize) {
        self.live.fetch_sub(size, Ordering::Relaxed);
    }

    fn set_cap(&self, bytes: usize) {
        self.cap.store(bytes, Ordering::Relaxed);
    }

    fn live(&self) -> usize {
        self.live.load(Ordering::Relaxed)
    }

    fn peak(&self) -> usize {
        self.peak.load(Ordering::Relaxed)
    }
}

fn exceeds(live: usize, size: usize, cap: usize) -> bool {
    match live.checked_add(size) {
        Some(next) => cap != 0 && next > cap,
        None => true,
    }
}

/// `System` (dlmalloc on wasm32) behind an `AllocationCounter`.
pub(crate) struct CappedAllocator {
    counter: AllocationCounter,
}

#[global_allocator]
static ALLOCATOR: CappedAllocator = CappedAllocator {
    counter: AllocationCounter::new(),
};

unsafe impl GlobalAlloc for CappedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !self.counter.try_reserve(layout.size()) {
            return std::ptr::null_mut();
        }
        let ptr = unsafe { System.alloc(layout) };
        if ptr.is_null() {
            self.counter.release(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !self.counter.try_reserve(layout.size()) {
            return std::ptr::null_mut();
        }
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if ptr.is_null() {
            self.counter.release(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        self.counter.release(layout.size());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let old_size = layout.size();
        if new_size > old_size {
            let grow = new_size - old_size;
            if !self.counter.try_reserve(grow) {
                return std::ptr::null_mut();
            }
            let next = unsafe { System.realloc(ptr, layout, new_size) };
            if next.is_null() {
                self.counter.release(grow);
            }
            next
        } else {
            let next = unsafe { System.realloc(ptr, layout, new_size) };
            // A failed shrink leaves the original block, and its count, alone.
            if !next.is_null() {
                self.counter.release(old_size - new_size);
            }
            next
        }
    }
}

/// A JS number as a byte count. Negative, NaN, and non-integer values are
/// rejected; values past `usize::MAX` saturate.
fn bytes_from_js(bytes: f64) -> Result<usize, String> {
    if bytes.is_nan() || bytes < 0.0 {
        return Err("Allocation cap must be a non-negative integer".to_string());
    }
    if bytes >= usize::MAX as f64 {
        return Ok(usize::MAX);
    }
    if bytes.fract() != 0.0 {
        return Err("Allocation cap must be a non-negative integer".to_string());
    }
    Ok(bytes as usize)
}

/// Cap on live heap bytes for this instance; 0 removes the cap. A host sets
/// it from its decoded-bytes budget plus headroom before loading anything.
/// Allocations past the cap abort the instance (a `WebAssembly.RuntimeError`
/// in the host). Lowering the cap below what is already live only blocks
/// further growth.
#[wasm_bindgen]
pub fn set_allocation_cap(bytes: f64) -> Result<(), JsValue> {
    let bytes = bytes_from_js(bytes).map_err(|e| JsValue::from_str(&e))?;
    ALLOCATOR.counter.set_cap(bytes);
    Ok(())
}

/// Live heap bytes right now.
#[wasm_bindgen]
pub fn allocated_bytes() -> f64 {
    ALLOCATOR.counter.live() as f64
}

/// Highest live heap bytes seen since the instance started.
#[wasm_bindgen]
pub fn peak_allocated_bytes() -> f64 {
    ALLOCATOR.counter.peak() as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counter_tracks_reserve_and_release_against_the_cap() {
        let counter = AllocationCounter::new();
        assert!(!counter.would_exceed(usize::MAX - 1), "uncapped");
        assert!(counter.try_reserve(100));
        assert_eq!((counter.live(), counter.peak()), (100, 100));
        counter.release(40);
        assert_eq!((counter.live(), counter.peak()), (60, 100));

        counter.set_cap(100);
        assert!(!counter.would_exceed(40));
        assert!(counter.would_exceed(41));
        assert!(!counter.try_reserve(41));
        assert_eq!(counter.live(), 60, "a refused reserve counts nothing");
        assert!(counter.try_reserve(40));
        assert_eq!((counter.live(), counter.peak()), (100, 100));

        // Lowering the cap below live bytes blocks growth, not release.
        counter.set_cap(50);
        assert!(counter.would_exceed(1));
        counter.release(100);
        assert!(!counter.would_exceed(50));
        assert!(counter.would_exceed(51));
        counter.set_cap(0);
        assert!(!counter.would_exceed(usize::MAX));
        assert!(exceeds(1, usize::MAX, 0), "overflow always exceeds");
    }

    #[test]
    fn global_counter_sees_heap_allocations() {
        // Other tests allocate concurrently, so only monotonic facts are
        // asserted against the global counter.
        const SIZE: usize = 32 * 1024 * 1024;
        let held: Vec<u8> = Vec::with_capacity(SIZE);
        assert!(allocated_bytes() >= SIZE as f64);
        assert!(peak_allocated_bytes() >= SIZE as f64);
        assert!(peak_allocated_bytes() >= allocated_bytes());
        drop(held);
        assert!(peak_allocated_bytes() >= SIZE as f64);
    }

    #[test]
    fn a_cap_below_the_request_refuses_it() {
        // The global cap cannot be set here: tests share the allocator and
        // run in parallel, so a refused allocation would abort the run. A
        // private counter exercises the same refusal path.
        let counter = AllocationCounter::new();
        counter.set_cap(1024);
        assert!(counter.try_reserve(1000));
        assert!(counter.would_exceed(25));
        assert!(!counter.try_reserve(25));
        assert!(counter.try_reserve(24));
    }

    #[test]
    fn js_byte_counts_are_validated() {
        assert_eq!(bytes_from_js(0.0), Ok(0));
        assert_eq!(bytes_from_js(268_435_456.0), Ok(268_435_456));
        assert_eq!(bytes_from_js(f64::INFINITY), Ok(usize::MAX));
        assert_eq!(bytes_from_js(1e300), Ok(usize::MAX));
        for bad in [-1.0, 1.5, f64::NAN, f64::NEG_INFINITY] {
            assert!(bytes_from_js(bad).is_err(), "{bad}");
        }
    }
}
