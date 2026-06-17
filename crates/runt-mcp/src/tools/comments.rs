//! CommentsDoc tools for durable notebook comment threads.

use notebook_protocol::protocol::{NotebookRequest, NotebookResponse};
use rmcp::model::{CallToolRequestParams, CallToolResult, Content};
use rmcp::ErrorData as McpError;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::NteractMcp;

use super::{arg_bool, arg_str, assert_cell_exists, reject_unknown_args, tool_error};

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListCommentsParams {
    /// Filter to threads badged on this cell.
    #[serde(default)]
    pub cell_id: Option<String>,
    /// Include resolved threads. Defaults to true.
    #[serde(default)]
    pub include_resolved: Option<bool>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateCommentThreadParams {
    /// Anchor for the new thread.
    pub anchor: CommentAnchorInput,
    /// First message body.
    pub body: String,
    /// Insert after this thread within the same anchor scope.
    #[serde(default)]
    pub after_thread_id: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReplyCommentThreadParams {
    /// Thread ID to reply to.
    pub thread_id: String,
    /// Reply message body.
    pub body: String,
    /// Insert after this message in the thread.
    #[serde(default)]
    pub after_message_id: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResolveCommentThreadParams {
    /// Thread ID to mark resolved.
    pub thread_id: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReopenCommentThreadParams {
    /// Thread ID to reopen.
    pub thread_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CommentAnchorInput {
    /// Notebook-level thread not badged to a specific cell.
    Notebook,
    Cell {
        /// Cell ID from the cells resource or notebook cell list.
        cell_id: String,
        /// Optional observed fractional cell position; omitted values are filled from the active notebook.
        #[serde(default)]
        observed_cell_position: Option<String>,
    },
    CellRange {
        /// First cell ID in the range.
        start_cell_id: String,
        /// Last cell ID in the range.
        end_cell_id: String,
        /// Optional observed fractional position for start_cell_id; omitted values are filled from the active notebook.
        #[serde(default)]
        start_position: Option<String>,
        /// Optional observed fractional position for end_cell_id; omitted values are filled from the active notebook.
        #[serde(default)]
        end_position: Option<String>,
    },
    SourceRange {
        /// Cell ID containing the source span.
        cell_id: String,
        /// Zero-based start line.
        start_line: u64,
        /// Zero-based start column.
        start_column: u64,
        /// Zero-based end line.
        end_line: u64,
        /// Zero-based end column; must be after or equal to the start position.
        end_column: u64,
        /// Optional source text before the exact quote, used for anchor repair.
        #[serde(default)]
        prefix_quote: Option<String>,
        /// Optional exact selected source text, used for anchor repair.
        #[serde(default)]
        exact_quote: Option<String>,
        /// Optional source text after the exact quote, used for anchor repair.
        #[serde(default)]
        suffix_quote: Option<String>,
    },
    Output {
        /// Cell ID whose output is being discussed.
        cell_id: String,
        /// Optional execution_id from the cell/resource output metadata.
        #[serde(default)]
        execution_id: Option<String>,
        /// Optional output_id from the cell/resource output metadata.
        #[serde(default)]
        output_id: Option<String>,
    },
}

impl CommentAnchorInput {
    fn into_anchor(
        self,
        handle: &notebook_sync::handle::DocHandle,
    ) -> Result<comments_doc::CommentAnchor, McpError> {
        match self {
            Self::Notebook => Ok(comments_doc::CommentAnchor::Notebook),
            Self::Cell {
                cell_id,
                observed_cell_position,
            } => {
                assert_cell_exists(handle, &cell_id)?;
                Ok(comments_doc::CommentAnchor::Cell {
                    observed_cell_position: observed_cell_position
                        .or_else(|| handle.get_cell_position(&cell_id)),
                    cell_id,
                })
            }
            Self::CellRange {
                start_cell_id,
                end_cell_id,
                start_position,
                end_position,
            } => {
                assert_cell_exists(handle, &start_cell_id)?;
                assert_cell_exists(handle, &end_cell_id)?;
                Ok(comments_doc::CommentAnchor::CellRange {
                    start_position: start_position
                        .or_else(|| handle.get_cell_position(&start_cell_id)),
                    end_position: end_position.or_else(|| handle.get_cell_position(&end_cell_id)),
                    start_cell_id,
                    end_cell_id,
                })
            }
            Self::SourceRange {
                cell_id,
                start_line,
                start_column,
                end_line,
                end_column,
                prefix_quote,
                exact_quote,
                suffix_quote,
            } => {
                assert_cell_exists(handle, &cell_id)?;
                let anchor = comments_doc::CommentAnchor::SourceRange {
                    cell_id,
                    start_line,
                    start_column,
                    end_line,
                    end_column,
                    prefix_quote,
                    exact_quote,
                    suffix_quote,
                };
                validate_anchor_for_create(&anchor)?;
                Ok(anchor)
            }
            Self::Output {
                cell_id,
                execution_id,
                output_id,
            } => {
                assert_cell_exists(handle, &cell_id)?;
                Ok(comments_doc::CommentAnchor::Output {
                    cell_id,
                    execution_id,
                    output_id,
                })
            }
        }
    }
}

/// List durable notebook comments.
pub async fn list_comments(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(request, &["cell_id", "include_resolved"])?;
    let cell_id = arg_str(request, "cell_id");
    let include_resolved = arg_bool(request, "include_resolved").unwrap_or(true);

    let handle = require_handle!(server);
    if let Some(cell_id) = cell_id {
        assert_cell_exists(&handle, cell_id)?;
    }
    confirm_comments_sync(&handle, "list_comments").await?;

    let projection = match handle.get_comments_projection() {
        Ok(projection) => projection,
        Err(e) => return comments_tool_error("Comments are not ready", e),
    };
    let threads: Vec<_> = filter_threads(projection.threads, cell_id, include_resolved)
        .iter()
        .map(|thread| crate::resources::comment_thread_value(handle.notebook_id(), thread))
        .collect();
    let value = serde_json::json!({
        "notebook_id": handle.notebook_id(),
        "comments_doc_id": projection.comments_doc_id,
        "threads": threads,
        "resources": crate::resources::notebook_resources_json(handle.notebook_id()),
    });

    comments_resource_json_success(value, handle.notebook_id())
}

/// Create a comment thread.
pub async fn create_comment_thread(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(request, &["anchor", "body", "after_thread_id"])?;
    let body = required_body(request)?;
    let anchor = required_anchor(request)?;
    let after_thread_id = arg_str(request, "after_thread_id");
    let handle = require_handle!(server);
    confirm_comments_sync(&handle, "create_comment_thread bootstrap").await?;

    let anchor = anchor.into_anchor(&handle)?;
    let after_thread_id_owned = match after_thread_id {
        Some(thread_id) => Some(thread_id.to_string()),
        None => match default_after_thread_id(&handle, &anchor) {
            Ok(thread_id) => thread_id,
            Err(e) => return comments_tool_error("Failed to inspect existing comments", *e),
        },
    };
    let thread_id = format!("thread-{}", uuid::Uuid::new_v4());
    let message_id = format!("message-{}", uuid::Uuid::new_v4());
    let created_at = current_timestamp();
    let created = match handle.create_comment_thread(
        &thread_id,
        &message_id,
        &anchor,
        body,
        after_thread_id_owned.as_deref(),
        &created_at,
    ) {
        Ok(created) => created,
        Err(e) => return comments_tool_error("Failed to create comment thread", e),
    };
    let observed_comments_heads = match handle.current_comments_heads_hex() {
        Ok(heads) => heads,
        Err(e) => return comments_tool_error("Failed to capture comment heads after create", e),
    };
    confirm_comments_sync(&handle, "create_comment_thread").await?;
    if let Err(error) = send_comment_authority_request(
        &handle,
        NotebookRequest::AcceptCommentThread {
            thread_id: created.thread_id.clone(),
            message_id: created.message_id.clone(),
            observed_comments_heads,
        },
        "accept comment thread",
    )
    .await
    {
        return tool_error(&error);
    }
    confirm_comments_sync(&handle, "create_comment_thread authority accept").await?;
    let projection = match handle.get_comments_projection() {
        Ok(projection) => projection,
        Err(e) => return comments_tool_error("Failed to read comments after create", e),
    };
    let thread = projected_thread(&projection, &created.thread_id, "create")?;
    let thread = crate::resources::comment_thread_value(handle.notebook_id(), &thread);

    let value = serde_json::json!({
        "notebook_id": handle.notebook_id(),
        "comments_doc_id": projection.comments_doc_id,
        "thread_id": created.thread_id,
        "message_id": created.message_id,
        "thread": thread,
        "resources": crate::resources::notebook_resources_json(handle.notebook_id()),
    });
    comments_resource_json_success(value, handle.notebook_id())
}

/// Add a reply to a comment thread.
pub async fn reply_comment_thread(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(request, &["thread_id", "body", "after_message_id"])?;
    let thread_id = arg_str(request, "thread_id")
        .ok_or_else(|| McpError::invalid_params("Missing required parameter: thread_id", None))?;
    let body = required_body(request)?;
    let after_message_id = arg_str(request, "after_message_id");
    let handle = require_handle!(server);
    confirm_comments_sync(&handle, "reply_comment_thread bootstrap").await?;

    let after_message_id_owned = match after_message_id {
        Some(message_id) => Some(message_id.to_string()),
        None => match default_after_message_id(&handle, thread_id) {
            Ok(message_id) => message_id,
            Err(e) => return comments_tool_error("Failed to inspect existing comments", *e),
        },
    };
    let message_id = format!("message-{}", uuid::Uuid::new_v4());
    let created_at = current_timestamp();
    let replied = match handle.reply_to_comment_thread(
        thread_id,
        &message_id,
        body,
        after_message_id_owned.as_deref(),
        &created_at,
    ) {
        Ok(replied) => replied,
        Err(e) => return comments_tool_error("Failed to reply to comment thread", e),
    };
    let observed_comments_heads = match handle.current_comments_heads_hex() {
        Ok(heads) => heads,
        Err(e) => return comments_tool_error("Failed to capture comment heads after reply", e),
    };
    confirm_comments_sync(&handle, "reply_comment_thread").await?;
    if let Err(error) = send_comment_authority_request(
        &handle,
        NotebookRequest::AcceptCommentMessage {
            thread_id: replied.thread_id.clone(),
            message_id: replied.message_id.clone(),
            observed_comments_heads,
        },
        "accept comment reply",
    )
    .await
    {
        return tool_error(&error);
    }
    confirm_comments_sync(&handle, "reply_comment_thread authority accept").await?;
    let projection = match handle.get_comments_projection() {
        Ok(projection) => projection,
        Err(e) => return comments_tool_error("Failed to read comments after reply", e),
    };
    let thread = projected_thread(&projection, &replied.thread_id, "reply")?;
    let thread = crate::resources::comment_thread_value(handle.notebook_id(), &thread);

    let value = serde_json::json!({
        "notebook_id": handle.notebook_id(),
        "comments_doc_id": projection.comments_doc_id,
        "thread_id": replied.thread_id,
        "message_id": replied.message_id,
        "thread": thread,
        "resources": crate::resources::notebook_resources_json(handle.notebook_id()),
    });
    comments_resource_json_success(value, handle.notebook_id())
}

/// Mark a comment thread resolved through the daemon authority.
pub async fn resolve_comment_thread(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    update_comment_thread_status(server, request, CommentThreadStatusAction::Resolve).await
}

/// Reopen a comment thread through the daemon authority.
pub async fn reopen_comment_thread(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    update_comment_thread_status(server, request, CommentThreadStatusAction::Reopen).await
}

#[derive(Debug, Clone, Copy)]
enum CommentThreadStatusAction {
    Resolve,
    Reopen,
}

impl CommentThreadStatusAction {
    fn verb(self) -> &'static str {
        match self {
            Self::Resolve => "resolve",
            Self::Reopen => "reopen",
        }
    }

    fn request(self, thread_id: String, observed_comments_heads: Vec<String>) -> NotebookRequest {
        match self {
            Self::Resolve => NotebookRequest::ResolveCommentThread {
                thread_id,
                observed_comments_heads,
            },
            Self::Reopen => NotebookRequest::ReopenCommentThread {
                thread_id,
                observed_comments_heads,
            },
        }
    }
}

async fn update_comment_thread_status(
    server: &NteractMcp,
    request: &CallToolRequestParams,
    action: CommentThreadStatusAction,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(request, &["thread_id"])?;
    let thread_id = required_thread_id(request)?;
    let handle = require_handle!(server);
    confirm_comments_sync(&handle, "comment thread status bootstrap").await?;
    let observed_comments_heads = match handle.current_comments_heads_hex() {
        Ok(heads) => heads,
        Err(e) => return comments_tool_error("Failed to capture comment heads for status", e),
    };

    match handle
        .send_request(action.request(thread_id.to_string(), observed_comments_heads))
        .await
    {
        Ok(NotebookResponse::Ok {}) => {}
        Ok(NotebookResponse::Error { error }) => {
            return tool_error(&format!(
                "Failed to {} comment thread: {error}",
                action.verb()
            ));
        }
        Ok(other) => {
            return tool_error(&format!(
                "Failed to {} comment thread: unexpected daemon response {other:?}",
                action.verb()
            ));
        }
        Err(error) => {
            return tool_error(&format!(
                "Failed to {} comment thread: {error}",
                action.verb()
            ));
        }
    }

    confirm_comments_sync(&handle, "comment thread status").await?;
    let projection = match handle.get_comments_projection() {
        Ok(projection) => projection,
        Err(e) => return comments_tool_error("Failed to read comments after status update", e),
    };
    let thread = projected_thread(&projection, thread_id, action.verb())?;
    let thread = crate::resources::comment_thread_value(handle.notebook_id(), &thread);

    let value = serde_json::json!({
        "notebook_id": handle.notebook_id(),
        "comments_doc_id": projection.comments_doc_id,
        "thread_id": thread_id,
        "thread": thread,
        "resources": crate::resources::notebook_resources_json(handle.notebook_id()),
    });
    comments_resource_json_success(value, handle.notebook_id())
}

async fn send_comment_authority_request(
    handle: &notebook_sync::handle::DocHandle,
    request: NotebookRequest,
    action: &str,
) -> Result<(), String> {
    match handle.send_request(request).await {
        Ok(NotebookResponse::Ok {}) => Ok(()),
        Ok(NotebookResponse::Error { error }) => Err(format!(
            "Failed to {action} through daemon authority: {error}"
        )),
        Ok(other) => Err(format!(
            "Failed to {action} through daemon authority: unexpected daemon response {other:?}"
        )),
        Err(error) => Err(format!(
            "Failed to {action} through daemon authority: {error}"
        )),
    }
}

fn required_anchor(request: &CallToolRequestParams) -> Result<CommentAnchorInput, McpError> {
    let value = request
        .arguments
        .as_ref()
        .and_then(|args| args.get("anchor"))
        .ok_or_else(|| McpError::invalid_params("Missing required parameter: anchor", None))?;
    serde_json::from_value(value.clone())
        .map_err(|e| McpError::invalid_params(format!("Invalid anchor: {e}"), None))
}

fn required_thread_id(request: &CallToolRequestParams) -> Result<&str, McpError> {
    let thread_id = arg_str(request, "thread_id")
        .ok_or_else(|| McpError::invalid_params("Missing required parameter: thread_id", None))?;
    if thread_id.trim().is_empty() {
        return Err(McpError::invalid_params("thread_id cannot be empty", None));
    }
    Ok(thread_id)
}

fn required_body(request: &CallToolRequestParams) -> Result<&str, McpError> {
    let body = arg_str(request, "body")
        .ok_or_else(|| McpError::invalid_params("Missing required parameter: body", None))?;
    if body.trim().is_empty() {
        return Err(McpError::invalid_params("body cannot be empty", None));
    }
    Ok(body)
}

fn validate_anchor_for_create(anchor: &comments_doc::CommentAnchor) -> Result<(), McpError> {
    if let comments_doc::CommentAnchor::SourceRange {
        start_line,
        start_column,
        end_line,
        end_column,
        exact_quote,
        ..
    } = anchor
    {
        if start_line == end_line && start_column == end_column {
            return Err(McpError::invalid_params(
                "source_range must select at least one source character",
                None,
            ));
        }
        let Some(exact_quote) = exact_quote
            .as_deref()
            .filter(|quote| !quote.trim().is_empty())
        else {
            return Err(McpError::invalid_params(
                "source_range exact_quote is required and must not be whitespace-only",
                None,
            ));
        };
        if exact_quote.len() > comments_doc::MAX_SOURCE_COMMENT_QUOTE_BYTES {
            return Err(McpError::invalid_params(
                format!(
                    "source_range exact_quote exceeds {} bytes",
                    comments_doc::MAX_SOURCE_COMMENT_QUOTE_BYTES
                ),
                None,
            ));
        }
    }

    comments_doc::validate_comment_anchor(anchor)
        .map_err(|error| McpError::invalid_params(error, None))
}

fn current_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn default_after_thread_id(
    handle: &notebook_sync::handle::DocHandle,
    anchor: &comments_doc::CommentAnchor,
) -> Result<Option<String>, Box<notebook_sync::SyncError>> {
    let projection = handle.get_comments_projection().map_err(Box::new)?;
    Ok(last_thread_id_in_scope(&projection, anchor))
}

fn default_after_message_id(
    handle: &notebook_sync::handle::DocHandle,
    thread_id: &str,
) -> Result<Option<String>, Box<notebook_sync::SyncError>> {
    let projection = handle.get_comments_projection().map_err(Box::new)?;
    Ok(last_message_id_in_thread(&projection, thread_id))
}

fn last_thread_id_in_scope(
    projection: &comments_doc::CommentsProjection,
    anchor: &comments_doc::CommentAnchor,
) -> Option<String> {
    let scope = anchor.thread_order_scope();
    projection
        .threads
        .iter()
        .rfind(|thread| thread.anchor.thread_order_scope() == scope)
        .map(|thread| thread.id.clone())
}

fn last_message_id_in_thread(
    projection: &comments_doc::CommentsProjection,
    thread_id: &str,
) -> Option<String> {
    projection
        .threads
        .iter()
        .find(|thread| thread.id == thread_id)
        .and_then(|thread| thread.messages.last())
        .map(|message| message.id.clone())
}

async fn confirm_comments_sync(
    handle: &notebook_sync::handle::DocHandle,
    action: &str,
) -> Result<(), McpError> {
    handle.confirm_state_sync().await.map_err(|e| {
        McpError::internal_error(format!("Failed to sync comments for {action}: {e}"), None)
    })
}

fn comments_tool_error(
    prefix: &str,
    error: notebook_sync::SyncError,
) -> Result<CallToolResult, McpError> {
    match error {
        notebook_sync::SyncError::CommentsDoc(
            comments_doc::CommentsDocError::MissingCommentsDocId,
        ) => tool_error(&format!(
            "{prefix}: CommentsDoc is not ready yet. Retry after the notebook finishes syncing."
        )),
        other => tool_error(&format!("{prefix}: {other}")),
    }
}

fn projected_thread(
    projection: &comments_doc::CommentsProjection,
    thread_id: &str,
    action: &str,
) -> Result<comments_doc::CommentThreadSnapshot, McpError> {
    projection
        .threads
        .iter()
        .find(|thread| thread.id == thread_id)
        .cloned()
        .ok_or_else(|| {
            McpError::internal_error(
                format!(
                    "Comment thread {thread_id} was not visible after {action}; retry list_comments"
                ),
                None,
            )
        })
}

fn filter_threads(
    threads: Vec<comments_doc::CommentThreadSnapshot>,
    cell_id: Option<&str>,
    include_resolved: bool,
) -> Vec<comments_doc::CommentThreadSnapshot> {
    threads
        .into_iter()
        .filter(|thread| {
            include_resolved || thread.status != comments_doc::ProjectedThreadStatus::Resolved
        })
        .filter(|thread| match cell_id {
            Some(cell_id) => thread.badge_cell_ids.iter().any(|id| id == cell_id),
            None => true,
        })
        .collect()
}

fn comments_resource_json_success(
    result: serde_json::Value,
    notebook_id: &str,
) -> Result<CallToolResult, McpError> {
    let mut content = vec![
        Content::text(serde_json::to_string_pretty(&result).unwrap_or_default()),
        Content::resource_link(crate::resources::notebook_comments_resource_link(
            notebook_id,
        )),
    ];
    if let Some(thread_id) = result.get("thread_id").and_then(serde_json::Value::as_str) {
        content.push(Content::resource_link(
            crate::resources::notebook_comment_thread_resource_link(notebook_id, thread_id),
        ));
    }
    if let Some(cell_id) = result
        .get("thread")
        .and_then(|thread| thread.get("badge_cell_ids"))
        .and_then(serde_json::Value::as_array)
        .and_then(|ids| ids.first())
        .and_then(serde_json::Value::as_str)
    {
        content.push(Content::resource_link(
            crate::resources::notebook_cell_comments_resource_link(notebook_id, cell_id),
        ));
    }
    Ok(CallToolResult::success(content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cell_anchor_input() {
        let anchor: CommentAnchorInput = serde_json::from_value(serde_json::json!({
            "kind": "cell",
            "cell_id": "cell-1"
        }))
        .expect("anchor parses");

        assert!(matches!(anchor, CommentAnchorInput::Cell { .. }));
    }

    #[test]
    fn source_range_validation_rejects_inverted_spans() {
        assert!(validate_anchor_for_create(&source_anchor(10, 0, 9, 99, Some("quote"))).is_err());
        assert!(validate_anchor_for_create(&source_anchor(10, 8, 10, 7, Some("quote"))).is_err());
        assert!(validate_anchor_for_create(&source_anchor(10, 7, 11, 0, Some("quote"))).is_ok());
    }

    #[test]
    fn source_range_validation_requires_non_empty_exact_quote() {
        assert!(validate_anchor_for_create(&source_anchor(10, 7, 10, 7, Some("x"))).is_err());
        assert!(validate_anchor_for_create(&source_anchor(10, 7, 10, 8, None)).is_err());
        assert!(validate_anchor_for_create(&source_anchor(10, 7, 10, 8, Some(""))).is_err());
        assert!(validate_anchor_for_create(&source_anchor(10, 7, 10, 8, Some("   "))).is_err());
        assert!(validate_anchor_for_create(&source_anchor(10, 7, 10, 8, Some("x"))).is_ok());
    }

    #[test]
    fn source_range_validation_rejects_oversized_quotes() {
        let anchor = source_anchor(
            0,
            0,
            0,
            0,
            Some(&"x".repeat(comments_doc::MAX_SOURCE_COMMENT_QUOTE_BYTES + 1)),
        );

        assert!(validate_anchor_for_create(&anchor).is_err());
    }

    #[test]
    fn filters_resolved_threads_by_default_flag() {
        let threads = vec![
            comments_doc::CommentThreadSnapshot {
                id: "open".into(),
                anchor: comments_doc::CommentAnchor::Notebook,
                position: "80".into(),
                status: comments_doc::ProjectedThreadStatus::Open,
                mutation_state: comments_doc::ProjectedMutationState::Pending,
                trusted: false,
                messages: Vec::new(),
                badge_cell_ids: vec!["cell-1".into()],
                created_at: String::new(),
                created_by_actor_label: None,
                created_by_authority: None,
                rejection_reason: None,
                resolved_at: None,
                resolved_by_actor_label: None,
                resolved_by_authority: None,
            },
            comments_doc::CommentThreadSnapshot {
                id: "resolved".into(),
                anchor: comments_doc::CommentAnchor::Notebook,
                position: "81".into(),
                status: comments_doc::ProjectedThreadStatus::Resolved,
                mutation_state: comments_doc::ProjectedMutationState::Accepted,
                trusted: true,
                messages: Vec::new(),
                badge_cell_ids: vec!["cell-1".into()],
                created_at: String::new(),
                created_by_actor_label: None,
                created_by_authority: None,
                rejection_reason: None,
                resolved_at: None,
                resolved_by_actor_label: None,
                resolved_by_authority: None,
            },
        ];

        let filtered = filter_threads(threads, Some("cell-1"), false);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "open");
    }

    #[test]
    fn omitted_after_ids_default_to_last_visible_item() {
        let projection = comments_doc::CommentsProjection {
            comments_doc_id: "comments:test".into(),
            threads: vec![
                thread_snapshot(
                    "thread-1",
                    comments_doc::CommentAnchor::Notebook,
                    vec![message_snapshot("message-1")],
                ),
                thread_snapshot(
                    "thread-2",
                    comments_doc::CommentAnchor::Notebook,
                    vec![message_snapshot("message-2"), message_snapshot("message-3")],
                ),
                thread_snapshot(
                    "thread-cell",
                    comments_doc::CommentAnchor::Cell {
                        cell_id: "cell-1".into(),
                        observed_cell_position: None,
                    },
                    vec![message_snapshot("message-cell")],
                ),
            ],
        };

        assert_eq!(
            last_thread_id_in_scope(&projection, &comments_doc::CommentAnchor::Notebook),
            Some("thread-2".into())
        );
        assert_eq!(
            last_message_id_in_thread(&projection, "thread-2"),
            Some("message-3".into())
        );
    }

    #[test]
    fn projected_thread_errors_when_mutation_result_is_not_visible() {
        let projection = comments_doc::CommentsProjection {
            comments_doc_id: "comments:test".into(),
            threads: vec![thread_snapshot(
                "thread-1",
                comments_doc::CommentAnchor::Notebook,
                vec![message_snapshot("message-1")],
            )],
        };

        let found = projected_thread(&projection, "thread-1", "create").expect("thread visible");
        assert_eq!(found.id, "thread-1");

        let err = projected_thread(&projection, "thread-missing", "create")
            .expect_err("missing thread should be an internal error");
        assert!(
            format!("{err}").contains("thread-missing"),
            "error should name missing thread: {err}"
        );
    }

    fn thread_snapshot(
        id: &str,
        anchor: comments_doc::CommentAnchor,
        messages: Vec<comments_doc::CommentMessageSnapshot>,
    ) -> comments_doc::CommentThreadSnapshot {
        comments_doc::CommentThreadSnapshot {
            id: id.into(),
            anchor,
            position: "80".into(),
            status: comments_doc::ProjectedThreadStatus::Open,
            mutation_state: comments_doc::ProjectedMutationState::Pending,
            trusted: false,
            messages,
            badge_cell_ids: Vec::new(),
            created_at: String::new(),
            created_by_actor_label: None,
            created_by_authority: None,
            rejection_reason: None,
            resolved_at: None,
            resolved_by_actor_label: None,
            resolved_by_authority: None,
        }
    }

    fn message_snapshot(id: &str) -> comments_doc::CommentMessageSnapshot {
        comments_doc::CommentMessageSnapshot {
            id: id.into(),
            position: "80".into(),
            body: String::new(),
            mutation_state: comments_doc::ProjectedMutationState::Pending,
            trusted: false,
            created_at: String::new(),
            created_by_actor_label: None,
            created_by_authority: None,
            rejection_reason: None,
        }
    }

    fn source_anchor(
        start_line: u64,
        start_column: u64,
        end_line: u64,
        end_column: u64,
        exact_quote: Option<&str>,
    ) -> comments_doc::CommentAnchor {
        comments_doc::CommentAnchor::SourceRange {
            cell_id: "cell-1".into(),
            start_line,
            start_column,
            end_line,
            end_column,
            prefix_quote: None,
            exact_quote: exact_quote.map(str::to_string),
            suffix_quote: None,
        }
    }
}
