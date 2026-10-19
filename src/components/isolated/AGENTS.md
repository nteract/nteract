# Isolated output frame — security model and renderers

Outputs that require isolation render inside a sandboxed iframe. Tauri loads the iframe from the `nteract-frame` custom URI scheme so the iframe receives its own CSP. Omitting `allow-same-origin` prevents direct same-origin DOM and storage access to the parent and other frames. Host adapters must keep privileged native bridges out of output frames. The plain browser dev host uses `srcDoc` with the same sandbox-induced opaque origin behavior. See [output frame security](../../../docs/adr/output-frame-security.md) for the current implementation and its limits.

Scope: `src/components/isolated/**`, `src/isolated-renderer/**`.

Structured Markdown projections can render in the host when
`canRenderMarkdownProjectionInHost` admits them; raw HTML still requires the
sandbox. This includes Mermaid diagrams in cells, outputs, and comments. Their
generated SVG must pass through `mermaid-renderer.ts`'s DOMPurify and CSS admission
policy before insertion, with links and images disabled. Do not substitute raw
SVG insertion or treat the source as trusted. Browser coverage for this host
boundary lives alongside the sandboxed renderer tests in `apps/renderer-test`.

## Security model

### Sandbox allowlist

Keep the sandbox to exactly these flags:

```
allow-scripts allow-downloads allow-forms allow-pointer-lock
```

Fullscreen (sift maximize, maps, 3D) comes from the iframe `allow="fullscreen *"` Permissions Policy attribute, not a sandbox token. `allow-same-origin` stays off: adding it restores the document URL's origin, or the inherited parent origin for `srcDoc`, rather than always giving the frame the parent's origin. A CI test in `src/components/isolated/__tests__/isolated-frame.test.ts` asserts the sandbox list. Leave `allow-popups` and `allow-modals` out.

### Custom URI scheme + sandbox-induced opaque origin

In Tauri, mount the frame at `nteract-frame://localhost/`. On Windows, Tauri/wry rewrites this to `http://nteract-frame.localhost/` while still routing through the same scheme handler. Do not string-compare iframe URLs across platforms; parse the URL and account for the platform-specific origin shape.

Frames loaded from the same `nteract-frame://localhost/` URL share a URL origin. The custom scheme permits a separate CSP; the sandbox creates each frame's opaque effective origin (serialized as `"null"`). Multiple output items can share a frame and are not isolated from each other. Render-time tests enforce that `allow-same-origin` stays absent.

### Content Security Policy

The generated iframe HTML ships a `<meta>` CSP as defense-in-depth:

```
default-src 'self' blob: data:;
script-src  'unsafe-inline' 'unsafe-eval' blob: https: http://127.0.0.1:*;
style-src   'unsafe-inline' https: http://127.0.0.1:*;
img-src     * data: blob:;
font-src    * data:;
media-src   * data: blob:;
object-src  * data: blob:;
connect-src *;
worker-src  'self' blob:;
frame-src   'none';
child-src   'none';
```

`http://127.0.0.1:*` in `script-src`/`style-src` permits anywidget ESM (`_esm`) and CSS (`_css`) from the daemon's blob HTTP server on a dynamic port. `https:` permits CDN-hosted widget assets. These entries allow asset loading; they do not establish confidentiality of the unauthenticated blob service. `connect-src *` and broad resource policies permit network activity subject to browser and destination policy. The sandbox allows forms and downloads; an opaque origin does not ensure credential-free requests in every browser.

Canonical file: `src/components/isolated/frame.html`. Rust embeds that file with `include_str!()` for the Tauri scheme response; TypeScript imports the same file as raw text for `generateFrameHtml()` / browser `srcDoc`.

The scheme handler is registered in both packaged and Tauri dev shells. Plain browser-only `pnpm dev` still uses `srcDoc`, but `cargo xtask notebook` / Tauri dev can load `nteract-frame://localhost/`.

The Draft [hosted output origin ADR](../../../docs/adr/hosted-output-origin-isolation.md) describes separate-origin, credential-segregation, and scoped-capability requirements for hosted deployments. These are not general enforcement in the current local HTTP service. A separate output origin complements the sandbox. `srcDoc` inherits the parent's policy context; its effective origin remains opaque under the current sandbox.

### Source validation

The iframe's message handler rejects anything whose `event.source !== window.parent`. Keep that check: it binds messages to the immediate parent WindowProxy, not an authenticated app, vendor, or user. Any page creating its own frame is that frame's parent. The shell has no origin allowlist, authenticated token, or channel nonce. Parent receive paths bind to the expected iframe window and check protocol shape. Comm bridges delegate widget state and supported actions; data sent to output code is exposed to it.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      PARENT WINDOW                           │
│  Kernel ↔ WidgetStore ↔ CommBridgeManager ↔ IsolatedFrame   │
│                                  │ postMessage               │
└──────────────────────────────────┼───────────────────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│           ISOLATED IFRAME (nteract-frame://)                 │
│  WidgetBridgeClient ↔ WidgetStore ↔ WidgetView/AnyWidget    │
│                                                              │
│  window.parent.document   → cross-origin error               │
│  localStorage             → cross-origin error               │
└──────────────────────────────────────────────────────────────┘
```

The shell supplies no native or kernel control endpoint. Native bridge exposure
depends on each host's script injection and IPC policy, not just the iframe
sandbox. Check it on every supported platform.

The core renderer bundle is built inline by `apps/notebook/vite-plugin-isolated-renderer.ts` and supplied through `IsolatedRendererProvider` (read via `useIsolatedRenderer()`). No HTTP fetch, no separate build step.

## Renderer plugins

Heavy renderers (markdown, plotly, bokeh, panel, vega, leaflet, sift) are **not** in the core IIFE. They're on-demand CJS modules loaded via `frame.installRenderer()` only when their MIME types appear.

```
┌──────────────────────────────┐     ┌──────────────────────────┐
│  Parent (iframe-libraries)   │     │  Iframe (core renderer)  │
│  1. Scan output MIMEs        │     │  RendererRegistry (Map)  │
│  2. loadPlugin("vega")       │     │    + pattern matchers    │
│     → import("virtual:       │     │  installRendererPlugin() │
│        renderer-plugin/vega")│──▶ │    new Function(code)    │
│  3. frame.installRenderer(   │     │    mod.exports.install({ │
│       code, css)             │     │      register,           │
│                              │     │      registerPattern     │
│                              │     │    })                    │
└──────────────────────────────┘     └──────────────────────────┘
```

- `OutputArea` and the raw-frame prewarm path scan output MIME types with `needsPlugin()` from `src/components/isolated/iframe-libraries.ts`.
- Matching plugins lazy-load from their own Vite virtual module (`virtual:renderer-plugin/{name}`).
- Parent sends `nteract/installRenderer` with plugin code + CSS.
- Iframe runs `new Function("module", "exports", "require", code)` with a `require` shim that injects the shared React instance.
- Plugin `install(ctx)` registers components for its MIME types.
- `OutputRenderer` checks the registry before falling back to built-ins.

**React sharing:** plugins declare `react` and `react/jsx-runtime` as external; the iframe's `require` shim maps them to the React already loaded in the core bundle.

**Code splitting:** each plugin has its own virtual module, so a markdown-only notebook never pulls the 4.8 MB plotly chunk.

### Adding a plugin

1. Create `src/isolated-renderer/{name}-renderer.tsx` with a React component and an `install(ctx)` function:

```typescript
interface RendererProps {
  data: unknown;
  metadata?: Record<string, unknown>;
  mimeType: string;
}

function MyRenderer({ data }: RendererProps) { /* … */ }

export function install(ctx: {
  register: (mimeTypes: string[], component: React.ComponentType<RendererProps>) => void;
  registerPattern: (test: (mime: string) => boolean, component: React.ComponentType<RendererProps>) => void;
}) {
  ctx.register(["application/x-my-type"], MyRenderer);
  // or: ctx.registerPattern((m) => /^application\/vnd\.mylib\.v\d/.test(m), MyRenderer);
}
```

2. Extend `apps/notebook/vite-plugin-isolated-renderer.ts`: add the entry path, code/css variables, `invalidateCache()` entry, the `buildRendererPlugin()` call, and a `load()` case for the virtual module.
3. Declare the virtual module in `apps/notebook/src/vite-env.d.ts` (e.g., `declare module "virtual:renderer-plugin/bokeh" { ... }`).
4. In `src/components/isolated/renderer-plugin-info.ts`, add the MIME → plugin mapping. The plugin loader registration lives in `iframe-libraries.ts` with imports from the virtual modules.
5. Remove the component from `src/isolated-renderer/index.tsx` so it no longer ships in the core bundle.

## Message protocol

Two layers coexist:

1. **Frame bootstrap/render** in `frame-bridge.ts` — `eval`, `render`, `theme`, `clear`, `resize`, `link_click`, search flow.
2. **Widget sync** — JSON-RPC 2.0 over `postMessage`, wired by `jsonrpc-transport.ts` and `rpc-methods.ts`.

JSON-RPC widget methods:

- Parent → iframe: `nteract/bridgeReady`, `nteract/commOpen`, `nteract/commMsg`, `nteract/commClose`, `nteract/widgetSnapshot`
- Iframe → parent: `nteract/widgetReady`, `nteract/widgetCommMsg`, `nteract/widgetCommClose`

JSON-RPC Bokeh session methods (`docs/adr/bokeh-session-documents.md`), each checked against the frame's own output bindings:

- Iframe → parent requests: `nteract/bokehSessionOpen`, `nteract/bokehSetProps` (property values only), `nteract/bokehApplyPatch` (`MessageSent`, `ColumnsStreamed`, `ColumnsPatched` only), `nteract/bokehSessionData` (column blobs plus the retained tail)
- Parent → iframe notifications: `nteract/bokehSessionState`, `nteract/bokehSessionDoc` (full or delta update from the session document), `nteract/bokehSessionEvents` (data events and Python messages)

### Widget sync flow

```
1. IsolatedFrame mounts
2. Iframe → ready
3. Parent → eval (React bundle)
4. Iframe → renderer_ready
5. CommBridgeManager → nteract/bridgeReady
6. Iframe → nteract/widgetReady
7. CommBridgeManager → nteract/widgetSnapshot (all existing models)
8. Iframe renders widgets
9. Bidirectional updates flow through JSON-RPC notifications
```

## Security-sensitive code paths

Review these carefully on every change:

1. **Sandbox configuration** — `isolated-frame.tsx` / `SANDBOX_ATTRS`.
2. **Source validation** — `frame.html` / `event.source !== window.parent`.
3. **Custom message forwarding** — `comm-bridge-manager.ts` / `subscribeToModelCustomMessages` (required for anywidgets like quak).
4. **Type-guard whitelist** — `frame-bridge.ts` / `isIframeMessage` for legacy frame-bridge types; JSON-RPC methods live in `rpc-methods.ts`.

## Review checklist

- Sandbox still excludes `allow-same-origin`.
- Iframe CSP keeps `frame-src 'none'` and `child-src 'none'`.
- CSP `script-src` / `style-src` stay scoped to `127.0.0.1:*` and `https:` — no new origins.
- Source validation is intact (`event.source !== window.parent`).
- Any new message types are added to the whitelist (`frame-bridge.ts`) and the JSON-RPC method list.
- Unit tests updated; `pnpm test:run` green.

## Testing

Unit tests assert the security invariants:

```bash
pnpm test:run
```

The suite verifies the sandbox excludes `allow-same-origin`, the message type guards validate correctly, and the HTML includes the source-validation check.

Manual smoke test: open `crates/notebook/fixtures/audit-test/1-vanilla.ipynb`, add a JS output, confirm `window.__TAURI__` is `undefined`, parent DOM access throws cross-origin, and `localStorage` throws cross-origin. In debug builds `Cmd+Shift+I` opens the isolation test panel.

## Troubleshooting

**Widget not rendering.** Inspect the iframe in devtools. Confirm the `nteract/widgetSnapshot` / `nteract/widgetReady` handshake completed. If the bridge changed recently, check `jsonrpc-transport.ts` and `rpc-methods.ts`.

**Widget not receiving updates.** Check that `subscribeToModelCustomMessages` is firing and that kernel comm traffic is being translated into `nteract/commMsg` notifications with the correct `commId`.

**Theme not syncing.** Confirm the `theme` message fires on mode change, the root element sets `color-scheme`, and widgets relying on `@media (prefers-color-scheme)` see the updated value.
