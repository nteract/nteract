import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * Content-hashed renderer sidecar assets (PR #3449's runtime-wasm pattern
 * applied to the remaining un-hashed sidecars): the isolated renderer
 * bundle and Sift's WASM binary are written under BOTH their stable names
 * (documented fallback for shells without manifest names) and
 * content-hashed names. Hashed pathnames let the renderer-assets worker's
 * isContentHashedAssetPathname serve them with year-long immutable
 * caching; the sift_wasm `?v=` query is retired on the cloud path.
 */

export const RENDERER_SIDECAR_ASSET_MANIFEST = "renderer-sidecar-assets.json";
export const ISOLATED_RENDERER_JS_STABLE_NAME = "isolated-renderer.js";
export const ISOLATED_RENDERER_CSS_STABLE_NAME = "isolated-renderer.css";
export const SIFT_WASM_STABLE_NAME = "sift_wasm.wasm";

export async function copyRendererSidecarAssets({
  rendererJsUrl,
  rendererCssUrl,
  siftWasmUrl,
  assetsDirUrl,
  pluginsDirUrl,
  hashLength = 16,
}) {
  const [jsBytes, cssBytes, siftWasmBytes] = await Promise.all([
    readFile(rendererJsUrl),
    readFile(rendererCssUrl),
    readFile(siftWasmUrl),
  ]);
  const manifest = {
    js: `isolated-renderer.${sha256Hex(jsBytes).slice(0, hashLength)}.js`,
    css: `isolated-renderer.${sha256Hex(cssBytes).slice(0, hashLength)}.css`,
    siftWasm: `sift_wasm.${sha256Hex(siftWasmBytes).slice(0, hashLength)}.wasm`,
  };

  await mkdir(pluginsDirUrl, { recursive: true });
  await mkdir(assetsDirUrl, { recursive: true });

  const copies = [];
  const assets = [
    [rendererJsUrl, jsBytes, ISOLATED_RENDERER_JS_STABLE_NAME, manifest.js],
    [rendererCssUrl, cssBytes, ISOLATED_RENDERER_CSS_STABLE_NAME, manifest.css],
    [siftWasmUrl, siftWasmBytes, SIFT_WASM_STABLE_NAME, manifest.siftWasm],
  ];
  for (const [sourceUrl, bytes, stableName, hashedName] of assets) {
    copies.push(
      await writeSidecarAsset(sourceUrl, bytes, pluginsDirUrl, stableName),
      await writeSidecarAsset(sourceUrl, bytes, pluginsDirUrl, hashedName),
    );
  }

  const manifestUrl = new URL(RENDERER_SIDECAR_ASSET_MANIFEST, assetsDirUrl);
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);

  return { copies, manifest, manifestUrl };
}

async function writeSidecarAsset(sourceUrl, bytes, outputDirUrl, outputName) {
  const outputUrl = new URL(outputName, outputDirUrl);
  await writeFile(outputUrl, bytes);
  return { sourceUrl, outputUrl };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
