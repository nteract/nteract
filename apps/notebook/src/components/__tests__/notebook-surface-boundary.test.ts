import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe("notebook-surface render boundary", () => {
  const sourceText = readFileSync(
    join(process.cwd(), "apps/notebook/src/notebook-surface.ts"),
    "utf8",
  );
  const renderSurfaceComponentPaths = [
    "apps/notebook/src/components/NotebookView.tsx",
    "apps/notebook/src/components/CodeCell.tsx",
    "apps/notebook/src/components/MarkdownCell.tsx",
    "apps/notebook/src/components/RawCell.tsx",
  ] as const;

  it("exports the production render surface without app materialization glue", () => {
    expect(sourceText).toContain("Render-only notebook surface");
    expect(sourceText).toMatch(/export \{ CodeCell, type HiddenGroupCellSummary \}/);
    expect(sourceText).toMatch(/export \{ MarkdownCell \}/);
    expect(sourceText).toMatch(/export \{ NotebookView, type NotebookViewProps \}/);
    expect(sourceText).toMatch(/export \{ RawCell \}/);

    expect(sourceText).not.toContain("materializeChangeset");
    expect(sourceText).not.toContain("frame-pipeline");
    expect(sourceText).not.toMatch(/from\s+["'][^"']*runtimed-wasm/);
    expect(sourceText).not.toContain("useAutomergeNotebook");
    expect(sourceText).not.toContain("NotebookHandle");
  });

  it("keeps render components on the shared presence context", () => {
    for (const componentPath of renderSurfaceComponentPaths) {
      const componentSource = readFileSync(join(process.cwd(), componentPath), "utf8");

      expect(componentSource).not.toContain("../contexts/PresenceContext");
      expect(componentSource).toContain("@/components/notebook/presence-context");
    }
  });
});
