import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  NTERACT_PANEL_RUNTIME_MIME_TYPE,
  PANEL_EXEC_MIME_TYPE,
  PANEL_LOAD_MIME_TYPE,
} from "@/components/outputs/panel-mime";
import type { RendererProps } from "@/lib/renderer-registry";
import { install } from "../panel-renderer";

function installPanelRenderer() {
  let Renderer: ComponentType<RendererProps> | undefined;
  let registeredMimeTypes: string[] = [];

  install({
    register: (mimeTypes, component) => {
      registeredMimeTypes = mimeTypes;
      Renderer = component;
    },
  });

  expect(Renderer).toBeDefined();
  return { Renderer: Renderer!, registeredMimeTypes };
}

function stubAnimationFrames() {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
}

function stubPanelRuntime() {
  (window as typeof window & { Bokeh?: unknown }).Bokeh = { Panel: {}, index: {} };
}

function stubPanelResourceLoads() {
  const appendedSrcs: string[] = [];
  const appendChild = vi.spyOn(HTMLHeadElement.prototype, "appendChild");

  appendChild.mockImplementation(function appendPanelScript(
    this: HTMLHeadElement,
    node: Node,
  ): Node {
    if (node instanceof HTMLScriptElement && node.src) {
      appendedSrcs.push(node.src);
      if (node.src.includes("cdn.bokeh.org/bokeh/release/")) {
        (window as typeof window & { Bokeh?: unknown }).Bokeh = {
          version: "3.9.1",
          index: {},
        };
      }
      if (node.src.includes("panel.min.js")) {
        const target = window as typeof window & {
          Bokeh?: { Panel?: unknown; version?: string; index?: Record<string, unknown> };
        };
        target.Bokeh ??= { version: "3.9.1", index: {} };
        target.Bokeh.Panel = {};
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

function removePanelLoaderScripts() {
  for (const script of document.querySelectorAll("script[data-nteract-panel-src]")) {
    script.remove();
  }
}

describe("Panel renderer plugin", () => {
  beforeEach(() => {
    stubAnimationFrames();
    removePanelLoaderScripts();
    delete (window as typeof window & { PyViz?: unknown }).PyViz;
    delete (window as typeof window & { Bokeh?: unknown }).Bokeh;
    delete (window as typeof window & { __nteractBokehLoadPromise__?: unknown })
      .__nteractBokehLoadPromise__;
    delete (window as typeof window & { __nteractPanelLoadPromises__?: unknown })
      .__nteractPanelLoadPromises__;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    removePanelLoaderScripts();
    delete (window as typeof window & { PyViz?: unknown }).PyViz;
    delete (window as typeof window & { Bokeh?: unknown }).Bokeh;
    delete (window as typeof window & { __nteractBokehLoadPromise__?: unknown })
      .__nteractBokehLoadPromise__;
    delete (window as typeof window & { __nteractPanelLoadPromises__?: unknown })
      .__nteractPanelLoadPromises__;
  });

  it("registers Panel load and exec MIME types", () => {
    const { registeredMimeTypes } = installPanelRenderer();

    expect(registeredMimeTypes).toEqual([
      PANEL_LOAD_MIME_TYPE,
      PANEL_EXEC_MIME_TYPE,
      NTERACT_PANEL_RUNTIME_MIME_TYPE,
    ]);
  });

  it("appends Panel load MIME JavaScript directly", async () => {
    const { Renderer } = installPanelRenderer();
    const { container } = render(
      <Renderer
        data={{
          "application/javascript": "window.__panelLoadRan = true;",
          [PANEL_LOAD_MIME_TYPE]: "window.__panelLoadRan = true;",
        }}
        mimeType={PANEL_LOAD_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(renderedScripts(container).at(-1)?.textContent).toBe("window.__panelLoadRan = true;");
    });
  });

  it("renders Panel exec HTML and makes embedded scripts executable", async () => {
    stubPanelRuntime();
    const { Renderer } = installPanelRenderer();
    const { container } = render(
      <Renderer
        data={{
          "text/html":
            '<div id="panel-root">Panel root</div><script>window.__panelHtmlRan = true;</script>',
          [PANEL_EXEC_MIME_TYPE]: "",
        }}
        metadata={{ id: "p1011" }}
        mimeType={PANEL_EXEC_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("#panel-root")?.textContent).toBe("Panel root");
      expect(renderedScripts(container).at(-1)?.textContent).toContain("__panelHtmlRan");
    });
  });

  it("appends sibling application/javascript after Panel exec HTML", async () => {
    stubPanelRuntime();
    const { Renderer } = installPanelRenderer();
    const { container } = render(
      <Renderer
        data={{
          "text/html": '<div id="panel-root"></div>',
          "application/javascript": "window.__panelExecRan = true;",
          [PANEL_EXEC_MIME_TYPE]: "",
        }}
        metadata={{ id: "p1011" }}
        mimeType={PANEL_EXEC_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(renderedScripts(container).at(-1)?.textContent).toBe("window.__panelExecRan = true;");
    });
  });

  it("renders nteract Panel runtime bundles with sibling HTML and JavaScript", async () => {
    stubPanelRuntime();
    const { Renderer } = installPanelRenderer();
    const { container } = render(
      <Renderer
        data={{
          "text/html": '<div id="panel-root"></div>',
          "application/javascript": "window.__panelRuntimeRan = true;",
          [NTERACT_PANEL_RUNTIME_MIME_TYPE]: { version: 1, channel_id: "panel-1" },
        }}
        metadata={{ id: "doc-1" }}
        mimeType={NTERACT_PANEL_RUNTIME_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("#panel-root")).not.toBeNull();
      expect(renderedScripts(container).at(-1)?.textContent).toBe(
        "window.__panelRuntimeRan = true;",
      );
    });
  });

  it("executes id-less Panel exec bundles as auxiliary notebook setup", async () => {
    const { Renderer } = installPanelRenderer();
    const { container } = render(
      <Renderer
        data={{
          "text/html": "<style>.panel-test-style { color: red; }</style>",
          "application/javascript": "window.__panelAuxiliaryRan = true;",
          [PANEL_EXEC_MIME_TYPE]: "",
        }}
        mimeType={PANEL_EXEC_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("style")?.textContent).toContain("panel-test-style");
      expect(renderedScripts(container).at(-1)?.textContent).toBe(
        "window.__panelAuxiliaryRan = true;",
      );
    });
  });

  it("loads BokehJS and Panel resources derived from exec HTML before rendering", async () => {
    const appendedSrcs = stubPanelResourceLoads();
    const { Renderer } = installPanelRenderer();
    const { container } = render(
      <Renderer
        data={{
          "text/html": [
            '<div id="panel-root"></div>',
            '<script type="application/javascript">',
            'var docs_json = {"docid":{"version":"3.9.1","roots":[{"attributes":{"stylesheets":[{"attributes":{"url":"https://cdn.holoviz.org/panel/1.9.3/dist/css/loading.css"}}]}}]}};',
            "window.__panelHtmlRan = true;",
            "</script>",
          ].join(""),
          [PANEL_EXEC_MIME_TYPE]: "",
        }}
        metadata={{ id: "p1011" }}
        mimeType={PANEL_EXEC_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(renderedScripts(container).at(-1)?.textContent).toContain("__panelHtmlRan");
    });

    expect(appendedSrcs).toEqual([
      "https://cdn.bokeh.org/bokeh/release/bokeh-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-gl-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-widgets-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-tables-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-mathjax-3.9.1.min.js",
      "https://cdn.holoviz.org/panel/1.9.3/dist/panel.min.js",
    ]);
  });

  it("executes code-only Panel exec bundles after loading BokehJS", async () => {
    const appendedSrcs = stubPanelResourceLoads();
    const { Renderer } = installPanelRenderer();
    const { container } = render(
      <Renderer
        data={{
          "application/javascript": `
            window.__panelCodeOnlyDocs = {"docid": {"version": "3.9.1"}};
            window.__panelCodeOnlyRan = true;
          `,
          [PANEL_EXEC_MIME_TYPE]: "",
        }}
        metadata={{ id: "p1011" }}
        mimeType={PANEL_EXEC_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(renderedScripts(container).at(-1)?.textContent).toContain("__panelCodeOnlyRan");
    });

    expect(appendedSrcs).toEqual([
      "https://cdn.bokeh.org/bokeh/release/bokeh-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-gl-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-widgets-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-tables-3.9.1.min.js",
      "https://cdn.bokeh.org/bokeh/release/bokeh-mathjax-3.9.1.min.js",
    ]);
  });

  it("does not re-register a Panel plot after cleanup", async () => {
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    });
    const view = { model: { document: { clear: vi.fn() } } };
    (
      window as typeof window & {
        Bokeh?: { Panel?: unknown; index?: { get_by_id: () => unknown; delete: () => void } };
      }
    ).Bokeh = {
      Panel: {},
      index: {
        get_by_id: () => view,
        delete: vi.fn(),
      },
    };
    const { Renderer } = installPanelRenderer();
    const { unmount } = render(
      <Renderer
        data={{
          "text/html": '<div id="panel-root"></div>',
          [PANEL_EXEC_MIME_TYPE]: "",
        }}
        metadata={{ id: "p1011" }}
        mimeType={PANEL_EXEC_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      expect(
        (window as typeof window & { PyViz?: { plot_index?: Record<string, unknown> } }).PyViz
          ?.plot_index?.p1011,
      ).toBe(view);
    });

    unmount();
    expect(
      (window as typeof window & { PyViz?: { plot_index?: Record<string, unknown> } }).PyViz
        ?.plot_index?.p1011,
    ).toBeUndefined();

    for (const callback of animationFrameCallbacks) {
      callback(0);
    }

    expect(
      (window as typeof window & { PyViz?: { plot_index?: Record<string, unknown> } }).PyViz
        ?.plot_index?.p1011,
    ).toBeUndefined();
  });

  it("copies script attributes for Panel server outputs", async () => {
    const { Renderer } = installPanelRenderer();
    const { container } = render(
      <Renderer
        data={{
          "text/html": '<script src="https://example.test/panel-server.js" async></script>',
          [PANEL_EXEC_MIME_TYPE]: "",
        }}
        metadata={{ server_id: "server-1" }}
        mimeType={PANEL_EXEC_MIME_TYPE}
      />,
    );

    await waitFor(() => {
      const script = renderedScripts(container).at(-1);
      expect(script?.src).toBe("https://example.test/panel-server.js");
      expect(script?.hasAttribute("async")).toBe(true);
    });
  });
});
