// Local paired benchmark, not a wall-clock CI assertion. No document writes.
// node test/native-validation.benchmark.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as A from "@automerge/automerge";
import * as esbuild from "esbuild";
import { baseline, baseRevision, marker, text } from "./native-validation-baseline.mjs";
import { pageSpans, validateRichSpans } from "../model/richtext-spans.mjs";
import { parseMarkdown } from "../model/markdown-import.mjs";

const pages = fileURLToPath(new URL("../", import.meta.url));
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: pages,
  encoding: "utf8",
}).trim();
const source = Array(7)
  .fill(readFileSync(`${root}/docs/adr/automerge-document-storage.md`, "utf8"))
  .join("\n\n");
const marked = pageSpans(parseMarkdown(source));
const S = (value) => new A.ImmutableString(value);
const many = Array.from({ length: 1000 }, (_, i) => [
  marker(S("paragraph")),
  text(`Block ${i} ${"x".repeat(60)}`),
]).flat();
const limit = [text("x".repeat(262144 - Buffer.byteLength(JSON.stringify([text("")]))))];
const fixtures = {
  "marked 115 KB": [marked],
  "1000 paragraphs": [many],
  "1000 separate blocks": Array.from({ length: 1000 }, (_, i) => [
    text(`Block ${i} ${"x".repeat(60)}`),
  ]),
  "exact 262144 bytes": [limit],
};
const samples = Number(process.env.PAGES_VALIDATION_SAMPLES || 31);
const stats = (all) => {
  const sorted = [...all].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p10: sorted[Math.floor(sorted.length / 10)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
    samples: all,
  };
};
const result = {
  baseRevision,
  runtime: process.version,
  sourceBytes: Buffer.byteLength(source),
  fixtures: {},
  graphs: {},
};
for (const [name, blocks] of Object.entries(fixtures)) {
  const native = [],
    base = [];
  const run = (fn, cold = false) => {
    const inputs = cold ? blocks.map((spans) => JSON.parse(JSON.stringify(spans))) : blocks;
    const start = performance.now();
    for (const spans of inputs) fn(spans);
    return performance.now() - start;
  };
  for (let i = -5; i < samples; i++) {
    for (const variant of i % 2 ? ["base", "native"] : ["native", "base"]) {
      const ms = run(variant === "base" ? baseline.validateRichSpans : validateRichSpans);
      if (i >= 0) (variant === "base" ? base : native).push(ms);
    }
  }
  result.fixtures[name] = {
    blocks: blocks.length,
    spans: blocks.reduce((n, s) => n + s.length, 0),
    bytes: blocks.reduce((n, s) => n + Buffer.byteLength(JSON.stringify(s)), 0),
    base: stats(base),
    native: stats(native),
  };
  if (name === "marked 115 KB") {
    const coldBase = [],
      coldNative = [];
    for (let i = 0; i < samples; i++) {
      coldBase.push(run(baseline.validateRichSpans, true));
      coldNative.push(run(validateRichSpans, true));
    }
    result.fixtures["cold mutable JSON 115 KB"] = {
      bytes: result.fixtures[name].bytes,
      base: stats(coldBase),
      native: stats(coldNative),
    };
  }
}
for (const entry of ["model/native-validation.mjs", "model/richtext-spans.mjs"]) {
  const { metafile } = await esbuild.build({
    absWorkingDir: pages,
    entryPoints: [entry],
    bundle: true,
    write: false,
    treeShaking: false,
    platform: "browser",
    format: "esm",
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(metafile.inputs);
  result.graphs[entry] = {
    modules: inputs.length,
    pm: inputs.filter((name) => /prosemirror/.test(name)),
  };
}
assert.equal(result.graphs["model/native-validation.mjs"].pm.length, 0);
const doc = A.from({ richText: "validation is read-only" });
const saved = A.save(doc),
  heads = A.getHeads(doc),
  id = A.getObjectId(doc, "richText");
validateRichSpans(A.spans(doc, ["richText"]));
assert.deepEqual(A.save(doc), saved);
assert.deepEqual(A.getHeads(doc), heads);
assert.equal(A.getObjectId(doc, "richText"), id);
result.saved = {
  before: saved.length,
  after: A.save(doc).length,
  bytesEqual: true,
  headsEqual: true,
  objectIdEqual: true,
};
A.free(doc);
console.log(JSON.stringify(result, null, 2));
