// A plain-text paste of one URL becomes a bare link (bare-links.mjs). The
// browser E2E (scripts/page-links-smoke.mjs) pastes for real; these tests
// drive Wordgard's two clipboard facets the way its paste path does: text
// parsers first (skipped for paste as plain text), then paste handlers.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const name of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Text",
  "Range",
  "Selection",
  "DocumentFragment",
  "ShadowRoot",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "customElements",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "InputEvent",
  "FocusEvent",
  "MouseEvent",
])
  globalThis[name] ??= dom.window[name];
const empty = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = empty;

const { Wordgard } = await import("wordgard/editor");
const { GardState, GardSelection } = await import("wordgard/state");
const { history, undo } = await import("wordgard/history");
const { Command } = await import("wordgard/command");
const { textPath } = await import("../model/richtext.mjs");
const { richFromSource } = await import("../model/richtext-test-support.mjs");
const { createPageData, initializePage, orderedBlockIds } = await import("../model/page.mjs");
const { blockMarkdown } = await import("../model/richtext.mjs");
const { decode, encode, schema, PagesLink, Strong } = await import("./wordgard-model.mjs");
const { bareLinkPaste, bareUrl } = await import("./bare-links.mjs");

function editor(markdown) {
  const native = A.change(A.from({ blocks: { one: { markdown } } }), (d) =>
    richFromSource(d, "one"),
  );
  const state = GardState.create({
    doc: decode(A.spans(native, textPath("one"))).doc,
    config: [
      ...schema.elements.map((e) => GardState.schemaElement.of(e)),
      history(),
      bareLinkPaste(),
    ],
  });
  return new Wordgard({ state, parent: document.body });
}

/** Paste `text` as Wordgard's insertFromPaste does with no HTML on the
 * clipboard: `plain` is paste as plain text, which skips text parsers. */
function paste(wg, text, { plain = false } = {}) {
  let slice = null;
  if (!plain)
    for (const parser of wg.state.facet(Wordgard.clipboardTextParser))
      if ((slice = parser(text, wg.state))) break;
  if (slice && wg.state.facet(Wordgard.pasteHandler).some((h) => h(wg, null, slice))) return true;
  return false;
}

/** The block's Markdown, through the stored spans. */
function markdown(wg) {
  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Paste" }));
  doc = A.change(doc, (d) => initializePage(d, "x"));
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (d) => {
    d.blocks[id].richText = "";
    A.updateSpans(d, textPath(id), encode(wg.state.doc));
  });
  return blockMarkdown(doc.blocks[id]);
}

const links = (wg) => {
  const found = [];
  wg.state.doc.iterate((node) => {
    const link = node.isText && PagesLink.isInSet(node.marks);
    if (link) found.push([node.param, link.value.href, link.value.title]);
  });
  return found;
};
const page = "https://pages.example/p/0b6f6a8e-5d2c-4c7b-9a7e-2f1d3c4b5a69";

test("bareUrl accepts exactly one absolute http(s) URL", () => {
  assert.equal(bareUrl(page), page);
  assert.equal(bareUrl(`  ${page}\n`), page);
  assert.equal(bareUrl("http://example.com/a?b=c#d"), "http://example.com/a?b=c#d");
  for (const text of [
    "",
    "example.com",
    "/p/0b6f6a8e-5d2c-4c7b-9a7e-2f1d3c4b5a69",
    `${page} ${page}`,
    `${page}\n${page}`,
    `see ${page}`,
    "javascript:alert(1)",
    "https://",
    "https:///path",
    "mailto:a@example.com",
    "ftp://example.com/file",
    "https://exa mple.com",
    "https://example.com/\u0000",
    null,
  ])
    assert.equal(bareUrl(text), null, JSON.stringify(text));
});

test("pasting a URL inserts a bare link whose href is its text", () => {
  const wg = editor("See .");
  wg.dispatch({ selection: GardSelection.cursor(5) });
  assert.equal(paste(wg, `  ${page} `), true);
  assert.deepEqual(links(wg), [[page, page, null]]);
  assert.equal(wg.state.selection.head, 5 + page.length, "the caret ends after the link");
  assert.equal(markdown(wg), `See <${page}>.`);
  wg.dom.remove();
});

test("an external URL links too", () => {
  const wg = editor("x");
  wg.dispatch({ selection: GardSelection.cursor(2) });
  assert.equal(paste(wg, "https://example.com/docs"), true);
  assert.deepEqual(links(wg), [["https://example.com/docs", "https://example.com/docs", null]]);
  wg.dom.remove();
});

test("undo takes the link off first, then the text", () => {
  const wg = editor("See .");
  wg.dispatch({ selection: GardSelection.cursor(5) });
  paste(wg, page);
  Command.dispatch(wg, undo);
  assert.deepEqual(links(wg), []);
  assert.equal(wg.state.doc.textContent(), `See ${page}.`);
  Command.dispatch(wg, undo);
  assert.equal(wg.state.doc.textContent(), "See .");
  wg.dom.remove();
});

test("pasting a URL over a selection replaces it with the bare link", () => {
  const wg = editor("See this");
  wg.dispatch({ selection: GardSelection.range(5, 9) });
  assert.equal(paste(wg, page), true);
  assert.equal(wg.state.doc.textContent(), `See ${page}`);
  assert.deepEqual(links(wg), [[page, page, null]]);
  wg.dom.remove();
});

test("text that isn't one URL, and paste as plain text, stay ordinary text", () => {
  for (const text of [`${page} ${page}`, `see ${page}`, "javascript:alert(1)", "plain"]) {
    const wg = editor("x");
    wg.dispatch({ selection: GardSelection.cursor(2) });
    assert.equal(paste(wg, text), false, text);
    wg.dom.remove();
  }
  const wg = editor("x");
  wg.dispatch({ selection: GardSelection.cursor(2) });
  assert.equal(paste(wg, page, { plain: true }), false);
  wg.dom.remove();
});

test("a URL pasted into code, inline code or another link stays text", () => {
  for (const [source, inside] of [
    ["```\ncode\n```", 2],
    ["`code`", 3],
    ["[label](https://example.com)", 3],
  ]) {
    const wg = editor(source);
    wg.dispatch({ selection: GardSelection.cursor(inside) });
    assert.equal(paste(wg, page), false, source);
    wg.dom.remove();
  }
});

test("bold around the caret carries into the pasted link", () => {
  const wg = editor("**bold**");
  wg.dispatch({ selection: GardSelection.cursor(3) });
  assert.equal(paste(wg, page), true);
  assert.deepEqual(links(wg), [[page, page, null]]);
  let bold = false;
  wg.state.doc.iterate((node) => {
    if (node.isText && node.param === page) bold = !!Strong.isInSet(node.marks);
  });
  assert.ok(bold);
  wg.dom.remove();
});
