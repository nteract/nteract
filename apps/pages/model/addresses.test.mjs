// Addresses: one id names a block, a top-level node or an image anywhere in
// a Page, and resolves by comparing strings against ids minted from the live
// document. A caller's id never reaches Automerge.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { textPath } from "./richtext.mjs";
import { projectReadContent } from "./read-content.mjs";
import { nodeIds, resolveNodeId } from "./node-ids.mjs";
import { imageIds, resolveImageId } from "./image-ids.mjs";
import {
  ADDRESS_PATTERN,
  MAX_ADDRESS,
  addressIndex,
  blockAddress,
  resolveAddress,
} from "./addresses.mjs";

const pageId = "66666666-6666-4666-8666-666666666666";
const S = (value) => new A.ImmutableString(value);
const BLOCKS = [
  "Intro ![chart](https://example.org/a.png) words\n\n## Plan",
  "- one\n- two\n\n> quoted",
  "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n\nClosing words",
];

function page(blocks = BLOCKS) {
  let doc = A.from(createPageData({ pageId, title: "Addresses" }));
  doc = A.change(doc, (draft) => initializePage(draft, blocks[0]));
  for (const markdown of blocks.slice(1)) doc = edit(doc, [{ op: "insert_markdown", markdown }]);
  return { doc, keys: orderedBlockIds(doc) };
}
function edit(doc, operations) {
  return A.change(A.clone(doc), (draft) => {
    applyPageOperation(draft, { operation: "edit_page", arguments: { operations } });
  });
}
const nodesOf = (doc, key) => nodeIds(doc, key).map((entry) => entry.id);
const typeOf = (doc, nodeId) =>
  projectReadContent(doc, { include_content: false }).outline.find(
    (entry) => entry.node_id === nodeId,
  ).type;

// Every getCursorPosition call on any document's backend, through the
// slim and full entry points alike: both reach the wasm prototype.
const spied = { getCursorPosition: [], spans: [] };
const backend = Object.getPrototypeOf(A.getBackend(A.init()));
const originals = {};
before(() => {
  for (const name of Object.keys(spied)) {
    originals[name] = backend[name];
    backend[name] = function (...args) {
      spied[name].push(args);
      return originals[name].apply(this, args);
    };
  }
});
after(() => Object.assign(backend, originals));

/** resolveAddress, checking that the id it was handed reached no
 * getCursorPosition call. */
function resolve(index, id) {
  spied.getCursorPosition.length = 0;
  try {
    return resolveAddress(index, id);
  } finally {
    assert.deepEqual(spied.getCursorPosition, [], `getCursorPosition ran resolving ${id}`);
  }
}
const notFound = (index, id) =>
  assert.throws(
    () => resolve(index, id),
    (error) => error.code === "node_not_found",
    String(id),
  );

test("every kind of address resolves to the block that holds it", () => {
  const { doc, keys } = page();
  const index = addressIndex(doc);
  const types = new Set();
  let images = 0;
  for (const key of keys) {
    assert.deepEqual(resolve(index, blockAddress(doc, key)), { kind: "block", key });
    for (const [at, nodeId] of nodesOf(doc, key).entries()) {
      types.add(typeOf(doc, nodeId));
      assert.deepEqual(resolve(index, nodeId), {
        kind: "node",
        key,
        ...resolveNodeId(doc, key, nodeId),
      });
      assert.equal(resolve(index, nodeId).index, at);
    }
    for (const { image_id } of imageIds(doc, key)) {
      images++;
      const { at, index: span } = resolveImageId(doc, key, image_id);
      assert.deepEqual(resolve(index, image_id), { kind: "image", key, at, index: span });
    }
  }
  assert.deepEqual([...types].sort(), [
    "blockquote",
    "bullet-list",
    "heading",
    "horizontal-rule",
    "paragraph",
    "table",
  ]);
  assert.equal(images, 1);
  for (const key of keys) assert.match(blockAddress(doc, key), ADDRESS_PATTERN);
});

test("ids are distinct across blocks, texts, nodes and images, with two writers at once", () => {
  const { doc: base } = page();
  // Two clones change once each from the same heads, so their ops share
  // counters and differ only by actor.
  const left = edit(A.clone(base, { actor: "0a".repeat(16) }), [
    { op: "insert_markdown", markdown: "Left ![l](https://example.org/l.png)\n\n## Left" },
  ]);
  const right = edit(A.clone(base, { actor: "0b".repeat(16) }), [
    { op: "insert_markdown", markdown: "Right ![r](https://example.org/r.png)\n\n## Right" },
  ]);
  const doc = A.merge(A.clone(left), right);
  const keys = orderedBlockIds(doc);
  assert.equal(keys.length, BLOCKS.length + 2);
  const named = [];
  for (const key of keys) {
    named.push(["block", key, blockAddress(doc, key)]);
    named.push(["text", key, A.getObjectId(doc.blocks[key], "richText")]);
    for (const nodeId of nodesOf(doc, key)) named.push(["node", key, nodeId]);
    for (const { image_id } of imageIds(doc, key)) named.push(["image", key, image_id]);
  }
  const ids = named.map(([, , id]) => id);
  assert.equal(new Set(ids).size, ids.length);
  const counters = new Map();
  for (const id of ids) {
    const [counter, actor] = id.split("@");
    counters.set(counter, new Set([...(counters.get(counter) ?? []), actor]));
  }
  assert.ok(
    [...counters.values()].some((actors) => actors.size > 1),
    "two ids share a counter",
  );
  const index = addressIndex(doc);
  for (const [kind, key, id] of named) {
    if (kind === "text") notFound(index, id);
    else assert.deepEqual([resolve(index, id).kind, resolve(index, id).key], [kind, key]);
  }
});

test("a deleted node, a deleted block and its nodes, and a cursor off a marker name nothing", () => {
  const { doc, keys } = page();
  const [first, second, third] = keys;
  const heading = nodesOf(doc, first)[1];
  const quote = nodesOf(doc, second)[1];
  // A cursor at a text character in one block names no node, here or in
  // another block.
  notFound(addressIndex(doc), A.getCursor(doc, textPath(third), 3));

  const withoutNode = edit(doc, [{ op: "delete_node", block_id: first, node_id: heading }]);
  notFound(addressIndex(withoutNode), heading);
  assert.equal(resolve(addressIndex(withoutNode), nodesOf(doc, first)[0]).key, first);

  const withoutBlock = edit(doc, [{ op: "delete_block", block_id: second }]);
  const index = addressIndex(withoutBlock);
  for (const id of [blockAddress(doc, second), ...nodesOf(doc, second)]) notFound(index, id);
  assert.equal(resolve(index, blockAddress(doc, third)).key, third);

  // One writer deletes the block while another edits a node in it.
  const deleted = edit(A.clone(doc, { actor: "0a".repeat(16) }), [
    { op: "delete_block", block_id: second },
  ]);
  const typed = edit(A.clone(doc, { actor: "0b".repeat(16) }), [
    { op: "replace_match", block_id: second, match_text: "quoted", replacement: "quoted more" },
  ]);
  const merged = A.merge(A.clone(deleted), typed);
  assert.equal(Object.hasOwn(merged.blocks, second), false);
  for (const id of [blockAddress(doc, second), quote]) notFound(addressIndex(merged), id);
});

test("a block's id outlives a rewrite, a move, save and load, and a merge", () => {
  const { doc, keys } = page();
  const [first, second] = keys;
  const id = blockAddress(doc, second);
  const nodes = nodesOf(doc, second);
  const rewritten = edit(doc, [
    { op: "replace_block_markdown", block_id: second, markdown: "Rewritten\n\n## Fresh" },
  ]);
  assert.equal(blockAddress(rewritten, second), id);
  assert.deepEqual(resolve(addressIndex(rewritten), id), { kind: "block", key: second });
  assert.notDeepEqual(nodesOf(rewritten, second), nodes);

  const moved = edit(doc, [{ op: "move_block", block_id: second, after_block_id: null }]);
  assert.equal(orderedBlockIds(moved)[0], second);
  const loaded = A.load(A.save(moved));
  const peer = edit(A.clone(doc, { actor: "0c".repeat(16) }), [
    { op: "replace_match", block_id: first, match_text: "Intro", replacement: "Opening" },
  ]);
  const merged = A.merge(A.clone(moved), peer);
  for (const later of [moved, loaded, merged]) {
    assert.equal(blockAddress(later, second), id);
    assert.deepEqual(resolve(addressIndex(later), id), { kind: "block", key: second });
  }
});

test("a node's id outlives edits inside and before it, a retype, a move, save and load", () => {
  const { doc, keys } = page();
  const [first, , third] = keys;
  const closing = nodesOf(doc, third).at(-1);
  const plan = nodesOf(doc, first)[1];
  const at = (later, id) => {
    const { kind, key, index } = resolve(addressIndex(later), id);
    return { kind, key, index };
  };
  const expected = (key, index) => ({ kind: "node", key, index });
  let later = edit(doc, [
    { op: "replace_match", block_id: third, match_text: "Closing", replacement: "Final" },
    { op: "replace_match", block_id: third, match_text: "1", replacement: "one hundred" },
    { op: "replace_match", block_id: first, match_text: "Plan", replacement: "Plan for Q4" },
    { op: "replace_match", block_id: first, match_text: "Intro", replacement: "Opening" },
  ]);
  assert.deepEqual(at(later, closing), expected(third, 2));
  assert.deepEqual(at(later, plan), expected(first, 1));
  later = edit(later, [
    { op: "set_node", block_id: third, match_text: "Final", type: "heading", attrs: { level: 2 } },
  ]);
  assert.equal(typeOf(later, closing), "heading");
  assert.deepEqual(at(later, closing), expected(third, 2));
  later = edit(later, [{ op: "move_block", block_id: third, after_block_id: null }]);
  assert.equal(orderedBlockIds(later)[0], third);
  assert.deepEqual(at(later, closing), expected(third, 2));
  later = A.load(A.save(later));
  assert.deepEqual(at(later, closing), expected(third, 2));
  assert.deepEqual(at(later, plan), expected(first, 1));
});

test("an id that is not an address is refused, and one that names nothing is not found", () => {
  const { doc } = page();
  const index = addressIndex(doc);
  const actor = A.getActorId(doc);
  const overLong = "1@" + "a".repeat(MAX_ADDRESS - 1);
  assert.equal(overLong.length, 193);
  for (const id of [undefined, null, 7, {}, "", "garbage", "1@ABC", "@ab", "1@", overLong]) {
    assert.throws(
      () => resolve(index, id),
      (error) => error.code === undefined && /node_id must be/.test(error.message),
      String(id),
    );
  }
  assert.equal(MAX_ADDRESS, 192);
  // 192 characters is in shape and names nothing.
  notFound(index, "1@" + "a".repeat(MAX_ADDRESS - 2));
  notFound(index, `999999@${actor}`);
});

test("no caller id reaches getCursorPosition, for a cursor from another block or a deleted marker", () => {
  const { doc, keys } = page();
  const heading = nodesOf(doc, keys[0])[1];
  const gone = edit(doc, [{ op: "delete_node", block_id: keys[0], node_id: heading }]);
  spied.getCursorPosition.length = 0;
  const index = addressIndex(gone);
  for (const id of [heading, A.getCursor(doc, textPath(keys[1]), 2), `5@${A.getActorId(doc)}`])
    assert.throws(() => resolveAddress(index, id), { code: "node_not_found" });
  for (const key of keys)
    for (const id of [blockAddress(gone, key), ...nodesOf(gone, key)]) resolveAddress(index, id);
  assert.deepEqual(spied.getCursorPosition, []);
});

test("an index works on a draft, and after a write once the block is forgotten", () => {
  const { doc, keys } = page();
  const [first, second] = keys;
  const heading = nodesOf(doc, first)[1];
  A.change(A.clone(doc), (draft) => {
    const index = addressIndex(draft);
    assert.deepEqual(resolve(index, blockAddress(draft, second)), { kind: "block", key: second });
    assert.equal(resolve(index, heading).key, first);
    applyPageOperation(draft, {
      operation: "edit_page",
      arguments: {
        operations: [
          { op: "delete_node", block_id: first, node_id: heading },
          { op: "insert_markdown", markdown: "## Added", after_block_id: first },
        ],
      },
    });
    index.forget(first);
    notFound(index, heading);
    const added = orderedBlockIds(draft)[1];
    assert.ok(!keys.includes(added));
    index.forget(added);
    assert.deepEqual(resolve(index, blockAddress(draft, added)), { kind: "block", key: added });
    const [addedNode] = nodesOf(draft, added);
    assert.deepEqual(resolve(index, addedNode), {
      kind: "node",
      key: added,
      ...resolveNodeId(draft, added, addedNode),
    });
  });
});

test("an index reads each block once, and only as far as the id it is looking for", () => {
  const { doc, keys } = page();
  const [opening] = nodesOf(doc, keys[0]);
  const [list] = nodesOf(doc, keys[1]);
  const index = addressIndex(doc);
  spied.spans.length = 0;
  resolve(index, blockAddress(doc, keys[2]));
  assert.deepEqual(
    keys.map((key) => index.isIndexed(key)),
    [false, false, false],
  );
  assert.equal(spied.spans.length, 0);

  resolve(index, opening);
  assert.deepEqual(
    keys.map((key) => index.isIndexed(key)),
    [true, false, false],
  );
  assert.equal(spied.spans.length, 1);
  resolve(index, opening);
  assert.equal(spied.spans.length, 1);

  resolve(index, list);
  assert.deepEqual(
    keys.map((key) => index.isIndexed(key)),
    [true, true, false],
  );
  assert.equal(spied.spans.length, 2);

  index.forget(keys[0]);
  assert.equal(index.isIndexed(keys[0]), false);
  assert.equal(index.isIndexed(keys[1]), true);
});

test("unmarked text and a node this build can't place index without throwing", () => {
  // The block's first node deleted while a peer types into it leaves
  // unmarked text before "Second".
  const { doc: base, keys } = page([
    "Intro words\n\nSecond",
    "| a | b |\n| --- | --- |\n| After | 2 |\n\n## Heading",
  ]);
  const [plain, table] = keys;
  const deleted = edit(A.clone(base, { actor: "0a".repeat(16) }), [
    { op: "delete_node", block_id: plain, node_id: nodesOf(base, plain)[0] },
  ]);
  const typed = edit(A.clone(base, { actor: "0b".repeat(16) }), [
    { op: "replace_match", block_id: plain, match_text: "words", replacement: "words typed" },
  ]);
  let doc = A.merge(A.clone(deleted), typed);
  assert.equal(A.spans(doc, textPath(plain))[0].type, "text");
  assert.equal(nodeIds(doc, plain)[0].id, null);
  // A node from a newer build inside a table cell.
  doc = A.change(doc, (draft) =>
    A.splitBlock(draft, textPath(table), draft.blocks[table].richText.indexOf("After") + 2, {
      type: S("future-chart"),
      parents: [S("table"), S("table-row"), S("table-cell")],
      attrs: {},
      isEmbed: false,
    }),
  );
  assert.throws(() => nodeIds(doc, table), /can't place/);

  const index = addressIndex(doc);
  notFound(index, `999999@${A.getActorId(doc)}`);
  assert.deepEqual(
    keys.map((key) => index.isIndexed(key)),
    [true, true],
  );
  for (const key of keys)
    assert.deepEqual(resolve(index, blockAddress(doc, key)), { kind: "block", key });
  const second = nodeIds(doc, plain)[1].id;
  assert.deepEqual(resolve(index, second), {
    kind: "node",
    key: plain,
    ...resolveNodeId(doc, plain, second),
  });
  // The table's marker is still stored, but a block holding a node this
  // build can't place gives its nodes no addresses.
  notFound(index, nodesOf(base, table)[0]);
});
