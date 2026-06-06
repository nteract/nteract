# Runtime daemon (runtimed)

Scope: `crates/runtimed/**`, `crates/runtimed-client/**`, `crates/runtimed-outputs/**`, `crates/runtimed-service/**`, `crates/runtimed-settings-sync/**`, `crates/runtimed-py/**`, `crates/runtime-doc/**`, `crates/notebook-wire/**`, `crates/notebook-doc/**`, `crates/notebook-protocol/**`, `crates/notebook-sync/**`, `packages/runtimed/**`.

## Core principles

1. **Daemon as source of truth.** The runtimed daemon owns all runtime state. Clients are views, not independent state holders. If the daemon restarts, clients reconnect and resync.

2. **Automerge document as canonical notebook state.** Cell source, metadata, and structure live in the Automerge doc. To execute a cell, write it to the doc first, then request execution by cell_id. Pass code as a request parameter and you've introduced a correctness bug.

3. **On-disk notebook as checkpoint.** The `.ipynb` file is a snapshot. The daemon autosaves on a debounce (2s quiet, 10s max). Explicit save (Cmd+S) also formats cells. Unknown metadata keys are preserved through round-trips.

4. **Local-first editing, synced execution.** Cell mutations happen instantly in the WASM Automerge peer. Execution runs against the synced document. Source edits debounce at 20ms; `flushSync()` fires before execute/save.

5. **Binary separation via blob store.** Cell outputs use inline manifest Maps in the CRDT with `ContentRef` entries pointing to the blob store. MIME types and sizes are readable directly from the CRDT without blob fetch. Binary content always goes to the content-addressed blob store; text content is inlined only when it stays under the inline threshold.

6. **Daemon manages runtime resources.** Clients request kernel launch; they never spawn kernels directly. Environment selection, tool availability, and lifecycle are the daemon's responsibility.

7. **Process-isolated kernel execution.** Every kernel runs in a separate runtime agent subprocess (`runtimed runtime-agent`) connecting back as an Automerge peer. Execution is CRDT-driven — the coordinator writes execution entries (source + sequence number) to RuntimeStateDoc; the runtime agent discovers them via sync and executes in order. RPC handles lifecycle (`LaunchKernel`, `RestartKernel`, `ShutdownKernel`), interrupts, environment hot-sync (`SyncEnvironment`), completion/history queries, and ephemeral comm traffic (`SendComm`).

## Crate boundaries

| Crate | Owns | Consumers |
|-------|------|-----------|
| `notebook-wire` | Frame bytes, preamble constants, frame caps, typed-frame enum, session-control status shapes | daemon, WASM, Tauri relay, `notebook-protocol` |
| `notebook-doc` | Automerge schema, cell CRUD, nbformat fallback fields, per-cell accessors, `CellChangeset` diffing, fractional indexing, presence encoding | daemon, WASM, Python bindings |
| `notebook-protocol` | Wire types (`NotebookRequest`, `NotebookResponse`, `NotebookBroadcast`), connection handshake, frame parsing | daemon, `notebook-sync`, Python bindings |
| `notebook-sync` | Sync infrastructure (`DocHandle`), snapshot watch channel, per-cell accessors for Python clients, sync task management | Python bindings (`runtimed-py`) |

**Rule of thumb:** Frame bytes, caps, and connection-local readiness shapes → `notebook-wire`. Document schema or cell operations → `notebook-doc`. New request/response/broadcast type → `notebook-protocol`. Python client sync behavior → `notebook-sync`.

The Tauri app crate (`crates/notebook/`) is glue — it wires Tauri commands to daemon requests and manages the socket relay. It does not own protocol types or document operations.

## State ownership

| State | Writer | Notes |
|-------|--------|-------|
| Cell source (`Text` CRDT) | Frontend WASM | Local-first, character-level merge |
| Cell position, type, metadata | Frontend WASM | User-initiated via UI |
| Notebook metadata (deps, runtime) | Frontend WASM | User edits deps, runtime picker |
| Cell outputs (inline manifests) | Daemon | Kernel IOPub → blob store → inline manifest Maps in RuntimeStateDoc |
| Execution count | Daemon | Set on `execute_input` from kernel |
| Widget state | Daemon/runtime agent + frontend comm deltas | RuntimeStateDoc holds comm topology; CommsDoc holds mutable comm state; the runtime agent gates state by topology, suppresses echoes, and forwards accepted frontend deltas to the kernel |
| RuntimeStateDoc (kernel status, queue, executions, env, trust) | Daemon | Separate per-notebook Automerge doc synced via frame `0x05` |
| CommsDoc (widget state) | Daemon/runtime agent + frontend comm deltas | Separate per-notebook Automerge doc synced via frame `0x09` |

## RuntimeStateDoc

Each notebook room has a daemon-authoritative **RuntimeStateDoc** — a separate Automerge document (frame type `0x05`). It tracks:

- **Kernel state**: status, starting phase, name, language, env_source
- **Execution queue**: `executing_execution_id` plus ordered `queued_execution_ids`; notebook cells point at executions from `NotebookDoc`
- **Execution lifecycle**: per-execution_id map with status (`queued`/`running`/`done`/`error`), execution_count, success, source, outputs
- **Environment drift**: in_sync flag, added/removed packages
- **Trust state**: status and needs_approval flag

The daemon is the authoritative writer for kernel lifecycle, env, trust, queue, execution, output state, and comm topology. Frontend reads via `useRuntimeState()`, and Python reads via `notebook.runtime`. Widget values live in the paired CommsDoc so RuntimeStateDoc remains daemon-owned; the runtime agent gates CommsDoc deltas by RuntimeStateDoc topology and filters out kernel-authored echoes before forwarding foreign deltas to the kernel.

Key files: `crates/runtime-doc/src/doc.rs`, `crates/runtime-doc/src/handle.rs`, `apps/notebook/src/lib/runtime-state.ts`.

## Binary vs text content

Jupyter kernels send binary data as base64-encoded strings on the wire. The daemon **base64-decodes binary MIME types before storing** so the blob store holds actual binary bytes.

**Text MIME types** (`text/*`, `application/json`, `image/svg+xml`, anything `+json`/`+xml`):
- Stored as UTF-8 (or inlined in manifest if < 1KB)
- Resolved via `read_to_string()` / `response.text()`

**Binary MIME types** (`image/png`, `image/jpeg`, `audio/*`, `video/*`, most `application/*`):
- Base64-decoded before storage — blob contains raw bytes
- Always stored as blobs (never inlined, regardless of size)
- Frontend resolves to `http://` blob URLs
- Python resolver reads raw bytes → `Output.data` is `bytes`

**Exception:** `image/svg+xml` is TEXT. The `+xml` suffix is the tell.

### The `is_binary_mime` contract

One canonical Rust implementation in `notebook-doc::mime` is the single source of truth. All Rust crates use this module. WASM resolves `ContentRef`s to `Inline`/`Url`/`Blob` variants directly — the frontend never classifies MIMEs itself.

| Location | Function |
|----------|----------|
| `crates/notebook-doc/src/mime.rs` | `is_binary_mime()`, `mime_kind()`, `MimeKind` |

Rules:
- `image/*` → binary, **except** `image/svg+xml`
- `audio/*`, `video/*` → always binary
- `application/*` → binary by default, **except**: `json`, `javascript`, `ecmascript`, `xml`, `xhtml+xml`, `mathml+xml`, `sql`, `graphql`, `x-latex`, `x-tex`, and anything ending in `+json` or `+xml`
- `text/*` → always text

### Resolution by consumer

| Consumer | Binary MIME | Text MIME |
|----------|------------|-----------|
| Frontend (WASM) | `http://` blob URL | Inline string or `response.text()` |
| Python (`output_resolver.rs`) | `fs::read()` → raw `bytes` | `read_to_string()` → string |
| `.ipynb` save | `resolve_binary_as_base64()` | `resolve()` → UTF-8 string |

## Blob store

Content-addressed storage lives under `runt_workspace::daemon_base_dir()/blobs` (stable expands to `~/.cache/runt/blobs/`; source builds normally use the nightly namespace). Entries are sharded by first 2 hex chars. Each blob has a `.meta` sidecar with `{media_type, size, created_at}`. Blobs are ephemeral — regenerated from `.ipynb` on daemon restart.

Manifests are inline Automerge Maps in RuntimeStateDoc. Each contains `ContentRef` entries per MIME type: `{"inline": "<data>"}` for ≤1KB text, `{"blob": "<hash>", "size": N}` for content >1KB or any binary. MIME types and sizes are readable directly from the CRDT — no blob fetch needed for metadata.

HTTP server at `127.0.0.1:<dynamic-port>` serves `GET /blob/{hash}` with correct `Content-Type` and `Cache-Control: immutable`.

## Notebook room lifecycle

- **Autosave:** 2s quiet period, 10s max interval. Daemon writes `RuntimeStateDoc.last_saved`; frontend computes dirty as `local_edit_at > last_saved`.
- **UUID-stable rooms:** Room keys are always UUIDs. Saving an untitled notebook updates `path_index` and writes `RuntimeStateDoc.path`. The UUID never changes.
- **Crash recovery:** Untitled notebooks persist to `notebook-docs/{hash}.automerge`. Snapshots go to `notebook-docs/snapshots/`. Outputs are ephemeral.
- **Multi-window:** Multiple windows join the same room as separate Automerge peers.
- **Eviction:** After all peers disconnect, delayed eviction (default 30s) shuts down the kernel and removes the room.

## Settings sync

Settings sync via a separate Automerge document on the same Unix socket. `settings.json` is the durable source of truth; the `SettingsDoc` is a live sync projection. External `settings.json` edits are authoritative — the file watcher applies them to the in-memory projection. Any window can write settings; all others receive changes via CRDT sync.

## Widget state

Widget topology lives in **RuntimeStateDoc** (`doc.comms/` entries without mutable state). Widget values live in **CommsDoc**:
- **Daemon/runtime agent:** Writes kernel-authored comm state from IOPub. State updates coalesce in a 16ms batch writer and use kernel actors so self-echoes can be filtered.
- **Frontend inbound:** `WidgetStore` in `widget-store.ts` has per-model subscriptions. `SyncEngine.commChanges$` merges RuntimeStateDoc topology with CommsDoc state, resolves blobs, and drives the store.
- **Frontend → Kernel:** State updates go through `WidgetUpdateManager` into CommsDoc. The runtime agent diffs foreign CommsDoc state for comm ids that still have RuntimeStateDoc topology, suppresses echoes, and forwards accepted deltas to the kernel. Custom messages and `comm_close` stay on the `SendComm` shell path because they are ephemeral events.

New clients receive widget topology via RuntimeStateDoc sync and widget state via CommsDoc sync. Custom widget messages (buttons, etc.) still use `NotebookBroadcast::Comm` as ephemeral events.

### Reserved comm namespace: `nteract.dx.*`

The `nteract.dx.*` prefix is reserved for nteract's own kernel-side protocols. `comm_open` / `comm_msg` / `comm_close` traffic for this namespace is filtered out of runtime comm topology/state and `NotebookBroadcast::Comm`, so it never reaches `WidgetStore`. v1 has no live `nteract.dx.blob` handler; reserved messages are dropped with a warning, and current blob refs ride IOPub `display_data` buffers through `preflight_ref_buffers`.

## Development workflow

| Task | Command |
|------|---------|
| Run dev daemon (per-worktree) | `cargo xtask dev-daemon` |
| Run with debug logs | `RUST_LOG=debug cargo run -p runtimed` |
| Check status | `cargo run -p runt -- daemon status` |
| Ping daemon | `cargo run -p runt -- daemon ping` |
| View logs | `cargo run -p runt -- daemon logs -f` |
| Run tests | `cargo test -p runtimed` |
| Specific test | `cargo test -p runtimed test_daemon_ping_pong` |
| Install nightly from source (Linux) | `./scripts/install-nightly` |

The notebook app automatically connects to or starts the daemon on launch. For development, use `cargo xtask dev-daemon` for per-worktree socket isolation, or the `nteract-dev` MCP server's `up` command.

Source builds default to the nightly channel (affects cache/socket namespaces). Set `RUNT_BUILD_CHANNEL=stable` only when validating the stable flow.

## Security model

`runtimed` is a per-user daemon. The OS account is the security boundary — cross-user access is denied, same-UID access is trusted.

- Unix socket at `~/.cache/<namespace>/runtimed.sock`, mode `0600`
- Socket directory kept owner-private (`0700`)
- `RUNTIMED_SOCKET_PATH` is a capability-bearing pointer — only set it for processes that should control the daemon
- Blob HTTP server binds `127.0.0.1`, read-only, content-addressed

## Python bindings (runtimed-py)

```python
import asyncio, runtimed

async def main():
    client = runtimed.Client()
    async with await client.create_notebook() as notebook:
        cell = await notebook.cells.create("print('hello')")
        result = await cell.run()
        print(result.stdout)  # "hello\n"

asyncio.run(main())
```

Install into workspace venv: `cd crates/runtimed-py && VIRTUAL_ENV=../../.venv maturin develop`

`Output.data` typing: binary MIME → `bytes`, JSON → `dict`, text → `str`. Binary images are raw bytes, not base64.

Socket path: respects `RUNTIMED_SOCKET_PATH`. For worktree daemons, export the socket path from `runt daemon status --json`.

## CLI commands

```bash
runt daemon status          # Show service + pool statistics
runt daemon start/stop      # Service lifecycle
runt daemon logs -f         # Tail logs
runt daemon ping            # Health check
runt ps                     # List all kernels
runt notebooks              # List open notebooks
```

## Code structure

```
crates/runtimed/src/
├── main.rs                   # CLI entry point
├── daemon.rs                 # State, pool management, connection routing
├── notebook_sync_server/     # Room lifecycle, peer sync, persistence, metadata/trust
├── runtime_agent.rs          # Runtime agent subprocess: peer, CRDT queue, kernel ownership
├── runtime_agent_handle.rs   # Coordinator-side agent spawn + monitor
├── jupyter_kernel.rs         # Process spawn, ZMQ sockets, IOPub routing
├── output_prep.rs            # IOPub → nbformat conversion, widget buffers, blob offload
├── output_store.rs           # Manifest creation, blob inlining threshold
├── blob_store.rs             # Content-addressed storage with metadata sidecars
├── blob_server.rs            # HTTP read server (hyper 1.x)
├── inline_env.rs             # Inline dependency env caching
├── project_file.rs           # Project file detection
├── singleton.rs              # Daemon locking/singleton
└── sync_server.rs            # Settings Automerge sync
```

## Shipped app behavior

The daemon installs as a system service at login:
- **macOS**: launchd plist in `~/Library/LaunchAgents/`
- **Linux**: systemd user service in `~/.config/systemd/user/`
- **Windows**: Startup folder script

Manage with `runt daemon start/stop/status/logs`. Cross-platform install/uninstall via `crates/runtimed-service/src/lib.rs`.

## Troubleshooting

**Daemon won't start (lock held):** Check `lsof ~/.cache/<namespace>/daemon.lock`. If stale, remove the lock file.

**Pool not replenishing:** Verify `uv --version` works and check `~/.cache/<namespace>/envs/`.

**Python bindings "Failed to parse output":** Usually connecting to wrong daemon (missing blob access). Set `RUNTIMED_SOCKET_PATH` to the correct daemon's socket.

## Key files

| File | Role |
|------|------|
| `crates/notebook-doc/src/lib.rs` | `NotebookDoc` — Automerge schema, cell CRUD |
| `crates/notebook-doc/src/diff.rs` | `CellChangeset` — structural diff from patches |
| `crates/notebook-doc/src/mime.rs` | Canonical MIME classification |
| `crates/notebook-protocol/src/protocol.rs` | Wire types: requests, responses, broadcasts |
| `crates/notebook-sync/src/handle.rs` | `DocHandle` — sync infrastructure |
| `crates/runtime-doc/src/doc.rs` | `RuntimeStateDoc` schema |
| `crates/runtimed/src/notebook_sync_server/` | Room lifecycle, peer sync |
| `crates/runtimed/src/output_prep.rs` | IOPub conversion, widget buffers |
| `crates/runtimed/src/output_store.rs` | Manifest creation, `ContentRef` |
| `crates/runtimed/src/blob_store.rs` | Content-addressed storage |
| `crates/runtimed/src/blob_server.rs` | HTTP blob server |
| `crates/runtimed-outputs/src/output_resolver.rs` | Shared Rust manifest resolution |
| `apps/notebook/src/lib/manifest-resolution.ts` | Frontend resolution (WASM resolves directly) |
| `apps/notebook/src/lib/notebook-cells.ts` | Split cell store, per-cell subscriptions |
