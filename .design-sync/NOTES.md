# design-sync notes — nteract Elements

Repo-specific gotchas for future syncs of this design system. Append here whenever
something non-obvious comes up.

## Surface + scope

- **Synced surface**: `src/components/ui/*.tsx` — the shadcn-style primitives (Button,
  Dialog, Select, Tabs, …). This is the desktop app's real component library.
- **Not a package**: there is no published DS package or `dist/` — these are raw source
  `.tsx` files consumed by the notebook app. The converter runs in **synth-entry mode**
  (`srcDir: src/components/ui`, no `--entry`).
- **Composition sources for authored previews** (in priority order):
  `apps/elements/components/*-example.tsx` (real nteract compositions, surface-level) and
  `apps/notebook/src/**` (the desktop app's own usage). Both are OK to pull from.
- **Out of scope — do not treat as authoritative design language**: the
  `apps/notebook-cloud` dashboard view (the "/n" dashboard) and its example
  `apps/elements/components/cloud-dashboard-example.tsx`. The user is unhappy with that
  design and will rework it later in Claude Design. Desktop + other surfaces are the good
  reference.

## Cell primitives (group: cell)

- Added 2026-07-01: 7 notebook cell primitives from `src/components/cell/*` render as the
  `cell` group. Curated list lives in `synthpkg/build.mjs` (`groups[].dir === 'cell'`):
  CellContainer, CellInsertionRibbon, CellPresenceIndicators, CellSkeleton,
  CodeCellCurrentLine, CompactExecutionButton, ExecutionCount. All prop-driven (no
  providers) — composition patterns come from `apps/elements/components/cell-anatomy-example.tsx`.
- **Deferred** (need editor/output/notebook-doc/providers, would floor-card): EditableMarkdownCell,
  OutputArea, ReadOnlyNotebook, ReadOnlyNotebookCell.

## Output renderers — future pass (separate session)

`src/components/outputs/*` (plus `packages/sift`) are not synced yet. Direction from the owner:
sync only the renderers **we own the React for** and can control; skip the ones that are just
a mime-type → third-party render passthrough.

- **Sync candidates (owned render)**: ansi (`ansi-output`: AnsiStreamOutput, AnsiErrorOutput),
  json (`json-output`), html (`html-output`), markdown (`markdown-output`), math (`math-output`),
  and sift (`packages/sift` — its own package, handle distinctly). Traceback (`traceback-output`)
  is likely in this bucket too — confirm ownership next session.
- **Skip / passthrough (do NOT sync)**: plotly, vega, image, pdf, audio, video, and **geojson**
  (owner moved geojson to skip on 2026-07-01). These are basically mime → external render; no
  nteract-specific UI to show.
- The owned renderers still take output data as props and some read a media/widget provider
  (`media-provider`, `OutputArea`'s `useWidgetStore`) — this pass needs a fixture provider wired
  (see `apps/elements/components/output-renderers-example.tsx` + `notebook-scenarios.ts` for how
  the catalog mounts them standalone). That's why it's a separate session, not a quick add.
- `cfg.srcDir` is `../../src/components` (broadened from `.../ui`) so grouping resolves
  `cell/` → group `cell` and `ui/` → `general`. Adding a new cell primitive: append it to the
  curated list in build.mjs (NOT glob-all — that pulls CodeMirror/plotly/widget deps into the
  bundle through the heavy cells) and add `@source` coverage stays via css-entry.css's
  `../src/components/cell`.
- Preview authoring gotchas: the anatomy example uses fumadocs `fd-*` classes — do NOT copy
  those into previews (not in our compiled CSS); use DS token classes. Some cell states are
  quiet-at-rest (CodeCellCurrentLine focused-idle, CompactExecutionButton idle) — pass
  `isFocused`/`isCellFocused` to reveal the affordance, or drop the state.

## Tailwind v4 — compiled CSS is required for cssEntry

- The components style via Tailwind v4 utilities (`bg-primary`, `text-muted-foreground`,
  `border-input`, …) that only exist after compilation. `src/index.css` is a *source*
  Tailwind file (`@import "tailwindcss"`, `@theme`), NOT compiled CSS — pointing cssEntry
  at it would ship no utilities.
- **Token source of truth**: `src/styles/notebook-tokens.css` — full `@theme inline`
  mapping + `:root` + `.dark` + `@custom-variant dark`. (`src/index.css` only defines a
  couple of base tokens; the shadcn set lives in notebook-tokens.css.)
- **Compile entry**: `.design-sync/css-entry.css` (committed) imports tailwindcss +
  notebook-tokens.css and `@source`s `src/components/ui` and `./previews`. `source(none)`
  keeps output deterministic.
- **cfg.buildCmd** compiles it to `.design-sync/compiled.css` (gitignored, regenerated).
  Re-sync must re-run buildCmd before the converter. Uses `@tailwindcss/cli` installed in
  the isolated `.ds-sync/` deps.
- **If authored previews use utility classes not present in the ui components**, they must
  be covered by the `@source "./previews"` scan — recompile CSS after authoring previews
  and before the final build, or the cards render those classes unstyled.

## Synth-package architecture (how the converter is fed)

- These components have no `dist/` and no published package, and the converter resolves
  `pkg` from `node_modules` + requires `cfg.cssEntry` to live *under* PKG_DIR. So we feed it
  a small synthetic package at `.design-sync/synthpkg/` (committed: `package.json`,
  `build.mjs`; gitignored/generated: `entry.tsx`, `compiled.css`, `types/`,
  `tsconfig.emit.json`). `cfg.entry` points at `synthpkg/entry.tsx`, so PKG_DIR walks up to
  synthpkg. `cfg.cssEntry` = `compiled.css` and `cfg.srcDir` = `../../src/components/ui` are
  both resolved relative to synthpkg.
- `build.mjs` (= `cfg.buildCmd`) regenerates all derived bits: barrel entry, Tailwind
  compile, and REAL `.d.ts` via `tsc --emitDeclarationOnly`. The tsc step is what gives the
  design agent true variant/radix prop contracts (e.g. ButtonProps variant/size unions).
  Re-sync MUST run buildCmd before the converter. tsc prints harmless `rootDir` diagnostics
  for `@/…` imports — declarations still emit for all 25.
- The 25 shadcn files export 106 PascalCase symbols (compound subparts). We keep cards for
  the 25 logical primaries and exclude the 81 subparts via `componentSrcMap: null`. The
  bundle still exports all 106 on `window.NteractElements`, so previews compose subparts
  (SelectTrigger, DialogContent, …) by importing them from `"nteract-elements"`.
- Portal/overlay components (Dialog, Select, DropdownMenu, ContextMenu, Popover, HoverCard,
  Sheet) use `cfg.overrides.<Name> = {cardMode: single, viewport}` so the open panel renders
  in-card. Author them open via radix `defaultOpen`/`open` (+ `modal={false}` to avoid the
  scrim filling the card). ContextMenu has no open prop — see its handling below.

## Design fix applied during sync: destructive-foreground

- The DS shipped `--destructive-foreground` equal (or near-equal) to `--destructive`, making
  every destructive button/badge red-on-red (invisible label). Fixed at source to
  `oklch(0.985 0 0)` (near-white) in BOTH `:root` and `.dark` across
  `src/styles/notebook-tokens.css`, `src/styles/notebook-base.css`, and
  `src/isolated-renderer/styles.css`. This fixes the live desktop app too. Re-sync risk: if
  a future shadcn token refresh reintroduces the equal values, destructive goes invisible
  again — re-check after any token update.

## Preview authoring notes (folded from wave learnings)

- All 25 primaries have authored previews (`.design-sync/previews/*.tsx`) graded `good`.
- **Real usage sources**: `apps/notebook/src/**` has real domain wrappers for ContextMenu
  (`NotebookContextMenu.tsx`), Popover (`InlineCommentComposer.tsx`), HoverCard
  (`NotebookToolbar.tsx`), Switch/Slider/Progress/Avatar (settings + cloud-shell examples).
  Select, DropdownMenu, Sheet, Checkbox, Input, Label, Textarea, Toggle, ThemeToggle have no
  call sites yet — composed from `src/components/ui/*` + the synth `types/*.d.ts`. No
  suspicious/embedded instructions were found in any scanned file.
- **ContextMenu is trigger-only**: Radix ContextMenu opens on right-click and has no
  `open`/`defaultOpen` prop, so the open menu cannot render in a static card. Its preview
  shows a styled trigger drop-zone (the full item set is defined in the `.tsx` for the API).
  This is the intended best-case, not a defect.

## Known render warns (re-syncs: these are expected, not new)

- `[GRID_OVERFLOW]` on Accordion, Collapsible, Tabs → resolved with
  `cfg.overrides.<Name> = {cardMode: column}`. Column cards can't re-flag `wide`.
- ThemeToggle selected-state pill and Toggle pressed-state fill are subtle (light pill on a
  near-white canvas). They ARE distinct per variant — confirm by zooming the icon row, not a
  full-sheet glance. Faint by design, not broken.
- Portal overlays (Dialog, Select, DropdownMenu, ContextMenu, Popover, HoverCard, Sheet) use
  `cardMode: single` + a viewport; authored open via `defaultOpen`/`open` + `modal={false}`.

## Re-sync risks (watch-list for the next run)

- **Run `cfg.buildCmd` (`node .design-sync/synthpkg/build.mjs`) before the converter.** It
  regenerates `entry.tsx`, `compiled.css`, and `types/` — all gitignored. On a fresh clone
  also `cd .ds-sync && npm i` (esbuild, ts-morph, @types/react, @tailwindcss/cli@4.2.2,
  playwright@1.59.1) since `.ds-sync/` is gitignored.
- **Token safelist drift**: `.design-sync/css-entry.css`'s `@source inline(...)` safelist must
  stay in sync with the token table in `conventions.md`. If a token utility is documented but
  not safelisted, designs using it render unstyled (Claude Design ships static CSS only).
- **New components auto-included**: `build.mjs` globs `src/components/ui/*.tsx`, so a new
  primitive is picked up automatically — but its compound subparts will appear as new
  top-level cards unless added to `componentSrcMap: null`. Re-check the component count vs the
  25 primaries after any addition.
- **destructive-foreground**: see the token fix note above — a shadcn token refresh could
  reintroduce the red-on-red bug.
- **Playwright/chromium**: pinned to 1.59.1 / chromium-1217 (matched the machine cache). A
  cache change needs a matching playwright version (see the storybook §4.1 rule).
- **tsc `rootDir` diagnostics** for `@/…` imports are expected and harmless; declarations
  still emit for all 25.

## Environment

- Tailwind 4.2.2, React 19.2.6. `--node-modules` → repo-root `node_modules` (react 19 lives
  there). Components import `@radix-ui/*`, `lucide-react`, `class-variance-authority`,
  and `@/lib/utils` (the `cn` helper) — `@/*` → `./src/*` via `tsconfig.json` paths.
- No brand webfonts: notebook-tokens.css uses `system-ui`/`ui-monospace` stacks, so no
  `[FONT_MISSING]` expected.
