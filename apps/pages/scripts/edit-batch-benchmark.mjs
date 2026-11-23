// One edit_page batch through applyPageOperation (model/page.mjs), in Node:
// the host's model work only, with no Durable Object, storage, sync or
// receipt. A target-scoped case runs guardPassageEdits
// (model/passage-edits.mjs) first, as the host does for conflict_scope
// target. Records timings on this machine, which is faster than the Workers
// host; compare cases and revisions, not absolute times. Gates on nothing.
//
//   node scripts/edit-batch-benchmark.mjs
// Options (environment):
//   PAGES_EDIT_SAMPLES  timed samples per case (default 5)
//   PAGES_EDIT_WARMUP   untimed samples first (default 1)
//   PAGES_EDIT_CASES    comma-separated case names to run (default all)
//   PAGES_EDIT_SECTIONS sections in the Markdown (default 85, about 112 KB)
//
// Fixtures hold the same generated Markdown: sections of a heading, marked
// prose, lists, a task list, a quote, a code block and a table, each
// section's words tagged with its number so every match is unique.
//   one block   the whole text in one block
//   N blocks    one section per block
//   two blocks  half the sections in each of two blocks, for moves between
//               two large blocks only
// Cases, each one batch, spread over the sections:
//   20 format_match, 20 replace_match, 10 insert_markdown after a node,
//   2 move_nodes, 2 move_nodes between two blocks, and 20 replace_match with
//   conflict_scope target against the revision before a peer's edit at the
//   end of the first block.
// Writes test-results/edit-batch-benchmark.json (every sample) and prints
// median [min, max] milliseconds, or the refusal a batch met.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, orderedBlockIds } from "../model/page.mjs";
import { setRichMarkdown } from "../model/richtext-page.mjs";
import { nodeAddresses } from "../model/addresses.mjs";
import { nativeRead, readKind } from "../model/native-read.mjs";
import { guardPassageEdits } from "../model/passage-edits.mjs";
import { textPath } from "../model/richtext-format.mjs";

const pages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = Number(process.env.PAGES_EDIT_SAMPLES || 5);
const WARMUP = Number(process.env.PAGES_EDIT_WARMUP || 1);
const ONLY = process.env.PAGES_EDIT_CASES?.split(",").map((name) => name.trim());
assert.ok(Number.isInteger(SAMPLES) && SAMPLES >= 1, "PAGES_EDIT_SAMPLES must be at least 1");
const PAGE = "77777777-7777-4777-8777-777777777777";
const SECTIONS = Number(process.env.PAGES_EDIT_SECTIONS || 85);
assert.ok(Number.isInteger(SECTIONS) && SECTIONS >= 85, "PAGES_EDIT_SECTIONS must be at least 85");

const tag = (i) => `s${String(i).padStart(3, "0")}q`;
function section(i) {
  const t = tag(i);
  return [
    `## Section ${t}`,
    `Paragraph ${t} opens with **bold words ${t}** and _quiet emphasis_, then \`inline code\`, a [link](https://example.com/${t}) and alpha ${t} in plain prose. It runs on for a while so the block has the weight of real writing: a decision, the reason for it, and what the next reader should check before changing it again. beta ${t} closes the sentence.`,
    `A second paragraph for ${t} says what changed and why, with ~~struck text~~ and one more **strong run** before it ends with gamma ${t}.`,
    `A third paragraph for ${t} carries the long middle of the section. It names the measurement that settled the question, the alternative that lost and why it lost, and the follow-up that someone still owes. A reader skims it, so it keeps to plain sentences, with _one emphasised aside_ and a **bold warning** about the part that is easy to get wrong. It ends with epsilon ${t}.`,
    `- First point ${t} with *emphasis*\n- Second point ${t}\n  - A nested point ${t}\n- Third point ${t} with \`code\``,
    `1. Step one ${t}\n2. Step two ${t}\n3. Step three ${t}`,
    `- [ ] Open task ${t}\n- [x] Done task ${t}`,
    `> A quoted remark ${t} that someone left while reviewing the plan.`,
    "```js\nconst value" + i + ' = compute("' + t + '");\nconsole.log(value' + i + ");\n```",
    `| Name | Value |\n| --- | --- |\n| key ${t} | ${i} |\n| other ${t} | ${i * 2} |`,
  ].join("\n\n");
}
const sections = Array.from({ length: SECTIONS }, (_, i) => section(i));

function pageOf(parts) {
  return A.change(
    A.from(createPageData({ pageId: PAGE, title: "Benchmark" }), { actor: "01".repeat(16) }),
    (draft) => {
      parts.forEach((markdown, i) => {
        const key = `b${String(i).padStart(3, "0")}`;
        draft.blocks[key] = { position: `a${String(i).padStart(3, "0")}`, richText: "" };
        setRichMarkdown(draft, key, markdown);
      });
    },
  );
}
const half = Math.ceil(SECTIONS / 2);
const fixtures = {
  "one block": pageOf([sections.join("\n\n")]),
  [`${SECTIONS} blocks`]: pageOf(sections),
  "two blocks": pageOf([sections.slice(0, half).join("\n\n"), sections.slice(half).join("\n\n")]),
};
/** The block holding section `i` in `doc`, and the index of its first node
 * there. */
function sectionAt(doc, i) {
  const keys = orderedBlockIds(doc);
  const per = Math.ceil(SECTIONS / keys.length);
  return { key: keys[Math.floor(i / per)], first: (i % per) * 10 };
}

/** Section `i`'s top-level node ids by kind, in the fixture `doc`: its
 * second paragraph, its code block and its table. */
function sectionNodes(doc, i) {
  const { key, first } = sectionAt(doc, i);
  const ids = nodeAddresses(doc, key);
  const nodes = nativeRead(doc.blocks[key], PAGE).nodes;
  // The section's nodes, in order, from `first`: heading, three paragraphs,
  // three lists, a quote, a code block and a table.
  const kinds = nodes.slice(first, first + 10).map(readKind);
  assert.deepEqual(
    kinds.slice(0, 4),
    ["heading", "paragraph", "paragraph", "paragraph"],
    `section ${i}`,
  );
  return {
    paragraph: ids[first + 2],
    quote: ids[first + 7],
    code: ids[first + 8],
    table: ids[first + 9],
  };
}
const spread = (count) =>
  Array.from({ length: count }, (_, k) => Math.floor((k * SECTIONS) / count));
const cases = {
  "20 format_match": () =>
    spread(20).map((i) => ({
      op: "format_match",
      match_text: `alpha ${tag(i)}`,
      add: { strong: true },
    })),
  "20 replace_match": () =>
    spread(20).map((i) => ({
      op: "replace_match",
      match_text: `beta ${tag(i)}`,
      replacement: `delta ${tag(i)}`,
    })),
  "10 insert_markdown after a node": (doc) =>
    spread(10).map((i) => ({
      op: "insert_markdown",
      after_node_id: sectionNodes(doc, i).paragraph,
      markdown: `An inserted paragraph after section ${tag(i)}.`,
    })),
  // From each block to the other: each move counts both blocks.
  "2 move_nodes between blocks": (doc) => {
    const from = [sectionNodes(doc, 10), sectionNodes(doc, SECTIONS - 10)];
    const to = [sectionNodes(doc, SECTIONS - 20), sectionNodes(doc, 20)];
    return from.map((nodes, k) => ({
      op: "move_nodes",
      node_id: nodes.quote,
      through_node_id: nodes.table,
      after_node_id: to[k].paragraph,
    }));
  },
  "20 replace_match target scope": () =>
    spread(20).map((i) => ({
      op: "replace_match",
      match_text: `alpha ${tag(i)}`,
      replacement: `omega ${tag(i)}`,
    })),
  "2 move_nodes": (doc) => {
    const from = [sectionNodes(doc, 10), sectionNodes(doc, 60)];
    const to = [sectionNodes(doc, 40), sectionNodes(doc, 20)];
    return from.map((nodes, k) => ({
      op: "move_nodes",
      node_id: nodes.quote,
      through_node_id: nodes.table,
      after_node_id: to[k].paragraph,
    }));
  },
};
// A passage operation names the block its match is in.
function addressed(doc, operations) {
  return operations.map((op) => {
    if (op.op !== "format_match" && op.op !== "replace_match") return op;
    const i = Number(/s(\d{3})q/.exec(op.match_text)[1]);
    return { ...op, node_id: A.getObjectId(doc.blocks[sectionAt(doc, i).key]) };
  });
}

const TARGET_SCOPE = new Set(["20 replace_match target scope"]);
// The cases the two-block fixture is for; the other fixtures skip them.
const TWO_BLOCKS = new Set(["2 move_nodes between blocks"]);
// The current document a target-scoped batch meets: its base revision plus
// a peer's sentence at the end of the first block, which the guard rebases
// over.
function withPeerEdit(base) {
  const key = orderedBlockIds(base)[0];
  return A.change(A.clone(base, { actor: "02".repeat(16) }), (draft) =>
    A.splice(draft, textPath(key), draft.blocks[key].richText.length, 0, " A peer's edit."),
  );
}

function run(base, operations, target) {
  const doc = target ? withPeerEdit(base) : A.clone(base);
  let result, error;
  const start = performance.now();
  try {
    const guarded = target && guardPassageEdits(doc, A.getHeads(base), operations);
    A.change(doc, (draft) => {
      result = applyPageOperation(draft, {
        operation: "edit_page",
        arguments: { operations: guarded ? guarded.operations : operations },
      });
    });
  } catch (caught) {
    error = caught;
  }
  const ms = performance.now() - start;
  A.free(doc);
  return { ms, result, error };
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};
const report = {
  node: process.version,
  samples: SAMPLES,
  warmup: WARMUP,
  fixtures: {},
  results: [],
};
for (const [name, doc] of Object.entries(fixtures)) {
  const keys = orderedBlockIds(doc);
  report.fixtures[name] = {
    blocks: keys.length,
    markdownBytes: Buffer.byteLength(sections.join("\n\n")),
    largestBlockUnits: Math.max(...keys.map((key) => doc.blocks[key].richText.length)),
  };
}
console.log(JSON.stringify(report.fixtures));
for (const [caseName, build] of Object.entries(cases)) {
  if (ONLY && !ONLY.includes(caseName)) continue;
  for (const [fixture, doc] of Object.entries(fixtures)) {
    if (TWO_BLOCKS.has(caseName) !== (fixture === "two blocks")) continue;
    const operations = addressed(doc, build(doc));
    const target = TARGET_SCOPE.has(caseName);
    for (let i = 0; i < WARMUP; i++) run(doc, operations, target);
    const samples = [];
    let refusal;
    for (let i = 0; i < SAMPLES; i++) {
      const { ms, error } = run(doc, operations, target);
      samples.push(ms);
      if (error)
        refusal = {
          reason: error.editReason ?? error.code ?? error.details?.conflicts?.[0]?.reason,
          edit_index: error.editAt?.index,
          message: error.message,
        };
    }
    const row = {
      case: caseName,
      fixture,
      median: quantile(samples, 0.5),
      min: Math.min(...samples),
      max: Math.max(...samples),
      samples,
      ...(refusal && { refusal }),
    };
    report.results.push(row);
    const fmt = (ms) => ms.toFixed(1);
    console.log(
      `${caseName.padEnd(34)} ${fixture.padEnd(10)} ${fmt(row.median).padStart(8)} ms [${fmt(row.min)}, ${fmt(row.max)}]${refusal ? `  refused: ${refusal.reason} at ${refusal.edit_index}` : ""}`,
    );
  }
}
const output = path.join(pages, "test-results");
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "edit-batch-benchmark.json"), JSON.stringify(report, null, 2));
