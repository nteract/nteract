import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { createBlobResolver } from "runtimed";
import { createWidgetStore } from "@/components/widgets/widget-store";
import { useCloudViewerSession, type CloudViewerConfig } from "../cloud-viewer-session";
import { connectCloudSyncRuntime } from "../live-sync";
import { cloudViewerLoadingPolicy } from "../loading-policy";

vi.mock("../live-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../live-sync")>()),
  connectCloudSyncRuntime: vi.fn(),
}));

it("clears the failed page status while a manual live-room retry is pending", async () => {
  const connect = vi.mocked(connectCloudSyncRuntime);
  connect.mockRejectedValueOnce(new Error("runtimed WASM asset failed: body terminated"));
  connect.mockImplementation(() => new Promise(() => {}));
  const config: CloudViewerConfig = {
    notebookId: "retry-fixture",
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
    blobResolver: createBlobResolver({ url: ({ blob }) => `/blob/${blob}` }),
    loadingPolicy: cloudViewerLoadingPolicy(config),
    preloadSiftWasm: () => {},
    widgetStore: createWidgetStore(),
  };
  const { result } = renderHook(() => useCloudViewerSession(options));
  await waitFor(() => expect(result.current.status.kind).toBe("error"));
  expect(result.current.connectionError).toContain("body terminated");

  act(() => result.current.retryLiveConnection());

  expect(connect).toHaveBeenCalledTimes(2);
  expect(result.current.connectionError).toBeNull();
  expect(result.current.status.kind).toBe("loading");
});
