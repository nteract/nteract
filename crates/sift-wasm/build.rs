//! Link-time ceiling on linear memory for the wasm32 build.
//!
//! The allocation cap (`src/alloc_cap.rs`) counts requested heap bytes; it
//! cannot see allocator overhead, fragmentation, or the stack, and
//! `memory.grow` never gives memory back. `--max-memory` bounds the module's
//! linear memory outright, so a runaway decode fails with a grow failure in
//! this instance instead of taking the tab toward the 4 GiB wasm32 limit.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        // 2 GiB, a multiple of the 64 KiB wasm page size.
        println!("cargo:rustc-link-arg=--max-memory=2147483648");
    }
}
