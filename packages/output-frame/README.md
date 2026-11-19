# @nteract/output-frame

A browser host and isolated runtime for [Anywidget Front-End Modules](https://anywidget.dev/en/afm/) with local state.
Pages is the first consumer. This package owns the frame lifecycle and byte
transport; the embedding product owns authorization, source selection, revisions,
and the decision to execute code.

```js
import { mountAnywidgetOutput } from '@nteract/output-frame';
const output = mountAnywidgetOutput(element, {
  spec: {
    _esm: 'code', _css: 'style', state: { time: 0 },
    buffers: ['recording'], buffer_paths: [['recording']],
  },
  assets: {
    code: { bytes: moduleBytes, mediaType: 'text/javascript' },
    style: { bytes: cssBytes, mediaType: 'text/css' },
    recording: { bytes: wavBytes, mediaType: 'audio/wav' },
  },
}, {
  frameUrl: 'https://outputs.example/frame/v2/',
  runtime: frameRuntimeText, // the runtime from your own build, see below
  hostContext: { theme: 'light' },
});
// A new recording reaches the mounted model; changed code needs a new mount.
output.setData('recording', newWavBytes);
output.destroy();
```

## Bootstrap and runtime

The output host serves one fixed document, the bootstrap
(`@nteract/output-frame/bootstrap`: `BOOTSTRAP_HTML`). Serve it from a
separate HTTPS origin. The embedding page supplies everything else: it builds
the runtime from this package and passes its text as the `runtime` option, a
string or a function that resolves to one. Host and runtime then always come
from the same build, however the output host is deployed or shared. A runtime
or port protocol change needs no output host deploy. Only a change to the
bootstrap document itself does, at a new frame path.

Build the runtime as one classic script, never as a module: an entry that
imports `styles.css` as text and calls `installRuntime(styles)` from
`@nteract/output-frame/runtime`, bundled as an IIFE. The runtime appends an
import map at mount, and Firefox and older Safari ignore an import map added
after any module has loaded. Pages builds it in `apps/pages/scripts/build-output.mjs`
and its credential-free Worker in `apps/pages/output` serves the bootstrap; the
library contains no Pages API routes, source IDs, authentication, or Cloudflare
dependencies.

The bootstrap's one script (`BOOTSTRAP_SCRIPT`) can be read in a minute:

- It accepts one message, `{type: "nteract-output-boot", runtime}`, and only
  from `window.parent`. It ignores every other message and every later boot.
- It runs `runtime` once as an inline classic script, then removes
  `window.nteractOutputRuntime`, which the runtime defines, and calls it with
  the boot event. The event's other fields and its transferred ports pass
  through untouched.
- If the runtime throws, defines no entry point, or the entry point throws, it
  posts `{type: "nteract-output-boot-failed"}` to its parent. The host then
  fails the mount at once.

It knows nothing about protocol versions, ports, views, data or catalogs. An
output host may place stylesheets or a `widget-catalog-map` before the script.

The bootstrap runs code only from its embedding parent. The parent already
supplies the view's code to the frame, and the frame stays an opaque-origin
`sandbox="allow-scripts"` iframe without `allow-same-origin`, with no
credentials, under the output host's CSP. Running the parent's runtime
grants that code nothing it did not already have.

The host creates that iframe and, after its `load` event, posts the boot
message `{type, runtime, connect, nonce}` to that exact WindowProxy, with a
MessagePort transferred. `connect` names the port protocol,
`nteract-output-connect-v3` (`PROTOCOL_VERSION` in `src/lifecycle.mjs`); the
runtime answers another version with an error that asks for a reload, and does
not mount. The nonce matches the frame URL's fragment. The runtime accepts the
port only from its immediate parent. This is channel binding,
not authentication of a parent application. The bootstrap can be embedded by anyone.

The host's lifecycle (`outputTransition` in `src/lifecycle.mjs`) names the
boot as its own state, `booting`, from the boot message to the runtime's
first answer on the port. The host sends that message once the frame has
loaded and the runtime text has resolved; a slow runtime text counts against
the startup limit only. `booting` has its own bound, `bootTimeoutMs` (10 seconds
by default), and its own failure text: "The output frame did not start. The
output host may need an update." The startup limit, `timeoutMs` (20 seconds),
covers the whole mount; when it ends in `booting` it reports the boot text,
and otherwise "The output took too long to start."

Subsequent messages use the port. Inputs are copied into dedicated ArrayBuffers
before transfer, including when callers provide a subarray of a larger buffer.
The runtime never receives bearer tokens, storage handles, or a general fetch
proxy. Its only parent messages report lifecycle, failure, and bounded height.

The default ESM export is a standard AFM object or async factory. `initialize`
runs once per model before any `render`; both may be async. Each receives its
own lifetime's AbortSignal, and returned cleanup callbacks run on abort, including
when a hook completes after cancellation. An object returned from `initialize`
is exposed through the widget handle's `exports`. Initialization times out after
10 seconds. Failed initialization never retries within the same mount.

`model.get/set/on/off` operate locally. `change:key` callbacks take no arguments. Subscriptions are scoped to the
initialization or view lifetime: teardown removes them, and one view's `off()`
cannot clear a sibling's listeners. Values remain shared across views.
`save_changes()` is a no-op: it never writes to the embedding product or a kernel.
`send()` throws a descriptive no-backend error. `msg:custom` listeners may be
registered, but there is no remote peer to supply messages. Removing/reloading
an output or changing its code resets it to the supplied initial state. A data
change that the view listens for does not (see [Data changes](#data-changes)).

`buffers` and `buffer_paths` use Jupyter's parallel buffer/path convention:
buffers name assets, while paths identify object keys and numeric array indices
inside `state`. The runtime restores DataViews at those paths. Parent containers
and array slots must exist (null array placeholders work); object leaves may be
absent. Paths cannot overlap or traverse prototype keys. Modules use `model.get`
to read the restored values; there is no proprietary `output.inputs` prop.

Optional `spec.models` maps child IDs to the same widget definition shape (without
nested `models`). The root ID is `root`. A state value `"anywidget:slider"` refers
to `models.slider`. `host.getWidget(ref)` waits for initialization and returns
`{ exports, render }`; `host.getModel(ref)` resolves its local model. Multiple
views share that model and the factory's closure, with separate view signals.
Pass an optional signal to `handle.render({el, signal})` to end that view early.
The resolving parent view's lifetime always applies too, including for content
rendered outside its DOM. Removing a connected view element aborts
its signal too. Errors name malformed or missing references; stalled
initialization rejects. No registry spans iframe mounts or grants access to
another output's data. Local reference reassignment works for registered models.

CSS is injected once per initialized model and removed on disposal. `_esm` and
`_css` model traits contain the supplied source text. Relative ESM imports are
unsupported with Blob modules: use bundled code or absolute HTTPS imports.
Module/CSS hot replacement requires a new immutable mount, not `model.set`.
Arbitrary ipywidget managers, Python callbacks, kernel comms and custom Python
serializers are not provided. Use ordinary AFM types and framework bridges;
Pages-specific theme helpers are optional extensions.

Pages authors use `application/vnd.nteract.anywidget.v2+json` with direct
`module: {source_id, revision?}`, optional `stylesheet`, and paired
`buffers: [{source: {source_id, revision?}, path: [...]}]` references. Child models
use the same shape. This is a Pages authoring format, not an upstream MIME type.
See [the Pages spec](../../apps/pages/REFERENCE.md#anywidget-outputs).

The Pages adapter validates and resolves references, then compiles them into the
named-byte envelope shown above. This library still has no source IDs, revision
lookup or authorization logic; AFM code sees the same model values. The authoring
format's version is independent of the frame path and the port protocol.

The output host and the embedding app deploy separately. Because the runtime
travels with the page, only a change to the bootstrap document needs care: it
adds a new versioned frame path, keeps serving the previous one for at least
one release, and deploys before the host that mounts the new path. Pages lists
the paths its output Worker serves in `apps/pages/shared/output-frame-paths.mjs`.
`preparePayload` requires exactly the referenced assets, checks module/CSS media
types, and bounds assets to 5 MiB each / 32 MiB total. Pages also enforces spec-size
and source authorization limits.

The output host's HTTP policy (the frame CSP) allows external HTTPS modules, WASM, and broad network
access. Output code can disclose every byte supplied to it. Isolation protects
the host DOM and storage; it does not make untrusted code confidential or a
browser-wide denial-of-service sandbox. Keep credentials off the output domain
and enforce CSRF protections on authenticated host endpoints. The embedding product decides when a mount runs and authorizes every input.
Pages renders automatically within its viewport lifecycle and remounts when the
view's code changes. A changed data input reaches the mounted view through
`setData`, and Pages remounts a view that does not listen for it; failures
expose a Retry button.

## Module views

`mountModuleOutput(container, {kind: 'module', assets: {entry}, imports?}, {files})`
mounts one entry module. Its named `render({model, el, signal, host})` export is
used when it has one; otherwise its default export is an AFM object or factory,
run as an anywidget view's, except that the frame sets no initialization
timeout: an entry may await a slow top-level import, and the host's startup
limit bounds it. Both get a local model built by the same
session code as an anywidget view: `model.get/set/on/off`, a no-op
`save_changes()` and a `send()` that throws.

`files` maps up to 16 `data/<alias>` names to file inputs. The embedder
supplies one object per name and serves it when the view asks:
`{mimeType, byteLength, read(offset, length, signal), bytes(signal),
columns?(format, signal)}`. `read` answers one range, `bytes` the whole file,
and `columns` the file read as a table in `format` (`"parquet"` or `"csv"`), as
a ColumnSet the embedder checks when it decodes it. `columns` rejects for a
format the file is not in; leave it out when the file is no table in any
format. Each signal ends when the frame cancels the request or the mount ends.
The library calls `bytes`, and `columns` for each format, for one request at a
time per file, and delivers each at most once per file.

The frame receives `{mimeType, size, port}` per name, and nothing else until
the view asks. The model's value for each alias is a file object
(`src/file-object.mjs`), and `import f from "data/<alias>"` gives the same
object, bound once to the file the view mounted with:

- `name`, `mimeType`, `size`: known at mount;
- `arrayBuffer()`, `text()`, `json()`: the whole file, read once per file
  object and shared; `arrayBuffer()` gives a new copy on each call;
- `parquet()`: an Arrow-style table (below); it rejects for a file that is not
  Parquet, and for any argument, since it takes no options yet;
- `csv()`: the file parsed as CSV by the embedder, as an array of plain row
  objects with a `columns` property naming the columns in file order, the
  shape of Observable's `FileAttachment.csv`. Values are typed as the table's
  are. It takes no options or `{typed: true}` and refuses any other, naming
  the option. It reads any file, whatever its media type, and rejects for one
  that does not parse;
- `slice(start, end)`: a range object `{size, arrayBuffer(), text()}`, clamped
  as `Blob.slice` clamps, that reads its span with one range request;
- `byteLength` and `read(offset, length, signal)`: the members that make the
  file a Sift byte source, for Sift's `loadTableFile`.

`text()`, `json()`, `parquet()` and `csv()` return the same promise on each call
while it is pending and after it resolves; after a rejection, the next call
asks again. A failed read rejects that call with a plain message and never
fails the mount. Opening a bound file is the embedder's work before it mounts,
and can fail the mount (in Pages, a missing asset or a media type that does
not match its source).

Each file has its own port (`src/byte-source.mjs`). A request names its kind:
`{kind: "range", offset, length}`, `{kind: "bytes"}` or `{kind: "columns",
format}` with `format` `"parquet"` or `"csv"`, each on its own reply port, and any message on that reply port cancels it.
The answer is `{bytes}`, `{columns}` with its typed arrays transferred, or
`{error}`. Both ends check every request, and the frame checks every reply,
ColumnSets included. Every kind counts as one read in the view's read budget.

`bytes` and `columns` are whole reads, with one share per exposed file for
`bytes` and one for each table format (`wholeFileTransition` in
`src/whole-file-total.mjs`). A share is none, reading or delivered. A request
starts only from none; while reading or once delivered, another request for
that share is refused with `{error}`, so the parent serves one at a time and
delivers each at most once. A failure or a cancel, queued or in flight,
returns a reading share to none, so a retry may start. A new file under the
name drops its shares. A whole-file read is at
most 5 MiB, and the `bytes` shares of the view's live files, reading or
delivered, stay within 32 MiB, so that is a bound on the bytes the frame
holds whole. A ColumnSet counts toward no total; the embedder's decode limits
bound it.

A ColumnSet (`src/column-set.mjs`) is `{numRows, columns: [{name, type,
values, nulls?}]}`, structured-cloneable with no class instances. `type` is
`number` or `date` (a `Float64Array`; a date in epoch milliseconds), `bigint` (a
`BigInt64Array` or `BigUint64Array`), or `string`, `boolean` or `other` (an
array). `nulls` is a `Uint8Array` validity mask, 1 where a value is present,
and is absent when the column has no nulls. `checkColumnSet` checks lengths,
types, value kinds, and at most 256 columns with unique names of 1 to 256
characters. The embedder checks a ColumnSet once, when it decodes it (Pages
does in `parquetColumns` and `csvColumns`, before its shared cache keeps it); the host copies
it to each frame without checking it again, and the frame checks its copy.

The table (`src/table.mjs`) spells its members as an Apache Arrow JS table
does: `numRows`, `numCols`, `schema.fields`, `getChild(name)`,
`getChildAt(index)`, `get(index)`, `toArray()`, `select(names)` and iteration
over rows; a column has `length`, `nullCount`, `type`, `get(index)`,
`toArray()`, `toJSON()` and iteration. Values are plain JavaScript: a `date`
is a `Date`, a missing value `null`, and rows are plain objects a view may
change. Nothing else on the object is part of the interface. The Pages
reference lists where it differs from Arrow JS.

## Data changes

`handle.setData(name, value)` offers a mounted view a new data input. The
name must be one the mount declared: a `data/<alias>` of a module view, or a
buffer name of an anywidget view that is not also a module or stylesheet name.
Anything else throws. A module view takes a file input; an anywidget buffer
takes a `Uint8Array`.

The parent sends one message per change on the mount's port:
`{type: 'data', name, input}`, where `input` is `{bytes}` for an anywidget
buffer (a dedicated copy, transferred) or `{mimeType, size, port}` for a module
view's file (a new port). It carries names, data and ports only. The frame checks the name against those its mount declared and
ignores any other.

- The host sends data only once the frame has rendered. Changes before that wait,
  the latest per name, and go in order at `ready`. A failed or disposed mount
  drops them (`dataTransition` in `src/lifecycle.mjs`).
- Replacing a file closes its old port: requests waiting in the read budget
  are dropped and requests in flight abort. The old file object's pending and
  later calls reject as aborted. The new port shares the same budget.
- In the frame, a module view's model key takes a new file object and
  `change:<alias>` fires. For an anywidget buffer, each model key that holds a
  path bound to that buffer gets a copy with a new DataView at the path, and
  `change:<key>` fires once per key. Other local values under that key are kept.
- The frame applies a change only when the view listens for it. Listen with
  `model.on("change:<alias>", …)` to update in place and keep the reader's
  state. If no key the change affects has a `change:<key>` listener on its
  model at that moment, the frame does not apply it and answers
  `{type: 'unhandled-data', name}`. When one affected key listens and another
  does not, every affected key takes the new value (`dataDecision` and
  `receiveDataChange` in `src/data.mjs`).
- The host passes an unhandled answer to the `onUnhandledData(name)` option
  only in `ready`, only for a declared name, and only once for each data
  message it sent for that name (`answerTransition` in `src/lifecycle.mjs`).
  An unsolicited or repeated answer is ignored, so a view can ask for at most
  one new mount per data change. The frame never acknowledges an applied change.
- After `onUnhandledData`, the embedder must mount the view again. The host
  ended the name's previous file when it sent the new one, so the
  view's reads through the old input no longer answer. Pages mounts the view
  again from its newest inputs: a view that does not listen is remounted when
  its data changes.
- `model.set` on a data key by view code stays local, like any other key.

## Read budget

A module view can bind up to 16 files, and each `read(offset, length)` becomes
a request the embedding product serves, often an authorized range request. One
read budget per mount, shared by all of the view's files, bounds that load
(`src/read-budget.mjs` names the constants):

- At most 8 reads are in flight at once across the view.
- Starting a read spends a token. The view starts with 256 tokens and earns 32
  per second, up to 256.
- A read past either bound waits its turn, in arrival order across files.
- At most 256 reads wait. A read that finds the waiting list full is refused
  with `Too many file reads are waiting.`

A read with an invalid interval is refused at once with `Invalid file read.`
and never waits. Aborting a read's signal while it waits removes it without
spending a token or reaching the source. Disposing the mount drops every
waiting read without a reply.

## Relationship to notebook outputs

`src/components/isolated/output-embed.ts` already offers a host-independent
notebook embed. Its renderer registry, MIME bundles, JSON-RPC widget bridge,
CommsDoc synchronization, and Tauri shell adapter remain notebook-owned. This
package does not replace those contracts or claim full ipywidgets support.

Both systems use opaque-origin frames and transferable binary data. This package
makes a smaller immutable ESM session usable without React, notebook stores, or
a kernel. A notebook adapter can use it for this profile; moving the full
notebook renderer requires preserving its comm and renderer-plugin protocols,
its platform shell selection, and its broader sandbox permissions explicitly.
The deployed notebook output host is unchanged.

Pages installs this local package with npm's `install-links=true`; after editing
package source, refresh the installed copy before running Pages builds/tests.

## Validation and example

From `apps/pages`, run `node scripts/output-smoke.mjs` for deterministic browser
boundary tests. `PAGES_OUTPUT_BROWSER=webkit` runs the same checks in WebKit.
`PAGES_OUTPUT_CDN=1` also loads the audio example's real HTTPS
Parquet/WASM dependencies. Its default data is deliberately synthetic.

For a native Inkling export, additionally set `PAGES_OUTPUT_ARTIFACT` to the
`c4-native-dmel.json` file and `PAGES_OUTPUT_WAV` to its original recording.
The harness verifies both recorded SHA-256 values, converts the native matrix to
Parquet, and saves wide/narrow screenshots in ignored `test-results/output-real`.
It does not rerun the model or publish the research files. Set
`PAGES_OUTPUT_LIVE=1` to exercise the deployed output host's bootstrap instead of intercepting
that request with the locally built Worker response.

## Theme and shared controls

### Document layout

The frame document starts borderless, with no body inset. Its normal-flow content determines
the iframe height, including margins and floats; it grows and shrinks as content
changes. Heights are rounded up and bounded to 1–100,000 CSS pixels by the host.
The iframe document does not scroll vertically: the parent Page owns that scroll.
This also prevents scrollbar width from feeding back into responsive chart height.
This high safety limit is not intended as a widget viewport. Avoid viewport-relative
heights on the output root: the viewport itself follows the content height.

Horizontal overflow is clipped at the document boundary, so a near miss beside a
slider cannot pan the entire output sideways. Range controls fill their available
width, have 44px touch targets, and reserve horizontal gestures for adjustment
while allowing vertical scrolling and pinch zoom.
Buttons also have a 44px minimum height. Ordinary content keeps native page scrolling
and pinch zoom; the runtime's stylesheet does not disable those gestures on an ancestor.

For content that should scroll, wrap it in an explicit `.output-scroll` region.
Give vertical regions a height or max-height, and make them keyboard-accessible
with `tabindex="0"`, a suitable role and an accessible label. For example:

```html
<div class="output-scroll" role="region" aria-label="Detailed results" tabindex="0"
     style="max-height:24rem">
  <!-- A wide table or another intentionally scrollable view. -->
</div>
```

These are shared defaults, not a CSS sandbox: modules can override them deliberately.
`.output-surface` remains an opt-in padded card. Application-specific chart sizing
and interaction belong to the module; iframe sizing and native control fixes do not.

### Host context

Pass `hostContext: { theme: 'light' | 'dark', styles: { variables } }` when
mounting. The host resolves its own `system` preference; the wire never accepts
`system`. `readHostContext(element, resolvedTheme)` snapshots the public semantic
CSS tokens from the embedding surface. Call `handle.setHostContext(next)` when
that resolved theme or palette changes. This uses the notebook embed's
`theme`/`styles.variables` shape, with this package's bounded token vocabulary;
notebook-specific palette aliases still belong in its adapter.

The frame applies context before importing the module, sets `.light`/`.dark`,
`data-theme` and `color-scheme`, and remains hidden until themed rendering is
ready. Subsequent updates change presentation without reinitializing the model,
retransferring data or resetting playback. Pages subscribes to its existing theme
store, so both explicit choices and OS changes in system mode propagate.

The runtime includes `@nteract/output-frame/styles.css`: semantic tokens, typography,
focus rings, native form controls, buttons, `.output-surface`, `.output-muted`,
and `.output-stack`. Buttons support `data-variant="secondary"`. Use plain HTML
with these defaults; no React or CSS compiler is required. Authors can also use
these variables from their own CSS or compiled Tailwind. This is a base stylesheet,
not the React/Radix behavior of shadcn components or a runtime Tailwind compiler.

```js
export default {
  render({ el, host }) {
    el.className = 'output-surface';
    const button = el.appendChild(document.createElement('button'));
    button.dataset.variant = 'secondary';
    const paint = () => { button.textContent = `Theme: ${host.getContext().theme}`; };
    paint();
    return host.onContextChange(paint);
  },
};
```

`host.getContext()` returns an immutable snapshot. `host.onContextChange(fn)`
returns an unsubscribe function; notifications follow the CSS update. Canvas or
WebGL authors can redraw in that callback. CSS-based components update directly.
Subscriptions are automatically removed when their view is disposed.
The context helpers are extensions alongside AFM's composition methods.

For a persistent original-data demo, set `PAGES_OUTPUT_SERVE=1` alongside the CDN,
artifact and WAV options above. `PAGES_OUTPUT_PORT` optionally chooses a local
port. The demo has a Light/Dark/System selector and uses the deployed output host.
