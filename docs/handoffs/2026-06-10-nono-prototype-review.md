# Review: nono-prototype branch (keep / redo map)

Anil's `nono-prototype` branch (tip `7cadac08`, 24 commits, forked from main at
`b3b10f59`) spikes [nono.sh](https://nono.sh) as a credential-injecting network
proxy wrapped around Python kernel launch. Per Anil, the branch stays unmerged
as **reference material**; the real implementation starts fresh from `main`
(see `2026-06-10-nono-fresh-branch-plan.md`). This doc maps what the prototype
got right (reuse the design) versus what was prototype-grade (redo).

Review coverage: frontend + MCP surface (complete), rebase/merge risk vs main
(complete), feature-flag and packaging strategy (complete). Daemon supervisor
internals and CRDT-layer reviews were cut short; partial findings are flagged
below.

## Keep: designs validated by review

**The locked decisions doc.** `docs/sandbox/decisions.md` on the branch
(D-1..D-11) is solid and should be ported nearly verbatim: vendored pinned
nono binary, opt-in profile at `metadata.runt.sandbox`, `--env-credential`
(not `--credential`, which only supports a fixed service list), dual-PID
tracking (empirical: SIGKILL on nono does NOT propagate to the kernel
grandchild), annotations in `RuntimeStateDoc.cell_annotations` following the
`workstation` lazily-written-post-genesis precedent, names-only MCP listing
with no `create_credential` tool.

**The secret-value path.** Verified clean end to end: dialog state →
`host.credentials.add/updateValue` → Tauri invoke → `keyring::Entry::set_password`
→ Keychain. The index file (`~/.config/nteract/credentials.json`) holds only
name→description. Nothing writes secret values to the Automerge doc, no value
logging, list/update never echo values, the browser host throws on mutation,
and `list_credentials` has a unit test asserting no `value` field.

**The host abstraction.** `HostCredentials` in
`packages/notebook-host/src/types.ts` follows the NotebookHost pattern
correctly (tauri impl real, browser impl stubbed).

**Cell annotation overlay placement.** Renders inside `outputContent` above
`OutputArea` within the same cell; `NotebookView` ordering untouched, so the
stable-DOM-order invariant holds — annotations appear/disappear without
reloading output iframes.

**Vendoring mechanics (shape, not failure mode).** `ensure_nono_binary` in
xtask pins `0.62.0`, verifies hardcoded SHA-256 per target triple
(macOS/Linux, both arches), caches under `target/nono-cache/`, and copies next
to `runtimed`. Runtime discovery is `NONO_BIN` env → sibling of the runtimed
executable → PATH, with a non-fatal daemon `startup_check()`. Keep the shape;
fix the panic-on-network-failure (below).

**Reference docs.** `docs/sandbox/` on the branch contains ~4k lines of
empirical findings (nono process-tree behavior, error-signal formats, network
architecture) and 12 staged task docs. The empirical docs are the most
valuable artifact of the spike — port them.

## Redo: prototype-grade problems

### Blockers (would have stopped a merge)

1. **D-3 violated — sandbox seeded `enabled: true` on every new notebook.**
   `notebook_sync_server/load.rs` (two sites) contradicts the branch's own
   opt-in decision. On any machine without nono, every new notebook fails
   kernel launch (the launch path refuses rather than silently falling back).
   This is the single most important thing the fresh branch must not repeat.

2. **Tests fail on the branch as-is.** 6 frontend test failures (sandbox-panel
   tests click a "Save profile" button that no longer exists after a move to
   auto-save; status-badge tests assert stale rendering/labels) and 1 Rust
   failure (`credentials.rs` validator allows hyphens while its own test
   expects `my-token` rejected). The daemon-review agent also found at least
   one branch test that does not compile (review cut short before details).

3. **Four credential-name validators disagree.** UI regexes accept hyphens;
   `src/sandbox/types.ts` and `notebook-doc/src/sandbox.rs` reject them. A
   user can create keychain credential `my-key`, reference it, and the profile
   validator silently never saves (auto-save returns early). The "must stay in
   sync with the Rust validator" comment is false. Fresh branch: one validator
   in Rust, ts-rs-exported or shared-fixture-tested.

4. **Incompatible with main's kernel dispatch.** Main introduced the `Kernel`
   enum (`kernel_dispatch.rs`) + `TestKernel`; the prototype hangs
   `sandbox_state` / `sandbox_event_stream` off `JupyterKernel` and reads them
   in `runtime_agent.rs`. Neither side's hunk compiles in a merge. Fresh
   branch: sandbox accessors live on the `Kernel` enum from day one
   (`Disabled`/`None` for `Test`).

### Should-fix (carry the lessons forward)

5. **MCP keychain probe leaks the secret into the MCP process.**
   `runt-mcp/tools/sandbox.rs` shells `security find-generic-password ... -g`;
   `-g` prints the password to stderr, captured by `.output()`. Existence
   checks don't need `-g`, and it risks keychain prompts hanging the tool.

6. **MCP/UI list inconsistency + parser bug.** MCP enumerates via
   `security dump-keychain` filtered with `svce.starts_with("nono")` (matches
   unrelated services); the UI reads `credentials.json`. They can disagree.
   The dump parser also mis-attributes accounts when `svce` precedes `acct`
   in a block. Fresh branch: MCP reads the same index the UI uses.

7. **`set_notebook_sandbox_profile` with `{}` silently wipes the profile** —
   missing key treated as explicit `null`. Tool schemas also advertise
   `notebook_id`/`runtime_id` params the handlers ignore.

8. **Hand-written TS mirrors instead of ts-rs, drift already present.**
   `SandboxStateInfo` in `packages/runtimed/src/runtime-state.ts` is missing
   `session_id` (Active) and `stderr_tail` (StartupFailed) vs the Rust type.
   Repo convention is ts-rs generation; use it.

9. **CodeCell subscribes to the whole runtime state** via `useRuntimeState()`
   to read one annotation — every cell re-renders on every RuntimeStateDoc
   sync. Use a fine-grained projection (`useCellAnnotation(executionId)`).

10. **SandboxPanel auto-saves on mount and echoes peer writes** — opening the
    panel stamps `metadata.runt.sandbox` into notebooks that never had it and
    re-writes the metadata snapshot on every inbound peer change. Needs a
    user-actually-edited dirty flag.

11. **xtask vendoring panics on network failure / unsupported triple** —
    breaks network-restricted CI and dev machines. Make it warn-and-skip by
    default, hard-require only in release jobs (`NTERACT_REQUIRE_NONO=1`).

12. **Silent keychain-list failures** render every credential as "missing on
    this machine" and invite the user to re-enter secrets. Surface the error.

13. **No feature gating anywhere.** Badge/panel/banner unconditional in
    `App.tsx`, four MCP tools unconditionally registered, Tauri credential
    commands always live, daemon seeds profiles. The fresh plan gates all of
    it from one daemon-computed capability.

14. **Protocol doc/wire mismatch** — `protocol.rs` comment documents
    `{ "type": ... }` but the serde tag is `state`.

### Main has moved (46 commits since the fork)

Beyond the `Kernel` enum: main added protocol exhaustiveness tests
(`notebook-protocol/src/typescript.rs` hard-codes discriminant lists +
generated-bindings-current check), so any new request/response variant must
update the generator lists and regenerate TS bindings or CI fails. Main also
split `peer_writer.rs` scopes (`NotebookWrite` + `BlobUpload`), reworked the
runtime_agent main loop (deferred launch-on-attach), consolidated runtime
binaries/install flow, and refactored frontend focus state into the shared
store. One prototype commit (`4f410012`) is a byte-identical cherry-pick of
main's #3546 — already landed.

### Platform reality (as written)

Effectively macOS-only end to end. Linux: nono supports Landlock and the
supervisor has `/proc`-based child discovery, but `keyring` is built with only
`apple-native`, so there is no working credential store and MCP silently
reports `keychain_present: false`. Windows: vendoring is a no-op stub, child
discovery returns empty, signals are `#[cfg(unix)]`. Error copy hardcodes
"macOS denied access to the keychain". The fresh branch should advertise a
per-platform capability rather than rendering a uniform UI everywhere.

### Open questions (reviews cut short)

The daemon-internals review (supervisor kill ordering vs D-4, control-plane
vs output-transport invariant for enrichment, events.rs parsing brittleness)
and the CRDT review (concurrent profile-edit convergence, annotation GC,
`rebuild_from_save` carrying `cell_annotations` through doc trims) were
stopped early. The fresh implementation should treat these as design review
items, not assume the prototype's answers are validated:

- Does the dual-PID shutdown order (kernel first, then nono) hold on every
  exit path, including unexpected nono death?
- Does sandbox event enrichment stay off the bounded output transport so it
  can never backpressure `KernelIdle`/`ExecutionDone`?
- Are `cell_annotations` bounded (cleared on restart? GC'd with executions?)
  and preserved across document save/load and trim?
- Do concurrent `metadata.runt.sandbox` edits converge to a valid profile?
