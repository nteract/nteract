import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { BACKEND_LIMITS, MAX_STORED_BYTES, assertIntentSize } from "../model/limits.mjs";
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
