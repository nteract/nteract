use automerge::sync;
use tracing::warn;

use notebook_protocol::connection::NotebookFrameType;

use super::peer_writer::PeerWriter;
use super::{
    check_and_broadcast_sync_state, check_and_update_trust_state, process_markdown_assets,
    NotebookRoom, RoomConnectionIdentity,
};
use notebook_doc::diff::{diff_metadata_touched, extract_change_actors};

pub(super) async fn handle_notebook_doc_frame(
    room: &NotebookRoom,
    peer_state: &mut sync::State,
    connection_identity: &RoomConnectionIdentity,
    writer: &PeerWriter,
    payload: &[u8],
) -> anyhow::Result<NotebookDocFrameOutcome> {
    let message =
        sync::Message::decode(payload).map_err(|e| anyhow::anyhow!("decode error: {}", e))?;

    // Complete all document mutations inside the lock, encode the reply, then
    // release the lock before performing async I/O.
    let (persist_bytes, reply_encoded, metadata_changed) = {
        let mut doc = room.doc.write().await;

        if !message.changes.is_empty() {
            let heads_before = doc.get_heads();
            let mut preview = notebook_doc::NotebookDoc::wrap(doc.doc().clone());
            let mut preview_peer_state = peer_state.clone();
            match preview.receive_sync_message_recovering(
                &mut preview_peer_state,
                message.clone(),
                "doc-auth-preview",
            ) {
                Ok(()) => {
                    let actors = extract_change_actors(preview.doc_mut(), &heads_before);
                    connection_identity
                        .validate_actor_labels(actors.iter().map(std::string::String::as_str))?;
                }
                Err(e) => {
                    warn!("[notebook-sync] doc auth preview failed: {}", e);
                    return Err(anyhow::anyhow!("doc auth preview failed: {e}"));
                }
            }
        }

        let heads_before = doc.get_heads();

        match doc.receive_sync_message_recovering(peer_state, message, "doc-receive-sync") {
            Ok(()) => {}
            Err(e) => {
                warn!("[notebook-sync] receive_sync_message error: {}", e);
                return Err(anyhow::anyhow!("doc receive_sync_message error: {e}"));
            }
        }

        let heads_after = doc.get_heads();
        let metadata_changed = diff_metadata_touched(doc.doc_mut(), &heads_before, &heads_after);

        let bytes = doc.save();

        // Notify other peers in this room.
        let _ = room.broadcasts.changed_tx.send(());

        let encoded = match doc.generate_sync_message_recovering(peer_state, "doc-sync-reply") {
            Ok(message) => message.map(|reply| reply.encode()),
            Err(e) => {
                warn!("[notebook-sync] doc sync reply failed: {}", e);
                return Err(anyhow::anyhow!("doc sync reply failed: {e}"));
            }
        };

        (bytes, encoded, metadata_changed)
    };

    // Queue the reply outside the lock so other peers can acquire it while the
    // writer task drains the socket.
    if let Some(encoded) = reply_encoded {
        writer.send_frame(NotebookFrameType::AutomergeSync, encoded)?;
    }

    Ok(NotebookDocFrameOutcome::Applied(NotebookDocSideEffects {
        persist_bytes,
        metadata_changed,
    }))
}

pub(super) enum NotebookDocFrameOutcome {
    Applied(NotebookDocSideEffects),
}

pub(super) struct NotebookDocSideEffects {
    persist_bytes: Vec<u8>,
    metadata_changed: bool,
}

pub(super) async fn finish_notebook_doc_frame(
    room: &NotebookRoom,
    effects: NotebookDocSideEffects,
) {
    room.persistence
        .enqueue_persist_bytes(effects.persist_bytes);

    if effects.metadata_changed {
        check_and_broadcast_sync_state(room).await;
    }

    check_and_update_trust_state(room).await;
    process_markdown_assets(room).await;
}

pub(super) async fn forward_notebook_doc_broadcast(
    room: &NotebookRoom,
    peer_state: &mut sync::State,
    writer: &PeerWriter,
) -> anyhow::Result<()> {
    let encoded = {
        let mut doc = room.doc.write().await;
        match doc.generate_sync_message_recovering(peer_state, "doc-broadcast") {
            Ok(message) => message.map(|msg| msg.encode()),
            Err(e) => {
                warn!("[notebook-sync] doc broadcast failed: {}", e);
                return Err(anyhow::anyhow!("doc broadcast failed: {e}"));
            }
        }
    };
    if let Some(encoded) = encoded {
        writer.send_frame(NotebookFrameType::AutomergeSync, encoded)?;
    }
    Ok(())
}

/// Queue a doc sync message to a peer if there are pending changes.
///
/// Generates an Automerge sync message from the room's doc and hands it to the
/// ordered peer writer after broadcast lag recovery.
pub(super) async fn queue_doc_sync(
    room: &NotebookRoom,
    peer_state: &mut sync::State,
    writer: &PeerWriter,
) -> anyhow::Result<()> {
    let encoded = {
        let mut doc = room.doc.write().await;
        match doc.generate_sync_message_recovering(peer_state, "broadcast-doc-changes") {
            Ok(message) => message.map(|msg| msg.encode()),
            Err(e) => {
                warn!("[notebook-sync] queue doc sync failed: {}", e);
                return Err(anyhow::anyhow!("queue doc sync failed: {e}"));
            }
        }
    };
    if let Some(encoded) = encoded {
        writer.send_frame(NotebookFrameType::AutomergeSync, encoded)?;
    }
    Ok(())
}
