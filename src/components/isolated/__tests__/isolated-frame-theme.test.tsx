import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NTERACT_RENDERER_READY, NTERACT_RESIZE, NTERACT_THEME } from "../rpc-methods";

const { MockJsonRpcTransport } = vi.hoisted(() => {
  class MockJsonRpcTransport {
    static instances: MockJsonRpcTransport[] = [];

    notify = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    notificationHandlers = new Map<string, (params: unknown) => void>();

    constructor(
      public target: Window,
      public source: MessageEventSource,
    ) {
      MockJsonRpcTransport.instances.push(this);
    }

    onNotification(method: string, handler: (params: unknown) => void) {
      this.notificationHandlers.set(method, handler);
    }
  }

  return { MockJsonRpcTransport };
});

vi.mock("../jsonrpc-transport", () => ({
  JsonRpcTransport: MockJsonRpcTransport,
}));

vi.mock("../frame-html", () => ({
  createFrameBlobUrl: vi.fn(() => "blob:isolated-frame-test"),
  generateFrameHtml: vi.fn(() => "<!DOCTYPE html><html><body></body></html>"),
}));

vi.mock("../isolated-renderer-context", () => ({
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

describe("IsolatedFrame theme updates", () => {
  beforeEach(() => {
    MockJsonRpcTransport.instances = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses JSON-RPC for live color-theme updates after the renderer is ready", async () => {
    const { container, rerender } = render(
      <IsolatedFrame darkMode={false} colorTheme={undefined} />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const iframeWindow = iframe.contentWindow as Window;

    dispatchIframeReady(iframeWindow);

    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();

    act(() => {
      transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});
    });

    rerender(<IsolatedFrame darkMode={false} colorTheme="cream" />);

    await waitFor(() => {
      expect(transport.notify).toHaveBeenCalledWith(NTERACT_THEME, {
        isDark: false,
        colorTheme: "cream",
      });
    });
  });

  it("re-applies the last measured content height when autoHeight changes", async () => {
    const { container, rerender } = render(
      <IsolatedFrame darkMode={false} maxHeight={2000} autoHeight={false} />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const iframeWindow = iframe.contentWindow as Window;

    dispatchIframeReady(iframeWindow);

    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();

    act(() => {
      transport.notificationHandlers.get(NTERACT_RESIZE)?.({ height: 2600 });
    });

    expect(iframe.style.height).toBe("2000px");

    rerender(<IsolatedFrame darkMode={false} maxHeight={2000} autoHeight />);

    await waitFor(() => {
      expect(iframe.style.height).toBe("2600px");
    });
  });

  it("can make static frames transparent to parent scroll hit-testing", () => {
    const { container } = render(<IsolatedFrame darkMode={false} scrollPassthrough />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;

    expect(iframe.style.pointerEvents).toBe("none");
  });

  it("uses srcdoc in a non-Tauri browser runtime", () => {
    const { container } = render(<IsolatedFrame darkMode={false} />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;

    expect(iframe.getAttribute("srcdoc")).toContain("<!DOCTYPE html>");
    expect(iframe.getAttribute("src")).toBeNull();
  });
});
