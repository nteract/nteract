# `@runtimed/node`

Run Python from Node in a kernel that stays alive between calls.
Variables and imports persist, dependencies install mid-session via uv, and plots return as image data in cell results.

**Before** (new process every call, no memory):

```js
execSync('python -c "import pandas as pd; df = pd.read_csv(\'data.csv\'); print(df.shape)"');
// next call: pandas re-imported, df gone, startup cost paid again
```

**After** (one session, state sticks):

```js
const { createNotebook } = require("@runtimed/node");

async function main() {
  const session = await createNotebook({ workingDir: "./project" });

  await session.runCell('import pandas as pd; df = pd.read_csv("data.csv")');
  await session.runCell('df.groupby("region").sum()'); // df still there

  await session.addDependencies(["seaborn"]); // no restart
  await session.syncEnvironment(); // df survives this

  const result = await session.runCell(
    "import seaborn as sns; sns.heatmap(df.corr(numeric_only=True))",
  );

  // Plot arrives as a display_data output. `dataJson` carries base64 PNG under
  // "image/png"; `blobUrlsJson` carries a daemon URL for the same bytes.
  const plot = result.outputs.find((output) => output.outputType === "display_data");
  console.log(Object.keys(JSON.parse(plot.dataJson))); // ["image/png", "text/plain", ...]
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Built for agent loops where one session spans many turns.
Startup takes a couple of seconds, then each later call is cheap.
Running a script once? Use a subprocess.

This package provides Node.js bindings for the nteract `runtimed` daemon.
Node, Bun, and other CommonJS-compatible runtimes can create notebooks, run Python cells, queue executions, read outputs, save notebooks, and manage dependencies through the same local daemon used by nteract desktop.

## Embedding a notebook frontend

### Native binding attribution

- Native platform packages (`@runtimed/node-<platform>`) ship `LICENSE.nteract`, `THIRD_PARTY_NOTICES.txt`, and `sbom.cdx.json` beside the `.node` binary. Keep these files when bundling the binding into Electron or another host.
- The wrapper installs the matching platform package as an optional dependency. Its README points to those target-specific files instead of substituting daemon notices for the binding's Rust dependency graph.
- `sbom.cdx.json` records the npm release version, source commit, Rust target, and binary SHA-256. It is a conservative dependency inventory, not a substitute for license texts or copyright notices.
- Preserve accessible notices and make corresponding MPL-covered source (including covered-file changes) available to recipients.
- Downloaded kernels/tools, the daemon, notebook UI, and host additions have separate attribution obligations; these files do not establish complete product compliance.

### Host telemetry permission

Host-attributed telemetry sits behind the daemon's default-off `NTERACT_HOST_TELEMETRY_ENABLE=1` gate.
Deploy the receiver's `host_id` schema and confirm privacy disclosure before enabling it.
Debug/dev/CI suppression, `NTERACT_TELEMETRY_DISABLE`, and a global nteract telemetry opt-out still prevent sending.

`openTelemetryRegistration` opens a separate daemon control connection without modifying onboarding, consent settings, or notebook documents.
Aggregate active notebook windows in the host's main process and keep one registration per product/source while the integration is active (starting a daemon alone is not notebook activity).

```js
const runtime = require("@runtimed/node");

// Older packages and daemons remain usable without host-attributed telemetry.
const telemetry = await runtime.openTelemetryRegistration?.({
  socketPath: selectedDaemonSocket,
  hostId: "example-desktop", // Product slug, never a machine or account identity.
  source: "app", // "app" or "mcp".
  allowed: false,
});

// Recheck current permission and activity after the asynchronous open finishes.
await telemetry?.updatePermission(currentPermission && notebookIsActive);
// Await withdrawal when the privacy choice changes.
await telemetry?.updatePermission(false);
// Close when the last notebook closes or the host shuts down.
await telemetry?.close();
```

Registration lifecycle and boundaries:

- **Failures and defaults**: an unsupported daemon or unavailable capability probe returns `null`. Initial connection failures or conflicting owners reject; never let telemetry failures block notebook operation. Permission defaults to denied when omitted.
- **Leases**: native lease renewal keeps the connection's permission alive, but never reconnects or regrants after failure. Open a new registration with the current privacy choice, never a saved grant.
- **Revocation**: a successful withdrawal or `close()` acknowledges server-side revocation, though already-sent HTTP requests cannot be recalled. On connection failure, the daemon drops ownership on disconnect or lease expiry; do not treat a failed close as confirmed immediate revocation.
- **Disclosure and IDs**: the host owns disclosure, permission, and live opt-out propagation. Pass a stable product slug as `hostId`, never an install ID, email, hostname, or notebook ID. The daemon supplies its opaque install ID and nteract component version (same-channel installs can share that ID; no cross-channel or account join happens). Unattributed legacy daemon heartbeats do not prove first-party use.

### Explicit project manifest creation

The local Node host can create a missing `environment.yml` when the user or host explicitly requests it.
Pass an existing absolute directory and the desired Conda specs; opening a notebook never calls this helper automatically.

```js
const { initializeEnvironmentYml } = require("@runtimed/node");

const manifestPath = await initializeEnvironmentYml({
  directory: "/absolute/path/to/project",
  name: "analysis",
  python: ">=3.11,<3.13",
  dependencies: ["numpy>=2,<3", "pandas"],
  channels: ["conda-forge"],
});
```

Validation and boundaries:

- **Validation and atomicity**: validates with the same parser as daemon discovery, then writes `environment.yml` atomically without replacing an existing file or symlink. It checks for an existing `environment.yaml` first (hosts must coordinate concurrent writers to that alternate filename). On Unix, permissions honor the host umask.
- **Inputs**: rejects invalid specs and missing or unwritable directories. `name` is optional; channel priority follows array order. Specify Python in `python` or `dependencies`, not both. Supports Conda dependencies only (pip subsections and other formats are separate work).
- **Local-only scope**: this is a local filesystem write for a host process with directory write authority. Neither the Electron renderer bridge nor remote notebook requests expose it. It does not contact the daemon, install packages, approve trust, or launch/change a kernel.
- **Discovery precedence**: open or reopen a notebook in that directory for normal discovery (`pyproject.toml`, `pixi.toml`, then `environment.yml`). Installing environments and launching kernels still use the explicit launch and approval flow, and running notebooks are unaffected.

### Notebook relay

`@runtimed/node/relay` exposes the native byte pipe used by desktop notebook hosts.
The browser/WASM frontend stays the Automerge peer.
Node owns the daemon socket, handshake, framing, and liveness heartbeat, forwarding opaque typed frames to the browser transport.

```js
const { createRelay } = require("@runtimed/node/relay");

const relay = await createRelay({
  workingDir: process.cwd(),
  ephemeral: true,
  description: "embedded notebook",
});

relay.onFrame((frame) => browserTransport.send(frame));
browserTransport.on("message", (frame) => relay.send(frame));
browserTransport.on("close", () => relay.close());
```

Daemon probes and compatibility metadata:

- **Socket helpers**: `defaultSocketPath()`, `socketPathForChannel("stable" | "nightly")`, and `queryDaemonInfo({ socketPath })` live in `@runtimed/node/relay`. Use the explicit channel helper when the host channel differs from the package's compile-time default.
- **`queryDaemonInfo` results**: returns `null` if the socket is absent, unready, or an older daemon cannot answer. Responding daemons return `protocolVersion`, `daemonApiVersion` (`0` when unreported), and an optional `compatibilityError` computed by the shared Rust checker. The probe never starts or replaces a daemon.
- **Handshake vs. probe**: `RelaySession.info.daemonVersion` comes from that notebook's exact handshake and stays `undefined` if an older daemon omits it (never backfilled from a later probe, which could race a restart). Treat it as diagnostic metadata. Compatibility depends on the negotiated protocol version and advertised capabilities. Because the daemon can change between calls, the pool probe is only a preflight diagnostic, not authentication or a guarantee for later connections.

Framing and delivery:

- Frames include the one-byte notebook frame discriminator and omit the daemon socket's length prefix; empty buffers are rejected.
- The relay subscribes to native delivery eagerly so bootstrap frames are retained.
- JavaScript frame handlers run serially to preserve order; forward or copy frames quickly instead of doing expensive work inline.

Electron hosts can attach a relay directly to one transferred `MessagePortMain` without a loopback listener:

```js
const { MessageChannelMain } = require("electron");
const { createRelay } = require("@runtimed/node/relay");
const { serveElectronNotebookHost } = require("@runtimed/node/electron");

const relay = await createRelay({ notebookId: authorizedNotebookId });
const { port1, port2 } = new MessageChannelMain();

serveElectronNotebookHost({
  port: port1,
  relay,
  handler: {
    invoke(method, params) {
      return invokeAuthorizedHostMethod(method, params);
    },
  },
});

browserWindow.webContents.postMessage("notebook:port", null, [port2]);
```

Host responsibilities and close semantics:

- `@runtimed/node/electron` validates the host-method allowlist and multiplexes opaque protocol-numbered notebook frames, host requests, notifications, and events over the port.
- The relay is Electron-free. The embedding host owns notebook authorization, path validation, dialogs, custom protocols, CSP, browser-peer authentication, window lifecycle, output CSP, and daemon installation.
- `connectRelay(notebookId)` is an operator connection, not an authorization check. Authorize notebook IDs in the host and never expose room discovery or relay creation to untrusted browser contexts.
- `close()` is terminal cancellation. Natural daemon closure drains frames queued for JavaScript before notifying `onClose`; calling `close()` before a browser peer subscribes discards buffered bootstrap frames.

For a daemon-backed transport check during development:

```bash
RUNTIMED_SOCKET_PATH=/path/to/runtimed.sock \
  pnpm --dir packages/runtimed-node smoke:relay
```

## Install

```bash
npm install @runtimed/node
```

`@runtimed/node` ships a small JavaScript wrapper plus TypeScript declarations.
The native binding is installed through an optional platform package such as
`@runtimed/node-darwin-arm64` or `@runtimed/node-linux-x64-gnu`.

## Basic Usage

```js
const { createNotebook, defaultSocketPath } = require("@runtimed/node");

async function main() {
  const session = await createNotebook({
    runtime: "python",
    workingDir: process.cwd(),
    // Record these before the first cell runs.
    dependencies: ["numpy", "matplotlib"],
    description: "plotting smoke test",
  });

  try {
    console.log("daemon socket:", defaultSocketPath());

    await session.syncEnvironment();

    const result = await session.runCell(`
import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 6.28, 200)
plt.plot(x, np.sin(x))
plt.show()
`);
    console.log(result.status);
    console.log(result.outputs);

    await session.saveNotebook();
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

## Notebook Dependencies

Pass `dependencies` to `createNotebook()` to declare packages up front instead of hitting an import error and retrying with `addDependencies()`.
When `packageManager` is omitted, the daemon and user environment choice stay in charge.
Later dependency edits infer the manager from the running kernel, inline notebook metadata (`uv`, then `conda`, then `pixi`), or a detected project file.
Fresh Python notebooks with no other signal fall back to UV.
Pass the native `PackageManager` string enum (`"uv"`, `"conda"`, or `"pixi"`) only to target a specific metadata section.
`description` sets a human-readable peer label for agent-created sessions.

## API Surface

- `defaultSocketPath()` returns the socket path for the current nteract channel
  or the `RUNTIMED_SOCKET_PATH` override.
- `socketPathForChannel("stable" | "nightly")` returns a channel-specific
  daemon socket path.
- `listActiveNotebooks(options)` lists active daemon notebook rooms.
- `createNotebook(options)` creates a notebook and records optional first-call dependencies.
- `openNotebook(notebookId, options)` connects to an existing daemon notebook.
- `openNotebookPath(path, options)` opens a notebook file through the daemon.
- `showNotebook(options)` opens an active notebook or path in nteract Desktop,
  returning a structured `opened: false` response in headless environments.
- `shutdownNotebook(notebookId, options)` shuts down a notebook room by ID.
- `getExecutionResult(executionId, options)` reads a result by execution ID.
- `Session.listCells()` and `Session.getCell(cellId)` inspect notebook cells.
- `Session.createCell(source, options)`, `Session.setCell(cellId, options)`,
  `Session.deleteCell(cellId)`, and `Session.moveCell(cellId, options)` edit
  notebooks directly without MCP JSON round-trips. `createCell()` appends by
  default; pass `index: 0` to prepend or `afterCellId` to insert after a cell.
- `Session.executeCell(cellId, options)` runs an existing code cell.
- `Session.showNotebook()` opens the session in nteract Desktop when a display
  is available.
- `Session.interruptKernel()` and `Session.shutdownKernel()` manage the running
  kernel.
- `Session.restartKernel({ timeoutMs? })` restarts the kernel and discards its
  in-memory state. It resolves only after this session's runtime state shows the
  old kernel stopped and then a kernel `Running` with the envSource (and local
  environment ID, when the daemon reports one) of the accepted launch. A launch
  reply alone, or an earlier snapshot, never resolves it.
  Every other ending rejects. `timeoutMs` (default 30000) bounds each client
  wait; the daemon's environment preparation keeps its own deadline.
- `Session.restartKernelResult({ timeoutMs? })` runs the same restart and
  returns `{ outcome, error?, launchedEnvSource?, status }`. `outcome` is
  `running`, `trust_required`, `launch_rejected`, `failed`, `stopped`, or
  `timed_out`. `status` reports an observed Running kernel after a stopped state only for `running`;
  confirmation matches the accepted environment source and local environment ID when supplied. The
  protocol has no launch generation, so a concurrent restart by another peer
  of the same environment cannot be distinguished from this call's launch.
- `Session.shutdownNotebook()` shuts down this notebook room and closes the session.
- `Session.runCell(source, options)` appends, runs, and waits for a cell.
- `Session.queueCell(source, options)` appends a cell, queues it, and returns IDs.
- `Session.waitForExecution(executionId, options)` waits for queued work.
  Pass `onUpdate(progress)` to receive resolved output snapshots while running.
- `Session.runtimeState$`, `Session.executionTransitions$`,
  `Session.executionViewChanges$`, `Session.cellChanges$`, `Session.broadcasts$`,
  and `Session.sessionStatus$` expose the same projected event families used by
  the browser sync engine.
- `Session.getExecutionView()` returns the current materialized execution view:
  non-null notebook cell pointers, execution snapshots keyed by `execution_id`,
  and the execution-ID-first queue projection. Use this for status surfaces;
  use `executionViewChanges$` when you need every pointer-clear transition.
- `Session.addDependency(spec, { packageManager })` /
  `Session.addDependencies(specs, { packageManager })` and
  `Session.removeDependency(spec, { packageManager })` /
  `Session.removeDependencies(specs, { packageManager })` edit notebook
  dependency metadata for UV, Conda, or Pixi. Omit `packageManager` to follow
  the notebook's running or configured manager. Batch variants use one CRDT
  metadata transaction.
- `Session.getDependencyStatus()` returns dependency metadata, fingerprint, and
  trust state in one call.
- `Session.getRuntimeStatus()` returns kernel lifecycle, activity, env source,
  `environmentId`, `environmentName`, `pythonVersion`, and startup error
  details. Identity fields (`name`, `language`, `envSource`, `runtimeAgentId`,
  `environmentId`, `environmentName`, `pythonVersion`) are empty unless
  `lifecycle` is `"Running"`; empty means unreported. `runtimeAgentId` is reused
  across restarts and is not a kernel generation. It reads this session's
  replica; right after a launch it can lag the daemon.
- `Session.syncEnvironment()` installs recorded notebook dependencies into the
  running kernel and rejects when the daemon cannot apply them.
- `Session.syncEnvironmentResult()` sends the same request and returns the
  daemon's verdict: `{ status, syncedPackages, needsRestart, error?, nextAction }`.
  `applied` means the packages are in the running kernel. `restart_required`
  (`nextAction: "restart"`) means the change needs a new kernel: removals,
  channel or package-manager changes, or project file updates. Nothing was
  installed, and the kernel was not restarted. Call `restartKernel()` when
  losing in-memory state is acceptable. `failed` (`nextAction: "inspect"`)
  covers trust refusals, borrowed environments, and install errors. Dependency
  metadata is the saved spec, not the running environment; check
  `getRuntimeStatus().envSource` after a restart.
- `Session.saveNotebook(path?)` saves the notebook.
- `Session.confirmNotebookSync()` returns the current `NotebookDoc` heads once
  the connected local daemon accepts them (later edits are outside that receipt):
  - Rejects on timeout, close, disconnect, rejected edits, hosted bridge rooms, or unsupported daemons (no best-effort fallback).
  - A missing handshake capability rejects before sending a request, keeping older daemon sessions usable.
  - Persistent local rooms journal edits before acknowledging; ephemeral rooms promise acceptance only.
  - Does not export an `.ipynb`, acknowledge other document streams, or confirm hosted persistence.
- `Session.close()` releases the daemon connection.

## Daemon Requirements

The package talks to a local `runtimed` daemon over its Unix socket. In a
development checkout, run the per-worktree daemon before using the bindings:

```bash
cargo xtask dev-daemon
```

Published nteract desktop builds manage their own daemon. Set
`RUNTIMED_SOCKET_PATH` when you need to connect to a specific daemon instance.

## Development Smoke Test

After building the native binding, run the daemon-backed API smoke test with:

```bash
RUNTIMED_SOCKET_PATH=/path/to/runtimed.sock pnpm --dir packages/runtimed-node smoke:api
```

When testing an out-of-tree N-API build, point the smoke script at it:

```bash
RUNTIMED_NODE_SMOKE_MODULE=/tmp/runtimed-node-napi-check/index.cjs \
RUNTIMED_SOCKET_PATH=/path/to/runtimed.sock \
pnpm --dir packages/runtimed-node smoke:api
```

## Platform Packages

The platform packages are implementation details and should normally be
installed through `@runtimed/node`:

- `@runtimed/node-darwin-arm64`
- `@runtimed/node-linux-x64-gnu`
- `@runtimed/node-linux-arm64-gnu` (publication requires the bootstrap described in `RELEASING.md`)
- `@runtimed/node-win32-x64-msvc`
- `@runtimed/node-win32-arm64-msvc`

They contain only the compiled native `.node` binary for their target platform.

Linux GNU compatibility baseline:

- Targets Ubuntu 22.04 (glibc 2.35) and newer on x64 and ARM64, requiring system OpenSSL 3 (`libssl.so.3`, `libcrypto.so.3`) and `libgcc_s.so.1`.
- Release builds compile on Ubuntu 22.04 for both architectures. CI audits ELF requirements and loads the packed wrapper and addon on that baseline (a newer CI host alone does not prove compatibility; sysroot and linked libraries decide).
- Applies to builds with the Linux compatibility fix, including nightlies; published 0.6.0 Linux packages require glibc 2.39.
- A “Cannot find native binding” error can wrap a libc or shared-library load failure; inspect its `cause` chain before assuming a missing optional dependency.

## Shared execution state

Each `Session` owns `session.executions`, the same synchronous execution store used by the React frontend.
Native execution changesets update this store before `executionViewChanges$` emits.
Command APIs and pi's existing changeset subscription are unchanged.
Construction adds no readiness promise, transport, timer, or WASM instance.

```js
const store = session.executions;
const unsubscribe = store.subscribeExecutionById(executionId)(() => {
  console.log(store.getExecutionById(executionId));
});
console.log(store.getExecutionById(executionId)); // initial read
// Later:
unsubscribe();
```

Store guarantees and implementation:

- **Immutable snapshots**: `getExecutionView()` returns a cached, immutable snapshot rather than a mutable copy. Entity snapshots and output-ID arrays are owned and frozen by the store (unchanged output membership keeps array identity). Copy explicitly if you need mutable data; retained snapshots never mutate on later events.
- **Removals and queues**: removing an execution clears its cell pointer even if its snapshot has not arrived. An explicit queue update without a notebook projection clears the notebook queue; an absent queue field leaves it unchanged. `setNotebookQueueProjection()` updates the notebook projection in an existing aggregate queue before notifying subscribers. Before any runtime queue arrives, the aggregate queue stays `null` (a cell-only projection cannot infer execution queue membership).
- **Notifications**: subscriptions invalidate synchronously per write. A changeset applies in upsert, removal, pointer, then queue order (not one atomic notification). Listeners added during delivery start on the next notification, unsubscribed listeners are skipped, and listener errors do not stop sibling listeners. Unsubscribe functions are idempotent even if the same callback is registered again later.
- **Shutdown**: `close()` disposes native subscriptions and completes RxJS streams; owners must still release store subscriptions. The last state remains readable.
- **Build and adapters**: source lives in `packages/runtimed/src/execution-store.ts`. `build:stores` generates this package's CommonJS module and declarations, and `check:stores` verifies freshness before packing (no published dependency on the private workspace package). `packages/runtimed/examples/execution-readable.ts` shows a framework-neutral Svelte readable adapter over the same instance (cells, output content, and a Svelte shell are separate follow-ups).

## Session status

`session.sessionStatus$` forwards the native `SyncStatus` JSON unchanged (`close()` completes the stream).
Subscribe to detect connection loss and bootstrap failures:

| Field | Case-sensitive values |
| --- | --- |
| `connection` | `"Connected"`, `"Disconnected"` |
| `notebook_doc` | `"Pending"`, `"Syncing"`, `"Interactive"` |
| `runtime_state` | `"Pending"`, `"Syncing"`, `"Ready"` |
| `initial_load` | `"NotNeeded"`, `"Streaming"`, `"Ready"`, `{ Failed: { reason: string } }` |

These native values differ from the session-control wire representation.
Callers using earlier lowercase declarations or `initial_load.phase` must update their comparisons; runtime serialization is unchanged.

## Native session verification

Build the native binding and daemon, then run the callback and shared-store
contract against an isolated daemon without a Python kernel:

```bash
pnpm --dir packages/runtimed-node build:debug
pnpm --dir packages/runtimed-node typecheck:contracts
cargo xtask artifacts ensure runtime,sift,renderer
cargo build -p runtimed
RUNTIMED_NODE_NATIVE_INTEGRATION=1 \
  pnpm test:run packages/runtimed-node/tests/native-session.test.ts
```

Add `RUNTIMED_NODE_EXECUTION_INTEGRATION=1` to test Python execution, reruns, progress callbacks, and retained snapshots too.
This creates a notebook environment with `ipykernel` and may download Python packages.
The suite manages its own daemon and disables background environment pools; CI runs both flags in a separate step.
