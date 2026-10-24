//! `ApproveProjectTrust` and `DeclineProjectTrust` handlers.
//!
//! Both record a decision for a directory of project files and return. The
//! client launches afterwards, the same way it does after `ApproveTrust`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use runtime_doc::RuntimeLifecycle;
use tracing::{info, warn};

use crate::notebook_sync_server::{check_and_update_trust_state, NotebookRoom};
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

    reconcile_notebook_trust(room, &manifest).await;
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
/// Detection runs from the room's current binding (or working directory),
/// so a notebook saved into another folder after the prompt was parked is
/// judged against the folder it lives in now. The parked manifest is used
/// only when it is still that file; a stale prompt for another folder fails
/// `validate_trust_target` and the client re-prompts on the next launch.
async fn room_manifest(room: &NotebookRoom) -> Result<DetectedProjectFile, String> {
    let notebook_path = room.file_binding.path().await;
    let working_dir = room.identity.working_dir.read().await.clone();
    let current = notebook_path
        .as_ref()
        .or(working_dir.as_ref())
        .and_then(|path| crate::project_file::detect_project_file(path))
        .ok_or_else(|| "No project file found for this notebook".to_string())?;

    let parked = room
        .state
        .with_doc(|sd| Ok(sd.project_trust()))
        .unwrap_or_default();
    if parked.manifest_path.is_empty() {
        return Ok(current);
    }
    let parked_path = PathBuf::from(&parked.manifest_path);
    let same = match (
        std::fs::canonicalize(&parked_path),
        std::fs::canonicalize(&current.path),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same {
        return Ok(DetectedProjectFile {
            path: parked_path,
            kind: current.kind,
        });
    }
    warn!(
        "[project-trust] parked prompt was for {} but the notebook now resolves to {}",
        parked.manifest_path,
        current.path.display()
    );
    Ok(current)
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

/// Heal notebook dependency trust for a notebook whose inline deps mirror
/// the project file that was just approved. Only the dependency slice the
/// manifest covers is seeded; see `project_trust::reconcilable_trust_info`.
async fn reconcile_notebook_trust(room: &NotebookRoom, approved: &DetectedProjectFile) {
    let Some(notebook_path) = room.file_binding.path().await else {
        return;
    };
    let covered = {
        let state = room.trust_state.read().await;
        crate::project_trust::reconcilable_trust_info(
            &room.trusted_packages,
            &notebook_path,
            Some(approved),
            &state,
        )
    };
    let Some(covered) = covered else {
        return;
    };
    if let Err(error) = room
        .trusted_packages
        .add_from_info(&covered, "project_file")
    {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob_store::BlobStore;
    use crate::notebook_sync_server::verify_trust_from_file;
    use crate::trusted_packages::TrustedPackageStore;
    use serde_json::json;

    fn room(
        temp: &Path,
        project: &Path,
        metadata: serde_json::Value,
        source: &str,
    ) -> Arc<NotebookRoom> {
        let path = project.join("test.ipynb");
        std::fs::write(&path, json!({
            "nbformat": 4, "nbformat_minor": 5,
            "metadata": metadata,
            "cells": [{"cell_type":"code", "id":"test", "metadata":{}, "source":source, "outputs":[], "execution_count":null}]
        }).to_string()).unwrap();
        Arc::new(
            NotebookRoom::new_fresh_with_trusted_packages(
                uuid::Uuid::new_v4(),
                Some(path),
                temp,
                Arc::new(BlobStore::new(temp.join("blobs"))),
                false,
                TrustedPackageStore::open(temp.join("trust.sqlite")).unwrap(),
            )
            .unwrap(),
        )
    }

    fn pyproject(directory: &Path, dependency: &str) {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(
            directory.join("pyproject.toml"),
            format!("[project]\nname = 'test'\nversion = '1'\ndependencies = ['{dependency}']\n"),
        )
        .unwrap();
    }

    fn conda_project(directory: &Path) {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(
            directory.join("environment.yml"),
            "name: test\nchannels:\n  - conda-forge\ndependencies:\n  - numpy\n",
        )
        .unwrap();
    }

    #[tokio::test]
    async fn stale_folder_prompt_after_save_as_cannot_approve_new_folder_dependencies() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        pyproject(&first, "pandas");
        pyproject(&second, "unreviewed");
        let room = room(
            temp.path(),
            &first,
            json!({"runt":{"uv":{"dependencies":["pandas"]}}}),
            "",
        );
        let original = crate::project_file::detect_project_file(&first).unwrap();
        crate::project_trust::require_for_launch(&room, Some(&original));
        let new_path = second.join("saved.ipynb");
        std::fs::write(&new_path, json!({"nbformat":4,"nbformat_minor":5,"cells":[],"metadata":{"runt":{"uv":{"dependencies":["unreviewed"]}}}}).to_string()).unwrap();
        room.file_binding
            .set_path_for_test(Some(new_path.clone()))
            .await;
        *room.trust_state.write().await = verify_trust_from_file(&new_path, &room.trusted_packages);

        assert!(matches!(
            approve(&room, first.to_string_lossy().into_owned()).await,
            NotebookResponse::Error { .. }
        ));
        assert!(room
            .trusted_packages
            .directory_decision_for(&first)
            .unwrap()
            .is_none());
        assert!(room
            .trusted_packages
            .directory_decision_for(&second)
            .unwrap()
            .is_none());
        assert!(!room
            .trusted_packages
            .all_dependencies_approved(&room.trust_state.read().await.info)
            .unwrap());

        // Even if Save As races after the old folder was approved, its
        // reconciliation cannot borrow that approval for the new binding.
        room.trusted_packages
            .set_directory_decision(&first, DirectoryDecision::Trusted, "test")
            .unwrap();
        reconcile_notebook_trust(&room, &original).await;
        assert!(!room
            .trusted_packages
            .all_dependencies_approved(&room.trust_state.read().await.info)
            .unwrap());
    }

    #[tokio::test]
    async fn approved_current_folder_reconciles_matching_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        pyproject(&project, "pandas");
        let room = room(
            temp.path(),
            &project,
            json!({"runt":{"uv":{"dependencies":["pandas"]}}}),
            "",
        );
        assert!(matches!(
            approve(&room, project.to_string_lossy().into_owned()).await,
            NotebookResponse::Ok {}
        ));
        assert!(room
            .trusted_packages
            .all_dependencies_approved(&room.trust_state.read().await.info)
            .unwrap());
    }

    #[tokio::test]
    async fn conda_folder_approval_does_not_approve_pep723_code() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        conda_project(&project);
        let room = room(temp.path(), &project, json!({"runt":{"conda":{"dependencies":["numpy"],"channels":["conda-forge"]}}}), "# /// script\n# dependencies = ['payload @ https://example.test/payload.tar.gz']\n# ///\n");
        assert!(!room.trust_state.read().await.pep723_dependencies.is_empty());
        assert!(matches!(
            approve(&room, project.to_string_lossy().into_owned()).await,
            NotebookResponse::Ok {}
        ));
        let mut pep_only = room.trust_state.read().await.info.clone();
        pep_only.conda_dependencies.clear();
        pep_only.conda_channels.clear();
        assert!(!pep_only.uv_dependencies.is_empty());
        assert!(!room
            .trusted_packages
            .all_dependencies_approved(&pep_only)
            .unwrap());
    }

    #[tokio::test]
    async fn conda_reconciliation_seeds_only_manifest_dependencies() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        conda_project(&project);
        let room = room(
            temp.path(),
            &project,
            json!({"runt":{"conda":{"dependencies":["numpy"],"channels":["conda-forge"]},"uv":{"dependencies":["unreviewed @ https://example.test/unreviewed.whl"]}}}),
            "",
        );
        assert!(matches!(
            approve(&room, project.to_string_lossy().into_owned()).await,
            NotebookResponse::Ok {}
        ));
        let state = room.trust_state.read().await;
        assert!(!room
            .trusted_packages
            .all_dependencies_approved(&state.info)
            .unwrap());
        let mut conda_only = state.info.clone();
        conda_only.uv_dependencies.clear();
        assert!(room
            .trusted_packages
            .all_dependencies_approved(&conda_only)
            .unwrap());
    }

    #[tokio::test]
    async fn legacy_approval_rejects_an_unrelated_environment_file() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let unrelated = temp.path().join("unrelated");
        conda_project(&project);
        conda_project(&unrelated);
        let room = room(temp.path(), &project, json!({}), "");
        let response = crate::requests::approve_project_environment::handle(
            &room,
            Some(
                unrelated
                    .join("environment.yml")
                    .to_string_lossy()
                    .into_owned(),
            ),
        )
        .await;
        assert!(matches!(response, NotebookResponse::Error { .. }));
        assert!(room
            .trusted_packages
            .directory_decision_for(&unrelated)
            .unwrap()
            .is_none());
        assert!(room
            .trusted_packages
            .directory_decision_for(&project)
            .unwrap()
            .is_none());
        // Legacy "build environment" consent cannot silently become
        // persistent subtree trust, even for the current manifest.
        assert!(matches!(
            crate::requests::approve_project_environment::handle(&room, None).await,
            NotebookResponse::Error { .. }
        ));
        assert!(room
            .trusted_packages
            .directory_decision_for(&project)
            .unwrap()
            .is_none());
        assert_eq!(
            room.state
                .with_doc(|sd| Ok(sd.read_state().kernel.lifecycle))
                .unwrap(),
            RuntimeLifecycle::AwaitingProjectTrust,
            "a stale build dialog must hand off to the explicit folder prompt",
        );
        assert!(matches!(
            approve(&room, project.to_string_lossy().into_owned()).await,
            NotebookResponse::Ok {}
        ));
        assert!(matches!(
            crate::requests::approve_project_environment::handle(
                &room,
                Some(
                    project
                        .join("environment.yml")
                        .to_string_lossy()
                        .into_owned()
                )
            )
            .await,
            NotebookResponse::Ok {}
        ));
    }
}
