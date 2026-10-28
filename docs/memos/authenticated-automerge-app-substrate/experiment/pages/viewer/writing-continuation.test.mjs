import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, projectPage } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { setRichMarkdown } from "../model/richtext.mjs";
import { writingContinuation } from "./writing-continuation.mjs";

function session(markdown = "") {
  let doc = A.from(createPageData({ pageId: "continuation_fixture", title: "Test" }));
  doc = A.change(doc, (d) => initializePage(d, markdown));
  return {
    alive: true,
    canWrite: true,
    changes: 0,
    get doc() {
      return doc;
    },
    change(fn) {
      doc = A.change(doc, fn);
      this.changes++;
    },
  };
}

test("continuing an empty Page reuses its paragraph without a document change", () => {
  const current = session(),
    id = orderedBlockIds(current.doc)[0],
    heads = A.getHeads(current.doc);
  assert.equal(writingContinuation(current), id);
  assert.equal(current.changes, 0);
  assert.deepEqual(A.getHeads(current.doc), heads);
});

test("continuing below an image preserves it and repeated activation creates only one paragraph", () => {
  const current = session("![Cat](/api/pages/continuation_fixture/assets/cat)"),
    imageId = orderedBlockIds(current.doc)[0],
    image = projectPage(current.doc).blocks[0].markdown,
    objectId = A.getObjectId(current.doc.blocks[imageId], "richText");
  const id = writingContinuation(current);
  assert.notEqual(id, imageId);
  assert.deepEqual(orderedBlockIds(current.doc), [imageId, id]);
  assert.equal(projectPage(current.doc).blocks[0].markdown, image);
  assert.equal(A.getObjectId(current.doc.blocks[imageId], "richText"), objectId);
  assert.equal(projectPage(current.doc).blocks[1].markdown, "");
  assert.equal(writingContinuation(current), id);
  assert.equal(current.changes, 1);
  assert.equal(orderedBlockIds(current.doc).length, 2);
});

test("a filled trailing paragraph is preserved when continuing again", () => {
  const current = session("Before"),
    previous = writingContinuation(current);
  current.change((doc) =>
    setRichMarkdown(doc, previous, "Writing that arrived since the last click"),
  );
  const next = writingContinuation(current);
  assert.notEqual(next, previous);
  assert.deepEqual(
    projectPage(current.doc).blocks.map((block) => block.markdown),
    ["Before", "Writing that arrived since the last click", ""],
  );
});

test("readonly and closed sessions cannot continue writing, even after an earlier activation", () => {
  assert.equal(writingContinuation(null), null);
  for (const property of ["canWrite", "alive"]) {
    const current = session("Existing content");
    current[property] = false;
    assert.equal(writingContinuation(current), null);
    assert.equal(current.changes, 0);
    current[property] = true;
    assert.ok(writingContinuation(current));
    current[property] = false;
    assert.equal(writingContinuation(current), null);
    assert.equal(current.changes, 1);
  }
});

test("a non-editable empty block is not mistaken for a writable trailing paragraph", () => {
  const current = session(),
    oldId = orderedBlockIds(current.doc)[0];
  current.change((doc) => {
    doc.blocks[oldId].format = "unknown-document-format";
  });
  const id = writingContinuation(current);
  assert.notEqual(id, oldId);
  assert.deepEqual(orderedBlockIds(current.doc), [oldId, id]);
  assert.equal(current.doc.blocks[oldId].format, "unknown-document-format");
});
