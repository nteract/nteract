# `@nteract/notebook-host`

Host-platform adapters for the shared nteract notebook frontend. Notebook
save/save-as bytes continue through the typed runtimed protocol; the host side
supplies the file dialog and window bookkeeping.

The Electron adapter is split across two trust zones:

- `@runtimed/node/electron` attaches an authorized
  `@runtimed/node/relay` session and allowlisted platform handlers to one
  `MessagePortMain`.
- `@nteract/notebook-host/electron` runs inside the notebook renderer and
  turns the transferred DOM `MessagePort` into a `NotebookHost`.

The notebook iframe never receives `ipcRenderer`, filesystem primitives, a
WebSocket URL, or the daemon socket path.

## Published notebook UI bundle

Stable and nightly GitHub releases publish the production notebook frontend as
`nteract-stable-notebook-ui.tar.gz` and
`nteract-nightly-notebook-ui.tar.gz`, respectively. Each archive has an
adjacent `.sha256` file and expands into a single `nteract-notebook-ui/`
directory containing:

- the static frontend rooted at `index.html`;
- the separately served `output-frame.html` document;
- `nteract-notebook-ui.json`, which records the schema version, release
  channel, nteract version, source commit, and entrypoint names; and
- `LICENSE.nteract`.

Pin a unique release tag, verify the checksum, and serve the extracted files
from a secure origin. The archive is the same platform-neutral frontend used by
the nteract desktop release; the embedding host still supplies the authorized
runtime transport and host capabilities described below.

## Electron topology

Create a `MessageChannelMain` in Electron main, serve one end, and transfer the
other end to the trusted application renderer with `webContents.postMessage`.
That renderer transfers the received DOM port into the notebook iframe with
`connectElectronNotebookFrame`.

```ts
// Electron main
import { MessageChannelMain } from "electron";
import { openRelayPath } from "@runtimed/node/relay";
import { serveElectronNotebookHost } from "@runtimed/node/electron";

const relay = await openRelayPath(authorizedNotebookPath);
const { port1, port2 } = new MessageChannelMain();

serveElectronNotebookHost({
  port: port1,
  relay,
  handler: {
    async invoke(method, params) {
      // Implement only the declared method union. Validate paths and URLs in
      // this trusted process before performing any side effect.
      return invokeAuthorizedNotebookHostMethod(method, params);
    },
  },
});

browserWindow.webContents.postMessage("nteract:notebook-port", null, [port2]);
```

The trusted Electron-aware renderer (or preload isolated world) receives the
port from the Electron event and transfers it directly into the iframe. Do not
forward `ipcRenderer` through `contextBridge`, and do not depend on passing a
`MessagePort` through a normal context-bridge function:

```ts
// Trusted Electron renderer / preload
import { ipcRenderer } from "electron";
import {
  connectElectronNotebookFrame,
  ELECTRON_HOST_PROTOCOL_VERSION,
  onElectronNotebookFrameReady,
} from "@nteract/notebook-host/electron";

let port: MessagePort | undefined;
let frameReady = false;
const connectWhenReady = () => {
  if (!port || !frameReady) return;
  connectElectronNotebookFrame(iframe.contentWindow!, iframeOrigin, {
    port,
    bootstrap: {
      protocolVersion: ELECTRON_HOST_PROTOCOL_VERSION,
      outputDocumentUrl: `${iframeOrigin}/output-frame.html`,
    },
  });
};

onElectronNotebookFrameReady({
  iframeWindow: iframe.contentWindow!,
  iframeOrigin,
  onReady() {
    frameReady = true;
    connectWhenReady();
  },
});

ipcRenderer.once("nteract:notebook-port", (event) => {
  port = event.ports[0];
  if (!port) throw new Error("notebook host port missing");
  connectWhenReady();
});
```

Load the notebook app with:

```text
?nteract-host=electron&nteract-parent-origin=<exact trusted parent origin>
```

The bootstrap rejects wildcard origins. Register custom Electron schemes as
standard, secure schemes so both parent and iframe have stable, non-opaque
origins.

## Notebook presentation

Renderers that support sidebar configuration advertise `presentation.rail` in
the ready message's optional `capabilities` array. Check that capability before
enabling the feature in a host consuming a pinned notebook UI archive. Protocol
version compatibility alone does not imply presentation support.

Pass initial configuration through `ElectronHostBootstrap.presentation`:

```ts
presentation: {
  rail: {
    visible: true,
    side: "right",
    initialCollapsed: true,
    initialPanel: "packages",
  },
},
```

All fields are optional. Existing hosts keep the left-side, visible, collapsed
Outline rail. Configuration is validated at the Electron handshake and copied
into an immutable host snapshot. Invalid fields or values reject the bootstrap.
The host supplies initial preferences; user interaction owns panel selection and
collapse after boot. This contract does not grant document or runtime access,
enable comments, or persist preferences in the notebook.

Use the existing host server's typed command event for later user intents:

```ts
server.emit("command", {
  id: "notebook.rail.open",
  payload: { panelId: "packages" },
});
server.emit("command", { id: "notebook.rail.close", payload: undefined });
```

Open restores an initially hidden rail and expands the requested Outline or
Packages panel. Close collapses the panel while retaining the visible icon strip.
An embedding that initially hides the rail must provide an accessible restore
action. Commands target only the notebook attached to that host connection.
The Python/environment status indicator remains passive.

The rail and its projections stay inside the notebook iframe. Hosts need no
imports of application stores, CSS-based rail suppression, generic IPC, or daemon
protocol changes. Preference persistence and live configuration updates are not
part of this initial contract.

## Isolated output document

The notebook production build emits `output-frame.html`. Serve it as a real
document and pass its URL in `ElectronHostBootstrap.outputDocumentUrl`.

Do not attach the notebook application's restrictive CSP response header to
that route. The document carries the output renderer CSP in its own meta tag,
while the iframe retains this sandbox:

```text
allow-scripts allow-downloads allow-forms allow-pointer-lock
```

In particular, never add `allow-same-origin`. The sandbox-induced opaque origin
is the output security boundary. The parent CSP must allow the output document
under `frame-src`; the output document's CSP controls scripts, workers, media,
and loopback blob fetches inside the iframe.

## SDK requirement

A request/response-only plugin `invoke` API can implement the host methods, but
it cannot transport the long-lived runtimed frame stream. An Electron embedding
SDK therefore needs exactly one additional capability: its trusted host layer
must transfer an authorized, notebook-scoped `MessagePort` into the plugin
renderer. The plugin itself does not need generic Electron IPC or a
TCP/WebSocket relay.
