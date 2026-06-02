# RuntimeStateDoc v2 Execution-ID-Only Design

## Objective

RuntimeStateDoc v2 should make execution IDs the only durable identity for
runtime execution state. Notebook cells, markdown blocks, slides, or any future
document-specific structure should point at executions from their own document
models instead of being embedded into the runtime-state schema.

The core RuntimeStateDoc v2 contract has landed for the bundled desktop
deployment. Runtime-state schema, daemon queueing, generated protocol bindings,
WASM/TypeScript projections, and native bindings now treat `execution_id` as the
durable execution identity. The remaining work is to expose that contract
through document-neutral execution APIs and remote-client compatibility
boundaries.

This document records both the landed design and the next architectural steps.

## Original Problem And Current Status

Before RuntimeStateDoc v2, runtime state leaked notebook cell identity into
durable execution records and queue state. Execution records and queue entries
were partly shaped around `cell_id`, even though the durable result handle we
want to support across documents is `execution_id`.

That made RuntimeStateDoc more notebook-specific than it needed to be:

- A markdown file, Slidev deck, or future realtime markdown document would need
  to either pretend its executable blocks are notebook cells or introduce
  another target indirection into runtime state.
- Runtime-agent-owned trimming can delete execution records without seeing
  whether a NotebookDoc cell still points at them.
- Error, interrupt, and lifecycle routing stays coupled to the document block
  that requested execution, even though Jupyter already gives us a natural
  execution correlation key in `execute_request.header.msg_id`.

RuntimeStateDoc v2 removed the durable schema coupling:

- RuntimeStateDoc queue state is now `executing_execution_id` and
  `queued_execution_ids`.
- RuntimeStateDoc executions are keyed by `execution_id` and no longer contain
  `cell_id`.
- NotebookDoc remains the notebook adapter through
  `cells/{cell_id}.execution_id`.
- Jupyter routing uses `execute_request.header.msg_id = execution_id`.

The remaining coupling is intentionally outside the durable runtime-state
schema: notebook protocol responses, cell-oriented helper APIs, watcher progress
payloads, and projection adapter names still expose cells because today they
serve the notebook UI and Python/MCP compatibility surfaces.

## Goals

- Remove cell identity from durable RuntimeStateDoc state.
- Keep executions keyed by `execution_id`.
- Keep NotebookDoc as the notebook adapter by storing the current execution
  pointer on `cells/{cell_id}.execution_id`.
- Allow clients to provide an execution ID early, before the daemon creates the
  Jupyter `execute_request`.
- Reject malformed or duplicate client-provided execution IDs with typed errors.
- Preserve daemon-generated execution ID behavior for callers that do not care
  about early optimistic handles.
- Make trimming run where document pointers and runtime execution records are
  both visible.

## Non-Goals

- Do not introduce a generic `block_id`, `target_id`, or document block registry
  inside RuntimeStateDoc.
- Do not design a complete REST API in this PR.
- Do not migrate to Automerge Repo in this PR.
- Do not require v1 runtime-state compatibility for bundled desktop deployment.
- Do not update `docs/adr/web-sync-engine-architecture.md` as part of
  this proposal.

## Design Principle

RuntimeStateDoc owns runtime facts. Document models own document pointers.

For notebooks, the document pointer is `cells/{cell_id}.execution_id`. A
Notebook UI derives queued state, running state, execution count, success, and
outputs by reading that pointer and looking up the matching execution record in
RuntimeStateDoc.

For markdown, Slidev, or another future document type, the document model can
choose its own pointer field. RuntimeStateDoc should not need to know whether
an execution came from a notebook cell, markdown fence, slide fragment, agent
tool call, or REST request.

This is why v2 should not replace `cell_id` with `block_id`. A generic block ID
would preserve the same coupling under a more abstract name. It would also make
RuntimeStateDoc responsible for a cross-document identity model that belongs in
each document type.

## RuntimeStateDoc v2 Shape

The exact Automerge layout can follow existing naming conventions, but the
durable contract should be equivalent to:

```ts
type RuntimeQueueStateV2 = {
  executing_execution_id: string | null;
  queued_execution_ids: string[];
};

type ExecutionStateV2 = {
  status: "queued" | "running" | "done" | "error";
  execution_count: number | null;
  success: boolean | null;
  source: string | null;
  seq: number | null;
  outputs: Record<string, OutputManifest>;
};

type RuntimeStateDocV2 = {
  schema_version: 2;
  queue: RuntimeQueueStateV2;
  executions: Record<string, ExecutionStateV2>;
};
```

The load-bearing rule is simpler than the illustrative type:

- `ExecutionState` has no `cell_id`.
- Queue state stores only `executing_execution_id` and
  `queued_execution_ids`.
- Executions stay keyed by `execution_id`.
- Execution records keep status, count, success, source, sequence, and outputs.

Output records remain execution-owned. Output ID changesets remain useful
because renderers and projections still need to know which output manifests
changed for a given execution.

## NotebookDoc Adapter Contract

NotebookDoc remains the notebook-specific adapter:

- `cells/{cell_id}.execution_id` is the canonical pointer from a notebook cell
  to its current execution.
- Notebook UI state resolves through:

```text
cell_id -> NotebookDoc.cells[cell_id].execution_id -> RuntimeStateDoc.executions[execution_id]
```

- A cell with no `execution_id` has no current runtime result.
- A cell whose `execution_id` points at a trimmed or missing runtime execution
  should render as having no available live result, while preserving any saved
  notebook-file output behavior that exists outside RuntimeStateDoc.
- Re-executing a cell replaces only that cell's pointer. It does not mutate old
  execution records except through normal trimming.

This keeps old results addressable by execution ID for APIs such as
`get_results(execution_id)` even after a cell points at a newer execution, as
long as trimming has not removed the old record.

## Execution ID Ownership

`ExecuteCell` should accept an optional client-provided execution ID:

```ts
type ExecuteCellRequestV2 = {
  cell_id: string;
  execution_id?: string;
  required_heads?: string[];
};
```

If `execution_id` is absent, the daemon generates a UUID and retries internally
until it finds one not present in RuntimeStateDoc.

If `execution_id` is present, the daemon validates it before accepting the
request:

1. The ID must be a valid UUID string in the protocol's chosen canonical form.
2. The ID must not already exist in RuntimeStateDoc.
3. The ID must not duplicate another execution ID in the same batched request.

Malformed IDs fail with a typed validation error. Duplicate IDs fail with a
typed conflict error. The daemon must not silently replace a caller-provided ID
because clients may already have bound optimistic UI, retries, logs, or
`get_results(execution_id)` handles to that value.

Once accepted, the caller-visible execution ID is stable.

## Execution Flow

The notebook execution path should become:

1. The client records or sends the required NotebookDoc heads for the source it
   wants to execute.
2. The client may generate a crypto-random UUID early, using platform-native
   secure randomness such as `crypto.randomUUID()` in web JavaScript. The
   TypeScript `NotebookClient` exposes this as an optional request parameter;
   existing app callers can continue to let the daemon generate IDs.
3. The client sends `ExecuteCell { cell_id, execution_id?, required_heads? }`.
4. The daemon validates the optional execution ID or generates one.
5. The daemon waits for required heads and snapshots the cell source from
   NotebookDoc.
6. The daemon creates the RuntimeStateDoc execution record keyed by
   `execution_id`.
7. The daemon stamps `NotebookDoc.cells[cell_id].execution_id = execution_id`.
8. The runtime agent dequeues by execution ID.
9. The runtime agent sends Jupyter `execute_request` with
   `header.msg_id = execution_id`.
10. IOPub handling routes output, lifecycle, error, interrupt, and completion
    updates by execution ID.
11. Notebook UIs resolve cell state through the NotebookDoc pointer and render
    outputs from the matching runtime execution.

The important ordering is that RuntimeStateDoc and NotebookDoc both learn the
accepted execution ID before the kernel sees the `execute_request`. That lets
clients subscribe or poll by execution ID without racing the first output.

## Run-All Flow

Run-all should use the same contract. The request may optionally carry a map of
cell IDs to caller-provided execution IDs:

```ts
type RunAllRequestV2 = {
  cell_execution_ids?: Record<string, string>;
  required_heads?: string[];
};
```

The daemon should:

1. Wait for the requested NotebookDoc heads.
2. Resolve the ordered executable cells.
3. Validate every supplied ID for UUID shape and uniqueness.
4. Generate missing IDs.
5. Reject the whole request on malformed or duplicate supplied IDs.
6. Queue accepted executions by execution ID.
7. Stamp each NotebookDoc cell's `execution_id` pointer to the accepted ID.

This keeps run-all atomic from the perspective of caller-visible execution
handles. A client should not have to discover that the daemon accepted some
optimistic IDs and rewrote others.

## Failure And Rollback

Load, guard, or required-head failures that happen before acceptance should not
create caller-visible execution state.

Failures that happen after an execution ID is accepted should be rolled back by
execution ID, not by cell ID. Existing helpers shaped like
`remove_executions_for_cells` should be replaced with direct execution-ID
cleanup for the pending records created by that request.

If RuntimeStateDoc creation succeeds but NotebookDoc pointer stamping fails, the
daemon should remove the created execution IDs before returning an error. If
NotebookDoc pointer stamping succeeds but kernel dispatch fails, the accepted
execution should transition to an error state rather than disappearing, because
the document now points at it.

## Trimming Contract

Runtime-agent-only trimming must stop. The runtime agent cannot know which
NotebookDoc cells, markdown blocks, or future document records still reference
an execution.

Trimming should run in a coordinator layer that can see every relevant document
model and RuntimeStateDoc together. For notebooks, the preservation set is:

- `queue.executing_execution_id`, when present.
- Every ID in `queue.queued_execution_ids`.
- Every execution whose RuntimeStateDoc status is `queued` or `running`, which
  covers the window before the runtime agent has projected the queue map.
- Every `cells/{cell_id}.execution_id` currently referenced by NotebookDoc.
- The daemon-local previous visible execution for a cell while that cell points
  at a queued/running execution that has not produced replacement outputs yet.
- Any implementation-defined recent-history window for user experience.
- Any execution IDs with outstanding direct result waiters, if the daemon keeps
  request-local waiter state.

Everything else is eligible for trimming subject to retention policy.

This makes `get_results(execution_id)` durable enough for direct execution APIs
without allowing RuntimeStateDoc to grow forever. It also keeps document
pointers authoritative: if a document still points at an execution, trimming
must preserve it.

## Schema Bump

The implementation creates a RuntimeStateDoc v2 schema artifact:

- Adds `runtime_state_genesis_v2.am`.
- Updates RuntimeStateDoc schema/version constants to v2.
- Updates generated Rust/WASM/TypeScript protocol bindings.
- Updates Python, MCP, and node projection/binding surfaces so RuntimeStateDoc
  executions no longer carry `cell_id`.
- Keeps the scaffold drift alarm for the frozen genesis artifact.

No v1 compatibility migration is required for bundled desktop deployment. The
daemon and app currently ship together, and this should land before web or Swift
clients rely on long-lived mixed-version compatibility.

For future remote clients, v2 should still be paired with protocol-level schema
version negotiation and typed mismatch errors. Frozen genesis bytes prevent one
class of bootstrap drift, but they do not replace a compatibility handshake.

## Implemented In This PR

1. RuntimeStateDoc schema v2 and frozen `runtime_state_genesis_v2.am`.
2. Notebook protocol request, response, and error types for optional execution
   IDs and duplicate-ID conflict errors.
3. Daemon queueing validation for malformed IDs, existing IDs, and duplicate
   IDs within run-all.
4. Execution records created and rolled back by execution ID rather than cell
   ID.
5. Runtime-agent, kernel-state, Jupyter message, stream, display-update, and
   output-prep routing by execution ID.
6. WASM and TypeScript projection cleanup: no `ExecutionState.cell_id`, no
   changed-cell output diffs, output-ID changesets retained.
7. Python, MCP, and node bindings updated for execution-ID-only runtime-state
   projection.
8. RuntimeStateDoc trimming moved to notebook-aware request coordination, with
   queued/running and cell-referenced execution IDs preserved.

## Implemented Follow-Up: Shared Execution View

Subsequent follow-up PRs moved the NotebookDoc + RuntimeStateDoc materialized
execution view into shared Rust projection code. That projection keeps
RuntimeStateDoc execution-ID-only while giving consumers a single derived view
over document pointers, runtime executions, and queue state.

The shared view now exposes:

- `cell_pointer_changes`: document adapter pointer deltas such as
  `cell_id -> execution_id | null` for NotebookDoc.
- `execution_upserts`: snapshots keyed by `execution_id`, including execution
  count, status, success, and ordered output IDs.
- `removed_execution_ids`: runtime executions trimmed from RuntimeStateDoc.
- `queue`: an execution-ID-first queue projection, plus an optional
  NotebookDoc adapter join for `executing_cell_id` and `queued_cell_ids`.

The browser WASM path emits this shape on sync frame events. Native consumers
share the same Rust projector instead of reimplementing the join:

- `@runtimed/node` exposes `Session.executionViewChanges$` for deltas and
  `Session.getExecutionView()` for the current materialized snapshot.
- `runtimed-py` exposes a snapshot-style execution view from the same shared
  projector.
- Pi consumes the Node changeset surface for execution prompt tracking without
  reading notebook cells itself.

## Remaining Follow-Up

- Add an execution-ID-only watcher path so bindings can wait on
  `execution_id` without also supplying a notebook `cell_id`. Keep the
  cell-aware watcher as a notebook compatibility wrapper.
- Broaden direct execution APIs so non-notebook clients can submit source by
  execution ID without requiring a cell pointer. This should create a
  RuntimeStateDoc execution record but not stamp a NotebookDoc cell pointer.
- Decide whether Python and node high-level APIs should expose caller-supplied
  execution IDs, matching the TypeScript client.
- Generalize projection terminology before another document type lands.
  `cell_pointer_changes` can become a generic document-item pointer changeset,
  with notebook-specific aliases kept as compatibility if needed.
- Add remote-client schema negotiation and typed mismatch errors before Swift
  or web clients are allowed to drift independently from the daemon.
- Extend trimming preservation discovery beyond the notebook room adapter
  before Slidev or markdown documents can hold execution references outside
  NotebookDoc cell pointers.
- Keep iframe output embedding separate from execution. Slidev or published
  markdown surfaces should call an execution API to produce results, then render
  outputs through the embeddable output surface with a host-owned blob resolver.

## Test Plan

Runtime-doc tests should prove:

- v2 frozen genesis loads and matches the scaffold drift alarm.
- Saved RuntimeStateDoc v2 state contains no execution `cell_id`.
- Queue state contains `executing_execution_id` and `queued_execution_ids`.

Protocol and request tests should cover:

- Daemon-generated execution IDs when the request omits one.
- Accepted client-provided UUIDs.
- Malformed client-provided IDs.
- Duplicate client-provided IDs already present in RuntimeStateDoc.
- Duplicate client-provided IDs inside one run-all request.

Runtime-agent tests should cover:

- Successful execute by execution ID.
- Error output and terminal failure state by execution ID.
- Interrupt routing by execution ID.
- Kernel death state by execution ID.
- Run-all queueing and completion without cell IDs in runtime state.

Frontend tests should cover:

- Queued and running UI derived from
  `cell.execution_id -> runtime execution`.
- Output rendering from the same pointer path.
- Re-execution replacing the cell pointer without requiring changed-cell output
  diffs from RuntimeStateDoc.

Integration tests should cover:

- Save and load with execution pointers intact.
- Run-all with mixed supplied and daemon-generated execution IDs.
- Rollback after failed required-head or load validation.
- Trimming preserving queued, running, and cell-referenced execution IDs.
- Durable `get_results(execution_id)` after the requesting document no longer
  needs to be inspected.

## Future Work

This design makes a REST-friendly execution API easier because the stable handle
is already an execution ID:

```http
POST /sessions/{session_id}/executions
GET /sessions/{session_id}/executions/{execution_id}
```

That API still needs daemon-level token creation, authentication, authorization,
and a decision about whether direct REST execution creates document pointers or
runtime-only records. The default should be runtime-only records; document
adapters such as NotebookDoc, MarkdownDoc, or Slidev can opt in to storing their
own current-execution pointer.

Markdown notebooks and Slidev integration can then use the same execution
service while keeping their own document-native pointers to current executions.
Slidev already has a code-runner extension point, so the integration should be
a runner that submits source to nteract and renders returned outputs, not a
conversion layer that pretends slide code fences are notebook cells.
