import { isVegaMimeType } from "@/components/outputs/vega-mime";

export type RendererPluginName = "markdown" | "plotly" | "vega" | "leaflet" | "sift";

export interface RendererPluginInfo {
  name: RendererPluginName;
  hasCss: boolean;
}

const MIME_TO_PLUGIN: Record<string, RendererPluginInfo> = {
  "text/markdown": { name: "markdown", hasCss: true },
  "text/latex": { name: "markdown", hasCss: true },
  "application/vnd.plotly.v1+json": { name: "plotly", hasCss: false },
  "application/geo+json": { name: "leaflet", hasCss: true },
  "application/vnd.apache.parquet": { name: "sift", hasCss: true },
  "application/vnd.apache.arrow.stream": { name: "sift", hasCss: true },
  "application/vnd.nteract.arrow-stream-manifest+json": { name: "sift", hasCss: true },
};

const VEGA_PLUGIN: RendererPluginInfo = { name: "vega", hasCss: false };

export function rendererPluginInfoForMime(mime: string): RendererPluginInfo | undefined {
  if (MIME_TO_PLUGIN[mime]) return MIME_TO_PLUGIN[mime];
  if (isVegaMimeType(mime)) return VEGA_PLUGIN;
  return undefined;
}

export function rendererPluginNameForMime(mime: string): RendererPluginName | undefined {
  return rendererPluginInfoForMime(mime)?.name;
}

export function needsRendererPlugin(mime: string): boolean {
  return rendererPluginInfoForMime(mime) !== undefined;
}
