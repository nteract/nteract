# Pyodide runtime

The jailed Python machine used by nteract's managed cloud runtime peer. It owns
pinned Pyodide/scientific assets, IPython execution, and a celld loader adapter.
It receives accepted source with a cell ID and execution ID and returns bounded
notebook outputs. It cannot connect to notebook rooms or author Automerge changes.

`apps/preview-python` owns the service: session admission, clean standbys, owner
quotas, deduplication, and the nteract runtime peer. The cloud app supplies room
sync, authorization, and blob storage. See the
[boundary map](../../docs/memos/python-runtime-boundaries.md).

Build with `pnpm --filter @nteract/pyodide-runtime build`, then run
`pnpm --filter @nteract/pyodide-runtime test`. Tests use the pinned Pyodide itself
under Node, including IPython lifecycle and traceback attribution. Building the
provider with `pnpm --filter @nteract/preview-python build` assembles these assets
into its existing deployment layout. Real celld tests remain in the service app.
The `./deployment` entrypoint assembles the immutable deployment assets; `./assets/*`
exposes generated machine modules to the celld test harness.

The build imports the launcher's `_traceback.py` and `_redact.py` directly from
`python/nteract-kernel-launcher`. Those are shared source, not copied forks. A
future standalone distribution must package that dependency explicitly.

## Semantics and limits

Execution uses IPython input transformation, `run_cell_async`, display hooks,
in-memory input/output history, and pre/post execution events. Top-level await,
compatible magics, rich MIME representations, display updates, deferred clears,
and automatic inline Matplotlib output work. Structured tracebacks use nteract's
existing format with cell/execution/source provenance, including earlier cells.
Shell commands fail explicitly; this does not grant subprocess or network access.

Output remains a bounded, validated batch per execution; `/execute` with
`stream: true` additionally returns advisory NDJSON stream lines before it. Background tasks cannot publish
into another execution's output capture. This is not full desktop kernel parity:
stdin, completion/inspection requests, widgets, Arrow buffer transport, and the
remaining launcher extensions are not wired here. `RuntimeControl.interrupt()`
requests a `KeyboardInterrupt` that the cell honors at output writes,
`time.sleep` and awaits, keeping its variables; a cell that never yields, or any
deadline-terminated interpreter, loses variables. Neither prepared nor
user-session snapshots exist.
