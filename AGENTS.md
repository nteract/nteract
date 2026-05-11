# Agent Instructions

<!-- This file is canonical. CLAUDE.md is a symlink to AGENTS.md. -->

This is a map. Subsystem details live in nested `AGENTS.md` files next to code, auto-loaded rules live in `.claude/rules/`, and repository skills live in `.agents/skills/`. Claude reads the same skills through the `.claude/skills` symlink. Run `cargo xtask help` for build commands.

## Skills

Use `.agents/skills/` when the task matches:
- `automerge-sync` — sync protocol internals, document model, reconnection, peer state, in-flight suppression, protocol design patterns, convergence debugging
- `daemon-dev` — daemon development, Python bindings, build system, kernel debugging, xtask workflows
- `execution-pipeline` — end-to-end cell execution: required_heads → ExecuteCell → CellQueued → RuntimeStateDoc polling → output-sync grace → output resolution
- `frontend-dev` — frontend development, TypeScript bindings (ts-rs), UI iteration workflows
- `mcp-session-lifecycle` — MCP proxy supervision, daemon watch loop, session state, rejoin/reconnect races, room eviction
- `pr-reviewer` — Bedrock-authenticated Claude Agent SDK PR reviews with isolated worktrees and structured findings
- `releasing` — version bumps, tag conventions, release procedures
- `testing` — choosing test strategies, running verification, E2E, diagnostics collection

## Subsystem guides

| Topic | Doc |
|------|-----|
| Architecture + daemon | `crates/runtimed/AGENTS.md` |
| Frontend architecture | `apps/notebook/src/AGENTS.md` |
| UI components (Shadcn + nteract) | `src/components/ui/AGENTS.md` |
| Wire protocol & sync | `crates/notebook-wire/AGENTS.md` |
| Widgets | `src/components/widgets/AGENTS.md` |
| Environments / trust | `crates/kernel-env/AGENTS.md` |
| Iframe sandbox & renderer plugins | `src/components/isolated/AGENTS.md` |
| CRDT mutation rules | `crates/notebook-doc/AGENTS.md` |
| Logging | `.claude/rules/logging.md` |

## MCP servers

Three may be visible. Pick by purpose. Full details in `.claude/rules/mcp-servers.md` (auto-loaded everywhere).

- **`nteract-dev`** — default for development. Per-worktree dev daemon, dev tools (`up`, `down`, `status`, `logs`, `vite_logs`) plus 26 proxied notebook tools. Prefer `up` over manual `cargo xtask dev-daemon`.
- **`nteract-nightly`** — system nightly daemon. Diagnostics only.
- **`nteract`** — system stable daemon. Diagnostics only.

If `nteract-dev` is unavailable, fall back to `cargo xtask` (derives the worktree env on its own). Use system MCP servers only for diagnostics.

## Required before commit

```bash
cargo xtask lint --fix
```

CI rejects unformatted PRs. `cargo xtask help` is the source of truth for build commands.

## Commit and PR title format

Conventional Commits: `<type>(<optional-scope>)!: <short imperative summary>`

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`, `revert`.

## Load-bearing invariants

Most invariants auto-load from `.claude/rules/*.md` and nested `AGENTS.md` files when you edit matching paths. Two that don't fit any path scope:

### Tokio mutex guards stay within synchronous blocks

Hold a `tokio::sync::Mutex` or `RwLock` guard only within a synchronous block — release before any `.await`. Convoy deadlocks if the holder suspends. CI enforces via `cargo test -p runtimed --test tokio_mutex_lint`. Use block scoping (not `drop()`) so the lint can verify. Prefer owned state in `select!` loops over `Arc<Mutex<...>>`. Use `std::sync::Mutex` for sync-only access.

### Cell list uses stable DOM order

`apps/notebook/src/components/NotebookView.tsx` renders cells in stable DOM order (sorted by cell ID) and uses CSS `order` for visual positioning. Iterating `cellIds` directly causes React's `insertBefore` on reorder, destroying iframes — visible as white flashes, lost widget state, re-rendered outputs. Iterate `stableDomOrder`; the parent is `display: flex; flex-direction: column` and each child sets `order`.

## Notebook files

Use MCP tools (`create_notebook`, `manage_dependencies`) for notebooks with dependency metadata — the schema is internal. Test fixtures that need deps put them at `metadata.runt.uv.dependencies`.

## Desktop app

`cargo xtask notebook` opens a GUI that blocks until ⌘Q. Let the human launch it from their own terminal.
