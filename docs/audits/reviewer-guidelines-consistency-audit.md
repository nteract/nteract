# Reviewer Guidelines Consistency Audit

Status: Audit
Date: 2026-06-20

This audit compares existing code boundaries against the reviewer rubric in
`.agents/reviewers/nteract-code-review-rubric.md`. It is a source-backed
follow-up list, not a decision record. Durable boundary decisions should
graduate into ADRs.

## Immediate Cleanup

### Browser Theme Hook Still Had a Tauri Side Effect

Reviewer category: `host_boundary`

`src/hooks/useTheme.ts` was used by cloud/browser views but still dynamically
imported `@tauri-apps/api/window` to sync the native window theme. Desktop Tauri
windows that need native window theme sync use `useSyncedTheme()` from
`src/hooks/useSyncedSettings.ts`, so the generic browser hook should stay
host-neutral.

Follow-up:

- PR #3780 removes the Tauri branch from `useTheme`.

## Highest-Value Target

### Direct Tauri Effects Remain Outside `@nteract/notebook-host`

Reviewer category: `host_boundary`

The current host abstraction says notebook frontend code should not import
`@tauri-apps/*` directly; call sites should go through `useNotebookHost()` or a
non-React helper that receives a host instance. The frontend subsystem guide
repeats the same invariant for `apps/notebook/src/**`, shared `src/**`, and
`packages/notebook-host`.

Evidence:

- `packages/notebook-host/src/types.ts` documents that the notebook frontend
  should never import `@tauri-apps/*` directly.
- `apps/notebook/src/AGENTS.md` defines `NotebookHost` as the host-platform
  side-effect boundary and lists direct `@tauri-apps/*` imports outside the
  Tauri host implementation as an invariant violation.
- `src/hooks/useSyncedSettings.ts` dynamically imports Tauri `invoke`, event
  `listen`, and `getCurrentWindow`.
- `apps/notebook/onboarding/App.tsx` imports Tauri `invoke`, event `listen`, and
  shell APIs, then writes synced settings through direct IPC.
- `apps/notebook/upgrade/App.tsx` imports Tauri core, event, window, process,
  and updater APIs, then runs upgrade IPC directly.
- `apps/notebook/diagnostics/App.tsx` imports Tauri core/window APIs and manages
  diagnostics IPC directly.
- `apps/notebook/feedback/App.tsx` imports Tauri core/window/shell APIs and opens
  feedback directly.
- `apps/notebook/settings/sections/Privacy.tsx` imports the Tauri shell plugin
  for telemetry links.

Suggested PR sequence:

1. Add a small auxiliary-window host adapter in `@nteract/notebook-host` rather
   than expanding the notebook-room host with upgrade/onboarding-specific
   methods.
2. Move shared synced-settings IPC behind that package first; this unlocks
   settings, onboarding, and desktop theme behavior.
3. Move diagnostics, feedback, and upgrade as follow-ups with narrow adapters
   instead of one large host-boundary PR.

## Generated Artifact Ownership

### Shared Tests and Cloud Import App-Owned WASM Output

Reviewer categories: `generated_artifact`, `shared_surface`

Several shared packages and cloud code load generated WASM artifacts from
`apps/notebook/src/wasm/runtimed-wasm`. That makes shared/package tests depend on
an app-owned generated path and blurs ownership of the WASM runtime surface.

Evidence:

- `apps/notebook-cloud/src/runtimed-wasm.ts` imports the generated JS and `.wasm`
  from the desktop app tree.
- `src/lib/__tests__/markdown-projection.test.ts` imports the generated JS and
  reads the generated `.wasm`.
- `src/components/outputs/__tests__/media-router.test.tsx` imports the generated
  JS and reads the generated `.wasm`.
- `packages/runtimed/tests/wasm-harness.ts` imports generated app types and loads
  generated app artifacts.

Suggested PR sequence:

1. Introduce a package-owned WASM loader or test harness entrypoint for
   `runtimed-wasm`.
2. Point cloud and shared tests at that artifact helper.
3. Keep app-local generated output as a consumer artifact, not the path other
   packages depend on.

## Planned Extraction To Track

### Cloud Renders Through the Temporary Desktop `notebook-surface`

Reviewer category: `shared_surface`

`apps/notebook-cloud/viewer/notebook-viewer.tsx` imports
`../../notebook/src/notebook-surface`, and
`apps/notebook/src/notebook-surface.ts` exports `NotebookView`, `CodeCell`,
`MarkdownCell`, and `RawCell` as a render-only surface. This is not accidental
drift: `apps/notebook-cloud/test/viewer-shared-cell-surface.test.ts` asserts this
temporary bridge, restricts private desktop imports, and checks that cloud
projects live cells into the shared stores.

This should still be tracked as extraction debt. A later PR can move the render
surface into `src/components/notebook` or a package once the host-boundary and
WASM artifact seams are cleaner.

## Low-Risk Review Item

### `useSyncedSettings` Initial Load Has No Stale-Unmount Guard

Reviewer category: `async_ordering`

`src/hooks/useSyncedSettings.ts` performs an initial async settings load and then
writes many local state values. This is not a high-severity correctness issue,
but if the hook is refactored behind a host/settings adapter, include
stale-unmount guards or move the data into a store with an explicit subscription
lifecycle.
