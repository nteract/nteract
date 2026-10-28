//! Frame `0x0b KeyedDocSync` routing for notebook peers. The room's
//! `KeyedDocHub` owns the replicas and the ingress checks.

use notebook_protocol::connection::NotebookFrameType;
use notebook_wire::KeyedDocKey;
use tokio::sync::broadcast;
use tracing::debug;

use super::peer_writer::PeerWriter;
use super::{NotebookRoom, RoomConnectionIdentity};
use crate::keyed_doc::KeyedSyncStates;

pub(super) fn handle_keyed_doc_frame(
    room: &NotebookRoom,
    states: &mut KeyedSyncStates,
    writer: &PeerWriter,
    payload: &[u8],
    connection_identity: &RoomConnectionIdentity,
) -> anyhow::Result<()> {
    let reply =
        room.keyed_docs
            .receive_peer_frame(states, payload, connection_identity, &room.state);
    // Same ordered lane as the frames, so the peer drops its replica before
    // the fresh sync arrives.
    if let Some(resync) = reply.resync {
        writer.send_json(NotebookFrameType::SessionControl, &resync)?;
    }
    for frame in reply.frames {
        writer.send_frame(NotebookFrameType::KeyedDocSync, frame)?;
    }
    Ok(())
}

/// Push a changed keyed document to this peer if it subscribed. Returns
/// `false` when the hub's channel closed.
pub(super) fn forward_keyed_doc_change(
    room: &NotebookRoom,
    peer_id: &str,
    states: &mut KeyedSyncStates,
    writer: &PeerWriter,
    result: Result<KeyedDocKey, broadcast::error::RecvError>,
) -> anyhow::Result<bool> {
    let frames = match result {
        Ok(key) => room.keyed_docs.peer_updates(states, Some(&key)),
        Err(broadcast::error::RecvError::Lagged(n)) => {
            debug!("[notebook-sync] Peer {peer_id} lagged {n} keyed document updates");
            room.keyed_docs.peer_updates(states, None)
        }
        Err(broadcast::error::RecvError::Closed) => return Ok(false),
    };
    for frame in frames {
        writer.send_frame(NotebookFrameType::KeyedDocSync, frame)?;
    }
    Ok(true)
}
