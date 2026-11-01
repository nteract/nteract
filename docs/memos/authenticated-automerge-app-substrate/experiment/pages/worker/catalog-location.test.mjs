import assert from "node:assert/strict";
import { test } from "node:test";
import { generateNKeysBetween } from "fractional-indexing";
import {
  appendPosition,
  childrenOf,
  homeEntry,
  locationAnswer,
  locationEntries,
  projectOf,
  publicLocation,
  restoreTarget,
} from "./catalog-location.mjs";
import {
  LOCATION_SHAPE_KEY,
  LOCATION_SHAPE_VERSION,
  SHAPE_BLOCKS,
  SHAPE_STATES,
  locationShape,
  migrateLocationShape,
  planLocationShape,
  shapeState,
} from "./location-shape.mjs";
import { STORAGE_KEYS_PER_CALL } from "./actor-authorship.mjs";
import {
  MAX_DEPTH,
  MAX_TREE_DEPTH,
  checkInvariants,
  deriveLocation,
  planMove,
} from "../model/location.mjs";

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
const [home, top, child, grandchild, loose] = [1, 2, 3, 4, 5].map(id);
const entry = (pageId, fields) => ({ page_id: pageId, title: pageId, ...fields });

/** A Project whose home Page is its root: top under home, child under top,
 * grandchild under child, and a root in Your items. */
const tree = (extra = {}) =>
  new Storage({
    [`space/${PROJECT}`]: { space_id: PROJECT, home_page_id: home },
    [`page/${home}`]: entry(home, {
      parent_id: null,
      position: "a0",
      space_id: PROJECT,
      home: true,
    }),
    [`page/${top}`]: entry(top, { parent_id: home, position: "a0" }),
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
  // Move the subtree out from under the home Page and every descendant follows.
  storage.values.set(`page/${top}`, entry(top, { parent_id: null, position: "a1" }));
  assert.equal(projectOf(await locationEntries(storage), grandchild), null);
  // A root with space_id from before the home Page was the only root still
  // derives its Project: reads work in both shapes.
  storage.values.set(
    `page/${top}`,
    entry(top, { parent_id: null, position: "a1", space_id: PROJECT }),
  );
  assert.equal(projectOf(await locationEntries(storage), grandchild), PROJECT);
});

test("the location answer is IDs only: ancestors nearest first and the root's Project", async () => {
  const entries = await locationEntries(tree());
  assert.deepEqual(locationAnswer(entries, grandchild), {
    page_id: grandchild,
    state: "active",
    parent_id: child,
    ancestors: [child, top, home],
    complete: true,
    space_id: PROJECT,
    home: false,
  });
  assert.equal(locationAnswer(entries, home).home, true);
  assert.equal(locationAnswer(entries, id(9)), null);
  assert.deepEqual(childrenOf(entries, top), [child]);
  assert.deepEqual(childrenOf(entries, home), [top], "the Project's top level");
  assert.deepEqual(publicLocation(entries, loose), {}, "Your items roots keep the plain row");
  assert.deepEqual(publicLocation(entries, child), {
    space_id: PROJECT,
    parent_id: top,
    position: "a0",
  });
  assert.deepEqual(publicLocation(entries, top), {
    space_id: PROJECT,
    parent_id: home,
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
  assert.equal(appendPosition(entries, home).position, "a1", "after top, the Project's top level");
  assert.equal(appendPosition(entries, null).position, "a1", "Your items roots; the home is alone");
  assert.equal(appendPosition(entries, top).position, "a1");
  assert.equal(appendPosition(entries, grandchild).position, "a0", "first child");
  assert.equal(homeEntry(entries, PROJECT).page_id, home);
  assert.equal(homeEntry(entries, "prj_other"), undefined);
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

  // Parent in Trash: the Project's top level, under its home Page after top.
  const orphaned = tree({
    [`trash/${child}`]: entry(child, { state: "trashed", parent_id: top, position: "a0" }),
    [`trash/${grandchild}`]: trashed({ parent_id: child, position: "a0" }),
  });
  orphaned.values.delete(`page/${child}`);
  orphaned.values.delete(`page/${grandchild}`);
  assert.deepEqual((await restoreTarget(orphaned, grandchild)).location, {
    parent_id: home,
    position: "a1",
  });
  // Parent leaving for Trash (a live reservation) counts as unavailable too.
  const leaving = tree({
    [`trash/${child}`]: { page_id: child, pending: true, reservation: "delete_page" },
    [`trash/${grandchild}`]: trashed({ parent_id: child, position: "a0" }),
  });
  leaving.values.delete(`page/${grandchild}`);
  assert.equal((await restoreTarget(leaving, grandchild)).location.parent_id, home);

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

  // A Trash entry from before the home Page was the only root: a root with
  // space_id. It returns under the home Page; its old root key isn't kept.
  const legacy = tree({
    [`trash/${id(8)}`]: entry(id(8), {
      state: "trashed",
      parent_id: null,
      position: "a1",
      space_id: PROJECT,
    }),
  });
  assert.deepEqual((await restoreTarget(legacy, id(8))).location, {
    parent_id: home,
    position: "a1",
  });
  // The same entry with its Project gone lands in Your items; "a1" is free there.
  legacy.values.delete(`space/${PROJECT}`);
  assert.deepEqual((await restoreTarget(legacy, id(8))).location, {
    parent_id: null,
    position: "a1",
  });
});

// Location shape migration (location-shape.mjs).

/** Every entry in the current shape: only home Pages are roots with
 * space_id, and the model's invariants hold. */
async function assertCurrentShape(storage) {
  const entries = await locationEntries(storage);
  for (const entry of entries.values())
    if (entry.parent_id === null && entry.space_id)
      assert.equal(entry.home, true, `${entry.page_id} is a root with space_id but not a home`);
  assert.deepEqual(checkInvariants({ revision: 0, entries }), []);
  return entries;
}

const shapeOf = async (storage) => shapeState(await storage.get(LOCATION_SHAPE_KEY));

test("locationShape: every state takes exactly the events a pass can send", () => {
  const states = {
    unmigrated: { name: "unmigrated" },
    migrating: { name: "migrating" },
    migrated: { name: "migrated" },
    blocked: { name: "blocked", reason: "home_pending", page_id: top, space_id: PROJECT },
  };
  assert.deepEqual(Object.keys(states), [...SHAPE_STATES]);
  const block = {
    type: "block",
    reason: "nesting_depth_exceeded",
    page_id: top,
    space_id: PROJECT,
  };
  const expected = {
    // state → { event: next state name, or undefined when rejected }
    unmigrated: { start: "migrating", batch: undefined, done: undefined, block: undefined },
    migrating: { start: "migrating", batch: "migrating", done: "migrated", block: "blocked" },
    migrated: { start: undefined, batch: undefined, done: undefined, block: undefined },
    blocked: { start: "migrating", batch: undefined, done: undefined, block: undefined },
  };
  for (const [name, state] of Object.entries(states))
    for (const [type, next] of Object.entries(expected[name])) {
      const result = locationShape(state, type === "block" ? block : { type });
      const where = `${name} + ${type}`;
      if (next === undefined) {
        assert.ok(result.rejected, where);
        assert.deepEqual(result.state, state, where);
      } else {
        assert.equal(result.rejected, undefined, where);
        assert.equal(result.state.name, next, where);
      }
    }
  const blocked = locationShape(states.migrating, block).state;
  assert.deepEqual(blocked, {
    name: "blocked",
    reason: "nesting_depth_exceeded",
    page_id: top,
    space_id: PROJECT,
  });
  assert.ok(locationShape(states.migrating, { type: "block", reason: "other" }).rejected);
  assert.ok(locationShape(states.migrating, { type: "nope" }).rejected);
  assert.deepEqual(SHAPE_BLOCKS, ["home_pending", "nesting_depth_exceeded"]);
  // Stored records: absent, another version, or an unknown state all read as
  // unmigrated; a blocked record keeps its reason.
  assert.deepEqual(shapeState(undefined), { name: "unmigrated" });
  assert.deepEqual(shapeState({ version: LOCATION_SHAPE_VERSION + 1, state: "migrated" }), {
    name: "unmigrated",
  });
  assert.deepEqual(shapeState({ version: LOCATION_SHAPE_VERSION, state: "weird" }), {
    name: "unmigrated",
  });
  assert.deepEqual(
    shapeState({ version: LOCATION_SHAPE_VERSION, state: "blocked", reason: "home_pending" }),
    { name: "blocked", reason: "home_pending", page_id: null, space_id: null },
  );
});

/** A Catalog written before the home Page was the only root: `top` is a root
 * with space_id (the older shape), `guide` is already under home (the newer
 * one), with a trashed root in the Project and a loose Page in Your items. */
const OTHER = `prj_${"2".repeat(8)}-2222-4222-8222-${"2".repeat(12)}`;
const [guide, trashedRoot, otherHome, otherTop] = [6, 7, 8, 9].map(id);
const mixed = (extra = {}) =>
  new Storage({
    [`space/${PROJECT}`]: { space_id: PROJECT, home_page_id: home },
    [`space/${OTHER}`]: { space_id: OTHER, home_page_id: otherHome },
    [`page/${home}`]: entry(home, {
      parent_id: null,
      position: "a0",
      space_id: PROJECT,
      home: true,
    }),
    [`page/${top}`]: entry(top, { parent_id: null, position: "a1", space_id: PROJECT }),
    [`page/${child}`]: entry(child, { parent_id: top, position: "a0" }),
    [`page/${grandchild}`]: entry(grandchild, { parent_id: child, position: "a0" }),
    [`page/${guide}`]: entry(guide, { parent_id: home, position: "a1" }),
    [`trash/${trashedRoot}`]: entry(trashedRoot, {
      parent_id: null,
      position: "a2",
      space_id: PROJECT,
      state: "trashed",
      trashed_at: "2026-01-01T00:00:00.000Z",
    }),
    [`page/${otherHome}`]: entry(otherHome, {
      parent_id: null,
      position: "a0",
      space_id: OTHER,
      home: true,
    }),
    [`page/${otherTop}`]: entry(otherTop, { parent_id: null, position: "a1", space_id: OTHER }),
    [`page/${loose}`]: entry(loose, { parent_id: null, position: "a0" }),
    ...extra,
  });

test("migration: both shapes in, one shape out, with positions kept and ties repaired", async () => {
  const storage = mixed();
  const before = await locationEntries(storage);
  assert.equal(projectOf(before, grandchild), PROJECT, "reads work before the pass");
  assert.deepEqual(await shapeOf(storage), { name: "unmigrated" });

  const state = await migrateLocationShape(storage);
  assert.deepEqual(state, { name: "migrated" });
  assert.deepEqual(await shapeOf(storage), { name: "migrated" });
  const entries = await assertCurrentShape(storage);
  // Every Project top-level Page is the home Page's child and lost space_id.
  assert.equal(entries.get(top).parent_id, home);
  assert.equal(entries.get(top).space_id, undefined);
  assert.equal(entries.get(otherTop).parent_id, otherHome);
  // top and guide both held "a1". In (position, page_id) order top comes
  // first and keeps its key; guide is rekeyed after it, as a move repairs a
  // tie.
  assert.equal(entries.get(top).position, "a1");
  assert.ok(entries.get(guide).position > "a1");
  assert.equal(entries.get(otherTop).position, "a1", "no tie, position kept");
  // Descendants didn't change; their Project still derives through the root.
  assert.deepEqual(entries.get(child), before.get(child));
  assert.equal(projectOf(entries, grandchild), PROJECT);
  assert.deepEqual(childrenOf(entries, home), [top, guide]);
  // The trashed root moved too, and remembers its Project for a restore.
  const trashed = await storage.get(`trash/${trashedRoot}`);
  assert.equal(trashed.parent_id, home);
  assert.equal(trashed.space_id, undefined);
  assert.equal(trashed.restore_space_id, PROJECT);
  assert.equal(trashed.position, "a2", "a trashed entry keeps its key");
  assert.equal(trashed.trashed_at, "2026-01-01T00:00:00.000Z", "other fields keep");
  // Home Pages and Your items are untouched.
  assert.deepEqual(await storage.get(`page/${home}`), mixed().values.get(`page/${home}`));
  assert.deepEqual(await storage.get(`page/${loose}`), mixed().values.get(`page/${loose}`));
  // One batch: four entries and the state record in one transaction.
  assert.equal(storage.transactions, 1);
  assert.deepEqual(storage.puts, [5]);
});

test("migration: idempotent, and a migrated Catalog costs one read", async () => {
  const storage = mixed();
  await migrateLocationShape(storage);
  const after = new Map(storage.values);
  storage.puts = [];
  storage.transactions = 0;
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  assert.deepEqual(storage.values, after);
  assert.deepEqual(storage.puts, []);
  assert.equal(storage.transactions, 0);
  // A Catalog already in the current shape (page10's imported guides, or a
  // new account) goes straight to migrated with only the record written.
  const fresh = tree();
  assert.deepEqual(await migrateLocationShape(fresh), { name: "migrated" });
  assert.deepEqual(fresh.puts, [1]);
  await assertCurrentShape(fresh);
  // A pass interrupted after its first batch resumes from `migrating`.
  const resumed = mixed();
  await resumed.put(LOCATION_SHAPE_KEY, { version: LOCATION_SHAPE_VERSION, state: "migrating" });
  assert.deepEqual(await migrateLocationShape(resumed), { name: "migrated" });
  await assertCurrentShape(resumed);
});

test("migration: 200 entries cross the per-call key limit in whole batches", async () => {
  const values = {
    [`space/${PROJECT}`]: { space_id: PROJECT, home_page_id: home },
    [`page/${home}`]: entry(home, {
      parent_id: null,
      position: "a0",
      space_id: PROJECT,
      home: true,
    }),
  };
  const roots = [];
  // Distinct keys already, as positionAmong hands them out.
  const keys = generateNKeysBetween("a0", null, 200);
  for (let i = 0; i < 200; i++) {
    const pageId = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
    roots.push(pageId);
    values[`${i % 5 === 0 ? "trash/" : "page/"}${pageId}`] = entry(pageId, {
      parent_id: null,
      position: keys[i],
      space_id: PROJECT,
      ...(i % 5 === 0 && { state: "trashed" }),
    });
  }
  const storage = new Storage(values);
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  // 200 entries + the record each batch: 127 + 1, then 73 + 1.
  assert.deepEqual(storage.puts, [STORAGE_KEYS_PER_CALL, 200 - (STORAGE_KEYS_PER_CALL - 1) + 1]);
  assert.equal(storage.transactions, 2);
  const entries = await assertCurrentShape(storage);
  for (const [i, pageId] of roots.entries()) {
    const moved = entries.get(pageId);
    assert.equal(moved.parent_id, home, pageId);
    assert.equal(moved.space_id, undefined, pageId);
    assert.equal(moved.position, keys[i], "position kept");
    assert.equal(moved.state, i % 5 === 0 ? "trashed" : "active");
  }
  assert.equal(childrenOf(entries, home).length, 160);
});

test("migration: a pending Project leaves the Catalog unmigrated; finishing it clears the block", async () => {
  const storage = mixed({
    [`space/${OTHER}`]: { space_id: OTHER, home_page_id: otherHome, pending: true },
    [`page/${otherHome}`]: entry(otherHome, {
      parent_id: null,
      position: "a0",
      space_id: OTHER,
      home: true,
      pending: true,
    }),
  });
  const before = new Map(storage.values);
  const state = await migrateLocationShape(storage);
  assert.deepEqual(state, {
    name: "blocked",
    reason: "home_pending",
    page_id: otherTop,
    space_id: OTHER,
  });
  assert.deepEqual(await shapeOf(storage), state);
  // Nothing moved: not even the other Project's roots.
  for (const [key, value] of before)
    if (key !== LOCATION_SHAPE_KEY) assert.deepEqual(storage.values.get(key), value, key);
  assert.equal((await storage.get(`page/${top}`)).space_id, PROJECT);
  // Reads still derive the Project in the older shape.
  assert.equal(projectOf(await locationEntries(storage), grandchild), PROJECT);
  // A later write tries again; once the home Page is created the pass runs.
  assert.deepEqual(await migrateLocationShape(storage), state, "still blocked");
  await storage.put(`space/${OTHER}`, { space_id: OTHER, home_page_id: otherHome });
  await storage.put(
    `page/${otherHome}`,
    entry(otherHome, { parent_id: null, position: "a0", space_id: OTHER, home: true }),
  );
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  await assertCurrentShape(storage);
});

/** A chain of `length` Pages below `root`, each the only child of the one
 * before. Returns the chain's IDs, deepest last. */
function chainBelow(values, root, length, tag) {
  const ids = [];
  let parent = root;
  for (let depth = 1; depth <= length; depth++) {
    const digit = String(depth % 10);
    const pageId = `${tag}${digit.repeat(7)}-${digit.repeat(4)}-4000-8000-${String(depth).padStart(12, "0")}`;
    values[`page/${pageId}`] = entry(pageId, { parent_id: parent, position: "a0" });
    parent = pageId;
    ids.push(pageId);
  }
  return ids;
}

test("migration: the deepest chain the older shape allowed lands one level lower and holds", async () => {
  // top is a root at depth 1 with eight Pages below it: depth 9, MAX_DEPTH,
  // the most a Project held before the home Page was its root.
  const chain = {};
  const leaves = chainBelow(chain, top, MAX_DEPTH - 1, "d");
  const storage = mixed(chain);
  storage.values.delete(`page/${child}`);
  storage.values.delete(`page/${grandchild}`);
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  const entries = await assertCurrentShape(storage);
  const deepest = deriveLocation(entries, leaves.at(-1));
  assert.equal(deepest.ok, true, "the chain still reads");
  assert.equal(deepest.depth, MAX_TREE_DEPTH, "one level lower than before");
  assert.equal(deepest.space_id, PROJECT);
  assert.equal(projectOf(entries, leaves.at(-1)), PROJECT);
  // New placement stays bounded: nothing goes under the deepest Page, and the
  // model refuses to move the chain anywhere it still exceeds MAX_DEPTH.
  const state = { revision: 0, entries };
  assert.equal(planMove(state, loose, { parent_id: leaves.at(-1) }).code, "nesting_depth_exceeded");
  assert.equal(planMove(state, top, { parent_id: loose }).code, "nesting_depth_exceeded");
  assert.equal(planMove(state, top, { project_id: null }).ok, true, "a root at depth 1 fits");
});

test("migration: a chain already past the depth the model holds blocks, naming the Project and Page", async () => {
  // Corrupt data: ten Pages below a root, which no build placed. The block
  // names the root and its Project, and nothing moves.
  const chain = {};
  chainBelow(chain, top, MAX_DEPTH, "e");
  const storage = mixed(chain);
  storage.values.delete(`page/${child}`);
  storage.values.delete(`page/${grandchild}`);
  const before = new Map(storage.values);
  assert.deepEqual(await migrateLocationShape(storage), {
    name: "blocked",
    reason: "nesting_depth_exceeded",
    page_id: top,
    space_id: PROJECT,
  });
  for (const [key, value] of before)
    if (key !== LOCATION_SHAPE_KEY) assert.deepEqual(storage.values.get(key), value, key);
  // A trashed leaf still counts: a restore would put it back without a depth
  // check. Purged, the chain fits.
  const leaf = Object.keys(chain).at(-1).slice("page/".length);
  const leafEntry = storage.values.get(`page/${leaf}`);
  storage.values.delete(`page/${leaf}`);
  storage.values.set(`trash/${leaf}`, { ...leafEntry, state: "trashed" });
  assert.equal((await migrateLocationShape(storage)).name, "blocked");
  storage.values.delete(`trash/${leaf}`);
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  await assertCurrentShape(storage);
});

/** A Catalog in the older shape with `count` legacy roots under PROJECT, the
 * first holding "a1", and `guide` already under home at "a1": one tie whose
 * repair (guide is rekeyed, since the root sorts first by page_id) is the
 * last write of the plan. */
function legacyRoots(count, { withGuide = true } = {}) {
  const values = {
    [`space/${PROJECT}`]: { space_id: PROJECT, home_page_id: home },
    [`page/${home}`]: entry(home, {
      parent_id: null,
      position: "a0",
      space_id: PROJECT,
      home: true,
    }),
    ...(withGuide && { [`page/${guide}`]: entry(guide, { parent_id: home, position: "a1" }) }),
  };
  const keys = ["a1", ...generateNKeysBetween("a1", null, count - 1)];
  for (let i = 0; i < count; i++) {
    const pageId = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
    values[`page/${pageId}`] = entry(pageId, {
      parent_id: null,
      position: keys[i],
      space_id: PROJECT,
    });
  }
  return new Storage(values);
}
const legacyRootsIn = (storage) =>
  [...storage.values.values()].filter(
    (value) => value.parent_id === null && value.space_id && !value.home,
  ).length;
/** Fail the nth multi-key put. With `afterCommit`, the values land first and
 * only the acknowledgement is lost. */
function failPut(storage, nth, { afterCommit = false } = {}) {
  let puts = 0;
  const put = storage.put.bind(storage);
  storage.put = async (key, value) => {
    if (typeof key !== "object" || ++puts !== nth) return put(key, value);
    if (afterCommit) await put(key, value);
    throw new Error("injected storage failure");
  };
  return () => {
    storage.put = put;
  };
}

test("migration: a pass cut after its last roots moved finishes the repair alone on its rerun", async () => {
  // 127 roots fill the first batch exactly; the second holds only guide's
  // repair and the migrated record, and fails.
  const storage = legacyRoots(STORAGE_KEYS_PER_CALL - 1);
  const restore = failPut(storage, 2);
  await assert.rejects(migrateLocationShape(storage), /injected/);
  assert.deepEqual(await shapeOf(storage), { name: "migrating" });
  assert.equal(legacyRootsIn(storage), 0, "every root moved in the first batch");
  const tied = [...storage.values.values()].filter(
    (value) => value.parent_id === home && value.position === "a1",
  );
  assert.equal(tied.length, 2, "the tie is still there");
  const beforeRerun = checkInvariants({ revision: 0, entries: await locationEntries(storage) });
  assert.deepEqual(
    beforeRerun.map((violation) => violation.code),
    ["duplicate_position"],
  );
  // The rerun has no root to move and must still repair the tie.
  restore();
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  const entries = await assertCurrentShape(storage);
  assert.equal(childrenOf(entries, home).length, STORAGE_KEYS_PER_CALL);
  assert.equal(entries.get(guide).position > "a1", true, "guide was rekeyed, the root kept a1");
  assert.equal(storage.transactions, 3, "one failed, one per pass that wrote");
});

test("migration: a repair-only batch whose acknowledgement is lost reruns to migrated with nothing to do", async () => {
  // Already current, with one tie under home: the plan is the repair alone.
  const storage = tree({ [`page/${guide}`]: entry(guide, { parent_id: home, position: "a0" }) });
  const restore = failPut(storage, 1, { afterCommit: true });
  await assert.rejects(migrateLocationShape(storage), /injected/);
  // The batch committed before its caller heard: record and repair are there.
  assert.deepEqual(await shapeOf(storage), { name: "migrated" });
  const after = await assertCurrentShape(storage);
  assert.notEqual(after.get(guide).position, after.get(top).position);
  restore();
  const snapshot = new Map(storage.values);
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  assert.deepEqual(storage.values, snapshot, "the rerun reads the record and writes nothing");
});

test("migration: planning a flat Catalog of thousands of roots is linear, not quadratic", async () => {
  // 5,000 roots, each with a two-Page chain below it: 15,000 entries. Walking
  // each root's subtree over a child index built per root would visit about
  // 75 million entries; one index per plan keeps it to one pass.
  const values = {
    [`space/${PROJECT}`]: { space_id: PROJECT, home_page_id: home },
    [`page/${home}`]: entry(home, {
      parent_id: null,
      position: "a0",
      space_id: PROJECT,
      home: true,
    }),
  };
  const keys = generateNKeysBetween("a0", null, 5000);
  for (let i = 0; i < 5000; i++) {
    const root = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
    const mid = `${String(i).padStart(8, "0")}-0001-4000-8000-000000000000`;
    const leaf = `${String(i).padStart(8, "0")}-0002-4000-8000-000000000000`;
    values[`page/${root}`] = entry(root, { parent_id: null, position: keys[i], space_id: PROJECT });
    values[`page/${mid}`] = entry(mid, { parent_id: root, position: "a0" });
    values[`page/${leaf}`] = entry(leaf, { parent_id: mid, position: "a0" });
  }
  const entries = await locationEntries(new Storage(values));
  const started = performance.now();
  const plan = planLocationShape(entries, new Map([[PROJECT, { home_page_id: home }]]));
  const elapsed = performance.now() - started;
  assert.equal(plan.ok, true);
  assert.equal(plan.writes.length, 5000);
  assert.ok(elapsed < 2000, `planning took ${Math.round(elapsed)}ms`);
});

test("migration: a home Page the Project record names but didn't flag is the root, and gains the flag", async () => {
  const storage = mixed();
  const flagged = storage.values.get(`page/${home}`);
  const { home: _home, ...unflagged } = flagged;
  storage.values.set(`page/${home}`, unflagged);
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  const entries = await assertCurrentShape(storage);
  const root = await storage.get(`page/${home}`);
  assert.equal(root.home, true, "the flag is written");
  assert.equal(root.parent_id, null);
  assert.equal(root.space_id, PROJECT);
  assert.deepEqual(childrenOf(entries, home), [top, guide], "its roots moved under it, no cycle");
  assert.equal(deriveLocation(entries, grandchild).root, home);
  assert.equal(homeEntry(entries, PROJECT).page_id, home);
  // A second flagged root for the same Project is a duplicate home; the one
  // the record names stays the root and the other becomes its child.
  const twice = mixed();
  const dup = id(5).replace(/5/g, "3");
  twice.values.set(
    `page/${dup}`,
    entry(dup, { parent_id: null, position: "a3", space_id: PROJECT, home: true }),
  );
  assert.deepEqual(await migrateLocationShape(twice), { name: "migrated" });
  const after = await assertCurrentShape(twice);
  assert.equal(after.get(dup).parent_id, home);
  assert.equal(after.get(dup).home, undefined);
  assert.equal((await twice.get(`page/${dup}`)).home, undefined);
});

test("migration: a root whose Project has no home Page anywhere goes to Your items", async () => {
  const gone = `prj_${"3".repeat(8)}-3333-4333-8333-${"3".repeat(12)}`;
  const orphan = id(5).replace(/5/g, "4");
  const trashedOrphan = id(5).replace(/5/g, "6");
  const storage = mixed({
    [`page/${orphan}`]: entry(orphan, { parent_id: null, position: "a0", space_id: gone }),
    [`trash/${trashedOrphan}`]: entry(trashedOrphan, {
      parent_id: null,
      position: "a0",
      space_id: gone,
      state: "trashed",
    }),
  });
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  const entries = await assertCurrentShape(storage);
  // The active one is a Your items root; its key tied with loose and was
  // repaired, so the two sort apart.
  assert.equal(entries.get(orphan).parent_id, null);
  assert.equal(entries.get(orphan).space_id, undefined);
  assert.equal(projectOf(entries, orphan), null);
  assert.notEqual(entries.get(orphan).position, entries.get(loose).position);
  assert.deepEqual(appendPosition(entries, null).position > entries.get(orphan).position, true);
  // The trashed one remembers the Project for a restore, which will fall
  // through to Your items while the Project stays gone.
  const trashed = await storage.get(`trash/${trashedOrphan}`);
  assert.equal(trashed.parent_id, null);
  assert.equal(trashed.space_id, undefined);
  assert.equal(trashed.restore_space_id, gone);
  assert.equal((await restoreTarget(storage, trashedOrphan)).location.parent_id, null);
});

test("planLocationShape: nothing to do on a current Catalog; a tie under a home is repaired on its own", async () => {
  const spaces = new Map([[PROJECT, { home_page_id: home }]]);
  assert.deepEqual(planLocationShape(await locationEntries(tree()), spaces), {
    ok: true,
    writes: [],
  });
  // Two children of home with one key, as concurrent writers in older data
  // left them: the pass repairs it, moving nothing.
  const tied = await locationEntries(
    tree({ [`page/${guide}`]: entry(guide, { parent_id: home, position: "a0" }) }),
  );
  const plan = planLocationShape(tied, spaces);
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.writes.map((write) => [write.page_id, write.parent_id]),
    [[guide, home]],
    "top sorts first by page_id and keeps a0; guide is rekeyed",
  );
  assert.ok(plan.writes[0].position > "a0");
});
