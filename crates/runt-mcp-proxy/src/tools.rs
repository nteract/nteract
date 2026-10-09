//! Tool cache and tool list divergence detection.

use std::collections::HashSet;
use std::path::Path;

use rmcp::model::Tool;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

fn tool_cache_path(cache_dir: &Path) -> std::path::PathBuf {
    let fingerprint = hex::encode(Sha256::digest(BUILTIN_TOOL_CACHE.as_bytes()));
    cache_dir.join(format!("tool-cache-{fingerprint}.json"))
}

/// Checked-in tool definitions, embedded at compile time.
/// Used as a fallback when no runtime cache exists on disk (e.g., fresh worktrees).
const BUILTIN_TOOL_CACHE: &str = include_str!("../tool-cache.json");

/// Load this embedded catalog revision's disk cache. Missing, corrupt, or empty
/// entries fall back to checked-in definitions; older revision files are ignored.
pub fn load_cached_tools(cache_dir: &Path) -> Option<Vec<Tool>> {
    let path = tool_cache_path(cache_dir);
    if let Ok(data) = std::fs::read_to_string(&path) {
        match serde_json::from_str::<Vec<Tool>>(&data) {
            Ok(tools) if !tools.is_empty() => return Some(tools),
            _ => warn!(
                "Invalid or empty tool cache at {}; using built-in definitions",
                path.display()
            ),
        }
    }
    load_builtin_tools()
}

/// Load the built-in tool cache (compiled into the binary).
/// Used when no cache_dir is configured (e.g., nteract-mcp).
pub fn load_builtin_tools() -> Option<Vec<Tool>> {
    match serde_json::from_str::<Vec<Tool>>(BUILTIN_TOOL_CACHE) {
        Ok(tools) => {
            info!("Loaded {} tools from built-in cache", tools.len());
            Some(tools)
        }
        Err(e) => {
            warn!("Failed to parse built-in tool cache: {e}");
            None
        }
    }
}

/// Save child tool definitions to disk for optimistic serving on next startup.
///
/// The embedded catalog fingerprint namespaces the cache across schema revisions.
/// Legacy caches are left untouched. Empty results keep the prior cache.
pub fn save_tool_cache(cache_dir: &Path, tools: &[Tool]) {
    if tools.is_empty() {
        warn!("Refusing to save empty tool cache to disk");
        return;
    }
    let path = tool_cache_path(cache_dir);
    if let Err(e) = std::fs::create_dir_all(cache_dir) {
        warn!(
            "Failed to create tool cache directory {}: {e}",
            cache_dir.display()
        );
        return;
    }
    match serde_json::to_string_pretty(tools) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                warn!("Failed to write tool cache to {}: {e}", path.display());
            } else {
                info!("Saved {} tools to cache at {}", tools.len(), path.display());
            }
        }
        Err(e) => warn!("Failed to serialize tool cache: {e}"),
    }
}

/// Result of comparing old and new tool lists after a child restart.
#[derive(Debug, PartialEq)]
pub enum ToolDivergence {
    /// Tool names are unchanged. Schema changes refresh in place via catalog
    /// publication; this policy only handles removal or renaming of tools.
    Same,
    /// New tools were added but none removed — safe to continue.
    Superset { added: Vec<String> },
    /// Tools were removed or renamed — MCP client's schema is stale.
    /// Publish the live catalog and continue so clients can relist in place.
    Incompatible {
        removed: Vec<String>,
        added: Vec<String>,
    },
}

/// Compare tool lists before and after a child restart.
pub fn detect_divergence(old_tools: &[Tool], new_tools: &[Tool]) -> ToolDivergence {
    let old_names: HashSet<&str> = old_tools.iter().map(|t| t.name.as_ref()).collect();
    let new_names: HashSet<&str> = new_tools.iter().map(|t| t.name.as_ref()).collect();

    let removed: Vec<String> = old_names
        .difference(&new_names)
        .map(|s| s.to_string())
        .collect();
    let added: Vec<String> = new_names
        .difference(&old_names)
        .map(|s| s.to_string())
        .collect();

    if removed.is_empty() && added.is_empty() {
        ToolDivergence::Same
    } else if removed.is_empty() {
        ToolDivergence::Superset { added }
    } else {
        ToolDivergence::Incompatible { removed, added }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str) -> Tool {
        Tool::new(
            name.to_string(),
            format!("Description for {name}"),
            serde_json::Map::new(),
        )
    }

    // ── detect_divergence() ───────────────────────────────────────────

    #[test]
    fn same_tools() {
        let tools = vec![tool("a"), tool("b")];
        assert_eq!(detect_divergence(&tools, &tools), ToolDivergence::Same);
    }

    #[test]
    fn same_tools_different_order() {
        let old = vec![tool("b"), tool("a")];
        let new = vec![tool("a"), tool("b")];
        assert_eq!(
            detect_divergence(&old, &new),
            ToolDivergence::Same,
            "order should not matter"
        );
    }

    #[test]
    fn both_empty() {
        let empty: Vec<Tool> = vec![];
        assert_eq!(detect_divergence(&empty, &empty), ToolDivergence::Same);
    }

    #[test]
    fn superset_is_safe() {
        let old = vec![tool("a"), tool("b")];
        let new = vec![tool("a"), tool("b"), tool("c")];
        match detect_divergence(&old, &new) {
            ToolDivergence::Superset { added } => {
                assert_eq!(added, vec!["c"]);
            }
            other => panic!("Expected Superset, got {other:?}"),
        }
    }

    #[test]
    fn superset_multiple_additions() {
        let old = vec![tool("a")];
        let new = vec![tool("a"), tool("b"), tool("c"), tool("d")];
        match detect_divergence(&old, &new) {
            ToolDivergence::Superset { added } => {
                assert_eq!(added.len(), 3);
                assert!(added.contains(&"b".to_string()));
                assert!(added.contains(&"c".to_string()));
                assert!(added.contains(&"d".to_string()));
            }
            other => panic!("Expected Superset, got {other:?}"),
        }
    }

    #[test]
    fn from_empty_to_tools_is_superset() {
        let old: Vec<Tool> = vec![];
        let new = vec![tool("a"), tool("b")];
        match detect_divergence(&old, &new) {
            ToolDivergence::Superset { added } => {
                assert_eq!(added.len(), 2);
            }
            other => panic!("Expected Superset, got {other:?}"),
        }
    }

    #[test]
    fn removal_is_incompatible() {
        let old = vec![tool("a"), tool("b"), tool("c")];
        let new = vec![tool("a"), tool("d")];
        match detect_divergence(&old, &new) {
            ToolDivergence::Incompatible { removed, added } => {
                assert!(removed.contains(&"b".to_string()));
                assert!(removed.contains(&"c".to_string()));
                assert!(added.contains(&"d".to_string()));
            }
            other => panic!("Expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn pure_removal_is_incompatible() {
        let old = vec![tool("a"), tool("b"), tool("c")];
        let new = vec![tool("a")];
        match detect_divergence(&old, &new) {
            ToolDivergence::Incompatible { removed, added } => {
                assert_eq!(removed.len(), 2);
                assert!(added.is_empty());
            }
            other => panic!("Expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn all_removed_is_incompatible() {
        let old = vec![tool("a"), tool("b")];
        let new: Vec<Tool> = vec![];
        match detect_divergence(&old, &new) {
            ToolDivergence::Incompatible { removed, added } => {
                assert_eq!(removed.len(), 2);
                assert!(added.is_empty());
            }
            other => panic!("Expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn rename_is_incompatible() {
        // A renamed tool shows up as removal + addition
        let old = vec![tool("connect_notebook"), tool("execute_cell")];
        let new = vec![tool("open_file"), tool("execute_cell")];
        match detect_divergence(&old, &new) {
            ToolDivergence::Incompatible { removed, added } => {
                assert!(removed.contains(&"connect_notebook".to_string()));
                assert!(added.contains(&"open_file".to_string()));
            }
            other => panic!("Expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn complete_replacement_is_incompatible() {
        let old = vec![tool("a"), tool("b")];
        let new = vec![tool("c"), tool("d")];
        match detect_divergence(&old, &new) {
            ToolDivergence::Incompatible { removed, added } => {
                assert_eq!(removed.len(), 2);
                assert_eq!(added.len(), 2);
            }
            other => panic!("Expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn single_tool_same() {
        let tools = vec![tool("only_one")];
        assert_eq!(detect_divergence(&tools, &tools), ToolDivergence::Same);
    }

    // ── Tool cache round-trip ─────────────────────────────────────────

    #[test]
    fn save_and_load_tool_cache() {
        let dir = tempfile::tempdir().unwrap();
        let tools = vec![
            tool("connect_notebook"),
            tool("execute_cell"),
            tool("get_cell"),
        ];

        save_tool_cache(dir.path(), &tools);
        let loaded = load_cached_tools(dir.path()).expect("should load saved tools");

        assert_eq!(loaded.len(), 3);
        let names: Vec<&str> = loaded.iter().map(|t| t.name.as_ref()).collect();
        assert!(names.contains(&"connect_notebook"));
        assert!(names.contains(&"execute_cell"));
        assert!(names.contains(&"get_cell"));
    }

    #[test]
    fn tool_cache_preserves_mcp_apps_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let mut cached = tool("notebook");
        let mut meta = rmcp::model::MetaObject::new();
        meta.insert(
            "ui".to_string(),
            serde_json::json!({"resourceUri": "ui://notebook", "visibility": ["model", "app"]}),
        );
        cached.meta = Some(meta);
        let expected = serde_json::to_value(&cached).unwrap();

        save_tool_cache(dir.path(), &[cached]);
        let loaded = load_cached_tools(dir.path()).unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(serde_json::to_value(&loaded[0]).unwrap(), expected);
    }

    #[test]
    fn load_falls_back_to_builtin_when_no_cache_file() {
        let dir = tempfile::tempdir().unwrap();
        // With no cache file on disk, should fall back to built-in cache
        let tools = load_cached_tools(dir.path());
        assert!(tools.is_some(), "should fall back to built-in cache");
        assert!(
            !tools.unwrap().is_empty(),
            "built-in cache should have tools"
        );
    }

    #[test]
    fn invalid_and_empty_cache_fall_back_to_builtin() {
        let dir = tempfile::tempdir().unwrap();
        for content in ["not json", "[]"] {
            std::fs::write(tool_cache_path(dir.path()), content).unwrap();
            assert_eq!(load_cached_tools(dir.path()), load_builtin_tools());
        }
    }

    #[test]
    fn old_revision_and_legacy_cache_are_ignored_and_preserved() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["tool-cache.json", "tool-cache-old-revision.json"] {
            let path = dir.path().join(name);
            std::fs::write(
                &path,
                serde_json::to_string(&vec![tool("obsolete")]).unwrap(),
            )
            .unwrap();
            assert_eq!(load_cached_tools(dir.path()), load_builtin_tools());
            save_tool_cache(dir.path(), &[tool("current")]);
            assert!(std::fs::read_to_string(path).unwrap().contains("obsolete"));
            std::fs::remove_file(tool_cache_path(dir.path())).unwrap();
        }
    }

    #[test]
    fn save_creates_nested_cache_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("cli/headless");
        let expected = vec![tool("current")];
        save_tool_cache(&nested, &expected);
        assert_eq!(load_cached_tools(&nested), Some(expected));
    }

    #[test]
    fn save_refuses_empty_cache() {
        // Empty discovery must not replace a previously useful disk cache.
        let dir = tempfile::tempdir().unwrap();
        let tools: Vec<Tool> = vec![];
        save_tool_cache(dir.path(), &tools);
        assert!(
            !tool_cache_path(dir.path()).exists(),
            "empty cache must not be persisted"
        );
    }

    #[test]
    fn save_overwrites_existing_cache() {
        let dir = tempfile::tempdir().unwrap();

        let tools_v1 = vec![tool("a"), tool("b")];
        save_tool_cache(dir.path(), &tools_v1);

        let tools_v2 = vec![tool("c"), tool("d"), tool("e")];
        save_tool_cache(dir.path(), &tools_v2);

        let loaded = load_cached_tools(dir.path()).unwrap();
        assert_eq!(loaded.len(), 3);
        let names: Vec<&str> = loaded.iter().map(|t| t.name.as_ref()).collect();
        assert!(names.contains(&"c"));
        assert!(!names.contains(&"a"));
    }
}
