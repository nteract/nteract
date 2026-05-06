# Widget system — state, bridge, renderers

Widgets run inside the isolated iframe. Widget state lives in `RuntimeStateDoc` (`doc.comms/`), not in Jupyter comm frames. The daemon writes comm state; `SyncEngine` diffs the CRDT, runs the WASM resolver, and forwards `ResolvedComm` events through `CommBridgeManager` to the iframe over JSON-RPC. The iframe fetches blob URLs and installs `DataView`s at each `bufferPath` before the anywidget model observes state.

Scope: `src/components/widgets/**`. The JSON-RPC transport and iframe lifecycle live alongside in `src/components/isolated/**` — see `src/components/isolated/AGENTS.md` for sandbox and postMessage details.

## Data flow

```
┌──────────────────────────────────────────────────────────────────┐
│ Daemon — kernel + blob store + RuntimeStateDoc                   │
│   comm_open / comm_msg / binary buffers                          │
│   → blob-store + ContentRef in CRDT                              │
└──────────────────────────────────┬───────────────────────────────┘
                                   │ Automerge sync
┌──────────────────────────────────▼───────────────────────────────┐
│ Parent window                                                    │
│  SyncEngine (resolve_comm + text-blob fetch)                     │
│    └─ commChanges$ ─► WidgetStore (state + bufferPaths)          │
│                       └─► CommBridgeManager                      │
│                            └─ postMessage / JSON-RPC ►           │
└───────────────────────────────────────────┬──────────────────────┘
                                            ▼
┌──────────────────────────────────────────────────────────────────┐
│ Isolated iframe                                                  │
│  WidgetBridgeClient (resolveBlobUrls → DataView at bufferPaths)  │
│    └─► iframe WidgetStore ─► widget components                   │
└──────────────────────────────────────────────────────────────────┘
```

## CRDT-driven inbound, outbound through the store

- **Daemon** writes comm state on `comm_open` / `comm_msg(update)` / `comm_close` from kernel IOPub, through a 16 ms coalescing writer so CRDT sync isn't overwhelmed.
- **Large values** (>1 KB JSON) and **binary buffers** from the ipywidgets binary-traitlet protocol (`Image.value`, `BinaryWidget.data`, …) are stored in the blob store as `ContentRef { blob, size, media_type }`. The daemon sets `media_type` per key — `_esm` → `text/javascript`, `_css` → `text/css`, binary buffers → `application/octet-stream`, else `text/plain`. See `crates/runtimed/src/output_prep.rs`.
- **WASM resolver** `resolve_comm_state` in `crates/runtimed-wasm/` walks the state and rewrites each `ContentRef` to a blob-server URL. It reports each path in one of three buckets:
  - `buffer_paths` — binary MIME (or missing `media_type`). Iframe fetches and installs a `DataView` (the ipywidgets binary-traitlet contract).
  - `text_paths` — text MIME. `SyncEngine` fetches and inlines the decoded string before it reaches widget code.
  - **Neither** — anywidget-reserved keys `_esm` / `_css`. The URL stays as a string so `loadESM` can `import(url)` and `injectCSS` can `<link rel="stylesheet">`. Leave these out of `buffer_paths` or the iframe resolver will turn them into `DataView`s and break both loaders.
- **Frontend inbound**: `SyncEngine.commChanges$` (`packages/runtimed/src/sync-engine.ts`) emits `ResolvedComm { state, bufferPaths, … }`. `App.tsx` drives `WidgetStore` from those events. `useCommRouter` is **outbound-only** — the old `handleMessage` / `applyBufferPaths` path was dropped when SyncEngine became authoritative (`fix/widget-binary-buffers`). If you want to re-add an inbound path, extend SyncEngine.
- **Frontend → kernel**: built-in widgets write state to `RuntimeStateDoc` via `getCrdtCommWriter()`. The runtime agent diffs comm state on each sync and forwards deltas to the kernel. Custom `model.send(..., buffers)` messages still use the daemon shell channel — they're ephemeral events, not CRDT state.
- **New clients** get widget state via normal `RuntimeStateDoc` CRDT sync (frame `0x05`). Ephemeral custom messages ride `NotebookBroadcast::Comm`.

## Reserved comm namespace: `nteract.dx.*`

`nteract.dx.*` target-names are reserved for nteract kernel-side protocols (dx uses `nteract.dx.blob`; future subsystems may use `nteract.dx.query`, `nteract.dx.stream`). The runtime agent filters this namespace out of `RuntimeStateDoc::comms` — it's not widget state, doesn't sync to the frontend, and never reaches `WidgetStore`. Pick a different prefix for widget targets.

## Key files

| File | Role |
|------|------|
| `src/components/widgets/widget-store.ts` | Model state (`useSyncExternalStore`) |
| `src/components/widgets/widget-registry.ts` | Model name → React component |
| `src/components/widgets/controls/` | 54 built-in ipywidgets |
| `src/components/widgets/controls/index.ts` | Built-in widget registration |
| `src/components/widgets/anywidget-view.tsx` | Anywidget ESM loader |
| `src/components/widgets/widget-view.tsx` | Registry lookup + render |
| `src/components/isolated/comm-bridge-manager.ts` | Parent ↔ iframe comm routing |
| `src/components/isolated/jsonrpc-transport.ts` | JSON-RPC 2.0 transport |
| `src/components/isolated/rpc-methods.ts` | Widget-bridge method constants |
| `src/isolated-renderer/widget-bridge-client.ts` | Iframe-side widget bridge |

## WidgetStore API

```typescript
interface WidgetStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Map<string, WidgetModel>;

  getModel(modelId: string): WidgetModel | undefined;
  createModel(commId: string, state: Record<string, unknown>, bufferPaths?: string[][]): void;
  updateModel(commId: string, statePatch: Record<string, unknown>, bufferPaths?: string[][]): void;
  deleteModel(commId: string): void;
  wasModelClosed(commId: string): boolean;

  subscribeToKey(modelId: string, key: string, callback: (value: unknown) => void): () => void;

  emitCustomMessage(commId: string, content: Record<string, unknown>, buffers?: ArrayBuffer[]): void;
  subscribeToCustomMessage(commId: string, callback: CustomMessageCallback): () => void;
}
```

`bufferPaths` is the manifest of JSON paths in `state` whose values are blob URL strings. The iframe fetches each URL and swaps in a `DataView` before the anywidget model observes state. Parent-window code sees URL strings; iframe code sees `DataView`s at those paths.

`buffers` on `emitCustomMessage` / `subscribeToCustomMessage` is a separate channel for transient event payloads (ipycanvas draw commands, quak row batches) that shouldn't live in CRDT state.

Use `useWidgetModelValue(modelId, "key")` from `widget-store-context.tsx` in components — it calls `useSyncExternalStore` with `subscribeToKey` + `getModel`.

## Comm bridge protocol

| Message | When | Iframe payload |
|---------|------|----------------|
| `comm_open` | Widget created (CRDT opened) | `{ commId, targetName, state, bufferPaths? }` |
| `comm_msg` method `update` | State delta (CRDT changed) | `{ commId, method: "update", data, bufferPaths? }` |
| `comm_msg` method `custom` | Ephemeral event | `{ commId, method: "custom", data, buffers? }` |
| `comm_close` | Widget destroyed | `{ commId }` |
| `widget_snapshot` | Iframe reconnect | `{ models: [{ commId, targetName, state, bufferPaths? }] }` |

`bufferPaths` applies only to `open` / `update`. `buffers` applies only to `custom`. The two don't share a channel. Exact payload shapes live in `CommOpenMessage`, `CommMsgMessage`, and `WidgetSnapshotMessage` in `src/components/isolated/frame-bridge.ts`.

`CommBridgeManager` subscribes to `WidgetStore`, forwards model updates (state + `bufferPaths`) to the iframe as JSON-RPC notifications, and routes iframe-originated `widget_comm_msg` / `widget_comm_close` messages to the kernel (`sendUpdate` / `sendCustom` / `closeComm`) and the parent store.

## Adding a built-in widget

1. Create the component in `src/components/widgets/controls/`:

```tsx
import type { WidgetComponentProps } from "../widget-registry";
import { useWidgetModelValue, useWidgetStoreRequired } from "../widget-store-context";

export function MyWidget({ modelId }: WidgetComponentProps) {
  const { sendUpdate } = useWidgetStoreRequired();
  const value = useWidgetModelValue(modelId, "value");
  const description = useWidgetModelValue(modelId, "description");

  return (
    <div>
      <label>{description}</label>
      <input value={value} onChange={(e) => sendUpdate(modelId, { value: Number(e.target.value) })} />
    </div>
  );
}
```

2. Register in `src/components/widgets/controls/index.ts`:

```typescript
import { MyWidget } from "./my-widget";
registerWidget("MyWidgetModel", MyWidget);
```

## Widget state conventions

Common ipywidgets fields:

| Field | Type | Notes |
|-------|------|-------|
| `_model_name` | string | e.g. `"IntSliderModel"` |
| `_model_module` | string | e.g. `"@jupyter-widgets/controls"` |
| `value` | varies | Current value |
| `description` | string | Label |
| `disabled` | boolean | Interactivity |
| `layout` | string | `IPY_MODEL_` reference to a `LayoutModel` |

Container widgets reference children via `IPY_MODEL_<comm_id>` strings. Resolve with `isModelRef(child)` / `parseModelRef(child)` from `widget-store.ts`.

## Anywidget

Anywidgets load ESM modules at runtime. `anywidget-view.tsx` detects `_esm` in model state, dynamically imports it, and calls its `render` with an AFM-compatible model proxy.

### Binary traitlets

When a widget defines `traitlets.Bytes(sync=True)`, ipywidgets' `_remove_buffers()` extracts the raw bytes before sending the comm message. The daemon blob-stores each buffer with `media_type: application/octet-stream` and replaces the state placeholder with a `ContentRef`. The WASM resolver rewrites to a blob URL, lists the path in `buffer_paths`, the iframe fetches and installs a `DataView` — which is exactly what anywidget consumers expect (`model.get("data").byteLength`, …).

`_esm` / `_css` stay out of `buffer_paths` on purpose (see the Data flow section).

`buildMediaSrc` in `buffer-utils.ts` accepts `DataView` in addition to `ArrayBuffer` / `Uint8Array` / URL string, so the resolved `DataView` turns into a valid `data:` URL for `<img>` / `<audio>` / `<video>` `src`.

## Testing and debugging

Unit tests: `src/components/widgets/__tests__/`.

Manual:

```python
import ipywidgets as widgets
slider = widgets.IntSlider(value=50, min=0, max=100)
display(slider)
```

In dev builds `apps/notebook/src/lib/logger.ts` calls `attachConsole()` so frontend logs appear in browser devtools. For comm-level tracing:

```bash
runt daemon logs -f | grep -i comm
```
