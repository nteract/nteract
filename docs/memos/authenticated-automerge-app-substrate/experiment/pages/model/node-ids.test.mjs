// Node ids and delete_node: a top-level node's id survives edits around and
// inside it, and delete_node removes exactly that node.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { blockMarkdown, richDoc, textPath } from "./richtext.mjs";
import { projectReadContent } from "./read-content.mjs";
import { projectReadChanges } from "./read-changes.mjs";
import { nodeIds, resolveNodeId } from "./node-ids.mjs";

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
const patch = (doc, operations) => run(doc, "patch_page", operations).doc;
const outline = (doc, id) =>
  projectReadContent(doc, { include_content: false }).outline.filter(
    (entry) => entry.block_id === id,
  );
const idOf = (doc, id, type) => outline(doc, id).find((entry) => entry.type === type).node_id;
const refuses = (doc, operations, check) => assert.throws(() => edit(doc, operations), check);

test("the outline gives every top-level node an id but the block's opening paragraph", () => {
  const { doc, id } = fixture();
  const entries = outline(doc, id);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["paragraph", "heading", "bullet-list", "blockquote", "table", "horizontal-rule", "paragraph"],
  );
  // The opening paragraph has no marker. The image inside it is a marker too,
  // but an inline one, so it doesn't give the paragraph an id.
  assert.equal(entries[0].node_id, null);
  for (const entry of entries.slice(1)) assert.equal(typeof entry.node_id, "string");
  assert.equal(new Set(entries.map((entry) => entry.node_id)).size, entries.length);
  // The id is the cursor at the node's opening marker.
  const spans = A.spans(doc, textPath(id));
  for (const { id: nodeId, at } of nodeIds(doc, id).slice(1)) {
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

test("a node keeps its id through text, mark and attribute edits and edits around it", () => {
  const { doc, id } = fixture();
  const before = outline(doc, id).map((entry) => entry.node_id);
  let after = patch(doc, [
    { op: "replace_match", block_id: id, match_text: "Plan", replacement: "Plan for Q4" },
    { op: "format_match", block_id: id, match_text: "quoted", add: { strong: true } },
    { op: "set_node", block_id: id, match_text: "Plan for Q4", attrs: { level: 3 } },
    { op: "set_node", block_id: id, match_text: "2", attrs: { align: "right" } },
    { op: "replace_match", block_id: id, match_text: "Intro", replacement: "Opening" },
  ]);
  assert.deepEqual(
    outline(after, id).map((entry) => entry.node_id),
    before,
  );
  // Retyping keeps the marker, so it keeps the id.
  after = patch(after, [
    { op: "set_node", block_id: id, match_text: "Closing", type: "heading", attrs: { level: 2 } },
  ]);
  assert.equal(outline(after, id).at(-1).type, "heading");
  assert.equal(outline(after, id).at(-1).node_id, before.at(-1));
  // A concurrent writer inserting a node earlier in the block shifts every
  // node_index after it, and no node_id.
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

test("delete_node removes one node and leaves its neighbours and their ids alone", () => {
  const { doc, id } = fixture();
  const ids = outline(doc, id).map((entry) => entry.node_id);
  const table = idOf(doc, id, "table");
  const { doc: after, result } = edit(doc, [{ op: "delete_node", block_id: id, node_id: table }]);
  assert.deepEqual(result.edits, [
    { op: "delete_node", block_id: id, node_id: table, type: "table" },
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
    const deleted = edit(doc, [
      { op: "delete_node", block_id: id, node_id: idOf(doc, id, type) },
    ]).doc;
    assert.equal(blockMarkdown(deleted.blocks[id]), projected(SOURCE.replace(removed, "")), type);
    richDoc(deleted.blocks[id], pageId).check();
  }
  // The last node: its range runs to the end of the text.
  const last = outline(doc, id).at(-1).node_id;
  const trimmed = edit(doc, [{ op: "delete_node", block_id: id, node_id: last }]).doc;
  assert.equal(
    blockMarkdown(trimmed.blocks[id]),
    projected(SOURCE.replace("\n\nClosing words", "")),
  );
});

test("deleting the node that opens a block leaves the next paragraph as the editor writes it", () => {
  const { doc, id } = fixture("## Heading\n\nFirst paragraph\n\nSecond");
  const heading = idOf(doc, id, "heading");
  const after = edit(doc, [{ op: "delete_node", block_id: id, node_id: heading }]).doc;
  assert.equal(blockMarkdown(after.blocks[id]), "First paragraph\n\nSecond");
  // No plain paragraph marker at 0: the editor would delete it on the next
  // structural edit and write history.
  const [first] = A.spans(after, textPath(id));
  assert.equal(first.type, "text");
  // "First paragraph" now opens the block, so it has no id; "Second" keeps its.
  assert.equal(outline(after, id)[0].node_id, null);
  assert.equal(outline(after, id)[1].node_id, outline(doc, id)[2].node_id);
});

test("delete_node removes a dataframe and an unknown node, which have no text", () => {
  let { doc } = fixture("Intro");
  doc = edit(doc, [
    { op: "insert_node", node: { type: "dataframe", attrs: { asset_id: assetId, title: "T" } } },
  ]).doc;
  const block = orderedBlockIds(doc)[1];
  const [frame] = outline(doc, block);
  assert.equal(frame.type, "dataframe");
  const emptied = edit(doc, [{ op: "delete_node", block_id: block, node_id: frame.node_id }]).doc;
  assert.equal(blockMarkdown(emptied.blocks[block]), "");
  assert.deepEqual(A.spans(emptied, textPath(block)), []);

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
  const cleaned = edit(withChart, [
    { op: "delete_node", block_id: unknown.id, node_id: chart.node_id },
  ]).doc;
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
  const after = edit(doc, [{ op: "delete_node", block_id: id, node_id: heading.node_id }]).doc;
  assert.doesNotMatch(blockMarkdown(after.blocks[id], pageId), /Heading/);
  assert.match(blockMarkdown(after.blocks[id], pageId), /After/);
  // And the foreign dataframe itself can be removed by id.
  const cleaned = edit(doc, [{ op: "delete_node", block_id: id, node_id: entries[1].node_id }]).doc;
  assert.equal(blockMarkdown(cleaned.blocks[id], pageId), "Intro\n\nAfter\n\n## Heading");
});

test("a block the binding can't place reads with null ids, and delete_node points to delete_block", () => {
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
  refuses(
    doc,
    [{ op: "delete_node", block_id: id, node_id: "1@" + "0".repeat(32) }],
    (error) => error.code === "node_not_found" && /delete_block/.test(error.message),
  );
});

test("delete_node refuses an id that doesn't name a live node in the block", () => {
  const { doc, id } = fixture();
  const table = idOf(doc, id, "table");
  const gone = edit(doc, [{ op: "delete_node", block_id: id, node_id: table }]).doc;
  const notFound = (error) =>
    error.code === "node_not_found" && /read the outline again/i.test(error.message);
  refuses(gone, [{ op: "delete_node", block_id: id, node_id: table }], notFound);
  // Another block's id names nothing here.
  const other = edit(doc, [{ op: "insert_markdown", markdown: "## Elsewhere" }]).doc;
  const otherId = orderedBlockIds(other)[1];
  refuses(
    other,
    [{ op: "delete_node", block_id: id, node_id: outline(other, otherId)[0].node_id }],
    notFound,
  );
  // A cursor at a text character, not a node's opening marker.
  refuses(
    doc,
    [{ op: "delete_node", block_id: id, node_id: A.getCursor(doc, textPath(id), 2) }],
    notFound,
  );
  for (const node_id of [undefined, null, "", 7, "x".repeat(129)])
    refuses(doc, [{ op: "delete_node", block_id: id, node_id }], /node_id must be a string/);
  refuses(doc, [{ op: "delete_node", block_id: "missing", node_id: table }], /Block not found/);
  // Nothing in the batch applies when one delete_node is refused.
  refuses(
    doc,
    [
      { op: "delete_node", block_id: id, node_id: idOf(doc, id, "heading") },
      { op: "delete_node", block_id: id, node_id: "1@" + "0".repeat(32) },
    ],
    notFound,
  );
});

test("two deletes in one batch use ids, so the first doesn't shift the second", () => {
  const { doc, id } = fixture();
  const { doc: after, result } = edit(doc, [
    { op: "delete_node", block_id: id, node_id: idOf(doc, id, "heading") },
    { op: "delete_node", block_id: id, node_id: idOf(doc, id, "horizontal-rule") },
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
    { op: "delete_node", block_id: id, node_id: quote },
  ]).doc;
  const two = edit(A.clone(doc, { actor: "02".repeat(16) }), [
    { op: "delete_node", block_id: id, node_id: quote },
  ]).doc;
  const both = A.merge(A.clone(one), two);
  assert.equal(blockMarkdown(both.blocks[id]), blockMarkdown(one.blocks[id]));
  const typed = patch(A.clone(doc, { actor: "03".repeat(16) }), [
    { op: "replace_match", block_id: id, match_text: "Closing", replacement: "Final" },
  ]);
  const merged = A.merge(A.clone(one), typed);
  richDoc(merged.blocks[id], pageId).check();
  assert.match(blockMarkdown(merged.blocks[id]), /Final words$/);
  assert.doesNotMatch(blockMarkdown(merged.blocks[id]), /quoted/);
});

test("read_page_changes names the node it reports by id, deleted ones included", () => {
  const { doc, id } = fixture();
  const table = idOf(doc, id, "table");
  const heading = idOf(doc, id, "heading");
  let after = edit(doc, [{ op: "delete_node", block_id: id, node_id: table }]).doc;
  after = patch(after, [
    { op: "replace_match", block_id: id, match_text: "Plan", replacement: "Roadmap" },
  ]);
  const { changes } = projectReadChanges(after, { since_heads: A.getHeads(doc) });
  const deleted = changes.find((change) => change.change === "deleted");
  assert.equal(deleted.node_id, table);
  assert.equal(deleted.type, "table");
  const updated = changes.find((change) => change.change === "updated");
  assert.equal(updated.node_id, heading);
  assert.equal(resolveNodeId(after, id, heading).index, 1);
});
