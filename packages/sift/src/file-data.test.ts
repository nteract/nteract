import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { loadTableFile } from "./file-data";

const mod = vi.hoisted(() => ({
  load_ipc_bounded: vi.fn(() => 7),
  load_parquet_bounded: vi.fn(() => 7),
  parquet_column_hints: vi.fn(() => []),
  arrow_ipc_column_hints_with_row_count: vi.fn(() => []),
  num_rows: vi.fn(() => 2),
  num_cols: vi.fn(() => 1),
  col_names: vi.fn(() => ["number"]),
  col_type: vi.fn(() => "numeric"),
  store_histogram: vi.fn(() => [{ x0: 1, x1: 3, count: 2 }]),
  store_value_counts: vi.fn(() => []),
  free: vi.fn(),
}));
const ensureModule = vi.hoisted(() => vi.fn(async () => mod));
vi.mock("./predicate", () => ({ ensureModule, getModuleSync: () => mod }));

const parquet = new Uint8Array([0x50, 0x41, 0x52, 0x31, 0]);

describe("loadTableFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects oversized input before initializing WASM", async () => {
    await expect(loadTableFile(parquet, { maxBytes: 4 })).rejects.toThrow("input bytes limit");
    expect(ensureModule).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000])(
    "rejects invalid limits (%s) before initializing WASM",
    async (value) => {
      await expect(loadTableFile(parquet, { maxRows: value })).rejects.toThrow("maxRows");
      expect(ensureModule).not.toHaveBeenCalled();
    },
  );

  it("rejects empty input", async () => {
    await expect(loadTableFile(new Uint8Array())).rejects.toThrow("empty");
    expect(ensureModule).not.toHaveBeenCalled();
  });

  it("detects Parquet, passes defaults, and transfers store ownership", async () => {
    const data = await loadTableFile(parquet);
    expect(mod.load_parquet_bounded).toHaveBeenCalledWith(parquet, 100_000, 256, 128 * 1024 * 1024);
    expect(mod.load_ipc_bounded).not.toHaveBeenCalled();
    expect(data.rowCount).toBe(2);
    expect(data.columns[0].columnType).toBe("numeric");
    expect(data.columnSummaries[0]).toMatchObject({ kind: "numeric", min: 1, max: 3 });
    expect(mod.free).not.toHaveBeenCalled();
    data.dispose?.();
    data.dispose?.();
    expect(mod.free).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("takes a snapshot before awaiting WASM and honors explicit format and limits", async () => {
    const bytes = new Uint8Array(parquet);
    const pending = loadTableFile(bytes, {
      format: "arrow-ipc",
      maxRows: 20,
      maxColumns: 4,
      maxDecodedBytes: 5000,
    });
    bytes.fill(0);
    const data = await pending;
    expect(mod.load_ipc_bounded).toHaveBeenCalledWith(parquet, 20, 4, 5000);
    expect(mod.arrow_ipc_column_hints_with_row_count).toHaveBeenCalledWith(parquet, 2);
    data.dispose?.();
  });

  it("copies typed-array subclasses whose slice aliases input, like Node Buffer", async () => {
    class AliasingBytes extends Uint8Array<ArrayBuffer> {
      override slice() {
        return this;
      }
    }
    const bytes = new AliasingBytes(parquet.buffer.slice(0));
    const pending = loadTableFile(bytes);
    bytes.fill(0);
    const data = await pending;
    expect(mod.load_parquet_bounded).toHaveBeenCalledWith(parquet, 100_000, 256, 128 * 1024 * 1024);
    data.dispose?.();
  });

  it("normalizes WASM parser errors without freeing a nonexistent handle", async () => {
    mod.load_parquet_bounded.mockImplementationOnce(() => {
      throw "Invalid Parquet footer";
    });
    await expect(loadTableFile(parquet)).rejects.toThrow("Invalid Parquet footer");
    expect(mod.free).not.toHaveBeenCalled();
  });

  it("frees a handle when schema hints fail", async () => {
    mod.parquet_column_hints.mockImplementationOnce(() => {
      throw new Error("bad schema");
    });
    await expect(loadTableFile(parquet)).rejects.toThrow("bad schema");
    expect(mod.free).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("frees the TableData lease when summary construction fails", async () => {
    mod.store_histogram.mockImplementationOnce(() => {
      throw new Error("summary failed");
    });
    await expect(loadTableFile(parquet)).rejects.toThrow("summary failed");
    expect(mod.free).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("keeps empty-table category percentages finite", async () => {
    mod.num_rows.mockReturnValueOnce(0).mockReturnValueOnce(0);
    mod.col_type.mockReturnValueOnce("categorical");
    const data = await loadTableFile(parquet);
    expect(data.rowCount).toBe(0);
    expect(data.columnSummaries[0]).toMatchObject({ kind: "categorical", othersPct: 0 });
    data.dispose?.();
  });
});
