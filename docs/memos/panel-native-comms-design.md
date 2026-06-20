# Panel Native Comms: Bokeh Patch Channel, Not Raw Comm State

**Status:** Exploration, 2026-06-20.

This is a design memo, not an ADR. It records what Panel and pyviz_comms need
for live notebook interactivity and frames the nteract-native shape. Code in the
current PR is a compatibility path; a durable decision can graduate into an ADR
after we pick the runtime transport boundary.

Source paths below are relative to the HoloViz `panel` and `pyviz_comms`
repositories.

## Context

Panel notebook rendering already produces a rich Bokeh document bundle, but live
widgets need a bidirectional callback channel. The tempting shortcut is to
forward raw Jupyter `comm_open` / `comm_msg` / `comm_close` frames through
nteract. That works as a compatibility bridge, but it is not the model Panel is
trying to expose.

Panel's live unit is a Bokeh document patch stream with Python-side callback
execution and acknowledgements. Jupyter comms are the transport Panel happens to
use in classic Notebook, JupyterLab, Colab, and VS Code.

## Source Findings

Panel's `_repr_mimebundle_` path selects Jupyter comms when it detects an
IPython kernel, creates a server comm, renders the Panel object into a Bokeh
document, and then calls `_render_mimebundle` (`panel/viewable.py`).

`_render_mimebundle` creates a Bokeh `CommManager` model with a server `comm_id`
and the root model `plot_id`, creates a separate client comm whose open handler
initializes the server comm, stores the `(server_comm, client_comm)` pair, and
records `client_comm_id` on the Bokeh model (`panel/viewable.py`).

`render_mimebundle` adds that `CommManager` model to the Bokeh document before
rendering the notebook MIME bundle. It also patches the client comm's `on_open`
handler when another library created the client comm first (`panel/io/notebook.py`).

On the browser side, `panel/models/comm_manager.ts` attaches to the Bokeh
document, filters non-syncable model changes, buffers document events, converts
them with `document.create_json_patch`, wraps them in a Bokeh `PATCH-DOC`
protocol message, extracts binary buffers, and sends the message over the
client comm. It blocks/debounces until Python sends an ACK.

On the Python side, `pyviz_comms.Comm._handle_msg` decodes incoming data,
removes `comm_id`, invokes the registered callback, captures stdout/errors, and
sends a metadata-only ACK with `msg_type: "Ready"` or `"Error"` plus the
`comm_id`. Panel's callback path runs `CommManager.assemble` to reconstruct the
Bokeh protocol message and applies it to the server-side Bokeh document.

`pyviz_comms.JupyterCommManager` is environment glue. It maps the same logical
operations onto classic notebook comms, JupyterLab kernel proxies, or Colab.
The JupyterLab renderer registers a `window.PyViz.kernels[plot_id]` proxy whose
`connectToComm` and `registerCommTarget` methods delegate to the live kernel.

Panel config currently exposes `PANEL_COMMS` choices for `default`,
`ipywidgets`, `vscode`, and `colab`; there is no public `nteract` comm backend
selector today.

## Interpretation

Panel widgets are not ipywidgets traitlets. The browser does not send small
semantic state patches like `{value: 4}` to a CRDT model. It sends Bokeh
document patch protocol messages, and Python remains authoritative for callbacks
that may mutate more models, emit stdout, raise exceptions, or produce follow-up
patches.

So "raw comm" is the wrong long-term abstraction, but "fully CRDT-native Panel
state" is also too strong if it means decomposing Bokeh model mutations into
independent Automerge fields. The safer native boundary is a typed
Panel/Bokeh patch channel:

- `PanelChannelOpen`: plot id, server comm id, client comm id, output id/cell id.
- `PanelClientPatch`: Bokeh `PATCH-DOC` message plus buffers, from iframe to
  kernel.
- `PanelServerPatch`: Bokeh message fragments or reconstructed patch plus
  buffers, from kernel to iframe.
- `PanelAck`: Ready/Error, stdout text, traceback, and channel id.
- `PanelChannelClose`: lifecycle cleanup.

That channel can be carried through nteract's runtime model and isolated iframe
JSON-RPC without exposing an arbitrary Jupyter comm pipe as a general feature.

## Proposed Direction

### 1. Keep the compatibility bridge narrow

The current bridge should be treated as a PyViz/Panel compatibility lane, not a
general raw comm transport. It should be enabled only for outputs whose MIME
bundle requires the comm bridge, and the code should name the reason: Panel
needs a Bokeh patch channel that currently rides Jupyter comm frames.

This keeps the risk bounded while restoring the user-visible workflow:

```python
import panel as pn
pn.extension()
pn.widgets.FloatSlider(name="nteract-panel-smoke", start=0, end=10, value=4)
```

### 2. Add a launcher-provided Python backend

A nteract Python package can implement the same small surface Panel expects from
`pyviz_comms.CommManager`:

- `get_server_comm(on_msg, id, on_error, on_stdout, on_open)`
- `get_client_comm(on_msg, id, on_error, on_stdout, on_open)`
- comm objects with `id`, `send`, `close`, `init`, and `_handle_msg`-equivalent
  ACK behavior

The kernel launcher would import/install this package before user code and set
`panel.io.state.state._comm_manager` when Panel is present. Because Panel's
public config selector does not currently include `nteract`, this is either a
local monkeypatch or an upstreamable Panel contribution that adds a backend
registration hook.

The package should not invent a new Panel model. It should preserve Bokeh's
protocol payloads and send them to the daemon as typed Panel channel messages.

### 3. Represent Panel runtime state explicitly in nteract

The daemon/runtime layer should know this is Panel/Bokeh traffic, not an
ipywidgets model update:

- keep output identity tied to the cell's displayed Panel root;
- order `open -> patch -> ack -> close` per channel;
- preserve binary buffers;
- surface Python callback stdout and traceback as output-adjacent diagnostics;
- replay only what is safe after iframe remount.

The CRDT can store channel descriptors, latest rendered output identity, and
possibly a patch log or latest Bokeh document snapshot. The Python kernel still
executes callbacks while it is alive. Offline replay without a live kernel is a
separate "embedded Panel" mode, not the same as live callback interactivity.

## ADR Candidate

If this direction holds, the ADR should decide:

1. nteract will support Panel through a typed Bokeh patch channel, not a generic
   raw Jupyter comm bridge.
2. The initial Python integration point is a launcher-provided comm manager
   backend that implements Panel/pyviz_comms' existing `CommManager` surface.
3. The browser still applies patches with BokehJS/PanelJS inside the sandboxed
   isolated iframe; nteract does not reinterpret Bokeh patches into independent
   widget trait state.
4. The durable CRDT record is channel/output topology and safe replay metadata,
   while live callback execution remains kernel-authoritative.

## Open Questions

1. Should we propose an upstream Panel backend registration hook instead of
   monkeypatching `state._comm_manager` in the launcher?
2. What is the minimum replay record needed when the iframe remounts: patch log,
   latest serialized document, or a fresh kernel-side render?
3. How should callback stdout/errors appear in the notebook output model?
4. Can we share a typed Bokeh patch channel with existing Bokeh output support,
   or does Panel's two-comm setup need its own runtime channel?
5. What is the failure behavior when the kernel restarts while a Panel output is
   visible: frozen last state, explicit disconnected overlay, or automatic
   re-render on next execution?
