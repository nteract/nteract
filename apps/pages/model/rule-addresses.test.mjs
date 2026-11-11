// Passage addresses after rules and dataframes. A rule or dataframe is a leaf
// with no text; node_index scoping and target-scoped edits must still find
// the nodes and characters after it.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { guardPassageEdits } from "./passage-edits.mjs";
import { visibleNodeRange, visibleRangeAddress } from "./replace-match.mjs";
import { encode } from "./wordgard-doc.mjs";
import { PAGE_ID, pageWithSpans } from "../test/address-inputs.mjs";
import { toWordgardTree } from "../test/random-page-tree.mjs";

const S = (value) => new A.ImmutableString(value);
const block = (type, parents = [], attrs = {}) => ({
  type: "block",
  value: { type: S(type), parents: parents.map(S), attrs, isEmbed: false },
});
const text = (value) => ({ type: "text", value, marks: {} });
const ASSET = `/api/pages/${PAGE_ID}/assets/${"a".repeat(64)}`;
const dataframe = () =>
  block("dataframe", [], { src: S(ASSET), media_type: S("application/vnd.apache.parquet") });

const ranges = (doc, id, count) =>
  Array.from({ length: count }, (_, index) => {
    const { start, end } = visibleNodeRange(doc, id, index);
    return [start, end];
  });
function replace(doc, id, input) {
  return A.change(A.clone(doc), (draft) =>
    applyPageOperation(draft, {
      operation: "patch_page",
      arguments: { operations: [{ op: "replace_match", block_id: id, ...input }] },
    }),
  );
}
/** A target-scoped replace_match at the current heads, applied. */
function guarded(doc, id, input) {
  const plan = guardPassageEdits(doc, A.getHeads(doc), [
    { op: "replace_match", block_id: id, ...input },
  ]);
  return { plan, after: replace(doc, id, plan.operations[0]) };
}

test("a second adjacent rule has its own range, and text after it is addressable", () => {
  const { doc, id } = pageWithSpans([
    block("horizontal-rule"),
    block("horizontal-rule"),
    block("paragraph"),
    text("after"),
  ]);
  assert.deepEqual(ranges(doc, id, 3), [
    [0, 1],
    [1, 2],
    [2, 8],
  ]);
  const at = doc.blocks[id].richText.indexOf("after");
  assert.equal(visibleRangeAddress(doc, id, at, at + 5).node_index, 2);
  const scoped = replace(doc, id, { match_text: "after", replacement: "later", node_index: 2 });
  assert.match(scoped.blocks[id].richText, /later$/);
  const { plan, after } = guarded(doc, id, {
    match_text: "after",
    replacement: "later",
    node_index: 2,
  });
  assert.equal(plan.operations[0].node_index, 2);
  assert.match(after.blocks[id].richText, /later$/);
});

test("the corpus rule variants address every node, the quote's rule included", () => {
  let doc = A.from(createPageData({ pageId: PAGE_ID, title: "Rules" }));
  doc = A.change(doc, (draft) =>
    initializePage(draft, "***\n\n___\n\n- item\n\n  ---\n\n> ---\n\nclosing words"),
  );
  const id = orderedBlockIds(doc)[0];
  assert.deepEqual(ranges(doc, id, 5), [
    [0, 1],
    [1, 2],
    [2, 9],
    [9, 11],
    [11, 25],
  ]);
  const { plan, after } = guarded(doc, id, {
    match_text: "closing",
    replacement: "final",
    node_index: 4,
  });
  assert.equal(plan.operations[0].node_index, 4);
  assert.match(after.blocks[id].richText, /final words$/);
});

test("text after adjacent dataframes is addressable", () => {
  const { doc, id } = pageWithSpans([dataframe(), dataframe(), block("paragraph"), text("after")]);
  assert.deepEqual(ranges(doc, id, 3), [
    [0, 1],
    [1, 2],
    [2, 8],
  ]);
  const scoped = replace(doc, id, { match_text: "after", replacement: "later", node_index: 2 });
  assert.match(scoped.blocks[id].richText, /later$/);
  const { after } = guarded(doc, id, { match_text: "after", replacement: "later" });
  assert.match(after.blocks[id].richText, /later$/);
});

test("a nested dataframe and rule don't throw off a later target-scoped edit", () => {
  // fast-check's shrunk counterexample: the edit used to fail with
  // "Position N out of range".
  const tree = toWordgardTree({
    kind: "doc",
    children: [
      {
        kind: "task",
        children: [
          {
            kind: "item",
            checked: false,
            children: [
              {
                kind: "ordered",
                start: 1,
                children: [
                  {
                    kind: "item",
                    children: [
                      {
                        kind: "dataframe",
                        attrs: { src: ASSET, media_type: "application/vnd.apache.parquet" },
                      },
                      { kind: "rule" },
                      { kind: "paragraph", children: [] },
                    ],
                  },
                  { kind: "item", children: [{ kind: "paragraph", children: [] }] },
                ],
              },
            ],
          },
        ],
      },
      { kind: "paragraph", children: [{ kind: "text", value: "tail", marks: {} }] },
    ],
  });
  const { doc, id } = pageWithSpans(encode(tree));
  const at = doc.blocks[id].richText.indexOf("tail");
  assert.equal(visibleRangeAddress(doc, id, at, at + 4).node_index, 1);
  const { plan, after } = guarded(doc, id, {
    match_text: "tail",
    replacement: "end",
    node_index: 1,
  });
  assert.equal(plan.operations[0].node_index, 1);
  assert.match(after.blocks[id].richText, /end$/);
});

const marker = (type, parents = [], attrs = {}) => ({ type, parents, attrs });
/** `doc` with a heading inserted before index `at` of block `id`. With
 * `opening`, the text from `at` onward was unmarked text (what a merge can
 * leave) and now opens with its own paragraph marker, as a writer marks it. */
function headingAbove(doc, id, at, opening = false) {
  return A.change(A.clone(doc), (draft) => {
    const path = ["blocks", id, "richText"];
    if (opening) A.splitBlock(draft, path, at, marker("paragraph"));
    A.splitBlock(draft, path, at, marker("heading", [], { level: 2 }));
    A.splice(draft, path, at + 1, 0, "Title");
  });
}
function targetScoped(base, current, id, extra = {}) {
  const plan = guardPassageEdits(current, A.getHeads(base), [
    { op: "replace_match", block_id: id, match_text: "target", replacement: "result", ...extra },
  ]);
  return { plan, after: replace(current, id, plan.operations[0]) };
}

test("a heading inserted before unmarked text leaves a target-scoped edit valid", () => {
  const { doc: base, id } = pageWithSpans([text("the target here"), block("paragraph"), text("x")]);
  const current = headingAbove(base, id, 0, true);
  const { plan, after } = targetScoped(base, current, id, { node_index: 0 });
  assert.equal(plan.operations[0].node_index, 1);
  assert.match(after.blocks[id].richText, /the result here/);
});

test("a heading inserted above a list or a quote leaves a target-scoped edit valid", () => {
  for (const container of ["unordered-list-item", "blockquote"]) {
    const { doc: base, id } = pageWithSpans([
      text("intro"),
      block(container),
      ...(container === "blockquote" ? [block("paragraph", ["blockquote"])] : []),
      text("the target here"),
      block("paragraph"),
      text("x"),
    ]);
    const current = headingAbove(base, id, 5);
    const { plan, after } = targetScoped(base, current, id, { node_index: 1 });
    assert.equal(plan.operations[0].node_index, 2, container);
    assert.match(after.blocks[id].richText, /the result here/, container);
  }
});

test("a paragraph gaining its own marker inside a list item or quote keeps its ancestry", () => {
  // The item's or quote's first paragraph is unmarked text, which a merge can
  // leave; the marker a writer gives it names the same structure.
  for (const container of ["unordered-list-item", "blockquote"]) {
    const spans = (own) => [
      block(container),
      ...(own ? [block("paragraph", [container])] : []),
      text("the target here"),
    ];
    const plain = pageWithSpans(spans(false));
    const marked = pageWithSpans(spans(true));
    const at = (doc, id) => doc.blocks[id].richText.indexOf("target");
    assert.deepEqual(
      visibleRangeAddress(plain.doc, plain.id, at(plain.doc, plain.id), at(plain.doc, plain.id) + 6)
        .ancestry,
      visibleRangeAddress(
        marked.doc,
        marked.id,
        at(marked.doc, marked.id),
        at(marked.doc, marked.id) + 6,
      ).ancestry,
      container,
    );
  }
});

test("node_index refuses a block whose stored and readable node counts disagree", () => {
  // Peer-written markers with parent chains no writer produces: the Markdown
  // projection reads two top-level nodes here, the stored spans three.
  const { doc, id } = pageWithSpans([
    text("a"),
    block("future-x"),
    { type: "block", value: { type: S("hard-break"), parents: [], attrs: {}, isEmbed: true } },
    block("future-x", ["future-x", "aside"]),
    text("d"),
  ]);
  assert.throws(() => visibleNodeRange(doc, id, 2), /node_index can't address this block/);
  assert.throws(() => visibleNodeRange(doc, id, 0), /node_index can't address this block/);
  assert.throws(
    () => replace(doc, id, { match_text: "d", replacement: "e", node_index: 1 }),
    /node_index can't address this block/,
  );
  // Without node_index the passage still matches.
  assert.match(replace(doc, id, { match_text: "d", replacement: "e" }).blocks[id].richText, /e$/);
});

test("a block holding only an image has a range that covers the image", () => {
  // The image is the first paragraph's only character after its marker. It
  // has no visible text, so no match can land in it; the range still has to
  // hold it, as every other node's range holds a trailing image.
  const page = (markdown) => {
    let doc = A.from(createPageData({ pageId: PAGE_ID, title: "Images" }));
    doc = A.change(doc, (draft) => initializePage(draft, markdown));
    return { doc, id: orderedBlockIds(doc)[0] };
  };
  const only = page("![chart](https://example.org/a.png)");
  assert.deepEqual(ranges(only.doc, only.id, 1), [[0, 2]]);
  // Text before a trailing image, and an image-only paragraph after another
  // node.
  const caption = page("Caption words ![chart](https://example.org/a.png)");
  assert.deepEqual(ranges(caption.doc, caption.id, 1), [[0, 16]]);
  const after = replace(caption.doc, caption.id, {
    match_text: "words",
    replacement: "text",
    node_index: 0,
  });
  assert.equal(after.blocks[caption.id].richText, "\ufffcCaption text \ufffc");
  const titled = page("# Title\n\n![chart](https://example.org/a.png)");
  assert.deepEqual(ranges(titled.doc, titled.id, 2), [
    [0, 6],
    [6, 8],
  ]);
});
