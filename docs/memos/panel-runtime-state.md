# Represent Panel Runtime State Explicitly

Status: RFC

Panel should not become another raw Jupyter comm bridge in nteract. Panel's
live notebook path is a Bokeh document patch protocol carried over PyViz comms,
and nteract already has better primitives for explicit runtime state: typed
runtime protocol messages, Automerge documents, blob storage, and execution
scoped outputs.

This memo frames a separate implementation track for native Panel runtime
state. It is source-grounded but not yet a durable decision; graduate the
accepted pieces into ADRs once the prototype proves the shape.

## Current Evidence

- Panel's notebook display path imports `JupyterCommManagerBinary` as
  `JupyterCommManager`, assigns `state._comm_manager = JupyterCommManager`
  when an IPython kernel is present, gets a server comm, renders a Bokeh model,
  and then renders a MIME bundle (Panel source: `panel/viewable.py`).
- `JupyterCommManagerBinary` only swaps Panel's client comm decode path for
  binary buffers; it still inherits the PyViz/Jupyter comm manager surface
  (Panel source: `panel/io/notebook.py`).
- The browser-side Panel `CommManager` listens for Bokeh document change
  events, filters unsyncable model properties, builds a Bokeh
  `PATCH-DOC` message with `document.create_json_patch`, extracts buffers, and
  sends that message through a client comm. The same model consumes incoming
  Bokeh protocol messages through a Bokeh `Receiver` and applies
  `document.apply_json_patch` (Panel source:
  `panel/models/comm_manager.ts`).
- Panel's Python `CommManager` model reconstructs a Bokeh protocol message from
  `header`, `metadata`, `content`, and `_buffers`, then applies the patch to
  the server document (Panel source: `panel/models/comm_manager.py`).
- PyViz comms capture callback stdout/errors and reply with `Ready` or `Error`
  ACK metadata, including the comm id that should be unblocked
  (pyviz_comms source: `pyviz_comms/__init__.py`).
- Panel's public `config.comms` selector currently admits `default`,
  `ipywidgets`, `vscode`, and `colab`; there is no `nteract` backend hook in
  that selector today (Panel source: `panel/config.py`).
- nteract's iframe renderer currently makes Panel static output work by
  executing Panel/Bokeh HTML and JavaScript inside an isolated static frame
  (`src/isolated-renderer/panel-renderer.tsx`).
- nteract's widget path is already explicit: RuntimeStateDoc owns comm
  topology, CommsDoc owns mutable widget state, and `NotebookBroadcast::Comm`
  is only for ephemeral widget custom messages (`crates/notebook-protocol/src/protocol.rs`,
  `src/components/widgets/comm-changes-store-bridge.ts`).

## Panel/PyViz/Bokeh Communication Model

Panel is not an ipywidgets trait-state protocol. It renders Panel objects into
a Bokeh `Document`, then uses PyViz comms as a transport for Bokeh document
patches.

The useful mental model is:

1. **Bokeh `Document`**: a graph of Bokeh `Model` objects, with roots attached
   to a document. A slider, layout, plot, or Panel component becomes one or
   more Bokeh models with ids and properties.
2. **Document change events**: when browser-side BokehJS changes a syncable
   model property, the document records a `DocumentChangedEvent`. Panel's
   browser `CommManager` ignores unsyncable properties, buffers the remaining
   events, and turns them into a Bokeh JSON patch with
   `document.create_json_patch`.
3. **Bokeh protocol message**: the JSON patch is wrapped in a Bokeh
   `PATCH-DOC` message. That message has `header`, `metadata`, `content`, and
   optional binary buffers. Bokeh's `Receiver` can reassemble chunked messages
   and buffers before applying the patch.
4. **PyViz comm transport**: PyViz supplies two comms around that Bokeh message:
   a server comm for Python-to-browser patches and a client comm for
   browser-to-Python patches. In Jupyter, those are implemented with
   ipykernel comm targets, but the payload is still Bokeh document protocol.
5. **ACK and callback output**: Python callbacks may print or fail while
   applying a browser patch. PyViz captures stdout/errors and sends a `Ready`
   or `Error` ACK so the browser-side `CommManager` can unblock its event
   queue.

That means the nteract-native boundary should be a Bokeh patch channel:
channel open, client patch, server patch, ACK, close, and disconnected state.
The browser should still let Panel/BokehJS compute and apply Bokeh patches.
nteract should own transport, ordering, durability, blob references, execution
output routing, and reconnect semantics.

This is also why mapping Panel to CommsDoc one Bokeh property at a time is the
wrong grain. CommsDoc is a good fit for ipywidget model state because widget
state already is a trait map keyed by comm id. Panel's coherent unit is the
Bokeh document patch, including event ordering and binary buffers.

## Proposed Model

Model Panel as a typed Bokeh patch channel, not as raw `comm_open`,
`comm_msg`, and `comm_close` envelopes crossing the frontend boundary.

The live channel should have explicit records:

- `PanelChannelOpen`: output id, cell id, execution id, plot id, server comm id,
  client comm id, Bokeh document id, and resource metadata.
- `PanelClientPatch`: browser to Python Bokeh `PATCH-DOC` message fragments plus
  binary buffer refs.
- `PanelServerPatch`: Python to browser Bokeh protocol message fragments plus
  binary buffer refs.
- `PanelAck`: `Ready` or `Error`, callback stdout, traceback, channel id, and
  execution id.
- `PanelChannelClose`: channel id, reason, and final disconnected state.

Large Bokeh buffer payloads should go through blob storage. The CRDT record
should carry structure, ordering, hashes, and blob refs, not large binary
payloads inline. The replay record can live in CommsDoc if it remains narrowly
scoped to live visualization state, but a dedicated Panel/Bokeh runtime doc is
also viable if patch-log ownership or retention diverges from ipywidget comm
state.

The initial display bundle can use a nteract-owned marker MIME:
`application/vnd.nteract.panel-runtime.v1+json`. That marker should travel with
Panel's HTML, JavaScript, and legacy HoloViews markers in the same output bundle,
but it gives the Rust/runtime output path a typed place to carry channel identity
and replay metadata. The marker is not the live patch transport; it is the
output-local anchor that lets the renderer, runtime doc, and blob-backed patch
records agree on the same Panel runtime instance.

The marker belongs at Panel's render-mimebundle point rather than in a broad
global IPython formatter. nteract controls the kernel launcher and can register
display hooks, but the useful Panel identities do not exist until Panel has
created the Bokeh root model, Bokeh `Document`, server comm, browser-side Bokeh
`CommManager` model, and client comm. Wrapping
`panel.viewable.MimeRenderMixin._render_mimebundle` lets the launcher detect
Panel by type while preserving Panel's own notebook rendering path and stamping
the returned bundle with the ids nteract needs.

## Runtime Integration

The first Python integration can be a launcher-hosted monkeypatch. The launcher
already auto-loads `nteract_kernel_launcher._bootstrap` before user code and
uses lazy import hooks for optional renderers. The Panel hook should avoid
importing Panel on kernel startup; when Panel is imported, it can replace the
comm manager class that Panel's display path assigns.

The first launcher slice lands as an opt-in scaffold behind
`NTERACT_PANEL_RUNTIME_STATE`. It installs the lazy import hook by default but
does not patch Panel unless the flag is enabled. That keeps current static
Panel rendering unchanged until the daemon and iframe sides of the typed
channel exist.

Because Panel's `viewable.py` assigns the imported `JupyterCommManager` during
rendering, patching only `state._comm_manager` is likely insufficient. The
bootstrap should patch the imported class binding or provide an equivalent
`JupyterCommManagerBinary` replacement with this surface:

- `get_server_comm(on_msg, id, on_error, on_stdout, on_open)`
- `get_client_comm(on_msg, id, on_error, on_stdout, on_open)`
- comm objects with `id`, `send`, `close`, `init`, and ACK behavior equivalent
  to PyViz comms.

The narrow marker-injection point is `panel.viewable.MimeRenderMixin._render_mimebundle`.
At that point Panel has already created the Bokeh root model, server comm, Bokeh
`CommManager` model, and client comm, and it is about to return the notebook
MIME bundle. A launcher wrapper can add `application/vnd.nteract.panel-runtime.v1+json`
without replacing Panel's render machinery or parsing generated JavaScript.

That backend should emit and consume typed nteract Panel events at the daemon
boundary. If the immediate transport still has to observe kernel comm messages,
the translation should terminate inside the daemon/runtime layer; the isolated
iframe and widget bridge should never see generic raw comm traffic for Panel.

The Rust output narrowing path should recognize the nteract Panel runtime MIME
as a Panel bundle marker. When it wins MIME priority, the narrowed manifest must
retain the marker payload, `text/html`, `application/javascript`, and fallback
text together so browser rendering and later runtime replay have one coherent
output record instead of detached siblings.

The parent-side iframe boundary should also stay typed. The isolated renderer
can expose `window.__nteractPanelRuntime` to Panel's browser-side comm manager
and convert its events into explicit JSON-RPC notifications:

- `nteract/panelChannelOpen`
- `nteract/panelClientPatch`
- `nteract/panelChannelClose`
- `nteract/panelServerPatch`
- `nteract/panelAck`
- `nteract/panelDisconnected`

`OutputArea` should claim the iframe-to-parent Panel events before they reach
`CommBridgeManager`, then surface them through a Panel-specific callback with
the owning cell and output ids. This keeps the widget bridge widget-only and
gives the daemon/runtime integration a single typed ingress for browser-origin
Panel patches.

If Panel exposes a clean backend registration hook while building the monkeypatch,
use it. If not, keep the monkeypatch small and propose an upstream hook after
the nteract shape is proven.

## Frontend Integration

The Panel iframe should extend `window.PyViz.comm_manager` with a nteract
implementation that sends and receives typed Panel channel events. It should
still let Panel's own Bokeh `CommManager` construct and apply JSON patches, so
nteract does not need to model every Bokeh model property as a separate trait.

This can share a typed Bokeh patch channel with the current Bokeh output
support if the channel is defined around Bokeh protocol messages rather than
Panel-specific widget concepts. Panel's two-comm setup adds channel identity
and ACK requirements, but the patch payload is still Bokeh.

When the iframe remounts, it should rebuild from the last serialized Bokeh
document or compacted patch snapshot plus blob refs. If only a patch log exists,
compact it when safe so remounts do not require replaying an unbounded history.

When the kernel restarts while a Panel output is visible, keep the last rendered
state frozen and show an explicit disconnected overlay. The next cell execution
can open a new channel and replace the frozen state.

The runtime-state write boundary needs its own explicit schema and policy
decision. Today regular frontend clients read `RuntimeStateDoc`; they do not
author it. Runtime peers may update accepted execution progress, outputs,
kernel lifecycle, and empty comm topology, while room-host/daemon-owned facts
and raw root-key changes are rejected. A durable Panel state map therefore
should not be smuggled in as generic comm state or as an arbitrary root-key
change. It needs either:

- a `RuntimeStateDoc.panel_channels` subtree whose topology and patch cursors
  are owned by the daemon/runtime peer under an updated policy, paired with
  blob-backed patch payloads in a dedicated Panel/Bokeh runtime doc; or
- a new dedicated Panel/Bokeh runtime doc synced alongside RuntimeStateDoc,
  referenced by output marker ids and execution ids.

The second option avoids unbounded patch logs inside the already busy
RuntimeStateDoc. The first option is useful for compact channel topology and
late-joiner discovery. A likely split is: channel topology and latest compacted
snapshot pointer in RuntimeStateDoc; ordered patch records and binary buffer
refs in a dedicated Panel runtime document or blob-indexed log.

## Output Semantics

Callback stdout and stderr should enter the notebook as ordinary stream outputs
for the owning cell/execution, not as console logs hidden inside the iframe. The
Panel ACK path already distinguishes `Ready` with stdout content from `Error`
with traceback. The daemon should translate those into execution-scoped
stdout/stderr outputs, preserving the same ordering guarantees as other
runtime output commits.

## Guardrails

- Do not add a generic raw comm bridge between the isolated iframe and kernel.
- Do not widen `NotebookBroadcast::Comm` beyond the current widget custom-event
  use without a new typed variant and authority review.
- Do not route Panel through `WidgetStore` or `hasWidgetOutputs`; Panel's
  Bokeh document patches are not ipywidget trait state.
- Do not let frontend `request_state` or future comm lifecycle variants become
  room-wide broadcasts by fallback.
- Any runtime-agent broadcast ingress must allow-list the exact typed event
  variants it forwards.

## Implementation Slices

1. Land this memo and a CI-visible output-lane guard that keeps Panel outside
   the widget bridge.
2. Add a launcher-side Panel import hook and a minimal nteract Panel comm
   manager replacement that logs typed channel events without enabling browser
   interactivity yet.
3. Add the nteract Panel marker MIME to Panel bundles and to Rust output
   narrowing, preserving marker, HTML, JavaScript, and fallback text as one
   coherent output record.
4. Add the iframe `window.__nteractPanelRuntime` transport and parent
   `OutputArea` ingress so browser-origin Panel events are typed and kept out
   of `CommBridgeManager`.
5. Add daemon/runtime protocol and CRDT state for Panel/Bokeh channel open,
   patch, ACK, close, and disconnected state. Use blob refs for binary buffers
   and make the write-authority policy explicit.
6. Connect the launcher-side Panel comm manager to the daemon/runtime channel
   so server patches and ACKs no longer depend on a generic raw comm bridge.
7. Add tests for patch send, ACK unblocking, remount replay, and disconnected
   overlay.
8. Route Panel callback stdout/errors into execution-scoped notebook stream
   outputs.
9. Evaluate whether Bokeh and Panel can share the typed patch channel, and
   whether this model maps cleanly onto an anywidget-like state adapter that
   could be proposed upstream.

## Open Points

- Exact CRDT placement: RuntimeStateDoc topology plus a new Panel/Bokeh runtime
  doc versus a single RuntimeStateDoc subtree.
- Patch compaction strategy and retention policy.
- Whether the first transport can avoid ipykernel comm observation entirely, or
  whether the daemon must translate kernel comms into typed Panel events during
  the prototype.
- Upstream API shape for registering notebook comm backends in Panel.
