import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, waitFor } from "@testing-library/react";
import { Table, tableFromArrays, tableToIPC, Utf8, vectorFromArray } from "apache-arrow";
import { createElement, StrictMode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { loadTableFile } from "./file-data";
import { typeOverridesFromHints } from "./parquet-features";
import { type ByteSource, coalesceRanges, openParquetFile } from "./parquet-file";
import {
  _resetPredicateModuleForTests,
  _setWasmModuleLoaderForTests,
  getModuleSync,
} from "./predicate";
import { SiftTable, type SiftLoadMilestone, type SiftSource } from "./react";

const wasmPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../crates/sift-wasm/pkg/sift_wasm_bg.wasm",
);

type Read = { offset: number; length: number };

/** In-memory ByteSource that records every read. */
function recordingSource(bytes: Uint8Array): ByteSource & { reads: Read[] } {
  const reads: Read[] = [];
  return {
    reads,
    byteLength: bytes.byteLength,
    read(offset, length) {
      reads.push({ offset, length });
      return Promise.resolve(bytes.subarray(offset, offset + length));
    },
  };
}

describe("typeOverridesFromHints", () => {
  it("pins footer types under host overrides", () => {
    const pins = typeOverridesFromHints(
      [
        { name: "label", columnType: "categorical", numeric: false, pandasIndex: false },
        { name: "idx", pandasIndex: true, sortable: false },
        { name: "pic", columnType: "image", pandasIndex: false },
      ],
      { pic: { columnType: "categorical" }, other: { width: 10 } },
    );
    expect(pins).toEqual({
      label: { columnType: "categorical", numeric: false },
      pic: { columnType: "categorical" },
      other: { width: 10 },
    });
  });
});

describe("coalesceRanges", () => {
  it("merges touching and near ranges and keeps distant ones apart", () => {
    expect(coalesceRanges([100, 50, 150, 50, 1000, 10], 64)).toEqual([
      { offset: 100, length: 100 },
      { offset: 1000, length: 10 },
    ]);
    expect(coalesceRanges([300, 10, 100, 100, 220, 10], 64)).toEqual([
      { offset: 100, length: 130 },
      { offset: 300, length: 10 },
    ]);
    expect(coalesceRanges([], 64)).toEqual([]);
  });

  it("keeps the bytes it requests within a fetch budget", () => {
    // Four 100-byte chunks with 50-byte gaps: 400 bytes of chunks, 550 merged.
    const flat = [0, 100, 150, 100, 300, 100, 450, 100];
    const requested = (ranges: { length: number }[]) =>
      ranges.reduce((sum, range) => sum + range.length, 0);
    expect(requested(coalesceRanges(flat, 64))).toBe(550);
    // A 500-byte budget pays for two of the three gaps.
    const bounded = coalesceRanges(flat, 64, 500);
    expect(requested(bounded)).toBeLessThanOrEqual(500);
    expect(bounded).toEqual([
      { offset: 0, length: 400 },
      { offset: 450, length: 100 },
    ]);
    // With no room for any gap, every chunk is fetched on its own.
    expect(requested(coalesceRanges(flat, 64, 400))).toBe(400);
    expect(coalesceRanges(flat, 64, 400)).toHaveLength(4);
    // Touching chunks cost nothing extra and still merge.
    expect(coalesceRanges([0, 100, 100, 100], 64, 200)).toEqual([{ offset: 0, length: 200 }]);
  });
});

// The workspace's normal WASM build supplies these artifacts. Unit tests still
// work in a source-only checkout; run `cargo xtask wasm sift` to enable this suite.
describe.skipIf(!existsSync(wasmPath))("byte-range Parquet with real WASM", () => {
  const ROWS_PER_GROUP = 6000;
  const GROUPS = 3;
  const DEFAULT_LIMITS = { maxRows: 100_000, maxColumns: 256, maxDecodedBytes: 128 * 1024 * 1024 };
  let parquet: Uint8Array;
  let writeParquet: (bytes: Uint8Array, rows?: number) => Uint8Array;

  beforeAll(async () => {
    const wasm = await import("sift-wasm/sift_wasm.js");
    const binary = readFileSync(wasmPath);
    await wasm.default({ module_or_path: binary });
    _resetPredicateModuleForTests();
    _setWasmModuleLoaderForTests(async () => ({ ...wasm, default: async () => undefined }));
    writeParquet = (
      wasm as unknown as {
        write_parquet_ipc_row_groups: (bytes: Uint8Array, rows?: number) => Uint8Array;
      }
    ).write_parquet_ipc_row_groups;

    // Deterministic, poorly compressible text so the file exceeds the 64 KiB
    // initial tail read and row groups have distinct byte ranges.
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    let table: Table | undefined;
    for (let group = 0; group < GROUPS; group++) {
      const base = group * ROWS_PER_GROUP;
      const batch = tableFromArrays({
        id: Int32Array.from({ length: ROWS_PER_GROUP }, (_, i) => base + i),
        text: Array.from({ length: ROWS_PER_GROUP }, (_, i) =>
          i % 97 === 3 ? null : `${next().toString(36)}-${base + i}`,
        ),
      });
      table = table ? table.concat(batch) : batch;
    }
    parquet = writeParquet(tableToIPC(table!, "stream"), ROWS_PER_GROUP);
    expect(parquet.byteLength).toBeGreaterThan(64 * 1024);
  });

  afterAll(() => {
    _setWasmModuleLoaderForTests(null);
    _resetPredicateModuleForTests();
  });

  it("reads the footer then one range per row group, never the whole file", async () => {
    const source = recordingSource(parquet);
    const data = await loadTableFile(source);
    try {
      expect(data.rowCount).toBe(ROWS_PER_GROUP * GROUPS);
      expect(data.columns.map((c) => c.key)).toEqual(["id", "text"]);
      expect(data.getCellRaw(0, 0)).toBe(0);
      expect(data.getCellRaw(ROWS_PER_GROUP, 0)).toBe(ROWS_PER_GROUP);
      expect(data.getCellRaw(ROWS_PER_GROUP * GROUPS - 1, 0)).toBe(ROWS_PER_GROUP * GROUPS - 1);
      expect(data.getCellRaw(3, 1)).toBeNull();
      expect(data.columnSummaries[0]).toMatchObject({
        kind: "numeric",
        min: 0,
        max: ROWS_PER_GROUP * GROUPS - 1,
      });

      const [tail, ...groups] = source.reads;
      expect(tail).toEqual({ offset: parquet.byteLength - 64 * 1024, length: 64 * 1024 });
      // Contiguous column chunks coalesce to one read per row group.
      expect(groups).toHaveLength(GROUPS);
      for (const read of groups) {
        expect(read.offset).toBeGreaterThanOrEqual(4);
        expect(read.length).toBeLessThan(parquet.byteLength / 2);
        expect(read.offset + read.length).toBeLessThanOrEqual(parquet.byteLength);
      }
      expect(groups.map((r) => r.offset)).toEqual(
        groups.map((r) => r.offset).sort((a, b) => a - b),
      );
    } finally {
      data.dispose?.();
    }
  });

  it("matches the whole-buffer decode cell for cell", async () => {
    const ranged = await loadTableFile(recordingSource(parquet));
    const whole = await loadTableFile(parquet);
    try {
      expect(ranged.rowCount).toBe(whole.rowCount);
      for (const row of [0, 1, 5999, 6000, 6001, 12000, 17999]) {
        ranged.prefetchViewport?.([row]);
        whole.prefetchViewport?.([row]);
        expect(ranged.getCell(row, 1)).toBe(whole.getCell(row, 1));
        expect(ranged.getCellRaw(row, 0)).toBe(whole.getCellRaw(row, 0));
      }
      expect(Array.from(ranged.sortColumn!(0, false)).slice(0, 3)).toEqual([17999, 17998, 17997]);
      expect(
        Array.from(ranged.filterRows!([{ kind: "range", min: 6000, max: 6002 }, null])),
      ).toEqual([6000, 6001, 6002]);
    } finally {
      ranged.dispose?.();
      whole.dispose?.();
    }
  });

  it("rejects a bad footer magic after a single read", async () => {
    const notParquet = recordingSource(new TextEncoder().encode("hello, this is not parquet"));
    await expect(loadTableFile(notParquet)).rejects.toThrow("Not a Parquet file");
    expect(notParquet.reads).toHaveLength(1);

    const truncated = recordingSource(parquet.subarray(0, parquet.byteLength - 1));
    await expect(loadTableFile(truncated)).rejects.toThrow("Not a Parquet file");
    expect(truncated.reads).toHaveLength(1);

    const tiny = recordingSource(new Uint8Array([0x50, 0x41, 0x52, 0x31]));
    await expect(loadTableFile(tiny)).rejects.toThrow("too small");
    expect(tiny.reads).toHaveLength(0);
  });

  it("applies admission limits from the footer and across row groups", async () => {
    const rows = recordingSource(parquet);
    await expect(loadTableFile(rows, { maxRows: ROWS_PER_GROUP })).rejects.toThrow("row limit");
    expect(rows.reads).toHaveLength(1);

    const columns = recordingSource(parquet);
    await expect(loadTableFile(columns, { maxColumns: 1 })).rejects.toThrow("column limit");
    expect(columns.reads).toHaveLength(1);

    // The footer floor admits the file (the string column counts nothing), so
    // the cumulative check has to catch it on a later row group.
    const decoded = recordingSource(parquet);
    await expect(loadTableFile(decoded, { maxDecodedBytes: 150_000 })).rejects.toThrow(
      "decoded bytes limit",
    );
    expect(decoded.reads.length).toBeGreaterThan(1);
    expect(decoded.reads.length).toBeLessThan(1 + GROUPS);

    // A failed load leaves the module usable.
    const reopened = await loadTableFile(recordingSource(parquet));
    expect(reopened.rowCount).toBe(ROWS_PER_GROUP * GROUPS);
    reopened.dispose?.();
  });

  it("rejects a ByteSource that returns the wrong number of bytes", async () => {
    const short: ByteSource = {
      byteLength: parquet.byteLength,
      read: (offset, length) => Promise.resolve(parquet.subarray(offset, offset + length - 1)),
    };
    await expect(loadTableFile(short)).rejects.toThrow("returned");
  });

  it("exposes row groups one at a time through openParquetFile", async () => {
    const source = recordingSource(parquet);
    const file = await openParquetFile(source, {
      limits: { maxRows: 100_000, maxColumns: 256, maxDecodedBytes: 128 * 1024 * 1024 },
    });
    try {
      expect(file.rowCount).toBe(ROWS_PER_GROUP * GROUPS);
      expect(file.rowGroupCount).toBe(GROUPS);
      expect(file.rowGroupRows).toEqual([ROWS_PER_GROUP, ROWS_PER_GROUP, ROWS_PER_GROUP]);
      // Schema is known before any row group: the table can mount empty.
      expect(file.tableData.rowCount).toBe(0);
      expect(file.tableData.columns.map((c) => c.key)).toEqual(["id", "text"]);

      const first = await file.appendRowGroup(0);
      expect(first).toEqual({ rowsAppended: ROWS_PER_GROUP, replaced: null, exhausted: false });
      expect(file.loadedRows).toBe(ROWS_PER_GROUP);
      expect(file.tableData.rowCount).toBe(ROWS_PER_GROUP);
      expect(file.tableData.columnSummaries[0]).toMatchObject({ max: ROWS_PER_GROUP - 1 });

      await expect(file.appendRowGroup(0)).rejects.toThrow("already loaded");
      await file.appendRowGroup(1);
      await file.appendRowGroup(2);
      expect(file.finish()).toEqual({ rowsAppended: 0, replaced: null });
      expect(file.tableData.rowCount).toBe(ROWS_PER_GROUP * GROUPS);
      await expect(file.appendRowGroup(1)).rejects.toThrow("closed");
    } finally {
      file.dispose();
    }
  });

  it("tracks committed rows and bytes across appends, and pausing marks coverage", async () => {
    const file = await openParquetFile(recordingSource(parquet), { limits: DEFAULT_LIMITS });
    try {
      expect(file.usage).toEqual({ rows: 0, decodedBytes: 0 });
      await file.appendRowGroup(0);
      const first = file.usage;
      expect(first.rows).toBe(ROWS_PER_GROUP);
      expect(first.decodedBytes).toBeGreaterThan(0);

      file.setPaused(true);
      expect(file.tableData.coverage).toMatchObject({
        loadedRows: ROWS_PER_GROUP,
        truncated: true,
        resumable: true,
      });
      expect(file.truncated).toBe(false);
      file.setPaused(false);
      expect(file.tableData.coverage).toMatchObject({ truncated: false, resumable: false });

      await file.appendRowGroup(1);
      expect(file.usage.rows).toBe(2 * ROWS_PER_GROUP);
      expect(file.usage.decodedBytes).toBeGreaterThan(first.decodedBytes);
      await file.appendRowGroup(2);
      file.finish();
      expect(file.usage.rows).toBe(GROUPS * ROWS_PER_GROUP);
      expect(file.tableData.coverage).toMatchObject({ truncated: false, resumable: false });
    } finally {
      file.dispose();
    }
  });

  it("reads footer statistics at open and scopes summaries as row groups land", async () => {
    const totalRows = ROWS_PER_GROUP * GROUPS;
    // Mirrors the `i % 97 === 3` null pattern in the fixture.
    const nullsPerGroup = Array.from({ length: ROWS_PER_GROUP }, (_, i) => i).filter(
      (i) => i % 97 === 3,
    ).length;
    const textNulls = GROUPS * nullsPerGroup;
    const file = await openParquetFile(recordingSource(parquet), { limits: DEFAULT_LIMITS });
    try {
      // Footer stats are fixed at open, before any row group is resident.
      const stats = file.tableData.datasetStats;
      expect(stats).toHaveLength(2);
      expect(stats?.[0]).toEqual({
        nullCount: 0,
        min: 0,
        max: totalRows - 1,
        boundedRowGroups: GROUPS,
        boundsExact: true,
        hasInfinite: false,
      });
      expect(stats?.[1]).toMatchObject({ nullCount: textNulls, boundedRowGroups: GROUPS });
      expect(typeof stats?.[1]?.min).toBe("string");
      expect(file.tableData.coverage).toEqual({
        loadedRows: 0,
        totalRows: { value: totalRows, scope: "dataset", precision: "exact", source: "metadata" },
        rowGroups: GROUPS,
        truncated: false,
      });

      await file.appendRowGroup(0);
      const partial = file.tableData.columnSummaries[0];
      expect(partial?.kind).toBe("numeric");
      if (partial?.kind !== "numeric") throw new Error("expected numeric");
      // Histogram over loaded rows; range and nulls lifted to the whole file.
      expect(partial.max).toBe(ROWS_PER_GROUP - 1);
      expect(partial.scope).toMatchObject({
        rows: { loaded: ROWS_PER_GROUP, dataset: { value: totalRows } },
        distribution: { scope: "loaded", precision: "exact", source: "resident" },
        range: { value: { min: 0, max: totalRows - 1 }, scope: "dataset", source: "metadata" },
        nullCount: { value: 0, scope: "dataset", source: "metadata" },
      });
      const text = file.tableData.columnSummaries[1];
      if (text?.kind !== "categorical") throw new Error("expected categorical");
      expect(text.nullCount).toBe(nullsPerGroup);
      expect(text.scope?.nullCount).toMatchObject({ value: textNulls, scope: "dataset" });
      expect(text.scope?.range).toBeUndefined();

      await file.appendRowGroup(1);
      await file.appendRowGroup(2);
      file.finish();
      expect(file.tableData.coverage).toMatchObject({ loadedRows: totalRows, truncated: false });
      expect(file.tableData.columnSummaries[0]?.scope?.distribution.scope).toBe("dataset");
      expect(file.tableData.datasetStats).toBe(stats);
    } finally {
      file.dispose();
    }
  });

  it("streams a byte-source through SiftTable and reports milestones", async () => {
    const source = recordingSource(parquet);
    const milestones: SiftLoadMilestone[] = [];
    const onChange = vi.fn();
    const onLoadError = vi.fn();
    const siftSource: SiftSource = { kind: "byte-source", source };
    const view = render(
      createElement(
        StrictMode,
        null,
        createElement(SiftTable, {
          source: siftSource,
          onChange,
          onLoadError,
          onLoadMilestone: (m) => milestones.push(m),
        }),
      ),
    );
    try {
      await waitFor(() => {
        expect(view.container.querySelector(".sift-status-ready")).not.toBeNull();
      });
      const phases = milestones.map((m) => m.phase);
      expect(phases[0]).toBe("load-start");
      expect(phases).toContain("engine-mounted");
      expect(phases.filter((p) => p === "chunk-appended")).toHaveLength(GROUPS - 1);
      expect(phases[phases.length - 1]).toBe("streaming-complete");
      expect(milestones.at(-1)).toMatchObject({
        source: "byte-source",
        format: "parquet",
        rowCount: ROWS_PER_GROUP * GROUPS,
      });
      expect(view.container.querySelector(".sift-cell")?.textContent).toBe("0");
      expect(view.container.querySelector(".sift-status-indicator")?.getAttribute("title")).toBe(
        "All data loaded",
      );
      expect(onLoadError).not.toHaveBeenCalled();
      expect(view.container.textContent).not.toContain("Invalid handle");
    } finally {
      view.unmount();
    }
  });

  it("reports load errors to the host and renders the error state", async () => {
    const onLoadError = vi.fn();
    const siftSource: SiftSource = {
      kind: "byte-source",
      source: recordingSource(new TextEncoder().encode("not parquet at all")),
    };
    const view = render(createElement(SiftTable, { source: siftSource, onLoadError }));
    try {
      await waitFor(() => {
        expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
          "Not a Parquet file",
        );
      });
      expect(onLoadError).toHaveBeenCalledTimes(1);
      expect(onLoadError.mock.calls[0][0]).toBeInstanceOf(Error);
    } finally {
      view.unmount();
    }
  });

  it("frees the store once when image refinement replaces the lease before mount", async () => {
    // 32 leading data URIs flip the column to "image" on the first append.
    const uris = Array.from({ length: 200 }, (_, i) => `data:image/png;base64,QUJD${i}`);
    // Plain Utf8: apache-arrow would otherwise dictionary-encode the strings,
    // and the sniff only looks at string and list-of-string columns.
    const pic = vectorFromArray(uris, new Utf8());
    const file = writeParquet(tableToIPC(new Table({ pic }), "stream"), 100);
    const mod = getModuleSync();
    const free = vi.spyOn(mod, "free");
    try {
      const opened = await openParquetFile(recordingSource(file), { limits: DEFAULT_LIMITS });
      const before = opened.tableData;
      expect(before.columns[0].columnType).toBe("categorical");
      const first = await opened.appendRowGroup(0);
      expect(first.replaced).not.toBeNull();
      expect(first.replaced!.columns[0].columnType).toBe("image");
      expect(opened.tableData).toBe(first.replaced);
      // The superseded lease is already released, but the store lives on.
      expect(free).not.toHaveBeenCalled();
      await opened.appendRowGroup(1);
      opened.finish();
      opened.dispose();
      expect(free).toHaveBeenCalledTimes(1);
      // Releasing the old lease again is a no-op, not a double free.
      before.dispose?.();
      expect(free).toHaveBeenCalledTimes(1);

      free.mockClear();
      const whole = await loadTableFile(recordingSource(file));
      expect(whole.columns[0].columnType).toBe("image");
      whole.dispose?.();
      expect(free).toHaveBeenCalledTimes(1);
    } finally {
      free.mockRestore();
    }
  });

  it("keeps footer type hints through every append", async () => {
    // A HuggingFace ClassLabel is an integer column the footer says to show
    // as categorical. The writer here cannot emit that footer key, so the
    // hint export is stubbed to return what it would parse.
    const mod = getModuleSync();
    const hints = vi
      .spyOn(mod, "parquet_file_column_hints")
      .mockReturnValue([
        { name: "id", columnType: "categorical", numeric: false, pandasIndex: false },
      ]);
    try {
      const opened = await openParquetFile(recordingSource(parquet), { limits: DEFAULT_LIMITS });
      expect(opened.columns[0].columnType).toBe("categorical");
      for (let group = 0; group < GROUPS; group++) {
        const { replaced } = await opened.appendRowGroup(group);
        expect(replaced).toBeNull();
        expect(opened.columns[0].columnType).toBe("categorical");
        expect(opened.columns[0].numeric).toBe(false);
      }
      expect(opened.finish().replaced).toBeNull();
      expect(opened.tableData.columnSummaries[0]).toMatchObject({ kind: "categorical" });
      opened.dispose();
    } finally {
      hints.mockRestore();
    }
  });

  it("opens a schema-only file as an empty table", async () => {
    const empty = writeParquet(
      tableToIPC(tableFromArrays({ a: new Int32Array(0), b: new Float64Array(0) }), "stream"),
    );
    const source = recordingSource(empty);
    const data = await loadTableFile(source);
    try {
      expect(data.rowCount).toBe(0);
      expect(data.columns.map((c) => c.key)).toEqual(["a", "b"]);
      expect(source.reads).toHaveLength(1);
    } finally {
      data.dispose?.();
    }

    const view = render(
      createElement(SiftTable, { source: { kind: "byte-source", source: recordingSource(empty) } }),
    );
    try {
      await waitFor(() => {
        expect(view.container.querySelector(".sift-status-ready")).not.toBeNull();
      });
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("rejects a row group the decoded budget cannot hold before fetching it", async () => {
    const source = recordingSource(parquet);
    // One 6k-row group retains roughly 150 KB; the cap admits one, not two.
    const opened = await openParquetFile(source, {
      limits: { ...DEFAULT_LIMITS, maxDecodedBytes: 250_000 },
    });
    try {
      await opened.appendRowGroup(0);
      const readsAfterFirst = source.reads.length;
      await expect(opened.appendRowGroup(1)).rejects.toThrow("decoded bytes limit");
      expect(source.reads).toHaveLength(readsAfterFirst);
      expect(opened.loadedRows).toBe(ROWS_PER_GROUP);
    } finally {
      opened.dispose();
    }
  });

  it("rejects a footer longer than the decoded budget before reading it", async () => {
    const source = recordingSource(parquet);
    await expect(loadTableFile(source, { maxDecodedBytes: 16 })).rejects.toThrow(
      "footer exceeds decoded bytes limit",
    );
    expect(source.reads).toHaveLength(1);
  });

  /** A ByteSource that serves the tail and row group 0, then fails. */
  function failingAfterFirstGroup(): ByteSource {
    let reads = 0;
    return {
      byteLength: parquet.byteLength,
      async read(offset, length) {
        reads += 1;
        if (reads > 2) throw new Error("disk went away");
        return parquet.subarray(offset, offset + length);
      },
    };
  }

  it("keeps mounted rows and notes a later row group failure in the footer", async () => {
    const onLoadError = vi.fn();
    const onChange = vi.fn();
    const view = render(
      createElement(SiftTable, {
        source: { kind: "byte-source", source: failingAfterFirstGroup() },
        onLoadError,
        onChange,
      }),
    );
    try {
      await waitFor(() => expect(onLoadError).toHaveBeenCalledTimes(1));
      expect(onLoadError.mock.calls[0][0].message).toContain("disk went away");
      await waitFor(() => {
        // The first row group stays on screen, with the failure in the footer.
        expect(view.container.querySelector(".sift-cell")?.textContent).toBe("0");
        expect(view.container.querySelector(".sift-load-failure")?.textContent).toBe(
          "Stopped loading: disk went away · Showing loaded rows",
        );
      });
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      expect(view.container.querySelector(".sift-status-streaming")).toBeNull();
      const indicator = view.container.querySelector(".sift-status-indicator");
      expect(indicator?.classList.contains("sift-status-stopped")).toBe(true);
      expect(indicator?.getAttribute("title")).toBe("Stopped loading: disk went away");
      expect(onLoadError).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });

  it("clears a mid-stream failure notice when a later source loads", async () => {
    const onLoadError = vi.fn();
    const view = render(
      createElement(SiftTable, {
        source: { kind: "byte-source", source: failingAfterFirstGroup() },
        onLoadError,
      }),
    );
    try {
      await waitFor(() => {
        expect(view.container.querySelector(".sift-load-failure")).not.toBeNull();
      });
      view.rerender(
        createElement(SiftTable, {
          source: { kind: "byte-source", source: recordingSource(parquet) },
          onLoadError,
        }),
      );
      await waitFor(() => {
        expect(view.container.querySelector(".sift-load-failure")).toBeNull();
        expect(view.container.querySelector(".sift-status-indicator")?.getAttribute("title")).toBe(
          "All data loaded",
        );
      });
      expect(view.container.querySelector(".sift-status-stopped")).toBeNull();
      expect(view.container.querySelector(".sift-footer-slot")).toBeNull();
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      expect(onLoadError).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });

  it("loads hosted Parquet URLs above the loadTableFile defaults", async () => {
    // The notebook renderer sends Parquet outputs through `url` with no way
    // to raise limits, so that path must not inherit the 100k-row default.
    const rows = 100_001;
    const big = writeParquet(
      tableToIPC(tableFromArrays({ n: Int32Array.from({ length: rows }, (_, i) => i) }), "stream"),
      50_000,
    );
    const url = `data:application/vnd.apache.parquet;base64,${Buffer.from(big).toString("base64")}`;
    const onChange = vi.fn();
    const onLoadError = vi.fn();
    const view = render(
      createElement(SiftTable, { source: { kind: "url", url }, onLoadError, onChange }),
    );
    try {
      await waitFor(() => {
        expect(view.container.querySelector(".sift-status-ready")).not.toBeNull();
        expect(view.container.querySelector(".sift-cell")?.textContent).toBe("0");
      });
      expect(onLoadError).not.toHaveBeenCalled();
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  describe('overflow: "truncate"', () => {
    it("loads a bounded prefix and stops reading once the row budget is spent", async () => {
      const source = recordingSource(parquet);
      const maxRows = ROWS_PER_GROUP + 100;
      await expect(
        openParquetFile(source, { limits: { ...DEFAULT_LIMITS, maxRows } }),
      ).rejects.toThrow("row limit");

      const counted = recordingSource(parquet);
      const file = await openParquetFile(counted, {
        limits: { ...DEFAULT_LIMITS, maxRows },
        overflow: "truncate",
      });
      try {
        expect(file.rowCount).toBe(ROWS_PER_GROUP * GROUPS);
        expect(file.truncated).toBe(false);
        const first = await file.appendRowGroup(0);
        expect(first).toMatchObject({ rowsAppended: ROWS_PER_GROUP, exhausted: false });
        const second = await file.appendRowGroup(1);
        expect(second).toMatchObject({ rowsAppended: 100, exhausted: true });
        expect(file.loadedRows).toBe(maxRows);
        expect(file.truncated).toBe(true);
        const reads = counted.reads.length;
        await expect(file.appendRowGroup(2)).rejects.toThrow("budget is exhausted");
        expect(counted.reads).toHaveLength(reads);
        file.finish();
        expect(file.truncated).toBe(true);
        expect(file.tableData.rowCount).toBe(maxRows);
        expect(file.tableData.getCellRaw(maxRows - 1, 0)).toBe(maxRows - 1);
      } finally {
        file.dispose();
      }
    });

    it("stops loadTableFile at the budget instead of failing", async () => {
      const source = recordingSource(parquet);
      const data = await loadTableFile(source, { maxRows: 100, overflow: "truncate" });
      try {
        expect(data.rowCount).toBe(100);
        // Tail plus row group 0 only.
        expect(source.reads).toHaveLength(2);
        // The result says it was cut and how big the file is.
        expect(data.coverage).toEqual({
          loadedRows: 100,
          totalRows: {
            value: ROWS_PER_GROUP * GROUPS,
            scope: "dataset",
            precision: "exact",
            source: "metadata",
          },
          rowGroups: GROUPS,
          truncated: true,
        });
        expect(data.columnSummaries[0]?.scope).toMatchObject({
          rows: { loaded: 100, dataset: { value: ROWS_PER_GROUP * GROUPS } },
          distribution: { scope: "loaded" },
          range: { value: { min: 0, max: ROWS_PER_GROUP * GROUPS - 1 }, scope: "dataset" },
        });
      } finally {
        data.dispose?.();
      }
      await expect(loadTableFile(parquet, { maxRows: 100, overflow: "truncate" })).rejects.toThrow(
        "row limit",
      );
    });

    it("finishes a file that fits with truncated false", async () => {
      const file = await openParquetFile(recordingSource(parquet), {
        limits: DEFAULT_LIMITS,
        overflow: "truncate",
      });
      try {
        for (let group = 0; group < GROUPS; group++) {
          expect((await file.appendRowGroup(group)).exhausted).toBe(false);
        }
        file.finish();
        expect(file.truncated).toBe(false);
        expect(file.loadedRows).toBe(ROWS_PER_GROUP * GROUPS);
      } finally {
        file.dispose();
      }
    });

    it("rejects an unknown overflow policy", async () => {
      await expect(
        openParquetFile(recordingSource(parquet), {
          limits: DEFAULT_LIMITS,
          overflow: "sample" as never,
        }),
      ).rejects.toThrow("overflow");
    });

    it("mounts a preview through SiftTable without reporting an error", async () => {
      const source = recordingSource(parquet);
      const milestones: SiftLoadMilestone[] = [];
      const onLoadError = vi.fn();
      const onChange = vi.fn();
      const maxRows = ROWS_PER_GROUP + 100;
      const siftSource: SiftSource = {
        kind: "byte-source",
        source,
        limits: { maxRows },
        overflow: "truncate",
      };
      const view = render(
        createElement(SiftTable, {
          source: siftSource,
          onLoadError,
          onChange,
          onLoadMilestone: (m) => milestones.push(m),
        }),
      );
      try {
        await waitFor(() => {
          expect(milestones.at(-1)?.phase).toBe("streaming-complete");
        });
        expect(milestones.at(-1)).toMatchObject({
          source: "byte-source",
          rowCount: maxRows,
          totalRowCount: ROWS_PER_GROUP * GROUPS,
          truncated: true,
        });
        // Tail, row group 0, row group 1. Row group 2 is never read.
        expect(source.reads).toHaveLength(3);
        expect(onLoadError).not.toHaveBeenCalled();
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
        await waitFor(() => {
          expect(view.container.querySelector(".sift-status-ready")).not.toBeNull();
          expect(view.container.querySelector(".sift-cell")?.textContent).toBe("0");
          expect(view.container.querySelector(".sift-preview-hint")?.textContent).toContain(
            `Showing first ${maxRows.toLocaleString()} of ${(ROWS_PER_GROUP * GROUPS).toLocaleString()} rows`,
          );
          expect(
            view.container.querySelector(".sift-status-indicator")?.getAttribute("title"),
          ).toBe("Preview loaded");
        });
      } finally {
        view.unmount();
      }
    });

    it("finishes without streaming when the first row group spends the budget", async () => {
      const source = recordingSource(parquet);
      const milestones: SiftLoadMilestone[] = [];
      const onLoadError = vi.fn();
      const view = render(
        createElement(SiftTable, {
          source: { kind: "byte-source", source, limits: { maxRows: 10 }, overflow: "truncate" },
          onLoadError,
          onLoadMilestone: (m) => milestones.push(m),
        }),
      );
      try {
        await waitFor(() => {
          expect(milestones.at(-1)?.phase).toBe("streaming-complete");
        });
        expect(milestones.map((m) => m.phase)).not.toContain("chunk-appended");
        expect(milestones.at(-1)).toMatchObject({ rowCount: 10, truncated: true });
        expect(source.reads).toHaveLength(2);
        expect(view.container.querySelector(".sift-status-streaming")).toBeNull();
        expect(onLoadError).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    });

    it("adds the preview footer to a table that mounted without one", async () => {
      const onLoadError = vi.fn();
      const view = render(
        createElement(SiftTable, {
          source: { kind: "byte-source", source: recordingSource(parquet) },
          onLoadError,
        }),
      );
      try {
        await waitFor(() => {
          expect(view.container.querySelector(".sift-status-ready")).not.toBeNull();
          expect(view.container.querySelector(".sift-cell")?.textContent).toBe("0");
        });
        expect(view.container.querySelector(".sift-footer-slot")).toBeNull();
        view.rerender(
          createElement(SiftTable, {
            source: {
              kind: "byte-source",
              source: recordingSource(parquet),
              limits: { maxRows: 100 },
              overflow: "truncate",
            },
            onLoadError,
          }),
        );
        await waitFor(() => {
          expect(view.container.querySelector(".sift-preview-hint")?.textContent).toContain(
            `Showing first 100 of ${(ROWS_PER_GROUP * GROUPS).toLocaleString()} rows`,
          );
        });
        expect(view.container.querySelectorAll(".sift-footer-slot")).toHaveLength(1);
        expect(onLoadError).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    });

    it("drops the footer slot when a source without one replaces a preview", async () => {
      const view = render(
        createElement(SiftTable, {
          source: {
            kind: "byte-source",
            source: recordingSource(parquet),
            limits: { maxRows: 100 },
            overflow: "truncate",
          },
        }),
      );
      try {
        await waitFor(() => {
          expect(view.container.querySelector(".sift-preview-hint")).not.toBeNull();
        });
        view.rerender(
          createElement(SiftTable, {
            source: { kind: "byte-source", source: recordingSource(parquet) },
          }),
        );
        await waitFor(() => {
          expect(view.container.querySelector(".sift-footer-slot")).toBeNull();
          expect(
            view.container.querySelector(".sift-status-indicator")?.getAttribute("title"),
          ).toBe("All data loaded");
        });
      } finally {
        view.unmount();
      }
    });

    it("reloads when only the overflow policy changes", async () => {
      const source = recordingSource(parquet);
      const onLoadError = vi.fn();
      const milestones: SiftLoadMilestone[] = [];
      const props = (overflow: "error" | "truncate") => ({
        source: { kind: "byte-source" as const, source, limits: { maxRows: 10 }, overflow },
        onLoadError,
        onLoadMilestone: (m: SiftLoadMilestone) => milestones.push(m),
      });
      const view = render(createElement(SiftTable, props("error")));
      try {
        await waitFor(() => expect(onLoadError).toHaveBeenCalledTimes(1));
        expect(onLoadError.mock.calls[0][0].message).toContain("row limit");
        view.rerender(createElement(SiftTable, props("truncate")));
        await waitFor(() => {
          expect(milestones.at(-1)).toMatchObject({ phase: "streaming-complete", truncated: true });
        });
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
      } finally {
        view.unmount();
      }
    });
  });

  it("aborts in-flight reads on unmount without reporting an error", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signals: (AbortSignal | undefined)[] = [];
    const source: ByteSource = {
      byteLength: parquet.byteLength,
      async read(offset, length, signal) {
        signals.push(signal);
        // Hold the first row group read until the host unmounts.
        if (signals.length === 2) await gate;
        return parquet.subarray(offset, offset + length);
      },
    };
    const onLoadError = vi.fn();
    const siftSource: SiftSource = { kind: "byte-source", source };
    const view = render(createElement(SiftTable, { source: siftSource, onLoadError }));
    await waitFor(() => expect(signals.length).toBe(2));
    view.unmount();
    expect(signals[1]?.aborted).toBe(true);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onLoadError).not.toHaveBeenCalled();
  });
});
