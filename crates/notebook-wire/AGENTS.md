# Wire protocol

The notebook app and the runtimed daemon communicate over a Unix socket (named pipe on Windows) using length-prefixed, typed frames. Traffic classes: Automerge sync, request/response, runtime/pool/comments state sync, broadcasts, and presence/session-control.

Scope: `crates/notebook-wire/`, `crates/notebook-doc/`, `crates/notebook-protocol/`, `crates/notebook-sync/`, `crates/runtime-doc/`, `crates/runtimed/src/notebook_sync_server/`, `crates/runtimed/src/requests/`, `packages/runtimed/src/{transport,protocol-contract,request-types}.ts`, `apps/notebook/src/lib/{frame-pipeline,notebook-frame-bus}.ts`.

## Crate boundaries

- `notebook-wire` — frame bytes, preamble constants, frame caps, typed-frame enum, session-control status shapes.
- `notebook-protocol` — handshakes and JSON wire types: `NotebookRequest`, `NotebookResponse`, `NotebookBroadcast`, runtime-agent envelopes.
- `notebook-doc` — `NotebookDoc` Automerge schema. `SCHEMA_VERSION` bumps only with a migration that preserves real user data.
- `runtime-doc` — `RuntimeStateDoc` and `CommsDoc` schemas. RuntimeStateDoc is read-only to regular clients; the local daemon / room host own coordinator facts, and runtime peers may write policy-allowed lifecycle, progress, output, and comm topology for accepted work. CommsDoc carries mutable widget state written by editor/owner clients and runtime peers.

## Versioning

Two independent integers, separate from the artifact version:

- **`PROTOCOL_VERSION`** (`connection/handshake.rs`, currently `4`) governs wire compatibility. Bump for framing, handshake, or serialization changes. Every connection starts with a 5-byte preamble (`0xC0DE01AC` + version byte). `Pool` stays version-tolerant so older stable apps can probe during upgrade; other channels require `MIN_PROTOCOL_VERSION..=PROTOCOL_VERSION`. Protocol v4 dropped legacy environment-sync request/response variants.
- **`SCHEMA_VERSION`** (`notebook-doc/src/lib.rs`, currently `5`) governs Automerge doc compatibility. Stored at the doc root as `schema_version`. Cells live in a fractional-indexed `Map`; `NotebookDoc` also carries `runtime_state_doc_id` so outputs and runtime lifecycle can live in the paired `RuntimeStateDoc`. Any future bump ships `migrate_vN_to_v(N+1)` that preserves user data.

Artifact versions follow standard semver. Protocol or schema bumps don't automatically force a major version bump.

### Desktop-app compatibility

The desktop app bundles its own daemon binary. Version-mismatch detection between the app and its bundled daemon compares git commit hashes (appended as `+{sha}` at build time), not semver — both always build from the same CI commit.

## Connection topology

The frontend talks to the Tauri relay through `invoke()` calls, a generation-scoped frame channel, and connection-status Tauri events. The relay is a transparent byte pipe to the runtimed socket for Automerge sync, request, runtime-state, pool-state, and presence frames; it holds no document replica of its own. Broadcasts, responses, presence, and session-control frames arrive through the unified inbound frame stream.

## Connection lifecycle

1. **Open a notebook.** The frontend invokes `open_notebook_in_new_window`; the relay connects to the daemon socket and sends the handshake. New notebook creation goes through Rust menu events (`spawn_new_notebook()` → `create_notebook_window_for_daemon()`), not a frontend `invoke()`.
2. **Handshake.** First frame is JSON:

   ```json
   { "channel": "notebook_sync", "notebook_id": "/path/to/notebook.ipynb", "protocol": "v4" }
   ```

   `Handshake` uses `#[serde(tag = "channel", rename_all = "snake_case")]`, so the wire form is flat. Optional fields (`working_dir`, `initial_metadata`) omit when `None`. Other variants: `Pool`, `SettingsSync`, `OpenNotebook { path }`, `CreateNotebook { runtime, … }`, `RuntimeAgent { … }`. `OpenNotebook` / `CreateNotebook` are the desktop paths; `NotebookSync` is used by programmatic clients (Python bindings). Blob uploads ride the `NotebookSync` channel as `PUT_BLOB` (`0x08`) frames; the localhost blob HTTP port is a separate server on a different socket, not a handshake channel.

   The daemon responds with `NotebookConnectionInfo`:

   ```json
   { "protocol": "v4", "notebook_id": "derived-id", "cell_count": 5, "needs_trust_approval": false }
   ```

   `protocol_version`, `daemon_version`, and `error` are `Option` with `skip_serializing_if` — they appear only when populated.
3. **Initial Automerge sync.** Both sides exchange sync messages until documents converge. The frontend starts empty; all state comes from the daemon. Protocol v4 clients also receive `SessionControl::SyncStatus` frames as the daemon advances notebook-doc, runtime-state, and initial-load readiness.
4. **Steady state.** All frame classes interleave: Automerge sync for edits, request/response for explicit actions, `RuntimeStateDoc` / `CommsDoc` / `PoolDoc` sync, presence, broadcasts, session-control. Confirmation waits register target-head waiters; request waits register id-keyed pending entries; command handlers return to the main frame loop after writing any immediate outbound frame. A blocking `recv()` inside a command path backpressures the socket and gets the peer dropped.
5. **Disconnection.** When the broadcast stream ends, the relay emits `daemon:disconnected`. A generation counter stops stale callbacks from an earlier connection from processing events after reconnection.

### Socket authority

The runtimed socket is **same-UID trusted**, not app-private. Unix permissions prevent cross-user access, but any same-user process holding the socket path can intentionally use the daemon. Treat `RUNTIMED_SOCKET_PATH` as a capability-bearing pointer.

| Handshake | Authority |
|-----------|-----------|
| `Pool` | Pool status, env claims/returns, daemon status/admin including shutdown |
| `SettingsSync` | Read/write sync to the live projection of canonical `settings.json`; client changes are persisted by the daemon |
| `NotebookSync` | Peer access to a notebook room and its runtime-state sync |
| `OpenNotebook` | Load or create a file-backed notebook from a path |
| `CreateNotebook` | Create an untitled or ephemeral notebook room |
| `RuntimeAgent` | Attach a runtime-agent peer to a notebook room |

A new handshake variant inherits this model. For tighter authority on a channel, design an explicit capability or guard instead of assuming "only the desktop app can reach it."

## Wire format

### Frames

Every message is length-prefixed:

```
┌──────────────┬──────────────────────┐
│ 4 bytes      │ N bytes              │
│ (big-endian  │ (payload)            │
│  u32 length) │                      │
└──────────────┴──────────────────────┘
```

Max frame: 100 MiB for data frames, 64 KiB for control/handshake frames.

Not every handshake channel uses typed frames. `NotebookSync`, `OpenNotebook`, `CreateNotebook`, and `RuntimeAgent` enter the typed-frame protocol after the handshake JSON. `Pool` and `SettingsSync` use length-prefixed JSON or binary bodies with no leading type byte; they don't carry the typed-frame enum at all.

### Typed frames

After the handshake, frames carry a leading type byte:

| Type | Name | Payload |
|------|------|---------|
| `0x00` | AutomergeSync | Binary (raw Automerge sync) |
| `0x01` | NotebookRequest | JSON |
| `0x02` | NotebookResponse | JSON |
| `0x03` | NotebookBroadcast | JSON |
| `0x04` | Presence | Binary (CBOR, `notebook_doc::presence`) |
| `0x05` | RuntimeStateSync | Binary (per-notebook `RuntimeStateDoc` Automerge sync) |
| `0x06` | PoolStateSync | Binary (per-daemon `PoolDoc` Automerge sync) |
| `0x07` | SessionControl | JSON (`SessionControlMessage`, daemon-originated readiness/status) |
| `0x08` | PutBlob | Framed binary blob upload (`PutBlobHeader` + bytes) |
| `0x09` | CommsDocSync | Binary (per-notebook `CommsDoc` Automerge sync) |
| `0x0a` | CommentsDocSync | Binary (per-notebook `CommentsDoc` Automerge sync for local notebook peers) |

| Sender | Valid types |
|--------|-------------|
| Frontend / Tauri relay | `0x00`, `0x01`, `0x04`, `0x05`, `0x06`, `0x08`, `0x09`, `0x0a` |
| Daemon notebook peer | `0x00`, `0x02`, `0x03`, `0x04`, `0x05`, `0x06`, `0x07`, `0x09`, `0x0a` |
| Runtime agent peer | `0x00`, `0x01` (RuntimeAgentRequest/Envelope), `0x02` (RuntimeAgentResponse/Envelope), `0x05`, `0x09` |

`0x0a` carries local daemon `CommentsDoc` sync. Editor/owner notebook peers may
submit tentative comment changes after actor validation; viewer and
`runtime_peer` scopes have non-empty changes stripped. Runtime-agent channels do
not participate in comments sync. Hosted cloud currently marks the frame
non-client-writable until its room materializer and policy handler land.

`NotebookRequest` / `NotebookResponse` payloads travel in flattened `NotebookRequestEnvelope` / `NotebookResponseEnvelope`. Concurrent requests carry an `id`; clients route responses by id because broadcasts, state sync, and out-of-order responses interleave freely.

### Keeping Rust and TypeScript in sync

| Source of truth | File |
|-----------------|------|
| `FrameType` constants and caps | `crates/notebook-wire/src/lib.rs`, generated into `packages/runtimed/src/wire-constants.ts` |
| Frontend `NotebookRequest` / `NotebookResponse` unions | `packages/runtimed/src/request-types.ts` |
| Discriminant lists + exhaustiveness checks | `packages/runtimed/src/protocol-contract.ts` |
| Rust ↔ TS contract test | `crates/notebook-protocol/src/protocol.rs` |

Adding or renaming a request, response, frame type, or session-control phase: update the Rust protocol and the `packages/runtimed` contract in the same patch, then run `cargo test -p notebook-protocol` and the focused package tests.

## Automerge sync

The notebook document is a CRDT shared between two peers:

- **Frontend (WASM)** — `NotebookHandle` in `crates/runtimed-wasm/`. Cell mutations apply instantly to the local WASM doc.
- **Daemon** — `NotebookDoc` in `crates/notebook-doc/`. Canonical document used for execution, output writing, and persistence.

Both sides use the workspace `automerge` dependency from the pinned `nteract/automerge` desktop patch commit. The frontend does **not** use the JS `@automerge/automerge` package for notebook state — its CRDT/string types and release cadence are a separate compatibility surface. Keeping both peers on the one Rust crate is the compatibility contract.

### Sync flow

```
user types in cell
  → CodeMirror bridge calls handle.splice_source(cell_id, index, delete_count, text)
  → WASM applies mutation locally (instant)
  → engine.scheduleFlush() (20 ms debounce) → flush_local_changes() → sync bytes
  → sendFrame(AUTOMERGE_SYNC, msg) → raw binary via tauri::ipc::Request
  → Tauri relay pipes to daemon socket
  → Daemon applies sync, updates canonical doc
  → Daemon generates reply → frame 0x00
  → Relay sends over the frame channel (raw typed bytes)
  → useAutomergeNotebook listener → handle.receive_frame(bytes)
  → WASM demuxes, returns FrameEvent[]
  → FrameEvent::SyncApplied includes a CellChangeset (field-level diff)
  → scheduleMaterialize coalesces within 32 ms:
      structural change → full materializeCells()
      output changes    → per-cell cache-aware resolution
      source/metadata/exec_count → per-cell materializeCellFromWasm() via O(1) accessors
  → React state updated via split cell store (only affected cells re-render)
  → scheduleSyncReply → 50 ms debounce → generate_sync_reply() → sendFrame()
```

### CellChangeset

After each sync, WASM computes a structural diff by walking `doc.diff(before, after)` patches (`notebook-doc/src/diff.rs`):

- `changed` — cells present before and after, with per-field flags (`source`, `outputs`, `execution_count`, `metadata`, `position`, `cell_type`, `resolved_assets`).
- `added` / `removed` — new / deleted cell IDs.
- `order_changed` — true if any position shifted or cells were added/removed.

Cost is O(delta), not O(doc). `mergeChangesets()` unions field flags and dedups added/removed across a throttle window. This is the primitive that keeps the sync pipeline incremental — the frontend knows exactly which cells changed and which fields.

## Request / response

One-shot JSON messages from client to daemon, one response each.

### Requests

| Request | Purpose |
|---------|---------|
| `LaunchKernel` | Start a kernel with env config |
| `ExecuteCell { cell_id }` | Queue a cell (daemon reads source from synced doc) |
| `ExecuteCellGuarded { cell_id, observed_heads }` | Queue only if approved notebook heads still match |
| `InterruptExecution` | SIGINT the running kernel |
| `ShutdownKernel` | Stop the kernel process |
| `RunAllCells` / `RunAllCellsGuarded { observed_heads }` | Execute all code cells in order; guarded variant checks heads |
| `SaveNotebook { format_cells, path? }` | Persist Automerge doc to `.ipynb`; optional save-as |
| `SyncEnvironment` | Hot-install packages into the running kernel's env |
| `ApproveTrust` | Sign current dependency metadata after user approval |
| `ApproveProjectEnvironment` | Record local approval for a project-file environment |
| `CloneAsEphemeral { source_notebook_id }` | Fork a loaded notebook into a new in-memory room |
| `SendComm { message }` | Comm message to the kernel (widget interactions) |
| `Complete { code, cursor_pos }` | Kernel code completions |
| `GetHistory { pattern, n, unique }` | Kernel input history |
| `GetDocBytes` | Canonical Automerge bytes to bootstrap a WASM peer |

`LaunchKernel.env_source` is a `LaunchSpec` string: `"auto"`, `"auto:uv"`, `"auto:conda"`, `"auto:pixi"`, or a concrete source like `"uv:inline"`. The daemon resolves the spec before launch; downstream responses carry a concrete `EnvSource`.

### Responses

| Response | Meaning |
|----------|---------|
| `KernelLaunched { env_source, … }` | Kernel started; resolved concrete env origin |
| `KernelAlreadyRunning { env_source, … }` | Existing kernel reused |
| `CellQueued` / `AllCellsQueued { queued }` | Queued (single / all runnable code cells) |
| `NotebookSaved { path }` / `SaveError { error }` | File written / structured save error |
| `GuardRejected { reason }` | Guarded action rejected — observed state changed |
| `NotebookCloned { notebook_id, working_dir }` | Ephemeral fork created |
| `SyncEnvironmentComplete` / `SyncEnvironmentFailed` | Hot-sync result |
| `DocBytes { bytes }` | Canonical Automerge bytes |
| `CompletionResult { items, cursor_start, cursor_end }` | Code completion |
| `HistoryResult { entries }` | Kernel input history |
| `Error { error }` | Something went wrong |

### Request flow through the stack

```
Frontend: host.transport.sendRequest({ type: "execute_cell", cell_id })
  → TauriTransport encodes NotebookRequestEnvelope with a correlation id
  → send_frame(0x01 + JSON envelope)
  → Relay: handle.forward_frame(NotebookRequest)
  → Frame 0x01 on socket
  → Daemon processes request
  → Frame 0x02 returned with matching id
  → Relay sends over the frame channel
  → TauriTransport response tap resolves the pending request by id
```

## Broadcasts

Daemon-initiated messages pushed to all connected clients; not replies to requests.

| Broadcast | Purpose |
|-----------|---------|
| `Comm { msg_type, content, buffers }` | Jupyter comm message (widget custom one-shot events). Widget state itself syncs via `CommsDoc`. |
| `EnvProgress { env_type, phase }` | Environment setup progress (`phase` flattened as `EnvProgressPhase`). `RuntimeStateDoc` is authoritative for durable env state. |

State-carrying broadcast variants (`CommSync`, kernel state, execution lifecycle, queue, outputs/display, path/autosave, env sync) were removed once Automerge docs became authoritative. The `Comm` variant is limited to custom messages (`method != "update"`) — widget state updates flow through `CommsDoc`.

### Output sync flow

```
Kernel produces output
  → Daemon intercepts Jupyter IOPub
  → Daemon writes output manifest to RuntimeStateDoc
  → RuntimeStateDoc sync produces frame 0x05
  → Relay sends over the frame channel
  → WASM handle.receive_frame() → RuntimeStateDoc merge
  → frame-pipeline.ts plans output materialization
  → UI updates
```

## Tauri channel bridge and frame bus

| Bridge | Direction | Payload | Purpose |
|--------|-----------|---------|---------|
| Frame channel | Relay → Frontend | typed frame bytes | All daemon frames via unified pipe |
| `daemon:ready` event | Relay → Frontend | `DaemonReadyPayload` | Connection established, ready to bootstrap |
| `daemon:disconnected` event | Relay → Frontend | — | Connection lost |

Outgoing frames use `sendFrame(frameType, payload)` where `payload` is `Uint8Array` via `tauri::ipc::Request`. Relay accepts frontend-originated `0x00`, `0x01`, `0x04`, `0x05`, `0x06`, `0x09`, and `0x0a`; `0x02`, `0x03`, and `0x07` are daemon-originated.

### In-memory frame bus

After WASM `receive_frame()` demuxes typed frames, broadcast and presence payloads dispatch via an in-memory pub/sub (`notebook-frame-bus.ts`) instead of Tauri webview events. This avoids an event-loop round-trip:

| Function | Purpose |
|----------|---------|
| `emitBroadcast(payload)` | Called by `useAutomergeNotebook` after WASM demux for type `0x03` frames |
| `subscribeBroadcast(cb)` | `useDaemonKernel` for ephemeral runtime events; persistent env state stays in `RuntimeStateDoc` |
| `emitPresence(payload)` | Called after WASM CBOR decode for type `0x04` frames |
| `subscribePresence(cb)` | `usePresence`, `cursor-registry` for remote cursor updates |

All dispatch is synchronous and in-process.

## Output storage

Cell outputs use inline manifests with blob offload for large payloads. When the daemon receives output:

1. Output becomes nbformat JSON, then an inline **manifest** as an Automerge Map in `RuntimeStateDoc` (`output_store.rs`).
2. Each MIME's content is a `ContentRef`: `Inline` for ≤ 1 KB, `Blob { hash, size }` for > 1 KB.
3. Blob content lives in a content-addressed **blob store** (`blob_store.rs`, SHA-256, under `runt_workspace::daemon_base_dir()/blobs`).
4. MIME types and small payloads are readable straight from the CRDT without a blob fetch.
5. Clients resolve large blobs from the daemon's HTTP blob server (`GET /blob/{hash}` on a dynamic port).

Manifests are structured Maps with compact `ContentRef` entries. MIME metadata is always available without touching the blob store.

Stream outputs (stdout/stderr) are special: text is fed through a terminal emulator (`stream_terminals`) for carriage-return and ANSI-escape handling before manifest creation. `upsert_stream_output` updates in place when consecutive stream outputs arrive.

## Notebook lifecycle

- **Autosave.** Daemon autosaves `.ipynb` on a debounce (2 s quiet, 10 s max). Explicit save (⌘S) additionally formats cells. Frontend dirty state is derived from sync/save confirmations, not a room broadcast.
- **UUID-stable rooms.** Room keys are always UUIDs. Saving an untitled notebook updates a secondary `path_index` map and the daemon-authored room state so peers can update local path tracking. The UUID never changes.
- **Crash recovery.** Untitled notebooks persist their Automerge doc to `notebook-docs/{hash}.automerge`. Before overwriting on reopen, the daemon snapshots to `notebook-docs/snapshots/`. Outputs are ephemeral (`RuntimeStateDoc`, not persisted), so snapshots hold source and metadata only.
- **Multi-window.** Multiple windows join the same room as separate Automerge peers. Each gets sync frames and broadcasts independently. The daemon tracks `active_peers` per room for eviction.

## Runtime state

### RuntimeStateDoc

State-carrying broadcasts (kernel status, env sync diff, queue) were replaced because they suffered from silent drops, no initial state for late joiners, and ordering races between windows. `RuntimeStateDoc` is a runtime-authoritative per-notebook Automerge document synced via frame `0x05` on the existing notebook connection.

Regular clients receive RuntimeStateDoc fields via normal Automerge sync, with
unexpected client changes stripped. The local daemon and hosted room host own
environment, trust, project, path/save, workstation, and schema/root facts.
Runtime peers may write policy-allowed kernel lifecycle, queue/progress,
outputs, and comm topology for accepted work. Mutable widget comm state lives in
CommsDoc. The frontend reads runtime state via `useRuntimeState()` and the
project runtime stores.

**Key files:** `crates/runtime-doc/src/doc.rs` (schema + setters), `crates/runtime-doc/src/handle.rs` (handle), `apps/notebook/src/lib/runtime-state.ts` (frontend store + hook).

### Widget comm state

Widget topology lives in `doc.comms/` in RuntimeStateDoc; mutable widget values live in CommsDoc. The daemon/runtime agent writes kernel-authored entries from IOPub, and new clients get widget topology and state through CRDT sync frames `0x05` and `0x09`. `CommSync` broadcast was removed. The `Comm` broadcast variant is limited to custom messages (ephemeral events like button clicks). Frontend-originated widget state updates write to CommsDoc, and the runtime agent diffs CommsDoc state for comm ids with RuntimeStateDoc topology before forwarding deltas to the kernel. See `src/components/widgets/AGENTS.md` for the widget-side data flow.

## Runtime agent subprotocol

Runtime agents are same-socket peers that connect with `Handshake::RuntimeAgent`. They share the framing layer but carry a different JSON subprotocol on request/response types:

| Frame | Runtime-agent payload |
|-------|-----------------------|
| `0x00` | NotebookDoc Automerge sync |
| `0x01` | `RuntimeAgentRequestEnvelope` |
| `0x02` | `RuntimeAgentResponseEnvelope` |
| `0x05` | RuntimeStateDoc Automerge sync |
| `0x09` | CommsDoc Automerge sync |

Coordinator-to-agent RPC covers kernel lifecycle and query-style operations: launch, restart, shutdown, completion, history, comm sends, interrupts, and hot environment sync. Cell execution is CRDT-driven: the coordinator writes execution entries into `RuntimeStateDoc`, and the runtime agent discovers and executes queued entries via `RuntimeStateDoc` sync.

Because the daemon socket is same-UID trusted, treat the runtime-agent handshake as a powerful attach operation. Design authority explicitly — don't rely on "only the desktop app can reach the socket."

## Invariants

- Update Rust protocol types and generated `packages/runtimed` TypeScript surfaces in the same patch.
- Run `cargo test -p notebook-protocol` for protocol-surface changes; add focused package tests when TypeScript transport or generated contracts move.
- Runtime state, outputs, queue, kernel lifecycle, trust, env drift, env progress snapshots, path, save state, and widget topology belong in `RuntimeStateDoc`; widget values belong in `CommsDoc`. Broadcasts are for ephemeral comm messages and high-frequency env progress events.
- Steady-state frame readers must keep draining. Register waiters/pending requests instead of blocking inside command paths.
- The runtimed socket is same-UID trusted, not app-private. New handshake variants must account for any same-user process holding the socket path.

## Key source files

| File | Role |
|------|------|
| `crates/notebook-wire/src/lib.rs` | Wire constants, preamble bytes, frame caps, typed-frame enum, session-control status |
| `crates/notebook-protocol/src/connection.rs` | Public connection API facade and compatibility re-exports |
| `crates/notebook-protocol/src/connection/framing.rs` | Preamble validation and length-prefixed typed-frame send/receive |
| `crates/notebook-protocol/src/connection/handshake.rs` | Protocol version, handshake, capabilities, connection info |
| `crates/notebook-protocol/src/connection/env.rs` | Launch spec, package manager, environment source wire types |
| `crates/notebook-protocol/src/protocol.rs` | Canonical wire types: `NotebookRequest`, `NotebookResponse`, `NotebookBroadcast` |
| `packages/runtimed/src/request-types.ts` | Generated TS request/response protocol unions |
| `packages/runtimed/src/protocol-contract.ts` | Generated TS discriminant lists for drift tests |
| `packages/runtimed/src/transport.ts` | TS `FrameType` constants and transport boundary |
| `crates/runtimed-client/src/protocol.rs` | Daemon-internal `Request` / `Response`, re-exports from `notebook-protocol` |
| `crates/notebook-sync/src/{relay,connect,handle}.rs` | Relay handle, connection setup, `DocHandle` |
| `crates/runtimed/src/notebook_sync_server/` | Notebook sync server: catalog, room, peer connection/loop/session, writer, metadata |
| `crates/runtimed/src/requests/` | Notebook request routing handlers |
| `crates/runtimed/src/output_prep.rs` | IOPub → nbformat conversion, widget buffers, blob offload |
| `crates/runtimed/src/runtime_agent.rs` | Runtime-agent peer loop, kernel lifecycle, comm-state diff forwarding, RuntimeStateDoc writes |
| `crates/runtimed/src/{output_store,blob_store}.rs` | Output manifest creation + blob inlining threshold; content-addressed blob storage |
| `crates/runtimed-wasm/src/lib.rs` | WASM bindings: cell mutations, sync, per-cell accessors, `CellChangeset` |
| `crates/notebook-doc/src/{lib,diff}.rs` | `NotebookDoc` schema + per-cell accessors; `CellChangeset` structural diff |
| `crates/runtime-doc/src/doc.rs` | `RuntimeStateDoc` schema — runtime-authoritative per-notebook state, read-only to regular clients |
| `apps/notebook/src/lib/{frame-pipeline,notebook-frame-bus,runtime-state,materialize-cells,notebook-cells}.ts` | App-side frame processing, in-memory bus, runtime store, materialization, split cell store |
| `apps/notebook/src/hooks/{useAutomergeNotebook,useDaemonKernel}.ts` | WASM handle owner + kernel execution/broadcast handling |
| `crates/notebook/src/lib.rs` | Tauri commands and relay tasks (transparent byte pipe) |
