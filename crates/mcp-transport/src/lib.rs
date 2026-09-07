//! Connection lifetime for stdio MCP request handlers.
//!
//! rmcp drains in-flight handlers on EOF without cancelling their request tokens.
//! Attach a separate connection token before dispatch so observation can end
//! immediately, while daemon-owned execution continues independently.

use rmcp::model::{
    ClientRequest, DiscoverRequest, GetExtensions, GetMeta, JsonRpcMessage, ProtocolVersion,
    RequestId,
};
use rmcp::service::{RequestContext, RoleServer, RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::{IntoTransport, Transport};
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct ConnectionClosed(CancellationToken);

pub fn cancellation_error() -> rmcp::ErrorData {
    rmcp::ErrorData::new(
        rmcp::model::ErrorCode(-32800),
        "Request observation cancelled; daemon execution may continue",
        None,
    )
}

#[derive(Default)]
struct Acknowledgment(Mutex<Option<rmcp::model::ServerNotification>>);
#[derive(Clone)]
struct ReleaseAcknowledgment;

/// Publish the SDK acknowledgment only after installing the watch/baseline.
/// Until then the adapter retains it in this request's extension slot.
pub async fn acknowledge(context: &RequestContext<RoleServer>) -> Result<(), rmcp::ErrorData> {
    let pending = context
        .extensions
        .get::<Arc<Acknowledgment>>()
        .and_then(|slot| slot.0.lock().unwrap_or_else(|e| e.into_inner()).take());
    if let Some(mut notification) = pending {
        notification.extensions_mut().insert(ReleaseAcknowledgment);
        tokio::select! {
            _ = cancelled(context) => return Err(rmcp::ErrorData::internal_error("Subscription cancelled before acknowledgment", None)),
            result = tokio::time::timeout(std::time::Duration::from_secs(1), context.peer.send_notification(notification)) => {
                result.map_err(|_| rmcp::ErrorData::internal_error("Subscription acknowledgment timed out", None))?.map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?;
            }
        }
    }
    Ok(())
}

#[derive(Clone, Default)]
pub struct ConnectionLifetime(CancellationToken);
#[derive(Clone)]
struct SuppressProgress;
/// Override the SDK's automatic private token when the upstream did not opt in.
pub fn suppress_progress(request: &mut rmcp::model::ClientRequest) {
    request.extensions_mut().insert(SuppressProgress);
}
impl ConnectionLifetime {
    pub async fn closed(&self) {
        self.0.cancelled().await;
    }
}

/// Expose private-child EOF without relying on the SDK's later response drain.
pub fn client<T, E, A>(
    transport: T,
) -> (
    impl Transport<rmcp::service::RoleClient, Error = E>,
    ConnectionLifetime,
)
where
    T: IntoTransport<rmcp::service::RoleClient, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    let lifetime = ConnectionLifetime::default();
    (
        ClientTransport {
            inner: transport.into_transport(),
            lifetime: lifetime.clone(),
        },
        lifetime,
    )
}
struct ClientTransport<T> {
    inner: T,
    lifetime: ConnectionLifetime,
}
impl<T> Drop for ClientTransport<T> {
    fn drop(&mut self) {
        self.lifetime.0.cancel();
    }
}
impl<T: Transport<rmcp::service::RoleClient>> Transport<rmcp::service::RoleClient>
    for ClientTransport<T>
{
    type Error = T::Error;
    fn send(
        &mut self,
        mut message: TxJsonRpcMessage<rmcp::service::RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        if let JsonRpcMessage::Request(request) = &mut message {
            if request
                .request
                .extensions()
                .get::<SuppressProgress>()
                .is_some()
            {
                request.request.get_meta_mut().remove("progressToken");
            }
        }
        let send = self.inner.send(message);
        let lifetime = self.lifetime.clone();
        async move {
            let result = send.await;
            if result.is_err() {
                lifetime.0.cancel();
            }
            result
        }
    }
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<rmcp::service::RoleClient>> {
        let result = self.inner.receive().await;
        if result.is_none() {
            self.lifetime.0.cancel();
        }
        result
    }
    async fn close(&mut self) -> Result<(), Self::Error> {
        self.lifetime.0.cancel();
        self.inner.close().await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use rmcp::model::*;
    struct Mock {
        next: Option<RxJsonRpcMessage<RoleServer>>,
        fail_write: bool,
    }
    impl Transport<RoleServer> for Mock {
        type Error = std::io::Error;
        fn send(
            &mut self,
            _: TxJsonRpcMessage<RoleServer>,
        ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
            let fail = self.fail_write;
            async move {
                if fail {
                    Err(std::io::Error::other("fixture write failure"))
                } else {
                    Ok(())
                }
            }
        }
        async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleServer>> {
            self.next.take()
        }
        async fn close(&mut self) -> Result<(), Self::Error> {
            Ok(())
        }
    }
    #[tokio::test]
    async fn request_lifetime_ends_on_failed_write_close_drop_and_eof() {
        for ending in ["write", "close", "drop", "eof"] {
            let mut transport = server(Mock {
                next: Some(JsonRpcMessage::request(
                    ClientRequest::PingRequest(PingRequest::default()),
                    RequestId::Number(1),
                )),
                fail_write: ending == "write",
            });
            let Some(JsonRpcMessage::Request(request)) = transport.receive().await else {
                panic!("expected request")
            };
            let closed = request
                .request
                .extensions()
                .get::<ConnectionClosed>()
                .unwrap()
                .clone();
            assert!(!closed.0.is_cancelled());
            match ending {
                "write" => assert!(transport
                    .send(JsonRpcMessage::response(
                        ServerResult::empty(()),
                        RequestId::Number(1)
                    ))
                    .await
                    .is_err()),
                "close" => transport.close().await.unwrap(),
                "eof" => assert!(transport.receive().await.is_none()),
                _ => drop(transport),
            }
            assert!(closed.0.is_cancelled(), "{ending}");
        }
    }
}

pub const LEGACY_VERSIONS: &[ProtocolVersion] = &[
    ProtocolVersion::V_2024_11_05,
    ProtocolVersion::V_2025_03_26,
    ProtocolVersion::V_2025_06_18,
    ProtocolVersion::V_2025_11_25,
];
pub const SUPPORTED_VERSIONS: &[ProtocolVersion] = &[
    ProtocolVersion::V_2024_11_05,
    ProtocolVersion::V_2025_03_26,
    ProtocolVersion::V_2025_06_18,
    ProtocolVersion::V_2025_11_25,
    ProtocolVersion::V_2026_07_28,
];
pub fn notebook_scoped_tool(name: &str) -> bool {
    matches!(
        name,
        "save_notebook"
            | "show_notebook"
            | "launch_app"
            | "disconnect_notebook"
            | "get_cell"
            | "get_all_cells"
            | "create_cell"
            | "set_cell"
            | "delete_cell"
            | "move_cell"
            | "clear_outputs"
            | "add_cell_tags"
            | "remove_cell_tags"
            | "set_cells_source_hidden"
            | "set_cells_outputs_hidden"
            | "sync_environment"
            | "execute_cell"
            | "run_all_cells"
            | "get_results"
            | "interrupt_kernel"
            | "restart_kernel"
            | "manage_dependencies"
            | "add_dependency"
            | "remove_dependency"
            | "get_dependencies"
            | "approve_trust"
            | "replace_match"
            | "replace_regex"
            | "create_comment"
            | "reply_comment"
            | "resolve_comment"
            | "reopen_comment"
    )
}
pub fn attachment_tool_schemas(tools: &mut [rmcp::model::Tool], required: bool) {
    for tool in tools {
        if !notebook_scoped_tool(&tool.name) {
            continue;
        }
        let schema = Arc::make_mut(&mut tool.input_schema);
        if let Some(properties) = schema
            .entry("properties")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
        {
            properties.insert("notebook_handle".into(), serde_json::json!({"type":"string","description":"Attachment handle from connect_notebook or create_notebook; also addresses parked notebooks."}));
        }
        if required {
            if let Some(fields) = schema
                .entry("required")
                .or_insert_with(|| serde_json::json!([]))
                .as_array_mut()
            {
                if !fields.iter().any(|field| field == "notebook_handle") {
                    fields.push(serde_json::json!("notebook_handle"));
                }
            }
        }
    }
}
pub fn validate_tool_target(
    request: &rmcp::model::CallToolRequestParams,
    context: &RequestContext<RoleServer>,
) -> Result<(), rmcp::ErrorData> {
    if is_native(context)
        && notebook_scoped_tool(&request.name)
        && request
            .arguments
            .as_ref()
            .and_then(|args| args.get("notebook_handle"))
            .and_then(serde_json::Value::as_str)
            .is_none_or(|handle| handle.is_empty())
    {
        return Err(rmcp::ErrorData::invalid_params(
            "notebook_handle is required; use connect_notebook or create_notebook to obtain one",
            None,
        ));
    }
    Ok(())
}
pub fn is_native(context: &RequestContext<RoleServer>) -> bool {
    context.peer.peer_info().is_none()
        && context.meta.protocol_version() == Some(ProtocolVersion::V_2026_07_28)
}
pub fn validate_resource_uri(
    uri: &str,
    context: &RequestContext<RoleServer>,
) -> Result<(), rmcp::ErrorData> {
    if is_native(context) && uri.starts_with("nteract://notebooks/") {
        return Err(rmcp::ErrorData::invalid_params(
            "Use the nteract://sessions/ resource URI returned with your notebook_handle",
            None,
        ));
    }
    Ok(())
}
pub fn resource_error(
    mut error: rmcp::ErrorData,
    context: &RequestContext<RoleServer>,
) -> rmcp::ErrorData {
    if is_native(context) && error.code.0 == -32002 {
        error.code = rmcp::model::ErrorCode::INVALID_PARAMS;
    }
    error
}
/// Only explicit notebook resources are supported by native listen today.
pub fn notebook_subscription_filter(
    requested: &rmcp::model::SubscriptionFilter,
) -> rmcp::model::SubscriptionFilter {
    let mut accepted = rmcp::model::SubscriptionFilter::builder();
    let mut seen = std::collections::BTreeSet::new();
    for uri in requested.resource_subscriptions.iter().flatten() {
        if uri.starts_with("nteract://sessions/") && seen.insert(uri) && seen.len() <= 128 {
            accepted = accepted.resource_subscription(uri);
        }
    }
    accepted.build()
}
/// Keep legacy handshakes and native per-request negotiation distinct.
pub fn require_protocol(context: &RequestContext<RoleServer>) -> Result<(), rmcp::ErrorData> {
    if context.peer.peer_info().is_some() {
        if context.meta.protocol_version() == Some(ProtocolVersion::V_2026_07_28) {
            return Err(rmcp::ErrorData::unsupported_protocol_version(
                ProtocolVersion::V_2026_07_28,
                LEGACY_VERSIONS,
            ));
        }
        return Ok(());
    }
    if is_native(context) {
        return Ok(());
    }
    Err(rmcp::ErrorData::invalid_request(
        "initialize is required for legacy application requests",
        None,
    ))
}
/// Discovery must remain pure: the SDK may invoke it before its peer pump starts.
pub fn discover(
    context: &RequestContext<RoleServer>,
    info: rmcp::model::ServerInfo,
) -> Result<rmcp::model::DiscoverResult, rmcp::ErrorData> {
    require_protocol(context)?;
    if !is_native(context) {
        return Err(rmcp::ErrorData::method_not_found::<
            rmcp::model::DiscoverRequestMethod,
        >());
    }
    Ok(rmcp::model::DiscoverResult::from_server_info(
        SUPPORTED_VERSIONS.to_vec(),
        info,
    ))
}

/// Wait for either explicit request cancellation or transport teardown.
pub async fn cancelled(context: &RequestContext<RoleServer>) {
    let connection = context.extensions.get::<ConnectionClosed>();
    match connection {
        Some(connection) => {
            tokio::select! {
                _ = context.ct.cancelled() => {},
                _ = connection.0.cancelled() => {},
            }
        }
        None => context.ct.cancelled().await,
    }
}

/// Apply once at each server entry point, including in-memory wire tests.
pub fn server<T, E, A>(transport: T) -> impl Transport<RoleServer, Error = E>
where
    T: IntoTransport<RoleServer, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    ServerTransport {
        inner: transport.into_transport(),
        closed: CancellationToken::new(),
        opening: Arc::new(Mutex::new(Opening::default())),
    }
}

struct ServerTransport<T> {
    inner: T,
    closed: CancellationToken,
    opening: Arc<Mutex<Opening>>,
}
#[derive(Default)]
struct Opening {
    started: bool,
    priming_id: Option<RequestId>,
    pending: Option<RxJsonRpcMessage<RoleServer>>,
    acknowledgments: std::collections::HashMap<RequestId, std::sync::Weak<Acknowledgment>>,
}
impl<T> Drop for ServerTransport<T> {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}
impl<T: Transport<RoleServer>> Transport<RoleServer> for ServerTransport<T> {
    type Error = T::Error;
    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleServer>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        // rmcp dispatches the first native request before starting its peer
        // pump. Prime with a pure discovery request so a first listen/progress
        // callback can use that pump. This response is private to the adapter.
        let defer_ack = {
            let mut opening = self.opening.lock().unwrap_or_else(|e| e.into_inner());
            opening
                .acknowledgments
                .retain(|_, slot| slot.strong_count() > 0);
            if let JsonRpcMessage::Notification(message) = &item {
                let notification = &message.notification;
                if matches!(
                    notification,
                    rmcp::model::ServerNotification::SubscriptionsAcknowledgedNotification(_)
                ) && notification
                    .extensions()
                    .get::<ReleaseAcknowledgment>()
                    .is_none()
                {
                    notification
                        .get_meta()
                        .subscription_id()
                        .and_then(|id| opening.acknowledgments.get(&id))
                        .and_then(std::sync::Weak::upgrade)
                        .map(|slot| {
                            *slot.0.lock().unwrap_or_else(|e| e.into_inner()) =
                                Some(notification.clone());
                        })
                        .is_some()
                } else {
                    false
                }
            } else {
                false
            }
        };
        let suppress = defer_ack || {
            let mut opening = self.opening.lock().unwrap_or_else(|e| e.into_inner());
            match (&item, opening.priming_id.as_ref()) {
                (JsonRpcMessage::Response(response), Some(id)) if response.id == *id => {
                    opening.priming_id = None;
                    true
                }
                (JsonRpcMessage::Error(error), Some(id)) if error.id.as_ref() == Some(id) => {
                    opening.priming_id = None;
                    opening.pending = None;
                    false // Preserve validation errors under the real request ID.
                }
                _ => false,
            }
        };
        let sent = (!suppress).then(|| self.inner.send(item));
        let closed = self.closed.clone();
        async move {
            let result = match sent {
                Some(sent) => sent.await,
                None => Ok(()),
            };
            if result.is_err() {
                closed.cancel();
            }
            result
        }
    }
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleServer>> {
        let pending = {
            let mut opening = self.opening.lock().unwrap_or_else(|e| e.into_inner());
            if opening.priming_id.is_none() {
                opening.pending.take()
            } else {
                None
            }
        };
        if pending.is_some() {
            return pending;
        }
        let mut message = self.inner.receive().await;
        match &mut message {
            Some(JsonRpcMessage::Request(request)) => {
                request
                    .request
                    .extensions_mut()
                    .insert(ConnectionClosed(self.closed.clone()));
                let mut opening = self.opening.lock().unwrap_or_else(|e| e.into_inner());
                if matches!(
                    request.request,
                    ClientRequest::SubscriptionsListenRequest(_)
                ) {
                    opening
                        .acknowledgments
                        .retain(|_, slot| slot.strong_count() > 0);
                    let slot = opening
                        .acknowledgments
                        .get(&request.id)
                        .and_then(std::sync::Weak::upgrade)
                        .unwrap_or_else(|| Arc::new(Acknowledgment::default()));
                    opening
                        .acknowledgments
                        .insert(request.id.clone(), Arc::downgrade(&slot));
                    request.request.extensions_mut().insert(slot);
                }
                if !opening.started {
                    let native = request.request.get_meta().protocol_version()
                        == Some(ProtocolVersion::V_2026_07_28);
                    let preinit_ping =
                        matches!(request.request, ClientRequest::PingRequest(_)) && !native;
                    if !preinit_ping {
                        opening.started = true;
                    }
                    if request
                        .request
                        .get_meta()
                        .missing_required_keys(&ProtocolVersion::V_2026_07_28)
                        .is_empty()
                        && !matches!(
                            request.request,
                            ClientRequest::InitializeRequest(_) | ClientRequest::DiscoverRequest(_)
                        )
                    {
                        let mut discovery =
                            ClientRequest::DiscoverRequest(DiscoverRequest::default());
                        *discovery.get_meta_mut() = request.request.get_meta().clone();
                        discovery
                            .extensions_mut()
                            .insert(ConnectionClosed(self.closed.clone()));
                        let prime = JsonRpcMessage::request(discovery, request.id.clone());
                        opening.priming_id = Some(request.id.clone());
                        opening.pending = message.take();
                        return Some(prime);
                    }
                }
            }
            None => self.closed.cancel(),
            _ => {}
        }
        message
    }
    async fn close(&mut self) -> Result<(), Self::Error> {
        self.closed.cancel();
        self.inner.close().await
    }
}
