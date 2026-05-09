//! Parity test for the iframe shell HTML.
//!
//! `crates/notebook/src/iframe_shell/frame.html` is the bytes the Rust
//! scheme handler serves. `src/components/isolated/frame-html.ts` is the
//! source the browser dev path uses via `srcDoc`. They must be byte-equal
//! so the production Tauri path and the dev browser path render the
//! same document.
//!
//! `scripts/dump-frame-html.mjs` regenerates the .html file from the TS
//! source via `tsx`. This test re-runs that script to a temp file and
//! compares to the committed copy. Skips if `node` (or `pnpm exec tsx`)
//! is unavailable, which keeps the test from blocking environments
//! without a JS toolchain.

use std::{path::PathBuf, process::Command};

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("notebook crate is two levels under the workspace root")
        .to_path_buf()
}

fn pnpm_available() -> bool {
    Command::new("pnpm")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[test]
fn frame_html_matches_typescript_source() {
    if !pnpm_available() {
        eprintln!("skipping iframe_shell_parity: pnpm not on PATH");
        return;
    }

    let root = workspace_root();
    let temp = tempfile::NamedTempFile::new().expect("temp file");
    let temp_path = temp.path().to_path_buf();

    let status = Command::new("pnpm")
        .args([
            "exec",
            "tsx",
            "scripts/dump-frame-html.mjs",
            temp_path.to_str().expect("utf-8 temp path"),
        ])
        .current_dir(&root)
        .status()
        .expect("invoking pnpm exec tsx should succeed when pnpm is installed");

    assert!(
        status.success(),
        "pnpm exec tsx scripts/dump-frame-html.mjs failed (exit {status:?}). \
         Make sure dependencies are installed (`pnpm install`)."
    );

    let regenerated = std::fs::read(&temp_path).expect("read regenerated HTML");
    let committed_path = root.join("crates/notebook/src/iframe_shell/frame.html");
    let committed = std::fs::read(&committed_path).expect("read committed frame.html");

    assert_eq!(
        regenerated.len(),
        committed.len(),
        "iframe_shell/frame.html drifted from frame-html.ts. \
         Regenerate with `pnpm exec tsx scripts/dump-frame-html.mjs`."
    );
    assert_eq!(
        regenerated, committed,
        "iframe_shell/frame.html drifted from frame-html.ts. \
         Regenerate with `pnpm exec tsx scripts/dump-frame-html.mjs`."
    );
}
