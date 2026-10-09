//! Legacy invalidation relay bound to one child transport per watch.
//!
//! A connection actor orders subscribe/unsubscribe operations, including their
//! child acknowledgments. Concurrent duplicates cannot report success before
//! the original subscription succeeds or unsubscribe a replacement watch.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use rmcp::model::{
    ResourceUpdatedNotificationParam, SubscribeRequestParams, UnsubscribeRequestParams,
};
use rmcp::service::{Peer, RoleClient, RoleServer};
use rmcp::ErrorData as McpError;
use tokio::sync::{broadcast, mpsc, oneshot};

type Reply = oneshot::Sender<Result<(), McpError>>;
enum Operation {
    Subscribe {
        uri: String,
        child: Peer<RoleClient>,
        generation: u64,
        notifications: broadcast::Receiver<ResourceUpdatedNotificationParam>,
        upstream: Peer<RoleServer>,
        reply: Reply,
    },
    Unsubscribe {
        uri: String,
        reply: Reply,
    },
}
struct Worker {
    sender: mpsc::Sender<Operation>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.task.abort();
    }
}
struct Watch {
    child: Peer<RoleClient>,
    generation: u64,
    upstream: Peer<RoleServer>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Watch {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub(crate) struct ObservationBridge {
    worker: Mutex<Option<Worker>>,
}
impl ObservationBridge {
    fn sender(&self) -> Result<mpsc::Sender<Operation>, McpError> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        if worker
            .as_ref()
            .is_some_and(|worker| worker.task.is_finished())
        {
            worker.take();
        }
        Ok(worker
            .get_or_insert_with(|| {
                let (sender, receiver) = mpsc::channel(128);
                Worker {
                    sender,
                    task: tokio::spawn(run(receiver)),
                }
            })
            .sender
            .clone())
    }

    pub(crate) async fn subscribe(
        &self,
        uri: String,
        child: Peer<RoleClient>,
        generation: u64,
        notifications: broadcast::Receiver<ResourceUpdatedNotificationParam>,
        upstream: Peer<RoleServer>,
    ) -> Result<(), McpError> {
        let (reply, response) = oneshot::channel();
        let operation = async {
            self.sender()?
                .send(Operation::Subscribe {
                    uri,
                    child,
                    generation,
                    notifications,
                    upstream,
                    reply,
                })
                .await
                .map_err(|_| unavailable())?;
            response.await.map_err(|_| unavailable())?
        };
        tokio::time::timeout(Duration::from_secs(10), operation).await.map_err(|_| McpError::internal_error("Resource subscription timed out; obtain a fresh notebook baseline before retrying", None))?
    }

    pub(crate) async fn unsubscribe(&self, uri: String) -> Result<(), McpError> {
        let (reply, response) = oneshot::channel();
        let operation = async {
            self.sender()?
                .send(Operation::Unsubscribe { uri, reply })
                .await
                .map_err(|_| unavailable())?;
            response.await.map_err(|_| unavailable())?
        };
        tokio::time::timeout(Duration::from_secs(10), operation)
            .await
            .map_err(|_| McpError::internal_error("Resource unsubscribe timed out", None))?
    }
}
fn unavailable() -> McpError {
    McpError::internal_error("Resource subscription relay is unavailable", None)
}
fn child_error(error: rmcp::service::ServiceError) -> McpError {
    match error {
        rmcp::service::ServiceError::McpError(error) => error,
        error => McpError::internal_error(error.to_string(), None),
    }
}

#[allow(deprecated)]
async fn admit_subscription(child: &Peer<RoleClient>, uri: &str) -> Result<(), McpError> {
    tokio::time::timeout(
        Duration::from_secs(5),
        child.subscribe(SubscribeRequestParams::new(uri)),
    )
    .await
    .map_err(|_| McpError::internal_error("Child resource subscription timed out", None))?
    .map_err(child_error)
}

#[allow(deprecated)]
async fn run(mut operations: mpsc::Receiver<Operation>) {
    let mut watches: HashMap<String, Watch> = HashMap::new();
    let mut cleanup = tokio::time::interval(Duration::from_secs(1));
    cleanup.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let operation = tokio::select! {
            operation = operations.recv() => match operation { Some(operation) => Some(operation), None => break },
            _ = cleanup.tick() => None,
        };
        let closed: Vec<_> = watches
            .iter()
            .filter(|(_, watch)| watch.child.is_transport_closed())
            .map(|(uri, _)| uri.clone())
            .collect();
        for uri in closed {
            if let Some(watch) = watches.remove(&uri) {
                // Transport closure can precede the callback channel closing.
                let _ = tokio::time::timeout(
                    Duration::from_millis(250),
                    watch
                        .upstream
                        .notify_resource_updated(ResourceUpdatedNotificationParam::new(uri)),
                )
                .await;
            }
        }
        watches
            .retain(|_, watch| !watch.task.is_finished() && !watch.upstream.is_transport_closed());
        let Some(operation) = operation else {
            continue;
        };
        match operation {
            Operation::Subscribe {
                uri,
                child,
                generation,
                notifications,
                upstream,
                reply,
            } => {
                if reply.is_closed() {
                    continue;
                }
                if watches
                    .get(&uri)
                    .is_some_and(|watch| watch.generation == generation)
                {
                    // A cached relay can outlive its terminal notification.
                    // Repeat idempotent child admission before acknowledging.
                    let _ = reply.send(admit_subscription(&child, &uri).await);
                    continue;
                }
                if let Some(previous) = watches.remove(&uri) {
                    let _ = tokio::time::timeout(
                        Duration::from_millis(250),
                        previous
                            .upstream
                            .notify_resource_updated(ResourceUpdatedNotificationParam::new(&uri)),
                    )
                    .await;
                }
                if watches.len() >= 128 {
                    let _ = reply.send(Err(McpError::invalid_request(
                        "At most 128 resource watches may be active",
                        None,
                    )));
                    continue;
                }
                let result = admit_subscription(&child, &uri).await;
                match result {
                    Ok(_) => {
                        if reply.send(Ok(())).is_err() {
                            let _ = tokio::time::timeout(
                                Duration::from_secs(5),
                                child.unsubscribe(UnsubscribeRequestParams::new(uri)),
                            )
                            .await;
                            continue;
                        }
                        let task = tokio::spawn(relay(
                            uri.clone(),
                            child.clone(),
                            notifications,
                            upstream.clone(),
                        ));
                        watches.insert(
                            uri,
                            Watch {
                                child,
                                generation,
                                upstream,
                                task,
                            },
                        );
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Operation::Unsubscribe { uri, reply } => {
                let result = if let Some(watch) = watches.remove(&uri) {
                    watch.task.abort();
                    tokio::time::timeout(
                        Duration::from_secs(5),
                        watch.child.unsubscribe(UnsubscribeRequestParams::new(uri)),
                    )
                    .await
                    .map_err(|_| {
                        McpError::internal_error("Child resource unsubscribe timed out", None)
                    })
                    .and_then(|result| result.map(|_| ()).map_err(child_error))
                } else {
                    Ok(())
                };
                let _ = reply.send(result);
            }
        }
    }
}

async fn relay(
    uri: String,
    child: Peer<RoleClient>,
    mut notifications: broadcast::Receiver<ResourceUpdatedNotificationParam>,
    upstream: Peer<RoleServer>,
) {
    loop {
        if upstream.is_transport_closed() {
            break;
        }
        if child.is_transport_closed() {
            let _ = upstream
                .notify_resource_updated(ResourceUpdatedNotificationParam::new(&uri))
                .await;
            break;
        }
        let update = match notifications.recv().await {
            Ok(event) => (event.uri == uri).then_some(event),
            Err(broadcast::error::RecvError::Lagged(_)) => {
                crate::proxy::reconcile_listener_updates(&child, std::slice::from_ref(&uri))
                    .await
                    .pop()
            }
            Err(broadcast::error::RecvError::Closed) => {
                let _ = upstream
                    .notify_resource_updated(ResourceUpdatedNotificationParam::new(&uri))
                    .await;
                break;
            }
        };
        if let Some(update) = update {
            let terminal = crate::proxy::attachment_terminal(update.meta.as_ref()).is_some();
            if upstream.notify_resource_updated(update).await.is_err() || terminal {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::*;
    use rmcp::service::{NotificationContext, RequestContext};
    use rmcp::{ClientHandler, ServerHandler, ServiceExt};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    struct Child {
        dead: Arc<AtomicBool>,
        admissions: Arc<AtomicUsize>,
    }
    impl ServerHandler for Child {
        #[allow(deprecated)]
        async fn subscribe(
            &self,
            _: SubscribeRequestParams,
            _: RequestContext<RoleServer>,
        ) -> Result<(), McpError> {
            self.admissions.fetch_add(1, Ordering::SeqCst);
            if self.dead.load(Ordering::SeqCst) {
                return Err(McpError::internal_error("sync_failed", Some(signal())));
            }
            Ok(())
        }
    }
    struct Notifications(mpsc::UnboundedSender<ResourceUpdatedNotificationParam>);
    impl ClientHandler for Notifications {
        async fn on_resource_updated(
            &self,
            mut params: ResourceUpdatedNotificationParam,
            context: NotificationContext<RoleClient>,
        ) {
            let mut meta = params.meta.take().unwrap_or_default();
            if let Some(extracted) = context.extensions.get::<NotificationMetaObject>() {
                meta.extend(extracted.clone());
            }
            meta.extend(context.meta);
            params.meta = Some(meta);
            let _ = self.0.send(params);
        }
    }
    fn signal() -> serde_json::Value {
        serde_json::json!({"code":"attachment_unavailable","notebook_handle":"retained"})
    }
    fn terminal(uri: &str) -> ResourceUpdatedNotificationParam {
        let mut update = ResourceUpdatedNotificationParam::new(uri);
        let mut meta = NotificationMetaObject::default();
        meta.insert("io.nteract/attachmentUnavailable".into(), signal());
        update.meta = Some(meta);
        update
    }

    #[tokio::test]
    async fn cached_legacy_relay_rechecks_admission_and_unavailable_signal_ends_relay() {
        let dead = Arc::new(AtomicBool::new(false));
        let admissions = Arc::new(AtomicUsize::new(0));
        let child = Child {
            dead: dead.clone(),
            admissions: admissions.clone(),
        };
        let (server_pipe, client_pipe) = tokio::io::duplex(65536);
        let task = tokio::spawn(async move { child.serve(server_pipe).await.unwrap() });
        let (sent, mut received) = mpsc::unbounded_channel();
        let mut client = Notifications(sent).serve(client_pipe).await.unwrap();
        let mut server = task.await.unwrap();
        let (updates, _) = broadcast::channel(16);
        let bridge = ObservationBridge::default();
        let uri = "nteract://sessions/retained/cells";
        bridge
            .subscribe(
                uri.into(),
                client.peer().clone(),
                1,
                updates.subscribe(),
                server.peer().clone(),
            )
            .await
            .unwrap();
        // No terminal notification has reached the cached relay yet.
        dead.store(true, Ordering::SeqCst);
        let error = bridge
            .subscribe(
                uri.into(),
                client.peer().clone(),
                1,
                updates.subscribe(),
                server.peer().clone(),
            )
            .await
            .unwrap_err();
        assert_eq!(admissions.load(Ordering::SeqCst), 2);
        assert_eq!(error.code, ErrorCode::INTERNAL_ERROR);
        assert_eq!(error.message, "sync_failed");
        assert_eq!(error.data, Some(signal()));

        // Exercise the production relay directly so task completion is observed
        // independently of the actor's periodic finished-task cleanup.
        let other_uri = "nteract://sessions/retained/comments";
        let relay_task = tokio::spawn(relay(
            other_uri.into(),
            client.peer().clone(),
            updates.subscribe(),
            server.peer().clone(),
        ));
        updates.send(terminal(other_uri)).unwrap();
        tokio::time::timeout(Duration::from_secs(2), relay_task)
            .await
            .unwrap()
            .unwrap();
        let update = tokio::time::timeout(Duration::from_secs(2), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(update.uri, other_uri);
        assert_eq!(
            crate::proxy::attachment_terminal(update.meta.as_ref()),
            Some(("io.nteract/attachmentUnavailable", &signal()))
        );
        drop(bridge);
        client.close().await.unwrap();
        server.close().await.unwrap();
    }
}
