# Contributing to nteract

## 1. Computer setup

- **macOS** - see [docs/runbooks/macos-setup.md](docs/runbooks/macos-setup.md)
- **Linux** - see the Linux development dependencies in [README.md](README.md)

## 2. Build commands

| Task | Command |
|------|---------|
| Full dev launch | `cargo xtask dev` |
| Skip JS/Python dependency install | `cargo xtask dev --skip-install` |
| Skip sidecar build | `cargo xtask dev --skip-build` |
| Debug build only | `cargo xtask build` |
| Rust only (skip frontend) | `cargo xtask build --rust-only` |
| Rebuild WASM targets | `cargo xtask wasm` |
| Check artifact status | `cargo xtask artifacts status` |
| Rebuild missing artifacts | `cargo xtask artifacts ensure` |
| All commands | `cargo xtask help` |

## 3. Development workflow

See the [project structure](README.md#project-structure) for the directory map
and [docs/README.md](docs/README.md) for subsystem documentation.

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

WASM build outputs are gitignored. The frontend and Rust crates that embed them
need these artifacts; `cargo xtask dev` ensures them automatically. To rebuild:

```bash
cargo xtask wasm              # rebuild all WASM targets
cargo xtask wasm runtimed     # rebuild runtimed-wasm only
cargo xtask wasm sift         # rebuild sift-wasm only
```

### Python bindings

`cargo xtask dev` syncs the Python environment unless `--skip-install` is set.
Python bindings are built separately:

```bash
uv sync
cd crates/runtimed-py && VIRTUAL_ENV=../../.venv uv run --directory ../../python/runtimed maturin develop
```

### Desktop app

```bash
cargo xtask notebook
```

Use this app-only loop when the worktree daemon is already running; otherwise
use `cargo xtask dev`. Both open a GUI and block until you quit.

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

### Lint and format

```bash
cargo xtask lint --fix
```

This runs Rust formatting, source control-byte checks, JS/TS checks (`vp check`),
and, when `uv` is available, Python lint/format (`ruff`) and type checks (`ty`).
`--fix` applies available formatting and lint fixes. To check without fixing:

```bash
cargo xtask lint
cargo xtask clippy
```

### Commit message format

[Conventional Commits](https://www.conventionalcommits.org/): `<type>(<optional-scope>)!: <short imperative summary>`
The scope is optional; use `!` only for breaking changes.

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf`, `revert`

```
feat(execution): add queue drain on kernel restart
fix(sync): handle empty changeset in merge path
docs: update contributing guide
```

### Design invariants

Follow the [repository-wide rules](AGENTS.md#repository-wide-rules),
[frontend invariants](apps/notebook/src/AGENTS.md#invariants), and
[daemon lifecycle ordering](crates/runtimed/AGENTS.md#lifecycle-and-output-ordering)
for the code you change.
