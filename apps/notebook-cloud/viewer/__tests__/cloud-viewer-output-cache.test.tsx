import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createBlobResolver } from "runtimed";
import { getCellOutputsSnapshot } from "@/components/notebook/state/output-store";
import { createWidgetStore } from "@/components/widgets/widget-store";
import { useCloudViewerSession, type CloudViewerConfig } from "../cloud-viewer-session";
import { cloudViewerLoadingPolicy } from "../loading-policy";
import { loadSnapshotPairHandle, type NotebookHandle } from "../runtimed-wasm-client";

vi.mock("../runtimed-wasm-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtimed-wasm-client")>()),
  loadSnapshotPairHandle: vi.fn(),
}));

const config: CloudViewerConfig = {
  notebookId: "cache-fixture",
  headsHash: "pinned",
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
const output = {
  output_id: "image-output",
  output_type: "display_data",
  _runt_output_cache_key: "output:image-output:0:0",
  data: { "image/png": { blob: "sha256:image" } },
  metadata: {},
};
let currentOutput = output;

beforeEach(() => {
  currentOutput = output;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/catalog"
        ? new Response(
            JSON.stringify({
              revisions: [
                {
                  notebook_heads_hash: "pinned",
                  runtime_heads_hash: "runtime",
                  runtime_state_doc_id: "runtime-doc",
                },
              ],
            }),
          )
        : new Response(new Uint8Array([1])),
    ),
  );
  vi.mocked(loadSnapshotPairHandle).mockImplementation(
    async () =>
      ({
        get_cells_json: () =>
          JSON.stringify([
            { id: "plot", cell_type: "code", source: "plt.show()", outputs: [currentOutput] },
          ]),
        get_metadata_snapshot_json: () => "{}",
        get_runtime_state: () => ({}),
        get_comms_state: () => ({}),
        free: vi.fn(),
      }) as unknown as NotebookHandle,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function resolver(displayUrl: () => Promise<string>) {
  return createBlobResolver({
    url: () => "/protected-image",
    displayUrl,
    resolvesBinaryUrlsSynchronously: false,
  });
}
function options(blobResolver: ReturnType<typeof resolver>) {
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
function imageSource() {
  const image = getCellOutputsSnapshot("plot")[0] as { data?: Record<string, unknown> } | undefined;
  return image?.data?.["image/png"];
}

it("resolves the image again after the authenticated resolver changes", async () => {
  const first = vi.fn(async () => "data:image/png;base64,first");
  const second = vi.fn(async () => "data:image/png;base64,second");
  const initial = options(resolver(first));
  const { rerender } = renderHook(useCloudViewerSession, { initialProps: initial });
  await waitFor(() => expect(imageSource()).toBe("data:image/png;base64,first"));
  rerender({ ...initial, blobResolver: resolver(second) });
  await waitFor(() => expect(second).toHaveBeenCalledOnce());
  await waitFor(() => expect(imageSource()).toBe("data:image/png;base64,second"));
});

it("does not let a retired resolver's pending image seed the replacement session", async () => {
  let finish!: (url: string) => void;
  const first = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const second = vi.fn(async () => "data:image/png;base64,current");
  const initial = options(resolver(first));
  const { rerender } = renderHook(useCloudViewerSession, { initialProps: initial });
  await waitFor(() => expect(first).toHaveBeenCalledOnce());
  rerender({ ...initial, blobResolver: resolver(second) });
  await waitFor(() => expect(imageSource()).toBe("data:image/png;base64,current"));
  await act(async () => {
    finish("data:image/png;base64,retired");
  });
  expect(imageSource()).toBe("data:image/png;base64,current");
});

it("does not reuse a prior notebook's stamped output through the same resolver", async () => {
  const display = vi.fn(
    async () => `data:image/png;base64,${currentOutput.data["image/png"].blob}`,
  );
  const initial = options(resolver(display));
  const { rerender } = renderHook(useCloudViewerSession, { initialProps: initial });
  await waitFor(() => expect(imageSource()).toBe("data:image/png;base64,sha256:image"));
  currentOutput = { ...output, data: { "image/png": { blob: "sha256:other" } } };
  rerender({ ...initial, config: { ...config, notebookId: "other-notebook" } });
  await waitFor(() => expect(imageSource()).toBe("data:image/png;base64,sha256:other"));
  expect(display).toHaveBeenCalledTimes(2);
});

it("reuses resolved output when the same notebook and resolver rematerialize", async () => {
  const display = vi.fn(async () => "data:image/png;base64,cached");
  const initial = options(resolver(display));
  const { rerender } = renderHook(useCloudViewerSession, { initialProps: initial });
  await waitFor(() => expect(imageSource()).toBe("data:image/png;base64,cached"));
  const resolved = getCellOutputsSnapshot("plot")[0];
  const preload = vi.fn();
  rerender({ ...initial, preloadSiftWasm: preload });
  await waitFor(() => expect(preload).toHaveBeenCalled());
  expect(getCellOutputsSnapshot("plot")[0]).toBe(resolved);
  expect(display).toHaveBeenCalledOnce();
});
