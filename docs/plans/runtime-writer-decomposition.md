# Runtime writer decomposition

**Status:** Proposed plan, 2026-09-17.

This plan follows the
[runtime writer decomposition proposal](../memos/runtime-writer-decomposition.md).
It builds on the existing runtime-agent process and the shared Rust ingress
policy. The audit below determines whether an internal API refactor is useful
and which call sites it should cover.

## 1. Map current write paths

Trace coordinator, runtime-agent, and hosted room-host writes to
`RuntimeStateDoc`. Record which writes go through peer validation and which call
document methods directly. Include host-owned recovery, kernel shutdown, and
execution failure handling.

Start with:

- `crates/runtime-doc/src/policy.rs`: shared runtime-peer write policy.
- `crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs`: daemon ingress.
- `crates/runtimed-wasm/src/lib.rs`: hosted ingress and direct room-host writes.
- `apps/notebook-cloud/src/room-materializer.ts`: TypeScript calls into the WASM host.
- `crates/runtimed/src/runtime_agent.rs`: runtime-agent execution and progress.

Complete this step with a list of call sites and a concrete example of a mistake
that a narrower internal API would prevent. Documentation status changes alone
are not evidence that a code boundary is missing.

## 2. Compare ingress behavior

Use existing policy tests as the baseline, then identify missing coverage at the
actual local and hosted ingress paths. Cover unauthorized writes to each room
document, actor attribution, and allowed runtime progress for accepted work.

Check that rejected mutations leave the authoritative document unchanged.
Record intentional differences in responses: the local runtime ingress strips
ordinary-client changes, while hosted ingress returns an error. Do not require
identical errors to establish equivalent write permissions.

## 3. Refactor one internal write path

If the audit identifies a useful boundary, route one group of internal writes
through an API that expresses its owner and permitted changes. Preserve the
shared ingress validator and existing process layout.

Tests should cover the internal API, including a permitted operation and the
invalid operation identified in step 1. Existing tests already reject
runtime-peer creation of unknown executions and writes to widget values inside
RuntimeStateDoc; rerunning them alone would not demonstrate the new API's value.

## 4. Apply the API where both hosts need it

Reuse Rust code through the hosted WASM implementation where applicable. Avoid
a second policy implementation in TypeScript. Keep legitimate room-host
recovery operations explicit and verify that they still work.

Complete this step when the affected local and hosted paths pass their
integration tests and any remaining host differences are documented.

## Constraints and follow-up

- Preserve the existing room documents and daemon-scoped `PoolDoc`.
- Keep execution tied to synced `cell_id` values.
- Preserve the recovery and checkpoint contract in
  [room source lifecycle](../adr/room-source-lifecycle-and-file-recovery.md).
- Keep MCP reconnect and cancellation behavior intact when changing shared APIs.
- Propose further process separation only for a demonstrated lifecycle or
  isolation need; kernel execution is already in a runtime-agent subprocess.

[Comments](comments-rollout.md), the [CLI release](unified-cli-release.md),
[shared UI work](notebook-surface-library-refactor-checklist.md), and hosting or
execution-engine proposals have their own plans. This refactor does not add a
new dependency to them.
