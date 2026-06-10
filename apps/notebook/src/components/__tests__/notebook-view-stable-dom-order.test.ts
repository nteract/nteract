import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * CI guard for the stable DOM order invariant (punchlist FSB-2).
 *
 * NotebookView renders cells in stable sorted-ID DOM order and positions
 * them visually with CSS `order` inside a flex column. The invariant lives
 * in three places that must all hold together — regressing any one of them
 * silently reintroduces React `insertBefore` on reorder, which destroys
 * output iframes (white flashes, lost widget state). See CLAUDE.md
 * § "Cell list uses stable DOM order" and frontend-sync-bridge.md
 * Decision 2.
 *
 * This is a source-shape guard, not a behavior test: jsdom cannot observe
 * iframe teardown, so the load-bearing truth is pinned at the source level
 * (same pattern as notebook-view-capabilities-source.test.ts).
 */
describe("NotebookView stable DOM order invariant (FSB-2)", () => {
  const sourceText = readFileSync(
    join(process.cwd(), "apps/notebook/src/components/NotebookView.tsx"),
    "utf8",
  );

  it("renders cells from the sorted stableDomOrder memo, not cellIds", () => {
    // Site 1: the memo that fixes DOM order independent of visual order.
    expect(sourceText).toMatch(/stableDomOrder = useMemo\(\(\) => \[\.\.\.cellIds\]\.sort\(\)/);
    // The cell list must map over stableDomOrder. Mapping over cellIds
    // directly would tie DOM order to visual order and break the invariant.
    expect(sourceText).toMatch(/\{stableDomOrder\.map\(\(cellId\) =>/);
    expect(sourceText).not.toMatch(/\{cellIds\.map\(\(cellId\) =>/);
  });

  it("positions each cell visually with CSS order", () => {
    // Site 2: per-cell style carries `order: index` so visual position is
    // CSS-driven while DOM position stays fixed.
    expect(sourceText).toMatch(/order: index,/);
  });

  it("wraps the cell list in a flex column so CSS order applies", () => {
    // Site 3: CSS `order` only affects layout inside a flex/grid container.
    expect(sourceText).toMatch(
      /<div style=\{\{ display: "flex", flexDirection: "column" \}\}>\s*\{stableDomOrder\.map/,
    );
  });
});
