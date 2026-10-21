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
    let _sync_lease = match room.local_environment_selection.begin_sync() {
        Ok(lease) => lease,
        Err(error) => return NotebookResponse::Error { error },
    };
    if room
        .runtime_agent_launched_config
        .read()
        .await
        .as_ref()
        .is_some_and(|config| config.local_environment.is_some())
    {
        return NotebookResponse::Error { error: "Package sync is disabled for a borrowed local environment; install packages externally".into() };
    }
    if let Err(rejection) = guarded::ensure_trusted(room).await {
        return rejection.into_response();
    }

    if let Some(guard) = guard {
        let doc = room.doc.read().await;
        if let Err(rejection) = guarded::validate_sync_environment(&doc, &guard.observed_heads) {
            return rejection.into_response();
        }
    }

    handle_sync_environment(room).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::sync::Arc;

    #[tokio::test]
    async fn sync_admission_blocks_apply_before_configuration_read() {
        let tmp = tempfile::TempDir::new().unwrap();
        let room = NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(crate::blob_store::BlobStore::new(tmp.path().join("blobs"))),
            false,
        );
        {
            let _config = room.runtime_agent_launched_config.write().await;
            let mut sync = Box::pin(handle(&room, None));
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(sync.as_mut().poll(&mut cx).is_pending());
            assert!(
                room.local_environment_selection.begin_apply(0).is_err(),
                "an admitted sync must fence Apply before its first await"
            );
        }
        assert!(room.local_environment_selection.begin_apply(0).is_ok());
    }

    #[tokio::test]
    async fn apply_admission_rejects_sync_before_configuration_read() {
        let tmp = tempfile::TempDir::new().unwrap();
        let room = NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(crate::blob_store::BlobStore::new(tmp.path().join("blobs"))),
            false,
        );
        let _apply = room.local_environment_selection.begin_apply(0).unwrap();
        {
            let _config = room.runtime_agent_launched_config.write().await;
            let mut sync = Box::pin(handle(&room, None));
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(matches!(
                sync.as_mut().poll(&mut cx),
                std::task::Poll::Ready(NotebookResponse::Error { error })
                    if error.contains("finish applying")
            ));
        }
        assert!(room.local_environment_selection.sync_lease().is_none());
    }

    #[tokio::test]
    async fn borrowed_environment_rejects_sync_without_changing_notebook_or_prefix() {
        let tmp = tempfile::TempDir::new().unwrap();
        let prefix = tmp.path().join("borrowed");
        std::fs::create_dir(&prefix).unwrap();
        std::fs::write(prefix.join("sentinel"), "unchanged").unwrap();
        let room = NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            tmp.path(),
            Arc::new(crate::blob_store::BlobStore::new(tmp.path().join("blobs"))),
            false,
        );
        *room.runtime_agent_launched_config.write().await =
            Some(notebook_protocol::protocol::LaunchedEnvConfig {
                local_environment: Some(notebook_protocol::protocol::LocalEnvironmentIdentity {
                    id: "borrowed".into(),
                    name: "borrowed".into(),
                    python_version: None,
                }),
                venv_path: Some(prefix.clone()),
                ..Default::default()
            });
        let before = room.doc.write().await.get_heads();
        let response = handle(&room, None).await;
        assert!(
            matches!(response, NotebookResponse::Error { error } if error.contains("borrowed"))
        );
        assert_eq!(room.doc.write().await.get_heads(), before);
        assert!(room.local_environment_selection.begin_apply(0).is_ok());
        assert_eq!(
            std::fs::read_to_string(prefix.join("sentinel")).unwrap(),
            "unchanged"
        );
    }
}
