import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeRendererAssetNames } from "../viewer/cloud-viewer-config.ts";

/**
 * The client half of the manifest-missing contract: the viewer bundle
 * ships under a stable name, so NEW viewer JS routinely executes against
 * OLD shell config (gradual worker deploys). A config without the
 * rendererAssets key — or with partial keys — must resolve to the stable
 * names, never throw.
 */
describe("cloud viewer renderer asset name normalization", () => {
  it("falls back to the stable names when the shell config predates rendererAssets", () => {
    assert.deepEqual(normalizeRendererAssetNames(undefined), {
      js: "isolated-renderer.js",
      css: "isolated-renderer.css",
      siftWasm: "sift_wasm.wasm",
    });
  });

  it("fills missing or empty keys per-field while keeping provided names", () => {
    assert.deepEqual(
      normalizeRendererAssetNames({ js: "isolated-renderer.0123456789abcdef.js", css: "" }),
      {
        js: "isolated-renderer.0123456789abcdef.js",
        css: "isolated-renderer.css",
        siftWasm: "sift_wasm.wasm",
      },
    );
  });

  it("passes a complete manifest through untouched", () => {
    const names = {
      js: "isolated-renderer.0123456789abcdef.js",
      css: "isolated-renderer.fedcba9876543210.css",
      siftWasm: "sift_wasm.a1b2c3d4e5f60718.wasm",
    };
    assert.deepEqual(normalizeRendererAssetNames(names), names);
  });
});
