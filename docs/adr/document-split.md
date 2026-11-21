# The Document Split

**Status:** Draft, updated 2026-09-17. Describes the four notebook-room
documents plus daemon-scoped `PoolDoc`; local recovery follows
[room source lifecycle](room-source-lifecycle-and-file-recovery.md).

[ADR 0002](0002-comms-document-split.md) extended the original three-document
split by moving mutable widget state into `CommsDoc`; this ADR records the
current boundaries across all five documents.

## Context

nteract syncs state across five separate Automerge documents split into two
scopes:

- **Notebook-room documents** belong to one notebook collaboration room:
  `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`, and `CommentsDoc`.
- **Daemon-scoped documents** fan out to local room peers because they affect
  the UI, but do not belong to room identity. `PoolDoc` is the current example.

Current document set:

- **`NotebookDoc`** (`crates/notebook-doc/src/lib.rs`) — one per room. Cells,
  source text, notebook metadata, and attachments. Schema v5. Wire frame `0x00`
  (`AutomergeSync`).
- **`RuntimeStateDoc`** (`crates/runtime-doc/src/doc.rs`) — one per room. Kernel
  lifecycle, execution queue, executions and outputs, env-sync, trust, project
  context, and widget comm topology/routing. Schema v2. Wire frame `0x05`
  (`RuntimeStateSync`).
- **`CommsDoc`** (`crates/runtime-doc/src/comms.rs`) — one per room. Mutable
  widget comm state keyed by comm ID; `RuntimeStateDoc` remains topology and
  membership truth. Schema v1. Wire frame `0x09` (`CommsDocSync`).
- **`CommentsDoc`** (`crates/comments-doc/src/lib.rs`) — one per room. Durable
  collaboration comments sidecar persisted separately from the notebook. Clients
  render optimistic edits; ingress validates actor labels and scope with no
  daemon finalization step, projecting attribution from admitted change actors.
  Schema v1. Wire frame `0x0a` (`CommentsDocSync`).
- **`PoolDoc`** (`crates/notebook-doc/src/pool_state.rs`) — one per daemon. UV,
  Conda, and Pixi prewarm pool counters, errors, and retry timers. No schema
  version. Wire frame `0x06` (`PoolStateSync`).

Peers subscribe over typed-frame handshake channels. `NotebookSync` (and
`OpenNotebook`, `CreateNotebook`, `OpenHostedNotebook`) brings up all four room
documents on one socket, plus `PoolDoc` on local daemons because the peer loop
subscribes to `pool_doc_changed` regardless of room. The `Pool` handshake is a
separate JSON-IPC channel for pool status, env claims, and daemon admin; it does
not carry typed-frame Automerge sync. Per-frame caps live in
`crates/notebook-wire/src/lib.rs`.

Each document has its own permissions, write authority, lifetime, persistence,
identity, and fan-out scope. Both local desktop daemons and hosted cloud rooms
run on the four room documents; each decision below notes where local and hosted
persistence differ.

Neighbors:

- `docs/adr/0002-comms-document-split.md` — extraction of mutable widget state
  into `CommsDoc`.
- `docs/adr/typed-frame-v4-wire-protocol.md` — byte framing carrying each
  document's sync stream.
- `docs/adr/runtime-state-document-identity.md` — `NotebookDoc` pointer to its
  associated `RuntimeStateDoc`.
- `docs/adr/execution-pipeline.md` — how `RuntimeStateDoc` is written during
  cell execution.
- `docs/adr/blob-storage-and-content-addressing.md` — out-of-band storage for
  output payloads.
- `docs/adr/identity-and-trust.md` — connection scopes that this split makes
  expressible.
- `docs/memos/runtime-writer-decomposition.md` — internal write APIs within
  these document boundaries.

## Decision 1: Separate documents, separate sync streams, separate frame types

Each document syncs on its own Automerge channel with its own peer-state object
and frame type. The peer loop in
`crates/runtimed/src/notebook_sync_server/peer_loop.rs` holds five independent
`sync::State` values:

```rust
let InitialSyncState { mut peer_state } =      // NotebookDoc
    send_initial_notebook_doc_sync(&mut writer, room).await?;
let mut state_peer_state = sync::State::new(); // RuntimeStateDoc
let mut comms_peer_state = sync::State::new(); // CommsDoc
let mut comments_peer_state = sync::State::new(); // CommentsDoc
let mut pool_peer_state = sync::State::new();  // PoolDoc
```

Each ingress path has its own handler and validator
(`handle_notebook_doc_frame`, `handle_runtime_state_frame`,
`handle_comms_doc_frame`, `handle_comments_doc_frame`, `handle_pool_state_frame`)
and broadcast stream (`changed_tx`, `state_changed_tx`, `comms_changed_tx`,
`comments_changed_tx`, `pool_doc_changed`). Inside `PeerWriter`, reliable frames
(`Response`, `SessionControl`, document sync, blob replies) are separated from
ephemeral presence and broadcast traffic. Reliable document sync streams still
share one reliable egress lane; `peer-egress-lanes.md` covers any finer-grained
control/resync split.

Five properties require physical wire separation:

1. **Different write authority.** `NotebookDoc` is multi-writer for editor and
   owner peers. `RuntimeStateDoc` is coordinator-authored for execution intent
   and room facts, and runtime-peer authored for policy-allowed lifecycle,
   progress, outputs, and comm topology. `CommsDoc` carries editor, owner, and
   runtime-peer widget state gated by `RuntimeStateDoc` topology. `PoolDoc` is
   daemon-only, stripping all client changes at ingress (`pool_state.rs:341`,
   `message.changes = Vec::<Vec<u8>>::new().into()`).
2. **Different trust scopes.** `identity-and-trust.md` Decision 5 carves four
   scopes along these exact boundaries: `viewer` reads room docs; `editor`
   writes allowed `NotebookDoc` fields and `CommsDoc` state; `runtime_peer`
   writes progress and outputs for accepted executions without editing
   `NotebookDoc` or creating execution intent; `owner` writes allowed notebook
   fields and manages ACLs without implying runtime authorship. `PoolDoc` is
   daemon-write-only for every scope.
3. **Different lifetimes and durability.** Local `NotebookDoc` recovers via an
   append-only journal and `.ipynb` checkpoints; local `RuntimeStateDoc` and
   `CommsDoc` are live room state rebuilt on load; `CommentsDoc` persists as a
   durable sidecar (`crates/runtimed/src/notebook_sync_server/comments_store.rs`);
   `PoolDoc` lives for the daemon's lifetime. Hosted rooms checkpoint all four
   room documents together (Decision 4).
4. **Different fan-out scopes.** `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`,
   and `CommentsDoc` fan out only to peers attached to that room. `PoolDoc` fans
   out to all local notebook-room typed peers; `Handshake::Pool` clients use
   JSON-IPC instead.
5. **Different traffic shapes (secondary).** Write cadences differ, but
   projection efficiency comes from changesets, narrow stores, and independent
   streams — not from splitting documents as a rendering workaround.

The split is not bandwidth optimization. It makes the trust model expressible at
the frame layer without path-level Automerge ACLs, which Automerge does not
provide.

## Decision 2: `NotebookDoc` carries durable per-cell state; `RuntimeStateDoc` carries per-execution state

The cleavage line is what must survive a kernel restart, a daemon restart, and a
save-to-`.ipynb` round trip. (Hosted rooms checkpoint `RuntimeStateDoc` and
`CommsDoc` for live-room hibernation and publish bundles, but the schema split
follows the same durable-vs-execution boundary.)

**`NotebookDoc` (schema v5, `crates/notebook-doc/src/lib.rs`):**

- `cells/{cell_id}/`: `id`, `cell_type`, `position` (fractional-index hex
  string), `source` (Automerge Text), `metadata`, `resolved_assets`,
  `attachments`, `execution_count` (legacy JSON-encoded string for nbformat
  round-trip).
- `cells/{cell_id}/execution_id`: pointer stamped by the daemon at queue time —
  the only runtime-state pointer inside `NotebookDoc`.
- `metadata/`: `runtime`, `kernelspec`, `language_info`, `runt` (deps, trust,
  cell-execution metadata), legacy `notebook_metadata` JSON string.
- Roots: `schema_version`, `notebook_id`, `runtime_state_doc_id`,
  `comms_doc_id`.

**`RuntimeStateDoc` (schema v2, `crates/runtime-doc/src/doc.rs`):**

- `kernel/`: lifecycle (`NotStarted`, `AwaitingTrust`, `AwaitingEnvBuild`, ...,
  `Running`, `Error`, `Shutdown`), activity (`Idle` / `Busy`), `error_reason`,
  `name`, `language`, `env_source`.
- `queue/`: `executing_execution_id`, `queued_execution_ids`.
- `executions/{execution_id}/`: `status` (`queued` / `running` / `done` /
  `error`), `execution_count`, `success`, `outputs` (map of `{output_id}` ->
  inline manifest with blob refs), `seq`, `source` (audit log of executed text).
- `env/`: `in_sync`, added/removed packages, `channels_changed`, `deno_changed`,
  latest flattened env-progress event.
- `trust/`: `status`, `needs_approval`, approved dependency lists per package
  manager.
- `project_context/`: `state`, `observed_at`, `kind`, `paths`, parsed dependency
  lists.
- `display_index/{display_id}/{execution_id\0output_id}`: reverse index routing
  `update_display_data` across executions.
- `comms/{comm_id}/`: `target_name`, `model_module`, `model_name`, `outputs`
  (inline manifests for `OutputModel` widgets), `seq`, `capture_msg_id`.
- `last_saved`: ISO timestamp of last save (ephemeral bookkeeping; see
  [Open Follow-ups](#open-follow-ups)).

**`CommsDoc` (schema v1, `crates/runtime-doc/src/comms.rs`):**

- `comms/{comm_id}/state/{key}`: mutable widget trait values authored by the
  runtime and editor/owner peers.
- `schema_version`.

**Placement test:** If executing a cell must wait on a field before producing
output, it is durable and belongs in `NotebookDoc`. If kernel replay must forget
it on restart, it belongs in `RuntimeStateDoc`. This matches nbformat: `.ipynb`
files carry cell source, structure, metadata, and static output snapshots, never
queue state or env-sync diffs. Loading `.ipynb` imports legacy outputs into
synthetic executions in `RuntimeStateDoc`.

### Cross-boundary pointers: `cell.execution_id` and document IDs

A cell's current outputs resolve from `NotebookDoc.cells/{cell_id}/execution_id`
into `RuntimeStateDoc.executions/{execution_id}/outputs`. The daemon stamps this
pointer at queue time (`NotebookDoc::set_execution_id`, `lib.rs:1707`).
`clear_outputs` sets the pointer to null and resets legacy `execution_count`
without deleting the execution entry in `RuntimeStateDoc` (`lib.rs:1736`). The
pointer survives `.ipynb` export; the live execution record does not.

Document-level pairing uses two roots in `NotebookDoc`:

- `NotebookDoc.runtime_state_doc_id` (`runtime-state-document-identity.md`)
  identifies the paired `RuntimeStateDoc`. `RuntimeStateDoc` carries its own
  `runtime_state_doc_id` with no notebook backlink, so it can later back
  markdown or standalone runtimes. It never stores runtime heads in
  `NotebookDoc`.
- `NotebookDoc.comms_doc_id` (ADR 0002) identifies the paired `CommsDoc`.

## Decision 3: Write authority is per-document; `RuntimeStateDoc` separates runtime authority from widget state

`NotebookDoc` is multi-writer. Editor and owner peers (desktop UI, MCP agents,
daemon formatters and file-watcher reloads) author changes distinguished by
actor labels (`identity-and-trust.md` Decision 1). Automerge merges concurrent
edits.

`RuntimeStateDoc` has two authoritative runtime writer paths. The coordinator
creates execution entries and queue order via `ExecuteCell` / `RunAllCells`;
runtime peers advance only accepted entries. Mutable widget state lives in
`CommsDoc`, not `RuntimeStateDoc`.

1. **Daemon (`runtimed:state`, `crates/runtime-doc/src/doc.rs:344`):** writes
   kernel lifecycle (`kernel_state.rs`, `runtime_bridge.rs`), queue mutations,
   execution entries, status transitions, IOPub outputs (`stream_committer.rs`,
   `display_update_committer.rs`), env-sync, trust, and project context.
2. **Runtime agent / runtime peer (`crates/runtimed/src/runtime_agent.rs:96`):**
   local runtime agents connect over `Handshake::RuntimeAgent`
   (`crates/notebook-protocol/src/connection/handshake.rs`); hosted runtime
   peers connect via scoped room sync. Both may publish lifecycle, progress,
   outputs, `display_index`, and comm topology for accepted executions. The
   shared policy rejects newly created execution or queue entries, and local
   ingress rejects frames whose agent ID does not match room provenance
   (`crates/runtimed/src/notebook_sync_server/peer_runtime_agent.rs:47-63`).

`CommsDoc` accepts mutable widget state from editor/owner peers and the runtime.
The runtime forward path checks `RuntimeStateDoc.comms/*` topology before
sending any `CommsDoc` state to a kernel.

`PoolDoc` is daemon-only; client changes are stripped at ingress
(`pool_state.rs:341`).

### Enforcement map

| Target | Guard | Location |
|---|---|---|
| `NotebookDoc` viewer writes | Frame-level scope check (`identity-and-trust.md` Decision 5) | `peer_notebook_sync.rs::handle_notebook_doc_frame` |
| `NotebookDoc` actor forgery | Clone-preview validator | `peer_notebook_sync.rs` (mirrors `peer_runtime_sync.rs:80-107`) |
| `RuntimeStateDoc` editor/owner writes | Shared policy rejects non-runtime-peer writes (widget state goes to `CommsDoc`) | `crates/runtime-doc/src/policy.rs`, `peer_runtime_sync.rs`, hosted WASM room host |
| `RuntimeStateDoc` actor forgery | Clone-preview validator | `peer_runtime_sync.rs:80-107` |
| `CommsDoc` orphan state | Runtime forward path and orphan GC check `RuntimeStateDoc` topology | `peer_comms_sync.rs`, `runtime_agent.rs`, `crates/runtime-doc/src/comms.rs` |
| `PoolDoc` client writes | Strip all changes at ingress | `pool_state.rs:341` |
| Runtime-agent provenance mismatch | Reject on agent ID mismatch | `peer_runtime_agent.rs:47-63` |

Provenance filtering and policy enforcement are distinct gates: provenance
checks who may write under the runtime-agent actor, while the shared policy
checks which paths each scope may mutate.

Internally, `RuntimeStateDoc` exposes two ingress APIs
(`crates/runtime-doc/src/doc.rs:2720`, `:2789`): `receive_sync_message` (read-only,
strips changes for clone-preview validation) and
`receive_sync_message_with_changes_recovering` (writable, applies validated
changes). The server runs clone-preview with the read-only API before
committing with the writable one; library callers invoke the writable API
directly.

## Decision 4: Persistence is per-document and asymmetric

Persistence differs by document in local daemon rooms, whereas hosted rooms
checkpoint all four room documents together through
`apps/notebook-cloud/src/room-materializer.ts`:

| Document | Local daemon room | Hosted room |
|---|---|---|
| `NotebookDoc` | Append-only recovery journal for persistent and untitled rooms; `.ipynb` is a checkpoint; legacy `.automerge` is untitled migration fallback; volatile for explicit ephemeral rooms ([room source lifecycle](room-source-lifecycle-and-file-recovery.md)) | Persisted in R2 snapshot bundle and DO checkpoint cache |
| `RuntimeStateDoc` | Not persisted standalone; rebuilt on room load from `.ipynb` outputs and durable execution records | Persisted in R2 snapshot bundle and DO checkpoint cache |
| `CommsDoc` | Not persisted standalone; reconstructed from `.ipynb` widget metadata on load and dropped on room eviction | Persisted in R2 snapshot bundle and DO checkpoint cache |
| `CommentsDoc` | Persisted sidecar at `~/.cache/<namespace>/comments/<sha256-of-comments-doc-id>.automerge` (sibling of `notebook-docs/`); ingress validates actor labels and scope (`peer_comments_sync.rs`) | Persisted in hosted room checkpoint |
| `PoolDoc` | Not persisted; rebuilt from `PoolDoc::new()` on startup and hydrated on each tick (`Daemon::update_pool_doc`) | Not applicable (daemon-scoped) |

Local output durability sits outside live `RuntimeStateDoc`:

- `ExecutionStore` (`crates/runtimed-client/src/execution_store.rs`) writes
  terminal execution records to disk on each terminal transition
  (`peer_runtime_sync.rs::persist_terminal_execution_records`).
- Saving to `.ipynb` walks `RuntimeStateDoc.executions[cell.execution_id].outputs`
  and writes them into the nbformat output array.
- Output payloads (images, large text) live in a SHA-256 content-addressed
  `BlobStore`, referenced by hash from output manifests. Blobs survive across
  executions and rooms; blob GC scans live rooms and persisted notebook docs for
  resolved-asset and attachment refs.

A persistent local notebook therefore spans a recovery journal, an optional
`.ipynb` checkpoint, a comments sidecar, execution records, and referenced
blobs. The live `RuntimeStateDoc` is not itself a recovery journal.

## Decision 5: Lifecycle and identity per document

| Document | Created | Identity & seed actor | Dropped / GC'd |
|---|---|---|---|
| `NotebookDoc` | Room load (recovery, file import, or fresh seed) | Per-notebook UUID; seed `nteract:notebook-schema:v5` | Live doc dropped on room eviction; durable recovery follows source lifecycle |
| `RuntimeStateDoc` | Room load (fresh seed; legacy `.ipynb` outputs imported as synthetic executions at `load.rs:709, :731, :741`) | `NotebookDoc.runtime_state_doc_id`; seed `nteract:runtime-state-schema:v2`; daemon actor `runtimed:state`; runtime-agent actor (`runtime_agent.rs:96`) | Room eviction |
| `CommsDoc` | Room load (fresh seed; hydrated from `.ipynb` widget metadata if present) | `NotebookDoc.comms_doc_id`; seed `nteract:comms-doc-schema:v1` | Room eviction |
| `CommentsDoc` | Room load (disk sidecar or fresh seed) | Per-notebook sidecar; seed `nteract:comments-doc-schema:v1`; ingress validates actor labels and scope | Live doc dropped on eviction; disk sidecar persists |
| `PoolDoc` | Daemon startup | Singleton; daemon actor `runtimed:pool` | Daemon shutdown |

Every peer scaffolds from frozen genesis bytes (`assets/notebook_genesis_v5.am`,
`assets/runtime_state_genesis_v2.am`, `assets/comms_doc_genesis_v1.am`) so
top-level object IDs (`cells`, `metadata`, `kernel`, `queue`, `executions`,
`comms`, ...) match before the first sync round. Inside `NotebookDoc`, the
`notebook-doc/AGENTS.md` rule "exactly one peer creates document structure"
governs non-genesis maps (the daemon scaffolds `cells` from empty).

Peer disconnect schedules kernel teardown without immediately evicting the room.
`peer_eviction.rs` keeps the room, file binding, and save services intact; a
separate resident-room reaper in `daemon.rs` checks idle state and durability
before reaping. See [room source lifecycle](room-source-lifecycle-and-file-recovery.md).

## Decision 6: Sync read-only enforcement is per-document

Each document's ingress makes its own choice on client changes:

- **`NotebookDoc::receive_sync_message_with_changes_recovering`**: runs the
  clone-preview actor validator (`identity-and-trust.md` Decision 3), then
  applies changes.
- **`RuntimeStateDoc::receive_sync_message_with_changes_recovering`**: runs the
  actor validator, then enforces the shared runtime-doc policy for allowed
  runtime-peer paths and rejects widget state writes meant for `CommsDoc`.
- **`CommsDoc::receive_sync_message_with_changes_recovering`**: applies mutable
  widget state changes; runtime forwarding and orphan cleanup defer to
  `RuntimeStateDoc` topology.
- **`CommentsDoc::receive_sync_message_with_changes_recovering`**: applies
  optimistic comment edits after validating change actor labels against the
  connection principal and stripping writes from unauthorized scopes.
- **`PoolDoc::receive_sync_message`** (`crates/notebook-doc/src/pool_state.rs:341`):
  clears `message.changes = Vec::<Vec<u8>>::new().into()` before Automerge sees
  the frame. Preserving `heads`, `need`, and `have` lets bloom-filter sync and
  ACKs finish while dropping every client change before evaluation.

## Worked examples

### Editing a cell while a kernel is busy

1. The user types in a code cell. CodeMirror dispatches a transaction and calls
   `handle.splice_source(cell_id, ...)`, mutating only
   `NotebookDoc.cells[cell_id].source`.
2. The flush debouncer sends a `0x00` sync frame. `AUTOMERGE_SYNC` is capped at
   64 MiB with a 16 MiB warning (`crates/notebook-wire/src/lib.rs:61-64`); the
   100 MiB `MAX_FRAME_SIZE` is only the outer ceiling for unknown frame types.
3. Meanwhile, the kernel streams stdout. The runtime agent writes
   `RuntimeStateDoc.executions[exec_id].outputs[output_id]` and sends `0x05`.
4. Both writes land concurrently over independent `sync::State` channels and
   update the frontend cell and output stores independently.

### Save and reload

1. On Cmd+S, the daemon walks `RuntimeStateDoc.executions` via each cell's
   `NotebookDoc` `execution_id`, materializes outputs into nbformat, and writes
   `.ipynb` to disk.
2. The daemon updates `RuntimeStateDoc.last_saved`.
3. Closing the notebook tears down the kernel, but the room may stay resident.
   Later reaping or daemon restart drops live documents while durable recovery
   files remain.
4. Reopening rejoins a resident room or cold-loads via the source lifecycle,
   creating synthetic executions in `RuntimeStateDoc` for imported `.ipynb`
   outputs (`crates/runtimed/src/notebook_sync_server/load.rs`).
5. If `.ipynb` contains
   `metadata.widgets["application/vnd.jupyter.widget-state+json"]`, the loader
   imports widget topology into `RuntimeStateDoc.comms`, externalizes large
   buffers into `BlobStore`, and writes mutable state into `CommsDoc`. Publish
   snapshots can thus carry widget models without a live kernel.

### Kernel crash and relaunch

1. The kernel dies mid-execution. The runtime agent sets
   `RuntimeStateDoc.kernel.lifecycle = "Error"` and marks the in-flight
   execution `"error"`.
2. On "Restart kernel", the daemon spawns a fresh runtime agent that transitions
   lifecycle through `Launching` -> `Connecting` -> `Running`.
3. `NotebookDoc` is untouched. `RuntimeStateDoc.executions` keeps the failed
   execution, and the cell's `execution_id` still renders its error output until
   the next run overwrites it.

### Pool failure affects all rooms

1. UV pool prewarm fails on a typo (`"numpyy"`) in `default_packages`.
2. `Daemon::update_pool_doc` writes `PoolDoc.uv.error = "could not resolve package 'numpyy'"`,
   `error_kind = "invalid_package"`, and `failed_package = "numpyy"`.
3. `pool_doc_changed.send(())` fans out `PoolStateSync` to every local notebook
   typed peer (`Pool` handshake clients use JSON-IPC instead).
4. `usePoolState` re-renders one pool banner per app instance, not per notebook.

## Implications for hosted deployment

Because hosted cloud rooms run multi-user rather than single-UID desktop:

- **`PoolDoc` stays local.** Prewarm pool state belongs to a host daemon, not a
  hosted room. Hosted deployments either drop it or replace it with a
  deployment-level pools-and-quotas surface.
- **Hosted rooms persist all four room documents.**
  `RoomMaterializer.checkpoint` persists `NotebookDoc`, `RuntimeStateDoc`,
  `CommsDoc`, and `CommentsDoc` for live-room recovery and publish bundles.
- **`NotebookDoc`'s multi-writer model carries over directly.** Editor-scope
  peers edit cells concurrently under room ACLs.
- **`CommsDoc` membership is a security boundary.** Without same-UID trust,
  arbitrary `CommsDoc` entries must stay inert unless `RuntimeStateDoc` topology
  proves the comm belongs to the active runtime.
- **`cell.execution_id` carries over unchanged.** It is an opaque string scalar
  independent of local addressing.

## Open Follow-ups

- **Resolve `RuntimeStateDoc.last_saved` durability:** `last_saved` lives in
  `RuntimeStateDoc`, which does not persist locally, so reopening a room from
  disk loses its last-saved timestamp. Either derive it explicitly from `.ipynb`
  mtime or move it to durable room metadata.
- **Unify split `execution_count` storage:** `NotebookDoc.cells[cell_id].execution_count`
  stores a legacy JSON-encoded string (`"5"`, `"null"`) for nbformat round-trip,
  while live counts live in `RuntimeStateDoc.executions[execution_id].execution_count`.
  This forces dual-source frontend reads and creates a stale-on-reload hazard.
- **Version and generalize `PoolDoc`:** `PoolDoc` has no `schema_version` field
  (unlike `NotebookDoc` v5 and `RuntimeStateDoc` v2) and hard-codes `uv`,
  `conda`, and `pixi` as top-level keys. Add a version pin and decide whether to
  replace hard-coded keys with a `pools/{kind}` map.

## Open Questions

1. **Keeping future `RuntimeStateDoc` ingress paths policy-wrapped:** Any future
   import, bridge, or remote-runtime write path must route through the shared
   runtime-doc policy rather than creating a second authorization surface.
2. **Converging `comms/*/outputs` with execution blob refs:** Cell outputs in
   `RuntimeStateDoc.executions/*/outputs` use blob refs, while `OutputModel`
   comm outputs inline manifests. Decide whether comm outputs should converge on
   the same blob path.
3. **Migrating hosted `RuntimeStateDoc` checkpoints across schema changes:**
   Local rooms rebuild `RuntimeStateDoc` on load, but hosted rooms persist its
   bytes. Future schema bumps need a checkpoint migration strategy alongside
   local execution records and `.ipynb` imports.
4. **Cross-document heads correlation at publish/export:** Replay and audit need
   a correlated `(NotebookDoc heads, RuntimeStateDoc heads)` pair. Keeping heads
   out of live documents avoids write amplification on every edit; hosted
   publish already stores both hashes in D1 alongside `latest_revision_id`, and
   a future desktop versioned export should follow the same boundary.
5. **`PoolDoc` bloom-filter participation:** Because `PoolDoc` strips client
   changes before Automerge apply, it skips the v1 clone-preview validator;
   stripped peer changes still participate in bloom-filter negotiation. Verify
   whether this remains benign.

## References

- `crates/notebook-doc/src/lib.rs` — `NotebookDoc` schema v5.
- `crates/notebook-doc/AGENTS.md` — mutation rules for `NotebookDoc`.
- `crates/runtime-doc/src/doc.rs` — `RuntimeStateDoc` schema v2.
- `crates/runtime-doc/src/comms.rs` — `CommsDoc` schema v1.
- `crates/notebook-doc/src/pool_state.rs:8-39, :110-153, :234-251` — `PoolDoc`
  schema (`uv`, `conda`, `pixi` counters and per-pool errors including
  `failed_package`).
- `crates/notebook-wire/src/lib.rs:9-44` — frame type constants and per-type
  caps.
- `crates/notebook-wire/AGENTS.md` — wire protocol overview.
- `crates/runtimed/src/notebook_sync_server/peer_loop.rs` — sync select loop
  holding per-document peer-state objects.
- `crates/runtimed/src/notebook_sync_server/peer_notebook_sync.rs` —
  `NotebookDoc` ingress validator.
- `crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs:80-107` —
  `RuntimeStateDoc` clone-preview validator and save-fingerprint comparison.
- `crates/runtimed/src/notebook_sync_server/peer_pool_sync.rs` — `PoolDoc`
  fan-out across connected peers.
- `crates/runtimed/src/notebook_sync_server/persist.rs` — `NotebookDoc`
  `.automerge` debouncer.
- `crates/runtimed/src/notebook_sync_server/recovery.rs` — recovery journal
  implementation.
- `apps/notebook-cloud/src/room-materializer.ts` — hosted checkpoints for all
  four room documents.
- `docs/adr/identity-and-trust.md` — trust scopes backed by the document split.
