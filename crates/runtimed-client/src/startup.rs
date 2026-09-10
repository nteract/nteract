//! Non-destructive admission and lazy startup for one selected local runtime.
//!
//! Endpoint/channel selection belongs to the caller. This module never repairs
//! services, stops a runtime, deletes a lock, or falls back to another namespace.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use runt_workspace::BuildChannel;

use crate::client::{ClientError, PoolClient};
use crate::singleton::{compatibility_error, compatibility_error_for_versions, DaemonInfo};

const START_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const IDENTITY_TIMEOUT: Duration = Duration::from_secs(5);

/// A binary and its complete existing namespace, rather than a socket override.
///
/// The binary must report that it is compiled for `channel`; setting an environment
/// variable cannot change its compiled channel. `worktree` opts into the
/// existing full worktree namespace for state, locks, kernels, and the endpoint.
#[derive(Debug, Clone)]
pub struct RuntimeLaunch {
    pub binary: PathBuf,
    pub channel: BuildChannel,
    pub worktree: Option<PathBuf>,
}

impl RuntimeLaunch {
    pub fn endpoint(&self) -> PathBuf {
        runt_workspace::socket_path_for_context(self.channel, self.worktree.as_deref())
    }

    async fn verify_binary_identity(&self) -> Result<(), RuntimeStartupError> {
        let mut command = tokio::process::Command::new(&self.binary);
        command
            .arg("runtime-identity")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let output = tokio::time::timeout(IDENTITY_TIMEOUT, command.output())
            .await
            .map_err(|_| self.identity_error("runtime-identity timed out"))?
            .map_err(|error| self.identity_error(format!("runtime-identity failed: {error}")))?;
        if !output.status.success() {
            return Err(
                self.identity_error(format!("runtime-identity exited with {}", output.status))
            );
        }
        validate_binary_identity(&output.stdout, self.channel)
            .map_err(|reason| self.identity_error(reason))
    }

    fn identity_error(&self, reason: impl Into<String>) -> RuntimeStartupError {
        RuntimeStartupError::BinaryIdentity {
            binary: self.binary.clone(),
            reason: reason.into(),
        }
    }

    async fn spawn(&self, endpoint: &Path) -> Result<(), RuntimeStartupError> {
        let expected = self.endpoint();
        if expected != endpoint {
            return Err(RuntimeStartupError::NamespaceMismatch {
                endpoint: endpoint.to_path_buf(),
                expected,
            });
        }
        // Called only after a definitely absent endpoint. Probe identity before
        // allowing the binary to open logs, claim a lock, or create runtime state.
        self.verify_binary_identity().await?;
        let mut command = tokio::process::Command::new(&self.binary);
        command
            .arg("run")
            .env_remove("RUNTIMED_SOCKET_PATH")
            .env_remove("RUNTIMED_DEV")
            .env_remove("RUNTIMED_WORKSPACE_PATH")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false);
        if let Some(worktree) = &self.worktree {
            command
                .env("RUNTIMED_DEV", "1")
                .env("RUNTIMED_WORKSPACE_PATH", worktree);
        }
        #[cfg(unix)]
        // SAFETY: setsid is async-signal-safe, and this closure accesses no
        // allocator or shared Rust state between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        #[cfg(windows)]
        command.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP

        let mut child = command
            .spawn()
            .map_err(|source| RuntimeStartupError::Launch {
                binary: self.binary.clone(),
                source,
            })?;
        // Reap if the caller stays alive. Dropping this task/runtime does not
        // kill the daemon. An exit status (including success) is not readiness:
        // a concurrent starter may have won the singleton lock.
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct BinaryIdentity {
    channel: String,
    protocol_version: u32,
    daemon_api_version: u32,
}

fn validate_binary_identity(output: &[u8], channel: BuildChannel) -> Result<(), String> {
    let identity: BinaryIdentity = serde_json::from_slice(output)
        .map_err(|error| format!("invalid runtime-identity JSON: {error}"))?;
    let expected = match channel {
        BuildChannel::Stable => "stable",
        BuildChannel::Nightly => "nightly",
    };
    if identity.channel != expected {
        return Err(format!(
            "binary channel {} does not match selected channel {expected}",
            identity.channel
        ));
    }
    match compatibility_error_for_versions(identity.protocol_version, identity.daemon_api_version) {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeStartupError {
    #[error("Cannot start runtime binary {binary}: {reason}. Its identity must be known and compatible before startup.")]
    BinaryIdentity { binary: PathBuf, reason: String },
    #[error("The runtime at {endpoint} ({version}) is incompatible: {reason}. It was left running; finish or save its notebooks before explicitly repairing the runtime.")]
    Incompatible {
        endpoint: PathBuf,
        version: String,
        reason: String,
    },
    #[error("Could not inspect the runtime at {endpoint}: {source}. No runtime was replaced or repaired.")]
    Probe {
        endpoint: PathBuf,
        #[source]
        source: ClientError,
    },
    #[error("No runtime is listening at {endpoint}, and automatic startup is unavailable for this endpoint.")]
    Unavailable { endpoint: PathBuf },
    #[error("Cannot start a runtime for {endpoint}: the launch namespace owns {expected}. A custom socket alone does not isolate runtime state.")]
    NamespaceMismatch {
        endpoint: PathBuf,
        expected: PathBuf,
    },
    #[error("Could not launch runtime binary {binary}: {source}")]
    Launch {
        binary: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("The runtime at {endpoint} did not become ready within {seconds}s. Check the runtime logs; no existing runtime was stopped or repaired.")]
    NotReady { endpoint: PathBuf, seconds: u64 },
}

fn endpoint_absent(error: &ClientError) -> bool {
    matches!(error, ClientError::ConnectionFailed(error)
        if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused))
}

fn admit(endpoint: &Path, info: DaemonInfo) -> Result<DaemonInfo, RuntimeStartupError> {
    if let Some(reason) = compatibility_error(&info) {
        return Err(RuntimeStartupError::Incompatible {
            endpoint: endpoint.to_path_buf(),
            version: info.version,
            reason,
        });
    }
    Ok(info)
}

/// Read-only probe. `None` means only a missing or refused endpoint.
///
/// Unresponsive, inaccessible, old/unknown, and incompatible endpoints return an
/// error, so selection callers cannot mistake them for an invitation to launch.
pub async fn probe_local_runtime(
    endpoint: &Path,
) -> Result<Option<DaemonInfo>, RuntimeStartupError> {
    let info = match PoolClient::new(endpoint.to_path_buf()).daemon_info().await {
        Ok(info) => info,
        Err(error) if endpoint_absent(&error) => return Ok(None),
        Err(source) => {
            return Err(RuntimeStartupError::Probe {
                endpoint: endpoint.to_path_buf(),
                source,
            });
        }
    };
    let info = DaemonInfo {
        endpoint: endpoint.to_string_lossy().into_owned(),
        protocol_version: info.protocol_version,
        daemon_api_version: info.daemon_api_version,
        pid: info.pid,
        version: info.daemon_version,
        started_at: info.started_at,
        blob_port: info.blob_port,
        execution_store_dir: info.execution_store_dir,
        worktree_path: info.worktree_path,
        workspace_description: info.workspace_description,
    };
    admit(endpoint, info).map(Some)
}

/// Reuse a compatible runtime, or lazily start the supplied full namespace.
/// Hosted-only operations must not call this function.
pub async fn ensure_local_runtime(
    endpoint: PathBuf,
    launch: Option<RuntimeLaunch>,
) -> Result<DaemonInfo, RuntimeStartupError> {
    let probe_endpoint = endpoint.clone();
    ensure_with(
        &endpoint,
        || probe_local_runtime(&probe_endpoint),
        || async {
            match launch {
                Some(launch) => launch.spawn(&endpoint).await,
                None => Err(RuntimeStartupError::Unavailable {
                    endpoint: endpoint.clone(),
                }),
            }
        },
        START_TIMEOUT,
        POLL_INTERVAL,
    )
    .await
}

async fn ensure_with<P, F, L, LF>(
    endpoint: &Path,
    mut probe: P,
    launch: L,
    timeout: Duration,
    interval: Duration,
) -> Result<DaemonInfo, RuntimeStartupError>
where
    P: FnMut() -> F,
    F: Future<Output = Result<Option<DaemonInfo>, RuntimeStartupError>>,
    L: FnOnce() -> LF,
    LF: Future<Output = Result<(), RuntimeStartupError>>,
{
    if let Some(info) = probe().await? {
        return admit(endpoint, info);
    }
    launch().await?;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match tokio::time::timeout_at(deadline, probe()).await {
            Ok(Ok(Some(info))) => return admit(endpoint, info),
            Ok(Ok(None)) => {}
            Ok(Err(RuntimeStartupError::Probe {
                source: ClientError::Timeout,
                ..
            })) => {}
            Ok(Err(error)) => return Err(error),
            Err(_) => break,
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep_until((tokio::time::Instant::now() + interval).min(deadline)).await;
    }
    Err(RuntimeStartupError::NotReady {
        endpoint: endpoint.to_path_buf(),
        seconds: timeout.as_secs(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn compatible_info() -> DaemonInfo {
        DaemonInfo {
            endpoint: "test-runtime".into(),
            protocol_version: u32::from(notebook_protocol::connection::PROTOCOL_VERSION),
            daemon_api_version: crate::protocol::DAEMON_API_VERSION,
            pid: 42,
            version: "different-compatible-build".into(),
            started_at: chrono::Utc::now(),
            blob_port: None,
            execution_store_dir: None,
            worktree_path: None,
            workspace_description: None,
        }
    }

    #[tokio::test]
    async fn compatible_runtime_is_reused_without_launch() {
        let result = ensure_with(
            Path::new("test-runtime"),
            || std::future::ready(Ok(Some(compatible_info()))),
            || async { panic!("must not probe binary or launch") },
            Duration::ZERO,
            Duration::ZERO,
        )
        .await
        .unwrap();
        assert_eq!(result.pid, 42);
    }

    #[tokio::test]
    async fn incompatible_runtime_is_preserved() {
        let mut info = compatible_info();
        info.daemon_api_version = crate::protocol::DAEMON_API_VERSION + 1;
        let result = ensure_with(
            Path::new("test-runtime"),
            || std::future::ready(Ok(Some(info.clone()))),
            || async { panic!("must not probe binary or launch") },
            Duration::ZERO,
            Duration::ZERO,
        )
        .await;
        assert!(matches!(
            result,
            Err(RuntimeStartupError::Incompatible { .. })
        ));
    }

    #[test]
    fn only_missing_or_refused_endpoints_are_absent() {
        for kind in [
            std::io::ErrorKind::NotFound,
            std::io::ErrorKind::ConnectionRefused,
        ] {
            assert!(endpoint_absent(&ClientError::ConnectionFailed(kind.into())));
        }
        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::BrokenPipe,
        ] {
            assert!(!endpoint_absent(&ClientError::ConnectionFailed(
                kind.into()
            )));
        }
        assert!(!endpoint_absent(&ClientError::Timeout));
        assert!(!endpoint_absent(&ClientError::ProtocolError(
            "unknown protocol".into()
        )));
        assert!(!endpoint_absent(&ClientError::DaemonError(
            "Unknown request".into()
        )));
    }

    #[tokio::test]
    async fn uncertain_endpoint_never_launches() {
        for source in [
            ClientError::Timeout,
            ClientError::ProtocolError("bad response".into()),
            ClientError::ConnectionFailed(std::io::ErrorKind::PermissionDenied.into()),
        ] {
            let mut source = Some(source);
            let result = ensure_with(
                Path::new("test-runtime"),
                || {
                    std::future::ready(Err(RuntimeStartupError::Probe {
                        endpoint: "test-runtime".into(),
                        source: source.take().unwrap(),
                    }))
                },
                || async { panic!("must not probe binary or launch") },
                Duration::ZERO,
                Duration::ZERO,
            )
            .await;
            assert!(matches!(result, Err(RuntimeStartupError::Probe { .. })));
        }
    }

    #[tokio::test]
    async fn successful_launch_still_needs_live_readiness() {
        let launches = Cell::new(0);
        let result = ensure_with(
            Path::new("test-runtime"),
            || std::future::ready(Ok(None)),
            || {
                launches.set(launches.get() + 1);
                std::future::ready(Ok(()))
            },
            Duration::ZERO,
            Duration::ZERO,
        )
        .await;
        assert_eq!(launches.get(), 1);
        assert!(matches!(result, Err(RuntimeStartupError::NotReady { .. })));
    }

    #[tokio::test]
    async fn concurrent_starter_can_supply_the_live_runtime() {
        let probes = Cell::new(0);
        let launches = Cell::new(0);
        let result = ensure_with(
            Path::new("test-runtime"),
            || {
                probes.set(probes.get() + 1);
                std::future::ready(Ok((probes.get() > 1).then(compatible_info)))
            },
            || {
                launches.set(launches.get() + 1);
                std::future::ready(Ok(()))
            },
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .unwrap();
        assert_eq!(result.pid, 42);
        assert_eq!(launches.get(), 1);
    }

    #[tokio::test]
    async fn arbitrary_socket_cannot_launch_into_shared_state() {
        let launch = RuntimeLaunch {
            binary: "never-spawned".into(),
            channel: BuildChannel::Stable,
            worktree: None,
        };
        assert!(matches!(
            launch.spawn(Path::new("arbitrary-other-endpoint")).await,
            Err(RuntimeStartupError::NamespaceMismatch { .. })
        ));
    }

    fn binary_identity(channel: &str, protocol: u32, api: u32) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "channel": channel,
            "protocol_version": protocol,
            "daemon_api_version": api,
        }))
        .unwrap()
    }

    #[test]
    fn binary_identity_requires_matching_channel_and_supported_versions() {
        let wire = u32::from(notebook_protocol::connection::PROTOCOL_VERSION);
        let api = crate::protocol::DAEMON_API_VERSION;
        assert!(validate_binary_identity(
            &binary_identity("stable", wire, api),
            BuildChannel::Stable
        )
        .is_ok());
        assert!(validate_binary_identity(
            &binary_identity("nightly", wire, api),
            BuildChannel::Nightly
        )
        .is_ok());
        for (channel, wire, api) in [
            ("nightly", wire, api),
            ("unknown", wire, api),
            ("stable", 0, api),
            ("stable", wire + 1, api),
            ("stable", wire, 0),
            ("stable", wire, api + 1),
        ] {
            assert!(validate_binary_identity(
                &binary_identity(channel, wire, api),
                BuildChannel::Stable
            )
            .is_err());
        }
    }

    #[test]
    fn malformed_or_missing_binary_identity_is_not_admitted() {
        for output in [
            b"".as_slice(),
            b"runtimed 2.7.6",
            b"{}",
            br#"{"channel":"stable","protocol_version":"1","daemon_api_version":1}"#,
        ] {
            assert!(validate_binary_identity(output, BuildChannel::Stable).is_err());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_identity_probe_never_reaches_runtime_run() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("fake-runtime");
        // This fixture has no daemon behavior. Reaching run records a marker;
        // its identity command deliberately describes the wrong channel.
        std::fs::write(&binary, "#!/bin/sh\nif [ \"$1\" = runtime-identity ]; then\n  printf '%s\\n' '{\"channel\":\"nightly\",\"protocol_version\":0,\"daemon_api_version\":0}'\nelse\n  touch \"$0.started\"\nfi\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let launch = RuntimeLaunch {
            binary: binary.clone(),
            channel: BuildChannel::Stable,
            worktree: None,
        };
        let result = launch.spawn(&launch.endpoint()).await;
        assert!(matches!(
            result,
            Err(RuntimeStartupError::BinaryIdentity { .. })
        ));
        assert!(!temp.path().join("fake-runtime.started").exists());
    }
}
