import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as A from "@automerge/automerge/slim";
import { checkpoint, recoveryCheck, restore } from "../scripts/storage-model.mjs";

await A.initializeWasm(
  await readFile(new URL(import.meta.resolve("@automerge/automerge/automerge.wasm"))),
);
function fixture() {
  let doc = A.from({ text: "Café 🌊 日本語", comments: {} }, { actor: "aa" });
  const snapshot = A.save(doc);
  const heads = A.getHeads(doc);
  doc = A.change(doc, (d) => A.splice(d, ["text"], 0, 0, "Before "));
  return { doc, record: { snapshot, tail: [A.saveSince(doc, heads)], heads: A.getHeads(doc) } };
}

test("checkpoint restarts preserve operation identity, stale cursors and duplicate chunks", () => {
  const { doc, record } = fixture();
  const cursor = A.getCursor(doc, ["text"], 8);
  const restarted = restore(record);
  const compacted = checkpoint(record, restarted);
  recoveryCheck(record, doc); // failure before publication leaves old generation readable
  recoveryCheck({ ...compacted, tail: record.tail }, doc); // crash before prune leaks harmless chunks
  recoveryCheck(compacted, doc); // completed prune
  const loaded = restore(compacted);
  assert.equal(A.getCursorPosition(loaded, ["text"], cursor), 8);
  assert.equal(A.getObjectId(loaded, "text"), A.getObjectId(doc, "text"));
  A.free(loaded);
  A.free(restarted);
  A.free(doc);
});

test("frontier checks reject missing chunks and truncated snapshots instead of partial recovery", () => {
  const { doc, record } = fixture();
  assert.throws(() => restore({ ...record, tail: [] }), /durable frontier mismatch/);
  assert.throws(() => restore({ ...record, snapshot: record.snapshot.slice(0, 12) }));
  assert.throws(() => restore({ ...record, tail: [record.tail[0].slice(0, 12)] }));
  A.free(doc);
});

test("changes committed after a checkpoint boundary survive pruning only the covered prefix", () => {
  const { doc, record } = fixture();
  const compacted = checkpoint(record, doc);
  const after = A.change(doc, (d) => A.splice(d, ["text"], 0, 0, "Later "));
  const subsequent = A.saveSince(after, record.heads);
  recoveryCheck({ ...compacted, tail: [subsequent], heads: A.getHeads(after) }, after);
  // Blindly deleting every chunk at publication would lose this later commit.
  assert.throws(() => restore({ ...compacted, heads: A.getHeads(after) }), /frontier mismatch/);
  A.free(after);
});

test("incremental recovery preserves concurrent branches through a fresh checkpoint", () => {
  const base = A.from({ text: "middle" }, { actor: "aa" });
  let left = A.clone(base, { actor: "bb" });
  let right = A.clone(base, { actor: "cc" });
  left = A.change(left, (d) => A.splice(d, ["text"], 0, 0, "left "));
  right = A.change(right, (d) => A.splice(d, ["text"], 6, 0, " right"));
  const leftBytes = A.saveSince(left, A.getHeads(base));
  const rightBytes = A.saveSince(right, A.getHeads(base));
  const merged = A.merge(left, right);
  const record = {
    snapshot: A.save(base),
    tail: [rightBytes, leftBytes],
    heads: A.getHeads(merged),
  };
  recoveryCheck(record, merged);
  const restarted = restore(record);
  assert.equal(restarted.text, "left middle right");
  recoveryCheck(checkpoint(record, restarted), merged);
  A.free(restarted);
  A.free(merged);
  A.free(right);
  A.free(base);
});
