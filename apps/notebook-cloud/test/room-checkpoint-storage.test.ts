import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadCheckpointObjects,
  storeCheckpointObjects,
  type CheckpointBodies,
} from "../src/room-checkpoint-storage.ts";
import type { R2Bucket } from "../src/cloudflare-types.ts";

function fixture() {
  const objects = new Map<string, ArrayBuffer>();
  let writes = 0;
  const bucket = {
    async get(key: string) {
      const value = objects.get(key);
      return value ? { size: value.byteLength, arrayBuffer: async () => value.slice(0) } : null;
    },
    async put(key: string, value: ArrayBuffer) {
      writes++;
      if (objects.has(key)) return null;
      objects.set(key, value.slice(0));
      return { size: value.byteLength };
    },
  } as R2Bucket;
  const bodies = Object.fromEntries(
    ["notebook", "runtime_state", "comms", "comments"].map((kind, index) => {
      const bytes = new Uint8Array(2_300_000);
      bytes.fill(index + 1);
      return [kind, bytes.buffer];
    }),
  ) as CheckpointBodies;
  return { objects, bucket, bodies, writes: () => writes };
}

describe("room checkpoint objects", () => {
  it("roundtrips all four bodies above the 2.2MB KV row limit and reuses unchanged bodies", async () => {
    const { bucket, bodies, objects, writes } = fixture();
    const references = await storeCheckpointObjects(bucket, "notebook/a", bodies);
    assert.equal(writes(), 4);
    assert.equal(objects.size, 4);
    assert.ok(
      [...objects.keys()].every((key) => key.startsWith("n/notebook%2Fa/room-checkpoints/")),
    );
    assert.deepEqual(await loadCheckpointObjects(bucket, "notebook/a", references), bodies);
    assert.deepEqual(
      await storeCheckpointObjects(bucket, "notebook/a", bodies, references),
      references,
    );
    assert.equal(writes(), 4, "unchanged documents do not issue object puts");
    assert.ok(JSON.stringify(references).length < 600);
    await assert.rejects(
      loadCheckpointObjects(bucket, "other-room", references),
      /Missing notebook/,
    );
  });

  for (const failure of ["missing", "truncated", "corrupt", "invalid-reference"] as const)
    it(`rejects a ${failure} committed body`, async () => {
      const { bucket, bodies, objects } = fixture();
      const references = await storeCheckpointObjects(bucket, "demo", bodies);
      const key = `n/demo/room-checkpoints/${references.runtime_state.sha256}.am`;
      if (failure === "missing") objects.delete(key);
      if (failure === "truncated") objects.set(key, new ArrayBuffer(1));
      if (failure === "corrupt") objects.set(key, new ArrayBuffer(bodies.runtime_state.byteLength));
      if (failure === "invalid-reference") references.runtime_state.sha256 = "../../another-room";
      await assert.rejects(
        loadCheckpointObjects(bucket, "demo", references),
        /Committed room checkpoint could not be loaded/,
      );
    });

  it("verifies an existing immutable object after losing a conditional put", async () => {
    const { bucket, bodies, objects } = fixture();
    const references = await storeCheckpointObjects(bucket, "demo", bodies);
    assert.deepEqual(await storeCheckpointObjects(bucket, "demo", bodies), references);
    objects.set(
      `n/demo/room-checkpoints/${references.notebook.sha256}.am`,
      new ArrayBuffer(bodies.notebook.byteLength),
    );
    await assert.rejects(
      storeCheckpointObjects(bucket, "demo", bodies),
      /Checkpoint notebook object write failed/,
    );
  });
});
