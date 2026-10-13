import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { createElement, StrictMode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { loadTableFile } from "./file-data";
import { _resetPredicateModuleForTests, _setWasmModuleLoaderForTests } from "./predicate";
import { SiftTable, type SiftSource } from "./react";

const wasmPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../crates/sift-wasm/pkg/sift_wasm_bg.wasm",
);

// The workspace's normal WASM build supplies these artifacts. Unit tests still
// work in a source-only checkout; run `cargo xtask wasm sift` to enable this suite.
describe.skipIf(!existsSync(wasmPath))("loadTableFile with real WASM", () => {
  let writeParquet: (bytes: Uint8Array) => Uint8Array;
  let ipc: Uint8Array;
  let parquet: Uint8Array;

  beforeAll(async () => {
    const wasm = await import("sift-wasm/sift_wasm.js");
    const binary = readFileSync(wasmPath);
    await wasm.default({ module_or_path: binary });
    _resetPredicateModuleForTests();
    _setWasmModuleLoaderForTests(async () => ({ ...wasm, default: async () => undefined }));
    writeParquet = (
      wasm as unknown as {
        write_parquet_ipc: (bytes: Uint8Array) => Uint8Array;
      }
    ).write_parquet_ipc;
    ipc = tableToIPC(
      tableFromArrays({
        number: [3, null, 1],
        text: ["東京", "", null],
        enabled: [true, null, false],
        nested: [{ tag: "x" }, { tag: null }, { tag: "z" }],
      }),
      "stream",
    );
    parquet = writeParquet(ipc);
  });

  afterAll(() => {
    _setWasmModuleLoaderForTests(null);
    _resetPredicateModuleForTests();
  });

  it.each(["parquet", "arrow-ipc"] as const)(
    "loads complete %s data with schema, nulls, summaries, sorting, and filters",
    async (format) => {
      const data = await loadTableFile(format === "parquet" ? parquet : ipc);
      try {
        expect(data.rowCount).toBe(3);
        expect(data.columns.map((column) => column.key)).toEqual([
          "number",
          "text",
          "enabled",
          "nested",
        ]);
        expect(data.getCell(0, 1)).toBe("東京");
        expect(data.getCellRaw(1, 0)).toBeNull();
        expect(data.getCellRaw(1, 1)).toBe("");
        expect(data.getCell(2, 3)).toContain("z");
        expect(data.columnSummaries[2]).toMatchObject({
          kind: "boolean",
          trueCount: 1,
          falseCount: 1,
          nullCount: 1,
          total: 3,
        });
        expect(Array.from(data.sortColumn!(0, true))).toEqual([2, 0, 1]);
        expect(Array.from(data.filterRows!([{ kind: "range", min: 0, max: 2 }]))).toEqual([2]);
      } finally {
        data.dispose?.();
      }
    },
  );

  it.each(["parquet", "arrow-ipc"] as const)(
    "rejects %s limits without truncating",
    async (format) => {
      const bytes = format === "parquet" ? parquet : ipc;
      await expect(loadTableFile(bytes, { maxRows: 2 })).rejects.toThrow("row limit");
      await expect(loadTableFile(bytes, { maxColumns: 2 })).rejects.toThrow("column limit");
      await expect(loadTableFile(bytes, { maxDecodedBytes: 1 })).rejects.toThrow(
        "decoded bytes limit",
      );
      // A failed load must not poison the module or prevent reopening the file.
      const reopened = await loadTableFile(bytes);
      expect(reopened.rowCount).toBe(3);
      reopened.dispose?.();
    },
  );

  it("rejects malformed files and IPC file format with clear errors", async () => {
    await expect(loadTableFile(new Uint8Array([80, 65, 82, 49]))).rejects.toBeInstanceOf(Error);
    await expect(loadTableFile(ipc.slice(0, ipc.length - 20))).rejects.toBeInstanceOf(Error);
    const file = tableToIPC(tableFromArrays({ value: [1] }), "file");
    await expect(loadTableFile(file)).rejects.toThrow("use an Arrow IPC stream");
  });

  it("loads a wide IPC table without counting its shared message body per column", async () => {
    const values = Array.from({ length: 25_000 }, (_, row) => (row % 2 === 0 ? row : null));
    const columns = Object.fromEntries(
      Array.from({ length: 20 }, (_, col) => [`column_${col}`, values]),
    );
    const bytes = tableToIPC(tableFromArrays(columns), "stream");
    expect(bytes.byteLength).toBeLessThan(5 * 1024 * 1024);
    const data = await loadTableFile(bytes, { maxDecodedBytes: 6 * 1024 * 1024 });
    try {
      expect(data.rowCount).toBe(25_000);
      expect(data.columns).toHaveLength(20);
      expect(data.getCellRaw(24_998, 19)).toBe(24_998);
      expect(data.getCellRaw(24_999, 19)).toBeNull();
    } finally {
      data.dispose?.();
    }
  });

  it("loads a compact wide boolean Parquet table within the default limits", async () => {
    const flags = Array.from({ length: 100_000 }, (_, row) => row % 3 === 0);
    const columns = Object.fromEntries(
      Array.from({ length: 90 }, (_, col) => [`flag_${col}`, flags]),
    );
    const data = await loadTableFile(writeParquet(tableToIPC(tableFromArrays(columns), "stream")));
    try {
      expect(data.rowCount).toBe(100_000);
      expect(data.columns).toHaveLength(90);
      expect(data.getCellRaw(99_999, 89)).toBe(true);
      expect(data.getCellRaw(99_998, 89)).toBe(false);
    } finally {
      data.dispose?.();
    }
  });

  it.each(["parquet", "arrow-ipc"] as const)(
    "keeps Float32 and UInt32 raw values, summaries, and filters consistent in %s",
    async (format) => {
      const typedIpc = tableToIPC(
        tableFromArrays({
          float32: new Float32Array([3.25, 1.5, 2.75]),
          uint32: new Uint32Array([3, 1, 2]),
        }),
        "stream",
      );
      const data = await loadTableFile(format === "parquet" ? writeParquet(typedIpc) : typedIpc);
      try {
        expect(data.getCellRaw(0, 0)).toBe(3.25);
        expect(data.getCellRaw(0, 1)).toBe(3);
        data.prefetchViewport?.([1]);
        expect(data.getCellRaw(1, 0)).toBe(1.5);
        expect(data.getCellRaw(1, 1)).toBe(1);
        expect(data.columnSummaries[0]).toMatchObject({ kind: "numeric", min: 1.5, max: 3.25 });
        expect(data.columnSummaries[1]).toMatchObject({ kind: "numeric", min: 1, max: 3 });
        expect(Array.from(data.filterRows!([{ kind: "range", min: 1, max: 3 }, null]))).toEqual([
          1, 2,
        ]);
        expect(Array.from(data.filterRows!([null, { kind: "range", min: 2, max: 3 }]))).toEqual([
          0, 2,
        ]);
        data.recomputeFilteredSummaries?.(new Uint8Array([0, 1, 1]), 2);
        expect(data.columnSummaries[0]).toMatchObject({ kind: "numeric", min: 1.5, max: 2.75 });
        expect(data.columnSummaries[1]).toMatchObject({ kind: "numeric", min: 1, max: 2 });
      } finally {
        data.dispose?.();
      }
    },
  );

  it("loads fresh WASM stores through React StrictMode, sorts, filters, and reopens", async () => {
    const disposers: ReturnType<typeof vi.fn>[] = [];
    const load = vi.fn(async () => {
      const data = await loadTableFile(parquet);
      const dispose = vi.fn(data.dispose!);
      data.dispose = dispose;
      disposers.push(dispose);
      return data;
    });
    // Keep the source stable, as a host would with useMemo.
    const source: SiftSource = { kind: "loader", load };
    const onChange = vi.fn();
    const mount = () =>
      render(
        createElement(
          StrictMode,
          null,
          createElement(SiftTable, {
            source,
            onChange,
          }),
        ),
      );
    const first = mount();
    try {
      await waitFor(() => {
        expect(first.container.querySelector(".sift-status-ready")).not.toBeNull();
        expect(first.container.querySelector(".sift-cell")?.textContent).toBe("3");
      });
      expect(load).toHaveBeenCalledTimes(1);
      expect(disposers[0]).not.toHaveBeenCalled();

      fireEvent.keyDown(first.container.querySelector('.sift-th[data-col="0"]')!, {
        key: "Enter",
      });
      await waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith(
          expect.objectContaining({
            sort: { column: "number", direction: "asc" },
          }),
        );
        expect(first.container.querySelector(".sift-cell")?.textContent).toBe("1");
      });
      fireEvent.click(first.container.querySelector(".sift-bool-true")!);
      await waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith(
          expect.objectContaining({
            filteredCount: 1,
            totalCount: 3,
          }),
        );
        expect(first.container.querySelector(".sift-cell")?.textContent).toBe("3");
      });
    } finally {
      first.unmount();
    }
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);

    const reopened = mount();
    try {
      await waitFor(() => {
        expect(reopened.container.querySelector(".sift-status-ready")).not.toBeNull();
        expect(reopened.container.querySelector(".sift-cell")?.textContent).toBe("3");
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(reopened.container.textContent).not.toContain("Invalid handle");
    } finally {
      reopened.unmount();
    }
    expect(disposers).toHaveLength(2);
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});
