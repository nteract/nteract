//! `ApproveProjectTrust` and `DeclineProjectTrust` handlers.
//!
//! Both record a decision for a directory of project files and return. The
//! client launches afterwards, the same way it does after `ApproveTrust`.

use std::path::Path;
use std::sync::Arc;

use runtime_doc::RuntimeLifecycle;
use tracing::{info, warn};

use crate::notebook_sync_server::{check_and_update_trust_state, NotebookRoom};
use crate::project_file::DetectedProjectFile;
use crate::project_trust::{evaluate_for_room, validate_trust_target};
use crate::protocol::NotebookResponse;
use crate::trusted_packages::DirectoryDecision;

pub(crate) async fn approve(room: &Arc<NotebookRoom>, directory: String) -> NotebookResponse {
    let target_context = match room_manifest(room).await {
        Ok(context) => context,
        Err(error) => return NotebookResponse::Error { error },
    };
    let manifest = &target_context.manifest;
    let target = match with_current_context(room, &target_context, || {
        let target = validate_trust_target(Path::new(&directory), &manifest.path)?;
        room.trusted_packages
            .set_directory_decision(&target, DirectoryDecision::Trusted, "project_trust_dialog")
            .map_err(|error| format!("Could not record trusted folder: {error}"))?;
        clear_session_decline(room, &target);
        Ok(target)
    }) {
        Ok(target) => target,
        Err(error) => return NotebookResponse::Error { error },
    };
    info!("[project-trust] trusted {}", target.display());

    reconcile_notebook_trust(room, manifest).await;
    refresh_after_decision(room, &target_context);
    NotebookResponse::Ok {}
}

pub(crate) async fn decline(
    room: &Arc<NotebookRoom>,
    directory: String,
    remember: bool,
) -> NotebookResponse {
    let target_context = match room_manifest(room).await {
        Ok(context) => context,
        Err(error) => return NotebookResponse::Error { error },
    };
    let manifest = &target_context.manifest;
    let target = match with_current_context(room, &target_context, || {
        let target = validate_trust_target(Path::new(&directory), &manifest.path)?;
        if remember {
            room.trusted_packages
                .set_directory_decision(
                    &target,
                    DirectoryDecision::NotebookEnv,
                    "project_trust_dialog",
                )
                .map_err(|error| format!("Could not record folder choice: {error}"))?;
        } else if let Ok(mut guard) = room.project_trust_session_decline.lock() {
            *guard = Some(target.clone());
        }
        Ok(target)
    }) {
        Ok(target) => target,
        Err(error) => return NotebookResponse::Error { error },
    };
    info!(
        "[project-trust] using notebook environment for {} (remember: {})",
        target.display(),
        remember
    );
    refresh_after_decision(room, &target_context);
    NotebookResponse::Ok {}
}

struct ProjectTrustApprovalContext {
    manifest: DetectedProjectFile,
    revision: u64,
    identity_revision: u64,
}

/// Serialize the decision with binding changes and replacement prompts. The
/// store write is synchronous; reconciliation below may yield and is guarded
/// separately before it republishes the projection.
fn with_current_context<T>(
    room: &NotebookRoom,
    context: &ProjectTrustApprovalContext,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let prompt = room
        .project_trust_prompt
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if prompt.revision != context.revision || prompt.identity_revision != context.identity_revision
    {
        return Err("Notebook context changed; review project trust again".to_string());
    }
    action()
}

/// Resolve from the current room or the still-current explicit launch input.
/// The caller's approval directory is never a project-discovery input.
async fn room_manifest(room: &NotebookRoom) -> Result<ProjectTrustApprovalContext, String> {
    let identity_revision = room
        .project_trust_prompt
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .identity_revision;
    let notebook_path = room.file_binding.path().await;
    let working_dir = room.identity.working_dir.read().await.clone();
    let prompt = room
        .project_trust_prompt
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if prompt.identity_revision != identity_revision {
        return Err("Notebook context changed; review project trust again".to_string());
    }
    let state = room
        .state
        .read(|sd| sd.read_state())
        .map_err(|error| error.to_string())?;
    let launch_context = prompt.launch_context.as_ref().filter(|context| {
        state.kernel.lifecycle == RuntimeLifecycle::AwaitingProjectTrust
            && context.identity_revision == identity_revision
    });
    let current = if let Some(context) = launch_context {
        crate::project_trust::manifest_for_env_source(
            &context.env_source,
            None,
            Some(&context.anchor),
        )
    } else {
        notebook_path
            .as_ref()
            .or(working_dir.as_ref())
            .and_then(|path| crate::project_file::detect_project_file(path))
    }
    .ok_or_else(|| "No project file found for this notebook".to_string())?;
    Ok(ProjectTrustApprovalContext {
        manifest: current,
        revision: prompt.revision,
        identity_revision,
    })
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
fn refresh_after_decision(room: &NotebookRoom, context: &ProjectTrustApprovalContext) {
    // A newer prompt or room move does not belong to this approval.
    let mut prompt = room
        .project_trust_prompt
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if prompt.revision != context.revision || prompt.identity_revision != context.identity_revision
    {
        return;
    }
    let eval = evaluate_for_room(room, &context.manifest);
    if let Err(error) = room.state.with_doc(|sd| {
        sd.set_project_trust(&eval.state)?;
        if sd.read_state().kernel.lifecycle == RuntimeLifecycle::AwaitingProjectTrust {
            sd.set_lifecycle(&RuntimeLifecycle::NotStarted)?;
        }
        Ok(())
    }) {
        warn!("[runtime-state] {}", error);
    } else {
        prompt.replace(None);
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

    fn launch_context(
        room: &NotebookRoom,
        anchor: &Path,
    ) -> crate::project_trust::ProjectTrustLaunchContext {
        crate::project_trust::ProjectTrustLaunchContext {
            anchor: anchor.to_path_buf(),
            env_source: notebook_protocol::connection::EnvSource::Pyproject,
            identity_revision: room.project_trust_prompt.lock().unwrap().identity_revision,
        }
    }

    fn park_override(room: &NotebookRoom, anchor: &Path) {
        let manifest = crate::project_file::detect_project_file(anchor).unwrap();
        assert!(matches!(
            crate::project_trust::require_for_launch_in_context(
                room,
                Some(&manifest),
                Some(launch_context(room, anchor)),
            ),
            crate::project_trust::RoomProjectGate::Parked
        ));
    }

    #[tokio::test]
    async fn explicit_launch_path_approval_preserves_notebook_binding_and_package_trust() {
        for untitled in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let bound = temp.path().join("bound");
            let project = temp.path().join("override");
            pyproject(&bound, "pandas");
            pyproject(&project, "pandas");
            let room = room(
                temp.path(),
                &bound,
                json!({"runt":{"uv":{"dependencies":["pandas"]}}}),
                "# /// script\n# dependencies = ['pandas']\n# ///\n",
            );
            if untitled {
                crate::notebook_sync_server::NotebookFileBinding::set_path_for_test(&room, None)
                    .await;
            }
            let binding = room.file_binding.path().await;
            park_override(&room, &project);
            assert!(matches!(
                approve(&room, project.to_string_lossy().into_owned()).await,
                NotebookResponse::Ok {}
            ));
            assert_eq!(room.file_binding.path().await, binding);
            assert!(room
                .trusted_packages
                .directory_decision_for(&project)
                .unwrap()
                .is_some());
            assert!(room
                .trusted_packages
                .directory_decision_for(&bound)
                .unwrap()
                .is_none());
            assert_no_project_package_approval(&room);
            assert_eq!(
                room.state
                    .read(|sd| sd.read_state().kernel.lifecycle)
                    .unwrap(),
                RuntimeLifecycle::NotStarted
            );
            let manifest = crate::project_file::detect_project_file(&project).unwrap();
            assert!(matches!(
                crate::project_trust::require_for_launch_in_context(
                    &room,
                    Some(&manifest),
                    Some(launch_context(&room, &project))
                ),
                crate::project_trust::RoomProjectGate::Trusted(_)
            ));
        }
    }

    #[tokio::test]
    async fn explicit_launch_path_decline_uses_the_requested_project() {
        let temp = tempfile::tempdir().unwrap();
        let bound = temp.path().join("bound");
        let project = temp.path().join("override");
        pyproject(&bound, "pandas");
        pyproject(&project, "other");
        let room = room(temp.path(), &bound, json!({}), "");
        park_override(&room, &project);
        assert!(matches!(
            decline(&room, project.to_string_lossy().into_owned(), true).await,
            NotebookResponse::Ok {}
        ));
        assert_eq!(
            room.trusted_packages
                .directory_decision_for(&project)
                .unwrap()
                .unwrap()
                .decision,
            DirectoryDecision::NotebookEnv
        );
        assert!(room
            .trusted_packages
            .directory_decision_for(&bound)
            .unwrap()
            .is_none());
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::NotStarted
        );
    }

    #[tokio::test]
    async fn room_identity_changes_invalidate_explicit_launch_approval() {
        for change_binding in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let first = temp.path().join("first");
            let second = temp.path().join("second");
            pyproject(&first, "pandas");
            pyproject(&second, "other");
            let room = room(temp.path(), &first, json!({}), "");
            if !change_binding {
                crate::notebook_sync_server::NotebookFileBinding::set_path_for_test(&room, None)
                    .await;
                room.set_working_dir(Some(first.clone())).await;
            }
            park_override(&room, &first);
            if change_binding {
                crate::notebook_sync_server::NotebookFileBinding::set_path_for_test(
                    &room,
                    Some(second.join("moved.ipynb")),
                )
                .await;
            } else {
                room.set_working_dir(Some(second.clone())).await;
            }
            assert!(matches!(
                approve(&room, first.to_string_lossy().into_owned()).await,
                NotebookResponse::Error { .. }
            ));
            for directory in [&first, &second] {
                assert!(room
                    .trusted_packages
                    .directory_decision_for(directory)
                    .unwrap()
                    .is_none());
            }
            assert_no_project_package_approval(&room);
        }
    }

    #[tokio::test]
    async fn a_replacement_launch_replaces_the_explicit_approval_context() {
        for explicit in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let first = temp.path().join("first");
            let second = temp.path().join("second");
            pyproject(&first, "pandas");
            pyproject(&second, "other");
            let room = room(temp.path(), &second, json!({}), "");
            park_override(&room, &first);
            if explicit {
                park_override(&room, &second);
            } else {
                // Auto-launch and the legacy environment-build gate must not
                // inherit a preceding manual override.
                let manifest = crate::project_file::detect_project_file(&second).unwrap();
                crate::project_trust::require_for_launch(&room, Some(&manifest));
            }
            assert!(matches!(
                approve(&room, first.to_string_lossy().into_owned()).await,
                NotebookResponse::Error { .. }
            ));
            assert!(matches!(
                approve(&room, second.to_string_lossy().into_owned()).await,
                NotebookResponse::Ok {}
            ));
            assert!(room
                .trusted_packages
                .directory_decision_for(&first)
                .unwrap()
                .is_none());
        }
    }

    #[tokio::test]
    async fn a_launch_cannot_park_after_its_captured_room_identity_changes() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        pyproject(&first, "pandas");
        pyproject(&second, "other");
        let room = room(temp.path(), &first, json!({}), "");
        let context = launch_context(&room, &first);
        let manifest = crate::project_file::detect_project_file(&first).unwrap();
        // Deterministically order the otherwise concurrent Save As ahead of
        // publication. Both identity change and park share the prompt mutex.
        crate::notebook_sync_server::NotebookFileBinding::set_path_for_test(
            &room,
            Some(second.join("moved.ipynb")),
        )
        .await;
        park_override(&room, &second);
        let state = room.state.read(|sd| sd.read_state().project_trust).unwrap();
        assert!(matches!(
            crate::project_trust::require_for_launch_in_context(
                &room,
                Some(&manifest),
                Some(context)
            ),
            crate::project_trust::RoomProjectGate::ContextChanged
        ));
        assert_eq!(
            room.state.read(|sd| sd.read_state().project_trust).unwrap(),
            state
        );
        assert_eq!(
            room_manifest(&room)
                .await
                .unwrap()
                .manifest
                .path
                .canonicalize()
                .unwrap(),
            second.join("pyproject.toml").canonicalize().unwrap()
        );
    }

    #[tokio::test]
    async fn cancelled_launch_cannot_install_an_approval_context() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        pyproject(&project, "pandas");
        let room = room(temp.path(), &project, json!({}), "");
        let crate::notebook_sync_server::ManualLaunchAdmission::Admitted(attempt) =
            room.try_begin_manual_launch()
        else {
            panic!("launch was not admitted")
        };
        room.cancel_in_flight_launch().unwrap();
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Shutdown))
            .unwrap();
        park_override(&room, &project);
        assert!(room
            .project_trust_prompt
            .lock()
            .unwrap()
            .launch_context
            .is_none());
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Shutdown
        );
        attempt.finish_cancelled();
    }

    #[tokio::test]
    async fn late_approval_refresh_cannot_replace_a_newer_prompt() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        pyproject(&first, "pandas");
        pyproject(&second, "other");
        let room = room(temp.path(), &first, json!({}), "");
        park_override(&room, &first);
        let old_context = room_manifest(&room).await.unwrap();
        park_override(&room, &second);
        assert!(with_current_context::<()>(&room, &old_context, || {
            panic!("a superseded approval must not record a directory decision")
        })
        .is_err());
        refresh_after_decision(&room, &old_context);
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::AwaitingProjectTrust
        );
        assert_eq!(
            room_manifest(&room)
                .await
                .unwrap()
                .manifest
                .path
                .canonicalize()
                .unwrap(),
            second.join("pyproject.toml").canonicalize().unwrap()
        );
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
        crate::notebook_sync_server::NotebookFileBinding::set_path_for_test(
            room.as_ref(),
            Some(new_path.clone()),
        )
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

    fn assert_no_project_package_approval(room: &NotebookRoom) {
        let mut info = runt_trust::extract_trust_info(&std::collections::HashMap::from([(
            "runt".to_string(),
            json!({"uv":{"dependencies":["pandas", "unreviewed"]}}),
        )]));
        room.trusted_packages.enrich_info(&mut info).unwrap();
        assert!(info.approved_uv_dependencies.is_empty());
    }

    async fn finish_rebind_watchers(room: &Arc<NotebookRoom>, path: &Path) {
        room.file_binding.shutdown_project_file_watcher().await;
        room.file_binding.shutdown_notebook_watcher().await;
        crate::notebook_sync_server::shutdown_autosave_debouncer(
            room,
            &path.to_string_lossy(),
            std::time::Duration::from_secs(1),
        )
        .await;
    }

    #[tokio::test]
    async fn save_as_refreshes_the_parked_prompt_without_approving_either_folder() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        pyproject(&first, "pandas");
        pyproject(&second, "unreviewed");
        let room = room(temp.path(), &first, json!({}), "");
        let original = crate::project_file::detect_project_file(&first).unwrap();
        crate::project_trust::require_for_launch(&room, Some(&original));
        let new_path = second.join("moved.ipynb");
        std::fs::copy(first.join("test.ipynb"), &new_path).unwrap();
        crate::notebook_sync_server::NotebookFileBinding::rebind_after_save_as(
            &room,
            new_path.clone(),
        )
        .await;
        finish_rebind_watchers(&room, &new_path).await;

        let state = room.state.read(|sd| sd.read_state()).unwrap();
        assert_eq!(
            state.kernel.lifecycle,
            RuntimeLifecycle::AwaitingProjectTrust
        );
        assert_eq!(
            Path::new(&state.project_trust.manifest_path),
            second.join("pyproject.toml").canonicalize().unwrap()
        );
        assert!(state.project_trust.needs_approval);
        assert!(matches!(
            approve(&room, first.to_string_lossy().into_owned()).await,
            NotebookResponse::Error { .. }
        ));
        // The old native prompt can still submit its captured A path. Its
        // rejection must leave every peer's shared prompt pointing at B.
        let state = room.state.read(|sd| sd.read_state()).unwrap();
        assert_eq!(
            Path::new(&state.project_trust.manifest_path),
            second.join("pyproject.toml").canonicalize().unwrap()
        );
        for directory in [&first, &second] {
            assert!(room
                .trusted_packages
                .directory_decision_for(directory)
                .unwrap()
                .is_none());
        }
        assert_no_project_package_approval(&room);

        assert!(matches!(
            approve(&room, second.to_string_lossy().into_owned()).await,
            NotebookResponse::Ok {}
        ));
        let state = room.state.read(|sd| sd.read_state()).unwrap();
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::NotStarted);
        assert!(!state.project_trust.needs_approval);
    }

    #[tokio::test]
    async fn save_as_releases_a_project_prompt_when_the_new_context_needs_no_approval() {
        use notebook_protocol::connection::CreateNotebookEnvironmentMode;
        for case in [
            "no-manifest",
            "trusted",
            "notebook-mode",
            "deno",
            "declined",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let first = temp.path().join("first");
            let second = temp.path().join("second");
            pyproject(&first, "pandas");
            std::fs::create_dir_all(&second).unwrap();
            if case != "no-manifest" {
                pyproject(&second, "unreviewed");
            }
            let room = room(temp.path(), &first, json!({}), "");
            let original = crate::project_file::detect_project_file(&first).unwrap();
            crate::project_trust::require_for_launch(&room, Some(&original));
            if case == "trusted" || case == "declined" {
                room.trusted_packages
                    .set_directory_decision(
                        &second,
                        if case == "trusted" {
                            DirectoryDecision::Trusted
                        } else {
                            DirectoryDecision::NotebookEnv
                        },
                        "test",
                    )
                    .unwrap();
            }
            if case == "notebook-mode" {
                *room.identity.environment_mode.write().await =
                    CreateNotebookEnvironmentMode::Notebook;
            }
            let new_path = second.join("moved.ipynb");
            let metadata = if case == "deno" {
                json!({"kernelspec":{"name":"deno","display_name":"Deno","language":"typescript"}})
            } else {
                json!({})
            };
            if case == "deno" {
                let mut doc = room.doc.write().await;
                doc.set_metadata_value("kernelspec", &metadata["kernelspec"])
                    .unwrap();
                assert_eq!(doc.detect_runtime().as_deref(), Some("deno"));
            }
            std::fs::write(
                &new_path,
                json!({"nbformat":4,"nbformat_minor":5,"metadata":metadata,"cells":[]}).to_string(),
            )
            .unwrap();
            crate::notebook_sync_server::NotebookFileBinding::rebind_after_save_as(
                &room,
                new_path.clone(),
            )
            .await;
            finish_rebind_watchers(&room, &new_path).await;
            let state = room.state.read(|sd| sd.read_state()).unwrap();
            assert_eq!(
                state.kernel.lifecycle,
                RuntimeLifecycle::NotStarted,
                "{case}"
            );
            assert!(!state.project_trust.needs_approval, "{case}");
            if matches!(case, "no-manifest" | "notebook-mode" | "deno") {
                assert!(state.project_trust.manifest_path.is_empty(), "{case}");
            }
            assert_no_project_package_approval(&room);
        }
    }

    #[tokio::test]
    async fn path_refresh_does_not_reset_a_running_or_starting_kernel() {
        for lifecycle in [
            RuntimeLifecycle::Running(runtime_doc::KernelActivity::Idle),
            RuntimeLifecycle::Resolving,
            RuntimeLifecycle::PreparingEnv,
            RuntimeLifecycle::Launching,
            RuntimeLifecycle::Connecting,
        ] {
            let temp = tempfile::tempdir().unwrap();
            let first = temp.path().join("first");
            let second = temp.path().join("second");
            pyproject(&first, "pandas");
            pyproject(&second, "unreviewed");
            let room = room(temp.path(), &first, json!({}), "");
            let original = crate::project_file::detect_project_file(&first).unwrap();
            crate::project_trust::require_for_launch(&room, Some(&original));
            room.state
                .with_doc(|sd| sd.set_lifecycle(&lifecycle))
                .unwrap();
            let new_path = second.join("moved.ipynb");
            crate::notebook_sync_server::NotebookFileBinding::set_runtime_path(&room, &new_path)
                .await;
            let state = room.state.read(|sd| sd.read_state()).unwrap();
            assert_eq!(state.kernel.lifecycle, lifecycle);
            assert_eq!(
                Path::new(&state.project_trust.manifest_path),
                first.join("pyproject.toml").canonicalize().unwrap()
            );
        }
    }

    #[tokio::test]
    async fn path_refresh_does_not_reset_a_launch_that_advanced_during_metadata_read() {
        use std::future::Future;
        use std::task::{Context, Waker};

        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        pyproject(&project, "pandas");
        let room = room(temp.path(), &project, json!({}), "");
        let original = crate::project_file::detect_project_file(&project).unwrap();
        crate::project_trust::require_for_launch(&room, Some(&original));
        let old_prompt = room.state.read(|sd| sd.read_state().project_trust).unwrap();
        let new_path = temp.path().join("without-project.ipynb");
        crate::notebook_sync_server::NotebookFileBinding::set_path_for_test(
            room.as_ref(),
            Some(new_path.clone()),
        )
        .await;
        let mut refresh = std::pin::pin!(
            crate::notebook_sync_server::NotebookFileBinding::set_runtime_path(&room, &new_path)
        );
        {
            let _metadata_guard = room.doc.write().await;
            assert!(refresh
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending());
            room.state
                .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Launching))
                .unwrap();
        }
        assert!(refresh.await);
        let state = room.state.read(|sd| sd.read_state()).unwrap();
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::Launching);
        assert_eq!(state.project_trust, old_prompt);
    }

    #[tokio::test]
    async fn older_save_as_metadata_read_cannot_overwrite_a_newer_binding() {
        use crate::notebook_sync_server::NotebookFileBinding;
        use std::future::Future;
        use std::task::{Context, Waker};

        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        let third = temp.path().join("third");
        pyproject(&first, "pandas");
        pyproject(&second, "unreviewed");
        pyproject(&third, "third-package");
        let room = room(temp.path(), &first, json!({}), "");
        let original = crate::project_file::detect_project_file(&first).unwrap();
        crate::project_trust::require_for_launch(&room, Some(&original));
        let second_path = second.join("moved.ipynb");
        let third_path = third.join("moved.ipynb");
        for path in [&second_path, &third_path] {
            std::fs::copy(first.join("test.ipynb"), path).unwrap();
        }
        let mut older_rebind = std::pin::pin!(NotebookFileBinding::rebind_after_save_as(
            &room,
            second_path
        ));
        {
            let _metadata_guard = room.doc.write().await;
            assert!(older_rebind
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending());
        }
        NotebookFileBinding::rebind_after_save_as(&room, third_path.clone()).await;
        older_rebind.await;
        finish_rebind_watchers(&room, &third_path).await;
        let state = room.state.read(|sd| sd.read_state()).unwrap();
        assert_eq!(
            state.path.as_deref(),
            Some(third_path.to_string_lossy().as_ref())
        );
        assert_eq!(
            Path::new(&state.project_trust.manifest_path),
            third.join("pyproject.toml").canonicalize().unwrap()
        );
        assert_eq!(room.file_binding.path().await.as_ref(), Some(&third_path));
        assert!(state.project_trust.needs_approval);
        assert_no_project_package_approval(&room);
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
