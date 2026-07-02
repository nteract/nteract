# Building with nteract Elements

nteract Elements is a shadcn-style React component library (Radix primitives + Tailwind v4
tokens) for the nteract notebook environment. Components are exported from
`window.NteractElements.*` (import them by name, e.g. `Button`, `Dialog`, `Select`).

## Setup — no provider required

Components are self-contained and already styled by the design system's tokens; there is no
`ThemeProvider` or context wrapper to mount. Two things to know:

- **Dark mode** is class-based. Put `class="dark"` on any ancestor (usually `<html>` or a
  root `<div>`) to switch the whole subtree to the dark token set. No prop, no toggle
  component required (a presentational `ThemeToggle` exists for the control itself).
- **Icons** are [lucide-react](https://lucide.dev). Pass them as children where the examples
  do; Button auto-sizes an icon child to 16px.

## Styling idiom — Tailwind utilities over DS tokens

Style with Tailwind utility classes bound to the design system's semantic tokens. Never
hardcode hex colors; use the token utilities so light/dark and theming stay correct:

| Role | Utilities |
|---|---|
| Surface | `bg-background` / `text-foreground`, `bg-card`, `bg-popover` |
| Primary action | `bg-primary` / `text-primary-foreground` |
| Secondary / muted | `bg-secondary` / `text-secondary-foreground`, `bg-muted` / `text-muted-foreground` |
| Accent (hover/active) | `bg-accent` / `text-accent-foreground` |
| Destructive | `bg-destructive` / `text-destructive-foreground` |
| Borders / focus | `border-border`, `border-input`, `ring-ring` |
| uv tooling ONLY | `bg-uv` / `text-uv` - the uv package manager's brand magenta, reserved for uv-specific environment UI and current-user identity marks. NEVER a page accent, button color, or brand moment |
| Radius | `rounded-sm` · `rounded-md` · `rounded-lg` (scale off `--radius`) |

The brand voice is neutral: `--primary` and `--accent` are grayscale (zero-chroma oklch),
so brand moments come from type weight, spacing, and near-black/near-white contrast - not
hue. Chromatic color always carries a specific meaning: cell types (`--ct-*` ticks),
kernel states (`--k-*` dots), live presence green (`--live`), destructive red, language
marks. If you reach for a saturated color as decoration, stop - use `bg-primary` or
`bg-muted` instead.

Do layout with plain Tailwind (`flex`, `gap-2`, `grid`, spacing). Reach for a component's
own `variant`/`size` props before restyling it — e.g. `<Button variant="destructive"
size="sm">`, `<Badge variant="outline">`.

**Groups.** Six groups: the **general** UI primitives; **Cells** — notebook cell primitives
(CellContainer, CellInsertionRibbon, CodeCellCurrentLine, CompactExecutionButton,
ExecutionCount, CellPresenceIndicators, CellSkeleton); **Outputs** — owned output renderers
(AnsiOutput, AnsiStreamOutput, AnsiErrorOutput, JsonOutput, TracebackOutput) that take kernel
output data as props; **Comments** — comment affordances (CommentSelectionAffordance,
CommentMarkIcon); **Notebook** — NotebookCompositionTicks, the per-cell composition
fingerprint (`composition={{ code, markdown, raw }}` — those are the only cell kinds); and
**Runtime** — RuntimeStatusDot (`status`: executing/ready/starting/stale/error/none, optional
`showLabel`) and LanguageMark (`language`: "Python" renders the real mark, anything else an
identity dot). Everything is prop-driven: runtime/execution state enters as explicit props
(`count`, `isExecuting`, `isQueued`, `isErrored`, `cellType`, `isFocused`), never through
hooks. Comment affordances take author color from `--comment-author-color` and readable label
color from `--comment-author-contrast`. Use these to assemble notebook and dashboard surfaces;
cell identity and DOM ordering stay outside the components.

**Compound components** (Dialog, Select, DropdownMenu, ContextMenu, Popover, HoverCard,
Sheet, Tabs, Accordion, Command, RadioGroup, ToggleGroup) are composed from named subparts
imported alongside the root — `Dialog` + `DialogTrigger` + `DialogContent` + `DialogHeader`
+ `DialogTitle` + `DialogFooter`, etc. Each component's `.prompt.md` shows the exact
composition and its `<Name>.d.ts` (`<Name>Props`) is the API contract.

## Where the truth lives

Read `styles.css` (and the `@import`ed token layer) for the full token set, and each
component's per-component `.prompt.md` + `.d.ts` before composing it. The previews are real
renders of the shipped components — mirror their composition.

## One idiomatic example

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
         DialogFooter, DialogClose, Button } from "nteract Elements";

function RestartKernelDialog({ open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restart kernel?</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            This clears every variable held in memory.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex justify-end gap-2">
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <DialogClose asChild><Button variant="destructive">Restart</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```
