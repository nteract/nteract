import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  parseMarkdown,
  exportMarkdown,
  enableRich,
  textPath,
  validateRich,
  blockMarkdown,
} from "./richtext.mjs";
import { decode, encode } from "../viewer/wordgard-model.mjs";

test("tables nested in quotes and lists retain every row inside their container", () => {
  for (const source of [
    "> | A | B |\n> | --- | --- |\n> | X | Y |",
    "- Intro\n\n  | A | B |\n  | --- | --- |\n  | X | Y |",
    "1. Intro\n\n   > | A | B |\n   > | --- | --- |\n   > | X | Y |\n\n2. Tail",
  ]) {
    const parsed = parseMarkdown(source),
      exported = exportMarkdown(parsed);
    assert.deepEqual(parseMarkdown(exported).toJSON(), parsed.toJSON());
    const native = A.change(
      A.from({ blocks: { one: { id: "one", kind: "markdown", markdown: source } } }),
      (d) => enableRich(d, "one"),
    );
    const tree = decode(A.spans(native, textPath("one"))).doc;
    assert.ok(decode(encode(tree)).doc.eq(tree));
    validateRich(native.blocks.one);
    assert.equal(blockMarkdown(native.blocks.one), source);
  }
});
