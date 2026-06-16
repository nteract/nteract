//! Connection handshake and sync-task bootstrap.
//!
//! All connect variants use [`NotebookDoc::bootstrap()`] to create the
//! initial local document.  This seeds the doc with the standard notebook
//! skeleton (`schema_version`, empty `cells` map, `metadata`) so that
//! `Automerge::is_empty()` returns false **before** the first sync
//! message arrives.  Without this, `load_incremental`'s empty-doc
//! fast-path replaces `*self` with a freshly-loaded doc, discarding any
//! encoding or actor settings.
//!
//! Establishes a connection to the runtimed daemon, performs the protocol
//! handshake, bootstraps empty local docs, and then hands post-handshake
//! socket ownership to the background sync task.
//!
//! Platform-specific stream creation (Unix socket or Windows named pipe)
//! is handled internally. The handshake and sync logic is generic over
//! `AsyncRead + AsyncWrite`.

use automerge::sync;
use automerge::AutoCommit;
use log::{debug, info};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, watch};

use notebook_protocol::connection::{
    self, ConnectionBootstrap, FrameSink, FrameSource, Handshake, NotebookConnectionInfo,
    ProtocolCapabilities, PROTOCOL_V4,
};
use notebook_protocol::protocol::NotebookBroadcast;

use crate::error::SyncError;
use crate::handle::DocHandle;
use crate::relay::RelayHandle;
use crate::relay_task;
use crate::shared::SharedDocState;
use crate::snapshot::NotebookSnapshot;
use crate::status::SyncStatus;
use crate::sync_task;

/// Result of connecting to a notebook room.
pub struct ConnectResult {
    /// Handle for document mutations and reads.
    pub handle: DocHandle,

    /// Receiver for kernel/execution broadcasts from the daemon.
    pub broadcast_rx: crate::BroadcastReceiver,

    /// Initial metadata string (legacy format, for handshake compat).
    pub initial_metadata: Option<String>,
}

/// Result of connecting to an existing notebook file.
pub struct OpenResult {
    /// Handle for document mutations and reads.
    pub handle: DocHandle,

    /// Receiver for kernel/execution broadcasts from the daemon.
    pub broadcast_rx: crate::BroadcastReceiver,

    /// Connection info from the daemon (notebook_id, trust status, etc).
    pub info: NotebookConnectionInfo,
}

/// Result of creating a new notebook.
pub struct CreateResult {
    /// Handle for document mutations and reads.
    pub handle: DocHandle,

    /// Receiver for kernel/execution broadcasts from the daemon.
    pub broadcast_rx: crate::BroadcastReceiver,

    /// Connection info from the daemon (notebook_id, trust status, etc).
    pub info: NotebookConnectionInfo,
}

/// Result of opening a notebook as a relay (no local document).
pub struct RelayOpenResult {
    /// Handle for forwarding frames and sending requests.
    pub handle: RelayHandle,

    /// Connection info from the daemon (notebook_id, trust status, etc).
    pub info: NotebookConnectionInfo,
}

/// Result of creating a notebook as a relay (no local document).
pub struct RelayCreateResult {
    /// Handle for forwarding frames and sending requests.
    pub handle: RelayHandle,

    /// Connection info from the daemon (notebook_id, trust status, etc).
    pub info: NotebookConnectionInfo,
}

/// Platform-specific helper macro to connect to the daemon socket.
///
/// On Unix: `tokio::net::UnixStream::connect`
/// On Windows: `tokio::net::windows::named_pipe::ClientOptions::new().open`
macro_rules! connect_stream {
    ($socket_path:expr) => {{
        let path = $socket_path;
        let result = {
            #[cfg(unix)]
            {
                tokio::net::UnixStream::connect(path).await
            }
            #[cfg(windows)]
            {
                notebook_protocol::connection::connect_named_pipe_client(
                    path,
                    std::time::Duration::from_secs(2),
                )
                .await
            }
        };
        match result {
            Ok(stream) => stream,
            Err(e) => {
                let path_display = path.display();
                return Err(match e.kind() {
                    std::io::ErrorKind::NotFound => SyncError::DaemonUnavailable {
                        message: format!(
                            "Daemon is not running. Endpoint not found at {path_display}."
                        ),
                        source: e,
                    },
                    std::io::ErrorKind::ConnectionRefused => SyncError::DaemonUnavailable {
                        message: format!(
                            "Daemon connection refused at {path_display}. \
                             The daemon may have crashed or is restarting."
                        ),
                        source: e,
                    },
                    std::io::ErrorKind::PermissionDenied => SyncError::DaemonUnavailable {
                        message: format!(
                            "Permission denied connecting to daemon at {path_display}. \
                             Check file permissions."
                        ),
                        source: e,
                    },
                    _ => SyncError::Io(e),
                });
            }
        }
    }};
}

// =========================================================================
// Public connect functions
// =========================================================================

/// Connect to a notebook room by ID.
///
/// Performs the protocol handshake, spawns the background sync task, and
/// returns a `DocHandle` plus a broadcast receiver for kernel events.
///
/// `actor_label` sets the Automerge actor identity **before** initial sync
/// so that even the bootstrap operations are attributed to the caller
/// (e.g., `"local:kyle/desktop:window"`,
/// `"user:anaconda:alice/agent:claude:s1"`).
pub async fn connect(
    socket_path: PathBuf,
    notebook_id: String,
    actor_label: &str,
) -> Result<ConnectResult, SyncError> {
    connect_with_options(socket_path, notebook_id, None, None, actor_label).await
}

/// Connect to a notebook room with options.
pub async fn connect_with_options(
    socket_path: PathBuf,
    notebook_id: String,
    working_dir: Option<PathBuf>,
    initial_metadata: Option<String>,
    actor_label: &str,
) -> Result<ConnectResult, SyncError> {
    let stream = connect_stream!(&socket_path);
    let (reader, writer) = tokio::io::split(stream);
    let mut reader = tokio::io::BufReader::new(reader);
    let mut writer = tokio::io::BufWriter::new(writer);

    // Send preamble
    connection::send_preamble(&mut writer).await?;

    // Send handshake
    let handshake = Handshake::NotebookSync {
        notebook_id: notebook_id.clone(),
        protocol: Some(PROTOCOL_V4.to_string()),
        typed_bootstrap: Some(true),
        working_dir: working_dir.map(|p| p.to_string_lossy().to_string()),
        initial_metadata: initial_metadata.clone(),
        operator: operator_from_actor_label(actor_label),
    };
    connection::send_json_frame(&mut writer, &handshake)
        .await
        .map_err(|e| SyncError::Protocol(format!("Send handshake: {}", e)))?;

    // Receive protocol capabilities. New daemons respond with a typed
    // SessionControl bootstrap; old daemons ignore typed_bootstrap and send the
    // legacy untyped JSON frame.
    let caps = recv_typed_capabilities(&mut reader).await?;
    check_daemon_protocol_version(&caps);

    // Start from the standard notebook skeleton so the background sync task
    // owns the entire bootstrap from the first post-handshake frame onward.
    let bootstrap = notebook_doc::NotebookDoc::bootstrap(
        notebook_doc::TextEncoding::UnicodeCodePoint,
        caps.actor_label.as_deref().unwrap_or(actor_label),
    );
    let doc = bootstrap.into_inner();
    let peer_state = sync::State::new();

    // Build the shared state and channels
    build_and_spawn(
        doc,
        peer_state,
        notebook_id,
        caps.comments_doc_id.clone(),
        reader,
        writer,
    )
    .await
    .map(|(handle, broadcast_rx)| ConnectResult {
        handle,
        broadcast_rx,
        initial_metadata,
    })
}

/// Connect and open an existing notebook file.
pub async fn connect_open(
    socket_path: PathBuf,
    path: PathBuf,
    actor_label: &str,
) -> Result<OpenResult, SyncError> {
    let stream = connect_stream!(&socket_path);
    let (reader, writer) = tokio::io::split(stream);
    let mut reader = tokio::io::BufReader::new(reader);
    let mut writer = tokio::io::BufWriter::new(writer);

    // Send preamble
    connection::send_preamble(&mut writer).await?;

    // Send open handshake
    let handshake = Handshake::OpenNotebook {
        path: path.to_string_lossy().to_string(),
        typed_bootstrap: Some(true),
        operator: operator_from_actor_label(actor_label),
    };
    connection::send_json_frame(&mut writer, &handshake)
        .await
        .map_err(|e| SyncError::Protocol(format!("Send handshake: {}", e)))?;

    // Receive connection info. New daemons respond with a typed SessionControl
    // bootstrap; old daemons ignore typed_bootstrap and send the legacy untyped
    // JSON frame.
    let info = recv_typed_connection_info(&mut reader).await?;

    if let Some(ref error) = info.error {
        return Err(SyncError::Protocol(error.clone()));
    }

    let notebook_id = info.notebook_id.clone();

    let bootstrap = notebook_doc::NotebookDoc::bootstrap(
        notebook_doc::TextEncoding::UnicodeCodePoint,
        info.capabilities
            .actor_label
            .as_deref()
            .unwrap_or(actor_label),
    );
    let doc = bootstrap.into_inner();
    let peer_state = sync::State::new();

    build_and_spawn(
        doc,
        peer_state,
        notebook_id,
        info.capabilities.comments_doc_id.clone(),
        reader,
        writer,
    )
    .await
    .map(|(handle, broadcast_rx)| OpenResult {
        handle,
        broadcast_rx,
        info,
    })
}

/// Connect and create a new notebook.
///
/// The daemon creates an empty notebook room with one code cell and
/// returns connection info with a generated UUID as the notebook_id.
#[allow(clippy::too_many_arguments)]
pub async fn connect_create(
    socket_path: PathBuf,
    runtime: &str,
    working_dir: Option<PathBuf>,
    actor_label: &str,
    ephemeral: bool,
    package_manager: Option<notebook_protocol::connection::PackageManager>,
    dependencies: Vec<String>,
) -> Result<CreateResult, SyncError> {
    connect_create_with_environment_mode(
        socket_path,
        runtime,
        working_dir,
        actor_label,
        ephemeral,
        package_manager,
        dependencies,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn connect_create_with_environment_mode(
    socket_path: PathBuf,
    runtime: &str,
    working_dir: Option<PathBuf>,
    actor_label: &str,
    ephemeral: bool,
    package_manager: Option<notebook_protocol::connection::PackageManager>,
    dependencies: Vec<String>,
    environment_mode: Option<notebook_protocol::connection::CreateNotebookEnvironmentMode>,
) -> Result<CreateResult, SyncError> {
    connect_create_inner(
        socket_path,
        runtime,
        working_dir,
        None,
        actor_label,
        ephemeral,
        package_manager,
        dependencies,
        environment_mode,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn connect_create_inner(
    socket_path: PathBuf,
    runtime: &str,
    working_dir: Option<PathBuf>,
    notebook_id: Option<String>,
    actor_label: &str,
    ephemeral: bool,
    package_manager: Option<notebook_protocol::connection::PackageManager>,
    dependencies: Vec<String>,
    environment_mode: Option<notebook_protocol::connection::CreateNotebookEnvironmentMode>,
) -> Result<CreateResult, SyncError> {
    let stream = connect_stream!(&socket_path);
    let (reader, writer) = tokio::io::split(stream);
    let mut reader = tokio::io::BufReader::new(reader);
    let mut writer = tokio::io::BufWriter::new(writer);

    // Send preamble
    connection::send_preamble(&mut writer).await?;

    // Send create handshake
    let handshake = Handshake::CreateNotebook {
        runtime: runtime.to_string(),
        working_dir: working_dir
            .as_ref()
            .map(|p| p.to_string_lossy().to_string()),
        notebook_id,
        ephemeral: if ephemeral { Some(true) } else { None },
        package_manager,
        environment_mode,
        dependencies,
        typed_bootstrap: Some(true),
        operator: operator_from_actor_label(actor_label),
    };
    connection::send_json_frame(&mut writer, &handshake)
        .await
        .map_err(|e| SyncError::Protocol(format!("Send handshake: {}", e)))?;

    // Receive connection info. New daemons respond with a typed SessionControl
    // bootstrap; old daemons ignore typed_bootstrap and send the legacy untyped
    // JSON frame.
    let info = recv_typed_connection_info(&mut reader).await?;

    if let Some(ref error) = info.error {
        return Err(SyncError::Protocol(error.clone()));
    }

    let notebook_id = info.notebook_id.clone();

    let bootstrap = notebook_doc::NotebookDoc::bootstrap(
        notebook_doc::TextEncoding::UnicodeCodePoint,
        info.capabilities
            .actor_label
            .as_deref()
            .unwrap_or(actor_label),
    );
    let doc = bootstrap.into_inner();
    let peer_state = sync::State::new();

    build_and_spawn(
        doc,
        peer_state,
        notebook_id,
        info.capabilities.comments_doc_id.clone(),
        reader,
        writer,
    )
    .await
    .map(|(handle, broadcast_rx)| CreateResult {
        handle,
        broadcast_rx,
        info,
    })
}

/// Connect to a notebook room over already-authenticated typed-frame halves.
///
/// This is the hosted-room bootstrap path. The transport-specific dial,
/// credential exchange, and room-ready handshake happen before this function
/// is called; this function only creates the local document replicas and
/// starts the normal sync task over the supplied typed-frame source/sink.
pub async fn connect_frame_io<S, W>(
    notebook_id: String,
    actor_label: &str,
    source: S,
    sink: W,
) -> Result<ConnectResult, SyncError>
where
    S: FrameSource + Send + 'static,
    W: FrameSink + Send + 'static,
{
    let bootstrap = notebook_doc::NotebookDoc::bootstrap(
        notebook_doc::TextEncoding::UnicodeCodePoint,
        actor_label,
    );
    let doc = bootstrap.into_inner();
    let peer_state = sync::State::new();

    build_and_spawn_frame_io(doc, peer_state, notebook_id, None, source, sink)
        .await
        .map(|(handle, broadcast_rx)| ConnectResult {
            handle,
            broadcast_rx,
            initial_metadata: None,
        })
}

// =========================================================================
// Internal helpers
// =========================================================================

/// Build the shared state, channels, and spawn the sync task.
///
/// This is the common setup after handshake + initial sync, shared by
/// all connect variants.
async fn build_and_spawn<R, W>(
    doc: AutoCommit,
    peer_state: sync::State,
    notebook_id: String,
    comments_doc_id: Option<String>,
    reader: R,
    writer: W,
) -> Result<(DocHandle, crate::BroadcastReceiver), SyncError>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (handle, task_config, broadcast_rx) =
        build_sync_task_state(doc, peer_state, notebook_id.clone(), comments_doc_id)?;

    let notebook_id_for_task = notebook_id;
    tokio::spawn(async move {
        info!(
            "[notebook-sync] Sync task started for {}",
            notebook_id_for_task
        );
        sync_task::run(task_config, reader, writer).await;
        info!(
            "[notebook-sync] Sync task stopped for {}",
            notebook_id_for_task
        );
    });

    Ok((handle, broadcast_rx.into()))
}

async fn build_and_spawn_frame_io<S, W>(
    doc: AutoCommit,
    peer_state: sync::State,
    notebook_id: String,
    comments_doc_id: Option<String>,
    source: S,
    sink: W,
) -> Result<(DocHandle, crate::BroadcastReceiver), SyncError>
where
    S: FrameSource + Send + 'static,
    W: FrameSink + Send + 'static,
{
    let (handle, task_config, broadcast_rx) =
        build_sync_task_state(doc, peer_state, notebook_id.clone(), comments_doc_id)?;

    let notebook_id_for_task = notebook_id;
    tokio::spawn(async move {
        info!(
            "[notebook-sync] Frame sync task started for {}",
            notebook_id_for_task
        );
        sync_task::run_with_frame_io(task_config, source, sink).await;
        info!(
            "[notebook-sync] Frame sync task stopped for {}",
            notebook_id_for_task
        );
    });

    Ok((handle, broadcast_rx.into()))
}

fn build_sync_task_state(
    doc: AutoCommit,
    peer_state: sync::State,
    notebook_id: String,
    comments_doc_id: Option<String>,
) -> Result<
    (
        DocHandle,
        sync_task::SyncTaskConfig,
        tokio::sync::broadcast::Receiver<NotebookBroadcast>,
    ),
    SyncError,
> {
    let mut shared_state =
        SharedDocState::try_new_with_comments_doc_id(doc, notebook_id.clone(), comments_doc_id)?;
    shared_state.peer_state = peer_state;

    let shared = Arc::new(Mutex::new(shared_state));

    let initial_snapshot = {
        let state = shared.lock().map_err(|_| SyncError::LockPoisoned)?;
        NotebookSnapshot::from_doc(&state.doc)
    };
    let initial_runtime_state = {
        let state = shared.lock().map_err(|_| SyncError::LockPoisoned)?;
        state.state_doc.read_state()
    };

    let (snapshot_tx, snapshot_rx) = watch::channel(initial_snapshot);
    let snapshot_tx = Arc::new(snapshot_tx);
    let (runtime_state_tx, runtime_state_rx) = watch::channel(initial_runtime_state);
    let (status_tx, status_rx) = watch::channel(SyncStatus::connected_pending());
    let (changed_tx, changed_rx) = mpsc::unbounded_channel();
    let (cmd_tx, cmd_rx) = mpsc::channel::<sync_task::SyncCommand>(32);
    let (broadcast_tx, broadcast_rx) = tokio::sync::broadcast::channel::<NotebookBroadcast>(64);

    let handle = DocHandle::new(
        Arc::clone(&shared),
        changed_tx,
        cmd_tx,
        Arc::clone(&snapshot_tx),
        snapshot_rx,
        runtime_state_rx,
        status_rx,
        notebook_id,
    );

    let task_config = sync_task::SyncTaskConfig {
        doc: Arc::clone(&shared),
        changed_rx,
        cmd_rx,
        snapshot_tx: Arc::clone(&snapshot_tx),
        runtime_state_tx,
        status_tx,
        broadcast_tx,
    };

    Ok((handle, task_config, broadcast_rx))
}

// =========================================================================
// Relay connect functions — no initial sync, no local doc
// =========================================================================

/// Open a notebook as a relay — transparent byte pipe, no local document.
///
/// Performs the handshake only (preamble + OpenNotebook + receive info).
/// Does not perform any bootstrap sync on the client side — the daemon's
/// initial sync and session-status frames stay in the socket buffer and get
/// piped to the frontend by the relay task. The frontend (WASM) owns the
/// sync protocol.
///
/// This eliminates the 100ms convergence floor and wasted doc allocation
/// that the full-peer `connect_open` incurs.
pub async fn connect_open_relay(
    socket_path: PathBuf,
    path: PathBuf,
    frame_tx: mpsc::UnboundedSender<Vec<u8>>,
) -> Result<RelayOpenResult, SyncError> {
    connect_open_relay_with_operator(socket_path, path, frame_tx, None).await
}

/// Open a notebook as a relay with a self-declared operator label.
pub async fn connect_open_relay_with_operator(
    socket_path: PathBuf,
    path: PathBuf,
    frame_tx: mpsc::UnboundedSender<Vec<u8>>,
    operator: Option<String>,
) -> Result<RelayOpenResult, SyncError> {
    let stream = connect_stream!(&socket_path);
    let (reader, writer) = tokio::io::split(stream);
    let mut reader = tokio::io::BufReader::new(reader);
    let mut writer = tokio::io::BufWriter::new(writer);

    // Send preamble
    connection::send_preamble(&mut writer).await?;

    // Send open handshake
    let handshake = Handshake::OpenNotebook {
        path: path.to_string_lossy().to_string(),
        typed_bootstrap: Some(true),
        operator,
    };
    connection::send_json_frame(&mut writer, &handshake)
        .await
        .map_err(|e| SyncError::Protocol(format!("Send handshake: {}", e)))?;

    let info = recv_typed_connection_info(&mut reader).await?;

    if let Some(ref error) = info.error {
        return Err(SyncError::Protocol(error.clone()));
    }

    let notebook_id = info.notebook_id.clone();
    info!(
        "[relay] Connected to {} (relay mode, no initial sync)",
        notebook_id
    );

    let handle = spawn_relay(notebook_id, frame_tx, reader, writer);

    Ok(RelayOpenResult { handle, info })
}

/// Create a notebook as a relay — transparent byte pipe, no local document.
///
/// Same as `connect_open_relay` but for new notebooks. Performs the
/// CreateNotebook handshake, then immediately starts piping.
#[allow(clippy::too_many_arguments)]
pub async fn connect_create_relay(
    socket_path: PathBuf,
    runtime: &str,
    working_dir: Option<PathBuf>,
    notebook_id: Option<String>,
    frame_tx: mpsc::UnboundedSender<Vec<u8>>,
    ephemeral: bool,
    package_manager: Option<notebook_protocol::connection::PackageManager>,
    dependencies: Vec<String>,
    environment_mode: Option<notebook_protocol::connection::CreateNotebookEnvironmentMode>,
) -> Result<RelayCreateResult, SyncError> {
    connect_create_relay_with_operator(
        socket_path,
        runtime,
        working_dir,
        notebook_id,
        frame_tx,
        ephemeral,
        package_manager,
        dependencies,
        environment_mode,
        None,
    )
    .await
}

/// Create a notebook as a relay with a self-declared operator label.
#[allow(clippy::too_many_arguments)]
pub async fn connect_create_relay_with_operator(
    socket_path: PathBuf,
    runtime: &str,
    working_dir: Option<PathBuf>,
    notebook_id: Option<String>,
    frame_tx: mpsc::UnboundedSender<Vec<u8>>,
    ephemeral: bool,
    package_manager: Option<notebook_protocol::connection::PackageManager>,
    dependencies: Vec<String>,
    environment_mode: Option<notebook_protocol::connection::CreateNotebookEnvironmentMode>,
    operator: Option<String>,
) -> Result<RelayCreateResult, SyncError> {
    let stream = connect_stream!(&socket_path);
    let (reader, writer) = tokio::io::split(stream);
    let mut reader = tokio::io::BufReader::new(reader);
    let mut writer = tokio::io::BufWriter::new(writer);

    // Send preamble
    connection::send_preamble(&mut writer).await?;

    // Send create handshake
    let handshake = Handshake::CreateNotebook {
        runtime: runtime.to_string(),
        working_dir: working_dir
            .as_ref()
            .map(|p| p.to_string_lossy().to_string()),
        notebook_id,
        ephemeral: if ephemeral { Some(true) } else { None },
        package_manager,
        environment_mode,
        dependencies,
        typed_bootstrap: Some(true),
        operator,
    };
    connection::send_json_frame(&mut writer, &handshake)
        .await
        .map_err(|e| SyncError::Protocol(format!("Send handshake: {}", e)))?;

    let info = recv_typed_connection_info(&mut reader).await?;

    if let Some(ref error) = info.error {
        return Err(SyncError::Protocol(error.clone()));
    }

    let notebook_id = info.notebook_id.clone();
    info!(
        "[relay] Created {} (relay mode, no initial sync)",
        notebook_id
    );

    let handle = spawn_relay(notebook_id, frame_tx, reader, writer);

    Ok(RelayCreateResult { handle, info })
}

/// Connect to a notebook room by ID as a relay — no local document.
///
/// Same as `connect_open_relay` but for connecting to an existing room
/// by notebook ID rather than file path. Used by integration tests.
pub async fn connect_relay(
    socket_path: PathBuf,
    notebook_id: String,
    frame_tx: mpsc::UnboundedSender<Vec<u8>>,
) -> Result<RelayConnectResult, SyncError> {
    connect_relay_with_operator(socket_path, notebook_id, frame_tx, None).await
}

/// Connect to a notebook room by ID as a relay with a self-declared operator label.
pub async fn connect_relay_with_operator(
    socket_path: PathBuf,
    notebook_id: String,
    frame_tx: mpsc::UnboundedSender<Vec<u8>>,
    operator: Option<String>,
) -> Result<RelayConnectResult, SyncError> {
    let stream = connect_stream!(&socket_path);
    let (reader, writer) = tokio::io::split(stream);
    let mut reader = tokio::io::BufReader::new(reader);
    let mut writer = tokio::io::BufWriter::new(writer);

    // Send preamble
    connection::send_preamble(&mut writer).await?;

    // Send notebook sync handshake
    let handshake = Handshake::NotebookSync {
        notebook_id: notebook_id.clone(),
        protocol: Some(PROTOCOL_V4.to_string()),
        typed_bootstrap: Some(true),
        initial_metadata: None,
        working_dir: None,
        operator,
    };
    connection::send_json_frame(&mut writer, &handshake)
        .await
        .map_err(|e| SyncError::Protocol(format!("Send handshake: {}", e)))?;

    let caps = recv_typed_capabilities(&mut reader).await?;
    check_daemon_protocol_version(&caps);

    info!(
        "[relay] Connected to {} (relay mode, no initial sync)",
        notebook_id
    );

    let handle = spawn_relay(notebook_id, frame_tx, reader, writer);

    Ok(RelayConnectResult {
        handle,
        capabilities: caps,
    })
}

/// Result of connecting to a notebook room by ID as a relay.
pub struct RelayConnectResult {
    /// Handle for forwarding frames and sending requests.
    pub handle: RelayHandle,

    /// Protocol capabilities returned by the daemon.
    pub capabilities: ProtocolCapabilities,
}

fn operator_from_actor_label(actor_label: &str) -> Option<String> {
    match actor_label.split_once('/') {
        Some((_, operator)) if !operator.is_empty() => Some(operator.to_string()),
        None if !actor_label.is_empty() => Some(actor_label.to_string()),
        _ => None,
    }
}

/// Spawn a relay task and return the handle.
///
/// Common tail for `connect_open_relay` and `connect_create_relay`.
fn spawn_relay<R, W>(
    notebook_id: String,
    frame_tx: mpsc::UnboundedSender<Vec<u8>>,
    reader: R,
    writer: W,
) -> RelayHandle
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (cmd_tx, cmd_rx) = mpsc::channel::<crate::relay::RelayCommand>(32);

    let handle = RelayHandle::new(cmd_tx, notebook_id.clone());

    let task_config = relay_task::RelayTaskConfig {
        cmd_rx,
        frame_tx,
        notebook_id: notebook_id.clone(),
    };

    tokio::spawn(async move {
        relay_task::run(task_config, reader, writer).await;
    });

    handle
}

async fn recv_typed_connection_info<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<NotebookConnectionInfo, SyncError> {
    let frame = recv_bootstrap_frame(reader).await?;
    if is_typed_bootstrap_frame(&frame) {
        match parse_typed_bootstrap_payload(&frame[1..])? {
            ConnectionBootstrap::NotebookConnectionInfo { info } => Ok(info),
            ConnectionBootstrap::ProtocolCapabilities { .. } => Err(SyncError::Protocol(
                "Expected notebook connection info, got protocol capabilities".into(),
            )),
        }
    } else {
        serde_json::from_slice(&frame)
            .map_err(|e| SyncError::Protocol(format!("Parse connection info: {}", e)))
    }
}

async fn recv_typed_capabilities<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<ProtocolCapabilities, SyncError> {
    let frame = recv_bootstrap_frame(reader).await?;
    if is_typed_bootstrap_frame(&frame) {
        match parse_typed_bootstrap_payload(&frame[1..])? {
            ConnectionBootstrap::ProtocolCapabilities { capabilities } => Ok(capabilities),
            ConnectionBootstrap::NotebookConnectionInfo { info } => Ok(info.capabilities),
        }
    } else {
        serde_json::from_slice(&frame)
            .map_err(|e| SyncError::Protocol(format!("Parse capabilities: {}", e)))
    }
}

async fn recv_bootstrap_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, SyncError> {
    connection::recv_frame(reader)
        .await?
        .ok_or_else(|| SyncError::Protocol("Connection closed during handshake".into()))
}

fn is_typed_bootstrap_frame(frame: &[u8]) -> bool {
    frame.first().copied() == Some(connection::NotebookFrameType::SessionControl as u8)
}

fn parse_typed_bootstrap_payload(payload: &[u8]) -> Result<ConnectionBootstrap, SyncError> {
    serde_json::from_slice(payload)
        .map_err(|e| SyncError::Protocol(format!("Parse typed bootstrap: {}", e)))
}

/// Log version info from a daemon's `ProtocolCapabilities` response.
///
/// Warns on protocol version mismatch but does not error — the preamble
/// already hard-rejects incompatible protocol versions, so any connection
/// that gets this far has a matching wire format. This check surfaces
/// version differences for debugging (e.g., a daemon rebuilt from a
/// different commit).
fn check_daemon_protocol_version(caps: &ProtocolCapabilities) {
    let expected = u32::from(notebook_protocol::connection::PROTOCOL_VERSION);

    if let Some(remote) = caps.protocol_version {
        if remote != expected {
            log::warn!(
                "[notebook-sync] Daemon protocol version ({}) differs from client ({}). \
                 This connection may behave unexpectedly.",
                remote,
                expected,
            );
        }
    }

    if let Some(ref ver) = caps.daemon_version {
        debug!("[notebook-sync] Connected to daemon version {}", ver);
    }
}

#[cfg(test)]
mod bootstrap_tests {
    use super::*;

    #[tokio::test]
    async fn recv_typed_capabilities_accepts_legacy_json_frame() {
        let expected = ProtocolCapabilities::v4(Some("2.5.2+old".into()))
            .with_identity("local:kyle/desktop:legacy", "owner");
        let mut buf = Vec::new();
        connection::send_json_frame(&mut buf, &expected)
            .await
            .unwrap();

        let mut reader = std::io::Cursor::new(buf);
        let actual = recv_typed_capabilities(&mut reader).await.unwrap();

        assert_eq!(actual.protocol, expected.protocol);
        assert_eq!(
            actual.actor_label.as_deref(),
            Some("local:kyle/desktop:legacy")
        );
    }

    #[tokio::test]
    async fn recv_typed_connection_info_accepts_session_control_bootstrap() {
        let expected = NotebookConnectionInfo {
            capabilities: ProtocolCapabilities::v4(Some("2.5.2+new".into()))
                .with_identity("local:kyle/desktop:typed", "owner"),
            notebook_id: "550e8400-e29b-41d4-a716-446655440000".into(),
            cell_count: 3,
            needs_trust_approval: false,
            error: None,
            ephemeral: true,
            notebook_path: None,
        };
        let mut buf = Vec::new();
        connection::send_typed_bootstrap_frame(
            &mut buf,
            &ConnectionBootstrap::notebook_connection_info(expected.clone()),
        )
        .await
        .unwrap();

        let mut reader = std::io::Cursor::new(buf);
        let actual = recv_typed_connection_info(&mut reader).await.unwrap();

        assert_eq!(actual.notebook_id, expected.notebook_id);
        assert_eq!(actual.cell_count, expected.cell_count);
        assert_eq!(
            actual.capabilities.actor_label.as_deref(),
            Some("local:kyle/desktop:typed")
        );
    }
}
