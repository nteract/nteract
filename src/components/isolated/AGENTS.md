# Isolated output frame — security model and renderers

Untrusted cell outputs render inside a sandboxed iframe. Tauri loads the iframe from the `nteract-frame` custom URI scheme so the iframe receives its own CSP. The sandbox attribute list, without `allow-same-origin`, is the load-bearing isolation against parent DOM, storage, and Tauri IPC access. The plain browser dev host uses `srcDoc` with the same sandbox-induced opaque origin behavior.

Scope: `src/components/isolated/**`, `src/isolated-renderer/**`.

## Security model

### Sandbox allowlist

Keep the sandbox to exactly these flags:

```
allow-scripts allow-downloads allow-forms allow-pointer-lock
```

Fullscreen (sift maximize, maps, 3D) comes from the iframe `allow="fullscreen *"` Permissions Policy attribute, not a sandbox token. `allow-same-origin` stays off — adding it would give cell output access to `window.__TAURI__`, all Tauri APIs, parent DOM, localStorage, and cookies. A CI test in `src/components/isolated/__tests__/isolated-frame.test.ts` asserts the list stays clean; it's the single most important security invariant in this tree. `allow-popups` and `allow-modals` were removed to shrink the phishing surface — leave them out.

### Custom URI scheme + sandbox-induced opaque origin

In Tauri, mount the frame at `nteract-frame://localhost/`. On Windows, Tauri/wry rewrites this to `http://nteract-frame.localhost/` while still routing through the same scheme handler. Do not string-compare iframe URLs across platforms; parse the URL and account for the platform-specific origin shape.

All `nteract-frame://` iframes share one scheme origin. The custom scheme exists so the iframe gets its own CSP; it is not the isolation boundary. The sandbox attribute creates the opaque origin (shown as `"null"`) and is the only inter-iframe isolation. Render-time tests enforce that `allow-same-origin` stays absent.

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

`http://127.0.0.1:*` in `script-src`/`style-src` is deliberate: anywidget ESM (`_esm`) and CSS (`_css`) are served from the daemon's blob-store HTTP server on a dynamic localhost port. Without that entry the browser rejects `import()` of blob-served JS with a MIME-type violation. It's safe because the sandbox still lacks `allow-same-origin`, and the blob server is read-only and content-addressed. `https:` covers CDN-hosted widget assets (anywidget ESM from unpkg/jsdelivr).

Canonical file: `src/components/isolated/frame.html`. Rust embeds that file with `include_str!()` for the Tauri scheme response; TypeScript imports the same file as raw text for `generateFrameHtml()` / browser `srcDoc`.

The scheme handler is registered in both packaged and Tauri dev shells. Plain browser-only `pnpm dev` still uses `srcDoc`, but `cargo xtask notebook` / Tauri dev can load `nteract-frame://localhost/`.

Future hosted/web production should not treat `srcDoc` as the equivalent security boundary. A remote deployment with real auth and attribution should serve output documents from a separate output origin that does not share cookie scope, localStorage, or ambient credentials with the authenticated app origin. Keep those output iframes sandboxed without `allow-same-origin`; give the output origin its own permissive CSP; use explicit `postMessage` with origin/session validation; scope output URLs by signed, short-lived capability/session tokens; and keep attribution/audit data server-side instead of exposing identifiers to output JavaScript.

### Source validation

The iframe's message handler rejects anything whose `event.source !== window.parent`. Keep that check in place — it prevents other windows/iframes from spoofing messages.

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
│  window.__TAURI__         → undefined                        │
│  window.parent.document   → cross-origin error               │
│  localStorage             → cross-origin error               │
└──────────────────────────────────────────────────────────────┘
```

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
