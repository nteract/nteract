import { describe, expect, it } from "vite-plus/test";
import {
  columnFiltersToPredicates,
  engineStateToExplorerState,
  explorerStateToJSON,
  type ExplorerState,
  predicateToPandas,
  predicateToSQL,
} from "./filter-schema";
import { type ColumnFilter, createTable, type TableData } from "./table";

/**
 * Five rows whose `value` mixes a real null, an empty string, and the text
 * sentinels "null" and "NA". The exclusion filter must keep the null rows
 * while dropping the chosen strings, and the exported predicate must say so.
 */
function fixture(): TableData {
  const rows: [number, string | null][] = [
    [1, null],
    [2, ""],
    [3, "null"],
    [4, "NA"],
    [5, null],
  ];
  const columns = [
    { key: "id", label: "id", width: 80, sortable: true, numeric: true, columnType: "numeric" },
    {
      key: "value",
      label: "value",
      width: 120,
      sortable: true,
      numeric: false,
      columnType: "categorical",
    },
  ] as const;
  return {
    columns: columns.map((c) => ({ ...c })),
    rowCount: rows.length,
    getCell: (r, c) => String(rows[r][c] ?? ""),
    getCellRaw: (r, c) => rows[r][c],
    columnSummaries: columns.map(() => null),
  };
}

describe.each(["columns", "engine"] as const)("%s filter export", (conversion) => {
  it.each([
    {
      excluded: [""],
      minimumId: 1,
      count: 4,
      exclusionSQL: `("value" IS NULL OR "value" NOT IN (''))`,
    },
    {
      excluded: ["NA"],
      minimumId: 1,
      count: 4,
      exclusionSQL: `("value" IS NULL OR "value" NOT IN ('NA'))`,
    },
    {
      excluded: ["", "null"],
      minimumId: 3,
      count: 2,
      exclusionSQL: `("value" IS NULL OR "value" NOT IN ('', 'null'))`,
    },
    { excluded: [], minimumId: 1, count: 5, exclusionSQL: "" },
  ])(
    "exports the displayed selection for $excluded with id >= $minimumId",
    ({ excluded, minimumId, count, exclusionSQL }) => {
      const data = fixture();
      const engine = createTable(document.createElement("div"), data);
      try {
        const filters: ColumnFilter[] = [
          { kind: "range", min: minimumId, max: 5 },
          { kind: "not-in", values: new Set(excluded) },
        ];
        filters.forEach((filter, col) => engine.setFilter(col, filter));
        const state = engine.getState();
        const explorer = engineStateToExplorerState(state);
        if (conversion === "columns") {
          explorer.filters = columnFiltersToPredicates(data.columns, filters);
        }
        // The persisted predicate must carry null semantics, not just the SQL compiler.
        const restored = JSON.parse(explorerStateToJSON(explorer)) as ExplorerState;
        const sql = restored.filters.map(predicateToSQL).join(" AND ");
        expect(state.filteredCount).toBe(count);
        expect(sql).toBe(
          `"id" BETWEEN ${minimumId} AND 5${exclusionSQL ? ` AND ${exclusionSQL}` : ""}`,
        );
        if (excluded.length > 0) {
          expect(restored.filters[1]).toEqual({
            op: "or",
            args: [
              { column: "value", op: "is_null" },
              { column: "value", op: "not_in", value: excluded },
            ],
          });
          expect(predicateToPandas(restored.filters[1])).toBe(
            `(df["value"].isna() | ~df["value"].isin(${JSON.stringify(excluded).replaceAll(",", ", ")}))`,
          );
        } else {
          expect(restored.filters).toHaveLength(1);
        }
      } finally {
        engine.destroy();
      }
    },
  );
});
