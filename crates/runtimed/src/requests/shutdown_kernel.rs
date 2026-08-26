//! `NotebookRequest::ShutdownKernel` handler.

use notebook_doc::presence;

use crate::notebook_sync_server::{
    send_runtime_agent_request, update_kernel_presence_locked, NotebookRoom,
};
use crate::protocol::NotebookResponse;

async fn begin_shutdown_with_agent_policy(
    room: &NotebookRoom,
    invalidate_runtime_agent: bool,
) -> Option<u64> {
    // Presence and RuntimeStateDoc become terminal at the same launch-gate
    // linearization point. Success takes these locks in the same order, so it
    // cannot republish Idle/Running after this shutdown is accepted.
    let env_source = room
        .active_kernel_launch()
        .map(|launch| launch.env_source.as_str().to_string())
        .unwrap_or_default();
    {
        let mut presence_state = room.broadcasts.presence.write().await;
        let commit_presence = || {
            update_kernel_presence_locked(
                &mut presence_state,
                &room.broadcasts.presence_tx,
                presence::KernelStatus::Shutdown,
                &env_source,
            );
        };
        if invalidate_runtime_agent {
            room.cancel_launch_and_mark_teardown_with(commit_presence)
        } else {
            room.cancel_launch_and_mark_shutdown_with(commit_presence)
        }
    }
}

pub(crate) async fn begin_shutdown(room: &NotebookRoom) -> Option<u64> {
    begin_shutdown_with_agent_policy(room, false).await
}

pub(crate) async fn begin_teardown(room: &NotebookRoom) -> Option<u64> {
    begin_shutdown_with_agent_policy(room, true).await
}

pub(crate) async fn handle(room: &NotebookRoom) -> NotebookResponse {
    let cancelled_launch = begin_shutdown(room).await;

    // Send shutdown RPC but keep the runtime agent alive — it stays
    // connected for potential RestartKernel. The kernel process dies
    // but the runtime agent subprocess and socket connection remain.
    let has_runtime_agent = room.runtime_agent_request_tx.lock().await.is_some();
    if has_runtime_agent {
        let _ = send_runtime_agent_request(
            room,
            notebook_protocol::protocol::RuntimeAgentRequest::ShutdownKernel,
        )
        .await;
        // Keep runtime agent alive (runtime_agent_handle + runtime_agent_request_tx stay set)
        // so LaunchKernel can send RestartKernel. ExecuteCell/RunAllCells
        // check kernel.lifecycle from RuntimeStateDoc and return NoKernel
        // when it's Shutdown.
        //
    }
    if has_runtime_agent || cancelled_launch.is_some() {
        NotebookResponse::KernelShuttingDown {}
    } else {
        NotebookResponse::NoKernel {}
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use runtime_doc::{KernelActivity, QueueEntry, RuntimeLifecycle};

    use super::*;
    use crate::blob_store::BlobStore;

    #[tokio::test]
    async fn shutdown_without_agent_clears_stale_running_projection() {
        let tmp = tempfile::TempDir::new().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            false,
        ));
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle)))
            .unwrap();

        assert!(matches!(handle(&room).await, NotebookResponse::NoKernel {}));
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Shutdown
        );
    }

    #[tokio::test]
    async fn shutdown_terminalizes_queued_and_running_executions() {
        let tmp = tempfile::TempDir::new().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            false,
        ));
        room.state
            .with_doc(|state| {
                state.create_execution("queued")?;
                state.create_execution("running")?;
                state.set_execution_running("running")?;
                let running = QueueEntry {
                    execution_id: "running".to_string(),
                };
                let queued = [QueueEntry {
                    execution_id: "queued".to_string(),
                }];
                state.set_queue(Some(&running), &queued)?;
                state.set_env_progress("uv", &serde_json::json!({"phase": "installing"}))?;
                Ok(())
            })
            .unwrap();

        assert!(matches!(handle(&room).await, NotebookResponse::NoKernel {}));
        room.state
            .read(|state| {
                assert_eq!(state.get_execution("queued").unwrap().status, "cancelled");
                let running = state.get_execution("running").unwrap();
                assert_eq!(running.status, "error");
                assert_eq!(running.success, Some(false));
                let queue = state.read_state().queue;
                assert!(queue.executing.is_none());
                assert!(queue.queued.is_empty());
                assert!(state.read_state().env.progress.is_none());
            })
            .unwrap();
    }

    #[tokio::test]
    async fn shutdown_without_agent_cancels_in_flight_launch() {
        let tmp = tempfile::TempDir::new().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            false,
        ));
        let attempt = match room.try_begin_auto_launch() {
            crate::notebook_sync_server::AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("first launch should be admitted"),
        };
        room.state
            .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::PreparingEnv))
            .unwrap();

        assert!(matches!(
            handle(&room).await,
            NotebookResponse::KernelShuttingDown {}
        ));
        assert!(attempt.is_cancelled());
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Shutdown
        );
        crate::notebook_sync_server::reset_starting_state_with_outcome(
            &room,
            None,
            crate::notebook_sync_server::ResetOutcome::Error {
                reason: None,
                details: "late launch failure",
            },
        )
        .await;
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Shutdown,
            "late launch cleanup must not overwrite the accepted shutdown"
        );
        assert!(matches!(
            room.try_begin_manual_launch(),
            crate::notebook_sync_server::ManualLaunchAdmission::InFlight { .. }
        ));

        attempt.finish_cancelled();
        assert_eq!(
            room.launch_completion(1),
            Some(crate::notebook_sync_server::KernelLaunchCompletion::Cancelled)
        );
        match room.try_begin_manual_launch() {
            crate::notebook_sync_server::ManualLaunchAdmission::Admitted(attempt) => {
                attempt.release_without_cooldown()
            }
            _ => panic!("cancelled owner should release the gate"),
        }
    }

    #[tokio::test]
    async fn accepted_shutdown_cannot_be_overwritten_by_concurrent_launch_reset() {
        for _ in 0..100 {
            let tmp = tempfile::TempDir::new().unwrap();
            let room = Arc::new(NotebookRoom::new_fresh(
                uuid::Uuid::new_v4(),
                None,
                tmp.path(),
                Arc::new(BlobStore::new(tmp.path().join("blobs"))),
                false,
            ));
            let attempt = match room.try_begin_auto_launch() {
                crate::notebook_sync_server::AutoLaunchAdmission::Admitted(attempt) => attempt,
                _ => panic!("first launch should be admitted"),
            };
            room.state
                .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::PreparingEnv))
                .unwrap();

            let reset = tokio::spawn({
                let room = Arc::clone(&room);
                async move {
                    crate::notebook_sync_server::reset_starting_state_with_outcome(
                        &room,
                        None,
                        crate::notebook_sync_server::ResetOutcome::Error {
                            reason: None,
                            details: "concurrent launch failure",
                        },
                    )
                    .await;
                }
            });
            let shutdown = tokio::spawn({
                let room = Arc::clone(&room);
                async move { handle(&room).await }
            });
            let (_, response) = tokio::join!(reset, shutdown);
            assert!(matches!(
                response.unwrap(),
                NotebookResponse::KernelShuttingDown {}
            ));
            attempt.finish_cancelled();
            assert_eq!(
                room.state
                    .read(|sd| sd.read_state().kernel.lifecycle)
                    .unwrap(),
                RuntimeLifecycle::Shutdown
            );
        }
    }

    #[tokio::test]
    async fn accepted_shutdown_prevents_success_projection_from_republishing_running() {
        let tmp = tempfile::TempDir::new().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(BlobStore::new(tmp.path().join("blobs"))),
            false,
        ));
        let attempt = match room.try_begin_auto_launch() {
            crate::notebook_sync_server::AutoLaunchAdmission::Admitted(attempt) => attempt,
            _ => panic!("first launch should be admitted"),
        };
        assert!(matches!(
            handle(&room).await,
            NotebookResponse::KernelShuttingDown {}
        ));

        let projection_ran = std::cell::Cell::new(false);
        let cancelled_attempt = match attempt.succeed_with(|| {
            projection_ran.set(true);
            room.state
                .with_doc(|sd| sd.set_lifecycle(&RuntimeLifecycle::Running(KernelActivity::Idle)))
                .unwrap();
        }) {
            Err(attempt) => attempt,
            Ok(()) => panic!("shutdown must win success linearization"),
        };
        assert!(
            !projection_ran.get(),
            "cancelled success must not run its Idle/Running projection"
        );
        assert_eq!(
            room.state
                .read(|sd| sd.read_state().kernel.lifecycle)
                .unwrap(),
            RuntimeLifecycle::Shutdown
        );
        let presence_state = room.broadcasts.presence.read().await;
        let daemon = presence_state.peers().get("daemon").unwrap();
        match daemon.channels.get(&presence::Channel::KernelState) {
            Some(presence::ChannelData::KernelState(data)) => {
                assert_eq!(data.status, presence::KernelStatus::Shutdown)
            }
            other => panic!("expected shutdown kernel presence, got {other:?}"),
        }
        drop(presence_state);
        cancelled_attempt.finish_cancelled();
    }
}
