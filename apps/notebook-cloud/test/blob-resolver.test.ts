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

  it("can resolve protected binary blobs through authenticated object URLs", async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    URL.createObjectURL = (() =>
      "blob:https://viewer.example.test/object-url") as typeof URL.createObjectURL;
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const resolver = createNotebookCloudBlobResolver({
      baseUrl: "https://viewer.example.test/n/notebook-1",
      blobBasePath: "/api/n/notebook-1/blobs/",
      authenticatedBinaryObjectUrls: true,
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
        "blob:https://viewer.example.test/object-url",
      );
      assert.equal(
        await resolver.displayUrl?.({
          blob: "sha256:image",
          media_type: "image/png",
          size: 4,
        }),
        "blob:https://viewer.example.test/object-url",
      );
    } finally {
      URL.createObjectURL = originalCreateObjectUrl;
    }

    assert.deepEqual(fetchCalls, [
      {
        input: "https://viewer.example.test/api/n/notebook-1/blobs/sha256%3Aimage",
        init: { cache: "no-store" },
      },
    ]);
  });
});
