import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, projectPage } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { blockMarkdown, setRichMarkdown, textPath } from "../model/richtext.mjs";
import { nodeAddresses } from "../model/addresses.mjs";
import { decode } from "./wordgard-model.mjs";
import { isEmptyPage, writingContinuation } from "./writing-continuation.mjs";

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
    set doc(next) {
      doc = next;
    },
    change(fn) {
      const before = A.getHeads(doc).join();
      doc = A.change(doc, fn);
      if (A.getHeads(doc).join() !== before) this.changes++;
    },
    observeChange: () => () => {},
  };
}

/** The top-level node types of block `id`, as the editor draws them. */
const types = (doc, id) =>
  decode(A.spans(doc, textPath(id))).doc.content.map((node) => node.type.name);
const markdownOf = (doc, id) => blockMarkdown(doc.blocks[id]);

test("continuing an empty Page reuses its paragraph without a document change", () => {
  const current = session(),
    id = orderedBlockIds(current.doc)[0],
    heads = A.getHeads(current.doc);
  assert.equal(writingContinuation(current), id);
  assert.equal(current.changes, 0);
  assert.deepEqual(A.getHeads(current.doc), heads);
});

test("continuing below an image adds a paragraph inside its block; repeated activation adds only one", () => {
  const current = session("![Cat](/api/pages/continuation_fixture/assets/cat)"),
    imageId = orderedBlockIds(current.doc)[0],
    image = markdownOf(current.doc, imageId),
    objectId = A.getObjectId(current.doc.blocks[imageId], "richText");
  assert.equal(writingContinuation(current), imageId);
  assert.deepEqual(orderedBlockIds(current.doc), [imageId]);
  assert.equal(markdownOf(current.doc, imageId), image);
  assert.equal(A.getObjectId(current.doc.blocks[imageId], "richText"), objectId);
  assert.deepEqual(types(current.doc, imageId), ["Paragraph", "Paragraph"]);
  assert.equal(current.changes, 1);
  assert.equal(writingContinuation(current), imageId);
  assert.equal(writingContinuation(current), imageId);
  assert.equal(current.changes, 1);
  assert.deepEqual(types(current.doc, imageId), ["Paragraph", "Paragraph"]);
  assert.equal(orderedBlockIds(current.doc).length, 1);
});

test("a filled trailing paragraph gets an empty paragraph after it, in the same block", () => {
  const current = session("# Heading\n\nBefore"),
    id = orderedBlockIds(current.doc)[0];
  assert.equal(writingContinuation(current), id);
  assert.deepEqual(types(current.doc, id), ["Heading", "Paragraph", "Paragraph"]);
  assert.equal(markdownOf(current.doc, id), "# Heading\n\nBefore");
  // Writing that lands in the new paragraph fills it; the next activation
  // adds one more.
  current.change((doc) =>
    A.splice(doc, textPath(id), doc.blocks[id].richText.length, 0, "Since the last click"),
  );
  assert.equal(writingContinuation(current), id);
  assert.deepEqual(projectPage(current.doc).blocks.length, 1);
  assert.equal(markdownOf(current.doc, id), "# Heading\n\nBefore\n\nSince the last click");
  assert.deepEqual(types(current.doc, id), ["Heading", "Paragraph", "Paragraph", "Paragraph"]);
});

test("continuing keeps existing node ids and comment anchors", () => {
  const current = session("# Heading\n\nAnchored words here\n\n- item"),
    id = orderedBlockIds(current.doc)[0],
    before = nodeAddresses(current.doc, id),
    at = current.doc.blocks[id].richText.indexOf("words"),
    start = A.getCursor(current.doc, textPath(id), at),
    end = A.getCursor(current.doc, textPath(id), at + "words".length);
  assert.ok(before.every(Boolean));
  writingContinuation(current);
  const after = nodeAddresses(current.doc, id);
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, before.length), before);
  const text = current.doc.blocks[id].richText;
  assert.equal(
    text.slice(
      A.getCursorPosition(current.doc, textPath(id), start),
      A.getCursorPosition(current.doc, textPath(id), end),
    ),
    "words",
  );
});

test("a concurrent edit to the last paragraph merges with the new paragraph", () => {
  const current = session("First\n\nLast line"),
    id = orderedBlockIds(current.doc)[0];
  let peer = A.clone(current.doc);
  peer = A.change(peer, (doc) =>
    A.splice(doc, textPath(id), doc.blocks[id].richText.indexOf(" line"), 0, " written"),
  );
  writingContinuation(current);
  const local = current.doc;
  current.doc = A.merge(current.doc, peer);
  assert.equal(markdownOf(current.doc, id), "First\n\nLast written line");
  assert.deepEqual(types(current.doc, id), ["Paragraph", "Paragraph", "Paragraph"]);
  const nodes = decode(A.spans(current.doc, textPath(id))).doc.content;
  assert.equal(nodes.at(-1).content.length, 0, "the new paragraph stays last and empty");
  assert.equal(orderedBlockIds(current.doc).length, 1);
  assert.deepEqual(
    A.spans(A.merge(peer, local), textPath(id)),
    A.spans(current.doc, textPath(id)),
    "both replicas converge",
  );
  // The merged Page already ends in an empty paragraph.
  const changes = current.changes;
  writingContinuation(current);
  assert.equal(current.changes, changes);
});

test("typing at the end of the last paragraph while it continues keeps every word", () => {
  // Both writes land at the paragraph's end, as typing does against Enter:
  // Automerge orders them, and neither is lost.
  const current = session("Last"),
    id = orderedBlockIds(current.doc)[0];
  let peer = A.clone(current.doc);
  peer = A.change(peer, (doc) =>
    A.splice(doc, textPath(id), doc.blocks[id].richText.length, 0, " words"),
  );
  writingContinuation(current);
  const local = current.doc;
  current.doc = A.merge(current.doc, peer);
  assert.match(markdownOf(current.doc, id), /^Last(\n\n)? words$/);
  assert.deepEqual(types(current.doc, id), ["Paragraph", "Paragraph"]);
  assert.deepEqual(A.spans(A.merge(peer, local), textPath(id)), A.spans(current.doc, textPath(id)));
});

test("a last block this build draws lossily gets a new block after it instead", () => {
  const current = session("Before\n\nAfter"),
    id = orderedBlockIds(current.doc)[0];
  current.change((d) => {
    const at = d.blocks[id].richText.indexOf("After") - 1;
    A.splitBlock(d, textPath(id), at, {
      type: new A.ImmutableString("paragraph"),
      parents: [new A.ImmutableString("callout")],
      attrs: {},
      isEmbed: false,
    });
  });
  const spans = A.spans(current.doc, textPath(id));
  const next = writingContinuation(current);
  assert.notEqual(next, id);
  assert.deepEqual(orderedBlockIds(current.doc), [id, next]);
  assert.deepEqual(A.spans(current.doc, textPath(id)), spans, "nothing written inside");
  assert.equal(writingContinuation(current), next, "the new block is reused");
});

test("a read-only editor on the last block gets a new block after it instead", () => {
  const current = session("Before"),
    id = orderedBlockIds(current.doc)[0];
  const view = { state: { readOnly: true }, dispatch: () => assert.fail("no dispatch") };
  const next = writingContinuation(current, { editorOf: () => view });
  assert.notEqual(next, id);
  assert.deepEqual(orderedBlockIds(current.doc), [id, next]);
  assert.equal(markdownOf(current.doc, id), "Before");
});

test("a last block the Page shows as a notice gets a new block after it instead", () => {
  const current = session("Before"),
    id = orderedBlockIds(current.doc)[0];
  const next = writingContinuation(current, {
    editorOf: () => null,
    failed: (block) => block === id,
  });
  assert.notEqual(next, id);
  assert.deepEqual(orderedBlockIds(current.doc), [id, next]);
  assert.equal(markdownOf(current.doc, id), "Before", "the failed block is not written to");
  assert.equal(
    writingContinuation(current, { editorOf: () => null, failed: (block) => block === id }),
    next,
    "the new block is reused",
  );
  assert.equal(current.changes, 1);
});

test("a Page with no block gets its first block", () => {
  const current = session("Before"),
    id = orderedBlockIds(current.doc)[0];
  current.change((doc) => delete doc.blocks[id]);
  const next = writingContinuation(current);
  assert.ok(next);
  assert.deepEqual(orderedBlockIds(current.doc), [next]);
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
    assert.equal(orderedBlockIds(current.doc).length, 1);
    current[property] = false;
    assert.equal(writingContinuation(current), null);
    assert.equal(current.changes, 1);
  }
});

test("only a Page with one empty paragraph is empty", () => {
  const page = (markdown) => session(markdown).doc;
  assert.equal(isEmptyPage(page("")), true, "a new Page");
  assert.equal(isEmptyPage(page("  \n")), true, "whitespace only");
  assert.equal(isEmptyPage(page("Hello")), false);
  assert.equal(isEmptyPage(page("![Cat](/api/pages/continuation_fixture/assets/cat)")), false);
  assert.equal(isEmptyPage(null), false);
  assert.equal(isEmptyPage({ blocks: {} }), false, "no paragraph to put the caret in");
  const current = session("Before");
  writingContinuation(current);
  assert.equal(isEmptyPage(current.doc), false, "content and a blank paragraph");
  for (const markdown of ["", "  \n", "Hello", "---", "# "]) {
    const doc = page(markdown);
    assert.equal(
      isEmptyPage(doc),
      !projectPage(doc).blocks[0].markdown.trim(),
      `the stored read agrees with the Markdown for ${JSON.stringify(markdown)}`,
    );
  }
});
