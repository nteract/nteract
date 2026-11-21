# Pyodide runtime

The jailed Python machine used by nteract's managed cloud runtime peer.
It owns pinned Pyodide/scientific assets, IPython execution, and a celld loader adapter.
It receives room-accepted source with a cell ID and execution ID, then returns bounded notebook outputs.
It cannot connect to notebook rooms or author Automerge changes.

`apps/preview-python` owns the service: session admission, clean standbys, owner quotas, deduplication, and the nteract runtime peer.
The cloud app supplies room sync, authorization, and blob storage.
See the [boundary map](../../docs/memos/python-runtime-boundaries.md).

## Build and test

- Build this package: `pnpm --filter @nteract/pyodide-runtime build`
- Run unit tests: `pnpm --filter @nteract/pyodide-runtime test` (runs pinned Pyodide under Node, including IPython lifecycle and traceback attribution)
- Assemble service assets: `pnpm --filter @nteract/preview-python build` (real celld tests remain in the service app)
- Entry points: `./deployment` assembles immutable deployment assets; `./assets/*` exposes generated machine modules to the celld test harness.

The build imports `_traceback.py`, `_redact.py`, and `_format.py` directly from `python/nteract-kernel-launcher`.
Those are shared source, not copied forks.
A future standalone distribution must package that dependency explicitly.

## Semantics and limits

Execution uses IPython input transformation, `run_cell_async`, display hooks, in-memory input/output history, and pre/post execution events:

- **Supported**: top-level await, compatible magics, rich MIME representations, display updates, deferred clears, and automatic inline Matplotlib output.
- **Tracebacks**: structured in nteract's existing format with cell/execution/source provenance, including earlier cells.
- **No shell or network**: shell commands fail explicitly and grant no subprocess or network access.
- **Streaming and isolation**: every execution returns a bounded, validated batch. `/execute` with `stream: true` also emits advisory NDJSON stream lines first. Live lines reach the host when async cells yield; synchronous CPU work and `time.sleep` may defer them until completion (Python's sleep and asyncio behavior are not overridden). Background tasks cannot publish into another execution's output capture.
- **Not desktop kernel parity**: stdin, completion/inspection requests, widgets, and remaining launcher extensions are not wired here.
- **Termination**: interrupts and deadlines destroy the interpreter and lose variables. Neither prepared nor user-session snapshots exist.

Arrow tables and output budgets:

- **Arrow display**: pinned Pyodide 0.29.4 includes PyArrow 22.0.0. Arrow stream producers (including pandas DataFrames and PyArrow tables) display through sift as ordinary Arrow IPC MIME bytes.
- **Arrow cap**: the formatter reuses the launcher's Arrow stream import and writes at most 64 MiB of complete IPC bytes. Larger tables fail explicitly instead of silently sampling. Chunked Arrow manifests are not yet emitted.
- **Blob trust boundary**: the trusted room hashes and stores the bytes before publishing a blob reference. Guest-authored internal references remain rejected.
- **Output budgets**: rich output has a 128 MiB serialized budget per execution, plus a separate 2 MiB text-stream budget with a reserved diagnostic. The adapter independently caps the full result (including provenance and diagnostics) at 129 MiB.

## Package availability

The runtime is pinned to Pyodide 0.29.4.
Its build bundles the `ipython`, `numpy`, `pandas`, `matplotlib`, `micropip`, and `pyarrow` dependency closure from the hash-verified Pyodide lockfile.
The Packages panel's **Included with Python** inventory describes this deployed subset, not the full upstream Pyodide catalog.
Compiled libraries are packaged as static Wasm modules and loaded at interpreter initialization; the loader rejects unbundled modules.

Additional pure Python packages resolve through a disposable offline micropip planner:

- The trusted provider downloads bounded, hash-checked pure Python wheels from PyPI.
- The tenant installs local `emfs:` wheel paths with `deps=False`.
- Calling `micropip.install("name")` in a cell cannot reach that acquisition service because guest network access stays disabled.
- Use the Packages panel so successful requirements and pinned wheels are saved and restored on restart.

Compiled libraries outside the included subset need compatible Wasm artifacts, their dependency closure, and static loader qualification on celld.
Ordinary native PyPI wheels cannot run in this interpreter.
A newer upstream catalog or a successful Node import does not establish hosted support.
