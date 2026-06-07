# notebook-doc — CRDT mutations

The Automerge CRDT is the source of truth. The cell store (`notebook-cells.ts`) is a read-only projection — a materialized view that components subscribe to. If it ever disagrees with the CRDT, that's a bug.

Scope: `crates/notebook-doc/`, `crates/runtimed-wasm/`, `apps/notebook/src/hooks/useAutomergeNotebook*`, `apps/notebook/src/lib/{materialize,notebook-cells}*`.

## Who writes what

| Data | Writer | Frontend role |
|------|--------|---------------|
| Cell source text | Frontend (CodeMirror bridge) | Author — `splice_source` |
| Cell structure (add/delete/move) | Frontend (`commitMutation`) | Author — `add_cell`, `delete_cell`, `move_cell` |
| Cell metadata (tags, visibility) | Frontend | Author — `set_cell_source_hidden`, `set_cell_tags`, … |
| Notebook metadata (deps, runtime) | Frontend or MCP agent | Author — `add_uv_dependency`, `set_metadata`, … |
| `runtime_state_doc_id` | Daemon/schema migration | Reader; associates notebook cells with runtime/output state |
| `comms_doc_id` | ADR-required follow-up | Not implemented yet; must be deterministic and travel with clone/save/publish once added |
| Execution count | Daemon/runtime via `RuntimeStateDoc` | Read from runtime-state projection; notebook field is legacy export/import fallback |
| Cell outputs | Daemon/runtime via `RuntimeStateDoc` | Materialize from runtime-state sync and blob refs |
| Output clearing (pre-execute) | Daemon/runtime via `RuntimeStateDoc` | Reader of runtime-state mutation |
| Kernel status / queue state | Daemon/runtime via `RuntimeStateDoc` and session control | Read-only UI projection |

## Two paths

**Local mutations (user-initiated).** Write the WASM handle → debounced sync to daemon → materialization updates the store. The store write for instant feedback is safe because the CRDT and store agree; materialization writes the same value when it catches up.

```
user action → WASM handle mutation → scheduleFlush() → daemon
                                    → store update (instant feedback)
```

**Daemon/runtime projections.** Daemon writes `NotebookDoc` for notebook-owned
state and `RuntimeStateDoc` for runtime/output state → sync frame →
`receive_frame` → materialization updates the store. Session-control and
broadcast frames may still carry transient readiness or notification state, but
outputs, execution lifecycle, queue, kernel, trust, and environment state are
durable runtime-state projections.

```
daemon/runtime CRDT write → sync frame → receive_frame → materializeFromBatch → store
                                                        → text attributions → CM bridge
```

When a daemon/runtime event corresponds to durable state, read it from the
synced document projection instead of re-authoring under the frontend actor.
Re-authoring daemon-owned state from the UI generates redundant sync and marks
the notebook dirty.

## Naming convention

| Pattern | Meaning |
|---------|---------|
| `*Local` | User-initiated. Writes CRDT + store, triggers sync. |
| `*FromDaemon` / `apply*FromDaemon` | Daemon-initiated. Store-only projection. No CRDT write, no sync, no dirty flag. |

Example: `applyExecutionCountFromDaemon(cellId, count)` — daemon broadcast, store only.

## CodeMirror bridge (source text)

Source text has its own character-level path that bypasses the store.

```
outbound: CM transaction → ViewPlugin.update() → iterChanges
          → handle.splice_source(cellId, index, deleteCount, text)
          → onSourceChanged → store

inbound:  receive_frame → text attributions → subscribeBroadcast
          → bridge.applyRemoteChanges() → CM dispatch (externalChangeAnnotation)
```

Route all UI-side source edits through `splice_source`. Inbound changes carry `externalChangeAnnotation` so the outbound path skips them and avoids echo. Reserve `update_source` (Myers diff) for daemon code paths — from the UI it would conflict with the bridge's splice tracking.

## Invariants

1. **Write the CRDT first; let the store follow.** The store is a projection. A store-only change gets overwritten on the next materialization. Use `updateCellById` for instant visual feedback *after* a CRDT write, or inside `*FromDaemon` projections.

2. **Exactly one peer creates document structure.** Top-level Maps/Lists like `cells` and `metadata` are created by the daemon in `new_inner()`; other peers receive them via sync. Two `put_object(ROOT, "cells", Map)` from different actors create *two distinct* Map objects at the same key — one wins, the loser's children go invisible. That's why `NotebookDoc::bootstrap()` only seeds `schema_version` (a scalar).

   Sidecar document pointers follow the same rule. `runtime_state_doc_id` is
   current. ADR 0002 requires `comms_doc_id` as a deterministic root pointer;
   until it lands, do not treat room attachment as the final portable identity
   model. When adding any new root identity pointer, update pristine-seeding
   allowlists and constructor guards in the same change.

3. **Reconcile across `.await`.** When daemon code reads the CRDT, awaits something, and writes back, compose the write against the baseline view from before the await — otherwise concurrent edits during the gap are silently overwritten. See the next section.

## Async mutations (daemon side)

Prefer historical transactions: capture heads before the await, reacquire the doc lock after, apply at the baseline view.

```rust
// 1. Capture baseline heads before async work.
let baseline_heads = {
    let mut doc = room.doc.write().await;
    doc.get_heads()
};

// 2. Do async work.
let result = expensive_subprocess().await;

// 3. Reacquire and apply at the baseline view.
let mut doc = room.doc.write().await;
doc.transact_at_heads_recovering(
    &baseline_heads,
    Some("runtimed:formatter"),
    "formatter-transaction",
    |doc| {
        doc.update_source(&cell_id, &result)?;
        Ok(())
    },
)?;
```

The live document owns the actor sequence, so repeated transactions share one stable actor without producing duplicate `(actor, seq)` changes. Panic capture and rebuild stay inside the document boundary.

Use `fork_with_actor(...)` + `merge_recovering(...)` only when the async worker genuinely needs an editable fork across the await. Pick an actor name that cannot collide with another concurrent fork of the same parent.

```rust
let fork = {
    let mut doc = room.doc.write().await;
    doc.fork_with_actor("runtimed:external-worker")
};
let result = expensive_subprocess().await;
let mut fork = fork;
fork.update_source(&cell_id, &result).ok();
let mut doc = room.doc.write().await;
doc.merge_recovering(&mut fork, "external-worker-merge").ok();
```

Reserve `fork_at(heads)` for views and diagnostics — it builds a separate historical document with its own actor stream, so don't use it as the historical write primitive. The pinned Automerge 0.9 desktop patch covers the old MissingOps panic, but actor sequencing, restoration, integration, and panic recovery stay centralized when you go through the document-owned helpers.

### Synchronous blocks

For mutation blocks with no `.await`, call typed methods on the live doc while holding the lock, or use a document-owned transaction helper when you need actor restoration. `fork_and_merge(|fork| { … })` remains for existing isolated-draft call sites; it's not the preferred shape for new daemon mutations.

```rust
doc.fork_and_merge(|fork| {
    fork.update_source("cell-1", "x = 1\n");
    fork.set_cell_resolved_assets("cell-2", &assets);
});
```

### Protected paths today

| Path | Mechanism |
|------|-----------|
| ExecuteCell / RunAllCells formatting | `transact_at_heads_recovering` against captured format heads |
| `format_notebook_cells` (Cmd+S) | `transact_at_heads_recovering` against captured format heads |
| File watcher source updates | Compare against `last_save_sources`, then `transact_at_heads_recovering` on the live doc |
| File watcher order-changed rebuild | Same comparison, rebuild via `transact_at_heads_recovering` |
| `UpdateDisplayData` IOPub | Collect targets, await blob work outside the doc lock, apply via `RuntimeStateHandle::transact_at_current_heads` |
| `process_markdown_assets` | `transact_at_heads_recovering` against captured metadata heads |
| Env metadata capture / hot-sync flush | `transact_at_heads_recovering` under the `runtimed:metadata` actor |
| `handle_sync_environment` | Fresh read — no CRDT write, only in-memory state |

## Direction of travel

- Execution lifecycle states (queued, executing, done) are projected from
  `RuntimeStateDoc`, with session-control/broadcast frames reserved for
  transient coordination and notifications.
- The cell store is moving toward fully derived: every field comes from
  NotebookDoc/RuntimeStateDoc materialization or explicit transient frame
  handling, with no direct store writes outside the local/daemon paths above.
