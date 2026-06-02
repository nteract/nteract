import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { NotebookCell } from "../../types";
import { createNotebookController, type NotebookControllerHandle } from "../notebook-controller";
import { getCellById, resetNotebookCells, replaceNotebookCells } from "../notebook-cells";

function codeCell(id: string, source = ""): NotebookCell {
  return {
    cell_type: "code",
    id,
    source,
    execution_count: null,
    outputs: [],
    metadata: {},
  };
}

function createHandle(): NotebookControllerHandle & {
  sources: Map<string, string>;
  cells: string[];
} {
  const sources = new Map<string, string>([["cell-a", "old"]]);
  const cells = ["cell-a"];
  return {
    sources,
    cells,
    update_source(cellId, source) {
      if (!sources.has(cellId)) return false;
      sources.set(cellId, source);
      return true;
    },
    add_cell_after(cellId) {
      cells.push(cellId);
    },
    move_cell(cellId, afterCellId) {
      const previousIndex = cells.indexOf(cellId);
      if (previousIndex >= 0) cells.splice(previousIndex, 1);
      const afterIndex = afterCellId ? cells.indexOf(afterCellId) : -1;
      cells.splice(afterIndex + 1, 0, cellId);
    },
    cell_count() {
      return cells.length;
    },
    delete_cell(cellId) {
      const index = cells.indexOf(cellId);
      if (index < 0) return false;
      cells.splice(index, 1);
      return true;
    },
    clear_outputs() {
      return true;
    },
    set_cell_source_hidden() {
      return true;
    },
    set_cell_outputs_hidden() {
      return true;
    },
    has_cells_map() {
      return true;
    },
  };
}

afterEach(() => {
  resetNotebookCells();
});

describe("createNotebookController", () => {
  it("updates source through the handle and mirrors the shared cell store", () => {
    replaceNotebookCells([codeCell("cell-a", "old")]);
    const handle = createHandle();
    const engine = { flush: vi.fn(), scheduleFlush: vi.fn() };
    const controller = createNotebookController({
      getHandle: () => handle,
      getEngine: () => engine,
      canWriteCellSource: () => true,
      canEditStructure: () => true,
    });

    controller.updateCellSource("cell-a", "new");

    expect(handle.sources.get("cell-a")).toBe("new");
    expect(getCellById("cell-a")?.source).toBe("new");
    expect(engine.scheduleFlush).toHaveBeenCalledTimes(1);
    expect(engine.flush).not.toHaveBeenCalled();
  });

  it("does not mutate source when capabilities deny the edit", () => {
    replaceNotebookCells([codeCell("cell-a", "old")]);
    const handle = createHandle();
    const engine = { flush: vi.fn(), scheduleFlush: vi.fn() };
    const controller = createNotebookController({
      getHandle: () => handle,
      getEngine: () => engine,
      canWriteCellSource: () => false,
      canEditStructure: () => true,
    });

    controller.updateCellSource("cell-a", "new");

    expect(handle.sources.get("cell-a")).toBe("old");
    expect(getCellById("cell-a")?.source).toBe("old");
    expect(engine.scheduleFlush).not.toHaveBeenCalled();
  });

  it("lets hosts choose scheduled sync for structural mutations", () => {
    const handle = createHandle();
    const engine = { flush: vi.fn(), scheduleFlush: vi.fn() };
    const afterMutation = vi.fn();
    const controller = createNotebookController({
      getHandle: () => handle,
      getEngine: () => engine,
      canWriteCellSource: () => true,
      canEditStructure: () => true,
      createCellId: () => "cell-b",
      syncMode: { structure: "scheduleFlush" },
      afterMutation,
    });

    const added = controller.addCell("markdown", "cell-a");

    expect(handle.cells).toEqual(["cell-a", "cell-b"]);
    expect(added).toMatchObject({ id: "cell-b", cell_type: "markdown" });
    expect(afterMutation).toHaveBeenCalledWith(handle, "structure");
    expect(engine.scheduleFlush).toHaveBeenCalledTimes(1);
    expect(engine.flush).not.toHaveBeenCalled();
  });

  it("keeps structural mutations closed when the host has not accepted the cells map", () => {
    const handle = createHandle();
    const engine = { flush: vi.fn(), scheduleFlush: vi.fn() };
    const refresh = vi.fn();
    const controller = createNotebookController({
      getHandle: () => handle,
      getEngine: () => engine,
      canWriteCellSource: () => true,
      canEditStructure: () => true,
      canAcceptStructure: () => false,
      refreshCanAcceptCellMutations: refresh,
    });

    expect(controller.addCell("code", "cell-a")).toBeNull();
    expect(handle.cells).toEqual(["cell-a"]);
    expect(refresh).toHaveBeenCalledWith(handle);
    expect(engine.flush).not.toHaveBeenCalled();
  });
});
