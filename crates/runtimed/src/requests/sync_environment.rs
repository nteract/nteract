//! `NotebookRequest::SyncEnvironment` handler.
//!
//! Thin wrapper that delegates to `notebook_sync_server::handle_sync_environment`.
//! The actual logic (hot-install packages into the running kernel) is large
//! enough to warrant its own file in a follow-up; the wrapper is here so the
//! dispatcher reads uniformly.

use crate::notebook_sync_server::{handle_sync_environment, NotebookRoom};
use crate::protocol::{DependencyGuard, NotebookResponse};
use crate::requests::guarded;

pub(crate) async fn handle(
    room: &NotebookRoom,
    guard: Option<DependencyGuard>,
) -> NotebookResponse {
    if let Err(rejection) = guarded::ensure_trusted(room).await {
        return rejection.into_response();
    }

    let selected_conda_environment = room
        .runtime_agent_launched_config
        .read()
        .await
        .as_ref()
        .is_some_and(|config| config.environment_id.is_some())
        && room
            .state
            .read(|sd| sd.read_state().kernel.env_source == "conda:existing:local")
            .unwrap_or(false);

    if let Some(guard) = guard {
        let doc = room.doc.read().await;
        if let Err(rejection) = guarded::validate_sync_environment(&doc, &guard.observed_heads) {
            return rejection.into_response();
        }
    } else if selected_conda_environment {
        return NotebookResponse::GuardRejected {
            reason: "Review and approve the notebook dependencies before syncing.".into(),
        };
    }

    handle_sync_environment(room).await
}
