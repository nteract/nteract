import { readdir, writeFile } from "node:fs/promises";

export const VIEWER_PRIMARY_CSS = "notebook-cloud-viewer.css";
export const VIEWER_CSS_MANIFEST = "notebook-cloud-viewer-css.json";

export async function collectViewerCssAssets(assetsDirUrl, { publicPrefix = "/assets/" } = {}) {
  const entries = await readdir(assetsDirUrl);
  const stylesheets = entries.filter((entry) => entry.endsWith(".css")).sort();

  return {
    primary: stylesheets.includes(VIEWER_PRIMARY_CSS)
      ? `${publicPrefix}${VIEWER_PRIMARY_CSS}`
      : null,
    supplemental: stylesheets
      .filter((entry) => entry !== VIEWER_PRIMARY_CSS)
      .map((entry) => `${publicPrefix}${entry}`),
  };
}

export async function writeViewerCssManifest(assetsDirUrl) {
  const manifest = await collectViewerCssAssets(assetsDirUrl);
  const manifestUrl = new URL(VIEWER_CSS_MANIFEST, assetsDirUrl);
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestUrl };
}
