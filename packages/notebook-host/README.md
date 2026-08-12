# `@nteract/notebook-host`

Host-platform adapters for the shared nteract notebook frontend. Notebook
save/save-as bytes continue through the typed runtimed protocol; the host side
supplies the file dialog and window bookkeeping.

The Electron adapter is split across two trust zones:

- `@nteract/notebook-host/electron/main` attaches an authorized
  `@runtimed/node/relay` session and allowlisted platform handlers to one
  `MessagePortMain`.
- `@nteract/notebook-host/electron` runs inside the notebook renderer and
  turns the transferred DOM `MessagePort` into a `NotebookHost`.

The notebook iframe never receives `ipcRenderer`, filesystem primitives, a
WebSocket URL, or the daemon socket path.

## Electron topology

Create a `MessageChannelMain` in Electron main, serve one end, and transfer the
other end to the trusted application renderer with `webContents.postMessage`.
That renderer transfers the received DOM port into the notebook iframe with
`connectElectronNotebookFrame`.

```ts
// Electron main
import { MessageChannelMain } from "electron";
import { openRelayPath } from "@runtimed/node/relay";
import { serveElectronNotebookHost } from "@nteract/notebook-host/electron/main";

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
