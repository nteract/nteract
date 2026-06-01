import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloudNotebookCellId } from "../viewer/cloud-cell-id";

test("cloud notebook cell ids use randomUUID when available", () => {
  const id = createCloudNotebookCellId({
    randomUUID: () => "random-id",
    getRandomValues: () => {
      throw new Error("getRandomValues should not be called");
    },
  });

  assert.equal(id, "random-id");
});

test("cloud notebook cell ids fall back to random bytes without timestamp collisions", () => {
  const id = createCloudNotebookCellId({
    getRandomValues: (bytes: Uint8Array) => {
      bytes.fill(0xab);
      return bytes;
    },
  });

  assert.equal(id, "cell-abababababababababababababababab");
});

test("cloud notebook cell ids keep a monotonic fallback when crypto is unavailable", () => {
  const first = createCloudNotebookCellId(null);
  const second = createCloudNotebookCellId(null);

  assert.notEqual(first, second);
  assert.match(first, /^cell-[a-z0-9]+-[a-z0-9]+$/);
  assert.match(second, /^cell-[a-z0-9]+-[a-z0-9]+$/);
});
