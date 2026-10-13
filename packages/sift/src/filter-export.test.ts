import { describe, expect, it } from "vite-plus/test";
import { parseCsv } from "./csv";
import {
  columnFiltersToPredicates,
  engineStateToExplorerState,
  explorerStateToJSON,
  type ExplorerState,
  predicateToPandas,
  predicateToSQL,
} from "./filter-schema";
import { type ColumnFilter, createTable } from "./table";

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
      const data = parseCsv('id,value\n1,\n2,""\n3,null\n4,NA\n5,');
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
