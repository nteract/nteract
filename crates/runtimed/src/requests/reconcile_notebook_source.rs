//! Explicit file-backed source reconciliation.
//!
//! Ordinary save/reload paths preserve both sides of a disk/recovery conflict.
//! This handler is the only request surface that may name a winner and restore
//! interactive capabilities.

use std::path::Path;
use std::sync::Arc;

use notebook_protocol::protocol::{
    NotebookResponse, SaveBlockedReason, SourceReconciliation, SourceReconciliationBlockedReason,
    SourceReconciliationOperation,
};
use tracing::warn;

use crate::daemon::Daemon;
use crate::notebook_sync_server::file_checkpoint::{
    FileCheckpoint, SaveBlockedReason as FileCheckpointBlockedReason,
};
use crate::notebook_sync_server::recovery::source_fingerprint;
use crate::notebook_sync_server::{
    apply_prepared_source_reconciliation, apply_reconciled_runtime_sidecars, canonical_target_path,
    prepare_source_reconciliation, NotebookRoom, RoomAvailability,
};

use super::save_notebook;

pub(crate) async fn handle(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    operation: SourceReconciliation,
) -> NotebookResponse {
    let operation_name = operation.operation();
    if !matches!(room.lifecycle.availability(), RoomAvailability::Degraded(_)) {
        return blocked(
            operation_name,
            SourceReconciliationBlockedReason::NotRequired {
                message: "room source is not degraded".to_string(),
            },
        );
    }
    let Some(_claim) = room.try_claim_source_reconciliation() else {
        return blocked(operation_name, SourceReconciliationBlockedReason::Busy);
    };
    let source_generation = room.lifecycle.source_state().generation().saturating_add(1);

    match operation {
        SourceReconciliation::SaveRecoveredAs { path } => {
            save_recovered_as(room, daemon, path, source_generation).await
        }
        SourceReconciliation::KeepRecoveredAndOverwriteSource => {
            keep_recovered(room, daemon, source_generation).await
        }
        SourceReconciliation::ArchiveRecoveryAndReloadSource => {
            archive_and_reload_source(room, daemon, source_generation).await
        }
    }
}

async fn save_recovered_as(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    requested_path: String,
    source_generation: u64,
) -> NotebookResponse {
    let operation = SourceReconciliationOperation::SaveRecoveredAs;
    let Some(bound_path) = room.file_binding.path().await else {
        return blocked(operation, SourceReconciliationBlockedReason::NoBoundSource);
    };
    let normalized = match crate::paths::normalize_save_target(&requested_path) {
        Ok(path) => path,
        Err(message) => {
            return blocked(operation, SourceReconciliationBlockedReason::Io { message });
        }
    };
    let target = canonical_target_path(&normalized).await;
    if target == bound_path {
        return blocked(
            operation,
            SourceReconciliationBlockedReason::TargetMustDiffer {
                bound_path: bound_path.to_string_lossy().into_owned(),
                requested_path,
            },
        );
    }

    match save_notebook::handle_reconciled(
        room,
        daemon,
        false,
        Some(target.to_string_lossy().into_owned()),
        source_generation,
    )
    .await
    {
        NotebookResponse::NotebookSaved {
            path,
            exported_heads,
            save_sequence,
        }
        | NotebookResponse::NotebookAlreadyCurrent {
            path,
            exported_heads,
            save_sequence,
        } => {
            refresh_primary_disk_baseline(room, Path::new(&path)).await;
            finish_reconciliation(
                room,
                operation,
                path,
                None,
                exported_heads,
                save_sequence,
                source_generation,
            )
            .await
        }
        NotebookResponse::NotebookSaveBlocked { reason, .. } => {
            blocked(operation, map_save_block(reason))
        }
        NotebookResponse::SaveError { error } => blocked(
            operation,
            SourceReconciliationBlockedReason::Io {
                message: format!("save recovered notebook failed: {error:?}"),
            },
        ),
        NotebookResponse::Error { error } => blocked(
            operation,
            SourceReconciliationBlockedReason::Io { message: error },
        ),
        response => blocked(
            operation,
            SourceReconciliationBlockedReason::Io {
                message: format!("unexpected save response during reconciliation: {response:?}"),
            },
        ),
    }
}

async fn keep_recovered(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    source_generation: u64,
) -> NotebookResponse {
    let operation = SourceReconciliationOperation::KeepRecoveredAndOverwriteSource;
    if room.file_binding.path().await.is_none() {
        return blocked(operation, SourceReconciliationBlockedReason::NoBoundSource);
    }
    match save_notebook::handle_reconciled(room, daemon, false, None, source_generation).await {
        NotebookResponse::NotebookSaved {
            path,
            exported_heads,
            save_sequence,
        }
        | NotebookResponse::NotebookAlreadyCurrent {
            path,
            exported_heads,
            save_sequence,
        } => {
            finish_reconciliation(
                room,
                operation,
                path,
                None,
                exported_heads,
                save_sequence,
                source_generation,
            )
            .await
        }
        NotebookResponse::NotebookSaveBlocked { reason, .. } => {
            blocked(operation, map_save_block(reason))
        }
        NotebookResponse::SaveError { error } => blocked(
            operation,
            SourceReconciliationBlockedReason::Io {
                message: format!("overwrite recovered notebook failed: {error:?}"),
            },
        ),
        NotebookResponse::Error { error } => blocked(
            operation,
            SourceReconciliationBlockedReason::Io { message: error },
        ),
        response => blocked(
            operation,
            SourceReconciliationBlockedReason::Io {
                message: format!("unexpected save response during reconciliation: {response:?}"),
            },
        ),
    }
}

async fn archive_and_reload_source(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    source_generation: u64,
) -> NotebookResponse {
    let operation = SourceReconciliationOperation::ArchiveRecoveryAndReloadSource;
    let Some(bound_path) = room.file_binding.path().await else {
        return blocked(operation, SourceReconciliationBlockedReason::NoBoundSource);
    };
    let save_claim = match room.persistence.claim_file_checkpoint() {
        Ok(claim) => claim,
        Err(_) => {
            return blocked(
                operation,
                SourceReconciliationBlockedReason::Save {
                    reason: SaveBlockedReason::SequenceExhausted,
                },
            );
        }
    };
    let save_sequence = save_claim.sequence();
    let execution_store = runtimed_client::execution_store::ExecutionStore::new(
        daemon.config.execution_store_dir.clone(),
    );
    let prepared =
        match prepare_source_reconciliation(room, &bound_path, Some(&execution_store)).await {
            Ok(prepared) => prepared,
            Err(message) => {
                return blocked(
                    operation,
                    SourceReconciliationBlockedReason::InvalidSource { message },
                );
            }
        };

    // Detect a source edit that landed during async blob/asset preparation.
    // No journal state has changed yet, so the owner can retry against the new
    // bytes without losing either side.
    let current_source = match tokio::fs::read(&bound_path).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return blocked(
                operation,
                SourceReconciliationBlockedReason::Io {
                    message: format!("failed to re-read {}: {error}", bound_path.display()),
                },
            );
        }
    };
    let prepared_fingerprint = source_fingerprint(&current_source);
    let saved_at = std::fs::metadata(&bound_path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    let checkpoint_coordinator = room.persistence.file_checkpoint_coordinator();

    let actor = format!("runtimed:reconcile:{}:{save_sequence}", room.id);
    let (applied, archive_directory, archive_warning) = {
        let mut doc = room.doc.write().await;
        let rollback_actor = doc.get_actor_id();
        let rollback_snapshot = doc.save();
        let applied = match apply_prepared_source_reconciliation(&mut doc, &actor, prepared) {
            Ok(applied) => applied,
            Err(message) => {
                if let Ok(restored) =
                    notebook_doc::NotebookDoc::load_with_actor(&rollback_snapshot, &rollback_actor)
                {
                    *doc = restored;
                }
                return blocked(
                    operation,
                    SourceReconciliationBlockedReason::InvalidSource { message },
                );
            }
        };
        if applied.fingerprint != prepared_fingerprint {
            if let Ok(restored) =
                notebook_doc::NotebookDoc::load_with_actor(&rollback_snapshot, &rollback_actor)
            {
                *doc = restored;
            }
            return blocked(
                operation,
                SourceReconciliationBlockedReason::InvalidSource {
                    message: "source changed while reconciliation was being prepared; retry with the new disk revision"
                        .to_string(),
                },
            );
        }
        let checkpoint = FileCheckpoint {
            path: bound_path.clone(),
            exported_heads: applied.heads.iter().map(|head| head.0).collect(),
            file_fingerprint: applied.fingerprint,
            save_sequence,
            saved_at,
        };
        let commit = checkpoint_coordinator.commit_existing_with(save_claim, checkpoint, |_| {
            room.durability
                .archive_and_commit_reconciled_source(
                    &applied.snapshot,
                    applied.heads.iter().map(|head| head.0).collect(),
                    bound_path.clone(),
                    applied.fingerprint,
                    source_generation,
                    applied.change_hashes.iter().map(|hash| hash.0).collect(),
                    save_sequence,
                )
                .map_err(|error| error.to_string())
        });
        match commit {
            Ok(commit) => (
                applied,
                commit.archived_directory,
                commit.archive_durability_warning,
            ),
            Err(FileCheckpointBlockedReason::Superseded { latest_sequence }) => {
                if let Ok(restored) =
                    notebook_doc::NotebookDoc::load_with_actor(&rollback_snapshot, &rollback_actor)
                {
                    *doc = restored;
                }
                return blocked(
                    operation,
                    SourceReconciliationBlockedReason::Save {
                        reason: SaveBlockedReason::Superseded { latest_sequence },
                    },
                );
            }
            Err(error) => {
                if let Ok(restored) =
                    notebook_doc::NotebookDoc::load_with_actor(&rollback_snapshot, &rollback_actor)
                {
                    *doc = restored;
                }
                return blocked(
                    operation,
                    SourceReconciliationBlockedReason::Io {
                        message: format!("failed to commit reconciled source: {error:?}"),
                    },
                );
            }
        }
    };

    if let Some(warning) = archive_warning {
        warn!(
            "[notebook-sync] Reconciliation archive for {} committed with durability warning: {}",
            room.id, warning
        );
    }
    room.persistence.note_disk_content(&applied.source_content);
    *room.persistence.last_save_sources.write().await = applied.loaded_sources.clone();
    let exported_heads = applied
        .heads
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if let Err(error) = apply_reconciled_runtime_sidecars(room, &applied) {
        let reason = format!(
            "reconciled source journal committed, but runtime sidecars failed: {error}; archived recovery remains at {}",
            archive_directory.display()
        );
        warn!(
            "[notebook-sync] Reconciled NotebookDoc committed for {}, but runtime sidecars could not be refreshed: {}",
            room.id, reason
        );
        room.durability.mark_degraded(reason.clone());
        let _ = room.state.with_doc(|state| {
            state.set_file_checkpoint(&exported_heads, save_sequence)?;
            state.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Degraded {
                reason: reason.clone(),
            }))
        });
        let (cell_count, document_heads) = {
            let mut doc = room.doc.write().await;
            (doc.cell_count(), doc.get_heads_hex())
        };
        room.lifecycle.fail_reconciliation(
            source_generation,
            applied.fingerprint,
            cell_count,
            document_heads,
            reason.clone(),
        );
        let _ = room.broadcasts.changed_tx.send(());
        return blocked(
            operation,
            SourceReconciliationBlockedReason::Io { message: reason },
        );
    }

    finish_reconciliation(
        room,
        operation,
        bound_path.to_string_lossy().into_owned(),
        Some(archive_directory.to_string_lossy().into_owned()),
        exported_heads,
        save_sequence,
        source_generation,
    )
    .await
}

async fn finish_reconciliation(
    room: &NotebookRoom,
    operation: SourceReconciliationOperation,
    path: String,
    archived_journal: Option<String>,
    exported_heads: Vec<String>,
    save_sequence: u64,
    source_generation: u64,
) -> NotebookResponse {
    let (cell_count, document_heads) = {
        let mut doc = room.doc.write().await;
        (doc.cell_count(), doc.get_heads_hex())
    };
    let status = match room.durability.commit_source_ready(source_generation) {
        Ok(outcome) => match outcome {
            crate::notebook_sync_server::durability::DurableCommitOutcome::Committed(status)
            | crate::notebook_sync_server::durability::DurableCommitOutcome::AlreadyDurable(
                status,
            ) => status,
        },
        Err(error) => {
            let reason =
                format!("reconciled source data committed, but its Ready marker failed: {error}");
            room.durability.mark_degraded(reason.clone());
            let _ = room.state.with_doc(|state| {
                state.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Degraded {
                    reason: reason.clone(),
                }))
            });
            room.lifecycle.fail_reconciliation(
                source_generation,
                room.durability.status().source_fingerprint,
                cell_count,
                document_heads,
                reason.clone(),
            );
            return blocked(
                operation,
                SourceReconciliationBlockedReason::Io { message: reason },
            );
        }
    };
    // RuntimeStateDoc remains read-only while this projection is updated. The
    // lifecycle transition to Interactive is deliberately last so no mutator
    // can observe a cleared capability gate with a stale conflict marker.
    if let Err(error) = room.state.with_doc(|state| {
        state.set_file_checkpoint(&exported_heads, save_sequence)?;
        state.set_file_source_issue(None)
    }) {
        warn!(
            "[notebook-sync] Source reconciliation committed for {}, but RuntimeStateDoc projection failed: {}",
            room.id, error
        );
    }
    let projection =
        match crate::notebook_sync_server::build_live_notebook_projection_for_generation(
            room,
            source_generation,
        )
        .await
        {
            Ok(projection) => Arc::new(projection),
            Err(error) => {
                let reason = format!(
                "reconciled source data committed, but its projection could not be retained: {error:#}"
            );
                room.durability.mark_degraded(reason.clone());
                let _ = room.state.with_doc(|state| {
                    state.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Degraded {
                        reason: reason.clone(),
                    }))
                });
                room.lifecycle.fail_reconciliation(
                    source_generation,
                    status.source_fingerprint,
                    cell_count,
                    document_heads,
                    reason.clone(),
                );
                return blocked(
                    operation,
                    SourceReconciliationBlockedReason::Io { message: reason },
                );
            }
        };
    room.durability.clear_degraded();
    room.clear_load_failed();
    room.lifecycle.complete_reconciliation(
        source_generation,
        status.source_fingerprint,
        cell_count,
        projection,
        document_heads,
    );
    let _ = room.broadcasts.changed_tx.send(());
    NotebookResponse::NotebookSourceReconciled {
        operation,
        path,
        archived_journal,
        exported_heads,
        save_sequence,
        source_generation,
    }
}

async fn refresh_primary_disk_baseline(room: &NotebookRoom, path: &Path) {
    if let Ok(bytes) = tokio::fs::read(path).await {
        room.persistence.note_disk_content(&bytes);
    }
    let sources = {
        let doc = room.doc.read().await;
        doc.get_cells()
            .into_iter()
            .map(|cell| (cell.id, cell.source))
            .collect()
    };
    *room.persistence.last_save_sources.write().await = sources;
}

fn map_save_block(reason: SaveBlockedReason) -> SourceReconciliationBlockedReason {
    match reason {
        SaveBlockedReason::PathAlreadyOpen { uuid, path } => {
            SourceReconciliationBlockedReason::PathAlreadyOpen { uuid, path }
        }
        reason => SourceReconciliationBlockedReason::Save { reason },
    }
}

fn blocked(
    operation: SourceReconciliationOperation,
    reason: SourceReconciliationBlockedReason,
) -> NotebookResponse {
    NotebookResponse::NotebookSourceReconciliationBlocked { operation, reason }
}
