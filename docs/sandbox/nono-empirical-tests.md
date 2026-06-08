# nono empirical tests — nono 0.62.0

**Date:** 2026-06-08  
**nono version:** 0.62.0  
**Platform:** macOS (Apple Silicon)

---

## OQ-4: Process tree ownership

**Goal:** Confirm whether SIGKILL on the nono PID kills the kernel grandchild, and whether the process group is set up correctly.

### Test 1 — SIGKILL on nono: does `sleep` grandchild survive?

```bash
nono run -- sleep 120 &
NONO_PID=$!
sleep 2
kill -KILL $NONO_PID
sleep 2
ps aux | grep "sleep 120" | grep -v grep
```

**Output:**
```
NONO_PID=46221, PGID=46220
shell PGID=46220
New process group? NO-same-group
=== SIGKILL nono ===
sleep 120 SURVIVED (PID=46223), killing it
```

### Test 2 — Process group check

```bash
nono run -- sleep 100 &
NONO_PID=$!
sleep 2
ps -o pid,ppid,pgid,sess,command -p $NONO_PID
# children:
ps -ef | grep -E "($NONO_PID|sleep 100)"
```

**Output (representative):**
```
  PID  PPID  PGID   SESS COMMAND
46221 46220 46220      0 nono run -- sleep 120

  502 46072   0.0  0.0 435315312  nono run -- sleep 60   (PGID=46071, same as shell)
  502 46074   0.0  0.0 435300368  /bin/sleep 60           (child of nono)
  502 46075   0.0  0.0            /usr/bin/log stream ...  (sandboxd watcher, also child)
```

**ANSWER:**
- **SIGKILL on nono: the `sleep` grandchild SURVIVES.** After SIGKILL on the nono supervisor, the kernel-level child (`/bin/sleep`) was reparented to init (PID 1) and continued running. It had to be killed separately.
- **Process group: nono does NOT create a new process group.** The nono process inherits the shell's PGID. Both nono and its children share `PGID = shell_PGID`. There is no new `setpgid()` call visible.
- **nono spawns 2 direct children:** the sandboxed command itself (`/bin/sleep`) and a `/usr/bin/log stream --style ndjson ...` watcher process for sandboxd denial reporting. Both are direct children of the nono supervisor.
- **Implication for the daemon:** When nono wraps a Jupyter kernel, `kill -KILL <nono_pid>` leaks the kernel process. The daemon must track and kill the kernel PID separately, or use `kill -- -PGID` if it ever introduces a new process group.

---

## OQ-6: Proxy-mode credential-missing stderr

**Goal:** What exact stderr message and exit code when a named credential doesn't exist in keychain?

### Test 1 — `--credential` with an unknown service name

```bash
nono run --credential nonexistent_test_credential_xyz -- echo "hello" 2>&1
echo "Exit code: $?"
```

**Output:**
```
  nono v0.62.0
  Skipping CWD prompt (non-interactive). Use --allow-cwd to include working directory.
  Capabilities:
  ────────────────────────────────────────────────────
       + 36 system/group paths (-v to show)
   net  proxy localhost:0
  ────────────────────────────────────────────────────

  mode supervised (proxy, supervisor)
nono: Configuration parse error: Unknown credential service 'nonexistent_test_credential_xyz'. Available: ["anthropic", "gemini", "github", "gitlab", "google-ai", "openai"]
Exit code: 1
```

**Note:** `--credential` accepts only the fixed list of named services. It is NOT a keychain lookup by arbitrary key name — it's a proxy route name.

### Test 2 — `--env-credential` with a nonexistent keychain entry

```bash
nono run --env-credential nonexistent_test_credential_xyz -- echo "hello" 2>&1
echo "Exit code: $?"
```

**Output:**
```
  nono v0.62.0
  Skipping CWD prompt (non-interactive). Use --allow-cwd to include working directory.
  Capabilities:
  ────────────────────────────────────────────────────
       + 36 system/group paths (-v to show)
   net  proxy localhost:0
  ────────────────────────────────────────────────────

  mode supervised (proxy, supervisor)
  warning: env credential 'nonexistent_test_credential_xyz' exposes the secret directly to the sandboxed process.
             For network API keys, use a profile with credentials for credential isolation.
nono: Secret not found in keystore: nonexistent_test_credential_xyz
Exit code: 1
```

### Test 3 — `--credential anthropic` when key is not in keychain (env var not set)

```bash
nono run --credential anthropic -- echo hi 2>&1
echo "Exit: $?"
```

**Output:**
```
  mode supervised (proxy, supervisor)
WARN  Credential 'env://ANTHROPIC_API_KEY' not found for route 'anthropic' — managed-credential
      requests on this route will be denied until the credential is available. Looked for env var
      'ANTHROPIC_API_KEY' (not set). To add to the macOS keychain:
        security add-generic-password -s "nono" -a "ANTHROPIC_API_KEY" -w
      — and set credential_key to bare 'ANTHROPIC_API_KEY' (no env:// prefix).
  Applying sandbox...

hi
Exit: 0
```

**Note:** A missing `--credential anthropic` key is a **warning, not a fatal error** — nono runs the command anyway. The proxy silently denies requests to that route.

### Test 4 — Profile YAML is rejected (nono profiles are JSON)

```bash
cat > /tmp/test-nono-profile.yaml << 'EOF'
credentials:
  - name: nonexistent_test_credential_xyz
EOF
nono run --profile /tmp/test-nono-profile.yaml -- echo "hello" 2>&1
echo "Exit code: $?"
```

**Output:**
```
nono: Profile parse error: Unexpected word on line 1 column 1
Exit code: 1
```

**ANSWER:**
- `--credential <SERVICE>` accepts only built-in route names: `anthropic`, `gemini`, `github`, `gitlab`, `google-ai`, `openai`. Unknown names → fatal error, exit 1, message: `"Unknown credential service '<NAME>'. Available: [...]"`.
- `--env-credential <KEY>` with a missing keystore entry → fatal error, exit 1, message: `"Secret not found in keystore: <KEY>"`.
- `--credential <known-service>` with a missing API key in keychain → **non-fatal warning** at WARN level. Process runs, proxy denies affected routes silently.
- No `errSecInteractionNotAllowed`-style macOS error was directly surfaced — nono wraps keychain access and emits its own messages.
- Profiles must be JSON (not YAML). nono profile schema has no top-level `credentials` field; credential injection is done via CLI flags or the `env_credentials` / `secrets` fields.

---

## OQ-7 + OQ-8: Audit log schema and session ID

**Goal:** Find the actual NDJSON schema and whether session ID is printed on stdout.

### Audit log directory structure

```
~/.nono/audit/
  <YYYYMMDD-HHMMSS-PID>/      ← one directory per session
    audit-events.ndjson        ← Merkle-chained event log
    session.json               ← session summary
  ledger.ndjson                ← cross-session Merkle ledger
```

### audit-events.ndjson schema (per line)

```bash
cat ~/.nono/audit/20260608-083710-45245/audit-events.ndjson
```

**Output (formatted):**
```json
{
  "sequence": 0,
  "prev_chain": null,
  "leaf_hash": "f03773fb049ca205f592965de35cfd29bfc3ba325bb0e73581e2c487db6bb559",
  "chain_hash": "8de7c05d7391b15259a8d6c3c173038d6efe2c4c6916991b28c859a2e5127b48",
  "event_json": "{\"type\":\"session_started\",\"started\":\"2026-06-08T08:37:10.888371-07:00\",\"command\":[\"curl\",\"-s\",\"https://httpbin.org/get\"]}",
  "event": {
    "type": "session_started",
    "started": "2026-06-08T08:37:10.888371-07:00",
    "command": ["curl", "-s", "https://httpbin.org/get"]
  }
}
{
  "sequence": 1,
  "prev_chain": "8de7c05d7391b15259a8d6c3c173038d6efe2c4c6916991b28c859a2e5127b48",
  "leaf_hash": "116976f0c1dcca66f88b711de4f1561be7d23ae0d86a04425e2411133822fbd2",
  "chain_hash": "c855e857b8f9f8eaefd04fed37e2cdf1274b5f3a6693fd3e7197c3f7edbbd25e",
  "event_json": "{\"type\":\"session_ended\",\"ended\":\"2026-06-08T08:37:11.754569-07:00\",\"exit_code\":0}",
  "event": {
    "type": "session_ended",
    "ended": "2026-06-08T08:37:11.754569-07:00",
    "exit_code": 0
  }
}
```

**Event types observed:** `session_started`, `session_ended`. (No path-denial or network events appeared in the default Seatbelt mode from this test run; those may appear in `-c` capability-manifest mode or if `--audit-integrity` is used.)

### session.json schema (per-session summary)

```bash
cat ~/.nono/audit/20260608-083710-45245/session.json
```

**Output (formatted):**
```json
{
  "session_id": "20260608-083710-45245",
  "started": "2026-06-08T08:37:10.888371-07:00",
  "ended": "2026-06-08T08:37:11.754569-07:00",
  "command": ["curl", "-s", "https://httpbin.org/get"],
  "executable_identity": {
    "resolved_path": "/opt/homebrew/bin/curl",
    "sha256": "..."
  },
  "tracked_paths": [],
  "snapshot_count": 0,
  "exit_code": 0,
  "merkle_roots": [],
  "network_events": [],
  "audit_event_count": 2,
  "audit_integrity": {
    "hash_algorithm": "sha256",
    "event_count": 2,
    "chain_head": "...",
    "merkle_root": "..."
  },
  "audit_attestation": null
}
```

### ledger.ndjson schema (cross-session)

```json
{
  "sequence": 0,
  "prev_chain": null,
  "session_id": "20260605-031953-32404",
  "session_digest": "f37dde4888a8068595099e9aacaf58e83d8213a130a2a1cfda4c822ae83ec1c0",
  "completed_at": "2026-06-05T03:19:53.348143-07:00",
  "chain_hash": "1b46ecb5c2bf2aeaaf6dca0c1e0c336f282c9b35ddf36c8c06cea0ae6dab19df"
}
```

### Session ID format — two IDs coexist

nono uses **two distinct session identifiers**:

| ID | Format | Where |
|----|--------|-------|
| **audit session ID** | `YYYYMMDD-HHMMSS-PID` (e.g. `20260608-083710-45245`) | Audit dir name, `session.json`, ledger |
| **supervisor session ID** | 16-char hex (e.g. `e0286875c5f386b7`) | `~/.nono/sessions/<hex>.json`, `-vv` debug stdout |

### Is session ID printed to stdout?

```bash
nono run -- echo "test" 2>/dev/null | cat       # stdout only → just "test"
nono run -vv -- echo "test" 2>/dev/null | grep session
```

**Output from -vv on stdout:**
```
[DEBUG] Session file created: /Users/anil/.nono/sessions/839cf2dd6f133631.json
```

**ANSWER (OQ-7):** The NDJSON audit schema is a Merkle-chained log. Each line has `{sequence, prev_chain, leaf_hash, chain_hash, event_json, event}`. The `event` field carries a `type` string plus type-specific keys. Observed event types: `session_started` (keys: `started`, `command`) and `session_ended` (keys: `ended`, `exit_code`). A cross-session `ledger.ndjson` chains session digests.

**ANSWER (OQ-8):** Session ID is **not printed to stderr at normal verbosity**. At `-vv` it appears **on stdout** (not stderr) as a `DEBUG` log line: `Session file created: /Users/anil/.nono/sessions/<hex>.json`. The audit-dir session ID (`YYYYMMDD-HHMMSS-PID`) is never printed at any verbosity — it's inferred from the directory name. If the daemon needs to correlate with the audit trail, it must parse this path or use `nono ps --json` / `nono audit list --json`.

---

## OQ-9: `--session-id` flag

**Goal:** Does `nono run --session-id` exist?

```bash
nono run --help 2>&1 | grep -i session
nono run --session-id test-uuid-123 -- echo "hi" 2>&1
echo "Exit: $?"
```

**Output:**
```
# from --help (no --session-id in output):
      --detached     Start the session without attaching the current terminal...
      --name <NAME>  Name for this session (shown in `nono ps`)
      --no-audit     Disable the audit trail for this session
      --rollback     Enable atomic rollback snapshots for the session

# from --session-id attempt:
error: unexpected argument '--session-id' found
  tip: to pass '--session-id' as a value, use '-- --session-id'
Usage: nono run [OPTIONS]
Exit: 2
```

**ANSWER:** `--session-id` **does not exist** in nono 0.62.0. The closest flag is `--name <NAME>` which sets a human-readable label visible in `nono ps`. Session IDs are auto-generated (hex or timestamp-PID). There is no way to inject a caller-supplied ID. If the daemon needs to correlate runs, it must read the ID from the `-vv` stdout `DEBUG` line or from `nono ps --json` immediately after launch.

---

## OQ-10: `errSecInteractionNotAllowed` stderr

**Goal:** What happens when a headless keychain access fails?

```bash
nono --help 2>&1 | head -5
nono run --credential anthropic -- echo hi 2>&1
```

**Output (no ANTHROPIC_API_KEY in env or keychain):**
```
WARN  Credential 'env://ANTHROPIC_API_KEY' not found for route 'anthropic' — managed-credential
      requests on this route will be denied until the credential is available. Looked for env var
      'ANTHROPIC_API_KEY' (not set). To add to the macOS keychain:
        security add-generic-password -s "nono" -a "ANTHROPIC_API_KEY" -w
      — and set credential_key to bare 'ANTHROPIC_API_KEY' (no env:// prefix).
  Applying sandbox...
hi
Exit: 0
```

**ANSWER:** The raw macOS `errSecInteractionNotAllowed` error (OSStatus -25308) is **not surfaced** directly. nono wraps keychain access and emits its own `WARN`-level message on stderr: `"Credential '...' not found for route '...' — managed-credential requests on this route will be denied"`. This is a **non-fatal warning** — the process runs. A headless CI environment running `nono run --credential anthropic` with no key set will silently succeed at launch but fail at credential-injection time with no process-level error. The `errSecInteractionNotAllowed` path (macOS blocking UI prompts in headless sessions) is not directly observable without a separate non-interactive login session.

---

## OQ-11: `nono inspect --credential`

**Goal:** Does `nono inspect --credential` exist? What does `nono inspect` do?

```bash
nono inspect --help 2>&1
nono inspect --credential 2>&1
nono --help 2>&1 | head -40
```

**Output:**
```
# nono inspect --help:
Show detailed information about a session

USAGE
  nono inspect [flags] <session>

Arguments:
  <SESSION>  Session ID (or prefix)

Options:
      --json     Output as JSON
      --events   Include event log
      --changes  Include file changes
  -h, --help     Print help

EXAMPLES:
    nono inspect a3f7c2
    nono inspect --events a3f7c2
    nono inspect --json a3f7c2

# nono inspect --credential:
error: unexpected argument '--credential' found
  tip: to pass '--credential' as a value, use '-- --credential'
```

**ANSWER:** `nono inspect --credential` **does not exist**. `nono inspect <session>` is for runtime session state (similar to `nono ps` but detailed), not credential inspection. The subcommand takes a session ID or prefix and shows process state, file changes, and events. There is no `inspect-credential` or `list-credentials` command in nono 0.62.0. Credential lookup can be done via `security find-generic-password -s "nono"` directly.

---

## OQ-13: `bootstrap_dx` in nteract daemon

**Goal:** Does the daemon use `bootstrap_dx` / `nteract_kernel_launcher`? Where is it controlled?

### Files containing `bootstrap_dx` or `nteract_kernel_launcher`

```bash
grep -r "bootstrap_dx\|nteract_kernel_launcher" crates/ --include="*.rs" -l
```

**Files found:**
```
crates/notebook-protocol/src/typescript.rs
crates/notebook-protocol/src/protocol.rs
crates/runtimed-settings-sync/src/lib.rs
crates/runtimed/src/workstation/launch_on_attach.rs
crates/runtimed/src/jupyter_kernel.rs
crates/runtimed/src/inline_env.rs
crates/runtimed/src/requests/launch_kernel.rs
crates/runtimed/src/daemon.rs
crates/runtimed/src/notebook_sync_server/metadata.rs
crates/runtimed/src/warm_env.rs
crates/runtimed/src/launcher_cache.rs
crates/runtimed/src/uv_project.rs
crates/runtimed-client/src/settings_doc.rs
crates/kernel-env/tests/launcher_e2e.rs
crates/kernel-env/src/conda.rs
crates/kernel-env/src/pixi.rs
crates/kernel-env/src/launcher.rs
crates/kernel-env/src/uv.rs
```

### Control path

```
SettingsDoc::feature_flags()          # crates/runtimed-client/src/settings_doc.rs:354
  → bootstrap_dx: !self.disable_nteract_launcher

daemon.feature_flags().await          # crates/runtimed/src/daemon.rs:1265
  → self.settings.read().await.get_all().feature_flags()
```

`bootstrap_dx` = `true` by default (i.e., `disable_nteract_launcher` = `false`). It is toggled via the settings Automerge doc key `disable_nteract_launcher`.

### What it does

In `jupyter_kernel.rs`, when `bootstrap_dx` is `true`, the kernel is launched via:
```
python -m nteract_kernel_launcher
```
instead of the standard `python -m ipykernel_launcher`. This gives richer display formatters. The launcher module name is selected per env-source branch (uv, conda, pixi, plain) throughout `jupyter_kernel.rs`.

**Legacy handling:** The `bootstrap_dx` field in the on-wire JSON / Automerge doc is **read-only for backward compat** — setting `bootstrap_dx: false` in the settings doc does **not** disable the launcher (test at `settings_doc.rs:1707`). Only `disable_nteract_launcher: true` actually disables it.

**ANSWER:** YES — `bootstrap_dx`/`nteract_kernel_launcher` is deeply integrated into the daemon kernel launch path. It is on by default. It is controlled by the `disable_nteract_launcher` boolean in the settings Automerge doc (not by the notebook's `metadata.runt`). Setting `bootstrap_dx: false` in the legacy key is a no-op.

---

## OQ-14: `metadata.runt.sandbox` read path in daemon

**Goal:** Is there a `sandbox` field in `metadata.runt`? Where is it consumed in the daemon?

### Check `RuntMetadata` struct

```bash
grep -A 40 "^pub struct RuntMetadata" crates/notebook-doc/src/metadata.rs
```

**Output (struct fields):**
```rust
pub struct RuntMetadata {
    pub schema_version: String,
    pub env_id: Option<String>,
    pub uv: Option<UvInlineMetadata>,
    pub conda: Option<CondaInlineMetadata>,
    pub pixi: Option<PixiInlineMetadata>,
    pub deno: Option<DenoMetadata>,
    #[serde(flatten, deserialize_with = "deserialize_runt_extra")]
    pub extra: BTreeMap<String, serde_json::Value>,   // catch-all
}
```

### Check for any sandbox/nono references in metadata structs

```bash
grep -rn "sandbox\|nono" crates/notebook-doc/src/metadata.rs
grep -rn "sandbox\|nono" crates/notebook-protocol/src/protocol.rs | grep -v test
```

**Output:** No results. `sandbox` and `nono` do not appear in `metadata.rs` or `protocol.rs` (outside of test code).

### Check kernel launch for sandbox metadata consumption

```bash
grep -n "sandbox\|nono" crates/runtimed/src/requests/launch_kernel.rs
grep -n "sandbox\|nono" crates/kernel-env/src/launcher.rs
```

**Output:** No results.

**ANSWER:** There is **no `metadata.runt.sandbox` field** in the current codebase. `RuntMetadata` has typed fields for `uv`, `conda`, `pixi`, `deno`, and a catch-all `extra` map. The daemon's `launch_kernel.rs` reads `metadata_snapshot` for inline deps (uv/conda/pixi), env_id, and feature flags — but there is no path that reads sandbox or nono configuration from notebook metadata. If the daemon ever wraps kernels with `nono run`, that integration does not yet exist in the source. Any `metadata.runt.sandbox` key would fall into the `extra` BTreeMap and be preserved across round-trips but never consumed by the daemon.

---

## Summary of findings

| OQ | Answer | Surprise? |
|----|--------|-----------|
| **OQ-4** | SIGKILL on nono **leaks** the kernel child. It is reparented to init and survives. nono does NOT create a new process group — it inherits the caller's PGID. | **YES** — unexpected leak risk for daemon kernel management |
| **OQ-6** | `--credential` fatal (exit 1, lists valid names). `--env-credential` fatal (exit 1, "Secret not found"). `--credential <known>` missing key = **non-fatal WARN**, process continues. Profiles are JSON only. | **YES** — missing known credential is soft-fail, not hard-fail |
| **OQ-7** | NDJSON schema: `{sequence, prev_chain, leaf_hash, chain_hash, event_json, event}`. Only `session_started`/`session_ended` types seen in default mode. `session.json` summary has richer fields including `executable_identity`, `network_events`, `tracked_paths`. | Mostly as expected |
| **OQ-8** | Session ID NOT in stderr banner. At `-vv`, hex ID appears on **stdout** (not stderr) as a DEBUG line. Audit-dir ID (timestamp-PID format) is never printed. | **YES** — ID goes to stdout, not stderr; only at -vv |
| **OQ-9** | `--session-id` flag **does not exist**. Closest is `--name <NAME>` (human label only). IDs are auto-generated. | **YES** — no caller-injectable session ID |
| **OQ-10** | Raw `errSecInteractionNotAllowed` not surfaced. nono emits its own WARN message. Missing key is a non-fatal warning. | As expected |
| **OQ-11** | `nono inspect` is for **runtime sessions only** (takes session ID prefix). No `--credential` option. No credential-inspection subcommand exists. | As expected |
| **OQ-13** | `bootstrap_dx` is **on by default**, controlled by `disable_nteract_launcher` in settings doc (not notebook metadata). Legacy `bootstrap_dx: false` key is ignored. Deeply embedded in all kernel launch paths. | As expected |
| **OQ-14** | **No `metadata.runt.sandbox` field exists.** The `RuntMetadata` struct has no sandbox/nono field. No daemon code reads sandbox config from notebook metadata. Unknown keys fall into a catch-all `extra` map. | Confirms sandbox integration is not yet implemented |

### Key design implications

1. **OQ-4 leak:** When nono wraps a kernel, the daemon cannot rely on killing the nono PID to clean up the kernel. The daemon must track the kernel PID independently and kill it directly after nono exits.

2. **OQ-6 soft-fail:** If the daemon launches `nono run --credential anthropic` and the API key is absent, nono will start the process silently. The daemon needs to check for the WARN line on stderr (or pre-validate key presence via `security find-generic-password`) to surface a proper user-facing error.

3. **OQ-8/9 session correlation:** If the daemon needs to look up the nono audit trail for a running kernel session, it cannot get the session ID from the nono banner. It must either parse the `-vv` stdout DEBUG line, call `nono ps --json` immediately after launch, or derive the audit-dir name as `YYYYMMDD-HHMMSS-<child_pid>`.

4. **OQ-14 no metadata path:** Sandbox configuration (nono profile, credential list) for a kernel must come from daemon-level configuration or the LaunchKernel request payload — not from `metadata.runt` in the notebook document.
