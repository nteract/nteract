//! Manual inline Conda preparation owned by one live local connection.
//! The launch gate serializes operations; IDs and grants never come from the
//! shared runtime projection. Every install uses a fresh retained prefix.

use crate::notebook_sync_server::channel_review_connection::ChannelReviewConnection;
use crate::notebook_sync_server::{KernelLaunchAttempt, NotebookRoom};
use anyhow::{anyhow, bail, ensure, Context, Result};
use kernel_env::channel_review::authorization::{ApprovalScope, ReviewValidator};
use kernel_env::conda::reviewed::PreparedCondaInstall;
use std::sync::Arc;

pub(crate) struct ReviewGuard {
    room: Arc<NotebookRoom>,
    connection: Arc<ChannelReviewConnection>,
    heads: Vec<String>,
    selection_revision: u64,
    identity_revision: u64,
    generation: u64,
}

impl ReviewGuard {
    /// Keep all mutable input owners locked through publication/dispatch.
    /// The callback is synchronous; none of these guards crosses an await.
    pub(crate) fn with_document<T>(
        &self,
        doc: &notebook_doc::NotebookDoc,
        effect: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.connection.with_live(|| {
            super::guarded::validate_dependencies_unchanged_since_observed(doc, &self.heads)
                .map_err(|_| anyhow!("Notebook dependencies changed; review again"))?;
            ensure!(
                doc.get_metadata_snapshot()
                    .and_then(|m| m.detect_runtime())
                    .as_deref()
                    .unwrap_or("python")
                    == "python",
                "Notebook runtime changed; review again"
            );
            let trust = crate::notebook_sync_server::verify_trust_from_doc(
                doc,
                &self.room.trusted_packages,
            );
            ensure!(
                matches!(
                    trust.status,
                    runt_trust::TrustStatus::Trusted | runt_trust::TrustStatus::NoDependencies
                ),
                "Notebook trust changed; review again"
            );
            self.room
                .local_environment_selection
                .with_revision(self.selection_revision, || {
                    let identity = self
                        .room
                        .project_trust_prompt
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    ensure!(
                        identity.identity_revision == self.identity_revision,
                        "Notebook location changed; review again"
                    );
                    effect()
                })
        })
    }

    pub(crate) async fn commit<T>(&self, effect: impl FnOnce() -> Result<T>) -> Result<T> {
        let doc = self.room.doc.read().await;
        // Global owner order: launch gate, connection, selection, identity.
        self.room
            .commit_reviewed_launch(self.generation, || self.with_document(&doc, effect))
    }

    pub(crate) async fn validate(&self) -> Result<()> {
        self.commit(|| Ok(())).await
    }
}

impl ReviewValidator for ReviewGuard {
    fn validate(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> {
        Box::pin(ReviewGuard::validate(self))
    }
}

struct Projection {
    room: Arc<NotebookRoom>,
    id: String,
}
impl Drop for Projection {
    fn drop(&mut self) {
        let _ = self.room.state.with_doc(|doc| {
            if doc
                .related_channel_review()
                .is_some_and(|review| review.review_id == self.id)
            {
                doc.set_related_channel_review(None)?;
            }
            Ok(())
        });
    }
}

fn projection(
    review: &kernel_env::channel_review::authorization::PendingChannelReview,
) -> runtime_doc::RelatedChannelReview {
    use kernel_env::channel_review::RelationKind;
    runtime_doc::RelatedChannelReview {
        review_id: review.review_id.clone(),
        owner_label: "This notebook".into(),
        state: runtime_doc::RelatedChannelReviewStatus::Pending,
        scope: match review.scope {
            ApprovalScope::Metadata => runtime_doc::RelatedChannelReviewScope::Metadata,
            ApprovalScope::Install => runtime_doc::RelatedChannelReviewScope::Install,
        },
        declared_channels: review.channels.declared_channels.clone(),
        effective_channels: review.channels.effective_channels.clone(),
        uninspected_channels: review.channels.uninspected_channels.clone(),
        relations: review
            .channels
            .relations
            .iter()
            .map(|r| runtime_doc::RelatedChannelRelation {
                declaring_channel: r.declaring_channel.clone(),
                subdir: r.subdir.clone(),
                kind: match r.kind {
                    RelationKind::Base => runtime_doc::RelatedChannelRelationKind::Base,
                    RelationKind::Overrides => runtime_doc::RelatedChannelRelationKind::Overrides,
                },
                target_channel: r.target_channel.clone(),
                ignored_for_priority: r.ignored_for_priority,
            })
            .collect(),
    }
}

/// Approval is serviced directly by the peer ingress while its request worker
/// awaits launch. Ordinary requests retain their existing ordered queue.
pub(crate) async fn prepare(
    room: &Arc<NotebookRoom>,
    connection: Arc<ChannelReviewConnection>,
    attempt: &KernelLaunchAttempt,
    expected: &notebook_doc::metadata::NotebookMetadataSnapshot,
    identity_revision: u64,
    handler: Arc<dyn kernel_env::progress::ProgressHandler>,
) -> Result<Option<(kernel_env::conda::CondaEnvironment, Arc<ReviewGuard>)>> {
    let heads = {
        let mut doc = room.doc.write().await;
        let current = doc
            .get_metadata_snapshot()
            .context("Missing notebook metadata")?;
        ensure!(
            current.dependency_fingerprint() == expected.dependency_fingerprint(),
            "Notebook dependencies changed before channel review"
        );
        ensure!(
            current.detect_runtime().as_deref().unwrap_or("python") == "python",
            "Notebook runtime changed before channel review"
        );
        doc.get_heads_hex()
    };
    let selection = room.local_environment_selection.snapshot();
    ensure!(
        selection.selected.is_none() && selection.applied.is_none(),
        "Environment selection changed before channel review"
    );
    let guard = Arc::new(ReviewGuard {
        room: room.clone(),
        connection,
        heads: heads.clone(),
        selection_revision: selection.revision,
        identity_revision,
        generation: attempt.generation(),
    });
    guard.validate().await?;
    let deps = crate::notebook_sync_server::get_inline_conda_deps(expected)
        .context("Missing inline Conda dependencies")?;
    let dependencies = kernel_env::CondaDependencies {
        dependencies: crate::inline_env::inline_deps_with_conda_required_packages(&deps),
        channels: crate::notebook_sync_server::get_inline_conda_channels(expected),
        python: crate::notebook_sync_server::get_inline_conda_python(expected),
        env_id: expected.runt.env_id.clone(),
    };
    if !PreparedCondaInstall::supports_dependencies(&dependencies)? {
        return Ok(None);
    }
    // Separate from legacy cache/pool sweepers. Retained or interrupted prefixes
    // are never renamed, reused or deleted without process-tree quiescence.
    let root = kernel_env::conda::reviewed::default_root();
    let prepared = PreparedCondaInstall::new(
        room.id.to_string(),
        attempt.generation(),
        &heads.join(","),
        dependencies,
        &root,
    )?;
    let fence = prepared.fence().clone();
    let mut session = prepared.consent_session(true);
    loop {
        guard.validate().await?;
        let request = session
            .begin_discovery(&fence)
            .map_err(|e| anyhow!("Channel discovery expired: {e:?}"))?;
        let outcome = match prepared.discover(&request, guard.as_ref()).await {
            Ok(outcome) => outcome,
            Err(error) => {
                guard.validate().await?;
                if request.approved_metadata_channels().is_empty() {
                    // Discovery is an optional extension. An offline notebook
                    // with a usable declared-only cache must still launch.
                    tracing::debug!(
                        "Channel discovery unavailable; keeping declared-only resolution"
                    );
                    return Ok(None);
                }
                return Err(error);
            }
        };
        guard.validate().await?;
        if outcome.review().uninspected_channels.is_empty()
            && outcome.review().effective_channels == outcome.review().declared_channels
        {
            // The existing package/source trust grant already covers these
            // exact sources. Preserve cache/pool behavior without another prompt.
            return Ok(None);
        }
        session
            .discovered(&fence, request, outcome)
            .map_err(|e| anyhow!("Invalid channel discovery: {e:?}"))?;
        let review = session
            .pending_review()
            .context("No channel review")?
            .clone();
        let (_waiter, mut decision) = guard
            .connection
            .register(review.review_id.clone(), guard.clone())?;
        let _projection = Projection {
            room: room.clone(),
            id: review.review_id.clone(),
        };
        let mut changed = room.broadcasts.changed_tx.subscribe();
        let mut selection = room.local_environment_selection.subscribe();
        let cancellation = attempt.cancellation_receiver();
        guard
            .commit(|| {
                room.state
                    .with_doc(|doc| doc.set_related_channel_review(Some(&projection(&review))))?;
                Ok(())
            })
            .await?;
        let wait = async {
            loop {
                guard.validate().await?;
                tokio::select! {
                    value = &mut decision => return value.context("Channel review connection closed"),
                    _ = changed.recv() => {},
                    _ = selection.changed() => {},
                    _ = crate::notebook_sync_server::wait_for_kernel_launch_cancellation(cancellation.clone()) => bail!("Channel review cancelled"),
                }
            }
        };
        let approved = tokio::time::timeout(std::time::Duration::from_secs(600), wait)
            .await
            .context("Channel review expired; start the kernel again")??;
        guard.validate().await?;
        if !approved {
            session
                .decline(&fence, &review.review_id)
                .map_err(|e| anyhow!("Channel review expired: {e:?}"))?;
            bail!("Related channels declined; the existing environment was left unchanged");
        }
        let scope = session
            .approve(&fence, &review.review_id)
            .map_err(|e| anyhow!("Channel review expired: {e:?}"))?;
        if scope == ApprovalScope::Install {
            break;
        }
    }
    let authorization = session
        .take_authorization(&fence)
        .map_err(|e| anyhow!("Installation consent expired: {e:?}"))?;
    let staged = prepared
        .stage(authorization, guard.as_ref(), handler)
        .await?;
    let publication = guard.clone();
    let runtime = tokio::runtime::Handle::current();
    let environment = tokio::task::spawn_blocking(move || {
        staged.commit(|_, env| {
            runtime.block_on(publication.commit(|| {
                *publication
                    .room
                    .preparing_kernel_env_path
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(env.env_path.clone());
                Ok(env.clone())
            }))
        })
    })
    .await??;
    Ok(Some((environment, guard)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notebook_sync_server::ManualLaunchAdmission;

    #[tokio::test]
    async fn reviewed_commit_rejects_changed_inputs_and_lost_owners() {
        for change in ["deps", "selection", "identity", "shutdown", "disconnect"] {
            let temp = tempfile::tempdir().unwrap();
            let room = Arc::new(NotebookRoom::new_fresh(
                uuid::Uuid::new_v4(),
                None,
                temp.path(),
                Arc::new(crate::blob_store::BlobStore::new(temp.path().join("blobs"))),
                false,
            ));
            let heads = {
                let mut doc = room.doc.write().await;
                doc.add_cell(0, "cell", "code").unwrap();
                doc.get_heads_hex()
            };
            let ManualLaunchAdmission::Admitted(attempt) = room.try_begin_manual_launch() else {
                panic!("launch admission")
            };
            let (connection, lease) = ChannelReviewConnection::open("peer".into(), true, true);
            let guard = ReviewGuard {
                room: room.clone(),
                connection,
                heads,
                selection_revision: 0,
                identity_revision: 0,
                generation: attempt.generation(),
            };
            guard.commit(|| Ok(())).await.unwrap();
            let mut lease = Some(lease);
            match change {
                "deps" => {
                    room.doc
                        .write()
                        .await
                        .add_conda_dependency("numpy")
                        .unwrap();
                }
                "selection" => {
                    room.local_environment_selection.set(None, 0).unwrap();
                }
                "identity" => {
                    room.project_trust_prompt.lock().unwrap().identity_revision += 1;
                }
                "shutdown" => {
                    room.cancel_in_flight_launch();
                }
                "disconnect" => {
                    drop(lease.take());
                }
                _ => unreachable!(),
            }
            let mut dispatched = false;
            assert!(
                guard
                    .commit(|| {
                        dispatched = true;
                        Ok(())
                    })
                    .await
                    .is_err(),
                "{change}"
            );
            assert!(
                !dispatched,
                "{change} must fence publication and kernel dispatch"
            );
        }
    }

    #[tokio::test]
    async fn ordinary_cell_edit_does_not_revoke_dependency_consent() {
        let temp = tempfile::tempdir().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            temp.path(),
            Arc::new(crate::blob_store::BlobStore::new(temp.path().join("blobs"))),
            false,
        ));
        let heads = {
            let mut doc = room.doc.write().await;
            doc.add_cell(0, "cell", "code").unwrap();
            doc.get_heads_hex()
        };
        let ManualLaunchAdmission::Admitted(attempt) = room.try_begin_manual_launch() else {
            panic!("launch admission")
        };
        let (connection, _lease) = ChannelReviewConnection::open("peer".into(), true, true);
        let guard = ReviewGuard {
            room: room.clone(),
            connection,
            heads,
            selection_revision: 0,
            identity_revision: 0,
            generation: attempt.generation(),
        };
        room.doc
            .write()
            .await
            .update_source("cell", "1 + 1")
            .unwrap();
        guard.commit(|| Ok(())).await.unwrap();
    }

    #[tokio::test]
    async fn reviewed_validation_waits_for_document_contention() {
        use std::future::Future;
        let temp = tempfile::tempdir().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            temp.path(),
            Arc::new(crate::blob_store::BlobStore::new(temp.path().join("blobs"))),
            false,
        ));
        let heads = {
            let mut doc = room.doc.write().await;
            doc.add_cell(0, "cell", "code").unwrap();
            doc.get_heads_hex()
        };
        let ManualLaunchAdmission::Admitted(attempt) = room.try_begin_manual_launch() else {
            panic!("admission")
        };
        let (connection, _lease) = ChannelReviewConnection::open("peer".into(), true, true);
        let guard = ReviewGuard {
            room: room.clone(),
            connection,
            heads,
            selection_revision: 0,
            identity_revision: 0,
            generation: attempt.generation(),
        };
        let mut validation = std::pin::pin!(guard.validate());
        {
            let mut doc = room.doc.write().await;
            doc.update_source("cell", "2 + 2").unwrap();
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(
                validation.as_mut().poll(&mut context).is_pending(),
                "ordinary lock contention must wait, not revoke approval"
            );
        }
        validation.await.unwrap();
    }

    #[tokio::test]
    async fn reviewed_preparation_preserves_original_identity_revision() {
        let temp = tempfile::tempdir().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            temp.path(),
            Arc::new(crate::blob_store::BlobStore::new(temp.path().join("blobs"))),
            false,
        ));
        let snapshot = {
            let mut doc = room.doc.write().await;
            doc.set_metadata_snapshot(&notebook_doc::metadata::NotebookMetadataSnapshot {
                kernelspec: Some(notebook_doc::metadata::KernelspecSnapshot {
                    name: "python3".into(),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .unwrap();
            doc.get_metadata_snapshot().unwrap()
        };
        let ManualLaunchAdmission::Admitted(attempt) = room.try_begin_manual_launch() else {
            panic!("admission")
        };
        let (connection, _lease) = ChannelReviewConnection::open("peer".into(), true, true);
        room.project_trust_prompt.lock().unwrap().identity_revision = 1;
        let result = prepare(
            &room,
            connection,
            &attempt,
            &snapshot,
            0,
            Arc::new(kernel_env::progress::LogHandler),
        )
        .await;
        assert!(result
            .err()
            .unwrap()
            .to_string()
            .contains("location changed"));
    }

    #[tokio::test]
    async fn reviewed_rejected_completion_owns_gate_until_shutdown_finishes() {
        let temp = tempfile::tempdir().unwrap();
        let room = Arc::new(NotebookRoom::new_fresh(
            uuid::Uuid::new_v4(),
            None,
            temp.path(),
            Arc::new(crate::blob_store::BlobStore::new(temp.path().join("blobs"))),
            false,
        ));
        let heads = room.doc.write().await.get_heads_hex();
        let ManualLaunchAdmission::Admitted(attempt) = room.try_begin_manual_launch() else {
            panic!("admission")
        };
        let (connection, _lease) = ChannelReviewConnection::open("peer".into(), true, true);
        let guard = ReviewGuard {
            room: room.clone(),
            connection,
            heads,
            selection_revision: 0,
            identity_revision: 0,
            generation: attempt.generation(),
        };
        let agent_id = format!("review-rejection-{}", uuid::Uuid::new_v4());
        room.expect_runtime_agent(&agent_id);
        assert!(room.mark_runtime_agent_connected(&agent_id));
        *room.current_runtime_agent_id.write().await = Some(agent_id.clone());
        #[cfg(unix)]
        let agent_pid = {
            use std::os::unix::fs::PermissionsExt;
            let helper = temp.path().join("owned-agent");
            std::fs::write(&helper, "#!/bin/sh\nexec sleep 600\n").unwrap();
            std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
            let handle = crate::runtime_agent_handle::RuntimeAgentHandle::spawn(
                room.id.to_string(),
                agent_id.clone(),
                temp.path().join("blobs"),
                temp.path().join("unused.sock"),
                Some(helper),
            )
            .await
            .unwrap();
            assert!(handle.is_alive());
            let manifest: crate::runtime_agent_manifest::RuntimeAgentManifest =
                serde_json::from_slice(
                    &std::fs::read(crate::runtime_agent_manifest::manifest_path(&agent_id))
                        .unwrap(),
                )
                .unwrap();
            *room.runtime_agent_handle.lock().await = Some(handle);
            manifest.pgid.unwrap()
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        *room.runtime_agent_request_tx.lock().await = Some(tx);
        room.project_trust_prompt.lock().unwrap().identity_revision = 1;
        let task_room = room.clone();
        let task_agent_id = agent_id.clone();
        let completion = tokio::spawn(async move {
            super::super::launch_kernel::complete_manual_launch(
                &task_room,
                &mut Some(attempt),
                &task_agent_id,
                "python",
                &notebook_protocol::connection::EnvSource::Inline(
                    notebook_protocol::connection::PackageManager::Conda,
                ),
                &Default::default(),
                Some(&guard),
                None,
            )
            .await
        });
        let shutdown = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(
                room.try_begin_manual_launch(),
                ManualLaunchAdmission::InFlight { .. }
            ),
            "rejected launch must retain ownership while its shutdown RPC is pending"
        );
        assert!(room.runtime_agent_launched_config.read().await.is_none());
        drop(shutdown); // A lost acknowledgement must force agent teardown.
        assert!(completion.await.unwrap().is_err());
        assert!(room.runtime_agent_request_tx.lock().await.is_none());
        assert!(room.current_runtime_agent_id.read().await.is_none());
        assert!(
            !room.mark_runtime_agent_connected(&agent_id),
            "revoked agent cannot reconnect after failed shutdown"
        );
        #[cfg(unix)]
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match nix::sys::signal::kill(nix::unistd::Pid::from_raw(agent_pid), None) {
                    Err(nix::errno::Errno::ESRCH) => break,
                    Ok(()) => tokio::task::yield_now().await,
                    other => panic!("agent liveness check: {other:?}"),
                }
            }
        })
        .await
        .expect("failed shutdown acknowledgement must terminate the owned agent process");
        let ManualLaunchAdmission::Admitted(successor) = room.try_begin_manual_launch() else {
            panic!("cleanup must release gate")
        };
        successor.release_without_cooldown();
    }
}
