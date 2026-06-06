//! Launch-on-attach: let a cloud runtime agent *start* a kernel right after it
//! attaches, without waiting for an inbound `LaunchKernel` RPC.
//!
//! Why this exists (decision 38): the agent's steady state waits for an inbound
//! `RuntimeAgentRequest::LaunchKernel` before starting a kernel
//! (`runtime_agent.rs`). Over the daemon UDS that frame comes from the daemon.
//! Over the cloud transport it must come from the room — and that inbound
//! channel is req #5, **Deferred** (needs the 3d worker + a live room). So a
//! cloud agent spawned today *attaches but is never told to launch*. The ADR
//! says the workstation endpoint *allocates **and starts*** a runtime in env X;
//! launch-on-attach is how "start" happens headlessly while req #5 is deferred:
//! resolve env X up front and hand the agent an *initial* launch request it
//! applies after bootstrap.
//!
//! This module builds that initial request for the ADR's first-class
//! `current_python` environment policy (Decision 5): launch the kernel against
//! an explicit interpreter the connector already has, with no daemon-managed env
//! pool, package mutation disabled, and the target labelled as current Python.
//! The builder is pure and unit-tested; the actual kernel launch (and the live
//! attach) is the deferred proof.

use std::collections::HashMap;
use std::path::PathBuf;

use notebook_protocol::connection::EnvSource;
use notebook_protocol::protocol::{KernelPorts, LaunchedEnvConfig, RuntimeAgentRequest};

/// Inputs for a `current_python` launch-on-attach request.
#[derive(Debug, Clone)]
pub struct CurrentPythonLaunch {
    /// The Python interpreter to launch the kernel with (the connector's /
    /// provider workspace's current Python). Required — `current_python` means
    /// "use the interpreter you already have", so there is no pool fallback.
    pub python_path: PathBuf,
    /// Notebook path, if the room maps to a file on the workstation.
    pub notebook_path: Option<String>,
    /// Extra environment variables for the kernel process.
    pub env_vars: HashMap<String, String>,
}

/// The wire env-source label for a current-Python launch.
///
/// `current_python` is not one of the daemon's pool/inline/project sources, so
/// it has no canonical [`EnvSource`] variant; it round-trips through
/// `EnvSource::Unknown` (which `package_manager()` maps to the UV family by its
/// `uv:` prefix, the historical default — and crucially *not* to a pool take).
pub const CURRENT_PYTHON_ENV_SOURCE: &str = "uv:current_python";

/// Build the initial `LaunchKernel` request for a current-Python target.
///
/// Package mutation stays disabled (no inline/pool deps in the config), matching
/// the ADR: "package-management controls stay disabled unless the provider
/// adapter explicitly advertises safe package mutation."
pub fn build_current_python_launch(
    launch: &CurrentPythonLaunch,
    kernel_ports: KernelPorts,
) -> RuntimeAgentRequest {
    let launched_config = LaunchedEnvConfig {
        // No pool env, no inline deps: the kernel runs against python_path as-is.
        python_path: Some(launch.python_path.clone()),
        ..Default::default()
    };

    RuntimeAgentRequest::LaunchKernel {
        kernel_type: "python".to_string(),
        env_source: EnvSource::parse(CURRENT_PYTHON_ENV_SOURCE),
        notebook_path: launch.notebook_path.clone(),
        launched_config,
        kernel_ports,
        env_vars: launch.env_vars.clone(),
        // current_python does not redact (no daemon-managed secret env overlay).
        redact_env_values_in_outputs: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notebook_protocol::connection::PackageManager;

    fn ports() -> KernelPorts {
        KernelPorts {
            stdin: 9000,
            control: 9001,
            hb: 9002,
            shell: 9003,
            iopub: 9004,
        }
    }

    fn launch() -> CurrentPythonLaunch {
        CurrentPythonLaunch {
            python_path: PathBuf::from("/opt/ws/venv/bin/python"),
            notebook_path: Some("/home/ws/analysis.ipynb".into()),
            env_vars: HashMap::from([("FOO".to_string(), "bar".to_string())]),
        }
    }

    #[test]
    fn builds_python_launch_against_explicit_interpreter() {
        let req = build_current_python_launch(&launch(), ports());
        let RuntimeAgentRequest::LaunchKernel {
            kernel_type,
            env_source,
            notebook_path,
            launched_config,
            kernel_ports,
            env_vars,
            redact_env_values_in_outputs,
        } = req
        else {
            panic!("expected LaunchKernel");
        };
        assert_eq!(kernel_type, "python");
        assert_eq!(env_source.as_str(), CURRENT_PYTHON_ENV_SOURCE);
        assert_eq!(notebook_path.as_deref(), Some("/home/ws/analysis.ipynb"));
        assert_eq!(
            launched_config.python_path,
            Some(PathBuf::from("/opt/ws/venv/bin/python"))
        );
        assert_eq!(kernel_ports.iopub, 9004);
        assert_eq!(env_vars.get("FOO").map(String::as_str), Some("bar"));
        assert!(!redact_env_values_in_outputs);
    }

    #[test]
    fn carries_no_pool_or_inline_deps() {
        // current_python must not drag in a pool take or inline build: the
        // config has only the explicit interpreter, no venv_path / deps.
        let req = build_current_python_launch(&launch(), ports());
        let RuntimeAgentRequest::LaunchKernel {
            launched_config, ..
        } = req
        else {
            panic!("expected LaunchKernel");
        };
        assert!(launched_config.venv_path.is_none());
        assert!(launched_config.uv_deps.is_none());
        assert!(launched_config.conda_deps.is_none());
        assert!(launched_config.pixi_deps.is_none());
        assert!(launched_config.prewarmed_packages.is_empty());
    }

    #[test]
    fn env_source_label_routes_to_uv_family_not_a_pool_take() {
        // The Unknown("uv:current_python") label maps to the UV package-manager
        // family by prefix (historical default) but is NOT EnvSource::Prewarmed,
        // so the agent's launch path won't try to claim a pooled env for it.
        let src = EnvSource::parse(CURRENT_PYTHON_ENV_SOURCE);
        assert!(matches!(src, EnvSource::Unknown(_)));
        assert!(!matches!(src, EnvSource::Prewarmed(_)));
        assert_eq!(src.package_manager(), Some(PackageManager::Uv));
    }
}
