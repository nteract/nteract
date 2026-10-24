//! `NotebookRequest::ApproveProjectEnvironment` handler.
//!
//! Clients that predate project-directory trust send this from the
//! environment.yml build dialog. This approves the file's packages only;
//! persistent folder trust must already have been granted through the
//! explicit project-folder dialog. Building one environment is not consent
//! to trust every future project file in its directory.

use std::path::PathBuf;

use crate::notebook_sync_server::{
    check_and_update_trust_state, environment_yml_trust_info, NotebookRoom,
};
use crate::protocol::NotebookResponse;
use tracing::warn;

pub(crate) async fn handle(
    room: &NotebookRoom,
    project_file_path: Option<String>,
) -> NotebookResponse {
    let detected = match resolve_project_file(room, project_file_path).await {
        Ok(detected) => detected,
        Err(error) => return NotebookResponse::Error { error },
    };

    let trust_info = match detected.kind {
        crate::project_file::ProjectFileKind::EnvironmentYml => {
            let config = match crate::project_file::parse_environment_yml(&detected.path) {
                Ok(config) => config,
                Err(error) => return NotebookResponse::Error { error },
            };
            environment_yml_trust_info(&config)
        }
        _ => {
            return NotebookResponse::Error {
                error: "Project environment approval is only supported for environment.yml"
                    .to_string(),
            };
        }
    };

    let target = match detected
        .path
        .parent()
        .ok_or_else(|| "Project file has no directory".to_string())
        .and_then(|directory| {
            crate::project_trust::validate_trust_target(directory, &detected.path)
        }) {
        Ok(target) => target,
        Err(error) => return NotebookResponse::Error { error },
    };
    if !matches!(
        crate::project_trust::require_for_launch(room, Some(&detected)),
        crate::project_trust::RoomProjectGate::Trusted(_),
    ) {
        return NotebookResponse::Error {
            error: format!(
                "Trust the project folder {} before building its environment",
                target.display()
            ),
        };
    }

    if let Err(error) = room
        .trusted_packages
        .add_from_info(&trust_info, "project_env_dialog")
    {
        warn!(
            "[trusted-packages] Failed to approve project environment {:?}: {}",
            detected.path, error
        );
        return NotebookResponse::Error {
            error: format!("Failed to approve project environment: {}", error),
        };
    }

    // Re-evaluate and broadcast trust immediately (MSL-1), like the other
    // approval entry points (`ApproveTrust`, `seed_trust_from_doc_metadata`).
    // Without this the verdict only updates after the next sync-driving
    // action, so the dialog appears stuck on the stale Untrusted state.
    let _ = room.broadcasts.changed_tx.send(());
    check_and_update_trust_state(room).await;

    NotebookResponse::Ok {}
}

async fn resolve_project_file(
    room: &NotebookRoom,
    project_file_path: Option<String>,
) -> Result<crate::project_file::DetectedProjectFile, String> {
    let notebook_path = room.file_binding.path().await;
    let working_dir = room.identity.working_dir.read().await.clone();
    let detection_path = notebook_path.as_ref().or(working_dir.as_ref());
    let Some(path) = detection_path else {
        return Err(
            "No notebook path or working directory for project environment approval".into(),
        );
    };
    let detected = crate::project_file::find_nearest_project_file(
        path,
        &[crate::project_file::ProjectFileKind::EnvironmentYml],
    )
    .ok_or_else(|| "No environment.yml found for project environment approval".to_string())?;
    if let Some(requested) = project_file_path {
        let requested = std::fs::canonicalize(PathBuf::from(requested))
            .map_err(|error| format!("Cannot resolve project environment: {error}"))?;
        let current = std::fs::canonicalize(&detected.path)
            .map_err(|error| format!("Cannot resolve current project environment: {error}"))?;
        if requested != current {
            return Err(
                "Project environment changed; review the current notebook folder again".into(),
            );
        }
    }
    Ok(detected)
}
