# `@runtimed/agent-tools`

OpenCode and Kilo notebook tools backed directly by `@runtimed/node`.

The initial `notebook_run_source` tool attaches to an active nteract notebook,
appends a synced code cell, executes that cell, and returns the durable execution
identity and resolved outputs. Sessions are reused within an agent session and
closed when that agent session is deleted.

OpenCode and Kilo emit `session.deleted` during normal session cleanup, which
closes the corresponding `@runtimed/node` handles. If a host exits without that
event, terminating the host process closes its underlying daemon peer connection.

## OpenCode

Add the npm plugin to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@runtimed/agent-tools@0.1.0"]
}
```

## Kilo

Install the plugin for the current project:

```bash
kilo plugin @runtimed/agent-tools@0.1.0
```

Pass `--global` to install it into the user-wide Kilo configuration instead.

## Daemon selection

The plugin uses the default `runtimed` socket unless `RUNTIMED_SOCKET_PATH` is
set. Hosts such as Agentic Desktop should set this to their bundled daemon's
socket and install a package version matched to that daemon.

## Tool

`notebook_run_source` accepts:

- `notebook_id`: an active nteract notebook ID
- `source`: Python source for a new synced code cell
- `timeout_ms`: optional execution timeout

It returns JSON containing `notebook_id`, `cell_id`, `execution_id`, status,
success, and resolved outputs.

## Development

```bash
pnpm --dir packages/runtimed-agent-tools typecheck
pnpm --dir packages/runtimed-agent-tools test
pnpm --dir packages/runtimed-agent-tools smoke:hosts
RUNTIMED_SOCKET_PATH=/path/to/runtimed.sock pnpm --dir packages/runtimed-agent-tools smoke:live
pnpm --dir packages/runtimed-agent-tools pack:dry-run
```

The host smoke tests load the built local plugin through real OpenCode and Kilo
config directories without changing the user's global configuration.

The live smoke test creates a temporary notebook on the selected daemon, invokes
the same `notebook_run_source` handler registered with both hosts, verifies its
resolved output, and shuts the notebook down.
