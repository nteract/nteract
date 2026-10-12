import { describe, expect, it, vi } from "vite-plus/test";
import { parseCsv } from "./csv";
import { createTable } from "./table";

describe("parseCsv", () => {
  it("reads complete quoted UTF-8 CSV with BOM, CRLF, escaped quotes and multiline fields", () => {
    const data = parseCsv('\uFEFFname,notes,score\r\nZoë,"one, two\r\n""three""",12\r\nKai,,2\r\n');
    expect(data.rowCount).toBe(2);
    expect(data.columns.map((column) => column.key)).toEqual(["name", "notes", "score"]);
    expect(data.getCell(0, 1)).toBe('one, two\r\n"three"');
    expect(data.getCellRaw(1, 1)).toBeNull();
    expect(data.getCellRaw(0, 2)).toBe(12);
    expect(data.columns[2].columnType).toBe("numeric");
  });

  it("preserves nulls, quoted empty strings, null-like text, identifiers and unsafe integers", () => {
    const data = parseCsv(
      'empty,quoted,literal,id,big,date\n,"",NA,001,9007199254740993,2026-10-12\n',
    );
    expect(Array.from({ length: 6 }, (_, col) => data.getCellRaw(0, col))).toEqual([
      null,
      "",
      "NA",
      "001",
      "9007199254740993",
      "2026-10-12",
    ]);
    expect(data.columns.every((column) => column.columnType === "categorical")).toBe(true);
  });

  it("uses every row for inference and retains the original display spelling", () => {
    const data = parseCsv("number,flag,mixed\n1.20,true,1\n2e2,false,2\n,,text");
    expect(data.columns.map((column) => column.columnType)).toEqual([
      "numeric",
      "boolean",
      "categorical",
    ]);
    expect(data.getCell(0, 0)).toBe("1.20");
    expect(data.getCellRaw(1, 0)).toBe(200);
    expect(data.getCellRaw(1, 1)).toBe(false);
    expect(data.getCellRaw(2, 1)).toBeNull();
    expect(data.columnSummaries[1]).toEqual({
      kind: "boolean",
      trueCount: 1,
      falseCount: 1,
      nullCount: 1,
      total: 3,
    });
    expect(data.getCellRaw(0, 2)).toBe("1");
  });

  it("keeps nulls out of categories while retaining quoted empty and null-like text", () => {
    const data = parseCsv('id,value\n1,\n2,""\n3,null\n4,NA\n5,');
    expect(data.columnSummaries[1]).toMatchObject({
      kind: "categorical",
      uniqueCount: 3,
      allCategories: [
        { label: "", count: 1, pct: 20 },
        { label: "null", count: 1, pct: 20 },
        { label: "NA", count: 1, pct: 20 },
      ],
    });
    data.recomputeFilteredSummaries?.(new Uint8Array([1, 0, 0, 0, 1]), 2);
    expect(data.columnSummaries[1]).toMatchObject({ uniqueCount: 0, allCategories: [] });
    data.recomputeFilteredSummaries?.(new Uint8Array(5), 0);
    expect(data.columnSummaries[1]).toMatchObject({ allCategories: [], othersPct: 0 });
  });

  it("selects and excludes quoted empty categories without matching null cells", async () => {
    vi.useFakeTimers();
    const data = parseCsv('id,value\n1,\n2,""\n3,null\n4,NA\n5,');
    const engine = createTable(document.createElement("div"), data);
    try {
      engine.setFilter(1, { kind: "set", values: new Set([""]) });
      expect(engine.getState().filteredCount).toBe(1);
      await vi.advanceTimersByTimeAsync(150);
      expect(data.columnSummaries[0]).toMatchObject({ min: 2, max: 2 });
      expect(data.columnSummaries[1]).toMatchObject({
        allCategories: [{ label: "", count: 1, pct: 100 }],
      });
      engine.setFilter(1, { kind: "not-in", values: new Set([""]) });
      expect(engine.getState().filteredCount).toBe(4);
      await vi.advanceTimersByTimeAsync(150);
      expect(data.columnSummaries[0]).toMatchObject({ min: 1, max: 5 });
      expect(data.columnSummaries[1]).toMatchObject({
        allCategories: [
          { label: "null", count: 1, pct: 25 },
          { label: "NA", count: 1, pct: 25 },
        ],
      });
      engine.clearAllFilters();
      expect(engine.getState().filteredCount).toBe(5);
    } finally {
      engine.destroy();
      vi.useRealTimers();
    }
  });

  it("preserves explicit blank records instead of silently dropping null rows", () => {
    const data = parseCsv("a\n1\n\n");
    expect(data.rowCount).toBe(2);
    expect(data.getCellRaw(1, 0)).toBeNull();
    expect(() => parseCsv("a,b\n1,2\n\n")).toThrow(/record 3.*1 fields.*expected 2/);
  });

  it("can keep all non-null values as text", () => {
    const data = parseCsv("n,b\n2,true", { typing: "text" });
    expect(data.getCellRaw(0, 0)).toBe("2");
    expect(data.getCellRaw(0, 1)).toBe("true");
    expect(data.columns.map((column) => column.columnType)).toEqual(["categorical", "categorical"]);
  });

  it.each(["1e-400", "9007199254740991.1", "0.1234567890123456789", "1e400"])(
    "retains %s as text rather than destroying its numeric value",
    (value) => {
      const data = parseCsv(`value\n${value}\n0`);
      expect(data.columns[0].columnType).toBe("categorical");
      expect(data.getCellRaw(0, 0)).toBe(value);
    },
  );

  it("reads a long field without losing characters at escaped-quote boundaries", () => {
    const chunk = "x".repeat(100_000);
    const data = parseCsv(`value\n"${chunk}""${chunk}"`);
    expect(data.getCell(0, 0)).toBe(`${chunk}"${chunk}`);
  });

  it.each(["\t", ";", "|"] as const)(
    "accepts explicit %j delimiter without sniffing",
    (delimiter) => {
      const data = parseCsv(`name${delimiter}value\rZoë${delimiter}"a,b"`, { delimiter });
      expect(data.columns).toHaveLength(2);
      expect(data.getCell(0, 1)).toBe("a,b");
    },
  );

  it("supports empty and header-only files and disambiguates missing or repeated headers", () => {
    expect(parseCsv("").rowCount).toBe(0);
    expect(parseCsv("\uFEFF").columns).toEqual([]);
    expect(parseCsv("a,b\n").columns.map((column) => column.key)).toEqual(["a", "b"]);
    expect(parseCsv("a,b\n").rowCount).toBe(0);
    const data = parseCsv(",a,a,Column 1\n1,2,3,4\n");
    expect(data.columns.map((column) => column.key)).toEqual([
      "Column 1",
      "a",
      "a (2)",
      "Column 1 (2)",
    ]);
    expect(data.getCellRaw(0, 3)).toBe(4);
  });

  it.each([
    ["a,b\n1", /record 2.*1 fields.*expected 2/],
    ["a\n1,2", /record 2.*2 fields.*expected 1/],
    ['a\n"unclosed', /Unterminated/],
    ['a\nx"y', /Unexpected quote/],
    ['a\n"x"y', /after a closing quote/],
  ])("rejects malformed input %j instead of returning partial rows", (text, error) => {
    expect(() => parseCsv(text)).toThrow(error);
  });

  it("fails closed on byte, row, column and cell limits", () => {
    expect(() => parseCsv("a\né", { maxBytes: 3 })).toThrow(/byte limit/);
    expect(parseCsv("a\né", { maxBytes: 4 }).rowCount).toBe(1);
    expect(() => parseCsv("a\n1\n2", { maxRows: 1 })).toThrow(/row limit/);
    expect(() => parseCsv("a,b", { maxColumns: 1 })).toThrow(/column limit/);
    expect(() => parseCsv("a,b\n1,2\n3,4", { maxCells: 3 })).toThrow(/cell limit/);
    expect(parseCsv("a,b\n1,2\n3,4", { maxCells: 4 }).rowCount).toBe(2);
  });

  it.each([0, -1, Infinity, NaN, 1.5])("rejects invalid limits %j", (value) => {
    expect(() => parseCsv("a", { maxRows: value })).toThrow(/positive safe integer/);
  });

  it("filters inferred booleans and refreshes summaries without treating nulls as false", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const data = parseCsv("id,active\n1,true\n2,false\n3,\n");
    const engine = createTable(container, data);
    try {
      engine.setFilter(1, { kind: "boolean", value: false });
      expect(engine.getState().filteredCount).toBe(1);
      await vi.advanceTimersByTimeAsync(150);
      expect(data.columnSummaries[0]).toMatchObject({ kind: "numeric", min: 2, max: 2 });
      expect(data.columnSummaries[1]).toEqual({
        kind: "boolean",
        trueCount: 0,
        falseCount: 1,
        nullCount: 0,
        total: 1,
      });
      engine.setFilter(1, null);
      engine.setFilter(0, { kind: "range", min: 2, max: 3 });
      expect(engine.getState().filteredCount).toBe(2);
      await vi.advanceTimersByTimeAsync(150);
      expect(data.columnSummaries[1]).toEqual({
        kind: "boolean",
        trueCount: 0,
        falseCount: 1,
        nullCount: 1,
        total: 2,
      });
    } finally {
      engine.destroy();
      vi.useRealTimers();
    }
  });
});
