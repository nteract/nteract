//! `NotebookRequest::LaunchKernel` handler.
//!
//! Biggest single arm — 1300+ lines. Resolves kernel type + env source,
//! promotes inline deps, claims pool envs or prepares inline caches, spawns
//! the runtime agent, and dispatches LaunchKernel / RestartKernel over RPC.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tokio::sync::oneshot;
use tracing::{info, warn};

use notebook_doc::presence;
use notebook_protocol::connection::{EnvSource, LaunchSpec, PackageManager};
use runtime_doc::{KernelActivity, KernelErrorReason, RuntimeLifecycle};

use crate::async_outcome::{recv_oneshot_with_timeout, TimedOneShot};
use crate::daemon::Daemon;
use crate::kernel_launch_pipeline::{
    merge_launch_env_vars, overlay_env_vars, prepare_environment, resolve_prewarmed_packages,
    verify_pixi_toml_ipykernel, LaunchTrigger, PrepareEnvContext, PreparedEnvironment,
};
use crate::notebook_sync_server::{
    build_launched_config, captured_env_disk_state, captured_env_for_runtime,
    captured_env_source_override, check_and_broadcast_sync_state, check_inline_deps,
    extract_pixi_toml_deps, promote_inline_deps_to_project, publish_environment_launch_error,
    reset_starting_state, reset_starting_state_with_outcome, resolve_metadata_snapshot,
    send_runtime_agent_request_with_captured_env_repair, update_kernel_presence_locked,
    CapturedEnvRuntime, KernelLaunchAttempt, KernelLaunchCommitRejection, KernelLaunchCompletion,
    ManualLaunchAdmission, NotebookRoom, ResetOutcome,
};
use crate::protocol::NotebookResponse;
use crate::requests::guarded;

async fn wait_for_launch_generation(
    room: &NotebookRoom,
    generation: u64,
) -> KernelLaunchCompletion {
    let mut generation = generation;
    loop {
        if let Some(completion) = room.launch_completion(generation) {
            match completion {
                KernelLaunchCompletion::Released => {
                    if let Some(successor) = room.launch_successor_generation(generation) {
                        generation = successor;
                        continue;
                    }
                    return KernelLaunchCompletion::Released;
                }
                terminal => return terminal,
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

async fn wait_for_joined_launch(
    room: &NotebookRoom,
    generation: u64,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<KernelLaunchCompletion, ()> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    let completion = wait_for_launch_generation(room, generation);
    tokio::pin!(completion);
    tokio::select! {
        biased;
        result = &mut completion => Ok(result),
        _ = crate::notebook_sync_server::wait_for_kernel_launch_cancellation(cancel_rx) => {
            // The owner remains independently fenced until its cancellation-
            // safe checkpoint, but a joined request must retain its transport
            // budget. Wait only for the remainder of the original deadline.
            tokio::time::timeout_at(deadline, completion)
                .await
                .map_err(|_| ())
        }
        _ = tokio::time::sleep_until(deadline) => Err(()),
    }
}

/// Map a joined generation's completion to the joiner's reply. `None` means
/// the owner released the gate without a result and the joiner retries
/// admission.
async fn joined_launch_response(
    room: &NotebookRoom,
    completion: Result<KernelLaunchCompletion, ()>,
) -> Option<NotebookResponse> {
    match completion {
        Ok(KernelLaunchCompletion::Succeeded) => Some(
            existing_kernel_response(room)
                .await
                .unwrap_or_else(|| NotebookResponse::Error {
                    error: "Kernel launch completed without an active launch identity".to_string(),
                }),
        ),
        Ok(KernelLaunchCompletion::Released) => None,
        Ok(KernelLaunchCompletion::Cancelled) => Some(NotebookResponse::Error {
            error: "Kernel launch was cancelled by shutdown".to_string(),
        }),
        Ok(KernelLaunchCompletion::ProjectTrustRequired) => Some(project_trust_refusal()),
        Ok(KernelLaunchCompletion::Failed) | Err(_) => Some(NotebookResponse::Error {
            error: "Kernel launch timed out or failed".to_string(),
        }),
    }
}

fn project_trust_refusal() -> NotebookResponse {
    NotebookResponse::GuardRejected {
        reason: crate::project_trust::LAUNCH_REFUSAL_REASON.to_string(),
    }
}

/// Owner reply after the gate committed a project trust park. The generation
/// records the refusal so joined requests return the same typed reply.
fn refuse_for_project_trust(launch_attempt: &mut Option<KernelLaunchAttempt>) -> NotebookResponse {
    if let Some(attempt) = launch_attempt.as_mut() {
        attempt.require_project_trust();
    }
    project_trust_refusal()
}

fn commit_apply_delivery(
    room: &NotebookRoom,
    doc: &notebook_doc::NotebookDoc,
    lease: &super::local_environment_selection::EnvironmentApply<'_>,
    attempt: &mut KernelLaunchAttempt,
    expected_runtime: &str,
    deliver: impl FnOnce(),
) -> anyhow::Result<()> {
    if let Some(heads) = lease.observed_heads() {
        guarded::validate_dependencies_unchanged_since_observed(doc, &heads).map_err(|_| {
            anyhow::anyhow!("Notebook dependencies changed during environment preflight")
        })?;
    }
    guarded::ensure_trusted_for_doc(room, doc)?;
    if let Some(metadata) = doc.get_metadata_snapshot() {
        if room
            .local_environment_selection
            .snapshot()
            .selected_kernelspec
            .is_none()
            && metadata.detect_runtime().unwrap_or_else(|| "python".into()) != expected_runtime
        {
            anyhow::bail!("Notebook runtime changed during environment preflight");
        }
    }
    attempt.commit_kernel_replacement(|| {
        room.comms.with_doc(|cd| cd.clear_comms())?;
        room.state.with_doc(|sd| {
            sd.clear_comms()?;
            sd.set_local_environment_identity("", "", None)?;
            sd.set_lifecycle(&RuntimeLifecycle::Launching)
        })?;
        lease.begin_replacement();
        deliver();
        Ok(())
    })
}

/// A non-Apply launch can also reuse an applied session choice. Fence the
/// notebook-derived intent in either case, without making an unsaved session
/// choice masquerade as notebook metadata.
struct InstalledKernelDelivery {
    resolved_name: String,
    imported_name: Option<String>,
}

pub(crate) fn imported_kernelspec_target(
    room: &NotebookRoom,
    metadata: Option<&notebook_doc::metadata::NotebookMetadataSnapshot>,
    mode: notebook_protocol::connection::CreateNotebookEnvironmentMode,
) -> Option<String> {
    if room.local_environment_selection.applied_automatic()
        || matches!(
            room.bound_environment.snapshot(),
            super::bound_environment::BoundEnvironmentState::Bound(_)
        )
    {
        return None;
    }
    crate::kernelspec::imported(metadata, mode).map(|name| name.to_ascii_lowercase())
}

async fn send_installed_kernel_request(
    room: &NotebookRoom,
    delivery: &InstalledKernelDelivery,
    build_request: impl FnMut(
        notebook_protocol::protocol::KernelPorts,
    ) -> notebook_protocol::protocol::RuntimeAgentRequest,
) -> anyhow::Result<notebook_protocol::protocol::RuntimeAgentResponse> {
    use crate::notebook_sync_server::send_runtime_agent_request_with_kernel_ports_on_delivery;
    let stale_intent = || guarded::rejected("Notebook kernelspec changed; review before launching");
    send_runtime_agent_request_with_kernel_ports_on_delivery(
        room,
        build_request,
        Some(&room.doc),
        |doc, message, permit| {
            // Same doc -> launch gate ordering as Apply. No asynchronous work
            // between reading the notebook and committing the queue send.
            let doc = doc
                .ok_or_else(|| anyhow::anyhow!("Missing notebook document at guarded delivery"))?;
            if !matches!(
                room.initial_load.state(),
                crate::notebook_sync_server::RoomInitialLoadState::Ready { .. }
                    | crate::notebook_sync_server::RoomInitialLoadState::NotNeeded { .. }
            ) {
                return Err(stale_intent().into());
            }
            let mode = room
                .identity
                .environment_mode
                .try_read()
                .map_err(|_| stale_intent())?;
            guarded::ensure_trusted_for_doc(room, doc)?;
            let metadata = doc.get_metadata_snapshot();
            let imported = imported_kernelspec_target(room, metadata.as_ref(), *mode);
            let applied = room
                .local_environment_selection
                .snapshot()
                .applied_kernelspec;
            let current = applied
                .as_ref()
                .map(|spec| spec.name.as_str())
                .or(imported.as_deref());
            if imported != delivery.imported_name
                || current != Some(delivery.resolved_name.as_str())
            {
                return Err(stale_intent().into());
            }
            room.commit_unless_launch_cancelled(|| permit.send(message))
                .ok_or_else(|| anyhow::anyhow!("Kernel launch was cancelled"))?;
            Ok(())
        },
    )
    .await
}

pub(crate) async fn wait_for_launch_metadata(room: &NotebookRoom) -> anyhow::Result<()> {
    use crate::notebook_sync_server::RoomInitialLoadState;

    match room.initial_load.wait_until_settled().await {
        RoomInitialLoadState::Ready { .. } | RoomInitialLoadState::NotNeeded { .. } => Ok(()),
        RoomInitialLoadState::Loading { .. } => {
            anyhow::bail!("Notebook is still loading; try again")
        }
        RoomInitialLoadState::Failed { reason, .. } => {
            anyhow::bail!("Notebook could not be loaded: {reason}")
        }
    }
}

fn installed_kernel_requires_user_start(
    attempt: Option<&KernelLaunchAttempt>,
    language: &str,
    spec: &notebook_protocol::protocol::KernelspecLaunch,
) -> bool {
    attempt.is_some_and(KernelLaunchAttempt::is_automatic)
        && crate::kernelspec::requires_explicit_launch(language, spec)
}

#[cfg(test)]
mod installed_delivery_tests {
    use super::*;
    use crate::notebook_sync_server::{AutoLaunchAdmission, RuntimeAgentMessage};
    use std::future::Future;

    #[tokio::test]
    async fn wrapper_policy_blocks_only_daemon_initiated_launches() {
        let (_tmp, room) = super::tests::test_room();
        let wrapped = notebook_protocol::protocol::KernelspecLaunch {
            executable: "/bin/sh".into(),
            args: [
                "-c",
                "\"$1\" -m ipykernel_launcher -f \"$2\"; wait",
                "wrapper",
                "/opt/env/bin/python",
                "{connection_file}",
            ]
            .map(String::from)
            .to_vec(),
            resource_dir: Default::default(),
            env: Default::default(),
            interrupt_mode: Default::default(),
        };
        let AutoLaunchAdmission::Admitted(auto) = room.try_begin_auto_launch() else {
            panic!("auto admission")
        };
        assert!(installed_kernel_requires_user_start(
            Some(&auto),
            "PyThOn",
            &wrapped
        ));
        assert!(!installed_kernel_requires_user_start(
            Some(&auto),
            "julia",
            &wrapped
        ));
        auto.release_without_cooldown();
        let ManualLaunchAdmission::Admitted(manual) = room.try_begin_manual_launch() else {
            panic!("explicit admission")
        };
        assert!(!installed_kernel_requires_user_start(
            Some(&manual),
            "python",
            &wrapped
        ));
        manual.release_without_cooldown();
    }

    #[tokio::test]
    async fn applied_automatic_blocks_notebook_kernelspec_import_until_reset() {
        let (_tmp, room) = super::tests::test_room();
        let metadata = notebook_doc::metadata::NotebookMetadataSnapshot {
            kernelspec: Some(notebook_doc::metadata::KernelspecSnapshot {
                name: "julia".into(),
                display_name: "Julia".into(),
                language: Some("julia".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let selected = || imported_kernelspec_target(&room, Some(&metadata), Default::default());
        assert_eq!(selected().as_deref(), Some("julia"));
        let selection = &room.local_environment_selection;
        selection
            .begin_apply(0)
            .unwrap()
            .commit(None, Some("python".into()));
        assert_eq!(selected(), None, "old metadata must not win on restart");
        assert_eq!(
            selection.snapshot().intent_persistence,
            notebook_protocol::protocol::EnvironmentIntentPersistence::Unsaved
        );
        selection.reset();
        assert_eq!(selected().as_deref(), Some("julia"));
    }

    #[tokio::test]
    async fn environment_save_retry_does_not_clear_source_conflict() {
        let (_tmp, room) = super::tests::test_room();
        let mut doc = room.doc.write().await;
        let heads = doc.get_heads_hex();
        room.lifecycle
            .mark_source_conflict("external edit".into(), heads.clone());
        let availability = room.lifecycle.availability();
        let error = room
            .retry_kernelspec_persistence(&mut doc, None, None, "python")
            .unwrap_err();
        assert!(error.to_string().contains("Reconcile the notebook source"));
        assert_eq!(room.lifecycle.availability(), availability);
        assert_eq!(doc.get_heads_hex(), heads);
    }

    #[tokio::test(start_paused = true)]
    async fn launch_waits_for_import_and_delivery_waits_for_doc_writer() {
        let (tmp, room) = super::tests::test_room();
        let path = tmp.path().join("import.ipynb");
        std::fs::write(&path, serde_json::json!({"nbformat":4,"nbformat_minor":5,"cells":[],"metadata":{"kernelspec":{"name":"julia","language":"julia","display_name":"Julia"}}}).to_string()).unwrap();
        let claim = crate::notebook_sync_server::claim_room_initial_load(&room, path).unwrap();
        let prepare = wait_for_launch_metadata(&room);
        tokio::pin!(prepare);
        assert!(matches!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(prepare.as_mut().poll(cx))).await,
            std::task::Poll::Pending
        ));
        crate::notebook_sync_server::spawn_claimed_room_initial_load(
            claim,
            tmp.path().join("executions"),
        );
        prepare.await.unwrap();

        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let (dummy_reply, _) = oneshot::channel();
        assert!(tx
            .try_send(RuntimeAgentMessage::Query(
                notebook_protocol::protocol::RuntimeAgentRequestEnvelope {
                    id: "fill-queue".into(),
                    request: notebook_protocol::protocol::RuntimeAgentRequest::ShutdownKernel,
                },
                dummy_reply,
            ))
            .is_ok());
        *room.runtime_agent_request_tx.lock().await = Some(tx);
        let delivery = InstalledKernelDelivery {
            resolved_name: "julia".into(),
            imported_name: Some("julia".into()),
        };
        let (built, request_built) = oneshot::channel();
        let mut built = Some(built);
        let send = send_installed_kernel_request(&room, &delivery, |_| {
            built.take().unwrap().send(()).unwrap();
            notebook_protocol::protocol::RuntimeAgentRequest::ShutdownKernel
        });
        tokio::pin!(send);
        tokio::select! {
            biased;
            response = &mut send => panic!("delivery must wait for capacity: {response:?}"),
            built = request_built => built.unwrap(),
        }
        {
            let writer = room.doc.write().await;
            assert!(rx.try_recv().is_ok());
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(send.as_mut().poll(&mut context).is_pending());
            assert!(rx.try_recv().is_err());
            assert!(writer.get_metadata_snapshot().is_some());
        }
        tokio::select! {
            response = &mut send => panic!("unexpected premature result: {response:?}"),
            message = rx.recv() => {
                let Some(RuntimeAgentMessage::Query(_, reply)) = message else { panic!("expected launch query") };
                reply.send(notebook_protocol::protocol::RuntimeAgentResponse::Ok).unwrap();
            }
        }
        assert!(send.await.is_ok());
    }
}

async fn launch_delivery_refusal(
    room: &NotebookRoom,
    agent_id: Option<&str>,
    error: &anyhow::Error,
) -> Option<NotebookResponse> {
    let rejection = error.downcast_ref::<guarded::GuardRejection>()?;
    // Refresh the trust dialog as well as returning the typed refusal. Do not
    // leave an auto-launch parked in a starting phase if there is no caller.
    reset_starting_state(room, agent_id).await;
    crate::notebook_sync_server::check_and_update_trust_state(room).await;
    Some(rejection.into_response())
}

async fn existing_kernel_response(room: &NotebookRoom) -> Option<NotebookResponse> {
    let active = room.active_kernel_launch()?;
    let lifecycle = room
        .state
        .read(|sd| sd.read_state().kernel.lifecycle)
        .unwrap_or(RuntimeLifecycle::NotStarted);
    if !matches!(
        lifecycle,
        RuntimeLifecycle::Running(_)
            | RuntimeLifecycle::Resolving
            | RuntimeLifecycle::PreparingEnv
            | RuntimeLifecycle::Launching
            | RuntimeLifecycle::Connecting
    ) {
        return None;
    }

    let current_agent_id = room.current_runtime_agent_id.read().await.clone();
    if current_agent_id.as_deref() != Some(&active.runtime_agent_id)
        || room.runtime_agent_request_tx.lock().await.is_none()
    {
        room.clear_active_kernel_launch_if_agent(&active.runtime_agent_id);
        return None;
    }
    let launched_config = room.runtime_agent_launched_config.read().await.clone()?;

    Some(NotebookResponse::KernelAlreadyRunning {
        kernel_type: active.kernel_type,
        env_source: active.env_source,
        launched_config,
    })
}

#[allow(
    clippy::result_large_err,
    reason = "Launch completion returns the existing notebook protocol response on failure"
)]
async fn complete_manual_launch(
    room: &NotebookRoom,
    launch_attempt: &mut Option<KernelLaunchAttempt>,
    runtime_agent_id: &str,
    kernel_type: &str,
    env_source: &EnvSource,
    launched_config: &notebook_protocol::protocol::LaunchedEnvConfig,
    apply: Option<(
        &super::local_environment_selection::EnvironmentApply<'_>,
        Option<notebook_protocol::protocol::LocalCondaEnvironment>,
    )>,
) -> Result<(), NotebookResponse> {
    let Some(attempt) = launch_attempt.take() else {
        return Err(NotebookResponse::Error {
            error: "Kernel launch lost its manual launch ownership".to_string(),
        });
    };
    let env_source_label = env_source.as_str().to_string();
    let mut persistence = Ok(());
    let commit_result = {
        let (mut doc, mut config, mut presence_state) = tokio::join!(
            async {
                if apply.is_some() {
                    Some(room.doc.write().await)
                } else {
                    None
                }
            },
            room.runtime_agent_launched_config.write(),
            room.broadcasts.presence.write()
        );
        attempt.succeed_with_agent(runtime_agent_id, || {
            *config = Some(launched_config.clone());
            update_kernel_presence_locked(
                &mut presence_state,
                &room.broadcasts.presence_tx,
                presence::KernelStatus::Idle,
                &env_source_label,
            );
            if let Err(e) = room.state.with_doc(|sd| {
                sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))?;
                let name = launched_config
                    .installed_kernelspec
                    .as_ref()
                    .map_or(kernel_type, |s| s.name.as_str());
                sd.set_kernel_info(name, kernel_type, &env_source_label)?;
                let identity = launched_config.local_environment.as_ref();
                sd.set_local_environment_identity(
                    identity.map_or("", |e| e.id.as_str()),
                    identity.map_or("", |e| e.name.as_str()),
                    identity.and_then(|e| e.python_version.as_deref()),
                )?;
                sd.set_prewarmed_packages(&launched_config.prewarmed_packages)?;
                sd.set_runtime_agent_id(runtime_agent_id)?;
                Ok(())
            }) {
                warn!("[runtime-state] {}", e);
            }
            room.set_active_kernel_launch(
                runtime_agent_id.to_string(),
                kernel_type.to_string(),
                env_source.clone(),
            );
            *room
                .preparing_kernel_env_path
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
            if let Some((lease, binding)) = apply {
                if let Some(doc) = doc.as_deref_mut() {
                    persistence = match lease.observed_heads().map(|heads| {
                        guarded::validate_dependencies_unchanged_since_observed(doc, &heads)
                    }) {
                        Some(Err(_)) => Err(anyhow::anyhow!(
                            "Kernel started but notebook metadata changed; selection not saved"
                        )),
                        _ => crate::kernelspec::persist(
                            room,
                            doc,
                            launched_config.installed_kernelspec.as_ref(),
                            kernel_type,
                        ),
                    };
                }
                lease.commit(
                    binding,
                    persistence.is_err().then(|| kernel_type.to_string()),
                );
            } else {
                room.local_environment_selection
                    .record_launch(launched_config.installed_kernelspec.as_ref());
            }
        })
    };

    match commit_result {
        Ok(()) => {
            check_and_broadcast_sync_state(room).await;
            persistence.map_err(|e| NotebookResponse::Error {
                error: format!("{e:#}"),
            })
        }
        Err((cancelled_attempt, KernelLaunchCommitRejection::Cancelled)) => {
            // Shutdown won the gate before success was linearized. Keep the
            // token until cleanup finishes so no successor can launch beside
            // the kernel or agent we are stopping.
            let _ = crate::requests::shutdown_kernel::handle(room).await;
            cancelled_attempt.finish_cancelled();
            Err(NotebookResponse::Error {
                error: "Kernel launch cancelled by ShutdownKernel".to_string(),
            })
        }
        Err((superseded_attempt, KernelLaunchCommitRejection::AgentUnavailable)) => {
            drop(superseded_attempt);
            let details = "Kernel launch was superseded by a newer runtime agent";
            reset_starting_state_with_outcome(
                room,
                Some(runtime_agent_id),
                ResetOutcome::Error {
                    reason: None,
                    details,
                },
            )
            .await;
            Err(NotebookResponse::Error {
                error: details.to_string(),
            })
        }
    }
}

pub(crate) async fn handle(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    kernel_type: String,
    env_source: LaunchSpec,
    notebook_path: Option<String>,
) -> NotebookResponse {
    if let Err(error) = wait_for_launch_metadata(room).await {
        return NotebookResponse::Error {
            error: error.to_string(),
        };
    }
    if let Err(rejection) = guarded::ensure_trusted(room).await {
        return rejection.into_response();
    }

    let launch_attempt = loop {
        match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => {
                // The active kernel can finish between admission and this
                // check. Owning the gate makes a progress-phase projection
                // safe here: no different launch can be in flight.
                if let Some(response) = existing_kernel_response(room).await {
                    attempt.release_without_cooldown();
                    return response;
                }
                break attempt;
            }
            ManualLaunchAdmission::InFlight {
                generation,
                cancel_rx,
            } => {
                let completion = wait_for_joined_launch(room, generation, cancel_rx).await;
                match joined_launch_response(room, completion).await {
                    Some(response) => return response,
                    None => continue,
                }
            }
        }
    };

    let binding = if kernel_type == "deno" {
        None
    } else {
        room.local_environment_selection.snapshot().applied
    };
    let env_source = match super::bound_environment::existing_conda_launch_spec(
        env_source,
        binding.is_some(),
        &room.bound_environment.snapshot(),
    ) {
        Ok(env_source) => env_source,
        Err(error) => {
            launch_attempt.release_without_cooldown();
            return NotebookResponse::EnvironmentSelectionRejected { error };
        }
    };
    let binding = match binding {
        Some(environment) => match daemon
            .local_conda_environments
            .resolve_prefix(environment.prefix)
            .await
        {
            Ok(environment) => Some(environment),
            Err(error) => {
                launch_attempt.release_without_cooldown();
                return NotebookResponse::EnvironmentSelectionRejected { error };
            }
        },
        None => None,
    };
    handle_admitted(
        room,
        daemon,
        kernel_type,
        env_source,
        notebook_path,
        launch_attempt,
        binding,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_admitted(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    kernel_type: String,
    env_source: LaunchSpec,
    notebook_path: Option<String>,
    attempt: KernelLaunchAttempt,
    local_environment: Option<notebook_protocol::protocol::LocalCondaEnvironment>,
    apply: Option<super::local_environment_selection::EnvironmentApply<'_>>,
) -> NotebookResponse {
    let mut launch_attempt = Some(attempt);
    // Request workers can be cancelled at any await, including agent lookup.
    if apply.is_some() {
        if let Some(attempt) = launch_attempt.as_mut() {
            attempt.preserve_kernel_during_preparation();
        }
    }
    let prior_agent_id = if apply.is_some() {
        let id = room.current_runtime_agent_id.read().await.clone();
        if room.runtime_agent_request_tx.lock().await.is_some() {
            id
        } else {
            None
        }
    } else {
        None
    };
    if let Some(lease) = apply.as_ref() {
        lease.preserve_agent(prior_agent_id.clone());
    }
    // Preparation is reversible for Apply: only the replacement RPC owns
    // destruction of the old kernel. Inherited resolver errors must not drop
    // its runtime agent merely because a new target could not be prepared.
    let prior_kernel = room.state.read(|sd| sd.read_state().kernel).ok();
    let prior_env_path = room.runtime_agent_env_path.read().await.clone();
    if apply.is_some() {
        if let Some(attempt) = launch_attempt.as_mut() {
            attempt.preserve_environment_path(prior_env_path.clone());
        }
    }
    let response = handle_attempt(
        room,
        daemon,
        kernel_type,
        env_source,
        notebook_path,
        &mut launch_attempt,
        local_environment,
        apply.as_ref(),
    )
    .await;
    if apply.is_some() && room.local_environment_selection.is_preparing() {
        if prior_agent_id.is_none() {
            let spawned_agent_id = room.current_runtime_agent_id.read().await.clone();
            reset_starting_state(room, spawned_agent_id.as_deref()).await;
        }
        if let Some(attempt) = launch_attempt.take() {
            if !attempt.is_cancelled() {
                *room.runtime_agent_env_path.write().await = prior_env_path;
                *room
                    .preparing_kernel_env_path
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                if let Some(prior) = prior_kernel.as_ref() {
                    room.commit_unless_launch_cancelled(|| {
                        room.state.with_doc(|sd| {
                            sd.set_lifecycle_with_error_details(
                                &prior.lifecycle,
                                prior
                                    .error_reason
                                    .as_deref()
                                    .and_then(runtime_doc::KernelErrorReason::parse),
                                prior.error_details.as_deref(),
                            )?;
                            sd.set_kernel_info(&prior.name, &prior.language, &prior.env_source)?;
                            sd.set_runtime_agent_id(&prior.runtime_agent_id)?;
                            sd.clear_env_progress()?;
                            sd.set_local_environment_identity(
                                &prior.environment_id,
                                &prior.environment_name,
                                Some(&prior.python_version),
                            )
                        })
                    });
                }
                // Keeps a committed trust refusal as the generation result
                // without running cleanup against the prior kernel's agent.
                attempt.release_to_prior_kernel();
            }
        }
    }
    response
}

#[allow(clippy::too_many_arguments)]
async fn handle_attempt(
    room: &Arc<NotebookRoom>,
    daemon: &Arc<Daemon>,
    kernel_type: String,
    env_source: LaunchSpec,
    notebook_path: Option<String>,
    launch_attempt: &mut Option<KernelLaunchAttempt>,
    local_environment: Option<notebook_protocol::protocol::LocalCondaEnvironment>,
    apply: Option<&super::local_environment_selection::EnvironmentApply<'_>>,
) -> NotebookResponse {
    // Fall back to the room's on-disk path when the caller doesn't
    // supply one. The frontend typically launches with
    // `notebook_path: None` and relies on the room knowing its own
    // path; without this fallback, notebook-relative working dirs
    // and auto-detection of `pyproject.toml` / `environment.yml` /
    // `pixi.toml` silently stop working for saved notebooks.
    let identity_revision = room
        .project_trust_prompt
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .identity_revision;
    let bound_path = room.file_binding.path().await;
    let working_dir = room.identity.working_dir.read().await.clone();
    let notebook_path = match notebook_path {
        Some(p) => Some(p),
        None => bound_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
    };
    // The room-local launch gate above owns serialization. RuntimeStateDoc is
    // the client-facing projection, not a lock: concurrent Automerge lifecycle
    // writes can legitimately resolve to an intermediate phase.
    if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
        room.state.with_doc(|sd| {
            sd.clear_env_progress().ok();
            sd.set_trust("trusted", false).ok();
            sd.set_lifecycle(&RuntimeLifecycle::Resolving)
        })
    }) {
        warn!("[runtime-state] {}", e);
    }
    if apply.is_none() {
        if let Err(e) = room.comms.with_doc(|cd| cd.clear_comms()) {
            warn!("[comms-doc] {}", e);
        }
        if let Err(e) = room.state.with_doc(|sd| sd.clear_comms()) {
            warn!("[runtime-state] {}", e);
        }
    }

    let notebook_path = notebook_path.map(std::path::PathBuf::from);
    // Fall back to room.identity.working_dir for untitled notebooks (mirrors auto-launch path).
    // Enables project file detection (environment.yaml, pyproject.toml, pixi.toml)
    // when MCP callers send notebook_path: None for UUID-based notebooks.
    let notebook_path = match notebook_path {
        some @ Some(_) => some,
        None => {
            working_dir.clone().inspect(|p| {
                info!(
                    "[notebook-sync] LaunchKernel: using room working_dir for project file detection: {}",
                    p.display()
                );
            })
        }
    };

    // Resolve metadata snapshot from Automerge doc (preferred) or disk
    let initialization_fence = room.local_environment_selection.initialization_fence();
    let live_metadata = room.doc.read().await.get_metadata_snapshot();

    let selection = room.local_environment_selection.snapshot();
    let mode = *room.identity.environment_mode.read().await;
    let imported_name = imported_kernelspec_target(room, live_metadata.as_ref(), mode);
    let mut metadata_snapshot = match live_metadata {
        Some(metadata) => Some(metadata),
        None => resolve_metadata_snapshot(room, notebook_path.as_deref()).await,
    };
    let installed_name = if apply.is_some() {
        selection.selected_kernelspec.map(|s| s.name)
    } else if local_environment.is_none()
        && matches!(
            env_source,
            LaunchSpec::Auto | LaunchSpec::Concrete(EnvSource::Kernelspec)
        )
    {
        selection
            .applied_kernelspec
            .map(|s| s.name)
            .or_else(|| imported_name.clone())
    } else {
        None
    };
    let inherited = if daemon.import_shell_environment().await {
        overlay_env_vars(&daemon.shell_env_overlay())
    } else {
        Default::default()
    };
    let (installed, kernelspec) = if let Some(name) = installed_name {
        if room.is_hosted() {
            return NotebookResponse::EnvironmentSelectionRejected {
                error: "Installed kernelspecs require a local notebook".into(),
            };
        }
        if let (None, Some(fence)) = (apply, initialization_fence) {
            if let Some(intent) = metadata_snapshot
                .as_ref()
                .and_then(|metadata| metadata.kernelspec.as_ref())
                .filter(|intent| intent.name.eq_ignore_ascii_case(&name))
            {
                room.local_environment_selection.adopt_imported_kernelspec(
                    notebook_protocol::protocol::InstalledKernelspec {
                        name: name.to_ascii_lowercase(),
                        display_name: intent.display_name.clone(),
                        language: intent.language.clone().unwrap_or_default(),
                    },
                    fence,
                );
            }
        }
        if let Err(rejection) = guarded::ensure_trusted(room).await {
            return rejection.into_response();
        }
        match crate::kernelspec::resolve(name.clone())
            .await
            .and_then(|spec| Ok((spec.info(&name), spec.prepare(&inherited)?)))
        {
            Ok((info, spec)) => {
                if installed_kernel_requires_user_start(
                    launch_attempt.as_ref(),
                    &info.language,
                    &spec,
                ) {
                    let message = "This Python kernel does not use nteract's protected launch path. Start it from the Environment menu.";
                    reset_starting_state_with_outcome(
                        room,
                        None,
                        ResetOutcome::Error {
                            reason: Some(KernelErrorReason::EnvironmentPrepareFailed),
                            details: message,
                        },
                    )
                    .await;
                    return guarded::rejected(message).into_response();
                }
                (Some(info), Some(spec))
            }
            Err(e) => {
                let error = format!("{e:#}");
                if apply.is_none() {
                    reset_starting_state_with_outcome(
                        room,
                        None,
                        ResetOutcome::Error {
                            reason: None,
                            details: &error,
                        },
                    )
                    .await;
                }
                return NotebookResponse::EnvironmentSelectionRejected { error };
            }
        }
    } else if env_source == LaunchSpec::Concrete(EnvSource::Kernelspec) {
        return NotebookResponse::EnvironmentSelectionRejected {
            error: "No installed kernelspec selected".into(),
        };
    } else {
        (None, None)
    };
    let installed_delivery =
        installed
            .as_ref()
            .filter(|_| apply.is_none())
            .map(|spec| InstalledKernelDelivery {
                resolved_name: spec.name.clone(),
                imported_name,
            });

    // Auto-detect kernel type if "auto" or empty
    let resolved_kernel_type = if let Some(spec) = installed.as_ref() {
        spec.language.clone()
    } else if kernel_type == "auto" || kernel_type.is_empty() {
        metadata_snapshot
            .as_ref()
            .and_then(|s| s.detect_runtime())
            .unwrap_or_else(|| {
                info!("[notebook-sync] LaunchKernel: kernel type unknown, defaulting to python");
                "python".to_string()
            })
    } else {
        kernel_type.clone()
    };
    let local_environment = if resolved_kernel_type == "python" {
        local_environment
    } else if local_environment.is_some() && apply.is_some() {
        return NotebookResponse::EnvironmentSelectionRejected {
            error: "Notebook runtime changed; review the Python environment selection again".into(),
        };
    } else {
        None
    };
    info!(
        "[notebook-sync] LaunchKernel: resolved kernel_type='{}' (from '{}')",
        resolved_kernel_type, kernel_type
    );

    // Classify the request-time input. Permissive: non-canonical values land in
    // `LaunchSpec::Concrete(EnvSource::Unknown(_))` and pass through unchanged.
    let launch_spec = env_source;

    // Deno kernels don't use Python environments - always use "deno" regardless
    // of what env_source was requested. Log a warning if caller passed a Python env.
    // A directory the user chose the notebook environment for drops out of
    // auto-selection below.
    let mut declined_project_state = None;
    // Set when auto selection lands on the prewarmed fallback, the only slot
    // a host-bound environment may fill.
    let mut bound_environment_eligible = false;
    let resolved_env_source = if installed.is_some() {
        EnvSource::Kernelspec
    } else if resolved_kernel_type == "deno" {
        match &launch_spec {
            LaunchSpec::Auto | LaunchSpec::AutoScoped(_) => {
                info!("[notebook-sync] Deno kernel detected, using 'deno' env_source");
            }
            LaunchSpec::Concrete(EnvSource::Deno) => {
                info!("[notebook-sync] Deno kernel detected, using 'deno' env_source");
            }
            LaunchSpec::Concrete(other) => {
                warn!(
                    "[notebook-sync] Deno kernel requested with Python env_source '{}' - \
                     ignoring and using 'deno' instead",
                    other.as_str()
                );
            }
        }
        EnvSource::Deno
    } else if local_environment.is_some() {
        EnvSource::ExistingConda
    } else if matches!(launch_spec, LaunchSpec::Auto | LaunchSpec::AutoScoped(_)) {
        // Auto-detect Python environment, optionally scoped to a package manager family.
        // "auto:uv" constrains to UV sources, "auto:conda" to conda sources,
        // "auto:pixi" to pixi sources.
        let auto_scope: Option<&'static str> = match launch_spec.auto_scope() {
            Some(PackageManager::Uv) => Some("uv"),
            Some(PackageManager::Conda) => Some("conda"),
            Some(PackageManager::Pixi) => Some("pixi"),
            Some(PackageManager::Unknown(_)) | None => None,
        };

        let environment_mode = *room.identity.environment_mode.read().await;
        let detected_project = if environment_mode.allows_project_files() {
            notebook_path.as_ref().and_then(|path| match auto_scope {
                Some("uv") => crate::project_file::find_nearest_project_file(
                    path,
                    &[crate::project_file::ProjectFileKind::PyprojectToml],
                ),
                Some("conda") => crate::project_file::find_nearest_project_file(
                    path,
                    &[crate::project_file::ProjectFileKind::EnvironmentYml],
                ),
                Some("pixi") => crate::project_file::find_nearest_project_file(
                    path,
                    &[crate::project_file::ProjectFileKind::PixiToml],
                ),
                _ => crate::project_file::detect_project_file(path),
            })
        } else {
            None
        };
        let detected_project = detected_project.filter(|detected| {
            let eval = crate::project_trust::evaluate_for_room(room, detected);
            if eval.verdict == crate::project_trust::ProjectTrustVerdict::UseNotebookEnv {
                declined_project_state = Some(eval.state);
                false
            } else {
                true
            }
        });
        let project_source = detected_project.as_ref().map(|detected| {
            info!(
                "[notebook-sync] Auto-detected project file: {:?} -> {}",
                detected.path,
                detected.to_env_source().as_str()
            );
            detected.to_env_source()
        });

        // Auto keeps the legacy project-first policy. `notebook` is the
        // explicit opt-out and suppresses project_source above.
        if let Some(source) = if matches!(
            environment_mode,
            notebook_protocol::connection::CreateNotebookEnvironmentMode::Auto
                | notebook_protocol::connection::CreateNotebookEnvironmentMode::Project
        ) {
            project_source.clone()
        } else {
            None
        } {
            info!(
                "[notebook-sync] LaunchKernel: using project file -> {}",
                source.as_str()
            );
            source
        }
        // Captured prewarmed env wins over inline deps. Captured deps look
        // structurally identical to user-authored inline deps, so without this
        // override, reopening a captured notebook would route through the
        // inline-deps path and miss the already-claimed env.
        else if let Some(captured_src) = captured_env_source_override(metadata_snapshot.as_ref())
            .filter(|src| match auto_scope {
                Some("uv") => matches!(src, EnvSource::Prewarmed(PackageManager::Uv)),
                Some("conda") => matches!(src, EnvSource::Prewarmed(PackageManager::Conda)),
                Some("pixi") => false,
                _ => true,
            })
        {
            info!(
                "[notebook-sync] LaunchKernel: captured env on disk -> {}",
                captured_src.as_str()
            );
            captured_src
        }
        // Priority 3: Check inline deps in notebook metadata
        else if let Some(inline_source) =
            metadata_snapshot
                .as_ref()
                .and_then(|snap| -> Option<EnvSource> {
                    match auto_scope {
                        Some("uv") => snap
                            .runt
                            .uv
                            .as_ref()
                            .filter(|uv| !uv.dependencies.is_empty())
                            .map(|_| EnvSource::Inline(PackageManager::Uv)),
                        Some("conda") => snap
                            .runt
                            .conda
                            .as_ref()
                            .filter(|c| !c.dependencies.is_empty())
                            .map(|_| EnvSource::Inline(PackageManager::Conda)),
                        Some("pixi") => snap
                            .runt
                            .pixi
                            .as_ref()
                            .filter(|p| !p.dependencies.is_empty())
                            .map(|_| EnvSource::Inline(PackageManager::Pixi)),
                        _ => check_inline_deps(snap).filter(|s| !matches!(s, EnvSource::Deno)),
                    }
                })
        {
            info!(
                "[notebook-sync] Found inline deps in notebook metadata -> {}",
                inline_source.as_str()
            );
            inline_source
        } else {
            // Check PEP 723 script blocks in cell source.
            let has_pep723_deps = if auto_scope == Some("conda") {
                false
            } else {
                let cells = room.doc.read().await.get_cells();
                match notebook_doc::pep723::find_pep723_in_cells(&cells) {
                    Ok(Some(ref m)) if !m.dependencies.is_empty() => true,
                    Ok(_) => false,
                    Err(e) => {
                        warn!(
                            "[notebook-sync] Failed to parse PEP 723 script blocks: {}",
                            e
                        );
                        false
                    }
                }
            };

            if has_pep723_deps {
                let pep723_source = match auto_scope {
                    Some("uv") => EnvSource::Pep723(PackageManager::Uv),
                    Some("pixi") => EnvSource::Pep723(PackageManager::Pixi),
                    Some("conda") => unreachable!("conda scope skips PEP 723"),
                    _ => {
                        let default_env = daemon.default_python_env().await;
                        match default_env {
                            crate::settings_doc::PythonEnvType::Pixi => {
                                EnvSource::Pep723(PackageManager::Pixi)
                            }
                            _ => EnvSource::Pep723(PackageManager::Uv),
                        }
                    }
                };
                info!(
                    "[notebook-sync] Found PEP 723 deps in cell source ({})",
                    pep723_source.as_str()
                );
                pep723_source
            }
            // Fall back to prewarmed (scoped to family)
            else {
                let fallback = match auto_scope {
                    Some("conda") => EnvSource::Prewarmed(PackageManager::Conda),
                    Some("pixi") => EnvSource::Prewarmed(PackageManager::Pixi),
                    _ => {
                        let default_env = daemon.default_python_env().await;
                        match default_env {
                            crate::settings_doc::PythonEnvType::Conda => {
                                EnvSource::Prewarmed(PackageManager::Conda)
                            }
                            crate::settings_doc::PythonEnvType::Pixi => {
                                EnvSource::Prewarmed(PackageManager::Pixi)
                            }
                            _ => EnvSource::Prewarmed(PackageManager::Uv),
                        }
                    }
                };
                info!(
                    "[notebook-sync] No project file detected, using {}",
                    fallback.as_str()
                );
                // The bound prefix is Conda; uv- and pixi-scoped launches
                // keep their own family.
                bound_environment_eligible = matches!(auto_scope, None | Some("conda"));
                fallback
            }
        }
    } else {
        // Use explicit env_source (e.g., "uv:inline", "conda:inline")
        match launch_spec {
            LaunchSpec::Concrete(source) => source,
            LaunchSpec::Auto | LaunchSpec::AutoScoped(_) => unreachable!("auto handled above"),
        }
    };
    let bound_environment = if bound_environment_eligible {
        super::bound_environment::resolve_for_launch(
            room,
            &daemon.local_conda_environments,
            true,
            None,
        )
        .await
    } else {
        None
    };
    // An apply lease commits the user's selection, never a host binding that
    // filled the Automatic fallback.
    let applied_selection = local_environment.clone();
    let (local_environment, resolved_env_source) = match bound_environment {
        Some(environment) => (Some(environment), EnvSource::ExistingConda),
        None => (local_environment, resolved_env_source),
    };

    let parsed_resolved = resolved_env_source.clone();

    // Project trust gate. The env source is final here; a project-backed
    // source needs a trusted directory before uv, pixi, or conda sees the
    // manifest. Everything below that touches the project takes the
    // `TrustedProjectManifest` this returns.
    let project_manifest = crate::project_trust::manifest_for_env_source(
        &parsed_resolved,
        None,
        notebook_path.as_deref(),
    );
    let project_context =
        notebook_path
            .clone()
            .map(|anchor| crate::project_trust::ProjectTrustLaunchContext {
                anchor,
                env_source: parsed_resolved.clone(),
                identity_revision,
            });
    let trusted_project = match crate::project_trust::require_for_launch_in_context(
        room,
        project_manifest.as_ref(),
        project_context,
    ) {
        crate::project_trust::RoomProjectGate::NotProject
            if crate::project_trust::is_project_env_source(&parsed_resolved) =>
        {
            let error = format!(
                "{} requested but no project file was found",
                parsed_resolved.as_str()
            );
            reset_starting_state(room, None).await;
            publish_environment_launch_error(
                room,
                parsed_resolved.as_str(),
                Some(KernelErrorReason::EnvironmentPrepareFailed),
                &error,
            );
            return NotebookResponse::Error { error };
        }
        crate::project_trust::RoomProjectGate::NotProject => {
            let state = declined_project_state
                .take()
                .unwrap_or_else(crate::project_trust::no_project_state);
            crate::project_trust::publish_state(room, &state);
            None
        }
        crate::project_trust::RoomProjectGate::Trusted(trusted) => Some(trusted),
        crate::project_trust::RoomProjectGate::ContextChanged => {
            let error = "Notebook context changed during project detection; start the kernel again"
                .to_string();
            reset_starting_state(room, None).await;
            publish_environment_launch_error(
                room,
                parsed_resolved.as_str(),
                Some(KernelErrorReason::EnvironmentPrepareFailed),
                &error,
            );
            return NotebookResponse::Error { error };
        }
        // The gate committed `AwaitingProjectTrust` and the prompt. The reply
        // is the typed approval refusal, so clients classify it without
        // reading RuntimeStateDoc or the text. The generation records the same
        // refusal for requests that joined it.
        crate::project_trust::RoomProjectGate::Parked => {
            return refuse_for_project_trust(launch_attempt);
        }
        // Shutdown or agent disconnect already committed the terminal
        // projection. Dropping the cancelled token records `Cancelled`.
        crate::project_trust::RoomProjectGate::Cancelled => {
            return NotebookResponse::Error {
                error: "Kernel launch was cancelled by shutdown".to_string(),
            };
        }
        // This launch published no prompt. Dropping the token records
        // `Failed` and projects the generic launch error over the unfinished
        // lifecycle.
        crate::project_trust::RoomProjectGate::WriteFailed(error) => {
            return NotebookResponse::Error {
                error: format!("Could not record the project trust prompt: {error}"),
            };
        }
    };
    let trusted_path_of = |kind: crate::project_file::ProjectFileKind| {
        trusted_project
            .as_ref()
            .filter(|t| *t.kind() == kind)
            .map(|t| t.path().to_path_buf())
    };

    // For pixi:toml, verify ipykernel is declared before launching.
    // Unlike uv (`uv run --with ipykernel`) and conda:env_yml (daemon
    // injects ipykernel into deps pre-sync), pixi does not auto-inject.
    //
    // Publish the typed `KernelErrorReason::MissingIpykernel` AFTER
    // `reset_starting_state` so the Error lifecycle survives. The prior
    // code only returned an `Error` response — the toolbar could
    // classify the spawn error generically but never rendered the
    // targeted remediation on the RPC path.
    if let Err(error) = verify_pixi_toml_ipykernel(
        LaunchTrigger::Manual,
        room,
        &parsed_resolved,
        trusted_project.as_ref(),
    )
    .await
    {
        return NotebookResponse::Error { error };
    }

    // For project-backed envs, promote any inline deps to the project
    // file before launching. This handles the case where add_dependency
    // wrote to CRDT metadata and then triggered a restart.
    if matches!(
        parsed_resolved,
        EnvSource::PixiToml | EnvSource::Pyproject | EnvSource::EnvYml
    ) {
        if let Some(ref snap) = metadata_snapshot {
            let has_inline = match parsed_resolved {
                EnvSource::PixiToml => snap
                    .runt
                    .pixi
                    .as_ref()
                    .is_some_and(|p| !p.dependencies.is_empty()),
                EnvSource::Pyproject => snap
                    .runt
                    .uv
                    .as_ref()
                    .is_some_and(|u| !u.dependencies.is_empty()),
                EnvSource::EnvYml => snap
                    .runt
                    .conda
                    .as_ref()
                    .is_some_and(|c| !c.dependencies.is_empty()),
                _ => false,
            };
            if has_inline {
                // Build a minimal launched config with project paths for promotion
                let mut promo_config = notebook_protocol::protocol::LaunchedEnvConfig::default();
                if matches!(parsed_resolved, EnvSource::PixiToml) {
                    promo_config.pixi_toml_path =
                        trusted_path_of(crate::project_file::ProjectFileKind::PixiToml);
                    // Launched baseline = current pixi.toml deps (before promotion)
                    if let Some(ref path) = promo_config.pixi_toml_path {
                        if let Ok(content) = std::fs::read_to_string(path) {
                            promo_config.pixi_toml_deps = Some(extract_pixi_toml_deps(&content));
                        }
                    }
                } else if matches!(parsed_resolved, EnvSource::EnvYml) {
                    promo_config.environment_yml_path =
                        trusted_path_of(crate::project_file::ProjectFileKind::EnvironmentYml);
                    // Launched baseline = current env.yml deps (before promotion)
                    if let Some(ref path) = promo_config.environment_yml_path {
                        if let Ok(env_config) = crate::project_file::parse_environment_yml(path) {
                            let mut deps = env_config.dependencies;
                            deps.sort();
                            promo_config.environment_yml_deps = Some(deps);
                        }
                    }
                } else {
                    promo_config.pyproject_path =
                        trusted_path_of(crate::project_file::ProjectFileKind::PyprojectToml);
                }
                match promote_inline_deps_to_project(
                    room,
                    resolved_env_source.as_str(),
                    &promo_config,
                )
                .await
                {
                    Ok(promoted) if !promoted.is_empty() => {
                        info!(
                            "[notebook-sync] Promoted deps to project file: {:?}",
                            promoted
                        );
                        // Re-read metadata snapshot after CRDT was updated
                        metadata_snapshot =
                            resolve_metadata_snapshot(room, notebook_path.as_deref()).await;
                    }
                    Err(e) => {
                        warn!("[notebook-sync] Failed to promote deps: {}", e);
                    }
                    _ => {}
                }
            }
        }
    }

    let PreparedEnvironment {
        pooled_env,
        inline_deps,
        pep723_dependencies: pep723_dependencies_for_launch,
        uv_pyproject_offline,
        pixi_toml_frozen,
        feature_flags,
    } = match prepare_environment(PrepareEnvContext {
        trigger: LaunchTrigger::Manual,
        daemon,
        room,
        kernel_type: &resolved_kernel_type,
        env_source: &parsed_resolved,
        metadata_snapshot: metadata_snapshot.as_ref(),
        trusted_project: trusted_project.as_ref(),
        notebook_path: notebook_path.as_deref(),
        precomputed_pep723_deps: None,
    })
    .await
    {
        Ok(prepared) => prepared,
        Err(failure) => return failure.into_response(),
    };

    // Build LaunchedEnvConfig to track what config the kernel was launched with.
    //
    // For captured-prewarmed launches, pass the captured deps through
    // `captured_env_for_config` so `build_launched_config` records them
    // as the launch baseline. That way drift detection treats the
    // launch as "tracking" and won't falsely report captured deps as
    // pending additions on every reopen (see P3 in the codex review).
    //
    // `captured_env_for_config` must match the *final* resolved env
    // source — if the user explicitly asked for e.g. `uv:inline` and
    // we routed through inline flow, don't drag captured prewarmed
    // baselines along.
    let venv_path = local_environment
        .as_ref()
        .map(|e| e.prefix.clone())
        .or_else(|| pooled_env.as_ref().map(|e| e.venv_path.clone()));
    let python_path = local_environment
        .as_ref()
        .map(|e| e.python_path.clone())
        .or_else(|| pooled_env.as_ref().map(|e| e.python_path.clone()));
    let prewarmed_pkgs =
        resolve_prewarmed_packages(daemon, &parsed_resolved, pooled_env.as_ref()).await;
    let captured_env_for_config = match resolved_env_source.as_str() {
        "uv:prewarmed" => {
            captured_env_for_runtime(metadata_snapshot.as_ref(), CapturedEnvRuntime::Uv)
                .filter(|c| captured_env_disk_state(c).is_captured_route())
        }
        "conda:prewarmed" => {
            captured_env_for_runtime(metadata_snapshot.as_ref(), CapturedEnvRuntime::Conda)
                .filter(|c| captured_env_disk_state(c).is_captured_route())
        }
        _ => None,
    };
    let mut launched_config = build_launched_config(
        &resolved_kernel_type,
        resolved_env_source.as_str(),
        inline_deps.as_deref(),
        metadata_snapshot.as_ref(),
        venv_path,
        python_path,
        prewarmed_pkgs.as_deref(),
        trusted_project.as_ref(),
        feature_flags,
        captured_env_for_config.as_ref(),
    );
    launched_config.local_environment = local_environment.as_ref().map(|environment| {
        notebook_protocol::protocol::LocalEnvironmentIdentity {
            id: environment.id.clone(),
            name: environment.name.clone(),
            python_version: environment.python_version.clone(),
        }
    });
    if let Some(environment) = local_environment.as_ref() {
        launched_config.venv_path = Some(environment.prefix.clone());
        launched_config.python_path = Some(environment.python_path.clone());
        // Borrowed prefixes must never enter the daemon-owned cleanup slot.
        *room.runtime_agent_env_path.write().await = None;
    }
    if let Some(spec) = installed {
        launched_config = notebook_protocol::protocol::LaunchedEnvConfig {
            launch_id: launched_config.launch_id,
            local_environment: Some(notebook_protocol::protocol::LocalEnvironmentIdentity {
                id: format!("kernelspec:{}", spec.name),
                name: spec.display_name.clone(),
                python_version: None,
            }),
            installed_kernelspec: Some(spec),
            ..Default::default()
        };
        *room.runtime_agent_env_path.write().await = None;
    }

    if launch_attempt
        .as_ref()
        .is_some_and(KernelLaunchAttempt::is_cancelled)
    {
        return NotebookResponse::Error {
            error: "Kernel launch cancelled by ShutdownKernel".to_string(),
        };
    }

    if let Some(lease) = apply.as_ref() {
        let mut rejection = guarded::ensure_trusted(room).await.err();
        if rejection.is_none() {
            if let Some(heads) = lease.observed_heads() {
                let doc = room.doc.read().await;
                rejection =
                    guarded::validate_dependencies_unchanged_since_observed(&doc, &heads).err();
            }
        }
        if let Some(rejection) = rejection {
            return rejection.into_response();
        }
    }

    if parsed_resolved.as_str().ends_with(":pep723") {
        if let Err(rejection) =
            guarded::ensure_trusted_pep723(room, &pep723_dependencies_for_launch).await
        {
            reset_starting_state(room, None).await;
            return rejection.into_response();
        }
    }

    // Transition to "launching" phase before starting the kernel process
    if apply.is_none() {
        if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
            room.state.with_doc(|sd| {
                sd.set_local_environment_identity("", "", None)?;
                sd.set_lifecycle(&RuntimeLifecycle::Launching)
            })
        }) {
            warn!("[runtime-state] {}", e);
        }
    }
    let redact_env_values_in_outputs = daemon.redact_env_values_in_outputs().await;

    // If runtime agent is already connected, restart kernel in-place
    // (handles the shutdown → launch sequence without subprocess respawn).
    // The overlay is re-evaluated per launch so the toggle takes effect on
    // the next restart without respawning the runtime-agent process.
    {
        let existing_runtime_agent_id = room.current_runtime_agent_id.read().await.clone();
        let has_runtime_agent = room.runtime_agent_request_tx.lock().await.is_some();
        if has_runtime_agent {
            info!("[notebook-sync] Agent connected — sending RestartKernel");
            // Precedence: overlay (lowest) → uv → pixi (highest), so daemon-required
            // vars always win over imported shell values.
            let restart_env_vars =
                merge_launch_env_vars(inherited.clone(), uv_pyproject_offline, pixi_toml_frozen);
            let build_request =
                |kernel_ports| notebook_protocol::protocol::RuntimeAgentRequest::RestartKernel {
                    kernel_type: resolved_kernel_type.clone(),
                    env_source: resolved_env_source.clone(),
                    notebook_path: notebook_path
                        .as_deref()
                        .map(|p| p.to_str().unwrap_or("").to_string()),
                    launched_config: launched_config.clone(),
                    kernel_ports,
                    env_vars: restart_env_vars.clone(),
                    kernelspec: kernelspec.clone(),
                    redact_env_values_in_outputs,
                };
            let response = if let Some(lease) = apply {
                crate::notebook_sync_server::send_runtime_agent_request_with_kernel_ports_on_delivery(room, build_request, Some(&room.doc), |doc, message, permit| {
                    let doc = doc.ok_or_else(|| anyhow::anyhow!("Missing notebook document at Apply delivery"))?;
                    let attempt = launch_attempt.as_mut().ok_or_else(|| anyhow::anyhow!("Kernel launch ownership ended before delivery"))?;
                    commit_apply_delivery(room, doc, lease, attempt, &resolved_kernel_type, || { permit.send(message); })
                }).await
            } else if let Some(delivery) = &installed_delivery {
                send_installed_kernel_request(room, delivery, build_request).await
            } else {
                send_runtime_agent_request_with_captured_env_repair(
                    room,
                    captured_env_for_config.as_ref(),
                    build_request,
                )
                .await
            };
            match response {
                Ok(notebook_protocol::protocol::RuntimeAgentResponse::KernelRestarted {
                    env_source: es,
                }) => {
                    let Some(runtime_agent_id) = existing_runtime_agent_id else {
                        let details = "Kernel restarted without a current runtime agent";
                        if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
                            room.state.with_doc(|sd| {
                                sd.set_lifecycle_with_error_details(
                                    &RuntimeLifecycle::Error,
                                    None,
                                    Some(details),
                                )
                            })
                        }) {
                            warn!("[runtime-state] {}", e);
                        }
                        return NotebookResponse::Error {
                            error: details.to_string(),
                        };
                    };
                    if !room.is_current_runtime_agent(&runtime_agent_id).await {
                        let details = "Kernel restart was superseded by a newer runtime agent";
                        reset_starting_state_with_outcome(
                            room,
                            Some(&runtime_agent_id),
                            ResetOutcome::Error {
                                reason: None,
                                details,
                            },
                        )
                        .await;
                        return NotebookResponse::Error {
                            error: details.to_string(),
                        };
                    }
                    if let Err(response) = complete_manual_launch(
                        room,
                        launch_attempt,
                        &runtime_agent_id,
                        &resolved_kernel_type,
                        &es,
                        &launched_config,
                        apply.map(|lease| (lease, applied_selection.clone())),
                    )
                    .await
                    {
                        return response;
                    }

                    return NotebookResponse::KernelLaunched {
                        kernel_type: resolved_kernel_type,
                        env_source: es,
                        launched_config,
                    };
                }
                Ok(
                    notebook_protocol::protocol::RuntimeAgentResponse::Error { error }
                    | notebook_protocol::protocol::RuntimeAgentResponse::KernelLaunchFailed {
                        error,
                        ..
                    },
                ) => {
                    reset_starting_state_with_outcome(
                        room,
                        existing_runtime_agent_id.as_deref(),
                        ResetOutcome::Error {
                            reason: None,
                            details: &error,
                        },
                    )
                    .await;
                    return NotebookResponse::Error {
                        error: format!("Agent restart failed: {}", error),
                    };
                }
                Ok(_) => {
                    reset_starting_state(room, existing_runtime_agent_id.as_deref()).await;
                    return NotebookResponse::Error {
                        error: "Unexpected runtime agent response to RestartKernel".to_string(),
                    };
                }
                Err(e) => {
                    if let Some(response) =
                        launch_delivery_refusal(room, existing_runtime_agent_id.as_deref(), &e)
                            .await
                    {
                        return response;
                    }
                    if apply.is_some() || local_environment.is_some() {
                        let details = format!("Agent restart failed: {e}");
                        reset_starting_state_with_outcome(
                            room,
                            existing_runtime_agent_id.as_deref(),
                            ResetOutcome::Error {
                                reason: None,
                                details: &details,
                            },
                        )
                        .await;
                        return NotebookResponse::Error { error: details };
                    }
                    warn!(
                        "[notebook-sync] RestartKernel RPC failed: {} — spawning new runtime agent",
                        e
                    );
                    // Fall through to spawn new runtime agent below
                }
            }
        }
    }

    // Spawn runtime agent subprocess for kernel execution
    {
        info!("[notebook-sync] Spawning runtime agent subprocess");

        // Always pass the room UUID so the agent's RuntimeAgent
        // handshake finds the room in the UUID-keyed rooms map.
        let notebook_id = room.id.to_string();
        let runtime_agent_id = format!("runtime-agent:{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let socket_path = daemon.socket_path().clone();

        // Set provenance + bump generation + create oneshot BEFORE spawn
        // (see auto_launch_kernel for ordering rationale).
        let agent_expected = {
            let mut id = room.current_runtime_agent_id.write().await;
            if launch_attempt
                .as_ref()
                .is_some_and(|attempt| attempt.expect_runtime_agent(&runtime_agent_id))
            {
                *id = Some(runtime_agent_id.clone());
                true
            } else {
                false
            }
        };
        if !agent_expected
            || launch_attempt
                .as_ref()
                .is_some_and(KernelLaunchAttempt::is_cancelled)
        {
            reset_starting_state(room, None).await;
            return NotebookResponse::Error {
                error: "Kernel launch cancelled before runtime agent spawn".to_string(),
            };
        }
        room.runtime_agent_generation
            .fetch_add(1, Ordering::Release);
        let runtime_agent_connect_rx = {
            let (tx, rx) = oneshot::channel();
            let mut guard = room.pending_runtime_agent_connect_tx.lock().await;
            *guard = Some(tx);
            rx
        };
        let Some(spawn_cancel_rx) = launch_attempt
            .as_ref()
            .map(KernelLaunchAttempt::cancellation_receiver)
        else {
            reset_starting_state(room, Some(&runtime_agent_id)).await;
            return NotebookResponse::Error {
                error: "Kernel launch lost its manual launch ownership before agent spawn"
                    .to_string(),
            };
        };

        // Publish Connecting before the subprocess can take its initial
        // state snapshot. Its readiness acknowledgement must cover this write.
        if let Some(Err(e)) = room.commit_unless_launch_cancelled(|| {
            room.state
                .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Connecting))
        }) {
            warn!("[runtime-state] {}", e);
        }

        let spawn_result = tokio::select! {
            biased;
            _ = crate::notebook_sync_server::wait_for_kernel_launch_cancellation(
                spawn_cancel_rx,
            ) => {
                if let Some(attempt) = launch_attempt.as_ref() {
                    attempt
                        .discard_cancelled_runtime_agent(&runtime_agent_id)
                        .await;
                }
                return NotebookResponse::Error {
                    error: "Kernel launch cancelled while spawning runtime agent".to_string(),
                };
            }
            result = crate::runtime_agent_handle::RuntimeAgentHandle::spawn(
                notebook_id,
                runtime_agent_id.clone(),
                room.blob_store.root().to_path_buf(),
                socket_path,
                daemon.config.runtime_agent_exe.clone(),
            ) => result,
        };

        match spawn_result {
            Ok(ra) => {
                {
                    let mut ra_guard = room.runtime_agent_handle.lock().await;
                    *ra_guard = Some(ra);
                }
                if launch_attempt
                    .as_ref()
                    .is_some_and(KernelLaunchAttempt::is_cancelled)
                {
                    if let Some(attempt) = launch_attempt.as_ref() {
                        attempt
                            .discard_cancelled_runtime_agent(&runtime_agent_id)
                            .await;
                    }
                    return NotebookResponse::Error {
                        error: "Kernel launch cancelled after runtime agent spawn".to_string(),
                    };
                }

                // Wait for THIS runtime agent to connect back via socket
                let Some(connect_cancel_rx) = launch_attempt
                    .as_ref()
                    .map(KernelLaunchAttempt::cancellation_receiver)
                else {
                    reset_starting_state(room, Some(&runtime_agent_id)).await;
                    return NotebookResponse::Error {
                        error:
                            "Kernel launch lost its manual launch ownership before agent connection"
                                .to_string(),
                    };
                };
                let connect_result = tokio::select! {
                    biased;
                    _ = crate::notebook_sync_server::wait_for_kernel_launch_cancellation(
                        connect_cancel_rx,
                    ) => {
                        if let Some(attempt) = launch_attempt.as_ref() {
                            attempt
                                .discard_cancelled_runtime_agent(&runtime_agent_id)
                                .await;
                        }
                        return NotebookResponse::Error {
                            error: "Kernel launch cancelled while waiting for runtime agent connection".to_string(),
                        };
                    }
                    result = recv_oneshot_with_timeout(
                        runtime_agent_connect_rx,
                        std::time::Duration::from_secs(30),
                    ) => result,
                };
                match connect_result {
                    TimedOneShot::Received(()) => {}
                    TimedOneShot::SenderDropped => {
                        reset_starting_state(room, Some(&runtime_agent_id)).await;
                        return NotebookResponse::Error {
                            error: "Runtime agent connect cancelled (superseded or died)"
                                .to_string(),
                        };
                    }
                    TimedOneShot::TimedOut => {
                        reset_starting_state(room, Some(&runtime_agent_id)).await;
                        return NotebookResponse::Error {
                            error: "Agent failed to connect within 30s".to_string(),
                        };
                    }
                }

                if launch_attempt
                    .as_ref()
                    .is_some_and(KernelLaunchAttempt::is_cancelled)
                {
                    if let Some(attempt) = launch_attempt.as_ref() {
                        attempt
                            .discard_cancelled_runtime_agent(&runtime_agent_id)
                            .await;
                    }
                    return NotebookResponse::Error {
                        error: "Kernel launch cancelled before LaunchKernel RPC".to_string(),
                    };
                }

                // Send LaunchKernel RPC. Same precedence as the restart path
                // above: overlay (lowest) → uv → pixi (highest).
                let launch_env_vars =
                    merge_launch_env_vars(inherited, uv_pyproject_offline, pixi_toml_frozen);
                let build_request =
                    |kernel_ports| notebook_protocol::protocol::RuntimeAgentRequest::LaunchKernel {
                        kernel_type: resolved_kernel_type.clone(),
                        env_source: resolved_env_source.clone(),
                        notebook_path: notebook_path
                            .as_deref()
                            .map(|p| p.to_str().unwrap_or("").to_string()),
                        launched_config: launched_config.clone(),
                        kernel_ports,
                        env_vars: launch_env_vars.clone(),
                        kernelspec: kernelspec.clone(),
                        redact_env_values_in_outputs,
                    };
                let response = if let Some(lease) = apply {
                    crate::notebook_sync_server::send_runtime_agent_request_with_kernel_ports_on_delivery(room, build_request, Some(&room.doc), |doc, message, permit| {
                        let doc = doc.ok_or_else(|| anyhow::anyhow!("Missing notebook document at Apply delivery"))?;
                        let attempt = launch_attempt.as_mut().ok_or_else(|| anyhow::anyhow!("Kernel launch ownership ended before delivery"))?;
                        commit_apply_delivery(room, doc, lease, attempt, &resolved_kernel_type, || { permit.send(message); })
                    }).await
                } else if let Some(delivery) = &installed_delivery {
                    send_installed_kernel_request(room, delivery, build_request).await
                } else {
                    send_runtime_agent_request_with_captured_env_repair(
                        room,
                        captured_env_for_config.as_ref(),
                        build_request,
                    )
                    .await
                };
                match response {
                    Ok(notebook_protocol::protocol::RuntimeAgentResponse::KernelLaunched {
                        env_source: es,
                    }) => {
                        if !room.is_current_runtime_agent(&runtime_agent_id).await {
                            let details = "Kernel launch was superseded by a newer runtime agent";
                            reset_starting_state_with_outcome(
                                room,
                                Some(&runtime_agent_id),
                                ResetOutcome::Error {
                                    reason: None,
                                    details,
                                },
                            )
                            .await;
                            return NotebookResponse::Error {
                                error: details.to_string(),
                            };
                        }
                        if let Err(response) = complete_manual_launch(
                            room,
                            launch_attempt,
                            &runtime_agent_id,
                            &resolved_kernel_type,
                            &es,
                            &launched_config,
                            apply.map(|lease| (lease, applied_selection.clone())),
                        )
                        .await
                        {
                            return response;
                        }

                        NotebookResponse::KernelLaunched {
                            kernel_type: resolved_kernel_type,
                            env_source: es,
                            launched_config,
                        }
                    }
                    Ok(
                        notebook_protocol::protocol::RuntimeAgentResponse::Error { error }
                        | notebook_protocol::protocol::RuntimeAgentResponse::KernelLaunchFailed {
                            error,
                            ..
                        },
                    ) => {
                        // Mirror the response into CRDT so UIs that
                        // watch RuntimeStateDoc (not the RPC reply)
                        // also see the failure.
                        reset_starting_state_with_outcome(
                            room,
                            Some(&runtime_agent_id),
                            ResetOutcome::Error {
                                reason: None,
                                details: &error,
                            },
                        )
                        .await;
                        NotebookResponse::Error {
                            error: format!("Agent kernel launch failed: {}", error),
                        }
                    }
                    Ok(_) => {
                        let msg = "Unexpected runtime agent response";
                        reset_starting_state_with_outcome(
                            room,
                            Some(&runtime_agent_id),
                            ResetOutcome::Error {
                                reason: None,
                                details: msg,
                            },
                        )
                        .await;
                        NotebookResponse::Error {
                            error: msg.to_string(),
                        }
                    }
                    Err(e) => {
                        if let Some(response) =
                            launch_delivery_refusal(room, Some(&runtime_agent_id), &e).await
                        {
                            return response;
                        }
                        let details = format!("Agent communication error: {e}");
                        reset_starting_state_with_outcome(
                            room,
                            Some(&runtime_agent_id),
                            ResetOutcome::Error {
                                reason: None,
                                details: &details,
                            },
                        )
                        .await;
                        NotebookResponse::Error { error: details }
                    }
                }
            }
            Err(e) => {
                let details = format!("Failed to spawn runtime agent: {e}");
                reset_starting_state_with_outcome(
                    room,
                    None,
                    ResetOutcome::Error {
                        reason: None,
                        details: &details,
                    },
                )
                .await;
                NotebookResponse::Error { error: details }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob_store::BlobStore;
    use crate::notebook_sync_server::{AutoLaunchAdmission, ManualLaunchAdmission, NotebookRoom};

    pub(super) fn test_room() -> (tempfile::TempDir, Arc<NotebookRoom>) {
        let tmp = tempfile::TempDir::new().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            false,
        ));
        (tmp, room)
    }

    #[tokio::test]
    async fn apply_metadata_failure_keeps_kernel_running_and_can_retry_save() {
        let (tmp, room) = test_room();
        let observed_heads = {
            let mut doc = room.doc.write().await;
            doc.set_metadata_value(
                "kernelspec",
                &serde_json::json!({"name":"python3","language":"python","display_name":"Python"}),
            )
            .unwrap();
            doc.get_heads_hex()
        };
        let spec = notebook_protocol::protocol::InstalledKernelspec {
            name: "julia".into(),
            display_name: "Julia".into(),
            language: "julia".into(),
        };
        assert!(room
            .local_environment_selection
            .adopt_imported_kernelspec(spec.clone(), 0));
        let lease = room.local_environment_selection.begin_apply(1).unwrap();
        lease.set_observed_heads(observed_heads.clone());
        let mut attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("admission"),
        };
        *room.current_runtime_agent_id.write().await = Some("agent-1".into());
        assert!(attempt.expect_runtime_agent("agent-1"));
        assert!(room.mark_runtime_agent_connected("agent-1"));
        {
            let doc = room.doc.read().await;
            commit_apply_delivery(&room, &doc, &lease, &mut attempt, "julia", || {}).unwrap();
        }
        room.doc
            .write()
            .await
            .set_metadata_value(
                "kernelspec",
                &serde_json::json!({"name":"ir","language":"R","display_name":"R"}),
            )
            .unwrap();
        let (request_tx, mut request_rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(request_tx);
        let launched_config = notebook_protocol::protocol::LaunchedEnvConfig {
            launch_id: Some("launch-1".into()),
            installed_kernelspec: Some(spec),
            ..Default::default()
        };
        let error = complete_manual_launch(
            &room,
            &mut Some(attempt),
            "agent-1",
            "julia",
            &EnvSource::Kernelspec,
            &launched_config,
            Some((&lease, None)),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(error, NotebookResponse::Error { error } if error.contains("selection not saved"))
        );
        assert_eq!(
            room.doc
                .read()
                .await
                .get_metadata_snapshot()
                .unwrap()
                .kernelspec
                .unwrap()
                .name,
            "ir"
        );
        let selection = room.local_environment_selection.snapshot();
        assert_eq!(selection.applied_kernelspec, selection.selected_kernelspec);
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Running(KernelActivity::Idle),
        );
        use notebook_protocol::protocol::EnvironmentIntentPersistence::{Current, Unsaved};
        assert_eq!(selection.intent_persistence, Unsaved);
        let daemon = Daemon::new_for_test(crate::daemon::DaemonConfig {
            socket_path: tmp.path().join("daemon.sock"),
            cache_dir: tmp.path().join("envs"),
            blob_store_dir: tmp.path().join("daemon-blobs"),
            execution_store_dir: tmp.path().join("executions"),
            notebook_docs_dir: tmp.path().join("daemon-notebooks"),
            trusted_packages_db_path: tmp.path().join("trusted-packages.sqlite"),
            notebook_registry_db_path: tmp.path().join("notebooks.sqlite"),
            use_preferred_blob_port: false,
            lock_dir: Some(tmp.path().to_path_buf()),
            settings_json_path: Some(tmp.path().join("settings.json")),
            ..Default::default()
        })
        .unwrap();
        assert!(matches!(
            super::super::local_environment_selection::apply(&room, &daemon, selection.revision, observed_heads).await,
            NotebookResponse::GuardRejected { reason } if reason.contains("kernelspec changed"),
        ));
        assert_eq!(room.local_environment_selection.snapshot(), selection);

        let fresh_heads = room.doc.write().await.get_heads_hex();
        // Force an actual journal I/O error at the save-only boundary as
        // well: it must leave the kernel and pending choice intact.
        let journal = room.durability.journal().unwrap();
        std::fs::create_dir(journal.path()).unwrap();
        assert!(matches!(
            super::super::local_environment_selection::apply(&room, &daemon, selection.revision, fresh_heads.clone()).await,
            NotebookResponse::Error { error } if error.contains("journal commit failed"),
        ));
        std::fs::remove_dir(journal.path()).unwrap();
        let selection = room.local_environment_selection.snapshot();
        assert_eq!(selection.intent_persistence, Unsaved);
        assert_eq!(room.doc.write().await.get_heads_hex(), fresh_heads);
        // Model reconciliation paused after it computes its next generation.
        // Retry must not publish that same generation while the claim is held.
        let reconciliation = room.try_claim_source_reconciliation().unwrap();
        let source_before = room.lifecycle.source_state();
        let next_generation = source_before.generation().saturating_add(1);
        assert!(matches!(
            super::super::local_environment_selection::apply(&room, &daemon, selection.revision, fresh_heads.clone()).await,
            NotebookResponse::EnvironmentSelectionRejected { error } if error.contains("reconciliation is already in progress"),
        ));
        assert_eq!(room.lifecycle.source_state(), source_before);
        assert_eq!(room.local_environment_selection.snapshot(), selection);
        assert_eq!(room.doc.write().await.get_heads_hex(), fresh_heads);
        drop(reconciliation);
        let response = super::super::local_environment_selection::apply(
            &room,
            &daemon,
            selection.revision,
            fresh_heads,
        )
        .await;
        assert!(
            matches!(response, NotebookResponse::EnvironmentSelection { selection } if selection.intent_persistence == Current && !selection.applying)
        );
        assert_eq!(room.lifecycle.source_state().generation(), next_generation);
        let metadata = room.doc.read().await.get_metadata_snapshot().unwrap();
        assert_eq!(metadata.kernelspec.unwrap().name, "julia");
        assert_eq!(metadata.runt.extra["installed_kernelspec"], "julia");
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Running(KernelActivity::Idle),
        );
        assert_eq!(
            room.runtime_agent_launched_config.read().await.as_ref(),
            Some(&launched_config)
        );
        assert!(matches!(
            request_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        assert!(matches!(
            room.lifecycle.availability(),
            crate::notebook_sync_server::RoomAvailability::Interactive(_)
        ));
        assert!(room
            .state
            .read(|sd| sd.read_state().file_checkpoint.source_issue)
            .unwrap()
            .is_none());
        let path = tmp.path().join("export.ipynb");
        crate::notebook_sync_server::save_notebook_to_disk(&room, path.to_str())
            .await
            .expect("ordinary save must work after the journal recovers");
        let exported: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(exported["metadata"]["kernelspec"]["name"], "julia");
    }

    #[tokio::test(start_paused = true)]
    async fn non_apply_kernelspec_delivery_rechecks_intent_and_trust() {
        use notebook_protocol::protocol::RuntimeAgentRequest;

        for trust_changed in [false, true] {
            let (_tmp, room) = test_room();
            let mut metadata = notebook_doc::metadata::NotebookMetadataSnapshot::default();
            metadata.kernelspec = Some(notebook_doc::metadata::KernelspecSnapshot {
                name: "julia".into(),
                display_name: "Julia".into(),
                language: Some("julia".into()),
                ..Default::default()
            });
            room.doc
                .write()
                .await
                .set_metadata_snapshot(&metadata)
                .unwrap();
            let resolved =
                crate::kernelspec::imported(Some(&metadata), Default::default()).unwrap();
            guarded::ensure_trusted(&room).await.unwrap();

            let (tx, mut rx) = tokio::sync::mpsc::channel(1);
            let (dummy_reply, _) = oneshot::channel();
            assert!(tx
                .try_send(crate::notebook_sync_server::RuntimeAgentMessage::Query(
                    notebook_protocol::protocol::RuntimeAgentRequestEnvelope {
                        id: "fill-queue".into(),
                        request: RuntimeAgentRequest::ShutdownKernel,
                    },
                    dummy_reply,
                ))
                .is_ok());
            *room.runtime_agent_request_tx.lock().await = Some(tx);
            let delivery = InstalledKernelDelivery {
                imported_name: Some(resolved.clone()),
                resolved_name: resolved.clone(),
            };
            let (built_tx, mut built_rx) = oneshot::channel();
            let mut built_tx = Some(built_tx);
            let send = send_installed_kernel_request(&room, &delivery, |kernel_ports| {
                let _ = built_tx.take().unwrap().send(());
                RuntimeAgentRequest::LaunchKernel {
                    kernel_type: "julia".into(),
                    env_source: EnvSource::Kernelspec,
                    notebook_path: None,
                    launched_config: Default::default(),
                    kernelspec: None,
                    kernel_ports,
                    env_vars: Default::default(),
                    redact_env_values_in_outputs: false,
                }
            });
            tokio::pin!(send);
            tokio::select! {
                result = &mut send => panic!("launch completed despite full queue: {result:?}"),
                built = &mut built_rx => built.unwrap(),
            }
            // Update the notebook after request preparation, while delivery is
            // blocked on the runtime agent's queue reservation.
            if trust_changed {
                metadata.add_uv_dependency("not-approved-for-kernelspec-test");
            } else {
                metadata.kernelspec.as_mut().unwrap().name = "ir".into();
            }
            room.doc
                .write()
                .await
                .set_metadata_snapshot(&metadata)
                .unwrap();
            assert!(rx.try_recv().is_ok());
            let error = tokio::select! {
                result = &mut send => result.unwrap_err(),
                _ = rx.recv() => panic!("stale kernelspec {resolved} reached the runtime agent"),
            };
            assert!(matches!(
                error
                    .downcast_ref::<guarded::GuardRejection>()
                    .unwrap()
                    .into_response(),
                NotebookResponse::GuardRejected { .. }
            ));
            let error = error.to_string();
            assert!(
                error.contains(if trust_changed {
                    "Trust changed"
                } else {
                    "kernelspec changed"
                }),
                "{error}"
            );
            assert!(rx.try_recv().is_err());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn apply_delivery_rejects_current_runtime_before_replacing_old_kernel() {
        let (_tmp, room) = test_room();
        {
            let mut doc = room.doc.write().await;
            doc.set_metadata_value(
                "kernelspec",
                &serde_json::json!({"name":"deno","language":"typescript","display_name":"Deno"}),
            )
            .unwrap();
            assert_eq!(doc.detect_runtime().as_deref(), Some("deno"));
        }
        room.state
            .with_doc(|sd| {
                sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))?;
                sd.set_kernel_info("python", "python", "conda:existing:local")?;
                sd.set_local_environment_identity("old", "old", None)
            })
            .unwrap();
        let before = room.state.read(|sd| sd.read_state().kernel).unwrap();
        let lease = room.local_environment_selection.begin_apply(0).unwrap();
        let mut attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("admission"),
        };
        let error = {
            let doc = room.doc.read().await;
            commit_apply_delivery(&room, &doc, &lease, &mut attempt, "python", || {
                panic!("must not deliver")
            })
            .unwrap_err()
        };
        assert!(error.to_string().contains("runtime changed"));
        assert_eq!(
            room.state.read(|sd| sd.read_state().kernel).unwrap(),
            before
        );
        assert!(room.local_environment_selection.is_preparing());
        attempt.release_without_cooldown();
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_clears_running_identity_but_preserves_session_binding() {
        let (_tmp, room) = test_room();
        let environment = notebook_protocol::protocol::LocalCondaEnvironment {
            id: "local-rankings".into(),
            name: "rankings".into(),
            prefix: "/borrowed/rankings".into(),
            python_path: "/borrowed/rankings/bin/python".into(),
            python_version: Some("3.12".into()),
        };
        room.local_environment_selection
            .set(Some(environment.clone()), 0)
            .unwrap();
        room.local_environment_selection
            .begin_apply(1)
            .unwrap()
            .commit(Some(environment), None);
        room.state
            .with_doc(|sd| {
                sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle))?;
                sd.set_local_environment_identity("local-rankings", "rankings", Some("3.12"))
            })
            .unwrap();
        crate::requests::shutdown_kernel::handle(&room).await;
        let kernel = room.state.read(|sd| sd.read_state().kernel).unwrap();
        assert_eq!(kernel.lifecycle, RuntimeLifecycle::Shutdown);
        assert!(kernel.environment_id.is_empty());
        assert!(kernel.environment_name.is_empty());
        assert!(kernel.python_version.is_empty());
        assert_eq!(
            room.local_environment_selection
                .snapshot()
                .applied
                .unwrap()
                .name,
            "rankings"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn auto_launch_gate_completion_unblocks_stale_lifecycle_projection() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto-launch should be admitted"),
        };
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Launching))
            .unwrap();

        let waiter = tokio::spawn({
            let room = Arc::clone(&room);
            async move { wait_for_launch_generation(&room, 1).await }
        });
        tokio::task::yield_now().await;

        assert!(attempt.succeed().is_ok());
        let later_attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("later auto-launch should be admitted"),
        };
        later_attempt.release_without_cooldown();
        tokio::time::advance(std::time::Duration::from_millis(101)).await;

        assert_eq!(waiter.await.unwrap(), KernelLaunchCompletion::Succeeded);
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Launching,
            "the regression requires completion to be independent of the CRDT projection"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn joined_waiter_follows_successor_after_benign_release() {
        let (_tmp, room) = test_room();
        let first = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("first auto-launch should be admitted"),
        };
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Launching))
            .unwrap();
        let waiter = tokio::spawn({
            let room = Arc::clone(&room);
            async move { wait_for_launch_generation(&room, 1).await }
        });
        tokio::task::yield_now().await;

        first.release_without_cooldown();
        let successor = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("successor auto-launch should be admitted"),
        };
        assert!(successor.succeed().is_ok());
        tokio::time::advance(std::time::Duration::from_millis(101)).await;

        assert_eq!(waiter.await.unwrap(), KernelLaunchCompletion::Succeeded);
    }

    #[tokio::test]
    async fn existing_kernel_response_reuses_active_launch() {
        let (_tmp, room) = test_room();
        let launched_config = notebook_protocol::protocol::LaunchedEnvConfig {
            launch_id: Some("launch-1".to_string()),
            ..Default::default()
        };
        *room.runtime_agent_launched_config.write().await = Some(launched_config.clone());
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        assert!(
            room.record_active_kernel_launch_if_current(
                "agent-1".to_string(),
                "python".to_string(),
                EnvSource::Prewarmed(PackageManager::Uv),
            )
            .await
        );

        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle)))
            .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(tx);
        let response = existing_kernel_response(&room).await.unwrap();
        match response {
            NotebookResponse::KernelAlreadyRunning {
                kernel_type,
                env_source,
                launched_config: actual_config,
            } => {
                assert_eq!(kernel_type, "python");
                assert_eq!(env_source, EnvSource::Prewarmed(PackageManager::Uv));
                assert_eq!(actual_config, launched_config);
            }
            other => panic!("expected existing-kernel response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn terminal_lifecycle_rejects_response_without_projection_driven_clear() {
        let (_tmp, room) = test_room();
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        assert!(
            room.record_active_kernel_launch_if_current(
                "agent-1".to_string(),
                "python".to_string(),
                EnvSource::Prewarmed(PackageManager::Uv),
            )
            .await
        );
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(tx);
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Error))
            .unwrap();

        assert!(existing_kernel_response(&room).await.is_none());
        assert!(room.active_kernel_launch().is_some());
    }

    #[tokio::test]
    async fn stale_agent_cleanup_preserves_replacement_launch() {
        let (_tmp, room) = test_room();
        *room.current_runtime_agent_id.write().await = Some("replacement-agent".to_string());
        assert!(
            room.record_active_kernel_launch_if_current(
                "replacement-agent".to_string(),
                "python".to_string(),
                EnvSource::Prewarmed(PackageManager::Uv),
            )
            .await
        );

        assert!(
            !room
                .record_active_kernel_launch_if_current(
                    "stale-agent".to_string(),
                    "deno".to_string(),
                    EnvSource::Deno,
                )
                .await
        );

        room.clear_active_kernel_launch_if_agent("stale-agent");

        assert_eq!(
            room.active_kernel_launch()
                .map(|active| active.runtime_agent_id),
            Some("replacement-agent".to_string())
        );
    }

    #[tokio::test]
    async fn manual_launch_joins_exact_auto_launch_generation() {
        let (_tmp, room) = test_room();
        let auto_attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto-launch should be admitted"),
        };

        assert_eq!(
            match room.try_begin_manual_launch() {
                ManualLaunchAdmission::InFlight { generation, .. } => generation,
                ManualLaunchAdmission::Admitted(_) => {
                    panic!("manual launch must join the auto-launch")
                }
            },
            1
        );
        auto_attempt.release_without_cooldown();
    }

    #[tokio::test]
    async fn concurrent_manual_launches_share_one_generation() {
        let (_tmp, room) = test_room();
        let first = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("first manual launch should be admitted")
            }
        };

        assert_eq!(
            match room.try_begin_manual_launch() {
                ManualLaunchAdmission::InFlight { generation, .. } => generation,
                ManualLaunchAdmission::Admitted(_) => {
                    panic!("second manual launch must join the first")
                }
            },
            1
        );
        first.release_without_cooldown();
    }

    #[tokio::test]
    async fn failed_manual_launch_does_not_arm_auto_launch_cooldown() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("first manual launch should be admitted")
            }
        };
        drop(attempt);
        while room.launch_completion(1).is_none() {
            tokio::task::yield_now().await;
        }

        match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt.release_without_cooldown(),
            AutoLaunchAdmission::InFlight { .. } => {
                panic!("manual failure must release the gate")
            }
            AutoLaunchAdmission::CoolingDown { .. } => {
                panic!("manual failure must not throttle reconnect-driven launch")
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn manual_retry_preserves_existing_auto_launch_cooldown() {
        let (_tmp, room) = test_room();
        let auto_attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto launch should be admitted"),
        };
        drop(auto_attempt);
        while room.launch_completion(1).is_none() {
            tokio::task::yield_now().await;
        }

        let manual_attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("manual launch must bypass reconnect cooldown")
            }
        };
        drop(manual_attempt);
        while room.launch_completion(2).is_none() {
            tokio::task::yield_now().await;
        }
        assert!(matches!(
            room.try_begin_auto_launch(),
            AutoLaunchAdmission::CoolingDown { .. }
        ));

        tokio::time::advance(crate::notebook_sync_server::AUTO_LAUNCH_FAILURE_COOLDOWN).await;
        match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt.release_without_cooldown(),
            _ => panic!("original cooldown should expire normally"),
        }
    }

    #[tokio::test]
    async fn shutdown_cancellation_wins_manual_success_linearization() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("first manual launch should be admitted")
            }
        };
        assert_eq!(room.cancel_in_flight_launch(), Some(1));

        let cancelled_attempt = attempt
            .succeed()
            .expect_err("shutdown must prevent launch success from linearizing");
        assert!(matches!(
            room.try_begin_manual_launch(),
            ManualLaunchAdmission::InFlight { generation: 1, .. }
        ));
        cancelled_attempt.finish_cancelled();

        assert_eq!(
            room.launch_completion(1),
            Some(KernelLaunchCompletion::Cancelled)
        );
        match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt.release_without_cooldown(),
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("cancelled owner must release after cleanup")
            }
        }
    }

    #[tokio::test]
    async fn cancelled_manual_success_does_not_publish_launched_config() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => panic!("launch should be admitted"),
        };
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        room.expect_runtime_agent("agent-1");
        assert!(room.mark_runtime_agent_connected("agent-1"));
        assert_eq!(room.cancel_in_flight_launch(), Some(1));
        let mut launch_attempt = Some(attempt);
        let launched_config = notebook_protocol::protocol::LaunchedEnvConfig {
            launch_id: Some("cancelled-launch".to_string()),
            ..Default::default()
        };

        assert!(complete_manual_launch(
            &room,
            &mut launch_attempt,
            "agent-1",
            "python",
            &EnvSource::Prewarmed(PackageManager::Uv),
            &launched_config,
            None,
        )
        .await
        .is_err());
        assert!(room.runtime_agent_launched_config.read().await.is_none());
    }

    #[tokio::test]
    async fn abandoned_manual_launch_cleans_agent_slots_before_releasing_gate() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => panic!("launch should be admitted"),
        };
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        assert!(attempt.expect_runtime_agent("agent-1"));
        let (request_tx, _request_rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(request_tx);
        let (connect_tx, _connect_rx) = tokio::sync::oneshot::channel();
        *room.pending_runtime_agent_connect_tx.lock().await = Some(connect_tx);
        room.state
            .with_doc(|doc| doc.set_lifecycle(&RuntimeLifecycle::Launching))
            .unwrap();

        drop(attempt);
        for _ in 0..20 {
            if room.launch_completion(1).is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(
            room.launch_completion(1),
            Some(KernelLaunchCompletion::Failed)
        );
        assert!(room.current_runtime_agent_id.read().await.is_none());
        assert!(room.runtime_agent_request_tx.lock().await.is_none());
        assert!(room.pending_runtime_agent_connect_tx.lock().await.is_none());
        assert_eq!(
            room.state
                .read(|doc| doc.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Error
        );
    }

    #[tokio::test]
    async fn cancelled_attempt_drop_preserves_runtime_agent_disconnect_error() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => panic!("launch should be admitted"),
        };
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        assert!(attempt.expect_runtime_agent("agent-1"));
        assert!(room.mark_runtime_agent_connected("agent-1"));
        assert!(room.disconnect_runtime_agent_and_commit_terminal(
            "agent-1",
            || {},
            |doc| doc.set_lifecycle_with_error_details(
                &RuntimeLifecycle::Error,
                None,
                Some("Runtime agent disconnected"),
            ),
        ));

        drop(attempt);
        for _ in 0..20 {
            if room.launch_completion(1).is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(
            room.launch_completion(1),
            Some(KernelLaunchCompletion::Cancelled)
        );
        let state = room.state.read(|doc| doc.read_state()).unwrap();
        assert_eq!(state.kernel.lifecycle, RuntimeLifecycle::Error);
        assert_eq!(
            state.kernel.error_details.as_deref(),
            Some("Runtime agent disconnected")
        );
    }

    #[tokio::test]
    async fn cancelled_launch_cannot_regress_shutdown_projection() {
        let (_tmp, room) = test_room();
        let attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => panic!("launch should be admitted"),
        };
        assert_eq!(room.cancel_in_flight_launch(), Some(1));
        room.state
            .with_doc(|doc| doc.set_lifecycle(&RuntimeLifecycle::Shutdown))
            .unwrap();

        let committed = room.commit_unless_launch_cancelled(|| {
            room.state
                .with_doc(|doc| doc.set_lifecycle(&RuntimeLifecycle::PreparingEnv))
        });
        assert!(committed.is_none());
        assert_eq!(
            room.state
                .read(|doc| doc.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Shutdown
        );
        attempt.finish_cancelled();
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_join_retains_launch_timeout_while_owner_cleanup_continues() {
        let (_tmp, room) = test_room();
        let owner = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto-launch should be admitted"),
        };
        let (generation, cancel_rx) = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::InFlight {
                generation,
                cancel_rx,
            } => (generation, cancel_rx),
            ManualLaunchAdmission::Admitted(_) => {
                panic!("manual request must join the auto-launch")
            }
        };
        let waiter = tokio::spawn({
            let room = Arc::clone(&room);
            async move { wait_for_joined_launch(&room, generation, cancel_rx).await }
        });

        assert_eq!(room.cancel_in_flight_launch(), Some(generation));
        tokio::task::yield_now().await;
        tokio::time::advance(std::time::Duration::from_secs(61)).await;
        tokio::task::yield_now().await;
        assert_eq!(waiter.await.unwrap(), Err(()));
        assert!(
            matches!(
                room.try_begin_manual_launch(),
                ManualLaunchAdmission::InFlight { generation: 1, .. }
            ),
            "timing out a joined request must not release the owner's safety fence"
        );
        owner.finish_cancelled();
    }

    #[tokio::test]
    async fn manual_launch_can_take_over_after_benign_release_without_successor() {
        let (_tmp, room) = test_room();
        let auto_attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto-launch should be admitted"),
        };
        auto_attempt.release_without_cooldown();

        match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt.release_without_cooldown(),
            ManualLaunchAdmission::InFlight { .. } => {
                panic!("manual launch should take ownership after release")
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn failed_auto_launch_cannot_reuse_stale_active_response() {
        let (_tmp, room) = test_room();
        *room.current_runtime_agent_id.write().await = Some("agent-1".to_string());
        assert!(
            room.record_active_kernel_launch_if_current(
                "agent-1".to_string(),
                "python".to_string(),
                EnvSource::Prewarmed(PackageManager::Uv),
            )
            .await
        );
        let attempt = match room.try_begin_auto_launch() {
            AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("auto-launch should be admitted"),
        };
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Launching))
            .unwrap();
        room.clear_active_kernel_launch();
        drop(attempt);

        assert_eq!(
            wait_for_launch_generation(&room, 1).await,
            KernelLaunchCompletion::Failed
        );
        assert!(existing_kernel_response(&room).await.is_none());
    }

    /// An Apply that parks at the project trust gate restores the kernel it
    /// preserved. The generation still reports the trust refusal to joiners,
    /// not the old kernel as a launch success, and the old kernel's agent
    /// slots survive.
    #[tokio::test]
    async fn apply_trust_refusal_keeps_prior_kernel_and_reports_refusal() {
        let (_tmp, room) = test_room();
        *room.current_runtime_agent_id.write().await = Some("old-agent".to_string());
        assert!(
            room.record_active_kernel_launch_if_current(
                "old-agent".to_string(),
                "python".to_string(),
                EnvSource::Prewarmed(PackageManager::Uv),
            )
            .await
        );
        let (request_tx, _request_rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(request_tx);
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle)))
            .unwrap();

        let mut attempt = match room.try_begin_manual_launch() {
            ManualLaunchAdmission::Admitted(attempt) => attempt,
            ManualLaunchAdmission::InFlight { .. } => panic!("launch should be admitted"),
        };
        attempt.preserve_kernel_during_preparation();
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::AwaitingProjectTrust))
            .unwrap();
        let mut launch_attempt = Some(attempt);
        let response = refuse_for_project_trust(&mut launch_attempt);
        launch_attempt.unwrap().release_to_prior_kernel();
        tokio::task::yield_now().await;

        assert!(matches!(response, NotebookResponse::GuardRejected { .. }));
        assert_eq!(
            room.launch_completion(1),
            Some(KernelLaunchCompletion::ProjectTrustRequired)
        );
        assert_eq!(
            room.current_runtime_agent_id.read().await.as_deref(),
            Some("old-agent")
        );
        assert!(room.runtime_agent_request_tx.lock().await.is_some());
        assert!(room.active_kernel_launch().is_some());
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Running(KernelActivity::Idle)
        );
        match joined_launch_response(&room, Ok(KernelLaunchCompletion::ProjectTrustRequired)).await
        {
            Some(NotebookResponse::GuardRejected { reason }) => {
                assert_eq!(reason, crate::project_trust::LAUNCH_REFUSAL_REASON)
            }
            other => panic!("joiner must get the trust refusal, got {other:?}"),
        }
    }
}
