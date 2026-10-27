import { describe, expect, it, vi } from "vite-plus/test";
import type { getModuleSync } from "./predicate";
import type { Column, ColumnFileStats, DatasetCoverage, TableData } from "./table";
import { buildSummaryScope, updateWasmSummaries } from "./wasm-summaries";

type Mod = ReturnType<typeof getModuleSync>;

const columns: Column[] = [
  { key: "n", label: "n", width: 100, sortable: true, numeric: true, columnType: "numeric" },
  { key: "s", label: "s", width: 100, sortable: true, numeric: false, columnType: "categorical" },
  { key: "b", label: "b", width: 100, sortable: true, numeric: false, columnType: "boolean" },
  { key: "t", label: "t", width: 100, sortable: true, numeric: false, columnType: "timestamp" },
];

function makeMod(numRows: number): Mod {
  return {
    num_rows: vi.fn(() => numRows),
    store_null_counts: vi.fn(() => new Uint32Array([3, 1, 2, 0])),
    store_histogram: vi.fn(() => [
      { x0: 0, x1: 5, count: 4 },
      { x0: 5, x1: 10, count: 3 },
    ]),
    store_value_counts: vi.fn(() => [
      { label: "a", count: 5 },
      { label: "b", count: 4 },
    ]),
    store_bool_counts: vi.fn(() => new Uint32Array([4, 4, 2])),
    store_temporal_histogram: vi.fn(() => [
      { x0: 1_000, x1: 2_000, count: 5 },
      { x0: 2_000, x1: 3_000, count: 5 },
    ]),
  } as unknown as Mod;
}

function makeTableData(
  coverage?: DatasetCoverage,
  datasetStats?: (ColumnFileStats | null)[],
  castColumns: number[] = [],
): TableData {
  return {
    columns,
    rowCount: 0,
    getCell: () => "",
    getCellRaw: () => null,
    columnSummaries: [],
    coverage,
    datasetStats,
    isColumnCast: (c) => castColumns.includes(c),
  };
}

const footerStats: ColumnFileStats = {
  nullCount: 300,
  min: -5,
  max: 95,
  boundedRowGroups: 4,
  boundsExact: true,
  hasInfinite: false,
};

const truncated: DatasetCoverage = {
  loadedRows: 10,
  totalRows: { value: 1_000, scope: "dataset", precision: "exact", source: "metadata" },
  rowGroups: 4,
  truncated: true,
};

const complete: DatasetCoverage = {
  loadedRows: 10,
  totalRows: { value: 10, scope: "dataset", precision: "exact", source: "metadata" },
  rowGroups: 4,
  truncated: false,
};

describe("updateWasmSummaries scope", () => {
  it("labels a truncated load as loaded-rows and lifts footer range and nulls to the file", () => {
    const data = makeTableData(truncated, [footerStats, null, null, null]);
    updateWasmSummaries(makeMod(10), 1, data, columns);

    const numeric = data.columnSummaries[0];
    expect(numeric?.kind).toBe("numeric");
    if (numeric?.kind !== "numeric") return;
    // The histogram and its brush domain stay over loaded rows.
    expect(numeric.min).toBe(0);
    expect(numeric.max).toBe(10);
    expect(numeric.nullCount).toBe(3);
    expect(numeric.scope).toEqual({
      rows: { loaded: 10, dataset: truncated.totalRows },
      distribution: { scope: "loaded", precision: "exact", source: "resident" },
      range: {
        value: { min: -5, max: 95 },
        scope: "dataset",
        precision: "exact",
        source: "metadata",
      },
      nullCount: { value: 300, scope: "dataset", precision: "exact", source: "metadata" },
    });

    // Columns without footer stats report what the resident rows show.
    const categorical = data.columnSummaries[1];
    if (categorical?.kind !== "categorical") throw new Error("expected categorical");
    expect(categorical.nullCount).toBe(1);
    expect(categorical.scope?.nullCount).toEqual({
      value: 1,
      scope: "loaded",
      precision: "exact",
      source: "resident",
    });
    expect(categorical.scope?.distinctCount).toEqual({
      value: 2,
      scope: "loaded",
      precision: "exact",
      source: "resident",
    });
    expect(categorical.scope?.range).toBeUndefined();

    const boolean = data.columnSummaries[2];
    if (boolean?.kind !== "boolean") throw new Error("expected boolean");
    expect(boolean.scope?.distribution.scope).toBe("loaded");
    expect(boolean.scope?.nullCount?.value).toBe(2);

    const timestamp = data.columnSummaries[3];
    if (timestamp?.kind !== "timestamp") throw new Error("expected timestamp");
    expect(timestamp.nullCount).toBe(0);
    expect(timestamp.scope?.distribution.scope).toBe("loaded");
  });

  it("labels a complete load as the whole dataset over resident rows", () => {
    const data = makeTableData(complete, [footerStats, null, null, null]);
    updateWasmSummaries(makeMod(10), 1, data, columns);
    for (const summary of data.columnSummaries) {
      expect(summary?.scope?.distribution).toEqual({
        scope: "dataset",
        precision: "exact",
        source: "resident",
      });
      expect(summary?.scope?.rows).toEqual({ loaded: 10, dataset: complete.totalRows });
    }
    // Footer metadata still wins for the metrics it covers.
    expect(data.columnSummaries[0]?.scope?.nullCount?.source).toBe("metadata");
    expect(data.columnSummaries[1]?.scope?.nullCount).toEqual({
      value: 1,
      scope: "dataset",
      precision: "exact",
      source: "resident",
    });
  });

  it("treats a table without coverage as fully resident", () => {
    const data = makeTableData();
    updateWasmSummaries(makeMod(10), 1, data, columns);
    expect(data.columnSummaries[0]?.scope).toEqual({
      rows: { loaded: 10 },
      distribution: { scope: "dataset", precision: "exact", source: "resident" },
      nullCount: { value: 3, scope: "dataset", precision: "exact", source: "resident" },
    });
  });

  it("hides footer stats for a cast column", () => {
    const data = makeTableData(truncated, [footerStats, null, null, null], [0]);
    updateWasmSummaries(makeMod(10), 1, data, columns);
    const scope = data.columnSummaries[0]?.scope;
    expect(scope?.range).toBeUndefined();
    expect(scope?.nullCount).toEqual({
      value: 3,
      scope: "loaded",
      precision: "exact",
      source: "resident",
    });
  });

  it("does not ask whether a column is cast unless it has footer stats", () => {
    const isColumnCast = vi.fn(() => false);
    const data = { ...makeTableData(truncated, [footerStats, null, null, null]), isColumnCast };
    updateWasmSummaries(makeMod(10), 1, data, columns);
    expect(isColumnCast).toHaveBeenCalledTimes(1);
    expect(isColumnCast).toHaveBeenCalledWith(0);
  });
});

describe("buildSummaryScope", () => {
  const base = { numRows: 10, coverage: truncated, loadedNullCount: 3 };

  it("falls back to the loaded null count when the footer has none", () => {
    const scope = buildSummaryScope({ ...base, stats: { ...footerStats, nullCount: null } });
    expect(scope.nullCount).toEqual({
      value: 3,
      scope: "loaded",
      precision: "exact",
      source: "resident",
    });
    expect(scope.range?.scope).toBe("dataset");
  });

  it("omits the range when bounds do not cover every row group", () => {
    const scope = buildSummaryScope({ ...base, stats: { ...footerStats, boundedRowGroups: 3 } });
    expect(scope.range).toBeUndefined();
  });

  it("omits the range for non-numeric bounds and keeps infinite ones", () => {
    expect(
      buildSummaryScope({ ...base, stats: { ...footerStats, min: "a", max: "z" } }).range,
    ).toBeUndefined();
    const infinite = buildSummaryScope({
      ...base,
      stats: { ...footerStats, max: Number.POSITIVE_INFINITY, hasInfinite: true },
    });
    expect(infinite.range?.value.max).toBe(Number.POSITIVE_INFINITY);
  });

  it("marks truncated string bounds as estimated", () => {
    const scope = buildSummaryScope({ ...base, stats: { ...footerStats, boundsExact: false } });
    expect(scope.range?.precision).toBe("estimated");
  });

  it("does not claim the dataset when the total is unknown", () => {
    const scope = buildSummaryScope({
      ...base,
      coverage: { loadedRows: 10, truncated: false },
      stats: null,
    });
    expect(scope.distribution.scope).toBe("loaded");
    expect(scope.rows).toEqual({ loaded: 10 });
  });
});
