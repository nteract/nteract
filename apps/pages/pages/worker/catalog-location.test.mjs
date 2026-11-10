import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendPosition,
  childrenOf,
  locationAnswer,
  locationEntries,
  locationScan,
  projectOf,
  publicLocation,
  restoreTarget,
} from "./catalog-location.mjs";
import {
  LOCATION_SHAPE_KEY,
  LOCATION_SHAPE_VERSION,
  SHAPE_STATES,
  locationShape,
  migrateLocationShape,
  shapeState,
} from "./location-shape.mjs";
import { STORAGE_KEYS_PER_CALL } from "./storage-guard.mjs";
import { checkInvariants } from "../model/location.mjs";

/** Durable Object storage in memory. `puts` records the key count of every
 * multi-key put; `transactions` counts transaction runs. A put over the
 * per-call key limit throws, as the real storage does. */
class Storage {
  values = new Map();
  puts = [];
  transactions = 0;
  constructor(values = {}) {
    for (const [key, value] of Object.entries(values)) this.values.set(key, value);
  }
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      const entries = Object.entries(key);
      if (entries.length > STORAGE_KEYS_PER_CALL)
        throw new Error(`${entries.length} keys exceed the per-call limit`);
      this.puts.push(entries.length);
      for (const [name, entry] of entries) this.values.set(name, structuredClone(entry));
      return;
    }
    this.puts.push(1);
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async transaction(run) {
    this.transactions++;
    return run(this);
  }
  async list({ prefix = "", startAfter, limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit),
    );
  }
}

const PROJECT = `prj_${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}`;
const id = (n) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const [content, top, child, grandchild, loose] = [1, 2, 3, 4, 5].map(id);
const entry = (pageId, fields) => ({ page_id: pageId, title: pageId, ...fields });

/** A Project with its content document outside the tree: top is a Project
 * root, child under top, grandchild under child, and a root in Your items. */
const tree = (extra = {}) =>
  new Storage({
    [LOCATION_SHAPE_KEY]: { version: LOCATION_SHAPE_VERSION, state: "migrated" },
    [`space/${PROJECT}`]: { space_id: PROJECT, document_id: content },
    [`page/${content}`]: entry(content, { project_content: PROJECT }),
    [`page/${top}`]: entry(top, { parent_id: null, position: "a0", space_id: PROJECT }),
    [`page/${child}`]: entry(child, { parent_id: top, position: "a0" }),
    [`page/${grandchild}`]: entry(grandchild, { parent_id: child, position: "a0" }),
    [`page/${loose}`]: entry(loose, { parent_id: null, position: "a0" }),
    ...extra,
  });

test("a Page's Project is derived from its root, never stored below it", async () => {
  const storage = tree();
  const entries = await locationEntries(storage);
  assert.equal(entries.get(grandchild).space_id, undefined, "only the root stores it");
  assert.equal(projectOf(entries, grandchild), PROJECT);
  assert.equal(projectOf(entries, top), PROJECT);
  assert.equal(projectOf(entries, loose), null);
  // Move the subtree's root to Your items and every descendant follows.
  storage.values.set(`page/${top}`, entry(top, { parent_id: null, position: "a1" }));
  assert.equal(projectOf(await locationEntries(storage), grandchild), null);
  // space_id below a root is ignored: only roots carry a Project.
  storage.values.set(`page/${child}`, entry(child, { parent_id: top, space_id: PROJECT }));
  assert.equal((await locationEntries(storage)).get(child).space_id, undefined);
});

test("the content document is not in the tree: never an entry, child, sibling or parent", async () => {
  const { entries, contents } = await locationScan(tree());
  assert.equal(entries.has(content), false);
  assert.deepEqual([...contents], [[content, { space_id: PROJECT, state: "active" }]]);
  assert.deepEqual(childrenOf(entries, content), []);
  assert.deepEqual(locationAnswer(entries, content, contents), {
    page_id: content,
    state: "active",
    parent_id: null,
    ancestors: [],
    complete: true,
    space_id: PROJECT,
    content: true,
  });
  assert.equal(locationAnswer(entries, content), null, "without contents it is unknown");
  assert.deepEqual(checkInvariants({ revision: 0, entries }, { projects: [PROJECT] }), []);
  // A pending content document (a create_project in flight) reads as pending.
  const pending = tree({
    [`page/${content}`]: entry(content, { project_content: PROJECT, pending: true }),
  });
  assert.equal((await locationScan(pending)).contents.get(content).state, "pending");
});

test("the location answer is IDs only: ancestors nearest first and the root's Project", async () => {
  const entries = await locationEntries(tree());
  assert.deepEqual(locationAnswer(entries, grandchild), {
    page_id: grandchild,
    state: "active",
    parent_id: child,
    ancestors: [child, top],
    complete: true,
    space_id: PROJECT,
  });
  assert.equal(locationAnswer(entries, id(9)), null);
  assert.deepEqual(childrenOf(entries, top), [child]);
  assert.deepEqual(publicLocation(entries, loose), {}, "Your items roots keep the plain row");
  assert.deepEqual(publicLocation(entries, child), {
    space_id: PROJECT,
    parent_id: top,
    position: "a0",
  });
  assert.deepEqual(publicLocation(entries, top), {
    space_id: PROJECT,
    parent_id: null,
    position: "a0",
  });
});

test("a trashed sub-page whose parent was purged keeps the Project it recorded", async () => {
  const storage = tree({
    [`trash/${grandchild}`]: entry(grandchild, {
      state: "trashed",
      parent_id: child,
      position: "a0",
      restore_space_id: PROJECT,
    }),
  });
  storage.values.delete(`page/${grandchild}`);
  storage.values.delete(`page/${child}`);
  const entries = await locationEntries(storage);
  const answer = locationAnswer(entries, grandchild);
  assert.equal(answer.complete, false);
  assert.deepEqual(answer.ancestors, []);
  assert.equal(answer.space_id, PROJECT);
});

test("reservation slots are skipped and a Trash entry is the Page's real entry", async () => {
  const entries = await locationEntries(
    tree({
      [`page/${id(6)}`]: { page_id: id(6), pending: true, reservation: "restore_page" },
      [`trash/${id(6)}`]: entry(id(6), { state: "trashed", parent_id: top, position: "a1" }),
      [`page/${id(7)}`]: entry(id(7), { pending: true, parent_id: top, position: "a2" }),
    }),
  );
  assert.equal(entries.get(id(6)).state, "trashed");
  assert.equal(entries.get(id(7)).state, "pending");
  assert.deepEqual(childrenOf(entries, top), [child], "only active children");
});

test("a new Page goes after every sibling in its own scope", async () => {
  const entries = await locationEntries(tree());
  assert.equal(appendPosition(entries, null, undefined, PROJECT).position, "a1", "Project roots");
  assert.equal(appendPosition(entries, null).position, "a1", "Your items roots");
  assert.equal(appendPosition(entries, null, undefined, "prj_other").position, "a0", "empty");
  assert.equal(appendPosition(entries, top).position, "a1");
  assert.equal(appendPosition(entries, grandchild).position, "a0", "first child");
});

test("a restore keeps an active parent and otherwise returns to the top level", async () => {
  const trashed = (fields) =>
    entry(grandchild, { state: "trashed", trashed_by: "owner", ...fields });
  // Parent active: keep the place.
  const kept = tree({ [`trash/${grandchild}`]: trashed({ parent_id: child, position: "a0" }) });
  kept.values.delete(`page/${grandchild}`);
  assert.deepEqual((await restoreTarget(kept, grandchild)).location, {
    parent_id: child,
    position: "a0",
  });
  // A sibling took the key while it was in Trash: append instead.
  kept.values.set(`page/${id(8)}`, entry(id(8), { parent_id: child, position: "a0" }));
  assert.deepEqual((await restoreTarget(kept, grandchild)).location, {
    parent_id: child,
    position: "a1",
  });

  // Parent in Trash: the Project's top level, a root after top.
  const orphaned = tree({
    [`trash/${child}`]: entry(child, { state: "trashed", parent_id: top, position: "a0" }),
    [`trash/${grandchild}`]: trashed({ parent_id: child, position: "a0" }),
  });
  orphaned.values.delete(`page/${child}`);
  orphaned.values.delete(`page/${grandchild}`);
  assert.deepEqual((await restoreTarget(orphaned, grandchild)).location, {
    parent_id: null,
    position: "a1",
    space_id: PROJECT,
  });
  // Parent leaving for Trash (a live reservation) counts as unavailable too.
  const leaving = tree({
    [`trash/${child}`]: { page_id: child, pending: true, reservation: "delete_page" },
    [`trash/${grandchild}`]: trashed({ parent_id: child, position: "a0" }),
  });
  leaving.values.delete(`page/${grandchild}`);
  assert.deepEqual((await restoreTarget(leaving, grandchild)).location, {
    parent_id: null,
    position: "a1",
    space_id: PROJECT,
  });

  // Parent purged and the Project gone: Your items.
  const gone = tree({
    [`trash/${grandchild}`]: trashed({
      parent_id: child,
      position: "a0",
      restore_space_id: PROJECT,
    }),
  });
  for (const key of [`page/${grandchild}`, `page/${child}`, `space/${PROJECT}`])
    gone.values.delete(key);
  assert.deepEqual((await restoreTarget(gone, grandchild)).location, {
    parent_id: null,
    position: "a1",
  });

  // A trashed Project root returns to its Project's top level, keeping its
  // key when it is free.
  const root = tree({
    [`trash/${id(8)}`]: entry(id(8), {
      state: "trashed",
      parent_id: null,
      position: "a1",
      space_id: PROJECT,
    }),
  });
  assert.deepEqual((await restoreTarget(root, id(8))).location, {
    parent_id: null,
    position: "a1",
    space_id: PROJECT,
  });
  // The same entry with its Project gone lands in Your items; "a1" is free there.
  root.values.delete(`space/${PROJECT}`);
  assert.deepEqual((await restoreTarget(root, id(8))).location, {
    parent_id: null,
    position: "a1",
  });
  // The content document keeps its stored marker: a lifecycle projection of
  // it never gives it a place in the tree.
  assert.deepEqual((await restoreTarget(tree(), content)).location, {
    project_content: PROJECT,
  });
});

// Location shape (location-shape.mjs).

const shapeOf = async (storage) => shapeState(await storage.get(LOCATION_SHAPE_KEY));

test("locationShape: every state takes exactly the events a check can send", () => {
  const states = {
    unmigrated: { name: "unmigrated" },
    checking: { name: "checking" },
    migrated: { name: "migrated" },
  };
  assert.deepEqual(Object.keys(states), [...SHAPE_STATES]);
  const expected = {
    unmigrated: { start: "checking", done: undefined },
    checking: { start: undefined, done: "migrated" },
    migrated: { start: undefined, done: undefined },
  };
  for (const [name, state] of Object.entries(states))
    for (const [type, next] of Object.entries(expected[name])) {
      const result = locationShape(state, { type });
      const where = `${name} + ${type}`;
      if (next === undefined) {
        assert.ok(result.rejected, where);
        assert.deepEqual(result.state, state, where);
      } else {
        assert.equal(result.rejected, undefined, where);
        assert.equal(result.state.name, next, where);
      }
    }
  assert.ok(locationShape(states.checking, { type: "block" }).rejected);
  assert.ok(locationShape(states.checking, { type: "nope" }).rejected);
  assert.equal(
    LOCATION_SHAPE_VERSION,
    2,
    "a rollback-and-forward requires a bump (location-shape.mjs)",
  );
  // Stored records: absent, another version (v1 included), an unknown state
  // (a `blocked` record an earlier build wrote among them) or an interrupted
  // check all read as unmigrated.
  assert.deepEqual(shapeState(undefined), { name: "unmigrated" });
  assert.deepEqual(shapeState({ version: 1, state: "migrated" }), { name: "unmigrated" });
  for (const state of ["weird", "checking", "blocked"])
    assert.deepEqual(shapeState({ version: LOCATION_SHAPE_VERSION, state }), {
      name: "unmigrated",
    });
});

test("a current Catalog is recorded migrated on its first check, and then costs one read", async () => {
  const storage = tree();
  storage.values.delete(LOCATION_SHAPE_KEY);
  assert.deepEqual(await shapeOf(storage), { name: "unmigrated" });
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  assert.deepEqual(await shapeOf(storage), { name: "migrated" });
  let reads = 0;
  const get = storage.get.bind(storage);
  storage.get = async (key) => (reads++, get(key));
  storage.list = async () => assert.fail("a migrated Catalog lists nothing");
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  assert.equal(reads, 1);
  // A v1 record on a current Catalog (every account without Projects) is
  // simply re-recorded.
  const v1 = new Storage({
    [LOCATION_SHAPE_KEY]: { version: 1, state: "migrated" },
    [`page/${loose}`]: entry(loose, { parent_id: null, position: "a0" }),
  });
  assert.deepEqual(await migrateLocationShape(v1), { name: "migrated" });
});
