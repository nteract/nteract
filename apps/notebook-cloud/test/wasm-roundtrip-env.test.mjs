import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertWasmRoundtripAuthEnv, isLoopbackBaseUrl } from "../scripts/wasm-roundtrip-env.mjs";

describe("wasm roundtrip smoke environment", () => {
  it("allows loopback Wrangler runs without a dev token", () => {
    assert.doesNotThrow(() =>
      assertWasmRoundtripAuthEnv({
        baseUrl: "http://127.0.0.1:8787",
        devAuthToken: undefined,
      }),
    );
    assert.equal(isLoopbackBaseUrl("http://localhost:8787"), true);
    assert.equal(isLoopbackBaseUrl("http://[::1]:8787"), true);
  });

  it("requires an environment dev token for deployed Worker runs", () => {
    assert.throws(
      () =>
        assertWasmRoundtripAuthEnv({
          baseUrl: "https://nteract-notebook-cloud.rgbkrk.workers.dev",
          devAuthToken: undefined,
        }),
      /NOTEBOOK_CLOUD_DEV_TOKEN is required/,
    );
  });

  it("allows deployed Worker runs when the dev token comes from the environment", () => {
    assert.doesNotThrow(() =>
      assertWasmRoundtripAuthEnv({
        baseUrl: "https://nteract-notebook-cloud.rgbkrk.workers.dev",
        devAuthToken: "token-from-env",
      }),
    );
  });
});
