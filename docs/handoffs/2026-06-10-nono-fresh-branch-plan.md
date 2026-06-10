# Plan: feature-flagged nono credential injection, fresh from main

Implementation plan for re-doing the `nono-prototype` spike as a clean,
feature-flagged feature starting from `origin/main`. Companion to
`2026-06-10-nono-prototype-review.md` (keep/redo map). The prototype branch
stays unmerged; agents implementing this should read its `docs/sandbox/`
decisions and empirical docs as reference, not cherry-pick its code.

## Flag architecture: one source of truth

Principle: the daemon computes a single **effective sandbox capability** and
advertises it. Frontend and MCP read the advertisement; nothing else makes an
independent platform/availability decision.

### 1. Daemon master switch

- Add `sandbox_nono: bool` (default `false`) to `SyncedSettings`
  (`crates/runtimed-client/src/settings_doc.rs:232`) and to `FeatureFlags`
  (`crates/notebook-protocol/src/protocol.rs:27`), wired through
  `SyncedSettings::feature_flags()` (`settings_doc.rs:352`). This is the
  repo's documented flag recipe — one field per layer, no schema migration —
  and it rides the existing settings sync and `LaunchedEnvConfig` snapshot
  for free. Optional `RUNTIMED_SANDBOX=1` env override OR'd in for dev,
  mirroring `RUNTIMED_DEV` style.
- Effective capability, computed in one place (a `Daemon::sandbox_capability()`
  next to `Daemon::feature_flags()`, `crates/runtimed/src/daemon.rs:1265`):

  ```
  flag_enabled
    && cfg!(any(target_os = "macos", target_os = "linux"))
    && nono binary resolvable (env override → sibling of runtimed → PATH)
  ```

- Daemon behaviors gated on it:
  - Never seed `metadata.runt.sandbox` into new notebooks (restores D-3
    opt-in regardless of flag).
  - `requests/launch_kernel.rs` / auto-launch in
    `notebook_sync_server/metadata.rs`: when capability is off, ignore any
    profile in metadata (log it) and launch direct — a shared sandbox
    notebook degrades gracefully on a non-flagged machine instead of
    refusing to launch.
  - Spawn nono `startup_check()` only when the flag is on.

### 2. Capability advertisement to clients

- Add `sandbox: Option<SandboxCapability>` to `ProtocolCapabilities`
  (`crates/notebook-protocol/src/connection/handshake.rs:137`), following the
  existing `put_blob: Option<PutBlobCapability>` pattern. `None` = unsupported;
  old clients ignore the key, old daemons omit it.

  ```rust
  struct SandboxCapability {
      version: u32,
      nono_version: Option<String>,
      credential_store: bool, // macOS yes; Linux sandbox-yes/keychain-no
  }
  ```

- Plumb via the existing path: `NotebookConnectionInfo.capabilities` →
  Tauri `DaemonReadyPayload` (`crates/notebook/src/lib.rs:407`; see how
  `actor_label`/`connection_scope` flow at lines 608/688/760) →
  `packages/notebook-host/src/types.ts`.

### 3. Frontend gate

- One `useSandboxFeatureEnabled()` hook reading the daemon-ready payload.
  Gate the toolbar badge+sheet block, degraded banner, restart-needed logic,
  and the CodeCell annotation lookup (~4 one-line conditionals; all read
  sites are new).
- Gate the credential manager surface on `credential_store` within the
  capability (hides it on Linux/browser hosts).
- Settings toggle: one entry in `FEATURE_FLAG_METADATA`
  (`src/hooks/useSyncedSettings.ts:123`) — settings UI auto-renders it.

### 4. MCP gate

- Follow the `no_show` precedent (`crates/runt-mcp/src/lib.rs:60`): capture
  the capability at startup where `daemon_version` is captured (`lib.rs:103`),
  filter sandbox tools out of `list_tools` when off, and have `dispatch`
  return "sandbox feature is disabled on this daemon" (not "unknown tool")
  for nicer agent errors. Skip `sandbox_event` injection in execution results
  when off.

### 5. Build/CI gate (independent of runtime flag)

- xtask `ensure_nono_binary`: warn-and-skip by default;
  `NTERACT_REQUIRE_NONO=1` makes it fatal (set in release jobs once
  distribution is wired). Runtime capability (binary absent → off) keeps
  behavior coherent either way.
- Release bundling — `binaries/nono-{triple}` in `tauri.conf.json`
  `externalBin`, download/verify steps in `release-common.yml`, macOS
  codesign/notarize of the third-party binary — lands as its own later PR
  without changing any runtime gate.

Net new flag surface: one `SyncedSettings` boolean + one optional
`ProtocolCapabilities` field. Everything else derives from those two.

## PR staging

Each PR compiles, passes `cargo xtask lint --fix` + tests, and is inert
without the flag.

1. **`feat(runtimed): nono supervisor, profile translator, event parsing`**
   — `crates/runtimed/src/nono/` (supervisor, profile, events, enrichment)
   + `notebook-doc` sandbox profile types, ts-rs derives, unit tests, ported
   `docs/sandbox/` decisions + empirical docs. No call sites; dead code
   allowed behind `#[allow]` or wired only from tests. Re-derive the
   supervisor from the prototype's empirical docs against the **open
   questions** in the review doc (dual-PID kill ordering on all exit paths;
   enrichment off the bounded output transport; annotation GC/persistence).
2. **`feat(runtimed): sandbox flag, capability, and launch integration`**
   — `SyncedSettings`/`FeatureFlags` field, `Daemon::sandbox_capability()`,
   `ProtocolCapabilities.sandbox`, launch-chain integration on the `Kernel`
   dispatch enum (sandbox accessors delegating to `Jupyter`,
   `Disabled`/`None` for `Test`), `cell_annotations` in RuntimeStateDoc,
   `GetSandboxState` request. Must update
   `notebook-protocol/src/typescript.rs` discriminant lists and regenerate
   TS bindings (`cargo run -p notebook-protocol --bin
   generate-runtimed-types`) — main's exhaustiveness tests fail otherwise.
   Add the new request to the `NotebookWrite` scope arm in `peer_writer.rs`
   (main split scopes since the fork).
3. **`feat(notebook): credential store + sandbox UI behind the flag`**
   — keyring-backed credential commands, `HostCredentials`, SandboxPanel /
   CredentialManager / badge / annotation overlay, all behind
   `useSandboxFeatureEnabled()`. Fix the prototype's known UI defects: one
   validator (ts-rs or shared fixtures), dirty-flag before auto-save,
   fine-grained `useCellAnnotation` projection, surfaced keychain errors.
4. **`feat(runt-mcp): sandbox tools behind capability`** — the four tools
   with the `no_show`-style filter; MCP reads the same credential index as
   the UI (no `security dump-keychain`, never `-g`); explicit-`null`
   semantics for profile removal; honest tool schemas.
5. **`build: bundle nono in release artifacts`** — externalBin, release-job
   download/verify, codesigning. Last, independently revertable.

xtask vendoring (warn-and-skip version) can ride PR 1 or 2 — whichever first
needs the binary for an integration test.

## Suggested first step

Port `docs/sandbox/decisions.md` from the prototype into the fresh branch
(amending D-3's implementation note and recording the flag architecture above
as new decisions), so agents implementing PRs 1–5 have the authoritative
context in-tree.
