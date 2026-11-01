// Pasted content never becomes a preserved block: Markdown-looking text and
// HTML Pages has no node for stay as editable text in ordinary paragraphs.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as A from "@automerge/automerge";
import { Leaf, parse, serialize, Slice } from "wordgard/doc";
import { GardState } from "wordgard/state";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { blockMarkdown, parseAgentMarkdown, textPath, validateRich } from "../model/richtext.mjs";
import { markdownCommentSpans } from "../model/comment-content.mjs";
import { createWordgardBinding } from "./wordgard-binding.mjs";
import { pasteStrikethroughTags } from "./wordgard-shortcuts.mjs";
import { Wordgard } from "wordgard/editor";
import {
  decode,
  encode,
  schema,
  CodeBlock,
  HorizontalRule,
  OpaqueBlock,
  PRESERVED_NOTICE,
  Strikethrough,
} from "./wordgard-model.mjs";

const hasOpaque = (doc) => {
  let found = false;
  doc.iterate((node) => {
    found ||= node.type === OpaqueBlock;
  });
  return found;
};

function fixture() {
  let doc = A.change(A.from(createPageData({ pageId: "page_fixture", title: "Paste" })), (d) =>
    initializePage(d, "Start"),
  );
  const id = orderedBlockIds(doc)[0];
  const replica = {
    get doc() {
      return doc;
    },
    change(fn) {
      doc = A.change(doc, fn);
    },
    observeChange: () => () => {},
  };
  const binding = createWordgardBinding(replica, id);
  return { binding, id, replica, markdown: () => blockMarkdown(doc.blocks[id]) };
}

function paste(f, insert) {
  const state = GardState.create({
    doc: f.binding.current.doc,
    config: [GardState.schemaElement.of(schema.elements)],
  });
  // The end of the first paragraph's text.
  const end = state.doc.content[0].length - 1;
  f.binding.applyEditorTransaction(
    state.update({ changes: { from: end, insert, fit: true }, userEvent: "input.paste" }),
  );
  validateRich(f.replica.doc.blocks[f.id]);
  const stored = decode(A.spans(f.replica.doc, textPath(f.id))).doc;
  assert.ok(!hasOpaque(stored));
  return stored;
}

test("pasted plain text with math, HTML and Markdown syntax stays literal and editable", () => {
  const f = fixture();
  const text = " $x + 1$ <div>~~not struck~~</div> \\frac{a}{b}";
  const stored = paste(f, Slice.of([Leaf.text(text)]));
  assert.equal(stored.content[0].textContent(), `Start${text}`);
  // The projection escapes it, so an agent may write it back.
  assert.doesNotThrow(() => parseAgentMarkdown(f.markdown()));
  f.binding.destroy();
});

test("pasted HTML keeps its text: strikethrough and rules are native, other tags are text", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const state = GardState.create({
    config: [GardState.schemaElement.of(schema.elements), pasteStrikethroughTags],
  });
  // The editor's clipboard path: HTML filters, then the schema's parse rules.
  const html = state
    .facet(Wordgard.clipboardInputHTMLFilter)
    .reduce(
      (value, filter) => filter(value, state),
      '<p>a <del>gone</del> <s>s</s> <strike>t</strike> <span style="text-decoration: line-through">u</span></p>' +
        "<hr><p>$x$ <math><mi>y</mi></math> <custom-el>c</custom-el></p><div>block div</div>",
    );
  dom.window.document.body.innerHTML = html;
  const pasted = parse(schema, dom.window.document.body);
  assert.ok(!hasOpaque(pasted));
  assert.ok(pasted.content.some((node) => node.type === HorizontalRule.type));
  const struck = [];
  pasted.iterate((node) => {
    if (node.isText && Strikethrough.isInSet(node.marks)) struck.push(node.param);
  });
  assert.deepEqual(struck, ["gone", "s", "t", "u"]);
  assert.match(pasted.textContent(), /\$x\$ y c/);
  assert.ok(decode(encode(pasted)).doc.eq(pasted));
});

test("a copied preserved block pastes as an editable code block holding its source", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const source = "$x$ <div>kept</div>";
  const copied = serialize(
    schema.doc([OpaqueBlock.of({ source, importId: "", kind: "markdown" })]),
  ).toDOM(dom.window.document);
  assert.equal(copied.querySelector("section").getAttribute("data-pages-notice"), PRESERVED_NOTICE);
  const pasted = parse(schema, copied);
  assert.ok(!hasOpaque(pasted));
  assert.equal(pasted.content.length, 1);
  assert.equal(pasted.content[0].type, CodeBlock.type ?? CodeBlock);
  assert.equal(pasted.textContent(), source);
});

test("a browser comment draft keeps unsupported Markdown as literal text", () => {
  const spans = markdownCommentSpans("Math $x$ and <b>tag</b> and ~~gone~~", { literal: true });
  assert.ok(
    spans.every((span) => span.type !== "block" || String(span.value.type) !== "pages-opaque"),
  );
  const text = spans
    .filter((span) => span.type === "text")
    .map((span) => span.value)
    .join("");
  assert.equal(text, "Math $x$ and <b>tag</b> and gone");
  assert.ok(spans.some((span) => span.type === "text" && span.marks?.strike));
  assert.throws(() => markdownCommentSpans("Math $x$"), { code: "unsupported_markdown" });
});
