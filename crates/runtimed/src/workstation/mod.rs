//! Workstation endpoint: the daemon-side capability to offer compute to a
//! hosted cloud room.
//!
//! A *workstation* (the product noun from
//! `docs/adr/remote-workstation-doc-agents.md`) is an endpoint you pick compute
//! from. It does two things:
//!
//! 1. **lists the environments it has** ([`list_environments`], a projection over
//!    the daemon's existing [`pool_state`](notebook_doc::pool_state) — not a new
//!    enumerator), and
//! 2. on demand, **allocates and starts a runtime in env X for room Y**, driving
//!    [`run_cloud_runtime_agent`](crate::runtime_agent::run_cloud_runtime_agent)
//!    as the attach mechanism.
//!
//! This module is the daemon-side half. It is additive and gated behind the
//! cloud transport; the desktop/UDS path is unaffected.
//!
//! See `docs/handoffs/16-workstation-endpoint.md` for the full scope and which
//! pieces are headless-buildable vs. deferred to a live preview deploy.

pub mod allocate;
pub mod cloud_agent_cli;
pub mod environments;
pub mod launch_on_attach;

pub use allocate::{
    allocate_current_python_runtime, plan_current_python_allocation, Allocation, RoomTarget,
};
pub use cloud_agent_cli::{build_cloud_config, CloudAgentArgs, CloudAuthKind};
pub use environments::{
    environments_from_pool_state, list_environments, EnvKind, EnvironmentPolicy,
    WorkstationEnvironment,
};
pub use launch_on_attach::{
    build_current_python_launch, CurrentPythonLaunch, CURRENT_PYTHON_ENV_SOURCE,
};
