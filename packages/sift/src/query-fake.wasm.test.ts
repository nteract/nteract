import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, waitFor } from "@testing-library/react";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { loadTableFile } from "./file-data";
import { _resetPredicateModuleForTests, _setWasmModuleLoaderForTests } from "./predicate";
import type { RequestContext } from "./query";
import { type ArrowIpcSession, createArrowIpcSession } from "./query-fake";
import { SiftTable } from "./react";

const wasmPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../crates/sift-wasm/pkg/sift_wasm_bg.wasm",
);

const ctx = (): RequestContext => ({
  requestId: "test",
  signal: new AbortController().signal,
  budget: { maxIpcBytes: 1 << 20, maxDecodedBytes: 1 << 24 },
});

describe.skipIf(!existsSync(wasmPath))("createArrowIpcSession with real WASM", () => {
  let ipc: Uint8Array;
  let session: ArrowIpcSession;

  beforeAll(async () => {
    const wasm = await import("sift-wasm/sift_wasm.js");
    await wasm.default({ module_or_path: readFileSync(wasmPath) });
    _resetPredicateModuleForTests();
    _setWasmModuleLoaderForTests(async () => ({ ...wasm, default: async () => undefined }));
    ipc = tableToIPC(
      tableFromArrays({
        score: [5, 15, 25, null, 45, 55],
        status: ["a", "b", "a", null, "c", "a"],
        active: [true, false, true, null, false, true],
      }),
      "stream",
    );
    session = await createArrowIpcSession(ipc);
  });

  afterAll(async () => {
    await session.close();
    _setWasmModuleLoaderForTests(null);
    _resetPredicateModuleForTests();
  });

  it("declares exactly the WASM filter ABI per column type", () => {
    expect(session.rowCount).toBe(6);
    expect(session.capabilities).toEqual({
      filters: { score: ["between"], status: ["in", "not_in", "is_null"], active: ["eq"] },
      sort: [],
      casts: [],
      counts: ["exact"],
      compound: ["or"],
    });
  });

  it("answers a head window over the matches with an exact count", async () => {
    const page = await session.query(
      {
        casts: [],
        filters: [
          { column: "score", op: "between", value: [10, 60] },
          { column: "active", op: "eq", value: true },
        ],
        sort: [],
        window: { mode: "head", limit: 1 },
      },
      ctx(),
    );
    expect(page.returnedRows).toBe(1);
    expect(page.matchedCount).toEqual({ kind: "exact", value: 2 });
    expect(page.continuation).toEqual({ kind: "more" });
    const data = await loadTableFile(page.ipc, { format: "arrow-ipc" });
    try {
      expect(data.rowCount).toBe(1);
      expect(data.columns.map((c) => c.key)).toEqual(["score", "status", "active"]);
      expect(data.getCellRaw(0, 0)).toBe(25);
    } finally {
      data.dispose?.();
    }
  });

  it("returns a loadable schema-only stream for no matches", async () => {
    const page = await session.query(
      {
        casts: [],
        filters: [{ column: "score", op: "between", value: [100, 200] }],
        sort: [],
        window: { mode: "head", limit: 10 },
      },
      ctx(),
    );
    expect(page.returnedRows).toBe(0);
    expect(page.continuation).toEqual({ kind: "end" });
    const data = await loadTableFile(page.ipc, { format: "arrow-ipc" });
    try {
      expect(data.rowCount).toBe(0);
      expect(data.columns).toHaveLength(3);
    } finally {
      data.dispose?.();
    }
  });

  it("maps Sift's category exclusion to the WASM not-in filter and counts without a window", async () => {
    const q = {
      casts: [],
      filters: [
        {
          op: "or" as const,
          args: [
            { column: "status", op: "is_null" as const },
            { column: "status", op: "not_in" as const, value: ["a"] },
          ],
        },
      ],
      sort: [],
    };
    expect(await session.count(q, "exact", ctx())).toEqual({ kind: "exact", value: 3 });
    const page = await session.query({ ...q, window: { mode: "head", limit: 10 } }, ctx());
    expect(page.returnedRows).toBe(3);
  });

  it("refuses what it did not declare instead of narrowing it", async () => {
    const base = { casts: [], filters: [], sort: [], window: { mode: "head" as const, limit: 1 } };
    await expect(
      session.query({ ...base, sort: [{ column: "score", direction: "asc" }] }, ctx()),
    ).rejects.toThrow("Sorting by score is not supported");
    await expect(
      session.query({ ...base, filters: [{ column: "score", op: "gt", value: 1 }] }, ctx()),
    ).rejects.toThrow('Filter "gt" on score is not supported');
    const aborted = new AbortController();
    aborted.abort();
    await expect(session.query(base, { ...ctx(), signal: aborted.signal })).rejects.toBeInstanceOf(
      Error,
    );
  });

  it("drives SiftTable: head, local brush, apply, committed pill, clear", async () => {
    const own = await createArrowIpcSession(ipc);
    const { container, unmount } = render(
      createElement(SiftTable, { source: { kind: "query-session", session: own, headRows: 4 } }),
    );
    const footer = () => container.querySelector<HTMLElement>(".sift-stat-rows")?.dataset.value;
    try {
      await waitFor(() => {
        expect(footer()).toBe("6 rows in whole dataset · 4 rows shown");
      });
      expect(own.queries).toHaveLength(1);

      // A local brush narrows the shown rows and offers Apply.
      const boolTrue = await waitFor(() => {
        const el = container.querySelector<HTMLElement>(".sift-bool-true");
        expect(el).not.toBeNull();
        return el!;
      });
      boolTrue.click();
      const button = await waitFor(() => {
        const el = container.querySelector<HTMLButtonElement>(".sift-apply-query");
        expect(el?.disabled).toBe(false);
        return el!;
      });
      expect(container.querySelector<HTMLElement>(".sift-stat-local")?.textContent).toBe(
        "2 of 4 shown rows · Filters use shown rows",
      );

      button.click();
      await waitFor(() => {
        expect(footer()).toBe("3 whole-dataset matches · 3 rows shown");
        expect(container.querySelector(".sift-apply-query")).toBeNull();
      });
      expect(own.queries.at(-1)?.filters).toEqual([{ column: "active", op: "eq", value: true }]);
      const pill = container.querySelector<HTMLElement>(".sift-filter-pill--committed");
      expect(pill?.textContent).toContain("active is true");
      expect(container.querySelectorAll(".sift-filter-pill")).toHaveLength(1);

      pill!.querySelector<HTMLButtonElement>(".sift-filter-pill-x")!.click();
      await waitFor(() => {
        expect(footer()).toBe("6 rows in whole dataset · 4 rows shown");
      });
      expect(container.querySelector(".sift-filter-pill")).toBeNull();
    } finally {
      unmount();
    }
    await waitFor(() => expect(own.queries).toHaveLength(3));
    // Closed on unmount: a further query is refused.
    await waitFor(async () => {
      await expect(
        own.query({ casts: [], filters: [], sort: [], window: { mode: "head", limit: 1 } }, ctx()),
      ).rejects.toThrow("closed");
    });
  });
});
