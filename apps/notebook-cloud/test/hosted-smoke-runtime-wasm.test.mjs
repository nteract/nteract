import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkRuntimeWasmHints } from "../scripts/hosted-render-smoke-runtime-wasm.mjs";

describe("hosted smoke runtime WASM hints", () => {
  it("accepts the viewer shell modulepreload and fetch preload pair", () => {
    const check = checkRuntimeWasmHints(
      [
        {
          rel: "modulepreload",
          href: "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev/renderer-assets/runtimed_wasm.js",
          as: "",
          type: "",
          crossorigin: "",
          crossOrigin: "",
        },
        {
          rel: "preload",
          href: "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev/renderer-assets/runtimed_wasm_bg.wasm",
          as: "fetch",
          type: "application/wasm",
          crossorigin: "",
          crossOrigin: "",
        },
      ],
      {
        expectedRendererAssetOrigin: "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev",
      },
    );

    assert.equal(check.ok, true);
    assert.deepEqual(check.failures, []);
    assert.match(check.modulepreload.href, /runtimed_wasm\.js$/);
    assert.match(check.wasmPreload.href, /runtimed_wasm_bg\.wasm$/);
  });

  it("reports missing or malformed runtime WASM preload hints", () => {
    const check = checkRuntimeWasmHints(
      [
        {
          rel: "preload",
          href: "https://preview.runt.run/assets/runtimed_wasm_bg.wasm",
          as: "script",
          type: "application/octet-stream",
          crossorigin: null,
          crossOrigin: null,
        },
      ],
      {
        expectedRendererAssetOrigin: "https://nteract-notebook-cloud-assets.rgbkrk.workers.dev",
      },
    );

    assert.equal(check.ok, false);
    assert.equal(check.failures.length, 5);
    assert.match(check.failures[0].text, /Missing runtimed_wasm\.js modulepreload hint/);
    assert.match(check.failures[1].text, /used as="script"/);
    assert.match(check.failures[2].text, /used type="application\/octet-stream"/);
    assert.match(check.failures[3].text, /did not declare crossorigin/);
    assert.match(
      check.failures[4].text,
      /runtimed_wasm_bg\.wasm preload did not point at https:\/\/nteract-notebook-cloud-assets\.rgbkrk\.workers\.dev/,
    );
  });

  it("can collect diagnostics without failing when runtime WASM is optional", () => {
    const check = checkRuntimeWasmHints([], { requireHints: false });

    assert.equal(check.ok, true);
    assert.deepEqual(check.runtimedWasmHints, []);
  });
});
