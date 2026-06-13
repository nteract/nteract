import { copyFile, mkdir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { copyRendererSidecarAssets } from "./renderer-sidecar-assets.mjs";
import { copyRuntimeWasmAssets } from "./runtime-wasm-assets.mjs";
import { writeNotebookRouteAssetsManifest } from "./notebook-route-assets.mjs";
import { writeViewerCssManifest } from "./viewer-css-assets.mjs";

const siftWasmUrl = new URL("../../../crates/sift-wasm/pkg/sift_wasm_bg.wasm", import.meta.url);
const runtimedWasmModuleUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const runtimedWasmUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);
const isolatedRendererModuleUrl = new URL(
  "../../notebook/src/renderer-plugins/isolated-renderer.js",
  import.meta.url,
);
const isolatedRendererCssUrl = new URL(
  "../../notebook/src/renderer-plugins/isolated-renderer.css",
  import.meta.url,
);
const outputDocumentFrameUrl = new URL(
  "../../../src/components/isolated/frame.html",
  import.meta.url,
);
const outputDocumentOutputUrl = new URL("../dist-output-document/index.html", import.meta.url);

await assertExists(siftWasmUrl);
await assertExists(runtimedWasmModuleUrl);
await assertExists(runtimedWasmUrl);
await assertExists(isolatedRendererModuleUrl);
await assertExists(isolatedRendererCssUrl);
await assertExists(outputDocumentFrameUrl);
await mkdir(new URL("../dist/plugins/", import.meta.url), { recursive: true });
await mkdir(new URL("../dist/assets/", import.meta.url), { recursive: true });
await mkdir(new URL("../dist-output-document/", import.meta.url), { recursive: true });
const rendererSidecarAssets = await copyRendererSidecarAssets({
  rendererJsUrl: isolatedRendererModuleUrl,
  rendererCssUrl: isolatedRendererCssUrl,
  siftWasmUrl,
  assetsDirUrl: new URL("../dist/assets/", import.meta.url),
  pluginsDirUrl: new URL("../dist/plugins/", import.meta.url),
});
const runtimeWasmAssets = await copyRuntimeWasmAssets({
  moduleUrl: runtimedWasmModuleUrl,
  wasmUrl: runtimedWasmUrl,
  assetsDirUrl: new URL("../dist/assets/", import.meta.url),
  pluginsDirUrl: new URL("../dist/plugins/", import.meta.url),
});
await copyFile(outputDocumentFrameUrl, outputDocumentOutputUrl);
const { manifest, manifestUrl } = await writeViewerCssManifest(
  new URL("../dist/assets/", import.meta.url),
);
const { manifest: notebookRouteManifest, manifestUrl: notebookRouteManifestUrl } =
  await writeNotebookRouteAssetsManifest(new URL("../dist/assets/", import.meta.url));

for (const copy of rendererSidecarAssets.copies) {
  console.log(`copied ${fileURLToPath(copy.sourceUrl)} -> ${fileURLToPath(copy.outputUrl)}`);
}
for (const copy of runtimeWasmAssets.copies) {
  console.log(`copied ${fileURLToPath(copy.sourceUrl)} -> ${fileURLToPath(copy.outputUrl)}`);
}
console.log(
  `copied ${fileURLToPath(outputDocumentFrameUrl)} -> ${fileURLToPath(outputDocumentOutputUrl)}`,
);
console.log(`wrote renderer sidecar manifest ${fileURLToPath(rendererSidecarAssets.manifestUrl)}`);
console.log(`renderer sidecar assets: ${JSON.stringify(rendererSidecarAssets.manifest)}`);
console.log(`wrote runtime WASM manifest ${fileURLToPath(runtimeWasmAssets.manifestUrl)}`);
console.log(`runtime WASM assets: ${JSON.stringify(runtimeWasmAssets.manifest)}`);
console.log(`wrote viewer CSS manifest ${fileURLToPath(manifestUrl)}`);
console.log(`viewer CSS assets: ${JSON.stringify(manifest)}`);
console.log(`wrote notebook route asset manifest ${fileURLToPath(notebookRouteManifestUrl)}`);
console.log(`notebook route assets: ${JSON.stringify(notebookRouteManifest)}`);

async function assertExists(url) {
  try {
    await access(fileURLToPath(url));
  } catch {
    throw new Error(
      `Missing ${fileURLToPath(url)}. Run \`pnpm --dir apps/notebook-cloud run build\` to rebuild viewer inputs.`,
    );
  }
}
