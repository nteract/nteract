import { render } from "@testing-library/react";
import { act, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NTERACT_RENDERER_READY } from "../rpc-methods";
import type { IsolatedFrameHandle } from "../isolated-frame";

const { MockJsonRpcTransport } = vi.hoisted(() => {
  class MockJsonRpcTransport {
    static instances: MockJsonRpcTransport[] = [];

    notify = vi.fn();
    request = vi.fn(() => Promise.resolve({}));
    start = vi.fn();
    stop = vi.fn();
    notificationHandlers = new Map<string, (params: unknown) => void>();
    requestHandlers = new Map<string, (params: unknown) => unknown>();

    constructor(
      public target: Window,
      public source: MessageEventSource,
    ) {
      MockJsonRpcTransport.instances.push(this);
    }

    onNotification(method: string, handler: (params: unknown) => void) {
      this.notificationHandlers.set(method, handler);
    }

    onRequest(method: string, handler: (params: unknown) => unknown) {
      this.requestHandlers.set(method, handler);
    }
  }

  return { MockJsonRpcTransport };
});

vi.mock("../jsonrpc-transport", () => ({
  JsonRpcTransport: MockJsonRpcTransport,
}));

vi.mock("../frame-html", () => ({
  FRAME_HTML: "<!DOCTYPE html><html><body></body></html>",
  generateFrameHtml: vi.fn(() => "<!DOCTYPE html><html><body></body></html>"),
}));

vi.mock("../isolated-renderer-context", () => ({
  useRegisterIsolatedOutput: vi.fn(),
  useIsolatedRenderer: () => ({
    rendererCode: undefined,
    rendererCss: undefined,
    isLoading: false,
    error: null,
  }),
}));

import { IsolatedFrame } from "../isolated-frame";

function dispatchIframeReady(iframeWindow: Window) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframeWindow,
        data: { type: "ready", payload: null },
      }),
    );
  });
}

describe("IsolatedFrame extension requests", () => {
  beforeEach(() => {
    MockJsonRpcTransport.instances = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("forwards declared extension requests to the latest onExtensionRequest", async () => {
    const first = vi.fn(async () => "first");
    const latest = vi.fn(async (method: string, params: unknown) => ({ method, params }));
    const { container, rerender } = render(
      <IsolatedFrame extensionMethods={["test/echo"]} onExtensionRequest={first} />,
    );
    dispatchIframeReady(container.querySelector("iframe")!.contentWindow!);
    const transport = MockJsonRpcTransport.instances.at(-1)!;

    expect([...transport.requestHandlers.keys()]).toEqual(["test/echo"]);

    rerender(<IsolatedFrame extensionMethods={["test/echo"]} onExtensionRequest={latest} />);
    await expect(transport.requestHandlers.get("test/echo")?.({ value: 1 })).resolves.toEqual({
      method: "test/echo",
      params: { value: 1 },
    });
    expect(latest).toHaveBeenCalledWith("test/echo", { value: 1 });
    expect(first).not.toHaveBeenCalled();
  });

  it("serves no extension methods by default", () => {
    const { container } = render(<IsolatedFrame />);
    dispatchIframeReady(container.querySelector("iframe")!.contentWindow!);

    expect(MockJsonRpcTransport.instances.at(-1)!.requestHandlers.size).toBe(0);
  });

  it("rejects declared methods when no handler is supplied", async () => {
    const { container } = render(<IsolatedFrame extensionMethods={["test/echo"]} />);
    dispatchIframeReady(container.querySelector("iframe")!.contentWindow!);
    const handler = MockJsonRpcTransport.instances.at(-1)!.requestHandlers.get("test/echo");

    await expect(handler?.({})).rejects.toThrow("No host handler for extension method test/echo");
  });

  it("sends extension notifications through the handle once the renderer is ready", () => {
    const ref = createRef<IsolatedFrameHandle>();
    const { container } = render(<IsolatedFrame ref={ref} />);
    dispatchIframeReady(container.querySelector("iframe")!.contentWindow!);
    const transport = MockJsonRpcTransport.instances.at(-1)!;

    ref.current!.notifyExtension("test/state", { revision: 1 });
    expect(transport.notify).not.toHaveBeenCalledWith("test/state", { revision: 1 });

    act(() => {
      transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});
    });
    expect(transport.notify).toHaveBeenCalledWith("test/state", { revision: 1 });
  });
});
