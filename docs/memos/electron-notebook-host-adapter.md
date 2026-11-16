# Electron notebook host adapter

Status: implemented first pass; integration validation pending.

## Goal

Embed the shared nteract notebook app in an Electron side panel while retaining
the desktop app's runtime, save, dialog, window, settings, and output-isolation
semantics. The embedding must work with the singleton runtimed daemon and must
not publish the daemon Unix socket through a renderer-visible WebSocket.

## Boundary

The public adapter uses a single, notebook-scoped `MessagePort` as a capability:

1. Electron main authorizes a path or notebook ID and opens
   `@runtimed/node/relay`.
2. Electron main binds that relay plus an allowlisted host-method handler to one
   side of `MessageChannelMain`.
3. The trusted application renderer receives the other side and transfers it
   to the nteract iframe using an exact target origin after the iframe's
   protocol-versioned ready message. This avoids losing the one-use port during
   asynchronous bundle startup.
4. The iframe constructs `NotebookHost` from the port. Typed runtimed frames
   remain opaque; host calls use a separate versioned request/event envelope.

Electron `invoke` remains appropriate for discrete operations behind the
handler: show a save dialog, update host bookkeeping after a path change, set a
title, open an external URL, or read settings. The actual save/save-as request
uses the existing typed runtimed protocol on the notebook relay. `invoke` is not
the byte pipe because transferred `MessagePort`s require Electron's
`postMessage` APIs.

## Security invariants

- Do not expose `ipcRenderer`, generic channel names, filesystem APIs, room
  discovery, or daemon socket paths to the notebook iframe.
- Authorize the notebook before creating or connecting the native relay.
- Treat every host method as a capability and validate path/URL parameters in
  the trusted host process.
- Bind the transferred port using both exact `event.source` and exact
  `event.origin`; do not use `*`.
- Keep isolated output iframes sandboxed without `allow-same-origin`.
- Serve the emitted `output-frame.html` as a separate response. Do not apply the
  parent notebook CSP to that route; allow it under the parent's `frame-src`.
- Preserve runtimed protocol negotiation inside the relay. The Electron host
  protocol version applies only to the side-effect RPC envelope.

These constraints continue the security model described in
[Securing Notebooks](https://www.nteract.io/blog/security/): code and rich
outputs are untrusted, daemon control remains local, and privileged host actions
cross an explicit capability boundary.

## Agentic Desktop integration requirement

A request/response-only plugin SDK is almost sufficient. It can back the host
method handler, including save dialogs and path/window bookkeeping. The missing
primitive is one notebook-scoped transferable port. The SDK can add a narrow
API such as `openNotebookHostPort(sessionId)` rather than exposing Electron IPC
generally.

The integration should also give each Kilo chat/session an explicit notebook
identity chosen in the trusted host. Multiple agents and the user can then
connect to the same daemon-owned notebook document without starting competing
daemons or assigning the notebook by untrusted iframe input.

## Output CSP integration

The production notebook bundle now emits `output-frame.html`. The Electron host
should make two routes with different policies:

| Route | Policy |
|---|---|
| notebook app | strict application CSP; no renderer plugin script allowances |
| `output-frame.html` | canonical output CSP from the document; permitted by parent `frame-src` |

Because the iframe omits `allow-same-origin`, serving the output document beside
the app does not grant it same-origin DOM or storage access. Avoid `srcdoc` in
the Electron embedding: its effective CSP is constrained by the parent page and
prevents several isolated renderers from loading their required code or workers.

## Follow-up validation

- Exercise the adapter in Agentic Desktop with one existing `.ipynb` and one
  ephemeral notebook.
- Verify Save, Save As, cancel, path change, and reopen behavior.
- Render HTML, Plotly, widgets, worker-backed output, and daemon blobs under the
  packaged Electron CSP.
- Confirm two peers can open the same notebook ID through one singleton daemon.
- Add cancellation/lifecycle wiring when an Agentic panel or window closes.

## Related-channel review compatibility

Related-channel decisions use notebook protocol frames on the existing relay,
not a privileged Electron host method. `createElectronHost` installs the same
`approveRelatedChannels(reviewId)` / `declineRelatedChannels(reviewId)` adapter
as the native and browser hosts. The renderer sends only the daemon-issued
review ID, never a replacement channel list or an install authorization.

The shared dialog distinguishes server-authored `scope: "metadata"` (permission
to inspect additional channel metadata) from `scope: "install"` (review of the
prepared package-source order). Missing or unrecognized scopes do not offer
approval. Completing metadata inspection does not approve the final package
sources; a new review ID requires another explicit decision. Stale and
unsupported-daemon responses remain errors, with no fallback to workspace or
project trust.

The Electron adapter test covers these request/response semantics through a
linked renderer/main MessagePort and a fixture relay. This is not validation of
a downstream application's bundled assets, daemon, or permission policy. Before
enabling channel expansion in an embedding, validate its actual bundle and
supported daemon together: review display, metadata approve, final approve,
cancel, changed-plan rejection, reconnect, and unsupported-client behavior.
Existing project/workspace trust must not automatically approve discovered
channels. Production expansion remains off until the daemon's prepared-install
boundary and explicit client opt-in are wired and tested end to end.
