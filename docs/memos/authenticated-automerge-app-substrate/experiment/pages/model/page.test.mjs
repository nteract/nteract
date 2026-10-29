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
test("targeted Markdown edits preserve unknown document fields and rich text identity", () => {
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
          {
            op: "patch_block_markdown",
            block_id: id,
            replacements: [{ old: "people", new: "collaborators" }],
          },
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
              {
                op: "patch_block_markdown",
                block_id: id,
                replacements: [{ old: "one", new: "two" }],
              },
            ],
          },
        }),
      ),
    /exactly once/,
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
          {
            op: "patch_block_markdown",
            block_id: id,
            replacements: [{ old: "🌊 passage", new: "" }],
          },
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
