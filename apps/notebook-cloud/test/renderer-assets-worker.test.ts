import { describe, it } from "node:test";
import assert from "node:assert/strict";
import rendererAssetsWorker from "../src/renderer-assets-worker.ts";
import type { Env, ExecutionContext } from "../src/cloudflare-types.ts";

describe("renderer assets Worker", () => {
  it("serves renderer sidecars from the plugins asset directory", async () => {
    const seenPaths: string[] = [];
    const response = await rendererAssetsWorker.fetch(
      new Request("https://assets.test/renderer-assets/sift_wasm.wasm?v=hash"),
      fakeEnv({
        ASSETS: {
          fetch: async (request: Request) => {
            seenPaths.push(new URL(request.url).pathname);
            return new Response("wasm", {
              headers: { "Content-Type": "application/wasm" },
            });
          },
        },
      }),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/sift_wasm.wasm"]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, OPTIONS");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
    assert.equal(await response.text(), "wasm");
  });

  it("does not expose the notebook app bundle from the renderer asset origin", async () => {
    const response = await rendererAssetsWorker.fetch(
      new Request("https://assets.test/assets/notebook-cloud-viewer.js"),
      fakeEnv({
        ASSETS: {
          fetch: async () => new Response("should not be reached"),
        },
      }),
      fakeContext(),
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.deepEqual(await response.json(), { error: "not found" });
  });

  it("does not cache health checks as immutable assets", async () => {
    const response = await rendererAssetsWorker.fetch(
      new Request("https://assets.test/api/health"),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Cache-Control"), null);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "nteract-notebook-cloud-renderer-assets",
    });
  });

  it("supports HEAD requests for hosted sidecars", async () => {
    const response = await rendererAssetsWorker.fetch(
      new Request("https://assets.test/plugins/sift_wasm.wasm", { method: "HEAD" }),
      fakeEnv({
        ASSETS: {
          fetch: async (request: Request) =>
            new Response(null, {
              status: new Request(request).method === "HEAD" ? 200 : 500,
              headers: { "Content-Type": "application/wasm" },
            }),
        },
      }),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
  });
});

function fakeEnv(overrides: Partial<Env> = {}): Pick<Env, "ASSETS"> {
  return {
    ASSETS: undefined,
    ...overrides,
  };
}

function fakeContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };
}
