use serde_json::{json, Value};
use std::env;
use std::path::{Path, PathBuf};

fn merge_json(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Object(base_map), Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                merge_json(base_map.entry(key).or_insert(Value::Null), value);
            }
        }
        (slot, value) => *slot = value,
    }
}

fn target_sidecar_path(manifest_dir: &Path, target: &str, binary_name: &str) -> PathBuf {
    let executable_suffix = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    manifest_dir
        .join("binaries")
        .join(format!("{binary_name}-{target}{executable_suffix}"))
}

fn maybe_disable_external_bin_for_local_checks() {
    let profile = env::var("PROFILE").unwrap_or_default();
    if profile == "release" {
        return;
    }

    let Ok(manifest_dir_str) = env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let manifest_dir = PathBuf::from(manifest_dir_str);
    let Ok(target) = env::var("TARGET") else {
        return;
    };

    let expected_sidecars = [
        target_sidecar_path(&manifest_dir, &target, "runtimed"),
        target_sidecar_path(&manifest_dir, &target, "runt"),
        target_sidecar_path(&manifest_dir, &target, "nteract-cli"),
        target_sidecar_path(&manifest_dir, &target, "nteract-mcp"),
    ];

    for path in &expected_sidecars {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let missing_sidecars: Vec<_> = expected_sidecars
        .iter()
        .filter(|path| !path.exists())
        .collect();

    if missing_sidecars.is_empty() {
        return;
    }

    let mut config = env::var("TAURI_CONFIG")
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_else(|| json!({}));
    merge_json(&mut config, json!({ "bundle": { "externalBin": [] } }));
    if let Ok(serialized) = serde_json::to_string(&config) {
        env::set_var("TAURI_CONFIG", serialized);
    }

    let missing_paths = missing_sidecars
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    println!(
        "cargo:warning=Sidecar binaries missing ({missing_paths}); skipping bundle.externalBin for non-release builds so cargo check can run without `cargo xtask build`."
    );
}

fn tauri_attributes() -> tauri_build::Attributes {
    let attributes = tauri_build::Attributes::new();
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return attributes;
    }

    // Tauri attaches its app resource to binary targets, leaving the library's
    // unit test executable without a manifest. Without Common
    // Controls v6, the loader cannot resolve imports such as TaskDialogIndirect
    // and exits with STATUS_ENTRYPOINT_NOT_FOUND before any test runs.
    // Embed the same manifest through the linker for every notebook executable,
    // including lib unit tests (rustc-link-arg-tests only covers test targets).
    // Keep Tauri's icons/version resources, but avoid a second manifest resource.
    // See tauri-apps/tauri's examples/api/src-tauri/build.rs workaround.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
}

fn main() {
    let out_dir = out_dir();
    build_metadata::emit_git_rerun_hints();
    build_metadata::write_git_metadata(&out_dir);

    // Re-run if frontend dist changes (ensures fresh frontend is embedded).
    // This is the only non-git watcher — Phase 2 builds the frontend, then
    // Phase 3 (cargo tauri build) picks up the updated dist/.
    println!("cargo:rerun-if-changed=../../apps/notebook/dist");

    maybe_disable_external_bin_for_local_checks();

    tauri_build::try_build(tauri_attributes())
        .unwrap_or_else(|err| panic!("Tauri build failed: {err:#}"));
}

fn out_dir() -> PathBuf {
    match env::var("OUT_DIR") {
        Ok(value) => PathBuf::from(value),
        Err(err) => panic!("OUT_DIR is required for build metadata: {err}"),
    }
}
