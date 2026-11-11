import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Repo, interpretAsDocumentId } from "@automerge/automerge-repo";
import { copyRecord, recordBytes, recordKey } from "@automerge/automerge-repo/sedimentree";
import {
  applyRecords,
  extractRecords,
  validateDeliveredRecord,
} from "@automerge/automerge-repo/sedimentree/automerge";
import { MemoryBackend } from "@automerge/automerge-repo/sedimentree/testing";

function sample() {
  let doc = A.from({ title: "One", n: 0 });
  for (let i = 1; i <= 20; i++) doc = A.change(doc, (d) => (d.n = i));
  return doc;
}
const documentRecord = (doc) => ({
  kind: "document",
  heads: A.getHeads(doc),
  blob: A.save(doc),
});

test("a document record loads as one chunk and keeps its heads", () => {
  const doc = sample();
  const record = documentRecord(doc);
  const loaded = applyRecords(A.init(), [record]);
  assert.deepEqual(A.getHeads(loaded), A.getHeads(doc));
  assert.equal(loaded.n, 20);
  assert.equal(recordKey(record), `document:${A.getHeads(doc).join(",")}`);
  assert.equal(recordBytes(record), record.blob.byteLength + 32 + 32);
  const copy = copyRecord(record);
  assert.notEqual(copy.blob, record.blob);
  assert.deepEqual(copy, { ...record, heads: [...record.heads].sort() });
});

test("a document record mixes with the records for later changes in one batch", () => {
  const doc = sample();
  const next = A.change(A.clone(doc), (d) => (d.title = "Two"));
  // The new change is usually a loose commit. When its hash starts with a zero
  // byte (about 1 in 256) it is a fragment head covering the whole history.
  // Select by coverage so the batch carries the new change in either shape.
  const later = extractRecords(
    next,
    (m) => !A.hasHeads(doc, [m.kind === "commit" ? m.id : m.head]),
  );
  assert.deepEqual(
    later.map((r) => (r.kind === "commit" ? r.id : r.head)),
    A.getHeads(next),
  );
  const loaded = applyRecords(A.init(), [documentRecord(doc), ...later]);
  assert.equal(loaded.title, "Two");
  assert.deepEqual(A.getHeads(loaded), A.getHeads(next));
});

test("a document record whose heads aren't in its history is refused", () => {
  const doc = sample();
  const later = A.change(A.clone(doc), (d) => (d.n = 99));
  assert.throws(
    () => applyRecords(A.init(), [{ ...documentRecord(doc), heads: A.getHeads(later) }]),
    /heads are not in its history/,
  );
});

test("a document record with a bad checksum or another chunk type is refused", () => {
  const doc = sample();
  const record = documentRecord(doc);
  const corrupt = new Uint8Array(record.blob);
  corrupt[corrupt.length - 1] ^= 0xff;
  assert.throws(() => validateDeliveredRecord({ ...record, blob: corrupt }), /checksum/);
  const change = A.getLastLocalChange(doc);
  assert.throws(() => validateDeliveredRecord({ ...record, blob: change }), /chunk type/);
  assert.throws(() => copyRecord({ ...record, heads: [] }), /requires heads/);
});

test("Repo 3 opens a document a backend delivers as one document record", async () => {
  const doc = sample();
  const backend = new MemoryBackend();
  const repo = new Repo({ backend });
  try {
    const id = await backend.create([documentRecord(doc)]);
    const handle = await repo.find(interpretAsDocumentId(Uint8Array.from(Buffer.from(id, "hex"))));
    assert.equal(handle.doc().n, 20);
    assert.deepEqual(A.getHeads(handle.doc()), A.getHeads(doc));
    handle.change((d) => (d.n = 21));
    assert.equal(handle.doc().n, 21);
  } finally {
    await repo.shutdown();
  }
});
