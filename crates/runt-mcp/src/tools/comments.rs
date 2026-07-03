//! Comment tools: create, reply, resolve, reopen.

use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::ErrorData as McpError;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::NteractMcp;

use super::{reject_unknown_args, tool_success};

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateCommentParams {
    /// Anchor: either { "cell_id": "..." } for cell comment, or { "notebook": true } for notebook comment.
    pub anchor: AnchorParam,
    /// Comment text (markdown supported).
    pub body: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum AnchorParam {
    Cell { cell_id: String },
    Notebook { notebook: bool },
}

impl From<AnchorParam> for comments_doc::CommentAnchor {
    fn from(param: AnchorParam) -> Self {
        match param {
            AnchorParam::Cell { cell_id } => comments_doc::CommentAnchor::Cell {
                cell_id,
                observed_cell_position: None,
            },
            AnchorParam::Notebook { .. } => comments_doc::CommentAnchor::Notebook,
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReplyCommentParams {
    /// Thread ID to reply to.
    pub thread_id: String,
    /// Reply text (markdown supported).
    pub body: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResolveCommentParams {
    /// Thread ID to resolve.
    pub thread_id: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReopenCommentParams {
    /// Thread ID to reopen.
    pub thread_id: String,
}

/// Create a new comment thread anchored to a cell or notebook.
pub async fn create_comment(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(request, &["anchor", "body"])?;

    let handle = require_handle!(server);
    let params: CreateCommentParams = serde_json::from_value(serde_json::Value::Object(
        request
            .arguments
            .clone()
            .ok_or_else(|| McpError::invalid_params("Missing arguments", None))?,
    ))
    .map_err(|e| McpError::invalid_params(format!("Invalid parameters: {e}"), None))?;

    let thread_id = handle
        .create_comment_thread(params.anchor.into(), params.body)
        .map_err(|e| McpError::internal_error(format!("create comment thread: {e}"), None))?;

    handle.confirm_state_sync().await.map_err(|e| {
        McpError::internal_error(format!("Failed to sync after create_comment: {e}"), None)
    })?;

    tool_success(&format!("Created comment thread: {thread_id}"))
}

/// Reply to an existing comment thread.
pub async fn reply_comment(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(request, &["thread_id", "body"])?;

    let handle = require_handle!(server);
    let params: ReplyCommentParams = serde_json::from_value(serde_json::Value::Object(
        request
            .arguments
            .clone()
            .ok_or_else(|| McpError::invalid_params("Missing arguments", None))?,
    ))
    .map_err(|e| McpError::invalid_params(format!("Invalid parameters: {e}"), None))?;

    let message_id = handle
        .reply_to_comment(&params.thread_id, params.body)
        .map_err(|e| McpError::internal_error(format!("reply to comment: {e}"), None))?;

    handle.confirm_state_sync().await.map_err(|e| {
        McpError::internal_error(format!("Failed to sync after reply_comment: {e}"), None)
    })?;

    tool_success(&format!(
        "Replied to thread {}: message_id {}",
        params.thread_id, message_id
    ))
}

/// Mark a comment thread as resolved.
pub async fn resolve_comment(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(request, &["thread_id"])?;

    let handle = require_handle!(server);
    let params: ResolveCommentParams = serde_json::from_value(serde_json::Value::Object(
        request
            .arguments
            .clone()
            .ok_or_else(|| McpError::invalid_params("Missing arguments", None))?,
    ))
    .map_err(|e| McpError::invalid_params(format!("Invalid parameters: {e}"), None))?;

    handle
        .resolve_comment_thread(&params.thread_id)
        .map_err(|e| McpError::internal_error(format!("resolve comment: {e}"), None))?;

    handle.confirm_state_sync().await.map_err(|e| {
        McpError::internal_error(format!("Failed to sync after resolve_comment: {e}"), None)
    })?;

    tool_success(&format!("Resolved thread: {}", params.thread_id))
}

/// Reopen a resolved comment thread.
pub async fn reopen_comment(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, McpError> {
    reject_unknown_args(request, &["thread_id"])?;

    let handle = require_handle!(server);
    let params: ReopenCommentParams = serde_json::from_value(serde_json::Value::Object(
        request
            .arguments
            .clone()
            .ok_or_else(|| McpError::invalid_params("Missing arguments", None))?,
    ))
    .map_err(|e| McpError::invalid_params(format!("Invalid parameters: {e}"), None))?;

    handle
        .reopen_comment_thread(&params.thread_id)
        .map_err(|e| McpError::internal_error(format!("reopen comment: {e}"), None))?;

    handle.confirm_state_sync().await.map_err(|e| {
        McpError::internal_error(format!("Failed to sync after reopen_comment: {e}"), None)
    })?;

    tool_success(&format!("Reopened thread: {}", params.thread_id))
}

// Tests for the DocHandle comment methods are in crates/notebook-sync/src/handle.rs::comment_crud_operations.
