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
use automerge_recovery::{AutomergeOperationError, AutomergeRecoveryError};
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
                &json_path,
                "settings-sync-initial-generate",
            )?
        };
        if let Some(data) = encoded {
            connection::send_frame(&mut writer, &data).await?;
        }
    }

    // Phase 2: Exchange messages until sync is complete, then watch for changes
    loop {
        tokio::select! {
            // Incoming message from this client
            result = connection::recv_frame(&mut reader) => {
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

            // Another peer changed settings -- push update to this client
            _ = changed_rx.recv() => {
                let encoded = {
                    let mut doc = settings.write().await;
                    generate_settings_sync_frame(
                        &mut doc,
                        &mut peer_state,
                        &json_path,
                        "settings-sync-broadcast-generate",
                    )?
                };
                if let Some(msg) = encoded {
                    connection::send_frame(&mut writer, &msg).await?;
                }
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
    json_path: &Path,
    label: &'static str,
) -> anyhow::Result<Option<Vec<u8>>> {
    let fallback = doc.get_all();
    match doc.generate_sync_message_recovering(label, peer_state) {
        Ok(message) => Ok(message.map(|msg| msg.encode())),
        Err(error) => recover_settings_doc_reset_peer_and_retry_generate(
            doc, peer_state, json_path, &fallback, label, error,
        ),
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

            let reply =
                generate_settings_sync_frame(doc, peer_state, json_path, "settings-sync-reply")?;
            Ok(IncomingSettingsSyncOutcome {
                reply,
                broadcast_changed: doc_changed,
            })
        }
        Err(AutomergeOperationError::Panic(error)) => {
            // We cannot prove the inbound client edit applied cleanly after a
            // receive-side panic. Rebuild from durable JSON truth and resync
            // instead of replaying the same message into a recovered document.
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
    error: AutomergeRecoveryError,
) -> anyhow::Result<Option<Vec<u8>>> {
    warn!(
        "[sync] Rebuilding settings doc from JSON after Automerge panic: {}",
        error
    );
    recover_settings_doc_from_json_or_snapshot(doc, json_path, fallback);
    *peer_state = sync::State::new();

    doc.generate_sync_message_recovering(retry_label, peer_state)
        .map(|message| message.map(|msg| msg.encode()))
        .map_err(|retry_error| {
            anyhow::anyhow!(
                "[sync] settings sync recovery retry failed after Automerge panic: {}",
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
    use tempfile::TempDir;

    fn write_settings_json(path: &Path, settings: &SyncedSettings) {
        let json = serde_json::to_string_pretty(settings).expect("settings serialize");
        std::fs::write(path, json).expect("settings write");
    }

    #[test]
    #[serial(settings_sync_panic_hooks)]
    fn generate_panic_rebuilds_from_canonical_json_and_retries() {
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
        let frame = generate_settings_sync_frame(
            &mut doc,
            &mut peer_state,
            &json_path,
            "settings-test-generate",
        )
        .expect("recovery should retry generate");

        assert!(frame.is_some());
        assert_eq!(doc.get_all(), canonical);
    }

    #[test]
    #[serial(settings_sync_panic_hooks)]
    fn receive_panic_does_not_persist_or_broadcast_client_edit() {
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
        let outcome = apply_incoming_settings_sync_frame(
            &mut server,
            &mut server_peer_state,
            message,
            &json_path,
        )
        .expect("receive panic should recover to canonical settings");

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

        SettingsDoc::__panic_on_next_generate_sync_calls_for_test(1);
        let frame = generate_settings_sync_frame(
            &mut doc,
            &mut peer_state,
            &json_path,
            "settings-test-generate-invalid-json",
        )
        .expect("invalid JSON should fall back to last-known-good snapshot");

        assert!(frame.is_some());
        assert_eq!(doc.get_all(), snapshot);
        assert_eq!(
            std::fs::read_to_string(&json_path).expect("settings read"),
            "{ invalid json"
        );
    }

    #[test]
    #[serial(settings_sync_panic_hooks)]
    fn repeated_generate_panic_after_recovery_returns_error() {
        let tmp = TempDir::new().expect("temp dir");
        let json_path = tmp.path().join("settings.json");
        write_settings_json(&json_path, &SyncedSettings::default());

        let mut doc = SettingsDoc::new();
        let mut peer_state = sync::State::new();

        SettingsDoc::__panic_on_next_generate_sync_calls_for_test(2);
        let error = generate_settings_sync_frame(
            &mut doc,
            &mut peer_state,
            &json_path,
            "settings-test-repeated-generate",
        )
        .expect_err("second generate panic should close this sync path");

        assert!(error.to_string().contains("recovery retry failed"));
    }
}
