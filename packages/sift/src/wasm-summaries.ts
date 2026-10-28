import { looksLikeIndexColumnName } from "./parquet-features";
import type { getModuleSync } from "./predicate";
import type {
  Column,
  ColumnFileStats,
  ColumnSummary,
  Coverage,
  DatasetCoverage,
  SummaryScope,
  TableData,
} from "./table";

// --- WASM summary computation ---

const RESIDENT_EXACT: Coverage = { scope: "loaded", precision: "exact", source: "resident" };
const DATASET_EXACT_RESIDENT: Coverage = {
  scope: "dataset",
  precision: "exact",
  source: "resident",
};

/**
 * Resident rows are the whole dataset: no coverage was declared, or nothing
 * was cut and the known total matches what is loaded. An unknown total is
 * not a claim about the dataset.
 */
function residentIsDataset(coverage: DatasetCoverage | undefined): boolean {
  if (!coverage) return true;
  if (coverage.truncated) return false;
  return coverage.totalRows !== undefined && coverage.totalRows.value === coverage.loadedRows;
}

type ScopeInputs = {
  numRows: number;
  coverage: DatasetCoverage | undefined;
  /** Footer stats for this column, or null when absent or the column is cast. */
  stats: ColumnFileStats | null;
  /** Null count over resident rows. */
  loadedNullCount: number;
  /** Distinct count over resident rows, where the summary tracks one. */
  uniqueCount?: number;
};

/**
 * Assemble per-metric coverage for one column. The distribution (bins,
 * categories, true/false) is always over resident rows; range and null count
 * come from footer metadata when the footer has usable numbers for the whole
 * file, and from resident rows otherwise.
 */
export function buildSummaryScope({
  numRows,
  coverage,
  stats,
  loadedNullCount,
  uniqueCount,
}: ScopeInputs): SummaryScope {
  const allResident = residentIsDataset(coverage);
  const rows: SummaryScope["rows"] = { loaded: numRows };
  if (coverage?.totalRows) rows.dataset = coverage.totalRows;

  const scope: SummaryScope = {
    rows,
    distribution: allResident ? DATASET_EXACT_RESIDENT : RESIDENT_EXACT,
  };

  const fallback: Coverage = allResident ? DATASET_EXACT_RESIDENT : RESIDENT_EXACT;
  if (stats && stats.nullCount !== null) {
    scope.nullCount = {
      value: stats.nullCount,
      scope: "dataset",
      precision: "exact",
      source: "metadata",
    };
  } else {
    scope.nullCount = { value: loadedNullCount, ...fallback };
  }

  const rowGroups = coverage?.rowGroups;
  if (
    stats &&
    rowGroups !== undefined &&
    stats.boundedRowGroups === rowGroups &&
    typeof stats.min === "number" &&
    typeof stats.max === "number"
  ) {
    scope.range = {
      value: { min: stats.min, max: stats.max },
      scope: "dataset",
      precision: stats.boundsExact ? "exact" : "estimated",
      source: "metadata",
    };
  }

  if (uniqueCount !== undefined) {
    scope.distinctCount = { value: uniqueCount, ...fallback };
  }

  return scope;
}

export function updateWasmSummaries(
  mod: ReturnType<typeof getModuleSync>,
  handle: number,
  tableData: TableData,
  columns: Column[],
  pandasIndexCols?: Set<string>,
) {
  const numRows = mod.num_rows(handle);
  const BIN_COUNT = 25;
  const nullCounts = mod.store_null_counts(handle);
  const { coverage, datasetStats } = tableData;

  const scopeFor = (c: number, uniqueCount?: number): SummaryScope => {
    // Footer stats describe the stored type; a cast column shows different
    // values, so its footer entry is ignored. The cast check is a WASM call,
    // so it runs only for columns that have footer stats to hide.
    let stats = datasetStats?.[c] ?? null;
    if (stats && tableData.isColumnCast?.(c)) stats = null;
    return buildSummaryScope({
      numRows,
      coverage,
      stats,
      loadedNullCount: nullCounts[c] ?? 0,
      uniqueCount,
    });
  };

  tableData.rowCount = numRows;
  tableData.columnSummaries = columns.map((col, c): ColumnSummary => {
    switch (col.columnType) {
      // No header chart for image columns yet.
      case "image":
        return null;
      case "categorical": {
        const counts = mod.store_value_counts(handle, c) as {
          label: string;
          count: number;
        }[];
        const allCategories = counts.map(({ label, count }) => ({
          label,
          count,
          pct: numRows > 0 ? Math.round((count / numRows) * 1000) / 10 : 0,
        }));
        const topCategories = allCategories.slice(0, 3);
        const othersCount = counts.slice(3).reduce((s, e) => s + e.count, 0);
        const othersPct = numRows > 0 ? Math.round((othersCount / numRows) * 1000) / 10 : 0;
        const lengths = counts.map(({ label }) => label.length).sort((a, b) => a - b);
        const medianTextLength = lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)] : 0;
        return {
          kind: "categorical" as const,
          uniqueCount: counts.length,
          topCategories,
          othersCount,
          othersPct,
          allCategories,
          medianTextLength,
          nullCount: nullCounts[c] ?? 0,
          scope: scopeFor(c, counts.length),
        };
      }
      case "boolean": {
        const [trueCount, falseCount, nullCount] = mod.store_bool_counts(handle, c);
        return {
          kind: "boolean" as const,
          trueCount,
          falseCount,
          nullCount,
          total: numRows,
          scope: scopeFor(c),
        };
      }
      case "timestamp": {
        const bins = mod.store_temporal_histogram(handle, c) as {
          x0: number;
          x1: number;
          count: number;
        }[];
        if (bins.length === 0) return null;
        return {
          kind: "timestamp" as const,
          min: bins[0].x0,
          max: bins[bins.length - 1].x1,
          bins,
          nullCount: nullCounts[c] ?? 0,
          scope: scopeFor(c),
        };
      }
      case "numeric": {
        const bins = mod.store_histogram(handle, c, BIN_COUNT) as {
          x0: number;
          x1: number;
          count: number;
        }[];
        if (bins.length === 0) return null;
        // Parquet loads carry `pandasIndexCols` from the Rust hints; Arrow IPC
        // and other sources without footer metadata fall back to a name match.
        const isIndex = pandasIndexCols?.has(col.key) ?? looksLikeIndexColumnName(col.key);
        return {
          kind: "numeric" as const,
          min: bins[0].x0,
          max: bins[bins.length - 1].x1,
          bins,
          isIndex: isIndex ? true : undefined,
          nullCount: nullCounts[c] ?? 0,
          scope: scopeFor(c),
        };
      }
    }
  });
}
