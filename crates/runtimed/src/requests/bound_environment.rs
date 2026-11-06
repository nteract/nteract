//! Host-bound environment prefix for one notebook room.
//!
//! A `CreateNotebook` request may carry an existing Conda prefix. The binding
//! fills the slot the prewarmed pool would otherwise fill: inline
//! dependencies, PEP 723 blocks, a captured environment on disk, and a project
//! file all still claim the launch first. An applied local environment
//! selection is an explicit user choice and wins over the binding.
//!
//! The prefix is borrowed. Launches go through the same `ExistingConda` path
//! as the local environment picker, so the prefix never enters the daemon's
//! cleanup slot and teardown never deletes it.
//!
//! The binding lives in room memory only. Kernel restarts and reconnects to
//! the same room reuse it; a daemon restart drops it, and the host must pass
//! it again when it recreates the room.

use std::path::PathBuf;

use notebook_protocol::connection::{
    EnvSource, LaunchSpec, LocalEnvironmentBindingStatus, PackageManager,
};
use notebook_protocol::protocol::LocalCondaEnvironment;

use crate::local_conda_environments::LocalCondaEnvironments;
use crate::notebook_sync_server::NotebookRoom;

/// Binding lifecycle for one room.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) enum BoundEnvironmentState {
    /// No host binding. Auto selection falls back to the prewarmed pool.
    #[default]
    Unbound,
    /// The prefix validated and replaces the prewarmed fallback.
    Bound(LocalCondaEnvironment),
    /// The prefix failed validation. Auto selection behaves as if unbound.
    /// Terminal until the host requests a binding again.
    Rejected { prefix: PathBuf, error: String },
}

/// Inputs that move the binding between states.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BoundEnvironmentEvent {
    /// A `CreateNotebook` request carried a prefix and it was validated.
    /// A valid prefix replaces the current state: the latest host request
    /// wins. An invalid one never downgrades a working binding, so a
    /// reconnect with a bad prefix cannot strand a bound room.
    Requested(Result<LocalCondaEnvironment, (PathBuf, String)>),
    /// A launch revalidated the bound prefix. `prefix` fences the event to the
    /// binding it read, so a late result cannot overwrite a newer request.
    LaunchRevalidated {
        prefix: PathBuf,
        result: Result<LocalCondaEnvironment, String>,
    },
}

/// Pure transition function for [`BoundEnvironmentState`].
pub(crate) fn transition(
    state: &BoundEnvironmentState,
    event: BoundEnvironmentEvent,
) -> BoundEnvironmentState {
    use BoundEnvironmentEvent as Event;
    use BoundEnvironmentState as State;
    match (state, event) {
        (_, Event::Requested(Ok(environment))) => State::Bound(environment),
        (State::Bound(current), Event::Requested(Err(_))) => State::Bound(current.clone()),
        (_, Event::Requested(Err((prefix, error)))) => State::Rejected { prefix, error },
        (State::Bound(current), Event::LaunchRevalidated { prefix, result })
            if current.prefix == prefix =>
        {
            match result {
                Ok(environment) => State::Bound(environment),
                Err(error) => State::Rejected { prefix, error },
            }
        }
        // Stale revalidation: the binding changed or was already rejected.
        (state, Event::LaunchRevalidated { .. }) => state.clone(),
    }
}

/// What an automatic Python launch does with the room's binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BoundEnvironmentDecision {
    /// The launch is not a Python kernel; bindings never apply.
    NotPython,
    /// The room has no usable binding; keep the prewarmed fallback.
    NotBound,
    /// A notebook or project source claims the launch; the binding waits.
    Superseded,
    /// Nothing else claims the launch; borrow this prefix instead of the pool.
    UseBound(LocalCondaEnvironment),
}

/// Decide whether the binding replaces the prewarmed fallback.
///
/// `claimed` is the notebook or project source auto selection already chose
/// for this launch (see `claimed_auto_python_env_source`), or `None` when it
/// would fall back to the prewarmed pool.
pub(crate) fn decide(
    state: &BoundEnvironmentState,
    launches_python: bool,
    claimed: Option<&EnvSource>,
) -> BoundEnvironmentDecision {
    if !launches_python {
        return BoundEnvironmentDecision::NotPython;
    }
    match state {
        BoundEnvironmentState::Unbound | BoundEnvironmentState::Rejected { .. } => {
            BoundEnvironmentDecision::NotBound
        }
        BoundEnvironmentState::Bound(_) if claimed.is_some() => {
            BoundEnvironmentDecision::Superseded
        }
        BoundEnvironmentState::Bound(environment) => {
            BoundEnvironmentDecision::UseBound(environment.clone())
        }
    }
}

/// Rewrite a concrete `conda:existing:local` launch for a room without an
/// applied picker selection.
///
/// Restart helpers echo the running kernel's env source back as a concrete
/// launch. For a room running from its host binding that is
/// `conda:existing:local`, which only an applied selection can satisfy.
/// Re-resolve it as `auto:conda` instead: inline Conda deps still win,
/// otherwise the conda fallback is filled by the binding again.
pub(crate) fn existing_conda_launch_spec(
    spec: LaunchSpec,
    has_applied_selection: bool,
    state: &BoundEnvironmentState,
) -> Result<LaunchSpec, String> {
    match spec {
        LaunchSpec::Concrete(EnvSource::ExistingConda) if !has_applied_selection => match state {
            BoundEnvironmentState::Bound(_) => Ok(LaunchSpec::AutoScoped(PackageManager::Conda)),
            BoundEnvironmentState::Unbound | BoundEnvironmentState::Rejected { .. } => {
                Err("A local Conda launch requires an applied environment selection".into())
            }
        },
        spec => Ok(spec),
    }
}

/// Wire projection of the state, reported in the `CreateNotebook` reply.
pub(crate) fn status(state: &BoundEnvironmentState) -> Option<LocalEnvironmentBindingStatus> {
    match state {
        BoundEnvironmentState::Unbound => None,
        BoundEnvironmentState::Bound(environment) => Some(LocalEnvironmentBindingStatus::Bound {
            prefix: environment.prefix.clone(),
        }),
        BoundEnvironmentState::Rejected { prefix, error } => {
            Some(LocalEnvironmentBindingStatus::Rejected {
                prefix: prefix.clone(),
                error: error.clone(),
            })
        }
    }
}

/// Room-owned binding. A std mutex guards it; no guard crosses an `.await`.
#[derive(Default)]
pub(crate) struct BoundEnvironment {
    state: std::sync::Mutex<BoundEnvironmentState>,
}

impl BoundEnvironment {
    pub(crate) fn snapshot(&self) -> BoundEnvironmentState {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub(crate) fn apply(&self, event: BoundEnvironmentEvent) -> BoundEnvironmentState {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        *state = transition(&state, event);
        state.clone()
    }
}

/// Validate a `CreateNotebook` prefix with the local environment picker's
/// rules (absolute Conda prefix, Python inside it, ipykernel present) and
/// record the verdict on the room. Returns the room's effective binding: a
/// rejected prefix on an already bound room reports the existing binding.
pub(crate) async fn bind_on_create(
    room: &NotebookRoom,
    environments: &LocalCondaEnvironments,
    prefix: PathBuf,
) -> Option<LocalEnvironmentBindingStatus> {
    let result = if room.is_hosted() {
        Err("Local environments are unavailable for hosted notebooks".to_string())
    } else {
        environments.resolve_prefix(prefix.clone()).await
    };
    match &result {
        Ok(environment) => tracing::info!(
            "[runtimed] CreateNotebook bound local environment {}",
            environment.prefix.display()
        ),
        Err(error) => tracing::warn!(
            "[runtimed] CreateNotebook rejected local environment {}: {}; keeping any existing binding",
            prefix.display(),
            error
        ),
    }
    let state = room
        .bound_environment
        .apply(BoundEnvironmentEvent::Requested(
            result.map_err(|error| (prefix, error)),
        ));
    status(&state)
}

/// Return the bound environment when it should fill this launch, revalidated
/// against the filesystem. A prefix that no longer validates moves the room
/// to `Rejected` and the launch keeps its normal fallback.
pub(crate) async fn resolve_for_launch(
    room: &NotebookRoom,
    environments: &LocalCondaEnvironments,
    launches_python: bool,
    claimed: Option<&EnvSource>,
) -> Option<LocalCondaEnvironment> {
    if room.is_hosted() {
        return None;
    }
    let decision = decide(&room.bound_environment.snapshot(), launches_python, claimed);
    let BoundEnvironmentDecision::UseBound(bound) = decision else {
        if decision == BoundEnvironmentDecision::Superseded {
            tracing::info!(
                "[notebook-sync] Bound local environment superseded by {}",
                claimed.map(EnvSource::as_str).unwrap_or("another source")
            );
        }
        return None;
    };
    let result = environments.resolve_prefix(bound.prefix.clone()).await;
    if let Err(error) = &result {
        tracing::warn!(
            "[notebook-sync] Bound local environment {} no longer validates: {}; using the prewarmed fallback",
            bound.prefix.display(),
            error
        );
    }
    let state = room
        .bound_environment
        .apply(BoundEnvironmentEvent::LaunchRevalidated {
            prefix: bound.prefix,
            result,
        });
    match state {
        BoundEnvironmentState::Bound(environment) => {
            tracing::info!(
                "[notebook-sync] Launching from bound local environment {}",
                environment.prefix.display()
            );
            Some(environment)
        }
        _ => None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::notebook_sync_server::claimed_auto_python_env_source;
    use notebook_protocol::connection::CreateNotebookEnvironmentMode as Mode;
    use std::sync::Arc;

    fn environment(prefix: &str) -> LocalCondaEnvironment {
        LocalCondaEnvironment {
            id: format!("id-{prefix}"),
            name: "kilo".into(),
            prefix: PathBuf::from(prefix),
            python_path: PathBuf::from(prefix).join("bin/python"),
            python_version: Some("3.12".into()),
        }
    }

    fn bound() -> BoundEnvironmentState {
        BoundEnvironmentState::Bound(environment("/envs/kilo"))
    }

    fn decide_for(
        state: &BoundEnvironmentState,
        mode: Mode,
        notebook: Option<EnvSource>,
        project: Option<EnvSource>,
    ) -> BoundEnvironmentDecision {
        let claimed = claimed_auto_python_env_source(mode, notebook, project);
        decide(state, true, claimed.as_ref())
    }

    #[test]
    fn bound_prefix_fills_only_the_prewarmed_slot() {
        let use_bound = BoundEnvironmentDecision::UseBound(environment("/envs/kilo"));
        let cases = [
            // Nothing else claims the launch.
            (Mode::Auto, None, None, use_bound.clone()),
            // Inline deps win.
            (
                Mode::Auto,
                Some(EnvSource::Inline(PackageManager::Uv)),
                None,
                BoundEnvironmentDecision::Superseded,
            ),
            // PEP 723 wins.
            (
                Mode::Auto,
                Some(EnvSource::Pep723(PackageManager::Uv)),
                None,
                BoundEnvironmentDecision::Superseded,
            ),
            // A captured env on disk arrives as the notebook source and wins.
            (
                Mode::Auto,
                Some(EnvSource::Prewarmed(PackageManager::Conda)),
                None,
                BoundEnvironmentDecision::Superseded,
            ),
            // A trusted project file wins in auto and project mode.
            (
                Mode::Auto,
                None,
                Some(EnvSource::EnvYml),
                BoundEnvironmentDecision::Superseded,
            ),
            (
                Mode::Project,
                None,
                Some(EnvSource::Pyproject),
                BoundEnvironmentDecision::Superseded,
            ),
            // Notebook mode ignores project files, so the binding fills in.
            (
                Mode::Notebook,
                None,
                Some(EnvSource::PixiToml),
                use_bound.clone(),
            ),
            (
                Mode::Notebook,
                Some(EnvSource::Inline(PackageManager::Conda)),
                Some(EnvSource::PixiToml),
                BoundEnvironmentDecision::Superseded,
            ),
        ];
        for (mode, notebook, project, expected) in cases {
            assert_eq!(
                decide_for(&bound(), mode, notebook.clone(), project.clone()),
                expected,
                "mode={mode} notebook={notebook:?} project={project:?}"
            );
        }
    }

    #[test]
    fn unbound_rejected_and_deno_rooms_keep_the_fallback() {
        let rejected = BoundEnvironmentState::Rejected {
            prefix: "/envs/gone".into(),
            error: "missing".into(),
        };
        for state in [BoundEnvironmentState::Unbound, rejected] {
            assert_eq!(
                decide_for(&state, Mode::Auto, None, None),
                BoundEnvironmentDecision::NotBound
            );
        }
        assert_eq!(
            decide(&bound(), false, None),
            BoundEnvironmentDecision::NotPython
        );
    }

    #[test]
    fn rejected_request_keeps_a_working_binding() {
        assert_eq!(
            transition(
                &bound(),
                BoundEnvironmentEvent::Requested(Err(("/envs/bad".into(), "nope".into())))
            ),
            bound()
        );
    }

    #[test]
    fn valid_requests_replace_and_invalid_requests_reject_unbound_rooms() {
        let states = [
            BoundEnvironmentState::Unbound,
            BoundEnvironmentState::Rejected {
                prefix: "/envs/gone".into(),
                error: "missing".into(),
            },
        ];
        assert_eq!(
            transition(
                &bound(),
                BoundEnvironmentEvent::Requested(Ok(environment("/envs/new")))
            ),
            BoundEnvironmentState::Bound(environment("/envs/new"))
        );
        for state in &states {
            assert_eq!(
                transition(
                    state,
                    BoundEnvironmentEvent::Requested(Ok(environment("/envs/new")))
                ),
                BoundEnvironmentState::Bound(environment("/envs/new"))
            );
            assert_eq!(
                transition(
                    state,
                    BoundEnvironmentEvent::Requested(Err(("/envs/bad".into(), "nope".into())))
                ),
                BoundEnvironmentState::Rejected {
                    prefix: "/envs/bad".into(),
                    error: "nope".into()
                }
            );
        }
    }

    #[test]
    fn launch_revalidation_is_fenced_to_the_binding_it_read() {
        let failed = BoundEnvironmentEvent::LaunchRevalidated {
            prefix: "/envs/kilo".into(),
            result: Err("deleted".into()),
        };
        assert_eq!(
            transition(&bound(), failed.clone()),
            BoundEnvironmentState::Rejected {
                prefix: "/envs/kilo".into(),
                error: "deleted".into()
            }
        );
        // A newer request rebound the room; the stale failure is ignored.
        let rebound = BoundEnvironmentState::Bound(environment("/envs/other"));
        assert_eq!(transition(&rebound, failed.clone()), rebound);
        assert_eq!(
            transition(&BoundEnvironmentState::Unbound, failed),
            BoundEnvironmentState::Unbound
        );
        let mut refreshed = environment("/envs/kilo");
        refreshed.python_version = Some("3.13".into());
        assert_eq!(
            transition(
                &bound(),
                BoundEnvironmentEvent::LaunchRevalidated {
                    prefix: "/envs/kilo".into(),
                    result: Ok(refreshed.clone()),
                }
            ),
            BoundEnvironmentState::Bound(refreshed)
        );
    }

    /// Minimal Conda prefix accepted by the picker validation, without a
    /// runnable interpreter.
    fn conda_prefix(path: &std::path::Path) -> PathBuf {
        std::fs::create_dir_all(path.join("conda-meta")).unwrap();
        std::fs::write(
            path.join("conda-meta/python-3.11.9-0.json"),
            r#"{"name":"python","version":"3.11.9"}"#,
        )
        .unwrap();
        let python = crate::project_file::conda_python_path(path);
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, b"not an executable").unwrap();
        let site = if cfg!(windows) {
            path.join("Lib/site-packages")
        } else {
            path.join("lib/python3.11/site-packages")
        };
        std::fs::create_dir_all(site.join("ipykernel")).unwrap();
        std::fs::write(site.join("ipykernel/__init__.py"), b"").unwrap();
        path.to_path_buf()
    }

    #[tokio::test]
    async fn room_binding_validates_on_create_and_rejects_a_vanished_prefix_at_launch() {
        let tmp = tempfile::TempDir::new().unwrap();
        let blob_store = Arc::new(crate::blob_store::BlobStore::new(tmp.path().join("blobs")));
        let room =
            NotebookRoom::new_fresh(uuid::Uuid::new_v4(), None, tmp.path(), blob_store, false);
        let environments = LocalCondaEnvironments::default();
        let prefix = conda_prefix(&tmp.path().join("kilo-env"));

        let status = bind_on_create(&room, &environments, prefix.clone()).await;
        let canonical = std::fs::canonicalize(&prefix).unwrap();
        assert_eq!(
            status,
            Some(LocalEnvironmentBindingStatus::Bound {
                prefix: canonical.clone()
            })
        );

        // A reconnect with a bad prefix reports, and keeps, the binding.
        let status = bind_on_create(&room, &environments, PathBuf::from("relative/env")).await;
        assert_eq!(
            status,
            Some(LocalEnvironmentBindingStatus::Bound {
                prefix: canonical.clone()
            })
        );

        // A project file claims the launch: the binding waits.
        assert!(
            resolve_for_launch(&room, &environments, true, Some(&EnvSource::EnvYml))
                .await
                .is_none()
        );
        // Nothing claims it: launch borrows the bound prefix. Repeatable, so
        // a kernel restart reuses it.
        for _ in 0..2 {
            let environment = resolve_for_launch(&room, &environments, true, None)
                .await
                .expect("bound environment");
            assert_eq!(environment.prefix, canonical);
        }

        std::fs::remove_dir_all(&prefix).unwrap();
        assert!(resolve_for_launch(&room, &environments, true, None)
            .await
            .is_none());
        assert!(matches!(
            room.bound_environment.snapshot(),
            BoundEnvironmentState::Rejected { .. }
        ));
    }

    #[tokio::test]
    async fn room_binding_rejects_an_invalid_prefix_on_create() {
        let tmp = tempfile::TempDir::new().unwrap();
        let blob_store = Arc::new(crate::blob_store::BlobStore::new(tmp.path().join("blobs")));
        let room =
            NotebookRoom::new_fresh(uuid::Uuid::new_v4(), None, tmp.path(), blob_store, false);
        let environments = LocalCondaEnvironments::default();

        let status = bind_on_create(&room, &environments, PathBuf::from("relative/env")).await;
        assert!(matches!(
            status,
            Some(LocalEnvironmentBindingStatus::Rejected { ref prefix, .. })
                if prefix == &PathBuf::from("relative/env")
        ));
        assert!(resolve_for_launch(&room, &environments, true, None)
            .await
            .is_none());
    }

    #[test]
    fn existing_conda_relaunch_re_resolves_only_for_bound_rooms() {
        let existing = || LaunchSpec::parse("conda:existing:local");
        assert_eq!(
            existing_conda_launch_spec(existing(), false, &bound()),
            Ok(LaunchSpec::AutoScoped(PackageManager::Conda))
        );
        // An applied picker selection serves the concrete launch itself.
        assert_eq!(
            existing_conda_launch_spec(existing(), true, &bound()),
            Ok(existing())
        );
        for state in [
            BoundEnvironmentState::Unbound,
            BoundEnvironmentState::Rejected {
                prefix: "/envs/gone".into(),
                error: "missing".into(),
            },
        ] {
            assert!(existing_conda_launch_spec(existing(), false, &state).is_err());
        }
        assert_eq!(
            existing_conda_launch_spec(LaunchSpec::Auto, false, &bound()),
            Ok(LaunchSpec::Auto)
        );
    }

    #[test]
    fn status_projects_bound_and_rejected_only() {
        assert_eq!(status(&BoundEnvironmentState::Unbound), None);
        assert_eq!(
            status(&bound()),
            Some(LocalEnvironmentBindingStatus::Bound {
                prefix: "/envs/kilo".into()
            })
        );
    }
}
