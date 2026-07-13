# Bokeh Document Sessions for Panel

Status: Implemented architecture with follow-up validation work. The runtime is
a generic Bokeh document-session system with a thin Panel formatter adapter.
Panel's static notebook representation remains available only as a marked
formatter fallback; it is not the live-session transport.

## Goal

Panel output in nteract should behave like a live Bokeh document, not like an
HTML fragment with a PyViz comm manager attached to it.

The user-facing result is straightforward:

- displaying a Panel object renders immediately;
- browser interactions run Python callbacks;
- Python-side changes update every mounted view;
- callback stdout and errors appear as notebook outputs;
- iframe remounts recover the latest state;
- kernel restart leaves a frozen last state with a disconnected overlay;
- large document snapshots and binary patches use blob storage instead of
  growing a CRDT document or JSON frame without bound.

The architecture should also be useful for plain Bokeh output. Panel is the
first producer adapter, not the protocol namespace.

## Why the Unit Is a Bokeh Document

Panel's Python objects are a high-level authoring layer. At render time Panel
creates a Bokeh `Document` containing a graph of Bokeh models. Widget values,
plots, layouts, and Panel's custom models are properties in that graph.

Bokeh already defines the state and mutation model nteract needs:

- `Document.to_json()` serializes a checkpoint of the model graph;
- `Document.apply_json_patch()` applies a browser-origin patch in Python;
- document change events serialize into `PATCH-DOC` operations for the browser;
- a `setter` token marks the origin of a mutation and prevents an applied patch
  from being sent straight back to its source;
- binary buffers are referenced from serialized values instead of being forced
  into JSON strings.

Panel's current notebook implementation wraps that model in PyViz comms. In
`panel/viewable.py`, `_repr_mimebundle_` chooses a Jupyter comm manager,
constructs a document and root model, and `_render_mimebundle` adds Panel's
`CommManager` model plus a server and client comm. In
`panel/models/comm_manager.ts`, the browser turns Bokeh document changes into
`PATCH-DOC` messages and applies incoming protocol messages to its document.
The Python `panel/models/comm_manager.py` performs the inverse operation.

Those comms are transport. They are not Panel's authoritative state model.

There is a cleaner entry point already present in Panel. Calling
`viewable.get_root(doc=doc, comm=None)` creates the model graph without choosing
a PyViz transport. In `panel/reactive.py`, `_link_props` uses Panel's server
change callbacks when `comm` is `None`, so browser patches applied to the
document still update Parameters and run Python callbacks. A source-level probe
against Panel 1.9.3 and Bokeh 3.9.1 confirmed all of the following:

1. A `FloatSlider` can be rendered into a caller-owned `Document` with
   `comm=None`.
2. Applying a Bokeh JSON patch updates the Panel widget value and runs a Python
   watcher.
3. A Python parameter change emits a Bokeh `ModelChangedEvent`.
4. A linked-widget callback emits a derived event with a different setter from
   the inbound patch, so origin filtering preserves the callback result without
   echoing the input.
5. A fresh `Document.to_json()` checkpoint restores the current value.

This is the native seam. nteract does not need to impersonate PyViz comms to use
Panel's reactive model.

## Decision

nteract will model a live visualization as a `BokehDocumentSession`.

A session has:

- a kernel-owned live Bokeh `Document` and callback graph;
- an immutable initial output payload;
- a runtime-owned identity, revision, connection state, and replay pointers;
- browser views that materialize the document with BokehJS;
- typed patch requests and events between browser, daemon, and kernel;
- no raw `comm_open`, `comm_msg`, or `comm_close` surface outside the existing
  ipywidget subsystem.

Panel-specific code ends after it creates the document, root model, producer
metadata, and resource manifest. The runtime, CRDT projection, patch transport,
and renderer use Bokeh session terminology.

## Initial MIME Contract

The launcher registers an IPython formatter for `panel.viewable.Viewable` by
module and type name. `for_type_by_name` is lazy: it does not import Panel at
kernel startup, and IPython resolves the registered formatter through the
object's MRO after Panel is imported. The registered formatter takes precedence
over Panel's `_repr_mimebundle_`, so no import hook or Panel monkeypatch is
required.

The formatter returns:

```text
application/vnd.nteract.bokeh-session.v1+json
text/plain
```

The structured payload is:

```json
{
  "schema_version": 1,
  "session_id": "kernel-minted UUID",
  "revision": 0,
  "producer": {
    "name": "panel",
    "version": "1.9.3"
  },
  "bokeh_version": "3.9.1",
  "document": {},
  "root_ids": ["p1001"],
  "resources": {
    "javascript": [],
    "stylesheets": [],
    "javascript_modules": [],
    "module_exports": {}
  },
  "buffers": []
}
```

`document` is Bokeh document JSON, not generated HTML. `root_ids` identifies
which document roots should mount. Classic JavaScript and stylesheet entries
are explicit URLs or typed inline source; JavaScript modules and module exports
are separate typed fields. They are not script tags hidden in an HTML string.
Buffer entries map Bokeh buffer ids to Jupyter buffer indexes for the initial
hop and to content references after daemon ingestion.

The formatter returns no Panel `text/html`, `application/javascript`, or
HoloViews exec/load markers on the native path. The launcher also filters the
legacy HoloViews load/exec outputs that `pn.extension()` publishes, because the
session manifest is the resource authority and a second PyViz bootstrap can
replace the frame's Bokeh runtime. If native session construction fails, the
formatter marks Panel's existing MIME representation as an authorized fallback;
the filter removes that internal marker and lets the legacy output through.

The kernel mints `session_id` because it owns the live document. The daemon
associates that id with `output_id`, `cell_id`, and `execution_id` when the
display message enters the normal output pipeline. The Python formatter does
not guess notebook topology.

## Kernel Binding

The launcher owns a small generic session registry. A Panel adapter performs
roughly this operation:

```python
doc = Document()
root = viewable.get_root(doc=doc, comm=None)
if root not in doc.roots:
    doc.add_root(root)
session = BokehDocumentSession(doc=doc, roots=[root], producer=...)
registry.add(session)
return session.mimebundle()
```

The real implementation also establishes Panel's expected current-document
context, collects Panel and Bokeh resources, preserves binary serialization
buffers, and removes the session when it is closed or the kernel shuts down.

The registry exposes document operations, not a comm-manager compatibility
surface:

```text
open(viewable) -> initial snapshot
apply_patch(session_id, base_revision, patch, buffers) -> transaction result
checkpoint(session_id) -> serialized document
close(session_id)
```

The launcher kernel subclass registers custom Jupyter shell handlers for these
operations. The concrete message names are:

```text
nteract_bokeh_patch_request
nteract_bokeh_patch_reply
nteract_bokeh_checkpoint_request
nteract_bokeh_checkpoint_reply
nteract_bokeh_close_request
nteract_bokeh_close_reply
```

Asynchronous Python-origin changes publish a typed IOPub message:

```text
nteract_bokeh_event
```

The shell handler does not publish canonical patches in its reply. It applies
the request under the session lock, enqueues the resulting transaction, and
returns only a correlated acknowledgement with status and revision. A single
kernel-side event publisher drains both interaction results and asynchronous
Python changes onto IOPub in revision order. This avoids trying to infer order
between independent shell replies and IOPub events.

`jupyter-protocol` preserves unknown message types as `UnknownMessage`, so the
Rust runtime can parse these payloads without adding generic raw-message
forwarding. ipykernel supports the request handlers through the kernel
subclass's `msg_types` and `shell_handlers` tables.

This channel is intentionally not a Jupyter comm target. It has no target-name
discovery, arbitrary envelope forwarding, or frontend-visible comm lifecycle.

## Patch Transaction

A browser interaction follows one serialized transaction path:

```text
BokehJS view
  -> create JSON patch from document events
  -> iframe sends ApplyBokehSessionPatch(session_id, base_revision, patch)
  -> daemon validates session ownership and active kernel generation
  -> runtime agent sends nteract_bokeh_patch_request
  -> launcher applies patch with an origin setter
  -> Panel updates Parameters and runs Python callbacks
  -> launcher collects derived Bokeh events and callback output
  -> launcher returns a correlated status/revision/output acknowledgement
  -> launcher publishes the canonical revision as nteract_bokeh_event
  -> daemon persists and broadcasts a typed BokehSessionPatch event
  -> mounted peers apply the ordered patch transaction
```

The canonical transaction can contain a replayable client patch, a derived
kernel patch, or a replacement checkpoint. The origin browser skips the client
patch because its local document already contains that mutation, then applies
the derived patch. Other browsers apply both.

Bokeh sends browser events and lifecycle signals as `MessageSent` patch events.
The launcher applies the full inbound patch to the Python document so Panel and
Bokeh callbacks still run, but removes `MessageSent` events from the replayable
client patch before persistence and broadcast. A button click that runs a
callback without mutating the document therefore produces a canonical no-op
revision: it has identity and ordering but no patch payload. The browser filters
the Bokeh `document_ready` lifecycle event before transport because replaying it
after every remount would create an endless sequence of new revisions.

Python applies the client patch with a transaction-specific setter token. The
session's document-change receiver ignores events carrying that setter. Changes
caused by Panel callbacks normally carry a different setter and are included in
the derived patch. Browser views use the same rule for kernel-origin patches so
they do not send those changes back.

The kernel session is the revision authority. One per-session lock owns
document mutation, event collection, revision allocation, and insertion into
the ordered IOPub event queue. Both shell-request callbacks and asynchronous
Python callbacks pass through that same critical section. Every accepted
transaction or asynchronous server event increments a monotonically increasing
revision exactly once.

The daemon treats the IOPub event stream as canonical and uses revision to
detect gaps or duplicates. A shell acknowledgement can cross its corresponding
IOPub event in transit; it cannot advance projected document state. The runtime
correlates the two with a transaction id and publishes only the ordered IOPub
transaction to browser views.

Requests include `base_revision`. A stale request is not generically merged:
Bokeh patches can contain structural model changes, so last-writer-wins at the
JSON envelope level would be unsafe. The runtime returns a stale-revision result
and the browser resynchronizes from checkpoint plus tail.

Each browser view permits at most one in-flight patch request per session and
debounces local document events for 50 milliseconds before serializing one
Bokeh patch. Events arriving during the request remain pending for the next
transaction. On a stale response, the view restores authoritative state rather
than automatically replaying an opaque structural patch. The current local
pending list has no independent count or byte limit; sustained-input
benchmarking must establish whether Bokeh-side event combination or an explicit
bound is required.

## Runtime State

`RuntimeStateDoc` owns session topology and replay coordinates. It gains a
`bokeh_sessions` map keyed by `session_id`:

```text
bokeh_sessions/{session_id}/
  output_id
  cell_id
  execution_id
  kernel_id
  status                 connected | disconnected | closed | error
  head_revision
  producer_name
  producer_version
  bokeh_version
  root_ids[]
  checkpoint/
    revision
    content_ref
  patch_tail[]
    base_revision
    revision
    content_ref
```

The daemon/runtime actor is the only writer. Frontend peers can request a patch
but cannot author session topology, advance revision, replace checkpoint refs,
or mark a disconnected session connected.

The live patch event is an explicit `NotebookBroadcast::BokehSessionPatch`
variant. It is not `NotebookBroadcast::Comm`, and it does not enter
`WidgetStore`, `CommsDoc`, or `CommBridgeManager`.

RuntimeStateDoc is the durable projection for a room; the patch broadcast is the
low-latency path. A peer that misses broadcasts reconstructs a session from the
checkpoint and bounded patch tail named by RuntimeStateDoc.

## Blob and Checkpoint Policy

Full Bokeh documents and binary buffers do not belong inline in Automerge.

The daemon stores each checkpoint and patch payload in the content-addressed
blob store. RuntimeStateDoc contains only typed metadata, hashes, sizes, media
types, revisions, and ordered references.

The implemented policy is:

1. Blob-store every canonical revision, including an event-only no-op revision,
   and append its reference to RuntimeStateDoc before broadcasting it.
2. Ask the kernel for a checkpoint when the tail reaches 32 revisions.
3. Atomically advance the checkpoint ref and remove covered tail refs in one
   RuntimeStateDoc transaction.
4. Stop accepting another patch and force resynchronization if the tail reaches
   the hard limit of 128 revisions before compaction catches up.

There is no byte threshold, quiescence checkpoint, or coalesced RuntimeStateDoc
write yet. Those are possible performance refinements, not current guarantees.
Correctness does not depend on a particular count: a checkpoint at revision C
plus the ordered tail C+1 through R reconstructs revision R.

Patch persistence and checkpoint work use a bounded visualization-state lane.
Kernel lifecycle and execution completion remain on the separate reliable
control path. A slider flood must not delay interrupt, kernel-idle, or
execution-done signals.

## Callback Output

The custom shell handler captures stdout and stderr while applying a patch and
running synchronous callbacks. Its reply carries those streams separately from
the Bokeh patch result. Errors carry a structured exception name, value, and
traceback.

The daemon appends them as ordinary stream or error outputs to the session's
owning `execution_id`. It does not log them only in the iframe console and does
not create a fake cell execution. RuntimeStateDoc permits output append after an
execution reaches a terminal state, which is required because an interaction
can happen long after the original display call completed.

Asynchronous Python-origin document changes preserve session ordering through
`nteract_bokeh_event`. Capturing and routing stdout, stderr, and exceptions from
callbacks that run outside a browser patch shell request is not implemented
yet. That follow-up must use the RuntimeStateDoc session-to-execution
association rather than relying on a possibly unrelated Jupyter parent header.

## Frontend Renderer

The isolated renderer registers the new Bokeh session MIME with the Bokeh
plugin. It does not execute Panel-generated HTML or JavaScript.

The renderer:

1. loads the explicit resource manifest in dependency order;
2. creates a BokehJS `Document` from the JSON checkpoint;
3. resolves binary buffer refs;
4. mounts the named roots with BokehJS standalone embedding APIs;
5. subscribes to document changes and sends typed patch requests;
6. applies ordered runtime patch transactions with origin suppression;
7. resynchronizes from checkpoint plus tail on a revision gap;
8. tears down Bokeh views and subscriptions on unmount.

The frame bridge gains Bokeh-session JSON-RPC methods. They are separate from
the widget methods and carry only validated session payloads. Every message is
scoped to the output and session that mounted the frame. Existing source-window
validation and sandbox policy remain mandatory.

## Remount and Restart Behavior

Iframe remount does not ask Python to render the object again. It reads the
latest RuntimeStateDoc session record, fetches the checkpoint and tail blobs,
and reconstructs the Bokeh document. This avoids duplicate Python callback
registration and makes output state available to late peers.

Each session records the `kernel_id` that created it. When that kernel exits or
is replaced, the runtime marks its connected sessions `disconnected` while
retaining their checkpoint and tail. The renderer keeps the last state visible
and adds a compact disconnected overlay that prevents further interaction.

Executing the cell again creates a new session and output. A restarted kernel
does not silently adopt a document whose Python objects and callbacks no longer
exist.

## Resource Model

Panel resources are part of the session checkpoint contract. The adapter must
include BokehJS core/widget bundles plus Panel custom-model assets needed by the
rendered roots. Resource identity includes enough version and hash information
to cache safely across outputs.

The current resource manifest admits:

- URLs allowed by the iframe CSP;
- explicitly typed inline package resources;
- JavaScript module URLs and their exported global names.

Content-addressed resource blobs are a compatible future extension, but the
implemented resource schema does not expose them yet. Document and patch binary
buffers already use the blob store.

It does not admit an opaque generated HTML document. Inline code remains kernel
output and therefore runs only inside the existing isolated, non-same-origin
frame.

## Relationship to anywidget

The lifecycle is usefully similar to anywidget: a Python-side state owner, a
browser view, explicit synchronization, binary buffers, remount, and cleanup.
The state shape is different.

An anywidget model is primarily a trait map with custom messages. A Bokeh
document is an identity-rich object graph with protocol-defined structural
patches and setter semantics. Flattening it into ipywidget traits would discard
the protocol Bokeh and Panel already implement and would put high-frequency
document patches into CommsDoc under misleading widget topology.

nteract should share infrastructure where the contracts match, such as blob
resolution, isolated-frame lifecycle, revision handling, and view cleanup. It
should not pretend a Bokeh document is an ipywidget model.

An upstreamable abstraction could still look anywidget-like at the lifecycle
level:

```text
NotebookDocumentAdapter
  snapshot() -> document + buffers + resources
  apply_patch(patch, buffers, setter) -> derived patch + outputs
  subscribe(callback)
  close()
```

Panel could expose such an adapter without depending on nteract. Bokeh could
host the generic document-session interface, with Panel supplying resource and
current-document context hooks.

## Upstream Opportunities

The first implementation can use public Bokeh document APIs and Panel's public
`get_root` method. No comm-manager registration hook is required.

The potentially fragile parts are resource collection and the precise Panel
context needed while constructing a caller-owned document. After the nteract
adapter is proven, propose one of these small upstream APIs:

1. Panel: `Viewable.to_document_session(resources=...)`, returning a document,
   roots, resource manifest, and cleanup callback without selecting notebook
   comms.
2. Bokeh: a supported notebook document-session serializer that exposes
   snapshot buffers, patch encoding, setter-based event collection, and
   resource requirements as one typed object.

Either is preferable to standardizing a new comm-manager backend. The upstream
hook should expose Panel's actual document model, not ask every frontend to
reimplement PyViz comm behavior.

## Rejected Alternatives

### Replace Panel's JupyterCommManager

Rejected as the nteract architecture. It preserves Panel's current transport
shape, requires monkeypatching imported class bindings and global state, and
encourages raw comm semantics to leak through every frontend layer. It also
makes a Panel-specific two-comm lifecycle the core protocol even though the
state being synchronized is a Bokeh document.

### Forward raw Jupyter comms to the iframe

Rejected. nteract already has a carefully scoped comm path for ipywidgets. A
generic bridge would reintroduce opaque mutable state, broaden the authority
surface, complicate replay, and make later removal expensive.

### Put every Bokeh model property in Automerge

Rejected. Bokeh already owns graph identity, validation, event combination,
binary serialization, and setter semantics. Translating each property into a
new CRDT schema would duplicate Bokeh and make compatibility depend on every
model extension. RuntimeStateDoc stores session topology and replay pointers;
Bokeh patches remain Bokeh patches.

### Keep only an in-memory patch stream

Rejected. It cannot recover iframe remounts, late peers, or frozen state after
kernel loss. Checkpoint plus bounded tail is the replay record.

### Serialize the full document on every slider event

Rejected as the steady-state path. It is simple but scales with document size
per interaction. Live patches stay incremental; count-triggered checkpoints
compact the replay tail.

## Guardrails

- No Panel or PyViz monkeypatch on kernel startup.
- No generic raw Jupyter message or comm forwarding to the browser.
- No Panel state in `WidgetStore` or `CommsDoc`.
- No unbounded patch log in RuntimeStateDoc.
- No large snapshot or binary patch bytes inline in Automerge.
- No lifecycle signal on the bounded visualization-state work lane.
- No generated Panel HTML as the canonical session payload.
- No session reconnection across a kernel-id change.
- No frontend-authored RuntimeStateDoc session mutation.

## Implementation Status

Implemented and covered by focused tests:

- launcher-owned `BokehDocumentSession` registry and lazy Panel formatter;
- typed initial MIME, Bokeh resource closure, and binary buffer handoff;
- isolated BokehJS document renderer without a PyViz comm manager;
- custom shell request/reply handlers and canonical typed IOPub events;
- RuntimeStateDoc session topology, blob-backed checkpoint and patch tail;
- one in-flight browser transaction, ordered revision replay, and gap resync;
- synchronous callback stdout, stderr, and errors routed to the owning
  execution;
- frozen state plus a disconnected overlay after kernel replacement.

Verified in the development browser with a Panel slider and linked callback:

- initial native rendering;
- a Python-side change producing a live derived browser patch and ordinary
  notebook stdout;
- full-page remount restoring the latest state without rerunning the cell;
- kernel restart preserving the last state with a disconnected overlay;
- rerunning the cell creating a new connected session.

Remaining validation and follow-up work:

- automate a real pointer-origin slider or button interaction through the
  nested isolated frame and Bokeh shadow DOM;
- prove two simultaneously mounted browser views converge;
- capture output from asynchronous callbacks outside the patch shell request;
- benchmark sustained event load, checkpoint latency, CRDT write rate, and
  large binary documents;
- use those measurements to decide on local event combination and byte-based
  backpressure;
- draft the smallest upstream Panel or Bokeh API proposal supported by the
  implementation evidence.

## Acceptance Criteria

The initial implementation is acceptable when:

- `pn.widgets.FloatSlider()` renders from the structured session MIME;
- a browser patch updates its Python parameter without any comm message;
- a Python callback can update another Panel object and the mounted browser
  receives the derived patch;
- synchronous callback stdout and exceptions appear on the owning cell;
- an iframe remount restores the latest checkpoint plus tail without rerunning
  user code;
- kernel restart freezes the latest state and shows disconnected status;
- RuntimeStateDoc enforces a finite patch-tail limit;
- existing ipywidget and static Bokeh/Panel fallback behavior remains intact.

Multi-view convergence, asynchronous callback output, and sustained-load
measurements remain required before calling the runtime production-complete.

## Source Map

- Panel notebook display: `panel/viewable.py`
- Panel reactive property linking: `panel/reactive.py`
- Panel notebook resource and push helpers: `panel/io/notebook.py`
- Panel Python patch application: `panel/models/comm_manager.py`
- Panel browser patch production/application: `panel/models/comm_manager.ts`
- PyViz comm callback capture and ACK behavior: `pyviz_comms/__init__.py`
- nteract launcher formatter registration:
  `python/nteract-kernel-launcher/nteract_kernel_launcher/_bootstrap.py`
- nteract Panel producer adapter and legacy-bootstrap filter:
  `python/nteract-kernel-launcher/nteract_kernel_launcher/_panel.py`
- nteract kernel-owned Bokeh document registry:
  `python/nteract-kernel-launcher/nteract_kernel_launcher/_bokeh_session.py`
- nteract kernel subclass:
  `python/nteract-kernel-launcher/nteract_kernel_launcher/app.py`
- Jupyter message ingestion: `crates/runtimed/src/jupyter_kernel.rs`
- typed persistence and canonical event ingestion:
  `crates/runtimed/src/bokeh_session.rs`
- runtime document schema and policy: `crates/runtime-doc/src/`
- iframe host bridge:
  `src/components/isolated/bokeh-session-bridge-manager.ts`
- isolated BokehJS revision controller:
  `src/isolated-renderer/bokeh-session-controller.ts`
- isolated renderer plugin contract: `src/components/isolated/AGENTS.md`
