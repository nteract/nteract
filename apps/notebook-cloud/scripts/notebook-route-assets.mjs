import { readdir, writeFile } from "node:fs/promises";

export const NOTEBOOK_ROUTE_ASSETS_MANIFEST = "notebook-route-assets.json";

const MODULE_PRELOAD_STEMS = ["notebook-route", "MarkdownText", "markdown", "utils"];
const STYLE_PRELOAD_STEMS = ["notebook-route"];
const REQUIRED_MODULE_PRELOAD_STEMS = ["notebook-route"];
const REQUIRED_STYLE_PRELOAD_STEMS = ["notebook-route"];
// Vite's chunk hash is currently 8 base64url-ish chars, not hex.
const VITE_CHUNK_HASH_PATTERN = /^[A-Za-z0-9_-]{8}$/;

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
  assertRequiredRouteAssets(manifest);
  const manifestUrl = new URL(NOTEBOOK_ROUTE_ASSETS_MANIFEST, assetsDirUrl);
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestUrl };
}

function collectAssetNames(entries, stems, extension) {
  const names = new Set();
  for (const stem of stems) {
    for (const entry of entries
      .filter((entry) => entry.endsWith(extension))
      .filter((entry) => assetNameMatchesStem(entry, stem, extension))
      .sort()) {
      names.add(entry);
    }
  }
  return Array.from(names);
}

function assertRequiredRouteAssets(
  manifest,
  {
    modulePreloadStems = REQUIRED_MODULE_PRELOAD_STEMS,
    stylePreloadStems = REQUIRED_STYLE_PRELOAD_STEMS,
  } = {},
) {
  const missingModuleStems = missingAssetStems(manifest.modulepreload, modulePreloadStems, ".js");
  const missingStyleStems = missingAssetStems(manifest.stylepreload, stylePreloadStems, ".css");
  if (missingModuleStems.length === 0 && missingStyleStems.length === 0) {
    return;
  }

  const missing = [
    ...missingModuleStems.map((stem) => `${stem}.js`),
    ...missingStyleStems.map((stem) => `${stem}.css`),
  ];
  throw new Error(
    `Unable to write ${NOTEBOOK_ROUTE_ASSETS_MANIFEST}: missing required route preload assets: ${missing.join(", ")}`,
  );
}

function missingAssetStems(names, stems, extension) {
  return stems.filter((stem) => !names.some((name) => assetNameMatchesStem(name, stem, extension)));
}

function assetNameMatchesStem(name, stem, extension) {
  if (name === `${stem}${extension}`) {
    return true;
  }
  const prefix = `${stem}-`;
  if (!name.startsWith(prefix) || !name.endsWith(extension)) {
    return false;
  }
  return VITE_CHUNK_HASH_PATTERN.test(name.slice(prefix.length, -extension.length));
}
