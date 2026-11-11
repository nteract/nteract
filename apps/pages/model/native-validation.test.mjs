import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { validateRich, validateRichSpans } from "./richtext-spans.mjs";
import { UNREADABLE_MARKERS, UNREADABLE_MARKS } from "./richtext-test-support.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { isEditorForm, editorCommentSpans } from "./comment-content.mjs";
import { decode, encode, Blockquote, Paragraph, Table, PagesLink } from "./wordgard-doc.mjs";
import { parseAgentMarkdown } from "./markdown-import.mjs";
import { exportMarkdown } from "./markdown-serializer.mjs";

const marker = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: {
    type: new A.ImmutableString(type),
    parents: parents.map((p) => new A.ImmutableString(p)),
    attrs,
    isEmbed,
  },
});
const text = (value, marks = {}) => ({ type: "text", value, marks });

test("native admission refuses misplaced known blocks and malformed embed flags", () => {
  for (const spans of [
    [marker("heading", [], { level: 2 }, true)],
    [marker("image", [], { src: "/x.png" }, false)],
    [marker("paragraph", ["heading"], {}), text("nested")],
    [marker("table-row", [], {}), text("orphan")],
    [marker("heading", [], { level: 9 })],
    [text("x", { link: JSON.stringify({ href: "javascript:alert(1)" }) })],
  ])
    assert.throws(() => validateRichSpans(spans), JSON.stringify(spans));
});

test("empty and concurrently joined tables have a native editable row and cell", () => {
  for (const spans of [[marker("table")], [marker("table"), text("peer")]]) {
    validateRichSpans(spans);
    const { doc } = decode(spans);
    assert.equal(doc.firstChild.type, Table.type);
    assert.equal(doc.firstChild.content.length, 1);
    assert.equal(doc.firstChild.firstChild.content.length, 1);
    assert.equal(exportMarkdown(decode(encode(doc)).doc), exportMarkdown(doc));
  }
});

test("nested sibling quotes preserve their boundaries, including an empty first quote", () => {
  for (const first of ["", "first"]) {
    const source = `> > ${first}\n>\n> > | a |\n> > | --- |\n> > | b |`;
    const doc = decode(encode(parseAgentMarkdown(source))).doc;
    const quote = doc.firstChild;
    assert.equal(quote.type, Blockquote.type);
    assert.equal(quote.content.length, 2);
    assert.equal(quote.firstChild.firstChild.type, Paragraph.type);
    assert.equal(quote.lastChild.firstChild.type, Table.type);
    assert.equal(quote.firstChild.textContent(), first);
    assert.equal(exportMarkdown(parseAgentMarkdown(exportMarkdown(doc))), exportMarkdown(doc));
  }
});

test("native Markdown keeps link titles and crossed mark ranges", () => {
  const source = '<mark>**one</mark> two** [link](/x "title")';
  const doc = decode(encode(parseAgentMarkdown(source))).doc;
  const link = doc.firstChild.content.find((node) => node.isText && node.mark(PagesLink));
  assert.deepEqual(link.mark(PagesLink), { href: "/x", title: "title" });
  assert.equal(exportMarkdown(parseAgentMarkdown(exportMarkdown(doc))), exportMarkdown(doc));
});

// Every reader draws a marker it can't read as a notice, and a mark it can't
// read as plain text. Neither reaches storage through admission: a Page
// registers through validateRich, and a comment through validateRichSpans
// and isEditorForm.
test("admission refuses a stored marker or mark value this build can't read", () => {
  const stored = (spans) => {
    const doc = A.change(A.from({ richText: "" }), (d) =>
      A.updateSpans(d, ["richText"], spans, updateSpansConfig),
    );
    return { block: doc, spans: A.spans(doc, ["richText"]) };
  };
  const cases = [
    ...Object.entries(UNREADABLE_MARKERS).map(([name, value]) => [
      name,
      [{ type: "block", value: value() }],
      true,
    ]),
    // A mark value is read as a mark this build doesn't know: the editor
    // writes it back as stored, so it is in the editor's form, and the
    // shared content rule (validateRichSpans) refuses it.
    ...Object.entries(UNREADABLE_MARKS).map(([name, marks]) => [
      name,
      [marker("paragraph"), text("x", marks)],
      false,
    ]),
  ];
  for (const [name, spans, notice] of cases) {
    const { block, spans: read } = stored(spans);
    try {
      assert.throws(() => validateRich(block), name);
      assert.throws(() => validateRichSpans(read), name);
      if (notice) {
        assert.equal(isEditorForm(read), false, name);
        assert.throws(() => editorCommentSpans(read), name);
      }
    } finally {
      A.free(block);
    }
  }
  // The same block with a value this build reads is admitted.
  const { block } = stored([marker("heading", [], { level: 2 }), text("x")]);
  validateRich(block);
  A.free(block);
});
