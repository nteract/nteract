// One edit_page batch reads each block once and keeps the read for its later
// operations (model/block-reads.mjs). A batch must give the same document,
// receipts, presence trace and refusal as the same operations sent one batch
// each, where nothing is kept between operations.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, orderedBlockIds } from "./page.mjs";
import { setRichMarkdown } from "./richtext-page.mjs";
import { textPath } from "./richtext-format.mjs";
import { blockAddress, nodeAddresses } from "./addresses.mjs";
import { spliceRuns, textRuns } from "./block-reads.mjs";
import { guardPassageEdits } from "./passage-edits.mjs";
import { fuzzParameters as parameters } from "../test/fuzz-parameters.mjs";
import { freeing } from "../test/free-docs.mjs";

const PAGE = "66666666-6666-4666-8666-666666666666";
const ACTOR = "0c".repeat(16);
const tag = (i) => `s${i}q`;
const section = (i) => {
  const t = tag(i);
  return [
    `## Section ${t}`,
    `Paragraph ${t} has **bold ${t}** and _soft_ words, alpha ${t}, beta ${t} and gamma ${t}.`,
    `- First ${t}\n- Second ${t}`,
    `1. One ${t}\n2. Two ${t}`,
    `> Quote ${t}`,
    '```js\nconst x = "' + t + '";\n```',
    `| A | B |\n| --- | --- |\n| ${t} | b |`,
  ].join("\n\n");
};
// The kinds of each section's nodes, in order.
const KINDS = ["heading", "paragraph", "bullets", "ordered", "quote", "code", "table"];
const SECTIONS = 6;
// Sections 0 to 3 share the first block; 4 and 5 share the second.
const blockOf = (i) => (i < 4 ? "one" : "two");

function page() {
  return A.change(
    A.from(createPageData({ pageId: PAGE, title: "Batch" }), { actor: ACTOR }),
    (draft) => {
      draft.blocks.one = { position: "a0", richText: "" };
      draft.blocks.two = { position: "a1", richText: "" };
      setRichMarkdown(draft, "one", [0, 1, 2, 3].map(section).join("\n\n"));
      setRichMarkdown(draft, "two", [4, 5].map(section).join("\n\n"));
    },
  );
}
const base = page();
/** The addresses an agent reads from the starting Page, by section. */
const addresses = Array.from({ length: SECTIONS }, (_, i) => {
  const key = blockOf(i);
  const ids = nodeAddresses(base, key);
  const first = (i % (key === "one" ? 4 : 2)) * KINDS.length;
  return {
    block: blockAddress(base, key),
    ...Object.fromEntries(KINDS.map((kind, k) => [kind, ids[first + k]])),
  };
});

/** One batch of `operations` on `doc`: the next document and the result, or
 * the document unchanged and the refusal. */
function apply(doc, operations) {
  const trace = [];
  let result;
  try {
    const next = A.change(doc, (draft) => {
      result = applyPageOperation(draft, {
        operation: "edit_page",
        arguments: { operations },
        trace,
      });
    });
    return { doc: next, result, trace };
  } catch (error) {
    return {
      doc,
      error: {
        reason: error.editReason ?? error.code,
        index: error.editAt?.index,
        op: error.editAt?.op,
        field: error.editAt?.field,
        message: error.message,
      },
    };
  }
}
/** What a reader sees of `doc`: each block in order with its spans and node
 * ids. */
const content = (doc) =>
  orderedBlockIds(doc).map((key) => ({
    key,
    spans: A.spans(doc, textPath(key)),
    ids: nodeAddresses(doc, key),
  }));

/** Send `operations` as one batch and one batch each, and require the same
 * outcome. Frees what it makes through `keep`. */
function assertSameAsOneEach(operations, keep) {
  const batched = apply(A.clone(base, { actor: ACTOR }), operations);
  keep(batched.doc);
  let doc = A.clone(base, { actor: ACTOR });
  const edits = [];
  const trace = [];
  let refusal;
  for (const [i, op] of operations.entries()) {
    const one = apply(doc, [op]);
    if (one.error) {
      refusal = { ...one.error, index: i };
      break;
    }
    doc = one.doc;
    edits.push(...(one.result.edits ?? []));
    trace.push(...one.trace);
  }
  keep(doc);
  if (batched.error) {
    assert.deepEqual(batched.error, refusal, "the batch refuses where one batch each refuses");
    // Nothing in a refused batch is written.
    assert.deepEqual(content(batched.doc), content(base));
    return batched.error;
  }
  assert.equal(refusal, undefined, `one batch each refused: ${JSON.stringify(refusal)}`);
  assert.deepEqual(batched.result.edits ?? [], edits);
  assert.deepEqual(batched.trace, trace);
  assert.deepEqual(content(batched.doc), content(doc));
}

const ops = {
  bold: (i, scope) => ({
    op: "format_match",
    node_id: addresses[i][scope],
    match_text: `alpha ${tag(i)}`,
    add: { strong: true },
  }),
  unbold: (i, scope) => ({
    op: "format_match",
    node_id: addresses[i][scope],
    match_text: `bold ${tag(i)}`,
    remove: ["strong"],
  }),
  highlightAll: (i) => ({
    op: "format_match",
    node_id: addresses[i].block,
    match_text: tag(i),
    all: true,
    add: { highlight: "yellow" },
  }),
  replace: (i, scope) => ({
    op: "replace_match",
    node_id: addresses[i][scope],
    match_text: `beta ${tag(i)}`,
    replacement: `delta ${tag(i)}`,
  }),
  lengthen: (i, scope) => ({
    op: "replace_match",
    node_id: addresses[i][scope],
    match_text: `alpha ${tag(i)}`,
    replacement: `alpha ${tag(i)} and more`,
  }),
  replaceMarkdown: (i) => ({
    op: "replace_match",
    node_id: addresses[i].block,
    match_text: `gamma ${tag(i)}`,
    replacement_markdown: `**gamma** ${tag(i)}`,
  }),
  // Text in the nodes a move takes.
  emphasizeQuote: (i) => ({
    op: "format_match",
    node_id: addresses[i].block,
    match_text: `Quote ${tag(i)}`,
    add: { em: true },
  }),
  renameQuote: (i) => ({
    op: "replace_match",
    node_id: addresses[i].block,
    match_text: `Quote ${tag(i)}`,
    replacement: `Remark ${tag(i)}`,
  }),
  codeLanguage: (i) => ({
    op: "set_node",
    node_id: addresses[i].block,
    match_text: `"${tag(i)}"`,
    attrs: { language: "ts" },
  }),
  insert: (i) => ({
    op: "insert_markdown",
    after_node_id: addresses[i].paragraph,
    markdown: `Inserted after ${tag(i)}.`,
  }),
  // A list after a list of the same kind joins it, so this refuses.
  joinList: (i) => ({
    op: "insert_markdown",
    after_node_id: addresses[i].bullets,
    markdown: "- Joins the list",
  }),
  move: (i, _scope, j) => ({
    op: "move_nodes",
    node_id: addresses[i].quote,
    through_node_id: addresses[i].table,
    after_node_id: addresses[j].paragraph,
  }),
  deleteList: (i) => ({ op: "delete_node", node_id: addresses[i].bullets }),
  retitle: (i) => ({
    op: "set_node",
    node_id: addresses[i].block,
    match_text: `Section ${tag(i)}`,
    type: "heading",
    attrs: { level: 3 },
  }),
};

test("mixed operations on one block give what one batch each gives", () =>
  freeing((keep) =>
    assertSameAsOneEach(
      [
        ops.bold(1, "block"),
        ops.lengthen(1, "block"),
        ops.replace(2, "paragraph"),
        ops.insert(2),
        ops.bold(3, "paragraph"),
        ops.highlightAll(0),
        ops.move(0, null, 3),
        ops.replace(0, "block"),
        ops.replaceMarkdown(3),
        ops.deleteList(1),
        ops.unbold(2, "block"),
        ops.retitle(3),
        ops.bold(0, "paragraph"),
      ],
      keep,
    ),
  ));

test("moves between blocks give what one batch each gives", () =>
  freeing((keep) =>
    assertSameAsOneEach(
      [
        ops.move(4, null, 1),
        ops.bold(4, "block"),
        ops.move(1, null, 5),
        ops.insert(5),
        ops.replace(1, "block"),
      ],
      keep,
    ),
  ));

test("a refusal mid-batch writes nothing and names the operation one batch each refuses at", () =>
  freeing((keep) => {
    const refusal = assertSameAsOneEach(
      [ops.bold(1, "block"), ops.lengthen(1, "block"), ops.joinList(1), ops.replace(2, "block")],
      keep,
    );
    assert.equal(refusal.reason, "nodes_would_join");
    assert.equal(refusal.index, 2);
    assert.equal(refusal.op, "insert_markdown");
  }));

test("an operation on text an earlier operation in the batch replaced is refused as it is alone", () =>
  freeing((keep) => {
    const refusal = assertSameAsOneEach(
      [ops.replace(2, "block"), ops.bold(1, "block"), ops.replace(2, "block")],
      keep,
    );
    assert.equal(refusal.index, 2);
    assert.equal(refusal.reason, "match_zero");
  }));

test("any batch of edits gives what one batch each gives", () => {
  // joinList always refuses; the tests above cover it.
  const names = Object.keys(ops).filter((name) => name !== "joinList");
  const operation = fc
    .record({
      name: fc.constantFrom(...names),
      // Few sections, so operations meet on the same text and nodes: two in
      // the first block and one in the second.
      i: fc.constantFrom(0, 1, 4),
      j: fc.nat(SECTIONS - 1),
      scope: fc.constantFrom("block", "paragraph"),
    })
    .filter(({ name, i, j }) => name !== "move" || i !== j)
    .map(({ name, i, j, scope }) => ops[name](i, scope, j));
  fc.assert(
    fc.property(fc.array(operation, { minLength: 1, maxLength: 10 }), (operations) =>
      freeing((keep) => {
        assertSameAsOneEach(operations, keep);
      }),
    ),
    { ...parameters, numRuns: Math.max(parameters.numRuns, 150) },
  );
});

test("a kept text read follows a splice as a fresh read sees it, or is dropped", () => {
  const text = (doc) => doc.blocks.one.richText;
  fc.assert(
    fc.property(fc.nat(), fc.nat(8), fc.string({ maxLength: 4 }), (where, remove, insert) =>
      freeing((keep) => {
        const doc = A.clone(base);
        const at = where % (text(doc).length + 1);
        const length = Math.min(remove, text(doc).length - at);
        const removed = text(doc).slice(at, at + length);
        const before = textRuns(A.spans(doc, textPath("one")));
        const after = keep(
          A.change(doc, (draft) => A.splice(draft, textPath("one"), at, length, insert)),
        );
        const expected = textRuns(A.spans(after, textPath("one")));
        const kept = spliceRuns(before, at, length, insert);
        // Dropped only when the splice removes a marker.
        if (kept === null) assert.ok(removed.includes("\ufffc"));
        else assert.deepEqual(kept, expected);
      }),
    ),
    { ...parameters, numRuns: Math.max(parameters.numRuns, 200) },
  );
});

// Each kind of write, followed by an edit later in a block it wrote. A block
// a write leaves out of `touched` keeps its old read, so the later edit
// would find its match at the old offset, or move a node's old attributes.
test("every operation's writes reach the next operation on the blocks it wrote", () => {
  const image = {
    op: "insert_image",
    asset_id: "a".repeat(64),
    alt: "A figure",
    after_node_id: addresses[0].paragraph,
  };
  const rewrite = {
    op: "replace_block_markdown",
    node_id: addresses[4].block,
    markdown: `A new lead paragraph.\n\n${section(4)}\n\n${section(5)}`,
  };
  // A move writes the marker attributes it read, so it shows a stale read
  // of a retyped heading.
  const moveHeading = {
    op: "move_nodes",
    node_id: addresses[1].heading,
    through_node_id: addresses[1].paragraph,
    after_node_id: addresses[3].paragraph,
  };
  const cases = [
    ["insert_markdown after a node", [ops.insert(0), ops.replace(3, "block")]],
    ["insert_image after a node", [image, ops.replace(3, "block")]],
    ["replace_match", [ops.lengthen(0, "block"), ops.replace(3, "block")]],
    ["format_match", [ops.bold(0, "block"), ops.replace(3, "block")]],
    ["set_node", [ops.retitle(0), ops.replace(3, "block")]],
    ["delete_node", [ops.deleteList(0), ops.replace(3, "block")]],
    [
      "move_nodes, both blocks",
      [ops.move(4, null, 1), ops.replace(3, "block"), ops.replace(5, "block")],
    ],
    ["replace_block_markdown", [rewrite, ops.replace(5, "block")]],
    ["set_node, then a move of its node", [ops.retitle(1), moveHeading]],
  ];
  for (const [name, operations] of cases)
    freeing((keep) => assert.equal(assertSameAsOneEach(operations, keep), undefined, name));
});

// conflict_scope target: guardPassageEdits reads the base revision, the
// current document and a dry run, each once per block, then the batch
// applies. Against the same base, a batch on disjoint passages gives what
// one target-scoped batch each gives, and is refused exactly when one of
// them is refused, with that one's conflict.
const PEER = "0d".repeat(16);
const peerEdits = {
  // Text before the target moves it.
  prefix: (p) => ({
    op: "replace_match",
    node_id: addresses[p].block,
    match_text: `Paragraph ${tag(p)} has`,
    replacement: `Paragraph ${tag(p)} now opens with a peer's words and has`,
  }),
  retext: (p) => ({
    op: "replace_match",
    node_id: addresses[p].block,
    match_text: `alpha ${tag(p)}`,
    replacement: `alfa ${tag(p)}`,
  }),
  bold: (p) => ({
    op: "format_match",
    node_id: addresses[p].block,
    match_text: `beta ${tag(p)}`,
    add: { strong: true },
  }),
  paragraph: (p) => ({
    op: "insert_markdown",
    after_node_id: addresses[p].heading,
    markdown: `A peer's paragraph under ${tag(p)}.`,
  }),
};
/** One target-scoped batch against `baseHeads`: the guard, then the write. */
function applyTargeted(doc, baseHeads, operations) {
  try {
    const guarded = guardPassageEdits(doc, baseHeads, operations);
    const next = apply(doc, guarded.operations);
    if (next.error) return { doc, error: next.error };
    return next;
  } catch (error) {
    return {
      doc,
      error: {
        status: error.status,
        code: error.code,
        conflicts: error.details?.conflicts,
        reason: error.editReason,
        op: error.editAt?.op,
        message: error.message,
      },
    };
  }
}
const TARGETED = [
  "bold",
  "unbold",
  "replace",
  "lengthen",
  "replaceMarkdown",
  "emphasizeQuote",
  "renameQuote",
  "retitle",
  "codeLanguage",
];
test("a target-scoped batch gives what one target-scoped batch each gives, across a peer's edit", () => {
  const peer = fc.record({
    name: fc.constantFrom(...Object.keys(peerEdits)),
    p: fc.nat(SECTIONS - 1),
  });
  const targeted = fc.uniqueArray(
    fc.record({
      name: fc.constantFrom(...TARGETED),
      i: fc.nat(SECTIONS - 1),
      scope: fc.constantFrom("block", "paragraph"),
    }),
    { minLength: 1, maxLength: 6, selector: ({ i }) => i },
  );
  fc.assert(
    fc.property(fc.array(peer, { maxLength: 3 }), targeted, (changes, picks) =>
      freeing((keep) => {
        const baseHeads = A.getHeads(base);
        // The current document: the base plus the peer's edits.
        let current = A.clone(base, { actor: PEER });
        for (const { name, p } of changes) {
          const next = apply(current, [peerEdits[name](p)]);
          current = next.doc;
        }
        keep(current);
        const operations = picks.map(({ name, i, scope }) => ops[name](i, scope));
        const alone = operations.map((op) => {
          const one = applyTargeted(A.clone(current, { actor: ACTOR }), baseHeads, [op]);
          keep(one.doc);
          return one.error;
        });
        const batched = applyTargeted(A.clone(current, { actor: ACTOR }), baseHeads, operations);
        keep(batched.doc);
        if (batched.error) {
          const { index: _batchIndex, ...error } = batched.error;
          assert.ok(
            alone.some((each) => {
              if (!each) return false;
              const { index: _index, ...own } = each;
              return JSON.stringify(own) === JSON.stringify(error);
            }),
            `the batch's refusal is one operation's own: ${JSON.stringify(error)}`,
          );
          return;
        }
        assert.deepEqual(alone.filter(Boolean), [], "every operation passes alone");
        // One batch each, in order, against the same base revision.
        let doc = A.clone(current, { actor: ACTOR });
        const edits = [];
        for (const op of operations) {
          const one = applyTargeted(doc, baseHeads, [op]);
          assert.equal(one.error, undefined, JSON.stringify(one.error));
          doc = one.doc;
          edits.push(...(one.result.edits ?? []));
        }
        keep(doc);
        assert.deepEqual(batched.result.edits, edits);
        assert.deepEqual(content(batched.doc), content(doc));
      }),
    ),
    // Each run guards and applies the batch and every operation alone.
    { ...parameters, numRuns: Math.ceil(parameters.numRuns / 2) },
  );
});
