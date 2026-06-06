use std::sync::Arc;

use automerge::sync;
use nteract_identity::ConnectionScope;
use tokio::io::AsyncWrite;
use tokio::sync::broadcast;
use tracing::{debug, warn};

use notebook_doc::diff::extract_change_actors;
use notebook_protocol::connection::{self, NotebookFrameType};

use super::peer_writer::PeerWriter;
use super::{NotebookRoom, RoomConnectionIdentity, STATE_SYNC_COMPACT_THRESHOLD};

pub(super) async fn send_initial_comms_doc_sync<W>(
    writer: &mut W,
    room: &Arc<NotebookRoom>,
    comms_peer_state: &mut sync::State,
) -> anyhow::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let initial_comms_encoded = room
        .comms
        .with_doc(|comms_doc| {
            const COMPACTION_THRESHOLD: usize = 80 * 1024 * 1024;
            if comms_doc.compact_if_oversized(COMPACTION_THRESHOLD) {
                tracing::info!("[notebook-sync] Compacted oversized CommsDoc before initial sync");
            }
            comms_doc
                .generate_sync_message_bounded_encoded_recovering(
                    comms_peer_state,
                    STATE_SYNC_COMPACT_THRESHOLD,
                    "initial-comms-sync",
                )
                .map_err(|e| {
                    warn!("[notebook-sync] initial CommsDoc sync failed: {}", e);
                    runtime_doc::RuntimeStateError::from(e)
                })
        })
        .map_err(|e| anyhow::anyhow!("initial CommsDoc sync failed: {e}"))?;
    if let Some(encoded) = initial_comms_encoded {
        connection::send_typed_frame(writer, NotebookFrameType::CommsDocSync, &encoded).await?;
    }

    Ok(())
}

pub(super) async fn handle_comms_doc_frame(
    room: &NotebookRoom,
    comms_peer_state: &mut sync::State,
    writer: &PeerWriter,
    payload: &[u8],
    connection_identity: &RoomConnectionIdentity,
) -> anyhow::Result<bool> {
    let mut message =
        sync::Message::decode(payload).map_err(|e| anyhow::anyhow!("decode comms sync: {}", e))?;
    let has_client_changes = !message.changes.is_empty();
    if has_client_changes && !allows_comms_doc_write(connection_identity.scope()) {
        warn!(
            "[notebook-sync] Stripping unauthorized CommsDoc changes for scope {}",
            connection_identity.scope()
        );
        message.changes = sync::ChunkList::empty();
    }
    let has_client_changes = !message.changes.is_empty();

    let reply_encoded = room.comms.with_doc(|comms_doc| {
        if has_client_changes {
            let heads_before = comms_doc.get_heads();
            let mut preview = runtime_doc::CommsDoc::from_doc(comms_doc.doc().clone());
            let mut preview_peer_state = comms_peer_state.clone();
            match preview.receive_sync_message_with_changes_recovering(
                &mut preview_peer_state,
                message.clone(),
                "comms-auth-preview",
            ) {
                Ok(true) => {
                    let actors = extract_change_actors(preview.doc_mut(), &heads_before);
                    connection_identity
                        .validate_actor_labels(actors.iter().map(std::string::String::as_str))
                        .map_err(|error| {
                            runtime_doc::RuntimeStateError::UnauthorizedActor(error.to_string())
                        })?;
                }
                Ok(false) => {}
                Err(e) => {
                    warn!("[notebook-sync] CommsDoc auth preview failed: {}", e);
                    return Err(e.into());
                }
            }
        }

        match comms_doc.receive_sync_message_with_changes_recovering(
            comms_peer_state,
            message,
            "comms-receive-sync",
        ) {
            Ok(_) => {}
            Err(e) => {
                warn!("[notebook-sync] CommsDoc receive_sync_message error: {}", e);
                return Err(e.into());
            }
        }

        generate_comms_doc_sync_message(comms_doc, comms_peer_state, "comms-sync-reply")
    })?;

    if let Some(encoded) = reply_encoded {
        writer.send_frame(NotebookFrameType::CommsDocSync, encoded)?;
    }
    Ok(true)
}

pub(super) async fn forward_comms_doc_broadcast(
    room: &NotebookRoom,
    peer_id: &str,
    comms_peer_state: &mut sync::State,
    writer: &PeerWriter,
    result: Result<(), broadcast::error::RecvError>,
) -> anyhow::Result<bool> {
    match result {
        Ok(()) => {
            send_comms_doc_sync_update(room, comms_peer_state, writer, "comms-broadcast")?;
        }
        Err(broadcast::error::RecvError::Lagged(n)) => {
            debug!(
                "[notebook-sync] Peer {} lagged {} CommsDoc updates",
                peer_id, n
            );
            send_comms_doc_sync_update(room, comms_peer_state, writer, "comms-broadcast-lagged")?;
        }
        Err(broadcast::error::RecvError::Closed) => {
            return Ok(false);
        }
    }
    Ok(true)
}

fn send_comms_doc_sync_update(
    room: &NotebookRoom,
    comms_peer_state: &mut sync::State,
    writer: &PeerWriter,
    label: &str,
) -> anyhow::Result<()> {
    let encoded = room.comms.with_doc(|comms_doc| {
        generate_comms_doc_sync_message(comms_doc, comms_peer_state, label)
    })?;
    if let Some(encoded) = encoded {
        writer.send_frame(NotebookFrameType::CommsDocSync, encoded)?;
    }
    Ok(())
}

fn generate_comms_doc_sync_message(
    comms_doc: &mut runtime_doc::CommsDoc,
    comms_peer_state: &mut sync::State,
    label: &str,
) -> Result<Option<Vec<u8>>, runtime_doc::RuntimeStateError> {
    match comms_doc.generate_sync_message_recovering(comms_peer_state, label) {
        Ok(message) => Ok(message.map(|msg| msg.encode())),
        Err(e) => {
            warn!("[notebook-sync] CommsDoc sync generation failed: {}", e);
            Err(e.into())
        }
    }
}

fn allows_comms_doc_write(scope: ConnectionScope) -> bool {
    matches!(
        scope,
        ConnectionScope::Editor | ConnectionScope::Owner | ConnectionScope::RuntimePeer
    )
}
