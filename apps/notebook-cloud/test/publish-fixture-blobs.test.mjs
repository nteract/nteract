import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { fixtureBlobUploadHash } from "../scripts/publish-fixture-blobs.mjs";

const bytes = new TextEncoder().encode("fixture blob body");
const digest = createHash("sha256").update(bytes).digest("hex");

describe("publish fixture blob hashes", () => {
  it("uploads bare sha256 hex manifests under the declared hash", () => {
    assert.equal(fixtureBlobUploadHash({ hash: digest, path: "blobs/a.bin" }, bytes), digest);
  });

  it("strips a sha256: prefix so the Worker path hash matches the body digest", () => {
    assert.equal(
      fixtureBlobUploadHash({ hash: `sha256:${digest}`, path: "blobs/a.bin" }, bytes),
      digest,
    );
  });

  it("rejects bytes that do not digest to the declared hash", () => {
    assert.throws(
      () => fixtureBlobUploadHash({ hash: digest, path: "blobs/a.bin" }, new Uint8Array([1])),
      /hash mismatch: manifest declares/,
    );
  });

  it("rejects hashes that are not sha256 hex", () => {
    assert.throws(() => fixtureBlobUploadHash({ hash: "" }, bytes), /missing hash/);
    assert.throws(
      () => fixtureBlobUploadHash({ hash: "md5:abc", path: "blobs/a.bin" }, bytes),
      /must be sha256 hex/,
    );
    assert.throws(
      () => fixtureBlobUploadHash({ hash: "sha256:not-hex" }, bytes),
      /must be sha256 hex/,
    );
  });

  it("matches the checked-in sift_arrow_output fixture", async () => {
    const fixtureRoot = new URL(
      "../../../packages/runtimed/tests/fixtures/sift_arrow_output/",
      import.meta.url,
    );
    const manifest = JSON.parse(await readFile(new URL("manifest.json", fixtureRoot), "utf8"));
    const [blob] = manifest.blobs;
    const blobBytes = await readFile(new URL(blob.path, fixtureRoot));

    assert.equal(fixtureBlobUploadHash(blob, blobBytes), blob.hash);
    assert.match(blob.hash, /^[0-9a-f]{64}$/);
  });
});
