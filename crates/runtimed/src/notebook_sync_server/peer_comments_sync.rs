use std::sync::Arc;

use automerge::sync;
use nteract_identity::ConnectionScope;
use tokio::io::AsyncWrite;
use tokio::sync::broadcast;
use tracing::{debug, warn};

use comments_doc::{CommentsDoc, CommentsDocError};
use notebook_doc::diff::extract_change_actors;
use notebook_protocol::connection::{self, NotebookFrameType};

use super::peer_writer::PeerWriter;
use super::{NotebookRoom, RoomConnectionIdentity};

pub(super) async fn send_initial_comments_doc_sync<W>(
    writer: &mut W,
    room: &Arc<NotebookRoom>,
    comments_peer_state: &mut sync::State,
) -> anyhow::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let initial_comments_encoded = room
        .comments
        .generate_sync_message_recovering(comments_peer_state, "initial-comments-sync")
        .map_err(|e| anyhow::anyhow!("initial CommentsDoc sync failed: {e}"))?
        .map(|msg| msg.encode());
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
    let mut message = sync::Message::decode(payload)
        .map_err(|e| anyhow::anyhow!("decode comments sync: {}", e))?;
    let has_client_changes = !message.changes.is_empty();
    if has_client_changes && !allows_comments_doc_write(connection_identity.scope()) {
        warn!(
            "[notebook-sync] Stripping unauthorized CommentsDoc changes for scope {}",
            connection_identity.scope()
        );
        message.changes = sync::ChunkList::empty();
    }
    let has_client_changes = !message.changes.is_empty();

    if has_client_changes {
        let (heads_before, comments_doc_id, bytes) = room.comments.with_doc(|comments_doc| {
            let heads_before = comments_doc.get_heads();
            let comments_doc_id = comments_doc
                .comments_doc_id()
                .ok_or(CommentsDocError::MissingCommentsDocId)?;
            Ok((heads_before, comments_doc_id, comments_doc.save()))
        })?;
        let mut preview = CommentsDoc::load_with_actor(
            &bytes,
            &comments_doc_id,
            "runtimed:comments-auth-preview",
        )?;
        let mut preview_peer_state = comments_peer_state.clone();
        match preview.receive_sync_message_with_changes_recovering(
            &mut preview_peer_state,
            message.clone(),
            "comments-auth-preview",
        ) {
            Ok(true) => {
                let actors = extract_change_actors(preview.doc_mut(), &heads_before);
                connection_identity
                    .validate_actor_labels(actors.iter().map(std::string::String::as_str))?;
            }
            Ok(false) => {}
            Err(e) => {
                warn!("[notebook-sync] CommentsDoc auth preview failed: {}", e);
                return Err(e.into());
            }
        }
    }

    let (reply_encoded, applied_client_changes) = room.comments.with_doc(|comments_doc| {
        let applied_client_changes = match comments_doc
            .receive_sync_message_with_changes_recovering(
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

        let reply_encoded = generate_comments_doc_sync_message(
            comments_doc,
            comments_peer_state,
            "comments-sync-reply",
        )?;
        Ok((reply_encoded, applied_client_changes))
    })?;

    if applied_client_changes {
        if let Err(error) = room.comments_store.save_handle(&room.comments) {
            warn!(
                "[notebook-sync] Failed to persist CommentsDoc after sync frame: {}",
                error
            );
        }
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
    comments_doc: &mut CommentsDoc,
    comments_peer_state: &mut sync::State,
    label: &str,
) -> Result<Option<Vec<u8>>, CommentsDocError> {
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
    use automerge::ActorId;
    use comments_doc::{CommentAnchor, NotebookCommentRef};
    use notebook_protocol::connection;
    use tokio::io::duplex;

    use crate::blob_store::BlobStore;
    use crate::notebook_sync_server::{comments_store::CommentsSidecarStore, NotebookRoom};

    fn test_room(tmp: &tempfile::TempDir) -> Arc<NotebookRoom> {
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            &tmp.path().join("notebook-docs"),
            blob_store,
            false,
        ))
    }

    fn make_sender(
        comments_doc_id: &str,
        actor_label: &str,
        body: &str,
    ) -> (CommentsDoc, sync::State) {
        let notebook_ref = NotebookCommentRef::LocalRoom {
            room_id: "room".to_string(),
        };
        let mut sender = CommentsDoc::new_with_actor(comments_doc_id, &notebook_ref, actor_label);
        sender
            .create_thread(
                "thread-1",
                "message-1",
                &CommentAnchor::Notebook,
                body,
                None,
                "2026-06-16T00:00:00Z",
            )
            .expect("create comment thread");
        (sender, sync::State::new())
    }

    fn client_payload_after_initial_sync(
        room: &NotebookRoom,
        room_peer_state: &mut sync::State,
        sender: &mut CommentsDoc,
        sender_state: &mut sync::State,
    ) -> Vec<u8> {
        let initial_message = room
            .comments
            .generate_sync_message_recovering(room_peer_state, "comments-test-initial")
            .unwrap()
            .expect("initial comments sync message");
        sender
            .receive_sync_message_with_changes(sender_state, initial_message)
            .expect("client receives initial comments sync");
        let message = sender
            .generate_sync_message(sender_state)
            .expect("sender sync message");
        assert!(
            !message.changes.is_empty(),
            "client payload should carry comment changes"
        );
        message.encode()
    }

    async fn read_comments_frame<R>(reader: &mut R) -> Vec<u8>
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        let frame = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            connection::recv_typed_frame(reader),
        )
        .await
        .expect("comments frame timeout")
        .expect("read comments frame")
        .expect("read comments frame");
        assert_eq!(frame.frame_type, NotebookFrameType::CommentsDocSync);
        frame.payload
    }

    #[tokio::test]
    async fn editor_comments_doc_changes_apply_reply_persist_and_fan_out() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let comments_doc_id = room
            .comments
            .read(|doc| doc.comments_doc_id())
            .unwrap()
            .unwrap();
        let identity = RoomConnectionIdentity::local_with_scope(
            Some("desktop:window-1".to_string()),
            ConnectionScope::Editor,
        )
        .await
        .unwrap();
        let actor_label = identity.actor_label().as_str().to_string();
        let mut receiver_state = sync::State::new();
        let (mut sender, mut sender_state) =
            make_sender(&comments_doc_id, &actor_label, "persisted from sync");
        let payload = client_payload_after_initial_sync(
            &room,
            &mut receiver_state,
            &mut sender,
            &mut sender_state,
        );
        let (client, mut reader) = duplex(8192);
        let (peer_writer, writer_task) =
            super::super::peer_writer::spawn_peer_writer(client, "notebook".into(), "peer".into());

        assert!(handle_comments_doc_frame(
            &room,
            &mut receiver_state,
            &peer_writer,
            &payload,
            &identity,
        )
        .await
        .unwrap());
        let reply = read_comments_frame(&mut reader).await;
        assert!(!reply.is_empty());

        let projection = room
            .comments
            .read(|doc| doc.read_projection(None))
            .unwrap()
            .unwrap();
        assert_eq!(projection.threads.len(), 1);
        assert_eq!(
            projection.threads[0].messages[0].body,
            "persisted from sync"
        );

        let notebook_ref = room
            .comments
            .read(|doc| doc.notebook_ref())
            .unwrap()
            .unwrap();
        let reloaded = room
            .comments_store
            .load_or_create(&comments_doc_id, &notebook_ref)
            .unwrap();
        let reloaded_projection = reloaded
            .read(|doc| doc.read_projection(None))
            .unwrap()
            .unwrap();
        assert_eq!(reloaded_projection.threads.len(), 1);
        assert_eq!(
            reloaded_projection.threads[0].messages[0].body,
            "persisted from sync"
        );

        let mut fanout_state = sync::State::new();
        assert!(forward_comments_doc_broadcast(
            &room,
            "peer-2",
            &mut fanout_state,
            &peer_writer,
            Ok(()),
        )
        .await
        .unwrap());
        let fanout = read_comments_frame(&mut reader).await;
        assert!(!fanout.is_empty());

        writer_task.handle.abort();
    }

    #[tokio::test]
    async fn runtime_peer_comments_doc_changes_are_stripped() {
        let tmp = tempfile::tempdir().unwrap();
        let room = test_room(&tmp);
        let comments_doc_id = room
            .comments
            .read(|doc| doc.comments_doc_id())
            .unwrap()
            .unwrap();
        let identity = RoomConnectionIdentity::local_with_scope(
            Some("runtime:agent-1".to_string()),
            ConnectionScope::RuntimePeer,
        )
        .await
        .unwrap();
        let actor_label = identity.actor_label().as_str().to_string();
        let mut receiver_state = sync::State::new();
        let (mut sender, mut sender_state) =
            make_sender(&comments_doc_id, &actor_label, "runtime peer write");
        let payload = client_payload_after_initial_sync(
            &room,
            &mut receiver_state,
            &mut sender,
            &mut sender_state,
        );
        let (client, mut reader) = duplex(8192);
        let (peer_writer, writer_task) =
            super::super::peer_writer::spawn_peer_writer(client, "notebook".into(), "peer".into());

        assert!(handle_comments_doc_frame(
            &room,
            &mut receiver_state,
            &peer_writer,
            &payload,
            &identity,
        )
        .await
        .unwrap());
        let reply = read_comments_frame(&mut reader).await;
        assert!(!reply.is_empty());

        let projection = room
            .comments
            .read(|doc| doc.read_projection(None))
            .unwrap()
            .unwrap();
        assert!(projection.threads.is_empty());

        writer_task.handle.abort();
    }

    #[test]
    fn comments_sidecar_store_round_trip_persists_handle() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CommentsSidecarStore::new(tmp.path().join("comments"));
        let comments_doc_id = "comments:local-room:test";
        let notebook_ref = NotebookCommentRef::LocalRoom {
            room_id: "test".to_string(),
        };
        let handle = store
            .load_or_create(comments_doc_id, &notebook_ref)
            .expect("load comments handle");
        handle
            .with_doc(|doc| {
                doc.doc_mut()
                    .set_actor(ActorId::from("client:alice".as_bytes()));
                doc.create_thread(
                    "thread-1",
                    "message-1",
                    &CommentAnchor::Notebook,
                    "persisted",
                    None,
                    "2026-06-16T00:00:00Z",
                )?;
                Ok(())
            })
            .unwrap();
        store.save_handle(&handle).unwrap();

        let reloaded = store
            .load_or_create(comments_doc_id, &notebook_ref)
            .expect("reload comments handle");
        let projection = reloaded
            .read(|doc| doc.read_projection(None))
            .unwrap()
            .unwrap();
        assert_eq!(projection.threads.len(), 1);
        assert_eq!(projection.threads[0].messages[0].body, "persisted");
    }
}
