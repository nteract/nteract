//! Notebook session tracking — records the notebook_id of session-establishing
//! tool calls so that when the child is restarted, the supervisor can seed the
//! new child's `NTERACT_MCP_REJOIN_NOTEBOOK` env var and let the child's
//! `daemon_watch` loop re-join on its first `Connected` event.

use rmcp::model::{CallToolRequestParams, CallToolResult};
use serde_json::Value;

/// Track notebook_id from session-establishing tool calls.
///
/// When `connect_notebook` or `create_notebook` succeeds, returns the notebook_id
/// to persist for seeding the next child restart.
///
/// Checks request arguments first (connect_notebook passes path/notebook_id),
/// then falls back to parsing the response content (create_notebook returns
/// notebook_id in its JSON response, not in request args).
pub fn extract_session_id(
    params: &CallToolRequestParams,
    result: &CallToolResult,
) -> Option<String> {
    // Only track successful calls
    if result.is_error == Some(true) {
        return None;
    }

    let name: &str = &params.name;
    match name {
        // `open_notebook` kept for one release as a legacy alias — clients
        // may still be invoking it from stale tool caches.
        "connect_notebook" | "open_notebook" | "create_notebook" => {
            // Try request arguments first (connect_notebook)
            let from_args = params.arguments.as_ref().and_then(|args| {
                let target = args.get("target").and_then(Value::as_str);
                if target.is_some() {
                    return target.map(String::from);
                }

                let notebook_id = args.get("notebook_id").and_then(Value::as_str);
                let domain = args.get("domain").and_then(Value::as_str);
                if let (Some(notebook_id), Some(domain)) = (notebook_id, domain) {
                    if !is_local_domain_alias(domain) {
                        return Some(hosted_notebook_target(domain, notebook_id));
                    }
                }

                notebook_id
                    .or_else(|| args.get("path").and_then(Value::as_str))
                    .map(String::from)
            });

            if from_args.is_some() {
                return from_args;
            }

            // Fall back to parsing the response content (create_notebook returns
            // notebook_id in its JSON text response body)
            extract_notebook_id_from_result(result)
        }
        _ => None,
    }
}

/// Parse notebook_id from a tool result's text content (JSON response body).
fn extract_notebook_id_from_result(result: &CallToolResult) -> Option<String> {
    for content in &result.content {
        if let Some(text) = content.raw.as_text() {
            if let Ok(json) = serde_json::from_str::<Value>(&text.text) {
                if let Some(id) = json.get("notebook_id").and_then(Value::as_str) {
                    return Some(id.to_string());
                }
            }
        }
    }
    None
}

fn is_local_domain_alias(domain: &str) -> bool {
    matches!(
        domain.trim().to_ascii_lowercase().as_str(),
        "local" | "desktop"
    )
}

fn hosted_notebook_target(domain: &str, notebook_id: &str) -> String {
    format!("{}/n/{}", domain.trim().trim_end_matches('/'), notebook_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::Content;

    fn make_params(name: &str, args: serde_json::Value) -> CallToolRequestParams {
        serde_json::from_value(serde_json::json!({
            "name": name,
            "arguments": args
        }))
        .unwrap()
    }

    fn success_result() -> CallToolResult {
        CallToolResult::success(vec![Content::text("ok")])
    }

    fn error_result() -> CallToolResult {
        let mut result = CallToolResult::success(vec![Content::text("error")]);
        result.is_error = Some(true);
        result
    }

    // ── connect_notebook tracking ────────────────────────────────────────

    #[test]
    fn tracks_connect_notebook_with_path() {
        let params = make_params(
            "connect_notebook",
            serde_json::json!({"path": "/tmp/test.ipynb"}),
        );
        assert_eq!(
            extract_session_id(&params, &success_result()),
            Some("/tmp/test.ipynb".to_string())
        );
    }

    #[test]
    fn tracks_connect_notebook_with_notebook_id() {
        let params = make_params(
            "connect_notebook",
            serde_json::json!({"notebook_id": "abc-123-def"}),
        );
        assert_eq!(
            extract_session_id(&params, &success_result()),
            Some("abc-123-def".to_string())
        );
    }

    #[test]
    fn tracks_connect_notebook_with_hosted_notebook_id_and_domain() {
        let params = make_params(
            "connect_notebook",
            serde_json::json!({
                "notebook_id": "01KTZA152886TK1WAHYA48G7HJ",
                "domain": "https://preview.runt.run/"
            }),
        );
        assert_eq!(
            extract_session_id(&params, &success_result()),
            Some("https://preview.runt.run/n/01KTZA152886TK1WAHYA48G7HJ".to_string())
        );
    }

    #[test]
    fn tracks_connect_notebook_with_local_domain_as_local_id() {
        let params = make_params(
            "connect_notebook",
            serde_json::json!({
                "notebook_id": "550e8400-e29b-41d4-a716-446655440000",
                "domain": " desktop "
            }),
        );
        assert_eq!(
            extract_session_id(&params, &success_result()),
            Some("550e8400-e29b-41d4-a716-446655440000".to_string())
        );
    }

    #[test]
    fn tracks_connect_notebook_with_target_first() {
        let params = make_params(
            "connect_notebook",
            serde_json::json!({
                "target": "https://preview.runt.run/n/01KTZA152886TK1WAHYA48G7HJ/view-only-quill",
                "notebook_id": "550e8400-e29b-41d4-a716-446655440000",
                "path": "/tmp/test.ipynb"
            }),
        );
        assert_eq!(
            extract_session_id(&params, &success_result()),
            Some(
                "https://preview.runt.run/n/01KTZA152886TK1WAHYA48G7HJ/view-only-quill".to_string()
            )
        );
    }

    #[test]
    fn prefers_notebook_id_over_path() {
        let params = make_params(
            "connect_notebook",
            serde_json::json!({"notebook_id": "abc-123", "path": "/tmp/test.ipynb"}),
        );
        assert_eq!(
            extract_session_id(&params, &success_result()),
            Some("abc-123".to_string())
        );
    }

    // ── create_notebook tracking ──────────────────────────────────────

    #[test]
    fn tracks_create_notebook_with_path_arg() {
        let params = make_params(
            "create_notebook",
            serde_json::json!({"path": "/tmp/new.ipynb"}),
        );
        assert_eq!(
            extract_session_id(&params, &success_result()),
            Some("/tmp/new.ipynb".to_string())
        );
    }

    #[test]
    fn tracks_create_notebook_with_notebook_id_arg() {
        let params = make_params(
            "create_notebook",
            serde_json::json!({"notebook_id": "new-uuid"}),
        );
        assert_eq!(
            extract_session_id(&params, &success_result()),
            Some("new-uuid".to_string())
        );
    }

    #[test]
    fn tracks_create_notebook_from_response() {
        let params = make_params("create_notebook", serde_json::json!({}));
        let result = CallToolResult::success(vec![Content::text(
            r#"{"notebook_id": "8540eb53-8609-471d-88f4-5c3e92c3b396", "runtime": {"language": "python"}}"#,
        )]);
        assert_eq!(
            extract_session_id(&params, &result),
            Some("8540eb53-8609-471d-88f4-5c3e92c3b396".to_string())
        );
    }

    #[test]
    fn tracks_create_notebook_with_deps_from_response() {
        let params = make_params(
            "create_notebook",
            serde_json::json!({"dependencies": ["numpy", "pandas"]}),
        );
        let result = CallToolResult::success(vec![Content::text(
            r#"{"notebook_id": "abc-123", "runtime": {"language": "python"}, "dependencies": ["numpy", "pandas"], "package_manager": "uv"}"#,
        )]);
        assert_eq!(
            extract_session_id(&params, &result),
            Some("abc-123".to_string())
        );
    }

    // ── Tools that should NOT be tracked ──────────────────────────────

    #[test]
    fn ignores_execute_cell() {
        let params = make_params("execute_cell", serde_json::json!({"cell_id": "abc"}));
        assert_eq!(extract_session_id(&params, &success_result()), None);
    }

    #[test]
    fn ignores_save_notebook() {
        let params = make_params(
            "save_notebook",
            serde_json::json!({"path": "/tmp/test.ipynb"}),
        );
        assert_eq!(extract_session_id(&params, &success_result()), None);
    }

    #[test]
    fn ignores_list_active_notebooks() {
        let params = make_params("list_active_notebooks", serde_json::json!({}));
        assert_eq!(extract_session_id(&params, &success_result()), None);
    }

    // ── Legacy alias (one-release compat) ─────────────────────────────

    #[test]
    fn legacy_open_notebook_alias_still_tracked() {
        // Clients with stale tool caches may invoke `open_notebook`; the
        // session tracker must still record the notebook_id.
        let params = make_params(
            "open_notebook",
            serde_json::json!({"path": "/tmp/test.ipynb"}),
        );
        assert_eq!(
            extract_session_id(&params, &success_result()),
            Some("/tmp/test.ipynb".to_string())
        );
    }

    // ── Error handling ────────────────────────────────────────────────

    #[test]
    fn ignores_connect_notebook_error() {
        let params = make_params(
            "connect_notebook",
            serde_json::json!({"path": "/tmp/test.ipynb"}),
        );
        assert_eq!(extract_session_id(&params, &error_result()), None);
    }

    #[test]
    fn treats_is_error_none_as_success() {
        let params = make_params(
            "connect_notebook",
            serde_json::json!({"path": "/tmp/test.ipynb"}),
        );
        let mut result = CallToolResult::success(vec![Content::text("ok")]);
        result.is_error = None;
        assert_eq!(
            extract_session_id(&params, &result),
            Some("/tmp/test.ipynb".to_string())
        );
    }

    // ── Edge cases ────────────────────────────────────────────────────

    #[test]
    fn returns_none_when_arguments_empty_and_no_response_id() {
        let params = make_params("connect_notebook", serde_json::json!({}));
        assert_eq!(extract_session_id(&params, &success_result()), None);
    }

    #[test]
    fn returns_none_when_path_is_not_string() {
        let params = make_params("connect_notebook", serde_json::json!({"path": 42}));
        assert_eq!(extract_session_id(&params, &success_result()), None);
    }
}
