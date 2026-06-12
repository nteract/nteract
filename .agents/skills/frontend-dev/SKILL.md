---
name: frontend-dev
description: Frontend development, design exploration for UI and Elements surfaces, hot reload, dev daemon setup, MCP server workflow, and TypeScript bindings generation via ts-rs.
---

# Frontend Development

## Quick Reference

| Task | Command |
|------|---------|
| Hot reload assets | `cargo xtask vite` |
| Dev daemon | `cargo xtask dev-daemon` |
| Human app launch | `cargo xtask notebook` |
| Human attach to Vite | `cargo xtask notebook --attach` |
| Full debug build | `cargo xtask build` |
| Rust-only rebuild | `cargo xtask build --rust-only` |
| Human bundled launch | `cargo xtask run` |
| One-shot setup | `cargo xtask dev` |
| Lint/format | `cargo xtask lint --fix` |
| nteract-dev MCP server | `cargo xtask run-mcp` |
| Regenerate TS bindings | `cargo test` |

## Design Exploration Mode

Use this mode when the user asks to iterate on UI, including notebook UI,
Elements docs, rail/sidebar surfaces, toolbar chrome, cell affordances, runtime
state language, or says the goal is to make the design feel fluid with natural
grouping.

### Working Shape

- Start a task branch early and treat it as an exploratory design branch.
- Bring up the dev daemon and Vite unless the user only wants discussion.
- Prefer real fixture notebooks and existing Elements scenarios over synthetic empty states.
- If the production app is hard to drive, prototype the visual language in
  `apps/elements`, then pull only the durable parts back into the main app.
- Add or update an Elements page when a new surface needs product/design review:
  create the fixture component in `apps/elements/components/*-example.tsx`,
  document it in `apps/elements/content/docs/*.mdx`, and link it from
  `apps/elements/app/page.tsx` plus `apps/elements/content/docs/index.mdx`.
- Treat Elements fixtures as stable review artifacts: keep data deterministic,
  avoid live network dependencies, and cover dense, empty, error, and narrow
  viewport states when the surface needs them.
- Commit each promising design state as a separate conventional commit so the user can
  review, cherry-pick, or backtrack.
- Do not rush to PR until there is a tangible visual direction the user likes.

### Design Bias

- Make UI feel like it belongs to the document, not like legacy app chrome bolted around it.
- Use color as subtle state and focus language, not decoration.
- Favor fluid separators, ribbons, inline controls, and calm state vocabulary over raised
  pills, bubbles, boxed badges, or noisy status text.
- Use shared shadcn/nteract primitives from `src/components/ui` where they fit;
  add new primitives through the repo shadcn workflow instead of one-off
  component copies.
- Avoid duplicating identity/mode/status labels when another nearby control already carries
  that meaning.
- Keep desktop-local identity quiet; reserve explicit auth/account chrome for cloud surfaces.
- For cloud, separate app-level controls from notebook-level controls:
  presence, connection, sharing, auth, and view/edit mode belong in cloud/app chrome;
  execution, runtime/package language, and cell insertion belong in notebook chrome.
- For product-surface PRs and docs, describe nteract in concrete system terms:
  live documents, explicit runtime state, workstation/compute attachment, and
  collaboration mechanics. Avoid named comparisons to other products in PR
  descriptions or shipped docs.

### Visual Verification

- Check desktop and narrow widths before calling the design done.
- Use Playwright or Browser screenshots for at least one wide and one constrained viewport.
- Inspect common states: ready, queued, running, completed, failed, hidden input/output,
  markdown-heavy notebooks, and package/outline rail panels.
- If motion is involved, verify fast-path behavior so short executions do not flicker.

## Hosted Product Surface Work

Use this subsection for hosted notebook home, sharing, workstation, auth/session,
and public-notebook polish. These surfaces are app chrome around notebooks; they
should not fork cell, output, rail, toolbar, or execution UI.

### Product Shape

- Prototype in `apps/elements` first when the visual or interaction model is
  still uncertain, then promote only stable pieces into `apps/notebook-cloud`.
- Keep `/n` useful as a notebook home, not just a file list: continuation,
  ownership/access state, created/open flows, and workstation/runtime readiness
  should read together.
- Treat notebook titles as first-class product data. Untitled notebooks must
  degrade cleanly, but a dashboard full of IDs is a signal that title capture,
  rename, or cleanup tooling needs attention.
- Share previews and OG metadata must be safe by default. Private notebooks
  should not leak content through server-rendered metadata; public notebooks
  should use explicit published/revision-safe facts.
- Workstation state belongs to host/app chrome until it becomes the active
  notebook runtime. Runtime controls stay in the shared notebook toolbar.
- Hosted compute is owner-only until an explicit execute capability exists.
  Do not let `editor`, edit mode, or a live `runtime_peer` alone surface run,
  restart, or interrupt controls.
- R2 snapshot bundles and D1 catalog/ACL/revision rows are the durable hosted
  truth. Treat Durable Object storage as live-room recovery/cache unless a new
  ADR changes that boundary.

### App-Shell Latency

- Avoid first-frame empty states when the route already owns the data. Prefer
  server bootstrap or retained state for app-shell data such as `/n` lists and
  sharing ledgers.
- Do not solve app-shell data freshness by overusing Automerge when the source
  of truth is an ACL/catalog/session resource. Use Automerge for notebook and
  runtime documents; use host APIs for catalog, auth, sharing, and account data.
- If browser auth is localStorage-only, the Worker cannot server-render
  authenticated HTML on first navigation. A first-party session/cookie layer can
  bootstrap app-owned pages, but room WebSocket credentials should remain
  explicit/ticketed and output frames must stay on the separate isolated origin.

### Projection Discipline

- Derive dashboard/list/sidebar summaries in pure projection helpers outside
  component render bodies. React should consume stable arrays/objects rather
  than recreating ad hoc projections in JSX.
- For live notebook content, consume `CellChangeset` and shared narrow
  projection helpers when possible. Full live-cell rematerialization is a
  bootstrap or fallback path, not the steady-state Cloud projection model.
- When adding new API facts for UI, keep them structured and host-owned. Avoid
  parsing principal strings, display labels, or notebook IDs in React except as
  compatibility fallback.

## Hot Reload

Best for UI/React development. Start the dev daemon and Vite from agent terminals; let the human launch the Tauri GUI from their own terminal.

Agent terminals:

```bash
cargo xtask dev-daemon
cargo xtask vite
```

Human terminal:

```bash
cargo xtask notebook --attach
```

React changes hot-reload through the Vite dev server on port 5174.

### Multi-Window Testing

Closing the first Tauri window kills Vite. Keep Vite alive independently:

```bash
# Agent terminal: standalone Vite (stays running)
cargo xtask vite

# Human terminal(s): attach Tauri to existing Vite
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
# Agent terminals
cargo xtask dev-daemon
cargo xtask vite

# Human terminal if they want the full setup flow
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
| Human Dev App | `cargo xtask notebook` |
| Daemon Status | `./target/debug/runt daemon status` |
| Daemon Logs | `./target/debug/runt daemon logs -f` |
| Format | `cargo xtask lint --fix` |
| Setup | `pnpm install && cargo xtask build` |

## Common Gotchas

**Daemon code changes not taking effect:** Restart `cargo xtask dev-daemon` in dev mode. In production: reinstall the .app or run `./scripts/install-nightly`.

**App says "Dev daemon not running":** Start `cargo xtask dev-daemon` in another terminal.

**Port conflicts with Vite:** Default 5174 may conflict across worktrees. Use `cargo xtask build` + `run` to avoid Vite, or use `CONDUCTOR_PORT` for automatic assignment.

**Frontend changes not showing:** With `cargo xtask notebook` they hot-reload. With `cargo xtask run` you need `cargo xtask build` first. With `--rust-only` frontend is intentionally skipped.
