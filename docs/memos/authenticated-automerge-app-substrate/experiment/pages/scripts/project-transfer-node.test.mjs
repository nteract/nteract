import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ImageValidationError, inspectImage } from "../shared/inspect-image.mjs";

test("transfer CLI starts under plain Node without a loader or bundler aliases", () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./project-transfer.mjs", import.meta.url)), "--help"],
    {
      env,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined);
  // The existing CLI reports unsupported commands (including --help) as usage errors.
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout + result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
});

test("shared image inspection validates bytes and rejects corrupt containers under plain Node", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=",
    "base64",
  );
  assert.deepEqual(inspectImage(png), { mime_type: "image/png", width: 3, height: 2 });
  const webp = Buffer.from(
    "UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoDAAIAAUAmJaACdLoB+AAEyAAA/q4X/yU1/jblq/+QXq3zbGgAAA==",
    "base64",
  );
  assert.deepEqual(inspectImage(webp), { mime_type: "image/webp", width: 3, height: 2 });
  png[45] ^= 1;
  for (const bytes of [png, webp.subarray(0, 20), new Uint8Array(12), null])
    assert.throws(
      () => inspectImage(bytes),
      (error) => error instanceof ImageValidationError && error.status === 415,
    );
  const tooWide = Buffer.from(webp);
  tooWide[26] = 1;
  tooWide[27] = 32;
  assert.throws(
    () => inspectImage(tooWide),
    (error) => error instanceof ImageValidationError && error.status === 413,
  );
});
