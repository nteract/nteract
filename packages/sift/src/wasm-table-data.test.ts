import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWasmTableData } from "./wasm-table-data";

const predicateModule = vi.hoisted(() => ({
  num_rows: vi.fn(() => 2),
  num_cols: vi.fn(() => 4),
  col_names: vi.fn(() => ["id", "name", "score", "active"]),
  col_type: vi.fn((_handle: number, col: number): string =>
    col === 0 || col === 2 ? "numeric" : col === 3 ? "boolean" : "categorical",
  ),
  col_timezone: vi.fn(() => null),
  store_viewport_cells: vi.fn((_handle: number, rows: Uint32Array) => {
    const requested = Array.from(rows);
    expect(requested).toEqual([1, 0]);
    return {
      rows: requested,
      strings: ["2", "Bob", "88", "No", "1", "Alice", "", "Yes"],
      numeric_values: [2, null, 88, null, 1, null, null, null],
      nulls: [false, false, false, false, false, false, true, false],
    };
  }),
  is_null: vi.fn((): boolean => {
    throw new Error("is_null should not be called during batched prefetch");
  }),
  get_cell_string: vi.fn(() => {
    throw new Error("get_cell_string should not be called during batched prefetch");
  }),
  get_cell_f64: vi.fn(() => {
    throw new Error("get_cell_f64 should not be called during batched prefetch");
  }),
  get_cell_image_count: vi.fn(() => 0),
  get_cell_image_bytes_at: vi.fn(() => new Uint8Array()),
  free: vi.fn(),
}));

vi.mock("./predicate", () => ({
  getModuleSync: () => predicateModule,
}));

describe("createWasmTableData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefetches visible cells with one batched WASM call", () => {
    const { tableData, prefetchViewport } = createWasmTableData(7);

    prefetchViewport([1, 0]);

    expect(predicateModule.store_viewport_cells).toHaveBeenCalledTimes(1);
    expect(predicateModule.store_viewport_cells.mock.calls[0][0]).toBe(7);
    expect(Array.from(predicateModule.store_viewport_cells.mock.calls[0][1])).toEqual([1, 0]);

    expect(tableData.getCell(1, 1)).toBe("Bob");
    expect(tableData.getCellRaw(1, 0)).toBe(2);
    expect(tableData.getCellRaw(1, 2)).toBe(88);
    expect(tableData.getCellRaw(1, 3)).toBe(false);
    expect(tableData.getCell(0, 2)).toBe("");
    expect(tableData.getCellRaw(0, 2)).toBeNull();
    expect(tableData.getCellRaw(0, 3)).toBe(true);

    prefetchViewport([1]);
    expect(predicateModule.store_viewport_cells).toHaveBeenCalledTimes(1);
    expect(predicateModule.is_null).not.toHaveBeenCalled();
    expect(predicateModule.get_cell_string).not.toHaveBeenCalled();
    expect(predicateModule.get_cell_f64).not.toHaveBeenCalled();
  });

  it("disposes the backing WASM store once", () => {
    const { tableData } = createWasmTableData(7);

    tableData.dispose?.();
    tableData.dispose?.();

    expect(predicateModule.free).toHaveBeenCalledTimes(1);
    expect(predicateModule.free).toHaveBeenCalledWith(7);
  });

  it("maps image columns and reads image bytes without using formatted cell text", () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    predicateModule.num_cols.mockReturnValueOnce(1);
    predicateModule.col_names.mockReturnValueOnce(["image"]);
    predicateModule.col_type.mockReturnValueOnce("image");
    predicateModule.store_viewport_cells.mockReturnValueOnce({
      rows: [0],
      strings: ["very large formatted bytes that should be ignored"],
      numeric_values: [null],
      nulls: [false],
    });
    predicateModule.is_null.mockReturnValueOnce(false);
    predicateModule.get_cell_image_count.mockReturnValueOnce(1);
    predicateModule.get_cell_image_bytes_at.mockReturnValueOnce(imageBytes);

    const { columns, tableData, prefetchViewport } = createWasmTableData(7);
    prefetchViewport([0]);

    expect(columns[0].columnType).toBe("image");
    expect(tableData.getCell(0, 0)).toBe("");
    expect(tableData.getCellRaw(0, 0)).toEqual([imageBytes]);
    expect(predicateModule.get_cell_string).not.toHaveBeenCalled();
  });
});
