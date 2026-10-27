/**
 * The engine over a `WindowedTableData`. Every response goes through a gate the
 * test opens by hand, so placeholders, pending state, and stale-generation
 * rejection are observable.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createTable, type Column, type TableData, type TableEngine } from "./table";
import { makeColumns, makeRows, makeTableData, makeTableDataWithColumns } from "./table.fixtures";
import type { WindowedTableData } from "./windowed";
import { createResidentWindowedData, type ResidentWindowedData } from "./windowed-resident";

type Kind = "query" | "window" | "image" | "cast";

/** Wrap an adapter so its promises settle only when the test releases them. */
function delayed(inner: ResidentWindowedData, autoRelease = false) {
  const queue: { kind: Kind; run: () => void }[] = [];
  function gate<T>(kind: Kind, promise: Promise<T>): Promise<T> {
    if (autoRelease) return promise;
    return new Promise<T>((resolve, reject) => {
      queue.push({ kind, run: () => promise.then(resolve, reject) });
    });
  }
  const data: WindowedTableData = {
    kind: "windowed",
    get columns() {
      return inner.columns;
    },
    get rowCount() {
      return inner.rowCount;
    },
    get head() {
      return inner.head;
    },
    requestWindow: (s, e, g) => gate("window", inner.requestWindow(s, e, g)),
    setQuery: (q, g) => gate("query", inner.setQuery(q, g)),
    requestImage: (r, c) => gate("image", inner.requestImage(r, c)),
    castColumn: inner.castColumn
      ? (c, to, g) => gate("cast", inner.castColumn!(c, to, g))
      : undefined,
    undoCastColumn: inner.undoCastColumn
      ? (c, g) => gate("cast", inner.undoCastColumn!(c, g))
      : undefined,
    isColumnCast: inner.isColumnCast,
    subscribe: (l) => inner.subscribe(l),
    dispose: () => inner.dispose(),
  };
  return {
    data,
    inner,
    pending: () => queue.map((q) => q.kind),
    /** Release the oldest pending response of `kind` (or any), then settle microtasks. */
    async release(kind?: Kind) {
      const index = kind ? queue.findIndex((q) => q.kind === kind) : 0;
      if (index < 0) throw new Error(`no pending ${kind}; have ${queue.map((q) => q.kind)}`);
      const [entry] = queue.splice(index, 1);
      entry.run();
      await vi.advanceTimersByTimeAsync(0);
    },
    async releaseAll() {
      while (queue.length > 0) await this.release();
    },
  };
}

const frame = () => vi.advanceTimersByTimeAsync(20);

function cellText(container: HTMLElement, viewRow: number, col: number): string | undefined {
  const row = container.querySelector(`[aria-rowindex="${viewRow + 2}"]`);
  return row?.querySelectorAll(".sift-cell")[col]?.textContent ?? undefined;
}

function skeletons(container: HTMLElement): number {
  return container.querySelectorAll(".sift-cell-skeleton").length;
}

function footer(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLElement>(".sift-stat-rows")?.dataset.value;
}

describe("createTable over WindowedTableData", () => {
  let container: HTMLDivElement;
  let rows: unknown[][];
  let source: TableData;
  let harness: ReturnType<typeof delayed>;
  let engine: TableEngine;

  function mount(data: WindowedTableData, options?: Parameters<typeof createTable>[2]) {
    engine = createTable(container, data, options);
    const viewport = container.querySelector<HTMLElement>(".sift-viewport")!;
    Object.defineProperty(viewport, "clientHeight", { value: 400, configurable: true });
    viewport.dispatchEvent(new Event("scroll"));
    return engine;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    rows = makeRows(50);
    source = makeTableData(rows);
    source.dispose = vi.fn();
    harness = delayed(createResidentWindowedData(source, { headRows: 10 }));
  });

  afterEach(() => {
    engine?.destroy();
    container.remove();
    vi.useRealTimers();
  });

  it("shows placeholders until the query and window resolve, then renders cells", async () => {
    mount(harness.data);
    expect(engine.getState().pending).toBe(true);
    expect(harness.pending()).toEqual(["query"]);
    await frame();
    // Nothing is resolved before the first query answers.
    expect(skeletons(container)).toBeGreaterThan(0);
    expect(container.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".sift-row-placeholder").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Person 0");

    await harness.release("query");
    expect(engine.getState()).toMatchObject({ pending: false, filteredCount: 50, totalCount: 50 });
    await frame();
    // The head resolves rows 0–9 at once; the rest ask the data side.
    expect(cellText(container, 0, 1)).toBe("Person 0");
    expect(cellText(container, 9, 1)).toBe("Person 9");
    expect(
      container.querySelector('[aria-rowindex="12"]')?.querySelector(".sift-cell-skeleton"),
    ).not.toBeNull();
    expect(harness.pending()).toEqual(["window"]);

    await harness.release("window");
    await frame();
    expect(skeletons(container)).toBe(0);
    expect(container.getAttribute("aria-busy")).toBe("false");
    expect(cellText(container, 10, 1)).toBe("Person 10");
    expect(cellText(container, 10, 3)).toBe("Yes"); // active: 10 % 3 !== 0
    expect(cellText(container, 12, 3)).toBe("No"); // 12 % 3 === 0
    expect(footer(container)).toBe("50 rows");
    expect(harness.pending()).toEqual([]);
  });

  it("drops a window answered for an older generation after a sort", async () => {
    mount(harness.data);
    await harness.release("query");
    await frame();
    expect(harness.pending()).toEqual(["window"]);

    // Sorting bumps the generation while the window is still in flight.
    engine.setSort("score", "desc");
    expect(engine.getState().pending).toBe(true);
    await frame();
    expect(harness.pending()).toEqual(["window", "query"]);

    await harness.release("window");
    await frame();
    // The stale window never lands: every row is still a placeholder.
    expect(skeletons(container)).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Person 10");

    await harness.release("query");
    expect(engine.getState().pending).toBe(false);
    await frame();
    expect(harness.pending()).toEqual(["window"]);
    await harness.release("window");
    await frame();
    const scores = [0, 1, 2].map((r) => Number(cellText(container, r, 2)));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBe(Math.max(...rows.map((row) => row[2] as number)));
    expect(skeletons(container)).toBe(0);
  });

  it("filters: pending, then the right count, summaries, and empty state", async () => {
    const onChange = vi.fn();
    mount(harness.data, { onChange });
    await harness.release("query");
    await frame();
    await harness.release("window");
    await frame();

    engine.setFilter(3, { kind: "boolean", value: true });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ pending: true, filteredCount: 50 }),
    );
    expect(harness.pending()).toEqual(["query"]);
    await harness.release("query");
    const expected = rows.filter((row) => row[3] === true).length;
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ pending: false, filteredCount: expected, totalCount: 50 }),
    );
    expect(footer(container)).toBe(`${expected} of 50 rows`);
    await frame();
    await harness.releaseAll();
    await frame();
    expect(skeletons(container)).toBe(0);
    for (let r = 0; r < 5; r++) expect(cellText(container, r, 3)).toBe("Yes");

    // No matches: the empty state shows and nothing is requested.
    engine.setFilter(2, { kind: "range", min: 1000, max: 2000 });
    await harness.release("query");
    expect(engine.getState().filteredCount).toBe(0);
    await frame();
    expect(container.querySelector<HTMLElement>(".sift-empty-state")?.style.display).toBe("");
    expect(harness.pending()).toEqual([]);

    engine.clearAllFilters();
    await harness.release("query");
    expect(engine.getState()).toMatchObject({ filteredCount: 50, filters: [] });
    await frame();
    await harness.releaseAll();
    await frame();
    expect(footer(container)).toBe("50 rows");
    expect(skeletons(container)).toBe(0);
  });

  it("rows-appended grows the row count and keeps the sort", async () => {
    mount(harness.data);
    engine.setSort("score", "desc");
    await harness.releaseAll();
    await frame();
    await harness.releaseAll();
    await frame();
    expect(footer(container)).toBe("50 rows");

    rows.push([51, "Person 50", 999, true]);
    source.rowCount = 51;
    harness.inner.notifyAppended();
    expect(engine.getState()).toMatchObject({ pending: true, totalCount: 51 });
    await harness.release("query");
    expect(engine.getState()).toMatchObject({
      pending: false,
      filteredCount: 51,
      sort: { column: "score", direction: "desc" },
    });
    await frame();
    await harness.releaseAll();
    await frame();
    expect(footer(container)).toBe("51 rows");
    expect(cellText(container, 0, 1)).toBe("Person 50");
  });

  it("replaceData swaps windowed sources and rebuilds for resident data", async () => {
    mount(harness.data);
    await harness.releaseAll();
    await frame();
    await harness.releaseAll();
    await frame();
    engine.setFilter(3, { kind: "boolean", value: true });
    await harness.release("query");

    const nextSource = makeTableData([
      [1, "Alice", 10, true],
      [2, "Bob", 20, false],
    ]);
    nextSource.dispose = vi.fn();
    const next = delayed(createResidentWindowedData(nextSource), true);
    engine.replaceData(next.data);
    expect(source.dispose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    await frame();
    await frame();
    // Preserved filter re-applies through the new source's query.
    expect(engine.getState()).toMatchObject({ filteredCount: 1, totalCount: 2, pending: false });
    expect(cellText(container, 0, 1)).toBe("Alice");

    // Resident data after windowed data: a mode change rebuilds the engine.
    engine.replaceData(makeTableData(makeRows(3)));
    await frame();
    expect(nextSource.dispose).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toMatchObject({ totalCount: 3, pending: false });
    expect(container.querySelector(".sift-stat-rows")).not.toBeNull();
  });

  it("getState reports pending alongside the resident fields", async () => {
    mount(harness.data);
    expect(engine.getState()).toMatchObject({
      sort: null,
      filters: [],
      filteredCount: 50,
      totalCount: 50,
      loadedCount: 50,
      pending: true,
    });
    await harness.release("query");
    expect(engine.getState().pending).toBe(false);
  });

  it("destroy disposes the source once and ignores late responses", async () => {
    mount(harness.data);
    await harness.release("query");
    await frame();
    expect(harness.pending()).toEqual(["window"]);
    engine.destroy();
    expect(source.dispose).toHaveBeenCalledTimes(1);
    await harness.release("window");
    engine.destroy();
    expect(source.dispose).toHaveBeenCalledTimes(1);
  });

  it("focuses a resolved row by data row and ignores placeholders", async () => {
    mount(harness.data);
    await harness.release("query");
    await frame();
    // Row 20 is still a placeholder: clicking it changes nothing.
    const placeholder = container.querySelector<HTMLElement>('[aria-rowindex="22"]')!;
    expect(placeholder.classList.contains("sift-row-placeholder")).toBe(true);
    placeholder.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    placeholder.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: 5, clientY: 5, button: 0 }),
    );
    expect(engine.getFocusedDataRow()).toBeNull();

    await harness.release("window");
    await frame();
    engine.setFocusedDataRow(3);
    await frame();
    const focused = container.querySelector('[aria-rowindex="5"]');
    expect(focused?.classList.contains("sift-row-focused")).toBe(true);
    expect(engine.getFocusedDataRow()).toBe(3);
    // Focus is by data row, so it survives a sort.
    engine.setSort("score", "desc");
    await harness.release("query");
    await frame();
    await harness.releaseAll();
    await frame();
    expect(engine.getFocusedDataRow()).toBe(3);
    expect(container.querySelector(".sift-row-focused")?.textContent).toContain("Person 3");
  });

  it("fills image cells through requestImage only while the row still shows that data row", async () => {
    const createObjectURL = vi.fn(() => "blob:test");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const columns: Column[] = [
      ...makeColumns().slice(0, 2),
      {
        key: "image",
        label: "Image",
        width: 140,
        sortable: false,
        numeric: false,
        columnType: "image",
      },
    ];
    const imageRows: unknown[][] = [
      [1, "Person 0", [pngBytes]],
      [2, "Person 1", null],
    ];
    const imageSource = makeTableDataWithColumns(imageRows, columns);
    harness = delayed(createResidentWindowedData(imageSource, { headRows: 0 }));
    mount(harness.data);
    await frame();
    // Placeholder rows for an image schema use the thumbnail estimate.
    expect(container.querySelector<HTMLElement>('[aria-rowindex="2"]')?.style.height).toBe("80px");
    await harness.release("query");
    await frame();
    await harness.release("window");
    await frame();
    const imageCell = container
      .querySelector('[aria-rowindex="2"]')!
      .querySelectorAll<HTMLElement>(".sift-cell")[2];
    expect(imageCell.classList.contains("sift-cell-image")).toBe(true);
    expect(imageCell.querySelector("img")).toBeNull();
    expect(harness.pending()).toEqual(["image"]);
    // The null image cell did not ask for bytes.
    expect(cellText(container, 1, 2)).toBe("null");

    await harness.release("image");
    expect(imageCell.querySelector("img")?.getAttribute("src")).toBe("blob:test");
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    // A late answer for a recycled row is ignored.
    engine.setSort("name", "desc");
    await harness.release("query");
    await frame();
    await harness.release("window");
    await frame();
    expect(harness.pending()).toEqual(["image"]);
    const recycled = container
      .querySelector('[aria-rowindex="3"]')!
      .querySelectorAll(".sift-cell")[2];
    expect(recycled.textContent).toBe("");
    engine.setSort("name", "asc");
    await harness.release("query");
    await frame();
    await harness.release("window");
    await frame();
    const callsBefore = createObjectURL.mock.calls.length;
    await harness.release("image"); // belongs to the reassigned pooled row
    expect(createObjectURL.mock.calls.length).toBe(callsBefore);
    vi.unstubAllGlobals();
  });

  it("casts through the data side: pending, new column type, re-rendered cells", async () => {
    const castSource = makeTableData(rows);
    // A cast turns the score column into text; the source rewrites its cells.
    let scoreType: Column["columnType"] = "numeric";
    castSource.getCell = (r, c) =>
      c === 2 && scoreType !== "numeric" ? `#${rows[r][c]}` : String(rows[r][c] ?? "");
    castSource.castColumn = vi.fn((col, to) => {
      scoreType = to;
      castSource.columns[col].columnType = to;
    });
    castSource.isColumnCast = vi.fn(() => scoreType !== "numeric");
    harness = delayed(createResidentWindowedData(castSource, { headRows: 10 }));
    mount(harness.data);
    engine.setStreamingDone();
    await harness.release("query");
    await frame();
    await harness.release("window");
    await frame();
    expect(cellText(container, 0, 2)).toBe("0");

    await act(async () => {
      container
        .querySelector<HTMLElement>('.sift-th[data-col="2"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const menu = document.getElementById("column-context-menu-root")!;
    const textItem = [...menu.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Text"),
    );
    await act(async () => {
      textItem!.click();
    });
    expect(castSource.castColumn).toHaveBeenCalledWith(2, "categorical");
    expect(engine.getState().pending).toBe(true);
    expect(harness.pending()).toEqual(["cast"]);
    await harness.release("cast");
    expect(engine.getState().pending).toBe(false);
    expect(harness.data.columns[2].columnType).toBe("categorical");
    expect(container.querySelector('.sift-th[data-col="2"] .sift-type-icon')?.textContent).toBe(
      "Aa",
    );
    await frame();
    await harness.releaseAll();
    await frame();
    expect(cellText(container, 0, 2)).toBe("#0");
    expect(skeletons(container)).toBe(0);
  });
});
