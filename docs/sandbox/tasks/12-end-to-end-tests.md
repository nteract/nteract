# Task 12: End-to-end tests

## Framing

Validate the full sandbox feature with end-to-end tests covering happy path and all four error scenarios from `error-routing-design.md`. These tests run the real daemon, real nono binary, and a real Python kernel — they catch integration bugs that unit tests miss.

Depends on **all** Phase 1 and Phase 2 tasks. This is the gate before declaring MVP complete.

## Context to read

- `docs/sandbox/decisions.md` — the full empirical truth table at the bottom is required reading
- `docs/sandbox/error-routing-design.md` — all four scenarios in detail
- `docs/sandbox/nono-empirical-tests.md` — confirmed nono behaviors to assert
- The repo's existing testing skill: `.agents/skills/testing/SKILL.md`
- Existing E2E tests under `crates/runtimed/tests/` for conventions

**Do not read** other task files in `docs/sandbox/tasks/`.

## Background

Each scenario must be verified at three layers:

1. **Behavioral**: did Python see the right thing?
2. **State**: did `RuntimeStateDoc.cell_annotations` get the right entry?
3. **Process**: are both nono and kernel cleanly torn down?

The tests use a controlled keychain. macOS keychain manipulation in CI is awkward — use the macOS `security` CLI to create/delete `nono.<name>` entries in a temp keychain, and remove them on test teardown. Keep the keychain interactions hermetic per test.

## Technical steps

### 1. Test infrastructure

Add `crates/runtimed/tests/sandbox_e2e.rs` (or wherever the existing daemon E2E tests live).

Helpers:

```rust
/// Adds a credential to a per-test temp keychain. Returns a guard that removes
/// the credential on drop.
fn with_test_credential(name: &str, value: &str) -> CredentialGuard;

/// Spawns a daemon with a notebook containing the given sandbox profile.
async fn launch_with_profile(profile: SandboxProfile) -> TestDaemon;

/// Executes a Python cell on the test runtime and returns outputs + annotations.
async fn execute_cell(daemon: &TestDaemon, code: &str) -> CellResult;
```

Skip the entire test file on Windows via `#[cfg(target_os = "macos")]` for MVP. Linux tests are nice-to-have but not required.

### 2. Test: Happy path (credential injection)

```text
GIVEN a credential `analytics_api` exists in the keychain with value "real-secret-xyz"
AND   a notebook with sandbox.enabled = true
      and credentials = [{
        name: "analytics_api",
        env_var: "ANALYTICS_API_KEY",
        routes: [{
          host: "httpbin.org",
          inject_as: header,
          header: "Authorization",
          template: "Bearer {credential}"
        }]
      }]
      and allowed_domains = ["httpbin.org"]

WHEN the kernel executes:
  import os, requests
  r = requests.get("https://httpbin.org/headers", headers={
      "Authorization": f"Bearer {os.environ['ANALYTICS_API_KEY']}"
  })
  print(r.json())

THEN the response shows the upstream received `Authorization: Bearer real-secret-xyz`
AND  the kernel's environment variable held a phantom token, never the real value
AND  no annotations were written for this execution
```

This test confirms the full credential injection contract end-to-end.

### 3. Test: Domain blocked

```text
GIVEN a notebook with sandbox.enabled = true
      and allowed_domains = ["httpbin.org"]
      (no credentials)

WHEN the kernel executes:
  import requests
  try: r = requests.get("https://example.com")
  except Exception as e: print(type(e).__name__, e)

THEN the cell's annotation has kind = "sandbox_domain_blocked"
AND  the annotation message contains "example.com"
AND  the kernel saw an HTTP 403 (or proxy connection error)
```

### 4. Test: Credential rejected by upstream

This is harder to validate deterministically without controlling an upstream that returns 401. Two options:

- **Recommended**: Run a tiny localhost HTTP server (use `axum` or similar already in the workspace) that returns 401 to any request. Configure the profile to route a credential through it.
- **Fallback**: Use a known-public 401 endpoint (e.g. `httpbin.org/status/401`) — flakiness risk is real.

```text
GIVEN a credential `bad_api` is present
AND   a notebook routing it to the test 401 server

WHEN the kernel executes a request that hits the 401 server

THEN the cell's annotation has kind = "sandbox_credential_rejected"
AND  the annotation message names the credential
```

### 5. Test: Proxy dies mid-session

```text
GIVEN an active sandboxed runtime
WHEN  the test sends SIGTERM to the nono PID directly (simulating a crash)
THEN  within ~2s the SandboxState transitions to Degraded
AND   any subsequent execution has an annotation kind = "sandbox_proxy_degraded"
AND   the kernel process is also cleaned up (no orphan)
```

This test asserts the **process tree** invariant from **D-4**.

### 6. Test: Missing credential at startup

```text
GIVEN no credential `nonexistent_xxx` in the keychain
AND   a notebook profile that requires it

WHEN  the user attempts to launch a sandboxed kernel

THEN  the launch fails with SandboxLaunchError::SandboxStartFailed
AND   the runtime never enters the running state
AND   if the user attempts to execute a cell, the annotation surfaces sandbox_startup_failed
```

### 7. Test: No-profile path is unchanged

```text
GIVEN a notebook with no sandbox profile

WHEN the kernel launches and executes any cell with a network call

THEN the kernel is the daemon's grandchild as before (no nono in the process tree)
AND  no annotations are written
AND  network calls go directly to the internet (verifiable by checking the absence of
     HTTPS_PROXY in the kernel's environment, or by observing that an unallowlisted
     host like example.com is reachable)
```

### 8. Test: Clean teardown

```text
GIVEN any sandboxed runtime
WHEN  the daemon shuts down the runtime
THEN  ps shows no remaining nono process for that runtime
AND   ps shows no remaining kernel process
AND   ps shows no orphan `log stream` helper
AND   the temp profile YAML is removed
AND   the audit directory exists with at least one session_started + session_ended event
```

### 9. Documentation

Add a section to `docs/sandbox/` (or extend an existing doc) explaining:
- How to run the E2E tests locally
- The keychain prerequisites
- Known flake conditions
- How to debug a failing E2E test (where logs go, how to inspect the audit log)

### 10. CI integration

These tests must run on macOS in CI. They are slow and require the bundled nono binary from task 01 to be present. Mark them with a feature flag or test category if needed to keep the default `cargo test` fast.

## Interfaces produced

- E2E test suite in `crates/runtimed/tests/sandbox_e2e.rs`
- A docs page on running and debugging the suite

Consumed by CI and developers.

## Success criteria

- All eight tests above pass on macOS locally
- Tests run on macOS in CI
- Each test cleanly tears down its keychain entries
- No test leaves orphan processes or temp files
- Test failures produce clear, actionable diagnostics (preserve nono's audit log on failure)
- `cargo xtask lint --fix` passes

## In scope

- The eight tests above
- Test infrastructure (keychain setup/teardown, test daemon, helpers)
- Docs for running and debugging
- CI configuration for macOS

## Out of scope

- Linux E2E (nice-to-have, not required for MVP)
- Windows (nono not supported)
- Performance/load tests (deferred)
- Multi-notebook concurrency tests (deferred — single-runtime E2E is sufficient for MVP)
- Tests that exercise UI components (those are in tasks 10/11)
- Tests that exercise MCP tools end-to-end through an external client (task 09 covers tool-level tests; full external-client integration is deferred)
- Audit log Merkle integrity verification (deferred)
- Testing against multiple nono versions (we pin one)
