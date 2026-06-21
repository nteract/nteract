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
  cellTypes: Map<string, "code" | "markdown" | "raw">;
  cells: string[];
} {
  const sources = new Map<string, string>([["cell-a", "old"]]);
  const cellTypes = new Map<string, "code" | "markdown" | "raw">([["cell-a", "code"]]);
  const cells = ["cell-a"];
  return {
    sources,
    cellTypes,
    cells,
    update_source(cellId, source) {
      if (!sources.has(cellId)) return false;
      sources.set(cellId, source);
      return true;
    },
    add_cell_after(cellId, cellType) {
      cells.push(cellId);
      cellTypes.set(cellId, cellType);
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
      cellTypes.delete(cellId);
      return true;
    },
    clear_outputs() {
      return true;
    },
    set_cell_type(cellId, cellType) {
      if (!cellTypes.has(cellId)) return false;
      cellTypes.set(cellId, cellType);
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
    const afterMutation = vi.fn();
    const controller = createNotebookController({
      getHandle: () => handle,
      getEngine: () => engine,
      canWriteCellSource: () => true,
      canEditStructure: () => true,
      afterMutation,
    });

    controller.updateCellSource("cell-a", "new");

    expect(handle.sources.get("cell-a")).toBe("new");
    expect(getCellById("cell-a")?.source).toBe("new");
    expect(afterMutation).toHaveBeenCalledWith(handle, "source");
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

  it("routes accepted wrapper events without running afterMutation and still flushes", () => {
    const handle = createHandle();
    const engine = { flush: vi.fn(), scheduleFlush: vi.fn() };
    const afterMutation = vi.fn();
    const applyMutationEvent = vi.fn(() => true);
    const event = { type: "sync_applied", changed: true };
    handle.add_cell_after_with_changeset = vi.fn((cellId) => {
      handle.cells.push(cellId);
      return { result: "position-b", event };
    });
    const focusCell = vi.fn();
    const controller = createNotebookController({
      getHandle: () => handle,
      getEngine: () => engine,
      canWriteCellSource: () => true,
      canEditStructure: () => true,
      createCellId: () => "cell-b",
      applyMutationEvent,
      afterMutation,
      onFocusCell: focusCell,
    });

    const added = controller.addCell("markdown", "cell-a");

    expect(handle.add_cell_after_with_changeset).toHaveBeenCalledWith(
      "cell-b",
      "markdown",
      "cell-a",
    );
    expect(handle.cells).toEqual(["cell-a", "cell-b"]);
    expect(added).toMatchObject({ id: "cell-b", cell_type: "markdown" });
    expect(applyMutationEvent).toHaveBeenCalledWith(event);
    expect(afterMutation).not.toHaveBeenCalled();
    expect(engine.flush).toHaveBeenCalledTimes(1);
    expect(engine.scheduleFlush).not.toHaveBeenCalled();
    expect(focusCell).toHaveBeenCalledWith("cell-b");
  });

  it("falls back to afterMutation when wrapper events are rejected", () => {
    const handle = createHandle();
    handle.cells.push("cell-b");
    const engine = { flush: vi.fn(), scheduleFlush: vi.fn() };
    const afterMutation = vi.fn();
    const applyMutationEvent = vi.fn(() => false);
    const event = { type: "sync_applied", changed: false };
    handle.move_cell_with_changeset = vi.fn((cellId, afterCellId) => {
      handle.move_cell(cellId, afterCellId);
      return { result: "position-b", event };
    });
    const controller = createNotebookController({
      getHandle: () => handle,
      getEngine: () => engine,
      canWriteCellSource: () => true,
      canEditStructure: () => true,
      applyMutationEvent,
      afterMutation,
    });

    controller.moveCell("cell-b", null);

    expect(handle.cells).toEqual(["cell-b", "cell-a"]);
    expect(applyMutationEvent).toHaveBeenCalledWith(event);
    expect(afterMutation).toHaveBeenCalledWith(handle, "structure");
    expect(engine.flush).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy afterMutation behavior when wrappers are absent", () => {
    const handle = createHandle();
    handle.cells.push("cell-b");
    const engine = { flush: vi.fn(), scheduleFlush: vi.fn() };
    const afterMutation = vi.fn();
    const applyMutationEvent = vi.fn(() => true);
    const controller = createNotebookController({
      getHandle: () => handle,
      getEngine: () => engine,
      canWriteCellSource: () => true,
      canEditStructure: () => true,
      applyMutationEvent,
      afterMutation,
    });

    controller.moveCell("cell-b", null);

    expect(handle.cells).toEqual(["cell-b", "cell-a"]);
    expect(applyMutationEvent).not.toHaveBeenCalled();
    expect(afterMutation).toHaveBeenCalledWith(handle, "structure");
    expect(engine.flush).toHaveBeenCalledTimes(1);
  });

  it("switches cell type through the changeset wrapper as a structural mutation", () => {
    const handle = createHandle();
    const engine = { flush: vi.fn(), scheduleFlush: vi.fn() };
    const afterMutation = vi.fn();
    const applyMutationEvent = vi.fn(() => true);
    const event = { type: "sync_applied", changed: true };
    handle.set_cell_type_with_changeset = vi.fn((cellId, cellType) => {
      handle.set_cell_type(cellId, cellType);
      return { result: true, event };
    });
    const controller = createNotebookController({
      getHandle: () => handle,
      getEngine: () => engine,
      canWriteCellSource: () => true,
      canEditStructure: () => true,
      applyMutationEvent,
      afterMutation,
    });

    controller.setCellType("cell-a", "markdown");

    expect(handle.set_cell_type_with_changeset).toHaveBeenCalledWith("cell-a", "markdown");
    expect(handle.cellTypes.get("cell-a")).toBe("markdown");
    expect(applyMutationEvent).toHaveBeenCalledWith(event);
    expect(afterMutation).not.toHaveBeenCalled();
    expect(engine.flush).toHaveBeenCalledTimes(1);
    expect(engine.scheduleFlush).not.toHaveBeenCalled();
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
