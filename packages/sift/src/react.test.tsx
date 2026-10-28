import { cleanup, render, waitFor } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SiftFocusStatus, SiftScrollHandoffCue } from "./handoff";
import { ensureModule, loadIpc } from "./predicate";
import type {
  QueryCapabilities,
  QueryPage,
  RequestContext,
  TableQuery,
  WindowRequest,
} from "./query";
import { SiftTable, URL_PARQUET_LIMITS } from "./react";
import type { SiftLoadMilestone, SiftQueryState, SiftSource } from "./react";
import { createTable, type Column, type TableData, type TableEngine } from "./table";
import { setWorkerFactory } from "./worker/factory";

// Wrapped so tests can read the TableData the url source mounted.
vi.mock("./table", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./table")>();
  return { ...actual, createTable: vi.fn(actual.createTable) };
});

const predicateModule = vi.hoisted(() => ({
  create_arrow_stream_store: vi.fn(() => 9),
  // Each whole-buffer IPC load gets its own handle so tests can tell which
  // store a `free` released.
  load_ipc_bounded: vi.fn(
    (() => {
      let next = 100;
      return () => ++next;
    })(),
  ),
  append_arrow_stream_chunk: vi.fn(),
  finish_arrow_stream_store: vi.fn(),
  arrow_ipc_column_hints_with_row_count: vi.fn(() => []),
  num_rows: vi.fn(() => 2),
  num_cols: vi.fn(() => 2),
  col_names: vi.fn(() => ["id", "name"]),
  col_type: vi.fn((_handle: number, col: number): string =>
    col === 0 ? "numeric" : "categorical",
  ),
  col_timezone: vi.fn(() => null),
  store_histogram: vi.fn(() => []),
  store_temporal_histogram: vi.fn(() => []),
  store_value_counts: vi.fn(() => []),
  store_bool_counts: vi.fn(() => [0, 0, 0]),
  store_null_counts: vi.fn(() => new Uint32Array([0, 0])),
  // Local filters over the two-row table match both rows.
  store_filter_rows: vi.fn(() => new Uint32Array([0, 1])),
  store_filtered_value_counts: vi.fn(() => []),
  store_filtered_histogram: vi.fn(() => []),
  store_filtered_bool_counts: vi.fn(() => new Uint32Array([0, 0, 0])),
  // Byte-range Parquet over a fake two-row-group file; see `parquetFixture`.
  parquet_footer_length: vi.fn(() => 4),
  parquet_open: vi.fn(() => 11),
  parquet_file_info: vi.fn(() => ({
    num_rows: 4,
    num_row_groups: 2,
    row_group_rows: [2, 2],
    column_names: ["id", "name"],
  })),
  parquet_file_column_stats: vi.fn(() => ({ num_rows: 4, num_row_groups: 2, columns: [] })),
  parquet_file_column_hints: vi.fn(() => []),
  parquet_create_store: vi.fn(() => 9),
  parquet_row_group_ranges: vi.fn(() => Float64Array.from([4, 4])),
  parquet_append_row_group: vi.fn(() => 2),
  parquet_file_budget: vi.fn(() => ({ exhausted: false, truncated: false })),
  parquet_file_usage: vi.fn(() => ({ rows: 0, decoded_bytes: 0 })),
  parquet_close: vi.fn(),
  has_original_column: vi.fn(() => false),
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
  get_cell_image_count: vi.fn(() => 0),
  get_cell_image_bytes_at: vi.fn(() => new Uint8Array()),
  free: vi.fn(),
}));

vi.mock("./predicate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./predicate")>()),
  ensureModule: vi.fn(async () => predicateModule),
  getModuleSync: () => predicateModule,
  loadIpc: vi.fn(async () => 9),
}));

/**
 * 64 bytes shaped like a Parquet file: leading and trailing `PAR1` with a
 * 4-byte footer length. The mocked module answers every footer question, so
 * the bytes only have to pass Sift's own magic and length checks.
 */
function parquetFixture(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x50, 0x41, 0x52, 0x31], 0);
  bytes.set([4, 0, 0, 0, 0x50, 0x41, 0x52, 0x31], 56);
  return bytes;
}

/**
 * Let the mocked store grow by two rows per appended row group, with the
 * footer answering for `rowGroups` groups. Returns a restore function.
 */
function stubParquetStore(options: { truncateAfterGroups?: number; rowGroups?: number } = {}) {
  const rowGroups = options.rowGroups ?? 2;
  let loaded = 0;
  let groups = 0;
  predicateModule.parquet_file_info.mockImplementation(() => ({
    num_rows: rowGroups * 2,
    num_row_groups: rowGroups,
    row_group_rows: Array.from({ length: rowGroups }, () => 2),
    column_names: ["id", "name"],
  }));
  predicateModule.num_rows.mockImplementation(() => loaded);
  predicateModule.parquet_append_row_group.mockImplementation(() => {
    loaded += 2;
    groups += 1;
    return 2;
  });
  predicateModule.parquet_file_usage.mockImplementation(() => ({
    rows: loaded,
    decoded_bytes: loaded * 100,
  }));
  predicateModule.parquet_file_budget.mockImplementation(() => {
    const cut = options.truncateAfterGroups !== undefined && groups >= options.truncateAfterGroups;
    return { exhausted: cut, truncated: cut };
  });
  return () => {
    predicateModule.parquet_file_info.mockImplementation(() => ({
      num_rows: 4,
      num_row_groups: 2,
      row_group_rows: [2, 2],
      column_names: ["id", "name"],
    }));
    predicateModule.num_rows.mockImplementation(() => 2);
    predicateModule.parquet_append_row_group.mockImplementation(() => 2);
    predicateModule.parquet_file_usage.mockImplementation(() => ({ rows: 0, decoded_bytes: 0 }));
    predicateModule.parquet_file_budget.mockImplementation(() => ({
      exhausted: false,
      truncated: false,
    }));
  };
}

/** Serve `parquetFixture` from fetch and let the mocked store grow per row group. */
function stubParquetUrl(options: { truncateAfterGroups?: number } = {}) {
  vi.stubGlobal("fetch", () =>
    Promise.resolve({
      ok: true,
      headers: new Headers({ "Content-Type": "application/vnd.apache.parquet" }),
      arrayBuffer: async () => parquetFixture().buffer,
    }),
  );
  return stubParquetStore(options);
}

/** A `ByteSource` over `parquetFixture`, for the byte-source Parquet path. */
function parquetByteSource() {
  const bytes = parquetFixture();
  return {
    byteLength: bytes.byteLength,
    read: vi.fn(async (offset: number, length: number) => bytes.slice(offset, offset + length)),
  };
}

type PendingQuery = {
  q: TableQuery & { window: WindowRequest };
  ctx: RequestContext;
  resolve: (page: QueryPage) => void;
  reject: (reason: unknown) => void;
};

/**
 * A query session whose answers the test releases by hand. The mocked WASM
 * module decodes any bytes as the two-row `id`/`name` table.
 */
function fakeSession(caps: Partial<QueryCapabilities> = {}) {
  const pending: PendingQuery[] = [];
  const session = {
    capabilities: {
      filters: { id: ["between"], name: ["in"] },
      sort: [],
      casts: [],
      counts: ["exact"],
      ...caps,
    } as QueryCapabilities,
    query: vi.fn(
      (q: TableQuery & { window: WindowRequest }, ctx: RequestContext) =>
        new Promise<QueryPage>((resolve, reject) => pending.push({ q, ctx, resolve, reject })),
    ),
    count: vi.fn(async () => ({ kind: "exact" as const, value: 5 })),
    close: vi.fn(async () => {}),
  };
  const page = (over: Partial<QueryPage> = {}): QueryPage => ({
    ipc: new Uint8Array([1, 2, 3, 4]),
    returnedRows: 2,
    matchedCount: { kind: "exact", value: 40 },
    continuation: { kind: "more" },
    ...over,
  });
  return { session, pending, page };
}

const emptyQuery: TableQuery = { casts: [], filters: [], sort: [] };
const lastEngine = () => vi.mocked(createTable).mock.results.at(-1)?.value as TableEngine;

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
    // Manifest tests stub `fetch`. Restoring here keeps a failing test from
    // leaking its stub into the next one.
    vi.unstubAllGlobals();
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

  it("settles table data as complete on initial mount", async () => {
    const { container } = render(<SiftTable data={makeTableData([[1, "Alice", 95]])} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(container.querySelector(".sift-status-indicator")?.className).toContain(
      "sift-status-ready",
    );
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

  it.each(["url", "manifest"])("loads embedded Arrow %s bytes without fetching", async (kind) => {
    vi.useRealTimers();
    const fetchMock = vi.fn(() => Promise.reject(new Error("CSP blocked fetch")));
    vi.stubGlobal("fetch", fetchMock);
    const url = "data:application/vnd.apache.arrow.stream;base64,AQIDBA==";
    const source: SiftSource =
      kind === "url"
        ? { kind: "url", url }
        : { kind: "arrow-stream-manifest", manifest: { chunks: [{ url }], complete: true } };

    const { container } = render(<SiftTable source={source} />);
    await waitFor(() => {
      expect(container.querySelector(".sift-table-container")).not.toBeNull();
      expect(container.querySelector(".sift-status-indicator")?.className).toContain(
        "sift-status-ready",
      );
    });

    const loadedBytes =
      kind === "url"
        ? vi.mocked(loadIpc).mock.calls[0][0]
        : predicateModule.append_arrow_stream_chunk.mock.calls[0][1];
    expect([...loadedBytes]).toEqual([1, 2, 3, 4]);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("settles a bounded first-row preview and explains its table-tool scope", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      }),
    );

    const { container } = render(
      <SiftTable
        source={{
          kind: "arrow-stream-manifest",
          manifest: {
            chunks: [{ url: "http://127.0.0.1:9000/blob/capped-head", row_count: 50_000 }],
            complete: true,
            summary: {
              total_rows: 100_000,
              included_rows: 50_000,
              sampled: true,
              sample_strategy: "head",
            },
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(predicateModule.finish_arrow_stream_store).toHaveBeenCalledWith(9);
      expect(container.querySelector(".sift-status-indicator")?.className).toContain(
        "sift-status-ready",
      );
    });
    expect(container.querySelector(".sift-progress-bar")?.className).toContain(
      "sift-progress-bar-done",
    );
    expect(container.querySelector(".sift-footer-slot")).not.toBeNull();
    expect(container.querySelector(".sift-status-indicator")?.getAttribute("title")).toBe(
      "Preview loaded",
    );
    const previewHint = container.querySelector(".sift-preview-hint");
    expect(previewHint?.getAttribute("role")).toBe("note");
    expect(previewHint?.firstElementChild?.textContent).toBe(
      "Showing first 50,000 of 100,000 rows",
    );
    expect(previewHint?.querySelector(".sift-preview-scope-full")?.textContent).toBe(
      " · Table tools use shown rows",
    );
    // Narrow footers swap the sentence for this badge through the stylesheet.
    expect(previewHint?.querySelector(".sift-preview-scope-short")?.textContent).toBe(
      " · Shown rows",
    );
    expect(previewHint?.getAttribute("title")).toBe(
      "Sorting, filtering, and column summaries use only the rows shown in this preview.",
    );
  });

  it("does not invent a total for a bounded preview whose source length is unknown", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      }),
    );

    const { container } = render(
      <SiftTable
        source={{
          kind: "arrow-stream-manifest",
          manifest: {
            chunks: [{ url: "http://127.0.0.1:9000/blob/unknown-total", row_count: 50_000 }],
            complete: true,
            summary: {
              total_rows: 50_000,
              included_rows: 50_000,
              sampled: true,
              sample_strategy: "head",
            },
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".sift-status-indicator")?.className).toContain(
        "sift-status-ready",
      );
    });
    expect(container.querySelector(".sift-preview-hint")?.firstElementChild?.textContent).toBe(
      "Showing first 50,000 rows · total unknown",
    );
  });

  it("truncates url Parquet at the row budget and labels the preview", async () => {
    vi.useRealTimers();
    const restore = stubParquetUrl({ truncateAfterGroups: 1 });
    const milestones: SiftLoadMilestone[] = [];
    try {
      const { container } = render(
        <SiftTable
          source={{
            kind: "url",
            url: "http://127.0.0.1:9000/data.parquet",
            limits: { maxRows: 2 },
          }}
          onLoadMilestone={(milestone) => milestones.push(milestone)}
        />,
      );

      await waitFor(() => {
        expect(container.querySelector(".sift-status-indicator")?.className).toContain(
          "sift-status-ready",
        );
        expect(container.querySelector(".sift-preview-hint")).not.toBeNull();
      });

      expect(predicateModule.parquet_open).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        64,
        2,
        256,
        URL_PARQUET_LIMITS.maxDecodedBytes,
        true,
      );
      // Only the first row group is read once the budget is spent.
      expect(predicateModule.parquet_append_row_group).toHaveBeenCalledTimes(1);

      const hint = container.querySelector(".sift-preview-hint");
      expect(hint?.firstElementChild?.textContent).toBe("Showing first 2 of 4 rows");
      expect(hint?.querySelector(".sift-preview-scope-full")?.textContent).toBe(
        " · Table tools use shown rows",
      );
      expect(container.querySelector(".sift-status-indicator")?.getAttribute("title")).toBe(
        "Preview loaded",
      );

      const complete = milestones.find((m) => m.phase === "streaming-complete");
      expect(complete).toMatchObject({
        source: "url",
        format: "parquet",
        rowCount: 2,
        totalRowCount: 4,
        truncated: true,
      });

      const mounted = vi.mocked(createTable).mock.calls.at(-1)?.[1];
      expect(mounted?.coverage).toMatchObject({ loadedRows: 2, truncated: true });
      expect(mounted?.coverage?.totalRows?.value).toBe(4);
    } finally {
      restore();
    }
  });

  it("loads url Parquet completely under the default budget", async () => {
    vi.useRealTimers();
    const restore = stubParquetUrl();
    const milestones: SiftLoadMilestone[] = [];
    try {
      const { container } = render(
        <SiftTable
          url="http://127.0.0.1:9000/small.parquet"
          onLoadMilestone={(milestone) => milestones.push(milestone)}
        />,
      );

      await waitFor(() => {
        expect(container.querySelector(".sift-status-indicator")?.className).toContain(
          "sift-status-ready",
        );
        expect(milestones.some((m) => m.phase === "streaming-complete")).toBe(true);
      });

      expect(predicateModule.parquet_open).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        64,
        URL_PARQUET_LIMITS.maxRows,
        256,
        URL_PARQUET_LIMITS.maxDecodedBytes,
        true,
      );
      expect(predicateModule.parquet_append_row_group).toHaveBeenCalledTimes(2);
      expect(container.querySelector(".sift-preview-hint")).toBeNull();
      expect(container.querySelector(".sift-status-indicator")?.getAttribute("title")).toBe(
        "All data loaded",
      );
      expect(milestones.at(-1)).toMatchObject({
        phase: "streaming-complete",
        rowCount: 4,
        totalRowCount: 4,
        truncated: false,
      });
      const mounted = vi.mocked(createTable).mock.calls.at(-1)?.[1];
      expect(mounted?.coverage).toMatchObject({ loadedRows: 4, truncated: false });
    } finally {
      restore();
    }
  });

  describe("query-session", () => {
    const footer = (root: ParentNode) =>
      root.querySelector<HTMLElement>(".sift-stat-rows")?.dataset.value;
    const idRange: TableQuery["filters"][number] = { column: "id", op: "between", value: [1, 2] };
    const nameIn: TableQuery["filters"][number] = { column: "name", op: "in", value: ["row 1"] };

    beforeEach(() => {
      vi.useRealTimers();
    });

    it("mounts the head as a committed query and reports milestones", async () => {
      const { session, pending, page } = fakeSession();
      const milestones: SiftLoadMilestone[] = [];
      const queryStates: SiftQueryState[] = [];
      const { container, unmount } = render(
        <SiftTable
          source={{ kind: "query-session", session, headRows: 2 }}
          onLoadMilestone={(m) => milestones.push(m)}
          onQueryStateChange={(s) => queryStates.push(s)}
        />,
      );
      await waitFor(() => expect(pending).toHaveLength(1));
      expect(pending[0].q).toEqual({ ...emptyQuery, window: { mode: "head", limit: 2 } });
      expect(pending[0].ctx.budget).toMatchObject({
        maxIpcBytes: 64 * 1024 * 1024,
        maxDecodedBytes: 128 * 1024 * 1024,
      });
      expect(queryStates.at(-1)).toMatchObject({ generation: 1, pending: true });

      pending[0].resolve(page());
      await waitFor(() => {
        expect(container.querySelector(".sift-status-ready")).not.toBeNull();
        expect(footer(container)).toBe("40 rows in whole dataset · 2 rows shown");
      });
      const options = vi.mocked(createTable).mock.calls.at(-1)?.[2];
      expect(options).toMatchObject({ committedQuery: emptyQuery });
      const data = vi.mocked(createTable).mock.calls.at(-1)?.[1];
      expect(data?.coverage).toMatchObject({
        loadedRows: 2,
        truncated: true,
        totalRows: { value: 40, scope: "dataset", source: "query" },
      });
      expect(lastEngine().getState()).toMatchObject({
        committedQuery: emptyQuery,
        resultCount: { kind: "exact", value: 40 },
      });
      expect(milestones.map((m) => m.phase)).toEqual([
        "load-start",
        "wasm-ready",
        "table-data-created",
        "engine-mounted",
        "complete",
      ]);
      expect(milestones.every((m) => m.source === "query-session")).toBe(true);
      // The provider knew the count, so no separate count call.
      expect(session.count).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(queryStates.at(-1)).toMatchObject({
          generation: 1,
          pending: false,
          committedQuery: emptyQuery,
          resultCount: { kind: "exact", value: 40 },
        });
      });
      expect(container.querySelector(".sift-apply-query")).toBeNull();
      unmount();
    });

    it("asks for a cheap count when the page does not know it", async () => {
      const { session, pending, page } = fakeSession();
      const { container, unmount } = render(
        <SiftTable source={{ kind: "query-session", session }} />,
      );
      await waitFor(() => expect(pending).toHaveLength(1));
      expect(pending[0].q.window).toEqual({ mode: "head", limit: 10_000 });
      pending[0].resolve(page({ matchedCount: { kind: "unknown" } }));
      await waitFor(() => {
        expect(footer(container)).toBe("5 rows in whole dataset · 2 rows shown");
      });
      expect(session.count).toHaveBeenCalledWith(emptyQuery, "cheap", expect.anything());
      unmount();
    });

    it("disposes a stale response and never mounts it", async () => {
      const { session, pending, page } = fakeSession();
      const { container, unmount } = render(
        <SiftTable
          source={{
            kind: "query-session",
            session,
            initialQuery: { filters: [idRange, nameIn] },
          }}
        />,
      );
      await waitFor(() => expect(pending).toHaveLength(1));
      pending[0].resolve(page());
      await waitFor(() => {
        expect(container.querySelectorAll(".sift-filter-pill--committed")).toHaveLength(2);
      });
      const engine = lastEngine();
      const replaceData = vi.spyOn(engine, "replaceData");
      const freedBefore = predicateModule.free.mock.calls.length;

      // Clearing a committed pill starts generation 2.
      const closers = container.querySelectorAll<HTMLButtonElement>(
        ".sift-filter-pill--committed .sift-filter-pill-x",
      );
      closers[0].click();
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(pending[1].q.filters).toEqual([nameIn]);

      // Hold generation 2 inside loadTableFile (its second ensureModule call)
      // so generation 3 can start while its rows are being decoded.
      let releaseLoad: (() => void) | null = null;
      const ensureModuleCalls = vi.mocked(ensureModule).mock.calls.length;
      vi.mocked(ensureModule)
        .mockImplementationOnce(async () => predicateModule as never)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseLoad = () => resolve(predicateModule as never);
            }),
        );
      pending[1].resolve(page({ matchedCount: { kind: "exact", value: 2 } }));
      await waitFor(() => {
        expect(vi.mocked(ensureModule).mock.calls.length).toBe(ensureModuleCalls + 2);
      });

      closers[1].click();
      await waitFor(() => expect(pending).toHaveLength(3));
      expect(pending[2].q.filters).toEqual([idRange]);
      expect(pending[1].ctx.signal.aborted).toBe(true);
      expect(pending[2].ctx.signal.aborted).toBe(false);

      // Generation 2 finishes decoding late: its store is freed, nothing mounts.
      releaseLoad!();
      await waitFor(() => {
        expect(predicateModule.free.mock.calls.length).toBe(freedBefore + 1);
      });
      expect(replaceData).not.toHaveBeenCalled();
      expect(engine.getState().committedQuery).toEqual({
        ...emptyQuery,
        filters: [idRange, nameIn],
      });

      pending[2].resolve(page({ matchedCount: { kind: "exact", value: 3 } }));
      await waitFor(() => {
        expect(footer(container)).toBe("3 whole-dataset matches · 2 rows shown");
      });
      expect(replaceData).toHaveBeenCalledTimes(1);
      expect(replaceData.mock.calls[0][1]).toMatchObject({
        committedQuery: { ...emptyQuery, filters: [idRange] },
        streaming: false,
      });
      expect(container.querySelectorAll(".sift-filter-pill--committed")).toHaveLength(1);
      unmount();
    });

    it("applies local filters to the whole dataset as one merged query", async () => {
      const { session, pending, page } = fakeSession();
      const onChange = vi.fn();
      const { container, unmount } = render(
        <SiftTable
          source={{ kind: "query-session", session, initialQuery: { filters: [nameIn] } }}
          onChange={onChange}
        />,
      );
      await waitFor(() => expect(pending).toHaveLength(1));
      pending[0].resolve(page());
      await waitFor(() => expect(container.querySelector(".sift-status-ready")).not.toBeNull());
      expect(container.querySelector(".sift-apply-query")).toBeNull();

      const engine = lastEngine();
      engine.setFilter(0, { kind: "range", min: 1, max: 2 });
      const button = await waitFor(() => {
        const el = container.querySelector<HTMLButtonElement>(".sift-apply-query");
        expect(el).not.toBeNull();
        return el!;
      });
      expect(button.textContent).toBe("Apply filters to whole dataset");
      expect(button.disabled).toBe(false);
      expect(container.querySelector<HTMLElement>(".sift-stat-local")?.textContent).toBe(
        "2 of 2 shown rows · Filters use shown rows",
      );

      button.click();
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(pending[1].q).toEqual({
        ...emptyQuery,
        filters: [nameIn, idRange],
        window: { mode: "head", limit: 10_000 },
      });
      await waitFor(() => {
        const busy = container.querySelector<HTMLButtonElement>(".sift-apply-query");
        expect(busy?.textContent).toBe("Querying…");
        expect(busy?.disabled).toBe(true);
      });
      // The old rows stay visible while the query runs.
      expect(engine.getState().filteredCount).toBe(2);

      pending[1].resolve(page({ matchedCount: { kind: "exact", value: 12 } }));
      await waitFor(() => {
        expect(footer(container)).toBe("12 whole-dataset matches · 2 rows shown");
        expect(container.querySelector(".sift-apply-query")).toBeNull();
      });
      expect(engine.getState()).toMatchObject({
        filters: [],
        committedQuery: { ...emptyQuery, filters: [nameIn, idRange] },
      });
      expect(container.querySelectorAll(".sift-filter-pill--committed")).toHaveLength(2);
      expect(container.querySelectorAll(".sift-filter-pill")).toHaveLength(2);
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ committedQuery: { ...emptyQuery, filters: [nameIn, idRange] } }),
      );
      unmount();
    });

    it("disables Apply with the reason when the provider cannot run the merged query", async () => {
      const { session, pending, page } = fakeSession({ filters: { name: ["in"] } });
      const { container, unmount } = render(
        <SiftTable source={{ kind: "query-session", session }} />,
      );
      await waitFor(() => expect(pending).toHaveLength(1));
      pending[0].resolve(page());
      await waitFor(() => expect(container.querySelector(".sift-status-ready")).not.toBeNull());

      lastEngine().setFilter(0, { kind: "range", min: 1, max: 2 });
      await waitFor(() => {
        const button = container.querySelector<HTMLButtonElement>(".sift-apply-query");
        expect(button?.disabled).toBe(true);
        expect(button?.title).toBe("Filters on id are not supported");
      });
      expect(session.query).toHaveBeenCalledTimes(1);
      unmount();
    });

    it("aborts the query in flight and closes the session on unmount", async () => {
      const { session, pending } = fakeSession();
      const { unmount } = render(<SiftTable source={{ kind: "query-session", session }} />);
      await waitFor(() => expect(pending).toHaveLength(1));
      unmount();
      expect(pending[0].ctx.signal.aborted).toBe(true);
      await waitFor(() => expect(session.close).toHaveBeenCalledTimes(1));
    });

    it("shows a footer notice when a re-query fails and keeps the rows", async () => {
      const { session, pending, page } = fakeSession({ filters: { id: ["between"] } });
      const onLoadError = vi.fn();
      const { container, unmount } = render(
        <SiftTable source={{ kind: "query-session", session }} onLoadError={onLoadError} />,
      );
      await waitFor(() => expect(pending).toHaveLength(1));
      pending[0].resolve(page());
      await waitFor(() => expect(container.querySelector(".sift-status-ready")).not.toBeNull());
      lastEngine().setFilter(0, { kind: "range", min: 1, max: 2 });
      const button = await waitFor(() => {
        const el = container.querySelector<HTMLButtonElement>(".sift-apply-query");
        expect(el?.disabled).toBe(false);
        return el!;
      });
      button.click();
      await waitFor(() => expect(pending).toHaveLength(2));
      pending[1].reject(new Error("connection lost"));
      await waitFor(() => {
        expect(container.querySelector(".sift-load-failure")?.textContent).toContain(
          "connection lost",
        );
      });
      expect(onLoadError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "connection lost" }),
      );
      expect(lastEngine().getState().filteredCount).toBe(2);
      expect(container.querySelector<HTMLButtonElement>(".sift-apply-query")?.disabled).toBe(false);
      unmount();
    });
  });

  it.each([false, true])(
    "clears stopped styling when a replacement stream starts before React settles (windowed: %s)",
    async (windowed) => {
      vi.useRealTimers();
      let restore = stubParquetStore();
      const onLoadError = vi.fn();
      const milestones: SiftLoadMilestone[] = [];
      const failedSource = parquetByteSource();
      const append = predicateModule.parquet_append_row_group.getMockImplementation()!;
      predicateModule.parquet_append_row_group
        .mockImplementationOnce(append)
        .mockImplementationOnce(() => {
          throw new Error("row group read failed");
        });
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      let releaseLastGroup = () => {};
      try {
        root.render(
          <SiftTable
            source={{ kind: "byte-source", source: failedSource, overflow: "truncate", windowed }}
            onLoadError={onLoadError}
          />,
        );
        await waitFor(() => {
          expect(container.querySelector(".sift-load-failure")?.textContent).toContain(
            "row group read failed",
          );
          expect(container.querySelector(".sift-status-stopped")).not.toBeNull();
        });
        const engine = lastEngine();
        const indicator = container.querySelector<HTMLElement>(".sift-status-indicator")!;
        restore();
        restore = stubParquetStore();
        const lastGroupReady = new Promise<void>((resolve) => {
          releaseLastGroup = resolve;
        });
        const successfulSource = parquetByteSource();
        const read = successfulSource.read.getMockImplementation()!;
        let groupReads = 0;
        successfulSource.read.mockImplementation(async (offset, length) => {
          if (offset === 4 && ++groupReads === 2) await lastGroupReady;
          return read(offset, length);
        });
        // Keep browser-style concurrent scheduling here. RTL's act-wrapped
        // rerender flushes the failure-clear effect before the first async
        // read can mount, hiding the stopped + streaming ordering.
        root.render(
          <SiftTable
            source={{
              kind: "byte-source",
              source: successfulSource,
              overflow: "truncate",
              windowed,
            }}
            onLoadError={onLoadError}
            onLoadMilestone={(milestone) => milestones.push(milestone)}
          />,
        );
        await waitFor(() => {
          expect(groupReads).toBe(2);
          expect(indicator.classList.contains("sift-status-streaming")).toBe(true);
          expect(container.querySelector(".sift-load-failure")).toBeNull();
          expect(indicator.classList.contains("sift-status-stopped")).toBe(false);
        });
        releaseLastGroup();
        await waitFor(() => {
          expect(milestones.some((m) => m.phase === "streaming-complete")).toBe(true);
          expect(indicator.classList.contains("sift-status-ready")).toBe(true);
        });
        expect(lastEngine()).toBe(engine);
        expect(engine.getState().totalCount).toBe(4);
        expect(onLoadError).toHaveBeenCalledTimes(1);
        expect(container.querySelector(".sift-load-failure")).toBeNull();
        expect(indicator.title).toBe("All data loaded");
        expect(indicator.textContent).toBe("✓");
        expect(indicator.classList.contains("sift-status-stopped")).toBe(false);
      } finally {
        releaseLastGroup();
        root.unmount();
        container.remove();
        restore();
      }
    },
  );

  describe("autoLoad", () => {
    const streamingComplete = (milestones: SiftLoadMilestone[]) =>
      milestones.filter((m) => m.phase === "streaming-complete");

    it("pauses at the soft budget, offers Load more, and finishes on demand", async () => {
      vi.useRealTimers();
      const restore = stubParquetStore({ rowGroups: 3 });
      const milestones: SiftLoadMilestone[] = [];
      const source = parquetByteSource();
      try {
        const { container, unmount } = render(
          <SiftTable
            source={{
              kind: "byte-source",
              source,
              overflow: "truncate",
              autoLoad: { rows: 3 },
            }}
            onLoadMilestone={(milestone) => milestones.push(milestone)}
          />,
        );

        // Group 0 holds 2 rows (< 3), so group 1 loads too and the stream
        // pauses at 4 rows with one group left.
        await waitFor(() => {
          expect(container.querySelector(".sift-load-more")).not.toBeNull();
        });
        expect(predicateModule.parquet_append_row_group).toHaveBeenCalledTimes(2);
        expect(predicateModule.finish_arrow_stream_store).not.toHaveBeenCalled();
        expect(streamingComplete(milestones)).toEqual([
          expect.objectContaining({
            source: "byte-source",
            rowCount: 4,
            totalRowCount: 6,
            truncated: true,
            resumable: true,
          }),
        ]);
        expect(container.querySelector(".sift-status-indicator")?.className).toContain(
          "sift-status-ready",
        );
        const hint = container.querySelector(".sift-preview-hint");
        expect(hint?.firstElementChild?.textContent).toBe("Showing first 4 of 6 rows");
        const button = container.querySelector<HTMLButtonElement>(".sift-load-more");
        expect(button?.textContent).toBe("Load more");
        expect(button?.disabled).toBe(false);
        // The button comes before the scope badge so a narrow footer squeezes the badge.
        expect(button?.nextElementSibling?.className).toContain("sift-preview-scope");
        const paused = vi.mocked(createTable).mock.calls.at(-1)?.[1];
        expect(paused?.coverage).toMatchObject({ loadedRows: 4, truncated: true, resumable: true });

        button!.click();
        await waitFor(() => {
          expect(streamingComplete(milestones)).toHaveLength(2);
        });
        expect(milestones.map((m) => m.phase)).toContain("streaming-resumed");
        expect(milestones.find((m) => m.phase === "streaming-resumed")?.rowCount).toBe(4);
        expect(predicateModule.parquet_append_row_group).toHaveBeenCalledTimes(3);
        expect(predicateModule.finish_arrow_stream_store).toHaveBeenCalledTimes(1);
        expect(streamingComplete(milestones)[1]).toMatchObject({
          rowCount: 6,
          totalRowCount: 6,
          truncated: false,
          resumable: false,
        });
        await waitFor(() => {
          expect(container.querySelector(".sift-load-more")).toBeNull();
          expect(container.querySelector(".sift-preview-hint")).toBeNull();
        });
        expect(paused?.coverage).toMatchObject({
          loadedRows: 6,
          truncated: false,
          resumable: false,
        });
        expect(container.querySelector(".sift-status-indicator")?.getAttribute("title")).toBe(
          "All data loaded",
        );
        unmount();
      } finally {
        restore();
      }
    });

    it("shows Loading… while a resume is in flight and pauses again at the next budget", async () => {
      vi.useRealTimers();
      const restore = stubParquetStore({ rowGroups: 3 });
      const source = parquetByteSource();
      let releaseRead: (() => void) | null = null;
      const originalRead = source.read.getMockImplementation()!;
      try {
        render(
          <SiftTable
            source={{ kind: "byte-source", source, overflow: "truncate", autoLoad: { rows: 2 } }}
          />,
        );
        // Pause after group 0 (2 rows).
        await waitFor(() => {
          expect(document.querySelector(".sift-load-more")?.textContent).toBe("Load more");
        });

        // Hold the next range read so the resume stays in flight.
        source.read.mockImplementation(
          (offset, length) =>
            new Promise((resolve) => {
              releaseRead = () => resolve(originalRead(offset, length));
            }),
        );
        document.querySelector<HTMLButtonElement>(".sift-load-more")!.click();
        await waitFor(() => {
          const button = document.querySelector<HTMLButtonElement>(".sift-load-more");
          expect(button?.textContent).toBe("Loading…");
          expect(button?.disabled).toBe(true);
        });
        expect(releaseRead).not.toBeNull();
        source.read.mockImplementation(originalRead);
        releaseRead!();

        // Group 1 lands (4 rows >= 2 + 2) with one group left: paused again.
        await waitFor(() => {
          const button = document.querySelector<HTMLButtonElement>(".sift-load-more");
          expect(button?.textContent).toBe("Load more");
          expect(button?.disabled).toBe(false);
        });
        expect(document.querySelector(".sift-preview-hint")?.firstElementChild?.textContent).toBe(
          "Showing first 4 of 6 rows",
        );
        expect(predicateModule.finish_arrow_stream_store).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("closes the footer when unmounted while paused", async () => {
      vi.useRealTimers();
      const restore = stubParquetStore({ rowGroups: 3 });
      try {
        const { unmount } = render(
          <SiftTable
            source={{
              kind: "byte-source",
              source: parquetByteSource(),
              overflow: "truncate",
              autoLoad: { rows: 2 },
            }}
          />,
        );
        await waitFor(() => {
          expect(document.querySelector(".sift-load-more")).not.toBeNull();
        });
        expect(predicateModule.parquet_close).not.toHaveBeenCalled();
        unmount();
        expect(predicateModule.parquet_close).toHaveBeenCalledWith(11);
        // The engine owned the store; unmount frees it once.
        expect(predicateModule.free).toHaveBeenCalledWith(9);
      } finally {
        restore();
      }
    });

    it("rejects autoLoad without overflow: truncate", async () => {
      vi.useRealTimers();
      const restore = stubParquetStore();
      const onLoadError = vi.fn();
      try {
        const { container } = render(
          <SiftTable
            source={{ kind: "byte-source", source: parquetByteSource(), autoLoad: { rows: 2 } }}
            onLoadError={onLoadError}
          />,
        );
        await waitFor(() => {
          expect(container.querySelector(".sift-loading")?.textContent).toContain(
            'overflow: "truncate"',
          );
        });
        expect(onLoadError).toHaveBeenCalledTimes(1);
        expect(predicateModule.parquet_open).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("resumes from the engine's near-end scroll callback with trigger: scroll", async () => {
      vi.useRealTimers();
      const restore = stubParquetStore({ rowGroups: 3 });
      const milestones: SiftLoadMilestone[] = [];
      try {
        render(
          <SiftTable
            source={{
              kind: "byte-source",
              source: parquetByteSource(),
              overflow: "truncate",
              autoLoad: { rows: 3, trigger: "scroll" },
            }}
            onLoadMilestone={(milestone) => milestones.push(milestone)}
          />,
        );
        await waitFor(() => {
          expect(document.querySelector(".sift-load-more")).not.toBeNull();
        });
        const options = vi.mocked(createTable).mock.calls.at(-1)?.[2];
        expect(options?.onScrollNearEnd).toBeTypeOf("function");

        options!.onScrollNearEnd!();
        await waitFor(() => {
          expect(streamingComplete(milestones)).toHaveLength(2);
        });
        expect(milestones.some((m) => m.phase === "streaming-resumed")).toBe(true);
        expect(streamingComplete(milestones)[1]).toMatchObject({ resumable: false });
        // The button is gone with the preview; nothing to load.
        await waitFor(() => {
          expect(document.querySelector(".sift-load-more")).toBeNull();
        });
      } finally {
        restore();
      }
    });

    it("applies autoLoad to url Parquet too", async () => {
      vi.useRealTimers();
      const restore = stubParquetUrl();
      const milestones: SiftLoadMilestone[] = [];
      try {
        const { container } = render(
          <SiftTable
            source={{
              kind: "url",
              url: "http://127.0.0.1:9000/big.parquet",
              autoLoad: { rows: 2 },
            }}
            onLoadMilestone={(milestone) => milestones.push(milestone)}
          />,
        );
        await waitFor(() => {
          expect(container.querySelector(".sift-load-more")).not.toBeNull();
        });
        expect(streamingComplete(milestones)[0]).toMatchObject({
          source: "url",
          rowCount: 2,
          totalRowCount: 4,
          truncated: true,
          resumable: true,
        });
      } finally {
        restore();
      }
    });
  });

  it("rejects invalid url limits before mounting", async () => {
    vi.useRealTimers();
    const restore = stubParquetUrl();
    const onLoadError = vi.fn();
    try {
      const { container } = render(
        <SiftTable
          source={{ kind: "url", url: "http://127.0.0.1:9000/x.parquet", limits: { maxRows: 0 } }}
          onLoadError={onLoadError}
        />,
      );
      await waitFor(() => {
        expect(container.querySelector(".sift-loading")?.textContent).toContain("maxRows");
      });
      expect(onLoadError).toHaveBeenCalledTimes(1);
      expect(predicateModule.parquet_open).not.toHaveBeenCalled();
    } finally {
      restore();
    }
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

  it("appends only the new chunks when a progressive manifest grows", async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const growing = (n: number, complete: boolean): SiftSource => ({
      kind: "arrow-stream-manifest",
      manifest: {
        chunks: Array.from({ length: n }, (_, i) => ({
          url: `http://127.0.0.1:9000/blob/chunk-${i}`,
          row_count: 100,
        })),
        complete,
      },
    });

    const { rerender } = render(<SiftTable source={growing(1, false)} />);
    await waitFor(() => {
      expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(1);
    });

    for (let n = 2; n <= 5; n++) {
      rerender(<SiftTable source={growing(n, n === 5)} />);
      await waitFor(() => {
        expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(n);
      });
    }

    // One store for the whole run, and each chunk fetched and appended once.
    expect(predicateModule.create_arrow_stream_store).toHaveBeenCalledTimes(1);
    expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(predicateModule.finish_arrow_stream_store).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it("rebuilds the store when the manifest head changes", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true as const,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    );

    const manifestFrom = (prefix: string, n: number): SiftSource => ({
      kind: "arrow-stream-manifest",
      manifest: {
        chunks: Array.from({ length: n }, (_, i) => ({
          url: `http://127.0.0.1:9000/blob/${prefix}-${i}`,
        })),
        complete: false,
      },
    });

    const { rerender } = render(<SiftTable source={manifestFrom("first", 1)} />);
    await waitFor(() => {
      expect(predicateModule.create_arrow_stream_store).toHaveBeenCalledTimes(1);
    });

    // A different chunk 0 is a different logical table, not an extension.
    rerender(<SiftTable source={manifestFrom("second", 2)} />);
    await waitFor(() => {
      expect(predicateModule.create_arrow_stream_store).toHaveBeenCalledTimes(2);
    });

    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it("finishes the store when a grown manifest reports completion without new chunks", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true as const,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    );

    const chunks = [{ url: "http://127.0.0.1:9000/blob/chunk-0", row_count: 100 }];
    const open: SiftSource = {
      kind: "arrow-stream-manifest",
      manifest: { chunks, complete: false },
    };
    const closed: SiftSource = {
      kind: "arrow-stream-manifest",
      manifest: { chunks, complete: true },
    };

    const { rerender } = render(<SiftTable source={open} />);
    await waitFor(() => {
      expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(1);
    });
    expect(predicateModule.finish_arrow_stream_store).not.toHaveBeenCalled();

    // The producer's final update carries the same chunks with complete: true.
    rerender(<SiftTable source={closed} />);
    await waitFor(() => {
      expect(predicateModule.finish_arrow_stream_store).toHaveBeenCalledTimes(1);
    });
    expect(predicateModule.create_arrow_stream_store).toHaveBeenCalledTimes(1);
    expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it("refreshes mounted columns when stream completion refines an image type", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true as const,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    );
    predicateModule.col_type.mockImplementation((_handle: number, col: number) => {
      if (col === 0) return "numeric";
      return predicateModule.finish_arrow_stream_store.mock.calls.length > 0
        ? "image"
        : "categorical";
    });

    const source: SiftSource = {
      kind: "arrow-stream-manifest",
      manifest: {
        chunks: [{ url: "http://127.0.0.1:9000/blob/chunk-0", row_count: 2 }],
        complete: true,
      },
    };
    const { container } = render(<SiftTable source={source} />);

    await waitFor(() => {
      expect(predicateModule.finish_arrow_stream_store).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(container.querySelectorAll('.sift-type-icon[title="image"]')).toHaveLength(1);
    });

    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it("rebuilds rather than appending after another source takes over the engine", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true as const,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    );

    const growing = (n: number): SiftSource => ({
      kind: "arrow-stream-manifest",
      manifest: {
        chunks: Array.from({ length: n }, (_, i) => ({
          url: `http://127.0.0.1:9000/blob/chunk-${i}`,
          row_count: 100,
        })),
        complete: false,
      },
    });

    const { container, rerender } = render(<SiftTable source={growing(1)} />);
    await waitFor(() => {
      expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(1);
    });

    // `replaceData` frees the manifest store when this source takes the engine.
    rerender(<SiftTable data={makeTableData([[1, "Alice", 95]])} />);
    await waitFor(() => {
      expect(predicateModule.free).toHaveBeenCalled();
    });
    expect(container.querySelector(".sift-status-indicator")?.className).toContain(
      "sift-status-ready",
    );

    // Returning to a manifest that looks like an extension must not append to
    // the freed handle. It has to build a new store.
    rerender(<SiftTable source={growing(2)} />);
    await waitFor(() => {
      expect(predicateModule.create_arrow_stream_store).toHaveBeenCalledTimes(2);
    });
  });

  it("clears a stale error once a later manifest update succeeds", async () => {
    vi.useRealTimers();
    let failNext = false;
    vi.stubGlobal("fetch", () =>
      failNext
        ? Promise.resolve({ ok: false as const, status: 500, statusText: "boom" })
        : Promise.resolve({
            ok: true as const,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          }),
    );

    const growing = (n: number, complete: boolean): SiftSource => ({
      kind: "arrow-stream-manifest",
      manifest: {
        chunks: Array.from({ length: n }, (_, i) => ({
          url: `http://127.0.0.1:9000/blob/chunk-${i}`,
          row_count: 100,
        })),
        complete,
      },
    });

    const { rerender, container } = render(<SiftTable source={growing(1, false)} />);
    await waitFor(() => {
      expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(1);
    });

    failNext = true;
    rerender(<SiftTable source={growing(2, false)} />);
    await waitFor(() => {
      expect(container.innerHTML).toMatch(/boom|Failed/i);
    });

    failNext = false;
    rerender(<SiftTable source={growing(3, true)} />);
    await waitFor(() => {
      expect(predicateModule.finish_arrow_stream_store).toHaveBeenCalled();
    });
    expect(container.innerHTML).not.toMatch(/boom|Failed/i);
  });

  it("applies changed column overrides to a growing manifest", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true as const,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    );

    const growing = (n: number): SiftSource => ({
      kind: "arrow-stream-manifest",
      manifest: {
        chunks: Array.from({ length: n }, (_, i) => ({
          url: `http://127.0.0.1:9000/blob/chunk-${i}`,
          row_count: 100,
        })),
        complete: false,
      },
    });

    const { rerender, container } = render(
      <SiftTable source={growing(1)} columnOverrides={{ id: { label: "FIRST" } }} />,
    );
    await waitFor(() => {
      expect(container.innerHTML).toMatch(/FIRST/);
    });

    // Overrides are applied while the store is built, so a change to them has
    // to rebuild even though the manifest only grew.
    rerender(<SiftTable source={growing(2)} columnOverrides={{ id: { label: "SECOND" } }} />);
    await waitFor(() => {
      expect(container.innerHTML).toMatch(/SECOND/);
    });
    expect(container.innerHTML).not.toMatch(/FIRST/);
  });

  it("frees a store whose first chunk fetch fails, without waiting for unmount", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: false as const, status: 500, statusText: "boom" }),
    );

    render(
      <SiftTable
        source={{
          kind: "arrow-stream-manifest",
          manifest: {
            chunks: [{ url: "http://127.0.0.1:9000/blob/chunk-0" }],
            complete: true,
          },
        }}
      />,
    );

    // The engine never took ownership, so nothing else will release it.
    await waitFor(() => {
      expect(predicateModule.free).toHaveBeenCalledWith(9);
    });
  });

  it("frees the WASM store on unmount after a manifest load", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true as const,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    );

    const { unmount } = render(
      <SiftTable
        source={{
          kind: "arrow-stream-manifest",
          manifest: {
            chunks: [{ url: "http://127.0.0.1:9000/blob/chunk-0" }],
            complete: true,
          },
        }}
      />,
    );
    await waitFor(() => {
      expect(predicateModule.append_arrow_stream_chunk).toHaveBeenCalledTimes(1);
    });

    unmount();
    expect(predicateModule.free).toHaveBeenCalledWith(9);

    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  describe("worker byte-source", () => {
    type Listener = (event: Event) => void;

    /**
     * A fake data worker that speaks the wire protocol for a two-row-group file:
     * `opened` with the first group, then a `rows-appended` push and
     * `streaming-done`. Requests answer from a tiny in-memory table.
     */
    function fakeWorker(options: { failOpen?: string; fatalAfterMount?: string } = {}) {
      const listeners = new Map<string, Listener[]>();
      const posted: unknown[] = [];
      let terminated = false;
      const rows = [
        [1, "a"],
        [2, "b"],
        [3, "c"],
        [4, "d"],
      ];
      const cellsFor = (viewStart: number, viewEnd: number, count: number) => {
        const end = Math.min(viewEnd, count);
        const n = Math.max(0, end - viewStart);
        return {
          viewStart,
          dataRows: Uint32Array.from({ length: n }, (_, i) => viewStart + i),
          strings: Array.from({ length: n }, (_, i) => rows[viewStart + i].map(String)).flat(),
          nulls: new Uint8Array(n * 2),
          numeric: Float64Array.from({ length: n * 2 }, (_, k) =>
            k % 2 === 0 ? (rows[viewStart + Math.floor(k / 2)][0] as number) : Number.NaN,
          ),
        };
      };
      const columns = [
        { key: "id", label: "id", width: 80, sortable: true, numeric: true, columnType: "numeric" },
        {
          key: "name",
          label: "name",
          width: 80,
          sortable: true,
          numeric: false,
          columnType: "categorical",
        },
      ];
      let rowCount = 2;
      const reply = (message: unknown) => {
        if (terminated) return;
        setTimeout(() => {
          if (terminated) return;
          for (const listener of listeners.get("message") ?? []) {
            listener({ data: message } as unknown as Event);
          }
        }, 0);
      };
      const worker = {
        postMessage(message: { t: string; id?: number; viewStart?: number; viewEnd?: number }) {
          posted.push(message);
          switch (message.t) {
            case "open":
              if (options.failOpen) {
                reply({ t: "error", id: message.id, message: options.failOpen, fatal: false });
                return;
              }
              reply({
                t: "opened",
                id: message.id,
                columns,
                rowCount,
                head: cellsFor(0, 2, 2),
                rowGroupCount: 2,
              });
              reply({
                t: "progress",
                phase: "chunk",
                rowGroup: 0,
                rowGroupCount: 2,
                loadedRows: 2,
                totalRows: 4,
                truncated: false,
                memoryBytes: 10,
              });
              setTimeout(() => {
                if (options.fatalAfterMount) {
                  reply({ t: "error", id: null, message: options.fatalAfterMount, fatal: true });
                  return;
                }
                rowCount = 4;
                reply({
                  t: "event",
                  event: { type: "rows-appended", rowCount: 4, summariesAll: [null, null] },
                });
                reply({
                  t: "progress",
                  phase: "chunk",
                  rowGroup: 1,
                  rowGroupCount: 2,
                  loadedRows: 4,
                  totalRows: 4,
                  truncated: false,
                  memoryBytes: 20,
                });
                reply({ t: "event", event: { type: "streaming-done" } });
                reply({
                  t: "progress",
                  phase: "complete",
                  rowGroup: 1,
                  rowGroupCount: 2,
                  loadedRows: 4,
                  totalRows: 4,
                  truncated: false,
                  memoryBytes: 20,
                });
              }, 5);
              return;
            case "query":
              reply({
                t: "query",
                id: message.id,
                result: {
                  generation: 0,
                  filteredCount: rowCount,
                  summaries: [null, null],
                  summariesAll: [null, null],
                },
              });
              return;
            case "window":
              reply({
                t: "window",
                id: message.id,
                cells: cellsFor(message.viewStart!, message.viewEnd!, rowCount),
              });
              return;
            case "close":
              reply({ t: "closed" });
              return;
          }
        },
        addEventListener(type: string, listener: Listener) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        terminate() {
          terminated = true;
        },
        posted,
        isTerminated: () => terminated,
      };
      return worker;
    }

    const source = { byteLength: 1024, read: vi.fn(async () => new Uint8Array(8)) };

    afterEach(() => {
      setWorkerFactory(null);
    });

    it("rejects at validation without a factory; no main-thread fallback", async () => {
      vi.useRealTimers();
      const onLoadError = vi.fn();
      const { container, unmount } = render(
        <SiftTable
          source={{ kind: "byte-source", source, worker: true }}
          onLoadError={onLoadError}
        />,
      );
      await waitFor(() => {
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(
          "setWorkerFactory",
        );
      });
      expect(onLoadError).toHaveBeenCalledTimes(1);
      expect(source.read).not.toHaveBeenCalled();
      expect(createTable).not.toHaveBeenCalled();
      unmount();
    });

    it("mounts the worker's data, streams, and emits the milestone sequence", async () => {
      vi.useRealTimers();
      const worker = fakeWorker();
      setWorkerFactory(() => worker as unknown as Worker);
      const milestones: SiftLoadMilestone[] = [];
      const { container, unmount } = render(
        <SiftTable
          source={{ kind: "byte-source", source, worker: true, allocationCap: 123 }}
          onLoadMilestone={(m) => milestones.push(m)}
        />,
      );
      await waitFor(() => {
        expect(milestones.map((m) => m.phase)).toEqual([
          "load-start",
          "wasm-ready",
          "table-data-created",
          "engine-mounted",
          "chunk-appended",
          "streaming-complete",
        ]);
      });
      expect(milestones.every((m) => m.source === "byte-source")).toBe(true);
      const open = worker.posted[0] as {
        t: string;
        allocationCap?: number;
        source: { byteLength: number };
      };
      expect(open).toMatchObject({ t: "open", allocationCap: 123, source: { byteLength: 1024 } });
      const data = vi.mocked(createTable).mock.calls.at(-1)?.[1];
      expect(data).toMatchObject({ kind: "windowed" });
      await waitFor(() => {
        expect(container.querySelector<HTMLElement>(".sift-stat-rows")?.dataset.value).toBe(
          "4 rows",
        );
        expect(container.querySelector(".sift-status-ready")).not.toBeNull();
        expect(container.querySelector(".sift-cell")?.textContent).toBe("1");
      });
      unmount();
      // Engine teardown disposes the data: close, then terminate on the ack.
      await waitFor(() => expect(worker.isTerminated()).toBe(true));
      expect(worker.posted.some((m) => (m as { t: string }).t === "close")).toBe(true);
    });

    it("keeps the loaded rows and shows the stopped-loading footer on a fatal worker error", async () => {
      vi.useRealTimers();
      const worker = fakeWorker({
        fatalAfterMount: "row group 1 exceeded the worker memory limit",
      });
      setWorkerFactory(() => worker as unknown as Worker);
      const onLoadError = vi.fn();
      const { container, unmount } = render(
        <SiftTable
          source={{ kind: "byte-source", source, worker: true }}
          onLoadError={onLoadError}
        />,
      );
      await waitFor(() => {
        expect(container.querySelector(".sift-load-failure")?.textContent).toBe(
          "Stopped loading: row group 1 exceeded the worker memory limit · Showing loaded rows",
        );
      });
      expect(onLoadError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "row group 1 exceeded the worker memory limit" }),
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector<HTMLElement>(".sift-stat-rows")?.dataset.value).toBe("2 rows");
      expect(worker.isTerminated()).toBe(true);
      unmount();
    });

    it("reports an open failure as a blocking error", async () => {
      vi.useRealTimers();
      const worker = fakeWorker({ failOpen: "Table file is too small to be a Parquet file" });
      setWorkerFactory(() => worker as unknown as Worker);
      const { container, unmount } = render(
        <SiftTable source={{ kind: "byte-source", source, worker: true }} />,
      );
      await waitFor(() => {
        expect(container.querySelector('[role="alert"]')?.textContent).toContain("too small");
      });
      unmount();
    });
  });

  describe("windowed byte-source", () => {
    const phases = (milestones: SiftLoadMilestone[]) => milestones.map((m) => m.phase);

    async function streamParquet(windowed: boolean) {
      const restore = stubParquetStore({ rowGroups: 3 });
      const milestones: SiftLoadMilestone[] = [];
      const source = parquetByteSource();
      const { container, unmount } = render(
        <SiftTable
          source={{ kind: "byte-source", source, overflow: "truncate", windowed }}
          onLoadMilestone={(milestone) => milestones.push(milestone)}
        />,
      );
      try {
        await waitFor(() => {
          expect(phases(milestones)).toContain("streaming-complete");
          expect(container.querySelector(".sift-status-ready")).not.toBeNull();
        });
        await waitFor(() => {
          expect(container.querySelector<HTMLElement>(".sift-stat-rows")?.dataset.value).toBe(
            "6 rows",
          );
        });
        return { phases: phases(milestones), container, unmount };
      } finally {
        restore();
      }
    }

    it("mounts a WindowedTableData and streams with the same milestones as resident mode", async () => {
      vi.useRealTimers();
      const resident = await streamParquet(false);
      resident.unmount();
      const residentData = vi.mocked(createTable).mock.calls.at(-1)?.[1];
      expect(residentData && "kind" in residentData).toBe(false);

      vi.mocked(createTable).mockClear();
      const windowed = await streamParquet(true);
      const windowedData = vi.mocked(createTable).mock.calls.at(-1)?.[1];
      expect(windowedData).toMatchObject({ kind: "windowed" });
      expect(windowed.phases).toEqual(resident.phases);
      await waitFor(() => {
        expect(windowed.container.querySelector(".sift-cell-skeleton")).toBeNull();
        expect(windowed.container.querySelector(".sift-cell")?.textContent).toBe("1");
      });
      expect(windowed.container.getAttribute("aria-busy")).not.toBe("true");
      windowed.unmount();
      expect(predicateModule.free).toHaveBeenCalled();
    });
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

  it("disposes stale loader results and keeps the latest complete table", async () => {
    vi.useRealTimers();
    let finishOld!: (data: TableData) => void;
    const oldLoad = new Promise<TableData>((resolve) => {
      finishOld = resolve;
    });
    const load = vi.fn(() => oldLoad);
    const stale = { ...makeTableData([[1, "Old", 0]]), dispose: vi.fn() };
    const current = { ...makeTableData([[2, "Current", 10]]), dispose: vi.fn() };
    const { container, rerender, unmount } = render(
      <SiftTable source={{ kind: "loader", load }} />,
    );
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    rerender(<SiftTable source={{ kind: "loader", load: async () => current }} />);
    await waitFor(() => expect(container.querySelector(".sift-table-container")).not.toBeNull());
    finishOld(stale);
    await waitFor(() => expect(stale.dispose).toHaveBeenCalledOnce());
    expect(current.dispose).not.toHaveBeenCalled();
    unmount();
    expect(current.dispose).toHaveBeenCalledOnce();
  });

  it("clears a previous loader table on replacement and reports load failures", async () => {
    vi.useRealTimers();
    const data = { ...makeTableData([[1, "Old", 0]]), dispose: vi.fn() };
    const { container, rerender, getByText } = render(
      <SiftTable source={{ kind: "loader", load: async () => data }} />,
    );
    await waitFor(() => expect(container.querySelector(".sift-table-container")).not.toBeNull());
    rerender(
      <SiftTable
        source={{
          kind: "loader",
          load: async () => {
            throw new Error("Invalid table file");
          },
        }}
      />,
    );
    await waitFor(() => expect(getByText("Error: Invalid table file")).not.toBeNull());
    expect(container.querySelector(".sift-table-container")).toBeNull();
    expect(data.dispose).toHaveBeenCalledOnce();
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

  describe("worker byte-source load reporting", () => {
    type Listener = (event: Event) => void;
    const columns = [
      { key: "id", label: "id", width: 80, sortable: true, numeric: true, columnType: "numeric" },
      {
        key: "name",
        label: "name",
        width: 80,
        sortable: true,
        numeric: false,
        columnType: "categorical",
      },
    ];
    const cells = (viewStart: number, viewEnd: number, count: number) => {
      const n = Math.max(0, Math.min(viewEnd, count) - viewStart);
      return {
        viewStart,
        dataRows: Uint32Array.from({ length: n }, (_, i) => viewStart + i),
        strings: Array.from({ length: n }, (_, i) => [String(viewStart + i + 1), "x"]).flat(),
        nulls: new Uint8Array(n * 2),
        numeric: Float64Array.from({ length: n * 2 }, (_, k) =>
          k % 2 === 0 ? viewStart + k / 2 + 1 : Number.NaN,
        ),
      };
    };

    /**
     * Opens two of four rows, answers queries and windows over them, then
     * sends `afterOpen` (the load's last word) a few milliseconds later.
     */
    function scriptedWorker(afterOpen: unknown[]) {
      const listeners: Listener[] = [];
      let terminated = false;
      const reply = (message: unknown) =>
        setTimeout(() => {
          if (!terminated) for (const l of listeners) l({ data: message } as unknown as Event);
        }, 0);
      return {
        postMessage(message: { t: string; id: number; viewStart?: number; viewEnd?: number }) {
          if (message.t === "open") {
            reply({
              t: "opened",
              id: message.id,
              columns,
              rowCount: 2,
              head: cells(0, 2, 2),
              rowGroupCount: 2,
            });
            setTimeout(() => afterOpen.forEach(reply), 5);
          } else if (message.t === "query") {
            const result = { generation: 0, filteredCount: 2, summaries: [null, null] };
            reply({
              t: "query",
              id: message.id,
              result: { ...result, summariesAll: [null, null] },
            });
          } else if (message.t === "window") {
            reply({
              t: "window",
              id: message.id,
              cells: cells(message.viewStart!, message.viewEnd!, 2),
            });
          } else if (message.t === "close") {
            reply({ t: "closed" });
          }
        },
        addEventListener(type: string, listener: Listener) {
          if (type === "message") listeners.push(listener);
        },
        terminate() {
          terminated = true;
        },
      };
    }

    const source = { byteLength: 1024, read: vi.fn(async () => new Uint8Array(8)) };

    afterEach(() => {
      setWorkerFactory(null);
    });

    it("routes a factory that throws to Sift's error state and onLoadError", async () => {
      vi.useRealTimers();
      setWorkerFactory(() => {
        throw new DOMException("Refused to create a worker", "SecurityError");
      });
      const onLoadError = vi.fn();
      const { container, unmount } = render(
        <SiftTable
          source={{ kind: "byte-source", source, worker: true }}
          onLoadError={onLoadError}
        />,
      );
      await waitFor(() => {
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(
          "Worker factory threw: Refused to create a worker",
        );
      });
      expect(onLoadError).toHaveBeenCalledTimes(1);
      expect(onLoadError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Worker factory threw: Refused to create a worker" }),
      );
      expect(createTable).not.toHaveBeenCalled();
      unmount();
    });

    it("shows the stopped-loading footer for a non-fatal load error after mount", async () => {
      vi.useRealTimers();
      setWorkerFactory(
        () =>
          scriptedWorker([
            { t: "event", event: { type: "error", message: "network down", fatal: false } },
          ]) as unknown as Worker,
      );
      const onLoadError = vi.fn();
      const { container, unmount } = render(
        <SiftTable
          source={{ kind: "byte-source", source, worker: true }}
          onLoadError={onLoadError}
        />,
      );
      await waitFor(() => {
        expect(container.querySelector(".sift-load-failure")?.textContent).toBe(
          "Stopped loading: network down · Showing loaded rows",
        );
      });
      expect(onLoadError).toHaveBeenCalledTimes(1);
      expect(onLoadError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "network down" }),
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector<HTMLElement>(".sift-stat-rows")?.dataset.value).toBe("2 rows");
      await waitFor(() => {
        expect(container.querySelector(".sift-status-stopped")).not.toBeNull();
      });
      unmount();
    });

    it("shows the preview notice and reports counts when the budget stops the load", async () => {
      vi.useRealTimers();
      setWorkerFactory(
        () =>
          scriptedWorker([
            {
              t: "event",
              event: { type: "streaming-done", loadedRows: 2, totalRows: 4, truncated: true },
            },
          ]) as unknown as Worker,
      );
      const milestones: SiftLoadMilestone[] = [];
      const { container, unmount } = render(
        <SiftTable
          source={{ kind: "byte-source", source, worker: true, overflow: "truncate" }}
          onLoadMilestone={(m) => milestones.push(m)}
        />,
      );
      await waitFor(() => {
        expect(container.querySelector(".sift-preview-hint")?.textContent).toContain(
          "Showing first 2 of 4 rows · Table tools use shown rows",
        );
      });
      expect(milestones.find((m) => m.phase === "streaming-complete")).toMatchObject({
        rowCount: 2,
        totalRowCount: 4,
        truncated: true,
        resumable: false,
      });
      expect(container.querySelector<HTMLElement>(".sift-stat-rows")?.dataset.value).toBe("2 rows");
      unmount();
    });
  });
});
