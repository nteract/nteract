import { describe, expect, it } from "vite-plus/test";
import {
  applyColumnOverrides,
  applyParquetColumnHints,
  pandasIndexColumnsFromHints,
} from "./parquet-features";
import type { Column } from "./table";

function column(overrides: Partial<Column> = {}): Column {
  return {
    key: "image",
    label: "image",
    width: 80,
    sortable: true,
    numeric: false,
    columnType: "categorical",
    ...overrides,
  };
}

describe("parquet feature overrides", () => {
  it("lets explicit column overrides win over parquet metadata defaults", () => {
    const columns = [
      column({
        key: "__index_level_0__",
        label: "__index_level_0__",
        width: 40,
        sortable: true,
        numeric: true,
        columnType: "numeric",
      }),
      column(),
    ];

    const hints = [
      {
        name: "__index_level_0__",
        sortable: false,
        width: 78,
        label: "",
        pandasIndex: true,
        semanticType: "pandas_index",
      },
      {
        name: "image",
        columnType: "image" as const,
        numeric: false,
        sortable: false,
        width: 140,
        pandasIndex: false,
        semanticType: "huggingface_image",
      },
    ];

    applyParquetColumnHints(columns, hints);
    applyColumnOverrides(columns, {
      __index_level_0__: { label: "Row", width: 120, sortable: true },
      image: { columnType: "categorical", sortable: true, width: 180 },
    });

    expect(columns[0]).toMatchObject({ label: "Row", width: 120, sortable: true });
    expect(columns[1]).toMatchObject({
      columnType: "categorical",
      sortable: true,
      width: 180,
    });
    expect([...pandasIndexColumnsFromHints(hints)]).toEqual(["__index_level_0__"]);
  });
});
