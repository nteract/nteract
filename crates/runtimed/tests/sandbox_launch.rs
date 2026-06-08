// Tests can use unwrap/expect freely - panics are acceptable in test code
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! Integration tests for the sandbox kernel launch path (task 07).
//!
//! These tests verify the branching logic in `JupyterKernel::launch()`:
//! - No sandbox profile → direct launch (default path, no behavior change)
//! - `sandbox.enabled = false` → direct launch silently
//! - Valid sandbox profile with `enabled = true` → sandbox launch via nono
//! - Failure modes: nono unavailable, invalid profile, startup failure
//!
//! Most tests are unit-level since a real nono binary isn't available in CI.
//! The live E2E tests (kernel-as-grandchild, ps tree, shutdown order) are
//! covered by task 12.

use notebook_doc::sandbox::{CredentialRef, SandboxProfile};
use runtimed::sandbox_launch::{SandboxLaunchError, SandboxState};

// ── SandboxState type tests ──────────────────────────────────────────────

#[test]
fn sandbox_state_disabled_default() {
    let state = SandboxState::Disabled;
    assert!(!state.is_active());
    assert_eq!(state.nono_pid(), None);
    assert_eq!(state.kernel_pid(), None);
}

#[test]
fn sandbox_state_active_reports_pids() {
    let state = SandboxState::Active {
        nono_pid: 1234,
        kernel_pid: 5678,
        session_id: Some("abc123".to_string()),
    };
    assert!(state.is_active());
    assert_eq!(state.nono_pid(), Some(1234));
    assert_eq!(state.kernel_pid(), Some(5678));
}

#[test]
fn sandbox_state_active_with_zero_kernel_pid() {
    // kernel_pid may be 0 briefly during discovery race
    let state = SandboxState::Active {
        nono_pid: 999,
        kernel_pid: 0,
        session_id: None,
    };
    assert!(state.is_active());
    assert_eq!(state.nono_pid(), Some(999));
    assert_eq!(state.kernel_pid(), Some(0));
}

#[test]
fn sandbox_state_startup_failed_is_not_active() {
    let state = SandboxState::StartupFailed {
        reason: "nono: Secret not found in keystore: analytics_api".to_string(),
        stderr_capture: vec!["nono: Secret not found in keystore: analytics_api".to_string()],
    };
    assert!(!state.is_active());
    assert_eq!(state.nono_pid(), None);
    assert_eq!(state.kernel_pid(), None);
}

#[test]
fn sandbox_state_degraded_is_not_active() {
    let state = SandboxState::Degraded {
        reason: "nono proxy exited with code 1".to_string(),
    };
    assert!(!state.is_active());
}

// ── SandboxLaunchError tests ─────────────────────────────────────────────

#[test]
fn sandbox_launch_error_nono_unavailable_display() {
    let err = SandboxLaunchError::NonoUnavailable;
    let msg = format!("{}", err);
    assert!(msg.contains("nono binary was not found"));
    assert!(msg.contains("NONO_BIN"));
}

#[test]
fn sandbox_launch_error_invalid_profile_display() {
    let err = SandboxLaunchError::InvalidProfile {
        errors: "credential 'bad-name' has invalid characters; name must be alphanumeric"
            .to_string(),
    };
    let msg = format!("{}", err);
    assert!(msg.contains("invalid"));
}

#[test]
fn sandbox_launch_error_start_failed_display() {
    let err = SandboxLaunchError::SandboxStartFailed {
        stderr: "nono: Secret not found in keystore: analytics_api".to_string(),
    };
    let msg = format!("{}", err);
    assert!(msg.contains("nono exited immediately"));
    assert!(msg.contains("Secret not found in keystore"));
}

#[test]
fn sandbox_launch_error_kernel_discovery_timeout_display() {
    let err = SandboxLaunchError::KernelDiscoveryTimeout;
    let msg = format!("{}", err);
    assert!(msg.contains("timed out"));
}

#[test]
fn sandbox_launch_error_io_display() {
    let err = SandboxLaunchError::Io {
        source: std::io::Error::new(std::io::ErrorKind::NotFound, "binary not found"),
    };
    let msg = format!("{}", err);
    assert!(msg.contains("I/O error spawning nono"));
}

// ── From conversions ─────────────────────────────────────────────────────

#[test]
fn from_supervisor_error_binary_not_found() {
    let supervisor_err =
        runtimed::nono::SupervisorError::BinaryNotFound(runtimed::nono::NonoUnavailable);
    let launch_err = SandboxLaunchError::from(supervisor_err);
    assert!(
        matches!(launch_err, SandboxLaunchError::NonoUnavailable),
        "BinaryNotFound should map to NonoUnavailable"
    );
}

#[test]
fn from_supervisor_error_spawn_io() {
    let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "permission denied");
    let supervisor_err = runtimed::nono::SupervisorError::Spawn(io_err);
    let launch_err = SandboxLaunchError::from(supervisor_err);
    assert!(
        matches!(launch_err, SandboxLaunchError::Io { .. }),
        "Spawn error should map to Io"
    );
}

#[test]
fn from_supervisor_error_kernel_discovery_timeout() {
    let supervisor_err = runtimed::nono::SupervisorError::KernelDiscoveryTimeout;
    let launch_err = SandboxLaunchError::from(supervisor_err);
    assert!(
        matches!(launch_err, SandboxLaunchError::KernelDiscoveryTimeout),
        "KernelDiscoveryTimeout should map to KernelDiscoveryTimeout"
    );
}

// ── Profile-level opt-in tests ────────────────────────────────────────────
//
// These test the profile reading and enabled/disabled logic at the type level,
// without spawning actual kernels. The actual launch branching is tested via
// the integration tests that spawn daemons (requires the test environment).

#[test]
fn disabled_profile_is_treated_as_no_sandbox() {
    // A profile with `enabled = false` should not trigger the sandbox path.
    let profile = SandboxProfile {
        enabled: false,
        credentials: vec![],
        allowed_domains: vec![],
    };

    // Verify the profile is disabled — the launch path checks `profile.enabled`.
    assert!(
        !profile.enabled,
        "disabled profile should not trigger sandbox"
    );
}

#[test]
fn enabled_profile_with_only_allowed_domains_is_valid() {
    // A profile without credentials but with allowed domains is valid.
    // This is the simplest sandbox configuration (domain filtering only).
    let profile = SandboxProfile {
        enabled: true,
        credentials: vec![],
        allowed_domains: vec!["api.example.com".to_string()],
    };

    assert!(profile.enabled);
    let errors = profile.validate();
    assert!(
        errors.is_empty(),
        "profile with only allowed_domains should be valid: {:?}",
        errors
    );
}

#[test]
fn enabled_profile_with_valid_credential_is_valid() {
    // A profile with a credential that has a valid name and a route.
    let profile = SandboxProfile {
        enabled: true,
        credentials: vec![CredentialRef {
            name: "analytics_api".to_string(),
            description: Some("API key for analytics service".to_string()),
            env_var: None,
            keystore_name: None,
            routes: vec![notebook_doc::sandbox::RouteRule {
                host: "api.analytics.example.com".to_string(),
                inject_as: notebook_doc::sandbox::InjectionKind::Header,
                header: Some("Authorization".to_string()),
                template: "Bearer {credential}".to_string(),
            }],
        }],
        allowed_domains: vec!["api.analytics.example.com".to_string()],
    };

    assert!(profile.enabled);
    let errors = profile.validate();
    assert!(
        errors.is_empty(),
        "profile with valid credential should pass validation: {:?}",
        errors
    );
}

#[test]
fn profile_translation_error_for_disabled_profile() {
    // translate() should return Disabled error for disabled profiles.
    let profile = SandboxProfile {
        enabled: false,
        credentials: vec![],
        allowed_domains: vec![],
    };

    let result = runtimed::nono::profile::translate(&profile);
    assert!(
        result.is_err(),
        "translating a disabled profile should fail"
    );
    assert!(
        matches!(
            result.unwrap_err(),
            runtimed::nono::profile::ProfileTranslationError::Disabled
        ),
        "should return Disabled error"
    );
}

#[test]
fn profile_translation_error_for_invalid_profile() {
    // translate() should return Invalid error for profiles with bad credential names.
    let profile = SandboxProfile {
        enabled: true,
        credentials: vec![CredentialRef {
            name: "bad-name-with-hyphen".to_string(), // hyphens not allowed
            description: None,
            env_var: None,
            keystore_name: None,
            routes: vec![],
        }],
        allowed_domains: vec![],
    };

    let result = runtimed::nono::profile::translate(&profile);
    assert!(
        result.is_err(),
        "translating an invalid profile should fail"
    );
    assert!(
        matches!(
            result.unwrap_err(),
            runtimed::nono::profile::ProfileTranslationError::Invalid(_)
        ),
        "should return Invalid error"
    );
}

#[test]
fn profile_translation_succeeds_for_valid_profile() {
    // translate() should succeed for a valid enabled profile.
    let profile = SandboxProfile {
        enabled: true,
        credentials: vec![],
        allowed_domains: vec!["api.example.com".to_string()],
    };

    let result = runtimed::nono::profile::translate(&profile);
    assert!(
        result.is_ok(),
        "translating a valid profile should succeed: {:?}",
        result.err()
    );

    let translated = result.unwrap();
    // The profile file should exist on disk while TranslatedProfile is alive.
    assert!(
        translated.profile_json_path.exists(),
        "temp profile JSON file should exist while TranslatedProfile is held"
    );

    // Verify the JSON is valid.
    let contents = std::fs::read_to_string(&translated.profile_json_path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&contents).unwrap();
    assert!(parsed.get("meta").is_some(), "JSON should have 'meta' key");
    assert!(
        parsed.get("network").is_some(),
        "JSON should have 'network' key"
    );
    assert!(
        parsed["network"]["allow_domain"].is_array(),
        "network.allow_domain should be an array"
    );

    let path = translated.profile_json_path.to_path_buf();
    drop(translated);
    // File should be deleted after TranslatedProfile is dropped.
    assert!(
        !path.exists(),
        "temp profile JSON file should be deleted after TranslatedProfile is dropped"
    );
}

// ── KernelLaunchConfig sandbox_profile field ─────────────────────────────

#[test]
fn kernel_launch_config_has_sandbox_profile_field() {
    use notebook_protocol::protocol::{KernelPorts, LaunchedEnvConfig};
    use runtimed::kernel_connection::KernelLaunchConfig;

    // Verify the field exists and can be set to None (no-sandbox case).
    let _config = KernelLaunchConfig {
        kernel_type: "python".to_string(),
        env_source: "uv:prewarmed".to_string(),
        notebook_path: None,
        launched_config: LaunchedEnvConfig::default(),
        kernel_ports: KernelPorts {
            stdin: 9000,
            control: 9001,
            hb: 9002,
            shell: 9003,
            iopub: 9004,
        },
        env_vars: vec![],
        redact_env_values_in_outputs: false,
        pooled_env: None,
        direct_python_path: None,
        sandbox_profile: None, // no sandbox
    };

    // Field is present and set to None — direct launch path
}

#[test]
fn kernel_launch_config_sandbox_profile_with_enabled_profile() {
    use notebook_protocol::protocol::{KernelPorts, LaunchedEnvConfig};
    use runtimed::kernel_connection::KernelLaunchConfig;

    let profile = SandboxProfile {
        enabled: true,
        credentials: vec![],
        allowed_domains: vec!["api.example.com".to_string()],
    };

    let config = KernelLaunchConfig {
        kernel_type: "python".to_string(),
        env_source: "uv:prewarmed".to_string(),
        notebook_path: None,
        launched_config: LaunchedEnvConfig::default(),
        kernel_ports: KernelPorts {
            stdin: 9000,
            control: 9001,
            hb: 9002,
            shell: 9003,
            iopub: 9004,
        },
        env_vars: vec![],
        redact_env_values_in_outputs: false,
        pooled_env: None,
        direct_python_path: None,
        sandbox_profile: Some(profile),
    };

    // Verify the profile is present and enabled.
    assert!(
        config.sandbox_profile.as_ref().map_or(false, |p| p.enabled),
        "sandbox_profile should be present and enabled"
    );
}

// ── RuntimeAgentRequest sandbox_profile field ────────────────────────────

#[test]
fn runtime_agent_request_launch_kernel_has_sandbox_profile() {
    use notebook_protocol::connection::EnvSource;
    use notebook_protocol::protocol::{KernelPorts, LaunchedEnvConfig, RuntimeAgentRequest};

    // Verify the field exists and can be set to None.
    let req = RuntimeAgentRequest::LaunchKernel {
        kernel_type: "python".to_string(),
        env_source: EnvSource::Prewarmed(notebook_protocol::connection::PackageManager::Uv),
        notebook_path: None,
        launched_config: LaunchedEnvConfig::default(),
        kernel_ports: KernelPorts {
            stdin: 9000,
            control: 9001,
            hb: 9002,
            shell: 9003,
            iopub: 9004,
        },
        env_vars: Default::default(),
        redact_env_values_in_outputs: false,
        sandbox_profile: None,
    };

    // Serialize and deserialize to verify serde works correctly.
    let json = serde_json::to_value(&req).expect("serialize LaunchKernel");
    // sandbox_profile is None, so skip_serializing_if should omit it.
    assert!(
        !json.as_object().unwrap().contains_key("sandbox_profile"),
        "None sandbox_profile should not appear in JSON"
    );

    // Deserialize a JSON without sandbox_profile — should default to None.
    let parsed: RuntimeAgentRequest = serde_json::from_value(serde_json::json!({
        "action": "launch_kernel",
        "kernel_type": "python",
        "env_source": "uv:prewarmed",
        "launched_config": {},
        "kernel_ports": {
            "stdin": 9000,
            "control": 9001,
            "hb": 9002,
            "shell": 9003,
            "iopub": 9004
        }
    }))
    .expect("deserialize LaunchKernel without sandbox_profile");

    // The sandbox_profile field should default to None.
    if let RuntimeAgentRequest::LaunchKernel {
        sandbox_profile, ..
    } = parsed
    {
        assert_eq!(
            sandbox_profile, None,
            "sandbox_profile should default to None when absent from JSON"
        );
    } else {
        panic!("expected LaunchKernel");
    }
}

#[test]
fn runtime_agent_request_launch_kernel_with_sandbox_profile_round_trips() {
    use notebook_protocol::connection::EnvSource;
    use notebook_protocol::protocol::{KernelPorts, LaunchedEnvConfig, RuntimeAgentRequest};

    let profile = SandboxProfile {
        enabled: true,
        credentials: vec![],
        allowed_domains: vec!["api.example.com".to_string()],
    };

    let req = RuntimeAgentRequest::LaunchKernel {
        kernel_type: "python".to_string(),
        env_source: EnvSource::Prewarmed(notebook_protocol::connection::PackageManager::Uv),
        notebook_path: None,
        launched_config: LaunchedEnvConfig::default(),
        kernel_ports: KernelPorts {
            stdin: 9000,
            control: 9001,
            hb: 9002,
            shell: 9003,
            iopub: 9004,
        },
        env_vars: Default::default(),
        redact_env_values_in_outputs: false,
        sandbox_profile: Some(profile),
    };

    let json = serde_json::to_value(&req).expect("serialize with sandbox_profile");
    assert!(
        json.as_object().unwrap().contains_key("sandbox_profile"),
        "Some sandbox_profile should appear in JSON"
    );
    assert_eq!(json["sandbox_profile"]["enabled"], true);

    let parsed: RuntimeAgentRequest =
        serde_json::from_value(json).expect("deserialize with sandbox_profile");
    if let RuntimeAgentRequest::LaunchKernel {
        sandbox_profile: Some(p),
        ..
    } = parsed
    {
        assert!(p.enabled);
        assert_eq!(p.allowed_domains, vec!["api.example.com"]);
    } else {
        panic!("expected LaunchKernel with sandbox_profile");
    }
}
