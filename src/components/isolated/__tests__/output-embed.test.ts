import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createNteractOutputEmbed } from "../output-embed";
import { ISOLATED_FRAME_SANDBOX_ATTRS } from "../frame-config";
import {
  NTERACT_INSTALL_RENDERER,
  NTERACT_RENDER_OUTPUT,
  NTERACT_RENDERER_READY,
} from "../rpc-methods";

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

function bootstrapFrame(frameWindow: Window) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frameWindow,
      data: { type: "ready", payload: null },
    }),
  );
}

function flushAsyncWork() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("createNteractOutputEmbed", () => {
  beforeEach(() => {
    MockJsonRpcTransport.instances = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("creates a sandboxed iframe and disposes it", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);

    const handle = createNteractOutputEmbed({
      target,
      rendererBundle: { rendererCode: "", rendererCss: "" },
    });

    expect(target.querySelector("iframe")).toBe(handle.iframe);
    expect(handle.iframe.getAttribute("sandbox")).toBe(ISOLATED_FRAME_SANDBOX_ATTRS);
    expect(handle.iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(handle.iframe.getAttribute("allow")).toBe("fullscreen *");

    handle.dispose();

    expect(target.querySelector("iframe")).toBeNull();
  });

  it("loads the isolated frame from the host configured output document URL", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);

    const handle = createNteractOutputEmbed({
      target,
      rendererBundle: { rendererCode: "", rendererCss: "" },
      outputDocumentUrl: "https://outputs.example/frame/",
    });

    expect(handle.iframe.getAttribute("src")).toBe("https://outputs.example/frame/");
    expect(handle.iframe.getAttribute("srcdoc")).toBeNull();
    expect(handle.iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");

    handle.dispose();
  });

  it("advertises and enforces capped height when auto-height is disabled", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const onSizeChanged = vi.fn();

    const handle = createNteractOutputEmbed({
      target,
      rendererBundle: { rendererCode: "", rendererCss: "" },
      autoHeight: false,
      maxHeight: 400,
      onSizeChanged,
    });
    const frameWindow = handle.iframe.contentWindow!;

    expect(onSizeChanged).toHaveBeenCalledWith(expect.objectContaining({ maxHeight: 400 }));

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frameWindow,
        data: { type: "resize", payload: { height: 900 } },
      }),
    );

    expect(handle.iframe.style.height).toBe("400px");
    expect(onSizeChanged).toHaveBeenCalledWith({ height: 400 });

    handle.dispose();
  });

  it("loads an async renderer bundle after bootstrap", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const provider = vi.fn(async () => ({
      rendererCode: "window.__vanillaRenderer = true;",
      rendererCss: "body { color: red; }",
    }));

    const handle = createNteractOutputEmbed({ target, rendererBundle: provider });
    const frameWindow = handle.iframe.contentWindow!;
    const postMessage = vi.spyOn(frameWindow, "postMessage");

    bootstrapFrame(frameWindow);
    await flushAsyncWork();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "eval",
        payload: { code: expect.stringContaining("body { color: red; }") },
      },
      "*",
    );
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "eval",
        payload: { code: expect.stringContaining("__vanillaRenderer") },
      },
      "*",
    );
  });

  it("queues renders until renderer-ready", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);

    const handle = createNteractOutputEmbed({
      target,
      rendererBundle: { rendererCode: "", rendererCss: "" },
    });
    const frameWindow = handle.iframe.contentWindow!;

    await handle.render({
      mimeType: "text/plain",
      data: "queued output",
      outputId: "queued-output",
    });
    bootstrapFrame(frameWindow);
    const transport = MockJsonRpcTransport.instances[0];
    expect(transport.notify).not.toHaveBeenCalledWith(
      NTERACT_RENDER_OUTPUT,
      expect.objectContaining({ data: "queued output" }),
    );

    transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    expect(transport.notify).toHaveBeenCalledWith(
      NTERACT_RENDER_OUTPUT,
      expect.objectContaining({ data: "queued output" }),
    );
  });

  it("uses a custom renderer plugin loader before rendering plugin-backed outputs", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const rendererPluginLoader = vi.fn(async (mime: string) =>
      mime === "text/markdown" ? { code: "markdown plugin", css: ".markdown{}" } : undefined,
    );

    const handle = createNteractOutputEmbed({
      target,
      rendererBundle: { rendererCode: "", rendererCss: "" },
      rendererPluginLoader,
    });
    const frameWindow = handle.iframe.contentWindow!;
    bootstrapFrame(frameWindow);
    const transport = MockJsonRpcTransport.instances[0];
    transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    await handle.render({
      mimeType: "text/markdown",
      data: "**hello**",
      outputId: "markdown-output",
    });

    expect(rendererPluginLoader).toHaveBeenCalledWith("text/markdown");
    expect(transport.notify).toHaveBeenCalledWith(NTERACT_INSTALL_RENDERER, {
      code: "markdown plugin",
      css: ".markdown{}",
    });
    expect(transport.notify).toHaveBeenCalledWith(
      NTERACT_RENDER_OUTPUT,
      expect.objectContaining({ mimeType: "text/markdown", data: "**hello**" }),
    );
  });

  it("installs one shared renderer plugin for multiple MIME aliases", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const rendererPluginLoader = vi.fn(async (mime: string) =>
      mime === "text/markdown" || mime === "text/latex"
        ? { id: "markdown", code: "markdown plugin", css: ".markdown{}" }
        : undefined,
    );

    const handle = createNteractOutputEmbed({
      target,
      rendererBundle: { rendererCode: "", rendererCss: "" },
      rendererPluginLoader,
    });
    const frameWindow = handle.iframe.contentWindow!;
    bootstrapFrame(frameWindow);
    const transport = MockJsonRpcTransport.instances[0];
    transport.notificationHandlers.get(NTERACT_RENDERER_READY)?.({});

    await handle.renderBatch([
      {
        mimeType: "text/markdown",
        data: "**hello**",
        outputId: "markdown-output",
      },
      {
        mimeType: "text/latex",
        data: "$x$",
        outputId: "latex-output",
      },
    ]);

    expect(rendererPluginLoader).toHaveBeenCalledWith("text/markdown");
    expect(rendererPluginLoader).not.toHaveBeenCalledWith("text/latex");
    expect(transport.notify).toHaveBeenCalledWith(NTERACT_INSTALL_RENDERER, {
      code: "markdown plugin",
      css: ".markdown{}",
    });
    expect(
      transport.notify.mock.calls.filter(([method]) => method === NTERACT_INSTALL_RENDERER),
    ).toHaveLength(1);
  });

  it("reports renderer bundle provider failures", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const onDiagnostic = vi.fn();
    const onError = vi.fn();

    const handle = createNteractOutputEmbed({
      target,
      rendererBundle: async () => {
        throw new Error("bundle failed");
      },
      onDiagnostic,
      onError,
    });

    bootstrapFrame(handle.iframe.contentWindow!);
    await flushAsyncWork();

    expect(onDiagnostic).toHaveBeenCalledWith(
      "renderer-bundle-provider-error",
      { message: "bundle failed" },
      "error",
      "isolated-frame",
    );
    expect(onError).toHaveBeenCalledWith({ message: "bundle failed" });
  });

  it("reports initial output resolution failures", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const onDiagnostic = vi.fn();
    const onError = vi.fn();

    createNteractOutputEmbed({
      target,
      output: "not json",
      rendererBundle: { rendererCode: "", rendererCss: "" },
      onDiagnostic,
      onError,
    });

    await flushAsyncWork();

    expect(onDiagnostic).toHaveBeenCalledWith(
      "output-resolution-error",
      expect.objectContaining({
        message: expect.stringContaining("Failed to parse embeddable output JSON"),
      }),
      "error",
      "isolated-frame",
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Failed to parse embeddable output JSON"),
      }),
    );
  });
});
