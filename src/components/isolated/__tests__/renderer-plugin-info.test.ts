import { describe, expect, it } from "vite-plus/test";
import {
  needsRendererPlugin,
  rendererPluginInfoForMime,
  rendererPluginNameForMime,
} from "../renderer-plugin-info";
import { BOKEHJS_EXEC_MIME_TYPE, BOKEHJS_LOAD_MIME_TYPE } from "@/components/outputs/bokeh-mime";
import {
  NTERACT_PANEL_RUNTIME_MIME_TYPE,
  PANEL_EXEC_MIME_TYPE,
  PANEL_LOAD_MIME_TYPE,
} from "@/components/outputs/panel-mime";

describe("renderer plugin metadata", () => {
  it("maps exact MIME types to the shared renderer plugin names", () => {
    expect(rendererPluginInfoForMime("text/markdown")).toEqual({
      name: "markdown",
      hasCss: true,
    });
    expect(rendererPluginInfoForMime("application/vnd.plotly.v1+json")).toEqual({
      name: "plotly",
      hasCss: false,
    });
    expect(rendererPluginInfoForMime(BOKEHJS_LOAD_MIME_TYPE)).toEqual({
      name: "bokeh",
      hasCss: false,
    });
    expect(rendererPluginInfoForMime(BOKEHJS_EXEC_MIME_TYPE)).toEqual({
      name: "bokeh",
      hasCss: false,
    });
    expect(rendererPluginInfoForMime(PANEL_LOAD_MIME_TYPE)).toEqual({
      name: "panel",
      hasCss: false,
    });
    expect(rendererPluginInfoForMime(PANEL_EXEC_MIME_TYPE)).toEqual({
      name: "panel",
      hasCss: false,
    });
    expect(rendererPluginInfoForMime(NTERACT_PANEL_RUNTIME_MIME_TYPE)).toEqual({
      name: "panel",
      hasCss: false,
    });
    expect(rendererPluginInfoForMime("application/vnd.apache.parquet")).toEqual({
      name: "sift",
      hasCss: true,
    });
  });

  it("maps versioned Vega variants through the shared pattern", () => {
    expect(rendererPluginNameForMime("application/vnd.vegalite.v6+json")).toBe("vega");
    expect(rendererPluginNameForMime("application/vnd.vega.v5+json")).toBe("vega");
  });

  it("distinguishes core-rendered MIME types from plugin-rendered MIME types", () => {
    expect(needsRendererPlugin("text/html")).toBe(false);
    expect(needsRendererPlugin("text/plain")).toBe(false);
    expect(needsRendererPlugin("application/geo+json")).toBe(true);
  });
});
