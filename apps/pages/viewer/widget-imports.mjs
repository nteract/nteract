// The configured output host serves the pinned catalog. A declaration contains a digest, never an executable URL.
import { WIDGET_IMPORTS } from "../shared/widget-imports.mjs";
export { WIDGET_IMPORTS };
export function hasWidgetCatalog(frameUrl) {
  const configuration = globalThis.document?.querySelector('meta[name="pages-output-frame-url"]');
  const url = frameUrl ?? configuration?.content;
  return Boolean(
    url &&
    (new URL(url).hostname === "127.0.0.1" ||
      (configuration?.content === url && configuration.dataset.widgetCatalog === "enabled")),
  );
}
export function widgetCatalogPin(source) {
  return source?.source_id === WIDGET_IMPORTS && source.media_type === "application/octet-stream"
    ? source.asset_id
    : null;
}
