import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BOKEHJS_EXEC_MIME_TYPE, BOKEHJS_LOAD_MIME_TYPE } from "@/components/outputs/bokeh-mime";
import type { RendererProps } from "@/lib/renderer-registry";
import { install } from "../bokeh-renderer";

function installBokehRenderer() {
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

    expect(registeredMimeTypes).toEqual([BOKEHJS_LOAD_MIME_TYPE, BOKEHJS_EXEC_MIME_TYPE]);
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
});
