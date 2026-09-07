//! Connection-owned invalidation watches. Tasks retain observers, never sync peers.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::model::ResourceUpdatedNotificationParam;
use rmcp::service::{Peer, RoleServer};
use rmcp::ErrorData as McpError;

use crate::observation::{ChangeKind, ChangeOutcome, NotebookChanges, ObservationReader};
use crate::resources::NotebookResourceUri;

const MAX_WATCHES: usize = 128;
type ResourceWatch = (uuid::Uuid, ObservationReader, tokio::task::JoinHandle<()>);

#[derive(Default)]
pub(crate) struct ResourceSubscriptions {
    tasks: Mutex<HashMap<String, ResourceWatch>>,
}

impl Drop for ResourceSubscriptions {
    fn drop(&mut self) {
        if let Ok(tasks) = self.tasks.get_mut() {
            for (_, (_, _, task)) in tasks.drain() {
                task.abort();
            }
        }
    }
}

impl ResourceSubscriptions {
    pub(crate) fn subscribe(
        self: &Arc<Self>,
        uri: String,
        target: NotebookResourceUri,
        observer: ObservationReader,
        peer: Peer<RoleServer>,
    ) -> Result<(), McpError> {
        let baseline = observer
            .read(None)
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        if baseline.outcome == ChangeOutcome::Unavailable {
            return Err(McpError::resource_not_found(
                "Notebook attachment is no longer available",
                None,
            ));
        }
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        if tasks.get(&uri).is_some_and(|(_, existing, task)| {
            existing.same_attachment(&observer) && !task.is_finished()
        }) {
            return Ok(());
        }
        if let Some((_, _, task)) = tasks.remove(&uri) {
            task.abort();
        }
        if tasks.len() >= MAX_WATCHES {
            return Err(McpError::invalid_request(
                "At most 128 resource watches may be active on this connection",
                None,
            ));
        }
        let weak = Arc::downgrade(self);
        let id = uuid::Uuid::new_v4();
        let task_uri = uri.clone();
        let attachment = observer.clone();
        let task = tokio::spawn(async move {
            let mut cursor = baseline.cursor;
            loop {
                let Ok(change) = observer.wait(&cursor, Duration::from_secs(50)).await else {
                    break;
                };
                cursor = change.cursor;
                let invalidated = matches!(
                    change.outcome,
                    ChangeOutcome::Unavailable | ChangeOutcome::ResyncRequired
                );
                if (invalidated || affects(&target, &change.changes))
                    && peer
                        .notify_resource_updated(ResourceUpdatedNotificationParam::new(&task_uri))
                        .await
                        .is_err()
                {
                    break;
                }
                if change.outcome == ChangeOutcome::Unavailable {
                    break;
                }
            }
            if let Some(registry) = weak.upgrade() {
                if let Ok(mut tasks) = registry.tasks.lock() {
                    if tasks
                        .get(&task_uri)
                        .is_some_and(|(current, _, _)| *current == id)
                    {
                        tasks.remove(&task_uri);
                    }
                }
            }
        });
        tasks.insert(uri, (id, attachment, task));
        Ok(())
    }

    pub(crate) fn unsubscribe(&self, uri: &str) -> Result<(), McpError> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        if let Some((_, _, task)) = tasks.remove(uri) {
            task.abort();
        }
        Ok(())
    }
}

pub(crate) fn affects(target: &NotebookResourceUri, changes: &NotebookChanges) -> bool {
    if changes.kinds.contains(&ChangeKind::Status) {
        return true;
    }
    match target {
        NotebookResourceUri::Cells { .. } => changes.kinds.iter().any(|kind| {
            matches!(
                kind,
                ChangeKind::Cells
                    | ChangeKind::Executions
                    | ChangeKind::Outputs
                    | ChangeKind::Runtime
            )
        }),
        // Reordering or removing another cell changes this cell's neighbor links.
        NotebookResourceUri::Cell { cell_id, .. } => {
            changes.kinds.contains(&ChangeKind::Cells)
                || changes.cell_ids.contains(cell_id)
                || changes.kinds.contains(&ChangeKind::Runtime)
        }
        NotebookResourceUri::Comments { .. } => changes.kinds.contains(&ChangeKind::Comments),
        NotebookResourceUri::Notebooks => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observation::tests::{edited, fixture};
    use rmcp::model::*;
    use rmcp::service::{NotificationContext, RequestContext, RoleClient};
    use rmcp::{ClientHandler, ServerHandler, ServiceExt};

    struct Notifications(tokio::sync::mpsc::UnboundedSender<String>);
    impl ClientHandler for Notifications {
        async fn on_resource_updated(
            &self,
            params: ResourceUpdatedNotificationParam,
            _: NotificationContext<RoleClient>,
        ) {
            let _ = self.0.send(params.uri);
        }
    }
    struct Server {
        registry: Arc<ResourceSubscriptions>,
        observer: ObservationReader,
    }
    impl ServerHandler for Server {
        fn get_info(&self) -> ServerInfo {
            ServerInfo::new(
                ServerCapabilities::builder()
                    .enable_resources()
                    .enable_resources_subscribe()
                    .build(),
            )
        }
        #[allow(deprecated)]
        async fn subscribe(
            &self,
            params: SubscribeRequestParams,
            context: RequestContext<RoleServer>,
        ) -> Result<(), McpError> {
            let target = crate::resources::parse_notebook_resource_uri(&params.uri)
                .map_err(|e| McpError::invalid_params(e, None))?;
            self.registry
                .subscribe(params.uri, target, self.observer.clone(), context.peer)
        }
        #[allow(deprecated)]
        async fn unsubscribe(
            &self,
            params: UnsubscribeRequestParams,
            _: RequestContext<RoleServer>,
        ) -> Result<(), McpError> {
            self.registry.unsubscribe(&params.uri)
        }
    }

    #[tokio::test]
    #[allow(deprecated)]
    async fn subscribe_unsubscribe_and_session_release_use_real_protocol_notifications() {
        let fixture = fixture();
        let registry = Arc::new(ResourceSubscriptions::default());
        let (server_pipe, client_pipe) = tokio::io::duplex(65536);
        let server = Server {
            registry: registry.clone(),
            observer: fixture.owner.reader(),
        };
        let task = tokio::spawn(async move { server.serve(server_pipe).await.unwrap() });
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut client = Notifications(tx).serve(client_pipe).await.unwrap();
        let mut server = task.await.unwrap();
        let cells = "nteract://sessions/attachment/cells";
        let comments = "nteract://sessions/attachment/comments";
        client
            .subscribe(SubscribeRequestParams::new(cells))
            .await
            .unwrap();
        client
            .subscribe(SubscribeRequestParams::new(cells))
            .await
            .unwrap();
        client
            .subscribe(SubscribeRequestParams::new(comments))
            .await
            .unwrap();
        assert_eq!(registry.tasks.lock().unwrap().len(), 2);
        fixture.notebook.send_replace(edited("first edit"));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .unwrap()
                .unwrap(),
            cells
        );
        assert!(rx.try_recv().is_err());
        client
            .unsubscribe(UnsubscribeRequestParams::new(cells))
            .await
            .unwrap();
        fixture.notebook.send_replace(edited("second edit"));
        assert!(tokio::time::timeout(Duration::from_millis(150), rx.recv())
            .await
            .is_err());
        drop(fixture.owner);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .unwrap()
                .unwrap(),
            comments
        );
        assert!(tokio::time::timeout(Duration::from_millis(150), rx.recv())
            .await
            .is_err());
        assert!(registry.tasks.lock().unwrap().is_empty());
        client.close().await.unwrap();
        server.close().await.unwrap();
    }

    #[tokio::test]
    #[allow(deprecated)]
    async fn watch_limit_is_enforced_on_the_wire_and_unsubscribe_frees_a_slot() {
        let fixture = fixture();
        let registry = Arc::new(ResourceSubscriptions::default());
        let (server_pipe, client_pipe) = tokio::io::duplex(65536);
        let server = Server {
            registry,
            observer: fixture.owner.reader(),
        };
        let task = tokio::spawn(async move { server.serve(server_pipe).await.unwrap() });
        let mut client = ().serve(client_pipe).await.unwrap();
        let mut server = task.await.unwrap();
        for index in 0..MAX_WATCHES {
            client
                .subscribe(SubscribeRequestParams::new(format!(
                    "nteract://sessions/attachment/cells/cell-{index}"
                )))
                .await
                .unwrap();
        }
        let extra = "nteract://sessions/attachment/comments";
        assert!(client
            .subscribe(SubscribeRequestParams::new(extra))
            .await
            .is_err());
        client
            .unsubscribe(UnsubscribeRequestParams::new(
                "nteract://sessions/attachment/cells/cell-0",
            ))
            .await
            .unwrap();
        client
            .subscribe(SubscribeRequestParams::new(extra))
            .await
            .unwrap();
        client.close().await.unwrap();
        server.close().await.unwrap();
    }
}
