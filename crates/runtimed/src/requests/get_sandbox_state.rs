//! Handler for `GetSandboxState {}` notebook request.
//!
//! Returns the live sandbox state for the room's current kernel session,
//! read from the `sandbox_state_cache` field on `NotebookRoom`. The cache is
//! set by `launch_kernel.rs` when the runtime agent reports the kernel is up
//! (with the full `SandboxStateInfo` returned from `JupyterKernel::launch`),
//! and reset to `Disabled` on `ShutdownKernel`.
//!
//! This is a read-only query — it does not modify any state.

use std::sync::Arc;

use crate::notebook_sync_server::NotebookRoom;
use crate::protocol::NotebookResponse;

/// Handle the `GetSandboxState {}` request.
///
/// Returns the cached `SandboxStateInfo`. The cache defaults to `Disabled`
/// and is updated when a kernel launches or is shut down.
pub(crate) async fn handle(room: &Arc<NotebookRoom>) -> NotebookResponse {
    let state = room.sandbox_state_cache.read().await.clone();
    NotebookResponse::SandboxState { state }
}
