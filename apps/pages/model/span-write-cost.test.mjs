// A block's span writes must not grow the document when they change nothing
// but one attribute. Automerge's updateSpans compared a mark that spans
// several text runs (bold over plain and code text) piece by piece, removed
// it and wrote it again on every write; each write then read more mark state
// and a block an agent edited often got slower with every edit.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { blockMarkdown } from "./richtext.mjs";
import { blockAddress } from "./addresses.mjs";

const pageId = "77777777-7777-4777-8777-777777777777";
const item = (i) =>
  `- [ ] **Step ${i}: move \`svc-${i}\`** and check **alerts** in [the runbook](https://example.org/${i})`;
const LIST = Array.from({ length: 16 }, (_, i) => item(i + 1)).join("\n");

function rewrite(doc, key, markdown) {
  return A.change(doc, (draft) => {
    applyPageOperation(draft, {
      operation: "edit_page",
      arguments: {
        operations: [{ op: "replace_block_markdown", node_id: blockAddress(doc, key), markdown }],
      },
    });
  });
}

test("rewriting a task list to tick one item writes only that item's change", () => {
  let doc = A.change(A.from(createPageData({ pageId, title: "Plan" })), (draft) =>
    initializePage(draft, LIST),
  );
  const [key] = orderedBlockIds(doc);
  const added = [];
  for (let i = 0; i < 12; i++) {
    const markdown = blockMarkdown(doc.blocks[key], pageId);
    const ticked =
      i % 2 === 0
        ? markdown.replace("- [ ] **Step 1:", "- [x] **Step 1:")
        : markdown.replace("- [x] **Step 1:", "- [ ] **Step 1:");
    assert.notEqual(ticked, markdown);
    const before = A.stats(doc).numOps;
    doc = rewrite(doc, key, ticked);
    added.push(A.stats(doc).numOps - before);
  }
  // One attribute write per tick, and the same count every time.
  assert.ok(Math.max(...added) <= 4, `ops per tick: ${added.join(", ")}`);
  assert.equal(new Set(added).size, 1, `ops per tick: ${added.join(", ")}`);
});
