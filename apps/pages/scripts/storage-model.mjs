// Measurement-only model. No production storage adapter or durability claim.
import assert from "node:assert/strict";
import * as A from "@automerge/automerge/slim";

export function restore(record) {
  let doc = A.load(record.snapshot);
  try {
    for (const bytes of record.tail) doc = A.loadIncremental(doc, bytes);
    assert.deepEqual(A.getHeads(doc).sort(), [...record.heads].sort(), "durable frontier mismatch");
    return doc;
  } catch (error) {
    A.free(doc);
    throw error;
  }
}

export function assertEquivalent(actual, expected) {
  assert.deepEqual(A.getHeads(actual).sort(), A.getHeads(expected).sort());
  assert.deepEqual(A.toJS(actual), A.toJS(expected));
  // Heads alone cover history, but compare encoded changes too: creators and
  // cursors rely on operation identity, not only the visible projection.
  assert.deepEqual(
    A.getAllChanges(actual)
      .map((bytes) => A.decodeChange(bytes).hash)
      .sort(),
    A.getAllChanges(expected)
      .map((bytes) => A.decodeChange(bytes).hash)
      .sort(),
  );
}

export function checkpoint(record, doc) {
  assert.deepEqual(A.getHeads(doc).sort(), [...record.heads].sort());
  return { snapshot: A.save(doc), tail: [], heads: A.getHeads(doc) };
}

export function recoveryCheck(record, expected) {
  const recovered = restore(structuredClone(record));
  try {
    assertEquivalent(recovered, expected);
  } finally {
    A.free(recovered);
  }
}
