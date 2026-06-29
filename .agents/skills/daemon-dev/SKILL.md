---
name: daemon-dev
description: >
  Develop, debug, and manage the runtimed daemon, Python bindings, build system,
  and Python bindings. Use when working on daemon code, kernel issues,
  maturin builds, or xtask workflows.
---

# Daemon Development

## Quick Reference

| Task | Command |
|------|---------|
| Start dev daemon | `cargo xtask dev-daemon` |
| Full build | `cargo xtask build` |
| Rust-only rebuild | `cargo xtask build --rust-only` |
| Fast sidecar check | `cargo xtask build --rust-only --skip-tauri` |
| Run bundled binary | `cargo xtask run` |
| WASM rebuild | `cargo xtask wasm` |
| Install nightly (Linux) | `./scripts/install-nightly` |
| Daemon status | `./target/debug/runt daemon status` |
| Daemon status (JSON) | `./target/debug/runt daemon status --json` |
| Tail logs | `./target/debug/runt daemon logs -f` |
| List kernels | `./target/debug/runt ps` |
| List notebooks | `./target/debug/runt notebooks` |
| Flush pool | `./target/debug/runt daemon flush` |
| Stop daemon | `./target/debug/runt daemon stop` |
| Run daemon tests | `cargo test -p runtimed` |
| Lint | `cargo xtask lint --fix` |

## Architecture

The daemon (`runtimed`) is a singleton coordinating notebook windows over a Unix socket. Without it: race conditions on prewarmed environments, wasted resources, slow cold starts.

**Components:** Unix socket (IPC), lock file (singleton guarantee), UV/Conda pools (prewarmed envs), blob store (content-addressed outputs), notebook-docs (persisted Automerge documents).

**Protocol:** Length-prefixed typed frames over Unix socket. Preamble → JSON handshake → Automerge sync → steady state. Frame types: AutomergeSync (0x00), Request (0x01), Response (0x02), Broadcast (0x03), Presence (0x04), RuntimeStateSync (0x05), PoolStateSync (0x06), SessionControl (0x07), PutBlob (0x08), CommsDocSync (0x09).

**CRDT ownership:** Frontend WASM writes cell source, position, type, metadata. Daemon writes RuntimeStateDoc for outputs, execution counts, comm topology, trust, env progress, and project context. Mutable widget state lives in CommsDoc and is gated by RuntimeStateDoc topology. Write to a CRDT document only from an authority allowed for that document.

## Build System

### How `cargo xtask build` works (4 phases)

0. **Artifact guard** — verify gitignored WASM, renderer-plugin, and MCP widget outputs. Build/dev commands fingerprint workspace inputs and skip wasm-pack when outputs are current; rebuild only when outputs are missing, invalid, or stale.
1. **Single Rust compilation** — `cargo build -p runtimed -p runt -p mcp-supervisor -p notebook`. Sidecars copied to `crates/notebook/binaries/`.
2. **Frontend build** — `pnpm build` (TypeScript + Vite). `--rust-only` skips this.
3. **Tauri link** — `cargo tauri build --debug --no-bundle` with embedded frontend assets. Use `--skip-tauri` only for fast edit checks where updated sidecar binaries are enough; run a normal build before launching the bundled app.

All Rust targets build in one `cargo build` call to avoid feature-unification recompilation. WASM outputs are gitignored; `runtimed`'s `build.rs` panics if missing. `nteract-mcp` embeds the MCP widget HTML; prepare it with `cargo xtask artifacts ensure mcp-widget`.

### WASM rebuild

Run after changing `crates/runtimed-wasm/`, `crates/sift-wasm/`, `crates/notebook-doc/`, `crates/notebook-wire/`, or `scripts/build-renderer-plugins.ts`:

```bash
cargo xtask wasm             # all (runtimed-wasm + sift-wasm + renderer plugins)
cargo xtask wasm runtimed    # only runtimed-wasm
cargo xtask wasm sift        # only sift-wasm
```

## Development Workflow

### Fast iteration

```bash
# Terminal 1
cargo xtask dev-daemon

# Terminal 2
cargo xtask build --rust-only     # Fast rebuild (reuses frontend assets)
cargo xtask build --rust-only --skip-tauri  # Faster compile check for Rust sidecars
cargo xtask run                   # Run the bundled binary
```

### Testing

```bash
cargo test -p runtimed                          # All tests
cargo test -p runtimed --test integration       # Integration tests only
cargo test -p runtimed test_daemon_ping_pong    # Specific test
```

### Per-worktree isolation

`cargo xtask dev-daemon`, `cargo xtask notebook`, and `cargo xtask run-mcp` derive the git worktree automatically. State lives at `<cache>/runt-nightly/worktrees/{hash}/`. Set `RUNTIMED_DEV=1` and `RUNTIMED_WORKSPACE_PATH="$(pwd)"` only for raw `./target/debug/runt` commands outside xtask.

## Python Bindings

### Two venvs

| Venv | Path | Purpose |
|------|------|---------|
| Workspace | `.venv` (repo root) | Day-to-day dev, MCP server |
| Test | `python/runtimed/.venv` | Isolated pytest runs |

### Installation

```bash
# Into workspace venv (most common — what `up rebuild=true` does)
cd crates/runtimed-py
VIRTUAL_ENV=../../.venv uv run --directory ../../python/runtimed maturin develop

# Into test venv (for pytest)
VIRTUAL_ENV=../../python/runtimed/.venv uv run --directory ../../python/runtimed maturin develop
```

Always set `VIRTUAL_ENV` explicitly — without it, the `.so` installs into whichever venv `uv run` resolves.

### Basic usage

```python
import asyncio, runtimed

async def main():
    client = runtimed.Client()
    async with await client.create_notebook() as notebook:
        cell = await notebook.cells.create("print('hello')")
        result = await cell.run()
        print(result.stdout)  # "hello\n"

        # Granular execution control
        execution = await cell.execute()
        print(execution.status)  # "queued" | "running" | "done" | "error"
        result = await execution.result()

asyncio.run(main())
```

### Output.data typing

| MIME category | Python type | Notes |
|---------------|-------------|-------|
| Binary image (`image/png`) | `bytes` | Raw binary |
| JSON (`application/json`) | `dict` | Parsed |
| Text (`text/plain`, `text/html`) | `str` | UTF-8 |
| LLM hint (`text/llm+plain`) | `str` | Synthesized blob URL |

### Integration tests

```bash
RUNTIMED_SOCKET_PATH="$(./target/debug/runt daemon status --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["socket_path"])')" \
  python/runtimed/.venv/bin/python -m pytest python/runtimed/tests/test_daemon_integration.py -v
```

## MCP Server

The MCP server ships as `runt mcp` (Rust). Run via `cargo xtask run-mcp` for development.

**Advertised tools:** `list_active_notebooks`, `connect_notebook`, `create_notebook`, `save_notebook`, `show_notebook`, `disconnect_notebook`, `get_cell`, `get_all_cells`, `create_cell`, `set_cell`, `delete_cell`, `move_cell`, `execute_cell`, `run_all_cells`, `get_results`, `interrupt_kernel`, `restart_kernel`, `manage_dependencies`, `replace_match`, `replace_regex`.

Legacy dependency and cell-metadata tool names still dispatch for compatibility, but new workflows should use `manage_dependencies` for dependency inspection/edits and `get_results` for execution output lookup by `execution_id`.

## RuntimeStateDoc

Daemon-authoritative Automerge document synced via frame 0x05. Frontend reads only (`useRuntimeState()`); Python reads via `notebook.runtime`.

**Schema:** `kernel/{status, starting_phase, name, language, env_source}`, `queue/{executing, queued}`, `executions/{id → cell_id, status, execution_count, success}`, `env/{in_sync, added, removed}`, `trust/{status, needs_approval}`, `last_saved`, plus comm topology/routing. Mutable widget values live in CommsDoc, not RuntimeStateDoc.

**Execution lifecycle:** Client sends `ExecuteCell` → daemon generates `execution_id` → writes to queue → status progresses through running/done/error → Python `Execution` handle polls for updates.

## Async CRDT Mutations

Any daemon code that reads doc state, does async work, then writes back must
reconcile against the captured baseline heads. Prefer document-owned
`transact_at_heads_recovering(...)` for ordinary async writes. Use
`fork_with_actor(...)` + `merge_recovering(...)` only when the async worker
genuinely needs an editable fork across the await. Direct mutation after an
async gap overwrites concurrent edits.

```rust
let baseline_heads = {
    let mut doc = room.doc.write().await;
    doc.get_heads()
};
let result = do_async_work().await;
let mut doc = room.doc.write().await;
doc.transact_at_heads_recovering(&baseline_heads, Some("runtimed:formatter"), "tx", |doc| {
    doc.update_source(&cell_id, &result)?;
    Ok(())
}).ok();
```

For synchronous blocks: `doc.fork_and_merge(|fork| { ... })`.

## Notebook Room Lifecycle

Each open notebook has a room (`NotebookRoom`), keyed by UUID. A `PathIndex` maps canonical paths to room UUIDs.

- **Autosave:** 2s quiet, 10s max interval. Skips untitled/mid-load notebooks.
- **Multi-window:** Multiple windows join the same room as Automerge peers.
- **Eviction:** All peers disconnect → delayed eviction (default 30s) → kernel shuts down, room removed.
- **Crash recovery:** Untitled notebooks persist to `notebook-docs/{hash}.automerge`; snapshots in `notebook-docs/snapshots/`.

## Key Invariants

- `is_binary_mime()` has one canonical Rust implementation in `notebook-doc::mime` — single source of truth across all crates.
- Iframe sandbox: `allow-same-origin` is forbidden.
- Per-cell O(1) accessors must stay in sync across WASM, Rust, and Python.
- Hold tokio mutex guards only within synchronous blocks (use block scoping, verify with `cargo test -p runtimed --test tokio_mutex_lint`).
- Cell list renders in stable DOM order (sorted by ID) with CSS `order` for visual positioning.

## Troubleshooting

**Daemon lock held:** `runt daemon status` → check with `lsof`. Remove stale `daemon.lock` + `daemon.json` if crashed.

**Pool not replenishing:** Verify `uv --version` and check `~/.cache/runt/envs/`.

**Wrong daemon (Python):** If outputs return parse errors with hashes, the bindings connect to the wrong daemon (blob store is per-daemon). Set `RUNTIMED_SOCKET_PATH`.

**Build not reflected (Python):** Rebuild into the correct venv with explicit `VIRTUAL_ENV`. Or use `up rebuild=true`.

## Shipped App / System Daemon

Production daemon installs as a system service (macOS: launchd, Linux: systemd user). Manage with `runt daemon {status,stop,start,logs,uninstall}`.

**Key paths (macOS):** Binary at `~/Library/Application Support/runt/bin/runtimed`, socket at `~/Library/Caches/runt/runtimed.sock`, logs at `~/Library/Caches/runt/runtimed.log`.

Use `./target/debug/runt daemon stop` to stop only your worktree's daemon. Avoid `pkill`/`killall` — they affect every worktree.
