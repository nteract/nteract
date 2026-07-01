# Shared UI Primitives via Monorepo Aliasing

**Status:** Draft, 2026-07-01.

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

Do not create a new package and do not copy components. **Alias sift at the
app's literal components in the monorepo.** Add an `@` → repo `src` alias to
sift's TypeScript and Vite configs, point sift's primitive imports at
`@/components/ui/*` (the same specifier the app uses), delete sift's duplicate
copies, and feed sift the app's token CSS so the shared primitives render with
our palette.

`src/components/ui/*` stays the single source of truth. It is already the
design-sync surface; now sift consumes the same files. A primitive is edited once
and every consumer — app, sift, and the guide — moves together.

This is the general rule for the monorepo: **share UI by aliasing the real
source, not by per-package copies.** A future package that needs a primitive
aliases `@/components/ui/*` rather than vendoring its own.

## Scope of the sift migration

Small and contained — only two real consumers:

- `sparkline.tsx` imports `Popover*` from sift's `ui/popover` → `@/components/ui/popover`.
- `image-viewer.tsx` imports `Button` from sift's `ui/button` → `@/components/ui/button`.
- sift's `ui/context-menu.tsx` is dead (nothing imports it) — delete.
- sift's `lib/utils.ts` (`cn`) is byte-identical to the app's and, after the swap,
  has no consumers — delete; the app components bring `@/lib/utils` through the alias.

Plumbing:

- `tsconfig.json`: add `"@/*": ["../../src/*"]` to `paths`.
- `vite.config.ts` + `vite.lib.config.ts`: add `"@": resolve(__dirname, "../../src")`
  to `resolve.alias` (safe next to `sift-wasm`; the `@` alias matches `@/…` only,
  not `@radix-ui/…`).
- `style.css`: `@import` the app token CSS (`../../src/styles/notebook-tokens.css`)
  and `@source "../../src/components/ui"` so Tailwind compiles the utility classes
  the aliased components use.

## Consequences

- **Single source of truth.** Sift and the app can no longer drift on primitives.
- **Sift adopts our palette.** The shared primitives render with our monochrome
  primary in place of sift's prototype blue — the intended "feels native." Visible
  change to sift; worth a look before it ships.
- **Contained blast radius.** No repo-wide rewrite; two import swaps, four deletes,
  three config edits. Verified by sift's own `tsc`, `build:lib`, unit, and e2e.

## Follow-up (not this pass)

- Sift's own engine chrome (`sparkline.tsx` histograms/category bars,
  `column-context-menu`) still uses `--sift-*`. Unifying those tokens with ours —
  or aliasing `--sift-*` to the shared tokens — is the next step toward full native
  feel. It is engine styling, not shared primitives, so it is separable.
- Dark mode: the app is class-based (`.dark`); sift's themes are
  `prefers-color-scheme`. Reconcile so the iframe follows the app's theme.

## Non-goals

- Extracting sift's crossfilter engine, column-summary rendering, or filter UI.
  That is engine code, not reusable UI, and stays in sift.
