import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { Subject } from "rxjs";
import { createBlobResolver, type ExecutionViewChangeset } from "runtimed";
import {
  getCellExecutionId,
  notebookExecutionStore,
} from "@/components/notebook/state/execution-store";
import { getCellOutputsSnapshot } from "@/components/notebook/state/output-store";
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

it.each(["execute", "clear"] as const)(
  "keeps a newer %s pointer when an unrelated table finishes loading",
  async (change) => {
    const stdout = { output_id: "stdout", output_type: "stream", name: "stdout", text: "done\n" };
    const table = {
      output_id: "table-output",
      output_type: "display_data",
      data: { "text/html": { blob: "table-blob" } },
      metadata: {},
    };
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
        project_execution_view_changeset: () => undefined,
        free: vi.fn(),
      },
      engine: {
        broadcasts$: idle,
        presence$: idle,
        cellChanges$: idle,
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
    const fetchBlob = vi.fn(async () => {
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
      blobResolver: createBlobResolver({ url: () => "/blob/table-blob", fetchImpl: fetchBlob }),
      loadingPolicy: cloudViewerLoadingPolicy(config),
      preloadSiftWasm: () => {},
      widgetStore: createWidgetStore(),
    };
    const { result } = renderHook(() => useCloudViewerSession(options));
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledOnce());
    // Finish the other cell's synchronous progressive callback before changing
    // the authoritative execution, leaving only the table resolution pending.
    await act(async () => {
      await Promise.resolve();
    });
    const nextExecutionId = change === "execute" ? "stream-exec" : null;
    act(() => {
      cells = [
        cells[0],
        { ...cells[1], execution_id: nextExecutionId, outputs: nextExecutionId ? [stdout] : [] },
      ];
      outputIdChanges$.next({
        changed: nextExecutionId ? [["stdout", stdout]] : [],
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
    expect(fetchBlob).toHaveBeenCalledOnce();
  },
);
