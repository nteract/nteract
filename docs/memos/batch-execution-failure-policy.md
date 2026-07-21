# Batch Execution Failure Policy

**Status:** Draft memo, 2026-07-21. Product and architecture proposal; no new
batch policy or dependency analysis has been accepted yet. Tracked by
[issue #4000](https://github.com/nteract/nteract/issues/4000).

Neighbors:

- [execution-pipeline.md](../adr/execution-pipeline.md) — durable execution,
  output ordering, and control-plane invariants.
- [execution-engines-and-marimo.md](execution-engines-and-marimo.md) — engine
  ownership of scheduling, dependency ordering, and failure propagation.
- [document-split.md](../adr/document-split.md) — NotebookDoc and
  RuntimeStateDoc ownership.
- [notebook-host-shell-convergence.md](../adr/notebook-host-shell-convergence.md)
  — shared desktop and hosted notebook presentation.

## Summary

nteract should add a request-scoped **continue on syntax error** policy for Run
All while preserving today's stop-on-error behavior as the default. The policy
belongs to a coordinator-authorized batch, not to a frontend-only toggle or a
Jupyter `execute_request` flag. The coordinator should stamp the accepted
policy and one batch/plan identity onto every member execution; the runtime
adapter should classify user errors; and the sequential engine should decide
whether to continue or cancel the remaining members.

The first slice should not claim dependency awareness. nteract's sequential
engine has no dependency graph, and adding a Python variable analyzer beside
the kernel would create a second, incomplete execution model. Dependency-aware
blocking belongs to an engine that owns a validated graph. When such an engine
exists, RuntimeStateDoc can distinguish `blocked` descendants from user
cancellation and ordinary batch stopping.

This split still delivers the core educational workflow: an intentionally
malformed Python cell retains its traceback, reaches a terminal error state,
and an opted-in Run All proceeds to later independent cells without restarting
the kernel.

## Current behavior

Run All currently crosses these boundaries:

1. `NotebookClient.runAllCells()` sends `RunAllCells` or
   `RunAllCellsGuarded`. Neither request carries failure semantics
   (`packages/runtimed/src/notebook-client.ts`,
   `crates/notebook-protocol/src/protocol.rs`).
2. The local daemon or hosted room coordinator enumerates code cells and
   creates one RuntimeStateDoc execution per cell with captured source,
   `cell_id`, submitter provenance, and a monotonic `seq`
   (`crates/runtimed/src/requests/run_all_cells.rs`,
   `crates/runtimed-wasm/src/lib.rs`). The response is a list of
   `cell_id -> execution_id` entries, not a durable batch identity.
3. The runtime agent discovers every queued execution by `seq` and feeds the
   `KernelState` FIFO one cell at a time. Only one Jupyter request is
   outstanding, so Jupyter's `stop_on_error` setting is not the scheduler.
4. A classic or rich user error is converted to nbformat output and committed
   through the ordinary output ordering path. The normalized
   `UserErrorOutput` still has the exception name and rich syntax metadata at
   this boundary.
5. After the error output is durable,
   `LifecycleSignal::CellError { execution_id }` reaches the runtime agent.
   The signal has lost the error classification. Its handler clears the whole
   FIFO and marks every queued execution `cancelled`
   (`crates/runtimed/src/runtime_agent.rs`).
6. `ExecutionDone` marks the failed execution `error`; the Jupyter kernel
   remains alive. The shared cell UI already renders the failed cell as an
   error and never-run cells as neutral cancellations.

Consequently, two requested behaviors already exist: the syntax traceback is
captured in the affected cell, and the kernel survives. The missing behavior
is a durable, batch-scoped failure policy that can reach the queue decision.

## Product contract

### Default Run All remains stop on error

The existing Run All button, menu command, MCP tool default, and Python method
keep today's behavior. Existing notebooks and automation must not begin
running later side-effectful cells merely because a new release understands
another policy.

### Continuation is an explicit action

The first UI should expose a secondary action near Run All:

> Run all, continuing past syntax errors

This is request-scoped, not notebook metadata and not initially a persistent
global preference. It makes the exceptional behavior visible at the moment it
can run side effects and avoids changing how collaborators or automated agents
interpret the notebook later.

The shared notebook toolbar owns the action and wording. Desktop and hosted
shells supply the same capability and handler; host-specific chrome should not
fork the notebook execution surface. Elements should carry a deterministic
fixture for product review before the action ships.

### Syntax error means an adapter-classified parse failure

The UI and coordinator should not compare traceback strings. The executor
adapter reports a small semantic error class. For the current Python/Jupyter
profile, `SyntaxError`, `IndentationError`, and `TabError` are syntax-family
errors; the rich traceback's syntax payload is corroborating structured data.
An adapter that cannot classify an error reports `unknown`, which stops the
batch. Other language profiles opt in only when their adapter can provide an
equivalent classification.

With the opt-in policy:

- a syntax-family error remains `status: "error"` with `success: false`;
- its outputs remain the ordinary durable error manifests;
- the batch records that it completed with an error and proceeds to its next
  member;
- a non-syntax or unclassified error stops the remaining batch members;
- interrupts, kernel death, restart, trust rejection, and sync failures keep
  their existing fail-closed behavior.

The batch result should distinguish:

- `completed` — every member succeeded;
- `completed_with_errors` — at least one permitted syntax error occurred and
  the batch reached its end;
- `stopped_on_error` — an error outside the accepted policy stopped remaining
  members;
- `timed_out` — the caller's wait deadline elapsed.

This is a batch result, not a replacement for per-execution terminal state.
Every member remains independently readable and waitable by execution ID.

## Smallest coherent protocol and state shape

The names below are illustrative until implementation, but the semantics are
required.

### Fail closed across version skew

Do not add an optional field to the existing `RunAllCells` request and assume
older daemons will reject it. Serde may ignore an unknown field, allowing an
old daemon to queue the batch with stop-on-error semantics while a new client
claims continuation is active.

Use a distinct opt-in request discriminant, for example:

```text
RunAllCellsWithPolicy {
  failure_policy: ContinueOnSyntaxError,
  cell_execution_ids?
}

RunAllCellsGuardedWithPolicy {
  failure_policy: ContinueOnSyntaxError,
  cell_execution_ids?,
  observed_heads
}
```

The existing request variants remain the stop-on-error compatibility path.
An older daemon rejects the new action before creating execution intent. The
TypeScript client, MCP tool, and Python binding may expose one typed
`failure_policy` option while selecting the safe wire variant internally.

Both local and hosted coordinators must accept the new discriminants. Hosted
owner-only execution authority remains unchanged; an editor cannot acquire
compute authority by choosing a failure policy.

### Coordinator-owned batch identity

Each accepted Run All request should receive one coordinator-issued batch or
plan ID, and every member execution should carry:

```text
plan_id
plan_index
failure_policy
```

The coordinator still reads source from the authorized NotebookDoc projection,
allocates execution IDs and `seq`, records submitter provenance, and stamps
NotebookDoc execution pointers. A client-supplied execution-ID map does not
grant authority over the plan fields.

The execution-engine memo treats Run All as a host-enumerated plan. This slice
does not require the complete future plan-record schema, but it should use
terms and ownership that can graduate to that model instead of inventing a
frontend-only batch registry.

Batch identity is needed even for sequential execution:

- the agent must not infer policy from queue adjacency;
- a later single-cell request can coexist in the global FIFO;
- stopping one batch should not mislabel unrelated queued work as its
  descendants;
- programmatic callers need one stable object for aggregate outcome.

### Structured terminal cause

RuntimeStateDoc should retain enough structured cause to project behavior and
UI without parsing output text. A failed execution conceptually needs:

```text
error_class: syntax | user_code | system | unknown
error_name: optional adapter name
```

A never-run member stopped by an earlier batch error remains `cancelled` in
the first slice, with an optional structured cancellation cause referencing
the failed execution and plan. `success` remains absent, preserving the
existing distinction between "ran and errored" and "never ran."

Reserve `blocked` for an engine-proven dependency relationship. Do not label
every later visual cell a dependency error merely because it appears later.

## Runtime-agent behavior

`UserErrorOutput` is already the semantic normalization point for classic and
rich Jupyter errors. Extend the reliable control signal so `CellError` carries
the adapter's error class and name after the error output commit. This must not
bypass the output committer: the existing output-before-terminal causal order
remains load-bearing.

When the runtime agent receives the signal:

1. Mark the executing member as having errored.
2. Read the accepted policy and plan identity from coordinator-owned execution
   state, not from a mutable UI setting.
3. If the policy permits the reported syntax class, retain the remaining
   members. `ExecutionDone` terminalizes the failed member and
   `KernelState::process_next` starts the next queued member.
4. Otherwise cancel the remaining members of that plan with a cause that
   references the failed execution. Preserve unrelated queued work according
   to the global FIFO's existing admission order.

`CellError`, `ExecutionDone`, and queue release remain control-plane signals.
They cannot move onto the bounded output/work channel, and continuation cannot
publish terminal status before the error manifest is durable.

## Shared UI projection

The first presentation should reuse the existing calm execution language:

- The failed cell keeps the error boundary and adds the concise detail
  `syntax error` when durable classification says so. The traceback remains
  the detailed explanation; a second decorative badge is unnecessary.
- A cell cancelled because the batch stopped keeps the neutral never-ran
  treatment. When structured cause is available, its accessible label can say
  `Not run because cell <label> failed` and offer navigation to that cell.
- A continued batch may finish with syntax errors; toolbar or batch-progress
  feedback should say `completed with errors`, not `failed to run`.
- Desktop and hosted viewers consume the same execution fields and shared cell
  components. Cloud wrappers only provide capability and authority facts.

The UI must not manufacture dependency claims from cell order, exception text,
or a `NameError` after the fact.

## Dependency-aware blocking is a separate engine capability

The issue also asks nteract to skip only cells that depend on failed logic and
name the missing variable and provider cell. The sequential Jupyter profile
cannot do that reliably:

- Python dependencies are dynamic (`globals`, imports, mutation, reflection,
  magics, and runtime control flow);
- the current runtime agent sees accepted execution snapshots, not a validated
  notebook dependency graph;
- visual order does not prove dependency;
- a post-failure `NameError` does not prove which earlier execution caused it.

An engine with a real dependency graph may later project a terminal `blocked`
member with structured reasons such as provider cell/execution IDs and symbol
names. Independent graph branches may continue. That work should use the
planner/plan contract from the execution-engine memo rather than adding a
second Python analyzer to the daemon or frontend.

Until then, the opt-in sequential policy runs every later cell after a syntax
error. Any natural downstream exception is captured as its own execution
error. The product copy must state this plainly.

## Programmatic API behavior

- **TypeScript:** `RunAllCellsOptions.failurePolicy` selects the existing safe
  request for `stop_on_error` or the new discriminant for
  `continue_on_syntax_error`.
- **MCP:** `run_all_cells` accepts the same enum. Wait mode returns aggregate
  status plus per-cell `done`, `error`, and `cancelled` results; a completed
  batch with allowed syntax errors is not reported as transport failure.
- **Python:** `run_all_cells(failure_policy=...)` queues the same coordinator
  intent and returns the accepted batch/member identities. Waiting APIs use
  the same terminal predicate and aggregate vocabulary.
- **Unknown policy:** reject before allocating any execution IDs or stamping
  NotebookDoc pointers.

All execution still references synced cell IDs and captured NotebookDoc source.
No API may accept side-channel source strings for this feature.

## Delivery slices

### 1. Durable sequential policy

- add the fail-closed request variants and generated TypeScript contracts;
- stamp plan identity, index, and policy in local and hosted coordinators;
- carry adapter-classified error details through `CellError`;
- continue only syntax-family errors under the accepted policy;
- cancel only the stopped plan's remaining members;
- make all waiters recognize the aggregate outcomes.

This slice can ship behind programmatic APIs before adding a visible toolbar
action, but local and hosted execution semantics must land together.

### 2. Shared product surface

- add the secondary shared Run All action and capability gating;
- wire both desktop and cloud handlers;
- project syntax classification and cancellation cause through shared stores;
- add an Elements fixture covering successful, continued syntax-error, and
  stopped non-syntax-error batches;
- verify wide and constrained layouts and accessible labels.

### 3. Dependency-engine follow-up

- accept engine-provided dependency edges under coordinator authority;
- add `blocked` as a distinct terminal state with structured causes;
- continue independent branches and block only proven descendants;
- make batch/plan waiting understand blocked members and engine quiescence.

This slice should graduate the relevant execution-engine decisions rather than
quietly expanding the sequential policy.

## Verification matrix

The implementation should cover at least:

| Case | Expected result |
|---|---|
| Existing Run All + syntax error | failed cell errors; later batch members cancel |
| Opt-in + `SyntaxError` | failed cell errors; later members run |
| Opt-in + `IndentationError` / `TabError` | same continuation behavior |
| Opt-in + ordinary runtime error | batch stops; remaining plan members cancel |
| Opt-in + unclassified rich error | fail closed and stop |
| Interrupt or kernel death | existing interruption/death semantics win |
| Unrelated queued execution after stopped batch | not mislabeled as a dependent batch member |
| Hosted owner | same policy and state projection as local daemon |
| Hosted editor/viewer | request rejected by existing execution authority |
| Old daemon + new opt-in client | new request rejected before queue mutation |
| MCP/Python wait | aggregate result and every member reach a coherent terminal state |

Focused implementation tests belong in the protocol contract, local and WASM
Run All coordinators, RuntimeStateDoc transition policy, runtime-agent lifecycle
tests, TypeScript client tests, shared cell/toolbar tests, and hosted viewer
parity tests.

## Non-goals

- Parse or execute malformed code outside the owning runtime adapter.
- Infer Python dependencies in React, the coordinator, or from traceback text.
- Treat every later cell as dependent on the failed cell.
- Change default Run All behavior.
- Persist the opt-in as notebook metadata in the first slice.
- Weaken trust, hosted owner-only execution, required-heads, or output-before-
  terminal guarantees.
- Generalize the first slice into a third-party execution-engine ABI.

## Open questions

1. Should the initial UI be a toolbar menu action, command-palette action, or
   both? A persistent preference should require separate product evidence.
2. Should the public durable identity be named `batch_id` now or adopt
   `plan_id` immediately in anticipation of the execution-engine contract?
3. Which non-Python adapters can reliably classify syntax errors in the first
   release?
4. How should a plan-scoped cancellation cause be represented so old clients
   continue to render the execution as ordinary `cancelled`?
5. Should aggregate batch results live as a small RuntimeStateDoc plan record
   immediately, or be derived from member fields until richer engine plans
   land?

## Graduation

After a local and hosted vertical slice proves fail-closed version handling,
plan-scoped continuation, programmatic waits, and shared UI projection, the
accepted compatibility and authority rules should graduate into the execution
pipeline ADR. Dependency-aware `blocked` semantics should graduate with the
execution-engine plan model, not with the sequential syntax-error slice.
