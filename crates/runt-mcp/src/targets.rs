//! Explicit attachment selection follows this request; it never changes active selection.
use crate::NteractMcp;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::ErrorData;
tokio::task_local! {
    static TARGET: Option<String>;
    static NATIVE: bool;
    static RESERVATION: std::cell::RefCell<Option<crate::attachments::AttachmentReservation>>;
}
pub(crate) fn native() -> bool {
    NATIVE.try_with(|native| *native).unwrap_or(false)
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
    native: bool,
) -> Result<CallToolResult, ErrorData> {
    let reservation = if native
        && matches!(
            request.name.as_ref(),
            "connect_notebook" | "create_notebook"
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
    NATIVE
        .scope(
            native,
            RESERVATION.scope(
                std::cell::RefCell::new(reservation),
                dispatch_inner(server, request, native),
            ),
        )
        .await
}

async fn dispatch_inner(
    server: &NteractMcp,
    request: &CallToolRequestParams,
    native: bool,
) -> Result<CallToolResult, ErrorData> {
    if !mcp_transport::notebook_scoped_tool(&request.name) {
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
        None if native => return Err(ErrorData::invalid_params("notebook_handle is required; use the handle returned by connect_notebook or create_notebook", None)),
        None => None,
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
    TARGET
        .scope(target, crate::tools::dispatch(server, &request))
        .await
}

pub(crate) async fn with_handle<T>(
    handle: String,
    future: impl std::future::Future<Output = T>,
) -> T {
    TARGET.scope(Some(handle), future).await
}
