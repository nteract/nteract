# @nteract/output-frame

A browser host and isolated runtime for [Anywidget Front-End Modules](https://anywidget.dev/en/afm/) with local state.
Pages is the first consumer.
This package owns the frame lifecycle and byte transport.
The embedding product owns authorization, source selection, revisions, and the decision to execute code.

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

The output host serves one fixed bootstrap document (`@nteract/output-frame/bootstrap`: `BOOTSTRAP_HTML`) from a separate HTTPS origin.
The embedding page supplies everything else by building the runtime from this package and passing its text as `runtime` (a string or async resolver).
Host and runtime then always come from the same build, regardless of how the output host is deployed or shared.
A runtime or port protocol change needs no output host deploy; only a bootstrap change needs a new frame path.

Build the runtime as one classic script (IIFE), never as a module:

- Entry imports `styles.css` as text and calls `installRuntime(styles)` from `@nteract/output-frame/runtime`.
- The runtime appends an import map at mount. Firefox and older Safari ignore import maps added after any module has loaded.
- Pages builds it in `apps/pages/scripts/build-output.mjs`, and its credential-free Worker in `apps/pages/output` serves the bootstrap.
- This library contains no Pages API routes, source IDs, authentication, or Cloudflare dependencies.

The bootstrap's single script (`BOOTSTRAP_SCRIPT`) does three things:

- Accepts one message, `{type: "nteract-output-boot", runtime}`, from `window.parent` only. It ignores all other messages and later boots.
- Runs `runtime` once as an inline classic script, deletes `window.nteractOutputRuntime`, and calls it with the boot event (preserving extra fields and transferred ports).
- Posts `{type: "nteract-output-boot-failed"}` to its parent if the runtime throws, defines no entry point, or the entry point throws. The host then fails the mount immediately.

The bootstrap knows nothing about protocol versions, ports, views, data, or libraries.
Every output host serves the same bytes.

## Libraries

A view's libraries arrive in its mount payload, never in the frame document.

- **`payload.libraries`**: maps bare names (such as `d3` or `@observablehq/plot`) to absolute ES module URLs served on the embedder's origin.
- **Host validation (`checkLibraries` in `src/payload.mjs`)**: allows at most 64 entries. Each URL must match `<origin>/catalog/<revision>/<file>.js` on the embedder's origin, sharing one revision across the map. URLs must use HTTPS, or HTTP only on a loopback host.
- **`payload.libraryIntegrity`**: maps up to 256 module URLs in the same catalog revision (libraries and imported chunks) to `sha256-<base64>` hashes.
- **Import map (`src/import-map.mjs`)**: the runtime builds one import map from `payload.libraries`, then adds bound imports and `data/` files as blob URLs, attaching the integrity map as `integrity`. Chromium, Firefox, and WebKit all refuse library modules whose bytes differ. A bound name that duplicates a library fails the mount.

Because the frame has an opaque origin, it loads library modules in CORS mode:

- Each library response must include `Access-Control-Allow-Origin: *`.
- The output host's CSP must allow the embedder's origin in `script-src` (`https:` covers any HTTPS embedder).
- A local HTTP embedder must add its origin to its local frame server's CSP and serve that frame on a loopback address. Chromium blocks a public-origin frame from loading loopback resources.

### Handshake, lifecycle, and isolation

The bootstrap runs code only from its embedding parent.
The parent already supplies view code, and the frame stays an opaque-origin `sandbox="allow-scripts"` iframe (without `allow-same-origin`), credential-free, under the output host's CSP.
Running the parent's runtime grants that code nothing new.

Mount handshake and transport:

- After the iframe's `load` event, the host posts `{type, runtime, connect, nonce}` to that exact WindowProxy with a transferred `MessagePort`.
- `connect` names the port protocol: `nteract-output-connect-v3` (`PROTOCOL_VERSION` in `src/lifecycle.mjs`). A mismatched version returns an error asking for a reload and does not mount.
- `nonce` matches the frame URL's fragment. The runtime accepts the port only from its immediate parent. This is channel binding, not parent authentication; anyone can embed the bootstrap.
- Subsequent messages travel over the port. Inputs are copied into dedicated `ArrayBuffer` instances before transfer, including caller subarrays.
- The runtime never receives bearer tokens, storage handles, or a general fetch proxy. Its only parent messages report lifecycle, failure, and bounded height.

Startup timeouts (`outputTransition` in `src/lifecycle.mjs`):

- **`booting` state**: spans from sending the boot message to the runtime's first port reply. Sending waits for both iframe `load` and resolved `runtime` text (a slow resolver counts only against the startup limit).
- **`bootTimeoutMs` (default 10s)**: bounds `booting`. On expiry, reports `"The output frame did not start. The output host may need an update."`
- **`timeoutMs` (default 20s)**: bounds the whole mount. On expiry, reports the boot error if still `booting`, or `"The output took too long to start."` otherwise.

### Anywidget lifecycle and local model

The default ESM export is a standard AFM object or async factory:

- `initialize` runs once per model before any `render`; both may be async.
- Each hook receives an `AbortSignal` for its lifetime. Returned cleanup callbacks run on abort, even if the hook resolves after cancellation.
- An object returned from `initialize` is exposed as `exports` on the widget handle.
- Initialization times out after 10 seconds and never retries within the same mount.

Local model behavior:

- `model.get/set/on/off` operate locally; `change:key` callbacks take no arguments.
- Listeners are scoped to the initialization or view lifetime. Teardown removes them, and one view's `off()` cannot clear a sibling's listeners. Values stay shared across views.
- `save_changes()` is a no-op and never writes to the embedding product or a kernel.
- `send()` throws a descriptive no-backend error. `msg:custom` listeners may register, but no remote peer supplies messages.
- Removing or reloading an output, or changing its code, resets to initial state. Data changes handled by a listener do not (see [Data changes](#data-changes)).

### Buffers, child models, and styling constraints

- **Buffers**: `buffers` and `buffer_paths` follow Jupyter's parallel convention. `buffers` names assets; `buffer_paths` identifies object keys and numeric array indices in `state`, where the runtime restores `DataView`s. Parent containers and array slots must exist (null placeholders work); object leaves may be absent. Paths cannot overlap or traverse prototype keys. Modules read values via `model.get`; there is no `output.inputs` prop.
- **Child models**: optional `spec.models` maps child IDs to the same widget shape (without nested `models`). The root ID is `root`. A state value `"anywidget:slider"` references `models.slider`.
- **Child handles**: `host.getWidget(ref)` waits for initialization and returns `{ exports, render }`; `host.getModel(ref)` resolves its local model. Multiple views share the model and factory closure with separate view signals. Pass a signal to `handle.render({el, signal})` to end a view early; the resolving parent view's lifetime always applies too, even outside its DOM. Removing a connected view element aborts its signal.
- **Model errors and scope**: malformed or missing references reject; stalled initialization rejects. Local reference reassignment works for registered models. No registry spans iframe mounts or accesses another output's data.
- **CSS and imports**: CSS injects once per initialized model and is removed on disposal. `_esm` and `_css` traits hold the supplied source text. Relative ESM imports do not work in Blob modules; use bundled code or absolute HTTPS imports. Module/CSS updates require a new mount, not `model.set`.
- **Non-goals**: arbitrary ipywidget managers, Python callbacks, kernel comms, and custom Python serializers are not provided. Use standard AFM types and framework bridges; Pages theme helpers are optional extensions.

### Pages authoring, deployment, and security boundaries

- **Pages authoring format**: Pages authors use `application/vnd.nteract.anywidget.v2+json` with `module: {source_id, revision?}`, optional `stylesheet`, and paired `buffers: [{source: {source_id, revision?}, path: [...]}]` (child models use the same shape). This is a Pages format, not an upstream MIME type. See [the Pages spec](../../apps/pages/REFERENCE.md#anywidget-outputs).
- **Adapter boundary**: the Pages adapter validates and resolves references into the named-byte envelope above. This library has no source IDs, revision lookup, or authorization logic; AFM code sees the same model values. The authoring format version is independent of the frame path and port protocol.
- **Payload bounds**: `preparePayload` requires exact asset references, validates module/CSS media types, and limits assets to 5 MiB each and 32 MiB total. Pages also enforces spec-size and source authorization limits.
- **Separate deploys**: because the runtime travels with the page, only bootstrap changes require coordination. Add a new versioned frame path, keep serving the previous path for at least one release, and deploy the output host before the embedding app mounts the new path. Pages lists served paths in `apps/pages/shared/output-frame-paths.mjs`.
- **Security boundary**: the frame CSP permits external HTTPS modules, WASM, and broad network access, so output code can disclose every byte given to it. Isolation protects the host DOM and storage; it does not keep untrusted inputs confidential or prevent browser-wide denial of service. Keep credentials off the output domain and enforce CSRF protection on authenticated host endpoints.
- **Pages lifecycle**: the embedding product decides when a mount runs and authorizes every input. Pages renders automatically in its viewport lifecycle, remounts on code changes, delivers data changes via `setData` (remounting if unhandled), and shows a Retry button on failure.

## Module views

`mountModuleOutput(container, {kind: 'module', assets: {entry}, imports?}, {files})` mounts one entry module.
If it exports a named `render({model, el, signal, host})`, that function runs.
Otherwise, its default export runs as an AFM object or factory (like an anywidget view, but without an initialization timeout; the host's startup limit bounds slow top-level imports).
Both receive a local model with `model.get/set/on/off`, a no-op `save_changes()`, and a throwing `send()`.

### File inputs and `File` object API

`files` maps up to 16 `data/<alias>` names to embedder-supplied file providers:

```ts
{
  mimeType,
  byteLength,
  read(offset, length, signal),
  bytes(signal),
  columns?(format, signal), // format: "parquet" | "csv"
}
```

- `read` serves one byte range, `bytes` serves the whole file, and `columns` returns a validated `ColumnSet` for `"parquet"` or `"csv"`.
- `columns` rejects for unsupported formats; omit it when the file is not a table.
- Each `signal` aborts when the frame cancels the request or the mount ends.
- The library calls `bytes` (and `columns` per format) one request at a time per file and delivers each at most once per file.

At mount, the frame receives only `{mimeType, size, port}` per name until the view reads.
The model value for each alias and `import f from "data/<alias>"` expose the same file object (`src/file-object.mjs`), bound to the file mounted with the view:

- `name`, `mimeType`, `size`: known at mount.
- `arrayBuffer()`, `text()`, `json()`: read the whole file once per file object and share the result; `arrayBuffer()` returns a fresh copy each call.
- `parquet()`: returns an Arrow-style table (below). Rejects for non-Parquet files or any arguments (no options yet).
- `csv()`: parses any file as CSV on the embedder into an array of plain row objects with a `columns` array in file order (matching Observable's `FileAttachment.csv`), with typed values. Accepts no options, `{}` or `{typed: true}`, rejecting any other option by name, and rejects unparseable files.
- `slice(start, end)`: returns `{size, arrayBuffer(), text()}`, clamped like `Blob.slice`, backed by one range request.
- `byteLength` and `read(offset, length, signal)`: satisfy Sift's byte-source contract for `loadTableFile`.

`text()`, `json()`, `parquet()`, and `csv()` return the same promise while pending and after resolving; after rejection, the next call retries.
A failed read rejects that call with a plain message and never fails the mount.
Opening bound files before mount belongs to the embedder and can fail the mount (for example, a missing asset or mismatched media type in Pages).

### Byte-source protocol and whole-file caps

Each file has its own port (`src/byte-source.mjs`).
Requests carry `{kind: "range", offset, length}`, `{kind: "bytes"}`, or `{kind: "columns", format}` (`"parquet"` or `"csv"`), each with its own reply port.
Any message on that reply port cancels the request.
Replies carry `{bytes}`, `{columns}` (transferring typed arrays), or `{error}`.
Both ends validate every request, the frame validates every reply (including `ColumnSet`s), and every kind spends one read from the read budget.

Whole-file reads (`bytes` and `columns`) use per-share state (`wholeFileTransition` in `src/whole-file-total.mjs`):

- Each exposed file has one share for `bytes` and one per table format (`none`, `reading`, or `delivered`).
- A request starts only from `none`; concurrent or repeat requests fail with `{error}`, guaranteeing one in-flight read and at-most-once delivery.
- A failure or cancel (queued or in flight) resets `reading` to `none` so a retry can run. Replacing the file under that name drops its shares.
- A whole-file `bytes` read is capped at 5 MiB, and active `bytes` shares (reading or delivered) across live files stay within 32 MiB.
- `ColumnSet` reads do not count toward the 32 MiB byte total; the embedder's decode limits bound them.

### `ColumnSet` and table interface

A `ColumnSet` (`src/column-set.mjs`) is `{numRows, columns: [{name, type, values, nulls?}]}` (structured-cloneable, no class instances):

| `type` | `values` representation |
| --- | --- |
| `number` | `Float64Array` |
| `date` | `Float64Array` (epoch milliseconds) |
| `bigint` | `BigInt64Array` or `BigUint64Array` |
| `string`, `boolean`, `other` | plain JavaScript array |

- `nulls` is an optional `Uint8Array` validity mask (`1` = present), omitted when a column has no nulls.
- `checkColumnSet` verifies lengths, types, value kinds, and at most 256 columns with unique names of 1 to 256 characters.
- The embedder validates a `ColumnSet` once at decode (Pages does this in `parquetColumns` and `csvColumns` before caching). The host copies it to each frame without re-checking, and each frame validates its copy.

The table wrapper (`src/table.mjs`) matches Apache Arrow JS naming:

- **Table**: `numRows`, `numCols`, `schema.fields`, `getChild(name)`, `getChildAt(index)`, `get(index)`, `toArray()`, `select(names)`, and row iteration.
- **Column**: `length`, `nullCount`, `type`, `get(index)`, `toArray()`, `toJSON()`, and iteration.
- **Values**: plain JavaScript values (`Date` for `date`, `null` for missing, mutable plain objects for rows). Nothing else is part of the interface; see the Pages reference for Arrow JS differences.

## Data changes

`handle.setData(name, value)` pushes a new data input to a mounted view.
`name` must be declared at mount: a `data/<alias>` on a module view, or an anywidget buffer name that is not also a module or stylesheet name (any other name throws).
Module views take a file input; anywidget buffers take a `Uint8Array`.

The parent sends `{type: 'data', name, input}` on the mount port, where `input` is `{bytes}` (a transferred dedicated copy) for an anywidget buffer or `{mimeType, size, port}` (a new port) for a module file.
The message carries only names, data, and ports; the frame ignores undeclared names.

- **Ordering**: the host sends data only after `ready`. Earlier changes coalesce (latest per name) and flush in order at `ready`. Failed or disposed mounts drop them (`dataTransition` in `src/lifecycle.mjs`).
- **Port replacement**: replacing a file closes its old port, dropping queued reads and aborting in-flight ones. Pending and future calls on the old file object reject as aborted. The new port shares the same read budget.
- **Frame updates**: for a module view, the model key gets a new file object and emits `change:<alias>`. For an anywidget buffer, each model key holding a bound path gets a copy with a new `DataView` at that path and emits `change:<key>` once (other local values under that key remain).
- **Listener gating**: the frame applies a change only if at least one affected key has a `change:<key>` listener (listen with `model.on("change:<alias>", …)` to update in place). If none listens, it skips the update and replies `{type: 'unhandled-data', name}`. If any affected key listens, all affected keys update (`dataDecision` and `receiveDataChange` in `src/data.mjs`).
- **Host callback**: the host invokes `onUnhandledData(name)` only in `ready`, only for a declared name, and at most once per sent data message (`answerTransition` in `src/lifecycle.mjs`). Unsolicited or duplicate replies are ignored; applied changes send no ack.
- **Remount requirement**: after `onUnhandledData`, the embedder must remount the view because the old file port is already closed. Pages remounts from its newest inputs whenever a view does not listen.
- **Local writes**: `model.set` on a data key stays local, like any other key.

## Read budget

A module view can bind up to 16 files, and each `read(offset, length)` triggers an embedder request (often an authorized range request).
One shared read budget per mount bounds that load (`src/read-budget.mjs`):

- At most 8 reads are in flight at once across the view.
- Each read spends 1 token. The view starts with 256 tokens and refills at 32 per second, up to 256.
- Reads exceeding either limit wait in FIFO order across files.
- At most 256 reads can wait. A read hitting a full queue rejects with `Too many file reads are waiting.`

Reads with invalid intervals reject immediately with `Invalid file read.` without waiting.
Aborting a waiting read's signal removes it without spending a token or reaching the source.
Disposing the mount drops all waiting reads without a reply.

## Relationship to notebook outputs

`src/components/isolated/output-embed.ts` already provides a host-independent notebook embed.
Its renderer registry, MIME bundles, JSON-RPC widget bridge, CommsDoc synchronization, and Tauri shell adapter stay notebook-owned.
This package does not replace those contracts or claim full ipywidgets support.

Both systems use opaque-origin frames and transferable binary data, but this package offers a smaller immutable ESM session without React, notebook stores, or a kernel.
A notebook adapter can use it for this profile.
Moving the full notebook renderer requires explicitly preserving its comm and renderer-plugin protocols, platform shell selection, and broader sandbox permissions.
The deployed notebook output host is unchanged.

Pages installs this local package with npm's `install-links=true`.
After editing package source, refresh the installed copy before running Pages builds or tests.

## Validation and example

From `apps/pages`, run `node scripts/output-smoke.mjs` for deterministic browser boundary tests (using synthetic default data).

| Environment variable | Effect |
| --- | --- |
| `PAGES_OUTPUT_BROWSER=webkit` | Run the boundary checks in WebKit |
| `PAGES_OUTPUT_CDN=1` | Also load the audio example's real HTTPS Parquet/WASM dependencies |
| `PAGES_OUTPUT_ARTIFACT` | Path to a native Inkling `c4-native-dmel.json` export (pair with `PAGES_OUTPUT_WAV`) |
| `PAGES_OUTPUT_WAV` | Path to the recording paired with `PAGES_OUTPUT_ARTIFACT` |
| `PAGES_OUTPUT_LIVE=1` | Test against the deployed output host bootstrap instead of intercepting with the local Worker |

When `PAGES_OUTPUT_ARTIFACT` and `PAGES_OUTPUT_WAV` are set, the harness verifies both recorded SHA-256 values, converts the native matrix to Parquet, and saves wide/narrow screenshots in ignored `test-results/output-real`.
It does not rerun the model or publish research files.

## Theme and shared controls

### Document layout

- The frame document starts borderless with no body inset.
- Normal-flow content (including margins and floats) sets the iframe height, which grows and shrinks with content. The host rounds heights up and bounds them to 1 to 100,000 CSS pixels.
- The iframe document never scrolls vertically; the parent Page owns vertical scroll. This prevents scrollbar width from feeding back into responsive chart height.
- Do not use viewport-relative heights on the output root because the viewport follows content height (the 100,000px cap is only a safety limit).
- Horizontal overflow is clipped at the document boundary so a near miss beside a slider cannot pan the output sideways.
- Range controls fill available width, have 44px touch targets, and reserve horizontal gestures for adjustment while allowing vertical scroll and pinch zoom.
- Buttons have a 44px minimum height. Ordinary content keeps native page scrolling and pinch zoom.

Wrap intentionally scrollable content in `.output-scroll`.
Give vertical regions a height or `max-height`, plus `tabindex="0"`, an appropriate role, and an accessible label:

```html
<div class="output-scroll" role="region" aria-label="Detailed results" tabindex="0"
     style="max-height:24rem">
  <!-- A wide table or another intentionally scrollable view. -->
</div>
```

These are shared defaults, not a CSS sandbox; modules can override them.
`.output-surface` is an opt-in padded card.
Chart sizing and interaction belong to the module; iframe sizing and native control fixes belong here.

### Host context

Pass `hostContext: { theme: 'light' | 'dark', styles: { variables } }` at mount.
The host resolves `system` itself; the wire never accepts `system`.
`readHostContext(element, resolvedTheme)` snapshots public semantic CSS tokens from the embedding surface.
Call `handle.setHostContext(next)` when the resolved theme or palette changes.
This matches the notebook embed's `theme`/`styles.variables` shape with a bounded token vocabulary; notebook-specific palette aliases remain in its adapter.

Context lifecycle and styling:

- The frame applies context before importing the module, sets `.light`/`.dark`, `data-theme`, and `color-scheme`, and stays hidden until themed rendering is ready.
- Later updates change presentation without reinitializing the model, retransferring data, or resetting playback.
- Pages subscribes to its theme store so both explicit choices and OS changes in system mode propagate.
- The runtime includes `@nteract/output-frame/styles.css` with semantic tokens, typography, focus rings, native form controls, buttons (`data-variant="secondary"`), `.output-surface`, `.output-muted`, and `.output-stack`.
- Use plain HTML with these defaults (no React or CSS compiler needed), or reference the variables from custom CSS or compiled Tailwind. This is a base stylesheet, not React/Radix shadcn behavior or a runtime Tailwind compiler.

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

`host.getContext()` returns an immutable snapshot.
`host.onContextChange(fn)` returns an unsubscribe function and fires after CSS updates.
Canvas or WebGL authors can redraw in that callback, while CSS-based components update directly.
View disposal clears subscriptions automatically.
These context helpers extend AFM alongside its composition methods.

For a persistent original-data demo, set `PAGES_OUTPUT_SERVE=1` alongside the CDN, artifact, and WAV options above (with optional `PAGES_OUTPUT_PORT`).
The demo includes a Light/Dark/System selector and uses the deployed output host.
