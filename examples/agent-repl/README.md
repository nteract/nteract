# Agent REPL Prototype

This is a deliberately small persistent Python REPL for agents. It is not part
of the nteract runtime stack; it is a reference prototype for the case where an
agent only needs process-local Python state across tool calls.

## Run As An MCP Server

```bash
uv run --project examples/agent-repl agent-repl-mcp
```

Example MCP client config:

```json
{
  "command": "uv",
  "args": ["run", "--project", "examples/agent-repl", "agent-repl-mcp"],
  "working_directory": "/path/to/nteract"
}
```

The MCP server exposes four tools:

- `run_python(code, session, timeout_s, backend)`
- `reset_python(session)`
- `python_status(session)`
- `list_python_sessions()`

## Use Inline

```python
from agent_repl import ReplManager

manager = ReplManager()
try:
    print(manager.run("x = 41"))
    print(manager.run("x + 1"))
finally:
    manager.close()
```

## Backends

- `ipython` uses `InteractiveShell.run_cell_async()` and captures stdout,
  stderr, and rich display payloads.
- `python` uses only the standard library. It preserves a session namespace and
  reports a value for expression-only cells, but it intentionally does not try
  to recreate IPython's display machinery.

`backend="auto"` tries IPython first and falls back to standard Python.

## Prototype Boundaries

Each named session is one worker process. If a run times out, the worker is
killed and that session state is lost. That is the point: this keeps the MCP
server recoverable when code hangs.

This does not provide notebook persistence, multi-client document sync,
dependency management, output blob storage, renderer plugins, or durable cell
history. Those are nteract-shaped problems. This prototype is just a REPL.
