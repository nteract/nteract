import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { Subject } from "rxjs";
import { createBlobResolver, type CellChangeset, type ExecutionViewChangeset } from "runtimed";
import {
  getCellExecutionId,
  getExecutionById,
  notebookExecutionStore,
} from "@/components/notebook/state/execution-store";
import { getCellOutputsSnapshot } from "@/components/notebook/state/output-store";
import { getCellById } from "@/components/notebook/state/cell-store";
import { createWidgetStore } from "@/components/widgets/widget-store";
import { useCloudViewerSession, type CloudViewerConfig } from "../cloud-viewer-session";
import { connectCloudSyncRuntime, type CloudSyncRuntime } from "../live-sync";
import { cloudViewerLoadingPolicy } from "../loading-policy";
import type { RenderCell } from "../render-resolution";

vi.mock("../live-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../live-sync")>()),
  connectCloudSyncRuntime: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const config: CloudViewerConfig = {
  notebookId: "progressive-execution-fixture",
  headsHash: null,
  catalogEndpoint: "/catalog",
  snapshotBasePath: "/snapshot",
  runtimeSnapshotBasePath: "/runtime",
  commsSnapshotBasePath: "/comms",
  aclEndpoint: "/acl",
  invitesEndpoint: "/invites",
  accessRequestsEndpoint: "/access",
  syncEndpoint: "ws://localhost/sync",
  blobBasePath: "/blob",
  rendererAssetsBasePath: "/renderer",
  rendererAssets: { js: "renderer.js", css: "renderer.css", siftWasm: "sift.wasm" },
  outputDocumentBaseUrl: null,
  runtimedWasmModulePath: "/runtime.js",
  runtimedWasmPath: "/runtime.wasm",
};

function liveFixture(readCells: () => RenderCell[]) {
  const idle = new Subject<never>();
  const cellChanges$ = new Subject<CellChangeset | null>();
  const runtime = {
    actorLabel: "anonymous:test/browser:test",
    peerId: "test",
    peerLabel: "Test",
    connectionScope: "viewer",
    handle: {
      cell_count: () => readCells().length,
      notebook_doc_caught_up: () => false,
      get_cells_json: () => JSON.stringify(readCells()),
      get_metadata_snapshot_json: () => "{}",
      get_metadata_fingerprint: () => "metadata",
      get_metadata_snapshot: () => ({}),
      get_runtime_state: () => ({}),
      get_comms_state: () => ({}),
      get_execution_by_id: () => ({
        execution_count: 1,
        status: "done",
        success: true,
        output_ids: ["output"],
      }),
      project_execution_view_changeset: () => undefined,
      free: vi.fn(),
    },
    engine: {
      broadcasts$: idle,
      presence$: idle,
      cellChanges$,
      runtimeState$: idle,
      executionViewChanges$: idle,
      outputIdChanges$: idle,
      commChanges$: idle,
      commBroadcasts$: idle,
      poolState$: idle,
      notebookSyncApplied$: idle,
      notebookDocChanged$: idle,
      notebookDocFlushDelivered$: idle,
      reProjectComms: vi.fn(),
      stop: vi.fn(),
    },
    transport: { roomReady$: idle, disconnect: vi.fn() },
  } as unknown as CloudSyncRuntime;
  return { runtime, cellChanges$ };
}

function liveOptions(blobResolver = createBlobResolver({ url: ({ blob }) => `/blob/${blob}` })) {
  return {
    config,
    authRenewalKind: "idle" as const,
    authState: {
      mode: "anonymous" as const,
      token: null,
      user: null,
      oidcClaims: null,
      requestedScope: null,
      problem: null,
    },
    blobResolver,
    loadingPolicy: cloudViewerLoadingPolicy(config),
    preloadSiftWasm: () => {},
    widgetStore: createWidgetStore(),
  };
}

it("does not reuse handle-local output stamps after replacing the live runtime", async () => {
  const cell = (text: string): RenderCell => ({
    id: "cell",
    cell_type: "code",
    source: "print(value)",
    execution_id: "execution",
    outputs: [
      {
        output_id: "output",
        output_type: "stream",
        name: "stdout",
        text,
        _runt_output_cache_key: "output:output:0:1",
      },
    ],
  });
  const first = liveFixture(() => [cell("first chunk")]);
  const second = liveFixture(() => [cell("complete output")]);
  vi.mocked(connectCloudSyncRuntime)
    .mockResolvedValueOnce(first.runtime)
    .mockResolvedValueOnce(second.runtime);
  const options = liveOptions();
  const { result } = renderHook(() => useCloudViewerSession(options));
  await waitFor(() =>
    expect(getCellOutputsSnapshot("cell")[0]).toMatchObject({ text: "first chunk" }),
  );
  act(() => result.current.retryLiveConnection());
  await waitFor(() => expect(connectCloudSyncRuntime).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(getCellOutputsSnapshot("cell")[0]).toMatchObject({ text: "complete output" }),
  );
});

it("projects later serialized cell changes while a fallback output blob is pending", async () => {
  let cells: RenderCell[] = [
    { id: "cell", cell_type: "code", source: "initial", execution_id: "execution", outputs: [] },
  ];
  const { runtime, cellChanges$ } = liveFixture(() => cells);
  vi.mocked(connectCloudSyncRuntime).mockResolvedValue(runtime);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchBlob = vi.fn(async () => {
    await gate;
    return new Response("resolved");
  });
  const options = liveOptions(
    createBlobResolver({ url: ({ blob }) => `/blob/${blob}`, fetchImpl: fetchBlob }),
  );
  const { result } = renderHook(() => useCloudViewerSession(options));
  await waitFor(() => expect(result.current.status.kind).toBe("ready"));
  act(() => {
    cells = [
      {
        ...cells[0],
        outputs: [
          { output_id: "output", output_type: "stream", name: "stdout", text: { blob: "pending" } },
        ],
      },
    ];
    cellChanges$.next(null);
  });
  await waitFor(() => expect(fetchBlob).toHaveBeenCalledOnce());
  try {
    act(() => {
      cells = [{ ...cells[0], source: "collaborator edit" }];
      cellChanges$.next(null);
    });
    await waitFor(() => expect(getCellById("cell")?.source).toBe("collaborator edit"));
  } finally {
    await act(async () => {
      release();
    });
  }
});

it.each(["execute", "clear", "update"] as const)(
  "keeps a newer %s pointer when an unrelated table finishes loading",
  async (change) => {
    const stdout = { output_id: "stdout", output_type: "stream", name: "stdout", text: "done\n" };
    const table = {
      output_id: "table-output",
      output_type: "display_data",
      data: { "text/html": { blob: "table-blob" } },
      metadata: {},
    };
    const updatedTable = { ...table, data: { "text/html": { blob: "updated-table-blob" } } };
    let cells: RenderCell[] = [
      {
        id: "table",
        cell_type: "code",
        source: "display(df)",
        execution_id: "table-exec",
        outputs: [table],
      },
      {
        id: "stream",
        cell_type: "code",
        source: "print('done')",
        execution_id: change === "clear" ? "stream-exec" : null,
        outputs: change === "clear" ? [stdout] : [],
      },
    ];
    const executionViewChanges$ = new Subject<ExecutionViewChangeset>();
    const cellChanges$ = new Subject<CellChangeset | null>();
    const outputIdChanges$ = new Subject<{
      changed: Array<[string, unknown]>;
      removed_ids: string[];
    }>();
    const idle = new Subject<never>();
    const runtime = {
      actorLabel: "anonymous:test/browser:test",
      peerId: "test-peer",
      peerLabel: "Test",
      connectionScope: "viewer",
      handle: {
        cell_count: () => cells.length,
        notebook_doc_caught_up: () => false,
        get_cells_json: () => JSON.stringify(cells),
        get_metadata_snapshot_json: () => "{}",
        get_metadata_fingerprint: () => "metadata",
        get_metadata_snapshot: () => ({}),
        get_runtime_state: () => ({}),
        get_comms_state: () => ({}),
        get_execution_by_id: (id: string) => ({
          execution_count: 1,
          status: "done",
          success: true,
          output_ids: id === "table-exec" ? ["table-output"] : ["stdout"],
        }),
        project_execution_view_changeset: () => undefined,
        free: vi.fn(),
      },
      engine: {
        broadcasts$: idle,
        presence$: idle,
        cellChanges$,
        runtimeState$: idle,
        executionViewChanges$,
        outputIdChanges$,
        commChanges$: idle,
        commBroadcasts$: idle,
        poolState$: idle,
        notebookSyncApplied$: idle,
        notebookDocChanged$: idle,
        notebookDocFlushDelivered$: idle,
        reProjectComms: vi.fn(),
        stop: vi.fn(),
      },
      transport: { roomReady$: idle, disconnect: vi.fn() },
    } as unknown as CloudSyncRuntime;
    vi.mocked(connectCloudSyncRuntime).mockResolvedValue(runtime);
    let finishBlob!: () => void;
    const blobGate = new Promise<void>((resolve) => {
      finishBlob = resolve;
    });
    const fetchBlob = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === "/blob/updated-table-blob") return new Response("latest table");
      await blobGate;
      return new Response("<table><tr><td>1</td></tr></table>");
    });
    const options = {
      config,
      authRenewalKind: "idle" as const,
      authState: {
        mode: "anonymous" as const,
        token: null,
        user: null,
        oidcClaims: null,
        requestedScope: null,
        problem: null,
      },
      blobResolver: createBlobResolver({
        url: ({ blob }) => `/blob/${blob}`,
        fetchImpl: fetchBlob,
      }),
      loadingPolicy: cloudViewerLoadingPolicy(config),
      preloadSiftWasm: () => {},
      widgetStore: createWidgetStore(),
    };
    const { result } = renderHook(() => useCloudViewerSession(options));
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledOnce());
    // The engine's initial diff is already empty; bootstrap must recover the
    // authoritative summary, including unresolved output IDs, from the handle.
    expect(getExecutionById("table-exec")).toMatchObject({
      execution_count: 1,
      status: "done",
      success: true,
      output_ids: ["table-output"],
    });
    // Leave the table resolution pending while the authoritative execution advances.
    await act(async () => {
      await Promise.resolve();
    });
    const nextExecutionId = change === "execute" ? "stream-exec" : null;
    act(() => {
      cells = [
        change === "update" ? { ...cells[0], outputs: [updatedTable] } : cells[0],
        { ...cells[1], execution_id: nextExecutionId, outputs: nextExecutionId ? [stdout] : [] },
      ];
      outputIdChanges$.next({
        changed:
          change === "update"
            ? [["table-output", updatedTable]]
            : nextExecutionId
              ? [["stdout", stdout]]
              : [],
        removed_ids: nextExecutionId ? [] : ["stdout"],
      });
      executionViewChanges$.next({
        cell_pointer_changes: [["stream", nextExecutionId]],
        execution_upserts: nextExecutionId
          ? [
              [
                nextExecutionId,
                { execution_count: 3, status: "done", success: true, output_ids: ["stdout"] },
              ],
            ]
          : [],
        removed_execution_ids: [],
        queue: null,
      });
    });
    expect(getCellExecutionId("stream")).toBe(nextExecutionId);
    if (change === "update") {
      // The new async blob finishes first through outputIdChanges$, so the
      // bootstrap's held old blob must neither overwrite it nor poison its cache.
      await waitFor(() =>
        expect(getCellOutputsSnapshot("table")[0]).toMatchObject({
          data: { "text/html": "latest table" },
        }),
      );
    }
    const observedPointers: Array<string | null> = [];
    const unsubscribe = notebookExecutionStore.subscribeCellExecutionPointer("stream")(() => {
      observedPointers.push(getCellExecutionId("stream"));
    });
    await act(async () => {
      finishBlob();
    });
    await waitFor(() => expect(result.current.status.kind).toBe("ready"));
    unsubscribe();
    expect(getCellExecutionId("stream")).toBe(nextExecutionId);
    expect(observedPointers.every((pointer) => pointer === nextExecutionId)).toBe(true);
    expect(getCellOutputsSnapshot("stream")).toEqual(nextExecutionId ? [stdout] : []);
    expect(getCellOutputsSnapshot("table")).toHaveLength(1);
    if (change === "update") {
      expect(getCellOutputsSnapshot("table")[0]).toMatchObject({
        data: { "text/html": "latest table" },
      });
    }
    const expectedFetchCount = change === "update" ? 2 : 1;
    expect(fetchBlob).toHaveBeenCalledTimes(expectedFetchCount);
    const resolvedTable = getCellOutputsSnapshot("table")[0];
    await act(async () => {
      cellChanges$.next(null);
      expect(getCellOutputsSnapshot("table")[0]).toBe(resolvedTable);
    });
    await waitFor(() => expect(result.current.status.kind).toBe("ready"));
    expect(getCellOutputsSnapshot("table")[0]).toBe(resolvedTable);
    expect(fetchBlob).toHaveBeenCalledTimes(expectedFetchCount);
  },
);

it("finishes one widget hydration while runtime events continue", async () => {
  const idle = new Subject<never>();
  const runtimeState$ = new Subject<unknown>();
  const state = {
    comms: {
      widget: {
        model_module: "@jupyter-widgets/controls",
        model_name: "HTMLModel",
        state: { value: { blob: "widget-text", size: 8, media_type: "text/plain" } },
      },
    },
  };
  const getCells = vi.fn(() =>
    JSON.stringify([{ id: "stream", cell_type: "code", source: "print('running')", outputs: [] }]),
  );
  const runtime = {
    actorLabel: "anonymous:test/browser:test",
    peerId: "test",
    peerLabel: "Test",
    connectionScope: "viewer",
    handle: {
      cell_count: () => 1,
      notebook_doc_caught_up: () => false,
      get_cells_json: getCells,
      get_metadata_snapshot_json: () => "{}",
      get_metadata_fingerprint: () => "metadata",
      get_metadata_snapshot: () => ({}),
      get_runtime_state: () => state,
      get_comms_state: () => ({}),
      project_execution_view_changeset: () => undefined,
      free: vi.fn(),
    },
    engine: {
      broadcasts$: idle,
      presence$: idle,
      cellChanges$: idle,
      runtimeState$,
      executionViewChanges$: idle,
      outputIdChanges$: idle,
      commChanges$: idle,
      commBroadcasts$: idle,
      poolState$: idle,
      notebookSyncApplied$: idle,
      notebookDocChanged$: idle,
      notebookDocFlushDelivered$: idle,
      reProjectComms: vi.fn(),
      stop: vi.fn(),
    },
    transport: { roomReady$: idle, disconnect: vi.fn() },
  } as unknown as CloudSyncRuntime;
  vi.mocked(connectCloudSyncRuntime).mockResolvedValue(runtime);
  const releases: Array<() => void> = [];
  const fetchBlob = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        releases.push(() => resolve(new Response("hydrated")));
      }),
  );
  vi.stubGlobal("fetch", fetchBlob);
  const widgetStore = createWidgetStore();
  const options = {
    config,
    authRenewalKind: "idle" as const,
    authState: {
      mode: "anonymous" as const,
      token: null,
      user: null,
      oidcClaims: null,
      requestedScope: null,
      problem: null,
    },
    blobResolver: createBlobResolver({ url: ({ blob }) => `${location.origin}/blob/${blob}` }),
    loadingPolicy: cloudViewerLoadingPolicy(config),
    preloadSiftWasm: () => {},
    widgetStore,
  };
  const { result } = renderHook(() => useCloudViewerSession(options));
  await waitFor(() => expect(fetchBlob).toHaveBeenCalledOnce());
  await act(async () => {
    for (let i = 0; i < 5; i++) runtimeState$.next(state);
    releases[0]();
  });
  expect(result.current.status.kind).toBe("ready");
  expect(widgetStore.getModel("widget")?.state.value).toBe("hydrated");
  expect(fetchBlob).toHaveBeenCalledOnce();
  expect(getCells).toHaveBeenCalledOnce();
});
