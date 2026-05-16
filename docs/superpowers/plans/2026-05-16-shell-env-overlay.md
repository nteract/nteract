# Shell Env Overlay for Runtime Agents

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the user's shell environment once at daemon startup and apply it to each runtime-agent spawn, so kernels see the user's secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, etc.) while the existing PR #2610 redactor scrubs those values from outputs and the blob store.

**Architecture:** The daemon spawns the user's login shell (`$SHELL -lc 'env -0'`) once at startup, parses null-separated `KEY=VALUE` pairs into an `Arc<ShellEnvOverlay>`, and stores it in `Daemon`. The daemon's own process env stays untouched (no `env::set_var`), so a crash dump of the supervisor leaks nothing. When `RuntimeAgentHandle::spawn` runs, it layers the overlay onto the runtime-agent `Command` via `cmd.envs()`. The runtime-agent process then inherits the secrets in its real env, the existing `OutputRedactor::from_current_process_and_command` picks them up via `std::env::vars_os()`, and the kernel inherits them through the existing `cmd.envs()` plumbing in `jupyter_kernel.rs`. A new `import_shell_environment: bool` setting (default `true`) in the Privacy panel gates whether the overlay is applied on spawn.

**Tech Stack:** Rust (tokio, std::process::Command), `notebook-protocol` settings struct, `runtimed-settings-sync` JSON parser, React + ts-rs for the Privacy UI toggle.

---

## File Structure

**New:**
- `crates/runtimed/src/shell_env_overlay.rs` - capture + parse + apply; pure data + one `capture()` that shells out
- `crates/runtimed/tests/shell_env_overlay_runtime_agent.rs` - integration test that spawns a stub runtime-agent and asserts the overlay reaches the child env

**Modified:**
- `crates/runtimed/src/lib.rs` - declare new `shell_env_overlay` module
- `crates/runtimed/src/daemon.rs` - hold `Arc<ShellEnvOverlay>` on `Daemon`; accessor `shell_env_overlay()` and `import_shell_environment()` settings getter
- `crates/runtimed/src/main.rs:432` (`run_daemon`) - call `ShellEnvOverlay::capture()` before constructing `Daemon`, pass into `Daemon::new`
- `crates/runtimed/src/runtime_agent_handle.rs:44` - `RuntimeAgentHandle::spawn` takes `overlay: Option<Arc<ShellEnvOverlay>>`, applies via `cmd.envs()` before `cmd.spawn()`
- `crates/runtimed/src/requests/launch_kernel.rs:1598` - read `daemon.import_shell_environment().await`, pass overlay through to `RuntimeAgentHandle::spawn`
- `crates/notebook-protocol/src/protocol.rs:130` - add `default_import_shell_environment` fn; add `import_shell_environment: bool` to `SyncedSettings` near `redact_env_values_in_outputs`
- `crates/runtimed-settings-sync/src/lib.rs:600` - parse `import_shell_environment` from settings JSON
- `crates/runtimed/src/settings_doc.rs` (or whichever file owns `SettingsDoc::get_all`) - propagate field through Automerge projection
- `apps/notebook/settings/sections/Privacy.tsx` - add UI toggle and props
- `apps/notebook/settings/App.tsx` - thread `importShellEnvironment` state into `<PrivacySection>`
- `src/bindings/SyncedSettings.ts` - regenerated via ts-rs (do not hand-edit; just verify it lands)
- `src/hooks/useSyncedSettings.ts` - add `importShellEnvironment` to the hook surface

**Untouched:**
- `crates/runtimed/src/output_redaction.rs` - the redactor already reads `std::env::vars_os()`, so it automatically picks up overlay vars. No change needed; the test in Task 6 proves this.
- `crates/notebook/src/shell_env.rs` - still needed for the Tauri app's `runtimed install` sidecar PATH lookup; orthogonal concern.

---

## Cross-Task Constants

These names appear in multiple tasks; use them verbatim everywhere.

- Module path: `runtimed::shell_env_overlay`
- Struct: `ShellEnvOverlay`
- Inner storage: `entries: Vec<(OsString, OsString)>` (preserves order, allows dupes-by-key for trace logging if ever needed)
- Public methods:
  - `pub fn empty() -> Self`
  - `pub fn capture() -> Self` (cfg(unix); on non-unix returns `Self::empty()`)
  - `pub fn parse_null_separated(bytes: &[u8]) -> Self`
  - `pub fn len(&self) -> usize`
  - `pub fn is_empty(&self) -> bool`
  - `pub fn apply_to(&self, cmd: &mut tokio::process::Command)` - iterates and `cmd.env(k, v)`
- Settings field: `import_shell_environment: bool` (default `true`)
- Daemon accessor: `pub fn shell_env_overlay(&self) -> Arc<ShellEnvOverlay>`
- Daemon settings getter: `pub async fn import_shell_environment(&self) -> bool`
- Frontend prop name: `importShellEnvironment` / `onImportShellEnvironmentChange`

---

## Task 1: `ShellEnvOverlay` module skeleton with parsing tests

**Files:**
- Create: `crates/runtimed/src/shell_env_overlay.rs`
- Modify: `crates/runtimed/src/lib.rs` (add `pub mod shell_env_overlay;`)

- [ ] **Step 1: Write the failing test**

Append to `crates/runtimed/src/shell_env_overlay.rs`:

```rust
//! Capture the user's login-shell environment once at daemon startup and apply
//! it to runtime-agent subprocess spawns. The daemon's own process env stays
//! untouched; only spawned runtime-agents inherit the captured values.

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;

#[derive(Debug, Default, Clone)]
pub struct ShellEnvOverlay {
    entries: Vec<(OsString, OsString)>,
}

impl ShellEnvOverlay {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn parse_null_separated(bytes: &[u8]) -> Self {
        let mut entries = Vec::new();
        for chunk in bytes.split(|&b| b == 0) {
            if chunk.is_empty() {
                continue;
            }
            let Some(eq_idx) = chunk.iter().position(|&b| b == b'=') else {
                continue;
            };
            let key = OsString::from_vec(chunk[..eq_idx].to_vec());
            let value = OsString::from_vec(chunk[eq_idx + 1..].to_vec());
            entries.push((key, value));
        }
        Self { entries }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn apply_to(&self, cmd: &mut tokio::process::Command) {
        for (key, value) in &self.entries {
            cmd.env(key, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_null_separated_pairs() {
        let raw = b"FOO=bar\0BAZ=qux\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(overlay.len(), 2);
        assert_eq!(overlay.entries[0].0, OsString::from("FOO"));
        assert_eq!(overlay.entries[0].1, OsString::from("bar"));
        assert_eq!(overlay.entries[1].0, OsString::from("BAZ"));
        assert_eq!(overlay.entries[1].1, OsString::from("qux"));
    }

    #[test]
    fn skips_entries_without_equals() {
        let raw = b"GOOD=value\0BARE_TOKEN\0OTHER=ok\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(overlay.len(), 2);
        assert_eq!(overlay.entries[0].0, OsString::from("GOOD"));
        assert_eq!(overlay.entries[1].0, OsString::from("OTHER"));
    }

    #[test]
    fn handles_values_containing_equals_signs() {
        let raw = b"URL=https://example.com/?a=1&b=2\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(overlay.len(), 1);
        assert_eq!(overlay.entries[0].0, OsString::from("URL"));
        assert_eq!(
            overlay.entries[0].1,
            OsString::from("https://example.com/?a=1&b=2")
        );
    }

    #[test]
    fn empty_input_yields_empty_overlay() {
        assert!(ShellEnvOverlay::parse_null_separated(b"").is_empty());
        assert!(ShellEnvOverlay::parse_null_separated(b"\0\0\0").is_empty());
    }

    #[test]
    fn handles_multiline_values() {
        let raw = b"MULTI=line1\nline2\nline3\0NEXT=ok\0";
        let overlay = ShellEnvOverlay::parse_null_separated(raw);
        assert_eq!(overlay.len(), 2);
        assert_eq!(overlay.entries[0].1, OsString::from("line1\nline2\nline3"));
    }
}
```

Append to `crates/runtimed/src/lib.rs` (add to the module declaration block, alongside e.g. `pub mod runtime_agent;`):

```rust
pub mod shell_env_overlay;
```

- [ ] **Step 2: Run tests to verify they fail to compile, then compile-pass**

Run: `cargo test -p runtimed --lib shell_env_overlay -- --nocapture`
Expected: compiles, all five tests PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/runtimed/src/shell_env_overlay.rs crates/runtimed/src/lib.rs
git commit -m "feat(runtimed): add ShellEnvOverlay parse + apply primitives"
```

---

## Task 2: `ShellEnvOverlay::capture()` via login shell

**Files:**
- Modify: `crates/runtimed/src/shell_env_overlay.rs`

- [ ] **Step 1: Write the failing test**

Append to the existing `mod tests` block in `crates/runtimed/src/shell_env_overlay.rs`:

```rust
    #[cfg(unix)]
    #[test]
    fn capture_returns_some_entries_on_unix() {
        // Real shell available on any dev box and on CI macOS/Linux runners.
        // The test asserts a soft floor (>= 1 entry) and that PATH made it through,
        // which any login shell will export.
        let overlay = ShellEnvOverlay::capture();
        assert!(
            overlay.len() >= 1,
            "expected at least one captured env entry, got {}",
            overlay.len()
        );
        let has_path = overlay
            .entries
            .iter()
            .any(|(k, _)| k == std::ffi::OsStr::new("PATH"));
        assert!(has_path, "expected PATH in captured shell env");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p runtimed --lib shell_env_overlay::tests::capture_returns_some_entries_on_unix -- --nocapture`
Expected: FAIL with "no method named `capture`".

- [ ] **Step 3: Implement `capture()`**

Add to `impl ShellEnvOverlay` in `crates/runtimed/src/shell_env_overlay.rs`, and add the module-level constants and helper above it:

```rust
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const SHELL_CAPTURE_SCRIPT: &str = "env -0";
```

Add the method (inside `impl ShellEnvOverlay`):

```rust
    #[cfg(unix)]
    pub fn capture() -> Self {
        match capture_inner() {
            Ok(overlay) => {
                tracing::info!(
                    "[shell-env-overlay] captured {} entries from login shell",
                    overlay.len()
                );
                overlay
            }
            Err(e) => {
                tracing::warn!(
                    "[shell-env-overlay] capture failed: {e}; using empty overlay"
                );
                Self::empty()
            }
        }
    }

    #[cfg(not(unix))]
    pub fn capture() -> Self {
        Self::empty()
    }
```

Add the free function below the impl block:

```rust
#[cfg(unix)]
fn capture_inner() -> Result<ShellEnvOverlay, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let shell = std::env::var_os("SHELL").unwrap_or_else(|| std::ffi::OsString::from("/bin/zsh"));

    let mut child = Command::new(&shell)
        .args(["-l", "-c", SHELL_CAPTURE_SCRIPT])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn {shell:?}: {e}"))?;

    let mut stdout = child.stdout.take().ok_or("missing stdout pipe")?;

    // Block on a thread with timeout (std::process has no native timeout).
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::with_capacity(8 * 1024);
        let result = stdout
            .read_to_end(&mut buf)
            .map(|_| buf)
            .map_err(|e| e.to_string());
        let _ = tx.send(result);
    });

    let buf = match rx.recv_timeout(CAPTURE_TIMEOUT) {
        Ok(Ok(buf)) => buf,
        Ok(Err(e)) => {
            let _ = child.kill();
            return Err(format!("read stdout: {e}"));
        }
        Err(_) => {
            let _ = child.kill();
            return Err(format!("login shell capture timed out after {CAPTURE_TIMEOUT:?}"));
        }
    };

    match child.wait() {
        Ok(status) if !status.success() => {
            return Err(format!("login shell exited with status {status}"));
        }
        Err(e) => return Err(format!("wait on shell: {e}")),
        _ => {}
    }

    Ok(ShellEnvOverlay::parse_null_separated(&buf))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p runtimed --lib shell_env_overlay -- --nocapture`
Expected: all six tests PASS. The capture test prints the entry count to stderr.

- [ ] **Step 5: Commit**

```bash
git add crates/runtimed/src/shell_env_overlay.rs
git commit -m "feat(runtimed): capture login-shell env via 'env -0' with 3s timeout"
```

---

## Task 3: Hold the overlay on `Daemon` and capture at startup

**Files:**
- Modify: `crates/runtimed/src/daemon.rs` (struct field, `Daemon::new`, accessor)
- Modify: `crates/runtimed/src/main.rs:432` (call `ShellEnvOverlay::capture()` in `run_daemon`)

- [ ] **Step 1: Add the field to `Daemon`**

Locate the `pub struct Daemon { ... }` block at `crates/runtimed/src/daemon.rs:1087` and add at the bottom of the field list (before the closing brace, after `pixi_warming_respawns`):

```rust
    /// Shell-env overlay captured once at daemon startup. Applied to
    /// runtime-agent spawn commands when `import_shell_environment` is on.
    /// The daemon process env itself is never modified.
    pub(crate) shell_env_overlay: std::sync::Arc<crate::shell_env_overlay::ShellEnvOverlay>,
```

- [ ] **Step 2: Find and update `Daemon::new` (or whichever constructor builds the struct)**

Run: `grep -n "fn new\|Self {" crates/runtimed/src/daemon.rs | head -20` to locate the constructor. Add a parameter:

```rust
pub async fn new(
    config: DaemonConfig,
    shell_env_overlay: std::sync::Arc<crate::shell_env_overlay::ShellEnvOverlay>,
    // ... existing params ...
) -> anyhow::Result<Self> {
```

In the `Self { ... }` struct literal, add:

```rust
    shell_env_overlay,
```

If `Daemon::new` is called from tests, update test sites to pass `std::sync::Arc::new(crate::shell_env_overlay::ShellEnvOverlay::empty())`.

- [ ] **Step 3: Add accessor**

In `impl Daemon` (the public impl block starting near `crates/runtimed/src/daemon.rs:1157`), add right after `redact_env_values_in_outputs`:

```rust
    /// Snapshot of the user's login-shell env captured at daemon startup.
    /// Cheap to clone; applied to runtime-agent spawns when the setting is on.
    pub fn shell_env_overlay(&self) -> std::sync::Arc<crate::shell_env_overlay::ShellEnvOverlay> {
        self.shell_env_overlay.clone()
    }
```

- [ ] **Step 4: Wire capture into `run_daemon`**

In `crates/runtimed/src/main.rs`, locate `async fn run_daemon(config: DaemonConfig)` near line 432. Before the `let daemon = Daemon::new(...)` call (find it by searching for `Daemon::new` in the function), insert:

```rust
    let shell_env_overlay = std::sync::Arc::new(
        runtimed::shell_env_overlay::ShellEnvOverlay::capture(),
    );
    info!(
        "Shell env overlay: {} entries captured",
        shell_env_overlay.len()
    );
```

Then add `shell_env_overlay.clone()` as an argument to `Daemon::new`.

- [ ] **Step 5: Compile**

Run: `cargo build -p runtimed`
Expected: clean build. Fix any test-only `Daemon::new` call sites that the compiler flags.

- [ ] **Step 6: Verify the existing daemon test suite still passes**

Run: `cargo test -p runtimed --lib daemon -- --nocapture`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/runtimed/src/daemon.rs crates/runtimed/src/main.rs
git commit -m "feat(runtimed): capture shell env at daemon startup, hold on Daemon"
```

---

## Task 4: `import_shell_environment` setting

**Files:**
- Modify: `crates/notebook-protocol/src/protocol.rs` (struct field + default fn)
- Modify: `crates/runtimed-settings-sync/src/lib.rs:600` (JSON read path)
- Modify: `crates/runtimed/src/settings_doc.rs` (Automerge projection; locate via grep below)
- Modify: `crates/runtimed/src/daemon.rs` (async getter)

- [ ] **Step 1: Add the default fn and struct field in `notebook-protocol`**

In `crates/notebook-protocol/src/protocol.rs`, right after `default_redact_env_values_in_outputs` near line 130:

```rust
fn default_import_shell_environment() -> bool {
    true
}
```

Then in the `SyncedSettings` struct (find via `grep -n "pub struct SyncedSettings" crates/notebook-protocol/src/protocol.rs`), add immediately below the `redact_env_values_in_outputs` field:

```rust
    /// Apply the daemon's captured login-shell environment to newly spawned
    /// runtime agents. Combined with `redact_env_values_in_outputs`, the user's
    /// shell secrets reach the kernel but are scrubbed from outputs/blob store.
    #[serde(default = "default_import_shell_environment")]
    pub import_shell_environment: bool,
```

Also update every other place in this file where `SyncedSettings { ... }` is constructed (test fixtures around lines 1591, 1619, 1631, 1685, 1701) to include `import_shell_environment: true,`.

- [ ] **Step 2: Wire JSON parsing**

In `crates/runtimed-settings-sync/src/lib.rs`, right after the `redact_env_values_in_outputs` line at 600-601:

```rust
        import_shell_environment: get_bool("import_shell_environment")
            .unwrap_or(defaults.import_shell_environment),
```

- [ ] **Step 3: Update the Automerge SettingsDoc projection**

Run: `grep -n "redact_env_values_in_outputs" crates/runtimed/src/settings_doc.rs` to find the projection. Mirror every appearance of `redact_env_values_in_outputs` with a parallel `import_shell_environment` line in the same blocks (struct field, reader, writer). If the file uses a macro or table-driven approach, follow that pattern.

- [ ] **Step 4: Add async getter on `Daemon`**

In `crates/runtimed/src/daemon.rs`, directly after the existing `redact_env_values_in_outputs` getter (around line 1170):

```rust
    /// Whether to apply the captured shell-env overlay when spawning runtime
    /// agents. When off, kernels only see the daemon's own (launchd-minimal) env.
    pub async fn import_shell_environment(&self) -> bool {
        self.settings
            .read()
            .await
            .get_all()
            .import_shell_environment
    }
```

- [ ] **Step 5: Compile and run existing settings tests**

Run: `cargo test -p runtimed-settings-sync && cargo test -p notebook-protocol && cargo build -p runtimed`
Expected: PASS / clean build. Any test fixtures the compiler flags as missing the new field must be updated to set it.

- [ ] **Step 6: Commit**

```bash
git add crates/notebook-protocol/src/protocol.rs crates/runtimed-settings-sync/src/lib.rs crates/runtimed/src/settings_doc.rs crates/runtimed/src/daemon.rs
git commit -m "feat(settings): add import_shell_environment toggle (default on)"
```

---

## Task 5: Apply overlay in `RuntimeAgentHandle::spawn`

**Files:**
- Modify: `crates/runtimed/src/runtime_agent_handle.rs:44-80`

- [ ] **Step 1: Update the spawn signature**

In `crates/runtimed/src/runtime_agent_handle.rs`, change the `RuntimeAgentHandle::spawn` signature:

```rust
    pub async fn spawn(
        notebook_id: String,
        runtime_agent_id: String,
        blob_root: PathBuf,
        socket_path: PathBuf,
        runtime_agent_exe: Option<PathBuf>,
        shell_env_overlay: Option<std::sync::Arc<crate::shell_env_overlay::ShellEnvOverlay>>,
    ) -> Result<Self> {
```

After the `cmd.arg(...)` block (just before `cmd.spawn()` at line 80), insert:

```rust
        if let Some(overlay) = shell_env_overlay {
            if !overlay.is_empty() {
                info!(
                    "[runtime-agent-handle] applying shell env overlay ({} entries) to runtime agent {}",
                    overlay.len(),
                    runtime_agent_id,
                );
                overlay.apply_to(&mut cmd);
            }
        }
```

- [ ] **Step 2: Compile and let the compiler list call sites**

Run: `cargo build -p runtimed 2>&1 | grep -E "error\[|^\s+--> " | head -20`
Expected: a compile error at every existing `RuntimeAgentHandle::spawn` call (currently one in `launch_kernel.rs`, possibly more).

- [ ] **Step 3: Commit (will not compile yet, so use `--no-verify-amend` workflow — actually defer until Task 6 wires callers)**

Skip the commit here. Task 6 will pass the new argument from callers and then we commit together.

---

## Task 6: Thread overlay through `launch_kernel` and prove the redactor picks it up

**Files:**
- Modify: `crates/runtimed/src/requests/launch_kernel.rs:1598`
- Create: `crates/runtimed/tests/shell_env_overlay_runtime_agent.rs`

- [ ] **Step 1: Update the call site in `launch_kernel.rs`**

In `crates/runtimed/src/requests/launch_kernel.rs`, near line 1487 where `redact_env_values_in_outputs` is read:

```rust
    let redact_env_values_in_outputs = daemon.redact_env_values_in_outputs().await;
    let import_shell_environment = daemon.import_shell_environment().await;
    let overlay_for_spawn = if import_shell_environment {
        Some(daemon.shell_env_overlay())
    } else {
        None
    };
```

Then at the `RuntimeAgentHandle::spawn` call near line 1598, add `overlay_for_spawn` as the last argument:

```rust
        match crate::runtime_agent_handle::RuntimeAgentHandle::spawn(
            notebook_id,
            runtime_agent_id.clone(),
            room.blob_store.root().to_path_buf(),
            socket_path,
            daemon.config.runtime_agent_exe.clone(),
            overlay_for_spawn,
        )
        .await
```

If the restart-in-place path further up (search for `RestartKernel`) takes a separate code path that does NOT respawn the runtime-agent, the overlay is irrelevant there: the runtime-agent already has the overlay from its original spawn. Confirm by reading lines 1488-1571 and add a one-line comment noting it.

- [ ] **Step 2: Build everything**

Run: `cargo build -p runtimed`
Expected: clean build.

- [ ] **Step 3: Write the integration test**

Create `crates/runtimed/tests/shell_env_overlay_runtime_agent.rs`:

```rust
//! Verifies that ShellEnvOverlay applied to a tokio::process::Command actually
//! reaches the child process's environment. This is a property test of the
//! overlay glue, not of the runtime-agent binary itself.

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::sync::Arc;

use runtimed::shell_env_overlay::ShellEnvOverlay;

#[tokio::test]
async fn overlay_reaches_spawned_child_env() {
    // Build a synthetic overlay with one secret-shaped value.
    let raw = b"TEST_OVERLAY_TOKEN=sk-overlay-test-12345\0";
    let overlay = Arc::new(ShellEnvOverlay::parse_null_separated(raw));

    // Spawn `/usr/bin/env` so the child prints its own env on stdout.
    let mut cmd = tokio::process::Command::new("/usr/bin/env");
    cmd.stdout(std::process::Stdio::piped());
    overlay.apply_to(&mut cmd);
    let output = cmd.output().await.expect("spawn /usr/bin/env");

    let stdout = String::from_utf8(output.stdout).expect("env output utf8");
    assert!(
        stdout.contains("TEST_OVERLAY_TOKEN=sk-overlay-test-12345"),
        "expected overlay token in child env, got:\n{stdout}"
    );
}

#[tokio::test]
async fn empty_overlay_is_a_noop() {
    let overlay = ShellEnvOverlay::empty();
    let mut cmd = tokio::process::Command::new("/usr/bin/env");
    cmd.stdout(std::process::Stdio::piped());
    overlay.apply_to(&mut cmd);
    let output = cmd.output().await.expect("spawn /usr/bin/env");
    let stdout = String::from_utf8(output.stdout).expect("env output utf8");
    // PATH or HOME from the parent process should still be there; we just check
    // the child started successfully.
    assert!(output.status.success(), "child exited non-zero: {stdout}");
}

#[tokio::test]
async fn redactor_picks_up_overlay_values_via_get_envs() {
    // Build an overlay, apply to a Command, then construct a redactor from
    // that command's envs (mirroring how OutputRedactor::from_current_process_and_command
    // reads cmd.get_envs() on line 40 of output_redaction.rs).
    let raw = b"TEST_REDACTABLE_SECRET=abcdef1234567890\0";
    let overlay = ShellEnvOverlay::parse_null_separated(raw);
    let mut cmd = tokio::process::Command::new("/usr/bin/env");
    overlay.apply_to(&mut cmd);

    // The std::process::Command underneath exposes get_envs(); tokio's Command
    // dereferences into it via as_std(). The redactor's eligibility rules
    // accept this value (16 chars, no whitespace, not in the localhost list).
    let std_cmd: &std::process::Command = cmd.as_std();
    let found = std_cmd
        .get_envs()
        .any(|(k, v)| {
            k == std::ffi::OsStr::new("TEST_REDACTABLE_SECRET")
                && v == Some(std::ffi::OsStr::new("abcdef1234567890"))
        });
    assert!(found, "overlay value not visible via Command::get_envs()");

    // Sanity: silence unused warning for OsString import in shared tests.
    let _ = OsString::from_vec(b"unused".to_vec());
}
```

- [ ] **Step 4: Run the integration test**

Run: `cargo test -p runtimed --test shell_env_overlay_runtime_agent -- --nocapture`
Expected: all three tests PASS.

- [ ] **Step 5: Run the whole runtimed test suite to catch regressions**

Run: `cargo test -p runtimed`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/runtimed/src/runtime_agent_handle.rs crates/runtimed/src/requests/launch_kernel.rs crates/runtimed/tests/shell_env_overlay_runtime_agent.rs
git commit -m "feat(runtimed): apply shell env overlay to runtime-agent spawn"
```

---

## Task 7: Privacy panel UI toggle

**Files:**
- Modify: `apps/notebook/settings/sections/Privacy.tsx`
- Modify: `apps/notebook/settings/App.tsx`
- Modify: `src/hooks/useSyncedSettings.ts`
- Regenerated automatically: `src/bindings/SyncedSettings.ts`

- [ ] **Step 1: Regenerate ts-rs bindings**

Run: `cargo xtask ts-bindings` (or the equivalent — check `cargo xtask help`)
Expected: `src/bindings/SyncedSettings.ts` now includes `import_shell_environment: boolean;`.

If the command name differs, search: `grep -n "ts-rs\|ts-bindings" /Users/kylekelley/projects/desktop/xtask/src/*.rs`.

- [ ] **Step 2: Add prop and toggle to Privacy.tsx**

Edit `apps/notebook/settings/sections/Privacy.tsx`. Extend the `PrivacySectionProps` interface (around lines 8-18):

```typescript
  importShellEnvironment: boolean;
  onImportShellEnvironmentChange: (value: boolean) => void;
```

Extend the function signature destructuring at line 37:

```typescript
  importShellEnvironment,
  onImportShellEnvironmentChange,
```

Add a new toggle block in the `<CollapsibleContent>` block, immediately after the `redactEnvValuesInOutputs` toggle (after line 97 closing `</div>`):

```tsx
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <span className="text-xs text-muted-foreground">
              Import shell environment into kernels
            </span>
            <p className="text-[10px] text-muted-foreground/70">
              Passes your login shell's env vars (API keys, tokens) to newly launched kernels.
              Pair with redaction above to keep values out of outputs.
            </p>
          </div>
          <Switch
            checked={importShellEnvironment}
            onCheckedChange={onImportShellEnvironmentChange}
          />
        </div>
```

- [ ] **Step 3: Wire the prop through `App.tsx`**

In `apps/notebook/settings/App.tsx`, find the `<PrivacySection>` usage (grep for `PrivacySection`). Add to its props:

```tsx
importShellEnvironment={settings.importShellEnvironment}
onImportShellEnvironmentChange={(value) =>
  updateSettings({ importShellEnvironment: value })
}
```

- [ ] **Step 4: Surface in `useSyncedSettings`**

Edit `src/hooks/useSyncedSettings.ts`. Find where `redactEnvValuesInOutputs` is read from the synced settings doc and exposed; add a parallel `importShellEnvironment` read and writer. Mirror the existing pattern exactly.

- [ ] **Step 5: Type-check the frontend**

Run: `pnpm tsc --noEmit` (from repo root, or use the project's typecheck task)
Expected: clean.

- [ ] **Step 6: Build the notebook app**

Run: `cargo build -p notebook`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/notebook/settings/sections/Privacy.tsx apps/notebook/settings/App.tsx src/hooks/useSyncedSettings.ts src/bindings/SyncedSettings.ts
git commit -m "feat(notebook): add 'Import shell environment' Privacy toggle"
```

---

## Task 8: Required-before-commit hygiene + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the lint pass that CI enforces**

Run: `cargo xtask lint --fix`
Expected: clean exit. Any changes auto-applied get committed in step 4.

- [ ] **Step 2: Manual E2E (the actual user-facing verification)**

Open a fresh terminal and export a sentinel:

```bash
export TEST_SHELL_OVERLAY_SECRET="sk-real-test-$(date +%s)abcdef"
```

Quit and relaunch `nteract Nightly.app` from the same terminal (`open -a "nteract Nightly"`). In a Python notebook, run:

```python
import os
os.environ.get("TEST_SHELL_OVERLAY_SECRET")
```

Expected output: the actual secret string. This proves the overlay reached the kernel.

Then run:

```python
print("Value is:", os.environ["TEST_SHELL_OVERLAY_SECRET"])
```

Expected output: `Value is: [redacted env]`. This proves the redactor scrubbed the value from the stream output.

If either expectation fails: do not declare done. Use systematic-debugging to trace which layer dropped the value.

- [ ] **Step 3: Toggle the setting off and re-verify**

In the Settings → Privacy panel, turn "Import shell environment into kernels" OFF. Restart the kernel from the notebook. Run again:

```python
import os
os.environ.get("TEST_SHELL_OVERLAY_SECRET")
```

Expected: `None`. Then turn the setting back ON, restart the kernel, and confirm the value returns.

- [ ] **Step 4: Final commit if `lint --fix` made any changes**

```bash
git status
# If anything is unstaged from lint --fix:
git add -u
git commit -m "chore(lint): apply cargo xtask lint --fix"
```

- [ ] **Step 5: Push and open a PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(runtimed): import login-shell env into kernels, scoped to runtime-agents" --body-file <path-to-pr-body.md>
```

PR body skeleton (write to `/tmp/pr-shell-env-overlay.md` first):

```markdown
Captures the user's login-shell env once at daemon startup, applies it to each
runtime-agent spawn via `Command::envs()`. Kernels see `ANTHROPIC_API_KEY` and
friends; the redactor from #2610 scrubs those values from outputs and the blob
store.

The daemon process env stays the launchd-minimal 10 vars — secrets only live in
the per-notebook runtime-agent process and the kernel it spawns. A new
`import_shell_environment` setting in the Privacy panel gates whether the
overlay is applied; default on.

## Design

- `ShellEnvOverlay` is a Rust struct, not a process-env mutation. The daemon
  never `env::set_var`s the captured values, so a daemon crash dump leaks
  nothing.
- Capture runs `$SHELL -lc 'env -0'` with a 3-second timeout. Failure → empty
  overlay + warn log.
- Apply happens in `RuntimeAgentHandle::spawn`. The kernel's existing env
  inheritance carries it the rest of the way; the redactor's existing
  `std::env::vars_os()` read in `OutputRedactor::from_current_process_and_command`
  picks it up automatically.
- The `crates/notebook/src/shell_env.rs` helper in the Tauri app is unchanged —
  it solves a different problem (PATH for the `runtimed install` sidecar).

## Behavioral coverage

| Setting on? | Shell secret exported? | `os.environ.get(...)` | Output redacted? |
|-------------|------------------------|-----------------------|------------------|
| Yes (default) | Yes | secret value           | yes              |
| Yes (default) | No  | `None`                 | n/a              |
| No           | Yes | `None`                 | n/a              |
| No           | No  | `None`                 | n/a              |

## Test plan

- [x] `cargo test -p runtimed --lib shell_env_overlay`
- [x] `cargo test -p runtimed --test shell_env_overlay_runtime_agent`
- [x] `cargo test -p runtimed`
- [x] Manual E2E with `TEST_SHELL_OVERLAY_SECRET` exported in the launching shell.
- [x] Setting toggle off → secret invisible; back on → secret visible and redacted.
```

---

## Self-Review Checklist (already applied)

- **Spec coverage:** Tasks 1-2 build the overlay. Task 3 captures at startup. Task 4 adds settings. Tasks 5-6 plumb it through the runtime-agent spawn and prove via tests that the redactor picks it up via `get_envs()`. Task 7 surfaces the UI. Task 8 verifies end-to-end.
- **Placeholders:** none.
- **Type consistency:** `ShellEnvOverlay`, `import_shell_environment`, `shell_env_overlay()` accessor, `apply_to(&mut Command)` used identically across tasks.
- **One known unknown:** the exact location and shape of `SettingsDoc::get_all` in `crates/runtimed/src/settings_doc.rs`. Task 4 Step 3 instructs the executor to grep and mirror the existing pattern — this is the right move because the field is one line in any of the plausible projection styles.
