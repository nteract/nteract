#![allow(clippy::unwrap_used, clippy::expect_used)]

//! CI lint: ensure no tokio::sync::Mutex guards are held across .await points.
//!
//! Uses the async-rust-lsp rule engine (tree-sitter based) to scan all runtimed
//! source files. Any violation is a hard CI failure.
//!
//! Reached zero violations on 2026-04-08 after:
//! - #1614, #1637, #1638: initial fixes and lint expansion
//! - #1642: Phase 1 mechanical burndown (58 → 19)
//! - #1647: Kernel actor pattern (19 → 14)
//! - Dead code removal + IOPub scoping (14 → 0)

/// Collect `.rs` files recursively. A flat `read_dir` silently skipped
/// `notebook_sync_server/`, `workstation/`, `requests/`, and every other
/// subdirectory, scoping the "zero violations" claim to top-level files
/// only (TMD-1).
fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|e| panic!("failed to read {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn scan_crate_src(src_dir: &std::path::Path, crate_label: &str) {
    let mut rs_files: Vec<std::path::PathBuf> = Vec::new();
    collect_rs_files(src_dir, &mut rs_files);

    assert!(
        !rs_files.is_empty(),
        "no .rs files found in {}",
        src_dir.display()
    );

    let mut violations = Vec::new();

    for path in &rs_files {
        let source = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));

        let diagnostics =
            async_rust_lsp::rules::mutex_across_await::check_mutex_across_await(&source);

        let display_path = path.strip_prefix(src_dir).unwrap_or(path).display();

        for d in diagnostics {
            violations.push(format!(
                "  {}:{}: {}",
                display_path,
                d.range.start.line + 1,
                d.message
            ));
        }
    }

    if !violations.is_empty() {
        let mut msg = format!(
            "Found {} tokio Mutex guard(s) held across .await in {crate_label} sources:\n\n",
            violations.len()
        );
        for v in &violations {
            msg.push_str(v);
            msg.push('\n');
        }
        msg.push_str(
            "\nFix: scope each lock in its own block so the guard drops before the next .await.\n\
             See: https://github.com/nteract/nteract/pull/1614\n",
        );
        panic!("{msg}");
    }
}

#[test]
fn runtimed_has_no_tokio_mutex_across_await() {
    let src_dir = std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
    scan_crate_src(&src_dir, "runtimed");
}

/// runtimed-py builds on the post-merge-only Anaconda lane, so its own cargo
/// tests do not gate PRs. Scanning its sources from here keeps the mutex
/// discipline on the pre-merge lane (TMD-2). Source-level scan only — no
/// compilation of runtimed-py is involved.
#[test]
fn runtimed_py_has_no_tokio_mutex_across_await() {
    let src_dir =
        std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../runtimed-py/src"));
    scan_crate_src(&src_dir, "runtimed-py");
}
