//! Explicit attachment selection follows this request; it never changes active selection.
use crate::NteractMcp;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::ErrorData;
tokio::task_local! {
    static TARGET: Option<String>;
    static CAPTURED_SESSION: Option<crate::session::NotebookSession>;
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

pub(crate) fn captured_session() -> Option<crate::session::NotebookSession> {
    CAPTURED_SESSION.try_with(Clone::clone).ok().flatten()
}

pub(crate) fn current() -> Option<String> {
    TARGET.try_with(Clone::clone).ok().flatten()
}

pub(crate) async fn dispatch(
    server: &NteractMcp,
    request: &CallToolRequestParams,
) -> Result<CallToolResult, ErrorData> {
    if let Err(error) = mcp_transport::validate_tool_target_params(request) {
        return Ok(mcp_transport::tool_target_error(error));
    }
    let reservation = if matches!(
        request.name.as_ref(),
        "connect_notebook" | "open_notebook" | "create_notebook"
    ) {
        Some(match server.attachments.reserve() {
            Ok(reservation) => reservation,
            Err(message) => return Ok(mcp_transport::tool_target_error(ErrorData::invalid_params(
                format!("{message}; deliberately disconnect_notebook with an unneeded exact notebook_handle, then explicitly acquire again"),
                Some(serde_json::json!({"code":"attachment_limit","resubmit_required":true})),
            ))),
        })
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
    let arguments = request.arguments.get_or_insert_default();
    let handle = arguments
        .remove("notebook_handle")
        .and_then(|v| v.as_str().map(str::to_owned));
    let id = arguments
        .remove("notebook_id")
        .and_then(|v| v.as_str().map(str::to_owned));
    let domain = arguments
        .remove("domain")
        .and_then(|v| v.as_str().map(str::to_owned));
    let captured = match id {
        Some(id) => match crate::notebook_target::acquire(server, &id, domain.as_deref()).await {
            Ok(session) => Some(session),
            Err(error) => return Ok(mcp_transport::tool_target_error(error)),
        },
        None => None,
    };
    let handle = match captured
        .as_ref()
        .map(|session| session.notebook_handle.clone())
        .or(handle)
    {
        Some(handle) => handle,
        None => {
            return Ok(mcp_transport::tool_target_error(ErrorData::invalid_params(
                "An explicit notebook target is required",
                None,
            )))
        }
    };
    if captured.is_none() && server.attachment_identity(&handle).await.is_none() {
        return Ok(mcp_transport::tool_target_error(
            crate::attachments::expired_resource_error(&handle),
        ));
    }
    let mut outcome = TARGET
        .scope(
            Some(handle.clone()),
            CAPTURED_SESSION.scope(captured.clone(), crate::tools::dispatch(server, &request)),
        )
        .await;
    if let Some(session) = captured {
        // An admitted ID request owns its captured replica through completion.
        // Releasing shared address retention is not rollback or a reason to
        // discard a confirmed cell/execution ID after a mutation.
        if let Ok(result) = &mut outcome {
            let target = serde_json::json!({
                "notebook_id":session.notebook_id,
                "domain":match &session.source {
                    crate::session::NotebookSessionSource::Local => "local",
                    crate::session::NotebookSessionSource::Hosted { domain } => domain.as_str(),
                },
                "notebook_handle":handle,
                "retention":"shared_address_owner",
                "retained":server.attachments.read_entries().contains_key(&handle),
            });
            if result.structured_content.is_none() {
                result.structured_content = Some(serde_json::json!({}));
            }
            if let Some(content) = result
                .structured_content
                .as_mut()
                .and_then(serde_json::Value::as_object_mut)
            {
                content.insert("target".into(), target.clone());
            }
            result.content.push(crate::formatting::assistant_text(
                serde_json::json!({"target":target}).to_string(),
            ));
        }
        outcome
    } else {
        finish_scoped_tool(server, &request.name, Some(&handle), outcome)
    }
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
