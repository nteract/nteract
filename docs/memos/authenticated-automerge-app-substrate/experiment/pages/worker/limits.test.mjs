import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  decodeRecordFrame,
  RECORD_HEADER_BYTES,
} from "../../upstream/packages/automerge-repo-subduction/src/record-codec.ts";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { Repo } from "@automerge/automerge-repo";
import { SubductionBackend } from "@automerge/automerge-repo-subduction";
import {
  BACKEND_LIMITS,
  MAX_STORED_BYTES,
  assertDocumentLimits,
  assertIntentSize,
} from "../model/limits.mjs";
import { DurableByteStore } from "./storage.mjs";
import { documentMutation } from "./mutations.mjs";

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
  async sync() {}
  async list({ prefix = "", startAfter = "", limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .slice(0, limit),
    );
  }
}

test("near-limit native records fit their real signed binary storage frame", async () => {
  const storage = new Storage();
  const signer = N.MemorySigner.fromBytes(randomBytes(32));
  const backend = new SubductionBackend({
    signer,
    storage: new DurableByteStore(storage),
    ...BACKEND_LIMITS,
  });
  const repo = new Repo({ backend });
  try {
    const doc = A.from({
      payload: new Uint8Array(randomBytes(BACKEND_LIMITS.maxRecordBytes - 4096)),
    });
    assertDocumentLimits(doc);
    const handle = await repo.import(A.save(doc));
    await repo.flush([handle.documentId]);
    await backend.flush();
    const frames = [...storage.values].filter(([key]) => /\/(commits|fragments)\//.test(key));
    assert.ok(frames.length > 0);
    assert.ok(frames.some(([, value]) => value.byteLength > 900_000));
    assert.ok(
      frames.every(
        ([, value]) => value.byteLength <= BACKEND_LIMITS.maxRecordBytes + RECORD_HEADER_BYTES,
      ),
    );
    for (const [key, value] of frames) {
      assert.ok(new TextEncoder().encode(key).length + value.byteLength <= MAX_STORED_BYTES);
      const frame = decodeRecordFrame(value, BACKEND_LIMITS.maxRecordBytes);
      assert.ok(frame.signed.length > 0 && frame.blob.length > 0);
    }
  } finally {
    await repo.shutdown();
    await backend.close();
    signer.free();
  }
});

test("the stored-frame guard includes UTF-8 key bytes and rejects before put", async () => {
  const storage = new Storage();
  const store = new DurableByteStore(storage);
  const key = "é";
  const allowed = MAX_STORED_BYTES - new TextEncoder().encode(`repo/${key}`).length;
  await store.save(key, new Uint8Array(allowed));
  const original = storage.values.get(`repo/${key}`);
  await assert.rejects(store.save(key, new Uint8Array(allowed + 1)), { status: 413 });
  assert.equal(storage.values.get(`repo/${key}`), original);
});

test("oversized derived edits leave content and recovery intents unchanged", async () => {
  const storage = new Storage();
  let doc = A.from({ page_id: "size-test", note: "before" });
  const heads = A.getHeads(doc);
  let flushes = 0;
  await assert.rejects(
    documentMutation({
      storage,
      handle: {
        doc: () => doc,
        update: async (fn) => {
          doc = fn(doc);
        },
      },
      operation: "edit_page",
      args: { idempotency_key: "oversized-edit", base_heads: heads },
      identity: { principal: "owner", driver: "test" },
      apply: (draft) => {
        draft.payload = new Uint8Array(randomBytes(BACKEND_LIMITS.maxRecordBytes + 4096));
      },
      flush: async () => {
        flushes++;
      },
    }),
    { status: 413 },
  );
  assert.deepEqual(A.getHeads(doc), heads);
  assert.equal(doc.payload, undefined);
  assert.equal(storage.values.size, 0);
  assert.equal(flushes, 0);
});

test("host intents bound binary payloads and metadata before storage", () => {
  assertIntentSize("host/creation", [new Uint8Array(BACKEND_LIMITS.maxRecordBytes)], {
    title: "Fits",
  });
  assert.throws(() => assertIntentSize("host/creation", [new Uint8Array(MAX_STORED_BYTES)], {}), {
    status: 413,
  });
  assert.throws(
    () =>
      assertIntentSize("host/operation/test", [new Uint8Array(1)], {
        result: "x".repeat(MAX_STORED_BYTES),
      }),
    { status: 413 },
  );
});
