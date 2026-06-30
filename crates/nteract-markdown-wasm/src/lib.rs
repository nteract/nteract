use nteract_markdown_engine::{error_to_json, project_markdown, render_plan_json};
use std::sync::Mutex;

static LAST_OUTPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

#[no_mangle]
pub extern "C" fn nteract_markdown_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Frees a buffer previously allocated by [`nteract_markdown_alloc`].
///
/// # Safety
///
/// `pointer` must either be null or a pointer returned by
/// [`nteract_markdown_alloc`] with the same `len`. It must not be used after
/// this call returns.
#[no_mangle]
pub unsafe extern "C" fn nteract_markdown_free(pointer: *mut u8, len: usize) {
    if !pointer.is_null() {
        drop(Vec::from_raw_parts(pointer, 0, len));
    }
}

/// Projects a UTF-8 markdown source buffer into the last-result JSON buffer.
///
/// # Safety
///
/// `pointer` must reference `len` readable bytes for the duration of this call.
/// The bytes should contain UTF-8 markdown source; invalid UTF-8 is reported in
/// the returned projection JSON rather than panicking.
#[no_mangle]
pub unsafe extern "C" fn nteract_markdown_project(pointer: *const u8, len: usize) -> usize {
    let bytes = std::slice::from_raw_parts(pointer, len);
    let json = match std::str::from_utf8(bytes) {
        Ok(source) => project_to_json(source),
        Err(error) => error_to_json(&format!("source was not valid UTF-8: {error}"), "rust-wasm"),
    };
    let mut output = LAST_OUTPUT.lock().expect("wasm output lock poisoned");
    *output = json.into_bytes();
    output.len()
}

#[no_mangle]
pub extern "C" fn nteract_markdown_result_ptr() -> *const u8 {
    LAST_OUTPUT
        .lock()
        .expect("wasm output lock poisoned")
        .as_ptr()
}

#[no_mangle]
pub extern "C" fn nteract_markdown_result_len() -> usize {
    LAST_OUTPUT.lock().expect("wasm output lock poisoned").len()
}

pub fn project_to_json(source: &str) -> String {
    match project_markdown(source) {
        Ok(plan) => render_plan_json(&plan, source, "rust-wasm"),
        Err(error) => error_to_json(&error.to_string(), "rust-wasm"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffi_path_emits_rust_wasm_label() {
        let json = project_to_json("# hi");
        assert!(json.starts_with("{\"version\":1,\"engine\":\"rust-wasm\""));
        assert!(!json.contains("\"mode\""));
    }
}
