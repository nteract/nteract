# Preview Python (experimental)

On-demand notebook compute for our celld cloud deployment only. This package is
not enabled by default and is not a Desktop kernel or a generic Cloudflare
provider. See [the implementation plan](../../docs/plans/preview-python.md).

This app owns the session pool and nteract runtime peer. The isolated interpreter,
IPython execution, pinned assets, and celld loader live in
[`@nteract/pyodide-runtime`](../../packages/pyodide-runtime/README.md).
The [boundary map](../../docs/memos/python-runtime-boundaries.md) describes their
deployment, authority, execution lineage, and the remaining async work.

The initial adapter executes Python directly and returns notebook-shaped outputs
without ZeroMQ. A trusted supervisor bridges accepted notebook executions to
isolated interpreters. Do not expose the internal execution endpoint publicly.

The private provider bundle exports `PreviewPythonSessions` (a Durable Object
holding the deployment pool) and `PackageAssets` (immutable scientific wheels).
Its public Worker entrypoint returns 404. The cloud discovery integration is
disabled unless `NOTEBOOK_CLOUD_PYTHON_PROVIDER=celld` and the private
`PREVIEW_PYTHON_SESSIONS` namespace binding are both configured. Discovery
registers an owner-scoped managed workstation and fills an absent default;
it never replaces an existing default. The cloud room attaches a private compute
session as an Automerge runtime peer. This remains experimental and requires a
qualified celld deployment.

## Build

Run `pnpm --filter @nteract/preview-python build`. Runtime assets are pinned to
Pyodide 0.28.3 and verified against the machine package's `runtime-lock.json`. Build output contains
local interpreter/stdlib assets; runtime startup does not fetch from a CDN.

## Provenance

The compiled-Wasm bootstrap follows the local celld Python Workers experiment
(branch `quod/python-workers`, based on celld 0.5.1). The execution/display
separation is informed by runtimed/runtime-agents' Pyodide agent used by anode.
The current evaluator and managed cloud integration are newly implemented.
No notebook readiness or tenant-isolation claim follows from the build alone.

## Scientific environment and isolation

The pinned package graph includes IPython, pandas, NumPy and Matplotlib. Native
Wasm libraries are compiled at build time. Immutable wheel assets are provided
by a restricted internal service binding and verified again on initialization;
loaded session code stays below celld's module limit. Guest ambient networking
remains disabled. Package assets contain no user data or credentials.

The evaluator uses IPython's cell lifecycle, input transformations, display hooks,
in-memory history, top-level await and inline Matplotlib events. It reuses the
launcher's structured traceback formatter with cell/execution/source provenance.
Compatible in-process magics work. Shell escapes, stdin, widgets, completion and
inspection transport, Arrow buffers and progressive output streaming are not
currently supported. The trusted adapter bounds response bytes and
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
named control method with a tiny CPU budget to trigger celld's isolate
invalidation. The method does not read mutable guest globals or invoke Python.
A second control call must receive the exact host invalidation marker before
the slot is released; a returned value or guest-wrapped exception is rejected. Disposal also invalidates idle sessions because Python can leave
background tasks running after an execution returns. Failed termination retains
the capacity reservation. A native host termination API should replace this
mechanism when available. Startup has independent CPU and wall budgets too.
The wall deadline initiates host termination; synchronous initialization may
delay completion (a 250 ms test deadline completed in about 1.05 seconds).
Unconfirmed startup cleanup quarantines its admission slot.
If that failure occurs while preparing a standby, automatic warming stops until
the provider restarts. Explicit notebook allocations can use remaining capacity;
discovery polling cannot consume every slot with failed background starts.

Closing a session permanently fences its owner/notebook/session generation,
including when close arrives before open. These small fence records survive
provider reconstruction and are retained indefinitely: the protocol has no
maximum delayed-request age that would make expiry safe. Runtime disposal can
be retried after a failure, while owner and deployment capacity stay reserved
until cleanup is confirmed. Expiry and shutdown still attempt healthy siblings
when another session cannot be cleaned up.
The alarm arms its next sweep first and logs cleanup failures without rejecting
the sweep; failure to store the next alarm still propagates.

Provider bookkeeping tests do not qualify the native or hosted lifecycle.
Qualification must exercise the supported deployment's execution and cleanup
paths, including the ownership boundaries tracked in
[HTTP shared-promise ownership](https://github.com/nteract/nteract/issues/4296)
and [stale-activation Storage/WebSocket authority](https://github.com/nteract/nteract/issues/4295).

## Notebook packages

The shared package rail shows the shipped Python packages and versions before
starting compute. The build generates this inventory from the pinned wheel
closure; it is not the full Pyodide package catalog. A ready interpreter verifies
the shipped versions and reports its current installed inventory separately.

Notebook owners can install supported PyPI packages into a running cloud Python
session. The trusted provider resolves and downloads bounded, hash-verified
pure-Python wheels. Installation runs offline in the notebook's interpreter;
guest networking remains disabled. Native packages outside the shipped Pyodide
environment, source builds, direct URLs and custom indexes are unsupported.

Successful requests are saved in NotebookDoc with a resolved wheel manifest.
Fresh compute restores those wheels before executing queued notebook cells.
The rail distinguishes saved requirements, installed additions (including their
dependencies), and included defaults. Removing a saved requirement changes the
next fresh session; it does not unload a package from the running interpreter.
Failed or uncertain installations do not save new requirements. An uncertain
interpreter mutation requires a restart; cancelled executions are not replayed.
Editors and viewers can inspect package state but cannot install or remove packages.
Desktop environments continue to use uv, conda or pixi.

Package operations share one active acquisition/install buffer set per deployment,
with at most four FIFO waiters and one outstanding request per owner. Waiting
owns no artifact buffers and can be cancelled. Acquisition has a two-minute
deadline, followed by installation's separate thirty-second wall deadline.
A queued turn can wait up to twelve minutes: four preceding turns with thirty
seconds each allowed for cleanup. The browser allows another two and a half
minutes for active work and a minute for an already-running cell and the final
room checkpoint, for a total of fifteen and a half minutes. Host termination or
persistence stalls can still produce an unconfirmed result; these allowances
do not establish a host-level completion guarantee.
The room's three-minute capacity retry window applies
only to rejected admission, not to a request already holding its FIFO place.
Adds have a five-second per-owner cooldown with bounded recent-owner bookkeeping.
The resolver can create one additional planner interpreter per deployment outside
the tenant session quota. It is disposed after each resolution; unconfirmed
cleanup retains its reservation until provider recovery.

The package integration test owns its celld process and temporary storage. It
requires network access for the provider's PyPI acquisition and checks install,
import/output, unsupported-package failure, restore into fresh compute and denied
guest network access:

```sh
CELLD_BIN=/absolute/path/to/celld NTERACT_PACKAGE_NETWORK_TEST=1 \
  node --test apps/preview-python/test/packages-celld.test.mjs
```

## Runtime qualification

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
Each run reports browser-to-output timing, separately from provider benchmarks
and RSS measurements.

When an owner opens a notebook with no selected compute, the celld room selects
the managed default as idle. Running the first synced code cell allocates its
interpreter; opening the notebook alone does not allocate a session. Existing
notebook selections and other default workstations are preserved. Editors and
viewers cannot trigger this selection or execute. The browser smoke uses this
first-run path by default; set `NOTEBOOK_CLOUD_PYTHON_EXPLICIT_ATTACH=1` to
exercise the separate Start compute path.

Run the isolated provider benchmark after building:

```sh
CELLD_BIN=/path/to/qualified/celld node apps/preview-python/test/benchmark.mjs
```

It writes `.scratch/benchmark-evidence.json` with raw samples, process RSS,
capacity rejection and four concurrent isolated namespaces. `PYTHON_BENCH_TRIALS`
defaults to five. The measurement boundary is loopback `/open` through a complete
`/execute` response, excluding fleet boot, asset build, browser and room sync.
Warm trials explicitly await a clean standby. Cold trials use fresh host
processes but share the operating system's file cache.

On an Apple M3 Max (macOS arm64, 2026-09-23), five trials measured:

| First output | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: |
| Cold provider | 4414 ms | 4430 ms | 4463 ms |
| Prepared interpreter | 10.0 ms | 10.2 ms | 13.1 ms |

Five fresh-fleet browser runs separately measured Run-to-visible-output at
4919–4929 ms (median 4923 ms), passing all 12 collaboration and lifecycle checks.
The smoke deliberately sends an execution before releasing its source sync to
verify causal ordering on the same socket. A prepared-standby browser observation
measured 389 ms; that single observation is not a warm-browser distribution.

These small samples are observations, not production latency estimates.
Summed supervisor/child-process RSS was 365 MiB before interpreter creation,
973 MiB with one clean standby after the latency trials, and 1695 MiB with
four ready interpreters. The first three assignments each triggered another clean standby, increasing
RSS by 181, 238 and 279 MiB respectively. The fourth assignment consumed the
standby rather than creating a fifth interpreter. Four simultaneous executions
preserved separate namespaces; a fifth allocation returned capacity exhaustion,
and terminating a session allowed a replacement.

RSS includes the provider, compiler/native caches, allocator retention and
shared-page accounting; it is not a per-interpreter heap measurement. After all
sessions were terminated, RSS remained 1248 MiB in this immediate sample.
Disposal releases admission capacity but does not promise immediate RSS return
to the operating system. This scientific package set therefore needs hundreds
of MiB per additional ready interpreter, even though warm execution is fast.

Authenticated discovery starts preparing one clean interpreter in the background;
it does not allocate a notebook session. The room transitions idle compute after
30 minutes. The provider's orphan-session sweep waits 35 minutes, leaving time
for the room to publish idle state and terminate normally. This fallback bounds
orphan retention if room cleanup fails; discovery polling does not postpone it.

IPython `clear_output` and display-handle updates are routed through the runtime
output model. Display updates preserve output IDs and can update matching
outputs from earlier executions. A deferred clear waits for the next output in
that execution. Consecutive writes to the same stream coalesce into one output
record, so the per-execution output-count limit applies to distinct outputs
rather than to each `print` argument and newline. Outputs are still delivered as a batch when execution completes;
progressive streaming and widget comms are not implemented yet.

The deployment admits at most four interpreters and each authenticated compute
owner may hold at most two sessions. The server's attach job identifies that
owner, who may differ from the notebook creator. Owner access is checked again
before startup, resume and new execution; revoked access cannot be restored by
resuming an old attachment. Pending allocations and retiring sessions
count against the owner's limit until destruction is confirmed; uncertain
cleanup keeps both owner and deployment reservations. A user at their limit
must stop another notebook session before starting a third. Clean unassigned
standbys count against deployment capacity, not an owner's allowance.

Preview Python is deployment-managed, so its workstation registration cannot be
deleted while this provider is enabled. Choose a different default workstation
to use your own compute. Disabling the deployment flag stops managed discovery;
ordinary workstation deregistration then works as before.
