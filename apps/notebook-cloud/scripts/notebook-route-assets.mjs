import { readdir, writeFile } from "node:fs/promises";

export const NOTEBOOK_ROUTE_ASSETS_MANIFEST = "notebook-route-assets.json";
export const MARKDOWN_DOCUMENT_ROUTE_ASSETS_MANIFEST = "markdown-document-route-assets.json";

const NOTEBOOK_MODULE_PRELOAD_STEMS = [
  "notebook-route",
  "MarkdownText",
  "markdown",
  "markdown-output",
  "katex.min",
  "utils",
];
const NOTEBOOK_MODULE_PRELOAD_EXCLUDE_STEMS = ["markdown-document", "markdown-projection"];
const NOTEBOOK_STYLE_PRELOAD_STEMS = ["notebook-route", "katex"];
const REQUIRED_NOTEBOOK_MODULE_PRELOAD_STEMS = ["notebook-route", "katex.min"];
// Route CSS is optional here because Vite may fold route-owned styles into the
// primary notebook-cloud-viewer.css asset. That primary stylesheet is guarded by
// viewer-css-assets.mjs; if Vite splits notebook-route.css again, we still
// collect and preload it through NOTEBOOK_STYLE_PRELOAD_STEMS.
const REQUIRED_NOTEBOOK_STYLE_PRELOAD_STEMS = ["katex"];

const MARKDOWN_DOCUMENT_MODULE_PRELOAD_STEMS = [
  "markdown-document-route",
  "markdown-projection",
  "MarkdownText",
  "katex.min",
  "utils",
  "cloud-notebook-title",
  "cloud-response",
  "use-cloud-auth",
];
const MARKDOWN_DOCUMENT_MODULE_PRELOAD_EXCLUDE_STEMS = [
  "markdown-document-live-sync",
  "codemirror-editor",
];
const MARKDOWN_DOCUMENT_STYLE_PRELOAD_STEMS = ["katex"];
const REQUIRED_MARKDOWN_DOCUMENT_MODULE_PRELOAD_STEMS = [
  "markdown-document-route",
  "markdown-projection",
  "katex.min",
];
const REQUIRED_MARKDOWN_DOCUMENT_STYLE_PRELOAD_STEMS = ["katex"];

export async function collectNotebookRouteAssets(
  assetsDirUrl,
  {
    modulePreloadStems = NOTEBOOK_MODULE_PRELOAD_STEMS,
    modulePreloadExcludeStems = NOTEBOOK_MODULE_PRELOAD_EXCLUDE_STEMS,
    stylePreloadStems = NOTEBOOK_STYLE_PRELOAD_STEMS,
  } = {},
) {
  const entries = await readdir(assetsDirUrl);
  return {
    modulepreload: collectAssetNames(entries, modulePreloadStems, ".js", {
      excludeStems: modulePreloadExcludeStems,
    }),
    stylepreload: collectAssetNames(entries, stylePreloadStems, ".css"),
  };
}

export async function collectMarkdownDocumentRouteAssets(
  assetsDirUrl,
  {
    modulePreloadStems = MARKDOWN_DOCUMENT_MODULE_PRELOAD_STEMS,
    modulePreloadExcludeStems = MARKDOWN_DOCUMENT_MODULE_PRELOAD_EXCLUDE_STEMS,
    stylePreloadStems = MARKDOWN_DOCUMENT_STYLE_PRELOAD_STEMS,
  } = {},
) {
  const entries = await readdir(assetsDirUrl);
  return {
    modulepreload: collectAssetNames(entries, modulePreloadStems, ".js", {
      excludeStems: modulePreloadExcludeStems,
    }),
    stylepreload: collectAssetNames(entries, stylePreloadStems, ".css"),
  };
}

export async function writeNotebookRouteAssetsManifest(assetsDirUrl) {
  const manifest = await collectNotebookRouteAssets(assetsDirUrl);
  assertRequiredRouteAssets(manifest, {
    manifestName: NOTEBOOK_ROUTE_ASSETS_MANIFEST,
    modulePreloadStems: REQUIRED_NOTEBOOK_MODULE_PRELOAD_STEMS,
    stylePreloadStems: REQUIRED_NOTEBOOK_STYLE_PRELOAD_STEMS,
  });
  const manifestUrl = new URL(NOTEBOOK_ROUTE_ASSETS_MANIFEST, assetsDirUrl);
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestUrl };
}

export async function writeMarkdownDocumentRouteAssetsManifest(assetsDirUrl) {
  const manifest = await collectMarkdownDocumentRouteAssets(assetsDirUrl);
  assertRequiredRouteAssets(manifest, {
    manifestName: MARKDOWN_DOCUMENT_ROUTE_ASSETS_MANIFEST,
    modulePreloadStems: REQUIRED_MARKDOWN_DOCUMENT_MODULE_PRELOAD_STEMS,
    stylePreloadStems: REQUIRED_MARKDOWN_DOCUMENT_STYLE_PRELOAD_STEMS,
  });
  const manifestUrl = new URL(MARKDOWN_DOCUMENT_ROUTE_ASSETS_MANIFEST, assetsDirUrl);
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestUrl };
}

function collectAssetNames(entries, stems, extension, { excludeStems = [] } = {}) {
  const names = new Set();
  for (const stem of stems) {
    for (const entry of entries
      .filter((entry) => entry.endsWith(extension))
      .filter((entry) => assetNameMatchesStem(entry, stem, extension))
      .filter(
        (entry) =>
          !excludeStems.some((excludeStem) => assetNameMatchesStem(entry, excludeStem, extension)),
      )
      .sort()) {
      names.add(entry);
    }
  }
  return Array.from(names);
}

function assertRequiredRouteAssets(
  manifest,
  { manifestName, modulePreloadStems, stylePreloadStems } = {},
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
    `Unable to write ${manifestName}: missing required route preload assets: ${missing.join(", ")}`,
  );
}

function missingAssetStems(names, stems, extension) {
  return stems.filter((stem) => !names.some((name) => assetNameMatchesStem(name, stem, extension)));
}

function assetNameMatchesStem(name, stem, extension) {
  return name === `${stem}${extension}` || name.startsWith(`${stem}-`);
}
