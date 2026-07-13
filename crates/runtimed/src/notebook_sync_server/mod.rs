//! Room-based notebook synchronization server.
//!
//! Each open notebook gets a "room" in the daemon. Multiple windows editing
//! the same notebook sync through the room's canonical Automerge document.
//!
//! Follows the same sync protocol pattern as `sync_server.rs` (settings sync)
//! but with per-notebook state managed through rooms.
//!
//! ## Room lifecycle
//!
//! 1. First window opens notebook -> daemon creates room, loads persisted doc
//! 2. Client exchanges Automerge sync messages with the room
//! 3. Additional windows join the same room
//! 4. Changes from any peer broadcast to all others in the room
//! 5. When the last peer disconnects, the room is evicted from memory
//!    (any pending doc bytes are flushed to disk via debounced persistence)
//! 6. Documents persist to `~/.cache/runt/notebook-docs/{hash}.automerge`
//!
//! ## Daemon-owned kernel execution
//!
//! Each room can have an optional kernel. When a kernel is launched:
//! - Execute requests flow through the daemon
//! - Daemon tracks msg_id -> cell_id mapping
//! - Outputs are broadcast to all connected windows
//! - Multiple windows share the same kernel

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use automerge::sync;
use notify_debouncer_mini::DebounceEventResult;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex, RwLock};
use tracing::{debug, error, info, warn};

use crate::blob_store::BlobStore;
use crate::markdown_assets::{extract_markdown_asset_refs, resolve_markdown_assets};
use crate::output_prep::{DenoLaunchedConfig, LaunchedEnvConfig};
use crate::paths::notebook_doc_filename;
use crate::protocol::{EnvSyncDiff, NotebookBroadcast, NotebookResponse};
use crate::task_supervisor::{spawn_best_effort, spawn_supervised};
use notebook_doc::metadata::NotebookMetadataSnapshot;
use notebook_doc::presence::{self, PresenceState};
use notebook_doc::{AttachmentEncoding, AttachmentRef, CellSnapshot, NotebookDoc};
use notebook_protocol::connection::{self, NotebookFrameType};
use runtime_doc::RuntimeStateDoc;

mod attachments;
mod blob_upload;
mod catalog;
mod comments_store;
// The coordinator is wired into room mutation paths after the standalone
// journal and checkpoint primitives.
#[allow(dead_code)]
pub(crate) mod durability;
// The checkpoint primitive intentionally lands before persistence integration.
#[allow(dead_code)]
pub(crate) mod file_checkpoint;
mod hosted_bridge;
mod identity;
mod load;
mod metadata;
mod nbformat_convert;
mod path_index;
mod peer_comments_sync;
mod peer_comms_sync;
mod peer_connection;
mod peer_eviction;
mod peer_loop;
mod peer_notebook_sync;
mod peer_pool_sync;
mod peer_presence;
mod peer_runtime_agent;
mod peer_runtime_sync;
mod peer_session;
mod peer_writer;
mod persist;
mod project_context;
mod projection;
// The journal primitive intentionally lands before room integration.
#[allow(dead_code)]
pub(crate) mod recovery;
mod registry;
mod room;
mod runtime_bridge;
#[cfg(test)]
mod tests;
mod workstation_attachment;

pub(crate) use attachments::*;
pub(crate) use catalog::*;
pub use hosted_bridge::HostedBridgeHandle;
pub(crate) use hosted_bridge::*;
pub(crate) use identity::*;
pub(crate) use load::*;
pub(crate) use metadata::*;
pub(crate) use nbformat_convert::*;
pub(crate) use peer_connection::*;
#[cfg(test)]
pub(crate) use peer_presence::sanitize_peer_label;
pub(crate) use peer_runtime_agent::handle_runtime_agent_sync_connection;
pub(crate) use peer_runtime_sync::notebook_execution_context_id;
pub(crate) use persist::*;
pub(crate) use projection::*;
pub(crate) use registry::*;
pub(crate) use room::*;
pub(crate) use runtime_bridge::*;
pub(crate) use workstation_attachment::*;

/// Global shutdown trigger registered by the daemon at startup.
///
/// Used by `spawn_supervised` callbacks in debouncers (autosave, persist) that
/// don't have `Arc<Daemon>` in scope. The daemon calls `register_shutdown_trigger`
/// once; on_panic handlers call `trigger_global_shutdown` to signal data-loss risk.
static SHUTDOWN_TRIGGER: std::sync::OnceLock<Arc<dyn Fn() + Send + Sync>> =
    std::sync::OnceLock::new();

pub fn register_shutdown_trigger(trigger: Arc<dyn Fn() + Send + Sync>) {
    let _ = SHUTDOWN_TRIGGER.set(trigger);
}

fn trigger_global_shutdown() {
    if let Some(trigger) = SHUTDOWN_TRIGGER.get() {
        (trigger)();
    }
}

/// Capacity for the per-room kernel broadcast channel. Sized to absorb bursts
/// of output messages (e.g. fast-printing cells) so slower peers trigger a
/// full doc sync ("peer lagged") rather than losing messages.
const KERNEL_BROADCAST_CAPACITY: usize = 256;

/// Compaction threshold for RuntimeStateDoc initial sync messages.
/// If the encoded message exceeds this, compact before sending. Leaves
/// 20 MiB headroom under the 100 MiB frame limit.
const STATE_SYNC_COMPACT_THRESHOLD: usize = 80 * 1024 * 1024;

/// A message sent through the runtime agent channel.
pub enum RuntimeAgentMessage {
    /// Fire-and-forget command - no response expected.
    Command(notebook_protocol::protocol::RuntimeAgentRequestEnvelope),
    /// Query requiring a sync response via correlation ID.
    Query(
        notebook_protocol::protocol::RuntimeAgentRequestEnvelope,
        tokio::sync::oneshot::Sender<notebook_protocol::protocol::RuntimeAgentResponse>,
    ),
}

/// Sender half of the runtime agent channel.
type RuntimeAgentRequestSender = tokio::sync::mpsc::Sender<RuntimeAgentMessage>;

fn runtime_agent_query_timeout(
    request: &notebook_protocol::protocol::RuntimeAgentRequest,
) -> std::time::Duration {
    use notebook_protocol::protocol::RuntimeAgentRequest;
    match request {
        RuntimeAgentRequest::Complete { .. } | RuntimeAgentRequest::GetHistory { .. } => {
            std::time::Duration::from_secs(10)
        }
        RuntimeAgentRequest::LaunchKernel { .. }
        | RuntimeAgentRequest::RestartKernel { .. }
        | RuntimeAgentRequest::SyncEnvironment(_) => std::time::Duration::from_secs(240),
        _ => std::time::Duration::from_secs(30),
    }
}
