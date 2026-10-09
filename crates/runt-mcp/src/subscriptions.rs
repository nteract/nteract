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

pub(crate) async fn listen(
    server: &crate::NteractMcp,
    context: rmcp::service::SubscriptionContext,
) -> Result<(), McpError> {
    let uris = context
        .accepted()
        .resource_subscriptions
        .clone()
        .unwrap_or_default();
    let _permit = server
        .native_subscription_slots
        .try_acquire_many(uris.len() as u32)
        .map_err(|_| {
            McpError::invalid_request("At most 128 native resource watches may be active", None)
        })?;
    let mut prepared = Vec::new();
    for uri in uris {
        let target = crate::resources::parse_notebook_resource_uri(&uri)
            .map_err(|e| McpError::invalid_params(e, None))?;
        let handle = match &target {
            NotebookResourceUri::Cells { notebook_id }
            | NotebookResourceUri::Cell { notebook_id, .. }
            | NotebookResourceUri::Comments { notebook_id } => notebook_id,
            NotebookResourceUri::Notebooks => {
                return Err(McpError::invalid_params(
                    "Use a notebook attachment URI",
                    None,
                ))
            }
        };
        let (_, observer) = server.observer_for_handle(handle).await?.ok_or_else(|| {
            McpError::invalid_params(
                "Notebook attachment expired; connect again and obtain a new handle",
                None,
            )
        })?;
        let baseline = observer
            .read(None)
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        if baseline.outcome == ChangeOutcome::Unavailable {
            return Err(McpError::invalid_params(
                "Notebook attachment is unavailable",
                None,
            ));
        }
        let expiration = server
            .attachments
            .read_entries()
            .get(handle)
            .map(|entry| entry.expiration())
            .ok_or_else(|| McpError::invalid_params("Notebook attachment expired", None))?;
        prepared.push((uri, target, observer, baseline.cursor, expiration));
    }
    // Receivers and cursors exist before the client sees its acknowledgment.
    mcp_transport::acknowledge(context.request_context()).await?;
    let mut watches = tokio::task::JoinSet::new();
    for (uri, target, observer, mut cursor, mut expiration) in prepared {
        let sink = context.sink().clone();
        watches.spawn(async move {
            loop {
                if *expiration.borrow() {
                    let _ = sink.notify_resource_updated(&uri).await;
                    return Ok::<(), McpError>(());
                }
                let change = tokio::select! {
                    change = observer.wait(&cursor, Duration::from_secs(50)) => change,
                    _ = expiration.changed() => {
                        let _ = sink.notify_resource_updated(&uri).await;
                        return Ok::<(), McpError>(());
                    }
                }
                .map_err(|error| McpError::internal_error(error.to_string(), None))?;
                cursor = change.cursor;
                let invalidated = matches!(
                    change.outcome,
                    ChangeOutcome::Unavailable | ChangeOutcome::ResyncRequired
                );
                if invalidated || affects(&target, &change.changes) {
                    tokio::time::timeout(
                        Duration::from_secs(1),
                        sink.notify_resource_updated(&uri),
                    )
                    .await
                    .map_err(|_| {
                        McpError::internal_error(
                            "Subscription delivery timed out; read a fresh baseline",
                            None,
                        )
                    })?
                    .map_err(|error| McpError::internal_error(error.to_string(), None))?;
                }
                if change.outcome == ChangeOutcome::Unavailable {
                    return Ok::<(), McpError>(());
                }
            }
        });
    }
    tokio::select! {
        _ = mcp_transport::cancelled(context.request_context()) => Ok(()),
        result = drain_watches(&mut watches) => result,
    }
}

async fn drain_watches(
    watches: &mut tokio::task::JoinSet<Result<(), McpError>>,
) -> Result<(), McpError> {
    while let Some(ended) = watches.join_next().await {
        ended.map_err(|error| McpError::internal_error(error.to_string(), None))??;
    }
    Ok(())
}

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
    #[cfg(test)]
    pub(crate) fn subscribe(
        self: &Arc<Self>,
        uri: String,
        target: NotebookResourceUri,
        observer: ObservationReader,
        peer: Peer<RoleServer>,
    ) -> Result<(), McpError> {
        self.subscribe_with_expiration(uri, target, observer, peer, None)
    }

    pub(crate) fn subscribe_with_expiration(
        self: &Arc<Self>,
        uri: String,
        target: NotebookResourceUri,
        observer: ObservationReader,
        peer: Peer<RoleServer>,
        mut expiration: Option<(String, tokio::sync::watch::Receiver<bool>)>,
    ) -> Result<(), McpError> {
        let baseline = observer
            .read(None)
            .map_err(|error| McpError::internal_error(error.to_string(), None))?;
        if baseline.outcome == ChangeOutcome::Unavailable {
            if let Some((handle, expired)) = expiration.as_ref() {
                if *expired.borrow() {
                    return Err(crate::attachments::expired_resource_error(handle));
                }
            }
            return Err(McpError::resource_not_found(
                "Notebook attachment is no longer available",
                expiration
                    .as_ref()
                    .map(|(handle, _)| crate::attachments::unavailable_resource_data(handle)),
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
                let result = tokio::select! {
                    change = observer.wait(&cursor, Duration::from_secs(50)) => change,
                    _ = async {
                        match expiration.as_mut() {
                            Some((_, expiration)) => {
                                if !*expiration.borrow() { let _ = expiration.changed().await; }
                            }
                            None => std::future::pending::<()>().await,
                        }
                    } => {
                        if let Some((handle, _)) = expiration.as_ref() {
                            let _ = tokio::time::timeout(Duration::from_secs(1), peer.notify_resource_updated(crate::attachments::expired_resource_notification(&task_uri, handle))).await;
                        }
                        break;
                    }
                };
                let Ok(change) = result else {
                    break;
                };
                cursor = change.cursor;
                if change.outcome == ChangeOutcome::Unavailable {
                    let update = match expiration.as_ref() {
                        Some((handle, expired)) if *expired.borrow() => {
                            crate::attachments::expired_resource_notification(&task_uri, handle)
                        }
                        Some((handle, _)) => {
                            crate::attachments::unavailable_resource_notification(&task_uri, handle)
                        }
                        None => ResourceUpdatedNotificationParam::new(&task_uri),
                    };
                    // Disconnected is terminal for this observation peer even
                    // if its daemon incarnation and logical handle remain live.
                    let _ = tokio::time::timeout(
                        Duration::from_secs(1),
                        peer.notify_resource_updated(update),
                    )
                    .await;
                    break;
                }
                let invalidated = matches!(change.outcome, ChangeOutcome::ResyncRequired);
                if (invalidated || affects(&target, &change.changes))
                    && peer
                        .notify_resource_updated(ResourceUpdatedNotificationParam::new(&task_uri))
                        .await
                        .is_err()
                {
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

    #[tokio::test]
    async fn releasing_one_attachment_keeps_other_listener_watches_running() {
        let mut watches = tokio::task::JoinSet::new();
        let (released, observed) = tokio::sync::oneshot::channel();
        watches.spawn(async move {
            let _ = released.send(());
            Ok(())
        });
        let (release_second, second) = tokio::sync::oneshot::channel();
        watches.spawn(async move {
            let _ = second.await;
            Ok(())
        });
        observed.await.expect("first attachment released");
        assert!(
            tokio::time::timeout(Duration::from_millis(30), drain_watches(&mut watches))
                .await
                .is_err()
        );
        release_second.send(()).expect("second watch still alive");
        drain_watches(&mut watches)
            .await
            .expect("all attachments released");
    }

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

    struct TypedNotifications(tokio::sync::mpsc::UnboundedSender<ResourceUpdatedNotificationParam>);
    impl ClientHandler for TypedNotifications {
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

    async fn local_peer(
        id: &str,
        incarnation: crate::session::DaemonIncarnation,
    ) -> (
        crate::session::NotebookSession,
        tokio::sync::mpsc::UnboundedSender<notebook_protocol::connection::TypedNotebookFrame>,
    ) {
        use notebook_protocol::connection::{
            FrameSource, NotebookFrameType, TypedNotebookFrame, WriterFrameSink,
        };
        use notebook_protocol::protocol::{
            InitialLoadPhaseWire, NotebookDocPhaseWire, RuntimeStatePhaseWire,
            SessionControlMessage, SessionSyncStatusWire,
        };
        struct Frames(tokio::sync::mpsc::UnboundedReceiver<TypedNotebookFrame>);
        impl FrameSource for Frames {
            async fn recv_frame(&mut self) -> Option<std::io::Result<TypedNotebookFrame>> {
                self.0.recv().await.map(Ok)
            }
        }
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let handle = notebook_sync::connect::connect_frame_io(
            id.into(),
            "local:test/agent:test",
            Frames(receiver),
            WriterFrameSink::new(tokio::io::sink()),
        )
        .await
        .unwrap()
        .handle;
        let mut status = handle.subscribe_status();
        sender
            .send(TypedNotebookFrame {
                frame_type: NotebookFrameType::SessionControl,
                payload: serde_json::to_vec(&SessionControlMessage::SyncStatus(
                    SessionSyncStatusWire {
                        notebook_doc: NotebookDocPhaseWire::Interactive,
                        runtime_state: RuntimeStatePhaseWire::Ready,
                        initial_load: InitialLoadPhaseWire::NotNeeded,
                    },
                ))
                .unwrap(),
            })
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !status.borrow_and_update().session_ready() {
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        (
            crate::session::NotebookSession::local(handle, id.into(), None, Some(incarnation)),
            sender,
        )
    }

    #[tokio::test]
    #[allow(deprecated)]
    async fn disconnected_peer_ends_only_its_watch_and_retains_its_attachment() {
        use crate::attachments::{ATTACHMENT_EXPIRED_META_KEY, ATTACHMENT_UNAVAILABLE_META_KEY};
        let incarnation = crate::session::DaemonIncarnation {
            pid: 123,
            started_at: chrono::Utc::now(),
        };
        let (a, sender_a) = local_peer("a", incarnation.clone()).await;
        let (b, _sender_b) = local_peer("b", incarnation.clone()).await;
        let handle_a = a.notebook_handle.clone();
        let handle_b = b.notebook_handle.clone();
        let peer_b = b.handle.clone();
        let mut status_a = a.handle.subscribe_status();
        let observer_a = a.observer().unwrap();
        let server = crate::NteractMcp::new_no_show("unused-test-socket".into(), None, None);
        let attachments = server.attachments.clone();
        let watches = server.resource_subscriptions.clone();
        attachments.insert(a, attachments.reserve().unwrap());
        attachments.insert(b, attachments.reserve().unwrap());
        let expired_a = attachments
            .read_entries()
            .get(&handle_a)
            .unwrap()
            .expiration();
        let uri_a = format!("nteract://sessions/{handle_a}/cells");
        let uri_b = format!("nteract://sessions/{handle_b}/cells");
        let (server_pipe, client_pipe) = tokio::io::duplex(65536);
        let task = tokio::spawn(async move { server.serve(server_pipe).await.unwrap() });
        let (tx, mut updates) = tokio::sync::mpsc::unbounded_channel();
        let mut client = TypedNotifications(tx).serve(client_pipe).await.unwrap();
        let mut service = task.await.unwrap();
        for uri in [&uri_a, &uri_b] {
            client
                .subscribe(SubscribeRequestParams::new(uri))
                .await
                .unwrap();
        }
        drop(sender_a);
        tokio::time::timeout(Duration::from_secs(2), async {
            while status_a.borrow_and_update().connection
                != notebook_sync::status::ConnectionState::Disconnected
            {
                status_a.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        let update = tokio::time::timeout(Duration::from_secs(2), updates.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(update.uri, uri_a);
        let meta = update.meta.unwrap();
        assert_eq!(
            meta.get(ATTACHMENT_UNAVAILABLE_META_KEY),
            Some(&crate::attachments::unavailable_resource_data(&handle_a))
        );
        assert!(!meta.contains_key(ATTACHMENT_EXPIRED_META_KEY));
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if !watches.tasks.lock().unwrap().contains_key(&uri_a) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(watches.tasks.lock().unwrap().contains_key(&uri_b));
        assert!(!*expired_a.borrow());
        assert_eq!(
            attachments
                .read_entries()
                .get(&handle_a)
                .unwrap()
                .session
                .local_daemon_incarnation,
            Some(incarnation)
        );
        let error = client
            .read_resource(ReadResourceRequestParams::new(&uri_a))
            .await
            .unwrap_err();
        let rmcp::ServiceError::McpError(error) = error else {
            panic!("expected resource access error")
        };
        assert_eq!(error.code, ErrorCode::INTERNAL_ERROR);
        assert!(error.message.contains("sync_failed"));
        assert_eq!(
            error.data,
            Some(crate::attachments::unavailable_resource_data(&handle_a))
        );
        let error = client
            .subscribe(SubscribeRequestParams::new(&uri_a))
            .await
            .unwrap_err();
        let rmcp::ServiceError::McpError(error) = error else {
            panic!("expected subscription admission error")
        };
        assert_eq!(error.code, ErrorCode::INTERNAL_ERROR);
        assert_eq!(
            error.data,
            Some(crate::attachments::unavailable_resource_data(&handle_a))
        );
        client
            .read_resource(ReadResourceRequestParams::new(&uri_b))
            .await
            .unwrap();
        peer_b
            .add_cell_with_source("survivor", "code", None, "healthy B edit")
            .unwrap();
        let update = tokio::time::timeout(Duration::from_secs(2), updates.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(update.uri, uri_b);
        assert!(!update
            .meta
            .as_ref()
            .unwrap()
            .contains_key(ATTACHMENT_UNAVAILABLE_META_KEY));
        assert!(!update
            .meta
            .as_ref()
            .unwrap()
            .contains_key(ATTACHMENT_EXPIRED_META_KEY));
        // Once membership really ends, expiration takes precedence over the
        // same peer's permanent unavailability, without waiting for recovery.
        drop(attachments.remove(&handle_a).unwrap());
        assert!(*expired_a.borrow());
        let error = watches
            .subscribe_with_expiration(
                uri_a.clone(),
                NotebookResourceUri::Cells {
                    notebook_id: handle_a.clone(),
                },
                observer_a,
                service.peer().clone(),
                Some((handle_a.clone(), expired_a)),
            )
            .unwrap_err();
        assert_eq!(error.data.unwrap()["code"], "attachment_expired");
        assert!(error.message.contains("Notebook attachment expired"));
        assert!(attachments.read_entries().contains_key(&handle_b));
        client.close().await.unwrap();
        service.close().await.unwrap();
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
