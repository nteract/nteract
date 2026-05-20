import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { IsolatedFrameRuntime } from "../isolated-frame-runtime";
import {
  MCP_UI_HOST_CONTEXT_CHANGED,
  MCP_UI_RESOURCE_TEARDOWN,
  NTERACT_RENDER_OUTPUT,
  NTERACT_RENDERER_READY,
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

function createRuntime(initialContent?: RenderPayload) {
  const frameWindow = {
    postMessage: vi.fn(),
  } as unknown as Window;
  const callbacks = {
    onBootstrapReady: vi.fn(),
    onRendererReady: vi.fn(),
    onResize: vi.fn(),
    onRenderComplete: vi.fn(),
    onLinkClick: vi.fn(),
    onMouseDown: vi.fn(),
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
    };
    const { frameWindow, runtime } = createRuntime();

    runtime.render(payload);
    expect(frameWindow.postMessage).not.toHaveBeenCalled();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }), {});
    const transport = MockJsonRpcTransport.instances[0];
    expect(transport).toBeDefined();
    expect(transport.notify).not.toHaveBeenCalledWith(NTERACT_RENDER_OUTPUT, payload);

    transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    expect(transport.notify).toHaveBeenCalledWith(NTERACT_RENDER_OUTPUT, payload);
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

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }), {});
    const transport = MockJsonRpcTransport.instances[0];
    transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    runtime.notifyHostContext(context);

    expect(transport.notify).toHaveBeenCalledWith(MCP_UI_HOST_CONTEXT_CHANGED, context);
  });

  it("recreates transport and reports reloads on a second bootstrap ready", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }), {});
    const firstTransport = MockJsonRpcTransport.instances[0];
    firstTransport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});
    expect(runtime.isReady).toBe(true);

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }), {});

    expect(firstTransport.stop).toHaveBeenCalled();
    expect(MockJsonRpcTransport.instances).toHaveLength(2);
    expect(runtime.isReady).toBe(false);
    expect(runtime.generation).toBe(2);
    expect(callbacks.onBootstrapReady).toHaveBeenLastCalledWith({
      isReload: true,
      generation: 2,
    });
  });

  it("injects renderer CSS and JS once per bootstrap generation", () => {
    const { callbacks, frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }), {});

    expect(
      runtime.injectRendererBundle({
        rendererCode: "window.__renderer = true;",
        rendererCss: "body { color: red; }",
      }),
    ).toBe(true);
    expect(
      runtime.injectRendererBundle({
        rendererCode: "window.__renderer = true;",
        rendererCss: "body { color: red; }",
      }),
    ).toBe(false);

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

  it("requests resource teardown before stopping the active transport", () => {
    const { frameWindow, runtime } = createRuntime();

    runtime.handleWindowMessage(frameMessage(frameWindow, { type: "ready", payload: null }), {});
    const transport = MockJsonRpcTransport.instances[0];

    runtime.dispose();

    expect(transport.request).toHaveBeenCalledWith(MCP_UI_RESOURCE_TEARDOWN, {
      reason: "unmount",
    });
  });
});
