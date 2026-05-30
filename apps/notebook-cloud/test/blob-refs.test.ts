import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectBlobRefs } from "../src/blob-refs.ts";

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
});
