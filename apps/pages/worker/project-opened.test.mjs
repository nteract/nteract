import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPENED_PROJECT_HINTS,
  OPENED_PROJECT_REFRESH_MS,
  recordOpenedProject,
} from "./project-opened.mjs";

/** Storage over a Map, as a Catalog's is. The first `list` after `hold()`
 * reads its snapshot, reports it read, and returns it only on `release()`,
 * so another writer can run between a trim's list and its deletes. */
function storageDouble() {
  const values = new Map();
  let held = null;
  return {
    values,
    async get(key) {
      return structuredClone(values.get(key));
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      return values.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const snapshot = new Map(
        [...values]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, value]) => [key, structuredClone(value)]),
      );
      if (held) {
        const { listed, released } = held;
        held = null;
        listed();
        await released;
      }
      return snapshot;
    },
    hold() {
      let listed, release;
      const reached = new Promise((resolve) => (listed = resolve));
      const released = new Promise((resolve) => (release = resolve));
      held = { listed, released };
      return { reached, release };
    },
  };
}

const owner = "user:kilo:owner";
const id = (i) => `prj_00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

test("a trim never deletes a hint another write refreshed after the trim's list", async () => {
  const storage = storageDouble();
  const now = Date.now();
  // A full set, all older than the refresh window; id(0) is the oldest.
  for (let i = 0; i < OPENED_PROJECT_HINTS; i++)
    await storage.put(`project-opened/${id(i)}`, {
      space_id: id(i),
      owner,
      at: now - 2 * OPENED_PROJECT_REFRESH_MS + i,
    });
  // Writer A adds a new hint and lists to trim; it will choose id(0).
  const { reached, release } = storage.hold();
  const a = recordOpenedProject(storage, { space_id: id(500), owner }, now);
  await reached;
  // Writer B, between A's list and A's delete, refreshes id(0).
  await recordOpenedProject(storage, { space_id: id(0), owner }, now + 1);
  release();
  await a;
  assert.equal(
    storage.values.get(`project-opened/${id(0)}`)?.at,
    now + 1,
    "the refreshed hint survives A's stale choice",
  );
  assert.ok(storage.values.has(`project-opened/${id(500)}`));
});
