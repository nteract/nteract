import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { listStartWarning } from "./list-start-warning.mjs";
import {
  applyPageOperation,
  createPageData,
  initializePage,
  orderedBlockIds,
  projectPage,
} from "./page.mjs";
import { blockAddress } from "./addresses.mjs";
import { pageMarkdown } from "./markdown-export.mjs";

test("lists that start at 1, bullets and plain prose raise no warning", () => {
  for (const markdown of [
    "Plain text.",
    "1. one\n2. two",
    "- a\n- b",
    "In 2026. The year.",
    "```\n6. inside a fence\n```",
    "    3. an indented code block",
  ])
    assert.equal(listStartWarning(markdown), null, markdown);
  assert.equal(listStartWarning(undefined), null);
});

test("each list that started at another number is named by its start and first item", () => {
  const warning = listStartWarning(
    "Intro.\n\n3. Is the first cut read-only?\n4. Does it cover other Pages?\n\nMore.\n\n" +
      "> 0) zero-based\n\n1. starts right\n\n   12. nested at twelve",
  );
  assert.equal(warning.code, "list_numbers_reset");
  assert.deepEqual(warning.lists, [
    { start: 3, first_item: "Is the first cut read-only?" },
    { start: 0, first_item: "zero-based" },
    { start: 12, first_item: "nested at twelve" },
  ]);
  assert.equal(warning.lists_truncated, undefined);
  assert.match(warning.suggested_action, /from 1/);
});

test("a list after a bullet on the same line, or with its first item on the next line, is named", () => {
  assert.deepEqual(listStartWarning("- 3. child").lists, [{ start: 3, first_item: "child" }]);
  assert.deepEqual(listStartWarning("3.\n   first item").lists, [
    { start: 3, first_item: "first item" },
  ]);
  assert.deepEqual(listStartWarning("7)\tafter a tab\r\n8) next").lists, [
    { start: 7, first_item: "after a tab" },
  ]);
});

test("a first item with no text of its own gives an empty preview, not later prose", () => {
  assert.deepEqual(listStartWarning("3. ```\n   code\n   ```\n\nUnrelated paragraph").lists, [
    { start: 3, first_item: "" },
  ]);
});

test("a long first item is cut, and more than 32 lists are capped", () => {
  const long = "x".repeat(200);
  assert.equal(listStartWarning(`5. ${long}`).lists[0].first_item, `${"x".repeat(80)}…`);
  const many = Array.from({ length: 40 }, (_, i) => `${i + 2}. item ${i}`).join("\n\nPara.\n\n");
  const warning = listStartWarning(many);
  assert.equal(warning.lists.length, 32);
  assert.equal(warning.lists_truncated, true);
});

test("Markdown edits keep the items, number them from 1, and say so in the edit's entry", () => {
  let doc = A.from(createPageData({ pageId: "list-start", title: "Lists" }));
  doc = A.change(doc, (draft) => initializePage(draft, "Intro."));
  const first = blockAddress(doc, orderedBlockIds(doc)[0]);
  let result;
  doc = A.change(doc, (draft) => {
    result = applyPageOperation(draft, {
      operation: "edit_page",
      arguments: {
        operations: [
          { op: "insert_markdown", markdown: "6. six\n7. seven", after_node_id: first },
          { op: "replace_block_markdown", node_id: first, markdown: "Intro.\n\n1. fine" },
        ],
      },
    });
  });
  const [inserted, replaced] = result.edits;
  assert.deepEqual(inserted.warnings, [listStartWarning("6. six\n7. seven")]);
  assert.equal(inserted.warnings[0].lists[0].start, 6);
  assert.equal(replaced.warnings, undefined);
  assert.match(pageMarkdown(projectPage(doc)), /1\. six\n2\. seven/);
});
