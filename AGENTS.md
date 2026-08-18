# Agent Instructions

<!-- This file is canonical. CLAUDE.md is a symlink to AGENTS.md. -->

## Start here

- Confirm the worktree, branch, and existing diff before editing.
- Read the nearest `AGENTS.md` for every file you change. Claude also loads
  matching rules from `.claude/rules/`; other tools should inspect those rules
  when they apply.
- Use the repository skills in `.agents/skills/` for subsystem workflows.
  Claude sees the same skills through `.claude/skills`.
- Run `cargo xtask help` for the current build and test commands.
- Discover files from the checkout. Keep paths in this guide only when they are
  canonical entry points; do not maintain subsystem file inventories here.

## What nteract is

nteract is a local-first notebook application. Notebook content is stored in
Automerge documents. The runtimed daemon owns kernels, execution, outputs, and
save/recovery behavior. Desktop, cloud, and programmatic clients use the same
notebook and runtime protocols.

Use the project names when they matter: `NotebookDoc` for notebook content,
`RuntimeStateDoc` for kernel and execution state, `CommsDoc` for widget state,
and `CommentsDoc` for comments. Describe concrete mechanisms rather than
inventing product labels.

## Working in the repository

- Inspect the implementation and its tests before changing behavior. Do not
  infer a contract from a type name, UI symptom, or stale document.
- For frontend or product-surface work, use the `frontend-dev` skill and follow
  the nearest subsystem guide. Shared notebook UI should behave the same in
  desktop and cloud unless the host difference is intentional.
- Automerge documents and daemon-owned runtime documents hold shared notebook
  state. React state is for local UI state, not a second copy of notebook or
  runtime state.
- Use `docs/README.md` to find maintained design and operations documents.
  Keep temporary investigation notes in `.context/`. Do not add a permanent
  document for notes that belong only to the current patch or PR.

## Development environment

Use `nteract-dev` for development against this worktree. The `nteract` and
`nteract-nightly` servers are for inspecting installed builds, not source
changes. If `nteract-dev` is unavailable, use `cargo xtask`; do not substitute
an installed notebook server. Full server details are in the scoped MCP rules.

For desktop source work, prefer `cargo xtask dev`. It starts the worktree-local
daemon and hot-reload app together and stops the daemon it started when the app
exits. On macOS, each worktree launches with a distinct `nteract Dev <hash>`
name and bundle identifier so it does not alias an installed stable or Nightly
app. Use `cargo xtask dev status` for the exact app PID, executable, identity,
Vite URL, and daemon socket; use `cargo xtask dev focus` to activate that exact
process. Accessibility automation must select the reported `Automation PID`,
not resolve an application named `nteract` through LaunchServices.

After changing Tauri bootstrap or listener setup, use `cargo xtask dev --fresh`
to reset and relaunch this worktree's app and daemon. Use
`cargo xtask dev reset` when a clean stop is needed without relaunching. Reserve
`cargo xtask notebook` for an app-only loop when the worktree daemon is already
managed separately. These commands derive and export the worktree namespace;
`direnv allow` is still useful for an interactive shell but is not required for
xtask isolation.

Before every commit, run:

```bash
cargo xtask lint --fix
```

Run the narrow tests for the code you changed, then widen verification when the
risk or subsystem guide calls for it. Use the `testing` skill for repository
test workflows.

Desktop dev commands open a GUI and block until it quits. Let the developer run
them from their own terminal unless the task explicitly requires live desktop
validation.

## Commits and reviews

Use Conventional Commits for commit and PR titles:

```text
<type>(<optional-scope>)!: <short imperative summary>
```

Allowed types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`,
`build`, `perf`, `revert`.

For reviews started on a developer workstation, use the repository-independent
Kilo review workflow. Repository-hosted Pullfrog reviews remain supported. Give
reviewers `.agents/reviewers/nteract-code-review-rubric.md`, define the exact
review target and mutation boundary, and verify every finding against the
checkout. Model findings are advisory. After a fix, rerun the relevant checks
before calling the review clear.

## Repository-wide rules

### Do not hold Tokio locks across `await`

Keep a `tokio::sync::Mutex` or `RwLock` guard inside a synchronous block so it
is released before `.await`. Use block scope rather than `drop()`; CI checks
this with `cargo test -p runtimed --test tokio_mutex_lint`. Prefer owned state
in `select!` loops and `std::sync::Mutex` for sync-only access.

### Execute synced notebook cells

Execution tied to notebook state must reference a synced `cell_id`. Create or
edit the cell in the Automerge document, wait for sync when needed, and execute
by `cell_id`. Do not send a separate code string that can differ from the live
notebook seen by other peers.

### Preserve notebook dependency metadata

Use the notebook MCP tools to create notebooks with dependency metadata; the
schema is internal. Test fixtures that need dependencies store them at
`metadata.runt.uv.dependencies`.
