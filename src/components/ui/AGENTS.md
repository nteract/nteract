# UI components (Shadcn + nteract)

Scope: `src/components/ui/**`, `src/components/cell/**`, `src/components/editor/**`, `src/components/outputs/**`.

## Project structure

```
/
├── components.json          ← shadcn configuration
├── tailwind.config.js       ← Tailwind config (covers src/ and apps/)
├── src/
│   ├── components/
│   │   ├── ui/              ← Shared shadcn primitives (Button, Dialog, etc.)
│   │   ├── cell/            ← Cell container, controls, execution count
│   │   ├── editor/          ← CodeMirror wrappers, extensions, themes
│   │   ├── outputs/         ← Output renderers (MediaRouter, AnsiOutput, etc.)
│   │   ├── comments/        ← Commenting UI
│   │   ├── environment/     ← Runtime/package UI
│   │   ├── isolated/        ← Isolated iframe renderer
│   │   ├── markdown/        ← Markdown rendering
│   │   ├── notebook/        ← Notebook-level UI
│   │   ├── notebook-rail/   ← Notebook rail components
│   │   └── widgets/         ← Widget rendering
│   └── lib/utils.ts         ← cn() utility
└── apps/
    └── notebook/            ← Uses @/components/* via path alias
```

The notebook app accesses shared components via `@/` which resolves to `../../src/` in `apps/notebook/tsconfig.json`.

## Editing components

Edit files in `src/components/` directly. These are local source files owned by this repo. When adding new shadcn primitives, use:

```bash
pnpm dlx shadcn@latest add <component> -yo
```

After installing or updating a shadcn component, remove the `"use client"` directive (irrelevant for Tauri, causes warnings in the isolated renderer build):

```bash
grep -rl '"use client"' src/ | xargs -I {} sed -i '' '/^"use client";$/d' {}
```

## Shared utilities

| Utility | Location | Purpose |
|---------|----------|---------|
| `isDarkMode()` | `@/lib/dark-mode` | Theme detection |
| `ErrorBoundary` | `@/lib/error-boundary` | Fault isolation with resetKeys |
| `cn()` | `@/lib/utils` | Class name merging (clsx + tailwind-merge) |

## Dynamic imports in widgets

Some widget components use dynamic imports Vite cannot analyze. Add `/* @vite-ignore */` to suppress warnings:

```tsx
return import(/* @vite-ignore */ esm);
```

## Troubleshooting

**CSS variables not applying:** Ensure relevant CSS files are imported in `src/index.css`. Verify `.dark` selector matches your dark mode implementation.

**Build errors after shadcn update:** Run `tsc -b` to catch TypeScript errors. Common: missing imports, path mismatches, type mismatches from prop changes.

Use `pnpm` as the package manager for shadcn operations.
