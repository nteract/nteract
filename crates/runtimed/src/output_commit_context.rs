//! Shared dependencies for output committer workers.
//!
//! The runtime has three output workers (ordinary outputs, stream flushes, and
//! display updates). Keep their shared dependencies grouped so adding a cloud
//! capability such as remote blob publishing does not widen every committer
//! constructor.

use std::sync::Arc;

use runtime_doc::RuntimeStateHandle;
use tokio::sync::mpsc;

use crate::blob_store::BlobStore;
use crate::output_blob_publisher::OutputBlobPublisher;
use crate::output_prep::LifecycleSignal;
use crate::output_redaction::OutputRedactor;

#[derive(Clone)]
pub(crate) struct OutputCommitContext {
    pub(crate) state: RuntimeStateHandle,
    pub(crate) blob_store: Arc<BlobStore>,
    pub(crate) blob_publisher: OutputBlobPublisher,
    pub(crate) kernel_actor_id: String,
    pub(crate) kernel_id: String,
    pub(crate) lifecycle_tx: mpsc::UnboundedSender<LifecycleSignal>,
    pub(crate) redactor: Arc<OutputRedactor>,
}

impl OutputCommitContext {
    pub(crate) fn new(
        state: RuntimeStateHandle,
        blob_store: Arc<BlobStore>,
        blob_publisher: OutputBlobPublisher,
        kernel_actor_id: String,
        kernel_id: String,
        lifecycle_tx: mpsc::UnboundedSender<LifecycleSignal>,
        redactor: Arc<OutputRedactor>,
    ) -> Self {
        Self {
            state,
            blob_store,
            blob_publisher,
            kernel_actor_id,
            kernel_id,
            lifecycle_tx,
            redactor,
        }
    }
}
