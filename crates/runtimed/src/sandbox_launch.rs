//! Sandbox kernel launch types and error variants.
//!
//! This module owns the types produced and consumed by the opt-in sandbox
//! launch path (task 07). The default kernel launch path is unchanged; these
//! types only come into play when `metadata.runt.sandbox` is present and
//! `enabled = true`.
//!
//! ## `SandboxState`
//!
//! Tracks the outcome of a sandboxed kernel launch and its runtime health.
//! Reachable from runtime session state so task 08 (event annotations),
//! task 09 (MCP tools), and task 11 (Automerge sync) can read it.
//!
//! ## `SandboxLaunchError`
//!
//! Returned instead of a silent fallback when the user has explicitly opted in
//! to sandbox mode. Per D-3, opting in means the user wants sandbox; falling
//! back silently when nono is missing or the profile is bad would be a
//! security regression.

// ── SandboxState ──────────────────────────────────────────────────────────

/// Tracks the sandbox proxy state for an active kernel session.
///
/// Attached to the session's in-memory tracking so downstream consumers
/// (task 08, task 09, task 11) can read it. This is ephemeral runtime state —
/// not persisted to the Automerge document directly (that is task 11's job).
///
/// Only meaningful when the notebook has `metadata.runt.sandbox.enabled = true`.
/// For all other notebooks the sandbox is [`SandboxState::Disabled`].
///
/// The `EventStream` is stored separately on `JupyterKernel::sandbox_event_stream`
/// (not embedded here) because `EventStream` is not `Clone`.
#[derive(Debug)]
pub enum SandboxState {
    /// No sandbox profile configured or `enabled = false`.
    ///
    /// The kernel launched via the normal direct path. All downstream
    /// consumers must treat this as the default and apply no sandbox logic.
    Disabled,

    /// Sandbox launched and the nono proxy is healthy.
    ///
    /// Both PIDs are tracked. See `JupyterKernel::sandbox_event_stream` for
    /// the `EventStream` (task 06 output) for this session.
    Active {
        /// PID of the nono proxy process (direct child of the daemon).
        nono_pid: u32,
        /// PID of the kernel process (grandchild of the daemon via nono).
        ///
        /// This is the PID used for ZeroMQ socket coordination and kernel
        /// lifecycle reporting. May briefly be 0 during the kernel discovery
        /// race window (see `NONE_PID` in supervisor.rs).
        kernel_pid: u32,
        /// Session identifier extracted from nono's stdout DEBUG line.
        ///
        /// Populated once `"Session file created: …"` is seen on stdout at
        /// -vv. Starts `None` and is set asynchronously. Used to locate the
        /// audit log directory (D-12).
        session_id: Option<String>,
    },

    /// Sandbox failed to start.
    ///
    /// Preferred over a silent fallback — the user explicitly opted in.
    StartupFailed {
        /// Human-readable reason for the failure.
        reason: String,
        /// Last N stderr lines from nono before it exited (for diagnostics).
        stderr_capture: Vec<String>,
    },

    /// Sandbox started but the nono proxy died mid-session.
    ///
    /// The kernel process may still be running but has no network proxy.
    /// All network calls from the kernel will fail with `ConnectionRefused`.
    Degraded {
        /// Human-readable reason (e.g. "nono proxy exited with code 1").
        reason: String,
    },
}

impl SandboxState {
    /// Returns `true` if the sandbox is actively proxying traffic.
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Active { .. })
    }

    /// Returns the nono PID if the sandbox is active.
    pub fn nono_pid(&self) -> Option<u32> {
        match self {
            Self::Active { nono_pid, .. } => Some(*nono_pid),
            _ => None,
        }
    }

    /// Returns the kernel PID if the sandbox is active.
    pub fn kernel_pid(&self) -> Option<u32> {
        match self {
            Self::Active { kernel_pid, .. } => Some(*kernel_pid),
            _ => None,
        }
    }
}

// ── SandboxLaunchError ────────────────────────────────────────────────────

/// Errors produced when a sandbox-enabled kernel fails to launch.
///
/// The caller must **not** fall back to a direct launch on these errors;
/// the user opted in to sandbox mode and a silent fallback would bypass the
/// intended security policy (D-3).
#[derive(Debug, thiserror::Error)]
pub enum SandboxLaunchError {
    /// The nono binary could not be found.
    ///
    /// The user opted in to sandbox mode but nono is not installed. The daemon
    /// refuses to launch and surfaces this error so the user knows what to fix.
    #[error(
        "sandbox is enabled for this notebook but the nono binary was not found \
         (tried NONO_BIN env, bundled path alongside runtimed, then PATH). \
         Install nono or set NONO_BIN=/path/to/nono."
    )]
    NonoUnavailable,

    /// The sandbox profile failed validation.
    ///
    /// `errors` contains one human-readable message per validation failure.
    #[error("sandbox profile is invalid: {errors}")]
    InvalidProfile {
        /// Semicolon-separated validation error messages.
        errors: String,
    },

    /// The profile translation step failed (e.g. temp file creation error).
    #[error("failed to translate sandbox profile: {source}")]
    ProfileTranslationFailed {
        #[source]
        source: crate::nono::profile::ProfileTranslationError,
    },

    /// nono exited immediately with a startup failure.
    ///
    /// Common cause: a required credential is missing from the macOS Keychain.
    /// `stderr` contains the captured lines that describe why nono exited.
    #[error("sandbox failed to start (nono exited immediately): {stderr}")]
    SandboxStartFailed {
        /// Captured stderr lines (joined with newlines).
        stderr: String,
    },

    /// The kernel PID could not be discovered within the timeout window.
    ///
    /// nono spawned but the kernel grandchild was not visible in the process
    /// tree within `KERNEL_DISCOVERY_TIMEOUT` (2s). Treating as a startup
    /// failure so the user gets a clear error rather than a hung kernel.
    #[error("kernel PID discovery timed out after nono spawn")]
    KernelDiscoveryTimeout,

    /// An I/O error occurred during spawn (e.g. nono binary not executable).
    #[error("I/O error spawning nono: {source}")]
    Io {
        #[source]
        source: std::io::Error,
    },
}

impl From<crate::nono::profile::ProfileTranslationError> for SandboxLaunchError {
    fn from(e: crate::nono::profile::ProfileTranslationError) -> Self {
        Self::ProfileTranslationFailed { source: e }
    }
}

impl From<crate::nono::SupervisorError> for SandboxLaunchError {
    fn from(e: crate::nono::SupervisorError) -> Self {
        match e {
            crate::nono::SupervisorError::BinaryNotFound(_) => Self::NonoUnavailable,
            crate::nono::SupervisorError::Spawn(io) => Self::Io { source: io },
            crate::nono::SupervisorError::KernelDiscoveryTimeout => Self::KernelDiscoveryTimeout,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_state_disabled_is_not_active() {
        let state = SandboxState::Disabled;
        assert!(!state.is_active());
        assert!(state.nono_pid().is_none());
        assert!(state.kernel_pid().is_none());
    }

    #[test]
    fn sandbox_state_startup_failed_is_not_active() {
        let state = SandboxState::StartupFailed {
            reason: "credential missing".to_string(),
            stderr_capture: vec!["error line".to_string()],
        };
        assert!(!state.is_active());
    }

    #[test]
    fn sandbox_state_degraded_is_not_active() {
        let state = SandboxState::Degraded {
            reason: "nono exited with code 1".to_string(),
        };
        assert!(!state.is_active());
    }

    #[test]
    fn sandbox_launch_error_nono_unavailable_message() {
        let err = SandboxLaunchError::NonoUnavailable;
        let msg = err.to_string();
        assert!(msg.contains("nono binary was not found"));
    }

    #[test]
    fn sandbox_launch_error_invalid_profile_message() {
        let err = SandboxLaunchError::InvalidProfile {
            errors: "name must be alphanumeric".to_string(),
        };
        let msg = err.to_string();
        assert!(msg.contains("invalid"));
    }

    #[test]
    fn sandbox_launch_error_start_failed_message() {
        let err = SandboxLaunchError::SandboxStartFailed {
            stderr: "Secret not found in keystore: analytics_api".to_string(),
        };
        let msg = err.to_string();
        assert!(msg.contains("nono exited immediately"));
    }

    #[test]
    fn from_supervisor_error_binary_not_found() {
        let supervisor_err =
            crate::nono::SupervisorError::BinaryNotFound(crate::nono::NonoUnavailable);
        let launch_err = SandboxLaunchError::from(supervisor_err);
        assert!(matches!(launch_err, SandboxLaunchError::NonoUnavailable));
    }

    #[test]
    fn from_supervisor_error_kernel_discovery_timeout() {
        let supervisor_err = crate::nono::SupervisorError::KernelDiscoveryTimeout;
        let launch_err = SandboxLaunchError::from(supervisor_err);
        assert!(matches!(
            launch_err,
            SandboxLaunchError::KernelDiscoveryTimeout
        ));
    }
}
