//! Explicit attachment selection follows this request; it never changes active selection.
use crate::NteractMcp;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::ErrorData;
tokio::task_local! {
    static TARGET: Option<String>;
    static EXPLICIT_ATTACHMENT: bool;
    static RESERVATION: std::cell::RefCell<Option<crate::attachments::AttachmentReservation>>;
    static BACKING_KEY: Option<crate::attachments::BackingPeerKey>;
}
pub(crate) fn backing_key() -> Option<crate::attachments::BackingPeerKey> {
    BACKING_KEY.try_with(Clone::clone).ok().flatten()
}
pub(crate) async fn with_backing_key<T>(
    key: Option<crate::attachments::BackingPeerKey>,
    future: impl std::future::Future<Output = T>,
) -> T {
    BACKING_KEY.scope(key, future).await
}
pub(crate) fn explicit_attachment_mode() -> bool {
    EXPLICIT_ATTACHMENT
        .try_with(|explicit| *explicit)
        .unwrap_or(false)
}
pub(crate) fn take_reservation(
    server: &NteractMcp,
) -> Result<crate::attachments::AttachmentReservation, &'static str> {
    RESERVATION
        .try_with(|reservation| reservation.borrow_mut().take())
        .ok()
        .flatten()
        .map(Ok)
        .unwrap_or_else(|| server.attachments.reserve())
}

pub(crate) fn current() -> Option<String> {
    TARGET.try_with(Clone::clone).ok().flatten()
}

pub(crate) async fn dispatch(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, ErrorData> {
    mcp_transport::validate_tool_target_params(request)?;
    let reservation = if matches!(
        request.name.as_ref(),
        "connect_notebook" | "open_notebook" | "create_notebook"
    ) {
        Some(
            server
                .attachments
                .reserve()
                .map_err(|message| ErrorData::invalid_params(message, None))?,
        )
    } else {
        None
    };
    EXPLICIT_ATTACHMENT
        .scope(
            true,
            RESERVATION.scope(
                std::cell::RefCell::new(reservation),
                dispatch_inner(server, request),
            ),
        )
        .await
}

async fn dispatch_inner(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, ErrorData> {
    if !mcp_transport::notebook_scoped_tool(&request.name)
        || request.name == "wait_for_notebook_change"
    {
        return crate::tools::dispatch(server, request).await;
    }
    let mut request = request.clone();
    let value = request
        .arguments
        .as_mut()
        .and_then(|arguments| arguments.remove("notebook_handle"));
    let target = match value {
        Some(serde_json::Value::String(handle)) if !handle.is_empty() => Some(handle),
        Some(_) => return Err(ErrorData::invalid_params("notebook_handle must be a nonempty attachment handle", None)),
        None => return Err(ErrorData::invalid_params("notebook_handle is required; use the handle returned by connect_notebook or create_notebook", None)),
    };
    if let Some(handle) = target.as_ref() {
        if server.attachment_identity(handle).await.is_none() {
            return Err(ErrorData::invalid_params(
                "Notebook attachment expired; connect again and obtain a new handle",
                None,
            ));
        }
        if request.arguments.as_ref().is_some_and(|args| {
            args.get("notebook_id")
                .is_some_and(|value| !value.is_null())
        }) {
            return Err(ErrorData::invalid_params(
                "Use notebook_handle without notebook_id",
                None,
            ));
        }
    }
    let outcome = TARGET
        .scope(target.clone(), crate::tools::dispatch(server, &request))
        .await;
    finish_scoped_tool(server, &request.name, target.as_deref(), outcome)
}

/// Fence successful completions against the logical owner captured at admission.
/// Already-admitted side effects can persist after release; this does not imply
/// rollback. Preserve original failures, including uncertain sync outcomes.
pub(crate) fn finish_scoped_tool(
    server: &NteractMcp,
    name: &str,
    handle: Option<&str>,
    outcome: Result<CallToolResult, ErrorData>,
) -> Result<CallToolResult, ErrorData> {
    let Some(handle) = handle else { return outcome };
    if name == "disconnect_notebook"
        || !matches!(&outcome, Ok(result) if result.is_error != Some(true))
        || server.attachments.read_entries().contains_key(handle)
    {
        return outcome;
    }
    let details = serde_json::json!({"error": {
        "code": "attachment_expired",
        "message": "Notebook attachment expired before this operation completed; an admitted operation may already have taken effect. Connect again and obtain a new handle",
        "notebook_handle": handle,
    }});
    let mut result =
        CallToolResult::error(vec![crate::formatting::assistant_text(details.to_string())]);
    result.structured_content = Some(details);
    Ok(result)
}

pub(crate) async fn with_handle<T>(
    handle: String,
    future: impl std::future::Future<Output = T>,
) -> T {
    TARGET.scope(Some(handle), future).await
}
