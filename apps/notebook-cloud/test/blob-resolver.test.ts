import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createNotebookCloudBlobResolver,
  notebookCloudBlobBasePath,
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
});
