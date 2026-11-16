//! Isolated preparation for an explicitly reviewed Conda operation.
//!
//! No production caller enables this yet. An owner must keep the prepared
//! inputs and consent session outside shared documents, revalidate current
//! notebook/selection/cancellation state in `validate`, and atomically publish
//! the completed prefix under its own operation lease. Preparation never
//! reuses a cached/pool prefix or reconstructs a lock into an existing prefix.
//! Conda embeds prefix paths, so publication retains the original unique path
//! rather than renaming it. An obsolete operation can only modify its private,
//! unpublished staging prefix; it cannot mutate a live environment.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use rattler_conda_types::ChannelConfig;
use sha2::{Digest, Sha256};

pub mod quarantine;

use super::{CondaDependencies, CondaEnvironment};
use crate::channel_review::authorization::{
    AuthorizedChannelPlan, ChannelConsentSession, ReviewFence,
};
use crate::progress::ProgressHandler;

/// Immutable inputs captured before discovery. Never accept this from a client.
/// Not Clone/Serialize: one prepared operation owns one unique target.
pub struct PreparedCondaInstall {
    dependencies: CondaDependencies,
    fence: ReviewFence,
    staging_root: PathBuf,
}

impl PreparedCondaInstall {
    /// Pure preparation: canonicalize declared channels and bind every installer
    /// input plus the owner's document revision to the review fence. No I/O.
    pub fn new(
        owner: String,
        generation: u64,
        document_revision: &str,
        mut dependencies: CondaDependencies,
        staging_root: &Path,
    ) -> Result<Self> {
        if !staging_root.is_absolute() {
            bail!("Reviewed Conda preparation requires an absolute staging root");
        }
        let (specs, constraints) =
            crate::python::solve_specs(&super::build_spec_strings(&dependencies))?;
        if specs
            .iter()
            .chain(&constraints)
            .any(|spec| spec.channel.is_some() || spec.url.is_some())
        {
            bail!("Channel-qualified and direct-URL specs require a separate reviewed source plan");
        }
        let platform = crate::conda_solve_platform()?;
        let config = ChannelConfig::default_with_root_dir(staging_root.to_path_buf());
        dependencies.channels =
            crate::channels::parse_channels(&dependencies.channels, &config, platform)?
                .into_iter()
                .map(|channel| channel.base_url.to_string())
                .collect();
        let mut seen = std::collections::HashSet::new();
        dependencies
            .channels
            .retain(|channel| seen.insert(channel.clone()));
        let mut hasher = Sha256::new();
        hasher.update(serde_json::to_vec(&(
            &dependencies,
            document_revision,
            platform.to_string(),
        ))?);
        let target = quarantine::owner_directory(staging_root)
            .join(format!("prefix-{}", uuid::Uuid::new_v4()));
        let fence = ReviewFence {
            owner,
            dependency_revision: hex::encode(hasher.finalize()),
            environment: target
                .to_str()
                .context("Reviewed Conda target must be UTF-8")?
                .to_owned(),
            generation,
        };
        Ok(Self {
            dependencies,
            fence,
            staging_root: staging_root.to_path_buf(),
        })
    }

    pub fn fence(&self) -> &ReviewFence {
        &self.fence
    }

    pub fn declared_channels(&self) -> &[String] {
        &self.dependencies.channels
    }

    pub fn consent_session(&self, scoped_client: bool) -> ChannelConsentSession {
        ChannelConsentSession::new(
            self.fence.clone(),
            self.dependencies.channels.clone(),
            scoped_client,
        )
    }

    /// Consume final source authorization and build only in a new private prefix.
    /// `validate` checks owner state, not a runtime-document projection. A change
    /// during a long installer effect cannot affect any previously live prefix;
    /// validation after that effect prevents stale publication.
    pub async fn stage(
        self,
        authorization: AuthorizedChannelPlan,
        validate: &(dyn Fn(&ReviewFence) -> Result<()> + Send + Sync),
        handler: Arc<dyn ProgressHandler>,
    ) -> Result<StagedCondaEnvironment> {
        validate(&self.fence)?;
        if authorization.review().declared_channels != self.dependencies.channels {
            bail!("Reviewed Conda declared channels do not match prepared inputs");
        }
        let channels = authorization
            .into_channels(&self.fence)
            .map_err(|_| anyhow!("Reviewed Conda authorization no longer matches preparation"))?;
        let mut dependencies = self.dependencies;
        dependencies.channels = channels;
        let target = PathBuf::from(&self.fence.environment);
        validate(&self.fence)?;
        let root = self.staging_root;
        let fence = self.fence;
        // Construct ownership in the same blocking operation as exclusive
        // creation. If the request is cancelled while awaiting it, dropping
        // the task's result still retains ownership of the unpublished prefix.
        // Interrupted installations quarantine rather than racing their writers.
        let mut stage = tokio::task::spawn_blocking(move || -> Result<StagedCondaEnvironment> {
            quarantine::ensure_owner(&root)?;
            // Never claim, delete or overwrite an existing target.
            std::fs::create_dir(&target)?;
            let record = quarantine::record_for(&target)?;
            quarantine::write_scope(&record, quarantine::WriterScope::ProcessLocal)?;
            Ok(StagedCondaEnvironment {
                environment: CondaEnvironment {
                    python_path: target.join(if cfg!(windows) {
                        "python.exe"
                    } else {
                        "bin/python"
                    }),
                    env_path: target,
                },
                fence,
                retained: false,
                cleanup_safe: true,
                record: Some(record),
            })
        })
        .await??;
        // Persist before any installer/subprocess-capable effect. A parent
        // lease cannot prove descendants died, even after successful vendoring.
        persist_external_scope(&mut stage, |record| {
            quarantine::write_scope(&record, quarantine::WriterScope::ExternalWriters)
        })
        .await?;
        let check = || validate(&stage.fence);
        super::install_conda_env_guarded(
            &stage.environment.env_path,
            &dependencies,
            handler,
            &check,
        )
        .await?;
        // Do not enable cleanup yet: launcher vendoring also schedules
        // filesystem writes which can outlive cancellation of its future.
        validate(&stage.fence)?;
        if !stage.environment.python_path.is_file() {
            bail!("Reviewed Conda preparation did not produce Python");
        }
        crate::launcher::vendor_into_venv(&stage.environment.python_path)
            .await
            .context("vendor launcher into reviewed Conda staging prefix")?;
        // Do not infer process-tree quiescence from awaited child completion.
        // Any unpublished prefix that entered this phase remains quarantined.
        validate(&stage.fence)?;
        Ok(stage)
    }
}

/// An unpublished prefix. Only pre-installer process-local stages may be
/// cleaned on drop/restart. Installer/vendor stages remain quarantined even on
/// success: detached or descendant processes are not covered by a parent lock.
/// Production enablement remains gated on a stronger process-tree lifecycle.
/// The owner must atomically validate and publish in `commit`, never extract a
/// path and publish it later after releasing its operation lease.
pub struct StagedCondaEnvironment {
    environment: CondaEnvironment,
    fence: ReviewFence,
    retained: bool,
    cleanup_safe: bool,
    record: Option<PathBuf>,
}

async fn persist_external_scope(
    stage: &mut StagedCondaEnvironment,
    write: impl FnOnce(PathBuf) -> Result<()> + Send + 'static,
) -> Result<()> {
    let record = stage.record.clone().context("missing quarantine record")?;
    // The durable transition can outlive cancellation. Never delete the prefix
    // while its blocking writer is queued or running, even if the write fails.
    stage.cleanup_safe = false;
    tokio::task::spawn_blocking(move || write(record)).await??;
    Ok(())
}

impl StagedCondaEnvironment {
    /// Durable retain-before-publication performs synchronous filesystem I/O.
    /// Invoke from an owner-controlled blocking context, not a Tokio worker.
    pub fn commit<T>(
        mut self,
        publish: impl FnOnce(&ReviewFence, &CondaEnvironment) -> Result<T>,
    ) -> Result<T> {
        if let Some(record) = &self.record {
            // Mark before publishing: a crash can leak an unneeded prefix, but
            // recovery must never delete one already visible to a kernel.
            quarantine::write_scope(record, quarantine::WriterScope::Retained)?;
        }
        let result = publish(&self.fence, &self.environment)?;
        self.retained = true;
        Ok(result)
    }
}

impl Drop for StagedCondaEnvironment {
    fn drop(&mut self) {
        if self.retained {
            return;
        }
        if !self.cleanup_safe {
            log::warn!("Quarantined interrupted reviewed Conda prefix at {:?}; cleanup requires writer quiescence", self.environment.env_path);
            return;
        }
        let path = self.environment.env_path.clone();
        let record = self.record.clone();
        // Cleanup must not block the Tokio worker and must outlive cancellation
        // of the request future. No shared/cache/live prefix is ever owned here.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(move || {
                if let Err(error) = std::fs::remove_dir_all(&path) {
                    log::warn!("Could not remove discarded reviewed Conda prefix: {error}");
                } else if let Some(record) = record {
                    let _ = std::fs::remove_file(record);
                }
            });
        } else if let Err(error) = std::fs::remove_dir_all(&path) {
            log::warn!("Could not remove discarded reviewed Conda prefix: {error}");
        } else if let Some(record) = record {
            let _ = std::fs::remove_file(record);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deps() -> CondaDependencies {
        CondaDependencies {
            dependencies: vec!["numpy".into()],
            channels: vec!["https://repo.test/main".into()],
            python: Some(">=3.11".into()),
            env_id: Some("owner-env".into()),
        }
    }

    fn prepare(
        dependencies: CondaDependencies,
        revision: &str,
        root: &Path,
    ) -> PreparedCondaInstall {
        PreparedCondaInstall::new("room-a".into(), 7, revision, dependencies, root).unwrap()
    }

    #[test]
    fn preparation_is_pure_unique_and_binds_all_inputs() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("not-created");
        let first = prepare(deps(), "heads-a", &root);
        let second = prepare(deps(), "heads-a", &root);
        assert!(!root.exists());
        assert_eq!(first.declared_channels(), &["https://repo.test/main/"]);
        assert_eq!(
            first.fence.dependency_revision,
            second.fence.dependency_revision
        );
        assert_ne!(first.fence.environment, second.fence.environment);
        assert_ne!(
            first.fence.dependency_revision,
            prepare(deps(), "heads-b", &root).fence.dependency_revision
        );
        for field in 0..4 {
            let mut changed = deps();
            match field {
                0 => changed.dependencies.push("pandas".into()),
                1 => changed.channels.push("https://repo.test/other/".into()),
                2 => changed.python = Some("3.12".into()),
                _ => changed.env_id = Some("different-env".into()),
            }
            assert_ne!(
                first.fence.dependency_revision,
                prepare(changed, "heads-a", &root).fence.dependency_revision
            );
        }
    }

    #[test]
    fn declared_canonical_roots_deduplicate_in_priority_order() {
        let temporary = tempfile::tempdir().unwrap();
        let mut dependencies = deps();
        dependencies.channels = vec![
            "main".into(),
            "https://repo.anaconda.com/pkgs/main/".into(),
            "https://repo.test/other".into(),
            "https://repo.test/other/".into(),
        ];
        let prepared = prepare(dependencies, "heads", temporary.path());
        assert_eq!(
            prepared.declared_channels(),
            &[
                "https://repo.anaconda.com/pkgs/main/",
                "https://repo.test/other/"
            ]
        );
    }

    #[tokio::test]
    async fn interrupted_writer_is_quarantined_not_raced_by_cleanup() {
        let temporary = tempfile::tempdir().unwrap();
        for cancelled in [false, true] {
            let path = temporary
                .path()
                .join(if cancelled { "cancelled" } else { "failed" });
            let mut stage = staged(&path);
            stage.cleanup_safe = false;
            let (release, wait) = std::sync::mpsc::channel();
            let writer_path = path.clone();
            let writer = tokio::task::spawn_blocking(move || {
                wait.recv().unwrap();
                std::fs::write(writer_path.join("late-write"), b"finished").unwrap();
            });
            if cancelled {
                let (ready, started) = tokio::sync::oneshot::channel();
                let task = tokio::spawn(async move {
                    let _owned = stage;
                    ready.send(()).unwrap();
                    std::future::pending::<()>().await;
                });
                started.await.unwrap();
                task.abort();
                let _ = task.await;
            } else {
                // Installer returned its first error while another writer lives.
                drop(stage);
            }
            assert!(path.join("marker").exists());
            release.send(()).unwrap();
            writer.await.unwrap();
            assert_eq!(std::fs::read(path.join("late-write")).unwrap(), b"finished");
        }
    }

    #[test]
    fn unsupported_sources_and_relative_targets_fail_before_io() {
        let temporary = tempfile::tempdir().unwrap();
        assert!(PreparedCondaInstall::new(
            "owner".into(),
            1,
            "heads",
            deps(),
            Path::new("relative")
        )
        .is_err());
        for package in ["other::numpy", "numpy[url='https://repo.test/numpy.conda']"] {
            let mut dependencies = deps();
            dependencies.dependencies = vec![package.into()];
            assert!(PreparedCondaInstall::new(
                "owner".into(),
                1,
                "heads",
                dependencies,
                temporary.path()
            )
            .is_err());
        }
        assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 0);
    }

    fn staged(path: &Path) -> StagedCondaEnvironment {
        std::fs::create_dir(path).unwrap();
        std::fs::write(path.join("marker"), b"private").unwrap();
        StagedCondaEnvironment {
            environment: CondaEnvironment {
                env_path: path.into(),
                python_path: path.join("python"),
            },
            fence: ReviewFence {
                owner: "room-a".into(),
                dependency_revision: "heads-a".into(),
                environment: path.to_str().unwrap().into(),
                generation: 7,
            },
            retained: false,
            cleanup_safe: true,
            record: None,
        }
    }

    #[tokio::test]
    async fn cancelled_scope_transition_retains_its_prefix_until_writer_finishes() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("stage");
        let record = temporary.path().join("scope.state");
        let mut stage = staged(&path);
        stage.record = Some(record.clone());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            persist_external_scope(&mut stage, move |record| {
                let _ = started_tx.send(());
                wait.recv().unwrap();
                quarantine::write_scope(&record, quarantine::WriterScope::ExternalWriters)?;
                let _ = done_tx.send(());
                Ok(())
            })
            .await
        });
        started_rx.await.unwrap();
        task.abort();
        let _ = task.await;
        assert!(path.exists());
        release.send(()).unwrap();
        done_rx.await.unwrap();
        assert!(path.exists());
        assert_eq!(
            std::fs::read_to_string(record).unwrap(),
            "external-writers-v1"
        );
    }

    #[test]
    fn stale_publication_discards_only_its_own_prefix() {
        let temporary = tempfile::tempdir().unwrap();
        let live = temporary.path().join("live");
        std::fs::create_dir(&live).unwrap();
        std::fs::write(live.join("marker"), b"live").unwrap();
        let path = temporary.path().join("stage");
        let stage = staged(&path);
        let result: Result<()> = stage.commit(|_, _| bail!("owner generation changed"));
        assert!(result.is_err());
        assert!(!path.exists());
        assert_eq!(std::fs::read(live.join("marker")).unwrap(), b"live");
    }

    #[test]
    fn accepted_publication_preserves_original_conda_prefix() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("stage");
        let published = staged(&path)
            .commit(|fence, environment| {
                assert_eq!(fence.environment, environment.env_path.to_str().unwrap());
                Ok(environment.clone())
            })
            .unwrap();
        assert_eq!(published.env_path, path);
        assert!(published.env_path.join("marker").exists());
    }

    #[tokio::test]
    async fn cancelled_process_local_stage_cleans_its_unpublished_prefix() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("stage");
        let stage = staged(&path);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _owned = stage;
            let _ = ready_tx.send(());
            std::future::pending::<()>().await;
        });
        ready_rx.await.unwrap();
        task.abort();
        let _ = task.await;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while path.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}
