import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BOKEHJS_EXEC_MIME_TYPE,
  BOKEHJS_LOAD_MIME_TYPE,
  NTERACT_BOKEH_SESSION_MIME_TYPE,
} from "@/components/outputs/bokeh-mime";
import type { RendererProps } from "@/lib/renderer-registry";
import { NTERACT_BOKEH_SESSION_STATE } from "@/components/isolated/rpc-methods";
import { install } from "../bokeh-renderer";

function installBokehRenderer(
  options: {
    requestHost?: (method: string, params?: unknown) => Promise<unknown>;
    subscribeHostNotification?: (method: string, listener: (params: unknown) => void) => () => void;
  } = {},
) {
  const renderers = new Map<string, ComponentType<RendererProps>>();

  install({
    register: (mimeTypes, component) => {
      for (const mimeType of mimeTypes) renderers.set(mimeType, component);
    },
    registerPattern: () => {},
    getHostContext: () => undefined,
    subscribeHostContext: () => () => {},
    requestHost: options.requestHost ?? (() => Promise.reject(new Error("not configured"))),
    notifyHost: () => {},
    subscribeHostNotification: options.subscribeHostNotification ?? (() => () => {}),
  });

  const Renderer = renderers.get(BOKEHJS_EXEC_MIME_TYPE);
  expect(Renderer).toBeDefined();
  return {
    Renderer: Renderer!,
    NativeRenderer: renderers.get(NTERACT_BOKEH_SESSION_MIME_TYPE)!,
    registeredMimeTypes: [...renderers.keys()],
  };
}

function stubAnimationFrames() {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
}

function stubBokehCdnLoads() {
  const appendedSrcs: string[] = [];
  const appendChild = vi.spyOn(HTMLHeadElement.prototype, "appendChild");

  appendChild.mockImplementation(function appendBokehScript(
    this: HTMLHeadElement,
    node: Node,
  ): Node {
    if (node instanceof HTMLScriptElement && node.src) {
      appendedSrcs.push(node.src);
      if (node.src.includes("bokeh-3.9.1.min.js")) {
        window.Bokeh = {};
      }
      queueMicrotask(() => node.onload?.(new Event("load")));
    }
    return Node.prototype.appendChild.call(this, node);
  });

  return appendedSrcs;
}

function renderedScripts(container: HTMLElement): HTMLScriptElement[] {
  return Array.from(container.querySelectorAll("script"));
}

describe("Bokeh renderer plugin", () => {
  beforeEach(() => {
    stubAnimationFrames();
    window.Bokeh = undefined;
    window.__nteractBokehLoadPromise__ = undefined;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.Bokeh = undefined;
    window.__nteractBokehLoadPromise__ = undefined;
  });

  it("registers Bokeh load and exec MIME types", () => {
    const { registeredMimeTypes } = installBokehRenderer();

    expect(registeredMimeTypes).toEqual([
      BOKEHJS_LOAD_MIME_TYPE,
      BOKEHJS_EXEC_MIME_TYPE,
      NTERACT_BOKEH_SESSION_MIME_TYPE,
    ]);
  });

  it("loads matching BokehJS resources before appending standalone exec output", async () => {
    const appendedSrcs = stubBokehCdnLoads();
    const { Renderer } = installBokehRenderer();
    const { container } = render(
      <Renderer
        data={{
          "application/javascript": `
            const docs_json = {"docid": {"version": "3.9.1"}};
            window.__bokehExecRan = true;
          `,
          [BOKEHJS_EXEC_MIME_TYPE]: "",
        }}
        metadata={{ id: "p1011" }}
        mimeType={BOKEHJS_EXEC_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(renderedScripts(container).at(-1)?.textContent).toContain("__bokehExecRan");
    });

    expect(appendedSrcs).toEqual([
      "https://cdn.bokeh.org/bokeh/release/bokeh-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-gl-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-widgets-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-tables-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-mathjax-3.9.1.min.js",
    ]);
  });

  it("uses an already-loaded BokehJS runtime without adding CDN scripts", async () => {
    const appendedSrcs = stubBokehCdnLoads();
    const { Renderer } = installBokehRenderer();
    window.Bokeh = {};

    const { container } = render(
      <Renderer
        data={{
          "application/javascript": "window.__bokehExecRan = true;",
          [BOKEHJS_EXEC_MIME_TYPE]: "",
        }}
        metadata={{ id: "p1011" }}
        mimeType={BOKEHJS_EXEC_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(renderedScripts(container).at(-1)?.textContent).toContain("__bokehExecRan");
    });

    expect(appendedSrcs).toEqual([]);
  });

  it("keeps an equivalent exec payload mounted without clearing the Bokeh document", async () => {
    const { Renderer } = installBokehRenderer();
    const clear = vi.fn();
    const deleteView = vi.fn();
    const view = { model: { document: { clear } } };
    window.Bokeh = {
      index: {
        get_by_id: vi.fn(() => view),
        delete: deleteView,
      },
    };

    const code = "window.__bokehExecRan = true;";
    const { container, rerender } = render(
      <Renderer
        data={{
          "application/javascript": code,
          [BOKEHJS_EXEC_MIME_TYPE]: "",
        }}
        metadata={{ id: "p1011" }}
        mimeType={BOKEHJS_EXEC_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(renderedScripts(container).at(-1)?.textContent).toBe(code);
    });

    rerender(
      <Renderer
        data={{
          "application/javascript": code,
          [BOKEHJS_EXEC_MIME_TYPE]: "",
        }}
        metadata={{ id: "p1011" }}
        mimeType={BOKEHJS_EXEC_MIME_TYPE}
      />,
    );

    expect(clear).not.toHaveBeenCalled();
    expect(deleteView).not.toHaveBeenCalled();
    expect(renderedScripts(container)).toHaveLength(1);
  });

  it("renders sibling Bokeh exec HTML before appending JavaScript", async () => {
    const appendedSrcs = stubBokehCdnLoads();
    const { Renderer } = installBokehRenderer();
    window.Bokeh = {};

    const { container } = render(
      <Renderer
        data={{
          "text/html":
            '<div id="bokeh-root">Bokeh root</div><script>window.__bokehHtmlRan = true;</script>',
          "application/javascript": "window.__bokehExecRan = true;",
          [BOKEHJS_EXEC_MIME_TYPE]: "",
        }}
        metadata={{ id: "p1011" }}
        mimeType={BOKEHJS_EXEC_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("#bokeh-root")?.textContent).toBe("Bokeh root");
      expect(renderedScripts(container).map((script) => script.textContent)).toEqual([
        "window.__bokehHtmlRan = true;",
        "window.__bokehExecRan = true;",
      ]);
    });

    expect(appendedSrcs).toEqual([]);
  });

  it("appends Bokeh load MIME JavaScript directly", async () => {
    const { Renderer } = installBokehRenderer();
    const { container } = render(
      <Renderer
        data={{
          "application/javascript": "window.Bokeh = {};",
          [BOKEHJS_LOAD_MIME_TYPE]: "window.Bokeh = {};",
        }}
        mimeType={BOKEHJS_LOAD_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(renderedScripts(container).at(-1)?.textContent).toBe("window.Bokeh = {};");
    });
  });

  it("mounts a native document session from the host snapshot", async () => {
    const fakeDocument = {
      all_roots: [{ id: "root-1" }],
      on_change: vi.fn(),
      remove_on_change: vi.fn(),
      create_json_patch: vi.fn(),
      apply_json_patch: vi.fn(),
      clear: vi.fn(),
    };
    const addDocumentStandalone = vi.fn(async (_document: unknown, element: HTMLElement) => {
      const root = document.createElement("div");
      root.dataset.testid = "native-bokeh-root";
      element.appendChild(root);
      return { clear: vi.fn() };
    });
    class BufferValue {
      constructor(readonly buffer: ArrayBuffer) {}
    }
    window.Bokeh = {
      version: "3.9.1",
      require: (name) => {
        if (name === "document") return { Document: { from_json: () => fakeDocument } };
        if (name === "embed/standalone") {
          return { add_document_standalone: addDocumentStandalone };
        }
        if (name === "core/serialization") return { Buffer: BufferValue };
        return {};
      },
    };
    const requestHost = vi.fn(async () => ({
      schemaVersion: 1,
      sessionId: "session-1",
      outputId: "output-1",
      status: "connected",
      headRevision: 0,
      checkpoint: { revision: 0, document: { roots: [{ id: "root-1" }] }, buffers: [] },
      patchTail: [],
    }));
    const notifications = new Map<string, (params: unknown) => void>();
    const subscribeHostNotification = vi.fn(
      (method: string, listener: (params: unknown) => void) => {
        notifications.set(method, listener);
        return () => notifications.delete(method);
      },
    );
    const { NativeRenderer } = installBokehRenderer({
      requestHost,
      subscribeHostNotification,
    });
    const { container } = render(
      <NativeRenderer
        data={{
          schema_version: 1,
          session_id: "session-1",
          revision: 0,
          producer: { name: "panel", version: "1.9.3" },
          bokeh_version: "3.9.1",
          document: { roots: [{ id: "root-1" }] },
          root_ids: ["root-1"],
          resources: {
            javascript: [],
            stylesheets: [],
            javascript_modules: [],
            module_exports: {},
          },
          buffers: [],
        }}
        mimeType={NTERACT_BOKEH_SESSION_MIME_TYPE}
        outputId="output-1"
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="native-bokeh-root"]')).not.toBeNull();
    });
    expect(requestHost).toHaveBeenCalledWith("nteract/bokehSessionOpen", {
      sessionId: "session-1",
      outputId: "output-1",
    });

    await act(async () => {
      notifications.get(NTERACT_BOKEH_SESSION_STATE)?.({
        sessionId: "session-1",
        outputId: "output-1",
        status: "disconnected",
        headRevision: 0,
      });
    });
    expect(container).toHaveTextContent("Disconnected");
    expect(container.querySelector('[data-testid="native-bokeh-root"]')).not.toBeNull();
  });
});
