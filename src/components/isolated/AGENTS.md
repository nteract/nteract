# Isolated output frame — security model and renderers

Untrusted cell outputs render inside a sandboxed iframe. **The sandbox attribute (without `allow-same-origin`) is what keeps the document at an opaque origin** — that's the load-bearing isolation against parent-DOM access, Tauri-IPC reach, and inter-iframe DOM scripting. The custom `nteract-frame://` URI scheme exists for a different reason: per CSP3 §init-document-csp, `blob:` documents inherit the creator's CSP, so loading the iframe from a real URL scheme lets the iframe document take its CSP from the response header instead of inheriting the parent's strict policy.

Scope: `src/components/isolated/**`, `src/isolated-renderer/**`.

## Security model

### Sandbox allowlist

Keep the sandbox to exactly these flags:

```
allow-scripts allow-downloads allow-forms allow-pointer-lock
```

Fullscreen (sift maximize, maps, 3D) comes from the separate `allowFullScreen` iframe attribute, not a sandbox token. `allow-same-origin` stays off — adding it would give cell output access to `window.__TAURI__`, all Tauri APIs, parent DOM, localStorage, and cookies. With every iframe sharing the same `nteract-frame://` scheme origin, sandbox-without-`allow-same-origin` is also the only inter-iframe isolation: drop the flag and any cell output can DOM-script every other cell-output iframe in the window. Two CI guards pin this: a string-constant test in `__tests__/isolated-frame.test.ts` and a render-time test in `__tests__/isolated-frame-sandbox.test.tsx` that queries the live iframe DOM. `allow-popups` and `allow-modals` were removed to shrink the phishing surface — leave them out.

### Custom URI scheme

Iframes load from `nteract-frame://localhost/` (Tauri, macOS/Linux/iOS). On Windows + WebView2, Tauri/wry rewrites this to `http://nteract-frame.localhost/`; both forms are in `tauri.conf.json` `frame-src`/`child-src`. The plain-browser dev host (Vite at `localhost:5174`, no Tauri) uses `srcDoc` because Chrome rejects sandboxed `blob:` navigations from localhost; the same opaque-origin guarantee applies via sandbox alone.

The Tauri scheme handler in `crates/notebook/src/iframe_shell/mod.rs` serves `frame.html` with `Content-Type: text/html`, `Content-Security-Policy: …`, and `Cache-Control: no-store, no-cache, must-revalidate`. The no-store header is non-negotiable: WKWebView caches custom-scheme responses, and a stale cache after an app update can serve outdated CSP on first launch. `frame.html` is byte-equal to the string returned by `generateFrameHtml()` in TS — `iframe_shell_parity.rs` runs `pnpm exec tsx scripts/dump-frame-html.mjs` and compares.

### Content Security Policy

The Tauri scheme handler's response header AND the iframe HTML's `<meta>` tag both carry the same permissive policy. CSP intersects across sources, so the duplication is defense-in-depth: the meta tag also covers the browser-dev `srcDoc` path where there's no response to attach a header to.

```
default-src 'self' blob: data:;
script-src  'unsafe-inline' 'unsafe-eval' blob: https: http://127.0.0.1:*;
style-src   'unsafe-inline' https: http://127.0.0.1:*;
img-src     * data: blob:;
font-src    * data:;
media-src   * data: blob:;
object-src  * data: blob:;
connect-src *;
frame-src   'none';
child-src   'none';
worker-src  'self' blob:;
```

`'unsafe-inline'` and `'unsafe-eval'` are required: cell outputs run inline `<script>` (Plotly fallback, Bokeh embeds, `display(HTML('<script>...'))`), and renderer plugins use `new Function(code)`. `frame-src 'none'`/`child-src 'none'` block malicious cell output from spawning nested iframes for evasion of host-side observers. `http://127.0.0.1:*` in `script-src`/`style-src` lets anywidget ESM (`_esm`) and CSS (`_css`) load from the daemon's blob-store HTTP server on a dynamic localhost port. `https:` covers CDN-hosted widget assets (unpkg/jsdelivr).

The parent shell CSP (`tauri.conf.json` `csp`) keeps `script-src 'self' 'wasm-unsafe-eval'` — strict, because the parent-shell JS is Vite-bundled with no inline scripts. `tests/tauri_csp.rs` pins this; it asserts no `'unsafe-inline'`, no `'unsafe-eval'`, no script hash, and that the new scheme is allowlisted in `frame-src`/`child-src`.

Canonical files:
- TS: `src/components/isolated/frame-html.ts` → `generateFrameHtml()`
- Rust: `crates/notebook/src/iframe_shell/mod.rs` → `handler()`, `frame.html`

### Per-platform origin shape

| Platform | Iframe URL | Iframe `window.origin` (sandboxed) |
|---|---|---|
| macOS, Linux, iOS | `nteract-frame://localhost/` | `null` (opaque) |
| Windows + WebView2 | `http://nteract-frame.localhost/` | `null` (opaque) |
| Browser dev (`pnpm dev`) | `srcDoc` | `null` (opaque) |

All three keep an opaque origin because of the sandbox attribute. Don't string-compare iframe URLs across platforms — `URL`-parse them.

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
│         ISOLATED IFRAME (nteract-frame://localhost/)         │
│         opaque origin (null) via sandbox flags               │
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
| `IsolatedFrame` | `src/components/isolated/isolated-frame.tsx` | Manages iframe document lifecycle, exposes `installRenderer()` |
| `CommBridgeManager` | `src/components/isolated/comm-bridge-manager.ts` | Parent-side widget state sync |
| `jsonrpc-transport.ts` | `src/components/isolated/jsonrpc-transport.ts` | JSON-RPC 2.0 transport over `postMessage` |
| `rpc-methods.ts` | `src/components/isolated/rpc-methods.ts` | Shared widget-bridge method constants |
| `WidgetBridgeClient` | `src/isolated-renderer/widget-bridge-client.ts` | Iframe-side widget bridge (`createWidgetBridgeClient`) |
| `frame-html.ts` | `src/components/isolated/frame-html.ts` | Bootstrap HTML (browser dev srcDoc path) |
| `iframe_shell` | `crates/notebook/src/iframe_shell/` | Tauri scheme handler + `frame.html` (production iframe path) |
| `frame-bridge.ts` | `src/components/isolated/frame-bridge.ts` | Legacy frame-message types and guards |

The core renderer bundle is built inline by `apps/notebook/vite-plugin-isolated-renderer.ts` and supplied through `IsolatedRendererProvider` (read via `useIsolatedRenderer()`). No HTTP fetch, no separate build step.

## Renderer plugins

Heavy renderers (markdown, plotly, vega, leaflet, sift) are **not** in the core IIFE. They're on-demand CJS modules loaded via `frame.installRenderer()` only when their MIME types appear.

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

### Current plugins

| Plugin | MIME | Virtual module | Size |
|--------|------|----------------|------|
| Markdown | `text/markdown` | `virtual:renderer-plugin/markdown` | ~2.2 MB |
| Vega | `application/vnd.vega*.v*` | `virtual:renderer-plugin/vega` | ~865 KB |
| Plotly | `application/vnd.plotly.v1+json` | `virtual:renderer-plugin/plotly` | ~4.8 MB |
| Leaflet | `application/geo+json` | `virtual:renderer-plugin/leaflet` | ~194 KB |
| Sift | `application/vnd.apache.parquet` | `virtual:renderer-plugin/sift` | ~380 KB JS + 138 KB CSS |

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
4. In `src/components/isolated/iframe-libraries.ts`, add the MIME → plugin entry to `PLUGIN_MIME_TYPES`. Vega-style pattern matchers can use a shared loader; exact MIME types should live in the map.
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

- Sandbox still excludes `allow-same-origin` (constant + render-time tests both green).
- Parent-shell CSP keeps `script-src 'self' 'wasm-unsafe-eval'` — no `'unsafe-inline'`, no `'unsafe-eval'`, no `sha256-…`. If you need to relax these, the iframe is probably back to inheriting the parent's CSP and the change is wrong.
- Iframe meta CSP and Rust scheme-handler response header carry the same policy; both keep `frame-src 'none'`/`child-src 'none'`.
- `Cache-Control: no-store` on scheme-handler responses.
- `frame.html` byte-matches `generateFrameHtml()` (`iframe_shell_parity` enforces).
- Source validation is intact (`event.source !== window.parent`).
- Any new message types are added to the whitelist (`frame-bridge.ts`) and the JSON-RPC method list.
- Unit tests updated; `pnpm test:run` green; `cargo test -p notebook` green.

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
