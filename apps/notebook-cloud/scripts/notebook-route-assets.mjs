import { readdir, writeFile } from "node:fs/promises";

export const NOTEBOOK_ROUTE_ASSETS_MANIFEST = "notebook-route-assets.json";

const MODULE_PRELOAD_STEMS = [
  "notebook-route",
  "MarkdownText",
  "markdown",
  "markdown-output",
  "katex.min",
  "utils",
];
const STYLE_PRELOAD_STEMS = ["notebook-route", "katex"];

export async function collectNotebookRouteAssets(
  assetsDirUrl,
  { modulePreloadStems = MODULE_PRELOAD_STEMS, stylePreloadStems = STYLE_PRELOAD_STEMS } = {},
) {
  const entries = await readdir(assetsDirUrl);
  return {
    modulepreload: collectAssetNames(entries, modulePreloadStems, ".js"),
    stylepreload: collectAssetNames(entries, stylePreloadStems, ".css"),
  };
}

export async function writeNotebookRouteAssetsManifest(assetsDirUrl) {
  const manifest = await collectNotebookRouteAssets(assetsDirUrl);
  const manifestUrl = new URL(NOTEBOOK_ROUTE_ASSETS_MANIFEST, assetsDirUrl);
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestUrl };
}

function collectAssetNames(entries, stems, extension) {
  const names = new Set();
  for (const stem of stems) {
    for (const entry of entries
      .filter((entry) => entry.endsWith(extension))
      .filter((entry) => entry === `${stem}${extension}` || entry.startsWith(`${stem}-`))
      .sort()) {
      names.add(entry);
    }
  }
  return Array.from(names);
}
