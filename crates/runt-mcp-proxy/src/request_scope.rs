//! Request-scoped child cancellation and progress-token translation.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::model::*;
use rmcp::service::{
    Peer, PeerRequestOptions, RequestContext, RoleClient, RoleServer, ServiceError,
};
use tokio::sync::broadcast;

tokio::task_local! {
    static UPSTREAM_REQUEST: ScopedRequest;
}

#[derive(Clone)]
struct ScopedRequest {
    context: RequestContext<RoleServer>,
    started: tokio::time::Instant,
    last_progress: Arc<Mutex<Option<tokio::time::Instant>>>,
}

/// Preserve the upstream request while supervisor helpers forward to the child.
/// The scope follows this future only; independent requests have separate state.
pub async fn scope<T>(context: RequestContext<RoleServer>, future: impl Future<Output = T>) -> T {
    UPSTREAM_REQUEST
        .scope(
            ScopedRequest {
                context,
                started: tokio::time::Instant::now(),
                last_progress: Arc::default(),
            },
            future,
        )
        .await
}

struct CancelOnDrop {
    peer: Peer<RoleClient>,
    id: Option<RequestId>,
}
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            let peer = self.peer.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    cancel(&peer, id).await;
                });
            }
        }
    }
}
async fn cancel(peer: &Peer<RoleClient>, id: RequestId) {
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        peer.notify_cancelled(CancelledNotificationParam::new(
            Some(id),
            Some("Upstream request observation ended".into()),
        )),
    )
    .await;
}
fn cancelled() -> ServiceError {
    ServiceError::Cancelled {
        reason: Some("Request observation cancelled; daemon execution may continue".into()),
    }
}

pub(crate) async fn call_child(
    peer: &Peer<RoleClient>,
    params: CallToolRequestParams,
    mut progress: broadcast::Receiver<ProgressNotificationParam>,
) -> Result<CallToolResponse, ServiceError> {
    let Ok(scope) = UPSTREAM_REQUEST.try_with(Clone::clone) else {
        return peer.call_tool_once(params).await;
    };
    let context = &scope.context;
    let handle = tokio::select! {
        biased;
        _ = mcp_transport::cancelled(context) => return Err(cancelled()),
        result = peer.send_cancellable_request(ClientRequest::CallToolRequest(CallToolRequest::new(params)), PeerRequestOptions::no_options()) => result?,
    };
    let child_token = handle.progress_token.clone();
    let upstream_token = context.meta.get_progress_token();
    let id = handle.id.clone();
    let mut cleanup = CancelOnDrop {
        peer: peer.clone(),
        id: Some(id.clone()),
    };
    let response = handle.await_response();
    tokio::pin!(response);
    let mut pending: Option<ProgressNotificationParam> = None;
    let mut progress_open = true;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = mcp_transport::cancelled(context) => {
                cancel(peer, id).await;
                cleanup.id = None;
                return Err(cancelled());
            }
            result = &mut response => {
                cleanup.id = None;
                return match result? {
                    ServerResult::CallToolResult(result) => Ok(CallToolResponse::Complete(result)),
                    ServerResult::InputRequiredResult(result) => Ok(CallToolResponse::InputRequired(result)),
                    ServerResult::CreateTaskResult(result) => Ok(CallToolResponse::Task(result)),
                    _ => Err(ServiceError::UnexpectedResponse),
                };
            }
            notification = progress.recv(), if upstream_token.is_some() && progress_open => {
                match notification {
                    Ok(mut notification) if notification.progress_token == child_token => {
                        if let Some(token) = &upstream_token {
                            notification.progress_token = token.clone();
                            // Child metadata belongs to the private legacy transport.
                            notification.meta = None;
                            pending = Some(notification);
                        }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {},
                    Err(broadcast::error::RecvError::Closed) => { pending = None; progress_open = false; },
                }
            }
            _ = tick.tick() => {},
        }
        let can_send = {
            let mut last = scope
                .last_progress
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if pending.is_some() && last.is_none_or(|last| last.elapsed() >= Duration::from_secs(1))
            {
                *last = Some(tokio::time::Instant::now());
                true
            } else {
                false
            }
        };
        if can_send {
            if let Some(mut notification) = pending.take() {
                // Keep one monotonic elapsed clock and rate limit across a
                // safe retry on a replacement child transport.
                notification.progress = scope.started.elapsed().as_secs_f64();
                notification.total = None;
                // A progress delivery failure is not a failed notebook operation.
                let _ = tokio::time::timeout(
                    Duration::from_millis(250),
                    context.peer.notify_progress(notification),
                )
                .await;
            }
        }
    }
}
