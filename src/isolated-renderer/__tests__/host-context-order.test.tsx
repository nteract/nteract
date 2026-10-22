import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { IsolatedFrameRuntime } from "@/components/isolated/isolated-frame-runtime";
import { NTERACT_RENDERER_READY } from "@/components/isolated/rpc-methods";
import { install } from "../sift-renderer";

const state = vi.hoisted(() => ({
  roots: [] as Root[],
  configured: undefined as string | undefined,
  firstUse: vi.fn(),
}));
vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...original,
    createRoot: (...args: Parameters<typeof original.createRoot>) => {
      const root = original.createRoot(...args);
      state.roots.push(root);
      return root;
    },
  };
});
vi.mock("@nteract/sift", () => ({
  setWasmUrl: (url: string) => {
    state.configured = url;
  },
  SiftFocusStatus: () => null,
  // Model the earliest possible Sift use: during the child's first render.
  SiftTable: () => {
    state.firstUse(state.configured);
    return null;
  },
}));
vi.mock("../widget-provider", () => ({
  IframeWidgetStoreProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/widgets/widget-view", () => ({ WidgetView: () => null }));
vi.mock("@/components/widgets/controls", () => ({}));
vi.mock("@/components/widgets/matplotlib", () => ({}));

it("applies replayed context through the real renderer listener before Sift's first use", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const outbound: unknown[] = [];
  const inbound: unknown[] = [];
  const frameWindow = { postMessage: (data: unknown) => inbound.push(data) } as unknown as Window;
  const parentPost = vi.spyOn(window.parent, "postMessage").mockImplementation((data) => {
    outbound.push(data);
  });
  const addListener = vi.spyOn(window, "addEventListener");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("__installSiftForTest", install);
  const assetUrl = "https://assets.example/renderer-assets/sift_wasm.0123456789abcdef.wasm";
  const runtime = new IsolatedFrameRuntime({
    getFrameWindow: () => frameWindow,
    getInitialContent: () => ({
      mimeType: "application/vnd.apache.arrow.stream",
      outputId: "initial-table",
      data: "data:application/vnd.apache.arrow.stream;base64,/////w==",
    }),
    callbacks: {
      onBootstrapReady: vi.fn(),
      onRendererReady: vi.fn(),
      onResize: vi.fn(),
      onRenderComplete: vi.fn(),
      onLinkClick: vi.fn(),
      onMouseDown: vi.fn(),
      onMouseUp: vi.fn(),
      onDoubleClick: vi.fn(),
      onWheelBoundary: vi.fn(),
      onWidgetUpdate: vi.fn(),
      onError: vi.fn(),
      onMessage: vi.fn(),
      onDiagnostic: vi.fn(),
    },
  });
  try {
    runtime.handleWindowMessage(
      new MessageEvent("message", {
        source: frameWindow,
        data: { type: "ready" },
      }),
    );
    runtime.notifyHostContext({
      nteract: {
        rendererAssetsBaseUrl: "https://assets.example/renderer-assets/",
        siftWasmAssetName: "sift_wasm.0123456789abcdef.wasm",
      },
    });
    // Bootstrap consumed this early delivery before the React renderer existed.
    inbound.length = 0;
    runtime.installRenderer("exports.install = globalThis.__installSiftForTest;");
    runtime.render({
      mimeType: "application/vnd.apache.arrow.stream",
      outputId: "queued-table",
      data: "blob:null/6b85da0f-e0ac-4a82-87a5-a7f0379e62ea",
    });
    await act(async () => {
      await import("../index");
    });
    expect(outbound).toContainEqual({ jsonrpc: "2.0", method: NTERACT_RENDERER_READY, params: {} });
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frameWindow,
        data: { jsonrpc: "2.0", method: NTERACT_RENDERER_READY, params: {} },
      }),
    );
    // Deliver one message and flush React before the next, so batching cannot
    // hide an initial render that runs without asset context.
    for (const data of inbound) {
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", { source: window.parent, data }));
      });
    }
    expect(state.firstUse).toHaveBeenCalled();
    expect(state.firstUse.mock.calls.every(([url]) => url === assetUrl)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      for (const root of state.roots) root.unmount();
    });
    runtime.dispose();
    for (const [event, listener, options] of addListener.mock.calls) {
      window.removeEventListener(event, listener, options);
    }
    document.getElementById("root")?.remove();
    delete window.__REACT_RENDERER_ACTIVE__;
    parentPost.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
