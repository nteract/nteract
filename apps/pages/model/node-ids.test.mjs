// Node ids and delete_node: a top-level node's id survives edits around and
// inside it, and delete_node removes exactly that node.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf } from "wordgard/doc";
import { Blockquote, HorizontalRule, Paragraph } from "wordgard/types";
import { decode, encode, PagesDataframe, schema } from "./wordgard-doc.mjs";
import { blockAddresses } from "./node-addresses.mjs";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { blockMarkdown, parseMarkdown, richDoc, textPath } from "./richtext.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { projectReadContent } from "./read-content.mjs";
import { projectReadChanges } from "./read-changes.mjs";
import { MAX_NODE_ID, nodeIds } from "./node-ids.mjs";
import { addressIndex, blockAddress, nodeAddresses, resolveAddress } from "./addresses.mjs";
import { SHAPES, pageWithSpans } from "../test/address-inputs.mjs";

const pageId = "44444444-4444-4444-8444-444444444444";
const assetId = "e".repeat(64);
const S = (value) => new A.ImmutableString(value);
const SOURCE = [
  "Intro ![chart](https://example.org/a.png) words",
  "## Plan",
  "- one\n- two",
  "> quoted",
  "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "---",
  "Closing words",
].join("\n\n");

function fixture(markdown = SOURCE) {
  let doc = A.from(createPageData({ pageId, title: "Node ids" }));
  doc = A.change(doc, (draft) => initializePage(draft, markdown));
  return { doc, id: orderedBlockIds(doc)[0] };
}
function run(doc, operation, operations) {
  let result;
  const after = A.change(A.clone(doc), (draft) => {
    result = applyPageOperation(draft, { operation, arguments: { operations } });
  });
  return { doc: after, result };
}
// A Page written from `markdown`, read back: expectations follow the
// exporter's own spacing.
const projected = (markdown) => {
  const written = fixture(markdown);
  return blockMarkdown(written.doc.blocks[written.id]);
};
const edit = (doc, operations) => run(doc, "edit_page", operations);
const patch = (doc, operations) => run(doc, "edit_page", operations).doc;
/** The outline entries of block `id`: from the entry that names the block
 * up to the next one that names a block. */
const outline = (doc, id) => {
  const entries = projectReadContent(doc, { include_content: false }).outline;
  const start = entries.findIndex((entry) => entry.block === blockAddress(doc, id));
  if (start < 0) return [];
  const next = entries.findIndex((entry, index) => index > start && entry.block !== undefined);
  return entries.slice(start, next < 0 ? undefined : next);
};
const resolve = (doc, address) => resolveAddress(addressIndex(doc), address);
const idOf = (doc, id, type) => outline(doc, id).find((entry) => entry.type === type).node_id;
const refuses = (doc, operations, check) => assert.throws(() => edit(doc, operations), check);

test("the outline gives every top-level node an id, the block's opening paragraph included", () => {
  const { doc, id } = fixture();
  const entries = outline(doc, id);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["paragraph", "heading", "bullet-list", "blockquote", "table", "horizontal-rule", "paragraph"],
  );
  // The opening paragraph has its own marker at 0. The image inside it is a
  // marker too, but an inline one, which opens no node.
  assert.equal(nodeIds(doc, id)[0].at, 0);
  for (const entry of entries) assert.equal(typeof entry.node_id, "string");
  assert.equal(new Set(entries.map((entry) => entry.node_id)).size, entries.length);
  // The id is the cursor at the node's opening marker.
  const spans = A.spans(doc, textPath(id));
  for (const { id: nodeId, at } of nodeIds(doc, id)) {
    assert.equal(A.getCursor(doc, textPath(id), at), nodeId);
    let index = 0,
      span;
    for (span of spans) {
      const width = span.type === "text" ? span.value.length : 1;
      if (index + width > at) break;
      index += width;
    }
    assert.equal(span.type, "block");
    assert.equal(span.value.isEmbed, false);
  }
});

test("consecutive rules and an empty paragraph get their own stored marker ids", () => {
  const { doc: base, id } = fixture("");
  const doc = A.change(base, (draft) =>
    A.updateSpans(
      draft,
      textPath(id),
      encode(schema.doc([HorizontalRule, HorizontalRule, Paragraph.create([])])),
      updateSpansConfig,
    ),
  );
  const expected = [0, 1, 2].map((at) => ({
    id: A.getCursor(doc, textPath(id), at),
    at,
    end: at + 1,
  }));
  assert.deepEqual(nodeIds(doc, id), expected);
  assert.deepEqual(
    outline(doc, id).map((entry) => [entry.type, entry.node_id]),
    ["horizontal-rule", "horizontal-rule", "paragraph"].map((type, i) => [type, expected[i].id]),
  );
  for (const [index, { id: nodeId }] of expected.entries()) {
    assert.deepEqual(resolve(doc, nodeId), {
      kind: "node",
      key: id,
      index,
      start: index,
      end: index + 1,
    });
    const after = edit(doc, [{ op: "delete_node", node_id: nodeId }]).doc;
    assert.deepEqual(
      outline(after, id).map((entry) => entry.node_id),
      expected.filter((entry) => entry.id !== nodeId).map((entry) => entry.id),
    );
  }
});

test("a node keeps its id through text, mark and attribute edits and edits around it", () => {
  const { doc, id } = fixture();
  const before = outline(doc, id).map((entry) => entry.node_id);
  let after = patch(doc, [
    {
      op: "replace_match",
      node_id: blockAddress(doc, id),
      match_text: "Plan",
      replacement: "Plan for Q4",
    },
    {
      op: "format_match",
      node_id: blockAddress(doc, id),
      match_text: "quoted",
      add: { strong: true },
    },
    {
      op: "set_node",
      node_id: blockAddress(doc, id),
      match_text: "Plan for Q4",
      attrs: { level: 3 },
    },
    { op: "set_node", node_id: blockAddress(doc, id), match_text: "2", attrs: { align: "right" } },
    {
      op: "replace_match",
      node_id: blockAddress(doc, id),
      match_text: "Intro",
      replacement: "Opening",
    },
  ]);
  assert.deepEqual(
    outline(after, id).map((entry) => entry.node_id),
    before,
  );
  // Retyping keeps the marker, so it keeps the id.
  after = patch(after, [
    {
      op: "set_node",
      node_id: blockAddress(doc, id),
      match_text: "Closing",
      type: "heading",
      attrs: { level: 2 },
    },
  ]);
  assert.equal(outline(after, id).at(-1).type, "heading");
  assert.equal(outline(after, id).at(-1).node_id, before.at(-1));
  // A concurrent writer inserting a node earlier in the block shifts the
  // position of every node after it, and no node_id.
  const peer = A.change(A.clone(doc, { actor: "ab".repeat(16) }), (draft) => {
    const at = draft.blocks[id].richText.indexOf("Closing") - 1;
    A.splitBlock(draft, textPath(id), at, {
      type: S("paragraph"),
      parents: [],
      attrs: {},
      isEmbed: false,
    });
    A.splice(draft, textPath(id), at + 1, 0, "Inserted by a peer");
  });
  const merged = A.merge(A.clone(after), peer);
  const entries = outline(merged, id);
  assert.equal(entries.length, before.length + 1);
  for (const nodeId of before.slice(1))
    assert.ok(
      entries.some((entry) => entry.node_id === nodeId),
      nodeId,
    );
});

test("a block's id and its nodes' ids hold through rewrites, moves, save and load, and merges", () => {
  const { doc: base, id } = fixture("## Plan\n\nFirst words\n\n---\n\nClosing words");
  const doc = edit(base, [{ op: "insert_markdown", markdown: "Second block" }]).doc;
  const [, second] = orderedBlockIds(doc);
  const block = blockAddress(doc, id);
  const nodes = nodeAddresses(doc, id);
  const peer = A.change(A.clone(doc, { actor: "cd".repeat(16) }), (draft) =>
    A.splice(draft, textPath(id), draft.blocks[id].richText.indexOf("First") + 5, 0, " typed"),
  );
  const rewrite = edit(doc, [
    { op: "replace_block_markdown", node_id: block, markdown: "## New\n\nText" },
  ]);
  // A rewrite reports the block's id and its nodes' ids as they are now.
  assert.deepEqual(rewrite.result.edits, [
    { op: "replace_block_markdown", node_id: block, nodes: nodeAddresses(rewrite.doc, id) },
  ]);
  // Each row: what happened, the document after it, and whether the block's
  // nodes keep their ids. A Markdown rewrite keeps the block's id; its nodes
  // keep theirs only where the rewrite keeps them.
  const rows = [
    ["replace_block_markdown", rewrite.doc, false],
    [
      "move_block after another block",
      edit(doc, [{ op: "move_block", node_id: block, after_node_id: blockAddress(doc, second) }])
        .doc,
      true,
    ],
    [
      "move_block to the start",
      edit(doc, [{ op: "move_block", node_id: blockAddress(doc, second), after_node_id: null }])
        .doc,
      true,
    ],
    ["save and load", A.load(A.save(doc)), true],
    ["merge with a peer typing in the block", A.merge(A.clone(doc), peer), true],
  ];
  for (const [label, after, keepsNodes] of rows) {
    assert.ok(Object.hasOwn(after.blocks, id), label);
    assert.equal(blockAddress(after, id), block, label);
    assert.deepEqual(resolve(after, block), { kind: "block", key: id }, label);
    assert.equal(outline(after, id)[0].block, block, label);
    if (keepsNodes) assert.deepEqual(nodeAddresses(after, id), nodes, label);
  }
  // The moves put the block where they said.
  assert.deepEqual(orderedBlockIds(rows[1][1]), [second, id]);
  assert.deepEqual(orderedBlockIds(rows[2][1]), [second, id]);
});

test("delete_node removes one node and leaves its neighbours and their ids alone", () => {
  const { doc, id } = fixture();
  const ids = outline(doc, id).map((entry) => entry.node_id);
  const table = idOf(doc, id, "table");
  const { doc: after, result } = edit(doc, [{ op: "delete_node", node_id: table }]);
  assert.deepEqual(result.edits, [
    { op: "delete_node", node_id: table, block: blockAddress(doc, id), type: "table" },
  ]);
  assert.equal(
    blockMarkdown(after.blocks[id]),
    projected(SOURCE.replace("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n", "")),
  );
  assert.deepEqual(
    outline(after, id).map((entry) => entry.node_id),
    ids.filter((nodeId) => nodeId !== table),
  );
  // Every kind of top-level node, including ones with no text.
  for (const [type, removed] of [
    ["bullet-list", "- one\n- two\n\n"],
    ["blockquote", "> quoted\n\n"],
    ["horizontal-rule", "---\n\n"],
    ["heading", "## Plan\n\n"],
  ]) {
    const deleted = edit(doc, [{ op: "delete_node", node_id: idOf(doc, id, type) }]).doc;
    assert.equal(blockMarkdown(deleted.blocks[id]), projected(SOURCE.replace(removed, "")), type);
    richDoc(deleted.blocks[id], pageId).schema.validate(richDoc(deleted.blocks[id], pageId));
  }
  // The last node: its range runs to the end of the text.
  const last = outline(doc, id).at(-1).node_id;
  const trimmed = edit(doc, [{ op: "delete_node", node_id: last }]).doc;
  assert.equal(
    blockMarkdown(trimmed.blocks[id]),
    projected(SOURCE.replace("\n\nClosing words", "")),
  );
});

test("deleting the node that opens a block leaves the next node, and its id, as they were", () => {
  const { doc, id } = fixture("## Heading\n\nFirst paragraph\n\nSecond");
  const heading = idOf(doc, id, "heading");
  const after = edit(doc, [{ op: "delete_node", node_id: heading }]).doc;
  assert.equal(blockMarkdown(after.blocks[id]), "First paragraph\n\nSecond");
  // "First paragraph" now opens the block with its own marker and id.
  const [first] = A.spans(after, textPath(id));
  assert.equal(String(first.value.type), "paragraph");
  assert.equal(outline(after, id)[0].node_id, outline(doc, id)[1].node_id);
  assert.equal(outline(after, id)[1].node_id, outline(doc, id)[2].node_id);
});

test("delete_node on a block's only node, set_node on its first paragraph, and an insert before it", () => {
  const { doc, id } = fixture("Only words");
  const [only] = outline(doc, id);
  assert.equal(typeof only.node_id, "string");
  // A block always holds a node: the deleted one becomes one empty paragraph
  // with a marker, and an id, of its own.
  const emptied = edit(doc, [{ op: "delete_node", node_id: only.node_id }]).doc;
  assert.equal(blockMarkdown(emptied.blocks[id]), "");
  const [left] = outline(emptied, id);
  assert.equal(left.type, "paragraph");
  assert.equal(typeof left.node_id, "string");
  assert.notEqual(left.node_id, only.node_id);
  // set_node turns the first paragraph into a heading in place: same marker, same id.
  const heading = patch(doc, [
    {
      op: "set_node",
      node_id: blockAddress(doc, id),
      match_text: "Only",
      type: "heading",
      attrs: { level: 2 },
    },
  ]);
  assert.deepEqual(
    outline(heading, id).map((entry) => [entry.type, entry.node_id]),
    [["heading", only.node_id]],
  );
  // A node a peer inserts before the first one leaves its id alone.
  const inserted = A.change(A.clone(doc), (draft) => {
    A.splitBlock(draft, textPath(id), 0, {
      type: S("horizontal-rule"),
      parents: [],
      attrs: {},
      isEmbed: false,
    });
  });
  assert.deepEqual(
    outline(inserted, id).map((entry) => entry.type),
    ["horizontal-rule", "paragraph"],
  );
  assert.equal(outline(inserted, id)[1].node_id, only.node_id);
});

test("delete_node removes a dataframe and an unknown node, which have no text", () => {
  let { doc } = fixture("Intro");
  doc = edit(doc, [
    { op: "insert_node", node: { type: "dataframe", attrs: { asset_id: assetId, title: "T" } } },
  ]).doc;
  const block = orderedBlockIds(doc)[1];
  const [frame] = outline(doc, block);
  assert.equal(frame.type, "dataframe");
  const emptied = edit(doc, [{ op: "delete_node", node_id: frame.node_id }]).doc;
  assert.equal(blockMarkdown(emptied.blocks[block]), "");
  assert.deepEqual(
    A.spans(emptied, textPath(block)).map((span) => String(span.value.type)),
    ["paragraph"],
  );

  const unknown = fixture("Before\n\nAfter");
  const withChart = A.change(unknown.doc, (draft) =>
    A.splitBlock(
      draft,
      textPath(unknown.id),
      draft.blocks[unknown.id].richText.indexOf("After") - 1,
      {
        type: S("future-chart"),
        parents: [],
        attrs: { title: S("Usage") },
        isEmbed: false,
      },
    ),
  );
  const chart = outline(withChart, unknown.id).find((entry) => entry.type === "unknown");
  assert.equal(chart.node_type, "future-chart");
  const cleaned = edit(withChart, [{ op: "delete_node", node_id: chart.node_id }]).doc;
  assert.equal(blockMarkdown(cleaned.blocks[unknown.id]), "Before\n\nAfter");
});

test("ids after a node read through notice text still name their own markers", () => {
  // A dataframe naming another Page's asset reads as a notice paragraph,
  // longer than the stored leaf. The nodes after it keep the right ids.
  const { doc: base, id } = fixture("Intro\n\nAfter\n\n## Heading");
  const other = "55555555-5555-4555-8555-555555555555";
  const doc = A.change(base, (draft) =>
    A.splitBlock(draft, textPath(id), draft.blocks[id].richText.indexOf("After") - 1, {
      type: S("dataframe"),
      parents: [],
      attrs: {
        src: S(`/api/pages/${other}/assets/${assetId}`),
        media_type: S("application/vnd.apache.parquet"),
      },
      isEmbed: false,
    }),
  );
  const entries = outline(doc, id);
  assert.equal(entries[1].type, "paragraph");
  assert.match(blockMarkdown(doc.blocks[id], pageId), /Unsupported node: dataframe/);
  const heading = entries.find((entry) => entry.type === "heading");
  const after = edit(doc, [{ op: "delete_node", node_id: heading.node_id }]).doc;
  assert.doesNotMatch(blockMarkdown(after.blocks[id], pageId), /Heading/);
  assert.match(blockMarkdown(after.blocks[id], pageId), /After/);
  // And the foreign dataframe itself can be removed by id.
  const cleaned = edit(doc, [{ op: "delete_node", node_id: entries[1].node_id }]).doc;
  assert.equal(blockMarkdown(cleaned.blocks[id], pageId), "Intro\n\nAfter\n\n## Heading");
});

test("a block the binding can't place reads with null ids, and its stored markers name nothing", () => {
  const { doc: base, id } = fixture("| a | b |\n| --- | --- |\n| After | 2 |\n\n## Heading");
  const doc = A.change(base, (draft) =>
    A.splitBlock(draft, textPath(id), draft.blocks[id].richText.indexOf("After") + 2, {
      type: S("future-chart"),
      parents: [S("table"), S("table-row"), S("table-cell")],
      attrs: {},
      isEmbed: false,
    }),
  );
  const entries = outline(doc, id);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => entry.node_id === null));
  // The heading's stored marker is a cursor, but the block gives its nodes
  // no ids, so it names nothing; delete_block still takes the block's id.
  const heading = A.getCursor(doc, textPath(id), doc.blocks[id].richText.indexOf("Heading") - 1);
  for (const node_id of [heading, "1@" + "0".repeat(32)])
    refuses(doc, [{ op: "delete_node", node_id }], (error) => error.code === "node_not_found");
  const removed = edit(doc, [
    { op: "insert_markdown", markdown: "Kept" },
    { op: "delete_block", node_id: blockAddress(doc, id) },
  ]).doc;
  assert.equal(Object.hasOwn(removed.blocks, id), false);
});

test("delete_node refuses an id that doesn't name a live node", () => {
  const { doc, id } = fixture();
  const table = idOf(doc, id, "table");
  const gone = edit(doc, [{ op: "delete_node", node_id: table }]).doc;
  const notFound = (error) =>
    error.code === "node_not_found" && /read the Page again/i.test(error.message);
  refuses(gone, [{ op: "delete_node", node_id: table }], notFound);
  // An id names its node in whichever block holds it, with no block beside it.
  const other = edit(doc, [{ op: "insert_markdown", markdown: "## Elsewhere\n\nStays" }]).doc;
  const otherId = orderedBlockIds(other)[1];
  const elsewhere = edit(other, [
    { op: "delete_node", node_id: outline(other, otherId)[0].node_id },
  ]).doc;
  assert.equal(blockMarkdown(elsewhere.blocks[otherId]), "Stays");
  assert.equal(blockMarkdown(elsewhere.blocks[id]), blockMarkdown(doc.blocks[id]));
  // A cursor at a text character, not a node's opening marker.
  refuses(doc, [{ op: "delete_node", node_id: A.getCursor(doc, textPath(id), 2) }], notFound);
  for (const node_id of [undefined, null, "", 7, id, `1@${"a".repeat(MAX_NODE_ID)}`])
    refuses(doc, [{ op: "delete_node", node_id }], /node_id must be an id from read_page/);
  // A block's id names a block, which delete_node doesn't take.
  refuses(
    doc,
    [{ op: "delete_node", node_id: blockAddress(doc, id) }],
    (error) => error.code === "wrong_address_kind" && error.status === 400,
  );
  // block_id is not a field of the operation.
  refuses(doc, [{ op: "delete_node", block_id: id, node_id: table }], /does not take block_id/);
  // Nothing in the batch applies when one delete_node is refused.
  refuses(
    doc,
    [
      { op: "delete_node", node_id: idOf(doc, id, "heading") },
      { op: "delete_node", node_id: "1@" + "0".repeat(32) },
    ],
    notFound,
  );
});

test("two deletes in one batch use ids, so the first doesn't shift the second", () => {
  const { doc, id } = fixture();
  const { doc: after, result } = edit(doc, [
    { op: "delete_node", node_id: idOf(doc, id, "heading") },
    { op: "delete_node", node_id: idOf(doc, id, "horizontal-rule") },
  ]);
  assert.deepEqual(
    result.edits.map((entry) => entry.type),
    ["heading", "horizontal-rule"],
  );
  assert.equal(
    blockMarkdown(after.blocks[id]),
    projected(SOURCE.replace("## Plan\n\n", "").replace("---\n\n", "")),
  );
});

test("concurrent deletes of the same node, or a delete beside a text edit, merge cleanly", () => {
  const { doc, id } = fixture();
  const quote = idOf(doc, id, "blockquote");
  const one = edit(A.clone(doc, { actor: "01".repeat(16) }), [
    { op: "delete_node", node_id: quote },
  ]).doc;
  const two = edit(A.clone(doc, { actor: "02".repeat(16) }), [
    { op: "delete_node", node_id: quote },
  ]).doc;
  const both = A.merge(A.clone(one), two);
  assert.equal(blockMarkdown(both.blocks[id]), blockMarkdown(one.blocks[id]));
  const typed = patch(A.clone(doc, { actor: "03".repeat(16) }), [
    {
      op: "replace_match",
      node_id: blockAddress(doc, id),
      match_text: "Closing",
      replacement: "Final",
    },
  ]);
  const merged = A.merge(A.clone(one), typed);
  richDoc(merged.blocks[id], pageId).schema.validate(richDoc(merged.blocks[id], pageId));
  assert.match(blockMarkdown(merged.blocks[id]), /Final words$/);
  assert.doesNotMatch(blockMarkdown(merged.blocks[id]), /quoted/);
});

test("read_page_changes names the node it reports by id, deleted ones included", () => {
  const { doc, id } = fixture();
  const table = idOf(doc, id, "table");
  const heading = idOf(doc, id, "heading");
  let after = edit(doc, [{ op: "delete_node", node_id: table }]).doc;
  after = patch(after, [
    {
      op: "replace_match",
      node_id: blockAddress(doc, id),
      match_text: "Plan",
      replacement: "Roadmap",
    },
  ]);
  const { changes } = projectReadChanges(after, { since_heads: A.getHeads(doc) });
  const deleted = changes.find((change) => change.change === "deleted");
  assert.equal(deleted.node_id, table);
  assert.equal(deleted.type, "table");
  const updated = changes.find((change) => change.change === "updated");
  assert.equal(updated.node_id, heading);
  assert.equal(resolve(after, heading).index, 1);
});

test("every node kind gets an id at its own opening marker", () => {
  const { doc, id } = fixture(
    [
      "Intro",
      "```js\nlet x = 1;\n```",
      "1. one\n2. two",
      "- [ ] task\n- [x] done",
      "- outer\n  - inner",
      "> quoted\n>\n> - listed",
      "Closing",
    ].join("\n\n"),
  );
  const entries = outline(doc, id);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    [
      "paragraph",
      "code-block",
      "ordered-list",
      "task-list",
      "bullet-list",
      "blockquote",
      "paragraph",
    ],
  );
  // Each id is the cursor at the first non-embed top-level marker of its
  // node, found here by scanning the stored spans, not through nodeIds.
  const opening = [];
  let at = 0,
    previous = null;
  for (const span of A.spans(doc, textPath(id))) {
    if (span.type === "block" && !span.value.isEmbed && !span.value.parents.length) {
      const type = String(span.value.type);
      // Items of one list share a list; only the first opens it.
      if (!(type.endsWith("-list-item") && type === previous)) opening.push(at);
      previous = type;
    }
    at += span.type === "text" ? span.value.length : 1;
  }
  assert.deepEqual(
    entries.map((entry) => entry.node_id),
    opening.map((index) => A.getCursor(doc, textPath(id), index)),
  );
  // Each kind deletes cleanly, and only itself.
  for (const entry of entries) {
    const after = edit(doc, [{ op: "delete_node", node_id: entry.node_id }]).doc;
    assert.deepEqual(
      outline(after, id).map((rest) => rest.node_id),
      entries.map((rest) => rest.node_id).filter((nodeId) => nodeId !== entry.node_id),
      entry.type,
    );
  }
});

test("a batch can delete the opening node and the paragraph after it", () => {
  const { doc, id } = fixture("## H\n\nP1\n\nP2");
  const [heading, first, second] = outline(doc, id).map((entry) => entry.node_id);
  const { doc: after, result } = edit(doc, [
    { op: "delete_node", node_id: heading },
    { op: "delete_node", node_id: first },
  ]);
  assert.deepEqual(
    result.edits.map((entry) => entry.type),
    ["heading", "paragraph"],
  );
  assert.equal(blockMarkdown(after.blocks[id]), "P2");
  // P2 now opens the block, with its own marker and id.
  assert.deepEqual(
    outline(after, id).map((entry) => entry.node_id),
    [second],
  );
  // In the other order too.
  const reversed = edit(doc, [
    { op: "delete_node", node_id: first },
    { op: "delete_node", node_id: heading },
  ]).doc;
  assert.equal(blockMarkdown(reversed.blocks[id]), "P2");
  assert.deepEqual(
    outline(reversed, id).map((entry) => entry.node_id),
    [second],
  );
});

test("delete_node refuses to join the lists on either side into one", () => {
  const { doc, id } = fixture("Intro\n\n- a\n\n---\n\n- b");
  const rule = idOf(doc, id, "horizontal-rule");
  refuses(
    doc,
    [{ op: "delete_node", node_id: rule }],
    (error) =>
      error.code === "nodes_would_join" &&
      /would join the bullet-list before this node and the bullet-list after it into one/.test(
        error.message,
      ),
  );
  // Stored content can lack the marker of a quote whose first child is a
  // list (the ProseMirror adapter's form): the list item names the quote only
  // as a parent, so deleting the rule would reopen the quote above. Refused.
  const legacy = fixture("Intro");
  legacy.doc = A.change(legacy.doc, (draft) =>
    A.updateSpans(
      draft,
      textPath(legacy.id),
      encode(parseMarkdown("Intro\n\n> a\n\n---\n\n> - x")).filter(
        (span, index, spans) =>
          !(
            span.type === "block" &&
            String(span.value.type) === "blockquote" &&
            spans[index + 1]?.type === "block" &&
            String(spans[index + 1].value.type) === "unordered-list-item"
          ),
      ),
      updateSpansConfig,
    ),
  );
  refuses(
    legacy.doc,
    [
      {
        op: "delete_node",
        node_id: idOf(legacy.doc, legacy.id, "horizontal-rule"),
      },
    ],
    /would join the blockquote before this node and the blockquote after it into one/,
  );
  // Pages writes that quote's own marker, as the editor does, so the same
  // delete leaves two quotes.
  const quoted = fixture("Intro\n\n> a\n\n---\n\n> - x");
  const apart = edit(quoted.doc, [
    {
      op: "delete_node",
      node_id: idOf(quoted.doc, quoted.id, "horizontal-rule"),
    },
  ]).doc;
  assert.deepEqual(
    outline(apart, quoted.id).map((entry) => entry.type),
    ["paragraph", "blockquote", "blockquote"],
  );
  assert.equal(blockMarkdown(apart.blocks[quoted.id]), "Intro\n\n> a\n\n> - x");
  // Different kinds of list stay separate, so that delete goes through.
  const mixed = fixture("Intro\n\n- a\n\n---\n\n1. b");
  const after = edit(mixed.doc, [
    {
      op: "delete_node",
      node_id: idOf(mixed.doc, mixed.id, "horizontal-rule"),
    },
  ]).doc;
  assert.deepEqual(
    outline(after, mixed.id).map((entry) => entry.type),
    ["paragraph", "bullet-list", "ordered-list"],
  );
  // Deleting the rule and one of the lists in the same batch is fine.
  const both = edit(doc, [
    { op: "delete_node", node_id: idOf(doc, id, "bullet-list") },
    { op: "delete_node", node_id: rule },
  ]).doc;
  assert.equal(blockMarkdown(both.blocks[id]), "Intro\n\n- b");
});

test("a node's range ends where the reader ends it, unmarked text after it included", () => {
  // A code block with an image after it, as a merge leaves it: the image
  // opens a paragraph of unmarked text.
  const { doc, id } = pageWithSpans(SHAPES["image-after-code"]);
  const ids = nodeIds(doc, id);
  assert.deepEqual(
    ids.map(({ id: nodeId, at, end }) => [nodeId === null, at, end]),
    [
      [false, 0, 2],
      [true, null, 4],
      [false, 4, 6],
    ],
  );
  const code = resolveAddress(addressIndex(doc), ids[0].id);
  assert.deepEqual([code.start, code.end], [0, 2]);
});

test("delete_node beside a peer typing into the same node merges into a valid tree", () => {
  const { doc, id } = fixture();
  const quote = idOf(doc, id, "blockquote");
  const deleted = edit(A.clone(doc, { actor: "04".repeat(16) }), [
    { op: "delete_node", node_id: quote },
  ]).doc;
  const typed = patch(A.clone(doc, { actor: "05".repeat(16) }), [
    {
      op: "replace_match",
      node_id: blockAddress(doc, id),
      match_text: "quoted",
      replacement: "quoted text",
    },
  ]);
  const merged = A.merge(A.clone(deleted), typed);
  richDoc(merged.blocks[id], pageId).schema.validate(richDoc(merged.blocks[id], pageId));
  assert.ok(outline(merged, id).every((entry) => entry.node_id !== quote));
  // The quote's own text is gone. The peer's new characters survive (a
  // delete removes only what it saw) and join the end of the node before:
  // the list's last item.
  const markdown = blockMarkdown(merged.blocks[id]);
  assert.doesNotMatch(markdown, /quoted/);
  assert.match(markdown, /- two text\n/);
  assert.equal(outline(merged, id).length, outline(deleted, id).length);
});

test("text a peer typed into a node deleted after a rule or dataframe reads as a paragraph", () => {
  const src = `/api/pages/${pageId}/assets/${assetId}`;
  const doomed = () => Paragraph.create([Leaf.text("doomed words")]);
  for (const [leaf, types, markdown] of [
    [HorizontalRule, ["paragraph", "horizontal-rule", "paragraph"], "Intro\n\n---\n\nkept"],
    [
      Blockquote.create([PagesDataframe.of({ src, media_type: "application/vnd.apache.parquet" })]),
      ["paragraph", "blockquote"],
      `Intro\n\n> [Dataframe](${src})\n>\n> kept`,
    ],
  ]) {
    let doc = A.change(A.from(createPageData({ pageId, title: "Node ids" })), (draft) =>
      initializePage(draft),
    );
    const id = orderedBlockIds(doc)[0];
    const tree = schema.doc([Paragraph.create([Leaf.text("Intro")]), leaf, doomed()]);
    doc = A.change(doc, (draft) => {
      draft.blocks[id].richText = "";
      A.updateSpans(draft, textPath(id), encode(tree), updateSpansConfig);
    });
    const last = outline(doc, id).at(-1).node_id;
    const deleted = edit(A.clone(doc, { actor: "04".repeat(16) }), [
      { op: "delete_node", node_id: last },
    ]).doc;
    const typed = patch(A.clone(doc, { actor: "05".repeat(16) }), [
      {
        op: "replace_match",
        node_id: blockAddress(doc, id),
        match_text: "doomed",
        replacement: "kept",
      },
    ]);
    const merged = A.merge(A.clone(deleted), typed);
    // The peer's characters follow the leaf directly, with no marker opening
    // them: unmarked text. They read as a paragraph beside it, as the editor
    // draws them.
    assert.deepEqual(
      outline(merged, id).map((entry) => entry.type),
      types,
    );
    assert.equal(blockMarkdown(merged.blocks[id], pageId), markdown);
    richDoc(merged.blocks[id], pageId).schema.validate(richDoc(merged.blocks[id], pageId));
    assert.equal(decode(A.spans(merged, textPath(id))).unmarked.length, 1);
    expectMarkedByNextWrite(merged, id, markdown);
  }
});

/** `doc`'s block `id` holds unmarked text. A top-level paragraph of it has a
 * null node_id; the next host write to the block marks it, so every node has
 * an id, and the block reads as `markdown` with the write's own edit. */
function expectMarkedByNextWrite(doc, id, markdown) {
  const entries = outline(doc, id);
  const unmarkedTopLevel = blockAddresses(A.spans(doc, textPath(id))).nodes.some(
    (node) => node.at === null,
  );
  assert.equal(
    entries.some((entry) => entry.node_id === null),
    unmarkedTopLevel,
  );
  const written = patch(doc, [
    {
      op: "replace_match",
      node_id: blockAddress(doc, id),
      match_text: "Intro",
      replacement: "Opening",
    },
  ]);
  assert.deepEqual(decode(A.spans(written, textPath(id))).unmarked, []);
  for (const entry of outline(written, id)) assert.equal(typeof entry.node_id, "string");
  // Ids the merged block had stay.
  for (const entry of entries)
    if (entry.node_id !== null)
      assert.ok(outline(written, id).some((after) => after.node_id === entry.node_id));
  assert.equal(blockMarkdown(written.blocks[id], pageId), markdown.replace("Intro", "Opening"));
}

test("text a merge leaves with no marker reads, has no id, and the next write marks it", () => {
  // The block's first node deleted while a peer types into it.
  {
    const { doc, id } = fixture("Intro words\n\nSecond");
    const deleted = edit(A.clone(doc, { actor: "0a".repeat(16) }), [
      { op: "delete_node", node_id: outline(doc, id)[0].node_id },
    ]).doc;
    const typed = patch(A.clone(doc, { actor: "0b".repeat(16) }), [
      {
        op: "replace_match",
        node_id: blockAddress(doc, id),
        match_text: "words",
        replacement: "words typed",
      },
    ]);
    const merged = A.merge(A.clone(deleted), typed);
    assert.equal(A.spans(merged, textPath(id))[0].type, "text");
    assert.equal(blockMarkdown(merged.blocks[id], pageId), " typed\n\nSecond");
    assert.deepEqual(
      outline(merged, id).map((entry) => [entry.type, entry.node_id === null]),
      [
        ["paragraph", true],
        ["paragraph", false],
      ],
    );
    // A later write elsewhere in the block marks it.
    const written = patch(merged, [
      {
        op: "replace_match",
        node_id: blockAddress(doc, id),
        match_text: "Second",
        replacement: "Last",
      },
    ]);
    assert.equal(blockMarkdown(written.blocks[id], pageId), " typed\n\nLast");
    for (const entry of outline(written, id)) assert.equal(typeof entry.node_id, "string");
  }
  // The node after a rule deleted while a peer types into it.
  {
    const { doc, id } = fixture("Intro\n\n---\n\nDoomed words");
    const deleted = edit(A.clone(doc, { actor: "0a".repeat(16) }), [
      { op: "delete_node", node_id: outline(doc, id)[2].node_id },
    ]).doc;
    const typed = patch(A.clone(doc, { actor: "0b".repeat(16) }), [
      {
        op: "replace_match",
        node_id: blockAddress(doc, id),
        match_text: "Doomed",
        replacement: "Kept",
      },
    ]);
    const merged = A.merge(A.clone(deleted), typed);
    assert.equal(blockMarkdown(merged.blocks[id], pageId), "Intro\n\n---\n\nKept");
    expectMarkedByNextWrite(merged, id, "Intro\n\n---\n\nKept");
  }
  // The editor deletes a quote's first paragraph while a peer types into it.
  {
    const { doc, id } = fixture("Intro\n\n> first\n>\n> second");
    const deleted = A.change(A.clone(doc, { actor: "0a".repeat(16) }), (draft) => {
      const from = draft.blocks[id].richText.indexOf("first") - 1;
      A.splice(draft, textPath(id), from, "first".length + 1);
    });
    const typed = A.change(A.clone(doc, { actor: "0b".repeat(16) }), (draft) => {
      A.splice(draft, textPath(id), draft.blocks[id].richText.indexOf("first") + 5, 0, " typed");
    });
    const merged = A.merge(A.clone(deleted), typed);
    assert.equal(blockMarkdown(merged.blocks[id], pageId), "Intro\n\n>  typed\n>\n> second");
    expectMarkedByNextWrite(merged, id, "Intro\n\n>  typed\n>\n> second");
  }
});

test("a list's id is its first item's marker, and goes when that marker does", () => {
  const { doc, id } = fixture("Intro\n\n- one\n- two\n- three\n\n## After");
  const list = idOf(doc, id, "bullet-list");
  // An edit inside a later item keeps it.
  const edited = patch(doc, [
    {
      op: "replace_match",
      node_id: blockAddress(doc, id),
      match_text: "three",
      replacement: "third",
    },
  ]);
  assert.equal(idOf(edited, id, "bullet-list"), list);
  // The editor deleting the first item removes its marker and text, as a
  // peer would.
  const rewritten = A.change(A.clone(doc), (draft) => {
    const text = draft.blocks[id].richText;
    const from = text.indexOf("one") - 2;
    A.splice(draft, textPath(id), from, text.indexOf("two") - 2 - from);
  });
  assert.match(blockMarkdown(rewritten.blocks[id]), /^Intro\n\n- two\n- three/);
  const next = idOf(rewritten, id, "bullet-list");
  assert.equal(typeof next, "string");
  assert.notEqual(next, list);
  assert.throws(
    () => edit(rewritten, [{ op: "delete_node", node_id: list }]),
    (error) => error.code === "node_not_found",
  );
});

test("read_page_changes reports a block without node ids as a whole block", () => {
  const { doc: base, id } = fixture("| a | b |\n| --- | --- |\n| After | 2 |\n\n## Heading");
  const since = A.getHeads(base);
  const doc = A.change(base, (draft) =>
    A.splitBlock(draft, textPath(id), draft.blocks[id].richText.indexOf("After") + 2, {
      type: S("future-chart"),
      parents: [S("table"), S("table-row"), S("table-cell")],
      attrs: {},
      isEmbed: false,
    }),
  );
  const { changes } = projectReadChanges(doc, { since_heads: since });
  assert.deepEqual(
    changes.map((change) => [change.scope, change.change]),
    [["block", "updated"]],
  );
  assert.match(changes[0].markdown, /Unsupported node: future-chart/);
});

test("a task list keeps its id when an item is checked", () => {
  const { doc, id } = fixture("Intro\n\n- [ ] first\n- [ ] second\n\n## After");
  const list = idOf(doc, id, "task-list");
  for (const target of ["first", "second"]) {
    const checked = patch(doc, [
      {
        op: "set_node",
        node_id: blockAddress(doc, id),
        match_text: target,
        attrs: { checked: true },
      },
    ]);
    assert.match(blockMarkdown(checked.blocks[id]), new RegExp(`- \\[x\\] ${target}`));
    assert.equal(idOf(checked, id, "task-list"), list, target);
  }
});
