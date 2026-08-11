# `@runtimed/node`

Run Python from Node in a kernel that stays alive between calls. Variables and
imports persist, dependencies install mid-session via uv, and plots come back
as image data in the cell result.

**Before** — new process every call, no memory:

```js
execSync('python -c "import pandas as pd; df = pd.read_csv(\'data.csv\'); print(df.shape)"');
// next call: pandas re-imported, df gone, startup cost paid again
```

**After** — one session, state sticks:

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

Built for agent loops where one session spans many turns. Session startup costs
a couple of seconds and then every later call is cheap, so the win grows with
the number of turns. Running a script once? Use a subprocess.

Node.js bindings for the nteract `runtimed` daemon. This package lets Node,
Bun, and other CommonJS-compatible runtimes create notebooks, run Python cells,
queue executions, read outputs, save notebooks, and manage notebook dependencies
through the same local daemon used by nteract desktop.

## Embedding a notebook frontend

`@runtimed/node/relay` exposes the native byte pipe used by desktop notebook
hosts. The browser/WASM frontend remains the Automerge peer; Node owns the
daemon socket, handshake, framing, and liveness heartbeat and forwards opaque
typed frames to the browser transport.

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

Hosts that supervise the daemon can use `defaultSocketPath()`,
`socketPathForChannel("stable" | "nightly")`, and
`queryDaemonInfo({ socketPath })` from the same subpath. The explicit channel
resolver is useful when the host's release channel differs from the package's
compile-time default. The query returns `null` until the daemon is ready, so
the host does not need to duplicate the pool wire protocol just to probe
readiness.

`RelaySession.info.daemonVersion` is the identity carried by that notebook's
exact handshake. It is intentionally left undefined when an older daemon omits
it rather than being filled from a later pool query, which could race a daemon
restart. Treat that artifact version as diagnostic metadata. Compatibility is
determined by the negotiated protocol number and, for optional semantics, the
capabilities advertised by the connection. Use `queryDaemonInfo()` only for
readiness and diagnostics.

Frames include the one-byte notebook frame discriminator and omit the daemon
socket's length prefix; an empty buffer is not a frame and is rejected. The
relay subscribes to native delivery eagerly so bootstrap frames are retained.
It invokes JavaScript frame handlers serially to preserve ordering, so handlers
should forward or copy a frame promptly rather than perform expensive work
inline.

The relay is intentionally Electron-free: custom protocols, CSP, browser-peer
authentication, window lifecycle, and daemon installation remain
responsibilities of the embedding host. `connectRelay(notebookId)` is an
operator connection, not an authorization check. A host must authorize the
notebook ID itself and must not expose room discovery or relay creation directly
to an untrusted browser context.

`close()` is terminal cancellation. Natural daemon closure drains frames already
queued for JavaScript before notifying `onClose`; explicitly closing before a
browser peer subscribes discards the buffered bootstrap frames.

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

Embedding hosts that acquire binaries without npm can use the matching nteract
GitHub release instead. Every release publishes a wrapper archive, one native
archive per supported desktop target, and a JSON asset manifest. Archive names
use the nteract release version so the wrapper, native binding, daemon, and web
assets can be selected from one immutable release even though the npm package
inside each archive has its own version:

| Target | Release archive |
|---|---|
| Wrapper | `runtimed-node-wrapper-${releaseVersion}.tgz` |
| macOS arm64 | `runtimed-node-darwin-arm64-${releaseVersion}.tgz` |
| macOS x64 | `runtimed-node-darwin-x64-${releaseVersion}.tgz` |
| Linux x64 (glibc) | `runtimed-node-linux-x64-gnu-${releaseVersion}.tgz` |
| Windows x64 | `runtimed-node-win32-x64-msvc-${releaseVersion}.tgz` |
| Asset manifest | `runtimed-node-assets-${releaseVersion}.json` |

Download the wrapper and exactly one native archive. Install them as the
package names recorded in the manifest (`@runtimed/node` and its matching
optional platform package). Before unpacking, require the GitHub Releases API
asset record to contain a `sha256:` `digest` and verify that digest against the
downloaded bytes. The manifest intentionally does not duplicate checksums;
GitHub's asset digest is authoritative.

The manifest's `source_revision` is the full nteract release commit and
`binding_source_revision` is the short revision compiled into the native
binding. Packaged hosts should require the latter to match
`bindingSourceRevision()` and the commit suffix carried by the selected daemon,
and require the full revision to match any notebook web manifest before opening
the browser peer. The `node_api_version` field records the minimum Node-API
level; a host must check `Number(process.versions.napi)` before loading the
native package. The workflow also loads each native binding on its build runner
and checks that `bindingSourceRevision()` identifies the release commit before
it can be attached to a release.

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

`createNotebook()` accepts `dependencies` so agent code can declare packages
up-front instead of failing the first import and retrying after `addDependencies()`.
When `packageManager` is omitted, the daemon/user environment choice remains in
charge. Later dependency edits also infer the manager from the running kernel,
inline notebook metadata (`uv`, then `conda`, then `pixi`), or detected project
file, falling back to UV for fresh Python notebooks with no other signal. Pass
the native binding's `PackageManager` string enum (`"uv"`, `"conda"`, or
`"pixi"`) only when you need to target a specific metadata section.
`description` can be used as a human-readable peer label for agent-created
sessions.

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
  `Session.deleteCell(cellId)`, and `Session.moveCell(cellId, options)` provide
  direct notebook editing without MCP JSON round-trips. `createCell()` appends
  by default; pass `index: 0` to prepend or `afterCellId` to insert after
  another cell.
- `Session.executeCell(cellId, options)` runs an existing code cell.
- `Session.showNotebook()` opens the session in nteract Desktop when a display
  is available.
- `Session.interruptKernel()`, `Session.shutdownKernel()`, and
  `Session.restartKernel()` manage the running kernel.
- `Session.shutdownNotebook()` shuts down this notebook room and closes the session.
- `Session.runCell(source, options)` appends, runs, and waits for a cell.
- `Session.queueCell(source, options)` appends a cell, queues it, and returns IDs.
- `Session.waitForExecution(executionId, options)` waits for queued work.
  Pass `onUpdate(progress)` to receive resolved output snapshots while the
  execution is still running.
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
  the notebook's running/configured manager. Batch variants use one CRDT
  metadata transaction.
- `Session.getDependencyStatus()` returns dependency metadata, fingerprint, and
  trust state in one call.
- `Session.getRuntimeStatus()` returns kernel lifecycle, activity, env source,
  and startup error details.
- `Session.syncEnvironment()` installs recorded notebook dependencies.
- `Session.saveNotebook(path?)` saves the notebook.
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
- `@runtimed/node-darwin-x64`
- `@runtimed/node-linux-x64-gnu`
- `@runtimed/node-win32-x64-msvc`

They contain only the compiled native `.node` binary for their target platform.
