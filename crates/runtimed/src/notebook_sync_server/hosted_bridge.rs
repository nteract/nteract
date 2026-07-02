//! Daemon-side bridge between a local notebook room and a hosted cloud room.
//!
//! Implements the daemon-mediated topology from
//! `docs/memos/desktop-cloud-daemon-bridge.md` (#3861): the daemon dials the
//! hosted room over [`CloudWsFrameTransport`] and attaches it as one more sync
//! peer of a local, ephemeral `NotebookRoom`. Local peers (desktop windows,
//! MCP sessions) connect to that room exactly like any daemon-local notebook.
//!
//! Echo suppression is structural: the room holds one `NotebookDoc` instance,
//! and the cloud connection is one automerge `sync::State` against it, exactly
//! like each local peer. The sync protocol never replays a change to the peer
//! it came from, so there is no bridge-specific dedup state to get wrong.
//!
//! Attribution: inbound cloud changes carry the actor labels the hosted room
//! already authorized, and are applied without local re-validation — the cloud
//! room is the authority for its own history (other collaborators' principals
//! legitimately appear in it). Local peers author under the bridge's observed
//! cloud principal via [`RoomConnectionIdentity::hosted_bridged`], so the
//! hosted room's actor-authorization check accepts their changes and cloud
//! history shows `<principal>/<local-operator>` per client.
//!
//! RuntimeStateDoc: the hosted room is authoritative. Hosted-bridged rooms
//! never launch local kernels; execute requests are forwarded to the cloud
//! room as hosted `Request` frames (see `requests::mod`), and queue/output
//! state converges back through RuntimeStateDoc sync.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use automerge::sync;
use notebook_cloud_transport::CloudWsFrameTransport;
use notebook_doc::diff::diff_metadata_touched;
use notebook_protocol::connection::{FrameSink, FrameSource, FrameTransport};
use notebook_wire::NotebookFrameType;
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

use super::{
    check_and_broadcast_sync_state, check_and_update_trust_state, process_markdown_assets,
    NotebookRoom,
};

/// Initial reconnect backoff; doubles per failed attempt.
const BACKOFF_INITIAL: Duration = Duration::from_secs(1);
/// Backoff ceiling.
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A connection that lived at least this long resets the backoff.
const BACKOFF_RESET_AFTER: Duration = Duration::from_secs(30);
/// Bound on queued forwarded request frames while (re)connecting.
const FORWARD_QUEUE_CAPACITY: usize = 32;

pub(crate) struct HostedBridgeOptions {
    pub idle_after: Duration,
    pub on_idle: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl Default for HostedBridgeOptions {
    fn default() -> Self {
        Self {
            idle_after: Duration::from_secs(15 * 60),
            on_idle: None,
        }
    }
}

/// Handle to a running hosted-room bridge, owned by the daemon and keyed by
/// the room's local UUID plus the normalized hosted locator.
pub struct HostedBridgeHandle {
    pub room_id: uuid::Uuid,
    /// Normalized hosted locator, `https://<host>/n/<notebook_id>`.
    pub locator: String,
    /// Hosted notebook id (ULID) on the cloud domain.
    pub hosted_notebook_id: String,
    principal_rx: watch::Receiver<Option<String>>,
    request_tx: mpsc::Sender<Vec<u8>>,
    task: tokio::task::JoinHandle<()>,
    idle_task: Option<tokio::task::JoinHandle<()>>,
    /// Keeps the bridged room resident (`reservations > 0`) while the bridge
    /// is live. Idle teardown drops the handle so normal room eviction applies.
    _reservation: super::ReservationGuard,
}

impl HostedBridgeHandle {
    /// The authenticated cloud principal, once the first connect has observed
    /// `cloud_room_ready`.
    pub fn principal(&self) -> Option<String> {
        self.principal_rx.borrow().clone()
    }

    /// Wait until the bridge has observed the cloud principal (first
    /// successful connect), bounded by `timeout`.
    pub async fn wait_for_principal(&self, timeout: Duration) -> Option<String> {
        let mut rx = self.principal_rx.clone();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(principal) = rx.borrow_and_update().clone() {
                return Some(principal);
            }
            match tokio::time::timeout_at(deadline, rx.changed()).await {
                Ok(Ok(())) => continue,
                // Bridge task dropped its sender or we timed out.
                Ok(Err(_)) | Err(_) => return None,
            }
        }
    }

    /// Queue a hosted `Request` frame (JSON payload) for the cloud room.
    /// Best-effort: fails when the bridge is gone or the queue is full.
    pub fn forward_request(&self, payload: Vec<u8>) -> anyhow::Result<()> {
        self.request_tx
            .try_send(payload)
            .map_err(|e| anyhow::anyhow!("hosted bridge request queue unavailable: {e}"))
    }

    /// Stop the bridge task. The room itself is torn down by normal room
    /// eviction.
    pub fn shutdown(&self) {
        self.task.abort();
        if let Some(idle_task) = &self.idle_task {
            idle_task.abort();
        }
    }
}

/// Spawn the bridge task for `room` over `transport`.
///
/// The transport is taken pre-built (rather than a config) so tests can point
/// it at an in-process fake room server.
pub(crate) fn spawn_hosted_bridge(
    room: Arc<NotebookRoom>,
    transport: CloudWsFrameTransport,
    locator: String,
    hosted_notebook_id: String,
    reservation: super::ReservationGuard,
    options: HostedBridgeOptions,
) -> HostedBridgeHandle {
    let (principal_tx, principal_rx) = watch::channel(None);
    let (request_tx, request_rx) = mpsc::channel(FORWARD_QUEUE_CAPACITY);
    let room_id = room.id;
    let task_locator = locator.clone();
    let HostedBridgeOptions {
        idle_after,
        on_idle,
    } = options;
    let idle_task = on_idle.map(|on_idle| {
        let idle_room = room.clone();
        let idle_locator = locator.clone();
        tokio::spawn(async move {
            monitor_idle(idle_room, idle_locator, idle_after, on_idle).await;
        })
    });
    let task = tokio::spawn(async move {
        run_bridge(room, transport, task_locator, principal_tx, request_rx).await;
    });
    HostedBridgeHandle {
        room_id,
        locator,
        hosted_notebook_id,
        principal_rx,
        request_tx,
        task,
        idle_task,
        _reservation: reservation,
    }
}

async fn monitor_idle(
    room: Arc<NotebookRoom>,
    locator: String,
    idle_after: Duration,
    on_idle: Arc<dyn Fn() + Send + Sync>,
) {
    let mut tick = tokio::time::interval(idle_check_interval(idle_after));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut zero_since: Option<tokio::time::Instant> = None;
    let mut fired_for_span = false;

    loop {
        tick.tick().await;
        let active_peers = room.connections.active_peers.load(Ordering::Relaxed);
        if active_peers > 0 {
            zero_since = None;
            fired_for_span = false;
            continue;
        }

        let now = tokio::time::Instant::now();
        let since = zero_since.get_or_insert(now);
        if !fired_for_span && now.duration_since(*since) >= idle_after {
            debug!(
                "[hosted-bridge] {} idle for {:?}; signaling daemon teardown",
                locator, idle_after
            );
            on_idle();
            fired_for_span = true;
        }
    }
}

fn idle_check_interval(idle_after: Duration) -> Duration {
    let coarse = (idle_after / 4).min(Duration::from_secs(60));
    coarse.max(Duration::from_millis(50))
}

async fn run_bridge(
    room: Arc<NotebookRoom>,
    transport: CloudWsFrameTransport,
    locator: String,
    principal_tx: watch::Sender<Option<String>>,
    mut request_rx: mpsc::Receiver<Vec<u8>>,
) {
    let mut backoff = BACKOFF_INITIAL;
    loop {
        // A closed principal watch means the daemon dropped the handle; stop
        // dialing on behalf of a room nobody can reach.
        if principal_tx.is_closed() {
            return;
        }
        let connected_at = tokio::time::Instant::now();
        match transport.connect().await {
            Ok((source, sink)) => {
                let Some(principal) = transport.principal().map(str::to_string) else {
                    warn!(
                        "[hosted-bridge] {} connected without a principal; retrying",
                        locator
                    );
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                    continue;
                };
                let _ = principal_tx.send(Some(principal.clone()));
                info!(
                    "[hosted-bridge] {} attached as principal {}",
                    locator, principal
                );
                if let Err(e) = run_connection(&room, &locator, source, sink, &mut request_rx).await
                {
                    warn!("[hosted-bridge] {} connection ended: {}", locator, e);
                } else {
                    info!("[hosted-bridge] {} connection closed", locator);
                }
            }
            Err(e) => {
                warn!("[hosted-bridge] {} connect failed: {}", locator, e);
            }
        }
        if connected_at.elapsed() >= BACKOFF_RESET_AFTER {
            backoff = BACKOFF_INITIAL;
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// Drive one live cloud connection until it drops.
async fn run_connection<S, W>(
    room: &Arc<NotebookRoom>,
    locator: &str,
    mut source: S,
    mut sink: W,
    request_rx: &mut mpsc::Receiver<Vec<u8>>,
) -> anyhow::Result<()>
where
    S: FrameSource + Send,
    W: FrameSink + Send,
{
    // Fresh sync states per connection: the room may have advanced while
    // disconnected, and cloud transport sync state is connection-scoped.
    let mut nb_peer = sync::State::new();
    let mut rt_peer = sync::State::new();

    // Subscribe before the initial send so a local change landing between
    // "generate initial" and "select loop" is not missed.
    let mut changed_rx = room.broadcasts.changed_tx.subscribe();
    let mut state_rx = room.state.subscribe();

    if let Some(encoded) = generate_notebook_sync(room, &mut nb_peer).await? {
        sink.send_frame(NotebookFrameType::AutomergeSync, &encoded)
            .await?;
    }
    if let Some(encoded) = generate_runtime_sync(room, &mut rt_peer)? {
        sink.send_frame(NotebookFrameType::RuntimeStateSync, &encoded)
            .await?;
    }

    loop {
        tokio::select! {
            frame = source.recv_frame() => {
                let Some(frame) = frame else {
                    return Ok(());
                };
                let frame = frame?;
                match frame.frame_type {
                    NotebookFrameType::AutomergeSync => {
                        let reply = apply_cloud_notebook_sync(room, &mut nb_peer, &frame.payload).await?;
                        if let Some(encoded) = reply {
                            sink.send_frame(NotebookFrameType::AutomergeSync, &encoded).await?;
                        }
                    }
                    NotebookFrameType::RuntimeStateSync => {
                        let reply = apply_cloud_runtime_sync(room, &mut rt_peer, &frame.payload)?;
                        if let Some(encoded) = reply {
                            sink.send_frame(NotebookFrameType::RuntimeStateSync, &encoded).await?;
                        }
                    }
                    NotebookFrameType::SessionControl => {
                        if let Ok(control) = serde_json::from_slice::<serde_json::Value>(&frame.payload) {
                            let ctl = control.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            if ctl != "cloud_frame_accepted" && ctl != "cloud_room_ready" {
                                debug!("[hosted-bridge] {} control: {}", locator, ctl);
                            }
                        }
                    }
                    other => {
                        debug!(
                            "[hosted-bridge] {} ignoring frame {:?} ({} bytes)",
                            locator, other, frame.payload.len()
                        );
                    }
                }
            }
            changed = changed_rx.recv() => {
                // Lagged is fine: sync generation reads current doc state, so
                // one pass after any number of missed notifications converges.
                if let Err(tokio::sync::broadcast::error::RecvError::Closed) = changed {
                    return Ok(());
                }
                if let Some(encoded) = generate_notebook_sync(room, &mut nb_peer).await? {
                    sink.send_frame(NotebookFrameType::AutomergeSync, &encoded).await?;
                }
            }
            state_changed = state_rx.recv() => {
                if let Err(tokio::sync::broadcast::error::RecvError::Closed) = state_changed {
                    return Ok(());
                }
                if let Some(encoded) = generate_runtime_sync(room, &mut rt_peer)? {
                    sink.send_frame(NotebookFrameType::RuntimeStateSync, &encoded).await?;
                }
            }
            request = request_rx.recv() => {
                let Some(payload) = request else {
                    return Ok(());
                };
                sink.send_frame(NotebookFrameType::Request, &payload).await?;
            }
        }
    }
}

async fn generate_notebook_sync(
    room: &NotebookRoom,
    nb_peer: &mut sync::State,
) -> anyhow::Result<Option<Vec<u8>>> {
    let mut doc = room.doc.write().await;
    doc.generate_sync_message_recovering(nb_peer, "hosted-bridge-doc-send")
        .map(|message| message.map(|m| m.encode()))
        .map_err(|e| anyhow::anyhow!("hosted bridge doc sync generate: {e}"))
}

fn generate_runtime_sync(
    room: &NotebookRoom,
    rt_peer: &mut sync::State,
) -> anyhow::Result<Option<Vec<u8>>> {
    room.state
        .generate_sync_message_recovering(rt_peer, "hosted-bridge-state-send")
        .map(|message| message.map(|m| m.encode()))
        .map_err(|e| anyhow::anyhow!("hosted bridge state sync generate: {e}"))
}

/// Apply an inbound cloud NotebookDoc sync frame to the room doc and produce
/// the reply, mirroring `peer_notebook_sync::apply_notebook_doc_frame` minus
/// actor validation (the hosted room already authorized these changes) and
/// minus persistence (hosted rooms are ephemeral in this slice).
async fn apply_cloud_notebook_sync(
    room: &Arc<NotebookRoom>,
    nb_peer: &mut sync::State,
    payload: &[u8],
) -> anyhow::Result<Option<Vec<u8>>> {
    let message = sync::Message::decode(payload)
        .map_err(|e| anyhow::anyhow!("decode hosted notebook sync: {e}"))?;

    let (changed, metadata_changed, reply) = {
        let mut doc = room.doc.write().await;
        let heads_before = doc.get_heads();
        doc.receive_sync_message_recovering(nb_peer, message, "hosted-bridge-doc-receive")
            .map_err(|e| anyhow::anyhow!("apply hosted notebook sync: {e}"))?;
        let heads_after = doc.get_heads();
        let changed = heads_before != heads_after;
        let metadata_changed =
            changed && diff_metadata_touched(doc.doc_mut(), &heads_before, &heads_after);
        if changed {
            let _ = room.broadcasts.changed_tx.send(());
        }
        let reply = doc
            .generate_sync_message_recovering(nb_peer, "hosted-bridge-doc-reply")
            .map_err(|e| anyhow::anyhow!("hosted bridge doc reply: {e}"))?
            .map(|m| m.encode());
        (changed, metadata_changed, reply)
    };

    if changed {
        if metadata_changed {
            check_and_broadcast_sync_state(room).await;
        }
        check_and_update_trust_state(room).await;
        process_markdown_assets(room).await;
    }

    Ok(reply)
}

/// Apply an inbound cloud RuntimeStateDoc sync frame. The cloud room is the
/// authority for runtime state on a bridged room, so changes are accepted
/// (`receive_sync_message_with_changes`), the opposite of the read-only-peer
/// stripping used for untrusted local clients.
fn apply_cloud_runtime_sync(
    room: &NotebookRoom,
    rt_peer: &mut sync::State,
    payload: &[u8],
) -> anyhow::Result<Option<Vec<u8>>> {
    let message = sync::Message::decode(payload)
        .map_err(|e| anyhow::anyhow!("decode hosted runtime sync: {e}"))?;
    room.state
        .with_doc(|state_doc| {
            state_doc.receive_sync_message_with_changes_recovering(
                rt_peer,
                message,
                "hosted-bridge-state-receive",
            )?;
            state_doc
                .generate_sync_message_recovering(rt_peer, "hosted-bridge-state-reply")
                .map(|m| m.map(|m| m.encode()))
                .map_err(Into::into)
        })
        .map_err(|e| anyhow::anyhow!("apply hosted runtime sync: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::{SinkExt, StreamExt};
    use notebook_cloud_transport::{CloudAuth, CloudWsConfig};
    use notebook_doc::{NotebookDoc, TextEncoding};
    use notebook_protocol::protocol::ExecutionIdRejectionReason;
    use runtime_doc::RuntimeStateDoc;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    use crate::blob_store::BlobStore;
    use crate::notebook_sync_server::{NotebookRoom, ReservationGuard, RoomConnectionIdentity};

    const CLOUD_PRINCIPAL: &str = "user:anaconda:kyle";
    const CLOUD_ROOM_ACTOR: &str = "user:anaconda:kyle/host:room:1";

    fn encode_ws_frame(frame_type: NotebookFrameType, payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(1 + payload.len());
        frame.push(frame_type as u8);
        frame.extend_from_slice(payload);
        frame
    }

    struct FakeCloudRoom {
        nb: NotebookDoc,
        rt: RuntimeStateDoc,
        nb_peer: sync::State,
        rt_peer: sync::State,
    }

    impl FakeCloudRoom {
        fn new() -> Self {
            Self::with_cells(&[("remote-1", "code", "print('from cloud')")])
        }

        fn with_cells(cells: &[(&str, &str, &str)]) -> Self {
            let mut nb = NotebookDoc::bootstrap(TextEncoding::UnicodeCodePoint, CLOUD_ROOM_ACTOR);
            for (index, (cell_id, cell_type, source)) in cells.iter().enumerate() {
                nb.add_cell(index, cell_id, cell_type).unwrap();
                nb.update_source(cell_id, source).unwrap();
            }
            let rt = RuntimeStateDoc::try_new_with_actor(CLOUD_ROOM_ACTOR).unwrap();
            Self {
                nb,
                rt,
                nb_peer: sync::State::new(),
                rt_peer: sync::State::new(),
            }
        }
    }

    /// Serve one fake hosted-room WebSocket connection: send
    /// `cloud_room_ready`, then act as the room-authoritative automerge peer
    /// for NotebookDoc + RuntimeStateDoc and answer `execute_cell` Request
    /// frames by creating a queued execution in the runtime doc.
    ///
    /// `observed` returns each cell id seen in the fake room's doc after
    /// every applied sync message; `frame_counter` counts inbound
    /// AutomergeSync frames (echo-storm probe).
    async fn serve_fake_cloud_room(
        listener: TcpListener,
        mut room: FakeCloudRoom,
        observed_cells: tokio::sync::watch::Sender<Vec<String>>,
        frame_counter: Arc<AtomicUsize>,
        request_counter: Arc<AtomicUsize>,
    ) {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();

        let ready = serde_json::to_vec(&serde_json::json!({
            "type": "cloud_room_ready",
            "actor_label": CLOUD_ROOM_ACTOR,
            "connection_scope": "editor",
        }))
        .unwrap();
        ws.send(Message::Binary(
            encode_ws_frame(NotebookFrameType::SessionControl, &ready).into(),
        ))
        .await
        .unwrap();

        // Kick initial sync for both docs, like the real room host.
        if let Some(m) = room.nb.generate_sync_message(&mut room.nb_peer) {
            ws.send(Message::Binary(
                encode_ws_frame(NotebookFrameType::AutomergeSync, &m.encode()).into(),
            ))
            .await
            .unwrap();
        }
        if let Some(m) = room.rt.generate_sync_message(&mut room.rt_peer) {
            ws.send(Message::Binary(
                encode_ws_frame(NotebookFrameType::RuntimeStateSync, &m.encode()).into(),
            ))
            .await
            .unwrap();
        }

        while let Some(Ok(msg)) = ws.next().await {
            let Message::Binary(data) = msg else { continue };
            let Some((&frame_type, payload)) = data.split_first() else {
                continue;
            };
            let mut replies: Vec<Vec<u8>> = Vec::new();
            if frame_type == NotebookFrameType::AutomergeSync as u8 {
                frame_counter.fetch_add(1, Ordering::SeqCst);
                let incoming = sync::Message::decode(payload).unwrap();
                room.nb
                    .receive_sync_message(&mut room.nb_peer, incoming)
                    .unwrap();
                let _ = observed_cells.send(room.nb.get_cell_ids());
                if let Some(m) = room.nb.generate_sync_message(&mut room.nb_peer) {
                    replies.push(encode_ws_frame(
                        NotebookFrameType::AutomergeSync,
                        &m.encode(),
                    ));
                }
            } else if frame_type == NotebookFrameType::RuntimeStateSync as u8 {
                let incoming = sync::Message::decode(payload).unwrap();
                room.rt
                    .receive_sync_message_with_changes(&mut room.rt_peer, incoming)
                    .unwrap();
                if let Some(m) = room.rt.generate_sync_message(&mut room.rt_peer) {
                    replies.push(encode_ws_frame(
                        NotebookFrameType::RuntimeStateSync,
                        &m.encode(),
                    ));
                }
            } else if frame_type == NotebookFrameType::Request as u8 {
                request_counter.fetch_add(1, Ordering::SeqCst);
                let request: serde_json::Value = serde_json::from_slice(payload).unwrap();
                match request.get("action").and_then(|v| v.as_str()) {
                    Some("execute_cell") | Some("execute_cell_guarded") => {
                        let cell_id = request
                            .get("cell_id")
                            .and_then(|v| v.as_str())
                            .unwrap()
                            .to_string();
                        let execution_id = request
                            .get("execution_id")
                            .and_then(|v| v.as_str())
                            .map(ToOwned::to_owned)
                            .unwrap_or_else(|| format!("exec-{cell_id}"));
                        room.rt.create_execution(&execution_id).unwrap();
                        if let Some(m) = room.rt.generate_sync_message(&mut room.rt_peer) {
                            replies.push(encode_ws_frame(
                                NotebookFrameType::RuntimeStateSync,
                                &m.encode(),
                            ));
                        }
                    }
                    Some("run_all_cells") | Some("run_all_cells_guarded") => {
                        let cell_execution_ids: HashMap<String, String> = serde_json::from_value(
                            request
                                .get("cell_execution_ids")
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!({})),
                        )
                        .unwrap();
                        for execution_id in cell_execution_ids.values() {
                            room.rt.create_execution(execution_id).unwrap();
                        }
                        if let Some(m) = room.rt.generate_sync_message(&mut room.rt_peer) {
                            replies.push(encode_ws_frame(
                                NotebookFrameType::RuntimeStateSync,
                                &m.encode(),
                            ));
                        }
                    }
                    Some("interrupt_execution") | Some("send_comm") => {
                        let accepted = serde_json::to_vec(&serde_json::json!({
                            "type": "cloud_frame_accepted",
                        }))
                        .unwrap();
                        replies.push(encode_ws_frame(
                            NotebookFrameType::SessionControl,
                            &accepted,
                        ));
                    }
                    action => panic!("unexpected fake room request action: {action:?}"),
                }
            }
            for reply in replies {
                ws.send(Message::Binary(reply.into())).await.unwrap();
            }
        }
    }

    fn test_room(tmp: &tempfile::TempDir) -> Arc<NotebookRoom> {
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            blob_store,
            true,
        ))
    }

    async fn start_bridge(
        room: &Arc<NotebookRoom>,
        addr: std::net::SocketAddr,
    ) -> Arc<HostedBridgeHandle> {
        start_bridge_with_options(room, addr, HostedBridgeOptions::default()).await
    }

    async fn start_bridge_with_options(
        room: &Arc<NotebookRoom>,
        addr: std::net::SocketAddr,
        options: HostedBridgeOptions,
    ) -> Arc<HostedBridgeHandle> {
        let transport = CloudWsFrameTransport::new(CloudWsConfig {
            cloud_url: format!("http://{addr}"),
            notebook_id: "hosted-test".to_string(),
            scope: "editor".to_string(),
            auth: CloudAuth::Dev {
                token: "dev-token".to_string(),
                user: "kyle".to_string(),
            },
            workstation: None,
        });
        let guard = ReservationGuard::new(room.clone());
        Arc::new(spawn_hosted_bridge(
            room.clone(),
            transport,
            "https://cloud.test/n/hosted-test".to_string(),
            "hosted-test".to_string(),
            guard,
            options,
        ))
    }

    async fn wait_until<F>(what: &str, mut check: F)
    where
        F: FnMut() -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>,
    {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if check().await {
                return;
            }
            if tokio::time::Instant::now() > deadline {
                panic!("timed out waiting for {what}");
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[tokio::test]
    async fn bridge_converges_both_directions_without_echo_storm() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (cells_tx, mut cells_rx) = tokio::sync::watch::channel(Vec::new());
        let frames = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let server = tokio::spawn(serve_fake_cloud_room(
            listener,
            FakeCloudRoom::new(),
            cells_tx,
            frames.clone(),
            requests,
        ));

        let tmp = tempfile::TempDir::new().unwrap();
        let room = test_room(&tmp);
        let bridge = start_bridge(&room, addr).await;

        let principal = bridge.wait_for_principal(Duration::from_secs(10)).await;
        assert_eq!(principal.as_deref(), Some(CLOUD_PRINCIPAL));

        // Cloud -> local: the fake room's seeded cell reaches the daemon room.
        let room_for_wait = room.clone();
        wait_until("cloud cell to reach the local room", move || {
            let room = room_for_wait.clone();
            Box::pin(async move {
                room.doc
                    .read()
                    .await
                    .get_cell_ids()
                    .contains(&"remote-1".to_string())
            })
        })
        .await;

        // Local -> cloud: a local edit converges to the fake room.
        {
            let mut doc = room.doc.write().await;
            doc.add_cell_after("local-1", "code", Some("remote-1"))
                .unwrap();
            doc.update_source("local-1", "x = 1").unwrap();
        }
        let _ = room.broadcasts.changed_tx.send(());

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if cells_rx.borrow().contains(&"local-1".to_string()) {
                break;
            }
            if tokio::time::Instant::now() > deadline {
                panic!("timed out waiting for local cell to reach the fake cloud room");
            }
            let _ = tokio::time::timeout(Duration::from_millis(100), cells_rx.changed()).await;
        }

        // Echo suppression: once converged, the exchange quiesces. Allow the
        // in-flight tail to settle, then assert no further NotebookDoc sync
        // frames arrive at the fake room.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let settled = frames.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            frames.load(Ordering::SeqCst),
            settled,
            "bridge kept exchanging NotebookDoc sync frames after convergence"
        );

        bridge.shutdown();
        server.abort();
    }

    #[tokio::test]
    async fn forwarded_execute_creates_cloud_execution_that_syncs_back() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (cells_tx, _cells_rx) = tokio::sync::watch::channel(Vec::new());
        let frames = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let server = tokio::spawn(serve_fake_cloud_room(
            listener,
            FakeCloudRoom::new(),
            cells_tx,
            frames,
            requests,
        ));

        let tmp = tempfile::TempDir::new().unwrap();
        let room = test_room(&tmp);
        let bridge = start_bridge(&room, addr).await;
        bridge
            .wait_for_principal(Duration::from_secs(10))
            .await
            .expect("bridge principal");

        bridge
            .forward_request(
                serde_json::to_vec(&serde_json::json!({
                    "action": "execute_cell",
                    "cell_id": "remote-1",
                }))
                .unwrap(),
            )
            .unwrap();

        // The cloud room creates the execution; it converges back into the
        // bridged room's RuntimeStateDoc.
        let room_for_wait = room.clone();
        wait_until("cloud execution to reach the local room", move || {
            let room = room_for_wait.clone();
            Box::pin(async move {
                room.state
                    .read(|sd| sd.read_state().executions.contains_key("exec-remote-1"))
                    .unwrap_or(false)
            })
        })
        .await;

        bridge.shutdown();
        server.abort();
    }

    #[tokio::test]
    async fn idle_on_idle_fires() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let tmp = tempfile::TempDir::new().unwrap();
        let room = test_room(&tmp);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let bridge = start_bridge_with_options(
            &room,
            addr,
            HostedBridgeOptions {
                idle_after: Duration::from_millis(200),
                on_idle: Some(Arc::new(move || {
                    let _ = tx.send(());
                })),
            },
        )
        .await;

        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("idle signal timed out")
            .expect("idle signal channel closed");

        bridge.shutdown();
    }

    #[tokio::test]
    async fn idle_on_idle_does_not_fire_while_peer_attached() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let tmp = tempfile::TempDir::new().unwrap();
        let room = test_room(&tmp);
        room.connections
            .active_peers
            .fetch_add(1, Ordering::Relaxed);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let bridge = start_bridge_with_options(
            &room,
            addr,
            HostedBridgeOptions {
                idle_after: Duration::from_millis(200),
                on_idle: Some(Arc::new(move || {
                    let _ = tx.send(());
                })),
            },
        )
        .await;

        assert!(
            tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .is_err(),
            "idle signal fired while a peer was attached"
        );

        bridge.shutdown();
        room.connections
            .active_peers
            .fetch_sub(1, Ordering::Relaxed);
    }

    #[tokio::test]
    async fn idle_on_idle_fires_once_per_idle_span() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let tmp = tempfile::TempDir::new().unwrap();
        let room = test_room(&tmp);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let bridge = start_bridge_with_options(
            &room,
            addr,
            HostedBridgeOptions {
                idle_after: Duration::from_millis(200),
                on_idle: Some(Arc::new(move || {
                    let _ = tx.send(());
                })),
            },
        )
        .await;

        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("first idle signal timed out")
            .expect("idle signal channel closed");
        assert!(
            tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .is_err(),
            "idle signal fired more than once in one idle span"
        );

        bridge.shutdown();
    }

    fn test_daemon(tmp: &tempfile::TempDir) -> Arc<crate::daemon::Daemon> {
        #[cfg(windows)]
        let socket_path = {
            let unique = tmp.path().file_name().unwrap_or_default().to_string_lossy();
            std::path::PathBuf::from(format!(r"\\.\pipe\runtimed-hosted-bridge-{unique}"))
        };
        #[cfg(not(windows))]
        let socket_path = tmp.path().join("hosted-bridge-test.sock");

        crate::daemon::Daemon::new_for_test(crate::daemon::DaemonConfig {
            socket_path,
            cache_dir: tmp.path().join("envs"),
            blob_store_dir: tmp.path().join("daemon-blobs"),
            execution_store_dir: tmp.path().join("executions"),
            notebook_docs_dir: tmp.path().join("daemon-notebook-docs"),
            trusted_packages_db_path: tmp.path().join("trusted-packages.sqlite"),
            notebook_registry_db_path: tmp.path().join("notebook-registry.sqlite"),
            uv_pool_size: 0,
            conda_pool_size: 0,
            max_age_secs: 3600,
            lock_dir: Some(tmp.path().to_path_buf()),
            use_preferred_blob_port: false,
            settings_json_path: Some(tmp.path().join("settings.json")),
            ..Default::default()
        })
        .unwrap()
    }

    async fn register_bridge(
        daemon: &Arc<crate::daemon::Daemon>,
        bridge: &Arc<HostedBridgeHandle>,
    ) {
        daemon
            .hosted_bridges
            .lock()
            .await
            .insert(bridge.locator.clone(), bridge.clone());
    }

    #[tokio::test]
    async fn hosted_execute_request_returns_cell_queued_and_syncs_back() {
        use crate::protocol::{NotebookRequest, NotebookResponse};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (cells_tx, _cells_rx) = tokio::sync::watch::channel(Vec::new());
        let frames = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let server = tokio::spawn(serve_fake_cloud_room(
            listener,
            FakeCloudRoom::new(),
            cells_tx,
            frames,
            requests.clone(),
        ));

        let tmp = tempfile::TempDir::new().unwrap();
        let room = test_room(&tmp);
        let bridge = start_bridge(&room, addr).await;
        bridge
            .wait_for_principal(Duration::from_secs(10))
            .await
            .expect("bridge principal");
        let daemon = test_daemon(&tmp);
        register_bridge(&daemon, &bridge).await;

        // Daemon-minted execution id: response is CellQueued with a UUID, and
        // the cloud room creates exactly that execution.
        let response = crate::requests::handle_notebook_request(
            &room,
            NotebookRequest::ExecuteCell {
                cell_id: "remote-1".to_string(),
                execution_id: None,
            },
            daemon.clone(),
            None,
        )
        .await;
        let NotebookResponse::CellQueued {
            cell_id,
            execution_id,
        } = response
        else {
            panic!("expected CellQueued, got {response:?}");
        };
        assert_eq!(cell_id, "remote-1");
        uuid::Uuid::parse_str(&execution_id).expect("minted execution id is a UUID");
        let room_for_wait = room.clone();
        let expected = execution_id.clone();
        wait_until("minted execution to sync back from the cloud", move || {
            let room = room_for_wait.clone();
            let expected = expected.clone();
            Box::pin(async move {
                room.state
                    .read(|sd| sd.read_state().executions.contains_key(&expected))
                    .unwrap_or(false)
            })
        })
        .await;

        // Caller-supplied valid id is echoed back verbatim.
        let supplied = uuid::Uuid::new_v4().to_string();
        let response = crate::requests::handle_notebook_request(
            &room,
            NotebookRequest::ExecuteCell {
                cell_id: "remote-1".to_string(),
                execution_id: Some(supplied.clone()),
            },
            daemon.clone(),
            None,
        )
        .await;
        match response {
            NotebookResponse::CellQueued { execution_id, .. } => {
                assert_eq!(execution_id, supplied);
            }
            other => panic!("expected CellQueued, got {other:?}"),
        }

        // The supplied-id forward is async; let it land before sampling the
        // request counter for the negative assertion below.
        let requests_for_wait = requests.clone();
        wait_until("supplied-id execute to reach the cloud room", move || {
            let requests = requests_for_wait.clone();
            Box::pin(async move { requests.load(Ordering::SeqCst) >= 2 })
        })
        .await;

        // Malformed id is rejected locally without contacting the cloud room.
        let requests_before = requests.load(Ordering::SeqCst);
        let response = crate::requests::handle_notebook_request(
            &room,
            NotebookRequest::ExecuteCell {
                cell_id: "remote-1".to_string(),
                execution_id: Some("not-a-uuid".to_string()),
            },
            daemon.clone(),
            None,
        )
        .await;
        match response {
            NotebookResponse::ExecutionIdRejected { reason, .. } => {
                assert_eq!(reason, ExecutionIdRejectionReason::Malformed);
            }
            other => panic!("expected ExecutionIdRejected, got {other:?}"),
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            requests.load(Ordering::SeqCst),
            requests_before,
            "malformed execution id must not reach the cloud room"
        );

        bridge.shutdown();
        server.abort();
    }

    #[tokio::test]
    async fn hosted_run_all_request_queues_exactly_the_code_cells() {
        use crate::protocol::{NotebookRequest, NotebookResponse};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (cells_tx, _cells_rx) = tokio::sync::watch::channel(Vec::new());
        let frames = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let server = tokio::spawn(serve_fake_cloud_room(
            listener,
            FakeCloudRoom::with_cells(&[
                ("c1", "code", "x = 1"),
                ("m1", "markdown", "# heading"),
                ("c2", "code", "y = 2"),
            ]),
            cells_tx,
            frames,
            requests.clone(),
        ));

        let tmp = tempfile::TempDir::new().unwrap();
        let room = test_room(&tmp);
        let bridge = start_bridge(&room, addr).await;
        bridge
            .wait_for_principal(Duration::from_secs(10))
            .await
            .expect("bridge principal");
        let daemon = test_daemon(&tmp);
        register_bridge(&daemon, &bridge).await;

        // The run-all handler reads code cells from the bridged room doc, so
        // the cloud content must have converged first.
        let room_for_wait = room.clone();
        wait_until("cloud cells to reach the local room", move || {
            let room = room_for_wait.clone();
            Box::pin(async move {
                let ids = room.doc.read().await.get_cell_ids();
                ids.contains(&"c1".to_string()) && ids.contains(&"c2".to_string())
            })
        })
        .await;

        let response = crate::requests::handle_notebook_request(
            &room,
            NotebookRequest::RunAllCells {
                cell_execution_ids: None,
            },
            daemon.clone(),
            None,
        )
        .await;
        let NotebookResponse::AllCellsQueued { queued } = response else {
            panic!("expected AllCellsQueued, got {response:?}");
        };
        let queued_cells: Vec<&str> = queued.iter().map(|e| e.cell_id.as_str()).collect();
        assert_eq!(
            queued_cells,
            vec!["c1", "c2"],
            "exactly the code cells, in document order"
        );
        for entry in &queued {
            uuid::Uuid::parse_str(&entry.execution_id).expect("minted execution id is a UUID");
        }

        let expected: Vec<String> = queued.iter().map(|e| e.execution_id.clone()).collect();
        let room_for_wait = room.clone();
        wait_until("run-all executions to sync back", move || {
            let room = room_for_wait.clone();
            let expected = expected.clone();
            Box::pin(async move {
                room.state
                    .read(|sd| {
                        let state = sd.read_state();
                        expected.iter().all(|id| state.executions.contains_key(id))
                    })
                    .unwrap_or(false)
            })
        })
        .await;

        bridge.shutdown();
        server.abort();
    }

    #[tokio::test]
    async fn hosted_interrupt_request_forwards_and_acks() {
        use crate::protocol::{NotebookRequest, NotebookResponse};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (cells_tx, _cells_rx) = tokio::sync::watch::channel(Vec::new());
        let frames = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let server = tokio::spawn(serve_fake_cloud_room(
            listener,
            FakeCloudRoom::new(),
            cells_tx,
            frames,
            requests.clone(),
        ));

        let tmp = tempfile::TempDir::new().unwrap();
        let room = test_room(&tmp);
        let bridge = start_bridge(&room, addr).await;
        bridge
            .wait_for_principal(Duration::from_secs(10))
            .await
            .expect("bridge principal");
        let daemon = test_daemon(&tmp);
        register_bridge(&daemon, &bridge).await;

        let response = crate::requests::handle_notebook_request(
            &room,
            NotebookRequest::InterruptExecution {},
            daemon.clone(),
            None,
        )
        .await;
        assert!(
            matches!(response, NotebookResponse::InterruptSent {}),
            "expected InterruptSent, got {response:?}"
        );
        let requests_for_wait = requests.clone();
        wait_until("interrupt request to reach the cloud room", move || {
            let requests = requests_for_wait.clone();
            Box::pin(async move { requests.load(Ordering::SeqCst) >= 1 })
        })
        .await;

        bridge.shutdown();
        server.abort();
    }

    #[tokio::test]
    async fn hosted_bridged_identity_authors_under_cloud_principal() {
        let identity = RoomConnectionIdentity::hosted_bridged(
            CLOUD_PRINCIPAL,
            Some("desktop:win1".to_string()),
            nteract_identity::ConnectionScope::Editor,
        )
        .unwrap();

        let label = identity.actor_label().as_str().to_string();
        assert!(
            label.starts_with("user:anaconda:kyle/desktop:win1"),
            "actor label {label} should be <cloud principal>/<operator>"
        );

        // Changes authored under the cloud principal pass validation.
        identity
            .validate_actor_labels(["user:anaconda:kyle/desktop:win2"])
            .unwrap();
        // The local-Unix principal is rejected: it would be dropped by the
        // hosted room's actor authorization.
        assert!(identity
            .validate_actor_labels(["local:kyle/desktop:win1"])
            .is_err());
        // Operator-only legacy labels are rejected on bridged rooms.
        assert!(identity.validate_actor_labels(["desktop:win1"]).is_err());
    }
}
