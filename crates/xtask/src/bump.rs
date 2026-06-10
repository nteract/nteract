//! `cargo xtask bump [patch|minor|major]` — bump every versioned artifact in
//! the repo in lockstep.
//!
//! The repo ships a single coordinated version per release: the Tauri app,
//! daemon, CLI, Python wheels, frontend packages, WASM bindings, and plugin
//! manifests all move together. This command is the source of truth for that
//! set. Add an entry to `TARGETS` when a new versioned file lands.
//!
//! The match is deliberately line-local (no TOML/JSON parser): a pyproject
//! may list `version = "1"` inside a dep spec, a package.json may list
//! `"version": "..."` inside `devDependencies`. We only touch the first
//! top-level `version` line per file.

use std::fs;
use std::path::Path;
use std::process::{exit, Command};

use crate::ensure_workspace_root_cwd;

#[derive(Clone, Copy)]
enum BumpKind {
    Patch,
    Minor,
    Major,
}

#[derive(Clone, Copy)]
enum Format {
    /// Line starts with `version = "..."` (TOML `[package]` / `[project]`).
    Toml,
    /// Line contains `"version": "..."` (JSON, any indentation).
    Json,
}

struct Target {
    path: &'static str,
    format: Format,
    /// How many version occurrences to bump in the file. Marketplace files
    /// have two plugin entries; everything else has one top-level version.
    matches: usize,
}

const TARGETS: &[Target] = &[
    // Rust workspace crates (keep in sync with [workspace.members] in /Cargo.toml)
    Target {
        path: "crates/build-metadata/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runt/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runtimed/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runt-publish/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/notebook/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runtimed-py/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runtimed-client/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    // Sibling crates split out of runtimed-client in #2567 / #2570.
    Target {
        path: "crates/runtimed-outputs/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runtimed-service/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runtimed-settings-sync/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/nteract-telemetry/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/nteract-identity/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/notebook-doc/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/notebook-wire/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/notebook-sync/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/notebook-protocol/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/nteract-markdown-engine/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/nteract-markdown-wasm/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runtimed-wasm/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/notebook-cloud-transport/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runt-mcp/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/mcp-supervisor/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/mcp-client-branding/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/playdate-image/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runt-trust/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runt-workspace/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/kernel-launch/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/kernel-env/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/automerge-recovery/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runtimed-node/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runt-mcp-proxy/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/nteract-mcp/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/repr-llm/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/nteract-predicate/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/sift-wasm/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/automunge/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/runtime-doc/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "crates/xtask/Cargo.toml",
        format: Format::Toml,
        matches: 1,
    },
    // Tauri app config (version surfaces in the .app bundle / installer)
    Target {
        path: "crates/notebook/tauri.conf.json",
        format: Format::Json,
        matches: 1,
    },
    // Frontend packages
    Target {
        path: "apps/notebook/package.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "apps/notebook/src/wasm/runtimed-wasm/package.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "crates/sift-wasm/pkg/package.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "packages/sift/package.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "packages/runtimed/package.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "packages/notebook-host/package.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "packages/runtimed-node/package.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "packages/runtimed-node/npm/darwin-arm64/package.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "packages/runtimed-node/npm/linux-x64-gnu/package.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "packages/runtimed-node/npm/win32-x64-msvc/package.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "plugins/nteract/pi/package.json",
        format: Format::Json,
        matches: 1,
    },
    // Python packages
    Target {
        path: "python/nteract/pyproject.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "python/runtimed/pyproject.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "python/dx/pyproject.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "python/nteract-kernel-launcher/pyproject.toml",
        format: Format::Toml,
        matches: 1,
    },
    Target {
        path: "python/prewarm/pyproject.toml",
        format: Format::Toml,
        matches: 1,
    },
    // Agent plugin manifests (shipped through the Claude/Codex marketplace)
    Target {
        path: "plugins/nightly/.claude-plugin/plugin.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "plugins/nightly/.codex-plugin/plugin.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "plugins/nteract/.claude-plugin/plugin.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: "plugins/nteract/.codex-plugin/plugin.json",
        format: Format::Json,
        matches: 1,
    },
    Target {
        path: ".claude-plugin/marketplace.json",
        format: Format::Json,
        matches: 2,
    },
    Target {
        path: ".agents/plugins/marketplace.json",
        format: Format::Json,
        matches: 2,
    },
];

const OPTIONAL_GENERATED_TARGETS: &[&str] = &[
    // Generated by `cargo xtask wasm`. The Cargo crate versions are the source
    // of truth, so these may not exist yet on a fresh checkout during bump.
    "apps/notebook/src/wasm/runtimed-wasm/package.json",
    "crates/sift-wasm/pkg/package.json",
];

pub fn cmd_bump(level: &str) {
    ensure_workspace_root_cwd();
    let kind = match level {
        "patch" => BumpKind::Patch,
        "minor" => BumpKind::Minor,
        "major" => BumpKind::Major,
        other => {
            eprintln!("Unknown bump level: {other:?}. Use: patch, minor, major.");
            exit(1);
        }
    };

    let mut errors: Vec<String> = Vec::new();
    let mut total = 0usize;
    for target in TARGETS {
        let path = Path::new(target.path);
        match bump_file(path, target.format, target.matches, kind) {
            Ok(changes) => {
                for (old, new) in &changes {
                    println!("  {:<60} {old} -> {new}", target.path);
                }
                total += changes.len();
            }
            Err(e) if is_optional_generated_target_missing(&e, target.path) => {
                println!(
                    "  {:<60} skipped (generated; run `cargo xtask wasm`)",
                    target.path
                );
            }
            Err(e) => errors.push(e),
        }
    }

    if !errors.is_empty() {
        for e in errors {
            eprintln!("error: {e}");
        }
        exit(1);
    }
    println!();
    println!(
        "bumped {total} version field(s) across {} file(s)",
        TARGETS.len() - missing_optional_generated_targets()
    );

    println!("Running cargo update -w ...");
    let status = Command::new("cargo")
        .args(["update", "-w"])
        .status()
        .unwrap_or_else(|e| {
            eprintln!("failed to run cargo update -w: {e}");
            exit(1);
        });
    if !status.success() {
        eprintln!("cargo update -w failed");
        exit(status.code().unwrap_or(1));
    }

    println!();
    println!("Next:");
    println!("  cargo xtask wasm   # rebuild runtimed-wasm, sift-wasm, and renderer plugins");
}

fn is_optional_generated_target_missing(error: &str, path: &str) -> bool {
    OPTIONAL_GENERATED_TARGETS.contains(&path) && error.starts_with(&format!("read {path}:"))
}

fn missing_optional_generated_targets() -> usize {
    OPTIONAL_GENERATED_TARGETS
        .iter()
        .filter(|path| !Path::new(path).exists())
        .count()
}

fn bump_file(
    path: &Path,
    format: Format,
    expected: usize,
    kind: BumpKind,
) -> Result<Vec<(String, String)>, String> {
    let contents = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut bumps = Vec::new();
    let mut out = String::with_capacity(contents.len());
    let parts: Vec<&str> = contents.split('\n').collect();
    let last_idx = parts.len().saturating_sub(1);
    for (i, line) in parts.iter().enumerate() {
        let replaced = if bumps.len() < expected {
            match format {
                Format::Toml => try_bump_toml_line(line, kind),
                Format::Json => try_bump_json_line(line, kind),
            }
        } else {
            None
        };
        match replaced {
            Some((old, new, new_line)) => {
                bumps.push((old, new));
                out.push_str(&new_line);
            }
            None => out.push_str(line),
        }
        if i != last_idx {
            out.push('\n');
        }
    }

    if bumps.len() != expected {
        return Err(format!(
            "{}: expected {expected} version line(s), found {}",
            path.display(),
            bumps.len()
        ));
    }

    fs::write(path, out).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(bumps)
}

fn try_bump_toml_line(line: &str, kind: BumpKind) -> Option<(String, String, String)> {
    let prefix = "version = \"";
    if !line.starts_with(prefix) {
        return None;
    }
    let rest = &line[prefix.len()..];
    let end = rest.find('"')?;
    let old = &rest[..end];
    let new = bump_str(old, kind)?;
    let suffix = &rest[end + 1..];
    let new_line = format!("{prefix}{new}\"{suffix}");
    Some((old.to_string(), new, new_line))
}

fn try_bump_json_line(line: &str, kind: BumpKind) -> Option<(String, String, String)> {
    let key = "\"version\"";
    let key_pos = line.find(key)?;
    let after_key = &line[key_pos + key.len()..];
    let colon_pos = after_key.find(':')?;
    let after_colon = &after_key[colon_pos + 1..];
    let trimmed = after_colon.trim_start();
    let ws_len = after_colon.len() - trimmed.len();
    if !trimmed.starts_with('"') {
        return None;
    }
    let after_open = &trimmed[1..];
    let close = after_open.find('"')?;
    let old = &after_open[..close];
    let new = bump_str(old, kind)?;
    let suffix = &after_open[close + 1..];
    let prefix_end = key_pos + key.len() + colon_pos + 1 + ws_len + 1;
    let prefix = &line[..prefix_end];
    let new_line = format!("{prefix}{new}\"{suffix}");
    Some((old.to_string(), new, new_line))
}

fn bump_str(version: &str, kind: BumpKind) -> Option<String> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let major: u64 = parts[0].parse().ok()?;
    let minor: u64 = parts[1].parse().ok()?;
    let patch: u64 = parts[2].parse().ok()?;
    let (major, minor, patch) = match kind {
        BumpKind::Major => (major + 1, 0, 0),
        BumpKind::Minor => (major, minor + 1, 0),
        BumpKind::Patch => (major, minor, patch + 1),
    };
    Some(format!("{major}.{minor}.{patch}"))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn toml_line_roundtrip() {
        let (old, new, line) = try_bump_toml_line("version = \"1.2.3\"", BumpKind::Patch).unwrap();
        assert_eq!(old, "1.2.3");
        assert_eq!(new, "1.2.4");
        assert_eq!(line, "version = \"1.2.4\"");
    }

    #[test]
    fn toml_minor_bump() {
        let (_, new, _) = try_bump_toml_line("version = \"2.3.9\"", BumpKind::Minor).unwrap();
        assert_eq!(new, "2.4.0");
    }

    #[test]
    fn toml_major_bump() {
        let (_, new, _) = try_bump_toml_line("version = \"1.9.9\"", BumpKind::Major).unwrap();
        assert_eq!(new, "2.0.0");
    }

    #[test]
    fn toml_ignores_dep_lines() {
        // Inline version fields in dep tables should not match — those don't
        // start at column 0 and use `version = "1"` inside `{ ... }`.
        assert!(try_bump_toml_line("  version = \"1.0.0\"", BumpKind::Patch).is_none());
        assert!(try_bump_toml_line(
            "serde = { version = \"1\", features = [\"derive\"] }",
            BumpKind::Patch
        )
        .is_none());
    }

    #[test]
    fn json_line_roundtrip() {
        let (old, new, line) =
            try_bump_json_line("  \"version\": \"0.1.2\",", BumpKind::Patch).unwrap();
        assert_eq!(old, "0.1.2");
        assert_eq!(new, "0.1.3");
        assert_eq!(line, "  \"version\": \"0.1.3\",");
    }

    #[test]
    fn json_line_without_trailing_comma() {
        let (_, _, line) = try_bump_json_line("  \"version\": \"0.1.2\"", BumpKind::Patch).unwrap();
        assert_eq!(line, "  \"version\": \"0.1.3\"");
    }

    #[test]
    fn json_spacing_variations() {
        let (_, _, line) =
            try_bump_json_line("    \"version\":\"1.0.0\",", BumpKind::Patch).unwrap();
        assert_eq!(line, "    \"version\":\"1.0.1\",");
    }

    #[test]
    fn rejects_malformed_version() {
        assert!(try_bump_toml_line("version = \"1.2\"", BumpKind::Patch).is_none());
        assert!(try_bump_toml_line("version = \"beta\"", BumpKind::Patch).is_none());
    }

    #[test]
    fn optional_generated_missing_targets_are_skippable() {
        assert!(is_optional_generated_target_missing(
            "read apps/notebook/src/wasm/runtimed-wasm/package.json: No such file or directory (os error 2)",
            "apps/notebook/src/wasm/runtimed-wasm/package.json"
        ));
        assert!(is_optional_generated_target_missing(
            "read crates/sift-wasm/pkg/package.json: No such file or directory (os error 2)",
            "crates/sift-wasm/pkg/package.json"
        ));
    }

    #[test]
    fn non_generated_or_non_read_errors_are_not_skippable() {
        assert!(!is_optional_generated_target_missing(
            "read packages/sift/package.json: No such file or directory (os error 2)",
            "packages/sift/package.json"
        ));
        assert!(!is_optional_generated_target_missing(
            "crates/sift-wasm/pkg/package.json: expected 1 version line(s), found 0",
            "crates/sift-wasm/pkg/package.json"
        ));
    }

    #[test]
    fn rust_workspace_crate_versions_are_bump_targets() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .and_then(Path::parent)
            .expect("xtask crate should live under crates/xtask");
        let crates_dir = repo_root.join("crates");

        let versioned_crates: BTreeSet<String> = fs::read_dir(&crates_dir)
            .expect("read crates directory")
            .map(|entry| entry.expect("read crate directory entry").path())
            .filter(|path| path.is_dir())
            .filter_map(|path| {
                let cargo_toml = path.join("Cargo.toml");
                let contents = fs::read_to_string(&cargo_toml).ok()?;
                if contents.lines().any(|line| line.starts_with("version = ")) {
                    Some(
                        cargo_toml
                            .strip_prefix(repo_root)
                            .expect("crate manifest should be under repo root")
                            .to_string_lossy()
                            .replace('\\', "/"),
                    )
                } else {
                    None
                }
            })
            .collect();

        let bump_targets: BTreeSet<String> = TARGETS
            .iter()
            .filter_map(|target| match target.format {
                Format::Toml
                    if target.path.starts_with("crates/")
                        && target.path.ends_with("/Cargo.toml") =>
                {
                    Some(target.path.to_string())
                }
                _ => None,
            })
            .collect();

        let missing_targets: Vec<&String> = versioned_crates.difference(&bump_targets).collect();

        assert!(
            missing_targets.is_empty(),
            "versioned crate manifests missing from bump TARGETS: {missing_targets:#?}"
        );
    }
}
