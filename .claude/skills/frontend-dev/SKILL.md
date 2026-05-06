---
name: frontend-dev
description: Frontend development with hot reload, dev daemon setup, MCP server workflow, and TypeScript bindings generation via ts-rs.
---

# Frontend Development

## Quick Reference

| Task | Command |
|------|---------|
| Hot reload dev | `cargo xtask notebook` |
| Standalone Vite | `cargo xtask vite` |
| Attach to Vite | `cargo xtask notebook --attach` |
| Full debug build | `cargo xtask build` |
| Rust-only rebuild | `cargo xtask build --rust-only` |
| Run bundled binary | `cargo xtask run` |
| One-shot setup | `cargo xtask dev` |
| Lint/format | `cargo xtask lint --fix` |
| nteract-dev MCP server | `cargo xtask run-mcp` |
| Regenerate TS bindings | `cargo test` |

## Hot Reload (`cargo xtask notebook`)

Best for UI/React development. Vite dev server on port 5174; React changes hot-reload instantly.

Requires a dev daemon running:

```bash
# Terminal 1: Start dev daemon
cargo xtask dev-daemon

# Terminal 2: Start the app
cargo xtask notebook
```

### Multi-Window Testing

Closing the first Tauri window kills Vite. Keep Vite alive independently:

```bash
# Terminal 1: Standalone Vite (stays running)
cargo xtask vite

# Terminal 2+: Attach Tauri to existing Vite
cargo xtask notebook --attach
```

## Debug Build (`cargo xtask build` + `run`)

Bundles frontend assets into the binary. Emits JS source maps for native webview devtools.

```bash
cargo xtask build               # Full build (frontend + Rust)
cargo xtask build --rust-only   # Skip frontend rebuild (fast Rust iteration)
cargo xtask run                 # Run the bundled binary
cargo xtask run path/to/notebook.ipynb
```

## Dev Daemon

Each worktree gets an isolated daemon in dev mode.

```bash
# Two-terminal workflow
cargo xtask dev-daemon    # Terminal 1 (stays running)
cargo xtask notebook      # Terminal 2

# One-shot (installs deps + builds + starts daemon + launches app)
cargo xtask dev
cargo xtask dev --skip-install --skip-build  # Fast repeat
```

`cargo xtask dev-daemon`, `cargo xtask notebook`, and `cargo xtask run-mcp` derive the worktree env automatically. Set `RUNTIMED_DEV=1` and `RUNTIMED_WORKSPACE_PATH="$(pwd)"` only for raw `./target/debug/runt ...` commands.

### Useful Daemon Commands

```bash
./target/debug/runt daemon status       # Check daemon state
./target/debug/runt daemon logs -f      # Tail logs
./target/debug/runt ps                  # List running kernels
./target/debug/runt notebooks           # List open notebooks
```

## MCP Server Development

### nteract-dev (recommended)

```bash
cargo xtask run-mcp             # Start dev MCP server
cargo xtask run-mcp --print-config  # Editor config output
```

Starts dev daemon, launches `nteract-dev`, spawns child `runt mcp`, proxies notebook tool calls, watches for file changes, and hot-reloads.

### nteract-dev Tools

| Tool | Purpose |
|------|---------|
| `up` | Idempotent bring-up. Args: `vite=true`, `rebuild=true`, `mode="debug"\|"release"` |
| `down` | Stop Vite. `daemon=true` also stops daemon |
| `status` | Read-only report of child, daemon, processes, build mode |
| `logs` | Tail daemon log |
| `vite_logs` | Tail Vite log |

### Hot Reload Watches

`python/nteract/src/`, `python/runtimed/src/`, `crates/runtimed-py/src/`, `crates/runtimed/src/`:
- **Python changes** — child restarts automatically
- **Rust changes** — `maturin develop` runs first, then child restarts

### Direct Mode (no proxy)

```bash
cargo xtask dev-daemon          # Terminal 1
./target/debug/runt mcp         # Terminal 2 (Rust-native, no Python)
```

### Zed Integration

`.zed/settings.json` (gitignored):

```json
{
  "context_servers": {
    "nteract-dev": {
      "command": "cargo",
      "args": ["run", "-p", "mcp-supervisor"],
      "cwd": ".",
      "env": { "NTERACT_DEV_MODE": "owner", "RUNTIMED_DEV": "1" }
    }
  }
}
```

## TypeScript Bindings (ts-rs)

Types in `src/bindings/` are auto-generated from Rust via `ts-rs`. Edit the Rust source, not the generated TypeScript.

### How It Works

Annotate Rust types with `#[derive(TS)]` and `#[ts(export)]`:

```rust
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ThemeMode {
    System,
    Light,
    Dark,
}
```

Generates `src/bindings/ThemeMode.ts`:
```typescript
export type ThemeMode = "system" | "light" | "dark";
```

### Adding New Bindings

1. Add `ts-rs` to crate's `Cargo.toml`:
   ```toml
   [dependencies]
   ts-rs = { version = "12", features = ["serde-compat"] }
   ```

2. Annotate type with `#[derive(TS)]` and `#[ts(export)]`

3. Run `cargo test` to generate the TypeScript file

4. Import from `src/bindings/index.ts`:
   ```typescript
   import type { MyNewType } from "@/bindings";
   ```

### Configuration

Export directory set in `.cargo/config.toml`:
```toml
[env]
TS_RS_EXPORT_DIR = { value = "src/bindings", relative = true }
```

### Source Files

| Rust File | Generated Types |
|-----------|-----------------|
| `crates/runtimed-client/src/settings_doc.rs` | `ThemeMode`, `PythonEnvType`, `UvDefaults`, `CondaDefaults`, `PixiDefaults`, `SyncedSettings` |
| `crates/runtimed-client/src/runtime.rs` | `Runtime` |

### Generated Output

```
src/bindings/
  CondaDefaults.ts, PixiDefaults.ts, PythonEnvType.ts,
  Runtime.ts, SyncedSettings.ts, ThemeMode.ts, UvDefaults.ts,
  index.ts          -- Re-exports all types
```

## Zed Editor Tasks

Pre-configured in `.zed/tasks.json` (cmd-shift-t):

| Task | Command |
|------|---------|
| Dev Daemon | `cargo xtask dev-daemon` |
| Dev App | `cargo xtask notebook` |
| Daemon Status | `./target/debug/runt daemon status` |
| Daemon Logs | `./target/debug/runt daemon logs -f` |
| Format | `cargo xtask lint --fix` |
| Setup | `pnpm install && cargo xtask build` |

## Common Gotchas

**Daemon code changes not taking effect:** Restart `cargo xtask dev-daemon` in dev mode. In production: reinstall the .app or run `./scripts/install-nightly`.

**App says "Dev daemon not running":** Start `cargo xtask dev-daemon` in another terminal.

**Port conflicts with Vite:** Default 5174 may conflict across worktrees. Use `cargo xtask build` + `run` to avoid Vite, or use `CONDUCTOR_PORT` for automatic assignment.

**Frontend changes not showing:** With `cargo xtask notebook` they hot-reload. With `cargo xtask run` you need `cargo xtask build` first. With `--rust-only` frontend is intentionally skipped.
