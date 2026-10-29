import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, applyPageOperation, orderedBlockIds } from "./page.mjs";

function edit(doc, operations) {
  return A.change(doc, (draft) =>
    applyPageOperation(draft, { operation: "edit_page", arguments: { operations } }),
  );
}
function fixture(count = 3) {
  let doc = A.from(createPageData({ pageId: "ordering-test" }));
  doc = A.change(doc, (draft) => initializePage(draft, "Original passage"));
  return edit(
    doc,
    Array.from({ length: count - 1 }, (_, i) => ({
      op: "insert_markdown",
      markdown: `Block ${i + 2}`,
    })),
  );
}
const positions = (doc) =>
  Object.fromEntries(orderedBlockIds(doc).map((id) => [id, String(doc.blocks[id].position)]));
const merge = (a, b) => A.merge(A.clone(a), A.clone(b));
function assertConverged(left, right) {
  const a = merge(left, right),
    b = merge(right, left);
  assert.deepEqual(orderedBlockIds(a), orderedBlockIds(b));
  assert.deepEqual(positions(a), positions(b));
  assert.equal(new Set(orderedBlockIds(a)).size, Object.keys(a.blocks).length);
  return a;
}
function collidingInsertions() {
  const base = fixture(2),
    [anchor] = orderedBlockIds(base);
  const left = edit(A.clone(base), [
    { op: "insert_markdown", after_block_id: anchor, markdown: "Left" },
  ]);
  const right = edit(A.clone(base), [
    { op: "insert_markdown", after_block_id: anchor, markdown: "Right" },
  ]);
  const doc = assertConverged(left, right);
  return {
    base,
    doc,
    inserted: orderedBlockIds(doc).filter((id) => !Object.hasOwn(base.blocks, id)),
  };
}

test("block membership is a map and positions use case-sensitive scalar ordering", () => {
  const doc = fixture();
  assert.equal(Object.hasOwn(doc, "order"), false);
  assert.deepEqual(orderedBlockIds(undefined), []);
  for (const id of orderedBlockIds(doc)) assert.equal(A.isRawString(doc.blocks[id].position), true);
  assert.deepEqual(
    orderedBlockIds({
      blocks: {
        later: { position: new A.RawString("a0") },
        earlier: { position: new A.RawString("Zz") },
      },
    }),
    ["earlier", "later"],
  );
  assert.deepEqual(orderedBlockIds(A.load(A.save(doc))), orderedBlockIds(doc));
});

test("concurrent inserts choose equal positions and converge using stable block IDs", () => {
  const { doc, inserted } = collidingInsertions();
  assert.equal(inserted.length, 2);
  assert.equal(String(doc.blocks[inserted[0]].position), String(doc.blocks[inserted[1]].position));
  assert.deepEqual(inserted, [...inserted].sort());
  assert.equal(Object.keys(doc.blocks).length, 4);
});

test("insertion inside a collided group repairs only that group and honors the anchor", () => {
  const { doc, inserted } = collidingInsertions();
  const before = orderedBlockIds(doc),
    originalPositions = positions(doc);
  const next = edit(doc, [
    { op: "insert_markdown", after_block_id: inserted[0], markdown: "Between ties" },
  ]);
  const newId = orderedBlockIds(next).find((id) => !Object.hasOwn(doc.blocks, id));
  assert.deepEqual(orderedBlockIds(next), [before[0], inserted[0], newId, inserted[1], before[3]]);
  assert.equal(String(next.blocks[inserted[0]].position), originalPositions[inserted[0]]);
  assert.equal(String(next.blocks[before[0]].position), originalPositions[before[0]]);
  assert.equal(String(next.blocks[before[3]].position), originalPositions[before[3]]);
  for (const id of inserted)
    assert.equal(A.getObjectId(next.blocks[id]), A.getObjectId(doc.blocks[id]));
});

test("concurrent collision repairs retain every inserted block and still converge", () => {
  const { doc, inserted } = collidingInsertions();
  const left = edit(A.clone(doc), [
    { op: "insert_markdown", after_block_id: inserted[0], markdown: "Left repair" },
  ]);
  const right = edit(A.clone(doc), [
    { op: "insert_markdown", after_block_id: inserted[0], markdown: "Right repair" },
  ]);
  const merged = assertConverged(left, right);
  assert.equal(Object.keys(merged.blocks).length, 6);
  for (const id of orderedBlockIds(doc)) assert.ok(Object.hasOwn(merged.blocks, id));
});

test("moves preserve block/text identity and unknown fields without rewriting other positions", () => {
  let doc = fixture();
  const [first, second, third] = orderedBlockIds(doc);
  doc = A.change(doc, (draft) => {
    draft.extension = { keep: true };
    draft.blocks[first].extension = { keep: true };
  });
  const originalPositions = positions(doc);
  const moved = edit(doc, [{ op: "move_block", block_id: first, after_block_id: third }]);
  assert.deepEqual(orderedBlockIds(moved), [second, third, first]);
  assert.equal(A.getObjectId(moved.blocks[first]), A.getObjectId(doc.blocks[first]));
  assert.equal(
    A.getObjectId(moved.blocks[first], "richText"),
    A.getObjectId(doc.blocks[first], "richText"),
  );
  assert.equal(String(moved.blocks[second].position), originalPositions[second]);
  assert.equal(String(moved.blocks[third].position), originalPositions[third]);
  assert.equal(moved.extension.keep && moved.blocks[first].extension.keep, true);
  const restored = edit(moved, [{ op: "move_block", block_id: first, after_block_id: null }]);
  assert.deepEqual(orderedBlockIds(restored), [first, second, third]);
});

test("concurrent moves of one block resolve to one scalar position rather than merged text", () => {
  const doc = fixture(),
    [first, second, third] = orderedBlockIds(doc);
  const left = edit(A.clone(doc), [{ op: "move_block", block_id: first, after_block_id: third }]);
  const right = edit(A.clone(doc), [{ op: "move_block", block_id: first, after_block_id: second }]);
  const merged = assertConverged(left, right);
  const choices = [String(left.blocks[first].position), String(right.blocks[first].position)];
  assert.ok(choices.includes(String(merged.blocks[first].position)));
  const conflicts = Object.values(A.getConflicts(merged.blocks[first], "position"));
  assert.equal(conflicts.length, 2);
  // getConflicts returns decoded scalar strings; the materialized property is RawString.
  assert.deepEqual(conflicts.sort(), [...choices].sort());
  assert.equal(A.isRawString(merged.blocks[first].position), true);
  for (const branch of [left, right]) {
    const ops = A.getChanges(doc, branch).flatMap((change) => A.decodeChange(change).ops);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].action, "set");
    assert.equal(ops[0].key, "position");
  }
  assert.equal(Object.keys(merged.blocks).length, 3);
});

test("concurrent moves of different blocks converge without duplicate membership", () => {
  const doc = fixture(4),
    [first, second, third, fourth] = orderedBlockIds(doc);
  const left = edit(A.clone(doc), [{ op: "move_block", block_id: first, after_block_id: fourth }]);
  const right = edit(A.clone(doc), [{ op: "move_block", block_id: third, after_block_id: null }]);
  assert.deepEqual(orderedBlockIds(assertConverged(left, right)), [third, second, fourth, first]);
});

test("delete wins over a concurrent move while inserts after the deleted anchor survive", () => {
  const doc = fixture(),
    [first, second, third] = orderedBlockIds(doc);
  const removed = edit(A.clone(doc), [{ op: "delete_block", block_id: second }]);
  const changed = edit(A.clone(doc), [
    { op: "move_block", block_id: second, after_block_id: third },
    { op: "insert_markdown", after_block_id: second, markdown: "Survives" },
  ]);
  const merged = assertConverged(removed, changed);
  assert.equal(Object.hasOwn(merged.blocks, second), false);
  assert.equal(Object.keys(merged.blocks).length, 3);
  assert.ok(orderedBlockIds(merged).includes(first));
  assert.ok(orderedBlockIds(merged).includes(third));
});

test("move into a collided group repairs its gap without replacing the moved block", () => {
  const { doc, inserted } = collidingInsertions();
  const original = orderedBlockIds(doc),
    movedId = original.at(-1);
  const moved = edit(doc, [{ op: "move_block", block_id: movedId, after_block_id: inserted[0] }]);
  assert.deepEqual(orderedBlockIds(moved), [original[0], inserted[0], movedId, inserted[1]]);
  assert.equal(A.getObjectId(moved.blocks[movedId]), A.getObjectId(doc.blocks[movedId]));
  assert.equal(
    String(moved.blocks[original[0]].position),
    String(doc.blocks[original[0]].position),
  );
});
