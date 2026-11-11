import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  ANCHOR_SLUG_MAX,
  EMPTY_HEADING_ANCHOR,
  createAnchorSlugger,
  headingAnchorsByBlock,
  headingSlug,
  headingsInSpans,
  pageHeadingAnchors,
} from "./heading-anchors.mjs";
import { safeUrl } from "./marks.mjs";
import { exportMarkdown, parseMarkdown, setRichMarkdown } from "./richtext.mjs";
import { PagesLink } from "./wordgard-doc.mjs";
import { richFromSource } from "./richtext-test-support.mjs";
import { linkDestination } from "../viewer/link-destination.mjs";

test("slugs are lowercase words joined by hyphens, punctuation dropped", () => {
  const cases = [
    ["Getting lean: Automerge", "getting-lean-automerge"],
    ["What's next?", "whats-next"],
    ["  Spaced   out\tline  ", "spaced-out-line"],
    ["C++ & Rust (2026)", "c-rust-2026"],
    ["snake_case and kebab-case", "snake_case-and-kebab-case"],
    ["**Bold** `code`", "bold-code"],
    ["Line\nbreak", "line-break"],
  ];
  for (const [text, slug] of cases) assert.equal(headingSlug(text), slug, text);
});

test("slugs keep letters and digits of every script and drop symbols", () => {
  assert.equal(headingSlug("Café ✨ 東京"), "café-東京");
  assert.equal(headingSlug("Ünïcödé Straße"), "ünïcödé-straße");
  assert.equal(headingSlug("Привет, мир"), "привет-мир");
  assert.equal(headingSlug("مرحبا بالعالم"), "مرحبا-بالعالم");
  // Composed and decomposed forms name the same anchor.
  assert.equal(headingSlug("Cafe\u0301"), headingSlug("Café"));
  assert.equal(headingSlug("🌊🌊"), "");
  assert.equal(headingSlug(""), "");
  assert.equal(headingSlug(undefined), "");
});

test("long slugs are cut by code point without a trailing hyphen", () => {
  const slug = headingSlug(`${"word ".repeat(40)}end`);
  assert.ok([...slug].length <= ANCHOR_SLUG_MAX);
  assert.ok(!slug.endsWith("-"));
  assert.equal([...headingSlug("東".repeat(150))].length, ANCHOR_SLUG_MAX);
});

test("repeated headings are numbered in order; empty headings get a name", () => {
  const name = createAnchorSlugger();
  assert.deepEqual(["Notes", "Notes", "Notes 1", "notes!", "", "✨", "Section"].map(name), [
    "notes",
    "notes-1",
    "notes-1-1",
    "notes-2",
    EMPTY_HEADING_ANCHOR,
    `${EMPTY_HEADING_ANCHOR}-1`,
    `${EMPTY_HEADING_ANCHOR}-2`,
  ]);
});

test("heading text in spans includes nested headings, breaks and image alt text", () => {
  const spans = [
    { type: "block", value: { type: "heading", parents: [], attrs: { level: 2 } } },
    { type: "text", value: "Getting " },
    { type: "block", value: { type: "hard-break", parents: [], attrs: {}, isEmbed: true } },
    { type: "text", value: "lean" },
    { type: "block", value: { type: "paragraph", parents: [], attrs: {} } },
    { type: "text", value: "Body" },
    {
      type: "block",
      value: { type: "heading", parents: ["blockquote"], attrs: { level: 3 } },
    },
    {
      type: "block",
      value: { type: "image", parents: [], attrs: { alt: "Logo", src: "/x.png" }, isEmbed: true },
    },
    { type: "text", value: " quoted" },
    { type: "block", value: { type: "heading", parents: [], attrs: { level: 1 } } },
  ];
  assert.deepEqual(headingsInSpans(spans), [
    { level: 2, text: "Getting  lean" },
    { level: 3, text: "Logo quoted" },
    { level: 1, text: "" },
  ]);
});

function page(blocks) {
  return A.change(A.from({ page_id: "anchor-fixture", title: "Title", blocks: {} }), (doc) => {
    blocks.forEach(({ id, markdown }, index) => {
      doc.blocks[id] = {
        position: new A.RawString(`a${index}`),
        markdown,
      };
      richFromSource(doc, id);
    });
  });
}

test("a Page's anchors run across blocks in document order", () => {
  let doc = page([
    { id: "one", markdown: "# Overview\n\nSee [the plan](#plan).\n\n## Plan\n\nText." },
    { id: "two", markdown: "Intro.\n\n> ## Plan\n\n## Getting lean: Automerge" },
  ]);
  const anchors = pageHeadingAnchors(doc);
  assert.deepEqual(
    anchors.map(({ blockId, index, level, anchor }) => ({ blockId, index, level, anchor })),
    [
      { blockId: "one", index: 0, level: 1, anchor: "overview" },
      { blockId: "one", index: 1, level: 2, anchor: "plan" },
      { blockId: "two", index: 0, level: 2, anchor: "plan-1" },
      { blockId: "two", index: 1, level: 2, anchor: "getting-lean-automerge" },
    ],
  );
  assert.equal(pageHeadingAnchors(doc), anchors, "cached per document version");
  assert.deepEqual(headingAnchorsByBlock(doc).get("two"), ["plan-1", "getting-lean-automerge"]);
  // A renamed heading gets a new anchor; the next version recomputes.
  doc = A.change(doc, (d) => setRichMarkdown(d, "one", "# Overview\n\n## Planning"));
  assert.deepEqual(
    pageHeadingAnchors(doc).map((entry) => entry.anchor),
    ["overview", "planning", "plan", "getting-lean-automerge"],
  );
  assert.deepEqual(pageHeadingAnchors(null), []);
});

test("fragment links pass link validation; executable schemes don't", () => {
  const id = "1a160b47-6df1-4983-81eb-489ca5a26812";
  for (const href of ["#getting-lean-automerge", `/p/${id}#plan`, "#café-東京"])
    assert.equal(safeUrl(href), true, href);
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "# x"])
    assert.equal(safeUrl(href), false, href);
  const base = `https://pages.example/p/${id}`;
  assert.equal(linkDestination("#plan", base), `${base}#plan`);
  assert.equal(linkDestination(`/p/${id}#plan`, base), `${base}#plan`);
  assert.equal(linkDestination("javascript:alert(1)", base), null);
});

test("Markdown heading links round trip as link marks", () => {
  const id = "1a160b47-6df1-4983-81eb-489ca5a26812";
  for (const source of [
    "See [*Getting lean: Automerge*](#getting-lean-automerge).",
    `Elsewhere: [the plan](/p/${id}#plan)`,
  ]) {
    const doc = parseMarkdown(source);
    let href = null;
    doc.iterate((node) => {
      href ??= node.mark(PagesLink)?.href ?? null;
    });
    assert.ok(href?.includes("#"), source);
    assert.equal(exportMarkdown(doc), source);
  }
  // Agent writes store them: a Page written with one keeps the href.
  const doc = page([{ id: "one", markdown: "| See |\n| --- |\n| [Plan](#plan) |\n\n## Plan" }]);
  const spans = A.spans(doc.blocks.one, ["richText"]);
  assert.ok(
    spans.some((span) => span.marks?.link && JSON.stringify(span.marks.link).includes("#plan")),
  );
});
