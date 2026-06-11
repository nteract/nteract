import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  ISOLATED_RENDERER_CSS_STABLE_NAME,
  ISOLATED_RENDERER_JS_STABLE_NAME,
  RENDERER_SIDECAR_ASSET_MANIFEST,
  SIFT_WASM_STABLE_NAME,
  copyRendererSidecarAssets,
} from "../scripts/renderer-sidecar-assets.mjs";

describe("renderer sidecar asset copying", () => {
  it("emits stable compatibility files plus content-hashed sidecar assets", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "renderer-sidecar-assets-"));
    const tempUrl = pathToFileURL(`${tempDir}/`);
    const sourceDirUrl = new URL("source/", tempUrl);
    const assetsDirUrl = new URL("dist/assets/", tempUrl);
    const pluginsDirUrl = new URL("dist/plugins/", tempUrl);
    const rendererJsUrl = new URL(ISOLATED_RENDERER_JS_STABLE_NAME, sourceDirUrl);
    const rendererCssUrl = new URL(ISOLATED_RENDERER_CSS_STABLE_NAME, sourceDirUrl);
    const siftWasmUrl = new URL(SIFT_WASM_STABLE_NAME, sourceDirUrl);
    const jsSource = "(() => { /* isolated renderer */ })();\n";
    const cssSource = ".isolated-renderer { color: inherit; }\n";
    const wasmBytes = "sift wasm bytes";

    await mkdir(sourceDirUrl, { recursive: true });
    await writeFile(rendererJsUrl, jsSource);
    await writeFile(rendererCssUrl, cssSource);
    await writeFile(siftWasmUrl, wasmBytes);

    const result = await copyRendererSidecarAssets({
      rendererJsUrl,
      rendererCssUrl,
      siftWasmUrl,
      assetsDirUrl,
      pluginsDirUrl,
    });

    assert.match(result.manifest.js, /^isolated-renderer\.[a-f0-9]{16}\.js$/);
    assert.match(result.manifest.css, /^isolated-renderer\.[a-f0-9]{16}\.css$/);
    assert.match(result.manifest.siftWasm, /^sift_wasm\.[a-f0-9]{16}\.wasm$/);

    // Stable names AND hashed names in the plugins dir (the renderer-assets
    // worker's asset root; the main origin serves the same dir via
    // /plugins/ and /renderer-assets/).
    assert.equal(
      await readFile(new URL(ISOLATED_RENDERER_JS_STABLE_NAME, pluginsDirUrl), "utf8"),
      jsSource,
    );
    assert.equal(
      await readFile(new URL(ISOLATED_RENDERER_CSS_STABLE_NAME, pluginsDirUrl), "utf8"),
      cssSource,
    );
    assert.equal(await readFile(new URL(SIFT_WASM_STABLE_NAME, pluginsDirUrl), "utf8"), wasmBytes);
    assert.equal(await readFile(new URL(result.manifest.js, pluginsDirUrl), "utf8"), jsSource);
    assert.equal(await readFile(new URL(result.manifest.css, pluginsDirUrl), "utf8"), cssSource);
    assert.equal(
      await readFile(new URL(result.manifest.siftWasm, pluginsDirUrl), "utf8"),
      wasmBytes,
    );

    const manifest = JSON.parse(
      await readFile(new URL(RENDERER_SIDECAR_ASSET_MANIFEST, assetsDirUrl), "utf8"),
    );
    assert.deepEqual(manifest, result.manifest);
    await stat(result.manifestUrl);
  });

  it("derives distinct hashes per asset content", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "renderer-sidecar-assets-"));
    const tempUrl = pathToFileURL(`${tempDir}/`);
    const sourceDirUrl = new URL("source/", tempUrl);
    const rendererJsUrl = new URL("a.js", sourceDirUrl);
    const rendererCssUrl = new URL("a.css", sourceDirUrl);
    const siftWasmUrl = new URL("a.wasm", sourceDirUrl);

    await mkdir(sourceDirUrl, { recursive: true });
    await writeFile(rendererJsUrl, "same-bytes");
    await writeFile(rendererCssUrl, "same-bytes");
    await writeFile(siftWasmUrl, "other-bytes");

    const result = await copyRendererSidecarAssets({
      rendererJsUrl,
      rendererCssUrl,
      siftWasmUrl,
      assetsDirUrl: new URL("dist/assets/", tempUrl),
      pluginsDirUrl: new URL("dist/plugins/", tempUrl),
    });

    const hashOf = (name) => name.split(".")[1];
    // Same content -> same hash segment; different content -> different.
    assert.equal(hashOf(result.manifest.js), hashOf(result.manifest.css));
    assert.notEqual(hashOf(result.manifest.js), hashOf(result.manifest.siftWasm));
  });
});
