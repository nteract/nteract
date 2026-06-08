# Sandbox Integration: Decisions Locked In

This document captures the design decisions that were settled during the planning conversation. Subsequent task documents reference these as ground truth. If you are implementing a task, treat this file as authoritative; the longer design docs (`ux-credential-sandbox-design.md`, `error-routing-design.md`) describe alternatives that were considered but not chosen.

## Scope of the MVP

The MVP integrates [nono.sh](https://nono.sh) as a network proxy and credential injector for **Python kernels only**. The user story is:

1. A user adds a credential (e.g. `analytics_api`) to the macOS Keychain through the nteract UI or via an MCP tool surface.
2. The user (or an AI agent) attaches a sandbox profile to a notebook that lists which credentials and which destination domains the kernel may use.
3. When the kernel launches, the daemon spawns nono as a parent process which then spawns the kernel as its child. nono terminates HTTPS to the kernel and injects the real credentials when forwarding to the upstream destination.
4. Credential errors and domain-block errors are surfaced back to the user (UI overlay) or agent (MCP execution result) with actionable enrichment.

Anything beyond this — full filesystem sandboxing, real-time accept/reject prompts, agent-driven sandbox expansion, multi-machine deployments — is **out of scope** for the MVP and explicitly deferred.

## Locked decisions

### D-1: nono distribution model

**Decision:** Bundle nono inside the nteract distribution.

The daemon will ship a vendored `nono` binary on the path it controls. We will not depend on the user having `brew install nono` available. The Apache-2.0 license permits redistribution. Bundling means:
- A known-good version is always available
- The daemon can locate the binary deterministically
- We pin the nono version against tested behavior (the CLI surface is pre-1.0 and may change)

Pin to a specific minor version (e.g. `0.62.x`). Track upstream releases manually for now.

### D-2: License

**Decision:** nono is Apache-2.0. Confirmed via crates.io and the `always-further/nono` GitHub repo. Permissive for bundling, redistribution, and Rust crate dependency. No CLA, no commercial restrictions identified.

### D-3: Sandbox is opt-in

**Decision:** Notebooks without a sandbox profile launch kernels with the existing direct-network behavior. No changes to the default codepath.

A profile is opt-in by adding `metadata.runt.sandbox` to the notebook document. Future work may flip this to opt-out, but not in MVP.

### D-4: Process tree ownership

**Decision:** The daemon must independently track both the nono PID and the kernel PID per kernel session.

Empirical testing showed:
- `SIGKILL` on the nono PID does **not** propagate to the kernel grandchild — the kernel reparents to init and survives.
- nono does not create a new process group; it inherits the caller's PGID.
- nono spawns a secondary helper (`/usr/bin/log stream`) for sandboxd denial monitoring.

The kernel lifecycle invariant ("the daemon must always be able to kill the kernel") requires the daemon to:
- Spawn nono and capture its PID
- Discover the kernel PID separately (nono's child) and capture it
- On shutdown, send signals to **both** PIDs in the correct order (kernel first, then nono)
- On unexpected nono exit, also kill the orphaned kernel PID
- On unexpected kernel exit, also terminate nono so the proxy is cleaned up

### D-5: Credential injection mechanism

**Decision:** Use nono's `--env-credential` for user-defined credentials. Do **not** use `--credential`.

Empirical finding: nono's `--credential` flag accepts only a fixed set of pre-integrated services (`anthropic`, `gemini`, `github`, `gitlab`, `google-ai`, `openai`). Custom or user-defined credentials must be passed via `--env-credential`, which:
- Reads a named secret from the keystore at proxy startup
- Injects it as a named environment variable in the child process
- Zeroizes the in-memory copy after exec

The notebook profile will reference credentials by name; the daemon translates each name into the appropriate `--env-credential <name>` flag at launch time.

### D-6: Profile location

**Decision:** Sandbox profile lives at `metadata.runt.sandbox` in the notebook's Automerge document.

The kernel launch path reads this metadata at the moment of launch. Profile changes during a running kernel session do not take effect until the next launch.

The profile contains only credential **names** and routing rules — never secret values. It is safe to include in notebook exports, version control, and shared documents. The `description` field on each credential reference becomes the user-facing error message when the credential is missing.

### D-7: Error enrichment storage

**Decision:** Sandbox error annotations are stored in `RuntimeStateDoc.cell_annotations`, a new top-level map keyed by `execution_id`. Cell output remains the canonical execution record and is never modified by sandbox logic.

The annotation map is daemon-authored, ephemeral runtime state. The frontend overlays the annotation when rendering the cell; the MCP execution-result tool surfaces the annotation alongside outputs in a `sandbox_event` field.

This follows the existing `workstation` precedent: a top-level map written lazily post-genesis, no schema version bump, no migration. Old clients see `{}`.

### D-8: Profile authoring permission model

**Decision (MVP framing):** Treat the sandbox profile as a normal notebook metadata field for MVP. Anyone who can edit the notebook can edit the profile. Refine later if needed.

Future: a per-notebook permission model may distinguish "can author profile" from "can use credentials" from "can launch with profile." Out of scope for MVP, but the data model (profile in notebook, credentials in machine-local keychain) keeps the option open.

### D-9: Agents cannot create credentials

**Decision:** MCP `list_credentials` returns names only, never values. There is no `create_credential` MCP tool. A human must add credentials via the UI or directly via macOS `security add-generic-password`. Agents may reference credentials and observe sandbox errors, but they cannot administer the credential store.

### D-10: No real-time accept/reject prompts in MVP

**Decision:** Agents and users must pre-declare the full credential and domain allowlist. There is no in-flight "should I allow this network call" interaction surface in the MVP.

This is a deliberate governance choice. Adding runtime prompts later is possible (a daemon → frontend channel for prompts; a daemon → MCP channel for agent decisions), but requires designing how trust and consent interact with autonomous agents.

### D-11: CLI wrapper for MVP, Rust crate later

**Decision:** The daemon invokes `nono run --profile <generated-yaml>` as a subprocess (CLI wrapper approach). The `nono` and `nono-proxy` Rust crates exist on crates.io and are usable later for deeper integration (real-time event streams, dynamic credential rotation), but are out of scope for MVP.

A consequence: the daemon's only signal surfaces are nono's stdout, stderr (verbose with `-vv`), exit code, and the audit log NDJSON file. There is no IPC event channel.

### D-12: Audit log discovery

**Decision:** The daemon will scan `~/.nono/audit/` by `(timestamp, PID)` to locate the audit directory for a given nono session. nono does not accept a pre-supplied session ID (`--session-id` flag does not exist), and the audit directory name is never printed.

Mitigation: the daemon records the spawn time and PID at launch and uses them to identify the correct directory after a small delay.

### D-13: Verbose mode is required

**Decision:** The daemon always launches nono with `-vv`.

Without `-vv`, the proxy emits no per-request signal and the audit log only emits `session_started`/`session_ended`. With `-vv`, ALLOW/DENY lines appear on stderr in near-real-time and network events flow into the audit log. This is the only way to enrich errors back to users.

Performance impact at high request volumes is acknowledged as a deferred concern (OQ-16 in the design doc).

## Empirical truths to honor

These came from direct testing of `nono run` on macOS. Implementations must match these exact behaviors:

| Behavior | Truth |
|---|---|
| `nono run --session-id <uuid>` | **Does not exist.** Session IDs are auto-generated. |
| `nono inspect --credential <name>` | **Does not exist.** No credential introspection CLI. Use `security find-generic-password` directly for pre-flight checks. |
| `nono run --profile -` (stdin) | **Not supported.** Profile must be a file path. Daemon writes a temp file per launch. |
| `--env-credential <missing-key>` | **Fatal**, exit 1, stderr: `"Secret not found in keystore"` (verify exact wording during stderr-parser tests). |
| `--credential <known-service>` with key absent | **Non-fatal WARN.** Proxy starts, routes silently denied. |
| `--credential <unknown-service>` | **Fatal**, exit 1, lists valid names. |
| Session ID location | At `-vv`: appears on **stdout** (not stderr) as a DEBUG line. Audit dir name is `<timestamp>-<pid>`, never printed. |
| Process tree | nono does not new a process group. Kernel survives `SIGKILL` on nono. nono spawns a secondary `log stream` helper. |
| Audit NDJSON line schema | `{sequence, prev_chain, leaf_hash, chain_hash, event_json, event}`. Default verbosity emits only `session_started`/`session_ended`; `-vv` emits per-request entries. |

## Reading order for implementers

When picking up a task:

1. Read this file (`decisions.md`) — locked decisions
2. Read your assigned task file (`tasks/NN-*.md`) — what to build
3. Read the linked sections of the design docs from your task file — context
4. Do **not** read other task files. Each task is independent. Cross-task communication happens via the artifacts listed in each task's "Interfaces produced" section.
