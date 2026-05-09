import type { Column } from "./table";

export interface ParquetColumnHint {
  name: string;
  columnType?: Column["columnType"];
  numeric?: boolean;
  sortable?: boolean;
  width?: number;
  label?: string;
  pandasIndex: boolean;
  semanticType?: string;
}

export function applyParquetColumnHints(columns: Column[], hints: ParquetColumnHint[]): void {
  const hintsByName = new Map(hints.map((hint) => [hint.name, hint]));
  for (const col of columns) {
    const hint = hintsByName.get(col.key);
    if (!hint) continue;

    if (hint.columnType) col.columnType = hint.columnType;
    if (hint.numeric !== undefined) col.numeric = hint.numeric;
    if (hint.sortable !== undefined) col.sortable = hint.sortable;
    if (hint.width !== undefined && col.width < hint.width) col.width = hint.width;
    if (hint.label !== undefined) col.label = hint.label;
  }
}

export function pandasIndexColumnsFromHints(hints: ParquetColumnHint[]): Set<string> {
  return new Set(hints.filter((hint) => hint.pandasIndex).map((hint) => hint.name));
}

/**
 * Name-based fallback for index/ID columns when the source has no parquet
 * footer to read (Arrow IPC, generated data, …). Mirrors Rust's
 * `nteract_predicate::is_index_like_name`; for parquet loads the Rust path is
 * authoritative and these names already round-trip through `pandasIndexCols`.
 */
const INDEX_NAME_PATTERN = /^(unnamed[: _]*\d*|index|_?id|rowid|row_?id|row_?num)$/i;

export function looksLikeIndexColumnName(name: string): boolean {
  return INDEX_NAME_PATTERN.test(name);
}

export function applyColumnOverrides(
  columns: Column[],
  columnOverrides?: Record<string, Partial<Column>>,
): void {
  if (!columnOverrides) return;
  for (const col of columns) {
    const override = columnOverrides[col.key];
    if (override) Object.assign(col, override);
  }
}
