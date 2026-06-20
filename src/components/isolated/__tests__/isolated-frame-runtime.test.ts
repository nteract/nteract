import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { IsolatedFrameRuntime } from "../isolated-frame-runtime";
import type { IsolatedFrameRendererBundle } from "../isolated-frame-runtime";
import {
  MCP_NOTIFICATIONS_MESSAGE,
  MCP_UI_HOST_CONTEXT_CHANGED,
  MCP_UI_RESOURCE_TEARDOWN,
  MCP_UI_SIZE_CHANGED,
  NTERACT_MEASURE_ELEMENT,
  NTERACT_MOUSE_UP,
  NTERACT_PANEL_CHANNEL_CLOSE,
  NTERACT_PANEL_CHANNEL_OPEN,
  NTERACT_PANEL_CLIENT_PATCH,
  NTERACT_RENDER_OUTPUT,
  NTERACT_RENDERER_READY,
  NTERACT_THEME,
} from "../rpc-methods";
import type { RenderPayload } from "../frame-bridge";

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

function frameMessage(source: Window, data: unknown): MessageEvent {
  return new MessageEvent("message", {
    source,
    data,
  });
}

function createRuntime(
  initialContent?: RenderPayload,
  rendererBundle?: IsolatedFrameRendererBundle,
) {
  const frameWindow = {
    postMessage: vi.fn(),
  } as unknown as Window;
  const callbacks = {
    onBootstrapReady: vi.fn(),
    onRendererReady: vi.fn(),
    onResize: vi.fn(),
    onSizeChanged: vi.fn(),
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
  };
  const runtime = new IsolatedFrameRuntime({
    getFrameWindow: () => frameWindow,
    getInitialContent: () => initialContent,
    rendererBundle,
    callbacks,
  });

  return { callbacks, frameWindow, runtime };
}

describe("IsolatedFrameRuntime", () => {
  beforeEach(() => {
    MockJsonRpcTransport.instances = [];
    vi.clearAllMocks();
  });

  it("queues render messages until the renderer is ready, then flushes over JSON-RPC", () => {
    const payload: RenderPayload = {
      mimeType: "text/plain",
      data: "queued",
      outputId: "queued-output",
    };
    const { frameWindow, runtime } = createRuntime();

    runtime.render(payload);
    expect(frameWindow.postMessage).not.toHaveBeenCalled();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();
    expect(transport.notify).not.toHaveBeenCalledWith(NTERACT_RENDER_OUTPUT, payload);

    transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    expect(transport.notify).toHaveBeenCalledWith(NTERACT_RENDER_OUTPUT, payload);
  });

  it("preserves structured MCP log notifications as isolated diagnostics", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();

    transport.notificationHandlers.get(MCP_NOTIFICATIONS_MESSAGE)?.({
      level: "warning",
      logger: "nteract.isolated-renderer",
      data: {
        source: "isolated-renderer",
        phase: "renderer-plugin-install-failed",
        details: { message: "failed" },
      },
    });

    expect(callbacks.onDiagnostic).toHaveBeenCalledWith(
      "renderer-plugin-install-failed",
      {
        logger: "nteract.isolated-renderer",
        protocol: "mcp-ui",
        message: "failed",
      },
      "warn",
      "isolated-renderer",
    );
  });

  it("forwards MCP Apps size-changed dimensions alongside legacy height resize", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();

    transport.notificationHandlers.get(MCP_UI_SIZE_CHANGED)?.({ height: 240, width: 640 });

    expect(callbacks.onSizeChanged).toHaveBeenCalledWith({ height: 240, width: 640 });
    expect(callbacks.onResize).toHaveBeenCalledWith(240);
  });

  it("forwards iframe mouse up selection state", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();

    transport.notificationHandlers.get(NTERACT_MOUSE_UP)?.({ hasSelection: true });

    expect(callbacks.onMouseUp).toHaveBeenCalledWith({ hasSelection: true });
  });

  it("forwards iframe Panel runtime notifications as typed messages", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();
    callbacks.onMessage.mockClear();

    const open = { plotId: "plot-1", commId: "comm-1" };
    const patch = {
      plotId: "plot-1",
      commId: "comm-1",
      data: { events: [{ kind: "ModelChanged" }] },
    };
    const close = { plotId: "plot-1", commId: "comm-1" };

    transport.notificationHandlers.get(NTERACT_PANEL_CHANNEL_OPEN)?.(open);
    transport.notificationHandlers.get(NTERACT_PANEL_CLIENT_PATCH)?.(patch);
    transport.notificationHandlers.get(NTERACT_PANEL_CHANNEL_CLOSE)?.(close);

    expect(callbacks.onMessage).toHaveBeenNthCalledWith(1, {
      type: "panel_channel_open",
      payload: open,
    });
    expect(callbacks.onMessage).toHaveBeenNthCalledWith(2, {
      type: "panel_client_patch",
      payload: patch,
    });
    expect(callbacks.onMessage).toHaveBeenNthCalledWith(3, {
      type: "panel_channel_close",
      payload: close,
    });
  });

  it("sends host context once per channel for equivalent content", () => {
    const { frameWindow, runtime } = createRuntime();
    const context = {
      theme: "light" as const,
      styles: {
        variables: {
          "--nteract-token": "value",
        },
      },
    };

    runtime.notifyHostContext(context);
    runtime.notifyHostContext({
      styles: {
        variables: {
          "--nteract-token": "value",
        },
      },
      theme: "light",
    });

    expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(
      { type: "host_context", payload: context },
      "*",
    );

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const transport = MockJsonRpcTransport.instances[0];
    transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    runtime.notifyHostContext(context);

    expect(transport.notify).toHaveBeenCalledWith(MCP_UI_HOST_CONTEXT_CHANGED, context);
  });

  it("sends theme over JSON-RPC once the bootstrap transport is available", () => {
    const { frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const transport = MockJsonRpcTransport.instances[0];

    runtime.setTheme(true, "dark-theme");

    expect(transport.notify).toHaveBeenCalledWith(NTERACT_THEME, {
      isDark: true,
      colorTheme: "dark-theme",
    });
    expect(frameWindow.postMessage).not.toHaveBeenCalledWith(
      { type: "theme", payload: { isDark: true, colorTheme: "dark-theme" } },
      "*",
    );
  });

  it("requests renderer element measurements only after renderer ready", async () => {
    const { frameWindow, runtime } = createRuntime();

    await expect(runtime.measureElement("heading-a")).resolves.toBeNull();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const transport = MockJsonRpcTransport.instances[0];
    transport.request.mockResolvedValueOnce({ found: true, top: 120, height: 32 });
    transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    await expect(runtime.measureElement("heading-a")).resolves.toEqual({
      found: true,
      top: 120,
      height: 32,
    });
    expect(transport.request).toHaveBeenCalledWith(NTERACT_MEASURE_ELEMENT, {
      anchorId: "heading-a",
    });
  });

  it("recreates transport and reports reloads on a second bootstrap ready", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const firstTransport = MockJsonRpcTransport.instances[0];
    firstTransport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});
    expect(runtime.isReady).toBe(true);

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));

    expect(firstTransport.stop).toHaveBeenCalled();
    expect(MockJsonRpcTransport.instances).toHaveLength(2);
    expect(runtime.isReady).toBe(false);
    expect(runtime.generation).toBe(2);
    expect(callbacks.onBootstrapReady).toHaveBeenLastCalledWith({
      isReload: true,
      generation: 2,
    });
  });

  it("drops queued renderer messages when the iframe reloads before renderer-ready", () => {
    const stalePayload: RenderPayload = {
      mimeType: "text/plain",
      data: "old iframe",
      outputId: "stale-output",
    };
    const { frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    runtime.render(stalePayload);
    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const reloadedTransport = MockJsonRpcTransport.instances[1];

    reloadedTransport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    expect(reloadedTransport.notify).not.toHaveBeenCalledWith(NTERACT_RENDER_OUTPUT, stalePayload);
  });

  it("ignores duplicate renderer-ready notifications for the current generation", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const transport = MockJsonRpcTransport.instances[0];

    transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});
    transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    expect(callbacks.onRendererReady).toHaveBeenCalledTimes(1);
  });

  it("allows JSON-RPC renderer-ready to deliver initial content after legacy ready", () => {
    const initialContent: RenderPayload = {
      mimeType: "text/markdown",
      data: "# Initial content",
      outputId: "initial-content",
    };
    const { callbacks, frameWindow, runtime } = createRuntime(initialContent);

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const transport = MockJsonRpcTransport.instances[0];
    runtime.handleWindowMessage(
      frameMessage(frameWindow, { type: "renderer_ready", payload: null }),
    );

    expect(callbacks.onRendererReady).toHaveBeenCalledTimes(1);
    expect(frameWindow.postMessage).toHaveBeenCalledWith(
      { type: "render", payload: initialContent },
      "*",
    );

    transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    expect(callbacks.onRendererReady).toHaveBeenCalledTimes(1);
    expect(transport.notify).toHaveBeenCalledWith(NTERACT_RENDER_OUTPUT, initialContent);
  });

  it("ignores stale renderer-ready notifications from a previous reload generation", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const firstTransport = MockJsonRpcTransport.instances[0];
    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const secondTransport = MockJsonRpcTransport.instances[1];

    firstTransport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    expect(runtime.isReady).toBe(false);
    expect(callbacks.onRendererReady).not.toHaveBeenCalled();

    secondTransport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    expect(runtime.isReady).toBe(true);
    expect(callbacks.onRendererReady).toHaveBeenCalledTimes(1);
  });

  it("injects renderer CSS and JS once per bootstrap generation", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    runtime.setRendererBundle({
      rendererCode: "window.__renderer = true;",
      rendererCss: "body { color: red; }",
    });

    expect(runtime.injectRendererBundle()).toBe(true);
    expect(runtime.injectRendererBundle()).toBe(false);

    expect(frameWindow.postMessage).toHaveBeenCalledTimes(2);
    expect(callbacks.onDiagnostic).toHaveBeenCalledWith(
      "renderer-bundle-injecting",
      expect.objectContaining({ hasRendererCode: true, hasRendererCss: true }),
    );
    expect(callbacks.onDiagnostic).toHaveBeenCalledWith(
      "renderer-bundle-injected",
      expect.objectContaining({ hasRendererCode: true, hasRendererCss: true }),
    );
  });

  it("uses the retained renderer bundle for bootstrap diagnostics and injection", () => {
    const { callbacks, frameWindow, runtime } = createRuntime(undefined, {
      rendererCode: "window.__storedRenderer = true;",
      rendererCss: "body { color: blue; }",
    });

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));

    expect(callbacks.onDiagnostic).toHaveBeenCalledWith(
      "bootstrap-ready",
      expect.objectContaining({ hasRendererCode: true, hasRendererCss: true }),
    );
    expect(runtime.waitingForRendererBundle()).toBe(false);
    expect(runtime.injectRendererBundle()).toBe(true);
    expect(frameWindow.postMessage).toHaveBeenNthCalledWith(
      1,
      {
        type: "eval",
        payload: { code: expect.stringContaining("body { color: blue; }") },
      },
      "*",
    );
    expect(frameWindow.postMessage).toHaveBeenNthCalledWith(
      2,
      {
        type: "eval",
        payload: { code: expect.stringContaining("window.__storedRenderer = true;") },
      },
      "*",
    );
  });

  it("replaces the retained renderer bundle rather than merging it", () => {
    const { frameWindow, runtime } = createRuntime();

    runtime.setRendererBundle({
      rendererCode: "window.__oldRenderer = true;",
      rendererCss: "body { color: orange; }",
    });
    runtime.setRendererBundle({
      rendererCode: "window.__newRenderer = true;",
      rendererCss: "body { color: green; }",
    });
    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));

    expect(runtime.injectRendererBundle()).toBe(true);
    expect(frameWindow.postMessage).toHaveBeenNthCalledWith(
      1,
      {
        type: "eval",
        payload: { code: expect.stringContaining("body { color: green; }") },
      },
      "*",
    );
    expect(frameWindow.postMessage).toHaveBeenNthCalledWith(
      2,
      {
        type: "eval",
        payload: { code: expect.stringContaining("window.__newRenderer = true;") },
      },
      "*",
    );
    expect(frameWindow.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ code: expect.stringContaining("__oldRenderer") }),
      }),
      "*",
    );
  });

  it("reports pending renderer bundles from retained state", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.setRendererBundle({ rendererCode: "window.__renderer = true;" });
    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    runtime.reportRendererBundlePending({ providerLoading: true });

    expect(callbacks.onDiagnostic).toHaveBeenCalledWith(
      "renderer-bundle-pending",
      expect.objectContaining({
        providerLoading: true,
        hasRendererCode: true,
        hasRendererCss: false,
      }),
    );
  });

  it("requests resource teardown before stopping the active transport", () => {
    const { frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    const transport = MockJsonRpcTransport.instances[0];

    runtime.dispose();

    expect(transport.request).toHaveBeenCalledWith(MCP_UI_RESOURCE_TEARDOWN, {
      reason: "unmount",
    });
  });

  it("does not recreate transport from queued messages after dispose", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));
    runtime.dispose();
    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));

    expect(MockJsonRpcTransport.instances).toHaveLength(1);
    expect(callbacks.onBootstrapReady).toHaveBeenCalledTimes(1);

    runtime.render({ mimeType: "text/plain", data: "after dispose", outputId: "after-dispose" });
    expect(frameWindow.postMessage).not.toHaveBeenCalledWith(
      {
        type: "render",
        payload: { mimeType: "text/plain", data: "after dispose", outputId: "after-dispose" },
      },
      "*",
    );
  });

  it("can reactivate after a StrictMode-style effect cleanup before iframe ready", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.dispose();
    runtime.activate();
    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }));

    expect(MockJsonRpcTransport.instances).toHaveLength(1);
    expect(callbacks.onBootstrapReady).toHaveBeenCalledWith({
      isReload: false,
      generation: 1,
    });
  });
});
