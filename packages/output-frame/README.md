# @nteract/output-frame

A browser host and isolated runtime for a small anywidget-compatible ESM profile.
Pages is the first consumer. This package owns the frame lifecycle and byte
transport; the embedding product owns authorization, source selection, revisions,
and the decision to execute code.

```js
import { mountEsmOutput } from '@nteract/output-frame';
const output = mountEsmOutput(element, {
  module: { bytes: moduleBytes, mediaType: 'text/javascript' },
  inputs: { recording: { bytes: wavBytes, mediaType: 'audio/wav' } },
  state: { time: 0 },
}, {
  frameUrl: 'https://pages.kilousercontent.com/frame/v1/',
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

The default ESM export is an object (or a factory returning one) with `render`
and optional `initialize`. Both may be async and return cleanup functions. They
receive an AbortSignal. `model.get/set/on/off` provide session-local values and
`change:key` notifications; binary input values are DataViews. `save_changes`
has no persistence effect and `send` explicitly rejects runtime messaging.
`render` additionally receives `el`, a `host` whose composition methods reject,
and `output.inputs` with media types and byte views. Relative module imports,
CSS traits, nested models, kernel comms, and durable widget state are not part of
this first profile. Use absolute HTTPS imports or self-contained ESM.

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
boundary tests. `PAGES_OUTPUT_CDN=1` also loads the audio example's real HTTPS
Parquet/WASM dependencies. Its default data is deliberately synthetic.

For a native Inkling export, additionally set `PAGES_OUTPUT_ARTIFACT` to the
`c4-native-dmel.json` file and `PAGES_OUTPUT_WAV` to its original recording.
The harness verifies both recorded SHA-256 values, converts the native matrix to
Parquet, and saves wide/narrow screenshots in ignored `test-results/output-real`.
It does not rerun the model or publish the research files. Set
`PAGES_OUTPUT_LIVE=1` to exercise the deployed frame shell instead of intercepting
that request with the locally built Worker response.

## Theme and shared controls

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
