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
    expect(sourceText).toMatch(
      /capabilities\?\.canEditStructure \?\? \(canAcceptCellMutations && !readOnly\)/,
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

  it("does not install code execution keybindings when execution is unavailable", () => {
    const sourceText = readFileSync(
      join(process.cwd(), "apps/notebook/src/components/CodeCell.tsx"),
      "utf8",
    );

    expect(sourceText).toMatch(/canExecute\?: boolean;/);
    expect(sourceText).toMatch(/onExecute: canExecute \? handleExecute : undefined/);
    expect(sourceText).toMatch(/onExecuteAndInsert:\s+canExecute && onInsertCellAfter/);
    expect(sourceText).toMatch(/canExecute=\{canExecute\}/);
  });
});
