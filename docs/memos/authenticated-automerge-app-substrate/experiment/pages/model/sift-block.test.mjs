import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  createPageData,
  initializePage,
  applyPageOperation,
  orderedBlockIds,
  projectPage,
} from "./page.mjs";
import { textPath } from "./richtext.mjs";
import { decode, CodeBlock, CodeBlockLanguage } from "../viewer/wordgard-model.mjs";
import { parseSiftSource, siftSource } from "../shared/dataset-assets.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const src = `/api/pages/${pageId}/assets/${"d".repeat(64)}`;

// An agent writes a dataset table as Markdown. The fence must reach the
// editor as a `sift` code block, and read back byte for byte.
test("an inserted sift fence is a sift code block that reads back unchanged", () => {
  const before = A.change(A.from(createPageData({ pageId })), (doc) =>
    initializePage(doc, "Intro"),
  );
  const body = siftSource({ src, title: "Usage by day" });
  const markdown = "```sift\n" + body + "\n```";
  let result;
  const after = A.change(A.clone(before), (draft) => {
    result = applyPageOperation(draft, {
      operation: "edit_page",
      arguments: { operations: [{ op: "insert_markdown", markdown }] },
    });
  });
  assert.deepEqual(result, { page_id: pageId });
  const [, inserted] = orderedBlockIds(after);
  assert.equal(projectPage(after).blocks[1].markdown, markdown);
  const { doc } = decode(A.spans(after, textPath(inserted)));
  const block = doc.firstChild;
  assert.equal(block.type, CodeBlock.type);
  assert.equal(block.mark(CodeBlockLanguage), "sift");
  assert.deepEqual(parseSiftSource(block.textContent()), { src, title: "Usage by day" });
});
