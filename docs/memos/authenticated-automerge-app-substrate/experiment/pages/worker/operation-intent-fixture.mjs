// Test support for the operation-intent sweeps. The Worker never imports it.
import assert from "node:assert/strict";
import { catalogTitle } from "./catalog.mjs";

/** Fields whose values are clocks, compared only for presence. */
const VOLATILE = new Set([
  "created_at",
  "updated_at",
  "createdAt",
  "expires_at",
  "trashed_at",
  "restored_at",
]);

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      VOLATILE.has(key) && item !== undefined ? "<time>" : scrub(item),
    ]),
  );
}

/** A storage map as a sorted object, clocks and the index's dirty token
 * replaced, so two runs compare exactly. */
export function normalize(values) {
  return Object.fromEntries(
    [...values]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => [key, key === "host/index/dirty" ? "<dirty>" : scrub(value)]),
  );
}

export const scrubbed = scrub;

const copy = (values) => new Map([...values].map(([key, value]) => [key, structuredClone(value)]));

/**
 * Durable Object storage whose every put, delete and sync passes through
 * `onMutation` first, so a test can record it or fail it. A multi-key put is
 * one write. `transaction()` commits everything its callback wrote or, when
 * the callback throws, nothing.
 */
export class CrashStorage {
  values = new Map();
  depth = 0;
  constructor(onMutation = () => {}) {
    this.onMutation = onMutation;
  }
  /** What a crash now would leave: an open transaction's writes roll back. */
  get committed() {
    return this.depth ? this.opened : this.values;
  }
  async get(name) {
    return structuredClone(this.values.get(name));
  }
  async put(name, value) {
    const entries = typeof name === "object" ? name : { [name]: value };
    this.onMutation({ op: "put", entries }, this);
    for (const [entry, item] of Object.entries(entries))
      this.values.set(entry, structuredClone(item));
  }
  async delete(name) {
    this.onMutation({ op: "delete", key: name }, this);
    return this.values.delete(name);
  }
  async sync() {
    this.onMutation({ op: "sync" }, this);
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(
          ([name]) => name.startsWith(prefix) && (startAfter === undefined || name > startAfter),
        )
        .slice(0, limit)
        .map(([name, item]) => [name, structuredClone(item)]),
    );
  }
  async transaction(callback) {
    const outer = this.depth === 0;
    if (outer) this.opened = copy(this.values);
    this.depth++;
    try {
      return await callback(this);
    } catch (error) {
      if (outer) this.values = this.opened;
      throw error;
    } finally {
      this.depth--;
    }
  }
}

/** A mutation as a short label: `put trash/<id>`, `delete page/<id>`, `sync`. */
export function describe(mutation, pageId) {
  const short = (key) => key.replace(pageId, "<id>");
  if (mutation.op === "sync") return "sync";
  if (mutation.op === "delete") return `delete ${short(mutation.key)}`;
  return `put ${Object.keys(mutation.entries).map(short).sort().join("+")}`;
}

/**
 * The Catalog's entries for `pageId` after projecting `current` over
 * `before` (that Page's `page/` and `trash/` entries just before). The
 * destination holds the Page's real entry at its lifecycle revision, with
 * its title, Trash fields and placement; the other prefix is empty. An entry
 * already observed at a newer revision is never replaced.
 */
export function assertProjected(values, pageId, current, before) {
  const page = values.get(`page/${pageId}`);
  const trash = values.get(`trash/${pageId}`);
  if (current.state === "deleted") {
    assert.equal(values.get(`host/deleted/${pageId}`), true, "a deletion leaves a tombstone");
    assert.equal(page, undefined, "a deletion removes the Page entry");
    assert.equal(trash, undefined, "a deletion removes the Trash entry");
    return;
  }
  const known = [before.page, before.trash].filter((entry) => entry && !entry.reservation);
  if (known.some((entry) => (entry.lifecycle_revision ?? 0) > (current.revision ?? 0))) {
    assert.deepEqual(page, before.page, "a fenced projection leaves the Page entry");
    assert.deepEqual(trash, before.trash, "a fenced projection leaves the Trash entry");
    return;
  }
  const [entry, other] = current.state === "active" ? [page, trash] : [trash, page];
  assert.equal(other, undefined, `projecting ${current.state} empties the other prefix`);
  assert.ok(entry && !entry.reservation && !entry.pending, "the destination holds a real entry");
  assert.equal(entry.page_id, pageId);
  assert.equal(entry.lifecycle_revision, current.revision ?? 0);
  assert.equal(entry.title, catalogTitle(current.title ?? known[0]?.title));
  if (Number.isSafeInteger(current.placement_epoch))
    for (const field of ["space_id", "parent_id", "position", "placement_epoch"])
      assert.equal(entry[field], current[field], `projected ${field}`);
  if (current.state === "trashed") {
    assert.equal(entry.state, "trashed");
    assert.equal(entry.trashed_by, current.trashed_by);
    assert.equal(entry.trash_root_id, current.trash_root_id ?? pageId);
  }
}
