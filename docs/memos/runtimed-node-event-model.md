# runtimed-node Event Model

**Status:** Findings, 2026-07-31. Measured against a dev daemon built from
`main`. Written for handing `@runtimed/node` to editor integrators, where the
request/response API is the wrong front door.

## Objective

`@runtimed/node` documents `runCell` as its primary API: submit a cell, await a
`CellResult`. That fits running a few cells from a script. It is the wrong shape
for an editor, which wants to stream outputs into a cell as they arrive and
reflect queue state in the UI.

The bindings already expose the event surface an editor needs. It is
undocumented, and two thirds of it does not currently behave as its types
promise.

## The surface that exists

`Session` already carries the frontend-shaped API:

```ts
readonly runtimeState$: Observable<RuntimeState>;
readonly executionTransitions$: Observable<ExecutionTransition>;
readonly executionViewChanges$: Observable<ExecutionViewChangeset>;
readonly sessionStatus$: Observable<SessionStatus>;
getExecutionView(): ExecutionView;
```

These are RxJS observables. `ExecutionView` is manifested state
(`cell_execution_ids`, `executions`, `queue`); `ExecutionViewChangeset` is the
delta. That is the same split the frontend consumes.

## What was measured

A live session against a dev daemon, running a cell that prints and sleeps.

### `executionTransitions$` delivers, wrapped

The data is correct and complete:

```
["{\"execution_id\":\"85e2e83b-...\",\"kind\":\"started\",\"execution_count\":1}"]
["{\"execution_id\":\"85e2e83b-...\",\"kind\":\"done\",\"execution_count\":1}"]
```

Both transitions arrive, in order, with the right execution id and count.

But each emission is a **single-element array containing a JSON string**, not
the `ExecutionTransition` object the type declares. A consumer following
`index.d.ts` writes this:

```ts
session.executionTransitions$.subscribe((t) => {
  if (t.kind === "done") { /* never runs */ }
});
```

`t.kind` is `undefined`, silently, forever. The working form today is:

```ts
session.executionTransitions$.subscribe(([json]) => {
  const t = JSON.parse(json) as ExecutionTransition;
  if (t.kind === "done") { /* ... */ }
});
```

`sessionStatus$` has the same envelope, and additionally reports a `connection`
field absent from `SessionStatus` with PascalCase values (`"Connected"`,
`"Interactive"`, `"Ready"`, `"NotNeeded"`) where the type declares lowercase.

### `executionViewChanges$` fires empty

Changesets arrive throughout an execution, but `execution_upserts` was empty on
every one and `queue` was never populated. The stream signals that something
changed without saying what.

### `getExecutionView()` was empty throughout

Sampled before submitting, mid-execution, immediately after the promise
resolved, and a second later. `executions`, `cell_execution_ids`, and `queue`
were empty at all four points, for an execution that completed successfully.

This may have a precondition not met here, since the session was created with
`createNotebook` and the cell submitted with `runCell`. Worth a second look
before treating it as simply broken.

## Why this matters more than it looks

`runCell` is the documented front door, and it is the one surface that discards
state on the unhappy path. `collect_outputs_with_timeout` races a client-side
timer against the collector and, on expiry, hand-builds a result:

```rust
fn timeout_cell_result(cell_id: String, execution_id: String) -> CellResult {
    CellResult { cell_id, execution_id, execution_count: None,
                 status: "timeout".to_string(), success: false, outputs: vec![] }
}
```

`outputs: vec![]` is hardcoded. Every other path builds its result from an
`ExecutionState` read out of the document; this one fabricates. The default
timer is 120 seconds, so a slow first cell returns `status: "timeout"`,
`success: false`, `outputs: []` while the execution continues daemon-side and
the document may hold real outputs moments later.

A caller cannot distinguish three different situations from that result: the
cell produced nothing, the cell produced output but the client stopped waiting,
or the kernel never started.

So the two halves fail in opposite directions. The promise API is documented and
lies on timeout. The event API is honest and undocumented, and its types do not
match what it emits.

## What an integration wants

For an editor, `executionTransitions$` is the primary API and `runCell` is a
convenience wrapper over it, which inverts how the README currently reads.

```ts
const session = await createNotebook({ workingDir });

// Envelope: emissions are [jsonString], not the declared object.
session.executionTransitions$.subscribe(([json]) => {
  const t = JSON.parse(json);
  switch (t.kind) {
    case "started": markRunning(t.execution_id); break;
    case "done":
    case "error": settle(t.execution_id, t.execution_count); break;
  }
});

const { executionId } = await session.queueCell(source);
```

Outputs still have to be fetched separately: `ExecutionViewSnapshot` carries
`output_ids`, not the outputs themselves, which is the right shape for a UI that
renders incrementally.

## Consequences

- Editor integrators have an event API available today, with a documented
  envelope caveat.
- `runCell` stays correct for scripts and stays wrong on timeout until the
  fabricated result is replaced by a document read.
- The typed surface cannot be trusted as written for the observables.

## Open Questions

1. Whether the `[jsonString]` envelope is intentional at the napi boundary or an
   unwrapped serialization. If intentional, the types should say so; if not, the
   binding should parse before emitting. The types and the runtime disagree
   either way.
2. Why `getExecutionView()` and `execution_upserts` are empty, and whether a
   precondition is unmet rather than the projection being unpopulated.
3. Whether `runCell` on timeout should return the document's current state
   marked timed-out, rather than a fabricated empty result. This is a defect
   with a clear answer and does not depend on the rest.
4. Whether the README should lead with events for the editor audience while
   keeping the promise example for scripts.
