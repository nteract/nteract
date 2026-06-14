# Frontend architecture

Scope: `apps/notebook/src/**`, shared components at `src/components/**`, and `packages/notebook-host/`.

## Directory layout

```
src/                          ← Shared components (path alias @/)
├── bindings/                 ← TypeScript types generated from Rust (ts-rs)
├── components/
│   ├── cell/                 ← Cell container, controls, execution count
│   ├── editor/               ← CodeMirror wrappers, extensions, themes
│   ├── isolated/             ← Iframe security isolation (see src/components/isolated/AGENTS.md)
│   ├── notebook/             ← Shared notebook chrome, capabilities, view-model projections
│   ├── outputs/              ← Output renderers (MediaRouter, AnsiOutput, etc.)
│   ├── widgets/              ← ipywidgets and anywidget (see src/components/widgets/AGENTS.md)
│   └── ui/                   ← shadcn components (see src/components/ui/AGENTS.md)
├── hooks/                    ← Shared hooks (useSyncedSettings, useTheme)
├── isolated-renderer/        ← Code that runs INSIDE isolated iframe
├── lib/                      ← Shared utilities (utils.ts with cn())
└── styles/                   ← Global stylesheets

apps/notebook/src/            ← Notebook app (path alias ~/)
├── components/               ← App-specific components (toolbar, banners)
├── contexts/                 ← React contexts (PresenceContext)
├── hooks/                    ← Notebook-specific hooks (useDaemonKernel, etc.)
├── lib/                      ← App-specific utilities (materialize-cells.ts)
├── wasm/                     ← WASM bindings (runtimed-wasm)
├── App.tsx                   ← Root component
└── types.ts                  ← App types
```

## Path aliases

Configured in `apps/notebook/tsconfig.json`:

| Alias | Resolves to | Use for |
|-------|-------------|---------|
| `@/*` | `../../src/*` | Shared components, hooks, utilities |
| `~/*` | `./src/*` | App-specific code |

## Shared vs app-specific

Put pure reusable UI components and generic browser utilities in `src/`.

Put host, transport, sync, and lifecycle mechanisms in packages such as `@nteract/notebook-host` or `@nteract/runtimed`. Package code may depend on `NotebookHost` contracts and daemon lifecycle types, but must not import app stores, routes, or React-owned notebook UI policy.

Put code in `apps/notebook/src/` when it owns notebook app policy: stores, routes, layout, UI state, materialization choices, and closures that connect package mechanisms to app-specific state.

When iterating on a shared surface (rail, outline, toolbar, cells), keep the *interaction* layer shared too: scroll observers, selection coupling, and status projections belong as hooks colocated with the shared component, not as hooks inside `App.tsx`. Interaction logic written here reaches only desktop — the cloud viewer renders the same component with whatever props it knows about and silently lacks the new behavior. If you add an optional interaction prop to a shared component, also wire it in `apps/notebook-cloud/viewer/` or record why not (see the outline case study in `docs/adr/notebook-host-shell-convergence.md`). Known intentional asymmetry: desktop omits the workstations panel while remote compute matures on hosted.

## NotebookHost — platform abstraction

Host-platform side effects (Tauri IPC, plugin calls, window chrome) flow through `@nteract/notebook-host`. React code uses `const host = useNotebookHost()`. Import `@tauri-apps/*` only inside the Tauri host implementation and narrow relay glue — the notebook frontend stays host-agnostic.

| Namespace | Purpose |
|-----------|---------|
| `host.transport` | `NotebookTransport` shared by SyncEngine / NotebookClient |
| `host.daemon` | `isConnected`, `reconnect`, `getInfo`, `getReadyInfo` |
| `host.daemonEvents` | `onReady` / `onProgress` / `onDisconnected` / `onUnavailable` |
| `host.relay` | `notifySyncReady()` outbound signal |
| `host.blobs` | `port()` — daemon blob-server HTTP port |
| `host.trust` | `verify()` / `approve()` |
| `host.deps` | Dependency validation (`checkTyposquats`) |
| `host.notebook` | `applyPathChanged`, `getDefaultSaveDirectory`, `saveAs`, `openInNewWindow`, `cloneToEphemeral` |
| `host.window` | `getTitle` / `setTitle` / `onFocusChange` |
| `host.system` | `getGitInfo`, `getUsername` |
| `host.dialog` | `openFile` / `saveFile` |
| `host.externalLinks` | `open(url)` |
| `host.updater` | `check()` |
| `host.commands` | Typed command bus (menus + keyboard + future palette) |
| `host.log` | `debug/info/warn/error` |

Module-level helpers (no hooks) — called once from `main.tsx` after `createTauriHost()`:
- `setLoggerHost(host)` — `src/lib/logger.ts`
- `setBlobPortHost(host)` — `blob-port.ts`
- `setOpenUrlHost(host)` — `src/lib/open-url.ts`
- `setMetadataTransport(host.transport)` — `notebook-metadata.ts`

**Canonical surface**: `packages/notebook-host/src/types.ts`.
**Tauri implementation**: `packages/notebook-host/src/tauri/index.ts`.

### Transport protocol

Notebook request/response traffic goes through `NotebookClient` on `host.transport`, encoding `NotebookRequestEnvelope` values as typed protocol frames (`0x01`). Responses return as `0x02` frames on the unified inbound transport stream, resolved by request id.

Prefer extending `NotebookRequest` for daemon-owned notebook behavior. Add host methods for platform behavior. Some direct `invoke(...)` calls remain for host-side work that is not a notebook request/response frame: save/open dialogs, app update flows, dependency validation helpers.

## Key hooks

| Hook | Role |
|------|------|
| `useNotebook` | Owns the active notebook controller: WASM NotebookHandle, materialization, `CellChangeset` dispatch |
| `useDaemonKernel` | Kernel execution and ephemeral runtime event callbacks |
| `usePresence` | Remote cursor/selection tracking via presence frames |
| `useEnvProgress` | RuntimeStateDoc-backed environment progress projection |
| `useDependencies` | UV dependency management |
| `useCondaDependencies` | Conda dependency management |
| `useDenoConfig` | Deno config detection plus flexible-npm-imports toggle |
| `useManifestResolver` | Resolves blob hashes to output data |
| `useCellKeyboardNavigation` | Arrow keys, enter/escape modes |
| `useEditorRegistry` | CodeMirror editor instance registry |
| `useGitInfo` | Git branch/status for the notebook file |
| `useGlobalFind` | Global find-and-replace across cells |
| `useTrust` | Notebook trust verification state |
| `usePixiDetection` | Pixi project detection (pixi.toml is the source of truth) |
| `usePoolState` | Daemon pool state |
| `useCrdtBridge` | CodeMirror ↔ CRDT character-level sync |

## Data flow

```
Tauri relay ── frame channel ──► useNotebook
                                     (WASM receive_frame demux)
                                       │          │         │
                  sync_applied ────────┘          │         │
                  + CellChangeset                 │         │
                         ▼                        │         │
                  scheduleMaterialize    emitBroadcast  emitPresence
                  (32ms coalesce)        (frame bus)    (frame bus)
                         │                    │              │
                  ┌──────┴──────┐             ▼              ▼
                  │ structural? │      useDaemonKernel   usePresence
                  └──┬──────┬───┘      useEnvProgress
            full ◄───┘      └───► per-cell
         materialize-     materialize-
         Cells()          CellFromWasm
                  │           │
                  ▼           ▼
            ┌────────────────────┐
            │ Split Cell Store   │
            │ useCell(id)        │
            │ useCellIds()       │
            └────────┬───────────┘
                     ▼
     React Components (React.memo per cell)
     CellRenderer → useCell(id) → CodeCell/MarkdownCell
```

### Incremental sync pipeline

1. **useNotebook** — Single frame ingress. Demuxes via WASM `receive_frame()`, applies sync locally. Returns a `CellChangeset` with field-level granularity. Broadcasts and presence dispatch via in-memory frame bus. The current implementation lives in `useAutomergeNotebook.ts` during the controller extraction.

2. **scheduleMaterialize** — Coalesces sync frames within a 32ms window via `mergeChangesets()`:
   - **Structural changes** (cells added/removed/reordered) → full `cellSnapshotsToNotebookCells()`
   - **Output changes** → per-cell cache-aware resolution via `materializeCellFromWasm()`
   - **Source/metadata only** → per-cell O(1) WASM accessors

3. **Split cell store** (`notebook-cells.ts`) — `Map<id, NotebookCell>` + ordered ID list:
   - `useCell(id)` — re-renders only when that cell changes
   - `useCellIds()` — re-renders only on structural changes
   - `updateCellById()` — O(1) map update, notifies one subscriber
   - `replaceNotebookCells()` — full replacement with `cellsEqual()` diffing

4. **Runtime state projection** — Persistent kernel/env state from RuntimeStateDoc through `runtime-state.ts` and `project-runtime-stores.ts`. Ephemeral events via broadcast frame bus.

5. **cursor-registry.ts** — Independent frame bus subscriber. Dispatches `setRemoteCursors()`/`setRemoteSelections()` as CodeMirror `StateEffect`s directly — bypasses React for low-latency cursor rendering.

### Mutation flow

Cell mutations go through WASM for instant local response. Source edits batch via `engine.scheduleFlush()` (20ms debounce), with `engine.flush()` before execute/save. Fast typing path: `useCrdtBridge` CodeMirror plugin → `handle.splice_source(cell_id, index, delete_count, text)` → `updateCellById()` → debounced sync to daemon.

Execution requests use `NotebookClient` on `host.transport`. The daemon reads cell source from the synced Automerge document, so flush pending source sync before execute/save.

### CellChangeset

Shape originates in Rust (`notebook-doc/src/diff.rs`). TypeScript source of truth: `packages/runtimed/src/cell-changeset.ts`. App re-exports through `apps/notebook/src/lib/cell-changeset.ts` and `frame-pipeline.ts`:
- `CellChangeset` — `{ changed, added, removed, order_changed }`
- `ChangedCell` — `{ cell_id, fields }` with boolean flags per field
- `mergeChangesets()` — union semantics for coalescing window

## Invariants

- Use `@nteract/notebook-host` for host-platform effects. No direct `@tauri-apps/*` imports outside the Tauri host implementation and narrow relay glue.
- `useNotebook` is the single daemon-frame ingress for notebook state.
- Cell editing mutates the WASM Automerge handle first; flush pending source sync before execute/save.
- Persistent runtime state comes from RuntimeStateDoc projections. Broadcasts are ephemeral only.
- Preserve split cell-store behavior: update individual cells by id when possible, reserve full replacement for structural changes.
- Render cells in stable DOM order in `NotebookView.tsx` and use CSS `order` for visual positioning so iframe outputs survive reorder without destruction.

## Key files

| File | Role |
|------|------|
| `apps/notebook/tsconfig.json` | Path alias configuration |
| `apps/notebook/src/App.tsx` | Root component, provider setup |
| `apps/notebook/src/hooks/useNotebook.ts` | Product-facing notebook controller hook |
| `apps/notebook/src/hooks/useAutomergeNotebook.ts` | Current WASM handle owner and materialization implementation |
| `apps/notebook/src/lib/materialize-cells.ts` | WASM → React conversion |
| `src/components/notebook/state/notebook-frame-bus.ts` | Pub/sub for broadcast and presence |
| `apps/notebook/src/hooks/usePresence.ts` | Remote presence tracking |
| `packages/runtimed/src/transport.ts` | `FrameType` constants and transport interface |
| `apps/notebook/src/lib/frame-pipeline.ts` | Frame event processing and materialization planning |
| `src/components/outputs/media-router.tsx` | Output type dispatch |
| `src/components/editor/codemirror-editor.tsx` | Main editor |
