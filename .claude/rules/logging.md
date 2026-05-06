---
paths:
  - crates/runtimed/src/**
  - apps/notebook/src/**
---

# Logging

Logging conventions for the daemon (Rust, `tracing`), the Tauri notebook crate (Rust, `log`), and the frontend (TypeScript, `logger` util).

## Rust — daemon (`crates/runtimed`)

Use `tracing`:

```rust
use tracing::{debug, info, warn, error};
```

`tracing-subscriber` runs layered subscribers (stderr + file). Dependencies that use the `log` crate (jupyter-zmq-client, automerge, …) bridge into `tracing` automatically via `tracing-log`.

## Rust — Tauri notebook crate

Use `log` with `tauri-plugin-log`:

```rust
use log::{debug, info, warn, error};
```

## TypeScript

Import the `logger` utility:

```typescript
import { logger } from "../lib/logger";

logger.debug("[component] Internal detail");
logger.info("[component] Significant event");
logger.warn("[component] Recoverable issue");
logger.error("[component] Failure:", error);
```

Route through `logger`, not raw `console.*`. The level filter is applied server-side by `tauri-plugin-log`. In dev (`import.meta.env.DEV`) `attachConsole()` mirrors everything into the browser devtools. In packaged builds the Rust-side app log level decides what's visible.

## Level guidelines

| Level | Use for | Examples |
|-------|---------|----------|
| `error` | Failures that affect functionality | Kernel crash, file write failure |
| `warn` | Recoverable issues that may indicate problems | Trust verification failed, retry exhausted |
| `info` | Significant user-visible events | Kernel launched, environment created, sync complete |
| `debug` | Internal details useful for debugging | Pool operations, request handling, state transitions |

Send these to `debug` rather than `info`:

- per-operation details (every cell execution, every pool take/return)
- internal state transitions (metadata resolution, room creation)
- expected conditions (kernel already running, no peers remaining)
- large data structures (comm state, JSON payloads)
- retry attempts (log only the final result)

## Prefixes

Rust (daemon):
- `[runtimed]` — daemon core operations
- `[notebook-sync]` — Automerge sync server
- `[kernel-manager]` — kernel lifecycle and execution
- `[doc-handle]` — CRDT document mutations and requests
- `[comm_*]` — widget communication

TypeScript (frontend):
- `[automerge-notebook]` — WASM handle, bootstrap, materialization
- `[sync-engine]` — frame processing, sync state, coalescing
- `[crdt-bridge]` — CodeMirror ↔ CRDT character-level sync
- `[frame-pipeline]` — changeset materialization, cache behavior
- `[daemon-kernel]` — kernel execution, broadcasts, comms
- `[flushSync]` — outbound sync flush

## Channel defaults

| Channel | Daemon | Notebook app |
|---------|--------|--------------|
| Nightly | `info` (with `debug` for `notebook_sync` and `notebook_sync_server`) | `Debug` |
| Stable  | `warn` | `Info` |

Nightly is intentionally chatty for field diagnosis. No configuration needed — the defaults are channel-aware.

## Overrides

```bash
# All debug logs
RUST_LOG=debug cargo xtask dev-daemon

# One module
RUST_LOG=runtimed::notebook_sync_server=debug cargo xtask dev-daemon

# Daemon CLI flag (overrides channel default)
runtimed --log-level debug
```

Daemon logs rotate on startup — each session gets a clean file, with the previous preserved as `runtimed.log.1`. That keeps `runt daemon logs -f` focused on the current session.

## Before adding a log statement

1. Who needs this? If it's only useful when debugging, send it to `debug`.
2. How often does it fire? High-frequency operations go to `debug`.
3. Does it contain sensitive data? Truncate or omit large JSON and full file paths.
4. Is it actionable? Errors should say what went wrong and what to try next.

## Review checklist

- Level matches the audience (internal details → `debug`, not `info`).
- Prefix follows `[component-name]`.
- No sensitive data (full file paths, large JSON).
- TypeScript uses `logger`, not raw `console.*`.
