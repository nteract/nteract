//! `NotebookRequest::SaveNotebook` handler.

use std::path::PathBuf;
use std::sync::Arc;

use tracing::warn;

use crate::daemon::Daemon;
use crate::notebook_sync_server::{
    canonical_target_path, finalize_untitled_promotion, format_notebook_cells,
    persist_notebook_bytes, release_autosave_owner_marker_for_path,
    save_notebook_to_disk_with_claim_and_intent, FileSaveIntent, FileSaveOutcome,
    NotebookFileBinding, NotebookRoom, SaveError,
};
use crate::protocol::NotebookResponse;

pub(crate) async fn handle(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    format_cells: bool,
    path: Option<String>,
) -> NotebookResponse {
    handle_with_intent(room, daemon, format_cells, path, FileSaveIntent::Ordinary).await
}

pub(crate) async fn handle_reconciled(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    format_cells: bool,
    path: Option<String>,
    source_generation: u64,
) -> NotebookResponse {
    handle_with_intent(
        room,
        daemon,
        format_cells,
        path,
        FileSaveIntent::Reconcile { source_generation },
    )
    .await
}

async fn handle_with_intent(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    format_cells: bool,
    path: Option<String>,
    intent: FileSaveIntent,
) -> NotebookResponse {
    // Reserve causal save order before formatting or serialization can yield.
    // A later request supersedes this one even if blocking workers start in a
    // different order.
    let save_claim = match room.persistence.claim_file_checkpoint() {
        Ok(claim) => claim,
        Err(_) => {
            return NotebookResponse::NotebookSaveBlocked {
                path,
                save_sequence: None,
                reason: notebook_protocol::protocol::SaveBlockedReason::SequenceExhausted,
            };
        }
    };
    let save_sequence = save_claim.sequence();

    let disable_auto_format = {
        let settings = daemon.settings.read().await;
        settings.get_all().disable_auto_format
    };

    // Format cells if requested (before saving)
    if format_cells && !disable_auto_format {
        if let Err(e) = format_notebook_cells(room).await {
            warn!("[save] Format cells failed before durable commit: {}", e);
            return NotebookResponse::NotebookSaveBlocked {
                path,
                save_sequence: Some(save_sequence),
                reason: notebook_protocol::protocol::SaveBlockedReason::Io { message: e },
            };
        }
    }

    let binding_snapshot = room.file_binding.save_snapshot().await;
    let was_untitled = binding_snapshot.was_untitled;
    let old_path = binding_snapshot.old_path;

    // For any save that writes to a NEW path (untitled promotion or
    // save-as rename), claim path_index BEFORE touching disk. Writing
    // first and then checking the claim would overwrite another room's
    // file if both happen to target the same path — the overwritten
    // file then trips the other room's watcher, wiping its CRDT cells.
    //
    // Compute the pre-write canonical target. For untitled rooms a path
    // is required; for file-backed rooms we only need a pre-write claim
    // if the caller specified a path different from the current bound path.
    let target_for_claim: Option<PathBuf> = match (&path, was_untitled) {
        (Some(p), _) => match crate::paths::normalize_save_target(p) {
            Ok(normalized) => Some(canonical_target_path(&normalized).await),
            Err(msg) => {
                return NotebookResponse::NotebookSaveBlocked {
                    path,
                    save_sequence: Some(save_sequence),
                    reason: notebook_protocol::protocol::SaveBlockedReason::Io { message: msg },
                };
            }
        },
        (None, true) => {
            // Untitled save with no path — the daemon requires one.
            // Fall through to save_notebook_to_disk which returns the
            // structured error; no claim needed (no write happens).
            None
        }
        (None, false) => None, // save-in-place on file-backed room
    };

    // The new path that needs a pre-write claim (if any). Separates
    // "claim required" from "have a claim path" so downstream branches
    // don't need a runtime is_some + unwrap.
    let pre_claim: Option<PathBuf> = match (&target_for_claim, &old_path) {
        (Some(t), Some(old)) if t != old => Some(t.clone()),
        (Some(t), None) => Some(t.clone()),
        _ => None,
    };

    if let Some(ref canonical_pre) = pre_claim {
        if let Err(kind) =
            NotebookFileBinding::claim_path(&daemon.notebook_rooms, canonical_pre, room.id).await
        {
            let reason = match kind {
                notebook_protocol::protocol::SaveErrorKind::PathAlreadyOpen { uuid, path } => {
                    notebook_protocol::protocol::SaveBlockedReason::PathAlreadyOpen { uuid, path }
                }
                notebook_protocol::protocol::SaveErrorKind::Io { message } => {
                    notebook_protocol::protocol::SaveBlockedReason::Io { message }
                }
            };
            return NotebookResponse::NotebookSaveBlocked {
                path: path.clone(),
                save_sequence: Some(save_sequence),
                reason,
            };
        }
    }

    let save_outcome = match save_notebook_to_disk_with_claim_and_intent(
        room,
        path.as_deref(),
        save_claim,
        intent,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(e) => {
            // Rollback the path_index claim we just made so the room
            // stays untitled / its old path stays claimed.
            if let Some(ref canonical_pre) = pre_claim {
                NotebookFileBinding::release_path(&daemon.notebook_rooms, canonical_pre).await;
            }
            // Emergency persist for ephemeral rooms: if saving to .ipynb
            // failed, at least write the Automerge doc so data isn't lost.
            if binding_snapshot.is_ephemeral && !room.persistence.has_debouncer() {
                let bytes = room.doc.write().await.save();
                persist_notebook_bytes(&bytes, &room.identity.persist_path);
                warn!(
                    "[notebook-sync] Save failed for ephemeral room — emergency persist to {:?}",
                    room.identity.persist_path
                );
            }
            let (blocked_sequence, reason) = match e {
                SaveError::Unrecoverable(message) | SaveError::Retryable(message) => (
                    Some(save_sequence),
                    notebook_protocol::protocol::SaveBlockedReason::Io { message },
                ),
                SaveError::CheckpointBlocked {
                    save_sequence,
                    reason,
                } => (save_sequence, reason),
            };
            return NotebookResponse::NotebookSaveBlocked {
                path: path.clone(),
                save_sequence: blocked_sequence,
                reason,
            };
        }
    };
    let written = save_outcome.path().to_string();

    // Post-write canonicalize. Usually matches the pre-write key. If it
    // differs (uncommon — only when parent-canonicalize disagreed with
    // full canonicalize), swap the path_index entry.
    let canonical = match tokio::fs::canonicalize(&written).await {
        Ok(c) => c,
        Err(e) => {
            warn!(
                "[notebook-sync] post-save canonicalize({}) failed: {} — using raw path. \
                 Duplicate-room detection may be weakened.",
                written, e
            );
            PathBuf::from(&written)
        }
    };

    if let Some(ref canonical_pre) = pre_claim {
        if canonical_pre != &canonical {
            NotebookFileBinding::replace_claim(
                &daemon.notebook_rooms,
                canonical_pre,
                canonical.clone(),
                room.id,
            )
            .await;
        }
    }

    let registry_now = chrono::Utc::now().to_rfc3339();
    if was_untitled {
        if let Err(message) = finalize_untitled_promotion(room, canonical.clone()).await {
            NotebookFileBinding::release_path(&daemon.notebook_rooms, &canonical).await;
            let save_sequence = match &save_outcome {
                FileSaveOutcome::Saved { save_sequence, .. }
                | FileSaveOutcome::AlreadyCurrent { save_sequence, .. } => *save_sequence,
            };
            return NotebookResponse::NotebookSaveBlocked {
                path: Some(written),
                save_sequence: Some(save_sequence),
                reason: notebook_protocol::protocol::SaveBlockedReason::Io { message },
            };
        }
        // Persist path -> id so reopening this freshly-saved file keeps its id
        // across daemon restarts (NIP-1).
        daemon
            .notebook_registry
            .record(&canonical, room.id, &registry_now);
    } else if let Some(old) = old_path.as_ref() {
        let path_changed = old != &canonical;
        if path_changed {
            // Save-as rename: new path already claimed above; remove
            // the old path_index entry and rebind the room to the new path.
            NotebookFileBinding::release_path(&daemon.notebook_rooms, old).await;
            NotebookFileBinding::rebind_after_save_as(room, canonical.clone()).await;
            // Move the persistent binding with the room: the old path is now a
            // different (or absent) file and must not resolve to this id.
            daemon.notebook_registry.forget(old);
            release_autosave_owner_marker_for_path(old).await;
            daemon
                .notebook_registry
                .record(&canonical, room.id, &registry_now);
        }
        // If path didn't change, this is save-in-place: nothing else.
    }

    match save_outcome {
        FileSaveOutcome::Saved {
            exported_heads,
            save_sequence,
            ..
        } => NotebookResponse::NotebookSaved {
            path: written,
            exported_heads,
            save_sequence,
        },
        FileSaveOutcome::AlreadyCurrent {
            exported_heads,
            save_sequence,
            ..
        } => NotebookResponse::NotebookAlreadyCurrent {
            path: written,
            exported_heads,
            save_sequence,
        },
    }
}
