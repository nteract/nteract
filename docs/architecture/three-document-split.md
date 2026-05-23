# The Three-Document Split: NotebookDoc, RuntimeStateDoc, PoolDoc

**Status:** Draft, 2026-05-22.

## Context

nteract syncs state through Automerge CRDTs. Three separate documents carry that state today, not one:

- **`NotebookDoc`** (`crates/notebook-doc/src/lib.rs`) - one per notebook room. Carries cells, source text, notebook metadata, attachments. Schema version 4. Wire frame `0x00` (AutomergeSync).
- **`RuntimeStateDoc`** (`crates/runtime-doc/src/doc.rs`) - one per notebook room. Carries kernel lifecycle, execution queue, executions and their outputs, env-sync state, trust state, project-file context, widget comm state. Schema version 2. Wire frame `0x05` (RuntimeStateSync).
- **`PoolDoc`** (`crates/notebook-doc/src/pool_state.rs`) - one per daemon (not per room). Carries UV / Conda / Pixi prewarm pool counters, errors, retry timers. No schema version. Wire frame `0x06` (PoolStateSync).

A connecting peer subscribes through one of the typed-frame handshake channels. `NotebookSync` (and the related `OpenNotebook` / `CreateNotebook` paths) brings up all three documents on one socket: `NotebookDoc` and `RuntimeStateDoc` per the joined room, plus `PoolDoc` fanned out to that peer because the peer loop subscribes to `pool_doc_changed` regardless of room. The `Pool` handshake is a JSON-IPC channel for pool status, env claims, and daemon admin; it does not carry typed-frame Automerge sync at all. Frame caps differ per type (see `crates/notebook-wire/src/lib.rs:59-102`).

The split is load-bearing for sync bandwidth, write-frequency isolation, fan-out scope, persistence, and trust. It is not written down in one place. This ADR records the decision so the boundaries become visible to anyone changing them.

This ADR describes the real desktop application. The hosted prototype at `apps/notebook-cloud/` is parked and outside scope. A closing section sketches what changes when the same split runs in a multi-user deployment.

Neighbors:

- `docs/architecture/typed-frame-v4-wire-protocol.md` — the byte protocol that carries each doc's sync stream.
- `docs/architecture/execution-pipeline.md` — how `RuntimeStateDoc` is written during cell execution.
- `docs/architecture/blob-storage-and-content-addressing.md` — how output payloads are stored separately from the doc itself.
- `docs/architecture/identity-and-trust.md` — the trust scopes the three-doc split makes expressible.
- `docs/architecture/cleanup-punchlist.md` — open gaps in the split.

## Decision 1: Three documents, three sync streams, three frame types

Each document syncs on its own Automerge channel, with its own peer-state object and its own frame type. The peer loop in `crates/runtimed/src/notebook_sync_server/peer_loop.rs` holds three independent `sync::State` values:

```rust
let InitialSyncState { mut peer_state } =      // NotebookDoc
    send_initial_notebook_doc_sync(&mut writer, room).await?;
let mut state_peer_state = sync::State::new(); // RuntimeStateDoc
let mut pool_peer_state = sync::State::new();  // PoolDoc
```

Each ingress path is a separate handler (`handle_notebook_doc_frame`, `handle_runtime_state_frame`, `handle_pool_state_frame`) with its own validator. Each broadcast subscription is a separate stream (`changed_tx`, `state_changed_tx`, `pool_doc_changed`). Egress shares one queue: the peer's outbound writer is a single bounded mpsc in `PeerWriter` (`peer_writer.rs:14`), so a stdout flood on `0x05` can backpressure a cell-text save on `0x00` even though the docs are otherwise independent. That shared egress is the one place the split leaks; everywhere else, the three streams are decoupled.

The reasons for keeping them separate, not just logically but physically on the wire:

1. **Different write frequencies.** `NotebookDoc` writes on user-paced events: keystrokes, cell adds, structural moves. `RuntimeStateDoc` writes on kernel-paced events: queue advances, IOPub output streams, widget comm churn, env-sync recalculation. `PoolDoc` writes on prewarm-pool-paced events: maybe seconds apart when idle, sub-second under load. Interleaving them in one Automerge document would make every frontend re-render on stdout flood, and every typing change generate cross-cutting sync messages to peers that only care about pool health.
2. **Different fan-out scopes.** `PoolDoc` fans out to every peer of the daemon, including peers that aren't even attached to a notebook (`Handshake::Pool` connections from the system-tray UI, env-management tools). `NotebookDoc` and `RuntimeStateDoc` fan out only to peers attached to that room.
3. **Different write authority.** `NotebookDoc` is multi-writer (any editor-scope peer authors cells). `RuntimeStateDoc` has two writer paths: the daemon, and the runtime-agent peer that attaches over the `Handshake::RuntimeAgent` channel and writes under its own actor (`crates/runtimed/src/runtime_agent.rs:96`). Browser clients are allowed to author into the `comms/*/state/*` subtree only. `PoolDoc` is daemon-only, with all client changes stripped at ingress (`pool_state.rs:341`, `message.changes = Vec::<Vec<u8>>::new().into()`).
4. **Different lifetimes.** `NotebookDoc` persists to disk (`.automerge` for ephemeral rooms; `.ipynb` for file-backed). `RuntimeStateDoc` is in-memory only. `PoolDoc` lives for the daemon's lifetime. See Decision 4.
5. **Different trust scopes.** The identity ADR (`docs/architecture/identity-and-trust.md` Decision 5) carves four scopes precisely along these lines. `viewer` reads all three. `editor` writes `NotebookDoc` and the widget subtree of `RuntimeStateDoc`. `runtime_peer` writes `RuntimeStateDoc` only. `owner` writes both notebook docs and manages the ACL. `PoolDoc` is daemon-write-only across every scope.

The split is not bandwidth optimization. It is what makes the trust model expressible at the frame layer at all. A single doc would force scope enforcement into path-level Automerge ACLs, which Automerge does not provide.

## Decision 2: NotebookDoc carries durable per-cell state. RuntimeStateDoc carries ephemeral per-execution state.

The cleavage line is "what should survive a kernel restart, a daemon restart, a save-to-`.ipynb` round trip?"

What lives in `NotebookDoc` (schema v4, `crates/notebook-doc/src/lib.rs:18-40`):

- `cells/{cell_id}/`: `id`, `cell_type`, `position` (fractional index hex string for ordering), `source` (Automerge Text), `metadata`, `resolved_assets`, `attachments`, `execution_count` (legacy JSON-encoded string preserved for nbformat round-trip).
- `cells/{cell_id}/execution_id`: a pointer that the daemon stamps at queue time. This is the **only** runtime-state field that lives in `NotebookDoc`.
- `metadata/`: `runtime`, `kernelspec`, `language_info`, `runt` (deps / trust / cell-execution metadata), legacy `notebook_metadata` JSON string.
- `schema_version`, `notebook_id`.

What lives in `RuntimeStateDoc` (schema v2, `crates/runtime-doc/src/doc.rs:8-73`):

- `kernel/`: lifecycle (NotStarted, AwaitingTrust, AwaitingEnvBuild, ..., Running, Error, Shutdown), activity (Idle / Busy when running), error_reason, name, language, env_source.
- `queue/`: `executing_execution_id`, `queued_execution_ids` (list of execution IDs awaiting execution).
- `executions/{execution_id}/`: status (queued / running / done / error), `execution_count`, `success`, `outputs` (a Map of `{output_id}` → inline manifest with blob refs), `seq` (queue ordering), `source` (audit log of what was executed).
- `env/`: in_sync flag, added/removed packages, channels_changed, deno_changed, latest flattened env-progress event.
- `trust/`: status, needs_approval, approved deps lists per package manager.
- `project_context/`: state, observed_at, kind, paths, parsed dependency lists.
- `display_index/{display_id}/{execution_id\0output_id}`: a reverse index used to route `update_display_data` to existing display IDs across executions.
- `comms/{comm_id}/`: target_name, model_module, model_name, state (JSON-encoded widget state), outputs (inline manifests for OutputModel widgets), seq, capture_msg_id.
- `last_saved`: ISO timestamp of last save (a persistence bookkeeping field, not a kernel concept).

The placement test: if executing a cell would have to wait on this field before it can produce output, the field is durable and belongs in `NotebookDoc`. If kernel-side replay would have to forget this field on restart, it belongs in `RuntimeStateDoc`. Sources, structure, metadata: durable. Execution status, outputs, queue position: ephemeral.

This matches nbformat semantics. `.ipynb` files carry cell source, cell type, metadata, and (legacy) static output snapshots. They do not carry queue state, kernel status, env-sync diff. The .ipynb load path imports legacy outputs into a single synthetic execution in `RuntimeStateDoc`; live outputs sit there from the start.

### One pointer crosses the boundary: `cell.execution_id`

A cell's "current outputs" are looked up by following the `cells/{cell_id}/execution_id` pointer in `NotebookDoc` into the `executions/{execution_id}/outputs` map in `RuntimeStateDoc`. The daemon stamps this pointer at queue time (`NotebookDoc::set_execution_id`, `lib.rs:1707`). `clear_outputs` sets the pointer to null and resets the legacy `execution_count` field; it never deletes the execution entry in `RuntimeStateDoc` (`lib.rs:1736`).

This is the only structural link between the two documents. Everything else is keyed entirely within one or the other. Output history sits in `RuntimeStateDoc` indefinitely; the cell just looks at one of the entries.

The choice to store the pointer in `NotebookDoc` and the body in `RuntimeStateDoc` was driven by save semantics. The pointer is the part that survives a `.ipynb` export. The body is the part that gets thrown away.

## Decision 3: Write authority is per-document, and `RuntimeStateDoc` has two distinct authoring paths

`NotebookDoc` is **multi-writer**. Editor-scope or owner-scope peers (the desktop UI, MCP agents authoring on the user's behalf, the daemon when applying formatter results or file-watcher reloads) all author changes. The actor labels distinguish them per `identity-and-trust.md` Decision 1. Concurrent edits resolve via Automerge.

`RuntimeStateDoc` has **two writer paths**, not one:

1. **The daemon** writes kernel lifecycle transitions (`kernel_state.rs`, `runtime_bridge.rs`), queue mutations on ExecuteCell / RunAllCells, execution entries on queue insert, status updates on start/done/error, outputs (the IOPub committer in `crates/runtimed/src/stream_committer.rs` and `display_update_committer.rs`), env-sync, trust state, and project context. The daemon's actor label is `runtimed:state` (`crates/runtime-doc/src/doc.rs:344`).
2. **The runtime-agent peer** attaches over the `Handshake::RuntimeAgent` channel (`crates/notebook-protocol/src/connection/handshake.rs`) and writes under its own actor (`crates/runtimed/src/runtime_agent.rs:96`). The runtime agent is the in-process kernel host; its writes to `executions/*/outputs`, `display_index`, and `comms/*` arrive over the same `0x05` sync stream as the daemon's writes. The peer-ingress validator rejects frames unless the agent ID in the frame matches the room's current runtime-agent provenance (`crates/runtimed/src/notebook_sync_server/peer_runtime_agent.rs:47-63`).

Browser editor clients may author **only into the `comms/*/state/*` subtree**. The frontend writes via `RuntimeStateHandle::set_comm_state_property` (`runtimed-wasm/src/lib.rs:1486`); anywidget's `save_changes()` calls `set_comm_state_batch` which calls the same path. The daemon receives the change like any other and forwards it to the kernel as a `SendCommUpdate`.

`PoolDoc` is **daemon-only**. Client writes are stripped on ingress (`pool_state.rs:341`) even though the sync protocol round-trip would otherwise carry them across.

### Where this is enforced

| Document | Enforcement | Where |
|---|---|---|
| `NotebookDoc` writes from viewer scope | Frame-level scope check (`identity-and-trust.md` Decision 5) | `peer_notebook_sync.rs::handle_notebook_doc_frame` |
| `NotebookDoc` actor-principal forgery | Clone-preview validator | `peer_notebook_sync.rs` (mirror of `peer_runtime_sync.rs:80-107`) |
| `RuntimeStateDoc` writes outside `comms/*/state/*` from editor scope | **Convention only.** Editor frames pass at the frame layer; the WASM handle's API surface refuses to expose general write methods. | `runtimed-wasm/src/lib.rs` (writer surface), `peer_runtime_sync.rs` (no path-level check) |
| `RuntimeStateDoc` actor-principal forgery | Clone-preview validator | `peer_runtime_sync.rs:80-107` |
| `PoolDoc` writes from any peer | Strip all changes at ingress | `pool_state.rs:341` |
| Runtime-agent ID provenance mismatch | Ingress reject on agent ID mismatch | `peer_runtime_agent.rs:47-63` |

The honest version: the editor / runtime_peer split for `RuntimeStateDoc` is enforced at the frame layer by scope, and inside that the widget-subtree restriction is enforced **client-side** by giving the WASM handle a narrow write API. A peer that crafted its own sync messages with changes targeting `executions/*/status` would pass the v1 ingress validator. Path-level server enforcement is deferred work; the identity ADR records it explicitly. The runtime-agent provenance check above is a different gate: it filters who may write under the runtime-agent's actor, not what paths any peer may write to.

`RuntimeStateDoc` exposes two ingress APIs internally: `receive_sync_message` (read-only, strips changes for clone-preview validation) and `receive_sync_message_with_changes_recovering` (writable, applies changes after validation). The server uses the read-only API in the clone-preview pass and the writable one for committed application; library callers use the writable API directly (`crates/runtime-doc/src/doc.rs:2720`, `:2789`).

## Decision 4: Persistence is per-document and asymmetric

- **`NotebookDoc`** is persisted. For file-backed rooms, the canonical form is the `.ipynb` on disk; the Automerge doc is rebuilt from `.ipynb` on load and saved back on Cmd+S. For untitled rooms, the doc is persisted as a debounced `.automerge` blob to a daemon-managed directory (`crates/runtimed/src/notebook_sync_server/persist.rs::spawn_persist_debouncer`). The persisted file is deleted on save-as (it transitions to file-backed) and on room eviction without save (the untitled doc is gone).
- **`RuntimeStateDoc`** is **not** persisted to disk separately. The comment in `crates/runtimed/src/daemon.rs:4419-4422` records this: "Outputs live in RuntimeStateDoc (not persisted to disk), once evicted, those outputs are discarded." On room eviction, the entire doc is dropped. On daemon restart, it is rebuilt from the schema seed.
- **`PoolDoc`** is **not** persisted. It is built fresh from `PoolDoc::new()` on daemon startup, hydrated from in-process pool state on each daemon tick (`Daemon::update_pool_doc`). On daemon restart it is empty until the pools come back online.

Output durability is the asymmetry that needs the most attention. `RuntimeStateDoc` outputs are the live record of the most recent execution; they are also what the frontend renders. If the room evicts before a save, those outputs are gone. The compensating mechanism:

- A separate `ExecutionStore` (`crates/runtimed-client/src/execution_store.rs`) persists terminal execution records to disk on each terminal transition (`peer_runtime_sync.rs::persist_terminal_execution_records`).
- On save to `.ipynb`, the daemon walks `RuntimeStateDoc.executions[cell.execution_id].outputs` and writes them into the nbformat output array on disk.
- Blob payloads (image bytes, large text) are stored in a content-addressed `BlobStore` keyed by SHA-256, separate from any of the three docs. Manifests in `executions/*/outputs` reference blobs by hash. Blobs survive across executions and rooms; the blob GC walks live rooms plus persisted notebook docs for resolved-asset and attachment refs.

So the durable footprint of one notebook is: the `.ipynb` (or untitled `.automerge`), the per-execution records in `ExecutionStore`, and the blob store. `RuntimeStateDoc` is the in-memory join of these for the lifetime of the room.

## Decision 5: Lifecycle and identity per document

| Document | Created when | Identity | GC'd when |
|---|---|---|---|
| `NotebookDoc` | On room load (either from `.ipynb` or fresh) | Per-notebook UUID; schema seed actor `nteract:notebook-schema:v4` | On room eviction; persisted file deleted on save-as transition |
| `RuntimeStateDoc` | On room load (fresh from schema seed; load code populates synthetic executions when the `.ipynb` carries legacy outputs, `crates/runtimed/src/notebook_sync_server/load.rs:709, :731, :741`) | Per-notebook (lives next to its NotebookDoc); schema seed actor `nteract:runtime-state-schema:v2`; daemon writes under actor `runtimed:state`; runtime-agent peer writes under its own actor (`crates/runtimed/src/runtime_agent.rs:96`) | On room eviction |
| `PoolDoc` | On daemon startup | Singleton; daemon writes under actor `runtimed:pool` | On daemon shutdown |

The schema seed actor is what makes initial sync correct. Every peer scaffolds from the same frozen genesis bytes (`assets/notebook_genesis_v4.am`, `assets/runtime_state_genesis_v2.am`) so the top-level object IDs (`cells`, `metadata`, `kernel`, `queue`, `executions`, ...) agree before the first sync round. The `notebook-doc/AGENTS.md` invariant "exactly one peer creates document structure" applies inside `NotebookDoc` for any non-genesis structure (so the daemon owns `cells` creation when scaffolding from empty); for `RuntimeStateDoc`, the daemon owns everything by convention because the genesis already scaffolds the runtime tree.

Room eviction is driven by "last peer disconnected." `peer_eviction.rs` runs the teardown: stop kernel, optionally clean up env, save `.ipynb` if file-backed and dirty, drop the room from the registry. Both notebook docs go out of scope. Re-opening the room recreates `RuntimeStateDoc` fresh from seed.

## Decision 6: Sync read-only enforcement is per-document

Each doc's `receive_sync_message` makes a different choice about client changes:

- **`NotebookDoc::receive_sync_message_with_changes_recovering`** applies client changes. The clone-preview validator runs first (per identity ADR Decision 3) to reject actor-principal forgery, then changes apply.
- **`RuntimeStateDoc::receive_sync_message_with_changes_recovering`** also applies client changes (the widget subtree path). Same validator runs first. Convention restricts what the client may legally write; the server does not yet enforce paths.
- **`PoolDoc::receive_sync_message`** (`crates/notebook-doc/src/pool_state.rs:341`) explicitly clears `message.changes = Vec::<Vec<u8>>::new().into()` before passing to Automerge. The `heads`, `need`, and `have` fields are preserved by omission so the sync handshake still completes (bloom-filter exchange, ACKs); only the change payload is dropped.

This is three different ingress shapes for what looks like one protocol. `PoolDoc`'s read-only mode is the most aggressive: a malicious peer cannot even cause Automerge to evaluate the changes; the strip happens before any apply.

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

### Kernel crash and relaunch

1. Kernel dies mid-execution. Runtime agent writes `RuntimeStateDoc.kernel.lifecycle = "Error"`, status of in-flight execution = "error".
2. User clicks "Restart kernel." Daemon spawns a fresh runtime agent. New agent connects, sets lifecycle through Launching → Connecting → Running.
3. `NotebookDoc` is unchanged. All cell sources, structure, metadata are still there. `RuntimeStateDoc.executions` still contains the failed execution. Cells continue to point at it via `execution_id`, so the failed output is still rendered until the next execution overwrites it.

### Pool failure affects all rooms

1. UV pool prewarm fails because `default_packages` contains a typo'd package name.
2. `Daemon::update_pool_doc` writes `PoolDoc.uv.error = "could not resolve package 'numpyy'"`, `error_kind = "invalid_package"`, `failed_package = "numpyy"`.
3. `pool_doc_changed.send(())` fans out to every peer subscribed in `peer_loop.rs`. That includes peers attached to notebooks via `NotebookSync`, and peers attached via `Pool` handshakes (system tray, env tools).
4. The frontend `usePoolState` hook re-renders the pool banner. The banner appears once per app instance, not once per open notebook.

## Open questions

1. **Should server-side path enforcement land for `RuntimeStateDoc` editor writes?** Today the WASM handle is the gatekeeper. A custom client that crafted change bytes targeting `executions/*/status` would pass the frame validator. The identity ADR explicitly defers this; the question is whether it should land before any deployment that admits browser clients without a vetted WASM build.
2. **Is `last_saved` in the right document?** It lives in `RuntimeStateDoc`, which does not persist. The justification in the field's doc comment is that it tracks ephemeral save bookkeeping, not document schema. But the field survives only as long as the room is open, which means a room reopened from disk has no record of when it was last saved. If the answer is "use mtime on the `.ipynb`," that should be explicit.
3. **Is `cells[cell_id].execution_count` in the right document?** Today it lives in `NotebookDoc` as a JSON-encoded string ("5", "null") for nbformat round-trip. Live execution counts live in `RuntimeStateDoc.executions[execution_id].execution_count`. The frontend has to know to consult the live source first and fall back to the legacy field. Splitting one concept across two documents creates a stale-on-reload hazard.
4. **`comms/*/outputs` is inline manifests, not blob refs.** Most output payloads in `RuntimeStateDoc.executions/*/outputs` go through the blob store; comm outputs (the OutputModel widget) inline their manifests. The reason is that comm outputs are scoped to a widget, not a cell, and don't go through the cell output path. Whether the comm-outputs storage should converge with execution outputs is open.
5. **`PoolDoc` per-pool-type vs per-pool-instance.** UV / Conda / Pixi are hard-coded top-level keys. Adding a new env manager (mamba, rattler, future) requires a schema change, not data. A keyed map `pools/{kind}` would be more extensible; the trade-off is that schema-versioned hard-coded keys make pool absence explicit in the type rather than a missing entry. Note also that `PoolDoc` has no `schema_version` field at all (`NotebookDoc` is v4, `RuntimeStateDoc` is v2); a future incompatible change has no version pin to negotiate against.
6. **What happens to `RuntimeStateDoc` on schema bump?** v2 today. The bump path is "discard and re-seed" because there is no persisted state. That works as long as no consumer treats `RuntimeStateDoc` as durable. If a future feature (e.g., persistent execution history across daemon restart) adds a persistence layer, the schema-bump strategy needs a migration story.
7. **Cross-document heads correlation.** A snapshot for replay or audit would want to pin (`NotebookDoc` heads, `RuntimeStateDoc` heads) as a pair. The desktop daemon does not produce or store this pair anywhere; the `execution_id` pointer in `NotebookDoc` references a key in `RuntimeStateDoc`, but neither doc records the other's heads. The parked hosted-room prototype at `apps/notebook-cloud/` does store both hashes together in the D1 catalog, which suggests the snapshot-publishing layer is where the correlation eventually needs to live in the desktop too.
8. **`PoolDoc` does not participate in the v1 clone-preview validator.** Because all changes are stripped on ingress, the principal-forgery problem doesn't arise. But the validator's absence means a malicious peer's stripped changes still contribute to the bloom-filter handshake. Probably benign; worth noting.

## Implications for distributed deployment

The split was designed for the desktop topology (one daemon per user, same-UID trust). In a hosted multi-user deployment:

- **`PoolDoc` does not make sense per-room or per-user.** Pool state is a property of the host's prewarm infrastructure. Hosted deployments either replace `PoolDoc` with a deployment-level "pools and quotas" doc, or drop it entirely if hosted runtimes don't prewarm on the user's behalf.
- **`RuntimeStateDoc`'s ephemeral semantics fit hibernating rooms badly.** A room that hibernates and rehydrates wants its execution history back. Either `RuntimeStateDoc` persists, or `ExecutionStore` becomes the canonical source and `RuntimeStateDoc` is a projection. The desktop's "throw it away on eviction" choice has to flip.
- **`NotebookDoc`'s multi-writer model already fits.** Multi-user editing of cells is what the trust model carves out for editor-scope peers.
- **The widget-subtree write exception becomes a security-critical path.** On desktop, same-UID trust means a misbehaving editor is the user's own problem. In a multi-user room, an editor peer writing outside `comms/*/state/*` is privilege escalation. The deferred server-side path enforcement becomes mandatory rather than optional.
- **`cell.execution_id` pointing across documents survives.** It is a string scalar; it does not depend on local addressing.

## References

- `crates/notebook-doc/src/lib.rs:18-40` - NotebookDoc schema v4.
- `crates/notebook-doc/AGENTS.md` - mutation rules for NotebookDoc.
- `crates/runtime-doc/src/doc.rs:8-73` - RuntimeStateDoc schema v2.
- `crates/notebook-doc/src/pool_state.rs:8-27, :128-141` - PoolDoc schema. The doc-comment at 8-27 names `uv` and `conda` only; the live scaffold at 128-141 also includes `pixi` and a per-pool `failed_package` field (`pool_state.rs:52, :223`). The doc-comment is stale.
- `crates/notebook-wire/src/lib.rs:9-44` - frame type constants and per-type caps.
- `crates/notebook-wire/AGENTS.md` - wire protocol overview.
- `crates/runtimed/src/notebook_sync_server/peer_loop.rs` - the sync select loop holding three peer-state objects.
- `crates/runtimed/src/notebook_sync_server/peer_notebook_sync.rs` - NotebookDoc ingress validator.
- `crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs:80-107` - RuntimeStateDoc clone-preview validator and save-fingerprint comparison.
- `crates/runtimed/src/notebook_sync_server/peer_pool_sync.rs` - PoolDoc fan-out across all connected peers.
- `crates/runtimed/src/notebook_sync_server/persist.rs` - NotebookDoc `.automerge` debouncer.
- `crates/runtimed/src/daemon.rs:4419-4422` - the comment that records "RuntimeStateDoc is not persisted."
- `docs/architecture/identity-and-trust.md` - the trust scopes that the three-document split makes expressible.
