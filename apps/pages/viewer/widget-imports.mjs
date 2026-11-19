// The configured output host serves the pinned catalog. A view record carries
// the catalog digest, never an executable URL.
export function hasWidgetCatalog(frameUrl) {
  const configuration = globalThis.document?.querySelector('meta[name="pages-output-frame-url"]');
  const url = frameUrl ?? configuration?.content;
  return Boolean(
    url &&
    (new URL(url).hostname === "127.0.0.1" ||
      (configuration?.content === url && configuration.dataset.widgetCatalog === "enabled")),
  );
}
