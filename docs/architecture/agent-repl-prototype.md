# Agent REPL Prototype

**Status:** Draft, 2026-05-25.

**Prototype:** `examples/agent-repl/`

## Context

Sometimes an agent does not need a notebook. It just needs a Python process
that remembers `x = 3` on the next tool call.

That is not a criticism of notebooks. It is the boundary between two products:

- A **persistent agent REPL** is process state plus an execution API.
- A **notebook runtime** is durable, visual, restartable, shareable execution
  state connected to a document that humans edit and inspect.

nteract is intentionally built for the second thing. It owns room lifecycle,
Automerge sync, RuntimeStateDoc, kernel launch, output blob storage, renderer
plugins, dependency metadata, trust, save/load, and multi-peer reconnects. That
is useful machinery when the artifact is a notebook. It is a lot of machinery
if the only requirement is "run this next Python snippet in the same namespace."

Said another way: if all we need is `x = 3` to still exist on the next turn,
Automerge is a very impressive way to remember a dictionary entry.

## Shape

The prototype keeps the architecture deliberately small:

```text
MCP client or inline caller
    |
    v
ReplManager
    |
    v
named session -> worker Python process
                    |
                    v
                 IPython InteractiveShell.run_cell_async()
                 or stdlib eval/exec namespace
```

The important bit is the process boundary. The tool server should not execute
agent code in its own process. If the agent runs `while True: pass`, the session
can be killed and recreated without killing the MCP server.

## Tool Surface

The MCP server exposes four tools:

| Tool | Purpose |
|------|---------|
| `run_python` | Run code in a named persistent session. |
| `reset_python` | Kill and forget a named session. |
| `python_status` | Inspect one named session. |
| `list_python_sessions` | List sessions owned by the current MCP process. |

That is enough surface for an agent to build workflows:

```python
run_python("import pandas as pd")
run_python("df = pd.read_csv('data.csv')")
run_python("df.head()")
```

No cell IDs. No document heads. No output lookup tool. No separate active
notebook. The session name is the routing key.

## Backends

`backend="ipython"` is the useful default because IPython already solved the
interactive parts:

- complete-cell execution via `InteractiveShell.run_cell_async()`;
- top-level await;
- better tracebacks;
- magics;
- display capture and MIME bundles.

`backend="python"` is the stdlib fallback. It keeps a namespace and handles
expression-only snippets, but it does not pretend to be a rich notebook kernel.
That is fine for smoke tests and constrained environments.

`backend="auto"` tries IPython and falls back to stdlib Python.

## What This Avoids

This prototype intentionally has none of the following:

- Jupyter kernel protocol or ZMQ channels;
- Automerge documents;
- notebook cell order;
- durable execution IDs;
- output blob manifests;
- iframe renderer plugins;
- save/load;
- multi-window sync;
- dependency synchronization;
- trust gates;
- daemon upgrade/rejoin logic.

Those omissions are the point. A REPL tool should have a tiny surface area until
the product needs notebook properties.

## Where It Stops Being Enough

The simple REPL becomes the wrong abstraction when any of these become product
requirements:

1. **The user needs a durable artifact.** A process namespace is not a document.
   Once outputs must survive restart or be reviewed later, use a notebook-shaped
   runtime record.
2. **Humans need rich visuals.** MIME bundles can be returned through MCP, but
   rendering Plotly, Vega, widgets, iframes, and binary assets is exactly where
   nteract earns its complexity.
3. **Multiple peers need to watch or edit.** A worker process has no convergence
   story. nteract's room and document model exists because multi-peer state is
   not a REPL problem.
4. **Execution needs auditability.** If the consumer needs stable execution IDs,
   output ordering boundaries, causal terminal status, or post-hoc result lookup,
   the RuntimeStateDoc model is the right shape.
5. **Environment state matters.** Dependency metadata, trust, and reproducible
   environments are bigger than a persistent namespace.

## Presentation Framing

The clean distinction:

> A persistent REPL is "keep a Python process alive and send it code."
>
> A notebook is "make that execution durable, inspectable, replayable,
> shareable, visual, restartable, dependency-aware, and safe enough for humans
> to trust."
>
> nteract is overcomplicated for the first thing because it is built for the
> second thing.

The self-deprecating version:

> We built an excellent system for remembering execution as a collaborative
> document. Sometimes the right answer is a process with a dictionary and a kill
> switch.

## Run It

```bash
uv run --project examples/agent-repl agent-repl-mcp
```

Inline usage:

```python
from agent_repl import ReplManager

manager = ReplManager()
try:
    print(manager.run("x = 41"))
    print(manager.run("x + 1"))
finally:
    manager.close()
```

This is intentionally small enough to throw away. Its value is as a comparison
point: it shows which pieces are essential for a REPL and which pieces only
become essential once the artifact is a notebook.
