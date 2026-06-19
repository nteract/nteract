use std::path::{Path, PathBuf};

fn main() {
    // Renderer plugin bundles live under `apps/notebook/src/renderer-plugins/`.
    // Stable third-party bundles (plotly, vega, leaflet) are LFS-tracked;
    // owned/generated renderer bundles (isolated-renderer.*, markdown.*,
    // bokeh.*, panel.*, sift.*) are gitignored and rebuilt via
    // `cargo xtask artifacts ensure renderer`.
    // sift_wasm.wasm is embedded directly from `crates/sift-wasm/pkg/`.
    // Probe each path before `include_bytes!` so a missing file points at
    // the right recovery command instead of a generic "file not found".
    let renderer_plugin_dir = Path::new("../../apps/notebook/src/renderer-plugins");
    let renderer_plugins = [
        "markdown.js",
        "markdown.css",
        "plotly.js",
        "vega.js",
        "leaflet.js",
        "leaflet.css",
        "bokeh.js",
        "panel.js",
        "sift.js",
        "sift.css",
    ];
    for file in renderer_plugins {
        let path = renderer_plugin_dir.join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        if !path.exists() {
            panic!(
                "Missing renderer plugin asset: {}\n\n\
                 Stable bundles (plotly, vega, leaflet) \
                 are LFS-tracked - run `git lfs pull` if your checkout has pointer \
                 files only.\n\
                 Generated bundles (isolated-renderer.*, markdown.*, bokeh.*, panel.*, sift.*) are gitignored - run \
                 `cargo xtask artifacts ensure sift,renderer` from the \
                 workspace root to rebuild.",
                path.display(),
            );
        }
    }

    let sift_wasm = Path::new("../sift-wasm/pkg/sift_wasm_bg.wasm");
    println!("cargo:rerun-if-changed={}", sift_wasm.display());
    if !sift_wasm.exists() {
        panic!(
            "Missing sift WASM binary: {}\n\n\
             Run `cargo xtask artifacts ensure sift,renderer` from the \
             workspace root to rebuild it.",
            sift_wasm.display(),
        );
    }

    let out_dir = out_dir();
    build_metadata::emit_git_rerun_hints();
    build_metadata::write_git_hash(&out_dir);
}

fn out_dir() -> PathBuf {
    match std::env::var("OUT_DIR") {
        Ok(value) => PathBuf::from(value),
        Err(err) => panic!("OUT_DIR is required for build metadata: {err}"),
    }
}
