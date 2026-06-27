use automerge::sync;
use tracing::warn;

use notebook_protocol::connection::NotebookFrameType;

use super::peer_writer::PeerWriter;
use super::{
    check_and_broadcast_sync_state, check_and_update_trust_state, process_markdown_assets,
    NotebookRoom, RoomConnectionIdentity,
};
use notebook_doc::diff::{diff_metadata_touched, extract_change_actor_hashes};

pub(super) async fn handle_notebook_doc_frame(
    room: &NotebookRoom,
    peer_state: &mut sync::State,
    connection_identity: &RoomConnectionIdentity,
    writer: &PeerWriter,
    payload: &[u8],
) -> anyhow::Result<NotebookDocSideEffects> {
    let (effects, reply_encoded) =
        apply_notebook_doc_frame(room, peer_state, connection_identity, payload).await?;

    // Queue the reply outside the lock so other peers can acquire it while the
    // writer task drains the socket.
    if let Some(encoded) = reply_encoded {
        writer.send_frame(NotebookFrameType::AutomergeSync, encoded)?;
    }

    Ok(effects)
}

pub(super) async fn apply_notebook_doc_frame(
    room: &NotebookRoom,
    peer_state: &mut sync::State,
    connection_identity: &RoomConnectionIdentity,
    payload: &[u8],
) -> anyhow::Result<(NotebookDocSideEffects, Option<Vec<u8>>)> {
    let mut message =
        sync::Message::decode(payload).map_err(|e| anyhow::anyhow!("decode error: {}", e))?;
    let has_client_changes = !message.changes.is_empty();
    if has_client_changes && !connection_identity.allows_notebook_write() {
        warn!(
            "[notebook-sync] Stripping unauthorized NotebookDoc changes for scope {}",
            connection_identity.scope()
        );
        message.changes = sync::ChunkList::empty();
    }
    let has_client_changes = !message.changes.is_empty();

    // Complete all document mutations inside the lock, encode the reply, then
    // release the lock before performing async I/O.
    let (persist_bytes, reply_encoded, metadata_changed) = {
        let mut doc = room.doc.write().await;

        if has_client_changes {
            // v1: clone-preview validator. Replace with sync_message_new_changes
            // once nteract/automerge ships Patch 1.
            let heads_before = doc.get_heads();
            let mut preview = notebook_doc::NotebookDoc::wrap(doc.doc().clone());
            let mut preview_peer_state = peer_state.clone();
            match preview.receive_sync_message_recovering(
                &mut preview_peer_state,
                message.clone(),
                "doc-auth-preview",
            ) {
                Ok(()) => {
                    let actors = extract_change_actor_hashes(preview.doc_mut(), &heads_before);
                    connection_identity.validate_notebook_change_actors(actors.iter())?;
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
        let changed = heads_before != heads_after;
        let metadata_changed =
            changed && diff_metadata_touched(doc.doc_mut(), &heads_before, &heads_after);

        let bytes = if changed { Some(doc.save()) } else { None };
        if changed {
            // Notify other peers in this room.
            let _ = room.broadcasts.changed_tx.send(());
        }

        let encoded = match doc.generate_sync_message_recovering(peer_state, "doc-sync-reply") {
            Ok(message) => message.map(|reply| reply.encode()),
            Err(e) => {
                warn!("[notebook-sync] doc sync reply failed: {}", e);
                return Err(anyhow::anyhow!("doc sync reply failed: {e}"));
            }
        };

        (bytes, encoded, metadata_changed)
    };

    let sync_reply_queued = reply_encoded.is_some();

    Ok((
        NotebookDocSideEffects {
            persist_bytes,
            metadata_changed,
            sync_reply_queued,
        },
        reply_encoded,
    ))
}

pub(super) struct NotebookDocSideEffects {
    persist_bytes: Option<Vec<u8>>,
    metadata_changed: bool,
    sync_reply_queued: bool,
}

impl NotebookDocSideEffects {
    pub(super) fn sync_reply_queued(&self) -> bool {
        self.sync_reply_queued
    }
}

pub(super) async fn finish_notebook_doc_frame(
    room: &NotebookRoom,
    effects: NotebookDocSideEffects,
) {
    let Some(persist_bytes) = effects.persist_bytes else {
        return;
    };

    room.persistence.enqueue_persist_bytes(persist_bytes);

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
