import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  MARK_NAMES,
  HIGHLIGHT_COLORS,
  decodeMarkValue,
  encodeMarkValue,
  formatAddSchema,
  updateSpansConfig,
} from "./marks.mjs";
import {
  createPageData,
  initializePage,
  applyPageOperation,
  orderedBlockIds,
  projectPage,
} from "./page.mjs";
import {
  blockMarkdown,
  parseMarkdown,
  richDoc,
  schema,
  textPath,
  unsupportedMarkdown,
  validateRich,
} from "./richtext.mjs";
import { expand } from "../viewer/wordgard-model.mjs";

function fixture(markdown) {
  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Marks" }));
  doc = A.change(doc, (draft) => initializePage(draft, markdown));
  return { doc, id: orderedBlockIds(doc)[0] };
}
function apply(doc, operations) {
  let result;
  const after = A.change(doc, (draft) => {
    result = applyPageOperation(draft, { operation: "patch_page", arguments: { operations } });
  });
  return { after, result };
}
// Whether a block's Markdown projection parses back to the same structure.
// `isAmgBlock` only records whether a paragraph had its own native marker.
const structure = (node) =>
  JSON.stringify(node.toJSON(), (key, value) => (key === "isAmgBlock" ? undefined : value));
const markdownReproduces = (block) =>
  structure(parseMarkdown(blockMarkdown(block))) === structure(richDoc(block));
const textMarks = (doc, id) =>
  A.spans(doc.blocks[id], ["richText"])
    .filter((span) => span.type === "text")
    .map((span) => [span.value, span.marks ?? {}]);

test("every consumer derives its mark list from the registry", () => {
  assert.deepEqual(MARK_NAMES, ["link", "em", "strong", "strike", "highlight", "code"]);
  assert.deepEqual(HIGHLIGHT_COLORS, ["yellow", "green", "blue", "pink"]);
  assert.deepEqual(Object.keys(schema.marks), [...MARK_NAMES, "unknownMark"]);
  assert.deepEqual(updateSpansConfig, {
    defaultExpand: "both",
    perMarkExpand: { link: "none", code: "none" },
  });
  assert.equal(expand, updateSpansConfig);
  assert.deepEqual(Object.keys(formatAddSchema().properties), MARK_NAMES);
});

test("mark values validate against the registry shapes", () => {
  assert.equal(decodeMarkValue("strong", true), true);
  assert.throws(() => decodeMarkValue("strong", "yes"));
  assert.equal(decodeMarkValue("highlight", "green"), "green");
  assert.equal(decodeMarkValue("highlight", "#00ff88"), "#00ff88");
  for (const bad of ["red", "#00FF88", "#0f8", "", null])
    assert.throws(() => decodeMarkValue("highlight", bad));
  assert.equal(
    encodeMarkValue("link", { href: "https://example.com" }),
    JSON.stringify({ href: "https://example.com", title: null }),
  );
  assert.throws(() => encodeMarkValue("link", { href: "javascript:alert(1)" }));
  assert.throws(() => decodeMarkValue("link", JSON.stringify({ href: "/x", target: "_top" })));
});

test("highlights project as one fixed tag and import back losslessly", () => {
  const source =
    'Plain <mark data-color="green">green **bold**</mark> and <mark data-color="#1f6feb">custom</mark>.';
  const { doc, id } = fixture(source);
  assert.deepEqual(textMarks(doc, id), [
    ["Plain ", {}],
    ["green ", { highlight: "green" }],
    ["bold", { highlight: "green", strong: true }],
    [" and ", {}],
    ["custom", { highlight: "#1f6feb" }],
    [".", {}],
  ]);
  validateRich(doc.blocks[id]);
  // Bold always nests outside a highlight in the projection.
  assert.equal(
    blockMarkdown(doc.blocks[id]),
    'Plain <mark data-color="green">green </mark>**<mark data-color="green">bold</mark>** and <mark data-color="#1f6feb">custom</mark>.',
  );
  assert.ok(markdownReproduces(doc.blocks[id]));
});

test("a bare mark tag is yellow and a line may start with one", () => {
  const { doc, id } = fixture("<mark>first</mark> word\n\n<MARK DATA-COLOR='#ABCDEF'>x</MARK>");
  const spans = textMarks(doc, id);
  assert.deepEqual(spans[0], ["first", { highlight: "yellow" }]);
  assert.deepEqual(spans.at(-1), ["x", { highlight: "#abcdef" }]);
});

test("unbalanced, nested and unknown-color mark tags stay literal text", () => {
  for (const [source, text] of [
    ["open <mark>only", "open <mark>only"],
    ["close only</mark>", "close only</mark>"],
    ['bad <mark data-color="red">x</mark>', 'bad <mark data-color="red">x</mark>'],
  ]) {
    const tree = parseMarkdown(source);
    assert.equal(tree.textContent, text, source);
    let marked = false;
    tree.descendants((node) => {
      marked ||= node.marks.some((mark) => mark.type.name === "highlight");
    });
    assert.equal(marked, false, source);
  }
  // A nested open is literal; the outer pair still highlights.
  const nested = parseMarkdown("<mark>a <mark>b</mark> c");
  assert.equal(nested.textContent, "a <mark>b c");
});

test("literal tag text is escaped on export so it reads back as text", () => {
  const { doc, id } = fixture("text");
  const after = A.change(doc, (d) => A.splice(d, textPath(id), 0, 4, "use <mark> tags"));
  const markdown = blockMarkdown(after.blocks[id]);
  assert.equal(markdown, "use \\<mark> tags");
  assert.equal(parseMarkdown(markdown).textContent, "use <mark> tags");
  assert.ok(markdownReproduces(after.blocks[id]));
});

test("bold that crosses a highlight boundary exports Markdown that reads back the same", () => {
  for (const source of [
    "<mark>a **b</mark> c**",
    "**a <mark>b** c</mark>",
    "x <mark>*a* b</mark>",
  ]) {
    const { doc, id } = fixture(source);
    const markdown = blockMarkdown(doc.blocks[id]);
    assert.ok(parseMarkdown(markdown).eq(parseMarkdown(source)), `${source} -> ${markdown}`);
    assert.ok(markdownReproduces(doc.blocks[id]), source);
  }
});

test("other HTML is refused for agents and literal text otherwise", () => {
  for (const [source, excerpt] of [
    ["<marker>x</marker>", "<marker>"],
    ["<div>x</div>", "<div>"],
  ]) {
    assert.deepEqual(unsupportedMarkdown(source), {
      construct: "html",
      line: 1,
      column: 1,
      excerpt,
    });
    const doc = parseMarkdown(source);
    assert.equal(doc.firstChild.type.name, "paragraph");
    assert.equal(doc.textContent, source);
  }
  // Neither is a tag: `<mark:x>` is an autolink to a refused scheme, and a
  // tag's spaces are ASCII, as in CommonMark, so `<mark\u00a0>` is text. An
  // agent may write both.
  for (const source of ["<mark:x>", "<mark\u00a0>x</mark>"]) {
    assert.equal(unsupportedMarkdown(source), null, source);
    assert.equal(parseMarkdown(source).textContent, source);
  }
});

test("strikethrough round trips through Markdown and native spans", () => {
  for (const source of ["~~gone~~", "a ~~b **c**~~ d", "| A |\n| --- |\n| ~~x~~ |", "> ~~q~~"]) {
    const { doc, id } = fixture(source);
    assert.ok(
      textMarks(doc, id).some(([, marks]) => marks.strike === true),
      source,
    );
    assert.equal(blockMarkdown(doc.blocks[id]), source);
    assert.ok(markdownReproduces(doc.blocks[id]), source);
  }
  // A single tilde, a code span and an escape are not strikethrough.
  for (const source of ["~one~", "`~~x~~`", "\\~~x~~"]) {
    const { doc, id } = fixture(source);
    assert.ok(!textMarks(doc, id).some(([, marks]) => marks.strike), source);
  }
  // format_match adds and removes it like any flag mark.
  const { doc, id } = fixture("plain words");
  const { after } = apply(doc, [
    { op: "format_match", block_id: id, match_text: "words", add: { strike: true } },
  ]);
  assert.equal(blockMarkdown(after.blocks[id]), "plain ~~words~~");
});

test("highlights inside table cells round trip", () => {
  const source = '| A | B |\n| --- | --- |\n| <mark data-color="pink">p</mark> | q |';
  const { doc, id } = fixture(source);
  assert.ok(textMarks(doc, id).some(([text, marks]) => text === "p" && marks.highlight === "pink"));
  assert.ok(markdownReproduces(doc.blocks[id]));
});

test("a mark from a newer build reads as plain text and survives text edits", () => {
  const { doc, id } = fixture("future text");
  const marked = A.change(doc, (d) =>
    A.mark(d, textPath(id), { start: 0, end: 6, expand: "none" }, "underline", true),
  );
  assert.equal(blockMarkdown(marked.blocks[id]), "future text");
  assert.equal(markdownReproduces(marked.blocks[id]), false);
  assert.throws(() => validateRich(marked.blocks[id]), /Unsupported rich mark/);
  // replace_match edits the text and keeps the foreign mark.
  const { after } = apply(marked, [
    { op: "replace_match", block_id: id, match_text: "text", replacement: "words" },
  ]);
  assert.deepEqual(textMarks(after, id), [
    ["future", { underline: true }],
    [" words", {}],
  ]);
});

test("format_match adds, recolors and removes marks without touching text", () => {
  const { doc, id } = fixture("Highlight the launch date here.");
  const object = A.getObjectId(doc.blocks[id], "richText");
  let { after, result } = apply(doc, [
    {
      op: "format_match",
      block_id: id,
      match_text: "launch date",
      add: { highlight: "Green", strong: true },
    },
  ]);
  assert.deepEqual(result.edits, [{ op: "format_match", block_id: id, matched: 1 }]);
  assert.equal(A.getObjectId(after.blocks[id], "richText"), object);
  assert.equal(after.blocks[id].richText, doc.blocks[id].richText);
  assert.equal(
    projectPage(after).blocks[0].markdown,
    'Highlight the **<mark data-color="green">launch date</mark>** here.',
  );
  ({ after } = apply(after, [
    { op: "format_match", block_id: id, match_text: "launch", add: { highlight: "#FF8800" } },
    { op: "format_match", block_id: id, match_text: "date", remove: ["strong", "highlight"] },
  ]));
  assert.deepEqual(textMarks(after, id), [
    ["Highlight the ", {}],
    ["launch", { highlight: "#ff8800", strong: true }],
    [" ", { highlight: "green", strong: true }],
    ["date here.", {}],
  ]);
  validateRich(after.blocks[id]);
});

test("format_match links text and rejects unsafe or unknown marks", () => {
  const { doc, id } = fixture("See the docs for more.");
  const { after } = apply(doc, [
    {
      op: "format_match",
      block_id: id,
      match_text: "docs",
      add: { link: { href: "https://example.com/docs" } },
    },
  ]);
  assert.equal(
    projectPage(after).blocks[0].markdown,
    "See the [docs](https://example.com/docs) for more.",
  );
  const fail = (op, pattern) =>
    assert.throws(
      () => apply(A.clone(doc), [{ op: "format_match", block_id: id, ...op }]),
      pattern,
    );
  fail({ match_text: "docs", add: { link: { href: "javascript:alert(1)" } } }, /Invalid link/);
  fail({ match_text: "docs", add: { underline: true } }, /Unsupported rich mark/);
  fail({ match_text: "docs", add: { highlight: "red" } }, /Invalid highlight/);
  fail({ match_text: "docs", add: { strong: "yes" } }, /true/);
  fail({ match_text: "docs" }, /add or remove/);
  fail({ match_text: "docs", add: { em: true }, remove: ["em"] }, /both added and removed/);
  fail({ match_text: "e", add: { em: true } }, /format_match found \d+ matches/);
});

test("format_match refuses code text, and stray code marks don't break reads", () => {
  const { doc, id } = fixture("```\nalpha\nbeta\n```");
  assert.throws(
    () =>
      apply(A.clone(doc), [
        { op: "format_match", block_id: id, match_text: "alpha", add: { highlight: "green" } },
      ]),
    /code block/,
  );
  // A mark another writer left on code text: the Page still projects.
  const marked = A.change(doc, (d) =>
    A.mark(d, textPath(id), { start: 1, end: 6, expand: "none" }, "strong", true),
  );
  assert.equal(projectPage(marked).blocks[0].markdown, "```\nalpha\nbeta\n```");
});
