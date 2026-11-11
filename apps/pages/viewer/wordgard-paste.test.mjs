// Pasted content never becomes a node Pages doesn't know: Markdown-looking
// text and HTML Pages has no node for stay as editable text in ordinary
// paragraphs.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as A from "@automerge/automerge";
import { Leaf, parse, serialize, Slice } from "wordgard/doc";
import { GardState } from "wordgard/state";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { blockMarkdown, parseAgentMarkdown, textPath, validateRich } from "../model/richtext.mjs";
import { markdownCommentSpans } from "../model/comment-content.mjs";
import { markdownlessNode } from "../model/richtext-spans.mjs";
import { createWordgardBinding } from "./wordgard-binding.mjs";
import { pasteStrikethroughTags } from "./wordgard-shortcuts.mjs";
import { Wordgard } from "wordgard/editor";
import {
  decode,
  encode,
  schema,
  CodeBlock,
  HorizontalRule,
  PagesUnknownBlock,
  Strikethrough,
  Aside,
  BulletList,
  Paragraph,
  pastedCommentHTML,
  pastedPageHTML,
} from "./wordgard-model.mjs";

const hasOpaque = (doc) => {
  let found = false;
  doc.iterate((node) => {
    found ||= node.type === PagesUnknownBlock;
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

test("a pasted aside reads as the notice and its content, and refuses a Markdown rewrite", (t) => {
  // The shape of an HTML reference page's aside example: an article
  // paragraph with a side note between paragraphs.
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  dom.window.document.body.innerHTML =
    "<article><p>Main text.</p><aside><p>A side note, set apart.</p></aside>" +
    "<p>More main text.</p></article>";
  const pasted = parse(schema, dom.window.document.body);
  assert.ok(pasted.content.some((node) => node.type === Aside.type));
  const f = fixture();
  paste(f, Slice.of(pasted.content));
  const markdown = f.markdown();
  assert.match(markdown, /\\\[Unsupported node: aside\\\]\n\nA side note, set apart\./);
  assert.match(markdown, /More main text\./);
  assert.equal(markdownlessNode(f.replica.doc.blocks[f.id]), "aside");
  f.binding.destroy();
});

// HTML from outside Pages pastes no aside, in a Page block and in the
// comment composer: its paragraphs and lists land in place.
test("a pasted aside from outside Pages unwraps to its blocks, in the body and the composer", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const parser = new dom.window.DOMParser();
  const html =
    "<p>Before.</p><aside><p>A note.</p><ul><li>one</li><li>two</li></ul></aside><p>After.</p>";
  const read = (filtered) => {
    const body = dom.window.document.createElement("body");
    body.innerHTML = filtered;
    return parse(schema, body);
  };
  for (const [where, filtered] of [
    ["body", pastedPageHTML(html, "page_fixture", parser)],
    ["composer", pastedCommentHTML(html, parser)],
  ]) {
    const pasted = read(filtered);
    let asides = 0;
    pasted.iterate((node) => {
      if (node.type === Aside.type) asides++;
    });
    assert.equal(asides, 0, where);
    assert.deepEqual(
      pasted.content.map((node) => node.type),
      [Paragraph.type, Paragraph.type, BulletList.type, Paragraph.type],
      where,
    );
    assert.equal(pasted.content[1].textContent(), "A note.", where);
  }
  // An aside copied inside Pages carries its attribute and pastes back.
  const copied = serialize(
    schema.doc([Aside.create([Paragraph.create([Leaf.text("kept")])])]),
  ).toDOM(dom.window.document);
  const own = copied.firstChild.outerHTML;
  assert.match(own, /data-pages-aside/);
  for (const filtered of [
    pastedPageHTML(own, "page_fixture", parser),
    pastedCommentHTML(own, parser),
  ])
    assert.equal(read(filtered).content[0].type, Aside.type);
});

// An aside's bare text keeps a block boundary when it unwraps: each run of
// its text and inline children becomes a paragraph of its own.
test("an unwrapped aside keeps its text apart from the blocks around it", (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const parser = new dom.window.DOMParser();
  const read = (filtered) => {
    const body = dom.window.document.createElement("body");
    body.innerHTML = filtered;
    return parse(schema, body).content.map((node) => [node.type, node.textContent()]);
  };
  const p = (text) => [Paragraph.type, text];
  for (const [html, expected] of [
    ["<aside>first</aside><aside>second</aside>", [p("first"), p("second")]],
    ["<p>a</p><aside>note</aside><p>b</p>", [p("a"), p("note"), p("b")]],
    ["<aside>lead <em>x</em><p>para</p>tail</aside>", [p("lead x"), p("para"), p("tail")]],
    ["<aside><aside>inner</aside>outer</aside>", [p("inner"), p("outer")]],
  ])
    for (const [where, filtered] of [
      ["body", pastedPageHTML(html, "page_fixture", parser)],
      ["composer", pastedCommentHTML(html, parser)],
    ])
      assert.deepEqual(read(filtered), expected, `${where}: ${html}`);
});

test("comment Markdown from an agent refuses math and HTML, as a Page body's does", () => {
  const spans = markdownCommentSpans("Text and ~~gone~~");
  assert.ok(spans.some((span) => span.type === "text" && span.marks?.strike));
  assert.throws(() => markdownCommentSpans("Math $x$"), { code: "unsupported_markdown" });
  assert.throws(() => markdownCommentSpans("<b>tag</b>"), { code: "unsupported_markdown" });
});
