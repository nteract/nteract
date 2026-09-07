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
        notifications: broadcast::Receiver<ResourceUpdatedNotificationParam>,
        upstream: Peer<RoleServer>,
    ) -> Result<(), McpError> {
        let (reply, response) = oneshot::channel();
        self.sender()?
            .send(Operation::Subscribe {
                uri,
                child,
                notifications,
                upstream,
                reply,
            })
            .await
            .map_err(|_| unavailable())?;
        response.await.map_err(|_| unavailable())?
    }

    pub(crate) async fn unsubscribe(&self, uri: String) -> Result<(), McpError> {
        let (reply, response) = oneshot::channel();
        self.sender()?
            .send(Operation::Unsubscribe { uri, reply })
            .await
            .map_err(|_| unavailable())?;
        response.await.map_err(|_| unavailable())?
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
    while let Some(operation) = operations.recv().await {
        let closed: Vec<_> = watches
            .iter()
            .filter(|(_, watch)| watch.child.is_transport_closed())
            .map(|(uri, _)| uri.clone())
            .collect();
        for uri in closed {
            if let Some(watch) = watches.remove(&uri) {
                // The actor may observe closure before the relay's next tick.
                let _ = watch
                    .upstream
                    .notify_resource_updated(ResourceUpdatedNotificationParam::new(uri))
                    .await;
            }
        }
        watches.retain(|_, watch| !watch.task.is_finished());
        match operation {
            Operation::Subscribe {
                uri,
                child,
                notifications,
                upstream,
                reply,
            } => {
                if reply.is_closed() {
                    continue;
                }
                if watches.contains_key(&uri) {
                    let _ = reply.send(Ok(()));
                    continue;
                }
                if watches.len() >= 128 {
                    let _ = reply.send(Err(McpError::invalid_request(
                        "At most 128 resource watches may be active",
                        None,
                    )));
                    continue;
                }
                let result = child
                    .subscribe(SubscribeRequestParams::new(&uri))
                    .await
                    .map_err(child_error);
                match result {
                    Ok(_) => {
                        if reply.send(Ok(())).is_err() {
                            let _ = child.unsubscribe(UnsubscribeRequestParams::new(uri)).await;
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
                    watch
                        .child
                        .unsubscribe(UnsubscribeRequestParams::new(uri))
                        .await
                        .map(|_| ())
                        .map_err(child_error)
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
    let mut tick = tokio::time::interval(Duration::from_millis(100));
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
        let update = tokio::select! {
            event = notifications.recv() => match event {
                Ok(event) => event.uri == uri,
                Err(broadcast::error::RecvError::Lagged(_)) => true,
                Err(broadcast::error::RecvError::Closed) => {
                    let _ = upstream.notify_resource_updated(ResourceUpdatedNotificationParam::new(&uri)).await;
                    break;
                },
            },
            _ = tick.tick() => false,
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
