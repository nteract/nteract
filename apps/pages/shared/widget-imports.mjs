import { outputFrameUrl } from "./output-frame-config.mjs";
export const standardImports = Object.freeze([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "d3",
  "@observablehq/plot",
  "@nteract/sift/parquet",
]);
export const catalogDigest = /^[a-f0-9]{64}$/;
export function configuredCatalogRevision(env = {}) {
  if (!catalogDigest.test(env.PAGES_WIDGET_CATALOG_REVISION) || !env.PAGES_OUTPUT_FRAME_URL)
    return null;
  try {
    outputFrameUrl(
      env.PAGES_OUTPUT_FRAME_URL,
      env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN ?? "http://localhost",
    );
    return env.PAGES_WIDGET_CATALOG_REVISION;
  } catch {
    return null;
  }
}
