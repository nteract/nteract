import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendPosition,
  childrenOf,
  locationAnswer,
  locationEntries,
  projectOf,
  publicLocation,
  restoreTarget,
} from "./catalog-location.mjs";

class Storage {
  values = new Map();
  constructor(values = {}) {
    for (const [key, value] of Object.entries(values)) this.values.set(key, value);
  }
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async list({ prefix = "", limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix))
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

/** A Project with home and top as roots, child under top, grandchild under
 * child, and a root in Your items. */
const tree = (extra = {}) =>
  new Storage({
    [`space/${PROJECT}`]: { space_id: PROJECT, home_page_id: home },
    [`page/${home}`]: entry(home, {
      parent_id: null,
      position: "a0",
      space_id: PROJECT,
      home: true,
    }),
    [`page/${top}`]: entry(top, { parent_id: null, position: "a1", space_id: PROJECT }),
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
  // Change the root and every descendant follows.
  storage.values.set(`page/${top}`, entry(top, { parent_id: null, position: "a1" }));
  assert.equal(projectOf(await locationEntries(storage), grandchild), null);
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
    home: false,
  });
  assert.equal(locationAnswer(entries, home).home, true);
  assert.equal(locationAnswer(entries, id(9)), null);
  assert.deepEqual(childrenOf(entries, top), [child]);
  assert.deepEqual(publicLocation(entries, loose), {}, "Your items roots keep the plain row");
  assert.deepEqual(publicLocation(entries, child), {
    space_id: PROJECT,
    parent_id: top,
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
  assert.equal(appendPosition(entries, null, PROJECT).position, "a2", "after home and top");
  assert.equal(appendPosition(entries, null, null).position, "a1", "Your items roots apart");
  assert.equal(appendPosition(entries, top, null).position, "a1");
  assert.equal(appendPosition(entries, grandchild, null).position, "a0", "first child");
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

  // Parent in Trash: the Project's top level, after its roots.
  const orphaned = tree({
    [`trash/${child}`]: entry(child, { state: "trashed", parent_id: top, position: "a0" }),
    [`trash/${grandchild}`]: trashed({ parent_id: child, position: "a0" }),
  });
  orphaned.values.delete(`page/${child}`);
  orphaned.values.delete(`page/${grandchild}`);
  assert.deepEqual((await restoreTarget(orphaned, grandchild)).location, {
    parent_id: null,
    position: "a2",
    space_id: PROJECT,
  });
  // Parent leaving for Trash (a live reservation) counts as unavailable too.
  const leaving = tree({
    [`trash/${child}`]: { page_id: child, pending: true, reservation: "delete_page" },
    [`trash/${grandchild}`]: trashed({ parent_id: child, position: "a0" }),
  });
  leaving.values.delete(`page/${grandchild}`);
  assert.equal((await restoreTarget(leaving, grandchild)).location.parent_id, null);

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
});
