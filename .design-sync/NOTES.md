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

## Output renderers (group: outputs)

Owner direction: sync only the renderers **we own the React for**; skip mime → third-party
passthroughs. Curated list in `synthpkg/build.mjs` (`groups[].dir === 'outputs'`).

- **Shipped 2026-07-01**: `ansi-output` (AnsiOutput, AnsiStreamOutput, AnsiErrorOutput),
  `json-output` (JsonOutput), `traceback-output` (TracebackOutput). All prop-driven, no provider.
  Data shapes: AnsiOutput takes `children: string` (raw ANSI), AnsiStreamOutput
  `{text, streamName}`, AnsiErrorOutput `{ename, evalue, traceback: string[]}`, JsonOutput
  `{data, collapsed?, displayDataTypes?}`, TracebackOutput `{data}` where data is the
  `application/vnd.nteract.traceback+json` payload `{ename, evalue, frames[], language}`.
- **Deferred — markdown + math (katex)**: both do `import "katex/dist/katex.min.css"`, and the
  converter's bundle has no `.ttf` loader for katex's fonts (`bundle.mjs` loads .woff/.woff2 only).
  Shipping them means either a declared `.ttf`-dataurl bundle override, or shipping the katex
  fonts under `fonts/` + `@import` katex CSS via css-entry with rewritten URLs. Not a fork-free
  quick add — own pass. markdown also pulls `MarkdownCodeBlock` → CodeMirror langs (fine to bundle).
- **Skipped — html-output**: `HtmlOutput` throws unless rendered inside a sandboxed iframe
  (security gate), so it can't render in a static card. Leave it out.
- **Skip / passthrough (do NOT sync)**: plotly, vega, image, pdf, audio, video, **geojson**
  (owner moved geojson to skip 2026-07-01). Mime → external render; no nteract-specific UI.
- **ANSI needs `src/styles/ansi.css`**: the 16-color ANSI palette is theme-aware CSS vars +
  `.ansi-*` classes defined there (the app ships it via the isolated renderer). css-entry.css
  now `@import`s it — without it every AnsiOutput renders colorless (black swatches). Same class
  of bug as the destructive-foreground token: component CSS the DS closure was missing.
- **Multi-export files need componentSrcMap group pins**: the converter fuzzy-matches
  component→file by kebab name, so `AnsiOutput`→`ansi-output.tsx` resolves but its siblings
  `AnsiStreamOutput`/`AnsiErrorOutput` don't, and fall to the default `general` group. Pin each
  extra export to its source file in `componentSrcMap` (value = path, not null) so they group as
  `outputs`. Any future multi-component output file needs the same pins.
- **sift is next (own PR)**: `packages/sift` is a separate package (`@nteract/sift`, main export
  `SiftTable` + SiftScrollHandoffCue/SiftFocusStatus/sparkline). Owner wants more of sift broken
  into individual reusable `src/components/*` primitives we style in the guide, THEN synced — so
  the sift pass is partly a refactor (extract components) then a sync, not just a bundle add.
- The heavier composed surfaces (`OutputArea`, `ReadOnlyNotebook`, `EditableMarkdownCell`) still
  need a fixture media/widget provider wired (see
  `apps/elements/components/output-renderers-example.tsx` + `notebook-scenarios.ts`).

## Comment affordances (group: comments)

- Added 2026-07-01: `CommentSelectionAffordance` + `CommentMarkIcon` from
  `src/components/comments/`. Both prop-driven; author identity flows in via
  `--comment-author-color` (+ `--comment-author-contrast` for the pill label) set
  on an ancestor — previews wrap in a scope span with real peer colors.
- css-entry `@import`s `src/styles/comment-affordance.css` (dot/pill morph) and
  `src/styles/comment-highlight.css` (open/resolved/pending treatments) — the
  shared surfaces both editor and rendered-markdown planes use, tunable here.
  The highlight demo lives as a story inside the affordance's preview (prose
  with `.comment-highlight`/`-resolved`/`-pending` spans).
- The affordance is quiet-at-rest by design. Its motion helper
  (`comment-affordance-motion.ts`) listens for `pointerenter`/`focus` (NOT
  mouseenter) — the Open story calls `btn.focus()` + dispatches a
  `PointerEvent("pointerenter")` to play the morph for the screenshot.
- **NotebookCommentsPanel is DEFERRED with the katex pass**: fully prop-driven
  (`projection` + callbacks — fixture-friendly) but renders quotes through
  `ProjectedMarkdownView`, which imports `katex/dist/katex.min.css` (the .ttf
  loader wall). It joins this group when katex fonts ship, alongside
  markdown-output/math-output. Its `runtimed` imports (`actorInitials`,
  `onBehalfOfText`) still need a tree-shake check at that point.

## Dashboard atoms (groups: notebook, runtime)

- Added 2026-07-02: NotebookCompositionTicks (notebook group), RuntimeStatusDot +
  LanguageMark (runtime group) - the /n dashboard redesign's prop-driven atoms, shared
  with the cloud viewer. Their styling lives in `src/styles/dashboard-atoms.css`
  (extracted FROM apps/notebook-cloud/viewer/index.css, which now @imports it) -
  the same shared-surface pattern as ansi.css/comment-affordance.css. css-entry
  @imports it and @sources src/components/runtime + the single
  NotebookCompositionTicks.tsx (NOT all of components/notebook - NotebookCommentsPanel
  stays deferred with the katex pass).
- LanguageMark's Marks story needed cardMode: column (five chips run wide).
- NotebookCommentsPanel unlock (katex pass) will join the notebook group.

## Groups + curated lists
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
