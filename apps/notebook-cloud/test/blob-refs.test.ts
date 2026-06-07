import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectArrowStreamManifestBlobRefs, collectBlobRefs } from "../src/blob-refs.ts";

const ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json";

describe("cloud blob ref collection", () => {
  it("collects NotebookDoc asset and attachment ref shapes", () => {
    const refs = collectBlobRefs({
      cells: [
        {
          resolved_assets: {
            "attachment:plot.png": "resolved-asset-hash",
          },
          attachments: {
            "plot.png": {
              "image/png": {
                blob_hash: "attachment-hash",
                encoding: "base64",
              },
            },
          },
        },
      ],
    });

    assert.equal(refs["resolved-asset-hash"]?.blob, "resolved-asset-hash");
    assert.equal(refs["attachment-hash"]?.blob, "attachment-hash");
    assert.equal(refs["attachment-hash"]?.media_type, "image/png");
  });

  it("collects known Arrow manifest child ref shapes without schema fingerprints", () => {
    const refs = collectBlobRefs({
      data: {
        [ARROW_STREAM_MANIFEST_MIME]: {
          inline: JSON.stringify({
            blob: "single-stream-hash",
            size: 99,
            content_type: "application/vnd.apache.arrow.stream",
            chunks: [
              { hash: "chunk-hash", size: 10 },
              { blob: "chunk-blob", media_type: "application/vnd.apache.arrow.stream" },
            ],
            blobs: [{ hash: "sidecar-hash" }],
            coalesced: {
              hash: "coalesced-hash",
              segments: [{ hash: "segment-hash" }],
            },
            schema: { hash: "schema-fingerprint" },
          }),
        },
      },
    });

    assert.equal(refs["single-stream-hash"]?.size, 99);
    assert.equal(refs["chunk-hash"]?.size, 10);
    assert.equal(refs["chunk-blob"]?.media_type, "application/vnd.apache.arrow.stream");
    assert.ok(refs["sidecar-hash"]);
    assert.ok(refs["coalesced-hash"]);
    assert.ok(refs["segment-hash"]);
    assert.equal(refs["schema-fingerprint"], undefined);
  });

  it("collects Arrow manifest pointer refs and marks them as manifest blobs", () => {
    const refs = collectBlobRefs({
      data: {
        [ARROW_STREAM_MANIFEST_MIME]: {
          inline: JSON.stringify({
            blob: "manifest-hash",
            size: 1615,
          }),
        },
      },
    });

    assert.equal(refs["manifest-hash"]?.blob, "manifest-hash");
    assert.equal(refs["manifest-hash"]?.size, 1615);
    assert.equal(refs["manifest-hash"]?.media_type, ARROW_STREAM_MANIFEST_MIME);
  });

  it("collects child refs from a resolved Arrow manifest blob", () => {
    const refs = collectArrowStreamManifestBlobRefs(
      JSON.stringify({
        chunks: [
          {
            hash: "arrow-chunk",
            size: 4096,
            content_type: "application/vnd.apache.arrow.stream",
          },
        ],
        complete: true,
      }),
    );

    assert.equal(refs["arrow-chunk"]?.blob, "arrow-chunk");
    assert.equal(refs["arrow-chunk"]?.size, 4096);
    assert.equal(refs["arrow-chunk"]?.media_type, "application/vnd.apache.arrow.stream");
  });
});
