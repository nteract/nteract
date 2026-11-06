// The Wordgard passage addresses against the ProseMirror traversal they
// replaced, imported directly (test files are exempt from pm-boundary). The
// traversal counted a leaf's open and close tags, so after a rule or a
// dataframe its positions were wrong, and a block holding nothing but an
// image got an empty range. It also applied the readable tree's sizes
// to the stored spans, which differ for a dataframe naming another Page's
// asset (read as a notice paragraph). A block holding a node it couldn't
// place made it throw. Everywhere else the two must agree exactly.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { amSpliceIdxToPmIdx, pmRangeToAmRange } from "@automerge/prosemirror/dist/traversal.js";
import { adapter } from "./pm-adapter.mjs";
import { blockAddresses, nodeIndexAt } from "./node-addresses.mjs";
import { textPath } from "./richtext-format.mjs";
import { richDoc } from "./richtext-spans.mjs";
import { allInputs, pageWithSpans, randomInputs } from "../test/address-inputs.mjs";

const inputs = [...allInputs(), ...randomInputs({ seed: 7, count: 30, maxDepth: 3 })];

/** The node ranges and sampled per-text-run node_index each path reports. */
function addresses(doc, id, path) {
  const spans = A.spans(doc, textPath(id));
  const tree = richDoc(doc.blocks[id], doc.page_id);
  const runs = [];
  let at = 0;
  for (const span of spans) {
    if (span.type === "text") runs.push(at);
    at += span.type === "text" ? span.value.length : 1;
  }
  const step = Math.ceil(runs.length / 8) || 1;
  const sampled = runs.filter((_at, run) => run % step === 0);
  if (path === "wordgard") {
    const result = blockAddresses(spans);
    return {
      ranges: result.nodes.map(({ start, end }) => [start, end]),
      text: sampled.map((am) => nodeIndexAt(result, am)),
    };
  }
  const ranges = [];
  let from = 0;
  for (let index = 0; index < tree.childCount; index++) {
    const to = from + tree.child(index).nodeSize;
    const { start, end } = pmRangeToAmRange(adapter, spans, { from, to });
    ranges.push([start, end]);
    from = to;
  }
  return {
    ranges,
    text: sampled.map((am) => tree.resolve(amSpliceIdxToPmIdx(adapter, spans, am)).index(0)),
  };
}

/** Why the ProseMirror traversal can be wrong for this block, or null. */
function knownShape(spans) {
  const types = spans
    .filter((span) => span.type === "block")
    .map((span) => String(span.value.type));
  if (types.includes("horizontal-rule")) return "rule";
  if (types.includes("dataframe")) return "dataframe";
  if (spans.length && spans.every((span) => span.type === "block" && span.value.isEmbed))
    return "only inline nodes";
  return null;
}

test("passage addresses match the ProseMirror traversal except where it miscounted", () => {
  const differing = {};
  let compared = 0;
  let plain = 0;
  for (const { name, spans } of inputs) {
    const { doc, id } = pageWithSpans(spans);
    try {
      richDoc(doc.blocks[id], doc.page_id);
    } catch {
      continue; // Neither path reads it.
    }
    const stored = A.spans(doc, textPath(id));
    if (!blockAddresses(stored).placed) continue; // The traversal threw.
    compared++;
    if (!knownShape(stored)) plain++;
    let old;
    try {
      old = addresses(doc, id, "prosemirror");
    } catch (error) {
      old = { error: error.message };
    }
    const now = addresses(doc, id, "wordgard");
    if (JSON.stringify(old) === JSON.stringify(now)) continue;
    const shape = knownShape(stored) ?? "unexplained";
    (differing[shape] ??= []).push(name);
  }
  const counts = Object.fromEntries(
    Object.entries(differing).map(([shape, names]) => [shape, names.length]),
  );
  if (process.env.PAGES_PARITY_REPORT)
    console.log(compared, plain, JSON.stringify(counts), JSON.stringify(differing));
  assert.deepEqual(differing.unexplained ?? [], []);
  // Enough inputs without a rule, a dataframe or an image-only block for
  // the agreement to mean something.
  assert.ok(plain >= 200, `only ${plain} plain inputs`);
});
