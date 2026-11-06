// Page-body admission for one browser change, in Node: the host's patch
// path (admitPageChanges in model/page-admission.mjs) against validating the
// touched block whole (validateRichSpans over its spans, as registration
// does). Covers the admission check only, after SyncHost has built the
// preview; not the clone, sync or storage. Records timings; gates on nothing.
//
//   node scripts/admission-benchmark.mjs
// Options (environment):
//   PAGES_ADMISSION_SAMPLES  timed samples per case (default 41, minimum 15)
//   PAGES_ADMISSION_WARMUP   untimed samples first (default 5)
//
// Fixtures, each a Page whose one rich-text block is built like
// scripts/binding-benchmark.mjs's:
//   marked 115 KB  docs/adr/automerge-document-storage.md, seven times
//   plain 118 KB   one paragraph of repeated prose
// Cases: type one character at native index 4; delete one and twelve
// characters there (each deleted index is probed for a marker); bold four
// characters; split the opening node with a paragraph marker (a block
// marker, which reads the block whole); type one character from a peer that
// hadn't seen another peer's character; and the costliest frame a client
// can send cheaply, a stale frame of 1,000 scattered one-character deletes
// (past the probe budget, so its block is read once), admitted and refused
// for its title.
// Writes test-results/admission-benchmark.json (every sample) and prints
// median [p10, p90] milliseconds.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { admitPageChanges } from "../model/page-admission.mjs";
import { validateRichSpans } from "../model/richtext-spans.mjs";

const pages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: pages })
  .toString()
  .trim();
const SAMPLES = Number(process.env.PAGES_ADMISSION_SAMPLES || 41);
const WARMUP = Number(process.env.PAGES_ADMISSION_WARMUP || 5);
assert.ok(
  Number.isInteger(SAMPLES) && SAMPLES >= 15,
  "PAGES_ADMISSION_SAMPLES must be at least 15",
);
const output = path.join(pages, "test-results");
mkdirSync(output, { recursive: true });

const adr = readFileSync(path.join(repo, "docs/adr/automerge-document-storage.md"), "utf8");
const fixtures = {
  "marked 115 KB": Array(7).fill(adr).join("\n\n"),
  "plain 118 KB": "The quick brown fox crosses a quiet field. ".repeat(2740).trim(),
};
const pageId = "66666666-6666-4666-8666-666666666666";

/** Up to `count` non-marker indexes, spread across the block, last first. */
function textIndexes(d, at, count) {
  const text = String(d.blocks[at[1]].richText);
  const step = Math.max(1, Math.floor(text.length / (count + 1)));
  const out = [];
  for (let i = step; i < text.length && out.length < count; i += step)
    if (text[i] !== "\uFFFC") out.push(i);
  return out.reverse();
}
// A host that took another peer's character, and one whose title sits at
// the bound, so the frame's title growth is refused once merged.
const peerTyped = (d, at) => A.splice(d, at, 100, 0, "p");
const longTitle = (d) => A.updateText(d, ["title"], "t".repeat(1020));
/** Each case: the frame's edit, an optional host edit concurrent with it,
 * and whether admission should accept it. */
const cases = {
  "type one character": { edit: (d, at) => A.splice(d, at, 4, 0, "x") },
  "delete one character": { edit: (d, at) => A.splice(d, at, 4, 1) },
  "delete twelve characters": { edit: (d, at) => A.splice(d, at, 4, 12) },
  "bold four characters": {
    edit: (d, at) => A.mark(d, at, { start: 4, end: 8, expand: "after" }, "strong", true),
  },
  // Enter inside the opening heading: a new paragraph marker.
  "split a block": {
    edit: (d, at) => A.splitBlock(d, at, 6, { type: "paragraph", parents: [], attrs: {} }),
  },
  "type one character, concurrent": {
    edit: (d, at) => A.splice(d, at, 4, 0, "x"),
    host: peerTyped,
  },
  // The worst case a client can send cheaply: a stale frame of scattered
  // one-character deletes, refused for its title once merged.
  "1,000 scattered deletes, stale, refused": {
    edit: (d, at) => {
      for (const i of textIndexes(d, at, 1000)) A.splice(d, at, i, 1);
      A.splice(d, ["title"], 0, 0, "abcdefgh");
    },
    host: (d, at) => {
      peerTyped(d, at);
      longTitle(d);
    },
    ok: false,
  },
  "1,000 scattered deletes, stale": {
    edit: (d, at) => {
      for (const i of textIndexes(d, at, 1000)) A.splice(d, at, i, 1);
    },
    host: peerTyped,
  },
};
const checks = {
  "patch path": (live, preview, _at, expected = true) => {
    const result = admitPageChanges(live, preview);
    assert.equal(result.ok, expected, JSON.stringify(result.reason));
    return result.stats.fullReads;
  },
  "full validation": (_live, preview, at) => {
    validateRichSpans(A.spans(preview, at), Infinity);
    return 1;
  },
};

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};
const results = {
  node: process.version,
  samples: SAMPLES,
  warmup: WARMUP,
  fixtures: {},
  results: [],
};
for (const [fixture, source] of Object.entries(fixtures)) {
  // A saved and reloaded Page, as the host holds it.
  const built = A.change(A.from(createPageData({ pageId, title: "Benchmark" })), (d) =>
    initializePage(d, source),
  );
  const live = A.load(A.save(built));
  A.free(built);
  const at = ["blocks", orderedBlockIds(live)[0], "richText"];
  results.fixtures[fixture] = {
    markdownBytes: Buffer.byteLength(source),
    nativeLength: live.blocks[at[1]].richText.length,
    spanBytes: Buffer.byteLength(JSON.stringify(A.spans(live, at))),
  };
  for (const [name, { edit, host: hostEdit, ok = true }] of Object.entries(cases)) {
    // The preview as SyncHost builds it: a clone of the live document with
    // the browser's change loaded.
    const change = A.getLastLocalChange(A.change(A.clone(live), (d) => edit(d, at)));
    const host = hostEdit ? A.change(A.clone(live), (d) => hostEdit(d, at)) : live;
    for (const [label, check] of Object.entries(checks)) {
      const samples = [];
      let fullReads = 0;
      for (let i = -WARMUP; i < SAMPLES; i++) {
        const preview = A.loadIncremental(A.clone(host), change);
        const start = performance.now();
        fullReads = check(host, preview, at, ok);
        const ms = performance.now() - start;
        A.free(preview);
        if (i >= 0) samples.push(ms);
      }
      if (host !== live && label === Object.keys(checks).at(-1)) A.free(host);
      results.results.push({
        fixture,
        case: name,
        check: label,
        fullReads,
        median: quantile(samples, 0.5),
        p10: quantile(samples, 0.1),
        p90: quantile(samples, 0.9),
        samples,
      });
    }
  }
  A.free(live);
}
writeFileSync(
  path.join(output, "admission-benchmark.json"),
  `${JSON.stringify(results, null, 2)}\n`,
);

const fmt = (n) => n.toFixed(2);
console.log(`node ${process.version}, ${SAMPLES} samples after ${WARMUP} warmups`);
for (const [fixture, info] of Object.entries(results.fixtures))
  console.log(
    `${fixture}: ${info.markdownBytes} Markdown bytes, ${info.nativeLength} native characters, ${info.spanBytes} span JSON bytes`,
  );
console.log(`\n| Fixture | Case | ${Object.keys(checks).join(" | ")} |`);
console.log(
  `| --- | --- | ${Object.keys(checks)
    .map(() => "---:")
    .join(" | ")} |`,
);
for (const fixture of Object.keys(fixtures))
  for (const name of Object.keys(cases)) {
    const cells = Object.keys(checks).map((label) => {
      const r = results.results.find(
        (x) => x.fixture === fixture && x.case === name && x.check === label,
      );
      return `${fmt(r.median)} [${fmt(r.p10)}, ${fmt(r.p90)}]${r.fullReads ? ` (${r.fullReads} read)` : ""}`;
    });
    console.log(`| ${fixture} | ${name} | ${cells.join(" | ")} |`);
  }
