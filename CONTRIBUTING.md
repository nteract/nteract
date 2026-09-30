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

### MCP renderer development

Run `cargo xtask run-mcp` from the worktree used by your MCP client. The
supervisor checks generated assets before compiling and starting its child:
WASM first, affected renderer bundles next, then the widget HTML and `runt`.
The first build checks every bundle, including the hydrated LFS bundles, and
records local content receipts under `target/xtask/`. This initial rebuild
certifies current source inputs; an LFS output alone cannot establish that.
Later
runs compare input and output bytes, including imported TypeScript, CSS source
directories, build configuration, and the package lockfile. Unchanged bundles
retain their timestamps so Cargo can reuse the existing child binary.

File watching is opt-in: set `NTERACT_DEV_WATCH=1` on the MCP server process.
Renderer/widget edits rebuild the affected assets and restart only the MCP
child if its binary changes. Generated outputs do not trigger another reload.
Without watching, restart the MCP server, or use `up rebuild=true` in owner
mode. Attach mode prepares the child and assets but never restarts the shared
daemon. Development daemons serve renderer assets from this worktree's disk;
installed stable/nightly daemons are not part of this workflow.

If asset preparation fails and a child binary already exists, startup keeps
that child available and reports the failure in supervisor status. With
watching enabled, a corrected edit retries the build. A fresh checkout with
no usable binary still requires a successful build before child tools work.

For asset-only preparation or diagnostics:

```bash
cargo xtask artifacts ensure mcp-widget  # includes sift and renderer dependencies
cargo xtask artifacts status mcp-widget
cargo xtask artifacts verify mcp-widget
```

The widget embeds content hashes of lazy plugin assets, so a plugin-only edit
also changes the widget's advertised resource URI after rebuilding. The child
refreshes live tool/resource discovery and emits list-change notifications.
The checked-in startup tool cache keeps its legacy readable widget URI for
compatibility; result metadata alone does not update a host's tool catalog.
MCP cannot force a host to replace an already-running widget. If your host
retains its old catalog or widget, reconnect/restart that host's MCP integration
(and, if necessary, the host application) to discover the new URI and open a
fresh widget. Source freshness is not proof of host-side invalidation.

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
