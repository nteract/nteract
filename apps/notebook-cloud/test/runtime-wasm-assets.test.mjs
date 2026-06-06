import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  RUNTIME_WASM_ASSET_MANIFEST,
  RUNTIME_WASM_BINARY_STABLE_NAME,
  RUNTIME_WASM_MODULE_STABLE_NAME,
  copyRuntimeWasmAssets,
} from "../scripts/runtime-wasm-assets.mjs";

describe("runtime WASM asset copying", () => {
  it("emits stable compatibility files plus content-hashed runtime WASM assets", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "runtime-wasm-assets-"));
    const tempUrl = pathToFileURL(`${tempDir}/`);
    const sourceDirUrl = new URL("source/", tempUrl);
    const assetsDirUrl = new URL("dist/assets/", tempUrl);
    const pluginsDirUrl = new URL("dist/plugins/", tempUrl);
    const moduleUrl = new URL(RUNTIME_WASM_MODULE_STABLE_NAME, sourceDirUrl);
    const wasmUrl = new URL(RUNTIME_WASM_BINARY_STABLE_NAME, sourceDirUrl);
    const moduleSource = "export default function init() {}\n";
    const wasmBytes = "wasm bytes";

    await mkdir(sourceDirUrl, { recursive: true });
    await writeFile(moduleUrl, moduleSource);
    await writeFile(wasmUrl, wasmBytes);

    const result = await copyRuntimeWasmAssets({
      moduleUrl,
      wasmUrl,
      assetsDirUrl,
      pluginsDirUrl,
    });

    assert.match(result.manifest.module, /^runtimed_wasm\.[a-f0-9]{16}\.js$/);
    assert.match(result.manifest.wasm, /^runtimed_wasm_bg\.[a-f0-9]{16}\.wasm$/);

    for (const dirUrl of [assetsDirUrl, pluginsDirUrl]) {
      assert.equal(
        await readFile(new URL(RUNTIME_WASM_MODULE_STABLE_NAME, dirUrl), "utf8"),
        moduleSource,
      );
      assert.equal(
        await readFile(new URL(RUNTIME_WASM_BINARY_STABLE_NAME, dirUrl), "utf8"),
        wasmBytes,
      );
      assert.equal(await readFile(new URL(result.manifest.module, dirUrl), "utf8"), moduleSource);
      assert.equal(await readFile(new URL(result.manifest.wasm, dirUrl), "utf8"), wasmBytes);
    }

    const manifest = JSON.parse(
      await readFile(new URL(RUNTIME_WASM_ASSET_MANIFEST, assetsDirUrl), "utf8"),
    );
    assert.deepEqual(manifest, result.manifest);
    await stat(result.manifestUrl);
  });
});
