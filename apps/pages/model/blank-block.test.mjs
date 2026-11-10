// isBlankBlock reads emptiness from stored spans. Its contract is the answer
// the Markdown projection gives: `!blockMarkdown(block).trim()`.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as A from "@automerge/automerge";
import { createPageData, orderedBlockIds } from "./page.mjs";
import { blockMarkdown, isBlankBlock, textPath } from "./richtext.mjs";
import { MARK_NAMES, updateSpansConfig } from "./marks.mjs";
import { stampSpans } from "./schema-features.mjs";
import { encode } from "../viewer/wordgard-model.mjs";
import { PAGE_ID, pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";

const parameters = {
  seed: Number(process.env.PAGES_FUZZ_SEED ?? 0x5eed),
  numRuns: Number(process.env.PAGES_FUZZ_RUNS ?? 50),
};

function storedBlock(spans) {
  let doc = A.from(createPageData({ pageId: PAGE_ID, title: "Blank" }));
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) => {
    draft.blocks[id].richText = "";
    A.updateSpans(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  return doc.blocks[id];
}
const richBlock = (children) => storedBlock(encode(toWordgardTree({ kind: "doc", children })));
const projectedBlank = (block) => !blockMarkdown(block).trim();

const text = (value, marks = {}) => ({ kind: "text", value, marks });
const paragraph = (...children) => ({ kind: "paragraph", children });
const hardBreak = { kind: "break" };
const image = { kind: "image", attrs: { src: "https://example.org/i.png", alt: "", title: null } };
const dataframe = {
  kind: "dataframe",
  attrs: {
    src: `/api/pages/${PAGE_ID}/assets/${"b".repeat(64)}`,
    media_type: "application/vnd.apache.parquet",
  },
};
const MARK_VALUES = {
  link: { href: "https://example.org", title: null },
  em: true,
  strong: true,
  strike: true,
  highlight: "yellow",
  code: true,
};
const unknown = (type, parents, isEmbed) => ({
  type: "block",
  value: {
    type: new A.ImmutableString(type),
    parents: parents.map((parent) => new A.ImmutableString(parent)),
    attrs: {},
    isEmbed,
  },
});

const cases = [
  ["empty paragraph", [paragraph()], true],
  ["two empty paragraphs", [paragraph(), paragraph()], true],
  ["spaces", [paragraph(text("   "))], true],
  ["tab", [paragraph(text("\t"))], true],
  ["newline text", [paragraph(text("\n"))], true],
  ["no-break space", [paragraph(text("\u00a0"))], true],
  ["ideographic space", [paragraph(text("\u3000"))], true],
  ["zero-width space", [paragraph(text("\u200b"))], false],
  ["only a hard break", [paragraph(hardBreak)], true],
  ["two hard breaks", [paragraph(hardBreak, hardBreak)], true],
  ["whitespace then a hard break", [paragraph(text(" \n"), hardBreak)], true],
  ["hard break then whitespace", [paragraph(text(" "), hardBreak, text(" "))], false],
  ["hard break then a paragraph", [paragraph(hardBreak), paragraph(text(" "))], true],
  ["only an image", [paragraph(image)], false],
  ["only a rule", [{ kind: "rule" }], false],
  ["only a dataframe", [dataframe], false],
  [
    "empty list item",
    [{ kind: "bullet", children: [{ kind: "item", children: [paragraph()] }] }],
    false,
  ],
  [
    "empty task item",
    [{ kind: "task", children: [{ kind: "item", checked: false, children: [paragraph()] }] }],
    false,
  ],
  ["empty quote", [{ kind: "quote", children: [paragraph()] }], false],
  [
    "empty table",
    [
      {
        kind: "table",
        children: [{ kind: "row", children: [{ kind: "header", align: null, children: [] }] }],
      },
    ],
    false,
  ],
  ["empty code block", [{ kind: "code", language: null, children: [] }], false],
  ["empty heading", [{ kind: "heading", level: 2, children: [] }], false],
  ["text", [paragraph(text("a"))], false],
];

test("isBlankBlock agrees with the Markdown projection on hand-picked blocks", () => {
  for (const [name, children, blank] of cases) {
    const block = richBlock(children);
    assert.equal(projectedBlank(block), blank, `${name}: projection`);
    assert.equal(isBlankBlock(block), blank, name);
  }
});

test("isBlankBlock knows which marks keep whitespace visible", () => {
  for (const name of MARK_NAMES) {
    assert.ok(name in MARK_VALUES, `classify mark ${name} for isBlankBlock`);
    const block = richBlock([paragraph(text(" ", { [name]: MARK_VALUES[name] }))]);
    assert.equal(isBlankBlock(block), projectedBlank(block), name);
  }
  // Strong, em and strike expel whitespace, so the link around it never opens.
  const linkStrong = richBlock([paragraph(text(" ", { link: MARK_VALUES.link, strong: true }))]);
  assert.equal(projectedBlank(linkStrong), true);
  assert.equal(isBlankBlock(linkStrong), true);
  const future = storedBlock([{ type: "text", value: " ", marks: { future: true } }]);
  assert.equal(projectedBlank(future), true);
  assert.equal(isBlankBlock(future), true);
});

test("isBlankBlock treats nodes this build doesn't know as content", () => {
  for (const spans of [
    [unknown("future-block", [], false)],
    [unknown("future-embed", [], true)],
    [unknown("paragraph", ["future-aside"], false)],
  ]) {
    const block = storedBlock(spans);
    assert.equal(projectedBlank(block), false);
    assert.equal(isBlankBlock(block), false);
  }
});

function agreesOnTrees(arbitrary) {
  let blanks = 0;
  fc.assert(
    fc.property(arbitrary, (description) => {
      const block = storedBlock(encode(toWordgardTree(description)));
      const blank = projectedBlank(block);
      if (blank) blanks++;
      assert.equal(isBlankBlock(block), blank);
    }),
    parameters,
  );
  return blanks;
}

test("isBlankBlock agrees with the Markdown projection on generated Page trees", () => {
  agreesOnTrees(pageTreeArbitrary({ maxDepth: 2 }));
  agreesOnTrees(pageTreeArbitrary({ maxDepth: 2, hostile: true }));
});

// Generated Page trees are rarely blank. This profile stays near the boundary:
// whitespace runs with every mark, hard breaks and images in paragraphs.
test("isBlankBlock agrees with the Markdown projection near blank", () => {
  const whitespace = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\u00a0", "\u3000", "\u200b", "a"), {
      minLength: 1,
      maxLength: 3,
    })
    .map((parts) => parts.join(""));
  // Code text takes no formatting but a link (Wordgard's schema).
  const marks = fc
    .subarray(MARK_NAMES)
    .map((names) =>
      Object.fromEntries(
        names
          .filter((name) => !names.includes("code") || name === "code" || name === "link")
          .map((name) => [name, MARK_VALUES[name]]),
      ),
    );
  const inline = fc.oneof(
    { weight: 4, arbitrary: fc.record({ kind: fc.constant("text"), value: whitespace, marks }) },
    { weight: 3, arbitrary: fc.constant(hardBreak) },
    { weight: 1, arbitrary: fc.constant(image) },
  );
  const doc = fc.record({
    kind: fc.constant("doc"),
    children: fc.array(
      fc.oneof(
        {
          weight: 6,
          arbitrary: fc.array(inline, { maxLength: 4 }).map((children) => paragraph(...children)),
        },
        { weight: 1, arbitrary: fc.constant({ kind: "heading", level: 1, children: [] }) },
        { weight: 1, arbitrary: fc.constant({ kind: "rule" }) },
      ),
      { minLength: 1, maxLength: 3 },
    ),
  });
  const blanks = agreesOnTrees(doc);
  assert.ok(blanks >= parameters.numRuns / 20, `only ${blanks} blank blocks generated`);
});
