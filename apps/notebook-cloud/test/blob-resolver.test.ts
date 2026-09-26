import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createNotebookCloudBlobResolver,
  notebookCloudBlobBasePath,
  BLOB_DISPLAY_CACHE_MAX_BYTES,
  BLOB_DISPLAY_CACHE_MAX_ENTRIES,
} from "../src/blob-resolver.ts";

describe("notebook cloud blob resolver", () => {
  it("derives the default hosted blob base path in one place", () => {
    assert.equal(notebookCloudBlobBasePath("space notebook"), "/api/n/space%20notebook/blobs/");
  });

  it("uses the configured blob base path instead of recomputing viewer routes", () => {
    const resolver = createNotebookCloudBlobResolver({
      baseUrl: "https://viewer.example.test/n/notebook-1",
      blobBasePath: "https://cdn.example.test/notebooks/notebook-1/blobs",
    });

    assert.equal(
      resolver.url({ blob: "sha256:abc/def" }),
      "https://cdn.example.test/notebooks/notebook-1/blobs/sha256%3Aabc%2Fdef",
    );
  });

  it("retries transient hosted blob misses before returning the response", async () => {
    const statuses = [404, 200];
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const resolver = createNotebookCloudBlobResolver({
      baseUrl: "https://viewer.example.test/n/notebook-1",
      blobBasePath: "/api/n/notebook-1/blobs/",
      fetchImpl: async (input, init) => {
        fetchCalls.push({ input, init });
        const status = statuses.shift() ?? 500;
        return new Response(status === 200 ? "ready" : "missing", { status });
      },
    });

    const response = await resolver.fetch({ blob: "sha256:late" });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ready");
    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(
      fetchCalls.map((call) => call.input),
      [
        "https://viewer.example.test/api/n/notebook-1/blobs/sha256%3Alate",
        "https://viewer.example.test/api/n/notebook-1/blobs/sha256%3Alate",
      ],
    );
  });

  it("returns the final hosted blob miss after retry attempts are exhausted", async () => {
    let fetchCount = 0;
    const resolver = createNotebookCloudBlobResolver({
      baseUrl: "https://viewer.example.test/n/notebook-1",
      blobBasePath: "/api/n/notebook-1/blobs/",
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response("missing", { status: 404 });
      },
    });

    const response = await resolver.fetch({ blob: "sha256:missing" });

    assert.equal(response.status, 404);
    assert.equal(fetchCount, 3);
  });

  it("can resolve protected binary blobs through authenticated display URLs", async () => {
    const originalFileReader = globalThis.FileReader;
    class TestFileReader {
      result: string | ArrayBuffer | null = null;
      error: Error | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(blob: Blob) {
        blob
          .arrayBuffer()
          .then((buffer) => {
            this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
            this.onload?.();
          })
          .catch((error) => {
            this.error = error instanceof Error ? error : new Error(String(error));
            this.onerror?.();
          });
      }
    }
    globalThis.FileReader = TestFileReader as typeof FileReader;
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const resolver = createNotebookCloudBlobResolver({
      baseUrl: "https://viewer.example.test/n/notebook-1",
      blobBasePath: "/api/n/notebook-1/blobs/",
      authenticatedBinaryDisplayUrls: true,
      fetchImpl: async (input, init) => {
        fetchCalls.push({ input, init });
        return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
      },
    });

    try {
      assert.equal(resolver.resolvesBinaryUrlsSynchronously, false);
      assert.equal(
        await resolver.displayUrl?.({
          blob: "sha256:image",
          media_type: "image/png",
          size: 4,
        }),
        "data:image/png;base64,iVBORw==",
      );
      assert.equal(
        await resolver.displayUrl?.({
          blob: "sha256:image",
          media_type: "image/png",
          size: 4,
        }),
        "data:image/png;base64,iVBORw==",
      );
    } finally {
      globalThis.FileReader = originalFileReader;
    }

    assert.deepEqual(fetchCalls, [
      {
        input: "https://viewer.example.test/api/n/notebook-1/blobs/sha256%3Aimage",
        init: { cache: "no-store" },
      },
    ]);
  });

  it("lets ordinary authenticated blob fetches use the browser cache", async () => {
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const resolver = createNotebookCloudBlobResolver({
      baseUrl: "https://viewer.example.test/n/notebook-1",
      blobBasePath: "/api/n/notebook-1/blobs/",
      authenticatedBinaryDisplayUrls: true,
      fetchImpl: async (input, init) => {
        fetchCalls.push({ input, init });
        return new Response("<table></table>", {
          headers: { "Content-Type": "text/html" },
        });
      },
    });

    const response = await resolver.fetch({ blob: "sha256:html", media_type: "text/html" });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<table></table>");
    assert.deepEqual(fetchCalls, [
      {
        input: "https://viewer.example.test/api/n/notebook-1/blobs/sha256%3Ahtml",
        init: undefined,
      },
    ]);
  });

  it("coalesces concurrent protected binary display URL requests", async () => {
    const originalFileReader = globalThis.FileReader;
    class TestFileReader {
      result: string | ArrayBuffer | null = null;
      error: Error | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(blob: Blob) {
        blob
          .arrayBuffer()
          .then((buffer) => {
            this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
            this.onload?.();
          })
          .catch((error) => {
            this.error = error instanceof Error ? error : new Error(String(error));
            this.onerror?.();
          });
      }
    }
    globalThis.FileReader = TestFileReader as typeof FileReader;
    let resolveFetch!: (response: Response) => void;
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const resolver = createNotebookCloudBlobResolver({
      baseUrl: "https://viewer.example.test/n/notebook-1",
      blobBasePath: "/api/n/notebook-1/blobs/",
      authenticatedBinaryDisplayUrls: true,
      fetchImpl: async (input, init) => {
        fetchCalls.push({ input, init });
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      },
    });

    try {
      const first = resolver.displayUrl?.({
        blob: "sha256:image",
        media_type: "image/png",
        size: 4,
      });
      const second = resolver.displayUrl?.({
        blob: "sha256:image",
        media_type: "image/png",
        size: 4,
      });

      assert.equal(fetchCalls.length, 1);
      resolveFetch(
        new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })),
      );
      assert.deepEqual(await Promise.all([first, second]), [
        "data:image/png;base64,iVBORw==",
        "data:image/png;base64,iVBORw==",
      ]);
      assert.equal(
        await resolver.displayUrl?.({
          blob: "sha256:image",
          media_type: "image/png",
          size: 4,
        }),
        "data:image/png;base64,iVBORw==",
      );
    } finally {
      globalThis.FileReader = originalFileReader;
    }

    assert.deepEqual(fetchCalls, [
      {
        input: "https://viewer.example.test/api/n/notebook-1/blobs/sha256%3Aimage",
        init: { cache: "no-store" },
      },
    ]);
  });

  it("keeps fallback display URLs frame-safe and uses the declared MIME type", async (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
    Object.defineProperty(globalThis, "FileReader", { configurable: true, value: undefined });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, "FileReader", descriptor);
      else Reflect.deleteProperty(globalThis, "FileReader");
    });
    t.mock.method(URL, "createObjectURL", () => assert.fail("unowned object URL"));
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
    const resolver = protectedResolver(
      async () => new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }),
    );
    const display = await resolver.displayUrl!({ blob: "raster" }, "image/png");
    assert.ok(display.startsWith("data:image/png;base64,"));
    assert.deepEqual(new Uint8Array(await (await fetch(display)).arrayBuffer()), bytes);
  });

  it("does not cache or retry authorization failures", async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      const resolver = protectedResolver(async () => {
        calls++;
        return calls === 1 ? new Response(null, { status }) : new Response("ok");
      });
      await assert.rejects(resolver.displayUrl!({ blob: "private" }), new RegExp(`${status}`));
      assert.equal(calls, 1);
      assert.ok((await resolver.displayUrl!({ blob: "private" })).startsWith("data:"));
      assert.equal(calls, 2);
    }
  });

  it("bounds cached entries and keeps recently used and already displayed images usable", async () => {
    let calls = 0;
    const resolver = protectedResolver(async () => {
      calls++;
      return new Response("image");
    });
    const resolve = (blob: string) => resolver.displayUrl!({ blob });
    const displayed = await resolve("oldest");
    await resolve("keep");
    for (let i = 0; i < BLOB_DISPLAY_CACHE_MAX_ENTRIES - 2; i++) await resolve(`image-${i}`);
    await resolve("keep");
    await resolve("new");
    assert.equal(calls, BLOB_DISPLAY_CACHE_MAX_ENTRIES + 1);
    await resolve("keep");
    assert.equal(calls, BLOB_DISPLAY_CACHE_MAX_ENTRIES + 1);
    assert.equal(await (await fetch(displayed)).text(), "image");
    assert.equal(await resolve("oldest"), displayed);
    assert.equal(calls, BLOB_DISPLAY_CACHE_MAX_ENTRIES + 2);
  });

  it("bounds retained data URL bytes even below the entry limit", async () => {
    let calls = 0;
    const resolver = protectedResolver(async () => {
      calls++;
      return new Response(new Uint8Array(BLOB_DISPLAY_CACHE_MAX_BYTES / 4));
    });
    const first = await resolver.displayUrl!({ blob: "first" });
    await resolver.displayUrl!({ blob: "second" });
    await resolver.displayUrl!({ blob: "second" });
    assert.equal(calls, 2);
    assert.equal(await resolver.displayUrl!({ blob: "first" }), first);
    assert.equal(calls, 3);
  });

  it("renders oversized images without retaining them in the reuse cache", async () => {
    let calls = 0;
    const resolver = protectedResolver(async () => {
      calls++;
      return new Response(new Uint8Array(BLOB_DISPLAY_CACHE_MAX_BYTES / 2));
    });
    const first = await resolver.displayUrl!({ blob: "large" });
    assert.ok(first.length * 2 > BLOB_DISPLAY_CACHE_MAX_BYTES);
    assert.equal(await resolver.displayUrl!({ blob: "large" }), first);
    assert.equal(calls, 2);
  });

  it("keeps a retired resolver's pending result out of a new auth resolver", async () => {
    let finish!: (response: Response) => void;
    const old = protectedResolver(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const oldRequest = old.displayUrl!({ blob: "same-hash" });
    let calls = 0;
    const current = protectedResolver(async () => {
      calls++;
      return new Response(null, { status: 403 });
    });
    finish(new Response("old authorized bytes"));
    await oldRequest;
    await assert.rejects(current.displayUrl!({ blob: "same-hash" }), /403/);
    assert.equal(calls, 1);
  });
});

function protectedResolver(fetchImpl: typeof fetch) {
  return createNotebookCloudBlobResolver({
    baseUrl: "https://viewer.example.test/n/notebook-1",
    blobBasePath: "/api/n/notebook-1/blobs/",
    authenticatedBinaryDisplayUrls: true,
    fetchImpl,
  });
}
