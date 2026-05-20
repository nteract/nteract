import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MCP_UI_HOST_CONTEXT_CHANGED,
  MCP_UI_RESOURCE_TEARDOWN,
  NTERACT_RENDERER_READY,
  NTERACT_RESIZE,
  NTERACT_THEME,
} from "../rpc-methods";
import type { IsolatedFrameHandle } from "../isolated-frame";

const { MockJsonRpcTransport } = vi.hoisted(() => {
  class MockJsonRpcTransport {
    static instances: MockJsonRpcTransport[] = [];

    notify = vi.fn();
    request = vi.fn(() => Promise.resolve({}));
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
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
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

    await waitFor(() => {
      expect(transport.notify).toHaveBeenCalledWith(
        MCP_UI_HOST_CONTEXT_CHANGED,
        expect.objectContaining({
          theme: "light",
          nteract: { colorTheme: "cream" },
          styles: expect.objectContaining({
            variables: expect.objectContaining({
              "--color-text-primary": "#1e1a18",
              "--output-document-font": 'KaTeX_Main, Georgia, "Times New Roman", serif',
            }),
          }),
        }),
      );
    });
  });

  it("merges imperative host-context updates into MCP Apps-compatible notifications", async () => {
    const frameRef = { current: null as IsolatedFrameHandle | null };
    const { container } = render(
      <IsolatedFrame
        ref={(handle) => {
          frameRef.current = handle;
        }}
        darkMode={false}
      />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const iframeWindow = iframe.contentWindow as Window;

    dispatchIframeReady(iframeWindow);

    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();

    act(() => {
      transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});
    });

    act(() => {
      frameRef.current?.setHostContext({
        styles: {
          variables: {
            "--nteract-test-token": "host-context",
          },
        },
      });
    });

    await waitFor(() => {
      expect(transport.notify).toHaveBeenCalledWith(
        MCP_UI_HOST_CONTEXT_CHANGED,
        expect.objectContaining({
          styles: expect.objectContaining({
            variables: expect.objectContaining({
              "--nteract-test-token": "host-context",
            }),
          }),
        }),
      );
    });
  });

  it("keeps the JSON-RPC transport alive when frame diagnostics props change", () => {
    const { container, rerender, unmount } = render(
      <IsolatedFrame darkMode={false} name="code-Out[*]" />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const iframeWindow = iframe.contentWindow as Window;

    dispatchIframeReady(iframeWindow);

    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();

    act(() => {
      transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});
    });

    rerender(<IsolatedFrame darkMode={false} name="code-Out[1]" />);

    expect(transport.stop).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalledWith(MCP_UI_RESOURCE_TEARDOWN, {
      reason: "unmount",
    });

    unmount();

    expect(transport.request).toHaveBeenCalledWith(MCP_UI_RESOURCE_TEARDOWN, {
      reason: "unmount",
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

  it("uses nteract-frame://localhost/ src in Tauri runtime", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    const { container } = render(<IsolatedFrame darkMode={false} />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;

    expect(iframe.getAttribute("src")).toBe("nteract-frame://localhost/");
    expect(iframe.getAttribute("srcdoc")).toBeNull();
  });
});
