/**
 * The view permutation: which data rows pass the column filters, in sort order.
 *
 * Shared by the table engine (resident mode) and the resident windowed adapter,
 * so both compute the same `dataRows` for the same filters and sort. WASM
 * sources supply `filterRows` and `sortColumn`; the JS fallback reads cells.
 */

import type { Column, ColumnFilter, TableData } from "./table";

type CellReader = Pick<TableData, "getCell" | "getCellRaw">;

export type SortSpec = { col: number; dir: "asc" | "desc" } | null;

/** Whether `dataRow` passes every filter. `filters` has one entry per column. */
export function rowPassesFilters(
  data: CellReader,
  filters: (ColumnFilter | null)[],
  dataRow: number,
): boolean {
  for (let c = 0; c < filters.length; c++) {
    const f = filters[c];
    if (!f) continue;
    const raw = data.getCellRaw(dataRow, c);
    switch (f.kind) {
      case "range": {
        if (raw == null) return false;
        const v = Number(raw);
        if (!Number.isFinite(v)) return false;
        if (v < f.min || v > f.max) return false;
        break;
      }
      case "set": {
        if (raw == null) return false;
        const s = data.getCell(dataRow, c);
        if (!f.values.has(s)) return false;
        break;
      }
      case "not-in": {
        // Null is not a string category, including the empty-string category.
        if (raw == null) break;
        const s = data.getCell(dataRow, c);
        // Inverted: exclude row if value IS in the exclusion set
        if (f.values.has(s)) return false;
        break;
      }
      case "boolean": {
        if (raw == null || Boolean(raw) !== f.value) return false;
        break;
      }
    }
  }
  return true;
}

/** JS fallback comparator for one column; nulls and non-finite values sort last. */
export function compareDataRows(
  data: CellReader,
  columns: Column[],
  col: number,
  dir: "asc" | "desc",
): (a: number, b: number) => number {
  const colType = columns[col].columnType;
  const isNumeric = colType === "numeric" || colType === "timestamp";
  return (a, b) => {
    let cmp: number;
    if (isNumeric) {
      const rawA = data.getCellRaw(a, col);
      const rawB = data.getCellRaw(b, col);
      const va = rawA == null ? NaN : Number(rawA);
      const vb = rawB == null ? NaN : Number(rawB);
      const aOk = Number.isFinite(va) || va === Infinity || va === -Infinity;
      const bOk = Number.isFinite(vb) || vb === Infinity || vb === -Infinity;
      if (!aOk && !bOk) cmp = 0;
      else if (!aOk) return 1;
      else if (!bOk) return -1;
      else cmp = va - vb;
    } else if (colType === "boolean") {
      const rawA = data.getCellRaw(a, col);
      const rawB = data.getCellRaw(b, col);
      if (rawA == null && rawB == null) cmp = 0;
      else if (rawA == null) return 1;
      else if (rawB == null) return -1;
      else cmp = (rawA ? 1 : 0) - (rawB ? 1 : 0);
    } else {
      const rawA = data.getCellRaw(a, col);
      const rawB = data.getCellRaw(b, col);
      if (rawA == null && rawB == null) cmp = 0;
      else if (rawA == null) return 1;
      else if (rawB == null) return -1;
      else {
        const sa = data.getCell(a, col);
        const sb = data.getCell(b, col);
        cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
      }
    }
    return dir === "asc" ? cmp : -cmp;
  };
}

/**
 * Data rows passing `filters`, in `sort` order. Uses the source's `filterRows`
 * and `sortColumn` when it has them (WASM) and intersects the sorted order
 * with the filter set, else filters and sorts by reading cells.
 */
export function computePermutation(
  data: TableData,
  columns: Column[],
  filters: (ColumnFilter | null)[],
  sort: SortSpec,
  rowCount: number,
): number[] {
  const hasFilters = filters.some((f) => f !== null);
  // Step 1: filter
  const filtered: number[] = [];
  if (hasFilters) {
    if (data.filterRows) {
      // WASM fast path: apply all filters in Rust, no per-cell FFI
      const wasmResult = data.filterRows(filters);
      for (let i = 0; i < wasmResult.length; i++) filtered.push(wasmResult[i]);
    } else {
      for (let i = 0; i < rowCount; i++) {
        if (rowPassesFilters(data, filters, i)) filtered.push(i);
      }
    }
  } else {
    for (let i = 0; i < rowCount; i++) filtered.push(i);
  }

  // Step 2: sort the filtered set
  if (sort) {
    const { col, dir } = sort;
    if (data.sortColumn) {
      // WASM fast path: get sorted indices for all rows, then intersect with filter
      const sortedAll = data.sortColumn(col, dir === "asc");
      if (hasFilters) {
        const filterSet = new Set(filtered);
        filtered.length = 0;
        for (let i = 0; i < sortedAll.length; i++) {
          if (filterSet.has(sortedAll[i])) filtered.push(sortedAll[i]);
        }
      } else {
        filtered.length = 0;
        for (let i = 0; i < sortedAll.length; i++) {
          filtered.push(sortedAll[i]);
        }
      }
    } else {
      filtered.sort(compareDataRows(data, columns, col, dir));
    }
  }
  return filtered;
}
