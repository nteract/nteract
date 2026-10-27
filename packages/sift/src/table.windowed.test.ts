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

/**
 * QA findings on #4504: appends must not repaint delivered rows as placeholders
 * or move the viewport, and a refused or dead data side must not erase cells.
 */
describe("windowed appends and failures keep the painted snapshot", () => {
  let container: HTMLDivElement;
  let rows: unknown[][];
  let source: TableData;
  let harness: ReturnType<typeof delayed>;
  let engine: TableEngine;

  type Painted = { text: string | undefined; height: string; transform: string }[];
  /** Text, height, and transform of every shown pooled row, by view row. */
  function painted(): Painted {
    return [...container.querySelectorAll<HTMLElement>(".sift-row")]
      .filter((row) => row.style.display !== "none")
      .sort(
        (a, b) => Number(a.getAttribute("aria-rowindex")) - Number(b.getAttribute("aria-rowindex")),
      )
      .map((row) => ({
        text: row.querySelectorAll(".sift-cell")[1]?.textContent ?? undefined,
        height: row.style.height,
        transform: row.style.transform,
      }));
  }
  const viewport = () => container.querySelector<HTMLElement>(".sift-viewport")!;
  /** Skeleton cells in shown rows; released pooled rows are hidden, not cleared. */
  const shownSkeletons = () =>
    [...container.querySelectorAll<HTMLElement>(".sift-row")]
      .filter((row) => row.style.display !== "none")
      .reduce((n, row) => n + row.querySelectorAll(".sift-cell-skeleton").length, 0);

  function mount(data: WindowedTableData, options?: Parameters<typeof createTable>[2]) {
    engine = createTable(container, data, options);
    Object.defineProperty(viewport(), "clientHeight", { value: 400, configurable: true });
    viewport().dispatchEvent(new Event("scroll"));
    return engine;
  }

  async function settle() {
    await frame();
    await harness.releaseAll();
    await frame();
    await harness.releaseAll();
    await frame();
  }

  function append(count: number) {
    for (let i = 0; i < count; i++) {
      const id = rows.length + 1;
      rows.push([id, `Person ${id - 1}`, 500 + i, true]);
    }
    source.rowCount = rows.length;
    harness.inner.notifyAppended();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    rows = makeRows(60);
    source = makeTableData(rows);
    harness = delayed(createResidentWindowedData(source, { headRows: 10 }));
  });

  afterEach(() => {
    engine?.destroy();
    container.remove();
    vi.useRealTimers();
  });

  it("(a) identity append at the head: painted rows and scrollTop never change while the window is held", async () => {
    mount(harness.data);
    await settle();
    const before = painted();
    expect(before.length).toBeGreaterThan(10);
    expect(before[0].text).toBe("Person 0");
    expect(skeletons(container)).toBe(0);
    const scrollTop = viewport().scrollTop;

    append(5);
    expect(engine.getState()).toMatchObject({ pending: false, filteredCount: 65, totalCount: 65 });
    expect(footer(container)).toBe("65 rows");
    // The new rows' window is held across several frames.
    for (let i = 0; i < 3; i++) {
      await frame();
      const now = painted().slice(0, before.length);
      expect(now).toEqual(before);
      expect(viewport().scrollTop).toBe(scrollTop);
    }
    expect(harness.pending()).toEqual([]);
    // Nothing visible is unresolved: the new rows sit below the viewport.
    expect(container.getAttribute("aria-busy")).toBe("false");
    await settle();
    expect(painted().slice(0, before.length)).toEqual(before);
  });

  it("(b) identity append beyond the head: the resolved window stays painted and the viewport holds", async () => {
    mount(harness.data);
    await settle();
    // Scroll to a window past the head and let it resolve.
    viewport().scrollTop = 30 * 36;
    viewport().dispatchEvent(new Event("scroll"));
    await settle();
    const before = painted();
    expect(before.some((row) => row.text === "Person 35")).toBe(true);
    expect(shownSkeletons()).toBe(0);
    const scrollTop = viewport().scrollTop;
    expect(scrollTop).toBe(30 * 36);

    append(5);
    for (let i = 0; i < 3; i++) {
      await frame();
      expect(painted().slice(0, before.length)).toEqual(before);
      expect(viewport().scrollTop).toBe(scrollTop);
      // Only the appended rows (view rows 60+, below the viewport) are placeholders.
      const placeholderRows = [...container.querySelectorAll<HTMLElement>(".sift-row")]
        .filter((row) => row.style.display !== "none" && row.querySelector(".sift-cell-skeleton"))
        .map((row) => Number(row.getAttribute("aria-rowindex")) - 2);
      expect(placeholderRows.every((r) => r >= 60)).toBe(true);
    }
    await settle();
    expect(shownSkeletons()).toBe(0);
    expect(painted().slice(0, before.length)).toEqual(before);
    expect(viewport().scrollTop).toBe(scrollTop);
    expect(engine.getState().filteredCount).toBe(65);
  });

  it("(c) sorted append: the snapshot stays until query and window commit together under the anchor", async () => {
    const onChange = vi.fn();
    mount(harness.data, { onChange });
    engine.setSort("score", "desc");
    await settle();
    viewport().scrollTop = 5 * 36;
    viewport().dispatchEvent(new Event("scroll"));
    await settle();
    const before = painted();
    expect(shownSkeletons()).toBe(0);
    const scrollTop = viewport().scrollTop;

    append(1); // score 500 sorts first and shifts every row down by one
    expect(engine.getState()).toMatchObject({ pending: true, totalCount: 61, filteredCount: 60 });
    expect(harness.pending()).toEqual(["query"]);
    await frame();
    expect(painted()).toEqual(before);

    await harness.release("query");
    // The answer is reported, the rows are not touched yet.
    expect(engine.getState()).toMatchObject({ pending: false, filteredCount: 61 });
    expect(footer(container)).toBe("61 rows");
    expect(harness.pending()).toEqual(["window"]);
    for (let i = 0; i < 3; i++) {
      await frame();
      expect(painted()).toEqual(before);
      expect(viewport().scrollTop).toBe(scrollTop);
      expect(harness.pending()).toEqual(["window"]);
    }

    await harness.release("window");
    await frame();
    // Committed in one frame: no placeholder, every row shifted down by the
    // new first row, and the anchored view row keeps its offset.
    expect(shownSkeletons()).toBe(0);
    const after = painted();
    expect(after[0].text).toBe("Person 60");
    for (let i = 1; i < before.length; i++) expect(after[i].text).toBe(before[i - 1].text);
    expect(after.map((r) => r.transform)).toEqual(before.map((r) => r.transform));
    expect(viewport().scrollTop).toBe(scrollTop);
    expect(engine.getState().filteredCount).toBe(61);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ filteredCount: 61 }));
  });

  it("(d) a superseding query during a held sorted append discards the pending commit", async () => {
    mount(harness.data);
    engine.setSort("score", "desc");
    await settle();
    const before = painted();

    append(1);
    await harness.release("query");
    expect(harness.pending()).toEqual(["window"]);
    expect(footer(container)).toBe("61 rows");

    // The user filters before the append's window lands.
    engine.setFilter(3, { kind: "boolean", value: false });
    expect(engine.getState().pending).toBe(true);
    await harness.release("window"); // the held append window: dropped
    await frame();
    // The held answer (61) never committed; the snapshot's count still reports.
    expect(engine.getState()).toMatchObject({ pending: true, filteredCount: 60 });
    expect(footer(container)).toBe("60 of 61 rows");

    await harness.release("query");
    const expected = rows.filter((row) => row[3] === false).length;
    expect(engine.getState()).toMatchObject({ pending: false, filteredCount: expected });
    await settle();
    expect(shownSkeletons()).toBe(0);
    expect(before.length).toBeGreaterThan(0);
    const activeCells = [...container.querySelectorAll<HTMLElement>(".sift-row")]
      .filter((row) => row.style.display !== "none")
      .map((row) => row.querySelectorAll(".sift-cell")[3]?.textContent);
    expect(new Set(activeCells)).toEqual(new Set(["No"]));
  });

  it("a refused query after a sort click puts the delivered cells back; a fatal event disables the tools", async () => {
    // Forward the adapter's events and allow the test to inject a fatal one.
    const listeners = new Set<
      (event: Parameters<Parameters<WindowedTableData["subscribe"]>[0]>[0]) => void
    >();
    const data: WindowedTableData = {
      ...harness.data,
      get columns() {
        return harness.inner.columns;
      },
      get rowCount() {
        return harness.inner.rowCount;
      },
      get head() {
        return harness.inner.head;
      },
      subscribe(listener) {
        listeners.add(listener);
        const off = harness.data.subscribe(listener);
        return () => {
          listeners.delete(listener);
          off();
        };
      },
    };
    const onChange = vi.fn();
    mount(data, { onChange });
    await settle();
    const before = painted();
    expect(before[0].text).toBe("Person 0");

    // The data side is dead: every query rejects.
    vi.spyOn(harness.inner, "setQuery").mockImplementation(() =>
      Promise.reject(new Error("worker terminated")),
    );
    engine.setSort("score", "desc");
    expect(engine.getState().pending).toBe(true);
    await frame();
    expect(skeletons(container)).toBeGreaterThan(0); // the deliberate change shows placeholders
    await harness.release("query");
    expect(engine.getState()).toMatchObject({ pending: false, dataFailed: false });
    await frame();
    // Rejected: the snapshot is back, no placeholder remains.
    expect(shownSkeletons()).toBe(0);
    expect(painted().map((r) => r.text)).toEqual(before.map((r) => r.text));
    expect(footer(container)).toBe("60 rows");

    // The fatal event: rows stay, tools go.
    for (const listener of listeners) {
      listener({ type: "error", message: "worker terminated", fatal: true });
    }
    expect(engine.getState().dataFailed).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ dataFailed: true }));
    expect(painted().map((r) => r.text)).toEqual(before.map((r) => r.text));
    const scoreTop = container.querySelector<HTMLElement>('.sift-th[data-col="2"] .sift-th-top')!;
    expect(scoreTop.getAttribute("aria-disabled")).toBe("true");
    expect(scoreTop.title).toBe("Data source stopped; table tools are unavailable");
    const sortBefore = engine.getSort();
    scoreTop.click();
    expect(engine.getSort()).toEqual(sortBefore);
    expect(harness.pending()).toEqual([]);
    // Filters would need a query too: popovers, pills, and the API are no-ops.
    engine.setFilter(3, { kind: "boolean", value: true });
    engine.clearAllFilters();
    expect(engine.getState().filters).toEqual([]);
    expect(harness.pending()).toEqual([]);
    await frame();
    expect(shownSkeletons()).toBe(0);
    expect(painted().map((r) => r.text)).toEqual(before.map((r) => r.text));
  });
});
