//! Opt-in progress and cancellation confined to one MCP request.
//!
//! Numeric progress is elapsed seconds, never a guessed percentage. Daemon
//! execution outlives this observation future; cancellation sends no kernel RPC.

use std::future::Future;
use std::time::Duration;

use rmcp::model::ProgressNotificationParam;
use rmcp::service::{RequestContext, RoleServer};
use rmcp::ErrorData as McpError;
use tokio::sync::watch;

tokio::task_local! { static STATUS: watch::Sender<String>; }

/// Record a real lifecycle transition for the current request, if it opted in.
pub(crate) fn status(message: impl Into<String>) {
    let message = message.into();
    let _ = STATUS.try_with(|sender| {
        sender.send_replace(message);
    });
}

pub(crate) async fn run<T>(
    context: &RequestContext<RoleServer>,
    tool: &str,
    operation: impl Future<Output = Result<T, McpError>>,
) -> Result<T, McpError> {
    let cancelled = mcp_transport::cancellation_error;
    let Some(token) = context.meta.get_progress_token() else {
        return tokio::select! { biased; _ = mcp_transport::cancelled(context) => Err(cancelled()), result = operation => result };
    };
    let initial = format!("Processing {tool}");
    let (sender, mut receiver) = watch::channel(initial);
    let operation = STATUS.scope(sender, operation);
    tokio::pin!(operation);
    let started = tokio::time::Instant::now();
    let mut last_sent = None;
    let mut pending = true;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = mcp_transport::cancelled(context) => return Err(cancelled()),
            result = &mut operation => return result,
            changed = receiver.changed() => { if changed.is_ok() { pending = true; } },
            _ = tick.tick() => {},
        }
        let elapsed_since_send = last_sent.map(|last: tokio::time::Instant| last.elapsed());
        if elapsed_since_send.is_none_or(|elapsed| elapsed >= Duration::from_secs(5)) {
            pending = true;
        }
        if pending
            && started.elapsed() >= Duration::from_secs(1)
            && elapsed_since_send.is_none_or(|elapsed| elapsed >= Duration::from_secs(1))
        {
            let elapsed = started.elapsed().as_secs_f64();
            let message = format!(
                "{} ({elapsed:.0}s elapsed)",
                receiver.borrow_and_update().as_str()
            );
            let notification =
                ProgressNotificationParam::new(token.clone(), elapsed).with_message(message);
            // Backpressure on optional status delivery must not stall the tool.
            tokio::select! {
                biased;
                _ = mcp_transport::cancelled(context) => return Err(cancelled()),
                _ = tokio::time::timeout(Duration::from_millis(250), context.peer.notify_progress(notification)) => {},
            }
            last_sent = Some(tokio::time::Instant::now());
            pending = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::*;
    use rmcp::service::{NotificationContext, RoleClient};
    use rmcp::{ClientHandler, ServerHandler, ServiceExt};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    struct Client(tokio::sync::mpsc::UnboundedSender<ProgressNotificationParam>);
    impl ClientHandler for Client {
        async fn on_progress(
            &self,
            progress: ProgressNotificationParam,
            _: NotificationContext<RoleClient>,
        ) {
            let _ = self.0.send(progress);
        }
    }
    struct Server {
        finished: Arc<AtomicBool>,
        observing: Arc<AtomicBool>,
    }
    struct ObserveGuard(Arc<AtomicBool>);
    impl Drop for ObserveGuard {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    impl ServerHandler for Server {
        async fn call_tool(
            &self,
            _: CallToolRequestParams,
            context: RequestContext<RoleServer>,
        ) -> Result<CallToolResponse, McpError> {
            let done = self.finished.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(6)).await;
                done.store(true, Ordering::SeqCst);
            });
            run(&context, "fixture", async {
                self.observing.store(true, Ordering::SeqCst);
                let _guard = ObserveGuard(self.observing.clone());
                for index in 0..20 {
                    status(format!("Observed state {index}"));
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                tokio::time::sleep(Duration::from_secs(11)).await;
                Ok(CallToolResult::success(vec![]).into())
            })
            .await
        }
    }

    #[tokio::test(start_paused = true)]
    async fn real_requests_coalesce_status_and_report_elapsed_heartbeats() {
        let (server_pipe, client_pipe) = tokio::io::duplex(65536);
        let server = Server {
            finished: Arc::new(AtomicBool::new(false)),
            observing: Arc::new(AtomicBool::new(false)),
        };
        let task = tokio::spawn(async move { server.serve(server_pipe).await.unwrap() });
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let mut client = Client(sender).serve(client_pipe).await.unwrap();
        let mut server = task.await.unwrap();
        client
            .call_tool_once(CallToolRequestParams::new("fixture"))
            .await
            .unwrap();
        let mut updates = Vec::new();
        while let Ok(progress) = receiver.try_recv() {
            updates.push(progress);
        }
        assert!((3..=4).contains(&updates.len()), "{updates:?}");
        assert!(updates.iter().all(|progress| progress.total.is_none()));
        assert!(updates
            .windows(2)
            .all(|pair| pair[1].progress - pair[0].progress >= 1.0));
        assert!(updates.iter().any(|progress| progress.progress >= 5.0
            && progress
                .message
                .as_ref()
                .unwrap()
                .contains("Observed state 19")));
        client.close().await.unwrap();
        server.close().await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn connection_close_stops_observation_without_stopping_owned_work() {
        let (server_pipe, client_pipe) = tokio::io::duplex(65536);
        let finished = Arc::new(AtomicBool::new(false));
        let observing = Arc::new(AtomicBool::new(false));
        let server = Server {
            finished: finished.clone(),
            observing: observing.clone(),
        };
        let task = tokio::spawn(async move {
            server
                .serve(mcp_transport::server(server_pipe))
                .await
                .unwrap()
        });
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let mut client = Client(sender).serve(client_pipe).await.unwrap();
        let server = task.await.unwrap();
        let _request = client
            .send_cancellable_request(
                ClientRequest::CallToolRequest(CallToolRequest::new(CallToolRequestParams::new(
                    "fixture",
                ))),
                rmcp::service::PeerRequestOptions::no_options(),
            )
            .await
            .unwrap();
        receiver.recv().await.unwrap();
        assert!(observing.load(Ordering::SeqCst));
        client.close().await.unwrap();
        server.waiting().await.unwrap();
        assert!(!observing.load(Ordering::SeqCst));
        assert!(!finished.load(Ordering::SeqCst));
        tokio::time::advance(Duration::from_secs(7)).await;
        tokio::task::yield_now().await;
        assert!(finished.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn real_cancellation_stops_observation_while_owned_work_finishes() {
        let (server_pipe, client_pipe) = tokio::io::duplex(65536);
        let finished = Arc::new(AtomicBool::new(false));
        let observing = Arc::new(AtomicBool::new(false));
        let server = Server {
            finished: finished.clone(),
            observing: observing.clone(),
        };
        let task = tokio::spawn(async move { server.serve(server_pipe).await.unwrap() });
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let mut client = Client(sender).serve(client_pipe).await.unwrap();
        let mut server = task.await.unwrap();
        let request = client
            .send_cancellable_request(
                ClientRequest::CallToolRequest(CallToolRequest::new(CallToolRequestParams::new(
                    "fixture",
                ))),
                rmcp::service::PeerRequestOptions::no_options(),
            )
            .await
            .unwrap();
        receiver.recv().await.unwrap();
        assert!(observing.load(Ordering::SeqCst));
        request.cancel(Some("stop watching".into())).await.unwrap();
        // A ping ensures the cancellation notification has reached the server.
        client
            .send_request(ClientRequest::PingRequest(PingRequest::default()))
            .await
            .unwrap();
        tokio::task::yield_now().await;
        assert!(!observing.load(Ordering::SeqCst));
        assert!(!finished.load(Ordering::SeqCst));
        tokio::time::advance(Duration::from_secs(7)).await;
        tokio::task::yield_now().await;
        assert!(finished.load(Ordering::SeqCst));
        client.close().await.unwrap();
        server.close().await.unwrap();
    }
}
