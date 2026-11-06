// Node addressing against frozen expectations. model/node-addresses.golden.json
// holds, for every input in test/address-inputs.mjs (hand-written stored
// shapes, the Markdown corpus written as rich text, seeded random editor
// trees), the node ids, outline node_index and types the ProseMirror traversal
// produced before node ids moved to the Wordgard tree, and the node ranges and
// per-text node_index node-addresses.mjs computes.
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
import { visibleNodeRange, visibleRangeAddress } from "./replace-match.mjs";
import { textPath } from "./richtext-format.mjs";
import { richDoc } from "./richtext-spans.mjs";
import { allInputs, pageWithSpans, spansToJSON } from "../test/address-inputs.mjs";

const GOLDEN = new URL("./node-addresses.golden.json", import.meta.url);
const update = process.env.PAGES_UPDATE_ADDRESSES === "1";
const inputs = allInputs();
const hash = (spans) =>
  createHash("sha256")
    .update(JSON.stringify(spansToJSON(spans)))
    .digest("hex")
    .slice(0, 16);

/** Each text span's first character's node_index, in span order. */
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
    tree = richDoc(doc.blocks[id], doc.page_id);
  } catch {
    return { readable: false };
  }
  let outline = null;
  try {
    outline = projectReadContent(doc, { include_content: false }).outline;
  } catch {
    // read_page refuses a block its Markdown projection can't hold (an aside).
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

test("node ids, outline node_index and ranges match the frozen expectations", () => {
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
    // The outline's node_index counts top-level nodes, and its node_id is the
    // cursor at the frozen marker.
    assert.deepEqual(
      outline.map((entry) => entry.node_index),
      frozen.ids.map((_at, index) => index),
      name,
    );
    assert.deepEqual(
      outline.map((entry) => entry.node_id),
      frozen.ids.map((at) => (at === null ? null : A.getCursor(doc, textPath(id), at))),
      name,
    );
  }
});

test("replace_match scopes node_index and addresses passages by the frozen ranges", () => {
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
      for (let index = 0; index < expected.ranges.length; index++) {
        const { start, end } = visibleNodeRange(doc, id, index);
        observed.ranges.push([start, end]);
      }
      let at = 0;
      let run = 0;
      for (const span of A.spans(doc, path)) {
        if (span.type === "text" && run++ % step === 0) {
          const end = at + (/[\ud800-\udbff]/.test(text[at]) ? 2 : 1);
          observed.text.push(visibleRangeAddress(doc, id, at, end).node_index);
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
      { start: 0, end: 1, at: null },
      { start: 1, end: 14, at: 1 },
      { start: 14, end: 16, at: 14 },
      { start: 16, end: 18, at: 16 },
    ],
  );
  const inside = text.indexOf("callout");
  assert.equal(nodeIndexAt(addresses, inside), 1);
  assert.equal(ancestryAt(addresses, inside)[0].type, "PagesUnknownBlock");
  assert.deepEqual(ancestryAt(addresses, 0), [{ type: "Paragraph", attrs: {} }]);
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
