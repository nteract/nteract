/**
 * Tests for anywidget-view helpers that don't require the full iframe +
 * Jupyter comm pipeline. Focused on `injectCSS` because it grew a URL
 * branch (see PR that restores `_css` URL passthrough) plus an async
 * `ready` signal so callers can wait for the stylesheet to apply before
 * rendering. Other exports like `loadESM` rely on dynamic `import()`
 * and are better covered by integration tests in the isolated iframe
 * harness.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  applyAnyWidgetDisplayDefaults,
  injectCSS,
  NTERACT_JUPYTER_SCATTER_DEFAULT_HEIGHT,
} from "../anywidget-view";

describe("injectCSS", () => {
  afterEach(() => {
    document.head.querySelectorAll("[data-widget-id]").forEach((node) => node.remove());
  });

  it("renders raw CSS into a <style> element and cleans up on dispose", () => {
    const { cleanup } = injectCSS("m1", ".foo { color: red; }");
    const el = document.head.querySelector<HTMLStyleElement>('style[data-widget-id="m1"]');
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe(".foo { color: red; }");
    cleanup();
    expect(document.head.querySelector('[data-widget-id="m1"]')).toBeNull();
  });

  it("raw CSS ready promise resolves synchronously", async () => {
    const { ready, cleanup } = injectCSS("m1b", ".foo {}");
    // Inline <style> applies synchronously; ready should already be resolved.
    await expect(ready).resolves.toBeUndefined();
    cleanup();
  });

  it("renders http:// URL as a <link rel=stylesheet> and cleans up", () => {
    const url = "http://127.0.0.1:1234/blob/cafebabe";
    const { cleanup } = injectCSS("m2", url);
    const el = document.head.querySelector<HTMLLinkElement>('link[data-widget-id="m2"]');
    expect(el).not.toBeNull();
    expect(el?.rel).toBe("stylesheet");
    expect(el?.href).toBe(url);
    // Belt-and-suspenders: no <style> element should be created for the URL path.
    expect(document.head.querySelector('style[data-widget-id="m2"]')).toBeNull();
    cleanup();
    expect(document.head.querySelector('[data-widget-id="m2"]')).toBeNull();
  });

  it("renders https:// URL as a <link rel=stylesheet>", () => {
    const url = "https://cdn.example.com/widget.css";
    const { cleanup } = injectCSS("m3", url);
    const el = document.head.querySelector<HTMLLinkElement>('link[data-widget-id="m3"]');
    expect(el).not.toBeNull();
    expect(el?.href).toBe(url);
    cleanup();
  });

  it("URL ready resolves on <link> load event", async () => {
    const { ready, cleanup } = injectCSS("m3b", "http://127.0.0.1:1234/blob/load");
    const link = document.head.querySelector<HTMLLinkElement>('link[data-widget-id="m3b"]');
    expect(link).not.toBeNull();
    link!.dispatchEvent(new Event("load"));
    await expect(ready).resolves.toBeUndefined();
    cleanup();
  });

  it("URL ready resolves on <link> error event (missing stylesheet doesn't block widget)", async () => {
    const { ready, cleanup } = injectCSS("m3c", "http://127.0.0.1:1234/blob/missing");
    const link = document.head.querySelector<HTMLLinkElement>('link[data-widget-id="m3c"]');
    expect(link).not.toBeNull();
    link!.dispatchEvent(new Event("error"));
    await expect(ready).resolves.toBeUndefined();
    cleanup();
  });

  it("distinct model ids produce independent nodes", () => {
    const c1 = injectCSS("m4", ".a {}");
    const c2 = injectCSS("m5", "http://x/blob/h");
    expect(document.head.querySelector('style[data-widget-id="m4"]')).not.toBeNull();
    expect(document.head.querySelector('link[data-widget-id="m5"]')).not.toBeNull();
    c1.cleanup();
    expect(document.head.querySelector('[data-widget-id="m4"]')).toBeNull();
    expect(document.head.querySelector('link[data-widget-id="m5"]')).not.toBeNull();
    c2.cleanup();
  });
});

describe("applyAnyWidgetDisplayDefaults", () => {
  it("raises jupyter-scatter's library default height for nteract output display", () => {
    const state = {
      _anywidget_id: "jscatter.widget.JupyterScatter",
      width: "auto",
      height: 240,
    };

    expect(applyAnyWidgetDisplayDefaults(state)).toEqual({
      ...state,
      height: NTERACT_JUPYTER_SCATTER_DEFAULT_HEIGHT,
    });
  });

  it("honors non-default explicit jupyter-scatter heights", () => {
    const state = {
      _anywidget_id: "jscatter.widget.JupyterScatter",
      width: "auto",
      height: 520,
    };

    expect(applyAnyWidgetDisplayDefaults(state)).toBe(state);
  });

  it("does not change unrelated anywidgets", () => {
    const state = {
      _anywidget_id: "example.Widget",
      height: 240,
    };

    expect(applyAnyWidgetDisplayDefaults(state)).toBe(state);
  });
});
