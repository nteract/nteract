# Python Packages

Development home for nteract Python packages. The UV workspace root (`pyproject.toml` and `.venv`) lives at the **repo root**.

| Package | Description |
|---------|-------------|
| `python/runtimed/` | Low-level Python bindings for the runtimed daemon (maturin/PyO3) |
| `python/nteract/` | Thin launcher for the Rust-native `runt mcp` MCP server |
| `python/dx/` | Display and blob-store helpers used from Python kernels |
| `python/nteract-kernel-launcher/` | Embedded launcher package vendored by the daemon into kernel environments |
| `python/prewarm/` | Environment warm-up utility for Python kernels |
| `python/gremlin/` | Autonomous notebook agent for stress testing |
| `python/pr-reviewer/` | Internal opencode-backed PR reviewer |
| `python/safari-timeline/` | Safari Web Inspector timeline unpacking utilities |

The root project keeps install metadata empty. Workspace-local packages live in
the default `dev` dependency group so plain `pip install .` does not try to
resolve unpublished packages from PyPI. `nteract-kernel-launcher` is especially
important here: the packaged daemon embeds its sources and vendors them into
kernel environments, so use explicit `uv --package nteract-kernel-launcher`
commands when working on or testing that package directly.

## Dev Setup

The virtual environment lives at the repo root (`.venv`), not inside `python/`.

```bash
# From the repo root — creates .venv and installs the default dev workspace
uv sync
```

### Building runtimed from Rust source

The Rust bindings live in `crates/runtimed-py/`. To build them into the repo-root `.venv`:

```bash
cd crates/runtimed-py && VIRTUAL_ENV=../../.venv uv run --directory ../../python/runtimed maturin develop
```

Verify everything is wired up:

```bash
# From the repo root
uv run python -c "import runtimed, nteract; print('ok')"
```

## Running the MCP Server (Dev)

```bash
# Find your dev daemon socket (from repo root)
RUNTIMED_DEV=1 ./target/debug/runt daemon status

# Run the MCP server (from repo root)
RUNTIMED_SOCKET_PATH=~/Library/Caches/runt-nightly/worktrees/<hash>/runtimed.sock \
    uv run nteract
```

`uv run --no-sync nteract` also works from the repo root if you want to skip dependency resolution.

For Zed MCP config:

```json
{
  "command": "uv",
  "args": ["run", "--no-sync", "nteract"],
  "env": {
    "RUNTIMED_SOCKET_PATH": "/Users/<you>/Library/Caches/runt-nightly/worktrees/<hash>/runtimed.sock"
  },
  "working_directory": "/path/to/desktop"
}
```

## Rebuilding After Rust Changes

If you change code in `crates/runtimed-py/` or `crates/runtimed/`:

```bash
cd crates/runtimed-py && VIRTUAL_ENV=../../.venv uv run --directory ../../python/runtimed maturin develop
```
