# Shared UI Primitives Package (nteract Elements)

**Status:** Draft, 2026-07-01.

## Context

The shadcn-style UI primitives (Button, Popover, ContextMenu, Dialog, …) exist
in more than one place, and they have already started to drift:

- `src/components/ui/*` is the app's primitive library and the surface the
  design-sync converter ships to Claude Design (the "nteract Elements" guide).
  These use our semantic design tokens: `bg-primary`, `text-muted-foreground`,
  `border-input`, `ring`, backed by the oklch `--primary`/`--background`/… set in
  `src/styles/notebook-tokens.css`.
- `packages/sift/src/components/ui/{button,context-menu,popover}.tsx` are
  structurally identical shadcn copies that sift carried over from its prototype
  (`rgbkrk/sift`). They are wired to sift's own token namespace —
  `--sift-accent`, `--sift-ink`, `--sift-panel`, `--sift-rule`, `--sift-bg` —
  defined in `packages/sift/src/themes/{classic,cream}.css`. Sift's Button also
  exposes a narrower variant set (default/outline/ghost) than the app's
  (default/destructive/outline/secondary/ghost/link).

So the same component is maintained twice, and the two copies do not look the
same because they resolve different tokens. Every change to a primitive is now a
whack-a-mole: fix it in the app, remember to fix it in sift, reconcile tokens.

The dependency direction rules out the obvious fix. The app depends on sift, not
the reverse: `src/isolated-renderer/sift-renderer.tsx` and
`src/components/cell/OutputArea.tsx` import `@nteract/sift` and render `SiftTable`
inside an isolated iframe. Sift imports nothing from app `src/`. Pointing sift at
`@/components/ui/*` would be a circular dependency. Deduping is only possible
through a third package that both the app and sift can depend on.

Most of sift is **not** reusable UI and is out of scope here. `sparkline.tsx`
(~1350 lines) is the column-summary engine — histograms, category bars, filter
overlays, popovers — welded to sift's `TableData`/`ColumnSummary`/filter types.
`column-context-menu.tsx` is coupled to sift's `ColumnType` and event model.
Those stay in sift. The reusable surface is the shadcn primitives (the
duplicated ones) plus a small number of self-contained components
(`image-viewer.tsx`).

## Decision

Introduce a shared workspace package — proposed name **`@nteract/elements`**, to
match the design guide it feeds — as the single source of truth for the UI
primitives and the design tokens. Both the app (`src/`) and sift consume it. The
design-sync converter syncs from it.

Unification has two layers and both move into the package:

1. **Components** — the shadcn primitives (Button, Popover, ContextMenu, Dialog,
   Input, Label, …) plus `lib/utils` (`cn`) live in `@nteract/elements` and are
   imported by everyone. No more per-consumer copies.
2. **Tokens** — the semantic token set (`--primary`, `--background`, `--border`,
   `--ring`, …) and the Tailwind `@theme` mapping move into the package's CSS so
   every consumer resolves the same palette. Sift's `--sift-*` tokens become
   aliases of the shared tokens (or are replaced at the call sites), so sift's
   primitives adopt our palette instead of its prototype blue.

## Staged plan

Each stage is independently shippable and independently verifiable. The risky
stages touch a published package and the design-sync surface, so they are
sequenced last and reviewed on their own.

- **Stage 1 — create `packages/elements`.** Seed it from `src/components/ui/*`
  (our styled source of truth) + `src/lib/utils.ts` + the token CSS from
  `src/styles/notebook-tokens.css`. Package builds and type-checks on its own.
  Nothing consumes it yet, so blast radius is zero.
- **Stage 2 — app consumes the package.** Turn `src/components/ui/*` into thin
  re-exports from `@nteract/elements` so the ~all `@/components/ui/*` import sites
  keep working untouched. Repoint the design-sync converter (`.design-sync/`) at
  the package as the synced surface. The package is now the single source; the
  app stops owning primitive source.
- **Stage 3 — sift consumes the package.** Replace sift's
  `components/ui/{button,context-menu,popover}` imports with `@nteract/elements`,
  delete sift's copies, and unify tokens: alias `--sift-*` to the shared tokens
  in sift's theme files (or drop them for the shared token CSS). Reconcile the
  Button variant gap (sift only used default/outline/ghost — all present in
  ours). Verify with sift's own `build:lib`, unit tests, and e2e.
- **Stage 4 — lift the genuinely reusable components.** Move `image-viewer.tsx`
  into `@nteract/elements`, styled with shared tokens; sift and the app both use
  the one copy; it joins the design guide.

## Consequences

- **Single source of truth.** A primitive is edited once. The app, sift, and the
  guide can no longer drift.
- **Sift changes appearance.** Sift adopts our monochrome primary in place of its
  prototype blue accent, and its compact sizing must be reconciled against ours.
  This is the intended "match our styling," but it is a visible change to sift and
  needs a look before it ships.
- **Published-package risk.** Sift ships as `@nteract/sift` with a `build:lib`
  step and e2e suite. Stage 3 must keep that build green; it is the highest-risk
  stage and is gated behind Stages 1–2.
- **Design-sync surface moves.** The converter currently reads
  `src/components/ui`. After Stage 2 it reads the package. The synced component
  set and the guide are unchanged in content; only the source path moves.
- **App blast radius is contained** by the re-export shim in Stage 2 — no repo-wide
  import rewrite.

## Non-goals

- Extracting sift's crossfilter engine, column-summary rendering (`sparkline.tsx`),
  or filter UI. That is engine code, not reusable UI, and stays in sift.
- Publishing `@nteract/elements` externally. It is an internal workspace package.

## Open questions

- **Package name.** `@nteract/elements` aligns with the design guide; alternatives
  are `@nteract/ui` or folding into an existing package. Naming is load-bearing
  for imports and is worth confirming before Stage 1.
- **App migration shape.** Re-export shim (proposed, minimal churn) vs a full
  import rewrite to `@nteract/elements` across the app (cleaner end state, larger
  diff). The shim can be collapsed later.
- **Token strategy for sift.** Alias `--sift-*` → shared tokens (smallest sift
  diff, keeps sift's call sites) vs replace sift's call sites with shared utility
  classes (cleaner, larger sift diff).
