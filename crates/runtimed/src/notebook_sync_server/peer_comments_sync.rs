use std::sync::Arc;

use automerge::sync;
use comments_doc::{CommentsDoc, CommentsDocError};
use nteract_identity::ConnectionScope;
use tokio::io::AsyncWrite;
use tokio::sync::broadcast;
use tracing::{debug, warn};

use notebook_doc::diff::extract_change_actors;
use notebook_protocol::connection::{self, NotebookFrameType};

use super::peer_writer::PeerWriter;
use super::{NotebookRoom, RoomConnectionIdentity, COMMENTS_DOC_ACTOR};

pub(super) async fn send_initial_comments_doc_sync<W>(
    writer: &mut W,
    room: &Arc<NotebookRoom>,
    comments_peer_state: &mut sync::State,
) -> anyhow::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let initial_comments_encoded = room.comments.with_doc(|comments_doc| {
        generate_comments_doc_sync_message(
            comments_doc,
            comments_peer_state,
            "initial-comments-sync",
        )
    })?;

    if let Some(encoded) = initial_comments_encoded {
        connection::send_typed_frame(writer, NotebookFrameType::CommentsDocSync, &encoded).await?;
    }

    Ok(())
}

pub(super) async fn handle_comments_doc_frame(
    room: &NotebookRoom,
    comments_peer_state: &mut sync::State,
    writer: &PeerWriter,
    payload: &[u8],
    connection_identity: &RoomConnectionIdentity,
) -> anyhow::Result<bool> {
    let message = sync::Message::decode(payload)
        .map_err(|e| anyhow::anyhow!("decode comments sync: {}", e))?;
    let has_client_changes = !message.changes.is_empty();
    if has_client_changes && !allows_comments_doc_write(connection_identity.scope()) {
        warn!(
            "[notebook-sync] Ignoring unauthorized CommentsDoc changes for scope {}",
            connection_identity.scope()
        );
        *comments_peer_state = sync::State::new();
        let reply_encoded = room.comments.with_doc(|comments_doc| {
            generate_comments_doc_sync_message(
                comments_doc,
                comments_peer_state,
                "comments-unauthorized-reply",
            )
        })?;
        if let Some(encoded) = reply_encoded {
            writer.send_frame(NotebookFrameType::CommentsDocSync, encoded)?;
        }
        return Ok(true);
    }
    let has_client_changes = !message.changes.is_empty();
    let mut applied_changes = false;

    let reply_encoded = room.comments.with_doc(|comments_doc| {
        if has_client_changes {
            let heads_before = comments_doc.get_heads();
            let mut preview = CommentsDoc::from_doc(comments_doc.doc().clone())?;
            let mut preview_peer_state = comments_peer_state.clone();
            match preview.receive_sync_message_with_changes_recovering(
                &mut preview_peer_state,
                message.clone(),
                "comments-auth-preview",
            ) {
                Ok(true) => {
                    let actors = extract_change_actors(preview.doc_mut(), &heads_before);
                    if actors.iter().any(|actor| actor == COMMENTS_DOC_ACTOR) {
                        return Err(CommentsDocError::UnauthorizedActor(format!(
                            "reserved comment authority actor {COMMENTS_DOC_ACTOR}"
                        )));
                    }
                    if preview.changed_authority_fields_since(&heads_before) {
                        return Err(CommentsDocError::UnauthorizedActor(
                            "client-authored comment authority fields".to_string(),
                        ));
                    }
                    connection_identity
                        .validate_actor_labels(actors.iter().map(std::string::String::as_str))
                        .map_err(|error| CommentsDocError::UnauthorizedActor(error.to_string()))?;
                }
                Ok(false) => {}
                Err(e) => {
                    warn!("[notebook-sync] CommentsDoc auth preview failed: {}", e);
                    return Err(e);
                }
            }
        }

        applied_changes = match comments_doc.receive_sync_message_with_changes_recovering(
            comments_peer_state,
            message,
            "comments-receive-sync",
        ) {
            Ok(changed) => changed,
            Err(e) => {
                warn!(
                    "[notebook-sync] CommentsDoc receive_sync_message error: {}",
                    e
                );
                return Err(e);
            }
        };

        generate_comments_doc_sync_message(comments_doc, comments_peer_state, "comments-sync-reply")
    })?;

    if applied_changes {
        room.comments_store.save_handle(&room.comments)?;
    }
    if let Some(encoded) = reply_encoded {
        writer.send_frame(NotebookFrameType::CommentsDocSync, encoded)?;
    }
    Ok(true)
}

pub(super) async fn forward_comments_doc_broadcast(
    room: &NotebookRoom,
    peer_id: &str,
    comments_peer_state: &mut sync::State,
    writer: &PeerWriter,
    result: Result<(), broadcast::error::RecvError>,
) -> anyhow::Result<bool> {
    match result {
        Ok(()) => {
            send_comments_doc_sync_update(room, comments_peer_state, writer, "comments-broadcast")?;
        }
        Err(broadcast::error::RecvError::Lagged(n)) => {
            debug!(
                "[notebook-sync] Peer {} lagged {} CommentsDoc updates",
                peer_id, n
            );
            send_comments_doc_sync_update(
                room,
                comments_peer_state,
                writer,
                "comments-broadcast-lagged",
            )?;
        }
        Err(broadcast::error::RecvError::Closed) => {
            return Ok(false);
        }
    }
    Ok(true)
}

fn send_comments_doc_sync_update(
    room: &NotebookRoom,
    comments_peer_state: &mut sync::State,
    writer: &PeerWriter,
    label: &str,
) -> anyhow::Result<()> {
    let encoded = room.comments.with_doc(|comments_doc| {
        generate_comments_doc_sync_message(comments_doc, comments_peer_state, label)
    })?;
    if let Some(encoded) = encoded {
        writer.send_frame(NotebookFrameType::CommentsDocSync, encoded)?;
    }
    Ok(())
}

fn generate_comments_doc_sync_message(
    comments_doc: &mut comments_doc::CommentsDoc,
    comments_peer_state: &mut sync::State,
    label: &str,
) -> Result<Option<Vec<u8>>, comments_doc::CommentsDocError> {
    match comments_doc.generate_sync_message_recovering(comments_peer_state, label) {
        Ok(message) => Ok(message.map(|msg| msg.encode())),
        Err(e) => {
            warn!("[notebook-sync] CommentsDoc sync generation failed: {}", e);
            Err(e.into())
        }
    }
}

fn allows_comments_doc_write(scope: ConnectionScope) -> bool {
    matches!(scope, ConnectionScope::Editor | ConnectionScope::Owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_doc_write_scope_excludes_viewer_and_runtime_peer() {
        assert!(!allows_comments_doc_write(ConnectionScope::Viewer));
        assert!(allows_comments_doc_write(ConnectionScope::Editor));
        assert!(!allows_comments_doc_write(ConnectionScope::RuntimePeer));
        assert!(allows_comments_doc_write(ConnectionScope::Owner));
    }
}
