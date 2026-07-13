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
    assert.equal(response.headers.get("Timing-Allow-Origin"), "*");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
    assert.equal(response.headers.get("Content-Type"), "application/wasm");
    assert.equal(await response.text(), "wasm");
  });

  it("serves runtimed WASM assets from the same CORS-enabled asset origin", async () => {
    const seenPaths: string[] = [];
    const response = await rendererAssetsWorker.fetch(
      new Request("https://assets.test/renderer-assets/runtimed_wasm_bg.wasm"),
      fakeEnv({
        ASSETS: {
          fetch: async (request: Request) => {
            seenPaths.push(new URL(request.url).pathname);
            return new Response("runtime-wasm", {
              headers: { "Content-Type": "application/wasm" },
            });
          },
        },
      }),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/runtimed_wasm_bg.wasm"]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Timing-Allow-Origin"), "*");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
  });

  it("serves content-hashed runtime WASM assets with immutable caching", async () => {
    const seenPaths: string[] = [];
    const response = await rendererAssetsWorker.fetch(
      new Request("https://assets.test/renderer-assets/runtimed_wasm_bg.0123456789abcdef.wasm"),
      fakeEnv({
        ASSETS: {
          fetch: async (request: Request) => {
            seenPaths.push(new URL(request.url).pathname);
            return new Response("runtime-wasm", {
              headers: { "Content-Type": "application/wasm" },
            });
          },
        },
      }),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/runtimed_wasm_bg.0123456789abcdef.wasm"]);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Timing-Allow-Origin"), "*");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  });

  it("serves content-hashed renderer sidecars with immutable caching", async () => {
    const cases = [
      "https://assets.test/renderer-assets/isolated-renderer.0123456789abcdef.js",
      "https://assets.test/renderer-assets/isolated-renderer.fedcba9876543210.css",
      "https://assets.test/renderer-assets/sift_wasm.a1b2c3d4e5f60718.wasm",
    ];

    for (const url of cases) {
      const response = await rendererAssetsWorker.fetch(
        new Request(url),
        fakeEnv({
          ASSETS: {
            fetch: async () => new Response("sidecar"),
          },
        }),
        fakeContext(),
      );

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    }
  });

  it("keeps stable-name renderer sidecars on must-revalidate", async () => {
    for (const name of ["isolated-renderer.js", "isolated-renderer.css"]) {
      const response = await rendererAssetsWorker.fetch(
        new Request(`https://assets.test/renderer-assets/${name}`),
        fakeEnv({
          ASSETS: {
            fetch: async () => new Response("sidecar"),
          },
        }),
        fakeContext(),
      );

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
    }
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

  it("rejects traversal-shaped renderer asset paths before asset lookup", async () => {
    const requests = [
      "https://assets.test/renderer-assets/../assets/notebook-cloud-viewer.js",
      "https://assets.test/renderer-assets/%2e%2e%2fassets%2fnotebook-cloud-viewer.js",
      "https://assets.test/plugins/%2e%2e%5csift_wasm.wasm",
    ];

    for (const request of requests) {
      const response = await rendererAssetsWorker.fetch(
        new Request(request),
        fakeEnv({
          ASSETS: {
            fetch: async () => new Response("should not be reached"),
          },
        }),
        fakeContext(),
      );

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not found" });
    }
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

  it("falls through to the Custom Domain Worker when the sidecar asset is unavailable", async (t) => {
    const assetRequests: Array<{ method: string; url: string }> = [];
    const originRequests: Array<{ method: string; url: string; etag: string | null }> = [];
    const assetStatuses = [404, 503];
    const originFetch = t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        originRequests.push({
          method: request.method,
          url: request.url,
          etag: request.headers.get("If-None-Match"),
        });
        return new Response("main-worker-asset", {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "X-Renderer-Asset-Source": "main-worker",
          },
        });
      },
    );

    for (const status of assetStatuses) {
      const response = await rendererAssetsWorker.fetch(
        new Request("https://cloud.test/renderer-assets/sift_wasm.wasm?v=build", {
          headers: { "If-None-Match": '"previous"' },
        }),
        fakeEnv({
          ASSETS: {
            fetch: async (request: Request) => {
              assetRequests.push({ method: request.method, url: request.url });
              return new Response("sidecar miss", { status });
            },
          },
        }),
        fakeContext(),
      );

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("X-Renderer-Asset-Source"), "main-worker");
      assert.equal(await response.text(), "main-worker-asset");
    }

    assert.deepEqual(assetRequests, [
      { method: "GET", url: "https://cloud.test/sift_wasm.wasm?v=build" },
      { method: "GET", url: "https://cloud.test/sift_wasm.wasm?v=build" },
    ]);
    assert.deepEqual(originRequests, [
      {
        method: "GET",
        url: "https://cloud.test/renderer-assets/sift_wasm.wasm?v=build",
        etag: '"previous"',
      },
      {
        method: "GET",
        url: "https://cloud.test/renderer-assets/sift_wasm.wasm?v=build",
        etag: '"previous"',
      },
    ]);
    assert.equal(originFetch.mock.callCount(), assetStatuses.length);
  });

  it("falls through when the sidecar assets binding is absent", async (t) => {
    const originFetch = t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response("main-worker-asset", {
          headers: { "X-Renderer-Asset-Source": "main-worker" },
        }),
    );

    const response = await rendererAssetsWorker.fetch(
      new Request("https://cloud.test/renderer-assets/sift_wasm.wasm"),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Renderer-Asset-Source"), "main-worker");
    assert.equal(originFetch.mock.callCount(), 1);
  });

  it("keeps cache-validation responses in the sidecar Worker", async (t) => {
    const originFetch = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("origin fallback should not run");
    });

    const response = await rendererAssetsWorker.fetch(
      new Request("https://cloud.test/renderer-assets/sift_wasm.wasm"),
      fakeEnv({
        ASSETS: {
          fetch: async () => new Response(null, { status: 304 }),
        },
      }),
      fakeContext(),
    );

    assert.equal(response.status, 304);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(originFetch.mock.callCount(), 0);
  });

  it("returns the sidecar error when no downstream origin is available", async (t) => {
    const originFetch = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("no downstream Custom Domain Worker");
    });

    const response = await rendererAssetsWorker.fetch(
      new Request("https://assets.test/renderer-assets/missing.wasm"),
      fakeEnv({
        ASSETS: {
          fetch: async () => new Response("sidecar miss", { status: 404 }),
        },
      }),
      fakeContext(),
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(await response.text(), "sidecar miss");
    assert.equal(originFetch.mock.callCount(), 1);
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
