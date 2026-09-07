//! Reference-counted private-child watches for request-scoped native listeners.
//! An actor owns acknowledgments and cleanup so cancellation cannot strand a
//! half-installed watch or unsubscribe a watch still used by another listener.

use rmcp::model::{SubscribeRequestParams, UnsubscribeRequestParams};
use rmcp::service::{Peer, RoleClient};
use rmcp::ErrorData;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

type Key = (u64, String);
enum Operation {
    Acquire {
        generation: u64,
        uris: Vec<String>,
        child: Peer<RoleClient>,
        reply: oneshot::Sender<Result<(Vec<Key>, OwnedSemaphorePermit), ErrorData>>,
        permit: OwnedSemaphorePermit,
    },
    Release(Vec<Key>, OwnedSemaphorePermit),
}
struct Worker {
    sender: mpsc::UnboundedSender<Operation>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub(crate) struct Registry {
    worker: Mutex<Option<Worker>>,
    slots: Arc<Semaphore>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            worker: Mutex::new(None),
            slots: Arc::new(Semaphore::new(128)),
        }
    }
}
pub(crate) struct Lease {
    keys: Vec<Key>,
    sender: mpsc::UnboundedSender<Operation>,
    permit: Option<OwnedSemaphorePermit>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(permit) = self.permit.take() {
            let _ = self
                .sender
                .send(Operation::Release(std::mem::take(&mut self.keys), permit));
        }
    }
}
impl Registry {
    pub(crate) async fn acquire(
        &self,
        generation: u64,
        uris: Vec<String>,
        child: Peer<RoleClient>,
    ) -> Result<Lease, ErrorData> {
        let count = u32::try_from(uris.len())
            .map_err(|_| ErrorData::invalid_params("Too many resource watches", None))?;
        let permit = self
            .slots
            .clone()
            .try_acquire_many_owned(count)
            .map_err(|_| {
                ErrorData::invalid_request(
                    "At most 128 native resource watches may be active",
                    None,
                )
            })?;
        let sender = {
            let mut worker = self.worker.lock().unwrap_or_else(|e| e.into_inner());
            if worker
                .as_ref()
                .is_some_and(|worker| worker.task.is_finished())
            {
                worker.take();
            }
            worker
                .get_or_insert_with(|| {
                    let (sender, receiver) = mpsc::unbounded_channel();
                    Worker {
                        sender,
                        task: tokio::spawn(run(receiver)),
                    }
                })
                .sender
                .clone()
        };
        let (reply, response) = oneshot::channel();
        sender
            .send(Operation::Acquire {
                generation,
                uris,
                child,
                reply,
                permit,
            })
            .map_err(|_| unavailable())?;
        // The actor owns cancellation cleanup. The permit returns only after
        // pending child acknowledgments and any resulting unsubscriptions.
        let (keys, permit) = tokio::time::timeout(Duration::from_secs(30), response)
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())??;
        Ok(Lease {
            keys,
            sender,
            permit: Some(permit),
        })
    }
}
fn unavailable() -> ErrorData {
    ErrorData::internal_error("Native subscription relay is unavailable", None)
}
struct Watch {
    peer: Peer<RoleClient>,
    users: usize,
}

#[allow(deprecated)]
async fn release(watches: &mut HashMap<Key, Watch>, keys: Vec<Key>) {
    let mut cleanup = tokio::task::JoinSet::new();
    for key in keys {
        let last = watches.get_mut(&key).is_some_and(|watch| {
            watch.users -= 1;
            watch.users == 0
        });
        if last {
            if let Some(watch) = watches.remove(&key) {
                cleanup.spawn(async move {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(5),
                        watch.peer.unsubscribe(UnsubscribeRequestParams::new(key.1)),
                    )
                    .await;
                });
            }
        }
    }
    while cleanup.join_next().await.is_some() {}
}

#[allow(deprecated)]
async fn run(mut operations: mpsc::UnboundedReceiver<Operation>) {
    let mut watches: HashMap<Key, Watch> = HashMap::new();
    while let Some(operation) = operations.recv().await {
        match operation {
            Operation::Release(keys, _permit) => release(&mut watches, keys).await,
            Operation::Acquire {
                generation,
                uris,
                child,
                reply,
                permit,
            } => {
                if reply.is_closed() {
                    continue;
                }
                let mut keys = Vec::new();
                let mut error = None;
                for uri in uris {
                    if reply.is_closed() {
                        error = Some(unavailable());
                        break;
                    }
                    let key = (generation, uri.clone());
                    if let Some(watch) = watches.get_mut(&key) {
                        watch.users += 1;
                        keys.push(key);
                        continue;
                    }
                    let result = tokio::time::timeout(
                        Duration::from_secs(5),
                        child.subscribe(SubscribeRequestParams::new(&uri)),
                    )
                    .await;
                    match result {
                        Ok(Ok(_)) => {
                            watches.insert(
                                key.clone(),
                                Watch {
                                    peer: child.clone(),
                                    users: 1,
                                },
                            );
                            keys.push(key);
                        }
                        Ok(Err(rmcp::service::ServiceError::McpError(mut child_error))) => {
                            if child_error.code.0 == -32002 {
                                child_error.code = rmcp::model::ErrorCode::INVALID_PARAMS;
                            }
                            error = Some(child_error);
                            break;
                        }
                        _ => {
                            error = Some(unavailable());
                            break;
                        }
                    }
                }
                if let Some(error) = error {
                    release(&mut watches, keys).await;
                    let _ = reply.send(Err(error));
                } else if let Err(Ok((keys, _permit))) = reply.send(Ok((keys, permit))) {
                    release(&mut watches, keys).await;
                }
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, deprecated)]
mod tests {
    use super::*;
    use rmcp::service::{RequestContext, RoleServer};
    use rmcp::{ServerHandler, ServiceExt};
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Child {
        subscribed: Arc<AtomicUsize>,
        unsubscribed: Arc<AtomicUsize>,
    }
    impl ServerHandler for Child {
        async fn subscribe(
            &self,
            _: SubscribeRequestParams,
            _: RequestContext<RoleServer>,
        ) -> Result<(), ErrorData> {
            self.subscribed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn unsubscribe(
            &self,
            _: UnsubscribeRequestParams,
            _: RequestContext<RoleServer>,
        ) -> Result<(), ErrorData> {
            self.unsubscribed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    #[tokio::test]
    async fn cancelling_one_listener_keeps_the_shared_child_watch_until_the_last_lease() {
        let registry = Registry::default();
        let subscribed = Arc::new(AtomicUsize::new(0));
        let unsubscribed = Arc::new(AtomicUsize::new(0));
        let child = Child {
            subscribed: subscribed.clone(),
            unsubscribed: unsubscribed.clone(),
        };
        let (server_pipe, client_pipe) = tokio::io::duplex(65536);
        let task = tokio::spawn(async move { child.serve(server_pipe).await.unwrap() });
        let mut client = ().serve(client_pipe).await.unwrap();
        let mut server = task.await.unwrap();
        let first = registry
            .acquire(1, vec!["fixture://one".into()], client.peer().clone())
            .await
            .unwrap();
        let second = registry
            .acquire(1, vec!["fixture://one".into()], client.peer().clone())
            .await
            .unwrap();
        assert_eq!(subscribed.load(Ordering::SeqCst), 1);
        drop(first);
        let third = registry
            .acquire(1, vec!["fixture://one".into()], client.peer().clone())
            .await
            .unwrap();
        assert_eq!(unsubscribed.load(Ordering::SeqCst), 0);
        drop(second);
        drop(third);
        let barrier = registry
            .acquire(1, vec!["fixture://other".into()], client.peer().clone())
            .await
            .unwrap();
        assert_eq!(unsubscribed.load(Ordering::SeqCst), 1);
        assert_eq!(subscribed.load(Ordering::SeqCst), 2);
        drop(barrier);
        drop(registry);
        client.close().await.unwrap();
        server.close().await.unwrap();
    }
}
