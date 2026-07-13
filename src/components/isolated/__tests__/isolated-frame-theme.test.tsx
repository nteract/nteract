import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MCP_UI_HOST_CONTEXT_CHANGED,
  MCP_UI_RESOURCE_TEARDOWN,
  MCP_UI_SIZE_CHANGED,
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

  it("seeds hosted output-document URLs with the mount-time theme without reloading on theme changes", async () => {
    const { container, rerender } = render(
      <IsolatedFrame
        darkMode={false}
        colorTheme="cream"
        outputDocumentUrl="https://outputs.example/frame/"
      />,
    );

    const iframe = container.querySelector("iframe") as HTMLIFrameElement;

    await waitFor(() => {
      expect(iframe.src).toBe(
        "https://outputs.example/frame/?nteract_theme=light&nteract_color_theme=cream",
      );
    });

    rerender(
      <IsolatedFrame
        darkMode={true}
        colorTheme="cream"
        outputDocumentUrl="https://outputs.example/frame/"
      />,
    );

    expect(iframe.src).toBe(
      "https://outputs.example/frame/?nteract_theme=light&nteract_color_theme=cream",
    );
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

  it("delivers imperative theme changes through the bootstrap transport before renderer-ready", () => {
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
    transport.notify.mockClear();

    act(() => {
      frameRef.current?.setTheme(true, "imperative-dark");
    });

    expect(transport.notify).toHaveBeenCalledWith(NTERACT_THEME, {
      isDark: true,
      colorTheme: "imperative-dark",
    });
  });

  it("does not resend an unchanged host context when parent prop identity changes", async () => {
    const makeHostContext = (color: string) => ({
      styles: {
        variables: {
          "--nteract-test-token": color,
        },
      },
    });
    const { container, rerender } = render(
      <IsolatedFrame darkMode={false} hostContext={makeHostContext("same")} />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const iframeWindow = iframe.contentWindow as Window;

    dispatchIframeReady(iframeWindow);

    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();

    act(() => {
      transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});
    });

    await waitFor(() => {
      expect(
        transport.notify.mock.calls.filter(([method]) => method === MCP_UI_HOST_CONTEXT_CHANGED),
      ).toHaveLength(1);
    });

    rerender(<IsolatedFrame darkMode={false} hostContext={makeHostContext("same")} />);

    expect(
      transport.notify.mock.calls.filter(([method]) => method === MCP_UI_HOST_CONTEXT_CHANGED),
    ).toHaveLength(1);

    rerender(<IsolatedFrame darkMode={false} hostContext={makeHostContext("changed")} />);

    await waitFor(() => {
      expect(
        transport.notify.mock.calls.filter(([method]) => method === MCP_UI_HOST_CONTEXT_CHANGED),
      ).toHaveLength(2);
    });
  });

  it("keeps the JSON-RPC transport alive when frame diagnostics props change", () => {
    const onDiagnosticA = vi.fn();
    const onDiagnosticB = vi.fn();
    const { container, rerender, unmount } = render(
      <IsolatedFrame darkMode={false} name="code-Out[*]" onDiagnostic={onDiagnosticA} />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const iframeWindow = iframe.contentWindow as Window;

    dispatchIframeReady(iframeWindow);
    expect(onDiagnosticA).toHaveBeenCalledWith(
      "bootstrap-ready",
      expect.objectContaining({ frameName: "code-Out[*]" }),
      "debug",
      "isolated-frame",
    );

    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();

    act(() => {
      transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});
    });

    rerender(<IsolatedFrame darkMode={false} name="code-Out[1]" onDiagnostic={onDiagnosticB} />);

    expect(transport.stop).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalledWith(MCP_UI_RESOURCE_TEARDOWN, {
      reason: "unmount",
    });

    act(() => {
      transport.notificationHandlers.get(MCP_UI_SIZE_CHANGED)?.({ height: 42, width: 320 });
    });

    expect(onDiagnosticB).toHaveBeenCalledWith(
      "size-changed",
      expect.objectContaining({ frameName: "code-Out[1]", height: 42, width: 320 }),
      "debug",
      "isolated-frame",
    );

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

  it("can reserve frame height while content is hidden for reveal-on-render", () => {
    const { container } = render(
      <IsolatedFrame darkMode={false} minHeight={180} revealOnRender reserveHeightOnReveal />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;

    expect(iframe.style.height).toBe("180px");
    expect(iframe.style.opacity).toBe("0");
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

  it("adds the initial hosted theme hint without reloading on theme changes", () => {
    const { container, rerender } = render(
      <IsolatedFrame darkMode={false} outputDocumentUrl="https://outputs.example/frame/" />,
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;

    expect(iframe.getAttribute("src")).toBe("https://outputs.example/frame/?nteract_theme=light");

    rerender(<IsolatedFrame darkMode outputDocumentUrl="https://outputs.example/frame/" />);

    expect(iframe.getAttribute("src")).toBe("https://outputs.example/frame/?nteract_theme=light");
  });
});
