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
});
