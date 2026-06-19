import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PANEL_EXEC_MIME_TYPE, PANEL_LOAD_MIME_TYPE } from "@/components/outputs/panel-mime";
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

function renderedScripts(container: HTMLElement): HTMLScriptElement[] {
  return Array.from(container.querySelectorAll("script"));
}

describe("Panel renderer plugin", () => {
  beforeEach(() => {
    stubAnimationFrames();
    delete (window as typeof window & { PyViz?: unknown }).PyViz;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as typeof window & { PyViz?: unknown }).PyViz;
  });

  it("registers Panel load and exec MIME types", () => {
    const { registeredMimeTypes } = installPanelRenderer();

    expect(registeredMimeTypes).toEqual([PANEL_LOAD_MIME_TYPE, PANEL_EXEC_MIME_TYPE]);
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
