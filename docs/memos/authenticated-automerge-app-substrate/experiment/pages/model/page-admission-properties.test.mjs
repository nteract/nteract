// Page-body admission must never admit a frame that leaves a block readers
// can't read. Random readable Pages take random raw native frames, honest
// and adversarial alike: text typed anywhere (straight after a rule or
// dataframe too), deletes across markers, splits with any marker, joins,
// marker rewrites and marks with any name and value. Frames are built on
// the host's heads or on an older base the host has moved past, and two
// frames on one shared base arrive in both orders. Whenever admission
// accepts a frame on a block readers read, the block it leaves must still
// read (spansRead).
// Replay a failure with --test-name-pattern plus PAGES_FUZZ_SEED and
// PAGES_FUZZ_PATH.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as A from "@automerge/automerge";
import { createPageData, orderedBlockIds } from "./page.mjs";
import { admitPageChanges } from "./page-admission.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { RICH_FORMAT, textPath } from "./richtext.mjs";
import { spansRead } from "./richtext-spans.mjs";
import { encode } from "./wordgard-doc.mjs";
import { PAGE_ID, pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";
import { fuzzDepth, fuzzParameters as parameters } from "../test/fuzz-parameters.mjs";
import { freeing } from "../test/free-docs.mjs";

const imm = (value) => new A.ImmutableString(value);
const MARKERS = [
  { type: "paragraph", parents: [] },
  { type: "heading", parents: [], attrs: { level: 2 } },
  { type: "horizontal-rule", parents: [] },
  { type: "code-block", parents: [] },
  { type: "table-row", parents: ["table"] },
  { type: "table-cell", parents: ["table", "table-row"] },
  { type: "list-item", parents: ["bullet-list"] },
  { type: "paragraph", parents: ["blockquote"] },
  { type: "paragraph", parents: ["code-block"] },
  { type: "hard-break", parents: ["paragraph"], isEmbed: true },
  {
    type: "image",
    parents: ["paragraph"],
    attrs: { src: "https://example.org/i.png" },
    isEmbed: true,
  },
  {
    type: "image",
    parents: ["code-block"],
    attrs: { src: "https://example.org/i.png" },
    isEmbed: true,
  },
  {
    type: "dataframe",
    parents: [],
    attrs: {
      src: `/api/pages/${PAGE_ID}/assets/${"b".repeat(64)}`,
      media_type: "application/vnd.apache.parquet",
    },
  },
];
const markerValue = ({ type, parents, attrs = {}, isEmbed = false }) => ({
  type: imm(type),
  parents: parents.map(imm),
  attrs: Object.fromEntries(
    Object.entries(attrs).map(([k, v]) => [k, typeof v === "string" ? imm(v) : v]),
  ),
  isEmbed,
});
const MARKS = [
  ["strong", true],
  ["em", true],
  ["code", true],
  ["highlight", "green"],
  ["link", JSON.stringify({ href: "https://example.org", title: null })],
  ["strong", null],
];
const TEXT = ["x", "ab", " ", "\n", "😀"];

const operation = fc.record({
  kind: fc.constantFrom(
    "type",
    "type",
    "type-after-marker",
    "delete",
    "delete-marker",
    "split",
    "join",
    "update",
    "mark",
  ),
  a: fc.nat(),
  n: fc.nat(),
  span: fc.nat({ max: 6 }),
});

/** Native indexes of the block's markers. */
function markerIndexes(doc, path) {
  const out = [];
  let at = 0;
  for (const span of A.spans(doc, path)) {
    if (span.type === "block") out.push(at);
    at += span.type === "text" ? span.value.length : 1;
  }
  return out;
}

function apply(d, path, op) {
  const length = d.blocks[path[1]].richText.length;
  const markers = markerIndexes(d, path);
  const pick = (list) => list[op.a % list.length];
  const at = op.a % (length + 1);
  switch (op.kind) {
    case "type":
      A.splice(d, path, at, 0, TEXT[op.n % TEXT.length]);
      break;
    case "type-after-marker":
      if (markers.length) A.splice(d, path, pick(markers) + 1, 0, "stray");
      break;
    case "delete": {
      const count = Math.min(1 + op.span, length - at);
      if (count > 0) A.splice(d, path, at, count);
      break;
    }
    case "delete-marker":
      if (markers.length) A.splice(d, path, pick(markers), 1);
      break;
    case "split":
      A.splitBlock(d, path, at, markerValue(MARKERS[op.n % MARKERS.length]));
      break;
    case "join":
      if (markers.length) A.joinBlock(d, path, pick(markers));
      break;
    case "update":
      if (markers.length)
        A.updateBlock(d, path, pick(markers), markerValue(MARKERS[op.n % MARKERS.length]));
      break;
    case "mark": {
      const end = Math.min(length, at + 1 + op.span);
      if (end <= at) break;
      const [name, value] = MARKS[op.n % MARKS.length];
      if (value === null) A.unmark(d, path, { start: at, end, expand: "both" }, name);
      else A.mark(d, path, { start: at, end, expand: "after" }, name, value);
      break;
    }
  }
}

const readable = (doc, path) => spansRead(A.spans(doc, path), PAGE_ID);

/** A Page whose one block holds `description`'s tree. */
function pageOf(description) {
  let doc = A.from(createPageData({ pageId: PAGE_ID, title: "Property" }));
  const id = orderedBlockIds(doc)[0];
  const path = textPath(id);
  doc = A.change(doc, (d) => {
    d.blocks[id].format = RICH_FORMAT;
    d.blocks[id].richText = "";
    A.updateSpans(d, path, encode(toWordgardTree(description)), updateSpansConfig);
  });
  return { doc, path };
}

/** `frame`'s ops as one change on `base`, or null when Automerge refuses
 * one (a join at index 0). */
function build(base, path, frame, actor) {
  try {
    return A.change(A.clone(base, { actor }), (d) => {
      for (const op of frame) apply(d, path, op);
    });
  } catch {
    return null;
  }
}

/** Admit `change` (built on some base `live` contains) against `live`, as
 * SyncHost does; asserts the invariant and returns the next live document. */
function admitInto(live, change, path, label, totals) {
  const preview = A.merge(A.clone(live), change);
  const result = admitPageChanges(live, preview);
  if (!result.ok) {
    totals.refused++;
    A.free(preview);
    return live;
  }
  totals.admitted++;
  totals.reads += result.stats.fullReads;
  if (readable(live, path))
    assert.ok(readable(preview, path), `${label} left the block unreadable`);
  return preview;
}

const frames = fc.array(fc.array(operation, { minLength: 1, maxLength: 3 }), {
  minLength: 1,
  maxLength: 6,
});

test("an admitted frame never leaves a readable block unreadable, on current or stale bases", () => {
  const totals = { admitted: 0, refused: 0, reads: 0 };
  fc.assert(
    fc.property(
      pageTreeArbitrary({ maxDepth: fuzzDepth }),
      frames,
      fc.array(fc.nat()),
      (description, list, stale) =>
        freeing((keep) => {
          const { doc: first, path } = pageOf(description);
          let live = keep(first);
          const history = [first];
          list.forEach((frame, step) => {
            // Build on live's heads, or on an earlier admitted state.
            const base = stale[step] === undefined ? live : history[stale[step] % history.length];
            const change = build(base, path, frame, (step + 16).toString(16).padStart(32, "0"));
            if (!change) return;
            keep(change);
            const next = admitInto(
              live,
              change,
              path,
              `step ${step} ${JSON.stringify(frame)}`,
              totals,
            );
            if (next !== live) history.push((live = keep(next)));
          });
        }),
    ),
    parameters,
  );
  assert.ok(totals.admitted > 0 && totals.refused > 0, JSON.stringify(totals));
});

test("two frames on one shared base leave a readable block in either arrival order", () => {
  const totals = { admitted: 0, refused: 0, reads: 0 };
  fc.assert(
    fc.property(
      pageTreeArbitrary({ maxDepth: fuzzDepth }),
      fc.array(operation, { minLength: 1, maxLength: 3 }),
      fc.array(operation, { minLength: 1, maxLength: 3 }),
      (description, one, two) =>
        freeing((keep) => {
          const { doc: base, path } = pageOf(description);
          keep(base);
          const a = build(base, path, one, "aa".repeat(16));
          const b = build(base, path, two, "bb".repeat(16));
          if (!a || !b) return;
          keep(a);
          keep(b);
          for (const [label, order] of [
            ["a then b", [a, b]],
            ["b then a", [b, a]],
          ]) {
            let live = base;
            for (const change of order) live = keep(admitInto(live, change, path, label, totals));
          }
        }),
    ),
    parameters,
  );
  assert.ok(totals.admitted > 0, JSON.stringify(totals));
});
