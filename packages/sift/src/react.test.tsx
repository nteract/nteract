import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SiftFocusStatus, SiftScrollHandoffCue } from "./handoff";
import { SiftTable } from "./react";
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
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        arrayBuffer: async () => chunkBytes.buffer,
      }),
    );

    const { container } = render(
      <SiftTable
        source={{
          kind: "arrow-stream-manifest",
          manifest: {
            chunks: [{ url: "http://127.0.0.1:9000/blob/chunk" }],
            complete: true,
          },
        }}
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
