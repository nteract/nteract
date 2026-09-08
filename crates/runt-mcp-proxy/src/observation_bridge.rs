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
                    let _ = reply.send(Ok(()));
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
                let result = tokio::time::timeout(
                    Duration::from_secs(5),
                    child.subscribe(SubscribeRequestParams::new(&uri)),
                )
                .await
                .map_err(|_| {
                    McpError::internal_error("Child resource subscription timed out", None)
                })
                .and_then(|result| result.map_err(child_error));
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
            Ok(event) => event.uri == uri,
            Err(broadcast::error::RecvError::Lagged(_)) => true,
            Err(broadcast::error::RecvError::Closed) => {
                let _ = upstream
                    .notify_resource_updated(ResourceUpdatedNotificationParam::new(&uri))
                    .await;
                break;
            }
        };
        if update
            && upstream
                .notify_resource_updated(ResourceUpdatedNotificationParam::new(&uri))
                .await
                .is_err()
        {
            break;
        }
    }
}
