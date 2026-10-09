---
name: repl
description: Use nteract notebooks as a persistent Python REPL. Trigger this skill whenever you're about to run python3 -c, write a throwaway .py script, or chain multiple shell commands for data exploration, analysis, plotting, or iterative computation. Notebooks preserve state between cells, show rich output, and can be used in realtime with users.
---

# Use a Notebook Instead of python3 -c

When nteract notebook tools are available and you're about to do multi-step Python work — chaining `python3 -c` commands, writing a throwaway `.py` script, or running exploratory code — use a notebook-backed REPL instead. You get persistent state between cells, rich output (tables, plots, errors with tracebacks), and users and agents can view the notebook in realtime.

Prefer the direct pi tools when present:

- `python` — execute code in the persistent notebook session.
- `python_add_dependencies` — batch-add packages and hot-sync the environment.
- `python_save_notebook` — save the backing notebook.

If only MCP tools are available, use `create_notebook`, `create_cell`, `execute_cell`, `set_cell`, `inspect_notebook`, and `get_results`.

## If the notebook tools aren't appearing

If you loaded this skill but neither the direct pi tools (`python`, `python_add_dependencies`) nor the MCP notebook tools are available, don't fall back to `python3 -c`. Ask the user to verify that the nteract plugin is installed and enabled in Codex, then restart Codex after any plugin or marketplace changes. The most common cause is that the plugin was installed or updated after the current Codex session started.

If Codex reports the plugin is installed but the tools still do not appear, ask the user to refresh and reinstall the selected plugin to clear stale local cache state:

```sh
codex plugin marketplace upgrade nteract-plugins
codex plugin remove nteract@nteract-plugins      # or nightly@nteract-plugins
codex plugin add nteract@nteract-plugins         # or nightly@nteract-plugins
codex mcp list
```

Start a new Codex session after reinstalling; running sessions do not hot-load newly installed MCP tools.

If tools still don't appear after restarting Codex:

- Confirm the nteract desktop app/daemon is running.
- Run `nteract doctor` to check the installation (`nteract --channel nightly doctor` for the Nightly install).
- Share any error messages from the session.

## Quick Start (direct pi tools)

```json
python({
  "code": "import numpy as np\nnp.arange(3)",
  "dependencies": ["numpy"]
})
```

Pass `dependencies` on the first `python` call when imports may be missing. The pi REPL records them before kernel startup when possible; later dependency additions use hot-sync.

## Quick Start (MCP tools)

```
create_notebook(dependencies=["numpy"])
# Keep notebook_id as n and notebook_handle as h for deliberate release.
create_cell(notebook_id=n, source="import numpy as np\nnp.arange(3)", cell_type="code", and_run=true)
```

## MCP notebook targets and handles

Keep `notebook_id` from `create_notebook` or `connect_notebook` and pass it on
every notebook call. Hosted notebooks also need their configured `domain`;
omitting it always selects this server's local daemon. A `cell_id` identifies
a cell inside the selected notebook, never the notebook itself.

An existing `notebook_handle` still works instead of ID/domain. It identifies
one independent attachment, with no TTL. `disconnect_notebook` requires that
exact handle; expired handles never rebind. Use the target form advertised by
the running server when working with an older installation.

ID calls use an already connected, authorized replica and retain one shared
address owner per notebook/authority. They do not open a peer or start a kernel.
If the server returns `notebook_not_connected`, connect to the same ID/domain
and retry. Releasing the original connect handle leaves the address owner
available. The `target.notebook_handle` returned by an ID call can deliberately
release that shared retention; it is not a chat-private lease. Existing separate
handles and already admitted ID operations remain independent.

One MCP process may serve unrelated chats. Never infer your target from the
last connect call, client label, or another chat's result. If a mutation's
outcome is unknown, inspect the notebook and its execution results before
repeating it.

Use `inspect_notebook(notebook_id=n)` for bounded cells, source previews,
readiness and resource links. `cell_ids`, `start`/`count`, and `full_source` with
`source_start`/`source_chars` select bounded chunks. Pagination reads live state;
compare cursors before combining pages after edits. Resource-aware hosts should
use the returned resources and subscriptions for ongoing observation. Tool-only
hosts can call inspect with `after=cursor, timeout_secs=25`; without a cursor it
returns an immediate baseline.

`execute_cell` and `and_run` already wait for an initial result. If a run is
still active, continue with `get_results(notebook_id=n, execution_id=e,
timeout_secs=25)`. This waits for the same run; executing again starts another
run. Get-results and inspect waits default to zero and allow up to 50 seconds.
Canceling observation does not interrupt computation. The older
`wait_for_notebook_change` call remains callable for compatibility but is not
advertised.

## Core Workflow

1. **Start or reuse a notebook-backed REPL:**
   - Direct: call `python(...)`; the session is created lazily and state persists.
   - MCP: call `create_notebook(...)` or `connect_notebook(...)` and retain its `notebook_id` as `n` and release handle as `h`.

2. **Declare dependencies before import-heavy code:**
   - Direct: pass `dependencies` to `python` or call `python_add_dependencies`.
   - MCP: pass `dependencies` to `create_notebook` or use `manage_dependencies(notebook_id=n, ...)`.

3. **Run and iterate:**
   - Direct: call `python` repeatedly; variables/imports persist.
   - MCP: edit with `set_cell(notebook_id=n, ...)` and rerun with `execute_cell(notebook_id=n, cell_id=...)`.

4. **Check your work:**
   - Direct: inspect returned text/images/tables.
   - MCP: `inspect_notebook(notebook_id=n)` and `get_results(notebook_id=n, execution_id=..., timeout_secs=25)` for an existing run.

5. **Save when done:**
   `python_save_notebook(...)` or `save_notebook(notebook_id=n, ...)`.

6. **Open the app for the user:**
   `show_notebook(notebook_id=n)` when they ask to see the MCP notebook. This can be disruptive if unexpected.

## When to Use This

- Exploring a dataset (load, filter, plot, iterate)
- Running multi-step computations where later steps depend on earlier results
- Generating visualizations (matplotlib, plotly, altair)
- Prototyping code that you'll refine over several iterations
- Any task where you'd otherwise chain 3+ `python3 -c` commands

## When NOT to Use This

- One-shot commands (`python3 -c "print(2+2)"` is fine as-is)
- Running existing scripts (`python3 script.py`)
- Non-Python tasks
