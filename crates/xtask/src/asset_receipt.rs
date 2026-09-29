//! Content receipts emitted by the Vite asset builds. Checking actual inputs
//! and outputs avoids mtime assumptions (checkout, restore, and no-op builds).
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn source_files(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            source_files(&path, files)?;
        } else if matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("ts" | "tsx" | "js" | "jsx" | "css" | "html" | "json")
        ) {
            files.push(path);
        }
    }
    Ok(())
}

fn input_bytes(path: &Path, normalize: bool) -> std::io::Result<Vec<u8>> {
    let bytes = fs::read(path)?;
    if normalize
        && matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("ts" | "tsx" | "js" | "jsx" | "css" | "html" | "json" | "yaml" | "toml")
        )
    {
        Ok(bytes
            .iter()
            .enumerate()
            .filter_map(|(i, &b)| (b != b'\r' || bytes.get(i + 1) != Some(&b'\n')).then_some(b))
            .collect())
    } else {
        Ok(bytes)
    }
}

fn path_digest(path: &Path, normalize: bool) -> std::io::Result<String> {
    if !path.is_dir() {
        return input_bytes(path, normalize).map(|bytes| digest(&bytes));
    }
    let mut files = Vec::new();
    source_files(path, &mut files)?;
    // Match JavaScript's lexical path ordering, not PathBuf's component order
    // ("a.ts" sorts before "a/b.ts" as strings, but after it as components).
    files.sort_by_key(|file| file.to_string_lossy().replace('\\', "/"));
    let mut hash = Sha256::new();
    for file in files {
        let relative = file.strip_prefix(path).map_err(std::io::Error::other)?;
        hash.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        hash.update([0]);
        hash.update(input_bytes(&file, normalize)?);
        hash.update([0]);
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

pub fn stale(root: &Path, name: &str) -> Option<String> {
    let path = root.join(format!("target/xtask/{name}.inputs.json"));
    let receipt: serde_json::Value = match fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(value) => value,
        None => return Some("input receipt missing or invalid".into()),
    };
    if receipt["version"] != 2 {
        return Some("input receipt version changed".into());
    }
    for kind in ["inputs", "outputs"] {
        let Some(files) = receipt[kind].as_object().filter(|files| !files.is_empty()) else {
            return Some(format!("{kind} missing from receipt"));
        };
        for (file, previous) in files {
            let Ok(hash) = path_digest(&root.join(file), kind == "inputs") else {
                return Some(format!("{file} missing or unreadable"));
            };
            if previous.as_str() != Some(&hash) {
                return Some(format!("{file} changed"));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_digest_matches_builder_and_detects_new_css_sources() {
        let root = std::env::temp_dir().join(format!("asset-tree-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.ts"), "one").unwrap();
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/b.ts"), "two\r\n").unwrap();
        let expected = digest(b"a.ts\0one\0a/b.ts\0two\n\0");
        assert_eq!(path_digest(&root, true).unwrap(), expected);
        fs::write(root.join("b.tsx"), "two").unwrap();
        assert_ne!(path_digest(&root, true).unwrap(), expected);
        fs::remove_file(root.join("b.tsx")).unwrap();
        assert_eq!(path_digest(&root, true).unwrap(), expected);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn receipts_detect_content_changes_deletion_and_output_drift() {
        let root = std::env::temp_dir().join(format!("asset-receipt-{}", std::process::id()));
        fs::create_dir_all(root.join("target/xtask")).unwrap();
        fs::write(root.join("source.ts"), "old").unwrap();
        fs::write(root.join("output.js"), "bundle").unwrap();
        let receipt = serde_json::json!({
            "version": 2,
            "inputs": {"source.ts": digest(b"old")},
            "outputs": {"output.js": digest(b"bundle")},
        });
        assert!(stale(&root, "test").is_some());
        fs::write(
            root.join("target/xtask/test.inputs.json"),
            receipt.to_string(),
        )
        .unwrap();
        assert_eq!(stale(&root, "test"), None);
        // Rewriting the same bytes is a no-op, regardless of timestamp.
        fs::write(root.join("source.ts"), "old").unwrap();
        assert_eq!(stale(&root, "test"), None);
        fs::write(root.join("source.ts"), "new").unwrap();
        assert_eq!(stale(&root, "test"), Some("source.ts changed".into()));
        fs::write(root.join("source.ts"), "old").unwrap();
        fs::write(root.join("output.js"), "stale").unwrap();
        assert_eq!(stale(&root, "test"), Some("output.js changed".into()));
        fs::remove_file(root.join("source.ts")).unwrap();
        assert!(stale(&root, "test").unwrap().contains("missing"));
        fs::remove_dir_all(root).unwrap();
    }
}
