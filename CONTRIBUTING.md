# Contributing to nteract

## 1. Computer setup

- **macOS** - see [docs/runbooks/macos-setup.md](docs/runbooks/macos-setup.md)
- **Linux** - see the Linux development dependencies in [README.md](README.md)

## 2. Build commands

| Task | Command |
|------|---------|
| Full dev launch | `cargo xtask dev` |
| Skip pnpm install | `cargo xtask dev --skip-install` |
| Reuse existing artifacts | `cargo xtask dev --skip-build` |
| Debug build only | `cargo xtask build` |
| Rust only (skip frontend) | `cargo xtask build --rust-only` |
| Rebuild WASM targets | `cargo xtask wasm` |
| Check artifact status | `cargo xtask artifacts status` |
| Rebuild missing artifacts | `cargo xtask artifacts ensure` |
| All commands | `cargo xtask help` |

## 3. Development workflow

### Project structure

```
apps/notebook/        Tauri desktop app (React + Vite frontend)
apps/elements/        Elements component library
crates/               Rust workspace
  runtimed/           Daemon process — owns kernels and document state
  notebook/           Tauri application shell
  runt-mcp/           MCP server
  notebook-doc/       CRDT document model (Automerge)
  xtask/              Build task runner
packages/             Shared JS/TS packages
plugins/nteract/      Renderer plugins
```

### Frontend

The Vite dev server with hot reload runs as part of `cargo xtask dev`. To run it standalone:

```bash
cargo xtask vite
```

### Daemon

The runtimed daemon manages kernel processes and notebook document state. To run it independently:

```bash
cargo xtask dev-daemon
```

Check daemon status and logs:

```bash
cargo run -p runt -- daemon status
cargo run -p runt -- daemon logs -f
```

### WASM artifacts

WASM build outputs are gitignored and must exist before the frontend or Rust builds. `cargo xtask dev` ensures them automatically. To rebuild manually:

```bash
cargo xtask wasm              # rebuild all WASM targets
cargo xtask wasm runtimed     # rebuild runtimed-wasm only
cargo xtask wasm sift         # rebuild sift-wasm only
```

### Python bindings

`uv sync` and `maturin develop` are run automatically by `cargo xtask dev`. To run manually:

```bash
uv sync
cd crates/runtimed-py && VIRTUAL_ENV=../../.venv maturin develop
```

### Desktop app

```bash
cargo xtask notebook
```

This opens the GUI and blocks until quit — run it from your own terminal.

## 4. Testing

```bash
# Rust unit tests
cargo test

# Daemon-specific tests
cargo test -p runtimed

# JS/TS unit tests (vitest)
pnpm test:run

# Playwright browser E2E
pnpm --filter notebook-ui test:e2e:browser

# Native Tauri E2E
cargo xtask e2e build
cargo xtask e2e test

# Python integration tests
cargo xtask integration
```

## 5. Before opening a PR

### Lint and format (CI will reject failures)

```bash
cargo xtask lint --fix
```

This auto-fixes Rust (`rustfmt`), JS/TS (`biome`), and Python (`ruff`). To check without fixing:

```bash
cargo xtask lint
cargo xtask clippy
```

### Commit message format

[Conventional Commits](https://www.conventionalcommits.org/): `<type>(<optional-scope>): <short imperative summary>`

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`, `revert`

```
feat(execution): add queue drain on kernel restart
fix(sync): handle empty changeset in merge path
docs: update contributing guide
```

### CI-enforced invariants

**Tokio mutex guards** — Hold a `tokio::sync::Mutex` or `RwLock` guard only within a synchronous block; release before any `.await`. Use block scoping, not `drop()`.

**Cell rendering order** — In `NotebookView.tsx`, always iterate `stableDomOrder`, never `cellIds` directly. Visual order is controlled by CSS `order`; iterating `cellIds` directly causes React to call `insertBefore` on reorder, destroying iframes and losing widget state.

**Execution references synced cell IDs** — Execution requests must reference a `cell_id` from the Automerge document, not a side-channel code string.

**Control-plane signals use a separate transport** — Kernel lifecycle signals (`KernelIdle`, `ExecutionDone`, `CellError`) must not share the bounded output transport with stdout or display data.
