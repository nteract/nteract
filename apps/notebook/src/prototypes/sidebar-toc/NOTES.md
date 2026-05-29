# Notebook Sidebar ToC Prototype

Question: can a notebook reading sidebar support table-of-contents navigation now, while leaving clear room for variables and package panels later?

Run with:

```bash
pnpm prototype:sidebar-toc
```

Open:

```text
http://127.0.0.1:5175/prototypes/sidebar-toc/?variant=A
```

Variants:

- `A`: activity rail plus fixed outline panel.
- `B`: compact rail plus wider inspector panel with outline, packages, and variables in one surface.
- `C`: document navigator with a mini-map style outline and a collapsed notebook chrome.

Verdict: prefer variant `A`, the rail outline.

Why this direction:

- It keeps reading/navigation visible without making variables, packages, and future panels compete for the same always-open surface.
- It matches the old `intheloop` mental model: a narrow desktop rail, an active-panel registry, conditional items, and mobile fallback navigation.
- It keeps the notebook cell DOM owned by `NotebookView`; the sidebar can live in a workspace shell around it instead of disturbing stable cell order or iframe output preservation.

First app slice:

- Add a real `NotebookWorkspace`/`NotebookSidebar` shell around the existing notebook view.
- Start with `outline` as the only production panel, backed by headings parsed from materialized markdown cells and code-cell section comments if we decide to support them.
- Model the rail as configuration plus panel registry: `outline`, then `packages`, then `variables`. Keep runtime/debug/help/AI-style panels out of the first slice unless a current workflow needs them.
- Pass a notebook scroll container ref or a small `scrollToCell(cellId)` handle into the outline panel. Do not let the sidebar own notebook rendering or cell ordering.
- Mobile should collapse to a bottom nav or sheet; the desktop rail can stay around 48px wide with a 280-320px panel.

Runtime-free prototype path:

- Keep prototype routes importing shared UI primitives and pure presentation components only.
- Avoid `App.tsx`, `useAutomergeNotebook`, `usePresence`, `CrdtBridgeProvider`, and generated `runtimed-wasm` imports.
- Use fixtures/adapters for cells, outline entries, package rows, variable rows, output manifests, and markdown rendering.
- As app components become pure enough, promote them into `src/components/**` and make both the real app and prototype/docs import the same component.

Rendering and docs infra:

- `nteract/nteract` is the canonical home for notebook UI and rendering work. This repo is now ahead of `nteract/elements`, so do not pull components from `nteract/elements`.
- Use `nteract/elements` only as inspiration for documentation shape, examples, registry/docs organization, and migration history.
- Add a first-class Fumadocs site in this repo, preferably as a separate `apps/docs` workspace instead of bundling docs infra into `apps/notebook`. That keeps Fumadocs/MDX/search dependencies out of the desktop app while letting docs import local notebook rendering primitives and fixtures.
- The docs site should publish directly from this repo and make `nteract/nteract` the durable URL/source of truth. Once this is good enough, the old `nteract/elements` repo can be archived or redirected.
- Fumadocs can support either a Next.js docs app or a Vite MDX integration. The Next.js path is probably cleaner for docs UI/search/publishing; the Vite path is useful if we want docs-like MDX pages inside an existing Vite harness.

Open questions before real implementation:

- Should outline headings come only from markdown headings, or should code comments/cell metadata also generate sections?
- Should package and variable panels be read-only at first, or should package installs and variable inspection ship in the same shell work?
- Which `nteract/elements` pages/examples are worth recreating first before archiving or redirecting the old repo?
