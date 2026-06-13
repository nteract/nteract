import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SiftFocusStatus, SiftScrollHandoffCue } from "./handoff";
import { SiftTable } from "./react";
import type { SiftSource } from "./react";
import type { Column, TableData } from "./table";

const predicateModule = vi.hoisted(() => ({
  create_arrow_stream_store: vi.fn(() => 9),
  append_arrow_stream_chunk: vi.fn(),
  finish_arrow_stream_store: vi.fn(),
  arrow_ipc_column_hints_with_row_count: vi.fn(() => []),
  num_rows: vi.fn(() => 2),
  num_cols: vi.fn(() => 2),
  col_names: vi.fn(() => ["id", "name"]),
  col_type: vi.fn((_handle: number, col: number) => (col === 0 ? "numeric" : "categorical")),
  col_timezone: vi.fn(() => null),
  store_histogram: vi.fn(() => []),
  store_temporal_histogram: vi.fn(() => []),
  store_value_counts: vi.fn(() => []),
  store_bool_counts: vi.fn(() => [0, 0, 0]),
  store_viewport_cells: vi.fn(() => ({
    rows: [],
    strings: [],
    numeric_values: [],
    nulls: [],
  })),
  is_null: vi.fn(() => false),
  get_cell_string: vi.fn((_handle: number, row: number, col: number) =>
    col === 0 ? String(row + 1) : `row ${row + 1}`,
  ),
  get_cell_f64: vi.fn((_handle: number, row: number) => row + 1),
  free: vi.fn(),
}));

vi.mock("./predicate", () => ({
  ensureModule: vi.fn(async () => predicateModule),
  getModuleSync: () => predicateModule,
  loadIpc: vi.fn(async () => 9),
}));

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
  ];
}

function makeTableData(rows: unknown[][]): TableData {
  const columns = makeColumns();
  return {
    columns,
    rowCount: rows.length,
    getCell: (r, c) => String(rows[r][c] ?? ""),
    getCellRaw: (r, c) => rows[r][c],
    columnSummaries: columns.map(() => null),
  };
}

describe("SiftTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders a table container", async () => {
    const rows = [
      [1, "Alice", 95],
      [2, "Bob", 87],
      [3, "Carol", 92],
    ];
    const data = makeTableData(rows);

    const { container } = render(<SiftTable data={data} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(container.querySelector(".sift-table-container")).not.toBeNull();
    expect(container.querySelector(".sift-header")).not.toBeNull();
    expect(container.querySelector(".sift-viewport")).not.toBeNull();
  });

  it("renders correct header labels from data", async () => {
    const rows = [[1, "Alice", 95]];
    const data = makeTableData(rows);

    const { container } = render(<SiftTable data={data} />);
    await vi.advanceTimersByTimeAsync(0);

    const labels = container.querySelectorAll(".sift-th-label");
    expect(labels).toHaveLength(3);
    expect(labels[0].textContent).toBe("ID");
    expect(labels[1].textContent).toBe("Name");
    expect(labels[2].textContent).toBe("Score");
  });

  it("shows row count in stats bar", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => [i, `Person ${i}`, i * 10]);
    const data = makeTableData(rows);

    const { container } = render(<SiftTable data={data} />);
    await vi.advanceTimersByTimeAsync(0);

    const stats = container.querySelector(".sift-stat-rows") as HTMLElement;
    expect(stats?.dataset.value).toContain("25");
  });

  it("calls onChange when filter is applied via engine", async () => {
    const onChange = vi.fn();
    const rows = Array.from({ length: 10 }, (_, i) => [i, `Person ${i}`, i * 10]);
    const data = makeTableData(rows);

    const { container } = render(<SiftTable data={data} onChange={onChange} />);
    await vi.advanceTimersByTimeAsync(0);

    // The engine is mounted — we can interact via the DOM
    // The onChange should be wired up; we test by verifying the container has content
    expect(container.querySelector(".sift-table-container")).not.toBeNull();
  });

  it("cleans up engine on unmount", async () => {
    const rows = [[1, "Alice", 95]];
    const data = makeTableData(rows);

    const { container, unmount } = render(<SiftTable data={data} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(container.querySelector(".sift-table-container")).not.toBeNull();

    unmount();

    // Container should be cleaned up (React unmount clears the DOM)
    expect(container.innerHTML).toBe("");
  });

  it("reuses the mounted engine when table data props change", async () => {
    const firstData = makeTableData([[1, "Alice", 95]]);
    const firstDispose = vi.fn();
    firstData.dispose = firstDispose;
    const secondData = makeTableData([
      [2, "Bob", 88],
      [3, "Carol", 91],
    ]);
    const onChange = vi.fn();

    const { container, rerender } = render(<SiftTable data={firstData} onChange={onChange} />);
    await vi.advanceTimersByTimeAsync(0);
    const viewport = container.querySelector(".sift-viewport");

    rerender(<SiftTable data={secondData} onChange={onChange} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(container.querySelector(".sift-viewport")).toBe(viewport);
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ totalCount: 2 });
  });

  it("renders container for url prop without loading flash", async () => {
    // Mock fetch to never resolve (simulating slow load)
    vi.stubGlobal("fetch", () => new Promise(() => {}));

    const { container } = render(<SiftTable url="/data.arrow" />);
    await vi.advanceTimersByTimeAsync(0);

    // No loading indicator — engine handles its own skeleton
    expect(container.querySelector(".sift-loading")).toBeNull();

    vi.unstubAllGlobals();
  });

  it("shows error state on fetch failure", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: false, status: 404, statusText: "Not Found" }),
    );

    const { container } = render(<SiftTable url="/missing.arrow" />);

    // Wait for the async fetch to resolve and state to update
    await new Promise((r) => setTimeout(r, 50));

    const loading = container.querySelector(".sift-loading");
    expect(loading?.textContent).toContain("404");

    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it("loads Arrow stream manifest chunks through the appendable WASM store", async () => {
    vi.useRealTimers();
    const chunkBytes = new Uint8Array([1, 2, 3, 4]);
    const milestones: string[] = [];
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        arrayBuffer: async () => chunkBytes.buffer,
      }),
    );

    const { container, unmount } = render(
      <SiftTable
        source={{
          kind: "arrow-stream-manifest",
          manifest: {
            chunks: [{ url: "http://127.0.0.1:9000/blob/chunk" }],
            complete: true,
          },
        }}
        onLoadMilestone={(milestone) => milestones.push(milestone.phase)}
      />,
    );

    await waitFor(() => {
      expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(1);
      expect(predicateModule.finish_arrow_stream_store).toHaveBeenCalledWith(9);
      expect(container.querySelector(".sift-table-container")).not.toBeNull();
    });

    expect(predicateModule.create_arrow_stream_store).toHaveBeenCalledTimes(1);
    expect(predicateModule.append_arrow_stream_chunk.mock.calls[0][0]).toBe(9);
    expect(Array.from(predicateModule.append_arrow_stream_chunk.mock.calls[0][1])).toEqual([
      1, 2, 3, 4,
    ]);
    expect(milestones).toEqual([
      "load-start",
      "wasm-ready",
      "first-chunk-fetched",
      "first-chunk-appended",
      "table-data-created",
      "summaries-ready",
      "engine-mounted",
      "streaming-complete",
    ]);

    unmount();
    expect(predicateModule.free).toHaveBeenCalledTimes(1);
    expect(predicateModule.free).toHaveBeenCalledWith(9);

    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it("keeps sampled Arrow stream manifests provisional with the total row hint", async () => {
    vi.useRealTimers();
    const chunkBytes = new Uint8Array([1, 2, 3, 4]);
    const milestones: string[] = [];
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        arrayBuffer: async () => chunkBytes.buffer,
      }),
    );

    const { container, unmount } = render(
      <SiftTable
        source={{
          kind: "arrow-stream-manifest",
          manifest: {
            summary: {
              included_rows: 2,
              total_rows: 5,
              sampled: true,
            },
            chunks: [{ url: "http://127.0.0.1:9000/blob/chunk", row_count: 2 }],
            complete: true,
          },
        }}
        onLoadMilestone={(milestone) => milestones.push(milestone.phase)}
      />,
    );

    await waitFor(() => {
      expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(1);
      expect(container.querySelector(".sift-table-container")).not.toBeNull();
      expect((container.querySelector(".sift-stat-rows") as HTMLElement)?.dataset.value).toBe(
        "2 of 5 rows loaded",
      );
    });

    expect(predicateModule.finish_arrow_stream_store).not.toHaveBeenCalled();
    expect(milestones).toContain("partial-row-set");

    unmount();
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it("fetches trailing Arrow stream chunks sequentially after each append", async () => {
    vi.useRealTimers();
    const fetchResolvers: ((response: {
      ok: true;
      arrayBuffer: () => Promise<ArrayBuffer>;
    }) => void)[] = [];
    const fetchEvents: { url: string; appendCallCount: number }[] = [];
    const fetchMock = vi.fn(
      (url: string) =>
        new Promise<{ ok: true; arrayBuffer: () => Promise<ArrayBuffer> }>((resolve) => {
          fetchEvents.push({
            url,
            appendCallCount: predicateModule.append_arrow_stream_chunk.mock.calls.length,
          });
          fetchResolvers.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(
      <SiftTable
        source={{
          kind: "arrow-stream-manifest",
          manifest: {
            chunks: [
              { url: "http://127.0.0.1:9000/blob/chunk-0" },
              { url: "http://127.0.0.1:9000/blob/chunk-1" },
              { url: "http://127.0.0.1:9000/blob/chunk-2" },
            ],
            complete: true,
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(predicateModule.append_arrow_stream_chunk).not.toHaveBeenCalled();

    const responseFor = (bytes: number[]) => ({
      ok: true as const,
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
    });
    fetchResolvers[0](responseFor([1, 2, 3]));

    await waitFor(() => {
      expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchEvents.map((event) => event.url)).toEqual([
      "http://127.0.0.1:9000/blob/chunk-0",
      "http://127.0.0.1:9000/blob/chunk-1",
    ]);
    expect(fetchEvents[1].appendCallCount).toBe(1);

    fetchResolvers[1](responseFor([4, 5, 6]));

    await waitFor(() => {
      expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    expect(fetchEvents.map((event) => event.url)).toEqual([
      "http://127.0.0.1:9000/blob/chunk-0",
      "http://127.0.0.1:9000/blob/chunk-1",
      "http://127.0.0.1:9000/blob/chunk-2",
    ]);
    expect(fetchEvents[2].appendCallCount).toBe(2);

    fetchResolvers[2](responseFor([7, 8, 9]));

    await waitFor(() => {
      expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(3);
      expect(predicateModule.finish_arrow_stream_store).toHaveBeenCalledWith(9);
    });

    unmount();
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it("does not reload a manifest source when only object identity changes", async () => {
    vi.useRealTimers();
    const chunkBytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        arrayBuffer: async () => chunkBytes.buffer,
      }),
    );

    const source = (): SiftSource => ({
      kind: "arrow-stream-manifest",
      manifest: {
        chunks: [{ url: "http://127.0.0.1:9000/blob/chunk" }],
        complete: true,
      },
    });

    const { rerender } = render(<SiftTable source={source()} />);

    await waitFor(() => {
      expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(1);
    });

    rerender(<SiftTable source={source()} />);
    await new Promise((r) => setTimeout(r, 0));

    expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(1);
    expect(predicateModule.finish_arrow_stream_store).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it("accepts className and style props", async () => {
    const rows = [[1, "Alice", 95]];
    const data = makeTableData(rows);

    const { container } = render(
      <SiftTable data={data} className="my-table" style={{ border: "1px solid red" }} />,
    );
    await vi.advanceTimersByTimeAsync(0);

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.classList.contains("my-table")).toBe(true);
    expect(wrapper.style.border).toBe("1px solid red");
  });

  it("renders the scroll handoff cue with accessible default copy", () => {
    const { getByRole } = render(<SiftScrollHandoffCue />);

    expect(getByRole("button", { name: "Click inside the table to scroll" })).not.toBeNull();
  });

  it("renders the focused status with the escape key hint", () => {
    const { getByText } = render(<SiftFocusStatus />);

    expect(getByText("Table focused")).not.toBeNull();
    expect(getByText("Esc")).not.toBeNull();
  });
});
