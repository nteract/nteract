//! Frame `0x0b` routing for notebook peers. The hub in
//! `crate::bokeh_session::hub` owns the replicas and the ingress checks.

use automerge::ActorId;
use notebook_protocol::connection::NotebookFrameType;
use tokio::sync::broadcast;
use tracing::debug;

use super::peer_runtime_sync::runtime_state_write_scope;
use super::peer_writer::PeerWriter;
use super::{NotebookRoom, RoomConnectionIdentity};
use crate::bokeh_session::store::BokehSyncStates;

pub(super) fn handle_bokeh_session_frame(
    room: &NotebookRoom,
    states: &mut BokehSyncStates,
    writer: &PeerWriter,
    payload: &[u8],
    connection_identity: &RoomConnectionIdentity,
) -> anyhow::Result<()> {
    let record = notebook_wire::BokehSessionFrameHeader::try_parse(payload)
        .ok()
        .and_then(|(header, _)| {
            room.state
                .read(|doc| doc.get_bokeh_session(&header.session_id))
                .ok()
                .flatten()
        });
    let actor_ok = |actor: &ActorId| {
        let label = String::from_utf8_lossy(actor.to_bytes());
        connection_identity
            .validate_actor_labels(std::iter::once(label.as_ref()))
            .is_ok()
    };
    let result = room.bokeh_sessions.receive_peer_frame(
        states,
        payload,
        runtime_state_write_scope(connection_identity.scope()),
        record.as_ref(),
        actor_ok,
    );
    if let Some(resync) = result.resync {
        writer.send_json(NotebookFrameType::SessionControl, &resync)?;
    }
    for frame in result.frames {
        writer.send_frame(NotebookFrameType::BokehSessionDocSync, frame)?;
    }
    Ok(())
}

/// On runtime agent loss, freeze every connected session from the hub
/// replica into its output payload and mark it disconnected (read-only).
pub(super) async fn freeze_room_sessions(room: &NotebookRoom) {
    let connected: Vec<String> = room
        .state
        .read(|doc| {
            doc.get_bokeh_sessions()
                .into_iter()
                .filter(|(_, session)| session.status == runtime_doc::BokehSessionStatus::Connected)
                .map(|(id, _)| id)
                .collect()
        })
        .unwrap_or_default();
    if connected.is_empty() {
        return;
    }
    for session_id in &connected {
        let Some(snapshot) = room.bokeh_sessions.snapshot(session_id) else {
            continue;
        };
        if let Err(error) = crate::bokeh_session::materialize::freeze_session_output(
            session_id,
            &snapshot,
            &room.state,
            None,
            &room.blob_store,
            &crate::output_blob_publisher::OutputBlobPublisher::none(),
        )
        .await
        {
            tracing::warn!("[bokeh-session] Failed to freeze session {session_id}: {error}");
        }
    }
    if let Err(error) = room
        .state
        .with_doc(|doc| doc.disconnect_all_bokeh_sessions().map(|_| ()))
    {
        tracing::warn!("[bokeh-session] Failed to disconnect sessions: {error}");
    }
}

/// Push a changed session to this peer if it subscribed. Returns `false`
/// when the hub's channel closed.
pub(super) fn forward_bokeh_session_change(
    room: &NotebookRoom,
    peer_id: &str,
    states: &mut BokehSyncStates,
    writer: &PeerWriter,
    result: Result<String, broadcast::error::RecvError>,
) -> anyhow::Result<bool> {
    let sessions = match result {
        Ok(session_id) => vec![session_id],
        Err(broadcast::error::RecvError::Lagged(n)) => {
            debug!("[notebook-sync] Peer {peer_id} lagged {n} Bokeh session updates");
            states.keys().cloned().collect()
        }
        Err(broadcast::error::RecvError::Closed) => return Ok(false),
    };
    for session_id in sessions {
        for frame in room.bokeh_sessions.peer_updates(states, &session_id) {
            writer.send_frame(NotebookFrameType::BokehSessionDocSync, frame)?;
        }
    }
    Ok(true)
}
