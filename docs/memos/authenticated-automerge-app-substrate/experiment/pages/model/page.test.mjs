import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  createPageData,
  initializePage,
  projectPage,
  applyPageOperation,
  orderedBlockIds,
} from "./page.mjs";
import { applyComment, projectComments } from "./comments.mjs";
import { richDoc, schema } from "./richtext.mjs";
function page(markdown = "Hello 🌊 people") {
  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Test" }));
  return A.change(doc, (d) => initializePage(d, markdown));
}
const identity = { principal: "account:one", displayName: "Kyle Kelley", driver: "Browser" };
test("targeted text edits preserve unknown document fields and rich text identity", () => {
  let doc = page();
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (d) => {
    d.future = { kept: true };
    d.blocks[id].extension = { kept: true };
  });
  const object = A.getObjectId(doc.blocks[id], "richText");
  doc = A.change(doc, (d) =>
    applyPageOperation(d, {
      operation: "patch_page",
      arguments: {
        operations: [
          { op: "replace_match", block_id: id, match_text: "people", replacement: "collaborators" },
        ],
      },
    }),
  );
  assert.equal(projectPage(doc).blocks[0].markdown, "Hello 🌊 collaborators");
  assert.equal(A.getObjectId(doc.blocks[id], "richText"), object);
  assert.ok(doc.future.kept);
  assert.ok(doc.blocks[id].extension.kept);
});
test("ambiguous literal patch rejects atomically with no partially applied sibling", () => {
  const doc = page("one one");
  const id = orderedBlockIds(doc)[0];
  assert.throws(
    () =>
      A.change(doc, (d) =>
        applyPageOperation(d, {
          operation: "patch_page",
          arguments: {
            operations: [
              { op: "set_title", title: "Changed" },
              { op: "replace_match", block_id: id, match_text: "one", replacement: "two" },
            ],
          },
        }),
      ),
    /exactly one is required/,
  );
  assert.equal(doc.title, "Test");
  assert.equal(projectPage(doc).blocks[0].markdown, "one one");
});
test("anchored Unicode comments follow concurrent text and detach after the selected text is removed", () => {
  let doc = page("Before 🌊 passage after");
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (d) =>
    applyComment(
      d,
      { action: "add", block_id: id, body: "Discuss this", selected_text: "🌊 passage" },
      identity,
    ),
  );
  const thread = projectComments(doc)[0];
  assert.equal(thread.selectionContext.text, "🌊 passage");
  const left = A.change(A.clone(doc), (d) => A.splice(d, ["blocks", id, "richText"], 0, 0, "New "));
  const right = A.change(A.clone(doc), (d) =>
    applyComment(d, { action: "reply", thread_id: thread.id, body: "Agreed" }, identity),
  );
  doc = A.merge(left, right);
  assert.equal(projectComments(doc)[0].messages.length, 2);
  assert.equal(projectComments(doc)[0].selectionContext.text, "🌊 passage");
  doc = A.change(doc, (d) =>
    applyPageOperation(d, {
      operation: "patch_page",
      arguments: {
        operations: [
          { op: "replace_match", block_id: id, match_text: "🌊 passage", replacement: "" },
        ],
      },
    }),
  );
  assert.equal(projectComments(doc)[0].selectionContext.status, "detached");
});
test("unsafe link and image attributes are inert even in an open document schema", () => {
  const mark = schema.marks.link.create({ href: "javascript:alert(1)" });
  assert.equal(schema.marks.link.spec.toDOM(mark)[0], "span");
  const image = schema.nodes.image.create({ src: "javascript:alert(1)" });
  assert.equal(schema.nodes.image.spec.toDOM(image)[0], "span");
  const doc = page("**Bold** and `code`");
  richDoc(doc.blocks[orderedBlockIds(doc)[0]]).check();
});

// A block whose first paragraph is empty, as the browser editor writes it after
// Enter at the start of a block or deleting an image that was alone there.
function leadingEmptyParagraph() {
  let doc = page("Hope you can edit this.");
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (d) =>
    A.updateSpans(
      d,
      ["blocks", id, "richText"],
      [
        { type: "block", value: { type: "paragraph", parents: [], attrs: {}, isEmbed: false } },
        { type: "block", value: { type: "paragraph", parents: [], attrs: {}, isEmbed: false } },
        { type: "text", value: "Hope you can edit this." },
      ],
    ),
  );
  return { doc, id };
}
const edit = (doc, operations) =>
  A.change(A.clone(doc), (d) =>
    applyPageOperation(d, { operation: "patch_page", arguments: { operations } }),
  );
test("Markdown export omits the blank line Markdown can't turn back into an empty paragraph", () => {
  const { doc, id } = leadingEmptyParagraph();
  assert.equal(richDoc(doc.blocks[id]).childCount, 2);
  assert.equal(projectPage(doc).blocks[0].markdown, "Hope you can edit this.");
});
test("replace_match keeps an empty paragraph Markdown can't represent", () => {
  const { doc, id } = leadingEmptyParagraph();
  const matched = edit(doc, [
    { op: "replace_match", block_id: id, match_text: "edit", replacement: "change" },
  ]);
  assert.equal(richDoc(matched.blocks[id]).childCount, 2);
  assert.equal(projectPage(matched).blocks[0].markdown, "Hope you can change this.");
});
test("replace_block_markdown replaces the block with exactly the Markdown it is given", () => {
  const { doc, id } = leadingEmptyParagraph();
  const replaced = edit(doc, [
    { op: "replace_block_markdown", block_id: id, markdown: projectPage(doc).blocks[0].markdown },
  ]);
  // Markdown has no empty paragraph, so the replacement has one paragraph.
  assert.equal(richDoc(replaced.blocks[id]).childCount, 1);
  assert.equal(projectPage(replaced).blocks[0].markdown, "Hope you can edit this.");
});
