# Preview Python (experimental)

On-demand notebook compute for our celld cloud deployment only. This package is
not enabled by default and is not a Desktop kernel or a generic Cloudflare
provider. See [the implementation plan](../../docs/plans/preview-python.md).

The initial adapter executes Python directly and returns notebook-shaped outputs
without ZeroMQ. The trusted supervisor and cloud runtime-peer integration are
under development. Do not expose the internal execution endpoint publicly.

The private provider bundle exports `PreviewPythonSessions` (a Durable Object
holding the deployment pool) and `PackageAssets` (immutable scientific wheels).
Its public Worker entrypoint returns 404. The cloud discovery integration is
disabled unless `NOTEBOOK_CLOUD_PYTHON_PROVIDER=celld` and the private
`PREVIEW_PYTHON_SESSIONS` namespace binding are both configured. Discovery
registers an owner-scoped managed workstation and fills an absent default;
it never replaces an existing default. The cloud room attaches a private compute
session as an Automerge runtime peer. This remains experimental and is not ready
for live deployment yet.

## Build

Run `pnpm --filter @nteract/preview-python build`. Runtime assets are pinned to
Pyodide 0.28.3 and verified against `runtime-lock.json`. Build output contains
local interpreter/stdlib assets; runtime startup does not fetch from a CDN.

## Provenance

The compiled-Wasm bootstrap follows the local celld Python Workers experiment
(branch `quod/python-workers`, based on celld 0.5.1). The execution/display
separation is informed by runtimed/runtime-agents' Pyodide agent used by anode.
The current evaluator is newly implemented; the managed provider and its
notebook integration remain implementation gates.
No notebook readiness or tenant-isolation claim follows from the build alone.

## Scientific environment and isolation

The pinned package graph includes IPython, pandas, NumPy and Matplotlib. Native
Wasm libraries are compiled at build time. Immutable wheel assets are provided
by a restricted internal service binding and verified again on initialization;
loaded session code stays below celld's module limit. Guest ambient networking
remains disabled. Package assets contain no user data or credentials.

The direct evaluator uses IPython formatters and display publishing, while code
uses Python AST evaluation with top-level await. IPython magics, shell escapes,
stdin, widgets, progressive output streaming and full IPython history semantics
are not currently supported. The trusted adapter bounds response bytes and
validates output records, stripping unknown properties and rejecting guest
supplied internal blob/widget references. Conversion into canonical runtime
output manifests uses the shared Rust MIME classifier, with notebook-scoped blob
storage. Python-side limits alone are not a security boundary.

Execution has independent CPU and wall deadlines. Expiration destroys the
interpreter, so variables are lost; it is not a resumable Python interrupt.
The cloud Interrupt action uses the same destructive session termination and
fences its runtime peer immediately. Start compute creates a clean replacement.
Only notebook owners can interrupt, and unconfirmed cleanup returns an error.
The current celld loader does not forward fetch cancellation and registry
disposal waits for outstanding calls. The adapter therefore invokes a private
termination endpoint with a tiny CPU budget to trigger celld's isolate
invalidation. Disposal also invalidates idle sessions because Python can leave
background tasks running after an execution returns. Failed termination retains
the capacity reservation. A native host termination API should replace this
mechanism when available. Startup has independent CPU and wall budgets too.
The wall deadline initiates host termination; synchronous initialization may
delay completion (a 250 ms test deadline completed in about 1.05 seconds).
Unconfirmed startup cleanup quarantines its admission slot.

Run the real isolated-server test with a qualified experimental celld binary:

```sh
CELLD_BIN=/absolute/path/to/celld pnpm --filter @nteract/preview-python test
```

The tests own temporary ports/storage/processes and save measurements under
`.scratch/`. This requires the Python Workers branch's hard-termination fixes;
unmodified celld 0.5.1 is not qualified for safe interpreter reuse after a CPU
limit.

For the full cloud browser path, build the provider and cloud viewer, then start
the local fleet with `NOTEBOOK_CLOUD_CELLD_PYTHON=1` and
`NOTEBOOK_CLOUD_CELLD_BIN=/absolute/path/to/celld` using
`apps/notebook-cloud/scripts/celld-local.mjs`. Run:

```sh
NOTEBOOK_CLOUD_MANAGED_PYTHON_ORIGIN=http://127.0.0.1:9876 \
  node apps/notebook-cloud/scripts/managed-python-browser-smoke.mjs
```

The smoke requires loopback dev authentication. It creates a notebook fixture
and tests first attachment, persistent variables, a viewing collaborator,
restart, reconnect, and interrupt/replacement. Fixtures remain in local storage;
stop/restart the local fleet between repeated runs to release its bounded
in-memory compute pool.
Its timings are single browser observations, not latency distributions or RSS.

When an owner opens a notebook with no selected compute, the celld room selects
the managed default as idle. Running the first synced code cell allocates its
interpreter; opening the notebook alone does not allocate a session. Existing
notebook selections and other default workstations are preserved. Editors and
viewers cannot trigger this selection or execute. The browser smoke uses this
first-run path by default; set `NOTEBOOK_CLOUD_PYTHON_EXPLICIT_ATTACH=1` to
exercise the separate Start compute path.
