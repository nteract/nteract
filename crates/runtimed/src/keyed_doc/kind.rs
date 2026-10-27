//! The room-side contract a keyed document kind implements.

use std::collections::BTreeSet;
use std::sync::Arc;

use automerge::AutoCommit;
use futures::future::BoxFuture;
use notebook_protocol::connection::NotebookFrameType;
use notebook_protocol::protocol::NotebookBroadcast;
use notebook_wire::FrameSizeLimits;
use runtime_doc::{
    default_write_permission, KeyedDocRecord, KeyedDocRejection, KeyedWriteContext,
    KeyedWritePermission, RuntimeStateDoc, RuntimeStateHandle, RuntimeStateWriteScope,
};

use super::hub::KeyedDocHub;
use crate::blob_store::BlobStore;

/// One keyed document kind, instantiated once per room so it can hold
/// room-side state.
///
/// The hub calls `write_permission`, `validate_peer_changes`,
/// `referenced_blobs` and `on_runtime_change` while holding its document
/// lock; those must not touch `RuntimeStateHandle` or the hub, or they invert
/// the lock order. `kind`, `frame_limits`, `record`, `room_blob_roots`,
/// `observe_runtime_broadcast` and `on_runtime_agent_lost` run without it.
pub(crate) trait KeyedDocKind: Send + Sync + 'static {
    /// Wire name, `[a-z0-9_]{1,64}`.
    fn kind(&self) -> &'static str;

    /// Per-kind body limits, checked after the header is parsed. The outer
    /// `KeyedDocSync` frame cap is the ceiling.
    fn frame_limits(&self) -> FrameSizeLimits {
        notebook_wire::typed_frame_size_limits(NotebookFrameType::KeyedDocSync)
    }

    /// The record that admits `id`; `None` means the room does not know it.
    fn record(&self, state: &RuntimeStateDoc, id: &str) -> Option<KeyedDocRecord>;

    fn write_permission(
        &self,
        scope: RuntimeStateWriteScope,
        record: Option<&KeyedDocRecord>,
    ) -> Result<KeyedWritePermission, KeyedDocRejection> {
        default_write_permission(self.kind(), scope, record)
    }

    /// Content rules for one peer message, called only for `Validated`
    /// writers after the actor check. `before` is the hub replica before the
    /// message; `changes` are every change the message adds. Any error
    /// rejects the whole message.
    fn validate_peer_changes(
        &self,
        before: &AutoCommit,
        changes: &[automerge::Change],
        ctx: &KeyedWriteContext,
    ) -> Result<(), KeyedDocRejection>;

    /// Blob hashes the document references (GC roots).
    fn referenced_blobs(&self, _doc: &AutoCommit) -> BTreeSet<String> {
        BTreeSet::new()
    }

    /// Blob hashes held by room-side kind state.
    fn room_blob_roots(&self) -> BTreeSet<String> {
        BTreeSet::new()
    }

    /// Every runtime-agent broadcast, after validation, before fan-out.
    fn observe_runtime_broadcast(&self, _broadcast: &NotebookBroadcast) {}

    /// A runtime-agent frame changed `id`; `doc` is the hub replica after it.
    fn on_runtime_change(&self, _id: &str, _epoch: u64, _doc: &AutoCommit) {}

    /// RuntimeStateDoc changed. `ids` are the kind's replicas in the hub;
    /// returns those the hub should drop, after the kind dropped its own
    /// state for them. Runs inside `RuntimeStateHandle::read`.
    fn on_runtime_state_change(&self, _state: &RuntimeStateDoc, _ids: &[String]) -> Vec<String> {
        Vec::new()
    }

    /// The current runtime agent disconnected. Freeze or terminalize whatever
    /// the kind owns. Runs without the hub lock.
    fn on_runtime_agent_lost<'a>(&'a self, _ctx: RoomKindCtx<'a>) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}

pub(crate) struct RoomKindCtx<'a> {
    pub state: &'a RuntimeStateHandle,
    pub blob_store: &'a Arc<BlobStore>,
    pub hub: &'a KeyedDocHub,
}
