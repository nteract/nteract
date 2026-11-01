import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { importLegacy, normalizeSpans, pagesRoot } from "./legacy-codec.mjs";

const { decode, encode } = await import(
  pathToFileURL(resolve(pagesRoot, "viewer/wordgard-model.mjs")).href
);
const { FEATURE_REGISTRY, spanFeatures } = await import(
  pathToFileURL(resolve(pagesRoot, "model/schema-features.mjs")).href
);
const { default: featureFile } = await import(
  pathToFileURL(resolve(pagesRoot, "model/features.json")).href,
  { with: { type: "json" } }
);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${name} value`);
  return args[index + 1];
};
for (let index = 0; index < args.length; index += 2) {
  if (!["--native", "--wasm", "--fixture"].includes(args[index])) {
    throw new Error(`Unknown argument: ${args[index]}`);
  }
}
const native = resolve(option("--native", "target/debug/examples/codec"));
const wasmFile = resolve(
  option("--wasm", "target/wasm32-unknown-unknown/debug/nteract_rich_text.wasm"),
);
const fixtureFile = option("--fixture", new URL("../fixtures/compatibility.json", import.meta.url));
const corpus = JSON.parse(await readFile(fixtureFile, "utf8"));
const { instance } = await WebAssembly.instantiate(await readFile(wasmFile), {});
const api = instance.exports;
for (const name of ["codec_alloc", "codec_run", "codec_result_ptr", "codec_result_len", "codec_free"]) {
  assert.equal(typeof api[name], "function", `Missing WASM export ${name}`);
}
assert(api.memory instanceof WebAssembly.Memory, "WASM must export linear memory");
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function runWasm(request) {
  const bytes = encoder.encode(JSON.stringify(request));
  const pointer = api.codec_alloc(bytes.length);
  try {
    new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
    const length = api.codec_run(pointer, bytes.length);
    assert.equal(length, api.codec_result_len(), "WASM result length mismatch");
    // The codec may grow memory. Re-read the buffer after running it.
    return JSON.parse(decoder.decode(new Uint8Array(api.memory.buffer, api.codec_result_ptr(), length)));
  } finally {
    api.codec_free(pointer, bytes.length);
  }
}

let requestCount = 0;
function runBoth(requests) {
  const stdout = execFileSync(native, [], {
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, requests.length, "Native response count mismatch");
  requests.forEach((request, index) => {
    assert.deepEqual(runWasm(request), responses[index], `Native/WASM mismatch for request ${index}`);
  });
  requestCount += requests.length;
  return responses;
}

function equalSpans(actual, expected, name) {
  assert.deepEqual(normalizeSpans(actual), normalizeSpans(expected), name);
}

const allImports = [...corpus.fixtures, ...corpus.divergences];
const imports = runBoth(
  allImports.map(({ markdown, import_id = "", kind = "markdown" }) => ({
    op: "import", markdown, import_id, kind,
  })),
);
for (const [index, fixture] of allImports.entries()) {
  const result = imports[index];
  assert.equal(result.ok, true, `${fixture.id}: ${result.error}`);
  equalSpans(result.spans, fixture.expected_spans, `${fixture.id}: imported span mismatch`);
  equalSpans(
    importLegacy(fixture.markdown, fixture.import_id, fixture.kind),
    fixture.legacy_spans ?? fixture.expected_spans,
    `${fixture.id}: legacy oracle changed; investigate before regenerating fixtures`,
  );
}

const exportFixtures = [
  ...allImports.map((fixture) => ({ ...fixture, spans: fixture.expected_spans })),
  ...corpus.export_cases,
];
const exports = runBoth(exportFixtures.map(({ spans }) => ({ op: "export", spans })));
for (const [index, fixture] of exportFixtures.entries()) {
  const result = exports[index];
  assert.equal(result.ok, true, `${fixture.id}: ${result.error}`);
  const opaque = fixture.spans.length === 1 && fixture.spans[0].value?.type === "pages-opaque";
  if (opaque) {
    assert.equal(result.markdown, fixture.spans[0].value.attrs.source, `${fixture.id}: opaque source changed`);
  } else {
    equalSpans(
      // Export is Markdown, whatever the source kind was.
      importLegacy(result.markdown),
      // A declared legacy exporter limitation has an exact recorded result;
      // native and Wordgard round trips below still require preserved structure.
      fixture.legacy_export_spans ?? fixture.expected_spans,
      `${fixture.id}: exported Markdown changed legacy rich-text semantics`,
    );
  }
}

const roundTrips = runBoth(
  exports.map((result, index) => ({
    op: "import",
    markdown: result.markdown,
    import_id: exportFixtures[index].import_id ?? "",
    // Export is Markdown, whatever the source kind was.
    kind: "markdown",
  })),
);
for (const [index, fixture] of exportFixtures.entries()) {
  const result = roundTrips[index];
  assert.equal(result.ok, true, `${fixture.id}: ${result.error}`);
  equalSpans(result.spans, fixture.expected_spans, `${fixture.id}: Rust export/import changed semantics`);
}

// Wordgard can represent a paragraph or container implicitly, so its encoded
// markers need not match the importer's markers. Keep the strict legacy span
// checks above and independently prove equality of Wordgard's document model.
const wordgardCases = allImports.map((fixture, index) => {
  const doc = decode(imports[index].spans).doc;
  const spans = JSON.parse(JSON.stringify(encode(doc)));
  assert(decode(spans).doc.eq(doc), `${fixture.id}: Wordgard encode/decode changed the document`);
  return { fixture, doc, spans };
});
const wordgardExports = runBoth(wordgardCases.map(({ spans }) => ({ op: "export", spans })));
for (const [index, { fixture }] of wordgardCases.entries()) {
  assert.equal(wordgardExports[index].ok, true, `${fixture.id}: ${wordgardExports[index].error}`);
}
const wordgardImports = runBoth(
  wordgardExports.map((result, index) => ({
    op: "import",
    markdown: result.markdown,
    import_id: wordgardCases[index].fixture.import_id ?? "",
    kind: "markdown",
  })),
);
for (const [index, { fixture, doc }] of wordgardCases.entries()) {
  const result = wordgardImports[index];
  assert.equal(result.ok, true, `${fixture.id}: ${result.error}`);
  assert(
    decode(result.spans).doc.eq(doc),
    `${fixture.id}: Rust export/import changed the Wordgard document`,
  );
}

// Both codecs read the same registry files. They must agree on every
// feature, which marks and block types need one, and what each span needs.
const [registry] = runBoth([{ op: "registry" }]);
assert.deepEqual(
  registry,
  {
    ok: true,
    features: featureFile.features.map(({ id, description, blocks = [] }) => ({
      id,
      description,
      blocks,
    })),
    marks: Object.fromEntries(FEATURE_REGISTRY.marks),
    blocks: Object.fromEntries(FEATURE_REGISTRY.blocks),
  },
  "Rust and JavaScript read different schema feature registries",
);
const featureCases = [
  ...exportFixtures.map((fixture) => fixture.spans),
  ...wordgardCases.map(({ spans }) => spans),
];
const features = runBoth(featureCases.map((spans) => ({ op: "features", spans })));
for (const [index, spans] of featureCases.entries()) {
  assert.equal(features[index].ok, true, features[index].error);
  assert.deepEqual(features[index].features, spanFeatures(spans), `feature case ${index}`);
}

// Never silent loss, in the JavaScript codec: every Markdown fixture, and
// each one wrapped in a link, a table cell, bold and a highlight, imports
// with every link destination, image and visible character natively, or as
// the whole source in literal text. An agent write is refused exactly when
// the native parse would lose something or names math or HTML.
const pages = await import(pathToFileURL(resolve(pagesRoot, "model/richtext.mjs")).href);
const squash = (text) => text.replace(/\s+/g, "");
const wrappings = [
  (source) => source,
  (source) => `[${source.replace(/\n/g, " ")}](https://example.org/w)`,
  (source) => `| h |\n| - |\n| ${source.replace(/\n/g, "<br>").replace(/\|/g, "\\|")} |`,
  (source) => `**${source.replace(/\n/g, " ")}**`,
  (source) => `<mark>${source.replace(/\n/g, " ")}</mark> ![after](a.png)`,
];
let preserved = 0,
  literalized = 0;
for (const fixture of corpus.fixtures) {
  if ((fixture.kind ?? "markdown") !== "markdown") continue;
  for (const wrap of wrappings) {
    const source = wrap(fixture.markdown);
    const label = `${fixture.id}: ${JSON.stringify(source).slice(0, 80)}`;
    const doc = pages.parseMarkdown(source);
    doc.descendants((node) => assert.notEqual(node.type.name, "raw", label));
    if (pages.nativeImportLoss(source)) {
      literalized++;
      assert.equal(squash(doc.textContent), squash(source.replace(/\r/g, "")), label);
      assert.throws(() => pages.parseAgentMarkdown(source), { code: "unsupported_markdown" }, label);
    } else {
      preserved++;
      if (!pages.unsupportedMarkdown(source))
        assert.ok(pages.parseAgentMarkdown(source).eq(doc), label);
    }
  }
}
assert.ok(preserved > 500 && literalized > 0, `${preserved} preserved, ${literalized} literal`);

const invalid = [
  { op: "export", spans: [{ type: "text", value: "bad mark", marks: { unknown: true } }] },
  { op: "export", spans: [{ type: "text", value: "bad link", marks: { link: "not JSON" } }] },
  { op: "export", spans: [{ type: "text", value: "bad color", marks: { highlight: "red" } }] },
  { op: "export", spans: [{ type: "text", value: "bad case", marks: { highlight: "#ABCDEF" } }] },
  { op: "export", spans: [{ type: "block", value: { type: "mystery", parents: [], attrs: {}, isEmbed: false } }] },
  { op: "import", markdown: "a".repeat(262_145) },
];
for (const result of runBoth(invalid)) {
  assert.equal(result.ok, false, "Invalid input must return an error without trapping");
  assert.equal(typeof result.error, "string");
}

console.log(
  `${allImports.length} imports, ${exportFixtures.length} exports and round trips, ${wordgardCases.length} Wordgard round trips, ${featureCases.length} schema feature checks, ${invalid.length} invalid inputs, and ${preserved + literalized} preservation checks (${literalized} literal) passed (${requestCount} identical native/WASM responses).`,
);
