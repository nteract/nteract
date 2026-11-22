# Shared UI Primitives via Monorepo Aliasing

**Status:** Accepted, 2026-07-01. Implemented in #3872 (shared primitives via
aliasing, engine-token unification, explicit-signal dark mode).

## Context

The shadcn-style UI primitives (Button, Popover, ContextMenu, …) had started to
exist in more than one place:

- `src/components/ui/*` is the app's primitive library and the surface the
  design-sync converter ships to Claude Design (the "nteract Elements" guide).
  These use our semantic design tokens (`bg-primary`, `border-input`, `ring`),
  backed by the oklch `--primary`/`--background`/… set in
  `src/styles/notebook-tokens.css`.
- `packages/sift/src/components/ui/{button,context-menu,popover}.tsx` were
  structurally identical shadcn copies sift carried over from its prototype
  (`rgbkrk/sift`), wired to sift's own `--sift-{accent,ink,panel,rule,bg}` tokens
  (a blue accent) in `packages/sift/src/themes/*`.

Same component, maintained twice, rendered differently because each resolved a
different token set. Every primitive change became whack-a-mole across copies.

Two facts shape the fix:

- **Nothing here is a published library.** We ship built apps (desktop, cloud),
  not packages. So there is no package-boundary contract to preserve between the
  app and sift — they are all bundled into the same built apps. Sharing by direct
  source reference is fine and preferred.
- **sift is bundled and iframed, but should feel native.** The app renders
  `SiftTable` in an isolated iframe (`src/isolated-renderer/sift-renderer.tsx`),
  but it should look and behave like the rest of the app, not like a separate
  widget with its own accent.

## Decision

Do not create a new package and do not copy components. **Sift aliases the
app's literal components in the monorepo.** Sift's TypeScript and Vite configs
map `@` → repo `src`, primitive imports resolve `@/components/ui/*` (the same
specifier the app uses), duplicate sift copies are removed, and sift imports the
app's token CSS so shared primitives render with our palette.

`src/components/ui/*` is the single source of truth. It is already the
design-sync surface; sift consumes the same files. A primitive is edited once
and every consumer — app, sift, and the guide — moves together.

This is the general rule for the monorepo: **share UI by aliasing the real
source, not by per-package copies.** Any future package that needs a primitive
aliases `@/components/ui/*` rather than vendoring its own.

## Sift wiring rules

Sift consumes shared primitives directly through the `@` alias:

- `sparkline.tsx` imports `Popover*` from `@/components/ui/popover`.
- `image-viewer.tsx` imports `Button` from `@/components/ui/button`.
- Sift keeps no local copies of `ui/context-menu.tsx`, `ui/button.tsx`,
  `ui/popover.tsx`, or `lib/utils.ts` (`cn`). Aliased primitives bring
  `@/lib/utils` through `@`.
- `tsconfig.json` maps `"@/*": ["../../src/*"]` in `paths`.
- `vite.config.ts` and `vite.lib.config.ts` map `"@": resolve(__dirname, "../../src")`
  in `resolve.alias`. This matches `@/…` only and leaves `sift-wasm` and
  `@radix-ui/…` untouched.
- `style.css` imports `../../src/styles/notebook-tokens.css` and declares
  `@source "../../src/components/ui"` so Tailwind compiles utility classes used
  by aliased components.

## Consequences

- **Single source of truth.** Sift and the app can no longer drift on primitives.
- **Sift adopts our palette.** Shared primitives render with our monochrome
  primary in place of sift's prototype blue so sift feels native inside the app.
- **Contained blast radius.** Sift validates this wiring through its own `tsc`,
  `build:lib`, unit, and e2e checks without a repo-wide rewrite.

## Engine tokens and dark mode

The second stage of the same decision, applied to sift's engine chrome:

- The five neutral `--sift-*` tokens alias the app's semantic tokens in
  `themes/classic.css` (`--sift-bg` → `--background`, `--sift-panel` → `--card`,
  `--sift-ink` → `--foreground`, `--sift-muted` → `--muted-foreground`,
  `--sift-rule` → `--border`); their dark values are gone because the app token
  flip covers them.
- `--sift-accent` stays a sift-owned token, retuned to the app's output-link
  blues. Every app semantic token except `--destructive` is achromatic; aliasing
  the accent would flatten histograms, filter pills, and sort arrows to gray.
  Boolean green/red stays sift-owned for the same reason — the app has no
  success/positive token (a candidate addition if more data-viz surfaces need it).
- Dark mode is explicit-signal only: the token file's dark block is dual-keyed
  (`.dark, [data-theme="dark"]`), matching the isolated-renderer/frame.html
  convention, and sift's `prefers-color-scheme` blocks are deleted. Every host
  (app iframe, sift demo) sets an explicit signal; OS-only theming would
  split-brain aliased neutrals against sift-owned dark values.

## Non-goals

- Extracting sift's crossfilter engine, column-summary rendering, or filter UI.
  That is engine code, not reusable UI, and stays in sift.
