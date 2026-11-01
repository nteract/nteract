import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { pagePreview } from "./page-preview.mjs";

const asset = `/api/pages/5f0c4a5e-6c1e-4b0e-9a8f-0d0d4c5e6f70/assets/${"a".repeat(64)}`;
const page = (markdown) =>
  A.change(A.from(createPageData({ pageId: "p", title: "Roadmap" })), (draft) =>
    initializePage(draft, markdown),
  );

test("the preview renders blocks with the schema's own tags and attributes", (t) => {
  const doc = page(
    [
      "# Plan",
      "Some **bold**, *em*, `code`, ~~gone~~ and [a link](https://example.com).",
      "- [x] done",
      "| a | b |\n|:--|--:|\n| 1 | 2 |",
      `![Figure](${asset})`,
    ].join("\n\n"),
  );
  t.after(() => A.free(doc));
  const preview = pagePreview(doc);
  assert.equal(preview.title, "Roadmap");
  assert.equal(preview.truncated, false);
  assert.equal(preview.blocks.length, 1);
  assert.equal(preview.blocks[0].id, orderedBlockIds(doc)[0]);
  const [heading, paragraph, tasks, table, figure] = preview.blocks[0].content;
  assert.deepEqual(heading, ["h1", {}, "Plan"]);
  assert.deepEqual(paragraph, [
    "p",
    {},
    "Some ",
    ["strong", {}, "bold"],
    ", ",
    ["em", {}, "em"],
    ", ",
    ["code", {}, "code"],
    ", ",
    ["s", {}, "gone"],
    " and ",
    ["a", { href: "https://example.com", title: "" }, "a link"],
    ".",
  ]);
  assert.deepEqual(tasks[0], "ul");
  assert.equal(tasks[1]["data-task-list"], "true");
  assert.equal(tasks[2][1]["data-task-checked"], "true");
  assert.deepEqual(table[0], "table");
  assert.deepEqual(table[2][2][2][1], { "data-align": "left" });
  assert.deepEqual(figure, ["p", {}, ["img", { src: asset, alt: "Figure" }]]);
});

test("the preview drops unsafe link targets the way the editor does", () => {
  const doc = page("[x](https://ok.example)");
  const id = orderedBlockIds(doc)[0];
  const next = A.change(doc, (draft) =>
    A.mark(
      draft,
      ["blocks", id, "richText"],
      { start: 0, end: 1, expand: "none" },
      "link",
      JSON.stringify({ href: "javascript:alert(1)", title: null }),
    ),
  );
  assert.deepEqual(pagePreview(next).blocks[0].content, [["p", {}, ["span", {}, "x"]]]);
});

test("the preview stops at its size bound, in block order, and says so", (t) => {
  let doc = page("first block");
  for (let i = 0; i < 20; i++)
    doc = A.change(doc, (draft) =>
      applyPageOperation(draft, {
        operation: "edit_page",
        arguments: { operations: [{ op: "insert_markdown", markdown: `block ${i} `.repeat(40) }] },
        identity: { principal: "owner", displayName: "Owner", driver: "Browser" },
      }),
    );
  t.after(() => A.free(doc));
  const whole = pagePreview(doc);
  assert.equal(whole.blocks.length, 21);
  const bounded = pagePreview(doc, { maxBytes: 2000 });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.blocks.length > 0 && bounded.blocks.length < 21);
  assert.deepEqual(
    bounded.blocks.map((block) => block.id),
    orderedBlockIds(doc).slice(0, bounded.blocks.length),
  );
  assert.ok(JSON.stringify(bounded.blocks.map((b) => b.content)).length <= 2000 + 2 * 21);
});
