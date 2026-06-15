# The Document Split

**Status:** Draft, 2026-05-22.

**Update, 2026-06-07:** ADR 0002 intentionally supersedes the original
three-document model by extracting mutable widget comm state into `CommsDoc`.
This document remains the historical baseline for the original split and its
document-boundary reasoning. Do not use the document count as the concept:
current notebook rooms sync `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc`;
`PoolDoc` is daemon-scoped and sync-adjacent; the proposed `CommentsDoc` is
another per-notebook sidecar tracked separately in
`notebook-comments-document.md`.

## Context

nteract syncs state through Automerge CRDTs. Separate documents carry that
state today, not one. They split into two scopes:

- **Notebook-room documents** are attached to one notebook collaboration room.
  Today that set is `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc`. Proposed
  comment work adds `CommentsDoc` to this room set.
- **Daemon-scoped documents** are fanned out to room peers because they affect
  the room UI, but they do not belong to the room identity. `PoolDoc` is the
  current example.

The current documents are:

- **`NotebookDoc`** (`crates/notebook-doc/src/lib.rs`) - one per notebook room. Carries cells, source text, notebook metadata, attachments. Schema version 5. Wire frame `0x00` (AutomergeSync).
- **`RuntimeStateDoc`** (`crates/runtime-doc/src/doc.rs`) - one per runtime state surface; today each notebook room creates one. Carries kernel lifecycle, execution queue, executions and their outputs, env-sync state, trust state, project-file context, and widget comm topology/routing. Mutable widget comm state moved to `CommsDoc`. Schema version 2. Wire frame `0x05` (RuntimeStateSync).
- **`CommsDoc`** (`crates/runtime-doc/src/comms.rs`) - one per notebook room. Carries mutable widget comm state keyed by comm id; `RuntimeStateDoc` remains the topology and membership source of truth. Schema version 1. Wire frame `0x09` (CommsDocSync).
- **`PoolDoc`** (`crates/notebook-doc/src/pool_state.rs`) - one per daemon (not per room). Carries UV / Conda / Pixi prewarm pool counters, errors, retry timers. No schema version. Wire frame `0x06` (PoolStateSync).

A connecting peer subscribes through one of the typed-frame handshake channels.
`NotebookSync` (and the related `OpenNotebook` / `CreateNotebook` paths) brings
up the room documents on one socket: `NotebookDoc`, `RuntimeStateDoc`, and
`CommsDoc` per the joined room, plus `PoolDoc` fanned out to that peer because
the peer loop subscribes to `pool_doc_changed` regardless of room. The `Pool`
handshake is a JSON-IPC channel for pool status, env claims, and daemon admin;
it does not carry typed-frame Automerge sync at all. Frame caps differ per type
(see `crates/notebook-wire/src/lib.rs`).

The split is load-bearing for permission boundaries, document authority,
durability/lifetime, attachment identity, and fan-out scope. It is not written
down in one place. This ADR records the decision so the boundaries become
visible to anyone changing them.

This ADR is desktop-first, but the hosted publish/cloud viewer now consumes the
same notebook/runtime/comms snapshot bundle. A closing section sketches what
changes when the split runs in a multi-user deployment.

Neighbors:

- `docs/adr/typed-frame-v4-wire-protocol.md` — the byte protocol that carries each doc's sync stream.
- `docs/adr/runtime-state-document-identity.md` — the follow-on
  identity decision that makes `NotebookDoc` point at its associated
  `RuntimeStateDoc`.
- `docs/adr/execution-pipeline.md` — how `RuntimeStateDoc` is written during cell execution.
- `docs/adr/blob-storage-and-content-addressing.md` — how output payloads are stored separately from the doc itself.
- `docs/adr/identity-and-trust.md` — the trust scopes the document split makes expressible.

## Decision 1: Separate documents, separate sync streams, separate frame types

Each document syncs on its own Automerge channel, with its own peer-state object
and its own frame type. The peer loop in
`crates/runtimed/src/notebook_sync_server/peer_loop.rs` holds independent
`sync::State` values:

```rust
let InitialSyncState { mut peer_state } =      // NotebookDoc
    send_initial_notebook_doc_sync(&mut writer, room).await?;
let mut state_peer_state = sync::State::new(); // RuntimeStateDoc
let mut comms_peer_state = sync::State::new(); // CommsDoc
let mut pool_peer_state = sync::State::new();  // PoolDoc
```

Each ingress path is a separate handler (`handle_notebook_doc_frame`,
`handle_runtime_state_frame`, `handle_comms_doc_frame`,
`handle_pool_state_frame`) with its own validator. Each broadcast subscription
is a separate stream (`changed_tx`, `state_changed_tx`, `comms_changed_tx`,
`pool_doc_changed`). Egress now follows the first stage of the peer-lane split:
reliable frames (`Response`, `SessionControl`, document sync, blob replies) are
separated from ephemeral presence/broadcast traffic inside `PeerWriter`.
Reliable document sync streams still share one reliable egress lane, so
`peer-egress-lanes.md` remains the follow-on design for any finer-grained
control/resync lanes.

The reasons for keeping them separate, not just logically but physically on the wire:

1. **Different write authority.** `NotebookDoc` is multi-writer (any
   editor-scope peer authors cells). `RuntimeStateDoc` is coordinator-authored
   for execution intent and room facts, and runtime-peer authored for
   policy-allowed lifecycle, execution progress, output, and comm topology.
   `CommsDoc` carries editor/owner/runtime-peer widget state, but
   RuntimeStateDoc topology gates which comm state can reach the kernel.
   `PoolDoc` is daemon-only, with all client changes stripped at ingress
   (`pool_state.rs:341`, `message.changes = Vec::<Vec<u8>>::new().into()`).
2. **Different trust scopes.** The identity ADR
   (`docs/adr/identity-and-trust.md` Decision 5) carves four scopes precisely
   along these lines. `viewer` reads the room docs. `editor` writes allowed
   `NotebookDoc` fields and mutable widget state in `CommsDoc`. `runtime_peer`
   writes runtime progress/output state for accepted executions and cannot
   write `NotebookDoc` or create execution intent. `owner` writes allowed
   notebook fields and manages the ACL; it does not imply runtime authorship.
   `PoolDoc` is daemon-write-only across every scope.
3. **Different lifetimes and durability.** `NotebookDoc` persists to disk
   (`.automerge` for ephemeral rooms; `.ipynb` for file-backed).
   `RuntimeStateDoc` and desktop `CommsDoc` are live room state, not standalone
   persisted notebook content. `CommentsDoc`, when added, is durable
   collaboration state with its own attachment and persistence policy. `PoolDoc`
   lives for the daemon's lifetime. See Decision 4.
4. **Different fan-out and attachment scopes.** `PoolDoc` sync frames fan out
   to notebook-room typed peers so each open notebook can observe daemon pool
   state. `Handshake::Pool` clients, such as system-tray UI or env-management
   tools, use the separate JSON-IPC pool/admin channel instead of Automerge
   `PoolStateSync`. `NotebookDoc` and `RuntimeStateDoc` fan out only to peers
   attached to that room.
5. **Different operational traffic shapes.** The documents do have different
   write cadences, but that is not the primary architectural reason for the
   split. Rendering efficiency is handled by changesets, narrow store
   projections, and independent streams; document boundaries should not be
   justified as a workaround for projection performance.

The split is not bandwidth optimization. It is what makes the trust model expressible at the frame layer at all. A single doc would force scope enforcement into path-level Automerge ACLs, which Automerge does not provide.

## Decision 2: NotebookDoc carries durable per-cell state. RuntimeStateDoc carries ephemeral per-execution state.

The cleavage line is "what should survive a kernel restart, a daemon restart, a save-to-`.ipynb` round trip?"

What lives in `NotebookDoc` (schema v5, `crates/notebook-doc/src/lib.rs`):

- `cells/{cell_id}/`: `id`, `cell_type`, `position` (fractional index hex string for ordering), `source` (Automerge Text), `metadata`, `resolved_assets`, `attachments`, `execution_count` (legacy JSON-encoded string preserved for nbformat round-trip).
- `cells/{cell_id}/execution_id`: a pointer that the daemon stamps at queue time. This is the **only** runtime-state field that lives in `NotebookDoc`.
- `metadata/`: `runtime`, `kernelspec`, `language_info`, `runt` (deps / trust / cell-execution metadata), legacy `notebook_metadata` JSON string.
- `schema_version`, `notebook_id`, `runtime_state_doc_id`, `comms_doc_id`.

What lives in `RuntimeStateDoc` (schema v2, `crates/runtime-doc/src/doc.rs`):

- `kernel/`: lifecycle (NotStarted, AwaitingTrust, AwaitingEnvBuild, ..., Running, Error, Shutdown), activity (Idle / Busy when running), error_reason, name, language, env_source.
- `queue/`: `executing_execution_id`, `queued_execution_ids` (list of execution IDs awaiting execution).
- `executions/{execution_id}/`: status (queued / running / done / error), `execution_count`, `success`, `outputs` (a Map of `{output_id}` → inline manifest with blob refs), `seq` (queue ordering), `source` (audit log of what was executed).
- `env/`: in_sync flag, added/removed packages, channels_changed, deno_changed, latest flattened env-progress event.
- `trust/`: status, needs_approval, approved deps lists per package manager.
- `project_context/`: state, observed_at, kind, paths, parsed dependency lists.
- `display_index/{display_id}/{execution_id\0output_id}`: a reverse index used to route `update_display_data` to existing display IDs across executions.
- `comms/{comm_id}/`: target_name, model_module, model_name, outputs (inline manifests for OutputModel widgets), seq, capture_msg_id. This is widget comm topology and routing; mutable widget state lives in `CommsDoc`.
- `last_saved`: ISO timestamp of last save (a persistence bookkeeping field, not a kernel concept).

What lives in `CommsDoc` (schema v1, `crates/runtime-doc/src/comms.rs`):

- `comms/{comm_id}/state/{key}`: mutable widget trait values authored by the
  runtime and by editor/owner peers.
- `schema_version`.

The placement test: if executing a cell would have to wait on this field before it can produce output, the field is durable and belongs in `NotebookDoc`. If kernel-side replay would have to forget this field on restart, it belongs in `RuntimeStateDoc`. Sources, structure, metadata: durable. Execution status, outputs, queue position: ephemeral.

This matches nbformat semantics. `.ipynb` files carry cell source, cell type, metadata, and (legacy) static output snapshots. They do not carry queue state, kernel status, env-sync diff. The .ipynb load path imports legacy outputs into a single synthetic execution in `RuntimeStateDoc`; live outputs sit there from the start.

### The cell-level pointer crosses the boundary: `cell.execution_id`

A cell's "current outputs" are looked up by following the `cells/{cell_id}/execution_id` pointer in `NotebookDoc` into the `executions/{execution_id}/outputs` map in `RuntimeStateDoc`. The daemon stamps this pointer at queue time (`NotebookDoc::set_execution_id`, `lib.rs:1707`). `clear_outputs` sets the pointer to null and resets the legacy `execution_count` field; it never deletes the execution entry in `RuntimeStateDoc` (`lib.rs:1736`).

This is the per-cell structural link between `NotebookDoc` and `RuntimeStateDoc`. Document-level pairings are carried by `NotebookDoc.runtime_state_doc_id` and `NotebookDoc.comms_doc_id`.

The choice to store the pointer in `NotebookDoc` and the body in `RuntimeStateDoc` was driven by save semantics. The pointer is the part that survives a `.ipynb` export. The body is the part that gets thrown away.

`runtime-state-document-identity.md` adds a second, document-level association:
`NotebookDoc.runtime_state_doc_id`. For notebook rooms, that pointer identifies
which `RuntimeStateDoc` belongs with the notebook. The runtime-state document
itself remains document-agnostic: it carries its own `runtime_state_doc_id`, not
a notebook backlink, so the same schema can support markdown-associated or
standalone runtime state later. It does not replace `cell.execution_id`, and it
does not store runtime-state heads in `NotebookDoc`. ADR 0002 adds the parallel
`NotebookDoc.comms_doc_id` pointer for the paired CommsDoc.

## Decision 3: Write authority is per-document, and `RuntimeStateDoc` separates runtime authority from widget state

`NotebookDoc` is **multi-writer**. Editor-scope or owner-scope peers (the desktop UI, MCP agents authoring on the user's behalf, the daemon when applying formatter results or file-watcher reloads) all author changes. The actor labels distinguish them per `identity-and-trust.md` Decision 1. Concurrent edits resolve via Automerge.

`RuntimeStateDoc` has **two authoritative runtime writer paths**. Execution
intent is special: the coordinator creates execution entries and queue order
through `ExecuteCell` / `RunAllCells`; runtime peers may only advance those
accepted entries. Mutable widget state is no longer a RuntimeStateDoc exception;
it lives in `CommsDoc`.

1. **The daemon** writes kernel lifecycle transitions (`kernel_state.rs`, `runtime_bridge.rs`), queue mutations on ExecuteCell / RunAllCells, execution entries on queue insert, status updates on start/done/error, outputs (the IOPub committer in `crates/runtimed/src/stream_committer.rs` and `display_update_committer.rs`), env-sync, trust state, and project context. The daemon's actor label is `runtimed:state` (`crates/runtime-doc/src/doc.rs:344`).
2. **The runtime-agent/runtime-peer path** writes under its own actor (`crates/runtimed/src/runtime_agent.rs:96`). The local runtime agent attaches over the `Handshake::RuntimeAgent` channel (`crates/notebook-protocol/src/connection/handshake.rs`); hosted runtime peers attach through scoped room sync. They may publish lifecycle, progress, outputs, `display_index`, and comm topology/routing for accepted executions, but the shared policy rejects newly created execution entries so work cannot be smuggled in through raw `RuntimeStateDoc` sync. The local peer-ingress validator also rejects frames unless the agent ID in the frame matches the room's current runtime-agent provenance (`crates/runtimed/src/notebook_sync_server/peer_runtime_agent.rs:47-63`).

`CommsDoc` is the bidirectional widget-state document. Editor/owner peers and
the runtime can write mutable state there; the runtime forward path consults
`RuntimeStateDoc.comms/*` topology before sending any CommsDoc state to the
kernel.

`PoolDoc` is **daemon-only**. Client writes are stripped on ingress (`pool_state.rs:341`) even though the sync protocol round-trip would otherwise carry them across.

### Where this is enforced

| Document | Enforcement | Where |
|---|---|---|
| `NotebookDoc` writes from viewer scope | Frame-level scope check (`identity-and-trust.md` Decision 5) | `peer_notebook_sync.rs::handle_notebook_doc_frame` |
| `NotebookDoc` actor-principal forgery | Clone-preview validator | `peer_notebook_sync.rs` (mirror of `peer_runtime_sync.rs:80-107`) |
| `RuntimeStateDoc` writes from editor/owner scope | Frame-level scope check rejects non-runtime-agent writes; widget state belongs in `CommsDoc`. | `crates/runtime-doc/src/policy.rs`, `peer_runtime_sync.rs`, hosted WASM room host |
| `RuntimeStateDoc` actor-principal forgery | Clone-preview validator | `peer_runtime_sync.rs:80-107` |
| `CommsDoc` orphan state | Runtime forward path and orphan GC derive membership from `RuntimeStateDoc` topology. | `peer_comms_sync.rs`, `runtime_agent.rs`, `crates/runtime-doc/src/comms.rs` |
| `PoolDoc` writes from any peer | Strip all changes at ingress | `pool_state.rs:341` |
| Runtime-agent ID provenance mismatch | Ingress reject on agent ID mismatch | `peer_runtime_agent.rs:47-63` |

Editor/owner `RuntimeStateDoc` deltas are rejected; their mutable widget state
writes belong in `CommsDoc`. Queue, execution, kernel, environment, output
routing, comm topology, and hidden root/schema writes remain runtime-owned.
Runtime-peer deltas are also policy-validated: progress and output updates for
accepted executions pass, but newly created execution entries and queue entries
for unknown executions are rejected. The runtime-agent provenance check above is
a separate gate: it filters who may write under the
runtime-agent actor, while the shared policy filters what each scope may mutate.

`RuntimeStateDoc` exposes two ingress APIs internally: `receive_sync_message` (read-only, strips changes for clone-preview validation) and `receive_sync_message_with_changes_recovering` (writable, applies changes after validation). The server uses the read-only API in the clone-preview pass and the writable one for committed application; library callers use the writable API directly (`crates/runtime-doc/src/doc.rs:2720`, `:2789`).

## Decision 4: Persistence is per-document and asymmetric

- **`NotebookDoc`** is persisted. For file-backed rooms, the canonical form is the `.ipynb` on disk; the Automerge doc is rebuilt from `.ipynb` on load and saved back on Cmd+S. For untitled rooms, the doc is persisted as a debounced `.automerge` blob to a daemon-managed directory (`crates/runtimed/src/notebook_sync_server/persist.rs::spawn_persist_debouncer`). The persisted file is deleted on save-as (it transitions to file-backed) and on room eviction without save (the untitled doc is gone).
- **`RuntimeStateDoc`** is **not** persisted to disk separately. The comment in `crates/runtimed/src/daemon.rs:4419-4422` records this: "Outputs live in RuntimeStateDoc (not persisted to disk), once evicted, those outputs are discarded." On room eviction, the entire doc is dropped. On daemon restart, it is rebuilt from the schema seed.
- **`CommsDoc`** is **not** persisted to disk as a standalone Automerge doc in
  desktop rooms. Save/load reconstructs widget state from the notebook's widget
  metadata and the runtime/comms projection; the live CommsDoc is dropped on
  room eviction.
- **`PoolDoc`** is **not** persisted. It is built fresh from `PoolDoc::new()` on daemon startup, hydrated from in-process pool state on each daemon tick (`Daemon::update_pool_doc`). On daemon restart it is empty until the pools come back online.

Output durability is the asymmetry that needs the most attention. `RuntimeStateDoc` outputs are the live record of the most recent execution; they are also what the frontend renders. If the room evicts before a save, those outputs are gone. The compensating mechanism:

- A separate `ExecutionStore` (`crates/runtimed-client/src/execution_store.rs`) persists terminal execution records to disk on each terminal transition (`peer_runtime_sync.rs::persist_terminal_execution_records`).
- On save to `.ipynb`, the daemon walks `RuntimeStateDoc.executions[cell.execution_id].outputs` and writes them into the nbformat output array on disk.
- Blob payloads (image bytes, large text) are stored in a content-addressed `BlobStore` keyed by SHA-256, separate from any of the docs. Manifests in `executions/*/outputs` reference blobs by hash. Blobs survive across executions and rooms; the blob GC walks live rooms plus persisted notebook docs for resolved-asset and attachment refs.

So the durable footprint of one notebook is: the `.ipynb` (or untitled `.automerge`), the per-execution records in `ExecutionStore`, and the blob store. `RuntimeStateDoc` is the in-memory join of these for the lifetime of the room.

## Decision 5: Lifecycle and identity per document

| Document | Created when | Identity | GC'd when |
|---|---|---|---|
| `NotebookDoc` | On room load (either from `.ipynb` or fresh) | Per-notebook UUID; schema seed actor `nteract:notebook-schema:v5` | On room eviction; persisted file deleted on save-as transition |
| `RuntimeStateDoc` | On room load (fresh from schema seed; load code populates synthetic executions when the `.ipynb` carries legacy outputs, `crates/runtimed/src/notebook_sync_server/load.rs:709, :731, :741`) | Runtime-state document id referenced by `NotebookDoc.runtime_state_doc_id`; schema seed actor `nteract:runtime-state-schema:v2`; daemon writes under actor `runtimed:state`; runtime-agent peer writes under its own actor (`crates/runtimed/src/runtime_agent.rs:96`) | On room eviction |
| `CommsDoc` | On room load (fresh from schema seed; load code hydrates widget state when `.ipynb` widget metadata is present) | Per-notebook side document; schema seed actor `nteract:comms-doc-schema:v1` | On room eviction |
| `PoolDoc` | On daemon startup | Singleton; daemon writes under actor `runtimed:pool` | On daemon shutdown |

The schema seed actor is what makes initial sync correct. Every peer scaffolds
from the same frozen genesis bytes (`assets/notebook_genesis_v5.am`,
`assets/runtime_state_genesis_v2.am`, `assets/comms_doc_genesis_v1.am`) so the
top-level object IDs (`cells`, `metadata`, `kernel`, `queue`, `executions`,
`comms`, ...) agree before the first sync round. The `notebook-doc/AGENTS.md`
invariant "exactly one peer creates document structure" applies inside
`NotebookDoc` for any non-genesis structure (so the daemon owns `cells`
creation when scaffolding from empty). For `RuntimeStateDoc`, the frozen genesis
scaffolds the runtime tree; regular clients remain read-only, the
coordinator/room host owns intent and room facts, and runtime peers may only
mutate policy-allowed runtime progress/output/topology state.

Room eviction is driven by "last peer disconnected." `peer_eviction.rs` runs the teardown: stop kernel, optionally clean up env, save `.ipynb` if file-backed and dirty, drop the room from the registry. Room-scoped live docs go out of scope. Re-opening the room recreates `RuntimeStateDoc` and `CommsDoc` fresh from seed.

## Decision 6: Sync read-only enforcement is per-document

Each doc's `receive_sync_message` makes a different choice about client changes:

- **`NotebookDoc::receive_sync_message_with_changes_recovering`** applies client changes. The clone-preview validator runs first (per identity ADR Decision 3) to reject actor-principal forgery, then changes apply.
- **`RuntimeStateDoc::receive_sync_message_with_changes_recovering`** also applies client changes for approved runtime-state ingress paths. The same actor validator runs first, then the shared runtime-doc policy enforces the allowed path surface for runtime-peer lifecycle/output/topology state and rejects widget state writes that belong in `CommsDoc`.
- **`CommsDoc::receive_sync_message_with_changes_recovering`** applies mutable
  widget state changes. Runtime forwarding and orphan cleanup use
  `RuntimeStateDoc` topology as the membership authority.
- **`PoolDoc::receive_sync_message`** (`crates/notebook-doc/src/pool_state.rs:341`) explicitly clears `message.changes = Vec::<Vec<u8>>::new().into()` before passing to Automerge. The `heads`, `need`, and `have` fields are preserved by omission so the sync handshake still completes (bloom-filter exchange, ACKs); only the change payload is dropped.

This is a set of different ingress shapes for what looks like one protocol.
`PoolDoc`'s read-only mode is the most aggressive: a malicious peer cannot even
cause Automerge to evaluate the changes; the strip happens before any apply.

## Worked examples

### Editing a cell while a kernel is busy

1. User types into a code cell. CodeMirror dispatches a transaction. The bridge calls `handle.splice_source(cell_id, ...)`. This writes `NotebookDoc.cells[cell_id].source` only.
2. The flush debouncer sends a `0x00` sync frame to the daemon. Per-type cap for `AUTOMERGE_SYNC` is 64 MiB / warn at 16 MiB (`crates/notebook-wire/src/lib.rs:61-64`); the 100 MiB `MAX_FRAME_SIZE` is the outer ceiling for unknown types, not the per-type cap.
3. Meanwhile, the kernel is streaming stdout from an earlier `ExecuteCell`. The runtime agent writes `RuntimeStateDoc.executions[exec_id].outputs[output_id]` and pushes a `0x05` sync frame to all connected peers.
4. Both writes land. The frontend's two materialization paths update the cell store and the output store independently. Neither write is blocked behind the other; the two docs have independent `sync::State`.

### Save and reload

1. User hits Cmd+S. Daemon walks `RuntimeStateDoc.executions` keyed by each cell's current `execution_id` in `NotebookDoc`, materializes outputs into nbformat, writes `.ipynb` to disk.
2. Daemon sets `RuntimeStateDoc.last_saved` to the ISO timestamp.
3. User quits. Room evicts. Both notebook docs are dropped. `.automerge` for untitled paths is not used here because the doc is file-backed.
4. User reopens the notebook. Daemon loads `.ipynb` into a fresh `NotebookDoc`. `RuntimeStateDoc` is rebuilt from schema seed, then the loader walks cells that carry legacy `execution_count` or outputs and creates **one synthetic execution entry per such cell** so the new `RuntimeStateDoc` can route them through the same `executions/*/outputs` shape (`crates/runtimed/src/notebook_sync_server/load.rs:709-741`). The cell's `execution_id` is set to the synthetic entry's id at the same time.
5. If the `.ipynb` carries `metadata.widgets["application/vnd.jupyter.widget-state+json"]`, the loader imports widget topology into `RuntimeStateDoc.comms` and mutable model state into `CommsDoc`. Large widget buffers are externalized through the blob store before the comm state is written. That means a publish snapshot can carry widget models even when no live kernel has reopened those comms.

### Kernel crash and relaunch

1. Kernel dies mid-execution. Runtime agent writes `RuntimeStateDoc.kernel.lifecycle = "Error"`, status of in-flight execution = "error".
2. User clicks "Restart kernel." Daemon spawns a fresh runtime agent. New agent connects, sets lifecycle through Launching → Connecting → Running.
3. `NotebookDoc` is unchanged. All cell sources, structure, metadata are still there. `RuntimeStateDoc.executions` still contains the failed execution. Cells continue to point at it via `execution_id`, so the failed output is still rendered until the next execution overwrites it.

### Pool failure affects all rooms

1. UV pool prewarm fails because `default_packages` contains a typo'd package name.
2. `Daemon::update_pool_doc` writes `PoolDoc.uv.error = "could not resolve package 'numpyy'"`, `error_kind = "invalid_package"`, `failed_package = "numpyy"`.
3. `pool_doc_changed.send(())` fans out to every peer subscribed in `peer_loop.rs`. That includes peers attached to notebooks via `NotebookSync`, and peers attached via `Pool` handshakes (system tray, env tools).
4. The frontend `usePoolState` hook re-renders the pool banner. The banner appears once per app instance, not once per open notebook.

## Open Questions

1. **How do future `RuntimeStateDoc` ingress paths stay policy-wrapped?** Server-side enforcement has landed for runtime-owned `RuntimeStateDoc` writes, and mutable widget state moved to `CommsDoc`. Any future direct import, bridge, or remote-runtime path that can apply `RuntimeStateDoc` changes must route through the same policy instead of reintroducing a second authorization surface.
2. **Is `last_saved` in the right document?** It lives in `RuntimeStateDoc`, which does not persist. The justification in the field's doc comment is that it tracks ephemeral save bookkeeping, not document schema. But the field survives only as long as the room is open, which means a room reopened from disk has no record of when it was last saved. If the answer is "use mtime on the `.ipynb`," that should be explicit.
3. **Is `cells[cell_id].execution_count` in the right document?** Today it lives in `NotebookDoc` as a JSON-encoded string ("5", "null") for nbformat round-trip. Live execution counts live in `RuntimeStateDoc.executions[execution_id].execution_count`. The frontend has to know to consult the live source first and fall back to the legacy field. Splitting one concept across two documents creates a stale-on-reload hazard.
4. **`comms/*/outputs` is inline manifests, not blob refs.** Most output payloads in `RuntimeStateDoc.executions/*/outputs` go through the blob store; comm outputs (the OutputModel widget) inline their manifests. The reason is that comm outputs are scoped to a widget, not a cell, and don't go through the cell output path. Whether the comm-outputs storage should converge with execution outputs is open.
5. **`PoolDoc` per-pool-type vs per-pool-instance.** UV / Conda / Pixi are hard-coded top-level keys. Adding a new env manager (mamba, rattler, future) requires a schema change, not data. A keyed map `pools/{kind}` would be more extensible; the trade-off is that schema-versioned hard-coded keys make pool absence explicit in the type rather than a missing entry. Note also that `PoolDoc` has no `schema_version` field at all (`NotebookDoc` is v5, `RuntimeStateDoc` is v2); a future incompatible change has no version pin to negotiate against.
6. **What happens to `RuntimeStateDoc` on schema bump?** v2 today. The bump path is "discard and re-seed" because there is no persisted state. That works as long as no consumer treats `RuntimeStateDoc` as durable. If a future feature (e.g., persistent execution history across daemon restart) adds a persistence layer, the schema-bump strategy needs a migration story.
7. **Cross-document heads correlation belongs to the publish boundary, not the live docs.** A snapshot for replay or audit needs (`NotebookDoc` heads, `RuntimeStateDoc` heads) as a pair. The desktop daemon does not produce or store this pair anywhere, and that is probably correct: forcing the live docs to reference each other's heads buys nothing for editing and adds a write-amplification path on every change. The natural home for the pair is publish metadata — the hosted-room prototype already stores both hashes together in its D1 catalog row alongside `latest_revision_id`, and a desktop "export snapshot" or "save versioned" feature would write the same pair into the export artifact. Leaving it out of the live documents keeps the cleavage line clean.
8. **`PoolDoc` does not participate in the v1 clone-preview validator.** Because all changes are stripped on ingress, the principal-forgery problem doesn't arise. But the validator's absence means a malicious peer's stripped changes still contribute to the bloom-filter handshake. Probably benign; worth noting.

## Implications for distributed deployment

The split was designed for the desktop topology (one daemon per user, same-UID trust). In a hosted multi-user deployment:

- **`PoolDoc` does not make sense per-room or per-user.** Pool state is a property of the host's prewarm infrastructure. Hosted deployments either replace `PoolDoc` with a deployment-level "pools and quotas" doc, or drop it entirely if hosted runtimes don't prewarm on the user's behalf.
- **`RuntimeStateDoc`'s ephemeral semantics fit hibernating rooms badly.** A room that hibernates and rehydrates wants its execution history back. Either `RuntimeStateDoc` persists, or `ExecutionStore` becomes the canonical source and `RuntimeStateDoc` is a projection. The desktop's "throw it away on eviction" choice has to flip.
- **`NotebookDoc`'s multi-writer model already fits.** Multi-user editing of cells is what the trust model carves out for editor-scope peers.
- **CommsDoc membership is a security-critical path.** On desktop, same-UID
  trust means a misbehaving editor is the user's own problem. In a multi-user
  room, arbitrary CommsDoc entries must remain inert unless RuntimeStateDoc
  topology proves the comm exists and belongs to the active runtime path.
- **`cell.execution_id` pointing across documents survives.** It is a string scalar; it does not depend on local addressing.

## References

- `crates/notebook-doc/src/lib.rs` - NotebookDoc schema v5.
- `crates/notebook-doc/AGENTS.md` - mutation rules for NotebookDoc.
- `crates/runtime-doc/src/doc.rs` - RuntimeStateDoc schema v2.
- `crates/runtime-doc/src/comms.rs` - CommsDoc schema v1.
- `crates/notebook-doc/src/pool_state.rs:8-39, :110-153, :234-251` - PoolDoc schema. The doc-comment and live scaffold both model `uv`, `conda`, and `pixi` counters with optional per-pool error fields, including `failed_package`.
- `crates/notebook-wire/src/lib.rs:9-44` - frame type constants and per-type caps.
- `crates/notebook-wire/AGENTS.md` - wire protocol overview.
- `crates/runtimed/src/notebook_sync_server/peer_loop.rs` - the sync select loop holding per-document peer-state objects.
- `crates/runtimed/src/notebook_sync_server/peer_notebook_sync.rs` - NotebookDoc ingress validator.
- `crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs:80-107` - RuntimeStateDoc clone-preview validator and save-fingerprint comparison.
- `crates/runtimed/src/notebook_sync_server/peer_pool_sync.rs` - PoolDoc fan-out across all connected peers.
- `crates/runtimed/src/notebook_sync_server/persist.rs` - NotebookDoc `.automerge` debouncer.
- `crates/runtimed/src/daemon.rs:4419-4422` - the comment that records "RuntimeStateDoc is not persisted."
- `docs/adr/identity-and-trust.md` - the trust scopes that the document split makes expressible.

## Tracked follow-ups (from the retired cleanup punchlist)

These items were migrated from `docs/adr/cleanup-punchlist.md` when it was
retired (2026-06-10). Severity: **Targeted PR** = one-or-two-file fix ready
to implement; **Design** = needs a decision in this ADR before code moves.

- **3D-1** (Targeted PR; `crates/notebook-doc/`, frontend reader): `cells[cell_id].execution_count` lives in **both** `NotebookDoc` (legacy JSON-string) and `RuntimeStateDoc.executions[execution_id].execution_count` (live i64). Frontend consults live first, falls back to legacy. Two sources of truth for one number.
- **3D-2** (Targeted PR; `crates/runtime-state/` (move to `NotebookDoc` or use `.ipynb` mtime)): `last_saved` lives in `RuntimeStateDoc`, which does not persist. A reopened room has no record of its last save time.
- **3D-3** (Design; output manifest path): `comms/*/outputs` inline output manifests, bypassing the blob path that `executions/*/outputs` uses. Two output-storage paths in one document.
- **3D-6** (Design; `crates/runtimed/src/notebook_sync_server/`): `PoolDoc` does not participate in the clone-preview validator. Mitigation is `strip_changes`, not `validate`. Future write-bearing pool features would need the validator path wired back in.
- **3D-7** (Design; `docs/adr/remote-workstation-doc-agents.md` workstation dispatch): **Reframed.** The routing contract exists and its core is implemented: owner-scoped `REQUEST` frames are validated by the room host, become queued executions with coordinator-owned provenance in `RuntimeStateDoc` (`crates/runtimed-wasm/src/lib.rs::receive_request`), and the runtime peer consumes them through normal `RuntimeStateDoc` sync while the shared policy rejects runtime-peer-forged execution intent. Remaining design is active-target selection, kernel-lifecycle request dispatch, and disconnect/liveness gating, tracked in `remote-workstation-doc-agents.md` (#3399).
- **3D-8** (Design; `crates/runtimed/src/notebook_sync_server/peer_writer.rs`): The first peer-egress lane split has landed: `PeerWriter` separates reliable sync/response traffic from ephemeral presence/broadcast traffic. Remaining design work is reserved control capacity, explicit session-control barriers, and RuntimeStateDoc catch-up when reliable runtime traffic saturates. See `peer-egress-lanes.md`.
