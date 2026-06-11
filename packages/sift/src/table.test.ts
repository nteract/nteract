import { layout, prepare } from "@chenglou/pretext";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type Column, createTable, type TableData, type TableEngine } from "./table";

// --- Test helpers ---

function makeColumns(): Column[] {
  return [
    {
      key: "id",
      label: "ID",
      width: 80,
      sortable: true,
      numeric: true,
      columnType: "numeric",
    },
    {
      key: "name",
      label: "Name",
      width: 150,
      sortable: true,
      numeric: false,
      columnType: "categorical",
    },
    {
      key: "score",
      label: "Score",
      width: 100,
      sortable: true,
      numeric: true,
      columnType: "numeric",
    },
    {
      key: "active",
      label: "Active",
      width: 80,
      sortable: true,
      numeric: false,
      columnType: "boolean",
    },
  ];
}

function makeTableData(rows: unknown[][]): TableData {
  const columns = makeColumns();
  return makeTableDataWithColumns(rows, columns);
}

function makeTableDataWithColumns(rows: unknown[][], columns: Column[]): TableData {
  return {
    columns,
    rowCount: rows.length,
    getCell: (r, c) => String(rows[r][c] ?? ""),
    getCellRaw: (r, c) => rows[r][c],
    columnSummaries: columns.map(() => null),
  };
}

function makeRows(count: number): unknown[][] {
  const rows: unknown[][] = [];
  for (let i = 0; i < count; i++) {
    rows.push([i + 1, `Person ${i}`, Math.round(Math.random() * 100), i % 3 !== 0]);
  }
  return rows;
}

async function flushRAF() {
  await vi.advanceTimersByTimeAsync(0);
}

function resetPretextMocks() {
  vi.mocked(prepare).mockImplementation(
    () => ({ __brand: "PreparedText" }) as unknown as ReturnType<typeof prepare>,
  );
  vi.mocked(layout).mockImplementation(
    () => ({ lineCount: 1, height: 20 }) as ReturnType<typeof layout>,
  );
}

function pointerEvent(type: string, clientX: number): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    clientX: { value: clientX },
    pointerId: { value: 1 },
  });
  return event;
}

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 800,
    width: 800,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

// --- Tests ---

describe("createTable", () => {
  let container: HTMLDivElement;
  let rows: unknown[][];
  let data: TableData;
  let engine: TableEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    resetPretextMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    rows = makeRows(50);
    data = makeTableData(rows);
    engine = createTable(container, data);
  });

  afterEach(() => {
    engine.destroy();
    container.remove();
    vi.useRealTimers();
  });

  describe("DOM structure", () => {
    it("creates header, viewport, and stats bar", async () => {
      await flushRAF();
      expect(container.querySelector(".sift-header")).not.toBeNull();
      expect(container.querySelector(".sift-viewport")).not.toBeNull();
      expect(container.querySelector(".sift-stats")).not.toBeNull();
    });

    it("disposes backing table data when destroyed", () => {
      const localContainer = document.createElement("div");
      document.body.appendChild(localContainer);
      const dispose = vi.fn();
      const localEngine = createTable(localContainer, {
        ...makeTableData(rows),
        dispose,
      });

      localEngine.destroy();

      expect(dispose).toHaveBeenCalledTimes(1);
      localContainer.remove();
    });

    it("disposes backing table data only once across repeated destroy calls", () => {
      const localContainer = document.createElement("div");
      document.body.appendChild(localContainer);
      const dispose = vi.fn();
      const localEngine = createTable(localContainer, {
        ...makeTableData(rows),
        dispose,
      });

      localEngine.destroy();
      localEngine.destroy();

      expect(dispose).toHaveBeenCalledTimes(1);
      localContainer.remove();
    });

    it("renders correct header labels", async () => {
      await flushRAF();
      const labels = container.querySelectorAll(".sift-th-label");
      expect(labels).toHaveLength(4);
      expect(labels[0].textContent).toBe("ID");
      expect(labels[1].textContent).toBe("Name");
      expect(labels[2].textContent).toBe("Score");
      expect(labels[3].textContent).toBe("Active");
    });

    it("shows row count in stats bar", async () => {
      await flushRAF();
      const stats = container.querySelector(".sift-stat-rows") as HTMLElement;
      expect(stats?.dataset.value).toContain("50");
    });

    it("does not let long numeric values expand row height", async () => {
      const numericContainer = document.createElement("div");
      document.body.appendChild(numericContainer);
      const longNumber = `0.${"0".repeat(300)}5`;
      const numericEngine = createTable(
        numericContainer,
        makeTableData([[1, "Person 1", longNumber, true]]),
      );
      const viewport = numericContainer.querySelector<HTMLElement>(".sift-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 400, configurable: true });
      viewport.dispatchEvent(new Event("scroll"));

      await vi.advanceTimersByTimeAsync(20);

      const row = numericContainer.querySelector<HTMLElement>(".sift-row")!;
      expect(Number.parseFloat(row.style.height || "0")).toBeLessThan(80);

      numericEngine.destroy();
      numericContainer.remove();
    });

    it("positions rows with freshly measured lazy heights before painting", async () => {
      engine.destroy();
      container.innerHTML = "";

      vi.mocked(prepare).mockImplementation(
        (text: string) =>
          ({ __brand: "PreparedText", text }) as unknown as ReturnType<typeof prepare>,
      );
      vi.mocked(layout).mockImplementation((prepared: unknown) => {
        const { text } = prepared as { text?: string };
        return {
          // lineCount stays at MAX_COLLAPSED_LINES so the engine keeps the
          // measured height instead of clamping for the row-collapse path.
          lineCount: text?.includes("tall wrapped categorical text") ? 3 : 1,
          height: text?.includes("tall wrapped categorical text") ? 120 : 20,
        } as ReturnType<typeof layout>;
      });

      const tallRows = makeRows(8);
      tallRows[1][1] = "tall wrapped categorical text";
      engine = createTable(container, makeTableData(tallRows));

      await vi.advanceTimersByTimeAsync(20);

      const thirdRenderedRow = container.querySelector<HTMLElement>('[aria-rowindex="4"]');
      expect(thirdRenderedRow?.style.transform).toBe("translateY(172px)");
    });

    it("clamps a multi-line text cell to MAX_COLLAPSED_LINES until its row is focused", async () => {
      engine.destroy();
      container.innerHTML = "";

      vi.mocked(prepare).mockImplementation(
        (text: string) =>
          ({ __brand: "PreparedText", text }) as unknown as ReturnType<typeof prepare>,
      );
      // Every categorical cell reports 6 lines — well over the cap of 3.
      vi.mocked(layout).mockImplementation(
        () =>
          ({
            lineCount: 6,
            height: 120,
          }) as ReturnType<typeof layout>,
      );

      engine = createTable(container, makeTableData(makeRows(4)));
      const viewport = container.querySelector<HTMLElement>(".sift-viewport")!;
      // Force enough viewport height that the render loop reaches all 4 rows
      // and measures their categorical column.
      Object.defineProperty(viewport, "clientHeight", { value: 800, configurable: true });
      viewport.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(20);

      // Collapsed: every row's tall categorical column caps at 3 × 20 + 16 = 76.
      // View row 2 (aria-rowindex=4 — header is 1) sits at heights[0]+heights[1] = 152.
      const beforeRow2 = container.querySelector<HTMLElement>('[aria-rowindex="4"]');
      expect(beforeRow2?.style.transform).toBe("translateY(152px)");

      // The truncated cell carries the soft-fade class.
      expect(container.querySelector(".sift-cell-truncated")).not.toBeNull();

      // Focus row 1 → its height grows to the full 120 + 16 = 136.
      engine.setFocusedDataRow(1);
      await vi.advanceTimersByTimeAsync(20);

      const afterRow2 = container.querySelector<HTMLElement>('[aria-rowindex="4"]');
      // Row 0 still capped (76), row 1 expanded (136). View row 2 sits at 76 + 136 = 212.
      expect(afterRow2?.style.transform).toBe("translateY(212px)");

      // Truncation class is gone for the focused row's text cells.
      const focusedRow = container.querySelector(".sift-row-focused");
      expect(focusedRow).not.toBeNull();
      expect(focusedRow?.querySelector(".sift-cell-truncated")).toBeNull();
    });

    it("preserves image-cell <img> elements across focus toggle", async () => {
      // Regression: setFocusedDataRow used to renderCell every cell in the
      // affected rows, which destroyed the <img>s and re-allocated blob URLs
      // for the same bytes — the browser had to re-decode every image and
      // the user saw a flicker on row click.
      engine.destroy();
      container.innerHTML = "";

      vi.mocked(prepare).mockImplementation(
        (text: string) =>
          ({ __brand: "PreparedText", text }) as unknown as ReturnType<typeof prepare>,
      );
      // Tall categorical so focus expansion has something to do.
      vi.mocked(layout).mockImplementation(
        () => ({ lineCount: 6, height: 120 }) as ReturnType<typeof layout>,
      );

      // 8-byte PNG signature is enough for sniffImageMime to recognize it;
      // the <img> won't render in jsdom but the element + blob URL persist.
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const columns: Column[] = [
        {
          key: "id",
          label: "ID",
          width: 80,
          sortable: true,
          numeric: true,
          columnType: "numeric",
        },
        {
          key: "name",
          label: "Name",
          width: 150,
          sortable: true,
          numeric: false,
          columnType: "categorical",
        },
        {
          key: "image",
          label: "Image",
          width: 140,
          sortable: false,
          numeric: false,
          columnType: "image",
        },
      ];
      const rows: unknown[][] = [
        [1, "Person 0", [pngBytes]],
        [2, "Person 1", [pngBytes]],
      ];
      const data: TableData = {
        columns,
        rowCount: rows.length,
        getCell: (r, c) => String(rows[r][c] ?? ""),
        getCellRaw: (r, c) => rows[r][c],
        columnSummaries: columns.map(() => null),
      };

      engine = createTable(container, data);
      const viewport = container.querySelector<HTMLElement>(".sift-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 800, configurable: true });
      viewport.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(20);

      // Capture the <img> in row 1's image cell before toggling focus.
      const beforeImg = container.querySelector<HTMLImageElement>(
        '[aria-rowindex="3"] .sift-cell-image-thumb',
      );
      expect(beforeImg).not.toBeNull();
      const beforeBlobUrl = beforeImg!.dataset.siftBlobUrl;
      expect(beforeBlobUrl).toBeDefined();

      engine.setFocusedDataRow(1);
      await vi.advanceTimersByTimeAsync(20);

      const afterImg = container.querySelector<HTMLImageElement>(
        '[aria-rowindex="3"] .sift-cell-image-thumb',
      );
      // Same DOM node, same blob URL — no destroy + reallocate cycle.
      expect(afterImg).toBe(beforeImg);
      expect(afterImg!.dataset.siftBlobUrl).toBe(beforeBlobUrl);

      // Focus class still applied so the rest of the row-focus contract holds.
      const focusedRow = container.querySelector(".sift-row-focused");
      expect(focusedRow).not.toBeNull();
    });

    it("opens a larger image viewer with metadata and image-list navigation", async () => {
      engine.destroy();
      container.innerHTML = "";

      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      const columns: Column[] = [
        {
          key: "id",
          label: "ID",
          width: 80,
          sortable: true,
          numeric: true,
          columnType: "numeric",
        },
        {
          key: "image",
          label: "Image",
          width: 140,
          sortable: false,
          numeric: false,
          columnType: "image",
        },
      ];
      const imageRows: unknown[][] = [[1, [pngBytes, gifBytes]]];
      const imageData: TableData = {
        columns,
        rowCount: imageRows.length,
        getCell: (r, c) => String(imageRows[r][c] ?? ""),
        getCellRaw: (r, c) => imageRows[r][c],
        columnSummaries: columns.map(() => null),
      };

      engine = createTable(container, imageData);
      const viewport = container.querySelector<HTMLElement>(".sift-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 800, configurable: true });
      viewport.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(20);

      const thumbButton = container.querySelector<HTMLButtonElement>(
        ".sift-cell-image-thumb-button",
      );
      const thumbImg = thumbButton?.querySelector<HTMLImageElement>(".sift-cell-image-thumb");
      expect(thumbButton).not.toBeNull();
      expect(thumbImg?.dataset.siftBlobUrl).toBeDefined();

      await act(async () => {
        thumbButton!.click();
      });
      await flushRAF();

      const viewer = document.body.querySelector<HTMLElement>(".sift-image-viewer");
      const viewerImg = viewer?.querySelector<HTMLImageElement>(".sift-image-viewer-img");
      const viewerMeta = viewer?.querySelector<HTMLElement>(".sift-image-viewer-meta");
      expect(viewer).not.toBeNull();
      expect(viewerImg?.src).toMatch(/^blob:/);
      expect(viewerImg?.src).not.toBe(thumbImg!.dataset.siftBlobUrl);
      expect(viewerImg?.dataset.siftImageViewerIndex).toBe("0");
      expect(viewerMeta?.textContent).toBe("Image 1 of 2");
      expect(engine.getFocusedDataRow()).toBeNull();

      const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
      const firstViewerUrl = viewerImg!.src;
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>(".sift-image-viewer-next")!.click();
      });
      await flushRAF();
      const secondViewerImg = viewer?.querySelector<HTMLImageElement>(".sift-image-viewer-img");
      expect(secondViewerImg?.dataset.siftImageViewerIndex).toBe("1");
      expect(viewerMeta?.textContent).toBe("Image 2 of 2");
      expect(revokeSpy).toHaveBeenCalledWith(firstViewerUrl);

      const secondViewerUrl = secondViewerImg!.src;
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
      });
      await flushRAF();
      const finalViewerImg = viewer?.querySelector<HTMLImageElement>(".sift-image-viewer-img");
      expect(finalViewerImg?.dataset.siftImageViewerIndex).toBe("0");
      expect(viewerMeta?.textContent).toBe("Image 1 of 2");
      expect(revokeSpy).toHaveBeenCalledWith(secondViewerUrl);

      const finalViewerUrl = finalViewerImg!.src;
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>(".sift-image-viewer-close")!.click();
      });
      await flushRAF();

      expect(document.body.querySelector(".sift-image-viewer")).toBeNull();
      expect(revokeSpy).toHaveBeenCalledWith(finalViewerUrl);
      revokeSpy.mockRestore();
    });
  });

  describe("filtering", () => {
    it("setFilter reduces visible row count", async () => {
      await flushRAF();
      engine.setFilter(2, { kind: "range", min: 0, max: 30 });
      await flushRAF();
      const stats = container.querySelector(".sift-stat-rows") as HTMLElement;
      expect(stats?.dataset.value).toContain("of");
      expect(stats?.dataset.value).toContain("50");
    });

    it("setFilter creates a filter pill", async () => {
      await flushRAF();
      engine.setFilter(2, { kind: "range", min: 10, max: 50 });
      await flushRAF();
      const pills = container.querySelectorAll(".sift-filter-pill");
      expect(pills.length).toBe(1);
      expect(pills[0].textContent).toContain("Score");
      expect(pills[0].querySelector(".sift-filter-pill-label")?.textContent).toContain("Score");
      expect(pills[0].querySelector(".sift-filter-pill-x")).not.toBeNull();
    });

    it("clearFilter removes the pill", async () => {
      await flushRAF();
      engine.setFilter(2, { kind: "range", min: 10, max: 50 });
      await flushRAF();
      engine.clearFilter(2);
      await flushRAF();
      const pills = container.querySelectorAll(".sift-filter-pill");
      expect(pills.length).toBe(0);
    });

    it("clearAllFilters removes all pills", async () => {
      await flushRAF();
      engine.setFilter(1, { kind: "set", values: new Set(["Person 1"]) });
      engine.setFilter(3, { kind: "boolean", value: true });
      await flushRAF();
      expect(container.querySelectorAll(".sift-filter-pill").length).toBe(2);
      engine.clearAllFilters();
      await flushRAF();
      expect(container.querySelectorAll(".sift-filter-pill").length).toBe(0);
    });

    it("boolean filter works", async () => {
      await flushRAF();
      engine.setFilter(3, { kind: "boolean", value: true });
      await flushRAF();
      const stats = container.querySelector(".sift-stat-rows") as HTMLElement;
      expect(stats?.dataset.value).toContain("of");
    });

    it("set filter works", async () => {
      await flushRAF();
      engine.setFilter(1, {
        kind: "set",
        values: new Set(["Person 0", "Person 1"]),
      });
      await flushRAF();
      const stats = container.querySelector(".sift-stat-rows") as HTMLElement;
      expect(stats?.dataset.value).toContain("of");
    });
  });

  describe("destroy", () => {
    it("clears container contents", async () => {
      await flushRAF();
      engine.destroy();
      expect(container.innerHTML).toBe("");
    });

    it("removes sift-table-container class", async () => {
      await flushRAF();
      expect(container.classList.contains("sift-table-container")).toBe(true);
      engine.destroy();
      expect(container.classList.contains("sift-table-container")).toBe(false);
    });
  });

  describe("state API", () => {
    it("getSort returns null initially", () => {
      expect(engine.getSort()).toBeNull();
    });

    it("setSort sets sort state", async () => {
      engine.setSort("name", "asc");
      await flushRAF();
      const sort = engine.getSort();
      expect(sort).toEqual({ column: "name", direction: "asc" });
    });

    it("getFilters returns empty array initially", () => {
      expect(engine.getFilters()).toEqual([]);
    });

    it("getFilters returns active filters", async () => {
      engine.setFilter(2, { kind: "range", min: 10, max: 50 });
      await flushRAF();
      const filters = engine.getFilters();
      expect(filters).toHaveLength(1);
      expect(filters[0].column).toBe("score");
      expect(filters[0].filter).toEqual({ kind: "range", min: 10, max: 50 });
    });

    it("getState returns full state", async () => {
      engine.setSort("score", "desc");
      engine.setFilter(3, { kind: "boolean", value: true });
      await flushRAF();
      const state = engine.getState();
      expect(state.sort).toEqual({ column: "score", direction: "desc" });
      expect(state.filters).toHaveLength(1);
      expect(state.totalCount).toBe(50);
      expect(state.filteredCount).toBeLessThanOrEqual(50);
    });

    it("onChange callback fires on filter change", async () => {
      const onChange = vi.fn();
      engine.destroy();
      engine = createTable(container, data, { onChange });
      await flushRAF();

      engine.setFilter(2, { kind: "range", min: 10, max: 50 });
      await flushRAF();
      expect(onChange).toHaveBeenCalled();
      const state = onChange.mock.calls.at(-1)?.[0];
      expect(state.filters).toHaveLength(1);
    });

    it("replaceData swaps same-schema rows without remounting chrome", async () => {
      const oldDispose = vi.fn();
      data.dispose = oldDispose;
      await flushRAF();
      const viewport = container.querySelector(".sift-viewport");

      engine.setSort("score", "desc");
      engine.setFilter(1, { kind: "set", values: new Set(["Person 1"]) });
      await flushRAF();

      const nextData = makeTableData([
        [101, "Person 1", 12, true],
        [102, "Other", 98, false],
      ]);
      engine.replaceData(nextData);
      await flushRAF();

      expect(container.querySelector(".sift-viewport")).toBe(viewport);
      expect(oldDispose).toHaveBeenCalledTimes(1);
      expect(engine.getSort()).toEqual({ column: "score", direction: "desc" });
      expect(engine.getFilters()).toHaveLength(1);
      expect(engine.getState()).toMatchObject({ filteredCount: 1, totalCount: 2 });
      expect(container.textContent).toContain("Person 1");
      expect(container.textContent).not.toContain("Person 0");
    });

    it("replaceData keeps only sort and filters whose key and type survive", async () => {
      await flushRAF();
      engine.setSort("score", "desc");
      engine.setFilter(1, { kind: "set", values: new Set(["Person 1"]) });
      engine.setFilter(2, { kind: "range", min: 0, max: 50 });
      await flushRAF();

      const [idColumn, nameColumn, , activeColumn] = makeColumns();
      const nextData = makeTableDataWithColumns(
        [
          [1, "Person 1", true],
          [2, "Other", false],
        ],
        [idColumn, nameColumn, activeColumn],
      );
      engine.replaceData(nextData);
      await flushRAF();

      expect(engine.getSort()).toBeNull();
      expect(engine.getFilters()).toEqual([
        { column: "name", filter: { kind: "set", values: new Set(["Person 1"]) } },
      ]);
      expect(engine.getState()).toMatchObject({ filteredCount: 1, totalCount: 2 });
      const labels = Array.from(container.querySelectorAll(".sift-th-label")).map(
        (label) => label.textContent,
      );
      expect(labels).toEqual(["ID", "Name", "Active"]);
    });

    it("replaceData drops sort and filters for columns whose type changes", async () => {
      await flushRAF();
      engine.setSort("score", "desc");
      engine.setFilter(2, { kind: "range", min: 0, max: 50 });
      await flushRAF();

      const [idColumn, nameColumn, scoreColumn, activeColumn] = makeColumns();
      const categoricalScore = {
        ...scoreColumn,
        numeric: false,
        columnType: "categorical" as const,
      };
      const nextData = makeTableDataWithColumns(
        [
          [1, "Person 1", "low", true],
          [2, "Person 2", "high", false],
        ],
        [idColumn, nameColumn, categoricalScore, activeColumn],
      );
      engine.replaceData(nextData);
      await flushRAF();

      expect(engine.getSort()).toBeNull();
      expect(engine.getFilters()).toEqual([]);
      expect(engine.getState()).toMatchObject({ filteredCount: 2, totalCount: 2 });
    });

    it("replaceData clears cached cells and renders values from the new data", async () => {
      const firstRows = [
        [1, "Alice", 10, true],
        [2, "Bob", 20, false],
      ];
      const secondRows = [
        [1, "Carol", 30, true],
        [2, "Dave", 40, false],
      ];
      const cacheContainer = document.createElement("div");
      document.body.appendChild(cacheContainer);
      const cacheEngine = createTable(cacheContainer, makeTableData(firstRows));
      const viewport = cacheContainer.querySelector<HTMLElement>(".sift-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 400, configurable: true });
      viewport.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(20);
      expect(cacheContainer.textContent).toContain("Alice");

      cacheEngine.replaceData(makeTableData(secondRows));
      await vi.advanceTimersByTimeAsync(20);

      expect(cacheContainer.textContent).toContain("Carol");
      expect(cacheContainer.textContent).not.toContain("Alice");
      cacheEngine.destroy();
      cacheContainer.remove();
    });
  });

  describe("sort + filter combined", () => {
    it("sort persists through filter application", async () => {
      await flushRAF();
      engine.setSort("score", "desc");
      await flushRAF();
      engine.setFilter(3, { kind: "boolean", value: true });
      await flushRAF();
      expect(engine.getSort()).toEqual({ column: "score", direction: "desc" });
      expect(engine.getFilters()).toHaveLength(1);
    });

    it("filter persists through sort change", async () => {
      await flushRAF();
      engine.setFilter(2, { kind: "range", min: 0, max: 50 });
      await flushRAF();
      engine.setSort("name", "asc");
      await flushRAF();
      expect(engine.getFilters()).toHaveLength(1);
      expect(engine.getSort()).toEqual({ column: "name", direction: "asc" });
    });

    it("clearAllFilters preserves sort", async () => {
      await flushRAF();
      engine.setSort("id", "asc");
      engine.setFilter(2, { kind: "range", min: 10, max: 50 });
      await flushRAF();
      engine.clearAllFilters();
      await flushRAF();
      expect(engine.getSort()).toEqual({ column: "id", direction: "asc" });
      expect(engine.getFilters()).toEqual([]);
    });
  });

  describe("accessibility", () => {
    it('container has role="grid" and is focusable', async () => {
      await flushRAF();
      expect(container.getAttribute("role")).toBe("grid");
      expect(container.tabIndex).toBe(0);
    });

    it('header cells have role="columnheader"', async () => {
      await flushRAF();
      const headers = container.querySelectorAll(".sift-th");
      expect(headers.length).toBe(4);
      for (const h of headers) {
        expect(h.getAttribute("role")).toBe("columnheader");
      }
    });

    it("sorted column gets aria-sort attribute", async () => {
      await flushRAF();
      engine.setSort("name", "asc");
      await flushRAF();
      const headers = container.querySelectorAll(".sift-th");
      expect(headers[1].getAttribute("aria-sort")).toBe("ascending");
      expect(headers[0].hasAttribute("aria-sort")).toBe(false);
    });
  });

  describe("onBatchAppended", () => {
    it("updates row count when data grows", async () => {
      await flushRAF();
      // Add 10 more rows
      for (let i = 50; i < 60; i++) {
        rows.push([i + 1, `Person ${i}`, Math.round(Math.random() * 100), i % 3 !== 0]);
      }
      data.rowCount = 60;
      engine.onBatchAppended();
      await flushRAF();
      const stats = container.querySelector(".sift-stat-rows") as HTMLElement;
      expect(stats?.dataset.value).toContain("60");
    });

    it("preserves visible image-cell <img> elements when appended rows do not change them", async () => {
      engine.destroy();
      container.innerHTML = "";

      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const columns: Column[] = [
        {
          key: "id",
          label: "ID",
          width: 80,
          sortable: true,
          numeric: true,
          columnType: "numeric",
        },
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
        [1, [pngBytes]],
        [2, [pngBytes]],
      ];
      const imageData: TableData = {
        columns,
        rowCount: imageRows.length,
        getCell: (r, c) => String(imageRows[r][c] ?? ""),
        getCellRaw: (r, c) => imageRows[r][c],
        columnSummaries: columns.map(() => null),
      };

      engine = createTable(container, imageData);
      const viewport = container.querySelector<HTMLElement>(".sift-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 800, configurable: true });
      viewport.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(20);

      const beforeImg = container.querySelector<HTMLImageElement>(
        '[aria-rowindex="2"] .sift-cell-image-thumb',
      );
      expect(beforeImg).not.toBeNull();
      const beforeBlobUrl = beforeImg!.dataset.siftBlobUrl;
      expect(beforeBlobUrl).toBeDefined();

      imageRows.push([3, [pngBytes]]);
      imageData.rowCount = imageRows.length;
      engine.onBatchAppended();
      await vi.advanceTimersByTimeAsync(20);

      const afterImg = container.querySelector<HTMLImageElement>(
        '[aria-rowindex="2"] .sift-cell-image-thumb',
      );
      expect(afterImg).toBe(beforeImg);
      expect(afterImg!.dataset.siftBlobUrl).toBe(beforeBlobUrl);

      const stats = container.querySelector(".sift-stat-rows") as HTMLElement;
      expect(stats?.dataset.value).toContain("3");
    });
  });

  describe("edge cases", () => {
    it("single-row dataset mounts without crashing", async () => {
      const singleContainer = document.createElement("div");
      document.body.appendChild(singleContainer);
      const singleData = makeTableData([[1, "Solo", 42, true]]);
      const singleEngine = createTable(singleContainer, singleData);
      await flushRAF();
      // Engine mounts: header + stats bar + viewport exist
      expect(singleContainer.querySelector(".sift-header")).not.toBeNull();
      expect(singleContainer.querySelector(".sift-viewport")).not.toBeNull();
      const stats = singleContainer.querySelector(".sift-stat-rows") as HTMLElement;
      expect(stats?.dataset.value).toContain("1");
      singleEngine.destroy();
    });

    it("filter to zero results shows empty state", async () => {
      await flushRAF();
      engine.setFilter(2, { kind: "range", min: 999, max: 1000 });
      await flushRAF();
      const stats = container.querySelector(".sift-stat-rows") as HTMLElement;
      expect(stats?.dataset.value).toContain("0 of");
    });

    it("filter with single-value range (min === max)", async () => {
      await flushRAF();
      const targetScore = rows[0][2] as number;
      engine.setFilter(2, {
        kind: "range",
        min: targetScore,
        max: targetScore,
      });
      await flushRAF();
      const pills = container.querySelectorAll(".sift-filter-pill");
      expect(pills.length).toBe(1);
      // Single-value pill should NOT show range dash
      expect(pills[0].textContent).not.toContain("–");
    });

    it("set filter with empty set filters to zero", async () => {
      await flushRAF();
      engine.setFilter(1, { kind: "set", values: new Set() });
      await flushRAF();
      const stats = container.querySelector(".sift-stat-rows") as HTMLElement;
      expect(stats?.dataset.value).toContain("0 of");
    });

    it("null/NaN/Infinity values in data do not crash engine", async () => {
      const nullContainer = document.createElement("div");
      document.body.appendChild(nullContainer);
      const nullRows: unknown[][] = [
        [1, "Alice", null, true],
        [2, null, 50, false],
        [null, "Bob", NaN, null],
        [4, "Carol", Infinity, true],
        [5, "Dave", -Infinity, false],
      ];
      const nullData = makeTableData(nullRows);
      const nullEngine = createTable(nullContainer, nullData);
      await flushRAF();
      // Engine mounts without throwing
      expect(nullContainer.querySelector(".sift-header")).not.toBeNull();
      expect(nullContainer.querySelector(".sift-viewport")).not.toBeNull();
      nullEngine.destroy();
    });

    it("clearAllFilters restores full count after multiple filters", async () => {
      await flushRAF();
      engine.setFilter(1, { kind: "set", values: new Set(["Person 0"]) });
      engine.setFilter(2, { kind: "range", min: 0, max: 50 });
      engine.setFilter(3, { kind: "boolean", value: true });
      await flushRAF();
      const stats = container.querySelector(".sift-stat-rows") as HTMLElement;
      expect(stats?.dataset.value).toContain("of");

      engine.clearAllFilters();
      await flushRAF();
      expect(stats?.dataset.value).not.toContain("of");
      expect(stats?.dataset.value).toContain("50");
    });
  });

  describe("column resize", () => {
    it("last column has a resize handle", async () => {
      await flushRAF();
      const headerCells = container.querySelectorAll(".sift-th");
      expect(headerCells).toHaveLength(4);
      const lastHandle = headerCells[headerCells.length - 1].querySelector(".sift-resize-handle");
      expect(lastHandle).not.toBeNull();
    });

    it("grows last column to fill when viewport reports width wider than columns", async () => {
      const wide = document.createElement("div");
      document.body.appendChild(wide);
      const e = createTable(wide, makeTableData(makeRows(10)));
      await flushRAF();
      const viewport = wide.querySelector<HTMLElement>(".sift-viewport")!;
      // jsdom reports clientWidth as 0; stub it to simulate a wide container
      // and fire a resize event to trigger fitLastColumnToViewport().
      Object.defineProperty(viewport, "clientWidth", { value: 1600, configurable: true });
      window.dispatchEvent(new Event("resize"));
      await flushRAF();
      const headers = wide.querySelectorAll<HTMLElement>(".sift-th");
      const total = Array.from(headers).reduce(
        (s, h) => s + Number.parseFloat(h.style.width || "0"),
        0,
      );
      expect(total).toBeGreaterThanOrEqual(1600 - 2);
      e.destroy();
      wide.remove();
    });

    it("does not shrink the last column when the table is wider than the viewport", async () => {
      const narrow = document.createElement("div");
      document.body.appendChild(narrow);
      const e = createTable(narrow, makeTableData(makeRows(10)));
      await flushRAF();

      const viewport = narrow.querySelector<HTMLElement>(".sift-viewport")!;
      const headers = narrow.querySelectorAll<HTMLElement>(".sift-th");
      const last = headers[headers.length - 1];
      const initialLastWidth = Number.parseFloat(last.style.width || "0");

      Object.defineProperty(viewport, "clientWidth", { value: 300, configurable: true });
      window.dispatchEvent(new Event("resize"));
      await flushRAF();

      expect(Number.parseFloat(last.style.width || "0")).toBe(initialLastWidth);
      e.destroy();
      narrow.remove();
    });

    it("keeps the top visible row anchored while resized text changes row heights", async () => {
      engine.destroy();
      container.innerHTML = "";

      vi.mocked(prepare).mockImplementation(
        (text: string) =>
          ({ __brand: "PreparedText", text }) as unknown as ReturnType<typeof prepare>,
      );
      vi.mocked(layout).mockImplementation((prepared: unknown, width: number) => {
        const { text } = prepared as { text?: string };
        const tall = text?.includes("wrap-sensitive above viewport") && width < 500;
        return {
          // lineCount stays at MAX_COLLAPSED_LINES so the row-collapse path
          // doesn't clamp this fixture's height back to the cap.
          lineCount: tall ? 3 : 1,
          height: tall ? 120 : 20,
        } as ReturnType<typeof layout>;
      });

      const resizeRows = makeRows(50);
      resizeRows[0][1] = "wrap-sensitive above viewport";
      engine = createTable(container, makeTableData(resizeRows));
      await vi.advanceTimersByTimeAsync(20);

      const viewport = container.querySelector<HTMLElement>(".sift-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 400, configurable: true });

      viewport.scrollTop = 280;
      viewport.dispatchEvent(new Event("scroll"));
      await flushRAF();

      const nameHandle = container
        .querySelectorAll<HTMLElement>(".sift-th")[1]
        .querySelector<HTMLElement>(".sift-resize-handle")!;
      Object.defineProperty(nameHandle, "setPointerCapture", {
        value: vi.fn(),
        configurable: true,
      });

      nameHandle.dispatchEvent(pointerEvent("pointerdown", 0));
      nameHandle.dispatchEvent(pointerEvent("pointermove", 400));
      await vi.advanceTimersByTimeAsync(20);

      expect(viewport.scrollTop).toBe(280);

      nameHandle.dispatchEvent(pointerEvent("pointerup", 400));
      await vi.advanceTimersByTimeAsync(20);

      expect(viewport.scrollTop).toBe(180);
    });

    it("anchors resize to the actual top rendered row before falling back to model offsets", async () => {
      engine.destroy();
      container.innerHTML = "";

      vi.mocked(prepare).mockImplementation(
        (text: string) =>
          ({ __brand: "PreparedText", text }) as unknown as ReturnType<typeof prepare>,
      );
      vi.mocked(layout).mockImplementation((prepared: unknown, width: number) => {
        const { text } = prepared as { text?: string };
        const tall = text?.includes("wrap-sensitive above viewport") && width < 500;
        return {
          // lineCount stays at MAX_COLLAPSED_LINES so the row-collapse path
          // doesn't clamp this fixture's height back to the cap.
          lineCount: tall ? 3 : 1,
          height: tall ? 120 : 20,
        } as ReturnType<typeof layout>;
      });

      const resizeRows = makeRows(50);
      resizeRows[0][1] = "wrap-sensitive above viewport";
      engine = createTable(container, makeTableData(resizeRows));
      await vi.advanceTimersByTimeAsync(20);

      const viewport = container.querySelector<HTMLElement>(".sift-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 400, configurable: true });
      Object.defineProperty(viewport, "getBoundingClientRect", {
        value: () => rect(100, 400),
        configurable: true,
      });

      viewport.scrollTop = 280;
      viewport.dispatchEvent(new Event("scroll"));
      await flushRAF();

      const actualTopRow = container.querySelector<HTMLElement>('[aria-rowindex="9"]')!;
      Object.defineProperty(actualTopRow, "getBoundingClientRect", {
        value: () => rect(100, 36),
        configurable: true,
      });

      const nameHandle = container
        .querySelectorAll<HTMLElement>(".sift-th")[1]
        .querySelector<HTMLElement>(".sift-resize-handle")!;
      Object.defineProperty(nameHandle, "setPointerCapture", {
        value: vi.fn(),
        configurable: true,
      });

      nameHandle.dispatchEvent(pointerEvent("pointerdown", 0));
      nameHandle.dispatchEvent(pointerEvent("pointermove", 400));
      nameHandle.dispatchEvent(pointerEvent("pointerup", 400));
      await vi.advanceTimersByTimeAsync(20);

      expect(viewport.scrollTop).toBe(252);
    });
  });

  describe("scaled virtual scroll for tall tables", () => {
    // jsdom doesn't enforce a max element height. measureMaxElementHeight
    // converges to lo=1 in jsdom (probe.offsetHeight is always 0) and the
    // table.ts floor clamps the cached cap to 1,000,000 px. These tests
    // exercise the scaled-scroll path by exceeding that 1M-px effective cap
    // through row count rather than per-row height — only OVERSCAN rows get
    // lazy-prepared into their true heights at viewport=0, so making a few
    // rows tall doesn't move totalHeight much; growing the row count does.
    // At the default 20-px line height + 16-px padding, each unprepared row
    // contributes 36 px to totalHeight, so 30,000 rows is ~1.08M virtual.
    const JSDOM_CAP_PX = 1_000_000;
    const TALL_ROW_COUNT = 30_000;
    const DEFAULT_ROW_PX = 36; // LINE_HEIGHT (20) + CELL_PAD_V (16)

    function recreateEngine(rowCount: number) {
      engine.destroy();
      container.innerHTML = "";
      engine = createTable(container, makeTableData(makeRows(rowCount)));
    }

    it("matches scrollContent height to totalHeight when virtual fits under cap", async () => {
      recreateEngine(50);
      await vi.advanceTimersByTimeAsync(20);

      const scrollContent = container.querySelector<HTMLElement>(".sift-scroll-content")!;
      const heightPx = Number.parseFloat(scrollContent.style.height);
      // 50 rows × 36 = 1800 px, far under the 1M cap. The spacer is exactly
      // totalHeight + headerH; no scaling kicks in.
      expect(heightPx).toBeGreaterThan(50 * 30);
      expect(heightPx).toBeLessThan(10_000);
    });

    it("caps scrollContent height when virtual exceeds measured cap", async () => {
      recreateEngine(TALL_ROW_COUNT);
      await vi.advanceTimersByTimeAsync(20);

      const scrollContent = container.querySelector<HTMLElement>(".sift-scroll-content")!;
      const heightPx = Number.parseFloat(scrollContent.style.height);
      // 30,000 rows × 36 = 1,080,000 px > 1M. Spacer clamps at the measured
      // cap (cap - SCROLL_SPACER_SAFETY_PX of 1024). Allow a tolerance band
      // since headerH adds a few px on top in some render paths.
      expect(heightPx).toBeGreaterThan(JSDOM_CAP_PX - 10_000);
      expect(heightPx).toBeLessThanOrEqual(JSDOM_CAP_PX);
    });

    it("renders rows near the last index when scrolled to viewport bottom", async () => {
      recreateEngine(TALL_ROW_COUNT);
      const viewport = container.querySelector<HTMLElement>(".sift-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 5000, configurable: true });
      await vi.advanceTimersByTimeAsync(20);

      const scrollContent = container.querySelector<HTMLElement>(".sift-scroll-content")!;
      const spacerHeight = Number.parseFloat(scrollContent.style.height);
      viewport.scrollTop = spacerHeight - viewport.clientHeight;
      viewport.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(20);

      // At max scroll, virtualOffset places the visible window at the tail of
      // the virtual range. Pre-fix the bottom reachable row was near
      // row 27,778 (1M / 36) regardless of TALL_ROW_COUNT; post-fix the
      // visible aria-rowindex sits near the end of the 30,000-row table.
      // Walk the rendered rows and take the largest aria-rowindex (header
      // is row 1, so data rows start at 2 and the last data row is 30,001).
      const rowEls = container.querySelectorAll<HTMLElement>("[aria-rowindex]");
      let maxRowIndex = 0;
      for (const el of rowEls) {
        const idx = Number.parseInt(el.getAttribute("aria-rowindex") ?? "0", 10);
        if (idx > maxRowIndex) maxRowIndex = idx;
      }
      expect(maxRowIndex).toBeGreaterThan(29_000);
    });

    it("shrinks scrollContent height back to totalHeight when filter drops below cap", async () => {
      recreateEngine(TALL_ROW_COUNT);
      await vi.advanceTimersByTimeAsync(20);

      const scrollContent = container.querySelector<HTMLElement>(".sift-scroll-content")!;
      expect(Number.parseFloat(scrollContent.style.height)).toBeGreaterThan(JSDOM_CAP_PX - 10_000);

      // Apply a numeric range filter that matches no rows. Score is in [0,100]
      // by construction in makeRows, so [999,1000] guarantees filteredCount=0.
      engine.setFilter(2, { kind: "range", min: 999, max: 1000 });
      await vi.advanceTimersByTimeAsync(20);

      const filteredHeight = Number.parseFloat(scrollContent.style.height);
      // With filteredCount=0, totalHeight is 0 and the spacer is just headerH.
      expect(filteredHeight).toBeLessThan(DEFAULT_ROW_PX * 10);
    });

    it("syncs scrollContent height when setFocusedDataRow expands a row", async () => {
      // A small table sits under the cap, so spacerHeight tracks totalHeight
      // exactly. Toggling focus grows the focused row's height and the spacer
      // DOM must reflect the new total. Pre-fix, only `render()`'s heightsDirty
      // branch wrote the height, and focus toggling didn't set heightsDirty.
      // Mock pretext to make every categorical cell report 6 lines so the
      // focused row is meaningfully taller than the unfocused one (same trick
      // as the truncation test above).
      vi.mocked(prepare).mockImplementation(
        (text: string) =>
          ({ __brand: "PreparedText", text }) as unknown as ReturnType<typeof prepare>,
      );
      vi.mocked(layout).mockImplementation(
        () => ({ lineCount: 6, height: 120 }) as ReturnType<typeof layout>,
      );

      recreateEngine(4);
      const viewport = container.querySelector<HTMLElement>(".sift-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 800, configurable: true });
      viewport.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(20);

      const scrollContent = container.querySelector<HTMLElement>(".sift-scroll-content")!;
      const before = Number.parseFloat(scrollContent.style.height);

      engine.setFocusedDataRow(1);
      await vi.advanceTimersByTimeAsync(20);

      const after = Number.parseFloat(scrollContent.style.height);
      expect(after).toBeGreaterThan(before);

      resetPretextMocks();
    });

    it("recomputes scroll geometry when the viewport resizes", async () => {
      // Shrinking the viewport with virtualTotal > cap changes renderedRange
      // (spacerHeight - clientHeight), which changes scrollScale. We can't
      // observe scrollScale directly, but a 1-px scrollTop should land at a
      // proportionally different virtual position after the viewport shrinks,
      // and the row pool should rerender accordingly.
      recreateEngine(TALL_ROW_COUNT);
      const viewport = container.querySelector<HTMLElement>(".sift-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 600, configurable: true });
      await vi.advanceTimersByTimeAsync(20);

      // Snapshot the rendered row index at half scroll with the tall viewport.
      const scrollContent = container.querySelector<HTMLElement>(".sift-scroll-content")!;
      const spacerHeight = Number.parseFloat(scrollContent.style.height);
      viewport.scrollTop = Math.floor((spacerHeight - 600) / 2);
      viewport.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(20);

      const beforeIndex = topVisibleAriaRowIndex(container);

      // Shrink the viewport — ResizeObserver should fire and recompute scale.
      Object.defineProperty(viewport, "clientHeight", { value: 200, configurable: true });
      // jsdom doesn't drive ResizeObserver automatically; call the recompute
      // path the observer would call so the test exercises the geometry update.
      viewport.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(20);

      const afterIndex = topVisibleAriaRowIndex(container);
      // The virtual position should still resolve to roughly the same data
      // row neighborhood — the affine map has been refreshed against the new
      // renderedRange. Tolerance is generous because a small viewport change
      // doesn't shift the row much, but the test catches the case where
      // scrollScale was stale (the row would be in a wildly different range).
      expect(Math.abs(afterIndex - beforeIndex)).toBeLessThan(TALL_ROW_COUNT / 4);
    });

    it("advances by one row per ArrowDown even at scrollScale > 1", async () => {
      recreateEngine(TALL_ROW_COUNT);
      const viewport = container.querySelector<HTMLElement>(".sift-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 600, configurable: true });
      await vi.advanceTimersByTimeAsync(20);

      // Park near the top so ArrowDown's effect is observable as a small
      // scrollTop delta rather than getting clipped to scrollHeight.
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(20);

      const before = viewport.scrollTop;
      container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await vi.advanceTimersByTimeAsync(20);

      const delta = viewport.scrollTop - before;
      // Pre-fix, ArrowDown set scrollTop += LINE_HEIGHT + CELL_PAD_V (36 px),
      // skipping scrollScale virtual rows per press. Post-fix, the delta is
      // 36 / scrollScale, so it's strictly less than a full unscaled row.
      // At 30,000 rows × 36 px = 1.08M virtual against the 1M cap, scrollScale
      // is ≈ 1.08 and the delta should be close to 33 px.
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThan(DEFAULT_ROW_PX);
    });
  });
});

function topVisibleAriaRowIndex(container: HTMLElement): number {
  const rowEls = container.querySelectorAll<HTMLElement>("[aria-rowindex]");
  let minRowIndex = Number.MAX_SAFE_INTEGER;
  for (const el of rowEls) {
    const idx = Number.parseInt(el.getAttribute("aria-rowindex") ?? "0", 10);
    if (idx > 1 && idx < minRowIndex) minRowIndex = idx;
  }
  return minRowIndex === Number.MAX_SAFE_INTEGER ? 0 : minRowIndex;
}
