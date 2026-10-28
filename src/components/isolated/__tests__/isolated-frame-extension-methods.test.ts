import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { IsolatedFrameRuntime } from "../isolated-frame-runtime";

// Uses the real JsonRpcTransport so method-not-found replies come from the
// same dispatch the iframe sees.
function createRuntime(
  extensionMethods: readonly string[],
  onExtensionRequest: (method: string, params: unknown) => Promise<unknown>,
) {
  const frameWindow = { postMessage: vi.fn() } as unknown as Window;
  const runtime = new IsolatedFrameRuntime({
    getFrameWindow: () => frameWindow,
    getExtensionMethods: () => extensionMethods,
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
      onExtensionRequest,
      onError: vi.fn(),
      onMessage: vi.fn(),
      onDiagnostic: vi.fn(),
    },
  });
  runtime.activate();
  runtime.handleWindowMessage(
    new MessageEvent("message", { source: frameWindow, data: { type: "ready", payload: null } }),
  );
  return { frameWindow, runtime };
}

function requestFromFrame(frameWindow: Window, id: number, method: string, params: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frameWindow,
      data: { jsonrpc: "2.0", id, method, params },
    }),
  );
}

describe("IsolatedFrameRuntime extension requests over JSON-RPC", () => {
  let runtime: IsolatedFrameRuntime | null = null;

  afterEach(() => {
    runtime?.dispose();
    runtime = null;
  });

  it("serves registered host methods and answers others with method not found", async () => {
    const onExtensionRequest = vi.fn(async (method: string, params: unknown) => ({
      served: method,
      params,
    }));
    const created = createRuntime(["test/echo"], onExtensionRequest);
    runtime = created.runtime;
    const postMessage = vi.mocked(created.frameWindow.postMessage);

    requestFromFrame(created.frameWindow, 1, "test/echo", { value: 1 });
    requestFromFrame(created.frameWindow, 2, "nteract/bokehSessionOpen", { sessionId: "s" });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        { jsonrpc: "2.0", id: 1, result: { served: "test/echo", params: { value: 1 } } },
        "*",
      );
    });
    expect(postMessage).toHaveBeenCalledWith(
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32601, message: "Method not found: nteract/bokehSessionOpen" },
      },
      "*",
    );
    expect(onExtensionRequest).toHaveBeenCalledTimes(1);
  });

  it("returns handler rejections as JSON-RPC errors", async () => {
    const created = createRuntime(["test/fail"], async () => {
      throw new Error("session unavailable");
    });
    runtime = created.runtime;

    requestFromFrame(created.frameWindow, 7, "test/fail", {});

    await vi.waitFor(() => {
      expect(created.frameWindow.postMessage).toHaveBeenCalledWith(
        { jsonrpc: "2.0", id: 7, error: { code: -32000, message: "session unavailable" } },
        "*",
      );
    });
  });
});
