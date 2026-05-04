# CRDT Ownership

## Ownership map

- Frontend-authored CRDT writes: cell source, structure, cell metadata, notebook metadata
- Daemon-authored CRDT writes: outputs and execution-side notebook state written from kernel activity
- Store-only frontend projections: daemon execution count updates, daemon output clears, runtime-state UI updates

## Rules

- Write persistent notebook state to the WASM handle first, then let materialization update the store.
- Use store-only updates only for immediate UI feedback that already matches the CRDT, or for daemon-authored projections.
- Do not write to the CRDT in response to daemon broadcasts. That re-authors the same change and can create dirty-state or sync bugs.
- Treat CodeMirror source editing as a dedicated bridge. Avoid bypassing it with ad hoc source update flows.

## Fork+Merge for Daemon Async Mutations

Any daemon code that reads from the CRDT doc, does async work (subprocess, I/O, network), then writes back **must** reconcile against the pre-await document state. Direct mutation after an async gap can silently overwrite concurrent edits.

- **Preferred async notebook-doc pattern:** capture heads before the `.await`, then use `doc.transact_at_heads_recovering(...)` after reacquiring the live doc.
- **Forked async pattern:** when a worker must carry an editable document through the `.await`, use `fork_with_actor(...)` before the async work, mutate the fork, then `merge_recovering(...)` after.
- **Sync pattern:** `doc.fork_and_merge(|fork| { ... })` — handles fork/merge ordering automatically.
- **Historic save comparison:** compare against `last_save_sources`, then use a transaction or forked merge against the live doc. Do not use `fork_at(...)` for historical writes; keep it for views/diagnostics.

Key methods on `NotebookDoc`: `get_heads()`, `transact_at_heads_recovering(...)`, `fork_with_actor(...)`, `merge_recovering(...)`, `fork_and_merge(f)`.

## Common review questions

- Is this change writing to the store without a matching CRDT write?
- Is this change re-writing daemon-authored state from the frontend?
- Is the change on the local-mutation path, inbound sync path, or both?
- Does the sync rollback or retry logic preserve convergence if delivery fails?
- Does this code read doc state, await something, then write back? If so, is it using a historical transaction or forked merge?
