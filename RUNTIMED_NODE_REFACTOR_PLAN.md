# @runtimed/node refactor: napi emits projected events

## Context

The `@runtimed/node` napi binding is a synchronous request/response wrapper around the daemon's socket (`Session.runCell` waits for a full cell to finish, returns one `CellResult`). That shape blocks two things we want for the Pi extension:

1. **Streaming REPL output.** When a cell is running `for i in range(1000): print(i)`, we want the agent's tool-result to update as stdout streams, not wait until it's done. The frontend already does this reactively by subscribing to RuntimeStateDoc diffs - Pi can't, because the napi doesn't expose them.

2. **Shared implementation with the browser.** The browser's `packages/runtimed/` has `SyncEngine` with RxJS observables (`cellChanges$`, `executionTransitions$`, `runtimeState$`). All of that logic was rewritten imperatively in Rust inside `crates/runtimed-node/`. Two implementations of the same Session concept drift.

**The target architecture:** napi emits already-projected events across the FFI boundary (not raw frames). Rust owns the socket, the CRDT (via `runtimed-wasm` types compiled natively), and the diff-to-event projection that `packages/runtimed/src/sync-engine.ts` does in TS today. napi surfaces **typed event streams** (runtime state, execution transitions, cell changes, broadcasts). TS wraps those streams in RxJS `Subject`s and rebuilds the same observable API.

Benefits:
- Zero Automerge frame marshalling across FFI. Frames stay in Rust.
- Native speed for CRDT ops and projection. Big notebooks and high-frequency stdout don't pay a WASM tax.
- **One Session API in TS, backed by two emitters (napi in Node, WASM+TauriTransport in browser).** Consumer code is portable.
- Pi's `python_repl` can subscribe to `executionTransitions$` + `runtimeState$` and stream updates through Pi's `onUpdate` callback.

Parquet stays native in `crates/runtimed-node/src/parquet.rs` (already reuses `nteract-predicate::summarize_parquet`). Sift/sift-wasm can't replace this path - they load full parquet files into memory; Pi needs lazy row-range reads.

## Approach

### Phase 1: Expose projected event streams from napi

**New napi surface** in `crates/runtimed-node/src/`:

- `EventEmitter`-shaped object returned from `createNotebook` / `openNotebook`:
  - `onRuntimeState(cb: (state: RuntimeState) => void)` - fires on every RuntimeStateDoc change
  - `onExecutionTransition(cb: (t: ExecutionTransition) => void)` - fires `started`/`done`/`error` per execution (diffed from consecutive RuntimeState snapshots)
  - `onCellChange(cb: (changeset: CellChangeset) => void)` - fires on NotebookDoc cell diffs
  - `onBroadcast(cb: (payload: unknown) => void)` - comm traffic only (kernel status, etc. are in RuntimeState)
  - `onSessionStatus(cb: (s: SessionStatus) => void)` - handshake lifecycle
  - Each returns a disposer.

**Implementation notes:**
- Use `napi::threadsafe_function::ThreadsafeFunction` to push events from a tokio task to JS. This is the standard napi-rs pattern for async event emission.
- The tokio task owns the socket, runs the sync protocol, applies Automerge frames to an in-process `NotebookDoc` + `RuntimeStateDoc`, and computes diffs. It re-uses the same diff logic that `packages/runtimed/src/runtime-state.ts::diffExecutions` runs in TS today - but ported to Rust, or more likely just exposed from `runtime-doc` since the daemon also needs it.
- Rust-side coalescing: 32ms window matching the TS SyncEngine, so event volume stays sane.

**New Rust projection module:** `crates/runtimed-node/src/projection.rs` (or pulled up to `runtimed-client` if the daemon wants it too). This is the heart of the refactor. It mirrors:
- `packages/runtimed/src/sync-engine.ts` (frame demux + dispatch)
- `packages/runtimed/src/runtime-state.ts::diffExecutions`
- `packages/runtimed/src/cell-changeset.ts`

### Phase 2: Wrap napi in TS observables, reimplement Session in TS

**New TS code** in `packages/runtimed-node/src/`:

```
src/
  index.ts               public API: createNotebook, openNotebook, listActiveNotebooks, etc.
  session.ts             Session class mirroring current napi Session shape
  napi-observables.ts    wraps EventEmitter into RxJS Subjects
  napi-transport.ts      NotebookTransport impl (request/response only - frames are internal)
  output-resolver.ts     port of `runtimed_client::output_resolver::shared_resolver` to TS
```

The napi crate still does socket I/O natively, but also exposes a `sendRequest(envelope): Promise<response>` method so TS can issue `ExecuteCell`, `LaunchKernel`, etc. requests without re-opening the socket. That's the thin RPC face on top of the event emitter.

**Session class** re-implemented in TS:

```ts
class Session {
  readonly notebookId: string;
  readonly runtimeState$: Observable<RuntimeState>;
  readonly executionTransitions$: Observable<ExecutionTransition>;

  watchExecution(executionId: string): Observable<ExecutionProgress> {
    return this.runtimeState$.pipe(
      map(rs => rs.executions[executionId]),
      filter(Boolean),
      distinctUntilChanged(sameProgressSnapshot),
      map(e => ({ executionId, cellId: e.cell_id, status: e.status,
                  executionCount: e.execution_count,
                  outputs: resolveOutputs(e.outputs, this.blobBaseUrl) })),
    );
  }

  async waitForExecution(executionId, { timeoutMs = 120_000, onUpdate } = {}) {
    let last: ExecutionProgress | null = null;
    return firstValueFrom(
      this.watchExecution(executionId).pipe(
        tap(p => { last = p; onUpdate?.(p); }),
        filter(p => p.status === "done" || p.status === "error"),
        take(1),
        takeUntil(timer(timeoutMs).pipe(map(() => ({ ...last, status: "timeout" } as const)))),
      ),
    );
  }

  async runCell(source, opts) {
    const { executionId } = await this.queueCell(source, opts);
    return this.waitForExecution(executionId, opts);
  }
}
```

`queueCell`, `createCell`, `setCell`, `interruptKernel`, etc. become `transport.sendRequest({ type: "..." })` calls. The Session class has no direct napi coupling beyond the emitter subscriptions + request method - matching what `TauriTransport` + `SyncEngine` do in the browser.

**API compatibility:** Pi's `repl.ts` uses `createNotebook`, `queueCell`, `waitForExecution`, `runCell`, `addDependencies`, `syncEnvironment`, `getRuntimeStatus`, `saveNotebook`, `shutdownNotebook`, `close`. All are preserved. The `onUpdate` parameter in `waitForExecution` is new but optional.

### Phase 3: Enable streaming in Pi

Minimal diff in `plugins/nteract/pi/extensions/repl.ts`:

```ts
// in execute():
const queued = await sess.queueCell(params.code);
executionId = queued.executionId;
result = await sess.waitForExecution(executionId, {
  timeoutMs: Math.round(timeoutSecs * 1000),
  onUpdate: (progress) => {
    const { content, isError } = formatResult(progressToCellResult(progress), executionId);
    onUpdate?.({
      content,
      details: { notebook_id: sess.notebookId, execution_id: executionId,
                 status: progress.status, streaming: true },
    });
  },
});
```

The `onUpdate` Pi parameter (already in the tool `execute` signature) gets wired to the SyncEngine's stream. Stdout appears in the agent's tool-result as it prints; images arrive the instant `display_data` is emitted.

### Phase 4: Share the diff/projection logic across bindings

Projection logic already lives in several places today - the overlap worth consolidating is with the **Python bindings** (`crates/runtimed-py/` + `python/runtimed/`), which have the same problem space: native FFI binding that needs to surface reactive-ish events to script code. If we get the projection shape right for napi, it should drop into pyo3 with minimal work.

After Phase 3 ships:
- Extract projection into a shared crate (working name `runtime-projection`) used by napi, pyo3, and the daemon. Existing diff code in `runtime-doc` and the ad-hoc projection in `runtimed-client` are the starting points.
- Python bindings get the same event surface: async iterators or callback-based emitter (matching pyo3 idioms) sitting on top of the same Rust projection module.
- Leave the TS SyncEngine for the browser - it runs against WASM and is load-bearing. Both Node and Python eventually use the same Rust projection; browser keeps its TS port of the same semantics because WASM can't own the socket. Parity is enforced by shared types + a parity test harness rather than by sharing code with the browser.

## Critical files

**To modify:**
- `crates/runtimed-node/src/lib.rs` - napi surface
- `crates/runtimed-node/src/session.rs` - thin down to request/response + emitter wiring
- `crates/runtimed-node/src/projection.rs` (new) - diff logic
- `packages/runtimed-node/src/index.ts` (new) - TS public API
- `packages/runtimed-node/src/session.ts` (new) - TS Session class
- `packages/runtimed-node/src/napi-observables.ts` (new) - emitter → RxJS
- `packages/runtimed-node/src/output-resolver.ts` (new) - port of `runtimed_client::output_resolver`
- `plugins/nteract/pi/extensions/repl.ts` - add `onUpdate` streaming

**To reuse:**
- `packages/runtimed/src/runtime-state.ts` - `RuntimeState`, `ExecutionState`, `ExecutionTransition` types (already shared via re-export)
- `packages/runtimed/src/cell-changeset.ts` - `CellChangeset` type
- `crates/runtime-doc/` - `RuntimeStateDoc` and diff primitives
- `crates/runtimed-client/` - `PoolClient`, protocol types
- `crates/notebook-sync/` - `DocHandle` (internal), sync protocol
- `crates/nteract-predicate/` - parquet summaries (unchanged)

## Verification

1. **Unit tests for projection.** `cargo test -p runtimed-node` covers frame application → RuntimeStateDoc snapshots → expected `ExecutionTransition` sequence. Mirror the TypeScript tests in `packages/runtimed/tests/sync-engine.test.ts`.

2. **Parity test suite.** `packages/runtimed-node/tests/parity.test.ts` runs both the new TS Session and (temporarily) the old napi path against a real dev daemon via `nteract-dev`. Assert identical outputs for `createNotebook`, `runCell` with stdout, `runCell` with image, dependency sync, interrupt, restart. Use the `daemon-dev` and `testing` skills.

3. **Streaming integration test.** Run `for i in range(20): print(i); time.sleep(0.1)` via `python_repl`. Assert that `onUpdate` fires ≥ 3 times with monotonically growing stdout before `status === "done"`.

4. **Pi manual smoke.** `pi --extension ./plugins/nteract/pi/extensions/repl.ts` + run a multi-step workflow: import pandas, load parquet, plot. Verify the image arrives inline and stdout streams during long cells. See the `frontend-dev` skill for running against the dev daemon.

5. **Regression: browser build.** `cargo xtask build` + `cargo xtask notebook` (by a human, not the agent) - verify `SyncEngine` in the browser still works unchanged. This refactor should not touch `packages/runtimed/src/sync-engine.ts` or the WASM build.

## Decisions

- **Tokio runtime:** use `napi::tokio` (shared runtime). Avoids a private runtime in `runtimed-node`.
- **Coalescing window:** start at 16ms (shorter than the browser's 32ms). The daemon already coalesces stdout on its side, so we don't need a large additional smoothing window client-side; revisit if it shows up in perf.
- **Projection crate:** Phase 4 consolidates with the Python bindings first, since that's where the bigger code-duplication win is. Browser SyncEngine stays TS.

## Open questions

- **Does the Rust projection re-use existing `runtime-doc` diff primitives, or does it port the TS `diffExecutions` shape?** Lean toward re-using `runtime-doc` primitives since the daemon already computes similar diffs; resolve during implementation.
- **Handshake error paths.** Today the Rust side does `await_session_ready()` with specific error messages. The TS Session class needs equivalent typed errors across the FFI boundary; confirm napi error surfaces during Phase 1.
