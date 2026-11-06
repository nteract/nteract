// The Wordgard serializer against the ProseMirror serializer it replaces:
// both must write the same bytes for every input. Stored inputs come from
// test/address-inputs.mjs (stored shapes, the corpus as rich text, seeded
// random trees, plain and hostile); the corpus is also exported straight
// from the parser's tree.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import markdownCorpus from "./markdown-corpus.json" with { type: "json" };
import { exportMarkdown as proseMirrorMarkdown } from "./pm-markdown-serializer.mjs";
import { exportMarkdown, treeMarkdown } from "./markdown-serializer.mjs";
import { parseAgentMarkdown, parseMarkdown } from "./markdown-import.mjs";
import { schema as pmSchema } from "./pm-adapter.mjs";
import { blockMarkdown } from "./richtext-page.mjs";
import { adapterRead, readTree, richDoc } from "./richtext-spans.mjs";
import { encode, schema } from "./wordgard-doc.mjs";
import { corpusInputs, pageWithSpans, randomInputs, shapeInputs } from "../test/address-inputs.mjs";
import { pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";

const result = (f) => {
  try {
    return f();
  } catch (error) {
    return `error: ${error.message}`;
  }
};
const same = (label, before, after) => assert.equal(result(after), result(before), label);

function compareStored(name, spans) {
  const { doc, id } = pageWithSpans(spans);
  const block = doc.blocks[id];
  same(
    name,
    () => proseMirrorMarkdown(richDoc(block, doc.page_id)),
    () => blockMarkdown(block, doc.page_id),
  );
  same(
    `${name} (ProseMirror tree)`,
    () => proseMirrorMarkdown(richDoc(block, doc.page_id)),
    () => exportMarkdown(richDoc(block, doc.page_id)),
  );
  let tree, nodes;
  try {
    tree = richDoc(block, doc.page_id);
    nodes = readTree(block, doc.page_id).content;
  } catch {
    return;
  }
  if (tree.childCount !== nodes.length) return;
  tree.forEach((node, _offset, index) => {
    const slice = pmSchema.node("doc", null, [node]);
    // blockMarkdown reads these blocks through richDoc (adapterRead).
    if (!adapterRead(block))
      same(
        `${name} node ${index}`,
        () => proseMirrorMarkdown(slice),
        () => treeMarkdown(schema.doc([nodes[index]])),
      );
    same(
      `${name} node ${index} (ProseMirror tree)`,
      () => proseMirrorMarkdown(slice),
      () => exportMarkdown(slice),
    );
  });
}

test("stored shapes, the corpus as rich text and seeded random trees project the same", () => {
  for (const { name, spans } of [...shapeInputs(), ...corpusInputs(), ...randomInputs()])
    compareStored(name, spans);
});

test("hostile and deeper random trees project the same", () => {
  for (const [seed, options] of [
    [11, { hostile: true }],
    [12, { maxDepth: 3 }],
    [13, { hostile: true, maxDepth: 3 }],
  ])
    fc.sample(pageTreeArbitrary({ maxDepth: 2, ...options }), { seed, numRuns: 40 }).forEach(
      (description, index) =>
        compareStored(`random ${seed}/${index}`, encode(toWordgardTree(description))),
    );
});

test("the parser's tree for every corpus case exports the same", () => {
  for (const { id, markdown } of markdownCorpus.cases)
    for (const parse of [parseMarkdown, parseAgentMarkdown]) {
      let tree;
      try {
        tree = parse(markdown);
      } catch {
        continue;
      }
      same(
        `${parse.name} ${id}`,
        () => proseMirrorMarkdown(tree),
        () => exportMarkdown(tree),
      );
    }
});
