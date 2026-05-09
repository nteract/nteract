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
