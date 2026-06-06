import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const RUNTIME_WASM_ASSET_MANIFEST = "runtime-wasm-assets.json";
export const RUNTIME_WASM_MODULE_STABLE_NAME = "runtimed_wasm.js";
export const RUNTIME_WASM_BINARY_STABLE_NAME = "runtimed_wasm_bg.wasm";

export async function copyRuntimeWasmAssets({
  moduleUrl,
  wasmUrl,
  assetsDirUrl,
  pluginsDirUrl,
  hashLength = 16,
}) {
  const [moduleBytes, wasmBytes] = await Promise.all([readFile(moduleUrl), readFile(wasmUrl)]);
  const manifest = {
    module: `runtimed_wasm.${sha256Hex(moduleBytes).slice(0, hashLength)}.js`,
    wasm: `runtimed_wasm_bg.${sha256Hex(wasmBytes).slice(0, hashLength)}.wasm`,
  };
  const outputDirs = [assetsDirUrl, pluginsDirUrl];
  const copies = [];

  await Promise.all(outputDirs.map((outputDirUrl) => mkdir(outputDirUrl, { recursive: true })));
  for (const outputDirUrl of outputDirs) {
    copies.push(
      await writeRuntimeAsset(
        moduleUrl,
        moduleBytes,
        outputDirUrl,
        RUNTIME_WASM_MODULE_STABLE_NAME,
      ),
      await writeRuntimeAsset(moduleUrl, moduleBytes, outputDirUrl, manifest.module),
      await writeRuntimeAsset(wasmUrl, wasmBytes, outputDirUrl, RUNTIME_WASM_BINARY_STABLE_NAME),
      await writeRuntimeAsset(wasmUrl, wasmBytes, outputDirUrl, manifest.wasm),
    );
  }

  const manifestUrl = new URL(RUNTIME_WASM_ASSET_MANIFEST, assetsDirUrl);
  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);

  return { copies, manifest, manifestUrl };
}

async function writeRuntimeAsset(sourceUrl, bytes, outputDirUrl, outputName) {
  const outputUrl = new URL(outputName, outputDirUrl);
  await writeFile(outputUrl, bytes);
  return { sourceUrl, outputUrl };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
