import { copyFile, mkdir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeViewerCssManifest } from "./viewer-css-assets.mjs";

const siftWasmUrl = new URL("../../../crates/sift-wasm/pkg/sift_wasm_bg.wasm", import.meta.url);
const outputUrl = new URL("../dist/plugins/sift_wasm.wasm", import.meta.url);
const runtimedWasmModuleUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const runtimedModuleOutputUrl = new URL("../dist/assets/runtimed_wasm.js", import.meta.url);
const runtimedModulePluginOutputUrl = new URL("../dist/plugins/runtimed_wasm.js", import.meta.url);
const runtimedWasmUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);
const runtimedOutputUrl = new URL("../dist/assets/runtimed_wasm_bg.wasm", import.meta.url);
const runtimedPluginOutputUrl = new URL("../dist/plugins/runtimed_wasm_bg.wasm", import.meta.url);
const isolatedRendererModuleUrl = new URL(
  "../../notebook/src/renderer-plugins/isolated-renderer.js",
  import.meta.url,
);
const isolatedRendererCssUrl = new URL(
  "../../notebook/src/renderer-plugins/isolated-renderer.css",
  import.meta.url,
);
const isolatedRendererModuleOutputUrl = new URL(
  "../dist/plugins/isolated-renderer.js",
  import.meta.url,
);
const isolatedRendererCssOutputUrl = new URL(
  "../dist/plugins/isolated-renderer.css",
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
await copyFile(siftWasmUrl, outputUrl);
await copyFile(runtimedWasmModuleUrl, runtimedModuleOutputUrl);
await copyFile(runtimedWasmUrl, runtimedOutputUrl);
await copyFile(runtimedWasmModuleUrl, runtimedModulePluginOutputUrl);
await copyFile(runtimedWasmUrl, runtimedPluginOutputUrl);
await copyFile(isolatedRendererModuleUrl, isolatedRendererModuleOutputUrl);
await copyFile(isolatedRendererCssUrl, isolatedRendererCssOutputUrl);
await copyFile(outputDocumentFrameUrl, outputDocumentOutputUrl);
const { manifest, manifestUrl } = await writeViewerCssManifest(
  new URL("../dist/assets/", import.meta.url),
);

console.log(`copied ${fileURLToPath(siftWasmUrl)} -> ${fileURLToPath(outputUrl)}`);
console.log(
  `copied ${fileURLToPath(runtimedWasmModuleUrl)} -> ${fileURLToPath(runtimedModuleOutputUrl)}`,
);
console.log(`copied ${fileURLToPath(runtimedWasmUrl)} -> ${fileURLToPath(runtimedOutputUrl)}`);
console.log(
  `copied ${fileURLToPath(runtimedWasmModuleUrl)} -> ${fileURLToPath(runtimedModulePluginOutputUrl)}`,
);
console.log(
  `copied ${fileURLToPath(runtimedWasmUrl)} -> ${fileURLToPath(runtimedPluginOutputUrl)}`,
);
console.log(
  `copied ${fileURLToPath(isolatedRendererModuleUrl)} -> ${fileURLToPath(isolatedRendererModuleOutputUrl)}`,
);
console.log(
  `copied ${fileURLToPath(isolatedRendererCssUrl)} -> ${fileURLToPath(isolatedRendererCssOutputUrl)}`,
);
console.log(
  `copied ${fileURLToPath(outputDocumentFrameUrl)} -> ${fileURLToPath(outputDocumentOutputUrl)}`,
);
console.log(`wrote viewer CSS manifest ${fileURLToPath(manifestUrl)}`);
console.log(`viewer CSS assets: ${JSON.stringify(manifest)}`);

async function assertExists(url) {
  try {
    await access(fileURLToPath(url));
  } catch {
    throw new Error(
      `Missing ${fileURLToPath(url)}. Run \`pnpm --dir apps/notebook-cloud run build\` to rebuild viewer inputs.`,
    );
  }
}
