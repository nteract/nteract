// useNteractSession — STUB
//
// Will compose the same pieces apps/notebook does in useAutomergeNotebook.ts,
// scoped down to the read-only Slidev use case:
//
//   1. init the wasm artifact (currently lives at
//      ../../notebook/src/wasm/runtimed-wasm; relative import for the
//      prototype, packageable later).
//   2. createBrowserHost() from @nteract/notebook-host/browser to get a
//      NotebookTransport over the per-worktree dev relay.
//   3. Construct NotebookHandleHost + SyncEngine, wire frame events.
//   4. Subscribe to SyncEngine.executionViewChanges$ and the per-output
//      changeset stream; maintain reactive Vue refs:
//        - executions: Map<execution_id, ExecutionViewSnapshot>
//        - outputs:    Map<output_id, OutputManifest>
//        - cellPointers: Map<cell_id, execution_id>
//        - notebookQueue: { executing_cell_id, queued_cell_ids }
//   5. Expose helpers that return reactive refs:
//        useCellOutputs(cellId) → Ref<JupyterOutput[]>
//        useCellExecution(cellId) → Ref<ExecutionViewSnapshot | null>
//
// Open questions worth answering during implementation, not now:
//   - How does the deck pick which notebook to attach to? (Frontmatter? Per-slide
//     prop? Daemon "list notebooks" call + user selects?)
//   - Where does the wasm artifact live for the talk deck? (Relative import vs
//     a dedicated runtimed-wasm npm package vs a workspace re-export from
//     apps/notebook.)
//   - Blob resolution honesty: per-output { pending | resolved } state instead
//     of look-then-blink, per the web-composer plan.

export const STATUS = "stub" as const;
