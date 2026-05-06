# Isolated output frame — security model and renderers

Untrusted cell outputs render inside a sandboxed iframe loaded from a `blob:` URL. The iframe's opaque origin prevents Tauri IPC injection, and the sandbox attribute list is the primary defense against malicious JavaScript in outputs.

Scope: `src/components/isolated/**`, `src/isolated-renderer/**`.

## Security model

### Sandbox allowlist

Keep the sandbox to exactly these flags:

```
allow-scripts allow-downloads allow-forms allow-pointer-lock
```

Fullscreen (sift maximize, maps, 3D) comes from the separate `allowFullScreen` iframe attribute, not a sandbox token. `allow-same-origin` stays off — adding it would give cell output access to `window.__TAURI__`, all Tauri APIs, parent DOM, localStorage, and cookies. A CI test in `src/components/isolated/__tests__/isolated-frame.test.ts` asserts the list stays clean; it's the single most important security invariant in this tree. `allow-popups` and `allow-modals` were removed to shrink the phishing surface — leave them out.

### Blob URL origin

Generate HTML with `generateFrameHtml({ darkMode })`, wrap it in a `Blob`, and mount with `URL.createObjectURL`. Blob URLs produce a unique opaque origin (shown as `"null"`), so Tauri's IPC bridge doesn't inject into the iframe.

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
```

`http://127.0.0.1:*` in `script-src`/`style-src` is deliberate: anywidget ESM (`_esm`) and CSS (`_css`) are served from the daemon's blob-store HTTP server on a dynamic localhost port. Without that entry the browser rejects `import()` of blob-served JS with a MIME-type violation. It's safe because the sandbox still lacks `allow-same-origin`, and the blob server is read-only and content-addressed. `https:` covers CDN-hosted widget assets (anywidget ESM from unpkg/jsdelivr).

Canonical file: `src/components/isolated/frame-html.ts` → `generateFrameHtml()`.

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
│                 ISOLATED IFRAME (blob:)                      │
│  WidgetBridgeClient ↔ WidgetStore ↔ WidgetView/AnyWidget    │
│                                                              │
│  window.__TAURI__         → undefined                        │
│  window.parent.document   → cross-origin error               │
│  localStorage             → cross-origin error               │
└──────────────────────────────────────────────────────────────┘
```

### Key components

| Component | Location | Purpose |
|-----------|----------|---------|
| `IsolatedFrame` | `src/components/isolated/isolated-frame.tsx` | Manages blob URL lifecycle, exposes `installRenderer()` |
| `CommBridgeManager` | `src/components/isolated/comm-bridge-manager.ts` | Parent-side widget state sync |
| `jsonrpc-transport.ts` | `src/components/isolated/jsonrpc-transport.ts` | JSON-RPC 2.0 transport over `postMessage` |
| `rpc-methods.ts` | `src/components/isolated/rpc-methods.ts` | Shared widget-bridge method constants |
| `WidgetBridgeClient` | `src/isolated-renderer/widget-bridge-client.ts` | Iframe-side widget bridge (`createWidgetBridgeClient`) |
| `frame-html.ts` | `src/components/isolated/frame-html.ts` | Bootstrap HTML generator |
| `frame-bridge.ts` | `src/components/isolated/frame-bridge.ts` | Legacy frame-message types and guards |

The core renderer bundle is built inline by `apps/notebook/vite-plugin-isolated-renderer.ts` and supplied through `IsolatedRendererProvider` (read via `useIsolatedRenderer()`). No HTTP fetch, no separate build step.

## Renderer plugins

Heavy renderers (markdown, plotly, vega, leaflet) are **not** in the core IIFE. They're on-demand CJS modules loaded via `frame.installRenderer()` only when their MIME types appear.

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

- `OutputArea` scans each output's MIME types via `getRequiredLibraries()`.
- Matching plugins lazy-load from their own Vite virtual module (`virtual:renderer-plugin/{name}`).
- Parent sends `nteract/installRenderer` with plugin code + CSS.
- Iframe runs `new Function("module", "exports", "require", code)` with a `require` shim that injects the shared React instance.
- Plugin `install(ctx)` registers components for its MIME types.
- `OutputRenderer` checks the registry before falling back to built-ins.

**React sharing:** plugins declare `react` and `react/jsx-runtime` as external; the iframe's `require` shim maps them to the React already loaded in the core bundle.

**Code splitting:** each plugin has its own virtual module, so a markdown-only notebook never pulls the 4.8 MB plotly chunk.

### Current plugins

| Plugin | MIME | Virtual module | Size |
|--------|------|----------------|------|
| Markdown | `text/markdown` | `virtual:renderer-plugin/markdown` | ~2.2 MB |
| Vega | `application/vnd.vega*.v*` | `virtual:renderer-plugin/vega` | ~865 KB |
| Plotly | `application/vnd.plotly.v1+json` | `virtual:renderer-plugin/plotly` | ~4.8 MB |
| Leaflet | `application/geo+json` | `virtual:renderer-plugin/leaflet` | ~194 KB |

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
3. Declare the virtual module in `apps/notebook/src/vite-env.d.ts`.
4. In `src/components/isolated/iframe-libraries.ts`, add the MIME → plugin entry to `PLUGIN_MIME_TYPES` and the import case in `loadPluginForMime()`.
5. Remove the component from `src/isolated-renderer/index.tsx` so it no longer ships in the core bundle.

### Key files

| File | Role |
|------|------|
| `src/isolated-renderer/index.tsx` | Core renderer + plugin registry + CJS loader |
| `src/isolated-renderer/*-renderer.tsx` | Plugin entry points |
| `apps/notebook/vite-plugin-isolated-renderer.ts` | Builds core IIFE + plugins |
| `src/components/isolated/iframe-libraries.ts` | MIME detection, plugin loading |
| `src/components/isolated/frame-bridge.ts` | `InstallRendererMessage` type |
| `src/components/isolated/rpc-methods.ts` | `NTERACT_INSTALL_RENDERER` constant |
| `src/components/isolated/isolated-frame.tsx` | `installRenderer()` on `IsolatedFrameHandle` |

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
2. **Source validation** — `frame-html.ts` / `event.source !== window.parent`.
3. **Custom message forwarding** — `comm-bridge-manager.ts` / `subscribeToModelCustomMessages` (required for anywidgets like quak).
4. **Type-guard whitelist** — `frame-bridge.ts` / `isIframeMessage` for legacy frame-bridge types; JSON-RPC methods live in `rpc-methods.ts`.

## Review checklist

- Sandbox still excludes `allow-same-origin`.
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
