// Node addressing against recorded expectations. model/node-addresses.golden.json
// holds, for every input in test/address-inputs.mjs (hand-written stored
// shapes, the Markdown corpus written as rich text, seeded random editor
// trees), the node ids and types read_page reports, and the node ranges and
// per-text node index node-addresses.mjs computes. Agents address nodes by
// these values, so a change here is a tool-contract change.
//
// Regenerate only when an input or an intended behavior changes:
// PAGES_UPDATE_ADDRESSES=1 npm exec -- tsx --tsconfig tsconfig.json --test model/node-addresses.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as A from "@automerge/automerge";
import { ancestryAt, blockAddresses, nodeIndexAt } from "./node-addresses.mjs";
import { nodeIds, readableNodeIds } from "./node-ids.mjs";
import { projectReadContent } from "./read-content.mjs";
import { visibleRangeAddress } from "./replace-match.mjs";
import { addressIndex, blockAddress, nodeAddresses, resolveAddress } from "./addresses.mjs";
import { textPath } from "./richtext-format.mjs";
import { nativeRead } from "./native-read.mjs";
import { blockMarkdown, repairBlockMarkers } from "./richtext-page.mjs";
import { decode } from "./wordgard-doc.mjs";
import { applyPageOperation } from "./page.mjs";
import { allInputs, PAGE_ID, pageWithSpans, spansToJSON } from "../test/address-inputs.mjs";

const GOLDEN = new URL("./node-addresses.golden.json", import.meta.url);
const update = process.env.PAGES_UPDATE_ADDRESSES === "1";
const inputs = allInputs();
const hash = (spans) =>
  createHash("sha256")
    .update(JSON.stringify(spansToJSON(spans)))
    .digest("hex")
    .slice(0, 16);

/** Each text span's first character's top-level node index, in span order. */
function textIndexes(addresses, spans) {
  const out = [];
  let at = 0;
  for (const span of spans) {
    if (span.type === "text") out.push(nodeIndexAt(addresses, at));
    at += span.type === "text" ? span.value.length : 1;
  }
  return out;
}

function observe(spans) {
  const { doc, id } = pageWithSpans(spans);
  let tree;
  try {
    tree = nativeRead(doc.blocks[id], doc.page_id);
  } catch {
    return { readable: false };
  }
  let outline = null;
  try {
    outline = projectReadContent(doc, { include_content: false }).outline;
  } catch {
    // A shape read_page refuses has no outline.
  }
  const ids = readableNodeIds(doc, id, tree);
  let addresses;
  try {
    addresses = blockAddresses(A.spans(doc, textPath(id)));
  } catch {
    addresses = null;
  }
  return {
    doc,
    id,
    observed: {
      ids: ids.map((entry) => entry.at),
      types: outline?.map((entry) => entry.type) ?? null,
      ...(addresses && {
        placed: addresses.placed,
        ranges: addresses.nodes.map(({ start, end }) => [start, end]),
        text: textIndexes(addresses, A.spans(doc, textPath(id))),
      }),
    },
    outline,
  };
}

test("frozen inputs are the ones the golden file was made from", () => {
  if (update) {
    const golden = inputs.map(({ name, spans }) => {
      const result = observe(spans);
      return { name, hash: hash(spans), ...(result.observed ?? { readable: false }) };
    });
    writeFileSync(
      GOLDEN,
      `${JSON.stringify(golden, null, 0).replaceAll('},{"name"', '},\n{"name"')}\n`,
    );
  }
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(
    golden.map(({ name, hash }) => ({ name, hash })),
    inputs.map(({ name, spans }) => ({ name, hash: hash(spans) })),
    "An input changed: regenerate model/node-addresses.golden.json (see the header).",
  );
});

test("node ids, outline entries and ranges match the frozen expectations", () => {
  const golden = new Map(
    JSON.parse(readFileSync(GOLDEN, "utf8")).map((entry) => [entry.name, entry]),
  );
  for (const { name, spans } of inputs) {
    const expected = golden.get(name);
    const result = observe(spans);
    if (!result.observed) {
      assert.equal(expected.readable, false, name);
      continue;
    }
    const { doc, id, observed, outline } = result;
    const { name: _name, hash: _hash, ...frozen } = expected;
    assert.deepEqual(observed, frozen, name);
    if (!outline) continue;
    // The outline has one entry per top-level node; the first names the
    // block, and each node_id is the cursor at the frozen marker.
    assert.deepEqual(
      outline.map((entry) => entry.block),
      frozen.ids.map((_at, index) => (index === 0 ? blockAddress(doc, id) : undefined)),
      name,
    );
    assert.deepEqual(
      outline.map((entry) => entry.node_id),
      frozen.ids.map((at) => (at === null ? null : A.getCursor(doc, textPath(id), at))),
      name,
    );
  }
});

test("node ids resolve to the frozen ranges, and passages address the frozen nodes", () => {
  const golden = new Map(
    JSON.parse(readFileSync(GOLDEN, "utf8")).map((entry) => [entry.name, entry]),
  );
  const failed = [];
  for (const { name, spans } of inputs) {
    const expected = golden.get(name);
    if (!expected.ranges) continue;
    const { doc, id } = pageWithSpans(spans);
    const path = textPath(id);
    const text = doc.blocks[id].richText;
    const observed = { ranges: [], text: [] };
    // Every node, and up to 8 text runs per input, keep the test quick.
    const runs = expected.text.length;
    const step = Math.ceil(runs / 8) || 1;
    const sampled = expected.text.filter((_index, run) => run % step === 0);
    try {
      // A paragraph of unmarked text has no id, and a node before one has no
      // marked end until a write marks the block (page.mjs), so it resolves
      // to no range. The frozen range stands for each.
      const index = addressIndex(doc);
      const addresses = nodeAddresses(doc, id);
      for (const [n, address] of addresses.entries()) {
        if (address === null) {
          observed.ranges.push(expected.ranges[n]);
          continue;
        }
        if (addresses[n + 1] === null) {
          assert.throws(() => resolveAddress(index, address), /unmarked text/);
          observed.ranges.push(expected.ranges[n]);
          continue;
        }
        const resolved = resolveAddress(index, address);
        assert.equal(resolved.index, n);
        observed.ranges.push([resolved.start, resolved.end]);
      }
      let at = 0;
      let run = 0;
      for (const span of A.spans(doc, path)) {
        if (span.type === "text" && run++ % step === 0) {
          const end = at + (/[\ud800-\udbff]/.test(text[at]) ? 2 : 1);
          observed.text.push(visibleRangeAddress(doc, id, at, end).index);
        }
        at += span.type === "text" ? span.value.length : 1;
      }
    } catch (error) {
      observed.error = error.message;
    }
    if (JSON.stringify(observed) !== JSON.stringify({ ranges: expected.ranges, text: sampled }))
      failed.push(name);
  }
  if (process.env.PAGES_ADDRESSES_REPORT) console.log(failed.length, JSON.stringify(failed));
  assert.deepEqual(failed, []);
});

test("a block holding a node this build can't place gives no ids", () => {
  for (const shape of ["dataframe-in-cell", "unknown-in-cell", "unknown-embed-in-code"]) {
    const { spans } = inputs.find((input) => input.name === `shape/${shape}`);
    const { doc, id } = pageWithSpans(spans);
    assert.equal(blockAddresses(A.spans(doc, textPath(id))).placed, false, shape);
    assert.throws(() => nodeIds(doc, id), shape);
  }
  for (const shape of ["unknown-embed-in-cell", "unknown-block", "unknown-parent", "aside"]) {
    const { spans } = inputs.find((input) => input.name === `shape/${shape}`);
    const { doc, id } = pageWithSpans(spans);
    assert.equal(blockAddresses(A.spans(doc, textPath(id))).placed, true, shape);
  }
});

test("text stored after an unknown block is that node's content", () => {
  const { spans } = inputs.find((input) => input.name === "shape/unknown-block-then-text");
  const { doc, id } = pageWithSpans(spans);
  const addresses = blockAddresses(A.spans(doc, textPath(id)));
  const text = doc.blocks[id].richText;
  assert.deepEqual(
    addresses.nodes.map(({ start, end, at }) => ({ start, end, at })),
    [
      { start: 0, end: 2, at: 0 },
      { start: 2, end: 15, at: 2 },
      { start: 15, end: 17, at: 15 },
      { start: 17, end: 19, at: 17 },
    ],
  );
  const inside = text.indexOf("callout");
  assert.equal(nodeIndexAt(addresses, inside), 1);
  assert.equal(ancestryAt(addresses, inside)[0].type, "PagesUnknownBlock");
  assert.deepEqual(ancestryAt(addresses, 1), [{ type: "Paragraph", attrs: {} }]);
});

// Shapes with unmarked text, and whether it is a top-level paragraph
// (which has no node id until a writer marks it).
const UNMARKED = {
  empty: true,
  "unmarked-first": true,
  "unmarked-after-rule": true,
  "unmarked-in-quote": false,
  "unmarked-in-list-item": false,
  "unmarked-in-table": false,
  "image-after-code": true,
  "unknown-embed-after-code": true,
  "image-after-rule": true,
  "image-after-dataframe": true,
  "image-after-quoted-code": false,
  "image-in-code": true,
};

test("every written node has an id, the first paragraph's included", () => {
  for (const { name, spans } of inputs) {
    if (Object.keys(UNMARKED).some((shape) => name === `shape/${shape}`)) continue;
    const result = observe(spans);
    if (!result.observed || result.observed.placed === false) continue;
    assert.ok(
      result.observed.ids.every((at) => Number.isInteger(at)),
      `${name}: ${JSON.stringify(result.observed.ids)}`,
    );
  }
});

test("every reader reads unmarked text, and marking it gives every node an id", () => {
  for (const [shape, topLevel] of Object.entries(UNMARKED)) {
    const { spans } = inputs.find((input) => input.name === `shape/${shape}`);
    const { doc, id } = pageWithSpans(spans);
    const tree = nativeRead(doc.blocks[id], doc.page_id);
    const ids = nodeIds(doc, id, tree);
    assert.equal(blockAddresses(A.spans(doc, textPath(id))).nodes.length, ids.length, shape);
    // A top-level paragraph of unmarked text has no id; unmarked text inside
    // a container is inside a node that has one.
    assert.equal(ids.filter((entry) => entry.id === null).length, topLevel ? 1 : 0, shape);
    const marked = A.change(A.clone(doc), (draft) => assert.ok(repairBlockMarkers(draft, id)));
    assert.equal(decode(A.spans(marked, textPath(id))).unmarked.length, 0, shape);
    assert.ok(
      nodeIds(marked, id).every((entry) => typeof entry.id === "string"),
      shape,
    );
    // Marking adds markers only: the Markdown reads the same.
    assert.equal(blockMarkdown(marked.blocks[id]), blockMarkdown(doc.blocks[id]), shape);
    // A second pass writes nothing.
    A.change(A.clone(marked), (draft) => assert.equal(repairBlockMarkers(draft, id), false));
  }
});

test("an inline node continues the node before it when that node can hold it, and opens unmarked text when it can't", () => {
  // A code block holds text and line breaks; every other textblock holds
  // every inline node; a leaf holds nothing.
  for (const [shape, tree] of [
    ["image-after-code", `Doc(CodeBlock("x"),Paragraph(PagesImage,"y"),Paragraph("z"))`],
    ["image-in-code", `Doc(CodeBlock("x"),Paragraph(PagesImage,"y"),Paragraph("z"))`],
    ["unknown-embed-after-code", `Doc(CodeBlock("x"),Paragraph(PagesUnknownEmbed,"y"))`],
    ["break-after-code", `Doc(CodeBlock("x",LineBreak,"y"))`],
    ["image-after-heading", `Doc(Heading("x",PagesImage,"y"))`],
    ["image-after-rule", `Doc(Paragraph("x"),HorizontalRule,Paragraph(PagesImage,"y"))`],
    ["image-after-dataframe", `Doc(Paragraph("x"),PagesDataframe,Paragraph(PagesImage,"y"))`],
    ["image-in-cell-after-merge", `Doc(Table(TableRow(Cell("c",PagesImage,"d"))))`],
    ["image-after-quoted-code", `Doc(Blockquote(CodeBlock("x"),Paragraph(PagesImage)))`],
  ]) {
    const { spans } = inputs.find((input) => input.name === `shape/${shape}`);
    const { doc, id } = pageWithSpans(spans);
    const decoded = decode(A.spans(doc, textPath(id)));
    assert.equal(decoded.lossy, false, shape);
    assert.equal(String(decoded.doc), tree, shape);
    const native = nativeRead(doc.blocks[id], PAGE_ID).nodes;
    assert.equal(
      `Doc(${native.map(String).join(",")})`,
      tree.replace(`"x",LineBreak,"y"`, `"x\\ny"`),
      shape,
    );
    const markdown = blockMarkdown(doc.blocks[id], PAGE_ID);
    // A tool write to the block reads it, marks it and edits it.
    const match = shape === "image-in-cell-after-merge" ? "c" : "x";
    const written = A.change(A.clone(doc), (draft) =>
      applyPageOperation(draft, {
        operation: "edit_page",
        arguments: {
          operations: [
            {
              op: "replace_match",
              node_id: blockAddress(doc, id),
              match_text: match,
              replacement: "w",
            },
          ],
        },
      }),
    );
    assert.deepEqual(decode(A.spans(written, textPath(id))).unmarked, [], shape);
    assert.equal(blockMarkdown(written.blocks[id], PAGE_ID), markdown.replace(match, "w"), shape);
  }
});

test("ancestry names each container and its stored attrs", () => {
  const { spans } = inputs.find((input) => input.name === "shape/nested-lists");
  const { doc, id } = pageWithSpans(spans);
  const addresses = blockAddresses(A.spans(doc, textPath(id)));
  const text = doc.blocks[id].richText;
  assert.deepEqual(ancestryAt(addresses, text.indexOf("task")), [
    { type: "OrderedList", attrs: {} },
    { type: "ListItem", attrs: {} },
    { type: "BulletList", attrs: {} },
    { type: "ListItem", attrs: {} },
    { type: "PagesTaskList", attrs: {} },
    { type: "ListItem", attrs: { checked: true } },
    { type: "Paragraph", attrs: {} },
  ]);
  // The first and a later character of a text run share one ancestry.
  const at = text.indexOf("inner");
  assert.deepEqual(ancestryAt(addresses, at), ancestryAt(addresses, at + 3));
});
