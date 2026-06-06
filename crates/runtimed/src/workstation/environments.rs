//! `list_environments`: what compute this workstation can offer.
//!
//! A projection over the daemon's existing pool state, **not** a new enumerator
//! (decision 39). `PoolDoc::read_state()` already publishes available/warming/
//! health per env kind (synced to peers over `PoolStateSync`); this maps that to
//! a stable [`WorkstationEnvironment`] list the endpoint — and, later, the
//! hosted workstation-target API or the Content-rail catalog — can render.
//!
//! Kept as a pure function over [`PoolState`] ([`environments_from_pool_state`])
//! plus a thin daemon-facing wrapper ([`list_environments`]), so the projection
//! is unit-testable without a live daemon.

use notebook_doc::pool_state::{PoolState, RuntimePoolState};
use serde::{Deserialize, Serialize};

/// The environment backend a workstation environment is drawn from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvKind {
    Uv,
    Conda,
    Pixi,
}

impl EnvKind {
    fn as_str(self) -> &'static str {
        match self {
            EnvKind::Uv => "uv",
            EnvKind::Conda => "conda",
            EnvKind::Pixi => "pixi",
        }
    }
}

/// How nteract should treat the environment for execution, per the ADR's
/// `environment_policy` (Decision 5). Prewarmed pool envs are daemon-built and
/// reproducible, so they are `ManagedProject`. The other variants exist so a
/// provider adapter (Outerbounds current Python, JupyterHub kernelspec) can
/// project its own envs through the same shape later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentPolicy {
    CurrentPython,
    Kernelspec,
    ManagedProject,
    Unknown,
}

/// One environment a workstation can allocate a runtime in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkstationEnvironment {
    /// Stable selector for `allocate_runtime_for_room` (e.g. `pool:uv`).
    pub id: String,
    /// The backend (uv/conda/pixi).
    pub kind: EnvKind,
    /// Number of prewarmed instances ready to take immediately.
    pub available: u64,
    /// Number currently being prepared.
    pub warming: u64,
    /// Execution-treatment policy for the target.
    pub environment_policy: EnvironmentPolicy,
    /// Human-readable health note, `None` when the pool is healthy. Carried
    /// straight through from [`RuntimePoolState::error`] so a workstation can
    /// surface "uv pool failing: <pkg>" instead of silently offering a broken
    /// target.
    pub health: Option<String>,
}

/// Project a single pool kind into a workstation environment, if that kind
/// offers anything. A kind with nothing available, nothing warming, a zero
/// target, and no error is omitted (`None`) — the daemon simply isn't offering
/// that backend. A kind reporting an *error* is included even at zero
/// availability so the condition is visible rather than hidden.
fn environment_for_kind(kind: EnvKind, state: &RuntimePoolState) -> Option<WorkstationEnvironment> {
    let offers_nothing =
        state.available == 0 && state.warming == 0 && state.pool_size == 0 && state.error.is_none();
    if offers_nothing {
        return None;
    }
    Some(WorkstationEnvironment {
        id: format!("pool:{}", kind.as_str()),
        kind,
        available: state.available,
        warming: state.warming,
        // Prewarmed pools are daemon-built reproducible environments.
        environment_policy: EnvironmentPolicy::ManagedProject,
        health: state.error.clone(),
    })
}

/// Pure projection of a [`PoolState`] snapshot into the workstation environment
/// list. Order is stable (uv, conda, pixi).
pub fn environments_from_pool_state(state: &PoolState) -> Vec<WorkstationEnvironment> {
    [
        environment_for_kind(EnvKind::Uv, &state.uv),
        environment_for_kind(EnvKind::Conda, &state.conda),
        environment_for_kind(EnvKind::Pixi, &state.pixi),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// List the environments this daemon can offer, by projecting the live
/// daemon-authoritative pool doc. Reuses the existing pool state; does not
/// re-walk disk or re-inspect pools (decision 39).
pub async fn list_environments(daemon: &crate::daemon::Daemon) -> Vec<WorkstationEnvironment> {
    let state = {
        let doc = daemon.pool_doc.read().await;
        doc.read_state()
    };
    environments_from_pool_state(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(available: u64, warming: u64, pool_size: u64) -> RuntimePoolState {
        RuntimePoolState {
            available,
            warming,
            pool_size,
            ..Default::default()
        }
    }

    #[test]
    fn projects_each_nonempty_kind_in_stable_order() {
        let state = PoolState {
            uv: pool(3, 1, 4),
            conda: pool(0, 2, 2),
            pixi: pool(0, 0, 0),
        };
        let envs = environments_from_pool_state(&state);
        // uv (offering) + conda (warming) ; pixi omitted (offers nothing).
        assert_eq!(envs.len(), 2);
        assert_eq!(envs[0].id, "pool:uv");
        assert_eq!(envs[0].kind, EnvKind::Uv);
        assert_eq!(envs[0].available, 3);
        assert_eq!(envs[0].warming, 1);
        assert_eq!(
            envs[0].environment_policy,
            EnvironmentPolicy::ManagedProject
        );
        assert!(envs[0].health.is_none());
        assert_eq!(envs[1].id, "pool:conda");
        assert_eq!(envs[1].available, 0);
        assert_eq!(envs[1].warming, 2);
    }

    #[test]
    fn empty_pool_state_offers_nothing() {
        let envs = environments_from_pool_state(&PoolState::default());
        assert!(envs.is_empty());
    }

    #[test]
    fn unhealthy_kind_is_surfaced_even_at_zero_availability() {
        let mut uv = pool(0, 0, 0);
        uv.error = Some("uv pool failing: numpy".into());
        uv.error_kind = Some("invalid_package".into());
        let state = PoolState {
            uv,
            ..Default::default()
        };
        let envs = environments_from_pool_state(&state);
        assert_eq!(envs.len(), 1, "an erroring pool must be visible");
        assert_eq!(envs[0].id, "pool:uv");
        assert_eq!(envs[0].health.as_deref(), Some("uv pool failing: numpy"));
    }

    #[test]
    fn a_kind_with_only_a_target_is_offered() {
        // pool_size > 0 but nothing ready yet (cold start): still an offer.
        let state = PoolState {
            uv: pool(0, 0, 2),
            ..Default::default()
        };
        let envs = environments_from_pool_state(&state);
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].available, 0);
    }
}
