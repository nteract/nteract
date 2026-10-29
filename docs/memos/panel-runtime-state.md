# Bokeh Document Sessions for Panel

Status: Implemented. This memo covers the Panel producer seam, the initial MIME contract and the resource manifest. How a live session's state is shared between the kernel, the daemon, browsers and agents is decided in [`docs/adr/bokeh-session-documents.md`](../adr/bokeh-session-documents.md).

## Goal

Panel output in nteract should behave like a live Bokeh document, not like an HTML fragment with a PyViz comm manager attached to it:

- displaying a Panel object renders immediately;
- browser interactions run Python callbacks, and Python-side changes update every mounted view;
- callback stdout and errors appear as notebook outputs;
- iframe remounts and late peers recover the latest state without rerunning user code;
- kernel restart leaves a frozen last state with a disconnected overlay.

The architecture also serves plain Bokeh output. Panel is the first producer adapter, not the protocol namespace.

## Why the unit is a Bokeh document

Panel's Python objects are a high-level authoring layer. At render time Panel creates a Bokeh `Document` containing a graph of Bokeh models; widget values, plots, layouts and Panel's custom models are properties in that graph. Bokeh already defines the state and mutation model nteract needs: `Document.to_json()` serializes the graph, `Document.apply_json_patch()` applies a browser-origin patch in Python, document change events describe Python-origin changes, a `setter` token marks the origin of a mutation, and binary buffers are referenced from serialized values.

Panel's notebook implementation wraps that model in PyViz comms (`panel/viewable.py` `_repr_mimebundle_`, `panel/models/comm_manager.{py,ts}`). Those comms are transport, not Panel's state model. Calling `viewable.get_root(doc=doc, comm=None)` creates the model graph without choosing a PyViz transport, and `panel/reactive.py` `_link_props` then uses Panel's server change callbacks, so browser patches applied to the document still update Parameters and run Python callbacks. A probe against Panel 1.9.3 and Bokeh 3.9.1 confirmed that a widget rendered this way updates its Parameter and runs watchers when a Bokeh patch is applied, emits a `ModelChangedEvent` for a Python change, and gives callback-derived events a different setter from the inbound patch.

## Kernel binding

The launcher registers an IPython formatter for `panel.viewable.Viewable` by module and type name (`_bootstrap.py`). `for_type_by_name` is lazy, takes precedence over Panel's `_repr_mimebundle_`, and needs no import hook or Panel monkeypatch. The Panel adapter (`_panel.py`) does roughly:

```python
doc = Document()
root = viewable.get_root(doc=doc, comm=None)
if root not in doc.roots:
    doc.add_root(root)
session = BokehDocumentSession(doc=doc, roots=[root], producer=...)
registry.add(session)
return session.mimebundle()
```

The real implementation also establishes Panel's expected current-document context, collects resources, preserves binary buffers, and removes the session when its output is retired or the kernel shuts down. The session registry (`_bokeh_session.py`) and the launcher's custom shell and IOPub messages are not Jupyter comm targets: there is no target-name discovery, arbitrary envelope forwarding, or frontend-visible comm lifecycle. `jupyter-protocol` preserves the unknown message types, so the Rust runtime parses them without generic raw-message forwarding.

## Initial MIME contract

The formatter returns `application/vnd.nteract.bokeh-session.v1+json` and `text/plain`:

```json
{
  "schema_version": 1,
  "session_id": "kernel-minted UUID",
  "producer": {"name": "panel", "version": "1.9.4"},
  "bokeh_version": "3.9.2",
  "document": {},
  "root_ids": ["p1001"],
  "resources": {
    "javascript": [],
    "stylesheets": [],
    "javascript_modules": [],
    "module_exports": {}
  },
  "buffers": [],
  "session_doc": {},
  "session_doc_buffers": []
}
```

- `document` is Bokeh document JSON, not generated HTML, and `root_ids` names the roots to mount. It is the render fallback: the daemon rewrites it with the materialized state when the kernel goes away and before each save, so saved and frozen outputs render from it read-only.
- `session_doc` and `session_doc_buffers` are the baseline the daemon builds the session document from; the daemon strips them from the stored payload once ingested.
- `buffers` maps Bokeh buffer ids to Jupyter buffer indexes for the initial hop and to content references after ingest.
- The kernel mints `session_id` because it owns the live document. The daemon associates it with `output_id`, `cell_id` and `execution_id` when the display message enters the output pipeline.

The formatter returns no Panel `text/html`, `application/javascript`, or HoloViews exec/load markers. The launcher also filters the legacy load/exec outputs that `pn.extension()` publishes, because the session manifest is the resource authority and a second PyViz bootstrap can replace the frame's Bokeh runtime. If native session construction fails, the formatter marks Panel's existing MIME representation as an authorized fallback and the filter lets it through.

## Resource model

The adapter includes BokehJS core and widget bundles plus the Panel custom-model assets the rendered roots need. The manifest admits URLs allowed by the iframe CSP, explicitly typed inline package resources, and JavaScript module URLs with their exported global names. It does not admit an opaque generated HTML document; inline code is kernel output and runs only inside the isolated, non-same-origin frame. Content-addressed resource blobs are a compatible future extension.

## Relationship to anywidget

The lifecycle resembles anywidget: a Python-side state owner, a browser view, explicit synchronization, binary buffers, remount and cleanup. The state shape differs. An anywidget model is a trait map with custom messages; a Bokeh document is an identity-rich object graph whose structure only the kernel can produce. That is why sessions get their own document type with kernel-only structure rather than reusing ipywidget topology in `CommsDoc`.

## Upstream opportunities

The implementation uses public Bokeh document APIs and Panel's public `get_root`. The fragile parts are resource collection and the Panel context needed while constructing a caller-owned document. Either of these small upstream APIs would remove them:

1. Panel: `Viewable.to_document_session(resources=...)`, returning a document, roots, resource manifest and cleanup callback without selecting notebook comms.
2. Bokeh: a supported notebook document-session serializer exposing snapshot buffers, patch encoding, setter-based event collection and resource requirements as one typed object.

Either is preferable to standardizing a new comm-manager backend.

## Rejected alternatives

### Replace Panel's JupyterCommManager

It preserves Panel's transport shape, requires monkeypatching imported class bindings and global state, and makes a Panel-specific two-comm lifecycle the core protocol even though the state being synchronized is a Bokeh document.

### Forward raw Jupyter comms to the iframe

nteract already has a scoped comm path for ipywidgets. A generic bridge would reintroduce opaque mutable state, broaden the authority surface and complicate replay.

## Guardrails

- No Panel or PyViz monkeypatch on kernel startup.
- No generic raw Jupyter message or comm forwarding to the browser.
- No Panel state in `WidgetStore` or `CommsDoc`.
- No generated Panel HTML as the canonical session payload.
- No session reconnection across a kernel-id change.

## Source map

- Panel notebook display and reactive linking: `panel/viewable.py`, `panel/reactive.py`
- Launcher formatter registration: `python/nteract-kernel-launcher/nteract_kernel_launcher/_bootstrap.py`
- Panel producer adapter and legacy-bootstrap filter: `python/nteract-kernel-launcher/nteract_kernel_launcher/_panel.py`
- Kernel-owned session registry and deltas: `python/nteract-kernel-launcher/nteract_kernel_launcher/_bokeh_session.py`
- Kernel subclass and shell handlers: `python/nteract-kernel-launcher/nteract_kernel_launcher/app.py`
- Session document schema and filter: `crates/runtime-doc/src/bokeh_session_doc.rs`
- Daemon and runtime agent: `crates/runtimed/src/bokeh_session.rs` and `crates/runtimed/src/bokeh_session/`
- Browser host and frame: `src/components/isolated/bokeh-session-doc-store.ts`, `src/components/isolated/bokeh-session-bridge-manager.ts`, `src/isolated-renderer/bokeh-session-controller.ts`
- MCP summary and write tool: `crates/runtimed-outputs/src/bokeh_summary.rs`, `crates/runt-mcp/src/tools/bokeh.rs`
