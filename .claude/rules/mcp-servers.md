---
description: MCP server selection — use the right server for the task
globs:
  - "**"
---

# MCP Server Selection

Three nteract MCP servers may be available. Always use the right one:

| Server | What it is | When to use |
|--------|-----------|-------------|
| `nteract-dev` | Dev MCP server. Adds dev tools (`up`, `down`, `status`, `logs`, `vite_logs`) on top of the proxied `runt mcp` toolset. Manages a per-worktree dev daemon, hot-reloads on code changes. | **Default for all development work.** Use this for notebook interaction, daemon lifecycle, building, and testing. |
| `nteract-nightly` | System-installed nightly release daemon | Diagnostics and inspection of the installed nightly app. Do NOT use for development. |
| `nteract` | System-installed stable release daemon (nteract.app) | Diagnostics and inspection of the installed stable app. Do NOT use for development. |

**Rules:**

1. **Always prefer `nteract-dev`** (`mcp__nteract-dev__*` tools) for development work in this repo. It connects to the per-worktree dev daemon and includes the dev tools for managing the build/daemon lifecycle.
2. **Never use `nteract-nightly` or `nteract` for development.** They connect to system-installed daemons and will not reflect your source changes.
3. **Never use installed Codex plugin notebook servers for source work.** Servers named `nteract-notebook`, `nightly`, or older `notebook` tool aliases come from the installed stable/nightly plugin cache, not this worktree. They can attach to a different active notebook than the local Browser/Vite app.
4. If `nteract-dev` tools are not available, fall back to `cargo xtask` commands — not to the system or installed plugin MCP servers.
5. The dev tools (`up`, `down`, `status`, `logs`, `vite_logs`) live on the `nteract-dev` server. They manage the dev daemon and build pipeline — prefer them over manual terminal commands when available.

## nteract-dev tool surface

The advertised tool list varies by mode:

**Owner/isolated mode** (Claude Code `.mcp.json`) — manages daemon lifecycle:

| Tool | Purpose |
|------|---------|
| `up` | Idempotent "bring the dev environment to a working state." Sweeps zombie Vite processes, ensures the daemon is running, ensures the MCP child is healthy. Optional args: `vite=true` to also start Vite, `rebuild=true` to rebuild daemon + Python bindings first, `mode='debug'\|'release'` to switch build mode. Safe to call repeatedly — this is the first thing to reach for when things feel off. |
| `down` | Stop the managed Vite dev server. Leaves the daemon running by default (launchd / the installed app may own it). Pass `daemon=true` to also stop the managed daemon process. |
| `status` | Read-only report of `nteract-dev`, child, daemon, and managed-process state. |
| `logs` | Tail the daemon log. Arg: `lines` (default 50). |
| `vite_logs` | Tail the Vite dev server log. Arg: `lines` (default 50). |

**Attach mode** (Codex `.codex/config.toml`) — connects to an existing daemon:

| Tool | Purpose |
|------|---------|
| `status` | Read-only report of `nteract-dev`, child, and daemon state. |
| `logs` | Tail the daemon log. Arg: `lines` (default 50). |
| `vite_logs` | Tail the Vite dev server log. Arg: `lines` (default 50). |

All modes proxy the full `runt mcp` notebook tool surface.

## MCP Server

`nteract-dev` proxies `runt mcp` (Rust-native, direct Automerge access, no Python overhead). It auto-builds `runt` on startup and watches `crates/runt-mcp/src/` for hot reload. For the installed app, `runt mcp` ships as a sidecar binary — no Python or uv required.

`nteract-dev` runs in explicit modes. Claude Code uses owner mode from
`.mcp.json`, so it may start, restart, rebuild, and stop the worktree daemon.
Codex app/CLI uses attach mode from `.codex/config.toml`, so it connects to an
already-running worktree daemon but does not own its lifecycle. Both configs set
`cwd = "."`; that is load-bearing because it starts `mcp-supervisor` from the
repo root, letting it derive this exact worktree instead of another checkout.
When falling back to manual commands, `cargo xtask dev-daemon`, `cargo xtask
notebook`, and `cargo xtask run-mcp` derive the current git worktree and pass
the dev env to subprocesses; direnv is not required for those xtask paths.

## System daemon CLI (`runt` / `runt-nightly`)

When running CLI commands against system-installed daemons from a dev environment, **always use `env -i`** to strip dev env vars (`RUNTIMED_DEV`, `RUNTIMED_WORKSPACE_PATH`) that would otherwise redirect commands to the per-worktree dev daemon:

**Important:** The repo's `bin/runt` (added to PATH by direnv) shadows `/usr/local/bin/runt` and always resolves to the dev build (nightly channel). When targeting system-installed daemons, use absolute paths:

```bash
# Nightly system daemon
env -i HOME=$HOME /usr/local/bin/runt-nightly diagnostics
env -i HOME=$HOME /usr/local/bin/runt-nightly daemon status

# Stable system daemon
env -i HOME=$HOME /usr/local/bin/runt diagnostics
env -i HOME=$HOME /usr/local/bin/runt daemon status
```

For the dev daemon, prefer `nteract-dev` tools or `cargo xtask` commands. If you
run `./target/debug/runt` directly, set `RUNTIMED_DEV=1` and
`RUNTIMED_WORKSPACE_PATH="$(pwd)"` unless your shell already has them.

## Verifying Daemon Isolation

Verify that the three MCP servers connect to the correct daemons:

```bash
# 1. Check nteract-dev status (should show worktrees/ socket)
status
# Expected socket: ~/.cache/runt-nightly/worktrees/{hash}/runtimed.sock

# Codex app/CLI should list a project-scoped nteract-dev with cwd "."
codex mcp get nteract-dev

# 2. List active notebooks on nteract-nightly (should show user's notebooks)
mcp__nteract-nightly__list_active_notebooks
# Should list real notebooks like coordination.ipynb

# 3. List active notebooks on nteract-dev (should be empty in fresh dev env)
mcp__nteract-dev__list_active_notebooks
# Should return []

# 4. Verify nteract-nightly MCP processes have NO dev env vars
ps aux | grep "runt.*mcp" | grep -v grep
# For each nteract-nightly PID:
cat /proc/{PID}/environ | tr '\0' '\n' | grep RUNTIMED
# Should return nothing — no RUNTIMED_DEV or RUNTIMED_WORKSPACE_PATH

# 5. Verify nteract-nightly daemon socket (should be system socket)
env -i HOME=$HOME /usr/local/bin/runt-nightly daemon status --json | jq -r '.socket_path'
# Expected: ~/.cache/runt-nightly/runtimed.sock (NOT worktrees/)
```

**Red flags:**
- nteract-dev socket path doesn't contain `worktrees/` → using system daemon instead of a worktree daemon
- nteract-nightly shows empty notebook list → connecting to dev daemon instead of system daemon
- nteract-nightly MCP process has `RUNTIMED_DEV=1` in environment → env var stripping failed
- Codex only lists `nteract-notebook` / `nightly` and not `nteract-dev` → the session is missing the project-scoped dev MCP config; use `cargo xtask` until the session is restarted from this repo

**Fix:** Start the dev daemon from the repo root with `cargo xtask dev-daemon`
or use the owner-mode `nteract-dev` `up` tool. Use direnv only if you want the
repo's `bin/` wrappers on PATH for interactive shell commands.
