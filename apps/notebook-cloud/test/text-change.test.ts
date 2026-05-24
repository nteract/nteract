import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { minimalTextReplacement } from "../viewer/text-change.ts";

describe("minimalTextReplacement", () => {
  it("returns null when the text is unchanged", () => {
    assert.equal(minimalTextReplacement("same", "same"), null);
  });

  it("keeps common prefix and suffix for insertions", () => {
    assert.deepEqual(minimalTextReplacement("hello world", "hello brave world"), {
      from: 6,
      to: 6,
      insert: "brave ",
    });
  });

  it("keeps common prefix and suffix for replacements", () => {
    assert.deepEqual(minimalTextReplacement("alpha beta gamma", "alpha delta gamma"), {
      from: 6,
      to: 8,
      insert: "del",
    });
  });

  it("keeps common prefix and suffix for deletions", () => {
    assert.deepEqual(minimalTextReplacement("alpha beta gamma", "alpha gamma"), {
      from: 6,
      to: 11,
      insert: "",
    });
  });
});
