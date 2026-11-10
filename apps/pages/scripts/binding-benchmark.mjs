// One keystroke through the Wordgard binding, base build against this
// checkout, in Node: GardState, Command.dispatch and the real binding over a
// synchronous replica. Covers model and binding work only, not DOM rendering,
// IndexedDB, sync or saving. Records timings; gates on nothing.
//
//   node scripts/binding-benchmark.mjs
// Options (environment):
//   PAGES_BINDING_BASE     git revision for the base binding (default origin/main)
//   PAGES_BINDING_SAMPLES  timed samples per case (default 21, minimum 15)
//   PAGES_BINDING_WARMUP   untimed samples first (default 3)
//
// Fixtures, each one rich-text block:
//   marked 115 KB  docs/adr/automerge-document-storage.md, seven times
//   marked 16 KB   the same ADR once
//   plain 118 KB   one paragraph of repeated prose
// Cases: type one character at editor position 4; insert a hard line break
// there (a structural write); receive one remote character at native index 10
// and update the editor, as WordgardEditor does.
// Writes test-results/binding-benchmark.json (every sample) and prints
// median [p10, p90] milliseconds.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import * as A from "@automerge/automerge";
import { GardSelection, GardState, Transaction } from "wordgard/state";
import { Command, insertLineBreak, insertText } from "wordgard/command";
import { schema } from "../model/wordgard-doc.mjs";
import { setRichMarkdown } from "../model/richtext-page.mjs";
import { projectChanges } from "../viewer/wordgard-projection.mjs";

const pages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: pages })
  .toString()
  .trim();
const BASE = process.env.PAGES_BINDING_BASE || "origin/main";
const SAMPLES = Number(process.env.PAGES_BINDING_SAMPLES || 21);
const WARMUP = Number(process.env.PAGES_BINDING_WARMUP || 3);
assert.ok(Number.isInteger(SAMPLES) && SAMPLES >= 15, "PAGES_BINDING_SAMPLES must be at least 15");
const output = path.join(pages, "test-results");
mkdirSync(output, { recursive: true });

// The base binding, with its relative imports pointed at this checkout's
// modules. Only the binding differs between the two variants.
const bindingPath = path.relative(repo, path.join(pages, "viewer/wordgard-binding.mjs"));
const baseRevision = execFileSync("git", ["rev-parse", "--short", BASE], { cwd: repo })
  .toString()
  .trim();
const baseSource = execFileSync("git", ["show", `${BASE}:${bindingPath}`], { cwd: repo })
  .toString()
  .replaceAll(`from "./`, `from "${pathToFileURL(path.join(pages, "viewer"))}/`)
  .replaceAll(`from "../`, `from "${pathToFileURL(pages)}/`);
const baseFile = path.join(output, "wordgard-binding-base.mjs");
writeFileSync(baseFile, baseSource);
const variants = {
  [`base ${baseRevision}`]: {
    create: (await import(pathToFileURL(baseFile))).createWordgardBinding,
    // The base editor diffed every remote change against its own tree.
    reuseChanges: false,
  },
  current: {
    create: (await import("../viewer/wordgard-binding.mjs")).createWordgardBinding,
    reuseChanges: true,
  },
};

const adr = readFileSync(path.join(repo, "docs/adr/automerge-document-storage.md"), "utf8");
const fixtures = {
  "marked 115 KB": Array(7).fill(adr).join("\n\n"),
  "marked 16 KB": adr,
  "plain 118 KB": "The quick brown fox crosses a quiet field. ".repeat(2740).trim(),
};
const textPath = ["blocks", "b", "richText"];

function replicaOf(base) {
  let doc = A.clone(base, { actor: "aa".repeat(16) });
  const observers = new Set();
  const publish = (before, patches, remote) => {
    for (const fn of observers) fn({ before, after: doc, patches, remote });
  };
  return {
    get doc() {
      return doc;
    },
    observeChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
    change(fn) {
      const before = doc,
        patches = [];
      doc = A.change(doc, { patchCallback: (p) => patches.push(...p) }, fn);
      publish(before, patches, false);
    },
    // Merge outside the timer; `deliver` runs the observers.
    prepareReceive(other) {
      const before = doc;
      doc = A.merge(doc, other);
      const patches = A.diff(doc, A.getHeads(before), A.getHeads(doc));
      return () => publish(before, patches, true);
    },
    free() {
      A.free(doc);
    },
  };
}

function editorOf(replica, { create, reuseChanges }) {
  const binding = create(replica, "b");
  let state = GardState.create({
    doc: binding.current.doc,
    config: [GardState.schemaElement.of(schema.elements)],
  });
  state = state.update({ selection: GardSelection.Text.create({ anchor: 4 }) }).state;
  let writing = false;
  binding.observe((event) => {
    if (writing) return;
    state = state.update({
      changes:
        reuseChanges && state.doc === event.before.doc
          ? event.changes
          : projectChanges(state.doc, event.after.doc),
      annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    }).state;
  });
  return {
    binding,
    get state() {
      return state;
    },
    dispatch(spec) {
      const tr = state.update(spec);
      writing = true;
      try {
        binding.applyEditorTransaction(tr);
      } finally {
        writing = false;
      }
      state = tr.state;
    },
  };
}

const cases = {
  "type one character": (base, variant) => {
    const replica = replicaOf(base),
      editor = editorOf(replica, variant);
    const start = performance.now();
    Command.dispatch(editor, insertText, { from: 4, to: 4, insert: "x" });
    const ms = performance.now() - start;
    return { ms, replica, editor };
  },
  // A structural write: the binding re-encodes the block and reads it once.
  "hard line break": (base, variant) => {
    const replica = replicaOf(base),
      editor = editorOf(replica, variant);
    const start = performance.now();
    Command.dispatch(editor, insertLineBreak);
    const ms = performance.now() - start;
    return { ms, replica, editor };
  },
  "receive one remote character": (base, variant) => {
    const replica = replicaOf(base),
      editor = editorOf(replica, variant);
    const peer = A.change(A.clone(base, { actor: "bb".repeat(16) }), (d) =>
      A.splice(d, textPath, 10, 0, "y"),
    );
    const deliver = replica.prepareReceive(peer);
    A.free(peer);
    const start = performance.now();
    deliver();
    const ms = performance.now() - start;
    return { ms, replica, editor };
  },
};

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};
const results = {
  node: process.version,
  base: baseRevision,
  samples: SAMPLES,
  warmup: WARMUP,
  fixtures: {},
  results: [],
};
for (const [fixture, source] of Object.entries(fixtures)) {
  const base = A.change(
    A.from({ blocks: { b: { position: "a0", richText: "" } } }, { actor: "01".repeat(16) }),
    (d) => setRichMarkdown(d, "b", source),
  );
  results.fixtures[fixture] = {
    markdownBytes: Buffer.byteLength(source),
    nativeLength: base.blocks.b.richText.length,
    spans: A.spans(base, textPath).length,
  };
  for (const [name, run] of Object.entries(cases))
    for (const [label, variant] of Object.entries(variants)) {
      const samples = [];
      for (let i = -WARMUP; i < SAMPLES; i++) {
        const { ms, replica, editor } = run(base, variant);
        // Same result as a fresh decode, outside the timer.
        const fresh = variant.create(replica, "b").current.doc;
        assert.ok(editor.binding.current.doc.eq(editor.state.doc), `${label}: binding and editor`);
        assert.ok(fresh.eq(editor.state.doc), `${label}: native and editor`);
        editor.binding.destroy();
        replica.free();
        if (i >= 0) samples.push(ms);
      }
      results.results.push({
        fixture,
        case: name,
        variant: label,
        median: quantile(samples, 0.5),
        p10: quantile(samples, 0.1),
        p90: quantile(samples, 0.9),
        samples,
      });
    }
  A.free(base);
}
writeFileSync(path.join(output, "binding-benchmark.json"), `${JSON.stringify(results, null, 2)}\n`);

const fmt = (n) => n.toFixed(2);
console.log(
  `node ${process.version}, base ${baseRevision}, ${SAMPLES} samples after ${WARMUP} warmups`,
);
for (const [fixture, info] of Object.entries(results.fixtures))
  console.log(
    `${fixture}: ${info.markdownBytes} Markdown bytes, ${info.nativeLength} native characters, ${info.spans} spans`,
  );
console.log("\n| Fixture | Case | " + Object.keys(variants).join(" | ") + " |");
console.log(
  "| --- | --- | " +
    Object.keys(variants)
      .map(() => "---:")
      .join(" | ") +
    " |",
);
for (const fixture of Object.keys(fixtures))
  for (const name of Object.keys(cases)) {
    const cells = Object.keys(variants).map((label) => {
      const r = results.results.find(
        (x) => x.fixture === fixture && x.case === name && x.variant === label,
      );
      return `${fmt(r.median)} [${fmt(r.p10)}, ${fmt(r.p90)}]`;
    });
    console.log(`| ${fixture} | ${name} | ${cells.join(" | ")} |`);
  }
