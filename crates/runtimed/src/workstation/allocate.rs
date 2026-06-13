//! `allocate_runtime_for_room`: pick env X, attach a runtime to cloud room Y.
//!
//! The second endpoint operation (the ADR's "on demand, allocates and starts a
//! runtime in env X for room Y"). It ties together the three pieces built
//! earlier in Phase B:
//!
//! - the cloud config from a [`RoomTarget`] + [`CloudAuth`] (the B1 CLI builds
//!   the same shape from flags/env),
//! - an initial launch from an environment selection ([`build_current_python_launch`]),
//! - the cloud attach mechanism ([`run_cloud_runtime_agent`]) with launch-on-attach.
//!
//! Scope (decision 42): only the `current_python` environment policy is resolved
//! headlessly — it is the ADR's first-class Outerbounds policy (Decision 5): an
//! explicit interpreter, no daemon env pool, so the launch needs no pool take.
//! Allocating a *prewarmed-pool* env additionally needs `Daemon::take_uv_env`
//! (a live daemon) and its live attach can't be verified headlessly, so it's a
//! follow-up. The planning step ([`plan_current_python_allocation`]) is pure and
//! unit-tested; the spawn ([`allocate_current_python_runtime`]) is thin glue and
//! its live attach is the deferred proof.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use notebook_cloud_transport::{CloudAuth, CloudWorkstationMetadata, CloudWsConfig};
use notebook_protocol::protocol::{KernelPorts, RuntimeAgentRequest};

use super::launch_on_attach::{build_current_python_launch, CurrentPythonLaunch};

/// The cloud room a runtime is being allocated for.
#[derive(Debug, Clone)]
pub struct RoomTarget {
    /// Base URL of the notebook cloud (https/http; swapped to wss/ws).
    pub cloud_url: String,
    /// Notebook id; the room is `/n/<id>/sync`.
    pub notebook_id: String,
    /// Connection scope (a workstation runtime attaches as `runtime_peer`).
    pub scope: String,
    /// Operator suffix for the doc actor label (`<principal>/<operator>`).
    pub operator: String,
    /// Optional non-secret workstation facts to present to the room host when
    /// this runtime peer attaches.
    pub workstation: Option<CloudWorkstationMetadata>,
}

/// A resolved allocation ready to drive [`run_cloud_runtime_agent`]: the cloud
/// connection config plus the initial launch the agent applies on attach.
#[derive(Debug, Clone)]
pub struct Allocation {
    /// Cloud connection config for the attach.
    pub config: CloudWsConfig,
    /// Operator suffix carried through to the doc-actor label.
    pub operator: String,
    /// The initial `LaunchKernel` to apply on attach (launch-on-attach).
    pub initial_launch: RuntimeAgentRequest,
}

/// Plan a `current_python` allocation: map a room target, auth, interpreter, and
/// reserved ports into the [`Allocation`] that drives the cloud agent. Pure, so
/// the wiring is unit-testable without reserving real ports or dialing a room.
pub fn plan_current_python_allocation(
    target: &RoomTarget,
    auth: CloudAuth,
    python_path: PathBuf,
    notebook_path: Option<String>,
    working_dir: Option<PathBuf>,
    env_vars: HashMap<String, String>,
    kernel_ports: KernelPorts,
) -> Allocation {
    let config = CloudWsConfig {
        cloud_url: target.cloud_url.clone(),
        notebook_id: target.notebook_id.clone(),
        scope: target.scope.clone(),
        auth,
        workstation: target.workstation.clone(),
    };
    let launch = CurrentPythonLaunch {
        python_path,
        notebook_path,
        working_dir,
        env_vars,
    };
    let initial_launch = build_current_python_launch(&launch, kernel_ports);
    Allocation {
        config,
        operator: target.operator.clone(),
        initial_launch,
    }
}

/// Allocate a `current_python` runtime for a cloud room and run it to
/// completion: reserve kernel ports, plan the allocation, and drive
/// [`run_cloud_runtime_agent`] with launch-on-attach.
///
/// The port reservation is held for the agent's whole lifetime (its `Drop`
/// releases the ports), since the cloud agent — unlike the daemon UDS path — has
/// no separate coordinator holding them.
///
/// Deferred (decision 42): the live attach against a real preview room
/// (staging creds + deployed worker + the `runtime_peer` ACL row).
pub async fn allocate_current_python_runtime(
    target: RoomTarget,
    auth: CloudAuth,
    python_path: PathBuf,
    notebook_path: Option<String>,
    working_dir: Option<PathBuf>,
    env_vars: HashMap<String, String>,
    blob_root: PathBuf,
) -> anyhow::Result<()> {
    let reservation = crate::kernel_ports::reserve_kernel_ports().await?;
    let allocation = plan_current_python_allocation(
        &target,
        auth,
        python_path,
        notebook_path,
        working_dir,
        env_vars,
        reservation.ports(),
    );
    // Hold the reservation for the agent's lifetime so the ports stay claimed
    // while the kernel uses them; `_reservation` releases them on return/drop.
    let _reservation = reservation;
    crate::runtime_agent::run_cloud_runtime_agent(
        allocation.config,
        allocation.operator,
        blob_root,
        Some(allocation.initial_launch),
    )
    .await
}

pub fn current_python_workstation_metadata(working_dir: Option<&Path>) -> CloudWorkstationMetadata {
    CloudWorkstationMetadata {
        workstation_id: None,
        runtime_session_id: None,
        display_name: None,
        default_environment_label: Some("Current Python".to_string()),
        environment_policy: Some("current_python".to_string()),
        working_directory: working_dir.map(|path| path.to_string_lossy().into_owned()),
    }
}

/// Resolve the working directory a current-Python launch will present to the
/// room. Saved notebooks launch relative to their file directory, while
/// notebook-id-only rooms use the spawner/process cwd.
pub fn current_python_launch_working_dir(
    notebook_path: Option<&str>,
    fallback_working_dir: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(notebook_path) = notebook_path.map(PathBuf::from) {
        if notebook_path.is_dir() {
            return Some(notebook_path);
        }
        if let Some(parent) = notebook_path.parent() {
            return Some(parent.to_path_buf());
        }
    }
    fallback_working_dir.map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workstation::launch_on_attach::CURRENT_PYTHON_ENV_SOURCE;

    fn target() -> RoomTarget {
        RoomTarget {
            cloud_url: "https://preview.runt.run".into(),
            notebook_id: "nb-xyz".into(),
            scope: "runtime_peer".into(),
            operator: "agent:runt".into(),
            workstation: None,
        }
    }

    fn ports() -> KernelPorts {
        KernelPorts {
            stdin: 9100,
            control: 9101,
            hb: 9102,
            shell: 9103,
            iopub: 9104,
        }
    }

    #[test]
    fn plans_config_and_initial_launch_from_target() {
        let alloc = plan_current_python_allocation(
            &target(),
            CloudAuth::OidcBearer {
                token: "tok".into(),
            },
            PathBuf::from("/opt/ws/bin/python"),
            Some("/ws/nb.ipynb".into()),
            None,
            HashMap::from([("K".to_string(), "V".to_string())]),
            ports(),
        );

        // Config mirrors the target + auth.
        assert_eq!(alloc.config.notebook_id, "nb-xyz");
        assert_eq!(alloc.config.scope, "runtime_peer");
        assert_eq!(alloc.operator, "agent:runt");
        assert!(matches!(
            alloc.config.auth,
            CloudAuth::OidcBearer { token } if token == "tok"
        ));

        // Initial launch is a current-python LaunchKernel against the interpreter.
        let RuntimeAgentRequest::LaunchKernel {
            env_source,
            launched_config,
            kernel_ports,
            env_vars,
            ..
        } = alloc.initial_launch
        else {
            panic!("expected LaunchKernel");
        };
        assert_eq!(env_source.as_str(), CURRENT_PYTHON_ENV_SOURCE);
        assert_eq!(
            launched_config.python_path,
            Some(PathBuf::from("/opt/ws/bin/python"))
        );
        assert_eq!(kernel_ports.shell, 9103);
        assert_eq!(env_vars.get("K").map(String::as_str), Some("V"));
    }

    #[test]
    fn carries_scope_and_operator_through_unchanged() {
        let mut t = target();
        t.scope = "owner".into();
        t.operator = "agent:custom".into();
        let alloc = plan_current_python_allocation(
            &t,
            CloudAuth::Dev {
                token: "d".into(),
                user: "alice".into(),
            },
            PathBuf::from("/usr/bin/python3"),
            None,
            Some(PathBuf::from("/srv/work")),
            HashMap::new(),
            ports(),
        );
        assert_eq!(alloc.config.scope, "owner");
        assert_eq!(alloc.operator, "agent:custom");
        assert!(matches!(alloc.config.auth, CloudAuth::Dev { .. }));
        let RuntimeAgentRequest::LaunchKernel { notebook_path, .. } = alloc.initial_launch else {
            panic!("expected LaunchKernel");
        };
        assert_eq!(notebook_path.as_deref(), Some("/srv/work"));
    }

    #[test]
    fn carries_workstation_metadata_into_cloud_config() {
        let mut t = target();
        t.workstation = Some(current_python_workstation_metadata(Some(Path::new(
            "/home/ws/project",
        ))));

        let alloc = plan_current_python_allocation(
            &t,
            CloudAuth::OidcBearer {
                token: "tok".into(),
            },
            PathBuf::from("/usr/bin/python3"),
            None,
            Some(PathBuf::from("/home/ws/project")),
            HashMap::new(),
            ports(),
        );

        assert_eq!(
            alloc
                .config
                .workstation
                .as_ref()
                .and_then(|metadata| metadata.working_directory.as_deref()),
            Some("/home/ws/project")
        );
        assert_eq!(
            alloc
                .config
                .workstation
                .as_ref()
                .and_then(|metadata| metadata.environment_policy.as_deref()),
            Some("current_python")
        );
    }

    #[test]
    fn derives_current_python_launch_working_dir_from_notebook_path_or_spawner_cwd() {
        assert_eq!(
            current_python_launch_working_dir(
                Some("/home/ws/project/notebook.ipynb"),
                Some(Path::new("/tmp/spawner"))
            ),
            Some(PathBuf::from("/home/ws/project"))
        );
        assert_eq!(
            current_python_launch_working_dir(None, Some(Path::new("/tmp/spawner"))),
            Some(PathBuf::from("/tmp/spawner"))
        );
    }
}
