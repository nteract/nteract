import { describe, expect, it, vi } from "vite-plus/test";
import type { ColumnFilter, TableData } from "./table";
import { makeRows, makeTableData } from "./table.fixtures";
import { createResidentWindowedData } from "./windowed-resident";

const gen = 1;

/** Reference permutation: the source's own `filterRows`, then `sortColumn`, intersected. */
function reference(
  data: TableData,
  filters: (ColumnFilter | null)[],
  sort: { col: number; dir: "asc" | "desc" } | null,
): number[] {
  const active = filters.some((f) => f !== null);
  let rows = active
    ? Array.from(data.filterRows!(filters))
    : Array.from({ length: data.rowCount }, (_, i) => i);
  if (sort) {
    const keep = new Set(rows);
    rows = Array.from(data.sortColumn!(sort.col, sort.dir === "asc")).filter((r) => keep.has(r));
  }
  return rows;
}

/** A JS source that also offers the WASM-shaped fast paths over the same rows. */
function sourceWithFastPaths(rows: unknown[][]): TableData {
  const data = makeTableData(rows);
  data.filterRows = vi.fn((filters) => {
    const out: number[] = [];
    for (let r = 0; r < rows.length; r++) {
      let ok = true;
      for (let c = 0; c < filters.length && ok; c++) {
        const f = filters[c];
        if (!f) continue;
        const raw = rows[r][c];
        if (f.kind === "range")
          ok = raw != null && (raw as number) >= f.min && (raw as number) <= f.max;
        else if (f.kind === "boolean") ok = raw === f.value;
        else if (f.kind === "set") ok = f.values.has(String(raw));
        else if (f.kind === "not-in") ok = raw == null || !f.values.has(String(raw));
      }
      if (ok) out.push(r);
    }
    return Uint32Array.from(out);
  });
  data.sortColumn = vi.fn((col, ascending) =>
    Uint32Array.from(
      Array.from({ length: rows.length }, (_, i) => i).sort((a, b) => {
        const va = rows[a][col] as number | string;
        const vb = rows[b][col] as number | string;
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return ascending ? cmp : -cmp;
      }),
    ),
  );
  data.recomputeFilteredSummaries = vi.fn();
  return data;
}

async function dataRowsFor(
  adapter: ReturnType<typeof createResidentWindowedData>,
  filters: (ColumnFilter | null)[],
  sort: { col: number; dir: "asc" | "desc" } | null,
): Promise<number[]> {
  const result = await adapter.setQuery({ filters, sort }, gen);
  const cells = await adapter.requestWindow(0, result.filteredCount, gen);
  expect(cells.viewStart).toBe(0);
  expect(cells.dataRows.length).toBe(result.filteredCount);
  return Array.from(cells.dataRows);
}

describe("createResidentWindowedData", () => {
  const rows = makeRows(60);
  const none: (ColumnFilter | null)[] = [null, null, null, null];
  const cases: {
    name: string;
    filters: (ColumnFilter | null)[];
    sort: { col: number; dir: "asc" | "desc" } | null;
  }[] = [
    { name: "identity", filters: none, sort: null },
    { name: "sort asc", filters: none, sort: { col: 2, dir: "asc" } },
    { name: "sort desc by text", filters: none, sort: { col: 1, dir: "desc" } },
    {
      name: "range filter",
      filters: [null, null, { kind: "range", min: 10, max: 60 }, null],
      sort: null,
    },
    {
      name: "boolean filter + sort",
      filters: [null, null, null, { kind: "boolean", value: true }],
      sort: { col: 2, dir: "desc" },
    },
    {
      name: "set + not-in + sort",
      filters: [
        null,
        { kind: "not-in", values: new Set(["Person 1", "Person 2"]) },
        { kind: "range", min: 0, max: 80 },
        null,
      ],
      sort: { col: 0, dir: "desc" },
    },
  ];

  it.each(cases)(
    "matches the filterRows + sortColumn reference: $name",
    async ({ filters, sort }) => {
      const fast = sourceWithFastPaths(rows);
      const adapter = createResidentWindowedData(fast);
      expect(await dataRowsFor(adapter, filters, sort)).toEqual(reference(fast, filters, sort));

      // The JS fallback (no fast paths) agrees on the same rows.
      const plain = createResidentWindowedData(makeTableData(rows));
      expect(await dataRowsFor(plain, filters, sort)).toEqual(reference(fast, filters, sort));
    },
  );

  it("builds the mask for filtered summaries and restores the unfiltered snapshot", async () => {
    const fast = sourceWithFastPaths(rows);
    fast.columnSummaries = fast.columns.map((c) =>
      c.columnType === "boolean"
        ? { kind: "boolean", trueCount: 40, falseCount: 20, nullCount: 0, total: 60 }
        : null,
    );
    const adapter = createResidentWindowedData(fast);
    const filters: (ColumnFilter | null)[] = [null, null, null, { kind: "boolean", value: true }];
    const result = await adapter.setQuery({ filters, sort: null }, gen);
    const expectedRows = rows.filter((r) => r[3] === true).length;
    expect(result.filteredCount).toBe(expectedRows);
    const [mask, count] = vi.mocked(fast.recomputeFilteredSummaries!).mock.calls[0];
    expect(count).toBe(expectedRows);
    expect(Array.from(mask).filter((bit) => bit === 1)).toHaveLength(expectedRows);
    expect(result.summariesAll[3]).toMatchObject({ kind: "boolean", trueCount: 40 });

    const cleared = await adapter.setQuery({ filters: none, sort: null }, gen);
    expect(cleared.filteredCount).toBe(60);
    expect(cleared.summaries).toEqual(cleared.summariesAll);
  });

  it("exposes the head, cells with nulls and booleans, images, events, and one dispose", async () => {
    const data = makeTableData([
      [1, "a", null, true],
      [2, null, 5, false],
    ]);
    data.dispose = vi.fn();
    data.prefetchViewport = vi.fn();
    const adapter = createResidentWindowedData(data, { headRows: 1 });
    expect(Array.from(adapter.head.dataRows)).toEqual([0]);
    expect(adapter.head.strings).toEqual(["1", "a", "", "true"]);
    expect(Array.from(adapter.head.nulls)).toEqual([0, 0, 1, 0]);
    expect(Array.from(adapter.head.numeric)).toEqual([1, Number.NaN, Number.NaN, 1]);

    const cells = await adapter.requestWindow(1, 5, gen);
    expect(Array.from(cells.dataRows)).toEqual([1]);
    expect(Array.from(cells.nulls)).toEqual([0, 1, 0, 0]);
    expect(Array.from(cells.numeric)).toEqual([2, Number.NaN, 5, 0]);
    expect(data.prefetchViewport).toHaveBeenCalledWith([1]);
    expect(await adapter.requestImage(0, 1)).toBeNull();

    const events: string[] = [];
    const unsubscribe = adapter.subscribe((event) => events.push(event.type));
    data.rowCount = 2;
    adapter.notifyAppended();
    adapter.notifyStreamingDone();
    expect(events).toEqual(["rows-appended", "streaming-done"]);
    unsubscribe();
    adapter.notifyStreamingDone();
    expect(events).toHaveLength(2);

    adapter.dispose();
    adapter.dispose();
    expect(data.dispose).toHaveBeenCalledTimes(1);
    await expect(adapter.requestWindow(0, 1, gen)).rejects.toThrow("disposed");
  });
});
