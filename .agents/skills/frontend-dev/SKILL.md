---
name: frontend-dev
description: Frontend development for nteract UI/product surfaces, Elements fixtures, hot reload, dev daemon setup, MCP server workflow, TypeScript bindings via ts-rs, and reactive state work that touches RxJS streams, useSyncExternalStore stores, or WASM-backed notebook/runtime projections.
---

# Frontend Development

Use this skill for UI/product work and for TypeScript state surfaces that feed
shared notebook UI. If the task is primarily Automerge protocol, daemon/kernel
execution, MCP session lifecycle, or release mechanics, use the more specific
repo skill for that subsystem first and return here only for app integration.

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

## Reactive State and WASM Projection Work

Use this subsection when editing RxJS or shared-store code such as
`packages/runtimed/src/sync-engine.ts`,
`packages/runtimed/src/*store*.ts`,
`src/components/notebook/state/*`,
`apps/notebook/src/lib/notebook-sync-store-bridge.ts`,
`apps/notebook-cloud/viewer/*facts*.ts`, or
`apps/notebook-cloud/viewer/*store*.ts`.

### State Boundary

- Start from the durable owner: `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`,
  `CommentsDoc`, or host-owned APIs/session facts. React state is for local UI
  affordances, not another copy of document/runtime truth.
- Prefer WASM-emitted changesets and projections (`CellChangeset`,
  `ExecutionViewChangeset`, `outputIdChanges$`, `commentsProjection$`,
  `notebookSyncApplied$`) over second-pass TypeScript diffs.
- Shared components should consume shared stores. Host code should inject source
  facts and side-effect adapters, not duplicate projection logic.
- Keep host policy host-owned: D1/ACL/OIDC/session state, Tauri daemon
  lifecycle, filesystem/package-manager access, and workstation source facts do
  not belong in `runtimed-wasm` or shared React stores. Project their results
  only when shared UI needs them.

### RxJS Shape

- Keep `Subject`, `BehaviorSubject`, and `ReplaySubject` private. Expose
  readonly `Observable` fields through `.asObservable()`.
- Prefer one authoritative subject plus `select(project, equals)` style
  projections with `distinctUntilChanged`. Add structural comparators when the
  projector allocates arrays or objects.
- Keep stream logic inside `.pipe()` where it is composable. Manual
  `.subscribe(...)` belongs at bridge edges that drive imperative sinks; collect
  those subscriptions in a `Subscription` and tear them down.
- Choose flattening operators by semantics: `switchMap` for latest-only work,
  `concatMap` for ordered materialization or writes, `mergeMap` for independent
  frame/event expansion, and `exhaustMap` for duplicate-submit suppression.
- Put `catchError` inside the inner observable when the outer session stream
  must keep running. Avoid letting one bad frame, blob fetch, or projection kill
  a long-lived bridge.
- Use `shareReplay` with an explicit lifetime. `refCount: false` is appropriate
  for app/session-lifetime shared store projections that must keep one cache;
  `refCount: true` is safer for cold sources whose subscription should end when
  consumers detach.

### React Binding

- Use `useSyncExternalStore` for shared notebook store hooks. The observable
  adapted by `useRuntimeProjection`-style helpers must emit synchronously on
  subscribe, usually through `BehaviorSubject`, `ReplaySubject(1)`, or a seeded
  `shareReplay` projection.
- Subscribe to the narrowest projected fact the UI needs instead of the whole
  runtime or notebook snapshot. This avoids re-rendering on unrelated daemon
  ticks and keeps Desktop and Cloud behavior converged.
- For async materialization or blob/output resolution, preserve ordering with
  `concatMap` or an explicit queue. After every `await`, check that the live
  handle/session still matches before writing stores.
- Reset paths must invalidate stale async writes, not just clear visible state.

### Verification

- Add virtual-time tests (`rxjs/testing` or `VirtualTimeScheduler`) for timers,
  throttles, cancellation, and ordered stream behavior.
- Add store-level tests for synchronous snapshot seeding, deduped emissions,
  loaded/default-state gates, and stale-write guards.
- If a change crosses the WASM projection boundary, regenerate or freshness-check
  runtime WASM artifacts with the repo xtask flow before trusting TypeScript
  results.

### Module-Singleton Source Stores

For non-CRDT async sources (auth, catalog, access requests, workstations) held
in a module-level `ObservableStore` singleton, follow Decision 8
(`docs/adr/frontend-sync-bridge.md`). The store outlives every component, so
each async completion is a stale-write risk:

- **Domain hooks are the API; the binding is plumbing.** Components import
  `useCloudAuthState`/`useHostedCatalogAuth`/`useCloudWorkstationsRegistry`, never
  `store.select(...)` inline in a render body and never
  `observable-binding.ts` directly. One binding, shared desktop and cloud.
- **Singletons for lifetime, context for consumption.** The store stays a module
  singleton (boot, drivers, instant-paint snapshot reads), but each domain hook
  resolves its instance from `useCloudStores()` (`cloud-stores-context.ts`),
  whose default is the singleton bundle. Production mounts no provider, so it is
  byte-identical; a test or Elements fixture mounts `CloudStoresProvider` with
  its own instances and the subtree reads those. The provider overrides
  consumption, never activation - its owner activates the instances it supplies.
  A controller that dispatches actions on the same store reads it from the same
  context too, so an override gets a coherent store.
- **Capture at issue, drop at apply — for every completion.** Poll ticks AND
  imperative actions capture `{epoch, auth reference, endpoint}` when the
  request starts; after every `await` (success, error, and any follow-up
  refetch), the result is discarded if the identity moved. A guarded first
  await followed by an unguarded second await is the recurring hole.
- **Invalidation covers bookkeeping, not just visible state.** `dispose`,
  `reset`, and a signed-out closed gate bump the activation epoch so captured
  issues die with them (a transient `loading` gate is a recoverable dip and
  keeps in-flight work alive); a dropped completion also clears any indicator
  it wrote (by object-reference ownership, so it can never clobber a newer
  identity's own state).
- **After-settle loops re-arm on settle, never on emission.** A self-scheduling
  poll re-arms via `repeat()` on completion, so a swallowed inner rejection
  cannot kill the loop. Keep `catchError` on the inner fetch.
- **One in-flight guard, one `exhaustMap`.** Fixed-rate triggers that must
  not overlap (interval tick, visibility rise, manual wakeup) feed a single
  `exhaustMap`; do not give each trigger its own guard. After-settle stores
  instead serialize manual refresh and mutation refetches through a dedicated
  `concatMap` action stream off the poll loop, so the coupling stays ordered
  and the cadence unperturbed.
- **Inject every clock.** `scheduler`, `now`, and the network operations are
  `activate(deps)` arguments, so tests run entirely on virtual time and the
  suite proves cadence, gates, aborts, and stale drops deterministically.
- **Named comparators with the manifest tripwire.** `distinctUntilChanged`
  uses a named `fooEquals(a, b)` with a colocated
  `satisfies Record<keyof T, true>` manifest. The manifest forces every key to
  be *listed* when the type grows; it does not prove every key is *compared* -
  treat a break as a prompt to revisit the comparator body, not proof of
  correctness. A projection that allocates an array or object each tick needs
  a structural comparator (length plus per-element identity/fields); a
  reference check on a re-allocated value dedups nothing. The manifest break
  surfaces as a tsc error (`pnpm --dir apps/notebook-cloud typecheck`); the
  node test script alone will not catch it.
- **`loaded$` gates readiness, not state.** The state subject emits its seeded
  default before the gate opens (state emits first, then the gate); a consumer
  that must tell "loading" from "loaded empty" reads `loaded$`, never infers
  from an empty snapshot.

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

Codex app/CLI reads `.codex/config.toml` from the project. Keep the
project-scoped server named `nteract-dev` and pinned to the repo root:

```toml
[mcp_servers.nteract-dev]
command = "cargo"
args = ["xtask", "run-mcp"]
cwd = "."
startup_timeout_sec = 120

[mcp_servers.nteract-dev.env]
NTERACT_DEV_MODE = "attach"
RUNTIMED_DEV = "1"
SKIP_MATURIN = "1"
```

Installed Codex plugin servers such as `nteract-notebook`, `nightly`, or older
`notebook` aliases target release/plugin daemons. Do not use them for source
development against a local Browser/Vite worktree.

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
