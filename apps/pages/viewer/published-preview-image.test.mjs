import assert from "node:assert/strict";
import { test } from "node:test";
import { previewTextLines } from "./published-preview-image.mjs";

const context = { measureText: (text) => ({ width: Array.from(text).length }) };

test("preview cards wrap at word boundaries and fit truncated lines", () => {
  assert.deepEqual(previewTextLines(context, "A lovely little Page", 14, 3), [
    "A lovely",
    "little Page",
  ]);
  assert.deepEqual(previewTextLines(context, "A lovely little Page", 14, 1), ["A lovely…"]);
  assert.deepEqual(previewTextLines(context, "abcdefghij more words", 5, 2), ["abcde", "fghi…"]);
  assert.deepEqual(previewTextLines(context, "🦀🦀🦀🦀", 2, 3), ["🦀🦀", "🦀🦀"]);
  assert.deepEqual(previewTextLines(context, "", 14, 3), []);
});
