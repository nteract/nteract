import { describe, it } from "node:test";
import assert from "node:assert/strict";
import outputDocumentWorker from "../src/output-document-worker.ts";
import type { Env, ExecutionContext } from "../src/cloudflare-types.ts";

describe("output document Worker", () => {
  it("serves only the isolated output document shell", async () => {
    const seenPaths: string[] = [];
    const response = await outputDocumentWorker.fetch(
      new Request("https://outputs.test/frame/"),
      fakeEnv({
        ASSETS: {
          fetch: async (request: Request) => {
            seenPaths.push(new URL(request.url).pathname);
            return new Response(
              "<!doctype html><script>parent.postMessage('ready', '*')</script>",
              {
                headers: { "Content-Type": "text/html; charset=utf-8" },
              },
            );
          },
        },
      }),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenPaths, ["/"]);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
    assert.match(response.headers.get("Content-Security-Policy") ?? "", /script-src/);
    assert.match(response.headers.get("Content-Security-Policy") ?? "", /frame-src 'none'/);
    assert.match(response.headers.get("Permissions-Policy") ?? "", /camera=\(\)/);
    assert.match(response.headers.get("Cache-Control") ?? "", /\bno-transform\b/);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
    assert.match(await response.text(), /<!doctype html>/i);
  });

  it("supports HEAD for the frame document without widening the route surface", async () => {
    const seenRequests: Array<{ method: string; pathname: string }> = [];
    const response = await outputDocumentWorker.fetch(
      new Request("https://outputs.test/frame", { method: "HEAD" }),
      fakeEnv({
        ASSETS: {
          fetch: async (request: Request) => {
            seenRequests.push({
              method: request.method,
              pathname: new URL(request.url).pathname,
            });
            return new Response(null, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          },
        },
      }),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(seenRequests, [{ method: "HEAD", pathname: "/" }]);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(await response.text(), "");
  });

  it("does not expose app APIs, room sockets, viewer bundles, renderer assets, or blobs", async () => {
    const blockedRoutes = [
      "/api/n/demo/render",
      "/api/n/demo/blobs/sha256-demo",
      "/n/demo/sync",
      "/assets/notebook-cloud-viewer.js",
      "/renderer-assets/sift_wasm.wasm",
      "/plugins/sift_wasm.wasm",
    ];

    for (const pathname of blockedRoutes) {
      const response = await outputDocumentWorker.fetch(
        new Request(new URL(pathname, "https://outputs.test")),
        fakeEnv({
          ASSETS: {
            fetch: async () => new Response("should not be reached"),
          },
        }),
        fakeContext(),
      );

      assert.equal(response.status, 404, pathname);
      assert.deepEqual(await response.json(), { error: "not found" }, pathname);
    }
  });

  it("rejects mutation-shaped requests before the assets binding", async () => {
    const response = await outputDocumentWorker.fetch(
      new Request("https://outputs.test/frame/", { method: "POST", body: "x" }),
      fakeEnv({
        ASSETS: {
          fetch: async () => new Response("should not be reached"),
        },
      }),
      fakeContext(),
    );

    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { error: "method not allowed" });
  });

  it("reports health without cacheable document headers or credential material", async () => {
    const response = await outputDocumentWorker.fetch(
      new Request("https://outputs.test/api/health"),
      fakeEnv(),
      fakeContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "nteract-notebook-cloud-output-document",
    });
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
