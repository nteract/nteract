// A local authoring trial. Only the configured loopback output host serves
// this catalog. A declaration contains a digest, never an executable URL.
export const WIDGET_IMPORTS = "widget-imports";
export function localWidgetCatalog(
  frameUrl = globalThis.document?.querySelector('meta[name="pages-output-frame-url"]')?.content,
) {
  return !!frameUrl && new URL(frameUrl).hostname === "127.0.0.1";
}
export function widgetCatalogPin(source) {
  return source?.source_id === WIDGET_IMPORTS && source.media_type === "application/octet-stream"
    ? source.asset_id
    : null;
}
