import { renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { applyNotebookCellStructureProjection } from "@/components/notebook/state/cell-store";
import type { NotebookCell } from "../../types";
import {
  getCellById,
  getCellIdsSnapshot,
  getNotebookCellsSnapshot,
  replaceNotebookCells,
  resetNotebookCells,
  updateCellById,
  updateCellSourceById,
  updateNotebookCells,
  useCell,
  useCellIds,
  useMaterializeVersion,
  useSourceVersion,
} from "../notebook-cells";
import { setMarkdownProjectionProjector } from "../markdown-projection";

const codeCell = (id: string, source = ""): NotebookCell => ({
  cell_type: "code",
  id,
  source,
  execution_count: null,
  outputs: [],
  metadata: {},
});

const markdownCell = (id: string, source = ""): NotebookCell => ({
  cell_type: "markdown",
  id,
  source,
  metadata: {},
});

function markdownProjection(
  source: string,
  anchors: readonly { title: string; level: number; slug: string }[],
): NonNullable<Extract<NotebookCell, { cell_type: "markdown" }>["markdownProjection"]> {
  return {
    version: 1,
    engine: "test",
    source,
    byteLength: source.length,
    utf16Length: source.length,
    measurement: { estimatedHeight: 24, confidence: "high", width: 720 },
    anchors: anchors.map((anchor, index) => ({
      anchorId: `anchor:${anchor.slug}`,
      blockId: `block:${index}`,
      level: anchor.level,
      slug: anchor.slug,
      sourceSpanByte: [0, source.length],
      sourceSpanUtf16: [0, source.length],
      title: anchor.title,
    })),
    blocks: [],
    runs: [],
  };
}

let restoreMarkdownProjectionProjector: (() => void) | undefined;

afterEach(() => {
  restoreMarkdownProjectionProjector?.();
  restoreMarkdownProjectionProjector = undefined;
  resetNotebookCells();
});

describe("replaceNotebookCells", () => {
  it("sets the snapshot to the provided cells", () => {
    const cells = [codeCell("a"), markdownCell("b")];
    replaceNotebookCells(cells);
    expect(getNotebookCellsSnapshot()).toEqual(cells);
  });

  it("replaces previous cells entirely", () => {
    replaceNotebookCells([codeCell("a")]);
    const next = [codeCell("b"), codeCell("c")];
    replaceNotebookCells(next);
    expect(getNotebookCellsSnapshot()).toEqual(next);
    expect(getNotebookCellsSnapshot()).toHaveLength(2);
  });

  it("notifies subscribers", () => {
    // Test through the public API by checking snapshot changes.
    replaceNotebookCells([codeCell("a")]);
    expect(getNotebookCellsSnapshot()).toHaveLength(1);
  });
});

describe("updateNotebookCells", () => {
  it("applies the updater function to current cells", () => {
    replaceNotebookCells([codeCell("a"), codeCell("b")]);
    const result = updateNotebookCells((cells) => cells.slice(1));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
    expect(getNotebookCellsSnapshot()).toEqual(result);
  });

  it("returns the new snapshot", () => {
    replaceNotebookCells([codeCell("a")]);
    const appended = codeCell("b");
    const result = updateNotebookCells((cells) => [...cells, appended]);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual(appended);
  });

  it("can clear cells via updater", () => {
    replaceNotebookCells([codeCell("a"), codeCell("b"), codeCell("c")]);
    updateNotebookCells(() => []);
    expect(getNotebookCellsSnapshot()).toHaveLength(0);
  });

  it("can transform cell contents", () => {
    replaceNotebookCells([codeCell("a", "print('hello')")]);
    updateNotebookCells((cells) =>
      cells.map((c) =>
        c.cell_type === "code" ? { ...c, source: "print('world')" } : c,
      ),
    );
    expect(getNotebookCellsSnapshot()[0].source).toBe("print('world')");
  });
});

describe("applyNotebookCellStructureProjection", () => {
  it("projects a pure insert and preserves surviving cell references", () => {
    replaceNotebookCells([codeCell("a", "keep-a"), codeCell("b", "keep-b")]);
    const refA = getCellById("a");
    const refB = getCellById("b");
    const inserted = codeCell("inserted", "new");

    applyNotebookCellStructureProjection({
      orderedCellIds: ["a", "inserted", "b"],
      upsertedCells: [inserted],
    });

    expect(getCellIdsSnapshot()).toEqual(["a", "inserted", "b"]);
    expect(getCellById("a")).toBe(refA);
    expect(getCellById("b")).toBe(refB);
    expect(getCellById("inserted")).toEqual(inserted);
  });

  it("projects a pure remove and preserves surviving cell references", () => {
    replaceNotebookCells([
      codeCell("a", "keep-a"),
      codeCell("removed", "delete"),
      codeCell("b", "keep-b"),
    ]);
    const refA = getCellById("a");
    const refB = getCellById("b");

    applyNotebookCellStructureProjection({
      orderedCellIds: ["a", "b"],
    });

    expect(getCellIdsSnapshot()).toEqual(["a", "b"]);
    expect(getCellById("a")).toBe(refA);
    expect(getCellById("b")).toBe(refB);
    expect(getCellById("removed")).toBeUndefined();
  });

  it("projects a move by updating only the ordered IDs", () => {
    replaceNotebookCells([
      codeCell("a", "keep-a"),
      codeCell("b", "keep-b"),
      codeCell("c", "keep-c"),
    ]);
    const refA = getCellById("a");
    const refB = getCellById("b");
    const refC = getCellById("c");

    applyNotebookCellStructureProjection({
      orderedCellIds: ["c", "a", "b"],
    });

    expect(getCellIdsSnapshot()).toEqual(["c", "a", "b"]);
    expect(getCellById("a")).toBe(refA);
    expect(getCellById("b")).toBe(refB);
    expect(getCellById("c")).toBe(refC);
  });

  it("emits structural notifications once and notifies removed cell subscribers", () => {
    replaceNotebookCells([codeCell("a", "keep"), codeCell("removed", "delete")]);

    const idsRenderCount = { current: 0 };
    const removedRenderCount = { current: 0 };
    const idsHook = renderHook(() => {
      idsRenderCount.current++;
      return useCellIds();
    });
    const removedHook = renderHook(() => {
      removedRenderCount.current++;
      return useCell("removed");
    });
    const materializeHook = renderHook(() => useMaterializeVersion());
    const sourceHook = renderHook(() => useSourceVersion());
    const initialMaterializeVersion = materializeHook.result.current;
    const initialSourceVersion = sourceHook.result.current;

    act(() => {
      applyNotebookCellStructureProjection({
        orderedCellIds: ["a"],
      });
    });

    expect(idsHook.result.current).toEqual(["a"]);
    expect(idsRenderCount.current).toBe(2);
    expect(removedHook.result.current).toBeUndefined();
    expect(removedRenderCount.current).toBe(2);
    expect(materializeHook.result.current).toBe(initialMaterializeVersion + 1);
    expect(sourceHook.result.current).toBe(initialSourceVersion + 1);
  });
});

describe("updateCellById", () => {
  it("updates a single cell by ID", () => {
    replaceNotebookCells([codeCell("a", "old"), codeCell("b", "keep")]);
    updateCellById("a", (c) => ({ ...c, source: "new" }));
    expect(getCellById("a")?.source).toBe("new");
    expect(getCellById("b")?.source).toBe("keep");
  });

  it("clears stale markdown projections when markdown source changes", () => {
    replaceNotebookCells([
      {
        ...markdownCell("a", "- [ ] old"),
        markdownProjection: {
          version: 1,
          engine: "test",
          byteLength: 8,
          utf16Length: 8,
          measurement: { estimatedHeight: 24, confidence: "high", width: 720 },
          anchors: [],
          blocks: [],
          runs: [],
        },
      },
    ]);

    updateCellById("a", (cell) =>
      cell.cell_type === "markdown" ? { ...cell, source: "- [x] old" } : cell,
    );

    const cell = getCellById("a");
    expect(cell?.source).toBe("- [x] old");
    expect(cell?.cell_type === "markdown" ? cell.markdownProjection : null).toBeUndefined();
  });

  it("refreshes markdown projections when updating source through the source helper", () => {
    restoreMarkdownProjectionProjector = setMarkdownProjectionProjector((source) =>
      JSON.stringify({
        version: 1,
        engine: "test",
        byteLength: source.length,
        utf16Length: source.length,
        measurement: { estimatedHeight: 24, confidence: "high", width: 720 },
        anchors: [
          {
            anchorId: "anchor:updated",
            blockId: "block:0",
            level: 1,
            slug: "updated",
            sourceSpanByte: [0, source.length],
            sourceSpanUtf16: [0, source.length],
            title: "Updated",
          },
        ],
        blocks: [],
        runs: [],
      }),
    );
    replaceNotebookCells([markdownCell("a", "# Old")]);

    updateCellSourceById("a", "# Updated");

    const cell = getCellById("a");
    expect(cell?.source).toBe("# Updated");
    expect(cell?.cell_type === "markdown" ? cell.markdownProjection?.anchors[0]?.title : null).toBe(
      "Updated",
    );
  });

  it("is a no-op for non-existent IDs", () => {
    replaceNotebookCells([codeCell("a")]);
    updateCellById("nonexistent", (c) => ({ ...c, source: "boom" }));
    expect(getNotebookCellsSnapshot()).toHaveLength(1);
  });

  it("preserves cell ordering", () => {
    replaceNotebookCells([codeCell("a"), codeCell("b"), codeCell("c")]);
    updateCellById("b", (c) => ({ ...c, source: "updated" }));
    const ids = getNotebookCellsSnapshot().map((c) => c.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

describe("getCellById", () => {
  it("returns the cell for a known ID", () => {
    replaceNotebookCells([codeCell("a", "hello")]);
    const cell = getCellById("a");
    expect(cell?.id).toBe("a");
    expect(cell?.source).toBe("hello");
  });

  it("returns undefined for unknown IDs", () => {
    replaceNotebookCells([codeCell("a")]);
    expect(getCellById("nonexistent")).toBeUndefined();
  });
});

describe("resetNotebookCells", () => {
  it("empties the snapshot", () => {
    replaceNotebookCells([codeCell("a"), markdownCell("b")]);
    resetNotebookCells();
    expect(getNotebookCellsSnapshot()).toEqual([]);
  });

  it("is idempotent on empty store", () => {
    resetNotebookCells();
    resetNotebookCells();
    expect(getNotebookCellsSnapshot()).toEqual([]);
  });
});

describe("getNotebookCellsSnapshot", () => {
  it("returns empty array initially", () => {
    expect(getNotebookCellsSnapshot()).toEqual([]);
  });

  it("returns content-equal results on consecutive calls", () => {
    const cells = [codeCell("a")];
    replaceNotebookCells(cells);
    const snap1 = getNotebookCellsSnapshot();
    const snap2 = getNotebookCellsSnapshot();
    expect(snap1).toEqual(snap2);
  });
});

describe("subscriber notifications", () => {
  it("replace produces distinct content each call", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      replaceNotebookCells([codeCell(`cell-${i}`)]);
      ids.add(getNotebookCellsSnapshot()[0].id);
    }
    expect(ids.size).toBe(5);
  });

  it("update produces distinct content each call", () => {
    replaceNotebookCells([codeCell("a")]);
    const ref1 = getNotebookCellsSnapshot();
    updateNotebookCells((cells) => [...cells, codeCell("b")]);
    const ref2 = getNotebookCellsSnapshot();
    updateNotebookCells((cells) => [...cells, codeCell("c")]);
    const ref3 = getNotebookCellsSnapshot();
    expect(ref1).toHaveLength(1);
    expect(ref2).toHaveLength(2);
    expect(ref3).toHaveLength(3);
  });
});

describe("cell chrome version", () => {
  it("does not bump for output-only replacements", () => {
    const firstOutput = {
      output_type: "stream" as const,
      name: "stdout" as const,
      text: "first",
    };
    const secondOutput = {
      output_type: "stream" as const,
      name: "stdout" as const,
      text: "second",
    };
    const cell = {
      ...codeCell("a", "print('hello')"),
      execution_count: 1,
      outputs: [firstOutput],
    };
    replaceNotebookCells([cell]);
    const firstCellRef = getCellById("a");

    const renderCount = { current: 0 };
    const { result } = renderHook(() => {
      renderCount.current += 1;
      return useMaterializeVersion();
    });
    const initialVersion = result.current;

    act(() => {
      replaceNotebookCells([{ ...cell, outputs: [secondOutput] }]);
    });

    expect(getCellById("a")).not.toBe(firstCellRef);
    expect(result.current).toBe(initialVersion);
    expect(renderCount.current).toBe(1);
  });

  it("bumps when cell chrome changes", () => {
    replaceNotebookCells([codeCell("a", "old")]);

    const renderCount = { current: 0 };
    const { result } = renderHook(() => {
      renderCount.current += 1;
      return useMaterializeVersion();
    });
    const initialVersion = result.current;

    act(() => {
      replaceNotebookCells([codeCell("a", "new")]);
    });

    expect(result.current).toBe(initialVersion + 1);
    expect(renderCount.current).toBe(2);
  });

  it("bumps when updateCellById changes cell chrome", () => {
    replaceNotebookCells([codeCell("a", "old")]);

    const { result } = renderHook(() => useMaterializeVersion());
    const initialVersion = result.current;

    act(() => {
      updateCellById("a", (cell) =>
        cell.cell_type === "code" ? { ...cell, execution_count: 1 } : cell,
      );
    });

    expect(result.current).toBe(initialVersion + 1);
  });

  it("does not bump when updateCellById changes only the materialized output snapshot", () => {
    replaceNotebookCells([codeCell("a", "print('hello')")]);

    const { result } = renderHook(() => useMaterializeVersion());
    const initialVersion = result.current;

    act(() => {
      updateCellById("a", (cell) =>
        cell.cell_type === "code"
          ? {
              ...cell,
              outputs: [
                {
                  output_type: "stream" as const,
                  name: "stdout" as const,
                  text: "hello",
                },
              ],
            }
          : cell,
      );
    });

    expect(result.current).toBe(initialVersion);
  });
});

describe("cell diffing in replaceNotebookCells", () => {
  it("preserves referential identity for unchanged cells", () => {
    const cells = [codeCell("a", "x = 1"), codeCell("b", "y = 2")];
    replaceNotebookCells(cells);
    const ref1 = getCellById("a");
    const ref2 = getCellById("b");

    // Replace with structurally identical cells (new objects)
    replaceNotebookCells([codeCell("a", "x = 1"), codeCell("b", "y = 2")]);
    const ref1After = getCellById("a");
    const ref2After = getCellById("b");

    // Old references should be preserved — same object, not just equal
    expect(ref1After).toBe(ref1);
    expect(ref2After).toBe(ref2);
  });

  it("replaces reference when source changes", () => {
    replaceNotebookCells([codeCell("a", "x = 1")]);
    const ref1 = getCellById("a");

    replaceNotebookCells([codeCell("a", "x = 2")]);
    const ref2 = getCellById("a");

    expect(ref2).not.toBe(ref1);
    expect(ref2?.source).toBe("x = 2");
  });

  it("replaces reference when execution_count changes", () => {
    const cell: NotebookCell = {
      cell_type: "code",
      id: "a",
      source: "1+1",
      execution_count: null,
      outputs: [],
      metadata: {},
    };
    replaceNotebookCells([cell]);
    const ref1 = getCellById("a");

    replaceNotebookCells([{ ...cell, execution_count: 1 }]);
    const ref2 = getCellById("a");

    expect(ref2).not.toBe(ref1);
    expect(ref2?.cell_type === "code" && ref2.execution_count).toBe(1);
  });

  it("replaces reference when outputs change", () => {
    const output = {
      output_type: "stream" as const,
      name: "stdout" as const,
      text: "hello",
    };
    const cell: NotebookCell = {
      cell_type: "code",
      id: "a",
      source: "print('hello')",
      execution_count: 1,
      outputs: [],
      metadata: {},
    };
    replaceNotebookCells([cell]);
    const ref1 = getCellById("a");

    replaceNotebookCells([{ ...cell, outputs: [output] }]);
    const ref2 = getCellById("a");

    expect(ref2).not.toBe(ref1);
  });

  it("preserves reference when outputs are referentially equal", () => {
    const output = {
      output_type: "stream" as const,
      name: "stdout" as const,
      text: "hello",
    };
    const cell: NotebookCell = {
      cell_type: "code",
      id: "a",
      source: "print('hello')",
      execution_count: 1,
      outputs: [output],
      metadata: {},
    };
    replaceNotebookCells([cell]);
    const ref1 = getCellById("a");

    // Same output object reference — cell should be preserved
    replaceNotebookCells([{ ...cell, outputs: [output] }]);
    const ref2 = getCellById("a");

    expect(ref2).toBe(ref1);
  });

  it("replaces reference when metadata changes", () => {
    replaceNotebookCells([
      { ...codeCell("a"), metadata: { collapsed: false } },
    ]);
    const ref1 = getCellById("a");

    replaceNotebookCells([{ ...codeCell("a"), metadata: { collapsed: true } }]);
    const ref2 = getCellById("a");

    expect(ref2).not.toBe(ref1);
  });

  it("preserves reference for markdown with identical resolvedAssets", () => {
    const assets = { "image.png": "sha256:abc" };
    const cell: NotebookCell = {
      cell_type: "markdown",
      id: "m1",
      source: "# Hello",
      metadata: {},
      resolvedAssets: assets,
    };
    replaceNotebookCells([cell]);
    const ref1 = getCellById("m1");

    // New object with same key/values — shallow compare should match
    replaceNotebookCells([
      { ...cell, resolvedAssets: { "image.png": "sha256:abc" } },
    ]);
    const ref2 = getCellById("m1");

    expect(ref2).toBe(ref1);
  });

  it("replaces same-source markdown cells when the projection refreshes", () => {
    const source = "# ANother one\n\n# LMAO this is fine";
    const staleCell: NotebookCell = {
      ...markdownCell("m1", source),
      markdownProjection: markdownProjection(source, [
        { title: "LMAO", level: 1, slug: "lmao" },
        { title: "Deeper note", level: 3, slug: "deeper-note" },
      ]),
    };
    const refreshedCell: NotebookCell = {
      ...markdownCell("m1", source),
      markdownProjection: markdownProjection(source, [
        { title: "ANother one", level: 1, slug: "another-one" },
        { title: "LMAO this is fine", level: 1, slug: "lmao-this-is-fine" },
        { title: "Deeper note", level: 3, slug: "deeper-note" },
      ]),
    };

    replaceNotebookCells([staleCell]);
    const ref1 = getCellById("m1");
    const { result } = renderHook(() => useMaterializeVersion());
    const initialVersion = result.current;

    act(() => {
      replaceNotebookCells([refreshedCell]);
    });

    const ref2 = getCellById("m1");
    expect(ref2).not.toBe(ref1);
    expect(result.current).toBe(initialVersion + 1);
    expect(
      ref2?.cell_type === "markdown"
        ? ref2.markdownProjection?.anchors.map((anchor) => anchor.title)
        : [],
    ).toEqual(["ANother one", "LMAO this is fine", "Deeper note"]);
  });

  it("only changes reference for the cell that changed", () => {
    replaceNotebookCells([
      codeCell("a", "unchanged"),
      codeCell("b", "will change"),
      codeCell("c", "unchanged"),
    ]);
    const refA = getCellById("a");
    const refB = getCellById("b");
    const refC = getCellById("c");

    replaceNotebookCells([
      codeCell("a", "unchanged"),
      codeCell("b", "changed!"),
      codeCell("c", "unchanged"),
    ]);

    expect(getCellById("a")).toBe(refA);
    expect(getCellById("b")).not.toBe(refB);
    expect(getCellById("b")?.source).toBe("changed!");
    expect(getCellById("c")).toBe(refC);
  });

  it("handles cell addition without breaking existing refs", () => {
    replaceNotebookCells([codeCell("a", "keep")]);
    const refA = getCellById("a");

    replaceNotebookCells([codeCell("a", "keep"), codeCell("b", "new")]);

    expect(getCellById("a")).toBe(refA);
    expect(getCellById("b")?.source).toBe("new");
    expect(getNotebookCellsSnapshot()).toHaveLength(2);
  });

  it("handles cell removal", () => {
    replaceNotebookCells([codeCell("a", "keep"), codeCell("b", "remove")]);

    replaceNotebookCells([codeCell("a", "keep")]);

    expect(getNotebookCellsSnapshot()).toHaveLength(1);
    expect(getCellById("b")).toBeUndefined();
  });

  it("handles cell type change", () => {
    replaceNotebookCells([codeCell("a", "# Title")]);
    const ref1 = getCellById("a");

    replaceNotebookCells([markdownCell("a", "# Title")]);
    const ref2 = getCellById("a");

    expect(ref2).not.toBe(ref1);
    expect(ref2?.cell_type).toBe("markdown");
  });
});

describe("mixed cell types", () => {
  it("stores code, markdown, and raw cells", () => {
    const cells: NotebookCell[] = [
      codeCell("c1", "x = 1"),
      markdownCell("m1", "# Title"),
      { cell_type: "raw", id: "r1", source: "raw content", metadata: {} },
    ];
    replaceNotebookCells(cells);
    const snap = getNotebookCellsSnapshot();
    expect(snap).toHaveLength(3);
    expect(snap[0].cell_type).toBe("code");
    expect(snap[1].cell_type).toBe("markdown");
    expect(snap[2].cell_type).toBe("raw");
  });

  it("preserves code cell outputs and execution_count", () => {
    const cell: NotebookCell = {
      cell_type: "code",
      id: "c1",
      source: "1 + 1",
      execution_count: 42,
      outputs: [
        {
          output_type: "execute_result",
          data: { "text/plain": "2" },
          execution_count: 42,
        },
      ],
      metadata: {},
    };
    replaceNotebookCells([cell]);
    const snap = getNotebookCellsSnapshot();
    expect(snap[0].cell_type).toBe("code");
    if (snap[0].cell_type === "code") {
      expect(snap[0].execution_count).toBe(42);
      expect(snap[0].outputs).toHaveLength(1);
      expect(snap[0].outputs[0].output_type).toBe("execute_result");
    }
  });
});
