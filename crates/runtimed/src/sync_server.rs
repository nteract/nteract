//! Automerge sync protocol handler for settings synchronization.
//!
//! Handles a single client connection that has already been routed by the
//! daemon's unified socket. The durable settings state is canonical
//! `settings.json`; this handler exchanges Automerge sync messages for the
//! live `SettingsDoc` projection, persists successfully applied client changes
//! back to JSON, and rebuilds the projection from JSON during recovery.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use automerge::sync;
use automerge_recovery::{is_recoverable_sync_error, AutomergeOperationError};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};

use crate::settings_doc::{SettingsDoc, SyncedSettings};
use notebook_protocol::connection;

/// Check if an error is just a normal connection close.
pub(crate) fn is_connection_closed(e: &anyhow::Error) -> bool {
    if let Some(io_err) = e.downcast_ref::<std::io::Error>() {
        matches!(
            io_err.kind(),
            std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::UnexpectedEof
                | std::io::ErrorKind::NotConnected
        )
    } else {
        false
    }
}

/// Handle a single settings sync client connection.
///
/// The caller has already consumed the handshake frame. This function
/// runs the Automerge sync protocol:
/// 1. Initial sync: exchange messages until both sides converge
/// 2. Watch loop: wait for changes (from other peers or from this client),
///    exchange sync messages to propagate
pub async fn handle_settings_sync_connection<R, W>(
    mut reader: R,
    mut writer: W,
    settings: Arc<RwLock<SettingsDoc>>,
    changed_tx: broadcast::Sender<()>,
    mut changed_rx: broadcast::Receiver<()>,
    json_path: PathBuf,
) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut peer_state = sync::State::new();
    info!("[sync] New client connected, starting initial sync");

    // Phase 1: Initial sync -- server sends first
    {
        let encoded = {
            let mut doc = settings.write().await;
            generate_settings_sync_frame(
                &mut doc,
                &mut peer_state,
                "settings-sync-initial-generate",
            )?
        };
        if let Some(data) = encoded {
            connection::send_frame(&mut writer, &data).await?;
        }
    }

    // Phase 2: Exchange messages until sync is complete, then watch for changes
    loop {
        // recv_frame uses read_exact, so dropping it on a broadcast would lose
        // partial prefix/body bytes. Keep the same raw-frame future alive until
        // it completes, without requiring an owned reader or a spawned task.
        let incoming = connection::recv_frame(&mut reader);
        tokio::pin!(incoming);
        let result = loop {
            tokio::select! {
                result = &mut incoming => break result,

                // Another peer changed settings -- push update to this client
                _ = changed_rx.recv() => {
                    let encoded = {
                        let mut doc = settings.write().await;
                        generate_settings_sync_frame(
                            &mut doc,
                            &mut peer_state,
                            "settings-sync-broadcast-generate",
                        )?
                    };
                    if let Some(msg) = encoded {
                        connection::send_frame(&mut writer, &msg).await?;
                    }
                }
            }
        };

        match result? {
            Some(data) => {
                let message = sync::Message::decode(&data)
                    .map_err(|e| anyhow::anyhow!("decode error: {}", e))?;

                let outcome = {
                    let mut doc = settings.write().await;
                    apply_incoming_settings_sync_frame(
                        &mut doc,
                        &mut peer_state,
                        message,
                        &json_path,
                    )?
                };

                if outcome.broadcast_changed {
                    let _ = changed_tx.send(());
                }

                if let Some(reply) = outcome.reply {
                    connection::send_frame(&mut writer, &reply).await?;
                }
            }
            None => {
                // Client disconnected
                return Ok(());
            }
        }
    }
}

struct IncomingSettingsSyncOutcome {
    reply: Option<Vec<u8>>,
    broadcast_changed: bool,
}

fn generate_settings_sync_frame(
    doc: &mut SettingsDoc,
    peer_state: &mut sync::State,
    label: &'static str,
) -> anyhow::Result<Option<Vec<u8>>> {
    match doc.generate_sync_message_recovering(label, peer_state) {
        Ok(message) => Ok(message.map(|msg| msg.encode())),
        Err(error) => Err(anyhow::anyhow!(
            "[sync] settings sync generate failed after Automerge panic: {}",
            error
        )),
    }
}

fn apply_incoming_settings_sync_frame(
    doc: &mut SettingsDoc,
    peer_state: &mut sync::State,
    message: sync::Message,
    json_path: &Path,
) -> anyhow::Result<IncomingSettingsSyncOutcome> {
    let fallback = doc.get_all();

    // Compare heads before/after so pure acks or duplicate messages don't fire
    // `settings_changed`. Without this the pool warming loops wake up on every
    // sync-protocol round-trip, which thrashes the pools when several
    // per-`invoke` clients land back-to-back (#2120).
    let before = doc.heads();
    match doc.receive_sync_message_recovering("settings-sync-receive", peer_state, message) {
        Ok(()) => {
            let after = doc.heads();
            let doc_changed = before != after;

            if doc_changed {
                persist_settings(doc, json_path);
            }

            let reply = generate_settings_sync_frame(doc, peer_state, "settings-sync-reply")?;
            Ok(IncomingSettingsSyncOutcome {
                reply,
                broadcast_changed: doc_changed,
            })
        }
        Err(AutomergeOperationError::Panic(error)) => Err(anyhow::anyhow!(
            "[sync] settings sync receive failed after Automerge panic: {}",
            error
        )),
        Err(AutomergeOperationError::Automerge { label, source }) => {
            let recoverable = is_recoverable_sync_error(source.as_ref());
            let error = AutomergeOperationError::Automerge { label, source };
            if !recoverable {
                return Err(error.into());
            }

            // Treat patch-log skew as a recoverable document-boundary failure:
            // the durable JSON file remains authoritative, and the inbound
            // frame must not be assumed to have applied.
            let reply = recover_settings_doc_reset_peer_and_retry_generate(
                doc,
                peer_state,
                json_path,
                &fallback,
                "settings-sync-receive-recovery-generate",
                error,
            )?;
            Ok(IncomingSettingsSyncOutcome {
                reply,
                broadcast_changed: false,
            })
        }
        Err(error) => Err(error.into()),
    }
}

fn recover_settings_doc_reset_peer_and_retry_generate(
    doc: &mut SettingsDoc,
    peer_state: &mut sync::State,
    json_path: &Path,
    fallback: &SyncedSettings,
    retry_label: &'static str,
    error: impl std::fmt::Display,
) -> anyhow::Result<Option<Vec<u8>>> {
    warn!(
        "[sync] Rebuilding settings doc from JSON after recoverable Automerge failure: {}",
        error
    );
    recover_settings_doc_from_json_or_snapshot(doc, json_path, fallback);
    *peer_state = sync::State::new();

    doc.generate_sync_message_recovering(retry_label, peer_state)
        .map(|message| message.map(|msg| msg.encode()))
        .map_err(|retry_error| {
            anyhow::anyhow!(
                "[sync] settings sync recoverable retry failed after recoverable Automerge failure: {}",
                retry_error
            )
        })
}

fn recover_settings_doc_from_json_or_snapshot(
    doc: &mut SettingsDoc,
    json_path: &Path,
    fallback: &SyncedSettings,
) {
    match load_settings_doc_from_json(json_path) {
        Ok(recovered) => {
            *doc = recovered;
        }
        Err(error) => {
            warn!(
                "[sync] Failed to reload canonical settings.json during recovery: {}; using last-known-good settings snapshot",
                error
            );
            *doc = SettingsDoc::from_synced_settings(fallback);
        }
    }
}

fn load_settings_doc_from_json(json_path: &Path) -> anyhow::Result<SettingsDoc> {
    let contents = std::fs::read_to_string(json_path)?;
    let json = serde_json::from_str::<serde_json::Value>(&contents)?;
    Ok(SettingsDoc::from_json_value(&json))
}

/// Persist the settings document to the canonical JSON file.
fn persist_settings(doc: &SettingsDoc, json_path: &Path) {
    if let Err(e) = doc.save_json_mirror(json_path) {
        warn!("[sync] Failed to write settings.json: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings_doc::{ColorTheme, SyncedSettings, ThemeMode};
    use serial_test::serial;
    use std::cell::Cell;
    use std::future::Future;
    use std::pin::Pin;
    use std::rc::Rc;
    use std::task::{Context, Poll};
    use tempfile::TempDir;
    use tokio::io::{AsyncWriteExt, DuplexStream, ReadBuf};

    struct ObservedReader<R> {
        inner: R,
        consumed: Rc<Cell<usize>>,
    }

    impl<R: AsyncRead + Unpin> AsyncRead for ObservedReader<R> {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let before = buf.filled().len();
            let result = Pin::new(&mut self.inner).poll_read(cx, buf);
            self.consumed
                .set(self.consumed.get() + buf.filled().len() - before);
            result
        }
    }

    // Drive the real handler and client explicitly, without spawned tasks or
    // sleeps. These small settings frames fit in the duplex buffer, so a handler
    // poll writes complete frames before parking on its next read/broadcast.
    async fn exchange_settings_until_idle(
        mut handler: Pin<&mut impl Future<Output = anyhow::Result<()>>>,
        stream: &mut DuplexStream,
        client: &mut SettingsDoc,
        peer_state: &mut sync::State,
    ) {
        for _ in 0..16 {
            let result = futures::poll!(handler.as_mut());
            assert!(
                result.is_pending(),
                "handler closed unexpectedly: {result:?}"
            );
            let incoming = {
                let receive = connection::recv_frame(stream);
                tokio::pin!(receive);
                futures::poll!(receive)
            };
            match incoming {
                Poll::Ready(Ok(Some(data))) => {
                    client
                        .receive_sync_message(
                            peer_state,
                            sync::Message::decode(&data).expect("server sync message"),
                        )
                        .expect("apply server settings");
                    if let Some(message) = client.generate_sync_message(peer_state) {
                        connection::send_frame(stream, &message.encode())
                            .await
                            .expect("send client settings");
                    }
                }
                Poll::Pending => return,
                result => panic!("server frame failed: {result:?}"),
            }
        }
        panic!("settings sync did not become idle");
    }

    async fn settings_handler_preserves_fragment_across_broadcasts(split_at: usize) {
        let _hook_guard = SettingsSyncFailureHookGuard::new();
        let tmp = TempDir::new().expect("temp dir");
        let json_path = tmp.path().join("settings.json");
        let canonical = SyncedSettings::default();
        write_settings_json(&json_path, &canonical);
        let settings = Arc::new(RwLock::new(SettingsDoc::from_synced_settings(&canonical)));
        let (changed_tx, changed_rx) = broadcast::channel(16);
        let (mut client_stream, server_stream) = tokio::io::duplex(64 * 1024);
        let (reader, mut writer) = tokio::io::split(server_stream);
        let consumed = Rc::new(Cell::new(0));
        let mut reader = ObservedReader {
            inner: reader,
            consumed: consumed.clone(),
        };
        // Borrow both halves and use a !Send reader to preserve the handler's
        // existing lifetime and AsyncRead/AsyncWrite + Unpin contract.
        let handler = handle_settings_sync_connection(
            &mut reader,
            &mut writer,
            settings.clone(),
            changed_tx.clone(),
            changed_rx,
            json_path.clone(),
        );
        tokio::pin!(handler);
        let mut client = SettingsDoc::new();
        let mut peer_state = sync::State::new();
        exchange_settings_until_idle(
            handler.as_mut(),
            &mut client_stream,
            &mut client,
            &mut peer_state,
        )
        .await;
        assert_eq!(settings.write().await.heads(), client.heads());

        client.put("theme", "light");
        let message = client
            .generate_sync_message(&mut peer_state)
            .expect("client edit")
            .encode();
        let mut frame = (message.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&message);
        assert!(split_at < frame.len());
        let before = consumed.get();
        client_stream
            .write_all(&frame[..split_at])
            .await
            .expect("write fragment");
        assert!(futures::poll!(handler.as_mut()).is_pending());
        assert_eq!(consumed.get(), before + split_at, "partial frame was read");

        // Simulate another peer's persisted edit while the incoming frame is
        // incomplete. With no remaining bytes available, only the broadcast can
        // win select; its receiver must be drained before we finish the frame.
        {
            let mut server = settings.write().await;
            server.put("color_theme", "cream");
            server
                .save_json_mirror(&json_path)
                .expect("persist other peer edit");
        }
        for _ in 0..2 {
            assert_eq!(changed_tx.send(()).expect("broadcast settings"), 1);
            assert!(futures::poll!(handler.as_mut()).is_pending());
            assert_eq!(changed_tx.len(), 0, "handler processed the broadcast");
            assert_eq!(consumed.get(), before + split_at);
        }

        client_stream
            .write_all(&frame[split_at..])
            .await
            .expect("finish frame");
        exchange_settings_until_idle(
            handler.as_mut(),
            &mut client_stream,
            &mut client,
            &mut peer_state,
        )
        .await;
        assert_eq!(client.get_all().theme, ThemeMode::Light);
        assert_eq!(client.get_all().color_theme, ColorTheme::Cream);
        assert_eq!(settings.write().await.heads(), client.heads());

        // A later frame must start on its own length prefix and converge too.
        client.put("theme", "dark");
        let next = client
            .generate_sync_message(&mut peer_state)
            .expect("next client edit");
        connection::send_frame(&mut client_stream, &next.encode())
            .await
            .expect("send next frame");
        exchange_settings_until_idle(
            handler.as_mut(),
            &mut client_stream,
            &mut client,
            &mut peer_state,
        )
        .await;
        assert_eq!(client.get_all().theme, ThemeMode::Dark);
        assert_eq!(settings.write().await.heads(), client.heads());
        let persisted: SyncedSettings = serde_json::from_str(
            &std::fs::read_to_string(&json_path).expect("read persisted settings"),
        )
        .expect("parse persisted settings");
        assert_eq!(persisted, client.get_all());

        client_stream
            .shutdown()
            .await
            .expect("orderly client disconnect");
        assert!(matches!(
            futures::poll!(handler.as_mut()),
            Poll::Ready(Ok(()))
        ));
    }

    #[tokio::test]
    #[serial(settings_sync_panic_hooks)]
    async fn settings_handler_preserves_partial_prefix_across_broadcasts() {
        // Scheduling is explicit; cooperative budget yields must not look like
        // an idle connection while buffered bytes are still available.
        tokio::task::unconstrained(settings_handler_preserves_fragment_across_broadcasts(2)).await;
    }

    #[tokio::test]
    #[serial(settings_sync_panic_hooks)]
    async fn settings_handler_preserves_partial_body_across_broadcasts() {
        tokio::task::unconstrained(settings_handler_preserves_fragment_across_broadcasts(4 + 5))
            .await;
    }

    struct SettingsSyncFailureHookGuard;

    impl SettingsSyncFailureHookGuard {
        fn new() -> Self {
            SettingsDoc::__reset_sync_failure_hooks_for_test();
            Self
        }
    }

    impl Drop for SettingsSyncFailureHookGuard {
        fn drop(&mut self) {
            SettingsDoc::__reset_sync_failure_hooks_for_test();
        }
    }

    fn write_settings_json(path: &Path, settings: &SyncedSettings) {
        let json = serde_json::to_string_pretty(settings).expect("settings serialize");
        std::fs::write(path, json).expect("settings write");
    }

    #[test]
    #[serial(settings_sync_panic_hooks)]
    fn generate_panic_returns_error_without_rebuild_or_retry() {
        let _hook_guard = SettingsSyncFailureHookGuard::new();
        let tmp = TempDir::new().expect("temp dir");
        let json_path = tmp.path().join("settings.json");
        let canonical = SyncedSettings {
            theme: ThemeMode::Dark,
            color_theme: ColorTheme::Cream,
            ..SyncedSettings::default()
        };
        write_settings_json(&json_path, &canonical);

        let mut doc = SettingsDoc::new();
        doc.put("theme", "light");
        let mut peer_state = sync::State::new();

        SettingsDoc::__panic_on_next_generate_sync_calls_for_test(1);
        let error =
            generate_settings_sync_frame(&mut doc, &mut peer_state, "settings-test-generate")
                .expect_err("generate panic should close settings sync path");

        assert!(error.to_string().contains("settings sync generate failed"));
        assert_eq!(doc.get_all().theme, ThemeMode::Light);
    }

    #[test]
    #[serial(settings_sync_panic_hooks)]
    fn receive_panic_returns_error_without_persisting_or_broadcasting() {
        let _hook_guard = SettingsSyncFailureHookGuard::new();
        let tmp = TempDir::new().expect("temp dir");
        let json_path = tmp.path().join("settings.json");
        let canonical = SyncedSettings::default();
        write_settings_json(&json_path, &canonical);

        let mut server = SettingsDoc::from_synced_settings(&canonical);
        let mut server_peer_state = sync::State::new();

        let mut client = SettingsDoc::new();
        client.put("theme", "dark");
        let mut client_state = sync::State::new();
        let message = client
            .generate_sync_message(&mut client_state)
            .expect("client should generate settings edit");

        SettingsDoc::__panic_on_next_receive_sync_calls_for_test(1);
        let error = match apply_incoming_settings_sync_frame(
            &mut server,
            &mut server_peer_state,
            message,
            &json_path,
        ) {
            Ok(_) => panic!("receive panic should close settings sync path"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("settings sync receive failed"));
        assert_eq!(server.get_all(), canonical);

        let saved = std::fs::read_to_string(&json_path).expect("settings read");
        let saved: SyncedSettings = serde_json::from_str(&saved).expect("settings parse");
        assert_eq!(saved.theme, ThemeMode::System);
    }

    #[test]
    #[serial(settings_sync_panic_hooks)]
    fn receive_patch_log_mismatch_does_not_persist_or_broadcast_client_edit() {
        let _hook_guard = SettingsSyncFailureHookGuard::new();
        let tmp = TempDir::new().expect("temp dir");
        let json_path = tmp.path().join("settings.json");
        let canonical = SyncedSettings::default();
        write_settings_json(&json_path, &canonical);

        let mut server = SettingsDoc::from_synced_settings(&canonical);
        let mut server_peer_state = sync::State::new();

        let mut client = SettingsDoc::new();
        client.put("theme", "dark");
        let mut client_state = sync::State::new();
        let message = client
            .generate_sync_message(&mut client_state)
            .expect("client should generate settings edit");

        SettingsDoc::__patch_log_mismatch_on_next_receive_sync_calls_for_test(1);
        let outcome = apply_incoming_settings_sync_frame(
            &mut server,
            &mut server_peer_state,
            message,
            &json_path,
        )
        .expect("receive PatchLogMismatch should recover to canonical settings");

        assert!(outcome.reply.is_some());
        assert!(!outcome.broadcast_changed);
        assert_eq!(server.get_all(), canonical);

        let saved = std::fs::read_to_string(&json_path).expect("settings read");
        let saved: SyncedSettings = serde_json::from_str(&saved).expect("settings parse");
        assert_eq!(saved.theme, ThemeMode::System);
    }

    #[test]
    #[serial(settings_sync_panic_hooks)]
    fn invalid_json_recovery_keeps_last_known_good_and_file_contents() {
        let _hook_guard = SettingsSyncFailureHookGuard::new();
        let tmp = TempDir::new().expect("temp dir");
        let json_path = tmp.path().join("settings.json");
        std::fs::write(&json_path, "{ invalid json").expect("settings write");

        let snapshot = SyncedSettings {
            theme: ThemeMode::Dark,
            color_theme: ColorTheme::Cream,
            ..SyncedSettings::default()
        };
        let mut doc = SettingsDoc::from_synced_settings(&snapshot);
        let mut peer_state = sync::State::new();

        let mut client = SettingsDoc::new();
        client.put("theme", "light");
        let mut client_state = sync::State::new();
        let message = client
            .generate_sync_message(&mut client_state)
            .expect("client should generate settings edit");

        SettingsDoc::__patch_log_mismatch_on_next_receive_sync_calls_for_test(1);
        let outcome =
            apply_incoming_settings_sync_frame(&mut doc, &mut peer_state, message, &json_path)
                .expect("invalid JSON should fall back to last-known-good snapshot");

        assert!(outcome.reply.is_some());
        assert!(!outcome.broadcast_changed);
        assert_eq!(doc.get_all(), snapshot);
        assert_eq!(
            std::fs::read_to_string(&json_path).expect("settings read"),
            "{ invalid json"
        );
    }

    #[test]
    #[serial(settings_sync_panic_hooks)]
    fn repeated_generate_panic_returns_first_error_without_retry() {
        let _hook_guard = SettingsSyncFailureHookGuard::new();
        let tmp = TempDir::new().expect("temp dir");
        let json_path = tmp.path().join("settings.json");
        write_settings_json(&json_path, &SyncedSettings::default());

        let mut doc = SettingsDoc::new();
        let mut peer_state = sync::State::new();

        SettingsDoc::__panic_on_next_generate_sync_calls_for_test(2);
        let error = generate_settings_sync_frame(
            &mut doc,
            &mut peer_state,
            "settings-test-repeated-generate",
        )
        .expect_err("generate panic should close this sync path");

        assert!(error.to_string().contains("settings sync generate failed"));
    }
}
