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
  frameUrl: 'https://pages.kilousercontent.com/frame/v2/',
  hostContext: { theme: 'light' },
});
// Changes to code or inputs create a new mount.
output.destroy();
```

Bundle the `@nteract/output-frame/runtime` entry into a shell containing `<main>`.
The shell must be served from a separate HTTPS origin. Pages' credential-free
Worker in `apps/pages/output` is one deployment adapter. The library contains no
Pages API routes, source IDs, authentication, or Cloudflare dependencies.

The host creates an opaque-origin `sandbox="allow-scripts"` iframe. A versioned,
nonce-bound handshake transfers a MessagePort to that exact iframe WindowProxy;
the runtime accepts it only from its immediate parent. This is channel binding,
not authentication of a parent application. The shell can be embedded by anyone.
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
an output or changing its inputs resets it to the supplied initial state.

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

The Pages envelope has media type `application/vnd.nteract.anywidget.v1+json`.
This is a versioned asset-binding envelope for AFM, not a claimed upstream MIME
standard. See [the Pages spec](../../apps/pages/REFERENCE.md#anywidget-outputs)
for named-source authoring. `preparePayload` requires exactly the referenced
assets, checks module/CSS media types, and bounds assets to 5 MiB each / 32 MiB
total. Pages additionally enforces its spec-size and source authorization limits.

The HTTP shell policy allows external HTTPS modules, WASM, and broad network
access. Output code can disclose every byte supplied to it. Isolation protects
the host DOM and storage; it does not make untrusted code confidential or a
browser-wide denial-of-service sandbox. Keep credentials off the output domain
and enforce CSRF protections on authenticated host endpoints. The embedding product decides when a mount runs and authorizes every input.
Pages renders automatically within its viewport lifecycle and remounts when the
module or bound inputs change; failures expose a Retry button.

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
`PAGES_OUTPUT_LIVE=1` to exercise the deployed frame shell instead of intercepting
that request with the locally built Worker response.

## Theme and shared controls

### Document layout

The shell starts borderless, with no body inset. Its normal-flow content determines
the iframe height, including margins and floats; it grows and shrinks as content
changes. Heights are rounded up and bounded to 1–100,000 CSS pixels by the host.
This high safety limit is not intended as a widget viewport. Avoid viewport-relative
heights on the output root: the viewport itself follows the content height.

Horizontal overflow is clipped at the document boundary, so a near miss beside a
slider cannot pan the entire output sideways. Range controls fill their available
width, have 44px touch targets, and reserve horizontal gestures for adjustment
while allowing vertical scrolling and pinch zoom.
Buttons also have a 44px minimum height. Ordinary content keeps native page scrolling
and pinch zoom; the shell does not disable those gestures on an ancestor.

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

The shell includes `@nteract/output-frame/styles.css`: semantic tokens, typography,
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
The context helpers are extensions alongside AFM's composition methods.

For a persistent original-data demo, set `PAGES_OUTPUT_SERVE=1` alongside the CDN,
artifact and WAV options above. `PAGES_OUTPUT_PORT` optionally chooses a local
port. The demo has a Light/Dark/System selector and uses the deployed shell.
