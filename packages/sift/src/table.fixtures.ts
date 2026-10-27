/**
 * Table fixtures shared by the engine test suites: the four-column
 * `id`/`name`/`score`/`active` table and a JS-backed `TableData` over rows.
 * Mirrors the helpers inside `table.test.ts` so the windowed suite runs the
 * same shapes through `createResidentWindowedData`.
 */

import type { Column, TableData } from "./table";

export function makeColumns(): Column[] {
  return [
    {
      key: "id",
      label: "ID",
      width: 80,
      sortable: true,
      numeric: true,
      columnType: "numeric",
    },
    {
      key: "name",
      label: "Name",
      width: 150,
      sortable: true,
      numeric: false,
      columnType: "categorical",
    },
    {
      key: "score",
      label: "Score",
      width: 100,
      sortable: true,
      numeric: true,
      columnType: "numeric",
    },
    {
      key: "active",
      label: "Active",
      width: 80,
      sortable: true,
      numeric: false,
      columnType: "boolean",
    },
  ];
}

export function makeTableDataWithColumns(rows: unknown[][], columns: Column[]): TableData {
  return {
    columns,
    rowCount: rows.length,
    getCell: (r, c) => String(rows[r][c] ?? ""),
    getCellRaw: (r, c) => rows[r][c],
    columnSummaries: columns.map(() => null),
  };
}

export function makeTableData(rows: unknown[][]): TableData {
  return makeTableDataWithColumns(rows, makeColumns());
}

/** `count` rows with deterministic scores so sort assertions are stable. */
export function makeRows(count: number): unknown[][] {
  const rows: unknown[][] = [];
  for (let i = 0; i < count; i++) {
    rows.push([i + 1, `Person ${i}`, (i * 37) % 101, i % 3 !== 0]);
  }
  return rows;
}
