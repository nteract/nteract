//! Single-threaded wasm32 C ABI. Buffers remain owned by the module, avoiding
//! raw pointer dereferences supplied by JavaScript. Allocate, fill, run, read;
//! the next call invalidates the previous result view.

use std::cell::RefCell;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn codec_alloc(len: usize) -> *mut u8 {
    if len > crate::MAX_INPUT_BYTES * 6 + 1024 {
        return std::ptr::null_mut();
    }
    INPUT.with_borrow_mut(|input| {
        input.resize(len, 0);
        input.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn codec_run(pointer: *const u8, len: usize) -> usize {
    let result = INPUT.with_borrow(|input| {
        if input.as_ptr() != pointer || input.len() != len {
            r#"{"ok":false,"error":"Invalid codec input buffer"}"#.to_owned()
        } else {
            crate::process_json(input)
        }
    });
    OUTPUT.with_borrow_mut(|output| {
        *output = result.into_bytes();
        output.len()
    })
}

#[no_mangle]
pub extern "C" fn codec_result_ptr() -> *const u8 {
    OUTPUT.with_borrow(|output| output.as_ptr())
}

#[no_mangle]
pub extern "C" fn codec_result_len() -> usize {
    OUTPUT.with_borrow(Vec::len)
}

#[no_mangle]
pub extern "C" fn codec_free(pointer: *const u8, len: usize) {
    INPUT.with_borrow_mut(|input| {
        if input.as_ptr() == pointer && input.len() == len {
            *input = Vec::new();
        }
    });
}
