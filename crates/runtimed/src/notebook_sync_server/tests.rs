use super::*;
use automerge::{transaction::Transactable, ActorId, AutoCommit, ObjType};
use base64::Engine;
use runtime_doc::{KernelActivity, KernelErrorReason, RuntimeLifecycle};
use uuid::Uuid;

const SCHEMA_SEED_ACTOR_LABEL: &str = "nteract:notebook-schema:v5";

#[test]
fn fallback_output_stamps_id_when_missing() {
    let raw = serde_json::json!({
        "output_type": "stream",
        "name": "stdout",
        "text": "hi\n",
    });
    let out = fallback_output_with_id(&raw);
    let id = out
        .get("output_id")
        .and_then(|v| v.as_str())
        .expect("output_id set");
    assert!(!id.is_empty(), "fallback must stamp a non-empty id");
    // Rest of the payload passes through untouched.
    assert_eq!(out["output_type"], "stream");
    assert_eq!(out["name"], "stdout");
}

#[test]
fn fallback_output_preserves_existing_id() {
    let raw = serde_json::json!({
        "output_type": "stream",
        "output_id": "existing-id",
    });
    let out = fallback_output_with_id(&raw);
    assert_eq!(out["output_id"], "existing-id");
}

#[test]
fn fallback_output_replaces_empty_id() {
    let raw = serde_json::json!({
        "output_type": "stream",
        "output_id": "",
    });
    let out = fallback_output_with_id(&raw);
    let id = out
        .get("output_id")
        .and_then(|v| v.as_str())
        .expect("output_id set");
    assert!(!id.is_empty());
    assert_ne!(id, "");
}

#[test]
fn test_sanitize_peer_label_basic() {
    assert_eq!(sanitize_peer_label(None, "fb"), "fb");
    assert_eq!(sanitize_peer_label(Some(""), "fb"), "fb");
    assert_eq!(sanitize_peer_label(Some("  "), "fb"), "fb");
    assert_eq!(sanitize_peer_label(Some("Codex"), "fb"), "Codex");
    assert_eq!(sanitize_peer_label(Some("  Claude  "), "fb"), "Claude");
}

#[test]
fn test_sanitize_peer_label_clamps_length() {
    let long = "a".repeat(100);
    assert_eq!(sanitize_peer_label(Some(&long), "fb").len(), 64);
}

#[test]
fn test_sanitize_peer_label_clamps_unicode() {
    // 70 emoji = 70 chars but 280 bytes
    let emoji_label: String = "🦾".repeat(70);
    let result = sanitize_peer_label(Some(&emoji_label), "fb");
    assert_eq!(result.chars().count(), 64);
}

#[test]
fn test_sanitize_peer_label_strips_zero_width() {
    // ZWJ, ZWSP, ZWNJ scattered in a label
    assert_eq!(
        sanitize_peer_label(Some("Co\u{200B}d\u{200D}ex"), "fb"),
        "Codex"
    );
    // Only zero-width chars → falls back to fallback
    assert_eq!(
        sanitize_peer_label(Some("\u{200B}\u{200C}\u{200D}"), "fb"),
        "fb"
    );
}

#[test]
fn test_image_attachment_hash_uses_stable_image_preference() {
    let refs = HashMap::from([(
        "plot".to_string(),
        HashMap::from([
            (
                "image/jpeg".to_string(),
                AttachmentRef {
                    blob_hash: "jpeg-hash".to_string(),
                    encoding: AttachmentEncoding::Base64,
                },
            ),
            (
                "image/png".to_string(),
                AttachmentRef {
                    blob_hash: "png-hash".to_string(),
                    encoding: AttachmentEncoding::Base64,
                },
            ),
        ]),
    )]);

    assert_eq!(
        image_attachment_hash(&refs, "plot#fragment").as_deref(),
        Some("png-hash")
    );

    let refs_with_query_name = HashMap::from([(
        "plot?actual".to_string(),
        HashMap::from([(
            "image/png".to_string(),
            AttachmentRef {
                blob_hash: "query-name-hash".to_string(),
                encoding: AttachmentEncoding::Base64,
            },
        )]),
    )]);
    assert_eq!(
        image_attachment_hash(&refs_with_query_name, "plot?actual").as_deref(),
        Some("query-name-hash")
    );
}

#[test]
fn test_sanitize_peer_label_strips_control_chars() {
    assert_eq!(sanitize_peer_label(Some("Claude\x00\x1F"), "fb"), "Claude");
    assert_eq!(sanitize_peer_label(Some("\x07"), "fb"), "fb");
}

#[test]
fn test_sanitize_peer_label_strips_bidi_overrides() {
    // RTL override + LTR override
    assert_eq!(
        sanitize_peer_label(Some("\u{202E}Agent\u{202C}"), "fb"),
        "Agent"
    );
}

#[test]
fn test_sanitize_peer_label_strips_bidi_marks() {
    // LRM and RLM
    assert_eq!(
        sanitize_peer_label(Some("\u{200E}Agent\u{200F}"), "fb"),
        "Agent"
    );
    assert_eq!(sanitize_peer_label(Some("\u{200E}\u{200F}"), "fb"), "fb");
}

/// Create a test blob store in the given temp directory.
fn test_blob_store(tmp: &tempfile::TempDir) -> Arc<BlobStore> {
    Arc::new(BlobStore::new(tmp.path().join("blobs")))
}

async fn recv_typed_frame_or_timeout<R>(
    reader: &mut R,
    timeout: std::time::Duration,
    context: &str,
) -> Option<notebook_protocol::connection::TypedNotebookFrame>
where
    R: tokio::io::AsyncRead + Unpin,
{
    match tokio::time::timeout(timeout, connection::recv_typed_frame(reader)).await {
        Ok(Ok(frame)) => frame,
        Ok(Err(err)) => panic!("{context}: failed to read typed frame: {err}"),
        Err(_) => None,
    }
}

fn decode_sync_status(
    frame: &notebook_protocol::connection::TypedNotebookFrame,
) -> Option<notebook_protocol::protocol::SessionSyncStatusWire> {
    if frame.frame_type != NotebookFrameType::SessionControl {
        return None;
    }

    match serde_json::from_slice::<notebook_protocol::protocol::SessionControlMessage>(
        &frame.payload,
    )
    .expect("valid session control frame")
    {
        notebook_protocol::protocol::SessionControlMessage::SyncStatus(status) => Some(status),
    }
}

async fn drain_initial_sync_frames<R>(reader: &mut R) -> Vec<u8>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut initial_notebook_sync = None;
    let mut saw_any = false;

    while let Some(frame) = recv_typed_frame_or_timeout(
        reader,
        if saw_any {
            std::time::Duration::from_millis(100)
        } else {
            std::time::Duration::from_secs(2)
        },
        "initial sync",
    )
    .await
    {
        saw_any = true;
        if frame.frame_type == NotebookFrameType::AutomergeSync && initial_notebook_sync.is_none() {
            initial_notebook_sync = Some(frame.payload);
        }
    }

    initial_notebook_sync.expect("daemon should send an initial NotebookDoc sync frame")
}

async fn recv_notebook_sync_reply<R>(reader: &mut R) -> Vec<u8>
where
    R: tokio::io::AsyncRead + Unpin,
{
    loop {
        let frame = recv_typed_frame_or_timeout(
            reader,
            std::time::Duration::from_secs(2),
            "notebook sync reply",
        )
        .await
        .expect("daemon should send a NotebookDoc sync reply");
        if frame.frame_type == NotebookFrameType::AutomergeSync {
            return frame.payload;
        }
    }
}

async fn recv_until_notebook_doc_interactive<R>(reader: &mut R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    loop {
        let frame = recv_typed_frame_or_timeout(
            reader,
            std::time::Duration::from_secs(2),
            "interactive status",
        )
        .await
        .expect("daemon should publish NotebookDoc Interactive");
        if decode_sync_status(&frame).is_some_and(|status| {
            status.notebook_doc == notebook_protocol::protocol::NotebookDocPhaseWire::Interactive
        }) {
            return;
        }
    }
}

async fn write_numbered_notebook(path: &Path, count: usize) {
    let cells: Vec<serde_json::Value> = (0..count)
        .map(|index| {
            serde_json::json!({
                "cell_type": "code",
                "execution_count": null,
                "id": format!("cell-{index}"),
                "metadata": {},
                "outputs": [],
                "source": format!("print({index})\n"),
            })
        })
        .collect();
    let notebook = serde_json::json!({
        "cells": cells,
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    });
    tokio::fs::write(path, serde_json::to_vec(&notebook).unwrap())
        .await
        .unwrap();
}

#[tokio::test]
async fn notebook_doc_interactive_waits_for_initial_sync_convergence() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let room = Arc::new(NotebookRoom::new_fresh(
        Uuid::new_v4(),
        None,
        tmp.path(),
        blob_store,
        false,
    ));
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "existing-1", "code").unwrap();
        doc.update_source("existing-1", "x = 1").unwrap();
        doc.add_cell(1, "existing-2", "markdown").unwrap();
        doc.update_source("existing-2", "# already here").unwrap();
    }

    let daemon = crate::daemon::Daemon::new_for_test(test_daemon_config(&tmp)).unwrap();
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let identity = RoomConnectionIdentity::local(Some("mcp:test".to_string()))
        .await
        .unwrap();
    let notebook_id = room.id.to_string();
    let (client_io, server_io) = tokio::io::duplex(1024 * 1024);
    let (server_reader, server_writer) = tokio::io::split(server_io);
    let (mut client_reader, mut client_writer) = tokio::io::split(client_io);

    let server_task = {
        let ctx = PeerConnectionContext {
            room: room.clone(),
            rooms,
            notebook_id,
            daemon: daemon.clone(),
            peer_id: "mcp-peer".to_string(),
            connection_identity: identity,
            client_protocol_version: notebook_protocol::connection::PROTOCOL_VERSION,
            default_runtime: Default::default(),
            default_python_env: Default::default(),
            working_dir: None,
            needs_load: None,
        };
        tokio::spawn(async move {
            super::peer_loop::run_sync_loop_v2(server_reader, server_writer, &ctx).await
        })
    };

    connection::send_typed_frame(&mut client_writer, NotebookFrameType::Presence, b"{}")
        .await
        .unwrap();

    let mut client_doc =
        notebook_doc::NotebookDoc::bootstrap(notebook_doc::TextEncoding::Utf16CodeUnit, "mcp:test");
    let mut client_state = sync::State::new();

    let initial_sync = drain_initial_sync_frames(&mut client_reader).await;
    let initial_message = sync::Message::decode(&initial_sync).expect("valid initial sync");
    client_doc
        .receive_sync_message_recovering(&mut client_state, initial_message, "test-initial-sync")
        .unwrap();
    let first_reply = client_doc
        .generate_sync_message_recovering(&mut client_state, "test-first-reply")
        .unwrap()
        .expect("client should reply to initial sync");
    connection::send_typed_frame(
        &mut client_writer,
        NotebookFrameType::AutomergeSync,
        &first_reply.encode(),
    )
    .await
    .unwrap();

    let changes_reply = recv_notebook_sync_reply(&mut client_reader).await;
    let mut premature_interactive = false;
    while let Some(frame) = recv_typed_frame_or_timeout(
        &mut client_reader,
        std::time::Duration::from_millis(150),
        "post-reply drain",
    )
    .await
    {
        if decode_sync_status(&frame).is_some_and(|status| {
            status.notebook_doc == notebook_protocol::protocol::NotebookDocPhaseWire::Interactive
        }) {
            premature_interactive = true;
            break;
        }
    }
    assert!(
        !premature_interactive,
        "daemon advertised NotebookDoc Interactive before the joiner acknowledged the changes-bearing initial sync reply"
    );

    let changes_message = sync::Message::decode(&changes_reply).expect("valid changes reply");
    client_doc
        .receive_sync_message_recovering(&mut client_state, changes_message, "test-changes-sync")
        .unwrap();
    assert_eq!(
        client_doc.cell_count(),
        2,
        "the changes-bearing reply must deliver the existing room cells"
    );
    let final_ack = client_doc
        .generate_sync_message_recovering(&mut client_state, "test-final-ack")
        .unwrap()
        .expect("client should acknowledge the changes-bearing reply");
    connection::send_typed_frame(
        &mut client_writer,
        NotebookFrameType::AutomergeSync,
        &final_ack.encode(),
    )
    .await
    .unwrap();

    recv_until_notebook_doc_interactive(&mut client_reader).await;

    drop(client_writer);
    drop(client_reader);
    server_task.abort();
    let _ = server_task.await;
}

#[tokio::test]
async fn file_backed_initial_load_applies_buffered_replies_before_ready() {
    let tmp = tempfile::TempDir::new().unwrap();
    let load_path = tmp.path().join("seven-cells.ipynb");
    write_numbered_notebook(&load_path, 7).await;

    let blob_store = test_blob_store(&tmp);
    let room = Arc::new(NotebookRoom::new_fresh(
        Uuid::new_v4(),
        Some(load_path.clone()),
        tmp.path(),
        blob_store,
        false,
    ));

    let daemon = crate::daemon::Daemon::new_for_test(test_daemon_config(&tmp)).unwrap();
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let identity = RoomConnectionIdentity::local(Some("mcp:test".to_string()))
        .await
        .unwrap();
    let notebook_id = room.id.to_string();
    let (client_io, server_io) = tokio::io::duplex(1024 * 1024);
    let (server_reader, server_writer) = tokio::io::split(server_io);
    let (mut client_reader, mut client_writer) = tokio::io::split(client_io);

    let server_task = {
        let ctx = PeerConnectionContext {
            room: room.clone(),
            rooms,
            notebook_id,
            daemon: daemon.clone(),
            peer_id: "mcp-peer".to_string(),
            connection_identity: identity,
            client_protocol_version: notebook_protocol::connection::PROTOCOL_VERSION,
            default_runtime: Default::default(),
            default_python_env: Default::default(),
            working_dir: None,
            needs_load: Some(load_path.clone()),
        };
        tokio::spawn(async move {
            super::peer_loop::run_sync_loop_v2(server_reader, server_writer, &ctx).await
        })
    };

    let mut client_doc =
        notebook_doc::NotebookDoc::bootstrap(notebook_doc::TextEncoding::Utf16CodeUnit, "mcp:test");
    let mut client_state = sync::State::new();
    let mut observed_counts = Vec::new();
    let mut last_count = 0usize;
    let mut saw_ready = false;
    let mut ready_notebook_doc_phase = None;

    while !saw_ready {
        let frame = recv_typed_frame_or_timeout(
            &mut client_reader,
            std::time::Duration::from_secs(2),
            "streaming load frame",
        )
        .await
        .expect("daemon should keep sending bootstrap frames");

        match frame.frame_type {
            NotebookFrameType::AutomergeSync => {
                let message = sync::Message::decode(&frame.payload).expect("valid sync message");
                client_doc
                    .receive_sync_message_recovering(
                        &mut client_state,
                        message,
                        "test-streaming-load-sync",
                    )
                    .unwrap();
                let count = client_doc.cell_count();
                if count != last_count {
                    observed_counts.push(count);
                    last_count = count;
                }
                if let Some(reply) = client_doc
                    .generate_sync_message_recovering(
                        &mut client_state,
                        "test-streaming-load-reply",
                    )
                    .unwrap()
                {
                    connection::send_typed_frame(
                        &mut client_writer,
                        NotebookFrameType::AutomergeSync,
                        &reply.encode(),
                    )
                    .await
                    .unwrap();
                }
            }
            NotebookFrameType::SessionControl => {
                if let Some(status) = decode_sync_status(&frame) {
                    if status.initial_load
                        == notebook_protocol::protocol::InitialLoadPhaseWire::Ready
                    {
                        ready_notebook_doc_phase = Some(status.notebook_doc);
                        saw_ready = true;
                    }
                }
            }
            _ => {}
        }
    }

    assert_eq!(client_doc.cell_count(), 7);
    assert!(
        observed_counts.iter().any(|count| *count < 7),
        "client should observe at least one partial load before Ready, got {observed_counts:?}"
    );
    assert_eq!(
        observed_counts.last().copied(),
        Some(7),
        "client should converge before Ready when replies are already buffered"
    );
    // Depending on scheduler order, the final acknowledgement is either
    // drained inside initial loading (so Ready already carries Interactive)
    // or arrives immediately afterward in the steady-state loop. Both paths
    // must converge; the regression was a buffered ACK that left the session
    // stuck in Syncing forever.
    if ready_notebook_doc_phase
        != Some(notebook_protocol::protocol::NotebookDocPhaseWire::Interactive)
    {
        recv_until_notebook_doc_interactive(&mut client_reader).await;
    }

    drop(client_writer);
    drop(client_reader);
    server_task.abort();
    let _ = server_task.await;
}

#[tokio::test(start_paused = true)]
async fn file_backed_initial_load_reaches_ready_without_streaming_replies() {
    let tmp = tempfile::TempDir::new().unwrap();
    let load_path = tmp.path().join("eleven-cells.ipynb");
    write_numbered_notebook(&load_path, 11).await;

    let blob_store = test_blob_store(&tmp);
    let room = Arc::new(NotebookRoom::new_fresh(
        Uuid::new_v4(),
        Some(load_path.clone()),
        tmp.path(),
        blob_store,
        false,
    ));

    let daemon = crate::daemon::Daemon::new_for_test(test_daemon_config(&tmp)).unwrap();
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let identity = RoomConnectionIdentity::local(Some("mcp:test".to_string()))
        .await
        .unwrap();
    let notebook_id = room.id.to_string();
    let (client_io, server_io) = tokio::io::duplex(1024 * 1024);
    let (server_reader, server_writer) = tokio::io::split(server_io);
    let (mut client_reader, mut client_writer) = tokio::io::split(client_io);

    let server_task = {
        let ctx = PeerConnectionContext {
            room: room.clone(),
            rooms,
            notebook_id,
            daemon: daemon.clone(),
            peer_id: "mcp-peer".to_string(),
            connection_identity: identity,
            client_protocol_version: notebook_protocol::connection::PROTOCOL_VERSION,
            default_runtime: Default::default(),
            default_python_env: Default::default(),
            working_dir: None,
            needs_load: Some(load_path.clone()),
        };
        tokio::spawn(async move {
            super::peer_loop::run_sync_loop_v2(server_reader, server_writer, &ctx).await
        })
    };

    let queued_notebook_syncs = tokio::time::timeout(std::time::Duration::from_millis(24), async {
        let mut sync_payloads = Vec::new();
        loop {
            let frame = connection::recv_typed_frame(&mut client_reader)
                .await
                .expect("daemon frame read should succeed")
                .expect("daemon should keep bootstrap connection open");
            match frame.frame_type {
                NotebookFrameType::AutomergeSync => sync_payloads.push(frame.payload),
                NotebookFrameType::SessionControl => {
                    if decode_sync_status(&frame).is_some_and(|status| {
                        status.initial_load
                            == notebook_protocol::protocol::InitialLoadPhaseWire::Ready
                    }) {
                        return sync_payloads;
                    }
                }
                _ => {}
            }
        }
    })
    .await
    .expect("file load should reach Ready without waiting for 25ms streaming reply drains");

    assert_eq!(
        room.doc.read().await.cell_count(),
        11,
        "daemon doc should finish loading before any client sync reply"
    );

    let mut client_doc =
        notebook_doc::NotebookDoc::bootstrap(notebook_doc::TextEncoding::Utf16CodeUnit, "mcp:test");
    let mut client_state = sync::State::new();
    for payload in queued_notebook_syncs {
        let message = sync::Message::decode(&payload).expect("valid sync message");
        client_doc
            .receive_sync_message_recovering(&mut client_state, message, "test-no-reply-sync")
            .unwrap();
    }

    if let Some(reply) = client_doc
        .generate_sync_message_recovering(&mut client_state, "test-delayed-reply")
        .unwrap()
    {
        connection::send_typed_frame(
            &mut client_writer,
            NotebookFrameType::AutomergeSync,
            &reply.encode(),
        )
        .await
        .unwrap();
    }

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while client_doc.cell_count() < 11 {
            let frame = connection::recv_typed_frame(&mut client_reader)
                .await
                .expect("daemon frame read should succeed")
                .expect("daemon should keep connection open until convergence");
            if frame.frame_type != NotebookFrameType::AutomergeSync {
                continue;
            }

            let message = sync::Message::decode(&frame.payload).expect("valid sync message");
            client_doc
                .receive_sync_message_recovering(
                    &mut client_state,
                    message,
                    "test-delayed-convergence-sync",
                )
                .unwrap();
            if let Some(reply) = client_doc
                .generate_sync_message_recovering(
                    &mut client_state,
                    "test-delayed-convergence-reply",
                )
                .unwrap()
            {
                connection::send_typed_frame(
                    &mut client_writer,
                    NotebookFrameType::AutomergeSync,
                    &reply.encode(),
                )
                .await
                .unwrap();
            }
        }
    })
    .await
    .expect("client should converge after its delayed sync reply");

    assert_eq!(client_doc.cell_count(), 11);

    drop(client_writer);
    drop(client_reader);
    server_task.abort();
    let _ = server_task.await;
}

fn test_trusted_packages() -> crate::trusted_packages::TrustedPackageStore {
    crate::trusted_packages::TrustedPackageStore::unavailable("test")
}

fn legacy_pre_seed_v4_doc_bytes(notebook_id: &str, actor: &str, cell_id: &str) -> Vec<u8> {
    let mut doc = AutoCommit::new_with_encoding(notebook_doc::TextEncoding::UnicodeCodePoint);
    doc.set_actor(ActorId::from(actor.as_bytes()));
    doc.put(
        automerge::ROOT,
        "schema_version",
        notebook_doc::SCHEMA_VERSION,
    )
    .unwrap();
    doc.put(automerge::ROOT, "notebook_id", notebook_id)
        .unwrap();

    let cells = doc
        .put_object(automerge::ROOT, "cells", ObjType::Map)
        .unwrap();
    let metadata = doc
        .put_object(automerge::ROOT, "metadata", ObjType::Map)
        .unwrap();
    doc.put(&metadata, "legacy_marker", "preserved").unwrap();

    let cell = doc.put_object(&cells, cell_id, ObjType::Map).unwrap();
    doc.put(&cell, "id", cell_id).unwrap();
    doc.put(&cell, "cell_type", "code").unwrap();
    doc.put(&cell, "position", "80").unwrap();
    let source = doc.put_object(&cell, "source", ObjType::Text).unwrap();
    doc.splice_text(&source, 0, 0, "print('legacy')").unwrap();
    doc.put(&cell, "execution_count", "null").unwrap();
    doc.put_object(&cell, "metadata", ObjType::Map).unwrap();
    doc.put_object(&cell, "resolved_assets", ObjType::Map)
        .unwrap();
    doc.put_object(&cell, "attachments", ObjType::Map).unwrap();

    doc.save()
}

#[tokio::test]
async fn notebook_room_has_uuid_id_populated() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let uuid = uuid::Uuid::new_v4();
    let room = NotebookRoom::new_fresh(
        uuid,
        None, // untitled
        tmp.path(),
        blob_store,
        false, // ephemeral
    );
    assert_eq!(room.id, uuid);
}

#[tokio::test]
async fn untitled_room_has_path_none() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(Uuid::new_v4(), None, tmp.path(), blob_store, false);
    assert!(room.file_binding.path().await.is_none());
}

#[tokio::test]
async fn file_backed_room_has_path_some() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let fake_path = tmp.path().join("note.ipynb");
    let room = NotebookRoom::new_fresh(
        Uuid::new_v4(),
        Some(fake_path.clone()),
        tmp.path(),
        blob_store,
        false,
    );
    assert_eq!(
        room.file_binding.path().await.as_deref(),
        Some(fake_path.as_path())
    );
}

#[tokio::test]
async fn reservation_guard_increments_and_decrements_counter() {
    use std::sync::atomic::Ordering;

    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let room = Arc::new(NotebookRoom::new_fresh(
        Uuid::new_v4(),
        None,
        tmp.path(),
        blob_store,
        false,
    ));

    assert_eq!(room.connections.reservations.load(Ordering::Relaxed), 0);

    let guard = ReservationGuard::new(room.clone());
    assert_eq!(room.connections.reservations.load(Ordering::Relaxed), 1);

    drop(guard);
    assert_eq!(room.connections.reservations.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn reservation_guards_stack() {
    use std::sync::atomic::Ordering;

    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let room = Arc::new(NotebookRoom::new_fresh(
        Uuid::new_v4(),
        None,
        tmp.path(),
        blob_store,
        false,
    ));

    let g1 = ReservationGuard::new(room.clone());
    let g2 = ReservationGuard::new(room.clone());
    let g3 = ReservationGuard::new(room.clone());
    assert_eq!(room.connections.reservations.load(Ordering::Relaxed), 3);

    drop(g2);
    assert_eq!(room.connections.reservations.load(Ordering::Relaxed), 2);

    drop(g1);
    drop(g3);
    assert_eq!(room.connections.reservations.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn test_room_persists_and_reloads() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    // Fixed UUID so the reloaded untitled room finds the persisted doc.
    let uuid = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440002").unwrap();

    // Create an untitled room and add a cell
    {
        let room = NotebookRoom::new_fresh(uuid, None, tmp.path(), blob_store.clone(), false);
        let mut doc = room.doc.try_write().unwrap();
        doc.add_cell(0, "c1", "code").unwrap();
        doc.update_source("c1", "hello").unwrap();
        let bytes = doc.save();
        persist_notebook_bytes(&bytes, &room.identity.persist_path);
    }

    // Reload the untitled room; the persisted cell must survive
    {
        let room = NotebookRoom::new_fresh(uuid, None, tmp.path(), blob_store, false);
        let doc = room.doc.try_read().unwrap();
        assert_eq!(doc.cell_count(), 1);
        let cell = doc.get_cell("c1").unwrap();
        assert_eq!(cell.source, "hello");
    }
}

#[tokio::test]
async fn test_get_or_create_room_reuses_existing() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let uuid1 = Uuid::new_v4();

    let (room1, _g1) = get_or_create_room(
        &rooms,
        uuid1,
        RoomCreationOptions {
            path: None,
            initial_load_execution_store_dir: None,
            docs_dir: tmp.path(),
            blob_store: blob_store.clone(),
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;
    let (room2, _g2) = get_or_create_room(
        &rooms,
        uuid1,
        RoomCreationOptions {
            path: None,
            initial_load_execution_store_dir: None,
            docs_dir: tmp.path(),
            blob_store,
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;

    // Should be the same Arc (same room)
    assert!(Arc::ptr_eq(&room1, &room2));
}

#[tokio::test]
async fn file_load_is_pending_before_room_becomes_observable() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let uuid = Uuid::new_v4();
    let path = tmp.path().join("pending.ipynb");

    let (room, _guard) = get_or_create_room(
        &rooms,
        uuid,
        RoomCreationOptions {
            path: Some(path.clone()),
            initial_load_execution_store_dir: Some(tmp.path()),
            docs_dir: tmp.path(),
            blob_store,
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;

    let visible = rooms
        .peek_uuid(uuid)
        .await
        .expect("room should be registered");
    assert!(Arc::ptr_eq(&room, &visible));
    match visible.initial_load.state() {
        RoomInitialLoadState::Loading { generation: 1 } => assert!(
            visible.initial_load.task_claimed_for_test(),
            "a registry-visible Loading generation must already have an owner"
        ),
        RoomInitialLoadState::Ready { generation: 1, .. }
        | RoomInitialLoadState::Failed { generation: 1, .. } => {
            // The room-owned task may settle before this test observes it.
        }
        state => panic!("unexpected initial-load state after publication: {state:?}"),
    }
    assert!(
        visible.connections.last_kernel_torn_down_at().is_some(),
        "a never-attached file room must enter the peerless reaper lifecycle"
    );
}

#[tokio::test]
async fn published_room_source_claim_cancellation_terminalizes_projection_waits() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let uuid = Uuid::new_v4();
    let path = tmp.path().join("cancelled-before-spawn.ipynb");
    let room = Arc::new(NotebookRoom::new_fresh(
        uuid,
        Some(path.clone()),
        tmp.path(),
        blob_store,
        false,
    ));

    room.initial_load.mark_required();
    let claim = claim_room_initial_load(&room, path.clone())
        .expect("source generation should be claimed before publication");
    rooms
        .insert_or_get(uuid, Arc::clone(&room), Some(&path))
        .await
        .expect("publish claimed room");

    // Model cancellation in the narrow registry-publication-to-task-spawn
    // window. The ownership token's Drop path must publish a terminal state.
    drop(claim);

    assert!(matches!(
        room.initial_load.state(),
        RoomInitialLoadState::Failed { generation: 1, .. }
    ));
    let waited = room
        .lifecycle
        .wait_for_projection_ready(std::time::Duration::from_secs(1))
        .await;
    assert!(matches!(
        waited,
        RoomWaitResult::Current(RoomAvailability::Degraded(_))
    ));
}

#[tokio::test]
async fn matching_recovery_journal_restores_room_without_source_regeneration() {
    let tmp = tempfile::TempDir::new().unwrap();
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let path = tmp.path().join("matching-recovery.ipynb");
    write_numbered_notebook(&path, 1).await;
    let id = Uuid::new_v4();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(
        id,
        Some(path.clone()),
        &docs_dir,
        Arc::clone(&blob_store),
        false,
    );
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "recovered-cell", "code").unwrap();
        doc.update_source("recovered-cell", "journal_value = 1")
            .unwrap();
    }
    commit_test_room_source(&room).await;
    let journal_path = room.durability.journal().unwrap().path().to_path_buf();
    let journal_before = std::fs::read(&journal_path).unwrap();
    drop(room);

    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let (recovered, _guard) = get_or_create_room(
        &rooms,
        id,
        RoomCreationOptions {
            path: Some(path),
            initial_load_execution_store_dir: Some(tmp.path()),
            docs_dir: &docs_dir,
            blob_store,
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;
    let settled = recovered
        .lifecycle
        .wait_for_source_settled(std::time::Duration::from_secs(5))
        .await
        .into_current();
    assert!(matches!(settled, RoomSourceState::Ready(_)));
    assert_eq!(recovered.doc.read().await.cell_count(), 1);
    assert_eq!(
        recovered.doc.read().await.get_cell_source("recovered-cell"),
        Some("journal_value = 1".to_string())
    );
    assert!(matches!(
        recovered.lifecycle.availability(),
        RoomAvailability::Interactive(_)
    ));
    assert_eq!(std::fs::read(&journal_path).unwrap(), journal_before);
}

#[tokio::test]
async fn idless_durably_staged_recovery_rebuilds_sidecars_with_stable_identities() {
    let tmp = tempfile::TempDir::new().unwrap();
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let path = tmp.path().join("staged-sidecars.ipynb");
    let source = br#"{
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [{
            "cell_type": "code",
            "metadata": {},
            "execution_count": 1,
            "outputs": [{"output_type":"stream","name":"stdout","text":["hello\n"]}],
            "source": ["print('hello')\n"]
        }]
    }"#;
    tokio::fs::write(&path, source).await.unwrap();
    let id = Uuid::new_v4();
    let legacy_cell_id = Uuid::new_v5(&id, b"nteract:legacy-nbformat-cell:0").to_string();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(
        id,
        Some(path.clone()),
        &docs_dir,
        Arc::clone(&blob_store),
        false,
    );
    let fingerprint = super::recovery::source_fingerprint(source);
    let (snapshot, heads, hashes) = {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, &legacy_cell_id, "code").unwrap();
        doc.update_source(&legacy_cell_id, "print('hello')\n")
            .unwrap();
        doc.set_execution_id(&legacy_cell_id, Some("staged-execution-id"))
            .unwrap();
        let heads = doc.get_heads().iter().map(|head| head.0).collect();
        let hashes = doc
            .doc_mut()
            .get_changes(&[])
            .iter()
            .map(|change| change.hash().0)
            .collect();
        (doc.save(), heads, hashes)
    };
    room.durability
        .commit_snapshot(
            &snapshot,
            heads,
            super::durability::DurableMutation::Source {
                generation: 1,
                fingerprint,
                staged_change_hashes: hashes,
            },
        )
        .unwrap();
    assert_eq!(
        room.durability.status().source_phase,
        super::recovery::RecoverySourcePhase::DurablyStaged
    );
    drop(room);

    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let (recovered, _guard) = get_or_create_room(
        &rooms,
        id,
        RoomCreationOptions {
            path: Some(path),
            initial_load_execution_store_dir: Some(tmp.path()),
            docs_dir: &docs_dir,
            blob_store,
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;
    let settled = recovered
        .lifecycle
        .wait_for_source_settled(std::time::Duration::from_secs(5))
        .await
        .into_current();
    assert!(matches!(settled, RoomSourceState::Ready(_)));
    assert_eq!(
        recovered
            .doc
            .read()
            .await
            .get_execution_id(&legacy_cell_id)
            .as_deref(),
        Some("staged-execution-id")
    );
    let execution = recovered
        .state
        .read(|state| state.get_execution("staged-execution-id"))
        .unwrap();
    assert!(execution.is_some(), "recovery must rebuild RuntimeState");
    let outputs = recovered
        .state
        .read(|state| state.get_outputs("staged-execution-id"))
        .unwrap();
    assert!(!outputs.is_empty(), "recovery must rebuild source outputs");
    assert_eq!(
        recovered.durability.status().source_phase,
        super::recovery::RecoverySourcePhase::Ready
    );
}

#[tokio::test]
async fn fresh_projection_captures_imported_runtime_sidecar_heads() {
    let tmp = tempfile::TempDir::new().unwrap();
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let path = tmp.path().join("fresh-projection-sidecars.ipynb");
    let source = br#"{
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [{
            "id": "projected-sidecar",
            "cell_type": "code",
            "metadata": {},
            "execution_count": 7,
            "outputs": [{"output_type":"stream","name":"stdout","text":["hello\n"]}],
            "source": ["print('hello')\n"]
        }]
    }"#;
    tokio::fs::write(&path, source).await.unwrap();
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let (room, _guard) = get_or_create_room(
        &rooms,
        Uuid::new_v4(),
        RoomCreationOptions {
            path: Some(path),
            initial_load_execution_store_dir: Some(tmp.path()),
            docs_dir: &docs_dir,
            blob_store: test_blob_store(&tmp),
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;
    let settled = room
        .lifecycle
        .wait_for_source_settled(std::time::Duration::from_secs(5))
        .await
        .into_current();
    assert!(matches!(settled, RoomSourceState::Ready(_)));

    let projection = room
        .lifecycle
        .projection(1)
        .expect("Ready generation must retain its prepared projection");
    let runtime_heads = room
        .state
        .with_doc(|state| {
            Ok(state
                .get_heads()
                .into_iter()
                .map(|head| head.to_string())
                .collect::<Vec<_>>())
        })
        .unwrap();
    assert_eq!(projection.runtime_state_heads, runtime_heads);
    let cell = projection
        .cells
        .iter()
        .find(|cell| cell.id == "projected-sidecar")
        .expect("projection should retain the imported cell");
    assert!(cell.execution_id.is_some());
    assert_eq!(cell.execution_count, Some(7));
}

#[tokio::test]
async fn peer_only_pending_recovery_never_regenerates_or_reports_ready() {
    let tmp = tempfile::TempDir::new().unwrap();
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let path = tmp.path().join("peer-only-pending.ipynb");
    write_numbered_notebook(&path, 1).await;
    let id = Uuid::new_v4();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(
        id,
        Some(path.clone()),
        &docs_dir,
        Arc::clone(&blob_store),
        false,
    );
    let changes = {
        let mut doc = room.doc.write().await;
        let before = doc.get_heads();
        doc.add_cell(0, "offline-peer-cell", "code").unwrap();
        doc.update_source("offline-peer-cell", "peer_truth = 1")
            .unwrap();
        doc.doc_mut().get_changes(&before)
    };
    room.durability.commit_peer_changes(changes).unwrap();
    drop(room);

    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let (recovered, _guard) = get_or_create_room(
        &rooms,
        id,
        RoomCreationOptions {
            path: Some(path),
            initial_load_execution_store_dir: Some(tmp.path()),
            docs_dir: &docs_dir,
            blob_store,
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;
    assert!(matches!(
        recovered.lifecycle.source_state(),
        RoomSourceState::Failed(ref status)
            if status.error.as_ref().is_some_and(|error| error.code == "source_degraded")
    ));
    assert!(matches!(
        recovered.lifecycle.availability(),
        RoomAvailability::Degraded(_)
    ));
    assert_eq!(
        recovered
            .doc
            .read()
            .await
            .get_cell_source("offline-peer-cell")
            .as_deref(),
        Some("peer_truth = 1")
    );
}

#[tokio::test]
async fn pending_recovery_without_peer_changes_safely_imports_disk() {
    let tmp = tempfile::TempDir::new().unwrap();
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let path = tmp.path().join("pending-safe-reload.ipynb");
    write_numbered_notebook(&path, 1).await;
    let id = Uuid::new_v4();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(
        id,
        Some(path.clone()),
        &docs_dir,
        Arc::clone(&blob_store),
        false,
    );
    let (snapshot, heads) = {
        let mut doc = room.doc.write().await;
        (
            doc.save(),
            doc.get_heads().iter().map(|head| head.0).collect(),
        )
    };
    room.durability
        .commit_snapshot(&snapshot, heads, super::durability::DurableMutation::Daemon)
        .unwrap();
    assert_eq!(
        room.durability.status().source_phase,
        super::recovery::RecoverySourcePhase::Pending
    );
    drop(room);

    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let (recovered, _guard) = get_or_create_room(
        &rooms,
        id,
        RoomCreationOptions {
            path: Some(path),
            initial_load_execution_store_dir: Some(tmp.path()),
            docs_dir: &docs_dir,
            blob_store,
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;
    let settled = recovered
        .lifecycle
        .wait_for_source_settled(std::time::Duration::from_secs(5))
        .await
        .into_current();
    assert!(matches!(settled, RoomSourceState::Ready(_)));
    assert_eq!(recovered.doc.read().await.cell_count(), 1);
    assert_eq!(
        recovered.durability.status().source_phase,
        super::recovery::RecoverySourcePhase::Ready
    );
}

#[tokio::test]
async fn recovery_source_fingerprint_mismatch_preserves_both_and_degrades() {
    let tmp = tempfile::TempDir::new().unwrap();
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let path = tmp.path().join("conflicted-recovery.ipynb");
    write_numbered_notebook(&path, 1).await;
    let id = Uuid::new_v4();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(
        id,
        Some(path.clone()),
        &docs_dir,
        Arc::clone(&blob_store),
        false,
    );
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "journal-cell", "code").unwrap();
        doc.update_source("journal-cell", "journal_truth = 1")
            .unwrap();
    }
    commit_test_room_source(&room).await;
    let journal_path = room.durability.journal().unwrap().path().to_path_buf();
    let journal_before = std::fs::read(&journal_path).unwrap();
    let external_revision = br#"{"nbformat":4,"nbformat_minor":5,"metadata":{},"cells":[{"id":"disk-cell","cell_type":"code","metadata":{},"execution_count":null,"outputs":[],"source":["disk_truth = 2\n"]}]}"#;
    tokio::fs::write(&path, external_revision).await.unwrap();
    drop(room);

    let recovered = NotebookRoom::new_fresh(id, Some(path.clone()), &docs_dir, blob_store, false);
    assert_eq!(recovered.doc.read().await.cell_count(), 1);
    assert_eq!(
        recovered.doc.read().await.get_cell_source("journal-cell"),
        Some("journal_truth = 1".to_string())
    );
    assert!(matches!(
        recovered.lifecycle.source_state(),
        RoomSourceState::Failed(ref status)
            if status.error.as_ref().is_some_and(|error| error.code == "source_conflict")
    ));
    assert!(matches!(
        recovered.lifecycle.availability(),
        RoomAvailability::Degraded(_)
    ));
    assert_eq!(tokio::fs::read(&path).await.unwrap(), external_revision);
    assert_eq!(std::fs::read(&journal_path).unwrap(), journal_before);
}

#[tokio::test]
async fn room_restart_finalizes_checkpoint_when_intended_file_replacement_landed() {
    let tmp = tempfile::TempDir::new().unwrap();
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let path = tmp.path().join("checkpoint-replacement-landed.ipynb");
    write_numbered_notebook(&path, 1).await;
    let id = Uuid::new_v4();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(
        id,
        Some(path.clone()),
        &docs_dir,
        Arc::clone(&blob_store),
        false,
    );
    commit_test_room_source(&room).await;

    let mut intended_bytes = tokio::fs::read(&path).await.unwrap();
    intended_bytes.extend_from_slice(b"\n ");
    let intended_fingerprint = super::recovery::source_fingerprint(&intended_bytes);
    let manifest = room.durability.manifest();
    room.durability
        .prepare_file_checkpoint(
            path.clone(),
            intended_fingerprint,
            manifest.durable_heads,
            manifest.file_save_sequence.unwrap_or_default() + 1,
            None,
        )
        .unwrap();
    tokio::fs::write(&path, &intended_bytes).await.unwrap();
    drop(room);

    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let (recovered, _guard) = get_or_create_room(
        &rooms,
        id,
        RoomCreationOptions {
            path: Some(path),
            initial_load_execution_store_dir: Some(tmp.path()),
            docs_dir: &docs_dir,
            blob_store,
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;
    let recovered_manifest = recovered.durability.manifest();
    assert_eq!(recovered_manifest.source_fingerprint, intended_fingerprint);
    assert!(recovered_manifest.pending_file_checkpoint.is_none());
    assert!(!recovered.durability.status().is_degraded());
    let recovered_source = recovered
        .lifecycle
        .wait_for_source_settled(std::time::Duration::from_secs(5))
        .await
        .into_current();
    assert!(
        matches!(recovered_source, RoomSourceState::Ready(_)),
        "finalized checkpoint should restore Ready, got {recovered_source:?}"
    );
    assert!(recovered
        .state
        .read(|state| state.read_state().file_checkpoint.source_issue)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn room_restart_preserves_third_revision_as_source_conflict_not_journal_failure() {
    let tmp = tempfile::TempDir::new().unwrap();
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let path = tmp.path().join("checkpoint-third-revision.ipynb");
    write_numbered_notebook(&path, 1).await;
    let id = Uuid::new_v4();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(
        id,
        Some(path.clone()),
        &docs_dir,
        Arc::clone(&blob_store),
        false,
    );
    commit_test_room_source(&room).await;

    let old_bytes = tokio::fs::read(&path).await.unwrap();
    let mut intended_bytes = old_bytes.clone();
    intended_bytes.extend_from_slice(b"\n ");
    let mut third_revision = old_bytes;
    third_revision.extend_from_slice(b"\n  ");
    let intended_fingerprint = super::recovery::source_fingerprint(&intended_bytes);
    let manifest = room.durability.manifest();
    room.durability
        .prepare_file_checkpoint(
            path.clone(),
            intended_fingerprint,
            manifest.durable_heads,
            manifest.file_save_sequence.unwrap_or_default() + 1,
            None,
        )
        .unwrap();
    tokio::fs::write(&path, &third_revision).await.unwrap();
    drop(room);

    let recovered = NotebookRoom::new_fresh(id, Some(path), &docs_dir, blob_store, false);
    assert!(matches!(
        recovered.lifecycle.source_state(),
        RoomSourceState::Failed(ref status)
            if status.error.as_ref().is_some_and(|error| error.code == "source_conflict")
    ));
    assert!(matches!(
        recovered.lifecycle.availability(),
        RoomAvailability::Degraded(_)
    ));
    assert!(recovered
        .durability
        .manifest()
        .pending_file_checkpoint
        .is_some());
    assert!(
        !recovered.durability.status().is_degraded(),
        "a third source revision is a reconciliation conflict, not failed journal durability"
    );
}

/// A source file missing at restart proves neither side of a pending
/// replacement. The room short-circuits before
/// `resolve_recovered_file_checkpoint` is ever called: the read error becomes
/// a startup source conflict, the pending intent and every checkpoint field
/// survive verbatim, and nothing is committed as if a side had been chosen.
#[tokio::test]
async fn room_restart_with_missing_source_file_preserves_intent_without_resolving() {
    let tmp = tempfile::TempDir::new().unwrap();
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let path = tmp.path().join("checkpoint-missing-file.ipynb");
    write_numbered_notebook(&path, 1).await;
    let id = Uuid::new_v4();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(
        id,
        Some(path.clone()),
        &docs_dir,
        Arc::clone(&blob_store),
        false,
    );
    commit_test_room_source(&room).await;

    let mut intended_bytes = tokio::fs::read(&path).await.unwrap();
    intended_bytes.extend_from_slice(b"\n ");
    let intended_fingerprint = super::recovery::source_fingerprint(&intended_bytes);
    let manifest = room.durability.manifest();
    room.durability
        .prepare_file_checkpoint(
            path.clone(),
            intended_fingerprint,
            manifest.durable_heads,
            manifest.file_save_sequence.unwrap_or_default() + 1,
            None,
        )
        .unwrap();
    let manifest_at_crash = room.durability.manifest();
    tokio::fs::remove_file(&path).await.unwrap();
    drop(room);

    let recovered = NotebookRoom::new_fresh(id, Some(path), &docs_dir, blob_store, false);
    assert!(matches!(
        recovered.lifecycle.source_state(),
        RoomSourceState::Failed(ref status)
            if status.error.as_ref().is_some_and(|error| error.code == "source_conflict")
    ));
    assert!(matches!(
        recovered.lifecycle.availability(),
        RoomAvailability::Degraded(_)
    ));
    let recovered_manifest = recovered.durability.manifest();
    assert_eq!(
        recovered_manifest.pending_file_checkpoint, manifest_at_crash.pending_file_checkpoint,
        "the resolver never runs on missing bytes: the intent survives verbatim"
    );
    assert_eq!(
        recovered_manifest.source_fingerprint, manifest_at_crash.source_fingerprint,
        "missing bytes must not be treated as the intended replacement"
    );
    assert_eq!(
        recovered_manifest.exported_heads,
        manifest_at_crash.exported_heads
    );
    assert_eq!(
        recovered_manifest.file_save_sequence,
        manifest_at_crash.file_save_sequence
    );
    assert_eq!(
        recovered_manifest.sequence, manifest_at_crash.sequence,
        "restart with unreadable source appends nothing"
    );
    assert!(
        !recovered.durability.status().is_degraded(),
        "a missing source file is a reconciliation conflict, not failed journal durability"
    );
}

#[tokio::test]
async fn uuid_only_restart_attach_recovers_manifest_path_without_false_conflict() {
    let tmp = tempfile::TempDir::new().unwrap();
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let path = tmp.path().join("uuid-recovery.ipynb");
    write_numbered_notebook(&path, 1).await;
    let id = Uuid::new_v4();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(
        id,
        Some(path.clone()),
        &docs_dir,
        Arc::clone(&blob_store),
        false,
    );
    commit_test_room_source(&room).await;
    drop(room);

    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let (recovered, _guard) = get_or_create_room(
        &rooms,
        id,
        RoomCreationOptions {
            path: None,
            initial_load_execution_store_dir: Some(tmp.path()),
            docs_dir: &docs_dir,
            blob_store,
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;

    assert_eq!(
        recovered.file_binding.path().await.as_deref(),
        Some(path.as_path())
    );
    let settled = recovered
        .lifecycle
        .wait_for_source_settled(std::time::Duration::from_secs(5))
        .await
        .into_current();
    assert!(matches!(settled, RoomSourceState::Ready(_)));
    assert!(!matches!(
        recovered.lifecycle.source_state(),
        RoomSourceState::Failed(ref status)
            if status.error.as_ref().is_some_and(|error| error.code == "source_conflict")
    ));
}

#[tokio::test]
async fn test_get_or_create_room_different_notebooks() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let uuid1 = Uuid::new_v4();
    let uuid2 = Uuid::new_v4();

    let (room1, _g1) = get_or_create_room(
        &rooms,
        uuid1,
        RoomCreationOptions {
            path: None,
            initial_load_execution_store_dir: None,
            docs_dir: tmp.path(),
            blob_store: blob_store.clone(),
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;
    let (room2, _g2) = get_or_create_room(
        &rooms,
        uuid2,
        RoomCreationOptions {
            path: None,
            initial_load_execution_store_dir: None,
            docs_dir: tmp.path(),
            blob_store,
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;

    // Should be different rooms
    assert!(!Arc::ptr_eq(&room1, &room2));
    assert_eq!(rooms.len().await, 2);
}

#[tokio::test]
async fn test_room_peer_counting() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(Uuid::new_v4(), None, tmp.path(), blob_store, false);

    assert_eq!(room.connections.active_peers.load(Ordering::Relaxed), 0);

    room.connections
        .active_peers
        .fetch_add(1, Ordering::Relaxed);
    room.connections
        .active_peers
        .fetch_add(1, Ordering::Relaxed);
    assert_eq!(room.connections.active_peers.load(Ordering::Relaxed), 2);

    room.connections
        .active_peers
        .fetch_sub(1, Ordering::Relaxed);
    assert_eq!(room.connections.active_peers.load(Ordering::Relaxed), 1);

    room.connections
        .active_peers
        .fetch_sub(1, Ordering::Relaxed);
    assert_eq!(room.connections.active_peers.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn test_new_fresh_creates_empty_doc() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let uuid = Uuid::new_v4();
    let room = NotebookRoom::new_fresh(uuid, None, tmp.path(), blob_store, false);

    let doc = room.doc.try_read().unwrap();
    let notebook_id = uuid.to_string();
    let runtime_state_doc_id = notebook_doc::default_runtime_state_doc_id(&notebook_id);
    let comms_doc_id = notebook_doc::default_comms_doc_id(&notebook_id);
    assert_eq!(doc.notebook_id(), Some(notebook_id.clone()));
    assert_eq!(
        doc.runtime_state_doc_id(),
        Some(runtime_state_doc_id.clone())
    );
    assert_eq!(doc.comms_doc_id(), Some(comms_doc_id));
    assert_eq!(doc.cell_count(), 0);
    assert_eq!(room.connections.active_peers.load(Ordering::Relaxed), 0);
    drop(doc);

    let runtime_state = room.state.read(|doc| doc.read_state()).unwrap();
    assert_eq!(
        runtime_state.runtime_state_doc_id.as_deref(),
        Some(runtime_state_doc_id.as_str())
    );
}

#[tokio::test]
async fn test_new_fresh_preserves_but_ignores_legacy_persisted_doc_for_file_path() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);

    // Use a fixed UUID so we can find the persist file again.
    let uuid = Uuid::parse_str("aaaaaaaa-bbbb-cccc-dddd-111111111111").unwrap();

    // Fabricate the legacy UUID-keyed persisted doc a prior session would
    // have left on disk.
    let filename = notebook_doc_filename(&uuid.to_string());
    let persist_path = tmp.path().join(&filename);
    {
        let mut doc = notebook_doc::NotebookDoc::new_with_actor(&uuid.to_string(), "runtimed");
        doc.add_cell(0, "c1", "code").unwrap();
        doc.update_source("c1", "old content").unwrap();
        persist_notebook_bytes(&doc.save(), &persist_path);
    }
    assert!(persist_path.exists(), "Persisted file should exist");

    // Create a file-backed room. Legacy UUID-keyed persistence is not recovery
    // authority for a file-backed room, but it is preserved for explicit
    // inspection instead of being deleted as a side effect of opening.
    let fake_ipynb = tmp.path().join("stale-test.ipynb");
    let room = NotebookRoom::new_fresh(uuid, Some(fake_ipynb), tmp.path(), blob_store, false);

    // Legacy bytes remain intact while the live room starts from canonical
    // genesis and will establish its recovery journal during source staging.
    assert!(
        persist_path.exists(),
        "opening a file-backed room must not delete legacy recovery bytes"
    );

    // Room should be empty (no cells from persisted doc)
    let doc = room.doc.try_read().unwrap();
    assert_eq!(doc.cell_count(), 0, "new_fresh should start with empty doc");
}

#[tokio::test]
async fn test_file_backed_room_ignores_and_preserves_legacy_history_before_ipynb_import() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let uuid = Uuid::parse_str("bbbbbbbb-cccc-dddd-eeee-222222222222").unwrap();
    let actor = "legacy-runtimed";

    let filename = notebook_doc_filename(&uuid.to_string());
    let persist_path = tmp.path().join(&filename);
    let legacy_bytes = legacy_pre_seed_v4_doc_bytes(&uuid.to_string(), actor, "legacy-cell");
    persist_notebook_bytes(&legacy_bytes, &persist_path);
    assert!(persist_path.exists(), "legacy persisted doc should exist");

    let notebook_path = tmp.path().join("source-of-truth.ipynb");
    std::fs::write(
        &notebook_path,
        r#"{
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {},
            "cells": [
                {
                    "id": "ipynb-cell",
                    "cell_type": "code",
                    "source": "print('ipynb')",
                    "execution_count": null,
                    "metadata": {},
                    "outputs": []
                }
            ]
        }"#,
    )
    .unwrap();

    let (room, _guard, settled) =
        materialized_room_from_disk_with(uuid, tmp.path(), blob_store, &notebook_path, tmp.path())
            .await;
    assert_source_ready(&settled);

    assert!(
        persist_path.exists(),
        "file-backed rooms preserve stale UUID-keyed history for manual recovery"
    );

    let mut doc = room.doc.write().await;
    let actors = doc.contributing_actors();
    assert!(
        actors.contains(&SCHEMA_SEED_ACTOR_LABEL.to_string()),
        "file-backed rooms should start from canonical seed history"
    );
    assert!(
        !actors.contains(&actor.to_string()),
        "stale legacy persisted actor must not contribute to file-backed rooms"
    );

    assert_eq!(doc.cell_count(), 1);
    let cells = doc.get_cells();
    assert_eq!(cells[0].id, "ipynb-cell");
    assert_eq!(cells[0].source, "print('ipynb')");
    assert!(doc.get_cell("legacy-cell").is_none());
}

#[tokio::test]
async fn test_new_fresh_loads_persisted_doc_for_untitled_notebook() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);

    // Use a fixed UUID (untitled notebook — path=None)
    let uuid = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();

    // Fabricate the persisted untitled doc a prior session would have left
    // on disk.
    let filename = notebook_doc_filename(&uuid.to_string());
    let persist_path = tmp.path().join(&filename);
    {
        let mut doc = notebook_doc::NotebookDoc::new_with_actor(&uuid.to_string(), "runtimed");
        doc.add_cell(0, "c1", "code").unwrap();
        doc.update_source("c1", "restored content").unwrap();
        persist_notebook_bytes(&doc.save(), &persist_path);
    }
    assert!(persist_path.exists(), "Persisted file should exist");

    // Create fresh room for untitled notebook (path=None) — should load persisted doc
    let room = NotebookRoom::new_fresh(uuid, None, tmp.path(), blob_store, false);

    // Persisted file should still exist (not deleted)
    assert!(
        persist_path.exists(),
        "Persisted file should NOT be deleted for untitled notebooks"
    );

    // Room should have the persisted content
    let doc = room.doc.try_read().unwrap();
    assert_eq!(
        doc.cell_count(),
        1,
        "new_fresh should load persisted doc for untitled notebooks"
    );
    let cells = doc.get_cells();
    assert_eq!(cells[0].source, "restored content");
}

#[tokio::test]
async fn persistent_untitled_peer_change_is_journaled_and_survives_restart() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let uuid = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440001").unwrap();

    let room = NotebookRoom::new_fresh(uuid, None, tmp.path(), blob_store.clone(), false);
    assert!(
        room.durability.journal().is_some(),
        "persistent untitled rooms must acknowledge edits through a recovery journal"
    );

    let committed_heads = {
        let mut doc = room.doc.write().await;
        let baseline_heads = doc.get_heads();
        let rollback_snapshot = doc.save();
        let rollback_actor = doc.get_actor_id();
        doc.add_cell(0, "journaled-cell", "code").unwrap();
        doc.update_source("journaled-cell", "durable = True")
            .unwrap();
        super::durability::commit_daemon_notebook_mutation(
            &room,
            &mut doc,
            &baseline_heads,
            &rollback_snapshot,
            &rollback_actor,
            "persistent untitled test mutation",
        )
        .unwrap();
        doc.get_heads()
    };
    let committed_manifest = room.durability.manifest();
    assert_eq!(
        committed_manifest.durable_heads,
        committed_heads
            .iter()
            .map(|head| head.0)
            .collect::<Vec<_>>()
    );
    assert!(room.durability.status().has_durable_record);
    drop(room);

    let recovered = NotebookRoom::new_fresh(uuid, None, tmp.path(), blob_store, false);
    assert_eq!(
        recovered.doc.read().await.get_cell_source("journaled-cell"),
        Some("durable = True".to_string())
    );
    assert_eq!(
        recovered.durability.manifest().durable_heads,
        committed_manifest.durable_heads,
        "restart must recover the exact acknowledged causal heads"
    );
    assert!(recovered.durability.status().has_durable_record);
    assert!(matches!(
        recovered.lifecycle.source_state(),
        RoomSourceState::Ready(ref status)
            if status.fingerprint == RoomSourceFingerprint::NotApplicable
    ));
    assert!(matches!(
        recovered.lifecycle.availability(),
        RoomAvailability::Interactive(_)
    ));
}

#[tokio::test]
async fn test_untitled_room_preserves_legacy_persisted_automerge_history() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let uuid = Uuid::parse_str("cccccccc-dddd-eeee-ffff-333333333333").unwrap();
    let actor = "legacy-runtimed";

    let filename = notebook_doc_filename(&uuid.to_string());
    let persist_path = tmp.path().join(&filename);
    let legacy_bytes = legacy_pre_seed_v4_doc_bytes(&uuid.to_string(), actor, "legacy-cell");
    persist_notebook_bytes(&legacy_bytes, &persist_path);

    let room = NotebookRoom::new_fresh(uuid, None, tmp.path(), blob_store, false);

    assert!(
        persist_path.exists(),
        "untitled rooms keep their persisted Automerge document as source of truth"
    );

    let mut doc = room.doc.try_write().unwrap();
    assert_eq!(doc.cell_count(), 1);
    assert_eq!(
        doc.get_cell("legacy-cell").unwrap().source,
        "print('legacy')"
    );
    assert_eq!(
        doc.get_metadata("legacy_marker"),
        Some("preserved".to_string())
    );

    let actors = doc.contributing_actors();
    assert!(
        actors.contains(&actor.to_string()),
        "untitled restore should preserve the legacy document actor/history"
    );
    assert!(
        !actors.contains(&SCHEMA_SEED_ACTOR_LABEL.to_string()),
        "loading existing untitled Automerge bytes must not rewrite history into the canonical seed"
    );
}

/// The headline `is_pristine` behavior: a notebook the user empties must not be
/// re-seeded on reconnect. A `cell_count() == 0` gate would re-seed here because
/// the emptied doc has zero cells; the causal `is_pristine` gate refuses because
/// the change graph still records the seed-then-delete history.
///
/// This mirrors the daemon's seeding gate (the three
/// `if doc.is_pristine() { create_empty_notebook(...) }` call sites) over the
/// same untitled room persist/reload harness as
/// `test_untitled_room_preserves_legacy_persisted_automerge_history`: an
/// untitled (path=None) room round-trips through persisted Automerge bytes, and
/// reconnect is `NotebookRoom::new_fresh` loading those bytes.
#[tokio::test]
async fn emptied_untitled_notebook_is_not_reseeded_on_reconnect() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);

    // Fixed UUID so the persisted untitled doc reloads on reconnect.
    let uuid = Uuid::parse_str("dddddddd-eeee-ffff-aaaa-444444444444").unwrap();

    // 1. First connect: a fresh untitled room is pristine, so the daemon seeds
    //    one starter cell via create_empty_notebook. 2. The user then deletes
    //    every cell, leaving cell_count == 0 but recording the cell + delete in
    //    history. Persist the emptied doc to disk.
    {
        let room = NotebookRoom::new_fresh(uuid, None, tmp.path(), blob_store.clone(), false);
        let mut doc = room.doc.try_write().unwrap();

        assert!(
            doc.is_pristine(),
            "a brand-new untitled room must be pristine so the daemon seeds it"
        );
        let seeded_cell = {
            // Mirror the daemon: only seed when pristine. create_empty_notebook
            // writes metadata + one code cell.
            create_empty_notebook(
                &mut doc,
                "python",
                crate::settings_doc::PythonEnvType::Uv,
                Some(&uuid.to_string()),
                None,
                &[],
            )
            .expect("seed empty notebook");
            doc.get_cells()[0].id.clone()
        };
        assert_eq!(doc.cell_count(), 1, "seeding adds one starter cell");
        assert!(
            !doc.is_pristine(),
            "a seeded notebook is no longer pristine"
        );

        doc.delete_cell(&seeded_cell).expect("delete cell");
        assert_eq!(doc.cell_count(), 0, "the user emptied the notebook");
        assert!(
            !doc.is_pristine(),
            "an emptied notebook still has cell history and must never re-seed"
        );

        let bytes = doc.save();
        persist_notebook_bytes(&bytes, &room.identity.persist_path);
    }

    // 3. Evict + reconnect: drop the room above and recreate the untitled room
    //    from the persisted bytes (the NotebookSync reconnect path).
    let room = NotebookRoom::new_fresh(uuid, None, tmp.path(), blob_store, false);
    let mut doc = room.doc.try_write().unwrap();

    // 4. The reconnect-side seeding gate must refuse to re-seed: the reloaded
    //    doc carries the seed-then-delete history, so is_pristine is false.
    assert!(
        !doc.is_pristine(),
        "a reloaded emptied notebook must not read as pristine on reconnect"
    );
    if doc.is_pristine() {
        // Mirror the daemon's gate so a regression that flips is_pristine back
        // to true would visibly re-seed and trip the assertion below.
        create_empty_notebook(
            &mut doc,
            "python",
            crate::settings_doc::PythonEnvType::Uv,
            Some(&uuid.to_string()),
            None,
            &[],
        )
        .expect("seed empty notebook");
    }
    assert_eq!(
        doc.cell_count(),
        0,
        "an emptied notebook must stay empty across reconnect — never re-seeded"
    );
}

/// Regression test for #1646: untitled notebooks must read trust from
/// the persisted Automerge doc, not from a non-existent .ipynb file.
#[tokio::test]
async fn test_new_fresh_untitled_trust_from_doc() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let store =
        crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
            .unwrap();

    let notebook_id = "550e8400-e29b-41d4-a716-446655440000";

    let snapshot = snapshot_with_uv(vec!["numpy".to_string()]);

    // Fabricate the persisted untitled doc carrying the trust metadata, as a
    // prior session would have left on disk.
    {
        let mut doc = notebook_doc::NotebookDoc::new_with_actor(notebook_id, "runtimed");
        doc.set_metadata_snapshot(&snapshot).unwrap();
        persist_notebook_bytes(
            &doc.save(),
            &tmp.path().join(notebook_doc_filename(notebook_id)),
        );
    }

    // Approve the dep in the allowlist; trust now lives there, not in
    // a per-machine signature embedded in the doc. The next room
    // creation should read the persisted doc and resolve to Trusted via
    // allowlist lookup.
    let info = runt_trust::extract_trust_info(&snapshot_metadata_hashmap(&snapshot));
    store.add_from_info(&info, "test").unwrap();

    let notebook_uuid = Uuid::parse_str(notebook_id).unwrap();
    let room = NotebookRoom::new_fresh_with_trusted_packages(
        notebook_uuid,
        None,
        tmp.path(),
        blob_store,
        false,
        store,
    )
    .unwrap();

    let ts = room.trust_state.try_read().unwrap();
    assert_eq!(
        ts.status,
        runt_trust::TrustStatus::Trusted,
        "Allowlist-approved deps should resolve to Trusted across daemon restart"
    );
}

/// Auto-trust path for MCP `create_notebook` with explicit deps. Seeding
/// the doc-declared deps into the allowlist must promote the room from
/// Untrusted → Trusted on the next `check_and_update_trust_state`, so the
/// auto-launch path can fire without a human-in-the-loop trust dialog.
#[tokio::test]
async fn test_seed_trust_from_doc_metadata_promotes_to_trusted() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let store =
        crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
            .unwrap();

    let notebook_uuid = Uuid::new_v4();
    let room = Arc::new(
        NotebookRoom::new_fresh_with_trusted_packages(
            notebook_uuid,
            None,
            tmp.path(),
            blob_store,
            true,
            store,
        )
        .unwrap(),
    );

    // Populate the doc with explicit deps (mirrors create_empty_notebook).
    let snapshot = snapshot_with_uv(vec!["pandas".to_string(), "scipy".to_string()]);
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot).unwrap();
    }

    // Before seeding: trust check on the doc's deps must fail.
    let pre_info = runt_trust::extract_trust_info(&snapshot_metadata_hashmap(&snapshot));
    assert!(
        !room
            .trusted_packages
            .all_dependencies_approved(&pre_info)
            .unwrap(),
        "fresh store should not approve un-seeded deps"
    );

    crate::notebook_sync_server::seed_trust_from_doc_metadata(&room, "mcp_create_notebook").await;

    // After seeding: same deps must approve, and re-verifying from snapshot
    // resolves to Trusted.
    let post_info = runt_trust::extract_trust_info(&snapshot_metadata_hashmap(&snapshot));
    assert!(
        room.trusted_packages
            .all_dependencies_approved(&post_info)
            .unwrap(),
        "deps must approve after seed_trust_from_doc_metadata"
    );
    let verified =
        crate::notebook_sync_server::verify_trust_from_snapshot(&snapshot, &room.trusted_packages);
    assert_eq!(verified.status, runt_trust::TrustStatus::Trusted);
}

/// No-op path: a freshly created notebook with no declared deps must not
/// touch the allowlist when seeded. NoDependencies short-circuits before
/// the store write so a brand-new untitled notebook doesn't get a
/// phantom "mcp_create_notebook" trust row.
#[tokio::test]
async fn test_seed_trust_from_doc_metadata_skips_when_no_deps() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let store =
        crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
            .unwrap();

    let notebook_uuid = Uuid::new_v4();
    let room = Arc::new(
        NotebookRoom::new_fresh_with_trusted_packages(
            notebook_uuid,
            None,
            tmp.path(),
            blob_store,
            true,
            store,
        )
        .unwrap(),
    );

    let snapshot = snapshot_with_uv(vec![]);
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot).unwrap();
    }

    crate::notebook_sync_server::seed_trust_from_doc_metadata(&room, "mcp_create_notebook").await;

    // An unrelated dep must still not approve — the seed call should have
    // been a no-op.
    let probe = runt_trust::TrustInfo {
        status: runt_trust::TrustStatus::Untrusted,
        uv_dependencies: vec!["pandas".to_string()],
        approved_uv_dependencies: vec![],
        conda_dependencies: vec![],
        approved_conda_dependencies: vec![],
        conda_channels: vec![],
        approved_conda_channels: vec![],
        pixi_dependencies: vec![],
        approved_pixi_dependencies: vec![],
        pixi_pypi_dependencies: vec![],
        approved_pixi_pypi_dependencies: vec![],
        pixi_channels: vec![],
        approved_pixi_channels: vec![],
    };
    assert!(!room
        .trusted_packages
        .all_dependencies_approved(&probe)
        .unwrap());
}

#[tokio::test(start_paused = true)]
async fn test_ephemeral_room_skips_persistence() {
    let dir = tempfile::tempdir().unwrap();
    let blob_store = Arc::new(BlobStore::new(dir.path().join("blobs")));
    let notebook_uuid = uuid::Uuid::new_v4();
    let room = NotebookRoom::new_fresh(notebook_uuid, None, dir.path(), blob_store, true);

    assert!(!room.persistence.has_debouncer());
    assert!(room.file_binding.is_ephemeral());

    // No .automerge file should exist
    let filename = notebook_doc_filename(&notebook_uuid.to_string());
    assert!(!dir.path().join(&filename).exists());
}

#[tokio::test(start_paused = true)]
async fn test_session_room_persists() {
    let dir = tempfile::tempdir().unwrap();
    let blob_store = Arc::new(BlobStore::new(dir.path().join("blobs")));
    let notebook_uuid = uuid::Uuid::new_v4();
    let room = NotebookRoom::new_fresh(notebook_uuid, None, dir.path(), blob_store, false);

    assert!(room.persistence.has_debouncer());
    assert!(!room.file_binding.is_ephemeral());
}

#[tokio::test(start_paused = true)]
async fn test_ephemeral_room_has_metadata_flag() {
    let dir = tempfile::tempdir().unwrap();
    let blob_store = Arc::new(BlobStore::new(dir.path().join("blobs")));
    let notebook_uuid = uuid::Uuid::new_v4();
    let room = NotebookRoom::new_fresh(notebook_uuid, None, dir.path(), blob_store, true);

    let doc = room.doc.read().await;
    assert_eq!(doc.get_metadata("ephemeral"), Some("true".to_string()));
}

/// Helper to build a snapshot with UV inline deps.
fn snapshot_with_uv(deps: Vec<String>) -> NotebookMetadataSnapshot {
    NotebookMetadataSnapshot {
        kernelspec: None,
        language_info: None,
        runt: notebook_doc::metadata::RuntMetadata {
            schema_version: "1".to_string(),
            env_id: None,
            uv: Some(notebook_doc::metadata::UvInlineMetadata {
                dependencies: deps,
                requires_python: None,
                prerelease: None,
            }),
            conda: None,
            pixi: None,
            deno: None,
            extra: std::collections::BTreeMap::new(),
        },
        extras: std::collections::BTreeMap::new(),
    }
}

/// Helper to build a snapshot with conda inline deps.
fn snapshot_with_conda(deps: Vec<String>) -> NotebookMetadataSnapshot {
    NotebookMetadataSnapshot {
        kernelspec: None,
        language_info: None,
        runt: notebook_doc::metadata::RuntMetadata {
            schema_version: "1".to_string(),
            env_id: None,
            uv: None,
            conda: Some(notebook_doc::metadata::CondaInlineMetadata {
                dependencies: deps,
                channels: vec!["conda-forge".to_string()],
                python: None,
            }),
            pixi: None,
            deno: None,
            extra: std::collections::BTreeMap::new(),
        },
        extras: std::collections::BTreeMap::new(),
    }
}

/// Helper to build a snapshot with Pixi inline deps.
fn snapshot_with_pixi(deps: Vec<String>, pypi_deps: Vec<String>) -> NotebookMetadataSnapshot {
    NotebookMetadataSnapshot {
        kernelspec: None,
        language_info: None,
        runt: notebook_doc::metadata::RuntMetadata {
            schema_version: "1".to_string(),
            env_id: None,
            uv: None,
            conda: None,
            pixi: Some(notebook_doc::metadata::PixiInlineMetadata {
                dependencies: deps,
                pypi_dependencies: pypi_deps,
                channels: vec!["conda-forge".to_string()],
                python: None,
            }),
            deno: None,
            extra: std::collections::BTreeMap::new(),
        },
        extras: std::collections::BTreeMap::new(),
    }
}

/// Helper to build an empty snapshot (no deps).
fn snapshot_empty() -> NotebookMetadataSnapshot {
    NotebookMetadataSnapshot {
        kernelspec: None,
        language_info: None,
        runt: notebook_doc::metadata::RuntMetadata {
            schema_version: "1".to_string(),
            env_id: None,
            uv: None,
            conda: None,
            pixi: None,
            deno: None,
            extra: std::collections::BTreeMap::new(),
        },
        extras: std::collections::BTreeMap::new(),
    }
}

#[test]
fn test_check_inline_deps_uv() {
    use notebook_protocol::connection::{EnvSource, PackageManager};
    let snapshot = snapshot_with_uv(vec!["numpy".to_string()]);
    assert_eq!(
        check_inline_deps(&snapshot),
        Some(EnvSource::Inline(PackageManager::Uv))
    );
}

#[test]
fn test_check_inline_deps_conda() {
    use notebook_protocol::connection::{EnvSource, PackageManager};
    let snapshot = snapshot_with_conda(vec!["pandas".to_string()]);
    assert_eq!(
        check_inline_deps(&snapshot),
        Some(EnvSource::Inline(PackageManager::Conda))
    );
}

#[test]
fn test_check_inline_deps_empty() {
    let snapshot = snapshot_empty();
    assert_eq!(check_inline_deps(&snapshot), None);
}

#[test]
fn test_check_inline_deps_empty_array() {
    // Snapshot with empty deps array - should return None
    let snapshot = snapshot_with_uv(vec![]);
    assert_eq!(check_inline_deps(&snapshot), None);
}

#[test]
fn test_check_inline_deps_uv_priority() {
    // Snapshot with both UV and conda deps - UV takes priority
    let snapshot = NotebookMetadataSnapshot {
        kernelspec: None,
        language_info: None,
        runt: notebook_doc::metadata::RuntMetadata {
            schema_version: "1".to_string(),
            env_id: None,
            uv: Some(notebook_doc::metadata::UvInlineMetadata {
                dependencies: vec!["numpy".to_string()],
                requires_python: None,
                prerelease: None,
            }),
            conda: Some(notebook_doc::metadata::CondaInlineMetadata {
                dependencies: vec!["pandas".to_string()],
                channels: vec!["conda-forge".to_string()],
                python: None,
            }),
            pixi: None,
            deno: None,
            extra: std::collections::BTreeMap::new(),
        },
        extras: std::collections::BTreeMap::new(),
    };
    use notebook_protocol::connection::{EnvSource, PackageManager};
    assert_eq!(
        check_inline_deps(&snapshot),
        Some(EnvSource::Inline(PackageManager::Uv))
    );
}

#[test]
fn test_check_inline_deps_deno() {
    // Snapshot with deno config - deno takes priority over everything
    let snapshot = NotebookMetadataSnapshot {
        kernelspec: None,
        language_info: None,
        runt: notebook_doc::metadata::RuntMetadata {
            schema_version: "1".to_string(),
            env_id: None,
            uv: Some(notebook_doc::metadata::UvInlineMetadata {
                dependencies: vec!["numpy".to_string()],
                requires_python: None,
                prerelease: None,
            }),
            conda: None,
            pixi: None,
            deno: Some(notebook_doc::metadata::DenoMetadata {
                permissions: vec![],
                import_map: None,
                config: None,
                flexible_npm_imports: None,
            }),
            extra: std::collections::BTreeMap::new(),
        },
        extras: std::collections::BTreeMap::new(),
    };
    use notebook_protocol::connection::EnvSource;
    assert_eq!(check_inline_deps(&snapshot), Some(EnvSource::Deno));
}

// Runtime detection tests now live in notebook-doc/src/metadata.rs
// (NotebookMetadataSnapshot::detect_runtime) with comprehensive coverage.

// ── Integration tests for save_notebook_to_disk ────────────────────────

/// Create a test room with a path pointing to a file in temp dir.
fn test_room_with_path(
    tmp: &tempfile::TempDir,
    notebook_filename: &str,
) -> (NotebookRoom, PathBuf) {
    test_room_with_path_and_store(tmp, notebook_filename, test_trusted_packages())
}

fn test_room_with_path_and_store(
    tmp: &tempfile::TempDir,
    notebook_filename: &str,
    trusted_packages: crate::trusted_packages::TrustedPackageStore,
) -> (NotebookRoom, PathBuf) {
    let notebook_path = tmp.path().join(notebook_filename);
    let blob_store = test_blob_store(tmp);
    let notebook_id = notebook_path.to_string_lossy().to_string();

    let mut doc = notebook_doc::NotebookDoc::new(&notebook_id);
    let persist_path = tmp.path().join("doc.automerge");
    let (persist_tx, persist_rx) = watch::channel::<Option<Vec<u8>>>(None);
    let (flush_request_tx, flush_rx) = mpsc::unbounded_channel::<FlushRequest>();
    spawn_persist_debouncer(persist_rx, flush_rx, persist_path.clone());

    let (state_changed_tx, _) = broadcast::channel(16);
    let state = runtime_doc::RuntimeStateHandle::new(RuntimeStateDoc::new(), state_changed_tx);
    let (comms_changed_tx, _) = broadcast::channel(16);
    let comms = runtime_doc::CommsDocHandle::new(runtime_doc::CommsDoc::new(), comms_changed_tx);
    let room_id = uuid::Uuid::new_v4();
    let comments_store = comments_store::CommentsSidecarStore::for_notebook_docs_dir(
        &tmp.path().join("notebook-docs"),
    );
    let comments_locator = comments_store::comments_locator_for_room(room_id, Some(&notebook_path));
    let comments_doc_id = comments_store
        .resolve_doc_id(&comments_locator)
        .expect("seed comments document id");
    let comments_ref = comments_store::comments_ref_for_room(room_id, Some(&notebook_path));
    let comments = comments_store
        .load_or_create(&comments_doc_id, &comments_ref)
        .expect("create comments document");
    let document_head_hashes = doc.get_heads();
    let document_heads = document_head_hashes
        .iter()
        .map(ToString::to_string)
        .collect();
    let genesis_snapshot = doc.save();
    let durability = Arc::new(super::durability::RoomDurability::journaled(
        super::recovery::RecoveryJournal::new(persist_path.with_extension("recovery")),
        room_id,
        Some(notebook_path.clone()),
        super::recovery::source_fingerprint(&[]),
        0,
        genesis_snapshot.clone(),
    ));
    let lifecycle = RoomLifecycle::new(genesis_snapshot, document_heads);
    let room = NotebookRoom {
        id: room_id,
        doc: Arc::new(RwLock::new(doc)),
        broadcasts: RoomBroadcasts::default(),
        persistence: RoomPersistence::with_debouncer(persist_tx, flush_request_tx),
        initial_load: RoomInitialLoad::new(Arc::clone(&lifecycle)),
        lifecycle,
        durability,
        source_reconciliation_claimed: AtomicBool::new(false),
        file_binding: NotebookFileBinding::new(Some(notebook_path.clone()), false),
        identity: RoomIdentity::new(persist_path),
        connections: RoomConnections::default(),
        hosted: AtomicBool::new(false),
        blob_store,
        trust_state: Arc::new(RwLock::new(TrustState {
            status: runt_trust::TrustStatus::Untrusted,
            info: runt_trust::TrustInfo {
                status: runt_trust::TrustStatus::Untrusted,
                uv_dependencies: vec![],
                approved_uv_dependencies: vec![],
                conda_dependencies: vec![],
                approved_conda_dependencies: vec![],
                conda_channels: vec![],
                approved_conda_channels: vec![],
                pixi_dependencies: vec![],
                approved_pixi_dependencies: vec![],
                pixi_pypi_dependencies: vec![],
                approved_pixi_pypi_dependencies: vec![],
                pixi_channels: vec![],
                approved_pixi_channels: vec![],
            },
            pending_launch: false,
        })),
        trusted_packages,
        state,
        comms,
        comments,
        comments_store,
        runtime_agent_handle: Arc::new(Mutex::new(None)),
        runtime_agent_env_path: Arc::new(RwLock::new(None)),
        runtime_agent_launched_config: Arc::new(RwLock::new(None)),
        runtime_agent_request_tx: Arc::new(Mutex::new(None)),
        pending_runtime_agent_connect_tx: Arc::new(Mutex::new(None)),
        runtime_agent_generation: Arc::new(AtomicU64::new(0)),
        next_queue_seq: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        current_runtime_agent_id: Arc::new(RwLock::new(None)),
        auto_launch_gate: AutoLaunchGate::default(),
    };

    (room, notebook_path)
}

/// Materialize a room from an on-disk `.ipynb` through the production path:
/// `get_or_create_room` claims the source generation before registry
/// publication, and the room-owned task stages, journals, and publishes the
/// import. Returns the room, its reservation guard, and the settled source
/// state so callers can assert `Ready`/`Failed` and then read the doc,
/// RuntimeStateDoc, and CommsDoc exactly as production peers do.
async fn materialized_room_from_disk_with(
    uuid: Uuid,
    docs_dir: &Path,
    blob_store: Arc<BlobStore>,
    notebook_path: &Path,
    execution_store_dir: &Path,
) -> (Arc<NotebookRoom>, ReservationGuard, RoomSourceState) {
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let (room, guard) = get_or_create_room(
        &rooms,
        uuid,
        RoomCreationOptions {
            path: Some(notebook_path.to_path_buf()),
            initial_load_execution_store_dir: Some(execution_store_dir),
            docs_dir,
            blob_store,
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;
    let settled = room
        .lifecycle
        .wait_for_source_settled(std::time::Duration::from_secs(10))
        .await
        .into_current();
    (room, guard, settled)
}

/// [`materialized_room_from_disk_with`] with a fresh room UUID, the tempdir
/// as docs dir, its own blob store, and an execution store rooted in the
/// tempdir.
async fn materialized_room_from_disk(
    tmp: &tempfile::TempDir,
    notebook_path: &Path,
) -> (Arc<NotebookRoom>, ReservationGuard, RoomSourceState) {
    materialized_room_from_disk_with(
        Uuid::new_v4(),
        tmp.path(),
        test_blob_store(tmp),
        notebook_path,
        &tmp.path().join("execution-store"),
    )
    .await
}

/// Unwrap a settled source state that must be `Ready`.
fn assert_source_ready(settled: &RoomSourceState) {
    assert!(
        matches!(settled, RoomSourceState::Ready(_)),
        "initial materialization should settle Ready, got {settled:?}"
    );
}

#[tokio::test]
async fn file_backed_projection_read_requires_a_retained_artifact() {
    let tmp = tempfile::tempdir().unwrap();
    let (room, _) = test_room_with_path(&tmp, "projection-missing.ipynb");

    let error = build_notebook_projection(&room, 0)
        .await
        .expect_err("file-backed reads must not synthesize a live-doc projection");
    assert!(matches!(
        error,
        NotebookProjectionBuildError::NotRetained {
            generation: 0,
            document_readable: true,
            ..
        }
    ));
}

#[tokio::test]
async fn degraded_projection_read_returns_retained_generation_with_current_readiness() {
    let tmp = tempfile::tempdir().unwrap();
    let (room, _) = test_room_with_path(&tmp, "projection-degraded.ipynb");
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "retained-cell", "code").unwrap();
        doc.update_source("retained-cell", "print('retained')")
            .unwrap();
    }

    let projection = Arc::new(
        build_live_notebook_projection_for_generation(&room, 1)
            .await
            .unwrap(),
    );
    let retained_heads = projection.projection_heads.clone();
    room.lifecycle.complete_external_source_revision(
        1,
        super::recovery::source_fingerprint(b"generation one"),
        1,
        Arc::clone(&projection),
        projection.notebook_heads.clone(),
    );
    room.lifecycle.fail_reconciliation(
        2,
        super::recovery::source_fingerprint(b"generation two"),
        1,
        vec!["new-document-head".to_string()],
        "new source sidecar failed".to_string(),
    );

    let observed = build_notebook_projection(&room, 2).await.unwrap();
    assert_eq!(observed.load_generation, 1);
    assert_eq!(observed.projection_heads, retained_heads);
    assert_eq!(observed.cells[0].id, "retained-cell");
    assert_eq!(observed.source_state.generation, 2);
    assert_eq!(
        observed.source_state.phase,
        runtimed_client::protocol::NotebookSourcePhase::Failed
    );
    assert_eq!(observed.availability.generation, 2);
    assert_eq!(
        observed.availability.phase,
        runtimed_client::protocol::NotebookAvailabilityPhase::Degraded
    );
    assert!(observed.readiness.projection);
    assert!(observed.readiness.document);
    assert!(!observed.readiness.runtime);
}

/// Test fixtures mutate NotebookDoc directly instead of entering through the
/// peer/daemon mutation paths that journal before acknowledgement. Mirror that
/// production prerequisite before exercising the file checkpoint itself.
async fn commit_test_room_doc(room: &NotebookRoom) {
    let (snapshot, heads) = {
        let mut doc = room.doc.write().await;
        let heads = doc.get_heads().iter().map(|head| head.0).collect();
        (doc.save(), heads)
    };
    room.durability
        .commit_snapshot(&snapshot, heads, super::durability::DurableMutation::Daemon)
        .expect("test NotebookDoc mutation should be journaled before save");
}

async fn commit_test_room_source(room: &NotebookRoom) {
    let path = room
        .file_binding
        .path()
        .await
        .expect("source-backed test room");
    let fingerprint = super::recovery::source_fingerprint(&tokio::fs::read(path).await.unwrap());
    let (snapshot, heads, hashes) = {
        let mut doc = room.doc.write().await;
        let heads = doc.get_heads().iter().map(|head| head.0).collect();
        let hashes = doc
            .doc_mut()
            .get_changes(&[])
            .iter()
            .map(|change| change.hash().0)
            .collect();
        (doc.save(), heads, hashes)
    };
    room.durability
        .commit_snapshot(
            &snapshot,
            heads,
            super::durability::DurableMutation::Source {
                generation: 1,
                fingerprint,
                staged_change_hashes: hashes,
            },
        )
        .expect("test source generation should be staged");
    room.durability
        .commit_source_ready(1)
        .expect("test source generation should become Ready");
}

#[tokio::test]
async fn peer_journal_failure_rolls_back_document_and_sync_ack() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "peer-journal-failure.ipynb");
    let (server_snapshot, server_heads, server_actor) = {
        let mut doc = room.doc.write().await;
        (doc.save(), doc.get_heads(), doc.get_actor_id())
    };
    let mut client = NotebookDoc::load_with_actor(&server_snapshot, "mcp:test-peer").unwrap();
    client.add_cell(0, "peer-cell", "code").unwrap();
    client.update_source("peer-cell", "peer_value = 1").unwrap();
    let mut client_state = sync::State::new();
    let mut server_peer_state = sync::State::new();
    let initial_server_message = room
        .doc
        .write()
        .await
        .generate_sync_message_recovering(&mut server_peer_state, "test-peer-initial")
        .unwrap()
        .expect("server should start the sync handshake");
    client
        .receive_sync_message_recovering(
            &mut client_state,
            initial_server_message,
            "test-peer-initial-receive",
        )
        .unwrap();
    let payload = client
        .generate_sync_message_recovering(&mut client_state, "test-peer-change")
        .unwrap()
        .expect("peer should produce a changes-bearing message")
        .encode();
    assert!(
        !sync::Message::decode(&payload).unwrap().changes.is_empty(),
        "the injected frame must cross the peer durability path"
    );

    let journal_path = room
        .durability
        .journal()
        .expect("file-backed room journal")
        .path()
        .to_path_buf();
    std::fs::create_dir_all(&journal_path).unwrap();
    let identity = RoomConnectionIdentity::local(Some("mcp:test-peer".to_string()))
        .await
        .unwrap();
    let mut changed = room.broadcasts.changed_tx.subscribe();

    let error = match super::peer_notebook_sync::apply_notebook_doc_frame(
        &room,
        &mut server_peer_state,
        &identity,
        &payload,
    )
    .await
    {
        Err(error) => error,
        Ok(_) => panic!("journal failure must reject the peer frame before acknowledgement"),
    };
    assert!(error.to_string().contains("before peer acknowledgement"));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), changed.recv())
            .await
            .is_err(),
        "rejected peer changes must not be broadcast"
    );
    {
        let mut doc = room.doc.write().await;
        assert_eq!(doc.get_heads(), server_heads);
        assert_eq!(doc.get_actor_id(), server_actor);
        assert_eq!(doc.cell_count(), 0);
    }
    assert!(matches!(
        room.state
            .read(|state| state.read_state().file_checkpoint.source_issue)
            .unwrap(),
        Some(runtime_doc::FileSourceIssue::Degraded { .. })
    ));

    // The same encoded peer message succeeds after the injected I/O fault is
    // removed, proving the sync state was rolled back with the document.
    std::fs::remove_dir(&journal_path).unwrap();
    let (_, reply) = super::peer_notebook_sync::apply_notebook_doc_frame(
        &room,
        &mut server_peer_state,
        &identity,
        &payload,
    )
    .await
    .expect("retry should accept and durably acknowledge the same peer change");
    assert!(reply.is_some());
    assert_eq!(room.doc.read().await.cell_count(), 1);
    tokio::time::timeout(std::time::Duration::from_secs(1), changed.recv())
        .await
        .expect("accepted peer change should broadcast")
        .expect("broadcast channel should remain open");
}

async fn save_notebook_to_disk(
    room: &NotebookRoom,
    target_path: Option<&str>,
) -> Result<FileSaveOutcome, SaveError> {
    commit_test_room_doc(room).await;
    super::persist::save_notebook_to_disk(room, target_path).await
}

fn test_daemon_config(tmp: &tempfile::TempDir) -> crate::daemon::DaemonConfig {
    #[cfg(windows)]
    let socket_path = {
        let unique = tmp.path().file_name().unwrap_or_default().to_string_lossy();
        std::path::PathBuf::from(format!(r"\\.\pipe\runtimed-format-test-{unique}"))
    };
    #[cfg(not(windows))]
    let socket_path = tmp.path().join("runtimed-format-test.sock");

    crate::daemon::DaemonConfig {
        socket_path,
        cache_dir: tmp.path().join("envs"),
        blob_store_dir: tmp.path().join("daemon-blobs"),
        execution_store_dir: tmp.path().join("executions"),
        notebook_docs_dir: tmp.path().join("daemon-notebook-docs"),
        trusted_packages_db_path: tmp.path().join("trusted-packages.sqlite"),
        uv_pool_size: 0,
        conda_pool_size: 0,
        pixi_pool_size: 0,
        max_age_secs: 3600,
        lock_dir: Some(tmp.path().to_path_buf()),
        room_eviction_delay_ms: Some(50),
        use_preferred_blob_port: false,
        settings_json_path: Some(tmp.path().join("settings.json")),
        ..Default::default()
    }
}

fn notebook_text_mime(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(lines) => lines
            .iter()
            .map(serde_json::Value::as_str)
            .collect::<Option<Vec<_>>>()
            .map(|parts| parts.concat()),
        _ => None,
    }
}

#[tokio::test]
async fn test_new_fresh_seeds_local_workstation_attachment() {
    let tmp = tempfile::TempDir::new().unwrap();
    let notebook_path = tmp.path().join("workstation.ipynb");
    std::fs::write(&notebook_path, "{}").unwrap();
    let room = NotebookRoom::new_fresh_with_trusted_packages(
        Uuid::new_v4(),
        Some(notebook_path),
        tmp.path(),
        test_blob_store(&tmp),
        false,
        test_trusted_packages(),
    )
    .unwrap();

    let attachment = room
        .state
        .with_doc(|sd| Ok(sd.workstation_attachment()))
        .unwrap()
        .expect("new local room should publish workstation attachment");

    assert_eq!(attachment.workstation_id, "local-daemon");
    assert_eq!(attachment.display_name, "This machine");
    assert_eq!(attachment.provider, "local_daemon");
    assert_eq!(attachment.default_environment_label, "Notebook runtime");
    assert_eq!(attachment.environment_policy, "daemon");
    assert_eq!(attachment.status, "ready");
    assert!(attachment.cpu_count.is_some_and(|count| count > 0));
    assert_eq!(
        attachment.working_directory.as_deref(),
        Some(tmp.path().to_string_lossy().as_ref())
    );
    assert_eq!(attachment.updated_at, None);
}

#[test]
fn test_local_workstation_attachment_publish_is_idempotent() {
    let (state_changed_tx, _) = broadcast::channel(16);
    let state = runtime_doc::RuntimeStateHandle::new(RuntimeStateDoc::new(), state_changed_tx);
    let working_directory = Some("/tmp/nteract-workstation".to_string());

    super::workstation_attachment::publish_local_workstation_attachment_for_test(
        &state,
        working_directory.clone(),
    )
    .unwrap();
    let heads_after_first = state.with_doc(|sd| Ok(sd.get_heads())).unwrap();

    super::workstation_attachment::publish_local_workstation_attachment_for_test(
        &state,
        working_directory,
    )
    .unwrap();
    let heads_after_second = state.with_doc(|sd| Ok(sd.get_heads())).unwrap();

    assert_eq!(
        heads_after_second, heads_after_first,
        "republishing identical local workstation facts must not churn RuntimeStateDoc heads"
    );
}

#[tokio::test]
async fn test_set_runtime_path_updates_local_workstation_working_directory() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "original.ipynb");
    let nested = tmp.path().join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let notebook_path = nested.join("saved.ipynb");

    NotebookFileBinding::set_runtime_path(&room, &notebook_path).await;

    let state = room.state.with_doc(|sd| Ok(sd.read_state())).unwrap();
    assert_eq!(
        state.path.as_deref(),
        Some(notebook_path.to_string_lossy().as_ref())
    );
    assert_eq!(
        state
            .workstation
            .as_ref()
            .and_then(|attachment| attachment.working_directory.as_deref()),
        Some(nested.to_string_lossy().as_ref())
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_creates_valid_nbformat() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "test.ipynb");

    // Add cells to the doc
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "print('hello')").unwrap();
        doc.add_cell(1, "cell2", "markdown").unwrap();
        doc.update_source("cell2", "# Title").unwrap();
    }

    // Save to disk
    save_notebook_to_disk(&room, None).await.unwrap();

    // Read and validate with nbformat
    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let notebook: nbformat::v4::Notebook =
        serde_json::from_str(&content).expect("Saved notebook should be valid nbformat");

    assert_eq!(notebook.cells.len(), 2);
    assert_eq!(notebook.nbformat, 4);
    assert!(
        notebook.nbformat_minor >= 5,
        "Cell IDs require nbformat_minor >= 5"
    );

    let runtime = room.state.read(|state| state.read_state()).unwrap();
    assert!(!runtime.file_checkpoint.exported_heads.is_empty());
    assert_eq!(runtime.file_checkpoint.save_sequence, Some(1));
    assert!(runtime.last_saved.is_some());
}

#[tokio::test]
async fn already_current_save_does_not_advance_checkpoint_or_saved_timestamp() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "already-current.ipynb");
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "print('hello')").unwrap();
    }

    let first = save_notebook_to_disk(&room, None).await.unwrap();
    assert!(matches!(first, FileSaveOutcome::Saved { .. }));
    let first_runtime = room.state.read(|state| state.read_state()).unwrap();

    let second = save_notebook_to_disk(&room, None).await.unwrap();
    assert!(matches!(
        second,
        FileSaveOutcome::AlreadyCurrent {
            save_sequence: 1,
            ..
        }
    ));
    let second_runtime = room.state.read(|state| state.read_state()).unwrap();
    assert_eq!(
        second_runtime.file_checkpoint,
        first_runtime.file_checkpoint
    );
    assert_eq!(second_runtime.last_saved, first_runtime.last_saved);
}

#[tokio::test]
async fn source_conflict_blocks_in_place_save_but_allows_save_recovered_elsewhere() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "conflicted.ipynb");
    tokio::fs::write(&notebook_path, b"original source")
        .await
        .unwrap();
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "recovered", "code").unwrap();
        doc.update_source("recovered", "value = 42").unwrap();
    }
    commit_test_room_doc(&room).await;
    let document_heads = {
        let mut doc = room.doc.write().await;
        doc.get_heads_hex()
    };
    room.lifecycle.restore_source_conflict(
        1,
        super::recovery::source_fingerprint(b"original source"),
        1,
        document_heads,
        "source_conflict: disk and recovery differ".to_string(),
    );

    let in_place = super::persist::save_notebook_to_disk(&room, None)
        .await
        .unwrap_err();
    assert!(matches!(
        in_place,
        SaveError::CheckpointBlocked {
            reason: notebook_protocol::protocol::SaveBlockedReason::SourceConflict { .. },
            ..
        }
    ));
    assert_eq!(
        tokio::fs::read(&notebook_path).await.unwrap(),
        b"original source"
    );

    let alternate = tmp.path().join("recovered-copy.ipynb");
    let saved_elsewhere =
        super::persist::save_notebook_to_disk(&room, Some(alternate.to_string_lossy().as_ref()))
            .await
            .unwrap();
    assert!(matches!(saved_elsewhere, FileSaveOutcome::Saved { .. }));
    assert!(alternate.exists());
    assert!(matches!(
        room.lifecycle.source_state(),
        RoomSourceState::Failed(ref status)
            if status.error.as_ref().is_some_and(|error| error.code == "source_conflict")
    ));
    assert!(matches!(
        room.lifecycle.availability(),
        RoomAvailability::Degraded(_)
    ));
}

#[tokio::test]
async fn external_watcher_conflict_publishes_structured_source_conflict() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "watcher-conflict.ipynb");
    let disk_revision = br#"{"nbformat":4,"nbformat_minor":5,"metadata":{},"cells":[]}"#;
    tokio::fs::write(&notebook_path, disk_revision)
        .await
        .unwrap();
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "unsaved-peer-cell", "code").unwrap();
        doc.update_source("unsaved-peer-cell", "value = 42")
            .unwrap();
    }
    commit_test_room_doc(&room).await;

    assert!(
        mark_external_source_conflict_if_needed(&room, &notebook_path, disk_revision).await,
        "dirty journal heads and a different disk fingerprint must conflict"
    );
    match room.lifecycle.source_state() {
        RoomSourceState::Failed(status) => {
            let error = status.error.expect("structured source error");
            assert_eq!(error.code, "source_conflict");
            assert!(error.message.contains("both versions were preserved"));
            assert_eq!(status.retry, RoomSourceRetry::ExplicitReconciliation);
        }
        state => panic!("watcher conflict must fail the source axis, got {state:?}"),
    }
    let availability = room.lifecycle.availability();
    assert!(matches!(availability, RoomAvailability::Degraded(_)));
    assert!(!availability.status().capabilities.mutate);
    assert!(!availability.status().capabilities.execute);
    assert!(matches!(
        room.state
            .read(|state| state.read_state().file_checkpoint.source_issue)
            .unwrap(),
        Some(runtime_doc::FileSourceIssue::Conflict { .. })
    ));
    assert_eq!(
        tokio::fs::read(&notebook_path).await.unwrap(),
        disk_revision,
        "conflict detection must not rewrite the external source"
    );
    assert_eq!(
        room.doc.read().await.cell_count(),
        1,
        "conflict detection must retain the recovered journal state"
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_preserves_unknown_metadata() {
    use std::io::Write;
    let tmp = tempfile::TempDir::new().unwrap();
    let notebook_path = tmp.path().join("metadata.ipynb");

    // Create existing file with unknown metadata fields
    {
        let mut f = std::fs::File::create(&notebook_path).unwrap();
        writeln!(
            f,
            r#"{{
                "nbformat": 4,
                "nbformat_minor": 5,
                "metadata": {{
                    "custom_extension": {{"key": "value"}},
                    "jupyter": {{"source_hidden": true}},
                    "runt": {{"future_field": "preserve-me", "schema_version": "1"}}
                }},
                "cells": []
            }}"#
        )
        .unwrap();
    }

    // Materialize from disk first (populates doc with extras + runt). Then
    // edit + save. The doc is the source of truth for metadata; the
    // save path no longer reads the on-disk file to rescue unknown
    // keys, so they must be in the doc.
    let (room, _guard, settled) = materialized_room_from_disk(&tmp, &notebook_path).await;
    assert_source_ready(&settled);
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(1, "cell1", "code").unwrap();
        doc.update_source("cell1", "x = 1").unwrap();
    }

    save_notebook_to_disk(&room, None).await.unwrap();

    // Verify unknown metadata is preserved
    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&content).unwrap();
    let metadata = saved.get("metadata").unwrap();

    // custom_extension should be preserved (via top-level extras)
    assert!(
        metadata.get("custom_extension").is_some(),
        "custom_extension should be preserved"
    );
    assert_eq!(
        metadata.get("custom_extension").unwrap().get("key"),
        Some(&serde_json::json!("value"))
    );

    // jupyter should be preserved (via top-level extras)
    assert!(
        metadata.get("jupyter").is_some(),
        "jupyter metadata should be preserved"
    );

    // Unknown forward-compatible runt keys should round-trip via the
    // RuntMetadata `extra` flatten map.
    let runt = metadata.get("runt").unwrap();
    assert_eq!(
        runt.get("future_field"),
        Some(&serde_json::json!("preserve-me")),
        "unknown runt keys should be preserved"
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_enforces_nbformat_minor_5() {
    use std::io::Write;
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "old_minor.ipynb");

    // Create existing file with old nbformat_minor
    {
        let mut f = std::fs::File::create(&notebook_path).unwrap();
        writeln!(
            f,
            r#"{{
                "nbformat": 4,
                "nbformat_minor": 2,
                "metadata": {{}},
                "cells": []
            }}"#
        )
        .unwrap();
    }

    // Add a cell with an id and save
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-with-id", "code").unwrap();
    }

    save_notebook_to_disk(&room, None).await.unwrap();

    // Verify nbformat_minor is upgraded to 5
    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&content).unwrap();

    assert_eq!(
        saved.get("nbformat_minor"),
        Some(&serde_json::json!(5)),
        "nbformat_minor should be upgraded to 5 when writing cell IDs"
    );
}

/// Round-trip a pre-4.5 notebook with no cell IDs through load+save and
/// confirm every saved cell carries a stable ID. The earlier behavior
/// minted positional `__external_cell_N` IDs that drifted across the
/// autosave-write-watch loop, desyncing source from cell type. With real
/// UUIDs, every save persists identifiers that survive any number of
/// reloads.
#[tokio::test]
async fn test_save_persists_real_ids_for_legacy_notebook() {
    use std::io::Write;
    let tmp = tempfile::TempDir::new().unwrap();
    let notebook_path = tmp.path().join("legacy.ipynb");

    // Pre-4.5 notebook with cells that have no `id` field.
    {
        let mut f = std::fs::File::create(&notebook_path).unwrap();
        writeln!(
            f,
            r##"{{
                "nbformat": 4,
                "nbformat_minor": 2,
                "metadata": {{}},
                "cells": [
                    {{ "cell_type": "code", "source": "x = 1", "execution_count": null, "outputs": [] }},
                    {{ "cell_type": "markdown", "source": "# Title", "metadata": {{}} }}
                ]
            }}"##
        )
        .unwrap();
    }

    let (room, _guard, settled) = materialized_room_from_disk(&tmp, &notebook_path).await;
    assert_source_ready(&settled);

    save_notebook_to_disk(&room, None).await.unwrap();

    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&content).unwrap();
    let cells = saved.get("cells").and_then(|v| v.as_array()).unwrap();
    assert_eq!(cells.len(), 2);
    for cell in cells {
        let id = cell
            .get("id")
            .and_then(|v| v.as_str())
            .expect("every saved cell must carry an id");
        assert!(
            uuid::Uuid::parse_str(id).is_ok(),
            "expected UUID, got {id:?}"
        );
    }
    assert_eq!(saved.get("nbformat_minor"), Some(&serde_json::json!(5)));
}

#[tokio::test]
async fn test_save_notebook_to_disk_with_outputs() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "outputs.ipynb");

    // Add a cell with a raw output stored in RuntimeStateDoc
    let eid = "test-exec-1";
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "print('hello')").unwrap();
        doc.set_execution_id("cell1", Some(eid)).unwrap();
    }
    room.state
        .with_doc(|sd| {
            let output: serde_json::Value = serde_json::json!({
                "output_type": "stream",
                "output_id": "test-output-1",
                "name": "stdout",
                "text": ["hello\n"]
            });
            sd.create_execution(eid)?;
            sd.set_execution_count(eid, 1)?;
            sd.set_outputs(eid, &[output])?;
            sd.set_execution_done(eid, true)?;
            Ok(())
        })
        .unwrap();

    save_notebook_to_disk(&room, None).await.unwrap();

    // Read and validate
    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let notebook: nbformat::v4::Notebook =
        serde_json::from_str(&content).expect("Should be valid nbformat with outputs");

    assert_eq!(notebook.cells.len(), 1);
    if let nbformat::v4::Cell::Code { outputs, .. } = &notebook.cells[0] {
        assert_eq!(outputs.len(), 1, "Should have one output");
        // Verify it's a stream output (nbformat types may vary)
        match &outputs[0] {
            nbformat::v4::Output::Stream { name, .. } => {
                assert_eq!(name, "stdout");
            }
            _ => panic!("Expected stream output"),
        }
    } else {
        panic!("Expected code cell");
    }

    // Runtime-only output_id must not hit disk. Check the raw bytes, since
    // the typed `nbformat::v4::Output` would silently drop unknown fields.
    assert!(
        !content.contains("output_id"),
        "saved notebook should not contain runtime-only output_id field, got:\n{content}"
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_writes_widget_state_metadata_from_runtime_comms() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "widget-state.ipynb");
    let eid = "widget-exec-1";
    let model_id = "slider-model";

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-widget", "code").unwrap();
        doc.update_source("cell-widget", "slider").unwrap();
        doc.set_execution_id("cell-widget", Some(eid)).unwrap();
    }

    room.state
        .with_doc(|sd| {
            sd.create_execution(eid)?;
            sd.set_execution_count(eid, 1)?;
            sd.set_outputs(
                eid,
                &[serde_json::json!({
                    "output_type": "display_data",
                    "output_id": "widget-output-runtime-only",
                    "data": {
                        "text/plain": "IntSlider(value=42)",
                        "application/vnd.jupyter.widget-view+json": {
                            "version_major": 2,
                            "version_minor": 0,
                            "model_id": model_id
                        }
                    },
                    "metadata": {}
                })],
            )?;
            sd.set_execution_done(eid, true)?;
            sd.put_comm(
                model_id,
                "jupyter.widget",
                "@jupyter-widgets/controls",
                "IntSliderModel",
                &serde_json::json!({
                    "_model_module": "@jupyter-widgets/controls",
                    "_model_module_version": "2.0.0",
                    "_model_name": "IntSliderModel",
                    "_view_module": "@jupyter-widgets/controls",
                    "_view_module_version": "2.0.0",
                    "_view_name": "IntSliderView",
                    "description": "Answer",
                    "value": 42
                }),
                0,
            )?;
            Ok(())
        })
        .unwrap();

    save_notebook_to_disk(&room, None).await.unwrap();

    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&content).unwrap();
    let widget_state = &saved["metadata"]["widgets"][WIDGET_STATE_MIME];
    assert_eq!(widget_state["version_major"], serde_json::json!(2));
    assert_eq!(widget_state["version_minor"], serde_json::json!(0));
    assert_eq!(
        widget_state["state"][model_id]["model_name"],
        serde_json::json!("IntSliderModel")
    );
    assert_eq!(
        widget_state["state"][model_id]["model_module"],
        serde_json::json!("@jupyter-widgets/controls")
    );
    assert_eq!(
        widget_state["state"][model_id]["model_module_version"],
        serde_json::json!("2.0.0")
    );
    assert_eq!(
        widget_state["state"][model_id]["state"]["value"],
        serde_json::json!(42)
    );
    assert_eq!(
        saved["cells"][0]["outputs"][0]["data"]["application/vnd.jupyter.widget-view+json"]
            ["model_id"],
        serde_json::json!(model_id),
        "the original widget view output should remain in the cell output"
    );
    assert!(
        !content.contains("widget-output-runtime-only"),
        "runtime-only output_id leaked to saved .ipynb:\n{content}"
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_resolves_widget_state_content_refs() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "widget-state-refs.ipynb");

    let esm = "export default { render() {} }";
    let esm_hash = room
        .blob_store
        .put(esm.as_bytes(), "text/javascript")
        .await
        .unwrap();
    let options = serde_json::json!({"items": [1, 2, 3]});
    let options_bytes = serde_json::to_vec(&options).unwrap();
    let options_hash = room
        .blob_store
        .put(&options_bytes, "application/json")
        .await
        .unwrap();
    let binary = b"abc123";
    let binary_hash = room
        .blob_store
        .put(binary, "application/octet-stream")
        .await
        .unwrap();

    room.state
        .with_doc(|sd| {
            sd.put_comm(
                "binary-widget",
                "jupyter.widget",
                "anywidget",
                "AnyModel",
                &serde_json::json!({
                    "_model_module": "anywidget",
                    "_model_module_version": "0.9.18",
                    "_model_name": "AnyModel",
                    "_esm": {
                        "blob": esm_hash,
                        "size": esm.len(),
                        "media_type": "text/javascript"
                    },
                    "options": {
                        "blob": options_hash,
                        "size": options_bytes.len(),
                        "media_type": "application/json"
                    },
                    "value": {
                        "blob": binary_hash,
                        "size": binary.len(),
                        "media_type": "application/octet-stream"
                    }
                }),
                0,
            )?;
            Ok(())
        })
        .unwrap();

    save_notebook_to_disk(&room, None).await.unwrap();

    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&content).unwrap();
    let model = &saved["metadata"]["widgets"][WIDGET_STATE_MIME]["state"]["binary-widget"];
    let state = &model["state"];

    assert_eq!(state["_esm"], serde_json::json!(esm));
    assert_eq!(state["options"], options);
    assert!(
        state.get("value").is_none(),
        "binary object fields should be removed from state and represented in buffers"
    );
    let buffers = model["buffers"].as_array().expect("buffers array");
    assert_eq!(buffers.len(), 1);
    assert_eq!(buffers[0]["encoding"], serde_json::json!("base64"));
    assert_eq!(buffers[0]["path"], serde_json::json!(["value"]));
    assert_eq!(
        buffers[0]["data"],
        serde_json::json!(base64::engine::general_purpose::STANDARD.encode(binary))
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_skips_only_widget_with_unresolved_state_blob() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "widget-state-partial.ipynb");

    room.state
        .with_doc(|sd| {
            sd.put_comm(
                "healthy-widget",
                "jupyter.widget",
                "@jupyter-widgets/controls",
                "IntSliderModel",
                &serde_json::json!({
                    "_model_module": "@jupyter-widgets/controls",
                    "_model_module_version": "2.0.0",
                    "_model_name": "IntSliderModel",
                    "value": 7
                }),
                0,
            )?;
            sd.put_comm(
                "broken-widget",
                "jupyter.widget",
                "@jupyter-widgets/controls",
                "ImageModel",
                &serde_json::json!({
                    "_model_module": "@jupyter-widgets/controls",
                    "_model_module_version": "2.0.0",
                    "_model_name": "ImageModel",
                    "value": {
                        "blob": "missing-widget-state-blob",
                        "size": 6,
                        "media_type": "application/octet-stream"
                    }
                }),
                1,
            )?;
            Ok(())
        })
        .unwrap();

    save_notebook_to_disk(&room, None).await.unwrap();

    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&content).unwrap();
    let widget_models = saved["metadata"]["widgets"][WIDGET_STATE_MIME]["state"]
        .as_object()
        .expect("widget state map");
    assert!(widget_models.contains_key("healthy-widget"));
    assert!(
        !widget_models.contains_key("broken-widget"),
        "a single unresolved widget blob should not poison every other widget model"
    );
    assert_eq!(
        widget_models["healthy-widget"]["state"]["value"],
        serde_json::json!(7)
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_externalizes_arrow_stream_outputs() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "arrow-output.ipynb");
    let eid = "arrow-exec-1";

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-arrow", "code").unwrap();
        doc.update_source("cell-arrow", "table").unwrap();
        doc.set_execution_id("cell-arrow", Some(eid)).unwrap();
    }

    let arrow_bytes = b"ARROW1-stream-payload-bytes-large-enough";
    let arrow_ref = crate::output_store::ContentRef::from_binary(
        arrow_bytes,
        notebook_doc::mime::ARROW_STREAM_MIME,
        &room.blob_store,
    )
    .await
    .unwrap();
    let manifest = crate::output_store::OutputManifest::DisplayData {
        output_id: "arrow-output-runtime-only".to_string(),
        data: HashMap::from([
            (notebook_doc::mime::ARROW_STREAM_MIME.to_string(), arrow_ref),
            (
                "text/plain".to_string(),
                crate::output_store::ContentRef::Inline {
                    inline: "pyarrow.Table\nimage: struct<bytes: binary, path: string>".to_string(),
                },
            ),
        ]),
        metadata: HashMap::new(),
        transient: Default::default(),
    };

    room.state
        .with_doc(|sd| {
            sd.create_execution(eid)?;
            sd.set_execution_count(eid, 1)?;
            sd.set_outputs(eid, &[manifest.to_json()])?;
            sd.set_execution_done(eid, true)?;
            Ok(())
        })
        .unwrap();

    save_notebook_to_disk(&room, None).await.unwrap();

    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&content).unwrap();
    let data = saved["cells"][0]["outputs"][0]["data"]
        .as_object()
        .expect("output data object");
    assert!(
        !data.contains_key(notebook_doc::mime::ARROW_STREAM_MIME),
        "raw Arrow stream MIME should be replaced by blob-ref MIME: {data:?}"
    );
    let ref_entry = data
        .get(notebook_doc::mime::BLOB_REF_MIME)
        .expect("Arrow stream saved as blob-ref MIME");
    assert_eq!(
        ref_entry["content_type"],
        notebook_doc::mime::ARROW_STREAM_MIME
    );
    assert_eq!(ref_entry["size"], arrow_bytes.len());
    assert!(ref_entry["hash"].as_str().is_some());
    assert_eq!(
        notebook_text_mime(data.get("text/plain")).as_deref(),
        Some("pyarrow.Table\nimage: struct<bytes: binary, path: string>")
    );
    assert!(
        !content.contains("arrow-output-runtime-only"),
        "runtime-only output_id leaked to saved .ipynb:\n{content}"
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_keeps_image_outputs_self_contained() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "image-output.ipynb");
    let eid = "image-exec-1";

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-image", "code").unwrap();
        doc.update_source("cell-image", "image").unwrap();
        doc.set_execution_id("cell-image", Some(eid)).unwrap();
    }

    let png_bytes = b"\x89PNG\r\n\x1a\nfake image payload";
    let image_ref =
        crate::output_store::ContentRef::from_binary(png_bytes, "image/png", &room.blob_store)
            .await
            .unwrap();
    let manifest = crate::output_store::OutputManifest::DisplayData {
        output_id: "image-output-runtime-only".to_string(),
        data: HashMap::from([
            ("image/png".to_string(), image_ref),
            (
                "text/plain".to_string(),
                crate::output_store::ContentRef::Inline {
                    inline: "<PNG image>".to_string(),
                },
            ),
        ]),
        metadata: HashMap::new(),
        transient: Default::default(),
    };

    room.state
        .with_doc(|sd| {
            sd.create_execution(eid)?;
            sd.set_execution_count(eid, 1)?;
            sd.set_outputs(eid, &[manifest.to_json()])?;
            sd.set_execution_done(eid, true)?;
            Ok(())
        })
        .unwrap();

    save_notebook_to_disk(&room, None).await.unwrap();

    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let saved: serde_json::Value = serde_json::from_str(&content).unwrap();
    let data = saved["cells"][0]["outputs"][0]["data"]
        .as_object()
        .expect("output data object");
    assert!(
        !data.contains_key(notebook_doc::mime::BLOB_REF_MIME),
        "ordinary image outputs should remain vanilla-Jupyter compatible"
    );
    let image_base64 = data
        .get("image/png")
        .and_then(|v| v.as_str())
        .expect("image/png base64 payload");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(image_base64)
        .unwrap();
    assert_eq!(decoded, png_bytes);
    assert_eq!(
        notebook_text_mime(data.get("text/plain")).as_deref(),
        Some("<PNG image>")
    );
    assert!(
        !content.contains("image-output-runtime-only"),
        "runtime-only output_id leaked to saved .ipynb:\n{content}"
    );
    for formatted_binary_marker in ["list of size", "struct (binary data)", "bytes ("] {
        assert!(
            !content.contains(formatted_binary_marker),
            "Sift display-only binary text leaked into saved .ipynb:\n{content}"
        );
    }
}

#[tokio::test]
async fn test_redacted_output_manifests_do_not_leak_to_state_or_saved_nbformat() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "redacted-outputs.ipynb");
    let secret = "secret-token-123";
    let redactor =
        crate::output_redaction::OutputRedactor::from_values_for_test(vec![secret.to_string()]);
    let eid = "redacted-exec-1";

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source(
            "cell1",
            "import os\nprint(os.environ['TOKEN'])\nraise Exception(os.environ['TOKEN'])",
        )
        .unwrap();
        doc.set_execution_id("cell1", Some(eid)).unwrap();
    }

    let stream = serde_json::json!({
        "output_type": "stream",
        "name": "stdout",
        "text": format!("{secret}\n")
    });
    let error = serde_json::json!({
        "output_type": "error",
        "ename": "Exception",
        "evalue": format!("boom {secret}"),
        "traceback": [format!("Traceback {secret}")]
    });
    let stream_manifest =
        crate::output_store::create_manifest_with_redactor(&stream, &room.blob_store, 0, &redactor)
            .await
            .unwrap();
    let error_manifest = crate::output_store::create_manifest_with_redactor(
        &error,
        &room.blob_store,
        crate::output_store::DEFAULT_INLINE_THRESHOLD,
        &redactor,
    )
    .await
    .unwrap();
    let output_values = vec![stream_manifest.to_json(), error_manifest.to_json()];

    room.state
        .with_doc(|sd| {
            sd.create_execution(eid)?;
            sd.set_execution_count(eid, 1)?;
            sd.set_outputs(eid, &output_values)?;
            sd.set_execution_done(eid, false)?;
            Ok(())
        })
        .unwrap();

    let state_outputs = room.state.read(|sd| sd.get_outputs(eid)).unwrap();
    let state_json = serde_json::to_string(&state_outputs).unwrap();
    assert!(state_json.contains(crate::output_redaction::REDACTION_MARKER));
    assert!(!state_json.contains(secret));

    for output in &state_outputs {
        let manifest: crate::output_store::OutputManifest =
            serde_json::from_value(output.clone()).unwrap();
        let resolved = crate::output_store::resolve_manifest(&manifest, &room.blob_store)
            .await
            .unwrap();
        let resolved_json = serde_json::to_string(&resolved).unwrap();
        assert!(resolved_json.contains(crate::output_redaction::REDACTION_MARKER));
        assert!(!resolved_json.contains(secret));
    }

    save_notebook_to_disk(&room, None).await.unwrap();
    let saved = std::fs::read_to_string(&notebook_path).unwrap();
    assert!(saved.contains(crate::output_redaction::REDACTION_MARKER));
    assert!(!saved.contains(secret));
}

/// Saves should produce byte-identical output twice in a row for the same
/// state, and top-level + cell keys should be alphabetically sorted. This is
/// the git-diff churn fix: a no-op save produces the same bytes, and edits
/// produce minimal, stable diffs because key order is deterministic.
#[tokio::test]
async fn test_save_notebook_to_disk_produces_sorted_stable_output() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "stable.ipynb");

    let eid = "exec-stable-1";
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-alpha", "code").unwrap();
        doc.update_source("cell-alpha", "x = 1").unwrap();
        doc.set_execution_id("cell-alpha", Some(eid)).unwrap();
        doc.add_cell(1, "cell-beta", "markdown").unwrap();
        doc.update_source("cell-beta", "# heading").unwrap();
    }
    room.state
        .with_doc(|sd| {
            let output = serde_json::json!({
                "output_type": "stream",
                "name": "stdout",
                "text": ["ok\n"],
                "output_id": "runtime-only-uuid",
            });
            sd.create_execution(eid)?;
            sd.set_execution_count(eid, 1)?;
            sd.set_outputs(eid, &[output])?;
            sd.set_execution_done(eid, true)?;
            Ok(())
        })
        .unwrap();

    save_notebook_to_disk(&room, None).await.unwrap();
    let first = std::fs::read_to_string(&notebook_path).unwrap();

    // Second save against unchanged state must produce identical bytes.
    save_notebook_to_disk(&room, None).await.unwrap();
    let second = std::fs::read_to_string(&notebook_path).unwrap();
    assert_eq!(first, second, "consecutive saves must be byte-identical");

    // Top-level key order: cells, metadata, nbformat, nbformat_minor.
    let cells_pos = first.find("\"cells\"").expect("cells key present");
    let metadata_pos = first.find("\"metadata\"").expect("metadata key present");
    let nbformat_pos = first.find("\"nbformat\"").expect("nbformat key present");
    let minor_pos = first
        .find("\"nbformat_minor\"")
        .expect("nbformat_minor key present");
    assert!(
        cells_pos < metadata_pos && metadata_pos < nbformat_pos && nbformat_pos < minor_pos,
        "top-level keys not alphabetical in:\n{first}"
    );

    // Code cell keys: cell_type, execution_count, id, metadata, outputs, source.
    let code_start = first.find("\"cell_type\": \"code\"").expect("code cell");
    let slice = &first[code_start..];
    let ct = slice.find("\"cell_type\"").unwrap();
    let ec = slice.find("\"execution_count\"").unwrap();
    let id = slice.find("\"id\"").unwrap();
    let src = slice.find("\"source\"").unwrap();
    assert!(ct < ec && ec < id && id < src, "code cell keys not sorted");

    // Runtime-only output_id must not hit disk.
    assert!(
        !first.contains("output_id"),
        "output_id leaked to disk:\n{first}"
    );
}

#[test]
fn test_is_untitled_notebook_with_uuid() {
    assert!(is_untitled_notebook("550e8400-e29b-41d4-a716-446655440000"));
    assert!(is_untitled_notebook("a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
}

#[test]
fn test_is_untitled_notebook_with_path() {
    assert!(!is_untitled_notebook("/home/user/notebook.ipynb"));
    assert!(!is_untitled_notebook("./relative/path.ipynb"));
    assert!(!is_untitled_notebook("notebook.ipynb"));
}

/// Test that the debouncer flushes at max interval even during continuous updates.
///
/// Uses short intervals (50ms debounce, 200ms max) for fast testing.
#[tokio::test]
async fn test_persist_debouncer_max_interval_flush() {
    use std::time::Duration;

    let tmp = tempfile::TempDir::new().unwrap();
    let persist_path = tmp.path().join("test.automerge");

    // Create watch channel and spawn debouncer with short intervals for testing
    let (tx, rx) = watch::channel::<Option<Vec<u8>>>(None);
    let (_flush_tx, flush_rx) = mpsc::unbounded_channel::<FlushRequest>();
    let config = PersistDebouncerConfig {
        debounce_ms: 50,       // 50ms debounce window
        max_interval_ms: 200,  // 200ms max between flushes
        check_interval_ms: 10, // Check every 10ms
    };
    spawn_persist_debouncer_with_config(rx, flush_rx, persist_path.clone(), config);

    // Send updates every 20ms (faster than 50ms debounce, so debounce never triggers)
    // The 200ms max interval should force a flush even without a quiet period.
    for i in 0..20 {
        let data = format!("update-{}", i).into_bytes();
        tx.send(Some(data)).unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Total time: 20 * 20ms = 400ms, which is > 200ms max interval

    // Give debouncer time to flush
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert!(
        persist_path.exists(),
        "File should exist after max interval even with continuous updates"
    );

    // Verify content is from an update
    let content = std::fs::read(&persist_path).unwrap();
    let content_str = String::from_utf8_lossy(&content);
    assert!(
        content_str.starts_with("update-"),
        "Content should be from an update"
    );
}

/// Regression test for the eviction/debouncer race.
///
/// The bug: room eviction used to remove the room from the HashMap before
/// the persist debouncer's debounce window elapsed, so a fast reconnect
/// would load stale/empty bytes. The fix: eviction sends a flush request
/// on `flush_request_tx` and awaits an ack on the oneshot *before* the
/// HashMap mutation. This test pins the contract: the ack must arrive
/// after the latest watch value has been written to disk, well inside
/// the debounce window.
#[tokio::test]
async fn test_persist_debouncer_flush_request_is_synchronous() {
    use std::time::Duration;

    let tmp = tempfile::TempDir::new().unwrap();
    let persist_path = tmp.path().join("race.automerge");

    // Use production defaults for debounce (500ms) so the timed flush
    // can't mask the flush-request ack timing.
    let (tx, rx) = watch::channel::<Option<Vec<u8>>>(None);
    let (flush_tx, flush_rx) = mpsc::unbounded_channel::<FlushRequest>();
    spawn_persist_debouncer(rx, flush_rx, persist_path.clone());

    // Push latest bytes and request a flush immediately. No sleeps — the
    // debounce timer must not be the thing that persists this write.
    let payload = b"eviction-latest-bytes".to_vec();
    tx.send(Some(payload.clone())).unwrap();

    let (ack_tx, ack_rx) = oneshot::channel::<bool>();
    flush_tx.send(ack_tx).unwrap();

    // The ack must come back fast (success=true). 500ms is 10x margin over
    // local disk I/O.
    let ack_result = tokio::time::timeout(Duration::from_millis(500), ack_rx).await;
    assert!(
        matches!(ack_result, Ok(Ok(true))),
        "flush ack did not arrive synchronously with success=true: {:?}",
        ack_result
    );

    // And the file on disk must hold the latest payload, not stale bytes.
    assert!(persist_path.exists(), "file must exist after flush ack");
    let on_disk = std::fs::read(&persist_path).unwrap();
    assert_eq!(
        on_disk, payload,
        "file contents must match latest payload after flush ack"
    );
}

/// The flush-and-ack must report I/O failures so the eviction task can
/// retry (rather than remove the room and leave stale bytes on disk).
/// Force a write failure by pointing persist_path at a non-writable
/// location, then confirm the ack carries `false`.
#[tokio::test]
async fn test_persist_debouncer_flush_request_reports_write_failure() {
    use std::time::Duration;

    let tmp = tempfile::TempDir::new().unwrap();
    // Write target is a file *inside* a path that includes a non-directory
    // component — `std::fs::create_dir_all` on parent will succeed, but
    // `std::fs::write` on the final path will fail because it conflicts
    // with a regular file we planted there. This simulates ENOSPC-class
    // failures without needing OS-specific tricks.
    let blocker = tmp.path().join("blocker");
    std::fs::write(&blocker, b"regular file").unwrap();
    let persist_path = blocker.join("race.automerge");

    let (tx, rx) = watch::channel::<Option<Vec<u8>>>(None);
    let (flush_tx, flush_rx) = mpsc::unbounded_channel::<FlushRequest>();
    spawn_persist_debouncer(rx, flush_rx, persist_path.clone());

    let payload = b"write-will-fail".to_vec();
    tx.send(Some(payload)).unwrap();

    let (ack_tx, ack_rx) = oneshot::channel::<bool>();
    flush_tx.send(ack_tx).unwrap();

    let ack_result = tokio::time::timeout(Duration::from_millis(500), ack_rx).await;
    assert!(
        matches!(ack_result, Ok(Ok(false))),
        "flush ack must report write failure: {:?}",
        ack_result
    );
    // The file should not exist, since the write errored before any bytes hit disk.
    assert!(
        !persist_path.exists(),
        "persist_path must not exist after failed write"
    );
}

// ==========================================================================
// File watcher tests
// ==========================================================================

/// Serialized single-code-cell notebook bytes for watcher tests.
fn watcher_test_ipynb_bytes(cell_id: &str, source: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [{
            "id": cell_id,
            "cell_type": "code",
            "source": source,
            "execution_count": null,
            "outputs": [],
            "metadata": {}
        }]
    }))
    .unwrap()
}

fn watcher_observation_for_test(
    observed: &[u8],
    known_disk: Option<&[u8]>,
    manifest: &[u8],
    pending: Option<&[u8]>,
) -> WatcherObservation {
    WatcherObservation {
        observed: super::recovery::source_fingerprint(observed),
        known_disk_hash: known_disk
            .map(|bytes| *super::recovery::source_fingerprint(bytes).as_bytes()),
        manifest_fingerprint: super::recovery::source_fingerprint(manifest),
        pending_checkpoint_fingerprint: pending.map(super::recovery::source_fingerprint),
    }
}

/// A snapshot of the room state a watcher event would build its observation
/// from, mirroring `process_watcher_event` exactly.
fn watcher_observation_from_room(room: &NotebookRoom, disk_bytes: &[u8]) -> WatcherObservation {
    let manifest = room.durability.manifest();
    WatcherObservation {
        observed: super::recovery::source_fingerprint(disk_bytes),
        known_disk_hash: room.persistence.known_disk_hash(),
        manifest_fingerprint: manifest.source_fingerprint,
        pending_checkpoint_fingerprint: manifest
            .pending_file_checkpoint
            .map(|pending| pending.file_fingerprint),
    }
}

#[test]
fn classify_watcher_observation_table() {
    use WatcherIngestDecision::{Ingest, Skip};
    use WatcherSkipReason::*;

    const OBSERVED: &[u8] = b"observed notebook bytes";
    const OTHER: &[u8] = b"some other notebook bytes";

    let cases: Vec<(&str, WatcherObservation, WatcherIngestDecision)> = vec![
        (
            "known disk hash only",
            watcher_observation_for_test(OBSERVED, Some(OBSERVED), OTHER, None),
            Skip(KnownDiskContent),
        ),
        (
            "manifest fingerprint only, diverged baseline",
            watcher_observation_for_test(OBSERVED, Some(OTHER), OBSERVED, None),
            Skip(ManifestFingerprint),
        ),
        (
            "manifest fingerprint only, no baseline",
            watcher_observation_for_test(OBSERVED, None, OBSERVED, None),
            Skip(ManifestFingerprint),
        ),
        (
            "pending checkpoint only",
            watcher_observation_for_test(OBSERVED, Some(OTHER), OTHER, Some(OBSERVED)),
            Skip(PendingCheckpoint),
        ),
        (
            "known disk hash and manifest fingerprint",
            watcher_observation_for_test(OBSERVED, Some(OBSERVED), OBSERVED, None),
            Skip(KnownDiskContent),
        ),
        (
            "manifest fingerprint and pending checkpoint",
            watcher_observation_for_test(OBSERVED, None, OBSERVED, Some(OBSERVED)),
            Skip(ManifestFingerprint),
        ),
        (
            "all guards at once",
            watcher_observation_for_test(OBSERVED, Some(OBSERVED), OBSERVED, Some(OBSERVED)),
            Skip(KnownDiskContent),
        ),
        (
            "unknown bytes ingest",
            watcher_observation_for_test(OBSERVED, None, OTHER, None),
            Ingest,
        ),
        (
            "unknown bytes ingest despite stale baselines",
            watcher_observation_for_test(OBSERVED, Some(OTHER), OTHER, Some(OTHER)),
            Ingest,
        ),
    ];

    for (name, observation, expected) in cases {
        assert_eq!(
            classify_watcher_observation(&observation),
            expected,
            "case: {name}"
        );
    }
}

/// Fifty byte-identical debounced events (the inotify IN_ACCESS storm shape)
/// must be fully suppressed: zero merges, zero checkpoint sequence claims,
/// zero journal appends, and an unchanged source generation. The room's doc
/// deliberately differs from the disk bytes so a single misclassified event
/// would merge the disk cell and move every counter.
#[tokio::test]
async fn watcher_storm_of_identical_events_is_fully_suppressed() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "storm.ipynb");

    let disk_bytes = watcher_test_ipynb_bytes("storm-cell", "value = 42");
    tokio::fs::write(&notebook_path, &disk_bytes).await.unwrap();
    // The baseline a completed save or watcher merge leaves behind.
    room.persistence.note_disk_content(&disk_bytes);

    let observation = watcher_observation_from_room(&room, &disk_bytes);
    assert_eq!(
        classify_watcher_observation(&observation),
        WatcherIngestDecision::Skip(WatcherSkipReason::KnownDiskContent),
    );

    let claimed_before = room
        .persistence
        .file_checkpoint_coordinator()
        .latest_claimed_sequence();
    let manifest_before = room.durability.manifest();
    let heads_before = room.doc.write().await.get_heads_hex();

    for _ in 0..50 {
        process_watcher_event(&room, &notebook_path).await;
    }

    assert_eq!(
        room.doc.write().await.get_heads_hex(),
        heads_before,
        "storm must not merge anything into the doc"
    );
    assert_eq!(room.doc.read().await.cell_count(), 0);
    assert_eq!(
        room.persistence
            .file_checkpoint_coordinator()
            .latest_claimed_sequence(),
        claimed_before,
        "storm must not claim checkpoint sequences"
    );
    let manifest_after = room.durability.manifest();
    assert_eq!(
        manifest_after.sequence, manifest_before.sequence,
        "storm must not append journal records"
    );
    assert_eq!(
        manifest_after.source_generation, manifest_before.source_generation,
        "storm must not advance the source generation"
    );
}

/// The commit-to-baseline window: a save's journal commit has landed but its
/// primary-path baseline install has not run yet. An event observing the new
/// bytes must skip via the manifest fingerprint.
#[tokio::test]
async fn watcher_event_between_journal_commit_and_baseline_install_skips() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "commit-window.ipynb");

    // The bound content this daemon previously saved and reconciled.
    let old_bytes = watcher_test_ipynb_bytes("cell-1", "x = 1");
    tokio::fs::write(&notebook_path, &old_bytes).await.unwrap();
    room.persistence.note_disk_content(&old_bytes);

    // The in-flight save: doc mutated, journaled, new bytes renamed into
    // place, checkpoint committed. The baseline install has NOT run.
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source("cell-1", "x = 2").unwrap();
    }
    commit_test_room_doc(&room).await;
    let new_bytes = watcher_test_ipynb_bytes("cell-1", "x = 2");
    tokio::fs::write(&notebook_path, &new_bytes).await.unwrap();
    let claim = room.persistence.claim_file_checkpoint().unwrap();
    let heads: Vec<[u8; 32]> = {
        let mut doc = room.doc.write().await;
        doc.get_heads().iter().map(|head| head.0).collect()
    };
    room.durability
        .commit_file_checkpoint(
            notebook_path.clone(),
            super::recovery::source_fingerprint(&new_bytes),
            heads,
            claim.sequence(),
        )
        .expect("journal commit for the in-flight save");

    let observation = watcher_observation_from_room(&room, &new_bytes);
    assert_eq!(
        classify_watcher_observation(&observation),
        WatcherIngestDecision::Skip(WatcherSkipReason::ManifestFingerprint),
        "the committed manifest fingerprint covers the commit-to-baseline window"
    );

    let claimed_before = room
        .persistence
        .file_checkpoint_coordinator()
        .latest_claimed_sequence();
    let manifest_before = room.durability.manifest();
    let heads_before = room.doc.write().await.get_heads_hex();

    process_watcher_event(&room, &notebook_path).await;

    assert_eq!(room.doc.write().await.get_heads_hex(), heads_before);
    assert_eq!(
        room.persistence
            .file_checkpoint_coordinator()
            .latest_claimed_sequence(),
        claimed_before
    );
    let manifest_after = room.durability.manifest();
    assert_eq!(manifest_after.sequence, manifest_before.sequence);
    assert_eq!(
        manifest_after.source_generation,
        manifest_before.source_generation
    );
    assert!(
        !matches!(room.lifecycle.availability(), RoomAvailability::Degraded(_)),
        "our own committed bytes must not degrade the room"
    );
}

/// The rename-to-commit window: the new bytes are visible on disk and the
/// journal holds the prepared checkpoint intent, but the commit marker has
/// not landed. The pending-checkpoint fingerprint resolves the event; a
/// misclassification here would manufacture a source conflict because the
/// journal's durable heads are ahead of its exported heads.
#[tokio::test]
async fn watcher_event_in_rename_to_commit_window_skips_via_pending_checkpoint() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "rename-window.ipynb");

    let old_bytes = watcher_test_ipynb_bytes("cell-1", "x = 1");
    tokio::fs::write(&notebook_path, &old_bytes).await.unwrap();
    room.persistence.note_disk_content(&old_bytes);

    // The in-flight save: doc mutated and journaled, checkpoint intent
    // prepared, temp file renamed over the target. The commit marker has
    // NOT been appended.
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source("cell-1", "x = 2").unwrap();
    }
    commit_test_room_doc(&room).await;
    let new_bytes = watcher_test_ipynb_bytes("cell-1", "x = 2");
    let claim = room.persistence.claim_file_checkpoint().unwrap();
    let heads: Vec<[u8; 32]> = {
        let mut doc = room.doc.write().await;
        doc.get_heads().iter().map(|head| head.0).collect()
    };
    room.durability
        .prepare_file_checkpoint(
            notebook_path.clone(),
            super::recovery::source_fingerprint(&new_bytes),
            heads,
            claim.sequence(),
            None,
        )
        .expect("checkpoint intent for the in-flight save");
    tokio::fs::write(&notebook_path, &new_bytes).await.unwrap();

    let observation = watcher_observation_from_room(&room, &new_bytes);
    assert_eq!(
        classify_watcher_observation(&observation),
        WatcherIngestDecision::Skip(WatcherSkipReason::PendingCheckpoint),
        "the prepared checkpoint fingerprint covers the rename-to-commit window"
    );

    let claimed_before = room
        .persistence
        .file_checkpoint_coordinator()
        .latest_claimed_sequence();
    let manifest_before = room.durability.manifest();
    let heads_before = room.doc.write().await.get_heads_hex();

    process_watcher_event(&room, &notebook_path).await;

    assert_eq!(room.doc.write().await.get_heads_hex(), heads_before);
    assert_eq!(
        room.persistence
            .file_checkpoint_coordinator()
            .latest_claimed_sequence(),
        claimed_before
    );
    let manifest_after = room.durability.manifest();
    assert_eq!(manifest_after.sequence, manifest_before.sequence);
    assert_eq!(
        manifest_after.source_generation,
        manifest_before.source_generation
    );
    assert!(
        manifest_after.pending_file_checkpoint.is_some(),
        "the prepared intent must remain for the save to commit"
    );
    assert!(
        !matches!(room.lifecycle.availability(), RoomAvailability::Degraded(_)),
        "our own renamed bytes must not be classified as a source conflict"
    );
}

#[test]
fn test_parse_ipynb_cells_missing_ids() {
    // Older notebooks (pre-nbformat 4.5) don't have cell IDs
    let fixture = br#"{
        "cells": [
            {"cell_type": "code", "source": "x = 1", "execution_count": null, "outputs": []},
            {"cell_type": "code", "source": "y = 2", "execution_count": null, "outputs": []}
        ]
    }"#;

    let parsed =
        parse_notebook_jiter_for_notebook(fixture, Uuid::nil()).expect("Should parse notebook");
    let cells = &parsed.cells;
    assert_eq!(cells.len(), 2);
    // Should derive UUIDs for ID-less cells so recovery and watcher reparses
    // retain identity until the next save writes explicit ids.
    assert!(uuid::Uuid::parse_str(&cells[0].id).is_ok());
    assert!(uuid::Uuid::parse_str(&cells[1].id).is_ok());
    assert_ne!(cells[0].id, cells[1].id);
    assert_eq!(cells[0].source, "x = 1");
    assert_eq!(cells[1].source, "y = 2");
}

#[test]
fn idless_external_edits_keep_the_room_derived_cell_id() {
    let notebook_id = Uuid::new_v4();
    let before = br#"{
        "cells": [{
            "cell_type": "code",
            "metadata": {},
            "execution_count": null,
            "outputs": [],
            "source": ["value = 1\n"]
        }]
    }"#;
    let after = br#"{
        "cells": [{
            "cell_type": "code",
            "metadata": {},
            "execution_count": null,
            "outputs": [],
            "source": ["value = 2\n"]
        }]
    }"#;

    let before = parse_notebook_jiter_for_notebook(before, notebook_id).unwrap();
    let after = parse_notebook_jiter_for_notebook(after, notebook_id).unwrap();
    assert_eq!(before.cells[0].id, after.cells[0].id);
    assert_ne!(before.cells[0].source, after.cells[0].source);
}

// ---------------------------------------------------------------------------
// .ipynb parser characterization over malformed fixtures
// (consolidation item 2, docs/memos/room-lifecycle-simplification-and-verification.md)
//
// `parse_notebook_jiter_for_notebook` is the single .ipynb parser: initial
// load, source reconciliation, the file watcher, and the watcher-baseline
// refresh all read disk content through it. Each row pins its behavior over
// one fixture, including the mappings chosen when the serde watcher parser
// was deleted:
// - non-object cell entries are dropped, never synthesized (no caller depends
//   on placeholder cells: the watcher diffs by cell id, the baseline refresh
//   maps id to source)
// - a missing or invalid `cells` key is Err; the watcher maps Err to its
//   existing warn-and-skip path instead of degrading the room
// - the watcher's outputs-by-cell-id shape comes from
//   `streaming_cells_into_snapshots`, which inserts only non-empty outputs
// ---------------------------------------------------------------------------

fn parse_ipynb(bytes: &[u8]) -> Result<ParsedStreamingNotebook, String> {
    parse_notebook_jiter_for_notebook(bytes, Uuid::nil())
}

/// Valid baseline: ids, normalized sources, cell types, execution counts,
/// and metadata all parse; the watcher adapter maps outputs into a
/// by-cell-id map holding only non-empty entries.
#[test]
fn parser_characterization_valid_baseline() {
    let fixture = br##"{
        "cells": [
            {"id": "a", "cell_type": "code", "source": "x = 1",
             "execution_count": 3, "metadata": {"tags": ["t"]},
             "outputs": [{"output_type": "stream", "name": "stdout", "text": "hi\n"}]},
            {"id": "b", "cell_type": "markdown", "source": ["# Title\n", "Body"],
             "metadata": {}},
            {"id": "c", "cell_type": "code", "source": "y = 2",
             "execution_count": null, "metadata": {}, "outputs": []}
        ],
        "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}},
        "nbformat": 4, "nbformat_minor": 5
    }"##;

    let parsed = parse_ipynb(fixture).expect("valid baseline parses");
    assert_eq!(parsed.cells.len(), 3);
    assert_eq!(parsed.cells[0].id, "a");
    assert_eq!(parsed.cells[0].cell_type, "code");
    assert_eq!(parsed.cells[0].execution_count, "3");
    assert_eq!(parsed.cells[0].metadata, serde_json::json!({"tags": ["t"]}));
    assert_eq!(parsed.cells[1].cell_type, "markdown");
    assert_eq!(parsed.cells[1].source, "# Title\nBody");
    assert_eq!(parsed.cells[2].execution_count, "null");

    // Metadata snapshot and raw metadata value both surface from the parse.
    let json: serde_json::Value = serde_json::from_slice(fixture).unwrap();
    assert_eq!(parsed.metadata_value.as_ref(), json.get("metadata"));
    assert!(parsed.metadata.is_some());

    // Watcher shape: only the cell with outputs gets a map entry; cells with
    // no outputs key ("b") or an empty array ("c") get none.
    let expected_outputs = parsed.cells[0].outputs.clone();
    assert_eq!(expected_outputs.len(), 1);
    let (cells, outputs_by_cell) = streaming_cells_into_snapshots(parsed.cells);
    assert_eq!(cells.len(), 3);
    assert_eq!(outputs_by_cell.len(), 1);
    assert_eq!(outputs_by_cell["a"], expected_outputs);
}

/// Non-object cell entries are dropped. The deleted serde watcher parser
/// synthesized placeholder cells here; nothing consumed them (the watcher
/// diffs by cell id, the baseline refresh maps id to source), so the drop
/// wins. Legacy id derivation enumerates the raw array, so a surviving
/// idless cell keeps its index-derived identity regardless of what its
/// dropped neighbors were.
#[test]
fn parser_characterization_non_object_cell_entries() {
    let fixture = br#"{
        "cells": [
            42,
            {"cell_type": "code", "source": "x = 1", "execution_count": null,
             "metadata": {}, "outputs": []},
            "bogus"
        ],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5
    }"#;

    let parsed = parse_ipynb(fixture).expect("non-object cell entries do not fail the parse");
    assert_eq!(parsed.cells.len(), 1);
    assert_eq!(parsed.cells[0].source, "x = 1");
    assert!(uuid::Uuid::parse_str(&parsed.cells[0].id).is_ok());

    // Index-derived identity: the kept idless cell sits at array index 1 in
    // both fixtures, so it derives the same legacy id even though its
    // non-object neighbors differ.
    let variant = br#"{
        "cells": [
            null,
            {"cell_type": "code", "source": "x = 1", "execution_count": null,
             "metadata": {}, "outputs": []}
        ],
        "metadata": {}, "nbformat": 4, "nbformat_minor": 5
    }"#;
    let variant = parse_ipynb(variant).expect("variant parses");
    assert_eq!(parsed.cells[0].id, variant.cells[0].id);
}

/// A missing `cells` key, a non-array `cells`, and a non-object root are all
/// Err. The watcher (persist.rs process_watcher_event) maps Err onto its
/// warn-and-skip path, the same route that always covered partial writes, so
/// a malformed revision waits for the next event instead of minting a new
/// failure mode. Initial load keeps failing hard so the autosave zeroing
/// guard preserves the on-disk file.
#[test]
fn parser_characterization_missing_or_invalid_cells() {
    let missing = br#"{"metadata": {}, "nbformat": 4, "nbformat_minor": 5}"#;
    assert!(parse_ipynb(missing)
        .err()
        .expect("missing cells key is an error")
        .contains("no 'cells' key"));

    let not_array = br#"{"cells": {}, "metadata": {}}"#;
    assert!(parse_ipynb(not_array)
        .err()
        .expect("non-array cells value is an error")
        .contains("not an array"));

    let not_object = br#"[1, 2, 3]"#;
    assert!(parse_ipynb(not_object)
        .err()
        .expect("non-object root is an error")
        .contains("not a JSON object"));
}

/// A genuine empty notebook (`cells: []`) parses, and the watcher adapter
/// yields no cells and no outputs entries.
#[test]
fn parser_characterization_empty_cells() {
    let fixture = br#"{"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}"#;
    let parsed = parse_ipynb(fixture).expect("cells: [] is a valid empty notebook");
    assert!(parsed.cells.is_empty());
    let (cells, outputs_by_cell) = streaming_cells_into_snapshots(parsed.cells);
    assert!(cells.is_empty());
    assert!(outputs_by_cell.is_empty());
}

/// Malformed (non-array) `outputs` values degrade to no outputs, so the
/// watcher adapter inserts no map entries for those cells.
#[test]
fn parser_characterization_malformed_outputs() {
    let fixture = br#"{
        "cells": [
            {"id": "a", "cell_type": "code", "source": "x", "execution_count": null,
             "metadata": {}, "outputs": "not-an-array"},
            {"id": "b", "cell_type": "code", "source": "y", "execution_count": null,
             "metadata": {}, "outputs": 7}
        ],
        "metadata": {}
    }"#;
    let parsed = parse_ipynb(fixture).expect("malformed outputs do not fail the parse");
    assert_eq!(parsed.cells.len(), 2);
    assert!(parsed.cells.iter().all(|c| c.outputs.is_empty()));
    let (_, outputs_by_cell) = streaming_cells_into_snapshots(parsed.cells);
    assert!(outputs_by_cell.is_empty());
}

/// Non-i64 `execution_count` values (floats, integers beyond i64) parse as
/// "null". nbformat specifies execution_count as int-or-null; the deleted
/// serde watcher parser stringified out-of-spec numbers into NotebookDoc,
/// this parser enforces the spec.
#[test]
fn parser_characterization_execution_count_numeric_edges() {
    let fixture = br#"{
        "cells": [
            {"id": "f", "cell_type": "code", "source": "x", "execution_count": 2.5,
             "metadata": {}, "outputs": []},
            {"id": "g", "cell_type": "code", "source": "y",
             "execution_count": 18446744073709551616,
             "metadata": {}, "outputs": []}
        ],
        "metadata": {}
    }"#;
    let parsed = parse_ipynb(fixture).expect("numeric-edge execution counts parse");
    assert_eq!(parsed.cells[0].execution_count, "null");
    assert_eq!(parsed.cells[1].execution_count, "null");
}

/// Integers beyond i64 inside outputs convert to strings via
/// `jiter_to_serde`, preserving the exact digits. The deleted serde watcher
/// parser kept them as lossy f64 numbers; the string is strictly better. The
/// same conversion applies to cell metadata and attachments.
#[test]
fn parser_characterization_bigint_output_values() {
    let fixture = br#"{
        "cells": [
            {"id": "a", "cell_type": "code", "source": "x", "execution_count": 1,
             "metadata": {},
             "outputs": [{"output_type": "stream", "name": "stdout", "text": "hi",
                          "big": 123456789012345678901234567890}]}
        ],
        "metadata": {}
    }"#;
    let parsed = parse_ipynb(fixture).expect("bigint output values parse");
    assert_eq!(
        parsed.cells[0].outputs[0]["big"],
        serde_json::json!("123456789012345678901234567890"),
        "jiter_to_serde converts BigInt to a string"
    );
}

/// Duplicate JSON keys resolve first-wins for cell-level fields read
/// through `jobj_get`'s linear scan; nested output/metadata/attachment
/// objects collect into `serde_json::Map`, which keeps the last value.
/// JSON leaves duplicate-key resolution undefined, so either policy is
/// valid; pathological input only.
#[test]
fn parser_characterization_duplicate_keys() {
    let fixture = br#"{
        "cells": [
            {"id": "a", "cell_type": "code", "source": "first", "source": "second",
             "execution_count": null, "metadata": {}, "outputs": []}
        ],
        "metadata": {}
    }"#;
    let parsed = parse_ipynb(fixture).expect("duplicate keys parse");
    assert_eq!(parsed.cells[0].source, "first");
}

#[tokio::test]
async fn test_apply_ipynb_changes_clears_all_cells() {
    // Valid "delete all cells" case — empty cells array from external
    // file should clear the doc, but ONLY when we have a save baseline
    // (last_save_sources populated). Without a save snapshot, deletions
    // are skipped to prevent the Run 38 cell-loss bug.
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "test.ipynb");

    // Add cells to the doc
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source("cell-1", "x = 1").unwrap();
    }

    // Populate last_save_sources — simulates a save that included the cell
    {
        let mut saved = room.persistence.last_save_sources.write().await;
        saved.insert("cell-1".to_string(), "x = 1".to_string());
    }

    // Apply empty external cells - should delete all cells (we have
    // a save baseline confirming cell-1 was on disk before)
    let external_cells = vec![];
    let changed = apply_ipynb_changes_inner(
        &room,
        &external_cells,
        &HashMap::new(),
        &HashMap::new(),
        false,
        None, // external_metadata
        None, // source_revision: exercise the no-source-revision path
    )
    .await
    .changed();
    assert!(changed, "Should apply changes to clear all cells");

    // Verify all cells were deleted
    let cells = {
        let doc = room.doc.read().await;
        doc.get_cells()
    };
    assert!(cells.is_empty(), "All cells should be deleted");
}

#[tokio::test]
async fn test_apply_ipynb_changes_updates_execution_count() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "test.ipynb");

    // Add cells to the doc
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-1", "code").unwrap();
    }

    // Apply external changes with execution_count
    let external_cells = vec![CellSnapshot {
        id: "cell-1".to_string(),
        cell_type: "code".to_string(),
        position: "80".to_string(),
        source: String::new(),
        execution_count: "42".to_string(),
        metadata: serde_json::json!({}),
        resolved_assets: std::collections::HashMap::new(),
        attachments: std::collections::HashMap::new(),
    }];

    let changed = apply_ipynb_changes_inner(
        &room,
        &external_cells,
        &HashMap::new(),
        &HashMap::new(),
        false,
        None, // external_metadata
        None, // source_revision: exercise the no-source-revision path
    )
    .await
    .changed();
    assert!(changed, "Should detect execution_count change");

    // Live execution_count is resolved from RuntimeStateDoc via synthetic execution_id.
    let doc = room.doc.read().await;
    let eid = doc.get_execution_id("cell-1");
    drop(doc);
    assert!(eid.is_some(), "Should have execution_id set");
    let ec = room
        .state
        .read(|sd| {
            sd.get_execution(eid.as_ref().unwrap())
                .unwrap()
                .execution_count
        })
        .unwrap();
    assert_eq!(ec, Some(42));
}

#[tokio::test]
async fn execute_cell_queues_in_runtime_doc_while_kernel_launch_is_resolving() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "test.ipynb");
    let room = Arc::new(room);

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source("cell-1", "print('queued while resolving')")
            .unwrap();
    }
    room.state
        .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Resolving))
        .unwrap();

    let response = crate::requests::execute_cell::handle_with_submitter(
        &room,
        "cell-1".to_string(),
        None,
        false,
        Some("local:kyle/agent:codex:s1"),
    )
    .await;

    let execution_id = match response {
        crate::protocol::NotebookResponse::CellQueued { execution_id, .. } => execution_id,
        other => panic!("expected CellQueued, got {other:?}"),
    };
    assert_eq!(
        room.doc.read().await.get_execution_id("cell-1").as_deref(),
        Some(execution_id.as_str())
    );

    let state = room.state.read(|sd| sd.read_state()).unwrap();
    let execution = state
        .executions
        .get(&execution_id)
        .expect("queued execution should exist");
    assert_eq!(execution.status, "queued");
    assert_eq!(
        execution.source.as_deref(),
        Some("print('queued while resolving')")
    );
    assert_eq!(
        execution.submitted_by_actor_label.as_deref(),
        Some("local:kyle/agent:codex:s1")
    );
    assert_eq!(state.queue.executing, None);
    assert_eq!(
        state
            .queue
            .queued
            .iter()
            .map(|entry| entry.execution_id.as_str())
            .collect::<Vec<_>>(),
        vec![execution_id.as_str()]
    );
}

#[tokio::test]
async fn run_all_cells_queues_in_runtime_doc_while_kernel_launch_is_resolving() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "test.ipynb");

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source("cell-1", "print('first')").unwrap();
        doc.add_cell(1, "cell-2", "code").unwrap();
        doc.update_source("cell-2", "print('second')").unwrap();
    }
    room.state
        .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Resolving))
        .unwrap();

    let response = crate::requests::run_all_cells::handle_with_submitter(
        &room,
        None,
        Some("local:kyle/desktop:window-1"),
    )
    .await;

    let queued = match response {
        crate::protocol::NotebookResponse::AllCellsQueued { queued } => queued,
        other => panic!("expected AllCellsQueued, got {other:?}"),
    };
    assert_eq!(queued.len(), 2);

    let first_execution_id = queued[0].execution_id.as_str();
    let second_execution_id = queued[1].execution_id.as_str();
    let doc = room.doc.read().await;
    assert_eq!(
        doc.get_execution_id("cell-1").as_deref(),
        Some(first_execution_id)
    );
    assert_eq!(
        doc.get_execution_id("cell-2").as_deref(),
        Some(second_execution_id)
    );
    drop(doc);

    let state = room.state.read(|sd| sd.read_state()).unwrap();
    assert_eq!(
        state
            .executions
            .get(first_execution_id)
            .and_then(|execution| execution.submitted_by_actor_label.as_deref()),
        Some("local:kyle/desktop:window-1")
    );
    assert_eq!(
        state
            .executions
            .get(second_execution_id)
            .and_then(|execution| execution.submitted_by_actor_label.as_deref()),
        Some("local:kyle/desktop:window-1")
    );
    assert_eq!(state.queue.executing, None);
    assert_eq!(
        state
            .queue
            .queued
            .iter()
            .map(|entry| entry.execution_id.as_str())
            .collect::<Vec<_>>(),
        vec![first_execution_id, second_execution_id]
    );
}

#[tokio::test]
async fn test_apply_ipynb_changes_updates_existing_cell_attachments() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "test.ipynb");

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-1", "raw").unwrap();
        doc.update_source("cell-1", "attachment ref").unwrap();
    }

    let external_cells = vec![CellSnapshot {
        id: "cell-1".to_string(),
        cell_type: "raw".to_string(),
        position: "80".to_string(),
        source: "attachment ref".to_string(),
        execution_count: "null".to_string(),
        metadata: serde_json::json!({}),
        resolved_assets: HashMap::new(),
        attachments: HashMap::new(),
    }];
    let external_attachments = HashMap::from([(
        "cell-1".to_string(),
        serde_json::json!({
            "payload.json": {
                "application/json": {"kind": "watch-update"}
            }
        }),
    )]);

    let changed = apply_ipynb_changes_inner(
        &room,
        &external_cells,
        &HashMap::new(),
        &external_attachments,
        false,
        None, // external_metadata
        None, // source_revision: exercise the no-source-revision path
    )
    .await
    .changed();
    assert!(changed, "Should detect attachment changes");

    let cells = room.doc.read().await.get_cells();
    let attachment_ref = cells[0]
        .attachments
        .get("payload.json")
        .and_then(|bundle| bundle.get("application/json"))
        .expect("watch path should store attachment refs on the existing cell");
    let reconstructed = attachment_refs_to_nbformat_value(&cells[0].attachments, &room.blob_store)
        .await
        .unwrap();
    assert_eq!(attachment_ref.encoding, AttachmentEncoding::Json);
    assert_eq!(reconstructed, external_attachments["cell-1"]);
}

#[tokio::test]
async fn test_apply_ipynb_changes_preserves_execution_count_when_kernel_running() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "test.ipynb");

    // Add cell with execution_count in RuntimeStateDoc via synthetic eid
    let eid = "existing-exec-1";
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.set_execution_id("cell-1", Some(eid)).unwrap();
    }
    room.state
        .with_doc(|sd| {
            sd.create_execution(eid)?;
            sd.set_execution_count(eid, 10)?;
            sd.set_execution_done(eid, true)?;
            Ok(())
        })
        .unwrap();

    // Apply external changes while kernel is "running"
    let external_cells = vec![CellSnapshot {
        id: "cell-1".to_string(),
        cell_type: "code".to_string(),
        position: "80".to_string(),
        source: "new source".to_string(),
        execution_count: "5".to_string(),
        metadata: serde_json::json!({}),
        resolved_assets: std::collections::HashMap::new(),
        attachments: std::collections::HashMap::new(),
    }];

    let changed = apply_ipynb_changes_inner(
        &room,
        &external_cells,
        &HashMap::new(),
        &HashMap::new(),
        true,
        None, // external_metadata
        None, // source_revision: exercise the no-source-revision path
    )
    .await
    .changed();
    assert!(changed, "Should apply source change");

    let cells = {
        let doc = room.doc.read().await;
        doc.get_cells()
    };
    // Source should be updated
    assert_eq!(cells[0].source, "new source");
    // execution_count should be preserved in RuntimeStateDoc (kernel running)
    let exec = room.state.read(|sd| sd.get_execution(eid)).unwrap();
    assert_eq!(exec.unwrap().execution_count, Some(10));
}

#[tokio::test]
async fn test_apply_ipynb_changes_new_cell_with_outputs_while_kernel_running() {
    // New external cells should get their external outputs even when kernel is running
    // (they don't have any in-progress state to preserve)
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "test.ipynb");

    // Start with one cell
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "existing-cell", "code").unwrap();
    }

    // Add a new external cell with outputs while kernel is "running"
    let external_cells = vec![
        CellSnapshot {
            id: "existing-cell".to_string(),
            cell_type: "code".to_string(),
            position: "80".to_string(),
            source: String::new(),
            execution_count: "null".to_string(),
            metadata: serde_json::json!({}),
            resolved_assets: std::collections::HashMap::new(),
            attachments: std::collections::HashMap::new(),
        },
        CellSnapshot {
            id: "new-cell".to_string(),
            cell_type: "code".to_string(),
            position: "81".to_string(),
            source: "print('new')".to_string(),
            execution_count: "42".to_string(),
            metadata: serde_json::json!({}),
            resolved_assets: std::collections::HashMap::new(),
            attachments: std::collections::HashMap::new(),
        },
    ];
    let mut external_outputs: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    external_outputs.insert(
        "new-cell".to_string(),
        vec![serde_json::json!({"output_type":"execute_result"})],
    );

    let changed = apply_ipynb_changes_inner(
        &room,
        &external_cells,
        &external_outputs,
        &HashMap::new(),
        true,
        None, // external_metadata
        None, // source_revision: exercise the no-source-revision path
    )
    .await
    .changed();
    assert!(changed, "Should add new cell");

    let cells = {
        let doc = room.doc.read().await;
        doc.get_cells()
    };
    assert_eq!(cells.len(), 2);

    // New cell should have external outputs and execution_count in RuntimeStateDoc
    let new_cell = cells.iter().find(|c| c.id == "new-cell").unwrap();
    assert_eq!(new_cell.source, "print('new')");

    // Outputs and execution_count are in RuntimeStateDoc keyed by synthetic execution_id
    let eid = {
        let doc = room.doc.read().await;
        doc.get_execution_id("new-cell")
            .expect("new-cell should have execution_id")
    };
    let exec = room.state.read(|sd| sd.get_execution(&eid)).unwrap();
    assert_eq!(exec.unwrap().execution_count, Some(42));
    let outputs = room.state.read(|sd| sd.get_outputs(&eid)).unwrap();
    assert_eq!(outputs.len(), 1);
    let manifest = &outputs[0];
    assert!(
        manifest.is_object(),
        "Output should be a manifest object, got: {}",
        manifest
    );
    // Verify the manifest resolves back to the original output
    let parsed_manifest: crate::output_store::OutputManifest =
        serde_json::from_value(manifest.clone()).unwrap();
    let resolved = crate::output_store::resolve_manifest(&parsed_manifest, &room.blob_store)
        .await
        .unwrap();
    assert_eq!(resolved["output_type"], "execute_result");
}

#[tokio::test]
async fn test_apply_ipynb_changes_wholesale_replacement() {
    // When external file has entirely different cell IDs (zero overlap),
    // the rebuild path should replace all cells correctly (issue #1310).
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "test.ipynb");

    // Add original cells
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "old-a", "code").unwrap();
        doc.update_source("old-a", "x = 1").unwrap();
        doc.add_cell(1, "old-b", "code").unwrap();
        doc.update_source("old-b", "y = 2").unwrap();
        doc.add_cell(2, "old-c", "markdown").unwrap();
        doc.update_source("old-c", "# Hello").unwrap();
    }

    // Completely replace with different cells (zero common IDs)
    let external_cells = vec![
        CellSnapshot {
            id: "new-1".to_string(),
            cell_type: "code".to_string(),
            position: "80".to_string(),
            source: "a = 10".to_string(),
            execution_count: "1".to_string(),
            metadata: serde_json::json!({}),
            resolved_assets: std::collections::HashMap::new(),
            attachments: std::collections::HashMap::new(),
        },
        CellSnapshot {
            id: "new-2".to_string(),
            cell_type: "code".to_string(),
            position: "81".to_string(),
            source: "b = 20".to_string(),
            execution_count: "2".to_string(),
            metadata: serde_json::json!({}),
            resolved_assets: std::collections::HashMap::new(),
            attachments: std::collections::HashMap::new(),
        },
    ];

    let changed = apply_ipynb_changes_inner(
        &room,
        &external_cells,
        &HashMap::new(),
        &HashMap::new(),
        false,
        None, // external_metadata
        None, // source_revision: exercise the no-source-revision path
    )
    .await
    .changed();
    assert!(changed, "Should detect wholesale replacement");

    let cells = {
        let doc = room.doc.read().await;
        doc.get_cells()
    };
    assert_eq!(cells.len(), 2, "Should have exactly 2 new cells");
    assert_eq!(cells[0].id, "new-1");
    assert_eq!(cells[0].source, "a = 10");
    assert_eq!(cells[1].id, "new-2");
    assert_eq!(cells[1].source, "b = 20");
    // Old cells should be gone
    assert!(cells.iter().all(|c| !c.id.starts_with("old-")));
}

#[tokio::test]
async fn test_apply_ipynb_changes_partial_overlap_preserves_unsaved() {
    // When there IS overlap between current and external cells, the
    // incremental path should preserve user-added cells not in
    // last_save_sources.
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "test.ipynb");

    // Add cells and populate last_save_sources to simulate a save
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "keep", "code").unwrap();
        doc.update_source("keep", "x = 1").unwrap();
        doc.add_cell(1, "remove", "code").unwrap();
        doc.update_source("remove", "y = 2").unwrap();
    }
    {
        let mut saved = room.persistence.last_save_sources.write().await;
        saved.insert("keep".to_string(), "x = 1".to_string());
        saved.insert("remove".to_string(), "y = 2".to_string());
    }

    // Add a cell NOT in last_save_sources (user just added it)
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(2, "user-added", "code").unwrap();
        doc.update_source("user-added", "z = 3").unwrap();
    }

    // External file has "keep" (overlap) but not "remove" or "user-added"
    let external_cells = vec![CellSnapshot {
        id: "keep".to_string(),
        cell_type: "code".to_string(),
        position: "80".to_string(),
        source: "x = 1".to_string(),
        execution_count: "null".to_string(),
        metadata: serde_json::json!({}),
        resolved_assets: std::collections::HashMap::new(),
        attachments: std::collections::HashMap::new(),
    }];

    let changed = apply_ipynb_changes_inner(
        &room,
        &external_cells,
        &HashMap::new(),
        &HashMap::new(),
        false,
        None, // external_metadata
        None, // source_revision: exercise the no-source-revision path
    )
    .await
    .changed();
    assert!(changed);

    let cells = {
        let doc = room.doc.read().await;
        doc.get_cells()
    };
    let ids: Vec<&str> = cells.iter().map(|c| c.id.as_str()).collect();
    assert!(
        ids.contains(&"keep"),
        "Overlapping cell should remain: {:?}",
        ids
    );
    assert!(
        !ids.contains(&"remove"),
        "Saved cell removed externally should be deleted: {:?}",
        ids
    );
    assert!(
        ids.contains(&"user-added"),
        "User-added cell not in save snapshot should be preserved: {:?}",
        ids
    );
}

#[tokio::test]
async fn test_apply_ipynb_changes_no_save_snapshot_preserves_crdt_cells() {
    // Regression test for Run 38 cell-loss: when last_save_sources is
    // empty (initial autosave with 0 cells), the file watcher must NOT
    // delete CRDT cells that aren't on disk. Without a save baseline we
    // can't distinguish "externally deleted" from "just created in CRDT."
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "test.ipynb");

    // Add cells to the CRDT (simulates MCP client creating cells)
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-a", "code").unwrap();
        doc.update_source("cell-a", "x = 1").unwrap();
        doc.add_cell(1, "cell-b", "code").unwrap();
        doc.update_source("cell-b", "y = 2").unwrap();
    }

    // Do NOT populate last_save_sources — simulates the case where
    // the only save was with 0 cells (empty HashMap is the default).
    assert!(room.persistence.last_save_sources.read().await.is_empty());

    // External file has 0 cells (the autosave wrote an empty notebook)
    let external_cells: Vec<CellSnapshot> = vec![];

    let changed = apply_ipynb_changes_inner(
        &room,
        &external_cells,
        &HashMap::new(),
        &HashMap::new(),
        false,
        None, // external_metadata
        None, // source_revision: exercise the no-source-revision path
    )
    .await
    .changed();
    // No changes should be applied — cells preserved
    assert!(
        !changed,
        "Should not delete cells when no save snapshot exists"
    );

    let cells = {
        let doc = room.doc.read().await;
        doc.get_cells()
    };
    let ids: Vec<&str> = cells.iter().map(|c| c.id.as_str()).collect();
    assert!(
        ids.contains(&"cell-a"),
        "CRDT cell should be preserved when no save snapshot: {:?}",
        ids
    );
    assert!(
        ids.contains(&"cell-b"),
        "CRDT cell should be preserved when no save snapshot: {:?}",
        ids
    );
}

/// Applying identical external content twice is a no-op the second time:
/// no reported change AND no new Automerge changes (issue #4015). A
/// spurious metadata_changed fires changed_tx (resetting the autosave
/// debounce), commits a journal marker, and wakes the persist debouncer.
///
/// Exercises both suspect shapes:
/// - a file whose metadata is empty while the doc carries internal keys
///   (`runtime` scalar, `runt.env_id`) the .ipynb omits — the untitled
///   autosave scenario from the issue's watcher log
/// - a file with kernelspec, language_info, and an unknown top-level key
#[tokio::test]
async fn test_apply_ipynb_changes_identical_metadata_is_idempotent() {
    let empty_metadata_fixture = br#"{
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {"id": "cell-1", "cell_type": "code", "source": "x = 1",
             "execution_count": null, "metadata": {}, "outputs": []}
        ]
    }"# as &[u8];
    let rich_metadata_fixture = br#"{
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"name": "python3", "display_name": "Python 3",
                           "language": "python"},
            "language_info": {"name": "python", "version": "3.12.1",
                              "codemirror_mode": {"name": "ipython", "version": 3}},
            "jupytext": {"formats": "ipynb,md"}
        },
        "cells": [
            {"id": "cell-1", "cell_type": "code", "source": "x = 1",
             "execution_count": null, "metadata": {}, "outputs": []}
        ]
    }"# as &[u8];

    for (label, fixture) in [
        ("empty-metadata", empty_metadata_fixture),
        ("rich-metadata", rich_metadata_fixture),
    ] {
        let tmp = tempfile::TempDir::new().unwrap();
        let (room, _) = test_room_with_path(&tmp, "test.ipynb");

        // The doc carries keys the .ipynb never has: the internal
        // `runtime` scalar (stamped at bootstrap) and a runt-namespaced
        // env_id. These must not make identical external content look
        // permanently different.
        {
            let mut doc = room.doc.write().await;
            doc.set_metadata("runtime", "python").unwrap();
            doc.with_metadata(|snap| {
                snap.runt.env_id = Some("11111111-2222-3333-4444-555555555555".to_string());
            })
            .unwrap();
        }

        let parsed = parse_notebook_jiter_for_notebook(fixture, room.id).expect("fixture parses");
        let external_metadata = parsed.metadata.expect("fixture has metadata");
        let (external_cells, external_outputs) = streaming_cells_into_snapshots(parsed.cells);

        let first = apply_ipynb_changes_inner(
            &room,
            &external_cells,
            &external_outputs,
            &parsed.attachments,
            false,
            Some(&external_metadata),
            None,
        )
        .await;
        assert!(
            first.changed(),
            "[{label}] first apply reconciles the doc to the external file"
        );

        let heads_after_first = room.doc.write().await.get_heads();

        let second = apply_ipynb_changes_inner(
            &room,
            &external_cells,
            &external_outputs,
            &parsed.attachments,
            false,
            Some(&external_metadata),
            None,
        )
        .await;
        assert!(
            !second.cells_changed,
            "[{label}] second apply of identical content must report cells=false"
        );
        assert!(
            !second.metadata_changed,
            "[{label}] second apply of identical content must report metadata=false"
        );

        let heads_after_second = room.doc.write().await.get_heads();
        assert_eq!(
            heads_after_first, heads_after_second,
            "[{label}] idempotent re-apply must produce zero new Automerge changes"
        );
    }
}

/// Companion to the idempotence test: a genuinely different metadata
/// snapshot must still report metadata_changed=true and land in the doc.
/// The idempotence fix normalizes the comparison; it must not swallow
/// real deltas.
#[tokio::test]
async fn test_apply_ipynb_changes_genuine_metadata_change_still_reports() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "test.ipynb");

    let before = br#"{
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"name": "python3", "display_name": "Python 3",
                           "language": "python"},
            "jupytext": {"formats": "ipynb,md"}
        },
        "cells": [
            {"id": "cell-1", "cell_type": "code", "source": "x = 1",
             "execution_count": null, "metadata": {}, "outputs": []}
        ]
    }"#;
    let after = br#"{
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"name": "deno", "display_name": "Deno",
                           "language": "typescript"},
            "custom_extension": {"enabled": true}
        },
        "cells": [
            {"id": "cell-1", "cell_type": "code", "source": "x = 1",
             "execution_count": null, "metadata": {}, "outputs": []}
        ]
    }"#;

    let parsed_before = parse_notebook_jiter_for_notebook(before, room.id).expect("before parses");
    let metadata_before = parsed_before.metadata.expect("before has metadata");
    let (cells_before, outputs_before) = streaming_cells_into_snapshots(parsed_before.cells);
    apply_ipynb_changes_inner(
        &room,
        &cells_before,
        &outputs_before,
        &parsed_before.attachments,
        false,
        Some(&metadata_before),
        None,
    )
    .await;

    let parsed_after = parse_notebook_jiter_for_notebook(after, room.id).expect("after parses");
    let metadata_after = parsed_after.metadata.expect("after has metadata");
    let (cells_after, outputs_after) = streaming_cells_into_snapshots(parsed_after.cells);
    let applied = apply_ipynb_changes_inner(
        &room,
        &cells_after,
        &outputs_after,
        &parsed_after.attachments,
        false,
        Some(&metadata_after),
        None,
    )
    .await;

    assert!(
        applied.metadata_changed,
        "genuinely different metadata must report metadata=true"
    );
    let doc = room.doc.read().await;
    let snapshot = doc.get_metadata_snapshot().expect("metadata present");
    assert_eq!(snapshot.kernelspec.as_ref().unwrap().name, "deno");
    assert!(snapshot.extras.contains_key("custom_extension"));
    assert!(
        !snapshot.extras.contains_key("jupytext"),
        "stale extras key must be replaced by the new snapshot"
    );
}

#[tokio::test]
async fn test_initial_load_routes_outputs_through_blob_store() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);

    // Create a .ipynb file with outputs including a large base64 image
    let large_image = "x".repeat(16 * 1024); // 16KB, above 8KB inline threshold
    let notebook_json = serde_json::json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "id": "cell-1",
                "cell_type": "code",
                "source": "1 + 1",
                "execution_count": 1,
                "metadata": {},
                "outputs": [
                    {
                        "output_type": "execute_result",
                        "execution_count": 1,
                        "data": { "text/plain": "2" },
                        "metadata": {}
                    }
                ]
            },
            {
                "id": "cell-2",
                "cell_type": "code",
                "source": "display(img)",
                "execution_count": 2,
                "metadata": {},
                "outputs": [
                    {
                        "output_type": "display_data",
                        "data": {
                            "text/plain": "<Image>",
                            "image/png": large_image
                        },
                        "metadata": {}
                    }
                ]
            },
            {
                "id": "cell-3",
                "cell_type": "code",
                "source": "print('hi')",
                "execution_count": 3,
                "metadata": {},
                "outputs": [
                    {
                        "output_type": "stream",
                        "name": "stdout",
                        "text": "hi\n"
                    }
                ]
            }
        ]
    });

    let ipynb_path = tmp.path().join("test.ipynb");
    std::fs::write(
        &ipynb_path,
        serde_json::to_string_pretty(&notebook_json).unwrap(),
    )
    .unwrap();

    let (room, _guard, settled) = materialized_room_from_disk(&tmp, &ipynb_path).await;
    assert_source_ready(&settled);
    let get_outputs = |eid: &str| {
        let eid = eid.to_string();
        room.state
            .with_doc(move |sd| Ok(sd.get_outputs(&eid)))
            .unwrap()
    };
    // Doc reads stay inside this block so the room lock drops before the
    // manifest resolution awaits below.
    let (eid1, eid2, eid3) = {
        let doc = room.doc.read().await;
        assert_eq!(doc.cell_count(), 3);

        let cells = doc.get_cells();
        assert_eq!(cells.len(), 3);

        // Each code cell with outputs should have an execution_id pointing to
        // RuntimeStateDoc
        for cell in &cells {
            if let Some(eid) = doc.get_execution_id(&cell.id) {
                let outputs = get_outputs(&eid);
                assert!(
                    !outputs.is_empty(),
                    "Cell {} should have outputs in state doc",
                    cell.id
                );
                for output_ref in &outputs {
                    assert!(
                        output_ref.is_object(),
                        "Cell {} output should be a manifest object, got: {}",
                        cell.id,
                        output_ref
                    );
                    assert!(
                        output_ref.get("output_type").is_some(),
                        "Cell {} output manifest should have output_type",
                        cell.id
                    );
                }
            }
        }

        (
            doc.get_execution_id("cell-1")
                .expect("cell-1 should have execution_id"),
            doc.get_execution_id("cell-2")
                .expect("cell-2 should have execution_id"),
            doc.get_execution_id("cell-3")
                .expect("cell-3 should have execution_id"),
        )
    };

    // Resolve cell-1's execute_result and verify round-trip
    let outputs1 = get_outputs(&eid1);
    let manifest = &outputs1[0];
    let parsed_manifest: crate::output_store::OutputManifest =
        serde_json::from_value(manifest.clone()).unwrap();
    let resolved = crate::output_store::resolve_manifest(&parsed_manifest, &blob_store)
        .await
        .unwrap();
    assert_eq!(resolved["output_type"], "execute_result");
    assert_eq!(resolved["data"]["text/plain"], "2");
    assert_eq!(resolved["execution_count"], 1);

    // Resolve cell-2's display_data with the large image
    let outputs2 = get_outputs(&eid2);
    let manifest = &outputs2[0];
    let parsed_manifest2: crate::output_store::OutputManifest =
        serde_json::from_value(manifest.clone()).unwrap();
    // The manifest should contain a blob ref for the large image, not inline
    let image_ref = &manifest["data"]["image/png"];
    assert!(
        image_ref.get("blob").is_some(),
        "Large image should be stored as blob ref, not inlined: {}",
        image_ref
    );
    // Full round-trip should reconstruct original data
    let resolved = crate::output_store::resolve_manifest(&parsed_manifest2, &blob_store)
        .await
        .unwrap();
    assert_eq!(resolved["output_type"], "display_data");
    assert_eq!(resolved["data"]["image/png"], large_image);

    // Resolve cell-3's stream output
    let outputs3 = get_outputs(&eid3);
    let manifest = &outputs3[0];
    let parsed_manifest: crate::output_store::OutputManifest =
        serde_json::from_value(manifest.clone()).unwrap();
    let resolved = crate::output_store::resolve_manifest(&parsed_manifest, &blob_store)
        .await
        .unwrap();
    assert_eq!(resolved["output_type"], "stream");
    assert_eq!(resolved["name"], "stdout");
    assert_eq!(resolved["text"], "hi\n");
}

#[tokio::test]
async fn test_initial_load_hydrates_widget_metadata_into_runtime_comms() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let widget_bytes = b"widget-bytes";
    let widget_data = base64::engine::general_purpose::STANDARD.encode(widget_bytes);

    let notebook_json = serde_json::json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "widgets": {
                WIDGET_STATE_MIME: {
                    "version_major": 2,
                    "version_minor": 0,
                    "state": {
                        "slider-model": {
                            "model_name": "IntSliderModel",
                            "model_module": "@jupyter-widgets/controls",
                            "model_module_version": "2.0.0",
                            "state": {
                                "_view_name": "IntSliderView",
                                "_view_module": "@jupyter-widgets/controls",
                                "_view_module_version": "2.0.0",
                                "description": "Answer",
                                "value": 42
                            },
                            "buffers": [
                                {
                                    "encoding": "base64",
                                    "path": ["binary_value"],
                                    "data": widget_data
                                }
                            ]
                        }
                    }
                }
            }
        },
        "cells": [
            {
                "id": "cell-widget",
                "cell_type": "code",
                "source": "slider",
                "execution_count": 1,
                "metadata": {},
                "outputs": [
                    {
                        "output_type": "display_data",
                        "data": {
                            "application/vnd.jupyter.widget-view+json": {
                                "version_major": 2,
                                "version_minor": 0,
                                "model_id": "slider-model"
                            },
                            "text/plain": "IntSlider(value=42)"
                        },
                        "metadata": {}
                    }
                ]
            }
        ]
    });

    let ipynb_path = tmp.path().join("widget-load.ipynb");
    std::fs::write(
        &ipynb_path,
        serde_json::to_string_pretty(&notebook_json).unwrap(),
    )
    .unwrap();

    let (room, _guard, settled) = materialized_room_from_disk(&tmp, &ipynb_path).await;
    assert_source_ready(&settled);

    let comm = room
        .state
        .with_doc(|sd| Ok(sd.get_comm("slider-model")))
        .unwrap()
        .expect("widget metadata should hydrate RuntimeStateDoc topology");
    assert_eq!(comm.target_name, JUPYTER_WIDGET_TARGET);
    assert_eq!(comm.model_name, "IntSliderModel");
    assert_eq!(comm.model_module, "@jupyter-widgets/controls");
    assert_eq!(
        comm.state,
        serde_json::json!({}),
        "mutable widget state should live in CommsDoc, not RuntimeStateDoc topology"
    );

    let comm_state = room
        .comms
        .with_doc(|cd| Ok(cd.get_comm_state("slider-model")))
        .unwrap()
        .expect("widget metadata should hydrate CommsDoc state");
    assert_eq!(
        comm_state["_model_name"],
        serde_json::json!("IntSliderModel")
    );
    assert_eq!(
        comm_state["_model_module"],
        serde_json::json!("@jupyter-widgets/controls")
    );
    assert_eq!(
        comm_state["_model_module_version"],
        serde_json::json!("2.0.0")
    );
    assert_eq!(comm_state["_view_name"], serde_json::json!("IntSliderView"));
    assert_eq!(comm_state["value"], serde_json::json!(42));

    let binary_ref = &comm_state["binary_value"];
    let binary_hash = binary_ref
        .get("blob")
        .and_then(serde_json::Value::as_str)
        .expect("widget buffer should be stored as a blob ref");
    assert_eq!(
        binary_ref["media_type"],
        serde_json::json!("application/octet-stream")
    );
    assert_eq!(
        blob_store.get(binary_hash).await.unwrap().as_deref(),
        Some(widget_bytes.as_slice())
    );

    let eid = room
        .doc
        .read()
        .await
        .get_execution_id("cell-widget")
        .expect("widget output should still link through RuntimeStateDoc");
    let outputs = room.state.with_doc(|sd| Ok(sd.get_outputs(&eid))).unwrap();
    let parsed_manifest: crate::output_store::OutputManifest =
        serde_json::from_value(outputs[0].clone()).unwrap();
    let resolved = crate::output_store::resolve_manifest(&parsed_manifest, &blob_store)
        .await
        .unwrap();
    assert_eq!(
        resolved["data"]["application/vnd.jupyter.widget-view+json"]["model_id"],
        serde_json::json!("slider-model")
    );
}

#[tokio::test]
async fn test_initial_load_reuses_matching_durable_execution_id() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);

    let notebook_json = serde_json::json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "id": "cell-1",
                "cell_type": "code",
                "source": "print('hi')",
                "execution_count": 7,
                "metadata": {},
                "outputs": [
                    {
                        "output_type": "stream",
                        "name": "stdout",
                        "text": "hi\n"
                    }
                ]
            }
        ]
    });
    let ipynb_path = tmp.path().join("durable.ipynb");
    std::fs::write(
        &ipynb_path,
        serde_json::to_string_pretty(&notebook_json).unwrap(),
    )
    .unwrap();

    let context_id = ipynb_path.to_string_lossy().to_string();
    let store_dir = tmp.path().join("execution-store");

    // First materialization has no durable records, so it mints a synthetic
    // execution. Capture its manifest refs to author a matching durable
    // record for the reload.
    let outputs = {
        let (first_room, _guard, settled) = materialized_room_from_disk_with(
            Uuid::new_v4(),
            tmp.path(),
            blob_store.clone(),
            &ipynb_path,
            &store_dir,
        )
        .await;
        assert_source_ready(&settled);
        let first_execution_id = first_room
            .doc
            .read()
            .await
            .get_execution_id("cell-1")
            .unwrap();
        first_room
            .state
            .with_doc(|sd| Ok(sd.get_outputs(&first_execution_id)))
            .unwrap()
    };

    let store = runtimed_client::execution_store::ExecutionStore::new(store_dir.clone());
    store
        .write_record(runtimed_client::execution_store::ExecutionRecord {
            schema_version: runtimed_client::execution_store::EXECUTION_RECORD_SCHEMA_VERSION,
            execution_id: "durable-exec-1".to_string(),
            context_kind: "notebook".to_string(),
            context_id: context_id.clone(),
            notebook_path: Some(context_id.clone()),
            cell_id: Some("cell-1".to_string()),
            status: "error".to_string(),
            success: Some(false),
            execution_count: Some(7),
            source: Some("print('hi')".to_string()),
            seq: Some(0),
            submitted_by_actor_label: None,
            outputs,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        })
        .await
        .unwrap();

    let (reload_room, _guard, settled) = materialized_room_from_disk_with(
        Uuid::new_v4(),
        tmp.path(),
        blob_store,
        &ipynb_path,
        &store_dir,
    )
    .await;
    assert_source_ready(&settled);

    assert_eq!(
        reload_room
            .doc
            .read()
            .await
            .get_execution_id("cell-1")
            .as_deref(),
        Some("durable-exec-1")
    );
    let reloaded_execution = reload_room
        .state
        .with_doc(|sd| Ok(sd.get_execution("durable-exec-1")))
        .unwrap()
        .unwrap();
    assert_eq!(reloaded_execution.execution_count, Some(7));
    assert_eq!(reloaded_execution.status, "error");
    assert_eq!(reloaded_execution.success, Some(false));
}

#[tokio::test]
async fn test_initial_load_mints_execution_id_when_durable_record_no_longer_matches() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);

    let notebook_json = serde_json::json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "id": "cell-1",
                "cell_type": "code",
                "source": "print('changed externally')",
                "execution_count": 7,
                "metadata": {},
                "outputs": [
                    {
                        "output_type": "stream",
                        "name": "stdout",
                        "text": "hi\n"
                    }
                ]
            }
        ]
    });
    let ipynb_path = tmp.path().join("changed.ipynb");
    std::fs::write(
        &ipynb_path,
        serde_json::to_string_pretty(&notebook_json).unwrap(),
    )
    .unwrap();

    let context_id = ipynb_path.to_string_lossy().to_string();
    let store_dir = tmp.path().join("execution-store");
    let store = runtimed_client::execution_store::ExecutionStore::new(store_dir.clone());
    store
        .write_record(runtimed_client::execution_store::ExecutionRecord {
            schema_version: runtimed_client::execution_store::EXECUTION_RECORD_SCHEMA_VERSION,
            execution_id: "durable-exec-1".to_string(),
            context_kind: "notebook".to_string(),
            context_id: context_id.clone(),
            notebook_path: Some(context_id.clone()),
            cell_id: Some("cell-1".to_string()),
            status: "done".to_string(),
            success: Some(true),
            execution_count: Some(7),
            source: Some("print('hi')".to_string()),
            seq: Some(0),
            submitted_by_actor_label: None,
            outputs: vec![serde_json::json!({
                "output_type": "stream",
                "name": "stdout",
                "text": {"inline": "hi\n"}
            })],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        })
        .await
        .unwrap();

    let (room, _guard, settled) = materialized_room_from_disk_with(
        Uuid::new_v4(),
        tmp.path(),
        blob_store,
        &ipynb_path,
        &store_dir,
    )
    .await;
    assert_source_ready(&settled);

    let execution_id = room.doc.read().await.get_execution_id("cell-1").unwrap();
    assert_ne!(execution_id, "durable-exec-1");
    assert!(room
        .state
        .with_doc(|sd| Ok(sd.get_execution(&execution_id)))
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn test_initial_load_resolves_nbformat_attachments() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);

    let notebook_json = serde_json::json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "id": "markdown-1",
                "cell_type": "markdown",
                "source": ["![inline](attachment:image.png)"],
                "metadata": {},
                "attachments": {
                    "image.png": {
                        "image/png": "aGVsbG8="
                    }
                }
            }
        ]
    });

    let ipynb_path = tmp.path().join("attachments.ipynb");
    std::fs::write(
        &ipynb_path,
        serde_json::to_string_pretty(&notebook_json).unwrap(),
    )
    .unwrap();

    let (room, _guard, settled) = materialized_room_from_disk(&tmp, &ipynb_path).await;
    assert_source_ready(&settled);
    let cells = {
        let doc = room.doc.read().await;
        assert_eq!(doc.cell_count(), 1);
        doc.get_cells()
    };
    assert_eq!(cells.len(), 1);

    let hash = cells[0]
        .resolved_assets
        .get("attachment:image.png")
        .expect("attachment should resolve into render assets");

    let bytes = blob_store.get(hash).await.unwrap().unwrap();
    assert_eq!(bytes, b"hello");

    let attachment_ref = cells[0]
        .attachments
        .get("image.png")
        .and_then(|bundle| bundle.get("image/png"))
        .expect("attachment should be stored in the cell schema");
    assert_eq!(attachment_ref.blob_hash, *hash);
    assert_eq!(attachment_ref.encoding, AttachmentEncoding::Base64);
}

#[tokio::test]
async fn test_initial_load_preserves_json_attachment_payloads() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);

    let expected_attachments = serde_json::json!({
        "payload.json": {
            "application/json": {"kind": "loaded"}
        },
        "label.json": {
            "application/json": "loaded-string"
        }
    });
    let notebook_json = serde_json::json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "id": "raw-1",
                "cell_type": "raw",
                "source": ["attachment ref"],
                "metadata": {},
                "attachments": expected_attachments
            }
        ]
    });

    let ipynb_path = tmp.path().join("json-attachments.ipynb");
    std::fs::write(
        &ipynb_path,
        serde_json::to_string_pretty(&notebook_json).unwrap(),
    )
    .unwrap();

    let (room, _guard, settled) = materialized_room_from_disk(&tmp, &ipynb_path).await;
    assert_source_ready(&settled);

    let cells = room.doc.read().await.get_cells();
    assert_eq!(cells.len(), 1);
    let reconstructed = attachment_refs_to_nbformat_value(&cells[0].attachments, &blob_store)
        .await
        .unwrap();
    assert_eq!(reconstructed, expected_attachments);
}

#[tokio::test]
async fn test_initial_load_rejects_invalid_attachment_payloads() {
    let tmp = tempfile::TempDir::new().unwrap();

    let notebook_json = serde_json::json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "id": "markdown-1",
                "cell_type": "markdown",
                "source": ["![inline](attachment:image.png)"],
                "metadata": {},
                "attachments": {
                    "image.png": {
                        "image/png": "not valid base64"
                    }
                }
            }
        ]
    });

    let ipynb_path = tmp.path().join("invalid-attachments.ipynb");
    std::fs::write(
        &ipynb_path,
        serde_json::to_string_pretty(&notebook_json).unwrap(),
    )
    .unwrap();

    let (_room, _guard, settled) = materialized_room_from_disk(&tmp, &ipynb_path).await;
    let RoomSourceState::Failed(status) = settled else {
        panic!("invalid attachment payload should fail materialization, got {settled:?}");
    };
    let error = status
        .error
        .expect("failed materialization should carry its error");
    assert!(
        error.message.contains("base64 payload is invalid"),
        "unexpected error: {}",
        error.message
    );
}

#[tokio::test]
async fn test_initial_load_skips_code_cell_asset_resolution() {
    let tmp = tempfile::TempDir::new().unwrap();
    std::fs::write(tmp.path().join("image.png"), b"hello").unwrap();

    let notebook_json = serde_json::json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "id": "code-1",
                "cell_type": "code",
                "source": ["![inline](image.png)"],
                "metadata": {},
                "outputs": [],
                "execution_count": null
            }
        ]
    });

    let ipynb_path = tmp.path().join("code-assets.ipynb");
    std::fs::write(
        &ipynb_path,
        serde_json::to_string_pretty(&notebook_json).unwrap(),
    )
    .unwrap();

    let (room, _guard, settled) = materialized_room_from_disk(&tmp, &ipynb_path).await;
    assert_source_ready(&settled);

    let cells = room.doc.read().await.get_cells();
    assert_eq!(cells.len(), 1);
    assert!(cells[0].resolved_assets.is_empty());
}

#[tokio::test]
async fn test_process_markdown_assets_rebuilds_stale_refs() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "assets.ipynb");
    std::fs::write(&notebook_path, "{}").unwrap();
    std::fs::write(tmp.path().join("img1.png"), b"one").unwrap();
    std::fs::write(tmp.path().join("img2.png"), b"two").unwrap();

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "markdown-1", "markdown").unwrap();
        doc.update_source("markdown-1", "![one](img1.png)").unwrap();
    }

    process_markdown_assets(&room).await;

    {
        let cells = room.doc.read().await.get_cells();
        let assets = &cells[0].resolved_assets;
        assert!(assets.contains_key("img1.png"));
        assert_eq!(assets.len(), 1);
    }

    {
        let mut doc = room.doc.write().await;
        doc.update_source("markdown-1", "![two](img2.png)").unwrap();
    }

    process_markdown_assets(&room).await;

    let cells = room.doc.read().await.get_cells();
    let assets = &cells[0].resolved_assets;
    assert!(assets.contains_key("img2.png"));
    assert!(!assets.contains_key("img1.png"));
    assert_eq!(assets.len(), 1);
}

#[tokio::test]
async fn test_process_markdown_assets_resolves_existing_attachment_refs() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "attachment-assets.ipynb");
    std::fs::write(&notebook_path, "{}").unwrap();

    let hash = room.blob_store.put(b"hello", "image/png").await.unwrap();
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "markdown-1", "markdown").unwrap();
        doc.update_source("markdown-1", "![inline](attachment:image.png)")
            .unwrap();
        let attachments = HashMap::from([(
            "image.png".to_string(),
            HashMap::from([(
                "image/png".to_string(),
                AttachmentRef {
                    blob_hash: hash.clone(),
                    encoding: AttachmentEncoding::Base64,
                },
            )]),
        )]);
        doc.set_cell_attachments("markdown-1", &attachments)
            .unwrap();
    }

    process_markdown_assets(&room).await;

    let cells = room.doc.read().await.get_cells();
    assert_eq!(
        cells[0]
            .resolved_assets
            .get("attachment:image.png")
            .map(String::as_str),
        Some(hash.as_str())
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_with_target_path() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _original_path) = test_room_with_path(&tmp, "original.ipynb");

    // Add a cell
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "x = 1").unwrap();
    }

    // Save to a different absolute path
    let new_path = tmp.path().join("new_location.ipynb");
    let result = save_notebook_to_disk(&room, Some(new_path.to_str().unwrap())).await;

    assert!(result.is_ok());
    let saved_path = result.unwrap();
    assert_eq!(saved_path.path(), new_path.to_string_lossy());
    assert!(new_path.exists(), "File should be created at new path");

    // Verify content
    let content = std::fs::read_to_string(&new_path).unwrap();
    let notebook: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!(notebook["cells"][0]["source"], serde_json::json!(["x = 1"]));
}

#[tokio::test]
async fn test_save_notebook_to_disk_preserves_nbformat_attachments_from_doc() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, original_path) = test_room_with_path(&tmp, "original.ipynb");

    {
        let hash = room.blob_store.put(b"hello", "image/png").await.unwrap();
        let mut attachment_refs = HashMap::new();
        attachment_refs.insert(
            "image.png".to_string(),
            HashMap::from([(
                "image/png".to_string(),
                AttachmentRef {
                    blob_hash: hash,
                    encoding: AttachmentEncoding::Base64,
                },
            )]),
        );
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "markdown-1", "markdown").unwrap();
        doc.update_source("markdown-1", "![inline](attachment:image.png)")
            .unwrap();
        doc.set_cell_attachments("markdown-1", &attachment_refs)
            .unwrap();
    }

    save_notebook_to_disk(&room, None).await.unwrap();

    let content = std::fs::read_to_string(&original_path).unwrap();
    let notebook: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!(
        notebook["cells"][0]["attachments"],
        serde_json::json!({
            "image.png": {
                "image/png": "aGVsbG8="
            }
        })
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_preserves_raw_cell_attachments_from_doc() {
    // The Jupyter v4.5 schema permits `attachments` on raw cells. nbformat
    // 2.2.0's `v4::Cell::Raw` has no slot for them, so the typed pipeline
    // drops them during conversion and `serialize_v4_notebook` re-injects
    // them onto the serialized output. This test pins the round-trip.
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, original_path) = test_room_with_path(&tmp, "raw.ipynb");

    {
        let hash = room.blob_store.put(b"hello", "text/plain").await.unwrap();
        let json_payload = serde_json::json!({"kind": "raw-attachment"});
        let json_hash = room
            .blob_store
            .put(
                &serde_json::to_vec(&json_payload).unwrap(),
                "application/json",
            )
            .await
            .unwrap();
        let mut attachment_refs = HashMap::new();
        attachment_refs.insert(
            "snippet.txt".to_string(),
            HashMap::from([
                (
                    "text/plain".to_string(),
                    AttachmentRef {
                        blob_hash: hash,
                        encoding: AttachmentEncoding::Text,
                    },
                ),
                (
                    "application/json".to_string(),
                    AttachmentRef {
                        blob_hash: json_hash,
                        encoding: AttachmentEncoding::Json,
                    },
                ),
            ]),
        );
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "raw-1", "raw").unwrap();
        doc.update_source("raw-1", "attachment ref").unwrap();
        doc.set_cell_attachments("raw-1", &attachment_refs).unwrap();
    }

    save_notebook_to_disk(&room, None).await.unwrap();

    let content = std::fs::read_to_string(&original_path).unwrap();
    let notebook: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!(
        notebook["cells"][0]["attachments"],
        serde_json::json!({
            "snippet.txt": {
                "application/json": {"kind": "raw-attachment"},
                "text/plain": "hello"
            }
        })
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_treats_missing_attachment_blob_as_unrecoverable() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _original_path) = test_room_with_path(&tmp, "missing-attachment.ipynb");

    {
        let attachment_refs = HashMap::from([(
            "missing.png".to_string(),
            HashMap::from([(
                "image/png".to_string(),
                AttachmentRef {
                    blob_hash: "missing-blob".to_string(),
                    encoding: AttachmentEncoding::Base64,
                },
            )]),
        )]);
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "markdown-1", "markdown").unwrap();
        doc.update_source("markdown-1", "![inline](attachment:missing.png)")
            .unwrap();
        doc.set_cell_attachments("markdown-1", &attachment_refs)
            .unwrap();
    }

    let error = save_notebook_to_disk(&room, None)
        .await
        .expect_err("missing attachment blob should fail save");
    assert!(
        matches!(error, SaveError::Unrecoverable(_)),
        "missing blob should not be retried forever: {error}"
    );
    assert!(
        error.to_string().contains("missing attachment blob"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_appends_ipynb_extension() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _original_path) = test_room_with_path(&tmp, "original.ipynb");

    // Add a cell
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
    }

    // Save to path without .ipynb extension
    let base_path = tmp.path().join("no_extension");
    let result = save_notebook_to_disk(&room, Some(base_path.to_str().unwrap())).await;

    assert!(result.is_ok());
    let saved_path = result.unwrap();
    assert!(
        saved_path.path().ends_with(".ipynb"),
        "Saved path should have .ipynb extension"
    );

    let expected_path = tmp.path().join("no_extension.ipynb");
    assert!(
        expected_path.exists(),
        "File should exist with .ipynb extension"
    );
}

#[tokio::test]
async fn test_save_notebook_to_disk_rejects_relative_path() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _original_path) = test_room_with_path(&tmp, "original.ipynb");

    // Try to save with a relative path
    let result = save_notebook_to_disk(&room, Some("relative/path.ipynb")).await;

    assert!(result.is_err());
    let error = result.unwrap_err();
    assert!(
        matches!(error, SaveError::Unrecoverable(_)),
        "Error should be unrecoverable: {}",
        error
    );
    assert!(
        error
            .to_string()
            .contains("Relative paths are not supported"),
        "Error should mention relative paths: {}",
        error
    );
}

#[tokio::test]
async fn test_format_notebook_cells_skips_unknown_runtime() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _notebook_path) = test_room_with_path(&tmp, "unknown_runtime.ipynb");

    // Add a code cell (no kernelspec metadata set = unknown runtime)
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "x=1").unwrap(); // Would be formatted if Python
    }

    // Run format - should skip (return 0) since no kernelspec
    let result = format_notebook_cells(&room).await;
    assert!(result.is_ok());
    assert_eq!(
        result.unwrap(),
        0,
        "Should format 0 cells for unknown runtime"
    );

    // Source should be unchanged
    let cells = {
        let doc = room.doc.read().await;
        doc.get_cells()
    };
    assert_eq!(cells[0].source, "x=1", "Source should remain unchanged");
}

#[tokio::test]
async fn test_save_notebook_skips_format_when_disable_auto_format_enabled() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "disable-format.ipynb");
    let room = Arc::new(room);
    let daemon = crate::daemon::Daemon::new_for_test(test_daemon_config(&tmp)).unwrap();

    assert_eq!(
        format_source("x=1", "python").await.as_deref(),
        Some("x = 1"),
        "test requires the Python formatter to be available"
    );

    {
        let mut settings = daemon.settings.write().await;
        settings.put_bool("disable_auto_format", true);
    }

    {
        let mut doc = room.doc.write().await;
        let metadata = build_new_notebook_metadata(
            "python",
            "test-env-id",
            crate::settings_doc::PythonEnvType::Uv,
            None,
            &[],
        );
        doc.set_metadata_snapshot(&metadata).unwrap();
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "x=1").unwrap();
    }
    commit_test_room_doc(&room).await;

    let response = crate::requests::save_notebook::handle(&room, &daemon, true, None).await;
    assert!(
        matches!(
            response,
            crate::protocol::NotebookResponse::NotebookSaved { .. }
        ),
        "expected NotebookSaved, got {response:?}"
    );

    let cells = {
        let doc = room.doc.read().await;
        doc.get_cells()
    };
    assert_eq!(
        cells[0].source, "x=1",
        "CRDT source should remain unformatted"
    );

    let saved: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&notebook_path).unwrap()).unwrap();
    assert_eq!(
        notebook_text_mime(saved["cells"][0].get("source")).as_deref(),
        Some("x=1"),
        "saved file source should remain unformatted"
    );
}

// ========================================================================
// Tests for daemon-owned notebook loading functions
// ========================================================================

#[test]
fn test_build_new_notebook_metadata_deno() {
    let metadata = build_new_notebook_metadata(
        "deno",
        "test-env-id",
        crate::settings_doc::PythonEnvType::Uv,
        None,
        &[],
    );

    assert_eq!(metadata.kernelspec.as_ref().unwrap().name, "deno");
    assert_eq!(metadata.kernelspec.as_ref().unwrap().display_name, "Deno");
    assert_eq!(
        metadata.kernelspec.as_ref().unwrap().language,
        Some("typescript".to_string())
    );
    assert_eq!(metadata.language_info.as_ref().unwrap().name, "typescript");
    assert_eq!(metadata.runt.env_id, Some("test-env-id".to_string()));
    assert!(metadata.runt.uv.is_none());
    assert!(metadata.runt.conda.is_none());
}

#[test]
fn test_build_new_notebook_metadata_python_uv() {
    let metadata = build_new_notebook_metadata(
        "python",
        "test-env-id",
        crate::settings_doc::PythonEnvType::Uv,
        None,
        &[],
    );

    assert_eq!(metadata.kernelspec.as_ref().unwrap().name, "python3");
    assert_eq!(
        metadata.kernelspec.as_ref().unwrap().display_name,
        "Python 3"
    );
    assert_eq!(
        metadata.kernelspec.as_ref().unwrap().language,
        Some("python".to_string())
    );
    assert_eq!(metadata.language_info.as_ref().unwrap().name, "python");
    assert_eq!(metadata.runt.env_id, Some("test-env-id".to_string()));
    assert!(metadata.runt.uv.is_some());
    assert!(metadata.runt.conda.is_none());
    assert!(metadata.runt.uv.as_ref().unwrap().dependencies.is_empty());
}

#[test]
fn test_build_new_notebook_metadata_python_conda() {
    let metadata = build_new_notebook_metadata(
        "python",
        "test-env-id",
        crate::settings_doc::PythonEnvType::Conda,
        None,
        &[],
    );

    assert_eq!(metadata.kernelspec.as_ref().unwrap().name, "python3");
    assert_eq!(metadata.language_info.as_ref().unwrap().name, "python");
    assert_eq!(metadata.runt.env_id, Some("test-env-id".to_string()));
    assert!(metadata.runt.uv.is_none());
    assert!(metadata.runt.conda.is_some());
    assert!(metadata
        .runt
        .conda
        .as_ref()
        .unwrap()
        .dependencies
        .is_empty());
    // Verify default channels to avoid false channel-drift detection
    assert_eq!(
        metadata.runt.conda.as_ref().unwrap().channels,
        vec!["conda-forge".to_string()]
    );
}

#[test]
fn test_create_empty_notebook_python() {
    let mut doc = NotebookDoc::new("test");
    let result = create_empty_notebook(
        &mut doc,
        "python",
        crate::settings_doc::PythonEnvType::Uv,
        None,
        None,
        &[],
    );

    assert!(result.is_ok());
    let env_id = result.unwrap();
    assert!(!env_id.is_empty(), "Should generate an env_id");

    // Fresh notebook structure is daemon-owned. The frontend must not infer
    // "new notebook" from an empty sync state and create this locally.
    assert_eq!(doc.cell_count(), 1);
    let cells = doc.get_cells();
    assert_eq!(cells[0].cell_type, "code");
    assert!(cells[0].source.is_empty());
}

#[test]
fn test_create_empty_notebook_deno() {
    let mut doc = NotebookDoc::new("test");
    let result = create_empty_notebook(
        &mut doc,
        "deno",
        crate::settings_doc::PythonEnvType::Uv, // Ignored for deno
        None,
        None,
        &[],
    );

    assert!(result.is_ok());
    assert_eq!(doc.cell_count(), 1);
    let cells = doc.get_cells();
    assert_eq!(cells[0].cell_type, "code");
    assert!(cells[0].source.is_empty());

    // Check metadata was set correctly
    let metadata = doc.get_metadata_snapshot();
    assert!(metadata.is_some());
    let metadata = metadata.unwrap();
    assert_eq!(metadata.kernelspec.as_ref().unwrap().name, "deno");
}

#[test]
fn test_create_empty_notebook_with_provided_env_id() {
    let mut doc = NotebookDoc::new("test");
    let provided_id = "my-custom-env-id";
    let result = create_empty_notebook(
        &mut doc,
        "python",
        crate::settings_doc::PythonEnvType::Uv,
        Some(provided_id),
        None,
        &[],
    );

    assert!(result.is_ok());
    let env_id = result.unwrap();
    assert_eq!(env_id, provided_id, "Should use provided env_id");

    let metadata = doc.get_metadata_snapshot().unwrap();
    assert_eq!(
        metadata.runt.env_id,
        Some(provided_id.to_string()),
        "Metadata should have provided env_id"
    );
}

/// Benchmark streaming load phases against a real notebook.
///
/// Reads `/tmp/gelmanschools-bench.ipynb` and profiles:
/// - jiter parse time
/// - blob store output processing per batch
/// - add_cell_full per batch
/// - generate_sync_message per batch
///
/// Run with: cargo test -p runtimed -- bench_streaming_load_steps --nocapture --ignored
#[tokio::test]
#[ignore] // Only run manually — requires the fixture notebook
async fn bench_streaming_load_steps() {
    let notebook_path = std::path::Path::new("/tmp/gelmanschools-bench.ipynb");
    if !notebook_path.exists() {
        eprintln!("Skipping: /tmp/gelmanschools-bench.ipynb not found");
        eprintln!("Copy the gelmanschools notebook there first:");
        eprintln!("  cp ~/Downloads/gelmanschools/index.ipynb /tmp/gelmanschools-bench.ipynb");
        return;
    }

    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);

    // Step 1: Read + parse
    let t0 = std::time::Instant::now();
    let bytes = std::fs::read(notebook_path).unwrap();
    let read_elapsed = t0.elapsed();

    let t_parse = std::time::Instant::now();
    let parsed = parse_notebook_jiter_for_notebook(&bytes, Uuid::nil()).unwrap();
    let cells = parsed.cells;
    let parse_elapsed = t_parse.elapsed();

    eprintln!(
        "--- Notebook: {} cells, {} bytes ---",
        cells.len(),
        bytes.len()
    );
    eprintln!("  Read file:  {:?}", read_elapsed);
    eprintln!("  jiter parse: {:?}", parse_elapsed);

    // Create doc + peer state
    let mut doc = notebook_doc::NotebookDoc::new("bench");
    let mut peer_state = automerge::sync::State::new();

    let batch_size = STREAMING_BATCH_SIZE;
    let mut cell_iter = cells.into_iter().enumerate().peekable();
    let mut batch_num = 0u32;

    let mut total_blob = std::time::Duration::ZERO;
    let mut total_add = std::time::Duration::ZERO;
    let mut total_sync_gen = std::time::Duration::ZERO;

    while cell_iter.peek().is_some() {
        // Blob store phase
        let t_blob = std::time::Instant::now();
        let mut batch: Vec<(usize, StreamingCell, Vec<serde_json::Value>)> = Vec::new();
        let mut batch_output_bytes = 0usize;
        for _ in 0..batch_size {
            let Some((idx, cell)) = cell_iter.next() else {
                break;
            };
            let mut output_refs = Vec::with_capacity(cell.outputs.len());
            for output in &cell.outputs {
                batch_output_bytes += output.to_string().len();
                output_refs.push(output_value_to_manifest_ref(output, &blob_store).await);
            }
            batch.push((idx, cell, output_refs));
        }
        let blob_elapsed = t_blob.elapsed();

        // add_cell_full phase
        let t_add = std::time::Instant::now();
        for (_idx, cell, _output_refs) in &batch {
            doc.add_cell_full(
                &cell.id,
                &cell.cell_type,
                &cell.position,
                &cell.source,
                &cell.execution_count,
                &cell.metadata,
            )
            .unwrap();
        }
        let add_elapsed = t_add.elapsed();

        // generate_sync_message phase
        let t_sync = std::time::Instant::now();
        let encoded = doc
            .generate_sync_message(&mut peer_state)
            .map(|m| m.encode());
        let sync_elapsed = t_sync.elapsed();
        let msg_size = encoded.as_ref().map(|e| e.len()).unwrap_or(0);

        batch_num += 1;
        eprintln!(
            "  Batch {:2} ({} cells, {:6}KB output): blob={:>8?}  add={:>8?}  sync_gen={:>8?}  msg={}KB",
            batch_num,
            batch.len(),
            batch_output_bytes / 1024,
            blob_elapsed,
            add_elapsed,
            sync_elapsed,
            msg_size / 1024,
        );

        total_blob += blob_elapsed;
        total_add += add_elapsed;
        total_sync_gen += sync_elapsed;
    }

    eprintln!("--- Totals ---");
    eprintln!("  blob store:         {:?}", total_blob);
    eprintln!("  add_cell_full:      {:?}", total_add);
    eprintln!("  generate_sync_msg:  {:?}", total_sync_gen);
    eprintln!(
        "  total (no I/O):     {:?}",
        total_blob + total_add + total_sync_gen
    );
    eprintln!("  cells: {}, batches: {}", doc.cell_count(), batch_num);
}

#[tokio::test]
async fn test_update_kernel_presence_publishes_state_and_relays() {
    let presence_state = Arc::new(RwLock::new(PresenceState::new()));
    let (presence_tx, mut presence_rx) = broadcast::channel::<(String, Vec<u8>)>(16);

    update_kernel_presence(
        &presence_state,
        &presence_tx,
        presence::KernelStatus::Idle,
        "uv:prewarmed",
    )
    .await;

    // Verify presence state contains the daemon peer with KernelState channel
    let state = presence_state.read().await;
    let peers = state.peers();
    let daemon_peer = peers.get("daemon").expect("daemon peer should exist");
    assert_eq!(daemon_peer.peer_id, "daemon");

    let kernel_channel = daemon_peer
        .channels
        .get(&presence::Channel::KernelState)
        .expect("kernel_state channel should exist");
    match kernel_channel {
        presence::ChannelData::KernelState(data) => {
            assert_eq!(data.status, presence::KernelStatus::Idle);
            assert_eq!(data.env_source, "uv:prewarmed");
        }
        other => panic!("expected KernelState, got {:?}", other),
    }
    drop(state);

    // Verify a relay frame was sent
    let (peer_id, bytes) = presence_rx
        .recv()
        .await
        .expect("should receive relay frame");
    assert_eq!(peer_id, "daemon");
    // Decode the frame to verify it's a valid KernelState update
    let msg = presence::decode_message(&bytes).expect("should decode presence message");
    match msg {
        presence::PresenceMessage::Update { peer_id, data, .. } => {
            assert_eq!(peer_id, "daemon");
            match data {
                presence::ChannelData::KernelState(data) => {
                    assert_eq!(data.status, presence::KernelStatus::Idle);
                    assert_eq!(data.env_source, "uv:prewarmed");
                }
                other => panic!("expected KernelState data, got {:?}", other),
            }
        }
        other => panic!("expected Update message, got {:?}", other),
    }
}

// ── Regression test: autosave after save_notebook path update ──────

/// Verify that saving an untitled (UUID-keyed) room updates path_index and
/// room.file_binding.path, while keeping the UUID stable in the rooms map.
#[tokio::test]
async fn saving_untitled_notebook_updates_path_index_and_keeps_uuid() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();

    // 1. Create an ephemeral-but-persisted room (UUID, no path)
    let uuid = Uuid::new_v4();
    let room = Arc::new(NotebookRoom::new_fresh(
        uuid, None, &docs_dir, blob_store, false,
    ));
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "c1", "code").unwrap();
    }
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    rooms
        .insert_or_get(uuid, room.clone(), None)
        .await
        .expect("registry insert for test setup");

    // 2. Simulate the handler's transition: save to disk then bind the path.
    let save_target = tmp.path().join("note.ipynb");
    let written = save_notebook_to_disk(&room, Some(save_target.to_str().unwrap()))
        .await
        .unwrap();
    let canonical = tokio::fs::canonicalize(&written)
        .await
        .unwrap_or_else(|_| PathBuf::from(written.path()));

    rooms.bind_path(room.id, canonical.clone()).await.unwrap();
    room.file_binding
        .set_path_for_test(Some(canonical.clone()))
        .await;

    // UUID key unchanged, path index populated, room.file_binding.path set.
    assert!(rooms.peek_uuid(uuid).await.is_some());
    assert_eq!(rooms.peek_path_uuid(&canonical).await, Some(uuid));
    assert_eq!(
        room.file_binding.path().await.as_deref(),
        Some(canonical.as_path())
    );
}

/// Verify that `promote_untitled_to_file_backed` returns
/// `SaveBlockedReason::PathAlreadyOpen` when the target path is already held by
/// another room, and does NOT mutate the fresh room's state on error.
#[tokio::test]
async fn saving_to_already_open_path_returns_path_already_open_error() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();

    // Existing room already claiming `target_path`.
    let existing_uuid = Uuid::new_v4();
    let target_path = tmp.path().join("existing.ipynb");
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    rooms
        .bind_path(existing_uuid, target_path.clone())
        .await
        .unwrap();

    // Fresh untitled room that tries to claim the same path.
    let new_uuid = Uuid::new_v4();
    let room = Arc::new(NotebookRoom::new_fresh(
        new_uuid, None, &docs_dir, blob_store, false,
    ));

    // Try to claim the path — must fail.
    let err = try_claim_path(&rooms, &target_path, new_uuid)
        .await
        .unwrap_err();

    match err {
        notebook_protocol::protocol::SaveBlockedReason::PathAlreadyOpen { uuid, path: p } => {
            assert_eq!(uuid, existing_uuid.to_string());
            assert_eq!(p, target_path.to_string_lossy());
        }
        other => panic!("expected PathAlreadyOpen, got {:?}", other),
    }

    // room.file_binding.path must NOT have been mutated on error.
    assert!(
        room.file_binding.path().await.is_none(),
        "room.file_binding.path should still be None after a failed claim"
    );
}

/// Regression test for the demo-day incident: when a second room tries to
/// save to a path that another room already claims, the claim check must
/// happen BEFORE any disk write. Otherwise the second room's save writes
/// 0 cells to the shared path, the first room's file watcher interprets
/// that as an external edit, and the first room's CRDT cells are wiped.
#[tokio::test]
async fn path_collision_does_not_overwrite_existing_file() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();

    // Room A claims the path; write a known marker payload to disk.
    let target_path = tmp.path().join("shared.ipynb");
    let marker_content = r#"{"cells":[{"cell_type":"code","source":"x = 1"}],"metadata":{},"nbformat":4,"nbformat_minor":5}"#;
    tokio::fs::write(&target_path, marker_content)
        .await
        .unwrap();

    // Canonicalize before inserting so the key matches what the handler
    // would compute via canonical_target_path at save time.
    let canonical = canonical_target_path(&target_path).await;
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let uuid_a = Uuid::new_v4();
    rooms.bind_path(uuid_a, canonical.clone()).await.unwrap();

    // Room B attempts to save to the same path. Per the handler's
    // claim-before-write ordering, it must fail at try_claim_path without
    // ever invoking save_notebook_to_disk.
    let uuid_b = Uuid::new_v4();
    let _room_b = Arc::new(NotebookRoom::new_fresh(
        uuid_b, None, &docs_dir, blob_store, false,
    ));
    let claim = try_claim_path(&rooms, &canonical, uuid_b).await;
    assert!(claim.is_err(), "claim must fail on collision");

    // Target file must be byte-for-byte identical.
    let on_disk = tokio::fs::read_to_string(&target_path).await.unwrap();
    assert_eq!(
        on_disk, marker_content,
        "collision attempt must not touch the file on disk"
    );
}

/// Staleness guard (#2285 stopgap): a primary-path save refuses to overwrite
/// a file that changed on disk since this daemon last read or wrote it (a
/// second daemon, `git pull`, an external editor). The refusal is retryable;
/// once the file watcher observes the external bytes (`note_disk_content` is
/// exactly what the watcher calls after reading the file), the next save
/// writes the room's state.
#[tokio::test]
async fn autosave_refuses_to_overwrite_externally_changed_file() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "stale.ipynb");

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "x = 1").unwrap();
    }

    // First save establishes the disk baseline.
    save_notebook_to_disk(&room, None).await.unwrap();

    // Another writer replaces the file behind our back.
    let external_content = r#"{"cells":[{"cell_type":"code","id":"other","source":"y = 2","metadata":{},"outputs":[],"execution_count":null}],"metadata":{},"nbformat":4,"nbformat_minor":5}"#;
    tokio::fs::write(&notebook_path, external_content)
        .await
        .unwrap();

    // Local edit so the no-op content-hash guard doesn't short-circuit.
    {
        let mut doc = room.doc.write().await;
        doc.update_source("cell1", "x = 3").unwrap();
    }

    let err = save_notebook_to_disk(&room, None).await.unwrap_err();
    assert!(
        matches!(err, SaveError::Retryable(_)),
        "staleness refusal must be retryable, got {err:?}"
    );

    // The external writer's bytes are untouched.
    let on_disk = tokio::fs::read_to_string(&notebook_path).await.unwrap();
    assert_eq!(
        on_disk, external_content,
        "refused save must not touch the file"
    );

    // Watcher reconciliation refreshes the baseline; the retry writes.
    room.persistence
        .note_disk_content(external_content.as_bytes());
    save_notebook_to_disk(&room, None).await.unwrap();
    let merged = tokio::fs::read_to_string(&notebook_path).await.unwrap();
    assert!(
        merged.contains("x = 3"),
        "post-reconcile save must write the room's state"
    );
}

/// Cross-daemon ownership guard (#2285): if another live daemon has claimed
/// this autosave path, this daemon must make the collision loud and leave the
/// existing file untouched.
#[tokio::test]
async fn autosave_refuses_live_foreign_owner_marker() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "live-owner.ipynb");
    write_two_cell_notebook(&notebook_path).await;

    let foreign_pid = 424_242;
    let _live = override_autosave_owner_liveness_for_test(foreign_pid, true);
    write_autosave_owner_marker_for_test(&notebook_path, "foreign-daemon", foreign_pid).await;

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "local-cell", "code").unwrap();
        doc.update_source("local-cell", "local = 1").unwrap();
    }

    let err = save_notebook_to_disk(&room, None).await.unwrap_err();
    let SaveError::Unrecoverable(message) = err else {
        panic!("live foreign owner must be unrecoverable, got {err:?}");
    };
    assert!(
        message.contains("owned by live daemon pid 424242"),
        "error should name the live owner pid; got {message}"
    );
    assert_eq!(
        disk_cell_count(&notebook_path),
        2,
        "live owner refusal must not clobber the existing notebook"
    );

    let marker = read_autosave_owner_marker_for_test(&notebook_path).await;
    assert_eq!(marker.daemon_id, "foreign-daemon");
    assert_eq!(marker.pid, foreign_pid);
}

/// A dead daemon's marker is safe to adopt. This keeps crash recovery working:
/// a new daemon can autosave the path once the recorded owner process is gone.
#[tokio::test]
async fn autosave_takes_over_dead_foreign_owner_marker() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "dead-owner.ipynb");
    write_two_cell_notebook(&notebook_path).await;

    let dead_pid = 515_151;
    let _dead = override_autosave_owner_liveness_for_test(dead_pid, false);
    write_autosave_owner_marker_for_test(&notebook_path, "dead-daemon", dead_pid).await;

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "takeover-cell", "code").unwrap();
        doc.update_source("takeover-cell", "takeover = 1").unwrap();
    }

    save_notebook_to_disk(&room, None)
        .await
        .expect("dead owner marker should be adopted");

    let on_disk = tokio::fs::read_to_string(&notebook_path).await.unwrap();
    assert!(
        on_disk.contains("takeover = 1"),
        "takeover save should write the local room state"
    );
    let marker = read_autosave_owner_marker_for_test(&notebook_path).await;
    assert_eq!(marker.pid, std::process::id());
    assert_eq!(marker.daemon_id, current_autosave_owner_id_for_test());
}

/// Saves to a non-primary path (Save As) are not staleness-guarded:
/// overwriting the chosen target is the user's intent, and the room's disk
/// baseline belongs to its bound path.
#[tokio::test]
async fn save_as_to_foreign_path_is_not_staleness_guarded() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _primary_path) = test_room_with_path(&tmp, "primary.ipynb");

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "z = 9").unwrap();
    }
    // Establish the primary baseline.
    save_notebook_to_disk(&room, None).await.unwrap();

    // Save As onto an existing file with foreign content must overwrite.
    let other_path = tmp.path().join("other.ipynb");
    tokio::fs::write(
        &other_path,
        r#"{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}"#,
    )
    .await
    .unwrap();
    save_notebook_to_disk(&room, Some(other_path.to_str().unwrap()))
        .await
        .unwrap();
    let written = tokio::fs::read_to_string(&other_path).await.unwrap();
    assert!(
        written.contains("z = 9"),
        "Save As must overwrite the target"
    );
}

/// `.ipynb` and `.automerge` writes go through tempfile + rename: the final
/// content lands and no temp siblings survive.
#[tokio::test]
async fn atomic_writes_leave_no_temp_files() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "atomic.ipynb");

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "a = 1").unwrap();
    }
    save_notebook_to_disk(&room, None).await.unwrap();
    assert!(notebook_path.exists());

    let automerge_path = tmp.path().join("docs").join("atomic.automerge");
    assert!(persist_notebook_bytes(b"snapshot-bytes", &automerge_path));
    assert_eq!(
        std::fs::read(&automerge_path).unwrap(),
        b"snapshot-bytes".to_vec()
    );

    for dir in [tmp.path().to_path_buf(), tmp.path().join("docs")] {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(
                !name.ends_with(".tmp"),
                "temp file left behind in {dir:?}: {name}"
            );
        }
    }
}

/// Verify the full lifecycle: create untitled room → save to disk →
/// promote via `promote_untitled_to_file_backed` → edit → autosave flushes
/// the edit to the .ipynb file.
///
/// This test calls the production helper directly, so it validates the real
/// code path rather than an inline copy of the transition logic.
// The durable save path uses `spawn_blocking` for file replacement and journal
// fsync. Keep real time here: a paused Tokio clock can advance the entire
// timeout while that intentionally blocking worker is still committing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_promote_untitled_starts_autosave() {
    use std::time::Duration;

    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();

    // 1. Create an untitled (UUID-keyed) room with one cell.
    let uuid_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let uuid = Uuid::parse_str(uuid_id).unwrap();
    let room = Arc::new(NotebookRoom::new_fresh(
        uuid, None, &docs_dir, blob_store, false,
    ));
    assert!(is_untitled_notebook(uuid_id));

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source("cell-1", "x = 1").unwrap();
    }

    // 2. Insert into rooms map under UUID key (UUID key stays constant).
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    rooms
        .insert_or_get(uuid, room.clone(), None)
        .await
        .expect("registry insert for test setup");

    // 3. Save to disk — creates the .ipynb file.
    let save_path = tmp.path().join("saved.ipynb");
    let written = save_notebook_to_disk(&room, Some(save_path.to_str().unwrap()))
        .await
        .unwrap();
    assert!(save_path.exists());

    // 4. Promote the room using the production helper.
    let canonical = tokio::fs::canonicalize(&written)
        .await
        .unwrap_or_else(|_| PathBuf::from(written.path()));

    try_claim_path(&rooms, &canonical, room.id)
        .await
        .expect("path claim should succeed");
    finalize_untitled_promotion(&room, canonical.clone())
        .await
        .unwrap();

    // Verify post-promotion state.
    assert!(
        rooms.peek_uuid(uuid).await.is_some(),
        "UUID key should still be present after promotion"
    );
    assert_eq!(
        room.file_binding.path().await.as_deref(),
        Some(canonical.as_path()),
        "room.file_binding.path should be set after promotion"
    );
    assert_eq!(
        rooms.peek_path_uuid(&canonical).await,
        Some(uuid),
        "registry path index should contain the room's UUID"
    );
    assert!(
        !room.file_binding.is_ephemeral(),
        "is_ephemeral should be cleared after promotion"
    );
    let promoted_generation = room.lifecycle.source_state().generation();
    let promoted_projection = room
        .lifecycle
        .projection(promoted_generation)
        .expect("file-backed Ready generation should retain its projection");
    assert_eq!(
        promoted_projection.notebook_path.as_deref(),
        Some(canonical.to_string_lossy().as_ref())
    );
    assert_eq!(promoted_projection.cells.len(), 1);
    assert_eq!(
        room.lifecycle.availability().status().projection_heads,
        promoted_projection.projection_heads
    );

    // 5. Add a new cell AFTER promotion (simulates MCP create_cell).
    {
        let mut doc = room.doc.write().await;
        let rollback_snapshot = doc.save();
        let rollback_actor = doc.get_actor_id();
        let baseline_heads = doc.get_heads();
        doc.add_cell(1, "cell-2", "code").unwrap();
        doc.update_source("cell-2", "y = 2").unwrap();
        super::durability::commit_daemon_notebook_mutation(
            &room,
            &mut doc,
            &baseline_heads,
            &rollback_snapshot,
            &rollback_actor,
            "test post-promotion cell creation",
        )
        .unwrap();
    }
    let _ = room.broadcasts.changed_tx.send(());

    // 6. Poll until the autosave debouncer flushes both cells to disk.
    //    Each sleep yields to the debouncer and its durable checkpoint worker.
    //    Timeout after 10s (well beyond the 2s debounce + 500ms check interval
    //    defaults).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let nb = loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let content = tokio::fs::read_to_string(&save_path).await.unwrap();
        let nb: serde_json::Value = serde_json::from_str(&content).unwrap();
        if nb["cells"].as_array().is_some_and(|c| c.len() == 2) {
            break nb;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Timed out waiting for autosave to flush both cells; got: {}",
            serde_json::to_string_pretty(&nb["cells"]).unwrap()
        );
    };

    // 7. Verify the post-promotion cell's source is present.
    let cells = nb["cells"].as_array().unwrap();
    let sources: Vec<String> = cells
        .iter()
        .map(|c| match &c["source"] {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(arr) => arr
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        })
        .collect();
    assert!(
        sources.iter().any(|s| s.contains("y = 2")),
        "Post-promotion cell should be persisted; sources: {:?}",
        sources
    );
}

// ── find_room_by_path tests ───────────────────────────────────────────

#[tokio::test]
async fn find_room_by_path_returns_room_after_index_insert() {
    let tmp = tempfile::tempdir().unwrap();
    let blob_store = test_blob_store(&tmp);
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let uuid = Uuid::new_v4();
    let fake = tmp.path().join("note.ipynb");
    let room = Arc::new(NotebookRoom::new_fresh(
        uuid,
        Some(fake.clone()),
        tmp.path(),
        blob_store,
        false,
    ));
    rooms
        .insert_or_get(uuid, room.clone(), Some(&fake))
        .await
        .unwrap();

    let found = find_room_by_path(&rooms, &fake).await;
    assert!(found.is_some());
    let (found_room, _guard) = found.unwrap();
    assert!(Arc::ptr_eq(&found_room, &room));
}

#[tokio::test]
async fn find_room_by_path_returns_none_when_not_indexed() {
    let tmp = tempfile::tempdir().unwrap();
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let found = find_room_by_path(&rooms, &tmp.path().join("nope.ipynb")).await;
    assert!(found.is_none());
}

/// PR 2 contract: when two callers race to insert a room for the
/// same path with different UUIDs (both saw `find_room_by_path ==
/// None`), the loser coalesces onto the winner's room rather than
/// erroring with `PathAlreadyOpen`. The combined registry is what
/// makes that joinable — both inserts contend for the same lock.
#[tokio::test]
async fn registry_insert_coalesces_concurrent_path_racers() {
    let tmp = tempfile::tempdir().unwrap();
    let blob_store = test_blob_store(&tmp);
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let shared_path = tmp.path().join("shared.ipynb");

    let winner_uuid = Uuid::new_v4();
    let winner_room = Arc::new(NotebookRoom::new_fresh(
        winner_uuid,
        Some(shared_path.clone()),
        tmp.path(),
        blob_store.clone(),
        false,
    ));
    let loser_uuid = Uuid::new_v4();
    let loser_room = Arc::new(NotebookRoom::new_fresh(
        loser_uuid,
        Some(shared_path.clone()),
        tmp.path(),
        blob_store,
        false,
    ));

    // Winner gets in first.
    let winner_outcome = rooms
        .insert_or_get(winner_uuid, winner_room.clone(), Some(&shared_path))
        .await
        .expect("winner insert should succeed");
    assert!(matches!(winner_outcome, InsertOutcome::Inserted(_, _)));

    // Loser arrives with a different UUID but the same path. The
    // registry must coalesce onto the winner's room rather than
    // failing with PathAlreadyOpen.
    let loser_outcome = rooms
        .insert_or_get(loser_uuid, loser_room.clone(), Some(&shared_path))
        .await
        .expect("loser must coalesce, not error");
    assert!(
        matches!(loser_outcome, InsertOutcome::Existing(_, _)),
        "racing path insert must return Existing for the winner's room"
    );
    let (returned, _guard) = loser_outcome.into_parts();
    assert!(
        Arc::ptr_eq(&returned, &winner_room),
        "loser must receive the winner's Arc, not its own"
    );

    // The registry holds exactly one room and one path binding.
    assert_eq!(rooms.len().await, 1);
    assert_eq!(rooms.path_count().await, 1);
    assert_eq!(rooms.peek_path_uuid(&shared_path).await, Some(winner_uuid));
}

// ── C1 regression: NotebookSync path handshake must reuse existing room ──

/// Verify that the pattern used by the NotebookSync handshake — consulting
/// `find_room_by_path` before calling `get_or_create_room` — produces
/// exactly one room for a given path even when called twice.
///
/// Before the C1 fix the handshake would mint a fresh UUID on every call,
/// so a second connection to the same path created a second room (zombie
/// room: two file watchers, two autosave debouncers, two writers).
///
/// The fix: if `find_room_by_path` returns `Some(existing)`, reuse its UUID
/// so `get_or_create_room` returns the existing room instead of creating one.
#[tokio::test]
async fn test_notebook_sync_path_handshake_reuses_existing_room() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let docs_dir = tmp.path().to_path_buf();
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());

    // Simulate a file-backed path (doesn't need to exist for this test).
    let notebook_path = tmp.path().join("my_notebook.ipynb");

    // --- First handshake (simulates the fixed NotebookSync path) ---
    // 1. Check the path index — not yet indexed, so mint a new UUID.
    let (room1, _g1) = {
        let (uuid, path) = match find_room_by_path(&rooms, &notebook_path).await {
            Some((existing, _)) => (existing.id, Some(notebook_path.clone())),
            None => (Uuid::new_v4(), Some(notebook_path.clone())),
        };
        get_or_create_room(
            &rooms,
            uuid,
            RoomCreationOptions {
                path,
                initial_load_execution_store_dir: None,
                docs_dir: &docs_dir,
                blob_store: blob_store.clone(),
                ephemeral: false,
                trusted_packages: test_trusted_packages(),
            },
        )
        .await
    };

    // --- Second handshake for the same path ---
    // find_room_by_path should now return the existing room.
    let (room2, _g2) = {
        let (uuid, path) = match find_room_by_path(&rooms, &notebook_path).await {
            Some((existing, _)) => (existing.id, Some(notebook_path.clone())),
            None => (Uuid::new_v4(), Some(notebook_path.clone())),
        };
        get_or_create_room(
            &rooms,
            uuid,
            RoomCreationOptions {
                path,
                initial_load_execution_store_dir: None,
                docs_dir: &docs_dir,
                blob_store: blob_store.clone(),
                ephemeral: false,
                trusted_packages: test_trusted_packages(),
            },
        )
        .await
    };

    // Both handshakes must return the same room Arc — no zombie duplicates.
    assert!(
        Arc::ptr_eq(&room1, &room2),
        "Second NotebookSync handshake for same path must reuse existing room"
    );

    // Exactly one room in the map (not two).
    assert_eq!(
        rooms.len().await,
        1,
        "Only one room should exist after two handshakes for the same path"
    );

    // The registry's path index has exactly one entry.
    assert_eq!(
        rooms.path_count().await,
        1,
        "registry path index should have exactly one entry"
    );
}

// ── compute_env_sync_diff tests ───────────────────────────────────────

#[test]
fn test_compute_env_sync_diff_in_sync() {
    let launched = LaunchedEnvConfig {
        uv_deps: Some(vec!["numpy".to_string(), "pandas".to_string()]),
        conda_deps: None,
        conda_channels: None,
        pixi_deps: None,
        pixi_toml_deps: None,
        pixi_toml_path: None,
        pyproject_path: None,
        environment_yml_path: None,
        environment_yml_deps: None,
        deno_config: None,
        venv_path: None,
        python_path: None,
        launch_id: Some("abc".to_string()),
        feature_flags: notebook_protocol::protocol::FeatureFlags::default(),
        prewarmed_packages: vec![],
    };
    let snapshot = snapshot_with_uv(vec!["numpy".to_string(), "pandas".to_string()]);
    assert!(
        compute_env_sync_diff(&launched, &snapshot).is_none(),
        "identical deps should be in sync"
    );
}

#[test]
fn test_compute_env_sync_diff_added() {
    let launched = LaunchedEnvConfig {
        uv_deps: Some(vec!["numpy".to_string()]),
        conda_deps: None,
        conda_channels: None,
        pixi_deps: None,
        pixi_toml_deps: None,
        pixi_toml_path: None,
        pyproject_path: None,
        environment_yml_path: None,
        environment_yml_deps: None,
        deno_config: None,
        venv_path: None,
        python_path: None,
        launch_id: None,
        feature_flags: notebook_protocol::protocol::FeatureFlags::default(),
        prewarmed_packages: vec![],
    };
    let snapshot = snapshot_with_uv(vec!["numpy".to_string(), "requests".to_string()]);
    let diff = compute_env_sync_diff(&launched, &snapshot).expect("should detect drift");
    assert_eq!(diff.added, vec!["requests".to_string()]);
    assert!(diff.removed.is_empty());
    assert!(!diff.channels_changed);
}

#[test]
fn test_compute_env_sync_diff_removed() {
    let launched = LaunchedEnvConfig {
        uv_deps: Some(vec!["numpy".to_string(), "pandas".to_string()]),
        conda_deps: None,
        conda_channels: None,
        pixi_deps: None,
        pixi_toml_deps: None,
        pixi_toml_path: None,
        pyproject_path: None,
        environment_yml_path: None,
        environment_yml_deps: None,
        deno_config: None,
        venv_path: None,
        python_path: None,
        launch_id: None,
        feature_flags: notebook_protocol::protocol::FeatureFlags::default(),
        prewarmed_packages: vec![],
    };
    let snapshot = snapshot_with_uv(vec!["numpy".to_string()]);
    let diff = compute_env_sync_diff(&launched, &snapshot).expect("should detect drift");
    assert!(diff.added.is_empty());
    assert_eq!(diff.removed, vec!["pandas".to_string()]);
}

#[test]
fn test_compute_env_sync_diff_added_and_removed() {
    let launched = LaunchedEnvConfig {
        uv_deps: Some(vec!["numpy".to_string(), "old-pkg".to_string()]),
        conda_deps: None,
        conda_channels: None,
        pixi_deps: None,
        pixi_toml_deps: None,
        pixi_toml_path: None,
        pyproject_path: None,
        environment_yml_path: None,
        environment_yml_deps: None,
        deno_config: None,
        venv_path: None,
        python_path: None,
        launch_id: None,
        feature_flags: notebook_protocol::protocol::FeatureFlags::default(),
        prewarmed_packages: vec![],
    };
    let snapshot = snapshot_with_uv(vec!["numpy".to_string(), "new-pkg".to_string()]);
    let diff = compute_env_sync_diff(&launched, &snapshot).expect("should detect drift");
    assert_eq!(diff.added, vec!["new-pkg".to_string()]);
    assert_eq!(diff.removed, vec!["old-pkg".to_string()]);
}

#[test]
fn test_compute_env_sync_diff_conda_channels_changed() {
    let launched = LaunchedEnvConfig {
        uv_deps: None,
        conda_deps: Some(vec!["scipy".to_string()]),
        conda_channels: Some(vec!["conda-forge".to_string()]),
        pixi_deps: None,
        pixi_toml_deps: None,
        pixi_toml_path: None,
        pyproject_path: None,
        environment_yml_path: None,
        environment_yml_deps: None,
        deno_config: None,
        venv_path: None,
        python_path: None,
        launch_id: None,
        feature_flags: notebook_protocol::protocol::FeatureFlags::default(),
        prewarmed_packages: vec![],
    };
    // Build a conda snapshot with a different channel
    let mut snapshot = snapshot_with_conda(vec!["scipy".to_string()]);
    snapshot.runt.conda.as_mut().unwrap().channels = vec!["defaults".to_string()];
    let diff = compute_env_sync_diff(&launched, &snapshot).expect("should detect channel drift");
    assert!(diff.added.is_empty());
    assert!(diff.removed.is_empty());
    assert!(diff.channels_changed);
}

#[test]
fn test_compute_env_sync_diff_no_tracking() {
    // Prewarmed kernel: no uv_deps, no conda_deps, no deno_config
    let launched = LaunchedEnvConfig::default();
    let snapshot = snapshot_with_uv(vec!["numpy".to_string()]);
    // When the kernel isn't tracking any deps, diff is None (no drift to report)
    assert!(compute_env_sync_diff(&launched, &snapshot).is_none());
}

#[test]
fn test_build_launched_config_uv_prewarmed_stores_paths() {
    let venv = PathBuf::from("/tmp/pool/env-abc");
    let python = PathBuf::from("/tmp/pool/env-abc/bin/python");
    let pkgs = vec!["ipykernel".to_string(), "pandas".to_string()];
    let config = build_launched_config(
        "python",
        "uv:prewarmed",
        None,
        None,
        Some(venv.clone()),
        Some(python.clone()),
        Some(&pkgs),
        None,
        notebook_protocol::protocol::FeatureFlags::default(),
        None,
    );
    assert_eq!(config.venv_path.as_ref(), Some(&venv));
    assert_eq!(config.python_path.as_ref(), Some(&python));
    assert!(config.uv_deps.is_none(), "prewarmed should not set uv_deps");
    assert_eq!(config.prewarmed_packages, pkgs);
}

#[test]
fn test_build_launched_config_uv_prewarmed_with_captured_baseline() {
    // P3 regression: when a captured env fires the prewarmed path,
    // launched_config must record captured deps as the baseline so
    // drift detection treats the launch as "tracking" rather than
    // reporting captured deps as pending additions on every reopen.
    let captured = CapturedEnv::Uv {
        deps: kernel_env::UvDependencies {
            dependencies: vec!["pandas".to_string(), "numpy".to_string()],
            requires_python: Some(">=3.10".to_string()),
            prerelease: None,
        },
        env_id: "nb-1".to_string(),
    };
    let config = build_launched_config(
        "python",
        "uv:prewarmed",
        None,
        None,
        Some(PathBuf::from("/tmp/env")),
        Some(PathBuf::from("/tmp/env/bin/python")),
        None,
        None,
        notebook_protocol::protocol::FeatureFlags::default(),
        Some(&captured),
    );
    assert_eq!(
        config.uv_deps.as_deref(),
        Some(["pandas".to_string(), "numpy".to_string()].as_slice()),
        "captured-prewarmed must record deps as baseline"
    );
}

#[test]
fn test_build_launched_config_conda_prewarmed_with_captured_baseline() {
    // Captured conda baseline must include channels so channel edits
    // surface as drift rather than being silently ignored.
    let captured = CapturedEnv::Conda {
        deps: kernel_env::CondaDependencies {
            dependencies: vec!["scipy".to_string()],
            channels: vec!["conda-forge".to_string(), "pytorch".to_string()],
            python: Some("3.11".to_string()),
            env_id: None,
        },
        env_id: "nb-2".to_string(),
    };
    let config = build_launched_config(
        "python",
        "conda:prewarmed",
        None,
        None,
        Some(PathBuf::from("/tmp/conda-env")),
        Some(PathBuf::from("/tmp/conda-env/bin/python")),
        None,
        None,
        notebook_protocol::protocol::FeatureFlags::default(),
        Some(&captured),
    );
    assert_eq!(
        config.conda_deps.as_deref(),
        Some([String::from("scipy")].as_slice())
    );
    assert_eq!(
        config.conda_channels.as_deref(),
        Some(["conda-forge".to_string(), "pytorch".to_string()].as_slice())
    );
}

#[test]
fn test_compute_env_sync_diff_prewarmed_promoted_to_empty_baseline() {
    // Simulates handle_sync_environment promoting uv_deps from None to
    // Some([]) for a prewarmed kernel, then computing the diff.
    let mut launched = LaunchedEnvConfig {
        venv_path: Some(PathBuf::from("/tmp/pool/env-abc")),
        python_path: Some(PathBuf::from("/tmp/pool/env-abc/bin/python")),
        ..LaunchedEnvConfig::default()
    };
    // Promote to empty baseline (what handle_sync_environment does)
    launched.uv_deps = Some(vec![]);

    let snapshot = snapshot_with_uv(vec!["httpx".to_string()]);
    let diff = compute_env_sync_diff(&launched, &snapshot).expect("should detect added deps");
    assert_eq!(diff.added, vec!["httpx".to_string()]);
    assert!(diff.removed.is_empty());
}

#[test]
fn test_build_launched_config_conda_prewarmed_stores_paths() {
    // conda:prewarmed stores paths so hot-sync can install deps later
    let venv = PathBuf::from("/tmp/conda-env");
    let python = PathBuf::from("/tmp/conda-env/bin/python");
    let config = build_launched_config(
        "python",
        "conda:prewarmed",
        None,
        None,
        Some(venv.clone()),
        Some(python.clone()),
        None,
        None,
        notebook_protocol::protocol::FeatureFlags::default(),
        None,
    );
    assert_eq!(config.venv_path.as_ref(), Some(&venv));
    assert_eq!(config.python_path.as_ref(), Some(&python));
    assert!(config.uv_deps.is_none());
    assert!(
        config.conda_deps.is_none(),
        "prewarmed should not set conda_deps"
    );
}

#[test]
fn test_build_launched_config_pyproject_records_context_without_notebook_deps() {
    let tmp = tempfile::tempdir().unwrap();
    let notebook_path = tmp.path().join("notebook.ipynb");
    std::fs::write(&notebook_path, "{}").unwrap();
    write_pyproject_with_deps(tmp.path(), &["pandas", "numpy"]);

    let config = build_launched_config(
        "python",
        "uv:pyproject",
        None,
        Some(&NotebookMetadataSnapshot::default()),
        Some(PathBuf::from("/tmp/project/.venv")),
        Some(PathBuf::from("/tmp/project/.venv/bin/python")),
        None,
        Some(&notebook_path),
        notebook_protocol::protocol::FeatureFlags::default(),
        None,
    );

    assert_eq!(
        config.pyproject_path.as_deref(),
        Some(tmp.path().join("pyproject.toml").as_path())
    );
    assert!(
        config.uv_deps.is_none(),
        "project-file deps are launch context, not notebook metadata deps"
    );
}

#[test]
fn test_build_launched_config_pixi_records_context_without_notebook_deps() {
    let tmp = tempfile::tempdir().unwrap();
    let notebook_path = tmp.path().join("notebook.ipynb");
    std::fs::write(&notebook_path, "{}").unwrap();
    std::fs::write(
        tmp.path().join("pixi.toml"),
        "[project]\nname = \"test\"\nchannels = [\"conda-forge\"]\nplatforms = [\"osx-arm64\"]\n[dependencies]\npandas = \">=2\"\n",
    )
    .unwrap();

    let config = build_launched_config(
        "python",
        "pixi:toml",
        None,
        Some(&NotebookMetadataSnapshot::default()),
        Some(PathBuf::from("/tmp/pixi-env")),
        Some(PathBuf::from("/tmp/pixi-env/bin/python")),
        None,
        Some(&notebook_path),
        notebook_protocol::protocol::FeatureFlags::default(),
        None,
    );

    assert_eq!(
        config.pixi_toml_path.as_deref(),
        Some(tmp.path().join("pixi.toml").as_path())
    );
    assert_eq!(
        config.pixi_toml_deps,
        Some(vec!["pandas = \">=2\"".to_string()])
    );
    assert!(
        config.pixi_deps.is_none(),
        "pixi.toml deps must not become notebook metadata deps"
    );
}

#[test]
fn test_build_launched_config_env_yml_records_context_without_notebook_deps() {
    let tmp = tempfile::tempdir().unwrap();
    let notebook_path = tmp.path().join("notebook.ipynb");
    std::fs::write(&notebook_path, "{}").unwrap();
    write_env_yml(tmp.path(), &["conda-forge"], &["pandas", "numpy"]);

    let config = build_launched_config(
        "python",
        "conda:env_yml",
        None,
        Some(&NotebookMetadataSnapshot::default()),
        Some(PathBuf::from("/tmp/conda-env")),
        Some(PathBuf::from("/tmp/conda-env/bin/python")),
        None,
        Some(&notebook_path),
        notebook_protocol::protocol::FeatureFlags::default(),
        None,
    );

    assert_eq!(
        config.environment_yml_path.as_deref(),
        Some(tmp.path().join("environment.yml").as_path())
    );
    assert_eq!(
        config.environment_yml_deps,
        Some(vec!["numpy".to_string(), "pandas".to_string()])
    );
    assert!(
        config.conda_deps.is_none(),
        "environment.yml deps must not become notebook metadata deps"
    );
}

// ── check_and_broadcast_sync_state tests ──────────────────────────────

#[tokio::test]
async fn test_check_and_broadcast_sync_state_no_kernel() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _path) = test_room_with_path(&tmp, "no_kernel.ipynb");

    // Write metadata so the function gets past the metadata check
    let snapshot = snapshot_with_uv(vec!["numpy".to_string()]);
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot).unwrap();
    }

    // Pre-set RuntimeStateDoc env to dirty so we can verify it's NOT changed
    room.state
        .with_doc(|sd| sd.set_env_sync(false, &["numpy".to_string()], &[], false, false))
        .unwrap();

    // No kernel in the room — should be a no-op
    check_and_broadcast_sync_state(&room).await;

    // Verify env state was NOT touched (still dirty from pre-set)
    let state = room.state.read(|sd| sd.read_state()).unwrap();
    assert!(
        !state.env.in_sync,
        "env should remain dirty when no kernel is present"
    );
    assert_eq!(state.env.added, vec!["numpy".to_string()]);
}

/// P3 regression: a captured-prewarmed launch must report `in_sync = true`
/// when metadata matches the captured baseline. Before the fix,
/// `LaunchedEnvConfig.uv_deps` was left `None` for the prewarmed path, so
/// `check_and_broadcast_sync_state` took the "prewarmed + inline deps
/// added" branch and flagged the captured deps as pending additions on
/// every reopen.
#[tokio::test]
async fn test_check_and_broadcast_sync_state_captured_uv_prewarmed_in_sync() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _path) = test_room_with_path(&tmp, "captured.ipynb");

    // Notebook has captured deps in metadata.
    let snapshot = snapshot_with_uv(vec!["pandas".to_string(), "numpy".to_string()]);
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot).unwrap();
    }

    // Kernel was launched via the captured-prewarmed path, so launched
    // config records the captured deps as the baseline (what our P3 fix
    // does in `build_launched_config`).
    {
        let mut lc = room.runtime_agent_launched_config.write().await;
        *lc = Some(LaunchedEnvConfig {
            uv_deps: Some(vec!["pandas".to_string(), "numpy".to_string()]),
            venv_path: Some(PathBuf::from("/tmp/captured-env")),
            python_path: Some(PathBuf::from("/tmp/captured-env/bin/python")),
            ..LaunchedEnvConfig::default()
        });
    }

    // Kernel is idle (otherwise the function returns early).
    {
        room.state
            .with_doc(|sd| {
                sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))?;
                // Pre-set to dirty so we can verify it flips to in_sync.
                sd.set_env_sync(false, &["pandas".to_string()], &[], false, false)?;
                Ok(())
            })
            .unwrap();
    }

    check_and_broadcast_sync_state(&room).await;

    let state = room.state.read(|sd| sd.read_state()).unwrap();
    assert!(
        state.env.in_sync,
        "captured-prewarmed launch with matching metadata must be in_sync"
    );
    assert!(state.env.added.is_empty());
    assert!(state.env.removed.is_empty());
}

/// Complementary to the above: when metadata diverges from the captured
/// baseline (user added a new dep post-capture), the drift detector
/// should surface the new dep in `env.added`. This verifies drift still
/// works when the captured baseline is populated.
#[tokio::test]
async fn test_check_and_broadcast_sync_state_captured_uv_prewarmed_reports_additions() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _path) = test_room_with_path(&tmp, "captured-drift.ipynb");

    // User added a third dep post-capture.
    let snapshot = snapshot_with_uv(vec![
        "pandas".to_string(),
        "numpy".to_string(),
        "polars".to_string(),
    ]);
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot).unwrap();
    }

    // Launched baseline still only has the original captured set.
    {
        let mut lc = room.runtime_agent_launched_config.write().await;
        *lc = Some(LaunchedEnvConfig {
            uv_deps: Some(vec!["pandas".to_string(), "numpy".to_string()]),
            venv_path: Some(PathBuf::from("/tmp/captured-env")),
            python_path: Some(PathBuf::from("/tmp/captured-env/bin/python")),
            ..LaunchedEnvConfig::default()
        });
    }

    {
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle)))
            .unwrap();
    }

    check_and_broadcast_sync_state(&room).await;

    let state = room.state.read(|sd| sd.read_state()).unwrap();
    assert!(
        !state.env.in_sync,
        "added dep post-capture must surface as drift"
    );
    assert_eq!(state.env.added, vec!["polars".to_string()]);
}

#[tokio::test]
async fn test_check_and_broadcast_sync_state_no_metadata() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _path) = test_room_with_path(&tmp, "no_meta.ipynb");

    // Don't write any metadata to the doc

    // Pre-set RuntimeStateDoc env to dirty
    {
        room.state
            .with_doc(|sd| sd.set_env_sync(false, &["pandas".to_string()], &[], false, false))
            .unwrap();
    }

    // No metadata in doc — should return early
    check_and_broadcast_sync_state(&room).await;

    // Verify env state was NOT touched
    let state = room.state.read(|sd| sd.read_state()).unwrap();
    assert!(
        !state.env.in_sync,
        "env should remain dirty when no metadata is present"
    );
}

// ── verify_trust_from_snapshot tests ───────────────────────────────────

fn open_test_store(tmp: &tempfile::TempDir) -> crate::trusted_packages::TrustedPackageStore {
    crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
        .expect("open trusted package store")
}

fn unavailable_test_store() -> crate::trusted_packages::TrustedPackageStore {
    crate::trusted_packages::TrustedPackageStore::unavailable("test")
}

#[test]
fn test_verify_trust_from_snapshot_no_deps() {
    let snapshot = snapshot_empty();
    let result = verify_trust_from_snapshot(&snapshot, &unavailable_test_store());
    assert_eq!(result.status, runt_trust::TrustStatus::NoDependencies);
    assert!(!result.pending_launch);
}

#[test]
fn test_verify_trust_from_snapshot_uv_unapproved() {
    let snapshot = snapshot_with_uv(vec!["numpy".to_string()]);
    let result = verify_trust_from_snapshot(&snapshot, &unavailable_test_store());
    assert_eq!(result.status, runt_trust::TrustStatus::Untrusted);
    assert!(!result.pending_launch);
}

#[test]
fn test_verify_trust_from_snapshot_pixi_unapproved() {
    let snapshot = snapshot_with_pixi(vec!["pandas".to_string()], vec!["requests".to_string()]);
    let result = verify_trust_from_snapshot(&snapshot, &unavailable_test_store());
    assert_eq!(result.status, runt_trust::TrustStatus::Untrusted);
    assert_eq!(result.info.pixi_dependencies, vec!["pandas"]);
    assert_eq!(result.info.pixi_pypi_dependencies, vec!["requests"]);
    assert!(!result.pending_launch);
}

#[test]
fn test_verify_trust_from_snapshot_uv_allowlisted_is_trusted() {
    let tmp = tempfile::TempDir::new().unwrap();
    let store = open_test_store(&tmp);
    let snapshot = snapshot_with_uv(vec!["numpy".to_string()]);

    // Pre-approve the dep in the allowlist; trust now resolves Trusted.
    let info = runt_trust::extract_trust_info(&snapshot_metadata_hashmap(&snapshot));
    store.add_from_info(&info, "test").unwrap();

    let result = verify_trust_from_snapshot(&snapshot, &store);
    assert_eq!(result.status, runt_trust::TrustStatus::Trusted);
    assert!(!result.pending_launch);
}

#[test]
fn test_verify_trust_from_snapshot_conda_allowlisted_is_trusted() {
    let tmp = tempfile::TempDir::new().unwrap();
    let store = open_test_store(&tmp);
    let snapshot = snapshot_with_conda(vec!["pandas".to_string()]);

    let info = runt_trust::extract_trust_info(&snapshot_metadata_hashmap(&snapshot));
    store.add_from_info(&info, "test").unwrap();

    let result = verify_trust_from_snapshot(&snapshot, &store);
    assert_eq!(result.status, runt_trust::TrustStatus::Trusted);
}

#[test]
fn test_verify_trust_from_snapshot_conda_channel_requires_allowlist() {
    let tmp = tempfile::TempDir::new().unwrap();
    let store = open_test_store(&tmp);
    let snapshot = snapshot_with_conda(vec!["pandas".to_string()]);

    let mut package_only = runt_trust::extract_trust_info(&snapshot_metadata_hashmap(&snapshot));
    package_only.conda_channels.clear();
    store.add_from_info(&package_only, "test").unwrap();

    let result = verify_trust_from_snapshot(&snapshot, &store);
    assert_eq!(result.status, runt_trust::TrustStatus::Untrusted);

    store
        .add_from_info(
            &runt_trust::extract_trust_info(&snapshot_metadata_hashmap(&snapshot)),
            "test",
        )
        .unwrap();

    let result = verify_trust_from_snapshot(&snapshot, &store);
    assert_eq!(result.status, runt_trust::TrustStatus::Trusted);
}

fn snapshot_metadata_hashmap(
    snapshot: &NotebookMetadataSnapshot,
) -> std::collections::HashMap<String, serde_json::Value> {
    let mut metadata = std::collections::HashMap::new();
    if let Ok(runt_value) = serde_json::to_value(&snapshot.runt) {
        metadata.insert("runt".to_string(), runt_value);
    }
    metadata
}

#[tokio::test]
async fn test_check_and_update_trust_state_empty_doc() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _path) = test_room_with_path(&tmp, "empty_doc.ipynb");

    // Doc has no metadata written — should not crash.
    check_and_update_trust_state(&room).await;

    // trust_state should remain Untrusted (the default from test_room_with_path).
    let ts = room.trust_state.read().await;
    assert_eq!(ts.status, runt_trust::TrustStatus::Untrusted);
}

#[tokio::test]
async fn test_check_and_update_trust_state_no_deps() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _path) = test_room_with_path(&tmp, "no_deps.ipynb");

    // Align RuntimeStateDoc with the room's initial Untrusted state so we
    // can verify the function actually writes the new value.
    {
        room.state
            .with_doc(|sd| sd.set_trust("untrusted", true))
            .unwrap();
    }

    // Write a minimal snapshot with a kernelspec so get_metadata_snapshot
    // returns Some (post-refactor: empty runt alone produces a None
    // snapshot because no keys get written to the doc).
    let mut snapshot = snapshot_empty();
    snapshot.kernelspec = Some(notebook_doc::metadata::KernelspecSnapshot {
        name: "python3".to_string(),
        display_name: "Python 3".to_string(),
        language: Some("python".to_string()),
        extras: std::collections::BTreeMap::new(),
    });
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot).unwrap();
    }

    check_and_update_trust_state(&room).await;

    // Room trust_state should change from Untrusted → NoDependencies.
    let ts = room.trust_state.read().await;
    assert_eq!(ts.status, runt_trust::TrustStatus::NoDependencies);
    drop(ts);

    // RuntimeStateDoc should reflect "no_dependencies" with needs_approval=false.
    let state = room.state.read(|sd| sd.read_state()).unwrap();
    assert_eq!(state.trust.status, "no_dependencies");
    assert!(!state.trust.needs_approval);
}

#[tokio::test]
async fn test_check_and_update_trust_state_cleared_metadata_resets_no_deps() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _path) = test_room_with_path(&tmp, "cleared_deps.ipynb");

    room.state
        .with_doc(|sd| sd.set_trust("untrusted", true))
        .unwrap();

    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot_with_uv(vec!["pandas>=2".to_string()]))
            .unwrap();
        doc.set_metadata_snapshot(&snapshot_empty()).unwrap();
        assert!(
            doc.get_metadata_snapshot().is_none(),
            "empty notebook metadata snapshots are stored as no metadata keys"
        );
    }

    check_and_update_trust_state(&room).await;

    let ts = room.trust_state.read().await;
    assert_eq!(ts.status, runt_trust::TrustStatus::NoDependencies);
    assert!(ts.info.uv_dependencies.is_empty());
    drop(ts);

    let state = room.state.read(|sd| sd.read_state()).unwrap();
    assert_eq!(state.trust.status, "no_dependencies");
    assert!(!state.trust.needs_approval);
}

#[tokio::test]
async fn test_approve_trust_adds_dependencies_to_allowlist() {
    let tmp = tempfile::TempDir::new().unwrap();
    let store =
        crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
            .unwrap();
    let (room, _path) = test_room_with_path_and_store(&tmp, "approve.ipynb", store.clone());
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot_with_uv(vec!["pandas>=2".to_string()]))
            .unwrap();
    }

    let response = crate::requests::approve_trust::handle(&room, None).await;
    assert!(matches!(response, NotebookResponse::Ok {}));

    let info = runt_trust::TrustInfo {
        status: runt_trust::TrustStatus::Untrusted,
        uv_dependencies: vec!["Pandas".to_string()],
        approved_uv_dependencies: vec![],
        conda_dependencies: vec![],
        approved_conda_dependencies: vec![],
        conda_channels: vec![],
        approved_conda_channels: vec![],
        pixi_dependencies: vec![],
        approved_pixi_dependencies: vec![],
        pixi_pypi_dependencies: vec![],
        approved_pixi_pypi_dependencies: vec![],
        pixi_channels: vec![],
        approved_pixi_channels: vec![],
    };
    assert!(store.all_dependencies_approved(&info).unwrap());
}

#[tokio::test]
async fn test_approve_trust_returns_error_when_store_unavailable() {
    let tmp = tempfile::TempDir::new().unwrap();
    // Store unavailable: approval must surface a real error rather than
    // silently succeeding while the allowlist stays empty.
    let store = crate::trusted_packages::TrustedPackageStore::unavailable("test disk full");
    let (room, _path) = test_room_with_path_and_store(&tmp, "approve.ipynb", store);
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot_with_uv(vec!["pandas>=2".to_string()]))
            .unwrap();
    }

    let response = crate::requests::approve_trust::handle(&room, None).await;
    let NotebookResponse::Error { error } = response else {
        panic!("expected NotebookResponse::Error, got {response:?}");
    };
    assert!(
        error.contains("Could not record trusted packages"),
        "error message should explain the persistence failure; got: {error}"
    );
}

#[tokio::test]
async fn test_allowlisted_dependencies_resolve_to_trusted() {
    let tmp = tempfile::TempDir::new().unwrap();
    let store =
        crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
            .unwrap();
    let seed = runt_trust::TrustInfo {
        status: runt_trust::TrustStatus::Untrusted,
        uv_dependencies: vec!["pandas".to_string(), "numpy".to_string()],
        approved_uv_dependencies: vec![],
        conda_dependencies: vec![],
        approved_conda_dependencies: vec![],
        conda_channels: vec![],
        approved_conda_channels: vec![],
        pixi_dependencies: vec![],
        approved_pixi_dependencies: vec![],
        pixi_pypi_dependencies: vec![],
        approved_pixi_pypi_dependencies: vec![],
        pixi_channels: vec![],
        approved_pixi_channels: vec![],
    };
    store.add_from_info(&seed, "test").unwrap();
    let (room, _path) = test_room_with_path_and_store(&tmp, "auto.ipynb", store);
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot_with_uv(vec![
            "pandas>=2".to_string(),
            "numpy".to_string(),
        ]))
        .unwrap();
    }

    check_and_update_trust_state(&room).await;

    let ts = room.trust_state.read().await;
    assert_eq!(ts.status, runt_trust::TrustStatus::Trusted);
    assert_eq!(
        ts.info.approved_uv_dependencies,
        vec!["pandas>=2".to_string(), "numpy".to_string()]
    );
}

#[tokio::test]
async fn test_allowlist_partial_coverage_stays_untrusted_with_markers() {
    let tmp = tempfile::TempDir::new().unwrap();
    let store =
        crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
            .unwrap();
    let seed = runt_trust::TrustInfo {
        status: runt_trust::TrustStatus::Untrusted,
        uv_dependencies: vec!["pandas".to_string()],
        approved_uv_dependencies: vec![],
        conda_dependencies: vec![],
        approved_conda_dependencies: vec![],
        conda_channels: vec![],
        approved_conda_channels: vec![],
        pixi_dependencies: vec![],
        approved_pixi_dependencies: vec![],
        pixi_pypi_dependencies: vec![],
        approved_pixi_pypi_dependencies: vec![],
        pixi_channels: vec![],
        approved_pixi_channels: vec![],
    };
    store.add_from_info(&seed, "test").unwrap();
    let (room, _path) = test_room_with_path_and_store(&tmp, "partial.ipynb", store);
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot_with_uv(vec![
            "pandas>=2".to_string(),
            "polars".to_string(),
        ]))
        .unwrap();
    }

    check_and_update_trust_state(&room).await;

    let ts = room.trust_state.read().await;
    assert_eq!(ts.status, runt_trust::TrustStatus::Untrusted);
    assert_eq!(ts.info.approved_uv_dependencies, vec!["pandas>=2"]);
    drop(ts);
    let state = room.state.read(|sd| sd.read_state()).unwrap();
    assert_eq!(state.trust.approved_uv_dependencies, vec!["pandas>=2"]);
}

#[tokio::test]
async fn test_check_and_update_trust_state_approval_updates_room() {
    let tmp = tempfile::TempDir::new().unwrap();
    let store = open_test_store(&tmp);
    let (room, _path) = test_room_with_path_and_store(&tmp, "approved.ipynb", store.clone());

    // Align RuntimeStateDoc with the room's initial Untrusted state.
    room.state
        .with_doc(|sd| sd.set_trust("untrusted", true))
        .unwrap();

    let snapshot = snapshot_with_uv(vec!["numpy".to_string()]);
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot).unwrap();
    }

    // Approve `numpy` in the allowlist; the doc-side trust check now flips
    // from Untrusted to Trusted on the next `check_and_update_trust_state`.
    let info = runt_trust::extract_trust_info(&snapshot_metadata_hashmap(&snapshot));
    store.add_from_info(&info, "test").unwrap();

    check_and_update_trust_state(&room).await;

    let ts = room.trust_state.read().await;
    assert_eq!(ts.status, runt_trust::TrustStatus::Trusted);
    drop(ts);

    let state = room.state.read(|sd| sd.read_state()).unwrap();
    assert_eq!(state.trust.status, "trusted");
    assert!(!state.trust.needs_approval);
}

#[tokio::test]
async fn test_check_and_update_trust_state_idempotent() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _path) = test_room_with_path(&tmp, "idempotent.ipynb");

    // Align RuntimeStateDoc with the room's initial Untrusted state so the
    // first transition to NoDependencies actually mutates the doc and fires
    // a notification.
    {
        room.state
            .with_doc(|sd| sd.set_trust("untrusted", true))
            .unwrap();
    }

    // Write a minimal snapshot with a kernelspec so get_metadata_snapshot
    // returns Some (post-refactor: empty runt alone produces a None
    // snapshot because no keys get written to the doc).
    let mut snapshot = snapshot_empty();
    snapshot.kernelspec = Some(notebook_doc::metadata::KernelspecSnapshot {
        name: "python3".to_string(),
        display_name: "Python 3".to_string(),
        language: Some("python".to_string()),
        extras: std::collections::BTreeMap::new(),
    });
    {
        let mut doc = room.doc.write().await;
        doc.set_metadata_snapshot(&snapshot).unwrap();
    }

    // Subscribe before either call so we capture all notifications.
    let mut rx = room.state.subscribe();

    // First call: state changes from Untrusted → NoDependencies → notification sent.
    check_and_update_trust_state(&room).await;

    // Second call: state is already NoDependencies → no change, no notification.
    check_and_update_trust_state(&room).await;

    // Drain the channel and count how many notifications arrived.
    let mut count = 0usize;
    while rx.try_recv().is_ok() {
        count += 1;
    }
    assert_eq!(count, 1, "expected exactly one state_changed notification");

    // Final trust_state should be NoDependencies.
    let ts = room.trust_state.read().await;
    assert_eq!(ts.status, runt_trust::TrustStatus::NoDependencies);
}

// ── Per-agent oneshot channel tests ──────────────────────────────

#[tokio::test]
async fn test_per_runtime_agent_oneshot_isolation() {
    // Verify that each spawn generation gets its own oneshot channel
    // and that connecting one agent doesn't resolve another's receiver.
    let pending: Arc<Mutex<Option<oneshot::Sender<()>>>> = Arc::new(Mutex::new(None));

    // Spawn A: create oneshot, store sender
    let (tx_a, rx_a) = oneshot::channel();
    *pending.lock().await = Some(tx_a);

    // A connects: take and send
    if let Some(tx) = pending.lock().await.take() {
        tx.send(()).unwrap();
    }
    assert!(rx_a.await.is_ok(), "A's receiver should resolve Ok");

    // Spawn B: create new oneshot (A's sender already consumed via take)
    let (tx_b, rx_b) = oneshot::channel();
    *pending.lock().await = Some(tx_b);

    // B connects
    if let Some(tx) = pending.lock().await.take() {
        tx.send(()).unwrap();
    }
    assert!(rx_b.await.is_ok(), "B's receiver should resolve Ok");

    // After both consumed, pending should be None
    assert!(pending.lock().await.is_none());
}

#[tokio::test]
async fn test_oneshot_replaced_before_runtime_agent_connect() {
    // When a new spawn replaces the oneshot before the previous agent
    // connects, the old receiver should resolve with Err (sender dropped).
    let pending: Arc<Mutex<Option<oneshot::Sender<()>>>> = Arc::new(Mutex::new(None));

    // Spawn A
    let (_tx_a, rx_a) = oneshot::channel();
    *pending.lock().await = Some(_tx_a);

    // Spawn B BEFORE A connects — replaces A's sender (drops tx_a)
    let (tx_b, rx_b) = oneshot::channel();
    *pending.lock().await = Some(tx_b); // tx_a dropped here

    // A's receiver resolves with Err (sender dropped = superseded)
    assert!(
        rx_a.await.is_err(),
        "A's receiver should get Err (sender was dropped by B's spawn)"
    );

    // B connects normally
    if let Some(tx) = pending.lock().await.take() {
        tx.send(()).unwrap();
    }
    assert!(rx_b.await.is_ok(), "B's receiver should resolve Ok");
}

#[tokio::test]
async fn test_reset_starting_state_guard() {
    // Verify that reset_starting_state skips when expected_runtime_agent_id
    // doesn't match current_runtime_agent_id.
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _notebook_path) = test_room_with_path(&tmp, "guard_test.ipynb");

    // Set current runtime agent to "agent-B"
    {
        let mut id = room.current_runtime_agent_id.write().await;
        *id = Some("agent-B".to_string());
    }

    // Move to Resolving (simulates in-progress launch — the earliest
    // "starting" sub-state).
    room.state
        .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Resolving))
        .unwrap();

    // Call reset with expected="agent-A" (stale handler) — should skip.
    reset_starting_state(&room, Some("agent-A")).await;

    // Verify: lifecycle should still be Resolving (NOT reset).
    {
        let lifecycle = room
            .state
            .read(|sd| sd.read_state().kernel.lifecycle)
            .unwrap();
        assert_eq!(
            lifecycle,
            RuntimeLifecycle::Resolving,
            "Guard should have prevented reset (agent-A != agent-B)"
        );
    }

    // Verify: current_runtime_agent_id unchanged
    {
        let id = room.current_runtime_agent_id.read().await;
        assert_eq!(id.as_deref(), Some("agent-B"));
    }

    // Now call with matching expected="agent-B" — should reset.
    reset_starting_state(&room, Some("agent-B")).await;

    // Verify: lifecycle should be NotStarted.
    {
        let lifecycle = room
            .state
            .read(|sd| sd.read_state().kernel.lifecycle)
            .unwrap();
        assert_eq!(
            lifecycle,
            RuntimeLifecycle::NotStarted,
            "Reset should proceed when expected matches current"
        );
    }

    // Verify: current_runtime_agent_id cleared (provenance cleanup)
    {
        let id = room.current_runtime_agent_id.read().await;
        assert!(
            id.is_none(),
            "Provenance should be cleared after guarded reset"
        );
    }

    // Call with None (pre-spawn) — should always reset.
    room.state
        .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Resolving))
        .unwrap();
    reset_starting_state(&room, None).await;
    {
        let lifecycle = room
            .state
            .read(|sd| sd.read_state().kernel.lifecycle)
            .unwrap();
        assert_eq!(
            lifecycle,
            RuntimeLifecycle::NotStarted,
            "None (pre-spawn) should always reset"
        );
    }
}

#[tokio::test]
async fn test_reset_starting_state_cleanup() {
    // Verify that guarded reset clears request_tx, connect_tx, and handle
    // (belt-and-suspenders cleanup prevents zombie runtime agents).
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _notebook_path) = test_room_with_path(&tmp, "cleanup_test.ipynb");

    // Simulate a runtime agent that has connected: set provenance,
    // request channel, and connect sender.
    {
        let mut id = room.current_runtime_agent_id.write().await;
        *id = Some("agent-A".to_string());
    }
    {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let mut guard = room.runtime_agent_request_tx.lock().await;
        *guard = Some(tx);
    }
    {
        let (tx, _rx) = oneshot::channel();
        let mut guard = room.pending_runtime_agent_connect_tx.lock().await;
        *guard = Some(tx);
    }
    room.state
        .with_doc(|sd| sd.set_env_progress("uv", &serde_json::json!({ "phase": "offline_hit" })))
        .unwrap();

    // Reset with matching agent — should clean up everything
    reset_starting_state(&room, Some("agent-A")).await;

    // Verify all fields cleared
    assert!(
        room.runtime_agent_request_tx.lock().await.is_none(),
        "request_tx should be cleared"
    );
    assert!(
        room.pending_runtime_agent_connect_tx.lock().await.is_none(),
        "connect_tx should be cleared"
    );
    assert!(
        room.runtime_agent_handle.lock().await.is_none(),
        "handle should be cleared"
    );
    assert!(
        room.current_runtime_agent_id.read().await.is_none(),
        "provenance should be cleared"
    );
    assert_eq!(
        room.state.read(|sd| sd.read_state().env.progress).unwrap(),
        None,
        "env progress should be cleared"
    );
}

#[tokio::test]
async fn test_reset_aborts_when_new_spawn_detected() {
    // Verify that guarded reset_starting_state aborts field cleanup
    // if a new spawn sets provenance between the provenance-clear and
    // the field clears (TOCTOU re-check).
    //
    // We simulate this by:
    // 1. Setting provenance to "agent-old" + populating fields
    // 2. Clearing provenance to None (as reset_starting_state would)
    // 3. Setting provenance to "agent-new" + new field values (simulating interleaving spawn)
    // 4. Calling reset_starting_state with None expected (pre-spawn path) — always proceeds
    //    But for the guarded path: we test manually by checking the re-check logic.
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _notebook_path) = test_room_with_path(&tmp, "toctou_test.ipynb");

    // Simulate: agent-old's reset already cleared provenance to None,
    // then a new spawn set provenance to "agent-new" with fresh channels.
    {
        let mut id = room.current_runtime_agent_id.write().await;
        *id = Some("agent-new".to_string());
    }
    let (new_tx, mut new_rx) = oneshot::channel::<()>();
    {
        let mut guard = room.pending_runtime_agent_connect_tx.lock().await;
        *guard = Some(new_tx);
    }
    let (req_tx, _req_rx) = tokio::sync::mpsc::channel(16);
    {
        let mut guard = room.runtime_agent_request_tx.lock().await;
        *guard = Some(req_tx);
    }

    // Now call reset with expected="agent-old" — provenance is "agent-new",
    // so the guard should skip entirely (mismatch).
    reset_starting_state(&room, Some("agent-old")).await;

    // Verify: new spawn's fields are untouched
    assert!(
        room.pending_runtime_agent_connect_tx.lock().await.is_some(),
        "new spawn's connect_tx should not be cleared"
    );
    assert!(
        room.runtime_agent_request_tx.lock().await.is_some(),
        "new spawn's request_tx should not be cleared"
    );
    assert_eq!(
        room.current_runtime_agent_id.read().await.as_deref(),
        Some("agent-new"),
        "new spawn's provenance should not be cleared"
    );

    // Verify new_rx is still alive (sender not dropped)
    // Use try_recv — should return TryRecvError::Empty (not Closed)
    assert!(
        new_rx.try_recv().is_err(),
        "new spawn's oneshot should still be pending (sender alive)"
    );
}

#[tokio::test]
async fn test_reset_generation_guard_with_concurrent_spawn() {
    // Regression test for TOCTOU in reset_starting_state: verifies that a
    // new spawn interleaving AFTER provenance is cleared (but before field
    // clears) is detected by the generation counter, causing reset to abort
    // and preserving the new spawn's fields.
    //
    // The test spawns a concurrent task that simulates a new spawn sequence
    // (set provenance → bump generation → store fields) as soon as it
    // detects provenance cleared to None. The main task calls
    // reset_starting_state with a matching expected_runtime_agent_id.
    //
    // Two valid orderings exist:
    // 1. Concurrent spawn completes between provenance clear and field clears
    //    → generation mismatch → reset aborts → new fields preserved
    // 2. Concurrent spawn completes after reset_starting_state returns
    //    → reset clears old fields normally → concurrent spawn stores new fields
    // In both cases, the new spawn's fields are present at the end.
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _notebook_path) = test_room_with_path(&tmp, "gen_concurrent.ipynb");

    // Setup: agent-old at generation 0 with populated fields.
    {
        let mut id = room.current_runtime_agent_id.write().await;
        *id = Some("agent-old".to_string());
    }
    let (old_tx, _old_rx) = oneshot::channel::<()>();
    {
        let mut guard = room.pending_runtime_agent_connect_tx.lock().await;
        *guard = Some(old_tx);
    }
    let (old_req_tx, _old_req_rx) = tokio::sync::mpsc::channel(16);
    {
        let mut guard = room.runtime_agent_request_tx.lock().await;
        *guard = Some(old_req_tx);
    }

    // Clone Arc fields for the concurrent task.
    let id_arc = room.current_runtime_agent_id.clone();
    let gen_arc = room.runtime_agent_generation.clone();
    let connect_arc = room.pending_runtime_agent_connect_tx.clone();
    let req_arc = room.runtime_agent_request_tx.clone();

    // Channel to receive the new spawn's oneshot receiver (for liveness check).
    let (done_tx, done_rx) = oneshot::channel::<oneshot::Receiver<()>>();

    // Spawn concurrent task: simulate a new spawn that fires as soon as
    // provenance is cleared (the trigger for the TOCTOU scenario).
    tokio::spawn(async move {
        // Poll for provenance → None (reset_starting_state clears it).
        loop {
            {
                let current = id_arc.read().await;
                if current.is_none() {
                    break;
                }
            }
            tokio::task::yield_now().await;
        }

        // Simulate new spawn sequence: provenance → generation → fields.
        {
            let mut id = id_arc.write().await;
            *id = Some("agent-new".to_string());
        }
        gen_arc.fetch_add(1, Ordering::Release);
        let (new_tx, new_rx) = oneshot::channel::<()>();
        {
            let mut guard = connect_arc.lock().await;
            *guard = Some(new_tx);
        }
        let (new_req_tx, _) = tokio::sync::mpsc::channel(16);
        {
            let mut guard = req_arc.lock().await;
            *guard = Some(new_req_tx);
        }

        let _ = done_tx.send(new_rx);
    });

    // Main task: call reset — provenance matches "agent-old", so it proceeds.
    // Generation was captured inside the provenance write lock (gen=0).
    // If the concurrent spawn bumps gen to 1 before field clears, the
    // generation guard aborts the clears. Otherwise, reset clears old fields
    // and the concurrent spawn stores new ones afterward.
    reset_starting_state(&room, Some("agent-old")).await;

    // Wait for concurrent task to complete its spawn simulation.
    let mut new_rx = done_rx
        .await
        .expect("concurrent spawn task should complete");

    // Verify: new spawn's fields must be present regardless of ordering.
    assert!(
        room.pending_runtime_agent_connect_tx.lock().await.is_some(),
        "connect_tx should be present (new spawn's)"
    );
    assert!(
        room.runtime_agent_request_tx.lock().await.is_some(),
        "request_tx should be present (new spawn's)"
    );
    assert_eq!(
        room.current_runtime_agent_id.read().await.as_deref(),
        Some("agent-new"),
        "provenance should be agent-new (set by concurrent spawn)"
    );
    // Verify oneshot sender is still alive (not dropped by reset).
    assert!(
        new_rx.try_recv().is_err(),
        "new spawn's oneshot sender should be alive"
    );
    // Generation should be 1 (bumped by concurrent spawn).
    assert_eq!(
        room.runtime_agent_generation.load(Ordering::Acquire),
        1,
        "generation should be 1 after concurrent spawn"
    );
}

#[test]
fn test_env_yml_insertion_point_no_trailing_newline() {
    use rattler_conda_types::EnvironmentYaml;
    let content = "dependencies:\n  - numpy";
    let ins = find_env_yml_deps_insertion_point(content).unwrap();
    assert!(ins.offset <= content.len());
    assert_eq!(ins.indent, "  ");
    assert_eq!(ins.newline, "\n");
    assert!(ins.needs_leading_newline);
    // Simulate insertion and verify the result parses
    let mut result = content.to_string();
    let mut insert_str = String::new();
    if ins.needs_leading_newline {
        insert_str.push_str(ins.newline);
    }
    insert_str.push_str(&format!("{}- pandas{}", ins.indent, ins.newline));
    result.insert_str(ins.offset, &insert_str);
    EnvironmentYaml::from_yaml_str(&result).expect("inserted YAML should parse");
}

#[test]
fn test_env_yml_insertion_point_with_trailing_newline() {
    let content = "dependencies:\n  - numpy\n  - pandas\n";
    let ins = find_env_yml_deps_insertion_point(content).unwrap();
    assert_eq!(ins.offset, content.len());
}

#[test]
fn test_env_yml_insertion_point_before_next_key() {
    let content = "dependencies:\n  - numpy\nchannels:\n  - conda-forge\n";
    let ins = find_env_yml_deps_insertion_point(content).unwrap();
    assert_eq!(ins.offset, "dependencies:\n  - numpy\n".len());
}

/// Pre-v4 .ipynb (no output_id fields) gets IDs minted on load,
/// persisted through save, and stable across reload.
#[tokio::test]
async fn test_pre_v4_ipynb_output_id_round_trip() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);

    let notebook_json = serde_json::json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "id": "cell-a",
                "cell_type": "code",
                "source": "1 + 1",
                "execution_count": 1,
                "metadata": {},
                "outputs": [
                    {
                        "output_type": "execute_result",
                        "execution_count": 1,
                        "data": { "text/plain": "2" },
                        "metadata": {}
                    }
                ]
            },
            {
                "id": "cell-b",
                "cell_type": "code",
                "source": "print('hi')",
                "execution_count": 2,
                "metadata": {},
                "outputs": [
                    {
                        "output_type": "stream",
                        "name": "stdout",
                        "text": "hi\n"
                    }
                ]
            },
            {
                "id": "cell-c",
                "cell_type": "code",
                "source": "display('x')",
                "execution_count": 3,
                "metadata": {},
                "outputs": [
                    {
                        "output_type": "display_data",
                        "data": { "text/plain": "x" },
                        "metadata": {}
                    }
                ]
            },
            {
                "id": "cell-d",
                "cell_type": "code",
                "source": "1/0",
                "execution_count": 4,
                "metadata": {},
                "outputs": [
                    {
                        "output_type": "error",
                        "ename": "ZeroDivisionError",
                        "evalue": "division by zero",
                        "traceback": ["line 1"]
                    }
                ]
            }
        ]
    });

    // --- Ingest 1: pre-v4 outputs carry no output_id fields ---
    // Both notebook loaders ingest outputs through the same pair of shared
    // helpers: `parse_notebook_jiter_for_notebook` for the .ipynb bytes and
    // `output_value_to_manifest_ref` for each parsed output.
    let bytes = serde_json::to_vec_pretty(&notebook_json).unwrap();
    let parsed = parse_notebook_jiter_for_notebook(&bytes, Uuid::nil()).unwrap();
    assert_eq!(parsed.cells.len(), 4);

    let mut first_load_ids: Vec<(String, String)> = Vec::new();
    let mut first_load_manifests: Vec<(String, crate::output_store::OutputManifest)> = Vec::new();
    for cell in &parsed.cells {
        assert_eq!(cell.outputs.len(), 1, "{} should have 1 output", cell.id);
        let manifest_ref = output_value_to_manifest_ref(&cell.outputs[0], &blob_store).await;
        let manifest: crate::output_store::OutputManifest =
            serde_json::from_value(manifest_ref).unwrap();
        let id = manifest.output_id().to_string();
        assert!(
            !id.is_empty(),
            "{} should have a non-empty output_id",
            cell.id
        );
        first_load_ids.push((cell.id.clone(), id));
        first_load_manifests.push((cell.id.clone(), manifest));
    }

    // All IDs should be distinct
    let id_set: std::collections::HashSet<&str> =
        first_load_ids.iter().map(|(_, id)| id.as_str()).collect();
    assert_eq!(id_set.len(), 4, "All output_ids should be unique");

    // --- Save: resolve manifests to .ipynb JSON ---
    let mut resolved_outputs: Vec<(String, serde_json::Value)> = Vec::new();
    for ((cell_id, expected_id), (_, manifest)) in first_load_ids.iter().zip(&first_load_manifests)
    {
        let resolved = crate::output_store::resolve_manifest(manifest, &blob_store)
            .await
            .unwrap();
        let saved_id = resolved["output_id"]
            .as_str()
            .unwrap_or_else(|| panic!("{cell_id} resolved JSON should have output_id"));
        assert_eq!(
            saved_id, expected_id,
            "{cell_id}: resolve_manifest should preserve output_id"
        );
        resolved_outputs.push((cell_id.clone(), resolved));
    }

    // --- Reload: re-ingest the saved .ipynb, whose outputs now carry
    // output_id fields (as resolve_manifest produces them) ---
    let saved_notebook = serde_json::json!({
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {},
        "cells": [
            {
                "id": "cell-a",
                "cell_type": "code",
                "source": "1 + 1",
                "execution_count": 1,
                "metadata": {},
                "outputs": [resolved_outputs[0].1]
            },
            {
                "id": "cell-b",
                "cell_type": "code",
                "source": "print('hi')",
                "execution_count": 2,
                "metadata": {},
                "outputs": [resolved_outputs[1].1]
            },
            {
                "id": "cell-c",
                "cell_type": "code",
                "source": "display('x')",
                "execution_count": 3,
                "metadata": {},
                "outputs": [resolved_outputs[2].1]
            },
            {
                "id": "cell-d",
                "cell_type": "code",
                "source": "1/0",
                "execution_count": 4,
                "metadata": {},
                "outputs": [resolved_outputs[3].1]
            }
        ]
    });

    let saved_bytes = serde_json::to_vec_pretty(&saved_notebook).unwrap();
    let reloaded = parse_notebook_jiter_for_notebook(&saved_bytes, Uuid::nil()).unwrap();

    // Verify IDs are stable across the round-trip
    for (cell, (cell_id, expected_id)) in reloaded.cells.iter().zip(&first_load_ids) {
        assert_eq!(&cell.id, cell_id);
        let manifest_ref = output_value_to_manifest_ref(&cell.outputs[0], &blob_store).await;
        let manifest: crate::output_store::OutputManifest =
            serde_json::from_value(manifest_ref).unwrap();
        assert_eq!(
            manifest.output_id(),
            expected_id,
            "{cell_id}: output_id should be stable across save/load round-trip"
        );
    }
}

// ── PR 2: prewarmed env capture (spec 2026-04-20) ───────────────────────

/// Build a minimal room suitable for exercising metadata writes. Avoids
/// pulling in the full daemon stack — we only touch `room.doc`.
///
/// Returns `(room, _tmp)` so the TempDir lives at least as long as
/// the room; dropping the TempDir mid-test would remove the docs dir
/// under the room's persist debouncer.
async fn test_room_for_capture() -> (NotebookRoom, tempfile::TempDir) {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(Uuid::new_v4(), None, tmp.path(), blob_store, false);
    // Seed the doc so `get_metadata_snapshot` returns Some, mirroring
    // what `create_empty_notebook` does on a fresh notebook.
    {
        let mut doc = room.doc.write().await;
        let _ = create_empty_notebook(
            &mut doc,
            "python",
            crate::settings_doc::PythonEnvType::Uv,
            Some("test-env-id"),
            None,
            &[],
        );
    }
    (room, tmp)
}

#[tokio::test]
async fn capture_writes_deps_and_env_id_for_fresh_uv_notebook() {
    let (room, _tmp) = test_room_for_capture().await;
    // Wipe env_id first so the capture step sets it.
    {
        let mut doc = room.doc.write().await;
        doc.fork_and_merge(|fork| {
            let mut snap = fork.get_metadata_snapshot().unwrap_or_default();
            snap.runt.env_id = None;
            let _ = fork.set_metadata_snapshot(&snap);
        });
    }
    let user_defaults = vec!["pandas".to_string(), "numpy".to_string()];
    let wrote =
        capture_env_into_metadata(&room, CapturedEnvRuntime::Uv, &user_defaults, "nb-42").await;
    assert!(wrote, "first capture should write both deps and env_id");

    let snap = room.doc.read().await.get_metadata_snapshot().unwrap();
    assert_eq!(snap.runt.env_id.as_deref(), Some("nb-42"));
    assert_eq!(
        snap.runt.uv.as_ref().unwrap().dependencies,
        vec!["pandas".to_string(), "numpy".to_string()]
    );
}

#[tokio::test]
async fn capture_is_idempotent_on_existing_deps() {
    let (room, _tmp) = test_room_for_capture().await;
    // Pre-populate with user-edited deps.
    {
        let mut doc = room.doc.write().await;
        doc.fork_and_merge(|fork| {
            let mut snap = fork.get_metadata_snapshot().unwrap_or_default();
            let uv = snap
                .runt
                .uv
                .get_or_insert_with(|| notebook_doc::metadata::UvInlineMetadata {
                    dependencies: Vec::new(),
                    requires_python: None,
                    prerelease: None,
                });
            uv.dependencies = vec!["scikit-learn".to_string()];
            let _ = fork.set_metadata_snapshot(&snap);
        });
    }

    // Second capture tries to overwrite with different defaults — must not.
    let wrote = capture_env_into_metadata(
        &room,
        CapturedEnvRuntime::Uv,
        &["pandas".to_string()],
        "nb-x",
    )
    .await;
    assert!(
        !wrote,
        "capture must not overwrite user-edited deps (env_id already set)"
    );

    let snap = room.doc.read().await.get_metadata_snapshot().unwrap();
    assert_eq!(
        snap.runt.uv.as_ref().unwrap().dependencies,
        vec!["scikit-learn".to_string()],
        "captured deps must not overwrite existing non-empty list"
    );
}

#[tokio::test]
async fn capture_preserves_existing_env_id_across_calls() {
    let (room, _tmp) = test_room_for_capture().await;
    // env_id is already set by create_empty_notebook to "test-env-id".
    let wrote_first = capture_env_into_metadata(
        &room,
        CapturedEnvRuntime::Uv,
        &["polars".to_string()],
        "different-env-id-ignored",
    )
    .await;
    assert!(wrote_first, "deps filled in, write_id left alone");

    let snap = room.doc.read().await.get_metadata_snapshot().unwrap();
    assert_eq!(
        snap.runt.env_id.as_deref(),
        Some("test-env-id"),
        "existing env_id must survive capture"
    );

    // Second call with same defaults is a no-op.
    let wrote_second =
        capture_env_into_metadata(&room, CapturedEnvRuntime::Uv, &["polars".to_string()], "x")
            .await;
    assert!(
        !wrote_second,
        "second capture must be a no-op when deps and env_id are already set"
    );
}

#[tokio::test]
async fn capture_handles_conda_section_independently() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(Uuid::new_v4(), None, tmp.path(), blob_store, false);
    {
        let mut doc = room.doc.write().await;
        let _ = create_empty_notebook(
            &mut doc,
            "python",
            crate::settings_doc::PythonEnvType::Conda,
            Some("conda-env-id"),
            None,
            &[],
        );
    }

    let user_defaults = vec!["scipy".to_string()];
    let wrote = capture_env_into_metadata(
        &room,
        CapturedEnvRuntime::Conda,
        &user_defaults,
        "conda-env-id",
    )
    .await;
    assert!(wrote);

    let snap = room.doc.read().await.get_metadata_snapshot().unwrap();
    assert_eq!(
        snap.runt.conda.as_ref().unwrap().dependencies,
        vec!["scipy".to_string()]
    );
    // UV section should remain untouched.
    assert!(snap.runt.uv.is_none());
}

#[test]
fn captured_env_for_runtime_reads_uv_deps_and_env_id() {
    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some("abc".to_string());
    snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
        dependencies: vec!["pandas".to_string()],
        requires_python: None,
        prerelease: None,
    });
    let captured =
        captured_env_for_runtime(Some(&snap), CapturedEnvRuntime::Uv).expect("captured env");
    assert_eq!(captured.env_id(), "abc");
    assert_eq!(captured.dependencies(), &["pandas".to_string()]);
    match &captured {
        CapturedEnv::Uv { deps, .. } => {
            assert_eq!(deps.requires_python, None);
            assert_eq!(deps.prerelease, None);
        }
        _ => panic!("expected UV captured env"),
    }
}

#[test]
fn captured_env_for_runtime_returns_empty_deps_when_section_missing() {
    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some("xyz".to_string());
    // No uv or conda section populated.
    let captured =
        captured_env_for_runtime(Some(&snap), CapturedEnvRuntime::Uv).expect("captured env");
    assert!(captured.dependencies().is_empty());
    assert_eq!(captured.env_id(), "xyz");
}

#[test]
fn captured_env_for_runtime_includes_uv_resolver_fields() {
    // P2 regression: captured lookup must carry requires-python and
    // prerelease, not just the dep list. Otherwise the on-disk hash
    // computed on reopen would differ from what the capture step
    // originally wrote, causing false cache misses or worse, matching
    // the wrong cached env.
    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some("env-uv".to_string());
    snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
        dependencies: vec!["pandas".to_string()],
        requires_python: Some(">=3.10".to_string()),
        prerelease: Some("allow".to_string()),
    });

    let captured =
        captured_env_for_runtime(Some(&snap), CapturedEnvRuntime::Uv).expect("captured env");
    match &captured {
        CapturedEnv::Uv { deps, env_id } => {
            assert_eq!(env_id, "env-uv");
            assert_eq!(deps.dependencies, vec!["pandas".to_string()]);
            assert_eq!(deps.requires_python.as_deref(), Some(">=3.10"));
            assert_eq!(deps.prerelease.as_deref(), Some("allow"));
        }
        _ => panic!("expected UV captured env"),
    }
}

#[test]
fn captured_env_for_runtime_includes_conda_resolver_fields() {
    // P2 regression: captured lookup must carry channels and python pin.
    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some("env-conda".to_string());
    snap.runt.conda = Some(notebook_doc::metadata::CondaInlineMetadata {
        dependencies: vec!["scipy".to_string()],
        channels: vec!["pytorch".to_string(), "nvidia".to_string()],
        python: Some("3.11".to_string()),
    });

    let captured =
        captured_env_for_runtime(Some(&snap), CapturedEnvRuntime::Conda).expect("captured env");
    match &captured {
        CapturedEnv::Conda { deps, env_id } => {
            assert_eq!(env_id, "env-conda");
            assert_eq!(deps.dependencies, vec!["scipy".to_string()]);
            assert_eq!(
                deps.channels,
                vec!["pytorch".to_string(), "nvidia".to_string()]
            );
            assert_eq!(deps.python.as_deref(), Some("3.11"));
        }
        _ => panic!("expected Conda captured env"),
    }
}

#[test]
fn captured_env_hash_differs_when_uv_prerelease_changes() {
    // P2 invariant: two captures with identical deps + env_id but a
    // different prerelease strategy must hash to different paths. If
    // they didn't, the on-disk lookup would happily find the wrong
    // prior env and reuse it with the wrong install set.
    let base_deps = vec!["pandas".to_string()];
    let a = kernel_env::UvDependencies {
        dependencies: base_deps.clone(),
        requires_python: None,
        prerelease: None,
    };
    let b = kernel_env::UvDependencies {
        dependencies: base_deps,
        requires_python: None,
        prerelease: Some("allow".to_string()),
    };
    let hash_a = kernel_env::uv::compute_unified_env_hash(&a, "same-env-id");
    let hash_b = kernel_env::uv::compute_unified_env_hash(&b, "same-env-id");
    assert_ne!(hash_a, hash_b);
}

#[test]
fn captured_env_hash_differs_when_conda_channels_change() {
    let base_deps = vec!["scipy".to_string()];
    let a = kernel_env::CondaDependencies {
        dependencies: base_deps.clone(),
        channels: vec!["conda-forge".to_string()],
        python: None,
        env_id: None,
    };
    let b = kernel_env::CondaDependencies {
        dependencies: base_deps.clone(),
        channels: vec!["conda-forge".to_string(), "pytorch".to_string()],
        python: None,
        env_id: None,
    };
    let hash_a = kernel_env::conda::compute_unified_env_hash(&a, "same-env-id");
    let hash_b = kernel_env::conda::compute_unified_env_hash(&b, "same-env-id");
    assert_ne!(hash_a, hash_b);

    // Python pin also contributes.
    let c = kernel_env::CondaDependencies {
        dependencies: base_deps,
        channels: vec!["conda-forge".to_string()],
        python: Some("3.12".to_string()),
        env_id: None,
    };
    let hash_c = kernel_env::conda::compute_unified_env_hash(&c, "same-env-id");
    assert_ne!(hash_a, hash_c);
}

#[test]
fn captured_env_for_runtime_requires_env_id() {
    let snap = NotebookMetadataSnapshot::default();
    assert!(captured_env_for_runtime(Some(&snap), CapturedEnvRuntime::Uv).is_none());
}

#[test]
fn captured_env_source_override_returns_none_when_no_env_id() {
    let snap = NotebookMetadataSnapshot::default();
    assert!(captured_env_source_override(Some(&snap)).is_none());
}

#[test]
fn captured_env_source_override_returns_none_when_deps_present_but_env_missing() {
    // Deps-present-but-disk-absent is intentionally NOT treated as
    // captured: we cannot tell a GC'd captured env apart from a fresh
    // notebook whose user added inline deps before the first launch.
    // Falling through to the normal inline path is the safer default —
    // same deps still dedup across notebooks via the legacy inline
    // cache; they just lose per-notebook env_id isolation for that
    // rebuild.
    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some(format!("unlikely-env-id-{}", uuid::Uuid::new_v4()));
    snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
        dependencies: vec!["pandas".to_string()],
        requires_python: None,
        prerelease: None,
    });
    assert!(captured_env_source_override(Some(&snap)).is_none());
}

#[test]
fn captured_env_source_override_returns_none_for_fresh_notebook_empty_deps() {
    // `create_empty_notebook` assigns an env_id and an empty uv/conda
    // section on every new notebook. Empty deps + no env on disk must
    // NOT be treated as captured, otherwise brand-new `uv:prewarmed`
    // launches bypass the warmed pool and build a base env from scratch.
    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some(format!("fresh-env-{}", uuid::Uuid::new_v4()));
    snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
        dependencies: vec![],
        requires_python: None,
        prerelease: None,
    });
    assert!(captured_env_source_override(Some(&snap)).is_none());
}

/// Given a tmpdir pretending to be the UV cache, materialise a fake
/// venv at `{cache}/{hash}/bin/python` for the given captured env so
/// `captured_env_disk_state_in` reports it as usable.
fn materialise_fake_uv_venv(
    deps: &kernel_env::UvDependencies,
    env_id: &str,
    cache_dir: &Path,
) -> PathBuf {
    let hash = kernel_env::uv::compute_unified_env_hash(deps, env_id);
    let venv_path = cache_dir.join(&hash);
    #[cfg(target_os = "windows")]
    let python_path = venv_path.join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let python_path = venv_path.join("bin").join("python");
    std::fs::create_dir_all(python_path.parent().unwrap()).unwrap();
    std::fs::write(&python_path, b"#!/bin/sh\n").unwrap();
    venv_path
}

fn materialise_fake_conda_env(
    deps: &kernel_env::CondaDependencies,
    env_id: &str,
    cache_dir: &Path,
) -> PathBuf {
    let hash = kernel_env::conda::compute_unified_env_hash(deps, env_id);
    let env_path = cache_dir.join(&hash);
    #[cfg(target_os = "windows")]
    let python_path = env_path.join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let python_path = env_path.join("bin").join("python");
    std::fs::create_dir_all(python_path.parent().unwrap()).unwrap();
    std::fs::write(&python_path, b"#!/bin/sh\n").unwrap();
    env_path
}

fn materialise_partial_uv_venv(
    deps: &kernel_env::UvDependencies,
    env_id: &str,
    cache_dir: &Path,
) -> PathBuf {
    let hash = kernel_env::uv::compute_unified_env_hash(deps, env_id);
    let venv_path = cache_dir.join(&hash);
    std::fs::create_dir_all(&venv_path).unwrap();
    venv_path
}

fn materialise_partial_conda_env(
    deps: &kernel_env::CondaDependencies,
    env_id: &str,
    cache_dir: &Path,
) -> PathBuf {
    let hash = kernel_env::conda::compute_unified_env_hash(deps, env_id);
    let env_path = cache_dir.join(&hash);
    std::fs::create_dir_all(&env_path).unwrap();
    env_path
}

#[test]
fn captured_env_disk_state_classifies_uv_missing_partial_usable() {
    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().join("uv");
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&uv_cache).unwrap();
    std::fs::create_dir_all(&conda_cache).unwrap();

    let deps = kernel_env::UvDependencies {
        dependencies: vec!["pandas".to_string()],
        requires_python: Some(">=3.11".to_string()),
        prerelease: None,
    };
    let env_id = "uv-disk-state";
    let captured = CapturedEnv::Uv {
        deps: deps.clone(),
        env_id: env_id.to_string(),
    };

    let missing = captured_env_disk_state_in(&captured, &uv_cache, &conda_cache);
    assert!(matches!(missing, CapturedEnvDiskState::Missing { .. }));
    assert!(!missing.is_captured_route());

    let partial_path = materialise_partial_uv_venv(&deps, env_id, &uv_cache);
    let partial = captured_env_disk_state_in(&captured, &uv_cache, &conda_cache);
    assert!(matches!(partial, CapturedEnvDiskState::Partial { .. }));
    assert_eq!(partial.env_path(), partial_path.as_path());
    assert!(partial.is_captured_route());

    let usable_path = materialise_fake_uv_venv(&deps, env_id, &uv_cache);
    let usable = captured_env_disk_state_in(&captured, &uv_cache, &conda_cache);
    assert!(matches!(usable, CapturedEnvDiskState::Usable { .. }));
    assert_eq!(usable.env_path(), usable_path.as_path());
    assert!(usable.is_captured_route());
}

#[test]
fn captured_env_disk_state_classifies_conda_missing_partial_usable() {
    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().join("uv");
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&uv_cache).unwrap();
    std::fs::create_dir_all(&conda_cache).unwrap();

    let deps = kernel_env::CondaDependencies {
        dependencies: vec!["scipy".to_string()],
        channels: vec!["conda-forge".to_string()],
        python: Some("3.11".to_string()),
        env_id: None,
    };
    let env_id = "conda-disk-state";
    let captured = CapturedEnv::Conda {
        deps: deps.clone(),
        env_id: env_id.to_string(),
    };

    let missing = captured_env_disk_state_in(&captured, &uv_cache, &conda_cache);
    assert!(matches!(missing, CapturedEnvDiskState::Missing { .. }));
    assert!(!missing.is_captured_route());

    let partial_path = materialise_partial_conda_env(&deps, env_id, &conda_cache);
    let partial = captured_env_disk_state_in(&captured, &uv_cache, &conda_cache);
    assert!(matches!(partial, CapturedEnvDiskState::Partial { .. }));
    assert_eq!(partial.env_path(), partial_path.as_path());
    assert!(partial.is_captured_route());

    let usable_path = materialise_fake_conda_env(&deps, env_id, &conda_cache);
    let usable = captured_env_disk_state_in(&captured, &uv_cache, &conda_cache);
    assert!(matches!(usable, CapturedEnvDiskState::Usable { .. }));
    assert_eq!(usable.env_path(), usable_path.as_path());
    assert!(usable.is_captured_route());
}

#[test]
fn captured_env_source_override_in_routes_uv_partial_and_usable_but_not_missing() {
    use notebook_protocol::connection::{EnvSource, PackageManager};

    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().join("uv");
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&uv_cache).unwrap();
    std::fs::create_dir_all(&conda_cache).unwrap();

    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some("uv-override-disk-state".to_string());
    snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
        dependencies: vec!["pandas".to_string()],
        requires_python: Some(">=3.11".to_string()),
        prerelease: None,
    });

    let missing = resolve_captured_env_override_in(Some(&snap), &uv_cache, &conda_cache);
    assert_eq!(missing.0, None);
    assert!(missing.1.is_none());

    let captured = captured_env_for_runtime(Some(&snap), CapturedEnvRuntime::Uv).unwrap();
    let CapturedEnv::Uv { deps, env_id } = captured else {
        unreachable!("runtime-specific lookup returned UV capture");
    };

    materialise_partial_uv_venv(&deps, &env_id, &uv_cache);
    let partial = resolve_captured_env_override_in(Some(&snap), &uv_cache, &conda_cache);
    assert_eq!(partial.0, Some(EnvSource::Prewarmed(PackageManager::Uv)));
    assert!(matches!(partial.1, Some(CapturedEnv::Uv { .. })));

    materialise_fake_uv_venv(&deps, &env_id, &uv_cache);
    let usable = resolve_captured_env_override_in(Some(&snap), &uv_cache, &conda_cache);
    assert_eq!(usable.0, Some(EnvSource::Prewarmed(PackageManager::Uv)));
    assert!(matches!(usable.1, Some(CapturedEnv::Uv { .. })));
}

#[test]
fn captured_env_source_override_in_routes_conda_partial_and_usable_but_not_missing() {
    use notebook_protocol::connection::{EnvSource, PackageManager};

    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().join("uv");
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&uv_cache).unwrap();
    std::fs::create_dir_all(&conda_cache).unwrap();

    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some("conda-override-disk-state".to_string());
    snap.runt.conda = Some(notebook_doc::metadata::CondaInlineMetadata {
        dependencies: vec!["scipy".to_string()],
        channels: vec!["conda-forge".to_string()],
        python: Some("3.11".to_string()),
    });

    let missing = resolve_captured_env_override_in(Some(&snap), &uv_cache, &conda_cache);
    assert_eq!(missing.0, None);
    assert!(missing.1.is_none());

    let captured = captured_env_for_runtime(Some(&snap), CapturedEnvRuntime::Conda).unwrap();
    let CapturedEnv::Conda { deps, env_id } = captured else {
        unreachable!("runtime-specific lookup returned Conda capture");
    };

    materialise_partial_conda_env(&deps, &env_id, &conda_cache);
    let partial = resolve_captured_env_override_in(Some(&snap), &uv_cache, &conda_cache);
    assert_eq!(partial.0, Some(EnvSource::Prewarmed(PackageManager::Conda)));
    assert!(matches!(partial.1, Some(CapturedEnv::Conda { .. })));

    materialise_fake_conda_env(&deps, &env_id, &conda_cache);
    let usable = resolve_captured_env_override_in(Some(&snap), &uv_cache, &conda_cache);
    assert_eq!(usable.0, Some(EnvSource::Prewarmed(PackageManager::Conda)));
    assert!(matches!(usable.1, Some(CapturedEnv::Conda { .. })));
}

#[test]
fn should_preserve_env_on_eviction_untitled_notebook_deletes() {
    // Even with captured deps + env on disk, no saved path means the
    // .ipynb won't persist the env_id binding — the env is orphaned.
    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().to_path_buf();
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&conda_cache).unwrap();

    let deps = kernel_env::UvDependencies {
        dependencies: vec!["pandas".to_string()],
        requires_python: None,
        prerelease: None,
    };
    let env_id = "env-untitled";
    let venv_path = materialise_fake_uv_venv(&deps, env_id, &uv_cache);

    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some(env_id.to_string());
    snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
        dependencies: deps.dependencies.clone(),
        requires_python: None,
        prerelease: None,
    });

    assert!(!should_preserve_env_on_eviction(
        false, // has_saved_path
        &venv_path,
        Some(&snap),
        &uv_cache,
        &conda_cache,
    ));
}

#[test]
fn should_preserve_env_on_eviction_saved_captured_notebook_preserves() {
    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().to_path_buf();
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&conda_cache).unwrap();

    let deps = kernel_env::UvDependencies {
        dependencies: vec!["pandas".to_string(), "numpy".to_string()],
        requires_python: None,
        prerelease: None,
    };
    let env_id = "env-saved";
    let venv_path = materialise_fake_uv_venv(&deps, env_id, &uv_cache);

    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some(env_id.to_string());
    snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
        dependencies: deps.dependencies.clone(),
        requires_python: None,
        prerelease: None,
    });

    assert!(should_preserve_env_on_eviction(
        true,
        &venv_path,
        Some(&snap),
        &uv_cache,
        &conda_cache,
    ));
}

#[test]
fn should_preserve_env_on_eviction_path_mismatch_deletes() {
    // Room has a saved path but its runtime_agent_env_path points at a
    // pool env (runtimed-uv-xxx), not the captured hash dir. That's a
    // pool-launched notebook — delete on eviction like before.
    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().to_path_buf();
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&conda_cache).unwrap();

    let deps = kernel_env::UvDependencies {
        dependencies: vec!["pandas".to_string()],
        requires_python: None,
        prerelease: None,
    };
    let env_id = "env-pool";
    let _ = materialise_fake_uv_venv(&deps, env_id, &uv_cache);

    let pool_path = uv_cache.join("runtimed-uv-abc123");

    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some(env_id.to_string());
    snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
        dependencies: deps.dependencies.clone(),
        requires_python: None,
        prerelease: None,
    });

    assert!(!should_preserve_env_on_eviction(
        true,
        &pool_path,
        Some(&snap),
        &uv_cache,
        &conda_cache,
    ));
}

#[test]
fn should_preserve_env_on_eviction_no_captured_metadata_deletes() {
    // Saved notebook but empty metadata — never captured, nothing to
    // preserve. This covers fresh notebooks that got saved before
    // first launch.
    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().to_path_buf();
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&conda_cache).unwrap();

    let some_path = uv_cache.join("runtimed-uv-deadbeef");

    assert!(!should_preserve_env_on_eviction(
        true,
        &some_path,
        Some(&NotebookMetadataSnapshot::default()),
        &uv_cache,
        &conda_cache,
    ));
}

#[test]
fn effective_user_deps_from_launched_uses_uv_deps_when_set() {
    // Hot-sync appends to launched.uv_deps, so that's the source of
    // truth for what should land in metadata.
    let launched = LaunchedEnvConfig {
        uv_deps: Some(vec!["pandas".to_string(), "numpy".to_string()]),
        ..LaunchedEnvConfig::default()
    };
    let deps = effective_user_deps_from_launched(&launched, CapturedEnvRuntime::Uv).unwrap();
    assert_eq!(deps, vec!["pandas".to_string(), "numpy".to_string()]);
}

#[test]
fn effective_user_deps_from_launched_ignores_prewarmed_packages() {
    // Pure prewarmed kernel that never hot-synced: uv_deps and
    // conda_deps are both None, prewarmed_packages has the pool's
    // install list. We intentionally return None here so the eviction
    // flush doesn't mistakenly populate metadata.runt.conda for a
    // pure UV kernel (or vice versa). For this case captured
    // metadata was already written at claim time and there's nothing
    // to flush.
    let launched = LaunchedEnvConfig {
        uv_deps: None,
        conda_deps: None,
        prewarmed_packages: vec![
            "ipykernel".to_string(),
            "ipywidgets".to_string(),
            "anywidget".to_string(),
            "nbformat".to_string(),
            "uv".to_string(),
            "pandas".to_string(),
        ],
        ..LaunchedEnvConfig::default()
    };
    assert!(effective_user_deps_from_launched(&launched, CapturedEnvRuntime::Uv).is_none());
    assert!(effective_user_deps_from_launched(&launched, CapturedEnvRuntime::Conda).is_none());
}

#[test]
fn effective_user_deps_from_launched_strips_base_from_uv_deps() {
    // Hot-synced a package into a captured-reopen kernel: uv_deps
    // = [captured_user_deps + synced]. Base packages should never
    // be in uv_deps in practice, but strip_base is idempotent and
    // this guards against accidental inclusion.
    let launched = LaunchedEnvConfig {
        uv_deps: Some(vec![
            "ipykernel".to_string(),
            "pandas".to_string(),
            "numpy".to_string(),
        ]),
        ..LaunchedEnvConfig::default()
    };
    let deps = effective_user_deps_from_launched(&launched, CapturedEnvRuntime::Uv).unwrap();
    assert_eq!(deps, vec!["pandas".to_string(), "numpy".to_string()]);
}

#[test]
fn effective_user_deps_from_launched_returns_none_for_wrong_runtime() {
    // Kernel launched with uv_deps; asking for Conda view returns None.
    let launched = LaunchedEnvConfig {
        uv_deps: Some(vec!["pandas".to_string()]),
        ..LaunchedEnvConfig::default()
    };
    assert!(effective_user_deps_from_launched(&launched, CapturedEnvRuntime::Conda).is_none());
}

#[test]
fn effective_user_deps_from_launched_returns_none_for_deno_only() {
    // Deno kernel: no uv/conda deps at all. No flush applicable.
    let launched = LaunchedEnvConfig::default();
    assert!(effective_user_deps_from_launched(&launched, CapturedEnvRuntime::Uv).is_none());
    assert!(effective_user_deps_from_launched(&launched, CapturedEnvRuntime::Conda).is_none());
}

#[test]
fn effective_user_deps_from_launched_conda_uses_conda_deps() {
    let launched = LaunchedEnvConfig {
        conda_deps: Some(vec!["scipy".to_string()]),
        ..LaunchedEnvConfig::default()
    };
    let deps = effective_user_deps_from_launched(&launched, CapturedEnvRuntime::Conda).unwrap();
    assert_eq!(deps, vec!["scipy".to_string()]);
}

#[tokio::test]
async fn rename_env_dir_moves_to_unified_hash_target() {
    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().to_path_buf();
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&conda_cache).unwrap();

    // Initial state: env lives under the OLD hash (captured deps
    // before hot-sync). We materialise a fake venv there.
    let old_deps = kernel_env::UvDependencies {
        dependencies: vec!["pandas".to_string()],
        requires_python: None,
        prerelease: None,
    };
    let env_id = "rename-target";
    let old_path = materialise_fake_uv_venv(&old_deps, env_id, &uv_cache);

    // Metadata after flush: deps grew to include numpy (new hash).
    let new_deps = kernel_env::UvDependencies {
        dependencies: vec!["pandas".to_string(), "numpy".to_string()],
        requires_python: None,
        prerelease: None,
    };
    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some(env_id.to_string());
    snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
        dependencies: new_deps.dependencies.clone(),
        requires_python: None,
        prerelease: None,
    });

    let expected_target =
        uv_cache.join(kernel_env::uv::compute_unified_env_hash(&new_deps, env_id));
    assert!(!expected_target.exists());

    let returned = rename_env_dir_to_unified_hash(
        &old_path,
        Some(&snap),
        CapturedEnvRuntime::Uv,
        &uv_cache,
        &conda_cache,
    )
    .await;

    assert_eq!(returned, expected_target);
    assert!(!old_path.exists());
    assert!(expected_target.exists());
}

#[tokio::test]
async fn rename_env_dir_noop_when_already_at_target() {
    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().to_path_buf();
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&conda_cache).unwrap();

    let deps = kernel_env::UvDependencies {
        dependencies: vec!["pandas".to_string()],
        requires_python: None,
        prerelease: None,
    };
    let env_id = "already-correct";
    let path = materialise_fake_uv_venv(&deps, env_id, &uv_cache);

    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some(env_id.to_string());
    snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
        dependencies: deps.dependencies.clone(),
        requires_python: None,
        prerelease: None,
    });

    let returned = rename_env_dir_to_unified_hash(
        &path,
        Some(&snap),
        CapturedEnvRuntime::Uv,
        &uv_cache,
        &conda_cache,
    )
    .await;

    assert_eq!(returned, path);
    assert!(path.exists());
}

#[tokio::test]
async fn rename_env_dir_skips_when_target_exists() {
    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().to_path_buf();
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&conda_cache).unwrap();

    // Two distinct envs on disk — an old one and the target name
    // from a different notebook already claimed. We must not
    // clobber the target.
    let old_deps = kernel_env::UvDependencies {
        dependencies: vec!["pandas".to_string()],
        requires_python: None,
        prerelease: None,
    };
    let env_id = "collide";
    let old_path = materialise_fake_uv_venv(&old_deps, env_id, &uv_cache);

    let new_deps = kernel_env::UvDependencies {
        dependencies: vec!["pandas".to_string(), "numpy".to_string()],
        requires_python: None,
        prerelease: None,
    };
    let occupied_path = materialise_fake_uv_venv(&new_deps, env_id, &uv_cache);
    assert!(occupied_path.exists());

    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some(env_id.to_string());
    snap.runt.uv = Some(notebook_doc::metadata::UvInlineMetadata {
        dependencies: new_deps.dependencies.clone(),
        requires_python: None,
        prerelease: None,
    });

    let returned = rename_env_dir_to_unified_hash(
        &old_path,
        Some(&snap),
        CapturedEnvRuntime::Uv,
        &uv_cache,
        &conda_cache,
    )
    .await;

    // Target is occupied — leave source intact.
    assert_eq!(returned, old_path);
    assert!(old_path.exists());
    assert!(occupied_path.exists());
}

#[tokio::test]
async fn rename_env_dir_noop_when_no_captured_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().to_path_buf();
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&conda_cache).unwrap();

    let some_path = uv_cache.join("runtimed-uv-abc123");
    std::fs::create_dir_all(&some_path).unwrap();

    let returned = rename_env_dir_to_unified_hash(
        &some_path,
        Some(&NotebookMetadataSnapshot::default()),
        CapturedEnvRuntime::Uv,
        &uv_cache,
        &conda_cache,
    )
    .await;

    assert_eq!(returned, some_path);
    assert!(some_path.exists());
}

/// Regression: conda-only notebook with env_id set must not route
/// its rename through the UV hash function. Before the runtime
/// parameter was explicit, `captured_env_for_runtime(Uv)` would
/// synthesise a zero-dep UV capture from `runt.env_id`, and the
/// rename helper would pick the UV-hash path first even though the
/// kernel was conda.
#[tokio::test]
async fn rename_env_dir_uses_conda_hash_when_runtime_is_conda() {
    let tmp = tempfile::tempdir().unwrap();
    let uv_cache = tmp.path().join("uv");
    let conda_cache = tmp.path().join("conda");
    std::fs::create_dir_all(&uv_cache).unwrap();
    std::fs::create_dir_all(&conda_cache).unwrap();

    let old_conda_deps = kernel_env::CondaDependencies {
        dependencies: vec!["numpy".to_string()],
        channels: vec!["conda-forge".to_string()],
        python: None,
        env_id: None,
    };
    let env_id = "conda-rename";
    let old_path = materialise_fake_conda_env(&old_conda_deps, env_id, &conda_cache);

    let new_conda_deps = kernel_env::CondaDependencies {
        dependencies: vec!["numpy".to_string(), "scipy".to_string()],
        channels: vec!["conda-forge".to_string()],
        python: None,
        env_id: None,
    };
    let expected = conda_cache.join(kernel_env::conda::compute_unified_env_hash(
        &new_conda_deps,
        env_id,
    ));

    let mut snap = NotebookMetadataSnapshot::default();
    snap.runt.env_id = Some(env_id.to_string());
    snap.runt.conda = Some(notebook_doc::metadata::CondaInlineMetadata {
        dependencies: new_conda_deps.dependencies.clone(),
        channels: new_conda_deps.channels.clone(),
        python: None,
    });

    let returned = rename_env_dir_to_unified_hash(
        &old_path,
        Some(&snap),
        CapturedEnvRuntime::Conda,
        &uv_cache,
        &conda_cache,
    )
    .await;

    assert_eq!(returned, expected);
    assert!(expected.exists());
    assert!(!old_path.exists());
}

/// P1 regression: the manual LaunchKernel handler must apply the captured
/// override when the requested `env_source` is auto/prewarmed but respect
/// explicit `auto:uv` / `auto:conda` scopes when they disagree with the
/// captured runtime.
///
/// This mirrors the filter inside the LaunchKernel handler. The daemon
/// side of the launch pipeline needs real pool state, so we can't spin
/// it up from a unit test — the filter is factored so the logic it
/// consumes is unit-testable in isolation.
#[test]
fn launch_kernel_captured_override_respects_auto_scope() {
    // The `captured` inputs here are the *string* outputs of
    // `captured_env_source_override`. Simulate a UV-captured notebook.
    let captured_uv = Some("uv:prewarmed".to_string());
    let captured_conda = Some("conda:prewarmed".to_string());

    // Replicates the inline filter inside the LaunchKernel handler.
    fn apply_scope(captured: Option<String>, auto_scope: Option<&str>) -> Option<String> {
        captured.filter(|src| match auto_scope {
            Some("uv") => src == "uv:prewarmed",
            Some("conda") => src == "conda:prewarmed",
            Some("pixi") => false,
            _ => true,
        })
    }

    // Plain auto (no scope) — captured override wins.
    assert_eq!(
        apply_scope(captured_uv.clone(), None),
        Some("uv:prewarmed".to_string())
    );
    assert_eq!(
        apply_scope(captured_conda.clone(), None),
        Some("conda:prewarmed".to_string())
    );

    // Explicit matching scope still fires.
    assert_eq!(
        apply_scope(captured_uv.clone(), Some("uv")),
        Some("uv:prewarmed".to_string())
    );
    assert_eq!(
        apply_scope(captured_conda.clone(), Some("conda")),
        Some("conda:prewarmed".to_string())
    );

    // Explicit mismatched scope drops the override so the project-file /
    // inline-deps priority chain takes over — user intent wins.
    assert_eq!(apply_scope(captured_uv.clone(), Some("conda")), None);
    assert_eq!(apply_scope(captured_conda.clone(), Some("uv")), None);

    // `auto:pixi` always drops the override (no pixi captures today).
    assert_eq!(apply_scope(captured_uv, Some("pixi")), None);
    assert_eq!(apply_scope(captured_conda, Some("pixi")), None);
}

#[test]
fn select_auto_python_env_source_respects_environment_mode() {
    use notebook_protocol::connection::{CreateNotebookEnvironmentMode, EnvSource, PackageManager};

    let notebook = Some(EnvSource::Inline(PackageManager::Uv));
    let project = Some(EnvSource::Pyproject);
    let fallback = EnvSource::Prewarmed(PackageManager::Conda);

    assert_eq!(
        select_auto_python_env_source(
            CreateNotebookEnvironmentMode::Auto,
            notebook.clone(),
            project.clone(),
            fallback.clone(),
        ),
        EnvSource::Pyproject
    );
    assert_eq!(
        select_auto_python_env_source(
            CreateNotebookEnvironmentMode::Project,
            notebook.clone(),
            project.clone(),
            fallback.clone(),
        ),
        EnvSource::Pyproject
    );
    assert_eq!(
        select_auto_python_env_source(
            CreateNotebookEnvironmentMode::Notebook,
            notebook,
            project,
            fallback,
        ),
        EnvSource::Inline(PackageManager::Uv)
    );
}

#[test]
fn select_auto_python_env_source_falls_back_without_project_or_notebook_env() {
    use notebook_protocol::connection::{CreateNotebookEnvironmentMode, EnvSource, PackageManager};

    let fallback = EnvSource::Prewarmed(PackageManager::Uv);

    assert_eq!(
        select_auto_python_env_source(
            CreateNotebookEnvironmentMode::Auto,
            None,
            None,
            fallback.clone(),
        ),
        fallback
    );
    assert_eq!(
        select_auto_python_env_source(
            CreateNotebookEnvironmentMode::Notebook,
            None,
            Some(EnvSource::Pyproject),
            EnvSource::Prewarmed(PackageManager::Conda),
        ),
        EnvSource::Prewarmed(PackageManager::Conda)
    );
}

/// Pre-upgrade notebooks: env_id is set but deps are empty. The capture
/// step must still record the env_id (no-op) and populate user_defaults
/// if they were derived from the pool. This is the migration path from
/// § 4 Migration of the spec.
#[tokio::test]
async fn capture_migrates_pre_upgrade_notebook() {
    let (room, _tmp) = test_room_for_capture().await;
    // Pre-upgrade state: env_id exists, uv section exists but empty.
    let snap_before = room.doc.read().await.get_metadata_snapshot().unwrap();
    assert_eq!(snap_before.runt.env_id.as_deref(), Some("test-env-id"));
    assert!(
        snap_before
            .runt
            .uv
            .as_ref()
            .map(|u| u.dependencies.is_empty())
            .unwrap_or(true),
        "pre-upgrade notebook starts with empty uv deps"
    );

    let user_defaults = vec!["polars".to_string()];
    let wrote =
        capture_env_into_metadata(&room, CapturedEnvRuntime::Uv, &user_defaults, "test-env-id")
            .await;
    assert!(wrote, "migration should populate user_defaults into deps");

    let snap_after = room.doc.read().await.get_metadata_snapshot().unwrap();
    assert_eq!(
        snap_after.runt.uv.as_ref().unwrap().dependencies,
        vec!["polars".to_string()]
    );
}

#[test]
fn test_env_yml_insertion_point_skips_pip_block() {
    let content = "name: test\ndependencies:\n  - numpy\n  - pip:\n    - pyyaml\n    - requests\n  - scipy\nchannels:\n  - conda-forge\n";
    let ins = find_env_yml_deps_insertion_point(content).unwrap();
    let expected =
        "name: test\ndependencies:\n  - numpy\n  - pip:\n    - pyyaml\n    - requests\n  - scipy\n"
            .len();
    assert_eq!(ins.offset, expected);
}

#[test]
fn test_env_yml_insertion_point_pip_block_at_end() {
    let content = "dependencies:\n  - numpy\n  - pandas\n  - pip:\n    - pyyaml\n";
    let ins = find_env_yml_deps_insertion_point(content).unwrap();
    let expected = "dependencies:\n  - numpy\n  - pandas\n".len();
    assert_eq!(ins.offset, expected);
}

#[test]
fn test_env_yml_insertion_point_crlf() {
    let content = "dependencies:\r\n  - numpy\r\n  - pandas\r\n";
    let ins = find_env_yml_deps_insertion_point(content).unwrap();
    assert_eq!(ins.offset, content.len());
    assert_eq!(ins.newline, "\r\n");
    assert_eq!(ins.indent, "  ");
}

#[test]
fn test_env_yml_insertion_point_four_space_indent() {
    let content = "dependencies:\n    - numpy\n    - pandas\n";
    let ins = find_env_yml_deps_insertion_point(content).unwrap();
    assert_eq!(ins.offset, content.len());
    assert_eq!(ins.indent, "    ");
}

#[test]
fn test_extract_env_yml_package_names_splits_namespaces() {
    let content = "\
name: test
channels:
  - conda-forge
dependencies:
  - numpy=1.24
  - python=3.11
  - pip:
    - pyyaml>=6.0
    - requests
  - scipy
";
    let names = extract_env_yml_package_names(content);
    assert!(names.conda.contains("numpy"));
    assert!(names.conda.contains("python"));
    assert!(names.conda.contains("scipy"));
    assert_eq!(names.conda.len(), 3);
    assert!(names.pip.contains("pyyaml"));
    assert!(names.pip.contains("requests"));
    assert_eq!(names.pip.len(), 2);
}

#[test]
fn test_extract_env_yml_package_names_malformed() {
    let content = "not: valid: {{yaml";
    let names = extract_env_yml_package_names(content);
    assert!(names.conda.is_empty());
    assert!(names.pip.is_empty());
}

#[test]
fn test_env_yml_conda_dep_not_blocked_by_pip_duplicate() {
    // A package under pip: must not prevent promoting the same name as a
    // conda dep — they are different namespaces. See #2076 review.
    let content = "\
dependencies:
  - numpy
  - pip:
    - pyyaml
";
    let names = extract_env_yml_package_names(content);
    assert!(
        !names.conda.contains("pyyaml"),
        "pyyaml is pip-only, not in conda set"
    );
    assert!(names.pip.contains("pyyaml"), "pyyaml should be in pip set");
}

#[tokio::test]
async fn test_promote_conda_dep_not_blocked_by_pip_duplicate() {
    // End-to-end: pyyaml exists under pip: in environment.yml. The user adds
    // pyyaml as a conda dep in notebook metadata. Promotion must write pyyaml
    // as a top-level conda dep AND leave the pip block untouched. See #2076.
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _notebook_path) = test_room_with_path(&tmp, "test.ipynb");

    let env_yml_path = tmp.path().join("environment.yml");
    let initial_content = "\
name: test-env
channels:
  - conda-forge
dependencies:
  - numpy
  - pip:
    - pyyaml
";
    std::fs::write(&env_yml_path, initial_content).unwrap();

    // Baseline: launched with numpy only (pip deps not in this list)
    let launched = notebook_protocol::protocol::LaunchedEnvConfig {
        environment_yml_path: Some(env_yml_path.clone()),
        environment_yml_deps: Some(vec!["numpy".to_string()]),
        ..Default::default()
    };

    // CRDT says the user wants pyyaml as a notebook-scoped conda dep. The
    // environment.yml baseline remains project context and must not be copied
    // back into the notebook metadata after promotion.
    let snapshot = snapshot_with_conda(vec!["pyyaml".to_string()]);
    {
        let mut doc = room.doc.write().await;
        let _ = doc.set_metadata_snapshot(&snapshot);
    }

    let result = promote_inline_deps_to_project(&room, "conda:env_yml", &launched)
        .await
        .expect("promotion should succeed");

    assert_eq!(result, vec!["+pyyaml"]);

    let updated = std::fs::read_to_string(&env_yml_path).unwrap();
    // pyyaml added as top-level conda dep
    assert!(
        updated.contains("\n  - pyyaml\n"),
        "pyyaml should be a top-level conda dep:\n{updated}"
    );
    // pip block untouched
    assert!(
        updated.contains("  - pip:\n    - pyyaml\n"),
        "pip block should be untouched:\n{updated}"
    );

    let after = room.doc.read().await.get_metadata_snapshot().unwrap();
    assert_eq!(
        after.runt.conda.unwrap().dependencies,
        vec!["pyyaml".to_string()],
        "project-file promotion must not mirror environment.yml deps into notebook metadata"
    );
}

// ── #2150: project-file trust reconciliation tests ─────────────────────

fn write_pyproject_with_deps(dir: &std::path::Path, deps: &[&str]) {
    let body = format!(
        "[project]\nname = \"test\"\nversion = \"0.0.1\"\ndependencies = [{}]\n",
        deps.iter()
            .map(|d| format!("\"{}\"", d))
            .collect::<Vec<_>>()
            .join(", ")
    );
    std::fs::write(dir.join("pyproject.toml"), body).unwrap();
}

fn write_unsigned_ipynb_with_uv_deps(path: &std::path::Path, deps: &[&str]) {
    let deps_json = deps
        .iter()
        .map(|d| format!("\"{}\"", d))
        .collect::<Vec<_>>()
        .join(",");
    let body = format!(
        r#"{{
  "cells": [],
  "metadata": {{
    "kernelspec": {{"name": "python3", "display_name": "Python 3", "language": "python"}},
    "language_info": {{"name": "python"}},
    "runt": {{
      "schema_version": "1",
      "uv": {{"dependencies": [{}]}}
    }}
  }},
  "nbformat": 4,
  "nbformat_minor": 5
}}"#,
        deps_json
    );
    std::fs::write(path, body).unwrap();
}

#[test]
fn test_project_file_deps_match_trust_info_pyproject_match() {
    let tmp = tempfile::tempdir().unwrap();
    write_pyproject_with_deps(tmp.path(), &["pandas", "numpy"]);
    let nb_path = tmp.path().join("notebook.ipynb");
    write_unsigned_ipynb_with_uv_deps(&nb_path, &["pandas", "numpy"]);

    let info = verify_trust_from_file(&nb_path, &unavailable_test_store()).info;
    assert_eq!(info.uv_dependencies, vec!["pandas", "numpy"]);
    assert!(project_file_deps_match_trust_info(&nb_path, &info));
}

#[test]
fn test_project_file_deps_match_trust_info_pyproject_mismatch() {
    let tmp = tempfile::tempdir().unwrap();
    write_pyproject_with_deps(tmp.path(), &["pandas"]);
    let nb_path = tmp.path().join("notebook.ipynb");
    write_unsigned_ipynb_with_uv_deps(&nb_path, &["pandas", "numpy"]);

    let info = verify_trust_from_file(&nb_path, &unavailable_test_store()).info;
    assert!(!project_file_deps_match_trust_info(&nb_path, &info));
}

fn write_env_yml(dir: &std::path::Path, channels: &[&str], deps: &[&str]) {
    let mut body = String::from("name: test\n");
    if !channels.is_empty() {
        body.push_str("channels:\n");
        for c in channels {
            body.push_str(&format!("  - {}\n", c));
        }
    }
    body.push_str("dependencies:\n");
    for d in deps {
        body.push_str(&format!("  - {}\n", d));
    }
    std::fs::write(dir.join("environment.yml"), body).unwrap();
}

fn write_unsigned_ipynb_with_conda(path: &std::path::Path, deps: &[&str], channels: &[&str]) {
    let deps_json = deps
        .iter()
        .map(|d| format!("\"{}\"", d))
        .collect::<Vec<_>>()
        .join(",");
    let channels_json = channels
        .iter()
        .map(|c| format!("\"{}\"", c))
        .collect::<Vec<_>>()
        .join(",");
    let body = format!(
        r#"{{
  "cells": [],
  "metadata": {{
    "kernelspec": {{"name": "python3", "display_name": "Python 3", "language": "python"}},
    "language_info": {{"name": "python"}},
    "runt": {{
      "schema_version": "1",
      "conda": {{"dependencies": [{}], "channels": [{}]}}
    }}
  }},
  "nbformat": 4,
  "nbformat_minor": 5
}}"#,
        deps_json, channels_json
    );
    std::fs::write(path, body).unwrap();
}

/// Codex P1 on #2158: env.yml match must also compare channels, not
/// just deps. Without this, a notebook with matching deps but different
/// inline channels would be auto-signed as Trusted, preserving an
/// approved signature over channels that didn't come from the project
/// file.
#[test]
fn test_project_file_deps_match_trust_info_envyml_channel_mismatch() {
    let tmp = tempfile::tempdir().unwrap();
    write_env_yml(tmp.path(), &["conda-forge"], &["pandas", "numpy"]);
    let nb_path = tmp.path().join("notebook.ipynb");
    // Same deps, different channels — must not match.
    write_unsigned_ipynb_with_conda(&nb_path, &["pandas", "numpy"], &["http://evil.example"]);

    let info = verify_trust_from_file(&nb_path, &unavailable_test_store()).info;
    assert_eq!(info.conda_dependencies, vec!["pandas", "numpy"]);
    assert_eq!(info.conda_channels, vec!["http://evil.example"]);
    assert!(
        !project_file_deps_match_trust_info(&nb_path, &info),
        "channel mismatch must block reconciliation even when deps match",
    );
}

#[test]
fn test_project_file_deps_match_trust_info_envyml_match() {
    let tmp = tempfile::tempdir().unwrap();
    write_env_yml(tmp.path(), &["conda-forge", "bioconda"], &["pandas"]);
    let nb_path = tmp.path().join("notebook.ipynb");
    write_unsigned_ipynb_with_conda(&nb_path, &["pandas"], &["conda-forge", "bioconda"]);

    let info = verify_trust_from_file(&nb_path, &unavailable_test_store()).info;
    assert!(project_file_deps_match_trust_info(&nb_path, &info));
}

#[test]
fn test_project_file_deps_match_trust_info_envyml_channel_order() {
    let tmp = tempfile::tempdir().unwrap();
    write_env_yml(tmp.path(), &["conda-forge", "bioconda"], &["pandas"]);
    let nb_path = tmp.path().join("notebook.ipynb");
    // Same channels but reversed — channel priority matters, so reject.
    write_unsigned_ipynb_with_conda(&nb_path, &["pandas"], &["bioconda", "conda-forge"]);

    let info = verify_trust_from_file(&nb_path, &unavailable_test_store()).info;
    assert!(
        !project_file_deps_match_trust_info(&nb_path, &info),
        "channel order affects conda resolution priority; reorderings must not auto-heal",
    );
}

#[test]
fn test_project_file_deps_match_trust_info_no_project_file() {
    let tmp = tempfile::tempdir().unwrap();
    let nb_path = tmp.path().join("notebook.ipynb");
    write_unsigned_ipynb_with_uv_deps(&nb_path, &["pandas"]);

    let info = verify_trust_from_file(&nb_path, &unavailable_test_store()).info;
    assert!(!project_file_deps_match_trust_info(&nb_path, &info));
}

/// Regression for #2150: a .ipynb on disk with deps that match a
/// project file's but no signature (a notebook saved by the pre-fix
/// build) must land on Trusted at room creation, so the auto-launch
/// gate in peer_connection.rs doesn't block.
#[tokio::test]
async fn test_new_fresh_promotes_untrusted_when_project_file_deps_match() {
    let tmp = tempfile::tempdir().unwrap();
    write_pyproject_with_deps(tmp.path(), &["pandas", "numpy"]);
    let nb_path = tmp.path().join("notebook.ipynb");
    write_unsigned_ipynb_with_uv_deps(&nb_path, &["pandas", "numpy"]);

    // Bare verify sees Untrusted — precondition.
    assert_eq!(
        verify_trust_from_file(&nb_path, &unavailable_test_store()).status,
        runt_trust::TrustStatus::Untrusted,
    );

    // Room creation runs reconciliation: project-file deps get seeded into
    // the allowlist with source="project_file", and trust recomputes to
    // Trusted via the standard allowlist gate.
    let blob_store = test_blob_store(&tmp);
    let store = open_test_store(&tmp);
    let room = NotebookRoom::new_fresh_with_trusted_packages(
        uuid::Uuid::new_v4(),
        Some(nb_path.clone()),
        tmp.path(),
        blob_store,
        false,
        store.clone(),
    )
    .expect("create test notebook room");

    let ts = room.trust_state.read().await;
    assert_eq!(
        ts.status,
        runt_trust::TrustStatus::Trusted,
        "room init should seed project-file deps into the allowlist and resolve Trusted",
    );
    drop(ts);

    // The deps are now in the allowlist - subsequent rooms see Trusted
    // without needing to re-run reconciliation.
    let info_check = runt_trust::TrustInfo {
        status: runt_trust::TrustStatus::Untrusted,
        uv_dependencies: vec!["pandas".to_string(), "numpy".to_string()],
        approved_uv_dependencies: vec![],
        conda_dependencies: vec![],
        approved_conda_dependencies: vec![],
        conda_channels: vec![],
        approved_conda_channels: vec![],
        pixi_dependencies: vec![],
        approved_pixi_dependencies: vec![],
        pixi_pypi_dependencies: vec![],
        approved_pixi_pypi_dependencies: vec![],
        pixi_channels: vec![],
        approved_pixi_channels: vec![],
    };
    assert!(
        store.all_dependencies_approved(&info_check).unwrap(),
        "project-file reconciliation should write approvals to the allowlist"
    );
}

/// Counterpart: if deps differ, room init must leave trust Untrusted.
#[tokio::test]
async fn test_new_fresh_leaves_untrusted_when_deps_differ() {
    let tmp = tempfile::tempdir().unwrap();
    write_pyproject_with_deps(tmp.path(), &["pandas"]);
    let nb_path = tmp.path().join("notebook.ipynb");
    write_unsigned_ipynb_with_uv_deps(&nb_path, &["pandas", "numpy"]);

    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(
        uuid::Uuid::new_v4(),
        Some(nb_path.clone()),
        tmp.path(),
        blob_store,
        false,
    );

    let ts = room.trust_state.read().await;
    assert_eq!(
        ts.status,
        runt_trust::TrustStatus::Untrusted,
        "mismatched deps must not auto-promote",
    );
}

/// Project-file reconciliation must not bypass the allowlist when the
/// store can't accept writes. With the allowlist as the single trust
/// gate, an unavailable store has to leave the room Untrusted - otherwise
/// matching deps would auto-launch with no record of approval.
#[tokio::test]
async fn test_new_fresh_stays_untrusted_when_allowlist_unavailable() {
    let tmp = tempfile::tempdir().unwrap();
    write_pyproject_with_deps(tmp.path(), &["pandas", "numpy"]);
    let nb_path = tmp.path().join("notebook.ipynb");
    write_unsigned_ipynb_with_uv_deps(&nb_path, &["pandas", "numpy"]);

    let blob_store = test_blob_store(&tmp);
    let store = unavailable_test_store();
    let room = NotebookRoom::new_fresh_with_trusted_packages(
        uuid::Uuid::new_v4(),
        Some(nb_path.clone()),
        tmp.path(),
        blob_store,
        false,
        store,
    )
    .expect("create test notebook room");

    let ts = room.trust_state.read().await;
    assert_eq!(
        ts.status,
        runt_trust::TrustStatus::Untrusted,
        "fail-closed: project-file reconciliation cannot bypass the allowlist",
    );
}

// ── #2157: environment.yml declares unbuilt conda env ─────────────────

#[test]
fn test_missing_conda_env_yml_decision_detects_unbuilt_named_env() {
    let tmp = tempfile::tempdir().unwrap();
    let yml_path = tmp.path().join("environment.yml");
    std::fs::write(
        &yml_path,
        "name: nteract-integration-probe-definitely-not-built-xyz\ndependencies:\n  - python\n",
    )
    .unwrap();
    let detected = crate::project_file::DetectedProjectFile {
        path: yml_path,
        kind: crate::project_file::ProjectFileKind::EnvironmentYml,
    };
    let decision =
        missing_conda_env_yml_decision(&detected).expect("unbuilt named env should gate launch");
    assert_eq!(
        decision.label,
        "nteract-integration-probe-definitely-not-built-xyz"
    );
    assert!(decision.create_command.starts_with("conda env create -f "));
}

#[test]
fn test_missing_conda_env_yml_decision_skips_non_envyml() {
    let tmp = tempfile::tempdir().unwrap();
    write_pyproject_with_deps(tmp.path(), &["pandas"]);
    let detected = crate::project_file::DetectedProjectFile {
        path: tmp.path().join("pyproject.toml"),
        kind: crate::project_file::ProjectFileKind::PyprojectToml,
    };
    assert_eq!(missing_conda_env_yml_decision(&detected), None);
}

#[test]
fn test_missing_conda_env_yml_decision_detects_unbuilt_unnamed_envyml() {
    let tmp = tempfile::tempdir().unwrap();
    let yml_path = tmp.path().join("environment.yml");
    std::fs::write(
        &yml_path,
        "channels:\n  - conda-forge\ndependencies:\n  - python\n  - ipykernel\n",
    )
    .unwrap();
    let detected = crate::project_file::DetectedProjectFile {
        path: yml_path,
        kind: crate::project_file::ProjectFileKind::EnvironmentYml,
    };
    let decision =
        missing_conda_env_yml_decision(&detected).expect("unnamed env should gate creation");
    assert!(
        decision.label.contains("conda-envs"),
        "unnamed env label should point at the computed cache prefix; got {:?}",
        decision.label
    );
    assert!(
        decision.create_command.contains("conda env create -p ")
            && decision.create_command.contains(" -f "),
        "unnamed env should get an explicit prefix create command; got {:?}",
        decision.create_command
    );
}

#[tokio::test]
async fn test_project_environment_build_uses_preapproved_packages() {
    let tmp = tempfile::TempDir::new().unwrap();
    let store =
        crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
            .unwrap();
    let (room, _notebook_path) =
        test_room_with_path_and_store(&tmp, "project-env.ipynb", store.clone());
    let yml_path = tmp.path().join("environment.yml");
    std::fs::write(
        &yml_path,
        "channels:\n  - conda-forge\ndependencies:\n  - python\n  - pandas\n  - six\n",
    )
    .unwrap();
    let detected = crate::project_file::DetectedProjectFile {
        path: yml_path.clone(),
        kind: crate::project_file::ProjectFileKind::EnvironmentYml,
    };

    assert!(
        !project_environment_build_approved(&room, &detected),
        "unapproved project packages should gate environment creation",
    );

    let config = crate::project_file::parse_environment_yml(&yml_path).unwrap();
    store
        .add_from_info(&environment_yml_trust_info(&config), "test")
        .unwrap();

    assert!(
        project_environment_build_approved(&room, &detected),
        "preapproved project packages should allow seamless environment creation",
    );
}

/// Codex P2 on #2167: `prefix:` pointing at a non-existent path must
/// be reported as missing so `auto_launch_kernel` surfaces the typed
/// error instead of letting the runtime agent die with the generic
/// resolver message. The reported name falls back to the prefix path
/// when env.yml has no `name:`.
#[test]
fn test_missing_conda_env_yml_name_prefix_missing_reports_path() {
    let tmp = tempfile::tempdir().unwrap();
    let missing_prefix = tmp.path().join("definitely-does-not-exist");
    let yml_path = tmp.path().join("environment.yml");
    std::fs::write(
        &yml_path,
        format!(
            "prefix: {}\ndependencies:\n  - python\n",
            missing_prefix.display()
        ),
    )
    .unwrap();
    let detected = crate::project_file::DetectedProjectFile {
        path: yml_path,
        kind: crate::project_file::ProjectFileKind::EnvironmentYml,
    };
    let decision =
        missing_conda_env_yml_decision(&detected).expect("prefix: missing should report");
    assert!(
        decision.label.contains("definitely-does-not-exist"),
        "reported name should include the prefix path; got {:?}",
        decision.label,
    );
    assert!(
        decision.create_command.contains("conda env create -p "),
        "prefix: missing should include an explicit create prefix; got {:?}",
        decision.create_command,
    );
}

/// When env.yml has both `name:` and a non-existent `prefix:`, the
/// name wins for display (shorter, more identifiable).
#[test]
fn test_missing_conda_env_yml_name_prefers_name_over_missing_prefix() {
    let tmp = tempfile::tempdir().unwrap();
    let missing_prefix = tmp.path().join("definitely-does-not-exist");
    let yml_path = tmp.path().join("environment.yml");
    std::fs::write(
        &yml_path,
        format!(
            "name: myenv\nprefix: {}\ndependencies:\n  - python\n",
            missing_prefix.display()
        ),
    )
    .unwrap();
    let detected = crate::project_file::DetectedProjectFile {
        path: yml_path,
        kind: crate::project_file::ProjectFileKind::EnvironmentYml,
    };
    assert_eq!(
        missing_conda_env_yml_decision(&detected)
            .as_ref()
            .map(|d| d.label.as_str()),
        Some("myenv"),
    );
}

#[test]
fn test_missing_conda_env_yml_name_prefix_with_python_is_not_missing() {
    let tmp = tempfile::tempdir().unwrap();
    let prefix = tmp.path().join("fake-env");
    #[cfg(not(target_os = "windows"))]
    {
        std::fs::create_dir_all(prefix.join("bin")).unwrap();
        std::fs::write(prefix.join("bin").join("python"), "#!/bin/sh\nexit 0\n").unwrap();
    }
    #[cfg(target_os = "windows")]
    {
        std::fs::create_dir_all(&prefix).unwrap();
        std::fs::write(prefix.join("python.exe"), "").unwrap();
    }
    let yml_path = tmp.path().join("environment.yml");
    std::fs::write(
        &yml_path,
        format!("prefix: {}\ndependencies:\n  - python\n", prefix.display()),
    )
    .unwrap();
    let detected = crate::project_file::DetectedProjectFile {
        path: yml_path,
        kind: crate::project_file::ProjectFileKind::EnvironmentYml,
    };
    assert_eq!(missing_conda_env_yml_decision(&detected), None);
}

// ---------------------------------------------------------------------------
// CloneAsEphemeral handler tests
// ---------------------------------------------------------------------------

/// Build the minimum scaffolding the clone handler needs: a combined
/// room registry, a docs_dir, and a blob store. Lets the handler run
/// without a full `Daemon`.
fn clone_test_scaffolding(
    tmp: &tempfile::TempDir,
) -> (NotebookRooms, std::path::PathBuf, Arc<BlobStore>) {
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();
    let blob_store = test_blob_store(tmp);
    (rooms, docs_dir, blob_store)
}

#[tokio::test]
async fn test_clone_as_ephemeral_forks_cells_and_clears_outputs() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (rooms, docs_dir, blob_store) = clone_test_scaffolding(&tmp);

    // Build a file-backed source room with cells + markdown/raw attachments
    // + stamped trust, registered in the rooms map.
    let source_path = tmp.path().join("source.ipynb");
    let source_uuid = Uuid::new_v4();
    let (source_room, _source_guard) = get_or_create_room(
        &rooms,
        source_uuid,
        RoomCreationOptions {
            path: Some(source_path.clone()),
            initial_load_execution_store_dir: None,
            docs_dir: &docs_dir,
            blob_store: blob_store.clone(),
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;

    let attachment_hash = blob_store.put(b"hello", "image/png").await.unwrap();
    let raw_attachment_hash = blob_store
        .put(
            &serde_json::to_vec(&serde_json::json!({"kind": "clone"})).unwrap(),
            "application/json",
        )
        .await
        .unwrap();
    {
        let mut doc = source_room.doc.write().await;
        doc.add_cell(0, "code-1", "code").unwrap();
        doc.update_source("code-1", "x = 1").unwrap();
        doc.add_cell(1, "md-1", "markdown").unwrap();
        doc.update_source("md-1", "# hello").unwrap();
        doc.add_cell(2, "raw-1", "raw").unwrap();
        doc.update_source("raw-1", "attachment ref").unwrap();
        // Seed resolved_assets on the markdown cell so we can verify the
        // clone carries them through (markdown cells render via
        // `cell.resolvedAssets` — asset ref -> blob hash — and an empty
        // map would break inline images).
        let mut assets = HashMap::new();
        assets.insert(
            "attachment:image.png".to_string(),
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string(),
        );
        doc.set_cell_resolved_assets("md-1", &assets).unwrap();
        let attachments = HashMap::from([(
            "image.png".to_string(),
            HashMap::from([(
                "image/png".to_string(),
                AttachmentRef {
                    blob_hash: attachment_hash.clone(),
                    encoding: AttachmentEncoding::Base64,
                },
            )]),
        )]);
        doc.set_cell_attachments("md-1", &attachments).unwrap();
        let raw_attachments = HashMap::from([(
            "payload.json".to_string(),
            HashMap::from([(
                "application/json".to_string(),
                AttachmentRef {
                    blob_hash: raw_attachment_hash.clone(),
                    encoding: AttachmentEncoding::Json,
                },
            )]),
        )]);
        doc.set_cell_attachments("raw-1", &raw_attachments).unwrap();
        // Stamp source metadata: env_id only (clone gets a fresh one).
        let mut snap = snapshot_empty();
        snap.runt.env_id = Some("source-env-id".to_string());
        doc.set_metadata_snapshot(&snap).unwrap();
    }
    // Dispatch clone handler.
    let response = crate::requests::clone_notebook::handle_inner(
        &rooms,
        &docs_dir,
        blob_store.clone(),
        source_uuid.to_string(),
    )
    .await;

    // Response shape.
    let (clone_id, clone_working_dir) = match response {
        NotebookResponse::NotebookCloned {
            notebook_id,
            working_dir,
        } => (notebook_id, working_dir),
        other => panic!("Expected NotebookCloned, got {other:?}"),
    };

    // Working dir = source's parent.
    assert_eq!(
        clone_working_dir.as_deref(),
        Some(tmp.path().to_string_lossy().as_ref())
    );

    // UUID differs.
    let clone_uuid = Uuid::parse_str(&clone_id).unwrap();
    assert_ne!(clone_uuid, source_uuid);

    // Room is registered.
    let clone_room = rooms
        .peek_uuid(clone_uuid)
        .await
        .expect("clone room should be registered");

    // Ephemeral.
    assert!(clone_room.file_binding.is_ephemeral());

    // working_dir seeded on the room.
    assert_eq!(
        clone_room.identity.working_dir.read().await.as_deref(),
        Some(tmp.path())
    );
    assert_eq!(
        clone_room
            .state
            .with_doc(|sd| Ok(sd.workstation_attachment()))
            .unwrap()
            .and_then(|attachment| attachment.working_directory),
        Some(tmp.path().to_string_lossy().into_owned())
    );

    // Doc content: same cells, execution_count cleared on code cells.
    let clone_cells = clone_room.doc.read().await.get_cells();
    assert_eq!(clone_cells.len(), 3);
    let cell_ids: Vec<&str> = clone_cells.iter().map(|c| c.id.as_str()).collect();
    assert!(cell_ids.contains(&"code-1"));
    assert!(cell_ids.contains(&"md-1"));
    assert!(cell_ids.contains(&"raw-1"));
    let code_cell = clone_cells.iter().find(|c| c.id == "code-1").unwrap();
    assert_eq!(code_cell.execution_count, "null");

    // Metadata: fresh env_id.
    let clone_snap = clone_room
        .doc
        .read()
        .await
        .get_metadata_snapshot()
        .expect("clone should have metadata");
    assert!(clone_snap.runt.env_id.is_some());
    assert_ne!(clone_snap.runt.env_id.as_deref(), Some("source-env-id"));

    // Attachments copied at the CRDT level for save/export.
    let clone_attachments = clone_room
        .doc
        .read()
        .await
        .get_cell_attachments("md-1")
        .expect("markdown cell should carry attachment refs");
    assert_eq!(
        clone_attachments
            .get("image.png")
            .and_then(|bundle| bundle.get("image/png"))
            .map(|attachment_ref| attachment_ref.blob_hash.as_str()),
        Some(attachment_hash.as_str())
    );
    let clone_raw_attachments = clone_room
        .doc
        .read()
        .await
        .get_cell_attachments("raw-1")
        .expect("raw cell should carry attachment refs");
    assert_eq!(
        clone_raw_attachments
            .get("payload.json")
            .and_then(|bundle| bundle.get("application/json"))
            .map(|attachment_ref| attachment_ref.blob_hash.as_str()),
        Some(raw_attachment_hash.as_str())
    );

    // resolved_assets copied on the markdown cell (CRDT-level asset map,
    // used by frontend rendering of cell.resolvedAssets).
    let clone_md_assets = clone_room
        .doc
        .read()
        .await
        .get_cell_resolved_assets("md-1")
        .expect("markdown cell should carry resolved_assets map");
    assert_eq!(
        clone_md_assets
            .get("attachment:image.png")
            .map(String::as_str),
        Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
    );
}

#[tokio::test]
async fn test_clone_as_ephemeral_rejects_unknown_source() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (rooms, docs_dir, blob_store) = clone_test_scaffolding(&tmp);

    let bogus = Uuid::new_v4().to_string();
    let response =
        crate::requests::clone_notebook::handle_inner(&rooms, &docs_dir, blob_store, bogus.clone())
            .await;

    match response {
        NotebookResponse::Error { error } => {
            assert!(
                error.contains("not found") || error.contains(&bogus),
                "Expected 'not found' in error, got: {error}"
            );
        }
        other => panic!("Expected Error, got {other:?}"),
    }
}

#[tokio::test]
async fn test_clone_as_ephemeral_rejects_invalid_uuid() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (rooms, docs_dir, blob_store) = clone_test_scaffolding(&tmp);

    let response = crate::requests::clone_notebook::handle_inner(
        &rooms,
        &docs_dir,
        blob_store,
        "not-a-uuid".to_string(),
    )
    .await;

    match response {
        NotebookResponse::Error { error } => {
            assert!(
                error.contains("Invalid"),
                "Expected 'Invalid' in error, got: {error}"
            );
        }
        other => panic!("Expected Error, got {other:?}"),
    }
}

#[tokio::test]
async fn test_save_round_trips_unknown_top_level_metadata() {
    // Regression test for Codex F3 on PR #2192: unknown top-level
    // metadata keys (jupytext, colab, etc.) must survive save.
    let tmp = tempfile::TempDir::new().unwrap();
    let notebook_path = tmp.path().join("with-jupytext.ipynb");

    std::fs::write(
        &notebook_path,
        r#"{
 "cells": [],
 "metadata": {
  "kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
  "language_info": {"name": "python", "version": "3.11.5"},
  "jupytext": {"paired_paths": [["x.py", "py:percent"]]},
  "colab": {"kernel": {"name": "python3"}}
 },
 "nbformat": 4,
 "nbformat_minor": 5
}"#,
    )
    .unwrap();

    let (room, _guard, settled) = materialized_room_from_disk(&tmp, &notebook_path).await;
    assert_source_ready(&settled);

    save_notebook_to_disk(&room, None).await.unwrap();

    let written = std::fs::read_to_string(&notebook_path).unwrap();
    let nb: serde_json::Value = serde_json::from_str(&written).unwrap();

    assert_eq!(
        nb["metadata"]["jupytext"],
        serde_json::json!({"paired_paths": [["x.py", "py:percent"]]}),
        "jupytext key must survive save round-trip"
    );
    assert_eq!(
        nb["metadata"]["colab"],
        serde_json::json!({"kernel": {"name": "python3"}}),
        "colab key must survive save round-trip"
    );
}

#[tokio::test]
async fn test_save_does_not_stamp_synthetic_runt_on_vanilla_notebook() {
    // Vanilla Jupyter notebook: no metadata.runt. Save must NOT add
    // `runt: { schema_version: "1" }` — that would churn every
    // git-tracked Jupyter notebook the user opens.
    let tmp = tempfile::TempDir::new().unwrap();
    let notebook_path = tmp.path().join("vanilla.ipynb");

    std::fs::write(
        &notebook_path,
        r#"{
 "cells": [],
 "metadata": {
  "kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
  "language_info": {"name": "python", "version": "3.11.5"}
 },
 "nbformat": 4,
 "nbformat_minor": 5
}"#,
    )
    .unwrap();

    let (room, _guard, settled) = materialized_room_from_disk(&tmp, &notebook_path).await;
    assert_source_ready(&settled);

    save_notebook_to_disk(&room, None).await.unwrap();

    let written = std::fs::read_to_string(&notebook_path).unwrap();
    let nb: serde_json::Value = serde_json::from_str(&written).unwrap();

    assert!(
        !nb["metadata"].as_object().unwrap().contains_key("runt"),
        "vanilla notebook save must not stamp metadata.runt, got: {}",
        nb["metadata"]
    );
}

#[tokio::test]
async fn test_clone_as_ephemeral_carries_unknown_metadata_extras() {
    // Codex F3 on PR #2192: clone must preserve unknown top-level
    // metadata keys from source (jupytext, colab, vscode, etc.).
    let tmp = tempfile::TempDir::new().unwrap();
    let (rooms, docs_dir, blob_store) = clone_test_scaffolding(&tmp);

    let source_uuid = Uuid::new_v4();
    let (source_room, _source_guard) = get_or_create_room(
        &rooms,
        source_uuid,
        RoomCreationOptions {
            path: Some(tmp.path().join("source.ipynb")),
            initial_load_execution_store_dir: None,
            docs_dir: &docs_dir,
            blob_store: blob_store.clone(),
            ephemeral: false,
            trusted_packages: test_trusted_packages(),
        },
    )
    .await;

    // Seed source doc with kernelspec (so snapshot is Some) plus
    // unknown extras.
    {
        let mut doc = source_room.doc.write().await;
        let mut snap = snapshot_empty();
        snap.kernelspec = Some(notebook_doc::metadata::KernelspecSnapshot {
            name: "python3".to_string(),
            display_name: "Python 3".to_string(),
            language: Some("python".to_string()),
            extras: std::collections::BTreeMap::new(),
        });
        snap.extras.insert(
            "jupytext".to_string(),
            serde_json::json!({"paired_paths": [["x.py", "py:percent"]]}),
        );
        snap.extras.insert(
            "vscode".to_string(),
            serde_json::json!({"extension": {"id": "ms-python.python"}}),
        );
        doc.set_metadata_snapshot(&snap).unwrap();
    }

    let response = crate::requests::clone_notebook::handle_inner(
        &rooms,
        &docs_dir,
        blob_store.clone(),
        source_uuid.to_string(),
    )
    .await;

    let clone_id = match response {
        NotebookResponse::NotebookCloned { notebook_id, .. } => notebook_id,
        other => panic!("Expected NotebookCloned, got {other:?}"),
    };
    let clone_uuid = Uuid::parse_str(&clone_id).unwrap();
    let clone_room = rooms
        .peek_uuid(clone_uuid)
        .await
        .expect("clone room should be registered");

    let clone_snap = clone_room
        .doc
        .read()
        .await
        .get_metadata_snapshot()
        .expect("clone has metadata");
    assert!(
        clone_snap.extras.contains_key("jupytext"),
        "jupytext must survive clone; extras: {:?}",
        clone_snap.extras.keys().collect::<Vec<_>>()
    );
    assert!(
        clone_snap.extras.contains_key("vscode"),
        "vscode must survive clone; extras: {:?}",
        clone_snap.extras.keys().collect::<Vec<_>>()
    );
    assert_eq!(
        clone_snap.extras["jupytext"],
        serde_json::json!({"paired_paths": [["x.py", "py:percent"]]})
    );
}

#[test]
fn test_file_watcher_replacement_drops_stale_top_level_metadata() {
    // Codex P2#2 on PR #2198: the file-watcher path calls
    // set_metadata_snapshot with whatever the new on-disk file
    // parsed to. When a user deletes an unknown top-level key (say,
    // `colab`) from the .ipynb, the daemon must converge — not keep
    // the stale Automerge map around forever. Both states go through
    // the seam every loader and the watcher share: the notebook parse
    // plus `set_metadata_snapshot`.
    let mut doc = notebook_doc::NotebookDoc::new("watcher-reload");

    // First state: both jupytext and colab present.
    let first_json = serde_json::json!({
        "cells": [],
        "metadata": {
            "kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
            "language_info": {"name": "python", "version": "3.11.5"},
            "jupytext": {"paired_paths": [["x.py", "py:percent"]]},
            "colab": {"kernel": {"name": "python3"}}
        },
        "nbformat": 4,
        "nbformat_minor": 5
    });
    let first_meta =
        parse_notebook_jiter_for_notebook(&serde_json::to_vec(&first_json).unwrap(), Uuid::nil())
            .unwrap()
            .metadata
            .expect("metadata present");
    doc.set_metadata_snapshot(&first_meta).unwrap();

    let first = doc.get_metadata_snapshot().unwrap();
    assert!(first.extras.contains_key("jupytext"));
    assert!(first.extras.contains_key("colab"));

    // Second state: colab removed, jupytext kept. This mirrors the watcher
    // path exactly: the shared notebook parse + set_metadata_snapshot.
    let new_json = serde_json::json!({
        "cells": [],
        "metadata": {
            "kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
            "language_info": {"name": "python", "version": "3.11.5"},
            "jupytext": {"paired_paths": [["x.py", "py:percent"]]}
        },
        "nbformat": 4,
        "nbformat_minor": 5
    });
    let new_meta =
        parse_notebook_jiter_for_notebook(&serde_json::to_vec(&new_json).unwrap(), Uuid::nil())
            .unwrap()
            .metadata
            .expect("metadata present");
    doc.set_metadata_snapshot(&new_meta).unwrap();

    let after = doc.get_metadata_snapshot().unwrap();
    assert!(
        after.extras.contains_key("jupytext"),
        "jupytext must still be present after replace"
    );
    assert!(
        !after.extras.contains_key("colab"),
        "colab must be deleted from doc after replacement snapshot omits it; extras={:?}",
        after.extras.keys().collect::<Vec<_>>()
    );
}

/// The daemon now arms a `notify` watcher on the detected project file
/// during `refresh_project_context_async` and re-parses whenever it
/// fires. External edits (git pull, user editing pyproject.toml in
/// another editor) should flow into `RuntimeStateDoc.project_context`
/// without any client round-trip.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_file_watcher_refreshes_context_on_external_edit() {
    use runtime_doc::ProjectContext;
    use tokio::time::{sleep, Duration};

    let tmp = tempfile::TempDir::new().unwrap();
    let notebook_path = tmp.path().join("demo.ipynb");
    let pyproject_path = tmp.path().join("pyproject.toml");
    std::fs::write(&notebook_path, "{}").unwrap();
    std::fs::write(
        &pyproject_path,
        "[project]\nname = \"demo\"\ndependencies = [\"pandas\"]\n",
    )
    .unwrap();

    let (room, _) = test_room_with_path(&tmp, "demo.ipynb");
    let room = std::sync::Arc::new(room);

    // Initial refresh arms the watcher and writes the first context.
    super::project_context::refresh_project_context_async(&room, Some(notebook_path.as_path()))
        .await;

    let first = room.state.with_doc(|sd| Ok(sd.project_context())).unwrap();
    let ProjectContext::Detected { parsed, .. } = first else {
        panic!("expected Detected for initial pyproject");
    };
    assert_eq!(parsed.dependencies, vec!["pandas".to_string()]);

    // Sanity: watcher state is armed.
    assert!(room.file_binding.has_project_file_watcher_for_test().await);

    // External edit: add a dep. `refresh_project_context_async`
    // already awaited the watcher's ready signal before returning, so
    // the subscription is live — no pre-write settle needed. `notify`
    // picks up the write, debounces for 500ms, then fires. We poll the
    // CRDT up to 15s for the new state to appear so the test stays
    // robust across CI jitter.
    std::fs::write(
        &pyproject_path,
        "[project]\nname = \"demo\"\ndependencies = [\"pandas\", \"numpy\"]\n",
    )
    .unwrap();

    let mut observed: Option<ProjectContext> = None;
    for _ in 0..150 {
        sleep(Duration::from_millis(100)).await;
        let ctx = room.state.with_doc(|sd| Ok(sd.project_context())).unwrap();
        if let ProjectContext::Detected { ref parsed, .. } = ctx {
            if parsed.dependencies.iter().any(|d| d == "numpy") {
                observed = Some(ctx);
                break;
            }
        }
    }

    let observed = observed.expect("watcher didn't refresh within 5s");
    let ProjectContext::Detected { parsed, .. } = observed else {
        panic!("expected Detected after external edit");
    };
    assert_eq!(
        parsed.dependencies,
        vec!["pandas".to_string(), "numpy".to_string()]
    );

    // Tear down the watcher so the temp dir can drop cleanly.
    room.file_binding.shutdown_project_file_watcher().await;
}

/// Kernel launch can fail before the kernel ever connects to the
/// daemon — e.g. the subprocess exits with status 1 because a required
/// module isn't installed. The failure arms in
/// `notebook_sync_server::metadata` and `requests::launch_kernel` now
/// use `reset_starting_state_with_outcome(..., ResetOutcome::Error)`
/// so the CRDT carries `Error + error_details` instead of quietly
/// reverting to `NotStarted`. This covers the wiring.
#[tokio::test]
async fn reset_starting_state_error_variant_writes_details() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "launch-failure.ipynb");

    // Seed a non-Error lifecycle so the transition under test is observable.
    room.state
        .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Launching))
        .unwrap();

    let stderr_tail = "Kernel process exited immediately: status 1\nstderr tail:\n/path/to/python: No module named foo\n";
    reset_starting_state_with_outcome(
        &room,
        None,
        ResetOutcome::Error {
            reason: None,
            details: stderr_tail,
        },
    )
    .await;

    let state = room.state.with_doc(|sd| Ok(sd.read_state())).unwrap();
    assert!(
        matches!(state.kernel.lifecycle, RuntimeLifecycle::Error),
        "expected Error lifecycle, got {:?}",
        state.kernel.lifecycle
    );
    assert_eq!(state.kernel.error_details.as_deref(), Some(stderr_tail));
    // No typed reason (generic launch error); `error_reason` is empty
    // but present so readers can skip typed-reason branches cleanly.
    assert_eq!(state.kernel.error_reason.as_deref(), Some(""));
}

#[tokio::test]
async fn publish_environment_launch_error_writes_kernel_error_and_clears_env_progress() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, _) = test_room_with_path(&tmp, "env-prepare-failure.ipynb");
    let details = "Failed to prepare conda inline environment: no candidates for pywidget";
    room.state
        .with_doc(|sd| {
            sd.set_env_progress(
                "conda",
                &serde_json::json!({ "phase": "solving", "spec_count": 5 }),
            )?;
            // A cell was queued against the launch that is about to fail.
            sd.create_execution("exec-queued-1")
        })
        .unwrap();

    publish_environment_launch_error(
        &room,
        "conda:inline",
        Some(KernelErrorReason::EnvironmentPrepareFailed),
        details,
    );

    let state = room.state.read(|sd| sd.read_state()).unwrap();
    assert!(
        matches!(state.kernel.lifecycle, RuntimeLifecycle::Error),
        "expected Error lifecycle, got {:?}",
        state.kernel.lifecycle
    );
    assert_eq!(
        state.kernel.error_reason.as_deref(),
        Some("environment_prepare_failed")
    );
    assert_eq!(state.kernel.error_details.as_deref(), Some(details));
    assert_eq!(state.kernel.language, "python");
    assert_eq!(state.kernel.env_source, "conda:inline");
    assert_eq!(state.env.progress, None);

    // The queued cell can never run now, so it must resolve instead of
    // spinning on "queued" forever (#3947).
    assert!(
        room.state
            .read(|sd| sd.get_queued_executions())
            .unwrap()
            .is_empty(),
        "no executions should remain queued after a terminal launch error"
    );
    let queued_cell = room
        .state
        .read(|sd| sd.get_execution("exec-queued-1"))
        .unwrap()
        .expect("exec-queued-1 exists");
    assert_eq!(queued_cell.status, "cancelled");
}

#[test]
fn sync_environment_failure_contract_distinguishes_agent_error_from_transport_error() {
    match sync_environment_agent_error_response("No candidates found".to_string()) {
        NotebookResponse::SyncEnvironmentFailed {
            error,
            needs_restart,
        } => {
            assert_eq!(error, "No candidates found");
            assert!(
                !needs_restart,
                "runtime agent already published env progress"
            );
        }
        other => panic!("unexpected response: {other:?}"),
    }

    match sync_environment_agent_communication_error_response(
        "Agent communication error: channel closed".to_string(),
    ) {
        NotebookResponse::SyncEnvironmentFailed {
            error,
            needs_restart,
        } => {
            assert_eq!(error, "Agent communication error: channel closed");
            assert!(needs_restart, "transport failure requires a kernel restart");
        }
        other => panic!("unexpected response: {other:?}"),
    }
}

// ── Regression tests for #2351: outputs not serialized to notebook ───

/// When a cell is re-queued for execution, `set_execution_id` rewrites the
/// cell's pointer to the NEW execution_id before the kernel produces any
/// outputs. If save fires in this window, the previous outputs must not be
/// clobbered with empty `[]`. Save falls back to the most recent terminal
/// execution for the cell.
#[tokio::test]
async fn test_save_preserves_outputs_when_execution_in_flight() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "in_flight.ipynb");

    let old_eid = "exec-old-done";
    let new_eid = "exec-new-queued";

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "print('hello')").unwrap();
    }
    room.state
        .with_doc(|sd| {
            let output = serde_json::json!({
                "output_type": "stream",
                "output_id": "old-output-1",
                "name": "stdout",
                "text": ["hello\n"]
            });
            sd.create_execution_with_source(old_eid, "print('hello')", 1)?;
            sd.set_outputs(old_eid, &[output])?;
            sd.set_execution_count(old_eid, 1)?;
            sd.set_execution_done(old_eid, true)?;
            Ok(())
        })
        .unwrap();
    {
        let mut doc = room.doc.write().await;
        doc.set_execution_id("cell1", Some(old_eid)).unwrap();
    }

    // Simulate `queue_cell_if_current`: remember the previous visible
    // execution, then rewrite cell.execution_id to a new queued execution
    // that has not produced outputs yet.
    room.persistence
        .remember_previous_visible_execution("cell1", old_eid);
    room.state
        .with_doc(|sd| {
            sd.create_execution_with_source(new_eid, "print('hello')", 2)?;
            sd.set_execution_running(new_eid)?;
            sd.set_execution_count(new_eid, 2)?;
            Ok(())
        })
        .unwrap();
    {
        let mut doc = room.doc.write().await;
        doc.set_execution_id("cell1", Some(new_eid)).unwrap();
    }

    save_notebook_to_disk(&room, None).await.unwrap();

    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let nb: serde_json::Value = serde_json::from_str(&content).unwrap();
    let cell = &nb["cells"][0];
    let outputs = cell["outputs"].as_array().expect("outputs array");
    assert_eq!(
        outputs.len(),
        1,
        "previous outputs must be preserved during in-flight execution; got: {}",
        serde_json::to_string_pretty(cell).unwrap()
    );
    assert_eq!(outputs[0]["name"], "stdout");
    assert_eq!(
        cell["execution_count"], 1,
        "previous execution_count preserved when current execution has no count yet"
    );
}

/// When a cell's `execution_id` is `None` (cleared via local Automerge mutation), save
/// must write empty outputs. The clear is intentional - we don't fall back
/// to historical executions.
#[tokio::test]
async fn test_save_writes_empty_outputs_when_cell_execution_id_cleared() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "cleared.ipynb");

    let eid = "exec-done";
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "print('hello')").unwrap();
    }
    room.state
        .with_doc(|sd| {
            let output = serde_json::json!({
                "output_type": "stream",
                "output_id": "clear-output-1",
                "name": "stdout",
                "text": ["hello\n"]
            });
            sd.create_execution_with_source(eid, "print('hello')", 1)?;
            sd.set_outputs(eid, &[output])?;
            sd.set_execution_count(eid, 1)?;
            sd.set_execution_done(eid, true)?;
            Ok(())
        })
        .unwrap();
    {
        let mut doc = room.doc.write().await;
        doc.set_execution_id("cell1", Some(eid)).unwrap();
        doc.set_execution_id("cell1", None).unwrap();
    }

    save_notebook_to_disk(&room, None).await.unwrap();

    let content = std::fs::read_to_string(&notebook_path).unwrap();
    let nb: serde_json::Value = serde_json::from_str(&content).unwrap();
    let outputs = nb["cells"][0]["outputs"].as_array().expect("outputs array");
    assert!(
        outputs.is_empty(),
        "cleared cell must have empty outputs; got: {}",
        serde_json::to_string_pretty(&nb["cells"][0]).unwrap()
    );
}

/// RuntimeStateDoc mutations only wake autosave through the explicit
/// file-dirty channel. Autosave's own `last_saved` write must not trigger a
/// follow-on autosave loop.
#[tokio::test(start_paused = true)]
async fn test_autosave_fires_on_runtime_file_dirty_without_self_loop() {
    use std::time::Duration;

    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();

    let room = Arc::new(NotebookRoom::new_fresh(
        Uuid::new_v4(),
        None,
        &docs_dir,
        blob_store,
        false,
    ));

    let eid = "exec-1";
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell1", "code").unwrap();
        doc.update_source("cell1", "print('hi')").unwrap();
        doc.set_execution_id("cell1", Some(eid)).unwrap();
    }
    room.state
        .with_doc(|sd| {
            sd.create_execution_with_source(eid, "print('hi')", 1)?;
            Ok(())
        })
        .unwrap();

    let save_path = tmp.path().join("auto.ipynb");
    let written = save_notebook_to_disk(&room, Some(save_path.to_str().unwrap()))
        .await
        .unwrap();
    let canonical = tokio::fs::canonicalize(&written)
        .await
        .unwrap_or_else(|_| PathBuf::from(written.path()));
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    try_claim_path(&rooms, &canonical, room.id)
        .await
        .expect("path claim should succeed");
    finalize_untitled_promotion(&room, canonical).await.unwrap();

    let initial = tokio::fs::read_to_string(&save_path).await.unwrap();
    let initial_nb: serde_json::Value = serde_json::from_str(&initial).unwrap();
    assert!(
        initial_nb["cells"][0]["outputs"]
            .as_array()
            .map(|o| o.is_empty())
            .unwrap_or(true),
        "baseline file must start with empty outputs"
    );

    room.state
        .with_doc(|sd| {
            let output = serde_json::json!({
                "output_type": "stream",
                "output_id": "autosave-output-1",
                "name": "stdout",
                "text": ["hi\n"]
            });
            sd.append_output(eid, &output)?;
            sd.set_execution_count(eid, 1)?;
            sd.set_execution_done(eid, true)?;
            Ok(())
        })
        .unwrap();

    let _ = room.broadcasts.file_dirty_tx.send(());

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let first_last_saved = loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let content = tokio::fs::read_to_string(&save_path).await.unwrap();
        let nb: serde_json::Value = serde_json::from_str(&content).unwrap();
        let outputs_saved = nb["cells"][0]["outputs"]
            .as_array()
            .is_some_and(|outputs| !outputs.is_empty());
        let last_saved = room
            .state
            .read(|sd| sd.read_state().last_saved)
            .unwrap_or_default();
        if outputs_saved {
            assert_eq!(nb["cells"][0]["outputs"][0]["name"], "stdout");
            if let Some(last_saved) = last_saved {
                break last_saved;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Timed out waiting for autosave to flush state-change outputs; got: {}",
            serde_json::to_string_pretty(&nb).unwrap()
        );
    };

    tokio::time::sleep(Duration::from_secs(5)).await;
    let second_last_saved = room
        .state
        .read(|sd| sd.read_state().last_saved)
        .unwrap_or_default()
        .expect("autosave should have stamped last_saved");
    assert_eq!(
        first_last_saved, second_last_saved,
        "last_saved changed without a new file-dirty or NotebookDoc signal"
    );
}

#[tokio::test(start_paused = true)]
async fn test_autosave_shutdown_flushes_pending_doc_change() {
    use std::time::Duration;

    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();

    let room = Arc::new(NotebookRoom::new_fresh(
        Uuid::new_v4(),
        None,
        &docs_dir,
        blob_store,
        false,
    ));

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source("cell-1", "before = 1").unwrap();
    }

    let save_path = tmp.path().join("auto.ipynb");
    let written = save_notebook_to_disk(&room, Some(save_path.to_str().unwrap()))
        .await
        .unwrap();
    let canonical = tokio::fs::canonicalize(&written)
        .await
        .unwrap_or_else(|_| PathBuf::from(written.path()));
    let rooms: NotebookRooms = Arc::new(RoomRegistry::new());
    try_claim_path(&rooms, &canonical, room.id)
        .await
        .expect("path claim should succeed");
    finalize_untitled_promotion(&room, canonical.clone())
        .await
        .unwrap();

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(1, "cell-2", "code").unwrap();
        doc.update_source("cell-2", "after = 2").unwrap();
    }
    commit_test_room_doc(&room).await;
    let _ = room.broadcasts.changed_tx.send(());

    assert!(
        shutdown_autosave_debouncer(&room, &canonical.to_string_lossy(), Duration::from_secs(5))
            .await,
        "autosave shutdown should complete its final save"
    );

    let content = tokio::fs::read_to_string(&save_path).await.unwrap();
    let nb: serde_json::Value = serde_json::from_str(&content).unwrap();
    let cells = nb["cells"].as_array().expect("cells array");
    assert_eq!(
        cells.len(),
        2,
        "shutdown final save should persist the pending doc edit"
    );
    let sources: Vec<String> = cells
        .iter()
        .map(|c| match &c["source"] {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(arr) => {
                arr.iter().filter_map(|v| v.as_str()).collect::<String>()
            }
            other => panic!("unexpected source shape: {other:?}"),
        })
        .collect();
    assert!(
        sources.iter().any(|source| source == "after = 2"),
        "shutdown final save should include the edit made inside the debounce window; got: {sources:?}"
    );
    assert!(
        !room.file_binding.has_autosave_shutdown_tx_for_test().await,
        "shutdown should consume the autosave lifecycle handle"
    );
}

#[tokio::test]
async fn test_install_autosave_shutdown_tx_signals_replaced_handle() {
    use std::time::Duration;

    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();

    let room = NotebookRoom::new_fresh(Uuid::new_v4(), None, &docs_dir, blob_store, false);

    let (old_tx, mut old_rx) = mpsc::unbounded_channel::<AutosaveShutdownRequest>();
    room.file_binding.install_autosave_shutdown_tx(old_tx).await;

    let (new_tx, mut new_rx) = mpsc::unbounded_channel::<AutosaveShutdownRequest>();
    let replaced_ack_task = tokio::spawn(async move {
        let ack_tx = old_rx
            .recv()
            .await
            .expect("replacing the handle should signal the old task");
        let _ = ack_tx.send(true);
    });
    room.file_binding.install_autosave_shutdown_tx(new_tx).await;
    replaced_ack_task.await.unwrap();
    assert!(
        new_rx.try_recv().is_err(),
        "new shutdown handle should remain installed until explicit shutdown"
    );

    let ack_task = tokio::spawn(async move {
        let ack_tx = new_rx
            .recv()
            .await
            .expect("explicit shutdown should use the new handle");
        let _ = ack_tx.send(true);
    });
    assert!(
        shutdown_autosave_debouncer(&room, "fake.ipynb", Duration::from_millis(500)).await,
        "explicit shutdown should receive ack from the new handle"
    );
    ack_task.await.unwrap();
}

#[tokio::test]
async fn test_save_as_rebind_replaces_file_lifecycle_and_runtime_path() {
    use std::time::Duration;

    let tmp = tempfile::TempDir::new().unwrap();
    let (room, old_path) = test_room_with_path(&tmp, "old.ipynb");
    let room = Arc::new(room);
    let new_path = tmp.path().join("new.ipynb");
    std::fs::write(&old_path, "{}").unwrap();
    std::fs::write(&new_path, "{}").unwrap();

    let (old_watcher_tx, old_watcher_rx) = oneshot::channel::<()>();
    room.file_binding
        .install_notebook_watcher_shutdown_tx(old_watcher_tx)
        .await;

    let (old_autosave_tx, mut old_autosave_rx) =
        mpsc::unbounded_channel::<AutosaveShutdownRequest>();
    room.file_binding
        .install_autosave_shutdown_tx(old_autosave_tx)
        .await;
    let autosave_ack_task = tokio::spawn(async move {
        let ack_tx = old_autosave_rx
            .recv()
            .await
            .expect("rebind should signal the old autosave task");
        let _ = ack_tx.send(true);
    });

    NotebookFileBinding::rebind_after_save_as(&room, new_path.clone()).await;

    tokio::time::timeout(Duration::from_secs(1), old_watcher_rx)
        .await
        .expect("rebind should signal old notebook watcher")
        .expect("old notebook watcher sender should not be dropped");
    autosave_ack_task.await.unwrap();

    assert_eq!(
        room.file_binding.path().await.as_deref(),
        Some(new_path.as_path())
    );
    let runtime_path = room
        .state
        .read(|sd| sd.read_state().path)
        .expect("runtime state should be readable");
    let expected_runtime_path = new_path.to_string_lossy().into_owned();
    assert_eq!(
        runtime_path.as_deref(),
        Some(expected_runtime_path.as_str())
    );

    room.file_binding.shutdown_notebook_watcher().await;
    assert!(
        shutdown_autosave_debouncer(&room, &new_path.to_string_lossy(), Duration::from_secs(1))
            .await,
        "new autosave task should shut down cleanly"
    );
}

#[tokio::test]
async fn test_autosave_shutdown_during_loading_returns_false_without_write() {
    use std::time::Duration;

    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let docs_dir = tmp.path().join("docs");
    std::fs::create_dir_all(&docs_dir).unwrap();

    let room = Arc::new(NotebookRoom::new_fresh(
        Uuid::new_v4(),
        None,
        &docs_dir,
        blob_store,
        false,
    ));

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-1", "code").unwrap();
        doc.update_source("cell-1", "before = 1").unwrap();
    }

    let save_path = tmp.path().join("loading.ipynb");
    let written = save_notebook_to_disk(&room, Some(save_path.to_str().unwrap()))
        .await
        .unwrap();
    let canonical = tokio::fs::canonicalize(&written)
        .await
        .unwrap_or_else(|_| PathBuf::from(written.path()));
    room.file_binding
        .set_path_for_test(Some(canonical.clone()))
        .await;
    let shutdown_tx =
        spawn_autosave_debouncer(canonical.to_string_lossy().into_owned(), Arc::clone(&room));
    room.file_binding
        .install_autosave_shutdown_tx(shutdown_tx)
        .await;

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(1, "cell-2", "code").unwrap();
        doc.update_source("cell-2", "after = 2").unwrap();
    }
    let _ = room.broadcasts.changed_tx.send(());

    assert!(room.try_start_loading(), "test should mark room as loading");
    assert!(
        !shutdown_autosave_debouncer(&room, &canonical.to_string_lossy(), Duration::from_secs(5))
            .await,
        "shutdown while loading should report that no final save happened"
    );
    room.finish_loading();

    let content = tokio::fs::read_to_string(&save_path).await.unwrap();
    let nb: serde_json::Value = serde_json::from_str(&content).unwrap();
    let cells = nb["cells"].as_array().expect("cells array");
    assert_eq!(
        cells.len(),
        1,
        "shutdown while loading should not write pending edits to disk"
    );
}

// ── finalize_trust_status: allowlist-driven trust resolution ──

#[test]
fn finalize_trust_status_no_deps_returns_no_dependencies() {
    let tmp = tempfile::TempDir::new().unwrap();
    let store =
        crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
            .unwrap();
    let mut info = runt_trust::extract_trust_info(&std::collections::HashMap::new());
    assert_eq!(info.status, runt_trust::TrustStatus::NoDependencies);
    info.status = runt_trust::TrustStatus::NoDependencies; // ensure reset

    let status = super::metadata::finalize_trust_status(&info, &store);
    assert_eq!(status, runt_trust::TrustStatus::NoDependencies);
}

#[test]
fn finalize_trust_status_all_deps_approved_returns_trusted() {
    let tmp = tempfile::TempDir::new().unwrap();
    let store =
        crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
            .unwrap();

    let metadata = serde_json::json!({
        "runt": { "uv": { "dependencies": ["pandas", "numpy"] } }
    });
    let mut hashmap = std::collections::HashMap::new();
    hashmap.insert("runt".to_string(), metadata["runt"].clone());
    let info = runt_trust::extract_trust_info(&hashmap);
    assert_eq!(info.status, runt_trust::TrustStatus::Untrusted);

    store.add_from_info(&info, "test").unwrap();

    let status = super::metadata::finalize_trust_status(&info, &store);
    assert_eq!(status, runt_trust::TrustStatus::Trusted);
}

#[test]
fn finalize_trust_status_missing_dep_returns_untrusted() {
    let tmp = tempfile::TempDir::new().unwrap();
    let store =
        crate::trusted_packages::TrustedPackageStore::open(tmp.path().join("trusted.sqlite"))
            .unwrap();

    // Approve only pandas, then ask about pandas + numpy.
    let approved_only = runt_trust::TrustInfo {
        status: runt_trust::TrustStatus::Untrusted,
        uv_dependencies: vec!["pandas".to_string()],
        approved_uv_dependencies: vec![],
        conda_dependencies: vec![],
        approved_conda_dependencies: vec![],
        conda_channels: vec![],
        approved_conda_channels: vec![],
        pixi_dependencies: vec![],
        approved_pixi_dependencies: vec![],
        pixi_pypi_dependencies: vec![],
        approved_pixi_pypi_dependencies: vec![],
        pixi_channels: vec![],
        approved_pixi_channels: vec![],
    };
    store.add_from_info(&approved_only, "test").unwrap();

    let mut hashmap = std::collections::HashMap::new();
    hashmap.insert(
        "runt".to_string(),
        serde_json::json!({ "uv": { "dependencies": ["pandas", "numpy"] } }),
    );
    let info = runt_trust::extract_trust_info(&hashmap);

    let status = super::metadata::finalize_trust_status(&info, &store);
    assert_eq!(status, runt_trust::TrustStatus::Untrusted);
}

#[test]
fn finalize_trust_status_unavailable_store_is_untrusted() {
    // Fail-closed: if the allowlist can't tell us, don't grant trust.
    let store = crate::trusted_packages::TrustedPackageStore::unavailable("test");

    let mut hashmap = std::collections::HashMap::new();
    hashmap.insert(
        "runt".to_string(),
        serde_json::json!({ "uv": { "dependencies": ["pandas"] } }),
    );
    let info = runt_trust::extract_trust_info(&hashmap);

    let status = super::metadata::finalize_trust_status(&info, &store);
    assert_eq!(status, runt_trust::TrustStatus::Untrusted);
}

// ── Autosave zeroing guard ─────────────────────────────────────────────
//
// A failed/incomplete streaming load empties the room doc (peer_session
// clears all cells on load failure). Autosave and kernel-teardown then call
// save_notebook_to_disk(.., None), which would overwrite a populated .ipynb
// with zero cells. The guard rejects that write without reporting success.

/// Write a populated two-cell .ipynb to disk.
async fn write_two_cell_notebook(path: &Path) {
    tokio::fs::write(
        path,
        r##"{
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {},
            "cells": [
                {
                    "id": "cell-a",
                    "cell_type": "code",
                    "metadata": {},
                    "source": "a = 1",
                    "execution_count": null,
                    "outputs": []
                },
                {
                    "id": "cell-b",
                    "cell_type": "markdown",
                    "metadata": {},
                    "source": "# heading"
                }
            ]
        }"##,
    )
    .await
    .unwrap();
}

fn disk_cell_count(path: &Path) -> usize {
    let content = std::fs::read_to_string(path).unwrap();
    let value: serde_json::Value = serde_json::from_str(&content).unwrap();
    value
        .get("cells")
        .and_then(|cells| cells.as_array())
        .map(|cells| cells.len())
        .unwrap_or(0)
}

/// The production zeroing case: a streaming load fails, the room doc is
/// emptied (clear_all_cells + finish_loading), and an autosave fires with
/// target_path = None. The on-disk notebook must be left intact.
#[tokio::test]
async fn autosave_skips_zeroing_write_after_failed_load() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "failed_load.ipynb");
    write_two_cell_notebook(&notebook_path).await;

    // Reproduce the post-failed-load room state: doc emptied, loading done,
    // failed-load hazard flagged (peer_session does this in the Err branch).
    {
        let mut doc = room.doc.write().await;
        doc.clear_all_cells().unwrap();
        assert_eq!(doc.cell_count(), 0);
    }
    room.mark_load_failed();
    room.finish_loading();

    // Autosave / kernel-teardown path.
    let error = save_notebook_to_disk(&room, None)
        .await
        .expect_err("failed-load autosave must not report success without writing");
    assert!(matches!(error, SaveError::Retryable(_)));

    assert_eq!(
        disk_cell_count(&notebook_path),
        2,
        "empty doc must not overwrite the populated .ipynb"
    );
}

#[tokio::test]
async fn explicit_save_after_failed_load_returns_error_instead_of_notebook_saved() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "failed_explicit.ipynb");
    write_two_cell_notebook(&notebook_path).await;
    let room = Arc::new(room);
    room.mark_load_failed();
    let daemon = crate::daemon::Daemon::new_for_test(test_daemon_config(&tmp)).unwrap();

    let response = crate::requests::save_notebook::handle(&room, &daemon, false, None).await;
    match response {
        crate::protocol::NotebookResponse::NotebookSaveBlocked {
            reason: notebook_protocol::protocol::SaveBlockedReason::Io { message },
            ..
        } => assert!(message.contains("initial file load failed")),
        other => panic!("failed-load save must return NotebookSaveBlocked, got {other:?}"),
    }
    assert_eq!(disk_cell_count(&notebook_path), 2);
}

#[tokio::test(start_paused = true)]
async fn failed_load_autosave_does_not_stamp_last_saved() {
    use std::time::Duration;

    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "failed_autosave.ipynb");
    write_two_cell_notebook(&notebook_path).await;
    let room = Arc::new(room);
    room.mark_load_failed();

    let shutdown = spawn_autosave_debouncer_with_config(
        notebook_path.to_string_lossy().into_owned(),
        Arc::clone(&room),
        AutosaveDebouncerConfig {
            debounce_ms: 10,
            max_interval_ms: 100,
            check_interval_ms: 1,
        },
    );
    let _ = room.broadcasts.changed_tx.send(());
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert_eq!(
        room.state
            .read(|sd| sd.read_state().last_saved)
            .unwrap_or_default(),
        None,
        "autosave must not stamp last_saved when no file write occurred"
    );
    assert_eq!(disk_cell_count(&notebook_path), 2);

    let (ack_tx, ack_rx) = oneshot::channel();
    shutdown.send(ack_tx).unwrap();
    assert!(
        !ack_rx.await.unwrap(),
        "shutdown flush must also report that the file was not saved"
    );
}

#[tokio::test(start_paused = true)]
async fn degraded_source_autosave_pauses_until_a_new_event_or_reconciliation() {
    use std::time::Duration;

    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "degraded_autosave.ipynb");
    write_two_cell_notebook(&notebook_path).await;
    let room = Arc::new(room);
    let document_heads = room.doc.write().await.get_heads_hex();
    room.lifecycle.mark_degraded(
        "injected source degradation".to_string(),
        document_heads,
        true,
    );

    let checkpoint = room.persistence.file_checkpoint_coordinator();
    let shutdown = spawn_autosave_debouncer_with_config(
        notebook_path.to_string_lossy().into_owned(),
        Arc::clone(&room),
        AutosaveDebouncerConfig {
            debounce_ms: 10,
            max_interval_ms: 100,
            check_interval_ms: 1,
        },
    );
    let _ = room.broadcasts.changed_tx.send(());
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert_eq!(
        checkpoint.latest_claimed_sequence(),
        1,
        "a terminal source state must not reserve a new save on every timer tick"
    );
    assert_eq!(disk_cell_count(&notebook_path), 2);

    let (ack_tx, ack_rx) = oneshot::channel();
    shutdown.send(ack_tx).unwrap();
    assert!(!ack_rx.await.unwrap());
}

/// An explicit user save (target_path = Some) is a deliberate action and
/// bypasses the guard: emptying then saving on purpose still writes.
#[tokio::test]
async fn explicit_save_of_empty_doc_still_writes() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "explicit.ipynb");
    write_two_cell_notebook(&notebook_path).await;

    {
        let mut doc = room.doc.write().await;
        doc.clear_all_cells().unwrap();
    }

    let target = notebook_path.to_string_lossy().to_string();
    save_notebook_to_disk(&room, Some(&target))
        .await
        .expect("explicit save must succeed");

    assert_eq!(
        disk_cell_count(&notebook_path),
        0,
        "explicit save of an emptied doc must write through the guard"
    );
}

/// A genuinely empty doc over an empty/absent file still round-trips on the
/// autosave path: the guard only fires when there are on-disk cells to lose.
#[tokio::test]
async fn autosave_writes_empty_doc_when_disk_has_no_cells() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "empty.ipynb");

    // No file on disk yet; doc starts empty.
    assert_eq!(room.doc.read().await.cell_count(), 0);

    save_notebook_to_disk(&room, None)
        .await
        .expect("empty doc over absent file must write");

    assert_eq!(
        disk_cell_count(&notebook_path),
        0,
        "empty notebook should round-trip to an empty .ipynb"
    );
}

/// A normal populated autosave is unaffected by the guard.
#[tokio::test]
async fn autosave_writes_populated_doc_normally() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "populated.ipynb");
    write_two_cell_notebook(&notebook_path).await;

    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "only-cell", "code").unwrap();
        doc.update_source("only-cell", "print('hi')").unwrap();
    }

    save_notebook_to_disk(&room, None)
        .await
        .expect("populated autosave must write");

    assert_eq!(
        disk_cell_count(&notebook_path),
        1,
        "populated doc must overwrite the on-disk notebook as usual"
    );
}

/// Corrupt/unparseable on-disk .ipynb is the single most common reason a
/// streaming load fails (jiter parse error, "not a JSON object"). The empty
/// post-failure doc must NOT overwrite those bytes on autosave, even though
/// the file cannot be parsed into a cells array. A guard that counts on-disk
/// cells by parsing would fall open here (count == 0) and destroy the
/// corrupt-but-recoverable file.
#[tokio::test]
async fn autosave_skips_zeroing_write_over_corrupt_file() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "corrupt.ipynb");

    let corrupt = b"{ \"nbformat\": 4, \"cells\": [ {\"id\": \"a\", trunc";
    tokio::fs::write(&notebook_path, corrupt).await.unwrap();

    // Post-failed-load room state: doc emptied, loading done, hazard flagged.
    {
        let mut doc = room.doc.write().await;
        doc.clear_all_cells().unwrap();
        assert_eq!(doc.cell_count(), 0);
    }
    room.mark_load_failed();
    room.finish_loading();

    let error = save_notebook_to_disk(&room, None)
        .await
        .expect_err("failed-load autosave must surface the preserved corrupt file");
    assert!(matches!(error, SaveError::Retryable(_)));

    let on_disk = std::fs::read(&notebook_path).unwrap();
    assert_eq!(
        on_disk, corrupt,
        "empty doc must not overwrite the corrupt-but-recoverable file"
    );
}

/// A file that parses as JSON but whose `cells` key is missing or not an
/// array (e.g. clobbered by a crashed prior write) also fails the streaming
/// load. The empty post-failure doc must not overwrite it. The old
/// parse-and-count guard fell open here because `cells.as_array()` returned
/// None -> count 0.
#[tokio::test]
async fn autosave_skips_zeroing_write_when_disk_cells_not_array() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "no_cells_array.ipynb");

    let no_array = br#"{ "nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": {} }"#;
    tokio::fs::write(&notebook_path, no_array).await.unwrap();

    {
        let mut doc = room.doc.write().await;
        doc.clear_all_cells().unwrap();
        assert_eq!(doc.cell_count(), 0);
    }
    room.mark_load_failed();
    room.finish_loading();

    let error = save_notebook_to_disk(&room, None)
        .await
        .expect_err("failed-load autosave must surface the malformed source");
    assert!(matches!(error, SaveError::Retryable(_)));

    let on_disk = std::fs::read(&notebook_path).unwrap();
    assert_eq!(
        on_disk.as_slice(),
        no_array.as_slice(),
        "empty doc must not overwrite a file whose cells key is non-array"
    );
}

/// Codex P1, the key "legit empty saves" case: the user deletes the last cell
/// of a notebook that loaded successfully (e.g. via MCP/Python). The room
/// legitimately has 0 cells and the on-disk file still has bytes, but the load
/// did NOT fail, so `load_failed` stays false and the guard does not fire: this
/// autosave WRITES the empty notebook over the populated file.
#[tokio::test]
async fn autosave_writes_empty_doc_after_successful_load_then_emptied() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "loaded_then_emptied.ipynb");
    write_two_cell_notebook(&notebook_path).await;

    // Reproduce a successful streaming load: the load populates the doc and
    // does NOT flag load_failed (peer_session sets the flag only in the Err
    // branch). The room is built via test_room_with_path, so load_failed is
    // false by default.
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "cell-a", "code").unwrap();
        doc.add_cell(1, "cell-b", "markdown").unwrap();
    }
    room.finish_loading();
    assert!(!room.load_failed());

    // User now deletes every cell.
    {
        let mut doc = room.doc.write().await;
        doc.clear_all_cells().unwrap();
        assert_eq!(doc.cell_count(), 0);
    }

    save_notebook_to_disk(&room, None)
        .await
        .expect("autosave of a legitimately-emptied loaded notebook must write");

    assert_eq!(
        disk_cell_count(&notebook_path),
        0,
        "deleting the last cell of a loaded notebook must persist the empty state"
    );
}

/// Codex P1, second case: a metadata/dependency edit on an already-saved EMPTY
/// notebook. The room has 0 cells and the file has bytes, but no load failed,
/// so `load_failed` is false and the write goes through, landing the edit.
#[tokio::test]
async fn autosave_writes_metadata_edit_on_loaded_empty_notebook() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "loaded_empty_meta.ipynb");

    // An already-saved empty notebook on disk (valid nbformat, zero cells).
    tokio::fs::write(
        &notebook_path,
        r#"{ "nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [] }"#,
    )
    .await
    .unwrap();

    // The room loaded that empty notebook successfully (no failed load).
    room.finish_loading();
    assert!(!room.load_failed());
    assert_eq!(room.doc.read().await.cell_count(), 0);

    // A metadata edit lands; the doc stays at 0 cells.
    room.state
        .with_doc(|sd| sd.set_path(Some(&notebook_path.to_string_lossy())))
        .unwrap();

    save_notebook_to_disk(&room, None)
        .await
        .expect("metadata edit on a loaded empty notebook must write");

    assert_eq!(
        disk_cell_count(&notebook_path),
        0,
        "loaded empty notebook stays empty but the write must not be skipped"
    );
}

/// The hazard flag clears on recovery COMPLETION, not at retry start. Winning a
/// fresh loading claim via `try_start_loading` must NOT clear it (that would race
/// an in-flight autosave during the retry window); only a completed recovery
/// (here, `clear_load_failed`, as a successful load / watcher reconcile / save
/// would call) re-enables empty saves.
#[tokio::test]
async fn failed_flag_clears_on_recovery_completion_not_retry_start() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "retry.ipynb");
    write_two_cell_notebook(&notebook_path).await;

    // First load failed: doc emptied, hazard flagged. The guard would skip.
    {
        let mut doc = room.doc.write().await;
        doc.clear_all_cells().unwrap();
    }
    room.mark_load_failed();
    room.finish_loading();
    assert!(room.load_failed());

    // A retry wins the loading claim, but the flag stays set while the retry is
    // in flight — the in-flight-autosave race fix.
    assert!(room.try_start_loading(), "retry must win the loading claim");
    assert!(
        room.load_failed(),
        "the flag must stay set during the retry (cleared only on completion)"
    );

    // Recovery completes (a successful load / watcher reconcile / save calls
    // clear_load_failed). Now the empty state writes through.
    room.clear_load_failed();
    room.finish_loading();
    save_notebook_to_disk(&room, None)
        .await
        .expect("empty save after recovery completion must write");
    assert_eq!(
        disk_cell_count(&notebook_path),
        0,
        "a recovered room writes its empty state"
    );
}

/// A failed-load room recovered by SAVING (a successful write makes disk match
/// the room) clears the hazard, so later legitimate empty saves write. Covers
/// the save-based recovery path (e.g. Save As, or add-a-cell-then-save).
#[tokio::test]
async fn save_based_recovery_clears_failed_flag() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "saverecover.ipynb");
    room.mark_load_failed();
    assert!(room.load_failed());

    // An explicit save (target Some) writes to disk and recovers the room.
    save_notebook_to_disk(&room, Some(notebook_path.to_str().unwrap()))
        .await
        .expect("explicit save must write and recover");
    assert!(
        !room.load_failed(),
        "a successful write clears the failed-load flag"
    );

    // Author and delete a temporary cell so the live document remains empty
    // at new causal heads. This forces a real checkpoint instead of an
    // `AlreadyCurrent` result. If the explicit recovery above had not cleared
    // the failed-load guard, the existing non-empty JSON file would block this
    // in-place save.
    {
        let mut doc = room.doc.write().await;
        doc.add_cell(0, "temporary-recovery-cell", "code").unwrap();
        doc.delete_cell("temporary-recovery-cell").unwrap();
    }
    let outcome = save_notebook_to_disk(&room, None)
        .await
        .expect("recovered room must autosave through");
    assert!(matches!(outcome, FileSaveOutcome::Saved { .. }));
    assert_eq!(
        disk_cell_count(&notebook_path),
        0,
        "a save-recovered room writes its empty state on autosave"
    );
}

/// Codex P1: a same-path explicit save (MCP/SDK `save(current_path)`) is an
/// in-place save, not a Save As, so a failed-load empty room must NOT zero the
/// file through it. Only a Save As to a DIFFERENT path bypasses the guard.
#[tokio::test]
async fn same_path_explicit_save_is_in_place_and_protected() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "inplace.ipynb");
    write_two_cell_notebook(&notebook_path).await;
    {
        let mut doc = room.doc.write().await;
        doc.clear_all_cells().unwrap();
    }
    room.mark_load_failed();

    // Same-path Some save == in-place == must fail honestly; the file is preserved.
    let error = save_notebook_to_disk(&room, Some(notebook_path.to_str().unwrap()))
        .await
        .expect_err("in-place save must not claim success without a write");
    assert!(matches!(error, SaveError::Retryable(_)));
    assert_eq!(
        disk_cell_count(&notebook_path),
        2,
        "a same-path save of a failed-load empty room must not zero the file"
    );

    // A Save As to a DIFFERENT path is deliberate and bypasses the guard.
    let other = tmp.path().join("saveas.ipynb");
    save_notebook_to_disk(&room, Some(other.to_str().unwrap()))
        .await
        .expect("Save As to a new path writes");
    assert_eq!(
        disk_cell_count(&other),
        0,
        "Save As to a new path writes the (empty) doc through"
    );
    assert_eq!(
        disk_cell_count(&notebook_path),
        2,
        "the original file is untouched after a Save As elsewhere"
    );
}

/// A file that is only whitespace carries no cells to lose, so the guard must
/// not fire: an empty doc over a whitespace-only file still writes through.
#[tokio::test]
async fn autosave_writes_empty_doc_over_whitespace_only_file() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (room, notebook_path) = test_room_with_path(&tmp, "whitespace.ipynb");

    tokio::fs::write(&notebook_path, b"   \n\t  \n")
        .await
        .unwrap();
    assert_eq!(room.doc.read().await.cell_count(), 0);

    save_notebook_to_disk(&room, None)
        .await
        .expect("empty doc over whitespace-only file must write");

    assert_eq!(
        disk_cell_count(&notebook_path),
        0,
        "whitespace-only file has no cells to protect; empty doc writes through"
    );
}

/// Codex P1: a valid-JSON file with no `cells` key is malformed and must fail
/// the load (not silently load as empty), so the failed load sets load_failed and
/// the zeroing guard preserves the clobbered file instead of overwriting it.
#[test]
fn parse_notebook_jiter_errors_on_missing_or_invalid_cells() {
    // Missing `cells` key -> Err (was previously Ok with empty cells).
    let missing = br#"{"metadata":{},"nbformat":4,"nbformat_minor":5}"#;
    assert!(
        parse_notebook_jiter_for_notebook(missing, Uuid::nil()).is_err(),
        "a notebook with no cells key must fail to load"
    );
    // `cells` present but not an array -> Err (unchanged).
    let not_array = br#"{"cells":{},"metadata":{},"nbformat":4,"nbformat_minor":5}"#;
    assert!(parse_notebook_jiter_for_notebook(not_array, Uuid::nil()).is_err());
    // A genuine empty notebook (cells: []) still parses successfully.
    let empty = br#"{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}"#;
    let ok = parse_notebook_jiter_for_notebook(empty, Uuid::nil())
        .expect("cells: [] is a valid empty notebook");
    assert_eq!(ok.cells.len(), 0);
}

// ---------------------------------------------------------------------------
// Primary-save baseline gate (verification roadmap item 9)
// ---------------------------------------------------------------------------

/// One `note_primary_save_baseline` call. The payload index derives distinct
/// sources and disk bytes per call, so a mixed tuple is detectable even when
/// two calls share a save sequence.
struct BaselineSaveCall {
    sequence: u64,
    payload: u64,
}

impl BaselineSaveCall {
    fn new(sequence: u64, payload: u64) -> Self {
        Self { sequence, payload }
    }

    fn sources(&self) -> HashMap<String, String> {
        HashMap::from([(
            format!("baseline-cell-{}", self.payload),
            format!("x = {}", self.payload),
        )])
    }

    fn bytes(&self) -> Vec<u8> {
        format!("baseline-disk-bytes-{}", self.payload).into_bytes()
    }
}

/// Assert the baseline fields (`last_save_sources`, the recorded disk hash,
/// and the committed baseline sequence) all carry the expected save's
/// payload, never a mix of two saves.
async fn assert_baseline_tuple(
    persistence: &RoomPersistence,
    expected: Option<(&HashMap<String, String>, &[u8], u64)>,
    context: &str,
) {
    use sha2::Digest as _;

    let sources = persistence.last_save_sources.read().await.clone();
    let disk_hash = persistence.known_disk_hash();
    let sequence = persistence.primary_save_baseline_sequence_for_test();
    match expected {
        Some((expected_sources, expected_bytes, expected_sequence)) => {
            assert_eq!(
                &sources, expected_sources,
                "{context}: last_save_sources must belong to the owning save"
            );
            let expected_hash: [u8; 32] = sha2::Sha256::digest(expected_bytes).into();
            assert_eq!(
                disk_hash,
                Some(expected_hash),
                "{context}: disk hash must belong to the owning save"
            );
            assert_eq!(
                sequence, expected_sequence,
                "{context}: baseline sequence must belong to the owning save"
            );
        }
        None => {
            assert!(
                sources.is_empty(),
                "{context}: no accepted save yet, last_save_sources must stay empty"
            );
            assert_eq!(
                disk_hash, None,
                "{context}: no accepted save yet, disk hash must stay unset"
            );
            assert_eq!(
                sequence, 0,
                "{context}: no accepted save yet, baseline sequence must stay 0"
            );
        }
    }
}

/// Replay a deterministic sequence of baseline calls and, after every call,
/// assert the whole tuple is owned by the maximal accepted call so far.
async fn drive_primary_save_baseline_calls(calls: &[BaselineSaveCall], scenario: &str) {
    let persistence = RoomPersistence::ephemeral();
    let mut owner: Option<&BaselineSaveCall> = None;
    for (step, call) in calls.iter().enumerate() {
        let context = format!(
            "{scenario}: step {step} (sequence {}, payload {})",
            call.sequence, call.payload
        );
        let accepted = persistence
            .note_primary_save_baseline(call.sequence, call.sources(), &call.bytes())
            .await;
        // The gate accepts monotonically: any call at or above the newest
        // accepted sequence rebinds the whole tuple; anything older is
        // refused outright.
        let expect_accept = owner.is_none_or(|current| call.sequence >= current.sequence);
        assert_eq!(accepted, expect_accept, "{context}: acceptance mismatch");
        if accepted {
            owner = Some(call);
        }
        let expected_tuple =
            owner.map(|owning| (owning.sources(), owning.bytes(), owning.sequence));
        assert_baseline_tuple(
            &persistence,
            expected_tuple
                .as_ref()
                .map(|(sources, bytes, sequence)| (sources, bytes.as_slice(), *sequence)),
            &context,
        )
        .await;
    }
}

#[tokio::test]
async fn primary_save_baseline_out_of_order_permutations_keep_tuple_from_max_accepted_call() {
    const PERMUTATIONS: [[u64; 3]; 6] = [
        [1, 2, 3],
        [1, 3, 2],
        [2, 1, 3],
        [2, 3, 1],
        [3, 1, 2],
        [3, 2, 1],
    ];
    for (permutation_index, order) in PERMUTATIONS.iter().enumerate() {
        let calls: Vec<BaselineSaveCall> = order
            .iter()
            .enumerate()
            .map(|(step, &sequence)| {
                BaselineSaveCall::new(sequence, (permutation_index as u64) * 10 + step as u64)
            })
            .collect();
        drive_primary_save_baseline_calls(&calls, &format!("permutation {order:?}")).await;
    }
}

#[tokio::test]
async fn primary_save_baseline_duplicate_sequences_rebind_only_at_current_maximum() {
    // A replayed duplicate at the current maximum re-owns the whole tuple.
    drive_primary_save_baseline_calls(
        &[BaselineSaveCall::new(2, 0), BaselineSaveCall::new(2, 1)],
        "duplicate at the maximum",
    )
    .await;

    // Duplicates of an already-superseded sequence stay refused and mutate
    // nothing, while a duplicate of the maximum still lands.
    drive_primary_save_baseline_calls(
        &[
            BaselineSaveCall::new(3, 10),
            BaselineSaveCall::new(1, 11),
            BaselineSaveCall::new(1, 12),
            BaselineSaveCall::new(3, 13),
        ],
        "stale duplicates after a newer save",
    )
    .await;

    // Interleaved duplicates across an out-of-order burst.
    drive_primary_save_baseline_calls(
        &[
            BaselineSaveCall::new(2, 20),
            BaselineSaveCall::new(5, 21),
            BaselineSaveCall::new(2, 22),
            BaselineSaveCall::new(5, 23),
            BaselineSaveCall::new(4, 24),
        ],
        "interleaved duplicates",
    )
    .await;
}

fn baseline_race_ipynb_bytes(cell_id: &str, source: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "cells": [{
            "cell_type": "code",
            "execution_count": null,
            "id": cell_id,
            "metadata": {},
            "outputs": [],
            "source": source,
        }],
        "metadata": {},
        "nbformat": 4,
        "nbformat_minor": 5,
    }))
    .unwrap()
}

/// Complete a reserved checkpoint through the same durable-intent callback
/// seams the production save path uses, committing the checkpoint into the
/// room's durability manifest.
fn complete_checkpoint_through_durable_intent_seams(
    room: &NotebookRoom,
    reservation: file_checkpoint::SaveSequenceClaim,
    path: &Path,
    bytes: &[u8],
) -> file_checkpoint::FileCheckpoint {
    let target =
        file_checkpoint::FileCheckpointTarget::for_content(path.to_path_buf(), Vec::new(), bytes);
    let durability = &room.durability;
    let outcome = room
        .persistence
        .file_checkpoint_coordinator()
        .complete_reserved_with_durable_intent(
            reservation,
            target,
            bytes,
            |preparation| {
                durability
                    .prepare_file_checkpoint(
                        preparation.path.clone(),
                        preparation.file_fingerprint,
                        preparation.exported_heads.clone(),
                        preparation.save_sequence,
                        None,
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
            |preparation| {
                durability
                    .abort_file_checkpoint(preparation.save_sequence)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
            |checkpoint| {
                durability
                    .commit_file_checkpoint(
                        checkpoint.path.clone(),
                        checkpoint.file_fingerprint,
                        checkpoint.exported_heads.clone(),
                        checkpoint.save_sequence,
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
        );
    match outcome {
        file_checkpoint::SaveOutcome::Saved { checkpoint } => checkpoint,
        other => panic!("checkpoint completion should commit a save: {other:?}"),
    }
}

#[tokio::test]
async fn save_continuation_fingerprint_mismatch_is_refused_and_rebinds_nothing() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(Uuid::new_v4(), None, tmp.path(), blob_store, false);
    let path = tmp.path().join("fingerprint-mismatch.ipynb");

    let checkpoint_bytes = baseline_race_ipynb_bytes("cell-s1", "s1 = 1");
    let externally_replaced_bytes = baseline_race_ipynb_bytes("cell-external", "external = 2");
    let s1 = room.persistence.claim_file_checkpoint().unwrap();
    let s1_sequence = s1.sequence();
    complete_checkpoint_through_durable_intent_seams(&room, s1, &path, &checkpoint_bytes);

    // Preserve the committed sequence and path, but replace the visible file
    // externally so only the fingerprint leg can reject this continuation.
    tokio::fs::write(&path, &externally_replaced_bytes)
        .await
        .unwrap();
    let manifest_before = room.durability.manifest();
    assert_eq!(manifest_before.file_save_sequence, Some(s1_sequence));
    assert_eq!(
        manifest_before.canonical_path.as_deref(),
        Some(path.as_path())
    );
    assert_ne!(
        manifest_before.source_fingerprint,
        super::recovery::source_fingerprint(&externally_replaced_bytes)
    );

    assert!(
        !refresh_primary_baseline_from_checkpoint(&room, &path, s1_sequence).await,
        "continuation with a fingerprint mismatch must be refused"
    );
    assert_baseline_tuple(&room.persistence, None, "after fingerprint mismatch").await;
    assert_eq!(
        room.durability.manifest(),
        manifest_before,
        "fingerprint rejection must leave durability state unchanged"
    );

    // Restoring the committed bytes makes the identical call succeed: the
    // fingerprint mismatch alone drove the refusal.
    tokio::fs::write(&path, &checkpoint_bytes).await.unwrap();
    assert!(
        refresh_primary_baseline_from_checkpoint(&room, &path, s1_sequence).await,
        "restored committed bytes must rebuild the baseline"
    );
    let s1_sources = HashMap::from([("cell-s1".to_string(), "s1 = 1".to_string())]);
    assert_baseline_tuple(
        &room.persistence,
        Some((&s1_sources, checkpoint_bytes.as_slice(), s1_sequence)),
        "after restored committed bytes",
    )
    .await;
}

#[tokio::test]
async fn save_continuation_canonical_path_mismatch_is_refused_and_rebinds_nothing() {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(Uuid::new_v4(), None, tmp.path(), blob_store, false);
    let manifest_path = tmp.path().join("manifest-path.ipynb");
    let continuation_path = tmp.path().join("continuation-path.ipynb");

    let s1_bytes = baseline_race_ipynb_bytes("cell-s1", "s1 = 1");
    let s1 = room.persistence.claim_file_checkpoint().unwrap();
    let s1_sequence = s1.sequence();
    complete_checkpoint_through_durable_intent_seams(&room, s1, &manifest_path, &s1_bytes);

    // Put byte-identical content at the continuation path so sequence and
    // fingerprint match the manifest and only the canonical-path leg differs.
    tokio::fs::write(&continuation_path, &s1_bytes)
        .await
        .unwrap();
    let manifest_before = room.durability.manifest();
    assert_eq!(manifest_before.file_save_sequence, Some(s1_sequence));
    assert_eq!(
        manifest_before.source_fingerprint,
        super::recovery::source_fingerprint(&s1_bytes)
    );
    assert_ne!(
        manifest_before.canonical_path.as_deref(),
        Some(continuation_path.as_path())
    );

    assert!(
        !refresh_primary_baseline_from_checkpoint(&room, &continuation_path, s1_sequence).await,
        "continuation with a canonical-path mismatch must be refused"
    );
    assert_baseline_tuple(&room.persistence, None, "after canonical-path mismatch").await;
    assert_eq!(
        room.durability.manifest(),
        manifest_before,
        "canonical-path rejection must leave durability state unchanged"
    );

    // The manifest's own canonical path accepts the identical sequence and
    // bytes: the path mismatch alone drove the refusal.
    assert!(
        refresh_primary_baseline_from_checkpoint(&room, &manifest_path, s1_sequence).await,
        "manifest canonical path must rebuild the baseline"
    );
    let s1_sources = HashMap::from([("cell-s1".to_string(), "s1 = 1".to_string())]);
    assert_baseline_tuple(
        &room.persistence,
        Some((&s1_sources, s1_bytes.as_slice(), s1_sequence)),
        "after canonical-path continuation",
    )
    .await;
}

#[tokio::test]
async fn save_continuation_race_superseded_sequence_fails_manifest_triple_check_and_rebinds_nothing(
) {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let room = NotebookRoom::new_fresh(Uuid::new_v4(), None, tmp.path(), blob_store, false);
    let path = tmp.path().join("raced.ipynb");

    let s1_bytes = baseline_race_ipynb_bytes("cell-s1", "s1 = 1");
    let s2_bytes = baseline_race_ipynb_bytes("cell-s2", "s2 = 2");

    let s1 = room.persistence.claim_file_checkpoint().unwrap();
    let s2 = room.persistence.claim_file_checkpoint().unwrap();
    let s1_sequence = s1.sequence();
    let s2_sequence = s2.sequence();
    assert!(s2_sequence > s1_sequence);

    // Both blocking completions commit in claim order; s2's checkpoint is
    // the newest committed manifest entry before either async continuation
    // resumes.
    complete_checkpoint_through_durable_intent_seams(&room, s1, &path, &s1_bytes);
    complete_checkpoint_through_durable_intent_seams(&room, s2, &path, &s2_bytes);

    // s1's continuation resumes late: the manifest triple-check (save
    // sequence, source fingerprint, canonical path) must refuse it and
    // rebind nothing.
    assert!(
        !refresh_primary_baseline_from_checkpoint(&room, &path, s1_sequence).await,
        "stale continuation must fail the manifest triple-check"
    );
    assert_baseline_tuple(&room.persistence, None, "after stale s1 continuation").await;

    // s2's continuation matches the manifest and installs the whole tuple.
    assert!(
        refresh_primary_baseline_from_checkpoint(&room, &path, s2_sequence).await,
        "committed continuation must rebuild the baseline"
    );
    let s2_sources = HashMap::from([("cell-s2".to_string(), "s2 = 2".to_string())]);
    assert_baseline_tuple(
        &room.persistence,
        Some((&s2_sources, s2_bytes.as_slice(), s2_sequence)),
        "after s2 continuation",
    )
    .await;

    // A replayed stale continuation still rebinds nothing once a real
    // baseline exists.
    assert!(!refresh_primary_baseline_from_checkpoint(&room, &path, s1_sequence).await);
    assert_baseline_tuple(
        &room.persistence,
        Some((&s2_sources, s2_bytes.as_slice(), s2_sequence)),
        "after replayed stale s1 continuation",
    )
    .await;
}

// ---------------------------------------------------------------------------
// Auto-launch single-flight gate (issue #4065: reconnect-loop spawn storm)
// ---------------------------------------------------------------------------

fn gate_test_room() -> (tempfile::TempDir, Arc<NotebookRoom>) {
    let tmp = tempfile::TempDir::new().unwrap();
    let blob_store = test_blob_store(&tmp);
    let room = Arc::new(NotebookRoom::new_fresh(
        Uuid::new_v4(),
        None,
        tmp.path(),
        blob_store,
        false,
    ));
    (tmp, room)
}

/// Two concurrent auto-launch requests: the second must join the first
/// attempt, not start its own. This is the single-flight property that keeps
/// a client reconnect loop from spawning one runtime agent per connect.
#[tokio::test(start_paused = true)]
async fn auto_launch_gate_second_request_joins_in_flight_attempt() {
    let (_tmp, room) = gate_test_room();

    let attempt = match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a,
        _ => panic!("first request must be admitted"),
    };
    assert!(
        matches!(room.try_begin_auto_launch(), AutoLaunchAdmission::InFlight),
        "second request must observe the in-flight attempt"
    );

    attempt.succeed();
}

/// A failed attempt closes the gate for the cooldown window, then a retry is
/// admitted. Connect-frequency retries inside the window are rejected.
#[tokio::test(start_paused = true)]
async fn auto_launch_gate_failure_arms_cooldown_then_readmits() {
    let (_tmp, room) = gate_test_room();

    let attempt = match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a,
        _ => panic!("first request must be admitted"),
    };
    // Dropping without an explicit outcome is the failure path (covers early
    // returns and panics in auto_launch_kernel).
    drop(attempt);

    match room.try_begin_auto_launch() {
        AutoLaunchAdmission::CoolingDown { remaining } => {
            assert!(remaining <= AUTO_LAUNCH_FAILURE_COOLDOWN);
            assert!(remaining > std::time::Duration::ZERO);
        }
        _ => panic!("request inside the cooldown window must be rejected"),
    }

    // Still cooling down just before the deadline.
    tokio::time::advance(AUTO_LAUNCH_FAILURE_COOLDOWN - std::time::Duration::from_millis(1)).await;
    assert!(matches!(
        room.try_begin_auto_launch(),
        AutoLaunchAdmission::CoolingDown { .. }
    ));

    // Past the deadline the next attempt is admitted.
    tokio::time::advance(std::time::Duration::from_millis(2)).await;
    match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a.succeed(),
        _ => panic!("retry after the cooldown must be admitted"),
    }
}

/// Success reopens the gate immediately with no cooldown: the running kernel
/// (not the gate) is what stops later connects from auto-launching again.
#[tokio::test(start_paused = true)]
async fn auto_launch_gate_success_reopens_without_cooldown() {
    let (_tmp, room) = gate_test_room();

    match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a.succeed(),
        _ => panic!("first request must be admitted"),
    }
    assert!(matches!(
        room.try_begin_auto_launch(),
        AutoLaunchAdmission::Admitted(_)
    ));
}

/// Benign aborts (no peers left, kernel already present) release the gate
/// with no cooldown so the next connect can launch without waiting.
#[tokio::test(start_paused = true)]
async fn auto_launch_gate_benign_release_reopens_without_cooldown() {
    let (_tmp, room) = gate_test_room();

    match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a.release_without_cooldown(),
        _ => panic!("first request must be admitted"),
    }
    assert!(matches!(
        room.try_begin_auto_launch(),
        AutoLaunchAdmission::Admitted(_)
    ));
}

/// A successful attempt after a failed one clears the stale cooldown state:
/// the failure deadline must not outlive the attempt that succeeded.
#[tokio::test(start_paused = true)]
async fn auto_launch_gate_admission_clears_stale_cooldown() {
    let (_tmp, room) = gate_test_room();

    match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => drop(a),
        _ => panic!("first request must be admitted"),
    }
    tokio::time::advance(AUTO_LAUNCH_FAILURE_COOLDOWN + std::time::Duration::from_millis(1)).await;
    match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a.succeed(),
        _ => panic!("post-cooldown request must be admitted"),
    }
    assert!(
        matches!(
            room.try_begin_auto_launch(),
            AutoLaunchAdmission::Admitted(_)
        ),
        "success must not inherit the earlier failure's cooldown"
    );
}

/// A launch attempt with zero peers aborts benignly through the real
/// `auto_launch_kernel` entry point: lifecycle lands back on NotStarted and
/// the gate reopens with no cooldown, so the next connect launches
/// immediately. Deleting the benign release at the no-peers exit turns this
/// abort into a failure cooldown and fails the admission assertion below.
#[tokio::test]
async fn auto_launch_no_peers_abort_resets_lifecycle_and_reopens_gate() {
    let (tmp, room) = gate_test_room();
    let daemon = crate::daemon::Daemon::new_for_test(test_daemon_config(&tmp)).unwrap();

    let attempt = match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a,
        _ => panic!("first request must be admitted"),
    };
    // Mirror the connect path: Resolving is written right after admission.
    room.state
        .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Resolving))
        .unwrap();
    assert_eq!(
        room.connections
            .active_peers
            .load(std::sync::atomic::Ordering::Relaxed),
        0,
        "test premise: the admitted peer has already disconnected"
    );

    auto_launch_kernel(
        &room,
        &room.id.to_string(),
        crate::runtime::Runtime::Python,
        crate::settings_doc::PythonEnvType::Uv,
        daemon,
        attempt,
    )
    .await;

    let lifecycle = room
        .state
        .read(|sd| sd.read_state().kernel.lifecycle)
        .unwrap();
    assert_eq!(
        lifecycle,
        RuntimeLifecycle::NotStarted,
        "benign no-peers abort must reset the Resolving lifecycle"
    );
    // A subsequent connect re-triggers: admission must succeed immediately,
    // with no failure cooldown from the benign abort.
    match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a.release_without_cooldown(),
        AutoLaunchAdmission::InFlight => panic!("benign abort must release the gate"),
        AutoLaunchAdmission::CoolingDown { .. } => {
            panic!("benign abort must not arm the failure cooldown")
        }
    }
}

/// The no-peers abort re-admits a reconnect that raced the abort window
/// (#4065 reconnect-loop workload): the reconnect bumped `active_peers` but
/// was refused admission (`InFlight`) while the aborting task still held the
/// gate, so the aborting task must hand itself a fresh token and retry on
/// the reconnected peer's behalf. The peers re-check runs only after the
/// token release; checked before, this connect would be stranded at
/// NotStarted with no retry trigger.
#[tokio::test]
async fn auto_launch_no_peers_abort_readmits_reconnect_that_raced_the_abort() {
    let (_tmp, room) = gate_test_room();

    let attempt = match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a,
        _ => panic!("first request must be admitted"),
    };
    // The reconnect landed during the abort window: peer count is back to 1
    // but its connect saw InFlight and was swallowed.
    room.connections
        .active_peers
        .store(1, std::sync::atomic::Ordering::Relaxed);
    assert!(
        matches!(room.try_begin_auto_launch(), AutoLaunchAdmission::InFlight),
        "the racing connect is refused while the abort is in progress"
    );

    let next = release_attempt_and_readmit_if_peer_waiting(&room, attempt)
        .await
        .expect("a waiting peer must be re-admitted for retry");

    // The re-admitted token holds the gate for the retry.
    assert!(
        matches!(room.try_begin_auto_launch(), AutoLaunchAdmission::InFlight),
        "the retry token must hold the gate"
    );
    next.release_without_cooldown();
}

/// When no peer raced the abort, the no-peers release stands: no retry
/// token, gate open for whichever connect arrives next.
#[tokio::test]
async fn auto_launch_no_peers_abort_stands_when_no_peer_waiting() {
    let (_tmp, room) = gate_test_room();

    let attempt = match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a,
        _ => panic!("first request must be admitted"),
    };

    let next = release_attempt_and_readmit_if_peer_waiting(&room, attempt).await;
    assert!(next.is_none(), "no waiting peer means no retry token");
    match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a.release_without_cooldown(),
        _ => panic!("gate must be open after the abort stands"),
    }
}

/// Success disposition at the launch exit site: `finish_auto_launch_success`
/// must write Running(Idle) and reopen the gate with no cooldown. Deleting
/// `attempt.succeed()` inside it drops the token as a failure, arms the 5s
/// cooldown after every successful launch, and fails the admission assertion.
#[tokio::test]
async fn auto_launch_success_disposition_reopens_gate_immediately() {
    let (_tmp, room) = gate_test_room();

    let attempt = match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a,
        _ => panic!("first request must be admitted"),
    };

    finish_auto_launch_success(
        &room,
        "python",
        "uv",
        "runtime-agent:test",
        LaunchedEnvConfig::default(),
        attempt,
    )
    .await;

    let lifecycle = room
        .state
        .read(|sd| sd.read_state().kernel.lifecycle)
        .unwrap();
    assert_eq!(
        lifecycle,
        RuntimeLifecycle::Running(KernelActivity::Idle),
        "success bookkeeping must publish Running(Idle)"
    );
    match room.try_begin_auto_launch() {
        AutoLaunchAdmission::Admitted(a) => a.release_without_cooldown(),
        AutoLaunchAdmission::InFlight => panic!("success must release the gate"),
        AutoLaunchAdmission::CoolingDown { .. } => {
            panic!("success must not arm the failure cooldown")
        }
    }
}
