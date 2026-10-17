import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { serialize } from "node:v8";
import * as A from "@automerge/automerge/slim";
import { PagesWorkspace } from "../src/workspace.ts";

// Application-only probe: no network, disk persistence, or private Page input.
await A.initializeWasm(
  await readFile(new URL(import.meta.resolve("@automerge/automerge/automerge.wasm"))),
);
const values = new Map();
let lastWrite;
const workspace = new PagesWorkspace({
  storage: {
    async get(key) {
      return structuredClone(values.get(key));
    },
    async put(entries) {
      lastWrite = entries;
      for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value));
    },
  },
});
const call = (operation, args) => workspace.call("probe:local", { operation, arguments: args });
const created = await call("create_page", {
  title: "Generated storage probe",
  idempotency_key: "storage-probe-creation",
  block_units: Array.from({ length: 96 }, (_, i) => ({
    markdown: `## Section ${i + 1}\n\n${Array.from(
      { length: 6 },
      (_, j) =>
        `Observation ${j + 1}: ${createHash("sha256").update(`${i}:${j}`).digest("hex")} describes this block.`,
    ).join("\n\n")}`,
  })),
});
const id = created.page_id;
const blockId = created.content.blocks[0].id;
const initial = values.get(id);
let fullBytes = 0;
let deltaBytes = 0;
let storedBytes = 0;
const increments = [];
const times = [];
for (let i = 0; i < 50; i++) {
  const before = values.get(id);
  const current = await call("read_page", { page_id: id, block_ids: [blockId] });
  const block = current.content.blocks.find((b) => b.id === blockId);
  const started = performance.now();
  await call("edit_page", {
    page_id: id,
    base_sequence: before.sequence,
    idempotency_key: `storage-probe-edit-${i}`,
    operations: [
      {
        op: "replace_block_markdown",
        block_id: blockId,
        expected_hash: block.hash,
        markdown: `${block.markdown}x`,
      },
    ],
  });
  times.push(performance.now() - started);
  const after = values.get(id);
  const left = A.load(before.bytes);
  const right = A.load(after.bytes);
  try {
    const changes = A.getChanges(left, right);
    increments.push(...changes);
    fullBytes += after.bytes.byteLength;
    deltaBytes += changes.reduce((sum, bytes) => sum + bytes.byteLength, 0);
    storedBytes += Object.values(lastWrite).reduce(
      (sum, value) => sum + serialize(value).byteLength,
      0,
    );
  } finally {
    A.free(left);
    A.free(right);
  }
}
const saved = values.get(id);
const [recovered] = A.applyChanges(A.load(initial.bytes), increments);
const finalDoc = A.load(saved.bytes);
try {
  assert.deepEqual(A.getHeads(recovered).sort(), A.getHeads(finalDoc).sort());
  assert.deepEqual(A.toJS(recovered), A.toJS(finalDoc));
} finally {
  A.free(recovered);
  A.free(finalDoc);
}
console.log(
  JSON.stringify(
    {
      workload: "96 generated blocks, 50 single-character appends to one block; mock storage",
      incrementalRecovery: "same heads and content as final full snapshot",
      initialSnapshotBytes: initial.bytes.byteLength,
      finalSnapshotBytes: saved.bytes.byteLength,
      totalFullSnapshotBytes: fullBytes,
      totalIncrementalChangeBytes: deltaBytes,
      totalNodeV8SerializedWrites: storedBytes,
      finalNodeV8SerializedRecordBytes: serialize(saved).byteLength,
      finalJsonBudgetBytes: Buffer.byteLength(
        JSON.stringify(saved, (_key, value) =>
          value instanceof Uint8Array ? Array.from(value) : value,
        ),
      ),
      medianEditMs: times.sort((a, b) => a - b)[Math.floor(times.length / 2)],
      caveat:
        "Payload measurements only, not celld/LTX/R2/S3 traffic. Delta totals exclude receipts and checkpoints. UUIDs/actors and timings vary between runs.",
    },
    null,
    2,
  ),
);
