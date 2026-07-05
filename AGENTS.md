# Agent Instructions

<!-- This file is canonical. CLAUDE.md is a symlink to AGENTS.md. -->

Subsystem details live in nested `AGENTS.md` files next to code, auto-loaded
rules live in `.claude/rules/`, and repository skills live in `.agents/skills/`.
Claude reads the same skills through the `.claude/skills` symlink. Run
`cargo xtask help` for build commands.

## Project positioning

nteract is a local-first, agent-ready notebook environment where humans, kernels, and AI agents work against the same live notebook document set. Describe that in concrete system terms: Automerge-backed notebook state, explicit runtime state, daemon-owned kernels, outputs, and execution, and programmatic control through the same runtime model. Avoid broad AI slogans; prefer the mechanics users and developers can verify.

## Documentation taxonomy

Use `docs/README.md` as the front door for repo documentation. Start working
notes in `.context/` while exploring. Do not create a persistent doc for routine
implementation notes, test plans, or context that only explains the current
patch; use the PR description, code comments, or final response instead.

Promote `.context/` notes into `docs/` only when they should persist for product,
design, engineering, research, or AI collaborators. Use `docs/memos/` for shared
thinking, research, options, and RFC-style proposals; do not file exploratory
work as a Draft ADR just because it mentions architecture. Graduate durable
technical decisions to `docs/adr/`, durable product requirements to `docs/prd/`,
scoped execution work to `docs/plans/`, evidence and follow-up lists to
`docs/audits/`, benchmark evidence to `docs/measurements/`, operational
procedures to `docs/runbooks/`.

## Design system and Elements

For UI, design-system, or product-surface work, start with the
`frontend-dev` repo skill and `apps/elements/content/docs/index.mdx` before
editing app code. This includes Elements, cloud dashboard, notebook shell,
toolbar, cells, output rendering, comments, runtime/package UI, search, themes,
and shared components.

Treat `apps/elements` as the stable review artifact layer for visual notebook
surfaces. The catalog details live in the Elements docs and `frontend-dev`
skill, not in this top-level routing file.

Then read the nested ownership rules for the code you will touch:
`apps/notebook/src/AGENTS.md` for desktop/shared notebook app wiring,
`apps/notebook-cloud/AGENTS.md` for hosted cloud shell, authority, and viewer
boundaries, and `src/components/ui/AGENTS.md` for shared UI, cell, editor, and
output primitives. For notebook shell convergence, also read
`docs/adr/notebook-host-shell-convergence.md`.

Use those files to keep cloud app chrome separate from the shared notebook
shell. Host-specific auth, ACL, sharing, workstation, routing, and side-effect
boundaries should not fork common notebook presentation without an explicit
reason.

## Frontend reactive state and RxJS

For RxJS, shared-store, `useSyncExternalStore`, or WASM-backed projection work,
start with the `frontend-dev` repo skill and
`docs/adr/frontend-sync-bridge.md`. This includes
`packages/runtimed/src/sync-engine.ts`, `packages/runtimed/src/*store*.ts`,
`packages/runtimed/src/observable-store.ts`, `packages/runtimed/src/poll.ts`,
`src/components/notebook/state/*`, `apps/notebook/src/lib/notebook-sync-store-bridge.ts`,
`apps/notebook-cloud/viewer/*store*.ts`,
`apps/notebook-cloud/viewer/use-cloud-*-store.ts`, and
`apps/notebook-cloud/viewer/browser-signals.ts`.

Use the durable owner first: Automerge documents, RuntimeStateDoc, CommsDoc,
CommentsDoc, or host-owned API/session facts. React state is local UI state,
not a second source of truth. Keep RxJS sources private, expose readonly
observables or named domain hooks, and test timers/cancellation with virtual
time. Any async path that writes into a store after `await` must prove the
current handle/session/auth/endpoint still matches or carry an activation
generation that invalidates stale completions.

## MCP servers

Three may be visible. Pick by purpose. Full details in `.claude/rules/mcp-servers.md` (auto-loaded everywhere).

- **`nteract-dev`** — default for development. Per-worktree dev daemon. Owner/isolated mode exposes dev tools (`up`, `down`, `status`, `logs`, `vite_logs`); attach mode (Codex) exposes read-only supervisor tools (`status`, `logs`, `vite_logs`) plus proxied notebook tools. Prefer `up` over manual `cargo xtask dev-daemon`.
- **`nteract-nightly`** — system nightly daemon. Diagnostics only.
- **`nteract`** — system stable daemon. Diagnostics only.
- **Codex plugin notebook servers** (`nteract-notebook`, `nightly`, or older `notebook` tool names) — installed release/plugin surfaces. Diagnostics only for source work; they may attach to a different active notebook than the local Browser/Vite app.

If `nteract-dev` is unavailable, fall back to `cargo xtask` (derives the worktree env on its own). Use system or installed plugin MCP servers only for diagnostics.

## Required before commit

```bash
cargo xtask lint --fix
```

CI rejects unformatted PRs. `cargo xtask help` is the source of truth for build commands.

## Commit and PR title format

Conventional Commits: `<type>(<optional-scope>)!: <short imperative summary>`

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`, `revert`.

## Load-bearing invariants

Most invariants auto-load from `.claude/rules/*.md` and nested `AGENTS.md` files when you edit matching paths. A few that don't fit any path scope:

### Tokio mutex guards stay within synchronous blocks

Hold a `tokio::sync::Mutex` or `RwLock` guard only within a synchronous block — release before any `.await`. Convoy deadlocks if the holder suspends. CI enforces via `cargo test -p runtimed --test tokio_mutex_lint`. Use block scoping (not `drop()`) so the lint can verify. Prefer owned state in `select!` loops over `Arc<Mutex<...>>`. Use `std::sync::Mutex` for sync-only access.

### Cell list uses stable DOM order

`apps/notebook/src/components/NotebookView.tsx` renders cells in stable DOM order (sorted by cell ID) and uses CSS `order` for visual positioning. Iterating `cellIds` directly causes React's `insertBefore` on reorder, destroying iframes — visible as white flashes, lost widget state, re-rendered outputs. Iterate `stableDomOrder`; the parent is `display: flex; flex-direction: column` and each child sets `order`.

### Runtime control-plane signals are not output transport

Kernel lifecycle signals (`KernelIdle`, `ExecutionDone`, `CellError`, `KernelDied`) must never share bounded output/work transport with stdout floods, display churn, or widget output replay. Route them through a separate reliable control path and drain them before bounded output work so interrupts and queue release cannot be backpressured by manifests, blob writes, or Automerge output mutations.

Stream output may use bounded, lossy periodic flushes, but ordering boundaries cannot. Flush stdout/stderr through the stream committer priority path before clearing terminal state for display/error outputs, and route `ExecutionDone` through that same priority path so terminal runtime state remains causally after the final stream manifest.

Output widget replay is not the durable record; RuntimeStateDoc is. Kernel-facing `SendCommUpdate` replay from IOPub must be non-blocking and best-effort so a full bounded work queue cannot delay later lifecycle status.

`update_display_data` is transient display churn. Coalesce it by `display_id` off the IOPub hot path, but flush pending display updates after `KernelIdle` and before `ExecutionDone` so terminal runtime state still follows durable output state.

### Execution references synced cell IDs

Execution that belongs to notebook state should reference a synced `cell_id`. Create or edit the cell in the Automerge document, wait for sync as needed, then execute by `cell_id`. Do not bypass the document with side-channel code strings or ad hoc code payloads; otherwise peers can execute source that is not the live notebook content.

## Notebook files

Use MCP tools (`create_notebook`, `manage_dependencies`) for notebooks with dependency metadata — the schema is internal. Test fixtures that need deps put them at `metadata.runt.uv.dependencies`.

## Desktop app

`cargo xtask notebook` opens a GUI that blocks until ⌘Q. Let the human launch it from their own terminal.
