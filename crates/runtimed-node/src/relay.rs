//! Raw typed-frame relay bindings for embedding the browser notebook frontend.
//!
//! The browser/WASM frontend remains the Automerge peer. This module only
//! exposes `notebook_sync::RelayHandle` to Node: the native relay owns the
//! daemon socket, handshake, framing, and liveness heartbeat while JavaScript
//! forwards opaque typed frames to and from its browser transport.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::sync::mpsc;

use notebook_protocol::connection::{NotebookConnectionInfo, ProtocolCapabilities};
use notebook_sync::RelayHandle;

use crate::error::to_napi_err;
use crate::session::{
    spawn_event_task, CreateNotebookEnvironmentMode, EventSubscription, PackageManager,
};

type FrameCallback =
    ThreadsafeFunction<Vec<u8>, (), FnArgs<(Buffer,)>, napi::Status, false, false, 0>;
type CloseCallback = ThreadsafeFunction<(), (), (), napi::Status, false, false, 0>;

#[napi(object)]
#[derive(Default)]
pub struct CreateRelayOptions {
    /// Runtime type. Defaults to `"python"`.
    pub runtime: Option<String>,
    /// Kernel working directory.
    pub working_dir: Option<String>,
    /// Override the daemon endpoint.
    pub socket_path: Option<String>,
    /// Restore or join an untitled notebook room by ID.
    pub notebook_id: Option<String>,
    /// Actor/operator label advertised during the handshake.
    pub peer_label: Option<String>,
    /// Human-readable fallback for `peerLabel`.
    pub description: Option<String>,
    /// Keep the notebook only in memory. Defaults to false.
    pub ephemeral: Option<bool>,
    /// Dependencies to seed into notebook metadata.
    pub dependencies: Option<Vec<String>>,
    /// Package manager preference for seeded dependencies.
    pub package_manager: Option<PackageManager>,
    /// Project/notebook environment inheritance mode.
    pub environment_mode: Option<CreateNotebookEnvironmentMode>,
}

#[napi(object)]
#[derive(Default)]
pub struct OpenRelayOptions {
    /// Override the daemon endpoint.
    pub socket_path: Option<String>,
    /// Actor/operator label advertised during the handshake.
    pub peer_label: Option<String>,
    /// Human-readable fallback for `peerLabel`.
    pub description: Option<String>,
}

#[napi(object)]
#[derive(Default)]
pub struct QueryDaemonOptions {
    /// Override the daemon endpoint.
    pub socket_path: Option<String>,
}

/// Daemon metadata needed by a Node host before it opens a notebook relay.
#[napi(object)]
pub struct DaemonInfo {
    pub version: String,
    pub socket_path: String,
    pub is_dev_mode: bool,
    pub blob_port: Option<u32>,
}

/// Bootstrap and daemon metadata needed by a browser host.
#[napi(object)]
#[derive(Clone)]
pub struct RelayInfo {
    pub notebook_id: String,
    pub cell_count: Option<u32>,
    pub needs_trust_approval: Option<bool>,
    pub ephemeral: Option<bool>,
    pub notebook_path: Option<String>,
    pub runtime: Option<String>,
    pub actor_label: Option<String>,
    pub connection_scope: Option<String>,
    pub comments_doc_id: Option<String>,
    /// JSON encoding of the daemon-authoritative notebook reference.
    pub comments_notebook_ref_json: Option<String>,
    pub protocol: String,
    pub protocol_version: Option<u32>,
    pub daemon_version: Option<String>,
    pub socket_path: String,
    pub blob_port: Option<u32>,
    pub is_dev_mode: bool,
}

struct RelayState {
    handle: Option<RelayHandle>,
}

/// A native byte pipe between a Node host and one daemon notebook room.
#[napi]
pub struct NativeRelaySession {
    info: RelayInfo,
    state: Arc<Mutex<RelayState>>,
    frame_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<Vec<u8>>>>>,
}

#[napi]
impl NativeRelaySession {
    #[napi(getter)]
    pub fn notebook_id(&self) -> String {
        self.info.notebook_id.clone()
    }

    #[napi(getter)]
    pub fn info(&self) -> RelayInfo {
        self.info.clone()
    }

    #[napi(getter)]
    pub fn closed(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.handle.is_none())
            .unwrap_or(true)
    }

    /// Forward one complete typed frame (`type byte | payload`) to the daemon.
    #[napi]
    pub async fn send(&self, frame: Buffer) -> Result<()> {
        if frame.is_empty() {
            return Err(Error::from_reason("relay frame must include a type byte"));
        }
        let handle = {
            let state = self
                .state
                .lock()
                .map_err(|_| Error::from_reason("Relay state poisoned"))?;
            state
                .handle
                .as_ref()
                .ok_or_else(|| Error::from_reason("Relay is closed"))?
                .clone()
        };
        handle
            .forward_frame(frame[0], frame[1..].to_vec())
            .await
            .map_err(to_napi_err)
    }

    /// Subscribe once to lossless inbound typed frames and relay closure.
    ///
    /// The receiver is single-consumer by design: one browser transport owns a
    /// daemon connection. The returned subscription must stay alive for the
    /// lifetime of the bridge.
    #[napi]
    pub fn subscribe_frames(
        &self,
        on_frame: Function<'_, (Buffer,), ()>,
        on_close: Function<'_, (), ()>,
    ) -> Result<EventSubscription> {
        let mut rx = self
            .frame_rx
            .lock()
            .map_err(|_| Error::from_reason("Relay frame receiver poisoned"))?
            .take()
            .ok_or_else(|| Error::from_reason("Relay frames already subscribed"))?;
        let frame_callback = frame_callback(on_frame)?;
        let close_callback = close_callback(on_close)?;
        let task = spawn_event_task(async move {
            while let Some(frame) = rx.recv().await {
                // Await the JavaScript callback before dequeuing the next frame.
                // This preserves ordering and prevents a busy browser peer from
                // creating a second unbounded queue inside N-API.
                if frame_callback.call_async(frame).await.is_err() {
                    break;
                }
            }
            let _ = close_callback.call((), ThreadsafeFunctionCallMode::NonBlocking);
        });
        Ok(EventSubscription::new(task))
    }

    /// Close the native relay. Idempotent.
    #[napi]
    pub fn close(&self) -> Result<()> {
        let handle = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| Error::from_reason("Relay state poisoned"))?;
            state.handle.take()
        };
        drop(handle);
        Ok(())
    }
}

/// Create a notebook room and return its native typed-frame relay.
#[napi]
pub async fn create_relay(options: Option<CreateRelayOptions>) -> Result<NativeRelaySession> {
    let opts = options.unwrap_or_default();
    let runtime = opts.runtime.unwrap_or_else(|| "python".to_string());
    let socket_path = resolve_socket_path(opts.socket_path);
    let (frame_tx, frame_rx) = mpsc::unbounded_channel();
    let result = notebook_sync::connect::connect_create_relay(
        socket_path.clone(),
        notebook_sync::connect::CreateNotebookSpec {
            working_dir: opts.working_dir.map(PathBuf::from),
            notebook_id: opts.notebook_id,
            actor_label: peer_label_or_description(opts.peer_label, opts.description),
            ephemeral: opts.ephemeral.unwrap_or(false),
            dependencies: opts.dependencies.unwrap_or_default(),
            package_manager: opts.package_manager.map(Into::into),
            environment_mode: opts.environment_mode.map(Into::into),
            ..notebook_sync::connect::CreateNotebookSpec::new(runtime.as_str())
        },
        frame_tx,
    )
    .await
    .map_err(to_napi_err)?;

    relay_session(
        result.handle,
        frame_rx,
        result.info,
        Some(runtime),
        socket_path,
    )
    .await
}

/// Open a notebook file and return its native typed-frame relay.
#[napi]
pub async fn open_relay_path(
    path: String,
    options: Option<OpenRelayOptions>,
) -> Result<NativeRelaySession> {
    let opts = options.unwrap_or_default();
    let socket_path = resolve_socket_path(opts.socket_path);
    let (frame_tx, frame_rx) = mpsc::unbounded_channel();
    let result = notebook_sync::connect::connect_open_relay_with_operator(
        socket_path.clone(),
        PathBuf::from(path),
        frame_tx,
        operator(opts.peer_label, opts.description),
    )
    .await
    .map_err(to_napi_err)?;

    relay_session(result.handle, frame_rx, result.info, None, socket_path).await
}

/// Join an active notebook room by ID and return its native typed-frame relay.
///
/// The daemon treats this API as an operator connection. Embedding hosts must
/// authorize the requested notebook ID before calling it and must not expose
/// room discovery or this relay directly to an untrusted browser context.
#[napi]
pub async fn connect_relay(
    notebook_id: String,
    options: Option<OpenRelayOptions>,
) -> Result<NativeRelaySession> {
    let opts = options.unwrap_or_default();
    let socket_path = resolve_socket_path(opts.socket_path);
    let (frame_tx, frame_rx) = mpsc::unbounded_channel();
    let result = notebook_sync::connect::connect_relay_with_operator(
        socket_path.clone(),
        notebook_id.clone(),
        frame_tx,
        operator(opts.peer_label, opts.description),
    )
    .await
    .map_err(to_napi_err)?;
    let daemon = runtimed_client::singleton::query_daemon_info(socket_path.clone()).await;
    let info =
        relay_info_from_capabilities(notebook_id, result.capabilities, None, socket_path, daemon);
    Ok(NativeRelaySession::new(result.handle, frame_rx, info))
}

/// Probe the selected daemon and return its host-facing metadata when ready.
///
/// `None` intentionally covers both an absent endpoint and a daemon that has
/// bound its socket but is not ready to answer pool requests yet. Hosts can
/// poll this function while supervising a cold start without cloning the wire
/// protocol in JavaScript.
#[napi]
pub async fn query_daemon_info(options: Option<QueryDaemonOptions>) -> Result<Option<DaemonInfo>> {
    let socket_path = resolve_socket_path(options.and_then(|options| options.socket_path));
    Ok(
        runtimed_client::singleton::query_daemon_info(socket_path.clone())
            .await
            .map(|info| DaemonInfo {
                version: info.version,
                socket_path: socket_path.to_string_lossy().into_owned(),
                is_dev_mode: info.worktree_path.is_some(),
                blob_port: info.blob_port.map(u32::from),
            }),
    )
}

impl NativeRelaySession {
    fn new(
        handle: RelayHandle,
        frame_rx: mpsc::UnboundedReceiver<Vec<u8>>,
        info: RelayInfo,
    ) -> Self {
        Self {
            info,
            state: Arc::new(Mutex::new(RelayState {
                handle: Some(handle),
            })),
            frame_rx: Arc::new(Mutex::new(Some(frame_rx))),
        }
    }
}

async fn relay_session(
    handle: RelayHandle,
    frame_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    connection: NotebookConnectionInfo,
    runtime: Option<String>,
    socket_path: PathBuf,
) -> Result<NativeRelaySession> {
    let daemon = runtimed_client::singleton::query_daemon_info(socket_path.clone()).await;
    let info = relay_info_from_connection(connection, runtime, socket_path, daemon);
    Ok(NativeRelaySession::new(handle, frame_rx, info))
}

fn relay_info_from_connection(
    connection: NotebookConnectionInfo,
    runtime: Option<String>,
    socket_path: PathBuf,
    daemon: Option<runtimed_client::singleton::DaemonInfo>,
) -> RelayInfo {
    let NotebookConnectionInfo {
        capabilities,
        notebook_id,
        cell_count,
        needs_trust_approval,
        ephemeral,
        notebook_path,
        ..
    } = connection;
    relay_info_from_capabilities(
        notebook_id,
        capabilities,
        Some((
            u32::try_from(cell_count).unwrap_or(u32::MAX),
            needs_trust_approval,
            ephemeral,
            notebook_path,
        )),
        socket_path,
        daemon,
    )
    .with_runtime(runtime)
}

fn relay_info_from_capabilities(
    notebook_id: String,
    capabilities: ProtocolCapabilities,
    notebook: Option<(u32, bool, bool, Option<String>)>,
    socket_path: PathBuf,
    daemon: Option<runtimed_client::singleton::DaemonInfo>,
) -> RelayInfo {
    let (cell_count, needs_trust_approval, ephemeral, notebook_path) = match notebook {
        Some((cell_count, needs_trust_approval, ephemeral, notebook_path)) => (
            Some(cell_count),
            Some(needs_trust_approval),
            Some(ephemeral),
            notebook_path,
        ),
        None => (None, None, None, None),
    };
    let comments_notebook_ref_json = capabilities
        .comments_notebook_ref
        .as_ref()
        .and_then(|value| serde_json::to_string(value).ok());
    RelayInfo {
        notebook_id,
        cell_count,
        needs_trust_approval,
        ephemeral,
        notebook_path,
        runtime: None,
        actor_label: capabilities.actor_label,
        connection_scope: capabilities.connection_scope,
        comments_doc_id: capabilities.comments_doc_id,
        comments_notebook_ref_json,
        protocol: capabilities.protocol,
        protocol_version: capabilities.protocol_version,
        // Older compatible handshakes may omit the daemon version; the pool
        // metadata query fills that diagnostic field when available.
        daemon_version: capabilities
            .daemon_version
            .or_else(|| daemon.as_ref().map(|info| info.version.clone())),
        socket_path: socket_path.to_string_lossy().into_owned(),
        blob_port: daemon
            .as_ref()
            .and_then(|info| info.blob_port)
            .map(u32::from),
        is_dev_mode: daemon
            .as_ref()
            .is_some_and(|info| info.worktree_path.is_some()),
    }
}

impl RelayInfo {
    fn with_runtime(mut self, runtime: Option<String>) -> Self {
        self.runtime = runtime;
        self
    }
}

fn resolve_socket_path(override_path: Option<String>) -> PathBuf {
    override_path
        .map(PathBuf::from)
        .unwrap_or_else(runt_workspace::default_socket_path)
}

fn peer_label_or_description(peer_label: Option<String>, description: Option<String>) -> String {
    peer_label.or(description).unwrap_or_default()
}

fn operator(peer_label: Option<String>, description: Option<String>) -> Option<String> {
    let value = peer_label_or_description(peer_label, description);
    match value.split_once('/') {
        Some((_, operator)) if !operator.is_empty() => Some(operator.to_string()),
        None if !value.is_empty() => Some(value),
        _ => None,
    }
}

fn frame_callback(callback: Function<'_, (Buffer,), ()>) -> Result<FrameCallback> {
    callback
        .build_threadsafe_function::<Vec<u8>>()
        .callee_handled::<false>()
        .build_callback(|ctx| Ok(FnArgs::from((Buffer::from(ctx.value),))))
}

fn close_callback(callback: Function<'_, (), ()>) -> Result<CloseCallback> {
    callback
        .build_threadsafe_function::<()>()
        .callee_handled::<false>()
        .build_callback(|_| Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operator_prefers_peer_label_then_description() {
        assert_eq!(
            operator(Some("host/window".into()), Some("description".into())),
            Some("window".into())
        );
        assert_eq!(
            operator(None, Some("embedded notebook".into())),
            Some("embedded notebook".into())
        );
        assert_eq!(operator(None, None), None);
    }
}
