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
    expect(sourceText).toMatch(/onRequestExecuteCell\?: \(cellId: string\) => void;/);
    expect(sourceText).toMatch(/onRequestExecute=\{requestExecuteCellOrHiddenGroup\}/);
    expect(sourceText).toMatch(/<MarkdownCell[\s\S]*readOnly=\{!canEditMarkdownSources\}/);
    expect(sourceText).toMatch(
      /onDelete=\{canMutateCells \? \(\) => handleDeleteCell\(cell\.id\) : undefined\}/,
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

  it("does not route cell deletion through tail-follow scrolling", () => {
    const sourceText = readFileSync(
      join(process.cwd(), "apps/notebook/src/components/NotebookView.tsx"),
      "utf8",
    );

    expect(sourceText).toMatch(/const previousCellCountRef = useRef\(cellIds\.length\);/);
    expect(sourceText).toMatch(
      /interface PendingNotebookScrollAnchorRestore \{[\s\S]*deletedCellId: string;[\s\S]*sourceCellIds: readonly string\[\];[\s\S]*snapshot: NotebookScrollAnchorSnapshot;/,
    );
    expect(sourceText).toMatch(
      /const pendingScrollAnchorRef = useRef<PendingNotebookScrollAnchorRestore \| null>\(null\);/,
    );
    expect(sourceText).toMatch(
      /const handleDeleteCell = useCallback\([\s\S]*tailPinnedRef\.current = false;[\s\S]*cancelTailScrollFrame\(\);[\s\S]*const sourceCellIds = cellIdsRef\.current;[\s\S]*const snapshot = captureCellDeletionScrollAnchor\(containerRef\.current, sourceCellIds, cellId\);[\s\S]*pendingScrollAnchorRef\.current = snapshot[\s\S]*onDeleteCell\(cellId\);/,
    );
    expect(sourceText).toMatch(
      /useLayoutEffect\(\(\) => \{[\s\S]*const pending = pendingScrollAnchorRef\.current;[\s\S]*if \(cellIds === pending\.sourceCellIds\) return;[\s\S]*pendingScrollAnchorRef\.current = null;[\s\S]*if \(cellIds\.includes\(pending\.deletedCellId\)\) return;[\s\S]*restoreScrollAnchor\(containerRef\.current, pending\.snapshot\);[\s\S]*\}, \[cellIds\]\);/,
    );
    expect(sourceText).toMatch(
      /if \(shouldTailFollowCellCountChange\(previousCellCount, cellIds\.length, tailPinnedRef\.current\)\) \{[\s\S]*scheduleTailScrollIfPinned\(\);[\s\S]*\}/,
    );
    expect(sourceText).toMatch(/onDeleteCell=\{handleDeleteCell\}/);
    expect(sourceText).not.toMatch(/currentContainer\.scrollTop = currentContainer\.scrollHeight/);
    expect(sourceText).toMatch(/scrollToNotebookTail\(currentContainer\)/);
    expect(sourceText).toMatch(/scrollToDocumentAnchor\(containerRef\.current/);
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

  it("consumes code execution keybindings when execution is unavailable", () => {
    const sourceText = readFileSync(
      join(process.cwd(), "apps/notebook/src/components/CodeCell.tsx"),
      "utf8",
    );

    expect(sourceText).toMatch(/canExecute\?: boolean;/);
    expect(sourceText).toMatch(/onRequestExecute\?: \(\) => void;/);
    expect(sourceText).toMatch(
      /const canRequestExecute = !readOnly && Boolean\(onRequestExecute\)/,
    );
    expect(sourceText).toMatch(/const canRunExecutionShortcut = canExecute \|\| canRequestExecute/);
    expect(sourceText).toMatch(/onExecute: canRunExecutionShortcut \? handleExecute : undefined/);
    expect(sourceText).toMatch(
      /onExecuteInPlace: canRunExecutionShortcut \? handleExecuteInPlace : undefined/,
    );
    expect(sourceText).toMatch(
      /onExecuteAndInsert:\s+canRunExecutionShortcut && onInsertCellAfter/,
    );
    expect(sourceText).toMatch(
      /consumeExecutionShortcuts: !readOnly \|\| canExecute \|\| canRequestExecute/,
    );
    expect(sourceText).toMatch(/canExecute=\{canExecute\}/);
    expect(sourceText).not.toContain("showReadoutWhenDisabled");
  });
});
