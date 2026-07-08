# shadcn AI Elements + Vercel-aligned registries: an nteract adoption plan

Status: research / options. 2026-07-07.

Vercel's [AI Elements](https://elements.ai-sdk.dev) is a shadcn-compatible registry of ~50 components built for agent UIs: a chatbot family (Message, Reasoning, Tool, Task, Prompt Input, Model Selector), a code family (Code Block, Terminal, Stack Trace, Test Results, Package Info, File Tree, Schema Display), plus voice and workflow-graph families. Several of the code-family components overlap nteract's real output surfaces directly. This memo says what to take, what to leave, and how to take it without breaking our token discipline.

**The recommendation in one line:** consume the *canonical shadcn primitives* (Separator, Skeleton, Spinner, Kbd, Tooltip, Empty) through the shadcn CLI as we already do; treat *AI Elements components* as vetted UX patterns to hand-port and re-tokenize, never as a dependency to install verbatim.

## How the registry works

- **Install:** `npx shadcn@latest add @ai-elements/<name>` (or `npx ai-elements@latest add <name>`). Registry served from `elements.ai-sdk.dev/api/registry/`.
- **Integration model:** shadcn-style vendoring. The CLI copies component *source* into the repo (default `components/ai-elements/<name>.tsx`), pulls its `registryDependencies` (other shadcn primitives) the same way, and adds its runtime `dependencies` (streamdown, ai-sdk, lucide-react) to `package.json`. Same "copied code, not a black-box dep" model as our `src/components/ui`.
- **Theming:** rides entirely on shadcn's existing CSS variables (`--background`, `--primary`, `--popover`, ...). No parallel token namespace. That means it inherits our already-synced Elements/Claude Design tokens for free, which is a genuine structural fit.
- **License:** Apache-2.0. **Prereq:** Tailwind v4 (we are on v4).

## Why not run the CLI straight into `src/components/ui`

AI Elements source ships Tailwind classes and, for Code Block, **Shiki syntax colors** tuned to its own look, not our `--ct-*`/`--k-*`/`--sev-*` vocabulary. Dropped in unmodified it would fail the `component-chroma-boundary` ratchet and the design-sync build (unregistered group / `componentSrcMap`) on first run. The port checklist for any AI Elements component:

1. Fetch into a scratch location, never straight into `src/components/ui/`.
2. Re-tokenize every color class to `--ct-*`/`--k-*`/`--sev-*`.
3. For Code Block/Tool: build a **custom Shiki theme from nteract's palette** instead of accepting stock Shiki colors. (The ratchet only catches Tailwind utilities, not the inline hex Shiki emits, so a naive port passes the automated gate while still violating the token law. This is the single biggest landing risk.)
4. Strip `"use client"`; backport to the repo's `forwardRef` + `displayName` convention.
5. Register in design-sync's `build.mjs` group / `componentSrcMap`.
6. Run `component-chroma-boundary` as the actual landing gate. Never add a file to `RATCHET_RAW_PALETTE_FILES` to make an import pass; that list is debt to shrink.

For the plain shadcn primitives, our documented flow (`pnpm dlx shadcn@latest add <c> -yo`, then strip `"use client"`) is fine. One caveat: **shadcn now defaults new installs to Base UI**, so force the Radix variant / scoped `@radix-ui/react-*` package to stay on the one primitive runtime our other 18 primitives use.

## Immediate canonical primitives

| Primitive | Verdict | Notes |
| --- | --- | --- |
| Separator | add-now | Zero cost. `bg-border` is our `--border` token. Scoped `@radix-ui/react-separator`. |
| Skeleton | shipped (#3964) | Added with the ratified shimmer (gradient sweep, `color-mix` on `--muted-foreground`), not stock `animate-pulse`; `CellSkeleton` migrated onto it. |
| Spinner | add-now | Colorless (`currentColor`), `lucide-react` already a dep. Add a small `cva` size variant; law demotes spinner to tight-space fallback. |
| Kbd | add-now | `bg-muted`/`text-muted-foreground` exist. Fix upstream's `<kbd>`-nested-in-`<kbd>`; preserve the `data-slot="tooltip-content"` coupling if Tooltip lands. |
| Tooltip | needs Kyle | No token gap, but a real call: upstream's inverted `bg-foreground/text-background` vs the `--popover` pair the rest of the overlay stack uses. Also needs a `TooltipProvider` mount point in the app root. |
| Empty (EmptyState) | needs Kyle | Tokens trivial, but `EmptyMedia`'s `size-10 rounded-lg` icon badge needs an explicit radius-law exemption before landing. Backs page-level empty states (no cells / comments / workstations). |

## AI Elements worth porting (ranked)

| Component | nteract surface | Mode | Why |
| --- | --- | --- | --- |
| **Code Block** | `apps/mcp-app` code renderer (today a bare unstyled `<pre>`, zero highlighting) | adapt-to-tokens | Fixes a real shipping gap: the MCP Apps widget agent hosts render after every tool call has no syntax highlighting. Needs a custom Shiki theme from our palette. |
| **Task** | run-all progress; MCP tool-call transcript | adapt-to-tokens | No component exists for either; collapsible per-step status list maps both. Route status icons to `--k-*`. |
| **Tool** | `apps/mcp-app` Cell renderer (already a de-facto Tool shape) | adapt-to-tokens | Convergence/refinement of load-bearing production code, not a net-new build. |
| **Stack Trace** | `outputs/traceback-output.tsx` (experimental) | adapt-to-tokens | Frame-dim/collapse/copy is a real upgrade. Swap the Node/V8 parser for Python-traceback-aware; keep the one sanctioned failing-line left rule. |
| **Package Info** | `environment/EnvironmentPackageSummaryPanel.tsx` | adapt-to-tokens | Version-diff badges over a flat list; we already have the `manage_dependencies` data. Remap added/removed/changed to `--sev-*`. |
| **Queue** | `CellQueued` pending cells | adapt-to-tokens | Likely just a filtered view of Task once Task lands. |
| **Test Results** | structured pytest/unittest output (today raw stdout) | adapt-to-tokens | Real gap, no demand yet; needs a test-output MIME/heuristic first. |
| **Terminal** | `outputs/ansi-output.tsx` | reference-only | Ours works, is theme-aware, and carries the one sanctioned raw-palette exemption. Mirror the affordances (autoscroll/clear/copy), don't replace the engine. |
| **Shimmer** | streaming text / AI-cell thinking | reference-only (blocked) | Distinct from the block Skeleton. A *text* shimmer for streaming output; gated on the gradient-law question below. |
| **Message / Reasoning / Model Selector** | future AI cell | reference-only | Gated on the AI cell graduating from a gutter-color placeholder to a composed surface. Reuse the comments `isAgent`/`onBehalfOf` attribution when it does. |

**Skip:** the entire Voice and Workflow-graph families (no surface), Commit / JSX Preview / Schema Display / Checkpoint / Confirmation / Context / Sources / Inline Citation / Attachments / Suggestion / Chain of Thought (speculative, no host surface), File Tree (our only tree is a heading outline, not a filesystem browser). No additional registries (kibo-ui, Tremor, Aceternity, Origin UI) are needed; the shadcn + AI Elements path covers every confirmed gap.

## Ordered plan

Autonomous (no design call): **1** Separator. **2** Skeleton (done, #3964). **3** Spinner. **6** Code Block into mcp-app (highest-value AI Elements pull). **7** Task for run-all + tool-call transcript, folding Queue in. **12** Package Info version-diff badges.

Needs Kyle: **4** Tooltip surface tokens + provider mount, then Tooltip + Kbd together. **5** Empty's icon-badge radius exemption, then Empty for page-level empties. **8** the convergence call (below) gates **9** Stack Trace. **10** the Shimmer/gradient-law call. **11** the AI-cell roadmap gates Message/Reasoning/Model Selector.

## Open questions for Kyle

1. **Shimmer / gradient law:** convention 6 already mandates skeleton shimmer (a gradient sweep), and #3964 sanctions that in the exceptions list. Separate question: is AI Elements' gradient-sweep *text* shimmer for streaming output worth a further allow-list entry, or does streaming stay pulse/other?
2. **Tooltip tokens:** align `TooltipContent` to `--popover`/`--popover-foreground` (matching Dialog/Popover) or ship upstream's inverted `bg-foreground/text-background`?
3. **Empty icon badge:** is `size-10 rounded-lg` an acceptable radius-law exemption, or reshape to `rounded-md`?
4. **Convergence:** should our output renderers (Terminal, Stack Trace, Test Results) visually converge toward the AI Elements look over time, or does AI Elements stay strictly a pattern reference while the sanctioned token-native renderers stay as-is?
5. **AI cell roadmap:** when does the AI cell graduate from gutter-color placeholder to a composed surface? That gates Message/Reasoning/Prompt Input/Model Selector past reference-only.
6. **mcp-app theming boundary:** should the MCP Apps widget (rendered inside third-party chat hosts) share our full token system, or a lighter host-neutral palette, since it lives in someone else's chrome?

## Risks

- Shiki/inline-hex leakage passes the ratchet but violates the token law in spirit; the port must re-theme Shiki, not just re-class Tailwind.
- design-sync breakage for any `src/components/ui` file not registered in `build.mjs`; multi-export files need `componentSrcMap` pinning.
- Radix-vs-Base-UI drift on bare `shadcn add`; always force the Radix variant.
- `pnpm --dir apps/notebook build` (tsc -b) is required beyond `vp check`/vitest to catch vendored-component type errors.
- Streamdown (Message's markdown dep) would duplicate our markdown pipeline; a deliberate replace-vs-coexist call if Message is ever pulled.
