import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
  store_null_counts: vi.fn(() => new Uint32Array([0])),
  free: vi.fn(),
}));
const ensureModule = vi.hoisted(() => vi.fn(async () => mod));
vi.mock("./predicate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./predicate")>()),
  ensureModule,
  getModuleSync: () => mod,
}));

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

  it("reports whole-buffer loads as complete coverage over resident rows", async () => {
    const data = await loadTableFile(parquet);
    expect(data.coverage).toEqual({
      loadedRows: 2,
      totalRows: { value: 2, scope: "dataset", precision: "exact", source: "resident" },
      truncated: false,
    });
    expect(data.datasetStats).toBeUndefined();
    expect(data.columnSummaries[0]?.scope).toEqual({
      rows: {
        loaded: 2,
        dataset: { value: 2, scope: "dataset", precision: "exact", source: "resident" },
      },
      distribution: { scope: "dataset", precision: "exact", source: "resident" },
      nullCount: { value: 0, scope: "dataset", precision: "exact", source: "resident" },
    });
    data.dispose?.();
  });

  describe("byte-source coverage", () => {
    // Two row groups of 2 rows each; the mock store "appends" by bumping num_rows.
    const stats = {
      num_rows: 4,
      num_row_groups: 2,
      columns: [
        {
          null_count: 1,
          min: 1,
          max: 9,
          bounded_row_groups: 2,
          bounds_exact: true,
          has_infinite: false,
        },
      ],
    };
    const ranged = {
      parquet_footer_length: vi.fn(() => 4),
      parquet_open: vi.fn(() => 11),
      parquet_file_info: vi.fn(() => ({
        num_rows: 4,
        num_row_groups: 2,
        row_group_rows: [2, 2],
        column_names: ["number"],
      })),
      parquet_file_column_stats: vi.fn(() => stats),
      parquet_file_column_hints: vi.fn(() => []),
      parquet_create_store: vi.fn(() => 7),
      parquet_row_group_ranges: vi.fn(() => Float64Array.from([0, 4])),
      parquet_append_row_group: vi.fn(() => 2),
      parquet_file_budget: vi.fn(() => ({ exhausted: false, truncated: false })),
      parquet_close: vi.fn(),
      finish_arrow_stream_store: vi.fn(),
      col_timezone: vi.fn(() => null),
      has_original_column: vi.fn(() => false),
    };
    // 64 zero bytes ending in a 4-byte footer length and the PAR1 magic.
    const file = new Uint8Array(64);
    file.set([4, 0, 0, 0, 0x50, 0x41, 0x52, 0x31], 56);
    const source = {
      byteLength: file.byteLength,
      read: vi.fn(async (offset: number, length: number) => file.slice(offset, offset + length)),
    };

    beforeEach(() => {
      Object.assign(mod, ranged);
      let loaded = 0;
      mod.num_rows.mockImplementation(() => loaded);
      ranged.parquet_append_row_group.mockImplementation(() => {
        loaded += 2;
        return 2;
      });
      ranged.parquet_file_budget.mockReturnValue({ exhausted: false, truncated: false });
    });

    afterEach(() => {
      mod.num_rows.mockImplementation(() => 2);
    });

    it("carries footer stats and complete coverage once every row group is resident", async () => {
      const data = await loadTableFile(source);
      expect(ranged.parquet_file_column_stats).toHaveBeenCalledExactlyOnceWith(11);
      expect(data.rowCount).toBe(4);
      expect(data.datasetStats).toEqual([
        {
          nullCount: 1,
          min: 1,
          max: 9,
          boundedRowGroups: 2,
          boundsExact: true,
          hasInfinite: false,
        },
      ]);
      expect(data.coverage).toEqual({
        loadedRows: 4,
        totalRows: { value: 4, scope: "dataset", precision: "exact", source: "metadata" },
        rowGroups: 2,
        truncated: false,
      });
      expect(data.columnSummaries[0]?.scope).toMatchObject({
        distribution: { scope: "dataset" },
        range: { value: { min: 1, max: 9 }, scope: "dataset", source: "metadata" },
        nullCount: { value: 1, scope: "dataset", source: "metadata" },
      });
      data.dispose?.();
    });

    it("reports a truncated load with the footer total", async () => {
      ranged.parquet_file_budget
        .mockReturnValueOnce({ exhausted: true, truncated: true })
        .mockReturnValue({ exhausted: true, truncated: true });
      const data = await loadTableFile(source, { overflow: "truncate" });
      expect(ranged.parquet_append_row_group).toHaveBeenCalledTimes(1);
      expect(data.rowCount).toBe(2);
      expect(data.coverage).toEqual({
        loadedRows: 2,
        totalRows: { value: 4, scope: "dataset", precision: "exact", source: "metadata" },
        rowGroups: 2,
        truncated: true,
      });
      expect(data.columnSummaries[0]?.scope).toMatchObject({
        rows: { loaded: 2, dataset: { value: 4 } },
        distribution: { scope: "loaded", source: "resident" },
        range: { scope: "dataset" },
      });
      data.dispose?.();
    });
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
