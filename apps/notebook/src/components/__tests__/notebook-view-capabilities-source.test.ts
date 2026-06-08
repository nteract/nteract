import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe("NotebookView shell capabilities", () => {
  it("derives edit, structure, and execute affordances from shared shell capabilities", () => {
    const sourceText = readFileSync(
      join(process.cwd(), "apps/notebook/src/components/NotebookView.tsx"),
      "utf8",
    );

    expect(sourceText).toMatch(/capabilities\?: NotebookShellCapabilities;/);
    expect(sourceText).toMatch(/capabilities\?\.canEditCells \?\? !readOnly/);
    expect(sourceText).toMatch(/capabilities\?\.canEditMarkdown \?\? !readOnly/);
    // Structure-edit gating now lives in computeCanMutateCells (see
    // notebook-view-mutation-gate.test.ts for the behavioral truth table).
    // NotebookView must still route through that helper with the host gate,
    // capabilities, and readOnly fallback.
    expect(sourceText).toMatch(
      /canMutateCells = computeCanMutateCells\(\{ canAcceptCellMutations, capabilities, readOnly \}\)/,
    );
    expect(sourceText).toMatch(/capabilities\?\.canExecute \?\? !readOnly/);
    expect(sourceText).toMatch(/<CodeCell[\s\S]*canExecute=\{canExecuteCells\}/);
    expect(sourceText).toMatch(/<MarkdownCell[\s\S]*readOnly=\{!canEditMarkdownSources\}/);
    expect(sourceText).toMatch(
      /onDelete=\{canMutateCells \? \(\) => onDeleteCell\(cell\.id\) : undefined\}/,
    );
    expect(sourceText).toMatch(
      /onInsertCellAfter=\{canMutateCells \? \(\) => onAddCell\("markdown", cell\.id\) : undefined\}/,
    );
    expect(sourceText).toMatch(/canMutateCells && onSetCellSourceHidden/);
    expect(sourceText).toMatch(/canMutateCells && onSetCellOutputsHidden/);
  });

  it("keeps the cell DOM branch stable while toggling structure mutation capabilities", () => {
    const sourceText = readFileSync(
      join(process.cwd(), "apps/notebook/src/components/NotebookView.tsx"),
      "utf8",
    );

    expect(sourceText).toMatch(/<DndContext[\s\S]*<SortableContext[\s\S]*stableDomOrder\.map/);
    expect(sourceText).toMatch(/disabled: !canMutateCells/);
    expect(sourceText).toMatch(/canMutateCells && index === 0/);
    expect(sourceText).not.toContain("function StaticCell");
  });

  it("does not arm tail-pinned scrolling before cells materialize", () => {
    const sourceText = readFileSync(
      join(process.cwd(), "apps/notebook/src/components/NotebookView.tsx"),
      "utf8",
    );

    expect(sourceText).toMatch(
      /if \(cellIdsRef\.current\.length === 0\) \{[\s\S]*tailPinnedRef\.current = false;[\s\S]*return;/,
    );
  });

  it("routes in-place code execution away from tail-follow scrolling", () => {
    const sourceText = readFileSync(
      join(process.cwd(), "apps/notebook/src/components/NotebookView.tsx"),
      "utf8",
    );

    expect(sourceText).toMatch(
      /const suppressTailFollowForInPlaceExecution = useCallback\(\(\) => \{[\s\S]*tailPinnedRef\.current = false;[\s\S]*cancelTailScrollFrame\(\);[\s\S]*\},/,
    );
    expect(sourceText).toMatch(/onExecute=\{executeCellOrHiddenGroup\}/);
    expect(sourceText).toMatch(/onExecuteInPlace=\{executeCellInPlaceOrHiddenGroup\}/);
  });

  it("does not create cells from a transient empty sync state", () => {
    const sourceText = readFileSync(
      join(process.cwd(), "apps/notebook/src/components/NotebookView.tsx"),
      "utf8",
    );

    expect(sourceText).not.toContain("Auto-seed first cell");
    expect(sourceText).not.toContain("didAutoSeed");
    expect(sourceText).toMatch(/data-notebook-synced=\{!isLoading && !loadError\}/);
  });

  it("does not install code execution keybindings when execution is unavailable", () => {
    const sourceText = readFileSync(
      join(process.cwd(), "apps/notebook/src/components/CodeCell.tsx"),
      "utf8",
    );

    expect(sourceText).toMatch(/canExecute\?: boolean;/);
    expect(sourceText).toMatch(/onExecute: canExecute \? handleExecute : undefined/);
    expect(sourceText).toMatch(/onExecuteAndInsert:\s+canExecute && onInsertCellAfter/);
    expect(sourceText).toMatch(/canExecute=\{canExecute\}/);
    expect(sourceText).toMatch(/showReadoutWhenDisabled=\{!readOnly\}/);
  });
});
