#![allow(clippy::unwrap_used, clippy::expect_used)]

//! CI lint: ensure no Tokio Mutex or RwLock guards are held across .await points.
//!
//! Uses the async-rust-lsp rule engine (tree-sitter based) to scan every crate's
//! source directory, including crates whose tests do not run on the PR lane.
//! This is a source-level check; it does not compile the scanned crates.

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

fn scan_crate_src(src_dir: &std::path::Path, crate_label: &str) -> Vec<String> {
    let mut rs_files: Vec<std::path::PathBuf> = Vec::new();
    collect_rs_files(src_dir, &mut rs_files);
    rs_files.sort();

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
                "  {crate_label}/src/{}:{}: {}",
                display_path,
                d.range.start.line + 1,
                d.message
            ));
        }
    }

    violations
}

#[test]
fn workspace_crates_have_no_tokio_locks_across_await() {
    let crates_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates directory")
        .to_path_buf();
    let mut crate_dirs: Vec<_> = std::fs::read_dir(&crates_dir)
        .expect("read crates directory")
        .map(|entry| entry.expect("crate directory entry").path())
        .filter(|path| path.join("Cargo.toml").is_file() && path.join("src").is_dir())
        .collect();
    crate_dirs.sort();
    assert!(!crate_dirs.is_empty(), "no crate source directories found");

    let mut violations = Vec::new();
    for crate_dir in crate_dirs {
        let label = crate_dir.file_name().unwrap().to_string_lossy();
        violations.extend(scan_crate_src(&crate_dir.join("src"), &label));
    }

    assert!(
        violations.is_empty(),
        "Found {} Tokio lock guard(s) held across .await in workspace crate sources:\n\n{}\n\n\
         Fix: scope each lock in its own block so the guard drops before the next .await.\n\
         See: https://github.com/nteract/nteract/pull/1614",
        violations.len(),
        violations.join("\n"),
    );
}
