//! End-to-end glue test for the shell-env overlay -> env_vars -> kernel Command path.
//!
//! The redactor's eligibility rules are covered by its own unit tests in
//! `output_redaction.rs`. This test asserts the architectural invariant: an
//! overlay entry, once merged into the LaunchKernel `env_vars` map and applied
//! via `Command::envs()` exactly the way `jupyter_kernel.rs:780` does, is
//! visible via `cmd.get_envs()` - which is the path
//! `OutputRedactor::from_current_process_and_command` reads at
//! `crates/runtimed/src/output_redaction.rs:40`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::sync::Arc;

use runtimed::shell_env_overlay::ShellEnvOverlay;

#[test]
fn overlay_value_reaches_kernel_command_via_env_vars() {
    // 1. Daemon builds an overlay (simulated parse from `env -0` output).
    let overlay = Arc::new(ShellEnvOverlay::parse_null_separated(
        b"TEST_REDACTABLE_SECRET=abcdef1234567890\0",
    ));

    // 2. Daemon merges overlay into env_vars exactly the way
    //    requests::launch_kernel.rs does for LaunchKernel.
    let env_vars: HashMap<String, String> = overlay
        .entries()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    // 3. Runtime-agent applies env_vars to the kernel Command exactly the way
    //    jupyter_kernel.rs:780 does.
    let mut cmd = std::process::Command::new("/usr/bin/env");
    for (key, value) in &env_vars {
        cmd.env(key, value);
    }

    // 4. The redactor's loop at output_redaction.rs:40 iterates cmd.get_envs().
    //    Prove the overlay value is visible through that exact API.
    let mut found = false;
    for (key, value) in cmd.get_envs() {
        if key == OsStr::new("TEST_REDACTABLE_SECRET")
            && value == Some(OsStr::new("abcdef1234567890"))
        {
            found = true;
            break;
        }
    }
    assert!(
        found,
        "overlay value not visible to redactor via Command::get_envs()"
    );
}

#[test]
fn toggle_off_means_overlay_does_not_reach_env_vars() {
    // Simulates the import_shell_environment=false branch of launch_kernel.rs.
    let overlay = Arc::new(ShellEnvOverlay::parse_null_separated(
        b"TEST_REDACTABLE_SECRET=abcdef1234567890\0",
    ));
    let import_shell_environment = false;

    let env_vars: HashMap<String, String> = if import_shell_environment {
        overlay
            .entries()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    } else {
        HashMap::new()
    };

    assert!(
        env_vars.is_empty(),
        "expected empty env_vars when import is off"
    );
}

#[test]
fn overlay_loses_to_explicit_env_vars_extend() {
    // Plan invariant: overlay entries are inserted first, then extended with
    // uv_offline_env_vars and pixi_frozen_env_vars. Keys present in both must
    // be won by the later extends so daemon-required vars (UV_OFFLINE, etc.)
    // can't be clobbered by a user-exported value with the same name.
    let overlay = Arc::new(ShellEnvOverlay::parse_null_separated(
        b"UV_OFFLINE=user-value\0FOO=bar\0",
    ));

    let mut env_vars: HashMap<String, String> = overlay
        .entries()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    // Simulate uv_offline_env_vars returning UV_OFFLINE=1.
    let uv: HashMap<String, String> = [("UV_OFFLINE".to_string(), "1".to_string())]
        .into_iter()
        .collect();
    env_vars.extend(uv);

    assert_eq!(env_vars.get("UV_OFFLINE").map(String::as_str), Some("1"));
    assert_eq!(env_vars.get("FOO").map(String::as_str), Some("bar"));
}
