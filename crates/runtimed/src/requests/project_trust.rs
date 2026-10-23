//! `ApproveProjectTrust` and `DeclineProjectTrust` handlers.
//!
//! Both record a decision for a directory of project files and return. The
//! client launches afterwards, the same way it does after `ApproveTrust`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use runtime_doc::RuntimeLifecycle;
use tracing::{info, warn};

use crate::notebook_sync_server::{
    check_and_update_trust_state, project_file_deps_match_trust_info, NotebookRoom,
};
use crate::project_file::DetectedProjectFile;
use crate::project_trust::{evaluate_for_room, publish_state, validate_trust_target};
use crate::protocol::NotebookResponse;
use crate::trusted_packages::DirectoryDecision;

pub(crate) async fn approve(room: &Arc<NotebookRoom>, directory: String) -> NotebookResponse {
    let manifest = match room_manifest(room).await {
        Ok(manifest) => manifest,
        Err(error) => return NotebookResponse::Error { error },
    };
    let target = match validate_trust_target(Path::new(&directory), &manifest.path) {
        Ok(target) => target,
        Err(error) => return NotebookResponse::Error { error },
    };
    if let Err(error) = room.trusted_packages.set_directory_decision(
        &target,
        DirectoryDecision::Trusted,
        "project_trust_dialog",
    ) {
        warn!(
            "[project-trust] failed to trust {}: {}",
            target.display(),
            error
        );
        return NotebookResponse::Error {
            error: format!("Could not record trusted folder: {error}"),
        };
    }
    info!("[project-trust] trusted {}", target.display());
    clear_session_decline(room, &target);

    reconcile_notebook_trust(room).await;
    refresh_after_decision(room, &manifest);
    NotebookResponse::Ok {}
}

pub(crate) async fn decline(
    room: &Arc<NotebookRoom>,
    directory: String,
    remember: bool,
) -> NotebookResponse {
    let manifest = match room_manifest(room).await {
        Ok(manifest) => manifest,
        Err(error) => return NotebookResponse::Error { error },
    };
    let target = match validate_trust_target(Path::new(&directory), &manifest.path) {
        Ok(target) => target,
        Err(error) => return NotebookResponse::Error { error },
    };
    if remember {
        if let Err(error) = room.trusted_packages.set_directory_decision(
            &target,
            DirectoryDecision::NotebookEnv,
            "project_trust_dialog",
        ) {
            return NotebookResponse::Error {
                error: format!("Could not record folder choice: {error}"),
            };
        }
    } else if let Ok(mut guard) = room.project_trust_session_decline.lock() {
        *guard = Some(target.clone());
    }
    info!(
        "[project-trust] using notebook environment for {} (remember: {})",
        target.display(),
        remember
    );
    refresh_after_decision(room, &manifest);
    NotebookResponse::Ok {}
}

/// The project file the room's trust prompt is about.
///
/// Prefers the manifest the gate parked on, so approval covers exactly what
/// the user reviewed. Falls back to detection from the notebook path or
/// working directory.
async fn room_manifest(room: &NotebookRoom) -> Result<DetectedProjectFile, String> {
    let parked = room
        .state
        .with_doc(|sd| Ok(sd.project_trust()))
        .unwrap_or_default();
    if !parked.manifest_path.is_empty() {
        let path = PathBuf::from(&parked.manifest_path);
        let kind = match parked.kind.as_str() {
            "pyproject_toml" => Some(crate::project_file::ProjectFileKind::PyprojectToml),
            "pixi_toml" => Some(crate::project_file::ProjectFileKind::PixiToml),
            "environment_yml" => Some(crate::project_file::ProjectFileKind::EnvironmentYml),
            _ => None,
        };
        if let (true, Some(kind)) = (path.is_file(), kind) {
            return Ok(DetectedProjectFile { path, kind });
        }
    }

    let notebook_path = room.file_binding.path().await;
    let working_dir = room.identity.working_dir.read().await.clone();
    notebook_path
        .as_ref()
        .or(working_dir.as_ref())
        .and_then(|path| crate::project_file::detect_project_file(path))
        .ok_or_else(|| "No project file found for this notebook".to_string())
}

fn clear_session_decline(room: &NotebookRoom, trusted: &Path) {
    if let Ok(mut guard) = room.project_trust_session_decline.lock() {
        if guard
            .as_deref()
            .is_some_and(|declined| declined.starts_with(trusted) || trusted.starts_with(declined))
        {
            *guard = None;
        }
    }
}

/// Heal notebook dependency trust for notebooks whose inline deps mirror a
/// now-trusted project file. Mirrors the room-open reconciliation.
async fn reconcile_notebook_trust(room: &NotebookRoom) {
    let Some(notebook_path) = room.file_binding.path().await else {
        return;
    };
    let info = {
        let state = room.trust_state.read().await;
        if !matches!(state.status, runt_trust::TrustStatus::Untrusted) {
            return;
        }
        state.info.clone()
    };
    if !project_file_deps_match_trust_info(&notebook_path, &info) {
        return;
    }
    if let Err(error) = room.trusted_packages.add_from_info(&info, "project_file") {
        warn!(
            "[project-trust] could not seed notebook deps from trusted project: {}",
            error
        );
        return;
    }
    let _ = room.broadcasts.changed_tx.send(());
    check_and_update_trust_state(room).await;
}

/// Republish project trust and release a parked lifecycle so the client can
/// launch.
fn refresh_after_decision(room: &NotebookRoom, manifest: &DetectedProjectFile) {
    let eval = evaluate_for_room(room, manifest);
    publish_state(room, &eval.state);
    if let Err(error) = room.state.with_doc(|sd| {
        if sd.read_state().kernel.lifecycle == RuntimeLifecycle::AwaitingProjectTrust {
            sd.set_lifecycle(&RuntimeLifecycle::NotStarted)?;
        }
        Ok(())
    }) {
        warn!("[runtime-state] {}", error);
    }
}
