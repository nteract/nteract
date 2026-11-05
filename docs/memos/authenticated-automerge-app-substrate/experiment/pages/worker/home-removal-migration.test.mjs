// ONE-SHOT MIGRATION tests: delete with home-removal-migration.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOME_REMOVAL_ABSENT,
  HOME_REMOVAL_BACKUP_PREFIX,
  HOME_REMOVAL_STATE_KEY,
  applyHomeRemoval,
  hasLegacyHomeShape,
  homeRemovalStep,
  patchOf,
  validateHomeRemoval,
  migrateIntent,
  planHomeRemoval,
  planSpaceHomeRemoval,
  readHomeRemovalInput,
  withoutHomeFields,
} from "./home-removal-migration.mjs";
import { listAll } from "./catalog.mjs";
import { locationScan } from "./catalog-location.mjs";
import { LOCATION_SHAPE_KEY, migrateLocationShape } from "./location-shape.mjs";
import { checkInvariants } from "../model/location.mjs";

class Storage {
  values = new Map();
  transactions = 0;
  failAfterTransactions = Infinity;
  constructor(values = {}) {
    for (const [key, value] of Object.entries(values)) this.values.set(key, value);
  }
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      if (Object.keys(key).length > 128) throw new Error("too many keys");
      for (const [name, entry] of Object.entries(key))
        this.values.set(name, structuredClone(entry));
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async transaction(run) {
    if (this.transactions >= this.failAfterTransactions) throw new Error("crash");
    this.transactions++;
    // All or nothing, like Durable Object storage.
    const staged = new Storage();
    staged.values = new Map(this.values);
    await run(staged);
    this.values = staged.values;
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

const id = (n) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const PROJECT = `prj_${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}`;
const OTHER = `prj_${"2".repeat(8)}-2222-4222-8222-${"2".repeat(12)}`;
const [home, top, child, trashedTop, loose, otherHome, otherTop, legacyRoot] = [
  1, 2, 3, 4, 5, 6, 7, 8,
].map(id);
const entry = (pageId, fields) => ({ page_id: pageId, title: `T ${pageId}`, ...fields });
const GRANT = { principal: "kkelley", role: "editor" };

/** Production's shape: a v1 Catalog. PROJECT's home holds top (with child)
 * and a trashed top-level Page; OTHER is a v0 Project whose home was only
 * named by its record, beside a v0 root with space_id. */
const retired = (extra = {}) =>
  new Storage({
    [LOCATION_SHAPE_KEY]: { version: 1, state: "migrated" },
    [`space/${PROJECT}`]: {
      space_id: PROJECT,
      title: "Launch",
      description: "kept",
      home_page_id: home,
      created_at: "t0",
    },
    [`space/${OTHER}`]: { space_id: OTHER, title: "Other", home_page_id: otherHome },
    [`page/${home}`]: entry(home, {
      parent_id: null,
      position: "a0",
      space_id: PROJECT,
      home: true,
      lifecycle_revision: 3,
      created_at: "t0",
      grant: GRANT,
    }),
    [`page/${top}`]: entry(top, { parent_id: home, position: "a0" }),
    [`page/${child}`]: entry(child, { parent_id: top, position: "a0" }),
    [`trash/${trashedTop}`]: entry(trashedTop, {
      parent_id: home,
      position: "a1",
      state: "trashed",
      restore_space_id: PROJECT,
      trashed_at: "t1",
    }),
    [`page/${otherHome}`]: entry(otherHome, { parent_id: null, position: "a0", space_id: OTHER }),
    [`page/${otherTop}`]: entry(otherTop, { parent_id: otherHome, position: "a1" }),
    [`page/${legacyRoot}`]: entry(legacyRoot, { parent_id: null, position: "a1", space_id: OTHER }),
    [`page/${loose}`]: entry(loose, { parent_id: null, position: "a0" }),
    ...extra,
  });

/** The stored `page/` and `trash/` values, which the shape check reads. */
const treeValues = (storage) =>
  [...storage.values]
    .filter(([key]) => key.startsWith("page/") || key.startsWith("trash/"))
    .map(([, value]) => value);
const plan = async (storage) => planHomeRemoval(await readHomeRemovalInput(storage, listAll));
const apply = async (storage, perBatch = 127) => {
  const planned = await plan(storage);
  assert.deepEqual(planned.report.blockers, []);
  const result = await applyHomeRemoval(storage, {
    listAll,
    perBatch,
    rewriteSpaces: async () => {},
  });
  assert.equal(result.state.phase, "done", JSON.stringify(result.state));
  return planned;
};

test("legacy markers: home flags and record fields are detected, the current shape isn't", () => {
  assert.equal(hasLegacyHomeShape([{ home: true }], []), true);
  assert.equal(hasLegacyHomeShape([], [{ home_page_id: home }]), true);
  assert.equal(hasLegacyHomeShape([{ project_content: PROJECT }], [{ document_id: home }]), false);
  assert.deepEqual(withoutHomeFields({ a: 1, home_page_id: home, home_page_title: "x" }), {
    a: 1,
    document_id: home,
  });
  const current = { document_id: home };
  assert.equal(withoutHomeFields(current), current, "nothing to do returns the same object");
});

test("dry run reports the conversion and writes nothing", async () => {
  const storage = retired();
  const before = new Map(storage.values);
  const { report, writes, spaceIds } = await plan(storage);
  assert.deepEqual(storage.values, before);
  assert.deepEqual(spaceIds.sort(), [PROJECT, OTHER].sort());
  assert.deepEqual(
    report.projects.sort((a, b) => (a.project_id < b.project_id ? -1 : 1)),
    [
      {
        project_id: PROJECT,
        document_id: home,
        content_found: true,
        reparented: 1,
        reparented_trashed: 1,
      },
      {
        project_id: OTHER,
        document_id: otherHome,
        content_found: true,
        reparented: 1,
        reparented_trashed: 0,
      },
    ].sort((a, b) => (a.project_id < b.project_id ? -1 : 1)),
  );
  assert.deepEqual(report.blockers, []);
  assert.ok(writes.size >= 7);
});

test("apply: content leaves the tree with its data and grants, children become Project roots", async () => {
  const storage = retired();
  await apply(storage);
  const content = storage.values.get(`page/${home}`);
  assert.deepEqual(content, {
    page_id: home,
    title: `T ${home}`,
    lifecycle_revision: 3,
    created_at: "t0",
    grant: GRANT,
    project_content: PROJECT,
  });
  assert.deepEqual(
    storage.values.get(`page/${top}`),
    entry(top, { parent_id: null, position: "a0", space_id: PROJECT }),
  );
  assert.deepEqual(
    storage.values.get(`page/${child}`),
    entry(child, { parent_id: top, position: "a0" }),
    "grandchildren unchanged",
  );
  const trashed = storage.values.get(`trash/${trashedTop}`);
  assert.equal(trashed.parent_id, null);
  assert.equal(trashed.space_id, PROJECT, "the trashed child's restore hint is its Project root");
  assert.equal("restore_space_id" in trashed, false);
  assert.equal(trashed.trashed_at, "t1");
  // v0: the record-named root is content; its child and the old root are roots.
  assert.equal(storage.values.get(`page/${otherHome}`).project_content, OTHER);
  assert.equal(storage.values.get(`page/${otherTop}`).space_id, OTHER);
  assert.equal(storage.values.get(`page/${legacyRoot}`).space_id, OTHER);
  // otherTop and legacyRoot both held "a1": the tie is repaired.
  assert.notEqual(
    storage.values.get(`page/${otherTop}`).position,
    storage.values.get(`page/${legacyRoot}`).position,
  );
  assert.deepEqual(storage.values.get(`space/${PROJECT}`), {
    space_id: PROJECT,
    title: "Launch",
    description: "kept",
    document_id: home,
    created_at: "t0",
  });
  // The shape check now passes and the steady-state reader agrees.
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
  const { entries, contents } = await locationScan(storage);
  assert.deepEqual([...contents.keys()].sort(), [home, otherHome].sort());
  assert.deepEqual(checkInvariants({ revision: 0, entries }, { projects: [PROJECT, OTHER] }), []);
  assert.equal(hasLegacyHomeShape(treeValues(storage), []), false);
});

test("apply keeps every prior value once, is idempotent, and resumes after a crash", async () => {
  const storage = retired();
  // Crash after the first batch transaction (2 keys per call: one item).
  storage.failAfterTransactions = 1;
  await assert.rejects(
    applyHomeRemoval(storage, { listAll, perBatch: 3, rewriteSpaces: async () => {} }),
    /crash/,
  );
  assert.equal((await storage.get(HOME_REMOVAL_STATE_KEY)).phase, "applying");
  assert.equal((await storage.get(HOME_REMOVAL_STATE_KEY)).next, 1);
  storage.failAfterTransactions = Infinity;
  const resumed = await applyHomeRemoval(storage, {
    listAll,
    perBatch: 3,
    rewriteSpaces: async () => assert.fail("a resumed apply doesn't plan again"),
  });
  assert.equal(resumed.state.phase, "done");
  const again = await applyHomeRemoval(storage, {
    listAll,
    perBatch: 3,
    rewriteSpaces: async () => {},
  });
  assert.equal(again.writes, 0, "a finished apply has nothing to do");
  // Before-images hold the values from before the first write.
  const original = retired();
  for (const [key, value] of storage.values)
    if (
      key.startsWith(HOME_REMOVAL_BACKUP_PREFIX) &&
      key !== `${HOME_REMOVAL_BACKUP_PREFIX}host/location/shape`
    )
      assert.deepEqual(
        value,
        original.values.get(key.slice(HOME_REMOVAL_BACKUP_PREFIX.length)),
        key,
      );
  assert.equal(storage.values.get(`${HOME_REMOVAL_BACKUP_PREFIX}page/${home}`).home, true);
  // The shape record's prior value is kept too, and v2 is stamped.
  assert.deepEqual(storage.values.get(`${HOME_REMOVAL_BACKUP_PREFIX}host/location/shape`), {
    version: 1,
    state: "migrated",
  });
  assert.deepEqual(storage.values.get(LOCATION_SHAPE_KEY), { version: 2, state: "migrated" });
});

test("a Catalog with no shape record saves the record's absence as its before-image", async () => {
  const storage = retired();
  storage.values.delete(LOCATION_SHAPE_KEY);
  await apply(storage);
  assert.deepEqual(
    storage.values.get(`${HOME_REMOVAL_BACKUP_PREFIX}host/location/shape`),
    HOME_REMOVAL_ABSENT,
  );
});

/** Ten Projects, 95 children in all, as Astra's reproduction built them. */
const wide = ({ tied = false } = {}) => {
  const values = { [LOCATION_SHAPE_KEY]: { version: 1, state: "migrated" } };
  let n = 0;
  for (let p = 0; p < 10; p++) {
    const spaceId = `prj_${String(p).padStart(8, "0")}-0000-4000-8000-000000000000`;
    const contentId = `c${p}`;
    values[`space/${spaceId}`] = { space_id: spaceId, home_page_id: contentId };
    values[`page/${contentId}`] = entry(contentId, {
      parent_id: null,
      position: "a0",
      space_id: spaceId,
      home: true,
    });
    for (let c = 0; c < (p < 5 ? 10 : 9); c++, n++) {
      const pageId = `k${String(n).padStart(3, "0")}`;
      values[`page/${pageId}`] = entry(pageId, {
        parent_id: contentId,
        position: tied ? "a0" : `a${c}`,
      });
    }
  }
  return new Storage(values);
};

test("an interrupted apply is never read or stamped: reads refuse until the whole plan is validated", async () => {
  const storage = wide();
  // Stop after 63 writes: one full batch at 127 keys per call.
  storage.failAfterTransactions = 1;
  await assert.rejects(
    applyHomeRemoval(storage, { listAll, perBatch: 127, rewriteSpaces: async () => {} }),
    /crash/,
  );
  // Markers are gone from many entries, children still point at content.
  assert.ok(validateHomeRemoval(await readHomeRemovalInput(storage, listAll)).length > 0);
  await assert.rejects(locationScan(storage), { status: 503, code: "location_migration_required" });
  assert.deepEqual(await migrateLocationShape(storage), {
    name: "blocked",
    reason: "home_removal_required",
  });
  storage.failAfterTransactions = Infinity;
  await applyHomeRemoval(storage, { listAll, perBatch: 127, rewriteSpaces: async () => {} });
  const { entries, contents } = await locationScan(storage);
  assert.equal(contents.size, 10);
  assert.equal(entries.size, 95);
  assert.deepEqual(validateHomeRemoval(await readHomeRemovalInput(storage, listAll)), []);
  assert.deepEqual(await migrateLocationShape(storage), { name: "migrated" });
});

test("tied siblings keep their order across a crash and resume", async () => {
  const order = async (storage) => {
    const { entries } = await locationScan(storage);
    return [...entries.values()]
      .filter((e) => e.space_id === "prj_00000000-0000-4000-8000-000000000000")
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
      .map((e) => e.page_id);
  };
  const clean = wide({ tied: true });
  await apply(clean, 7);
  const expected = await order(clean);
  assert.deepEqual(expected, [...expected].sort(), "ties resolve in page order");
  const crashed = wide({ tied: true });
  crashed.failAfterTransactions = 1;
  await assert.rejects(
    applyHomeRemoval(crashed, { listAll, perBatch: 7, rewriteSpaces: async () => {} }),
    /crash/,
  );
  crashed.failAfterTransactions = Infinity;
  await applyHomeRemoval(crashed, { listAll, perBatch: 7, rewriteSpaces: async () => {} });
  assert.deepEqual(await order(crashed), expected);
});

test("a crash while planning plans again; changes made after planning survive", async () => {
  const storage = retired();
  await storage.put(HOME_REMOVAL_STATE_KEY, { phase: "planning" });
  await assert.rejects(locationScan(storage), { status: 503 });
  // Plan, stop before applying, then a title projection lands.
  const original = storage.transaction.bind(storage);
  storage.transaction = async () => {
    throw new Error("crash");
  };
  await assert.rejects(
    applyHomeRemoval(storage, { listAll, perBatch: 127, rewriteSpaces: async () => {} }),
    /crash/,
  );
  assert.equal((await storage.get(HOME_REMOVAL_STATE_KEY)).phase, "applying");
  storage.values.set(`page/${top}`, { ...storage.values.get(`page/${top}`), title: "Renamed" });
  storage.transaction = original;
  await applyHomeRemoval(storage, { listAll, perBatch: 127, rewriteSpaces: async () => {} });
  assert.equal(storage.values.get(`page/${top}`).title, "Renamed");
  assert.equal(storage.values.get(`page/${top}`).space_id, PROJECT);
  assert.deepEqual(patchOf({ a: 1, b: 2 }, { a: 1, c: 3 }), { set: { c: 3 }, unset: ["b"] });
});

test("a plan that fails validation stays failed and keeps refusing reads", async () => {
  // A child whose content entry is missing can't be validated away later:
  // simulate an entry written under the content document meanwhile.
  const storage = retired();
  const rewrite = async () => {
    storage.values.set(`page/${id(9)}`, entry(id(9), { parent_id: home, position: "a9" }));
  };
  const result = await applyHomeRemoval(storage, {
    listAll,
    perBatch: 127,
    rewriteSpaces: rewrite,
  });
  assert.equal(result.state.phase, "failed");
  assert.ok(result.state.problems.some((problem) => problem.includes(id(9))));
  await assert.rejects(locationScan(storage), { status: 503 });
  assert.notDeepEqual(storage.values.get(LOCATION_SHAPE_KEY), { version: 2, state: "migrated" });
  // Fixing the entry and applying again finishes.
  storage.values.delete(`page/${id(9)}`);
  assert.equal(
    (await applyHomeRemoval(storage, { listAll, perBatch: 127, rewriteSpaces: async () => {} }))
      .state.phase,
    "done",
  );
});

test("homeRemovalStep: every phase takes exactly its events", () => {
  const states = {
    none: { phase: "none" },
    planning: { phase: "planning" },
    applying: { phase: "applying", next: 1, total: 3 },
    applied: { phase: "applying", next: 3, total: 3 },
    done: { phase: "done" },
    failed: { phase: "failed", problems: ["x"] },
  };
  const events = {
    start: { type: "start" },
    planned: { type: "planned", total: 3 },
    batch: { type: "batch", next: 2 },
    validated: { type: "validated" },
    invalid: { type: "invalid", problems: ["p"] },
  };
  const expected = {
    none: { start: "planning" },
    planning: { start: "planning", planned: "applying" },
    applying: { batch: "applying" },
    applied: { validated: "done", invalid: "failed" },
    done: {},
    failed: { start: "planning" },
  };
  for (const [name, state] of Object.entries(states))
    for (const [type, event] of Object.entries(events)) {
      const result = homeRemovalStep(state, event);
      const next = expected[name][type];
      if (next) assert.equal(result.state.phase, next, `${name} + ${type}`);
      else assert.ok(result.rejected, `${name} + ${type}`);
    }
  assert.ok(
    homeRemovalStep(states.applying, { type: "batch", next: 1 }).rejected,
    "never backwards",
  );
  assert.ok(
    homeRemovalStep(states.applying, { type: "batch", next: 4 }).rejected,
    "never past the end",
  );
  assert.ok(homeRemovalStep(states.planning, { type: "planned", total: -1 }).rejected);
  assert.ok(homeRemovalStep(states.none, { type: "nope" }).rejected);
  assert.equal(homeRemovalStep(undefined, events.start).state.phase, "planning");
});

test("pending creations and stored receipts move to the current names", () => {
  assert.deepEqual(
    migrateIntent({
      phase: "home_created",
      homeTitle: "Launch",
      spaceId: PROJECT,
      pageId: home,
      space: { space_id: PROJECT, home_page_id: home },
    }),
    {
      phase: "content_created",
      contentTitle: "Launch",
      spaceId: PROJECT,
      pageId: home,
      space: { space_id: PROJECT, document_id: home },
    },
  );
  assert.deepEqual(
    migrateIntent({
      phase: "ready",
      pending: false,
      receipt: { space_id: PROJECT, home_page_id: home, home_page_title: "Launch" },
    }),
    { phase: "ready", pending: false, receipt: { space_id: PROJECT, document_id: home } },
  );
  // A superseded receipt nests the Project it reports.
  assert.deepEqual(
    migrateIntent({
      receipt: { superseded: true, space: { space_id: PROJECT, home_page_id: home } },
    }),
    { receipt: { superseded: true, space: { space_id: PROJECT, document_id: home } } },
  );
  const page = { pageId: top, receipt: { page_id: top } };
  assert.equal(migrateIntent(page), page, "unrelated intents are untouched");
});

test("intents are part of the plan; a space_recorded creation keeps its phase", async () => {
  const storage = retired({
    "host/operation/k1": { pending: true, phase: "home_created", homeTitle: "x", pageId: id(9) },
    "host/operation/k2": {
      pending: true,
      phase: "space_recorded",
      pageId: id(9),
      space: { home_page_id: id(9) },
    },
    "host/operation/k3": { pending: false, receipt: { page_id: top } },
  });
  const { report } = await apply(storage);
  assert.equal(report.intents_changed, 2);
  assert.equal(storage.values.get("host/operation/k1").phase, "content_created");
  assert.equal(storage.values.get("host/operation/k2").phase, "space_recorded");
  assert.deepEqual(storage.values.get("host/operation/k2").space, { document_id: id(9) });
});

test("a duplicate home flag or a trashed flagged entry stays an ordinary Page", async () => {
  const storage = retired({
    [`page/${id(9)}`]: entry(id(9), {
      parent_id: null,
      position: "a5",
      space_id: PROJECT,
      home: true,
    }),
    [`trash/${id(0)}`]: entry(id(0), {
      parent_id: null,
      position: "a6",
      space_id: PROJECT,
      home: true,
      state: "trashed",
    }),
  });
  await apply(storage);
  assert.deepEqual(
    storage.values.get(`page/${id(9)}`),
    entry(id(9), { parent_id: null, position: "a5", space_id: PROJECT }),
  );
  assert.equal("home" in storage.values.get(`trash/${id(0)}`), false);
  assert.equal(hasLegacyHomeShape(treeValues(storage), []), false);
});

test("a content entry it can't convert blocks the plan", async () => {
  const notRoot = retired({
    [`page/${home}`]: entry(home, {
      parent_id: loose,
      position: "a0",
      home: true,
      space_id: PROJECT,
    }),
  });
  assert.deepEqual((await plan(notRoot)).report.blockers, [
    { code: "content_not_root", page_id: home, project_id: PROJECT },
  ]);
  const inTrash = retired({
    [`trash/${home}`]: entry(home, { parent_id: null, position: "a0", state: "trashed" }),
  });
  inTrash.values.delete(`page/${home}`);
  assert.deepEqual((await plan(inTrash)).report.blockers, [
    { code: "content_trashed", page_id: home, project_id: PROJECT },
  ]);
});

test("a pending content document converts like an active one", async () => {
  const storage = retired({
    [`page/${home}`]: entry(home, {
      parent_id: null,
      position: "a0",
      space_id: PROJECT,
      home: true,
      pending: true,
    }),
  });
  await apply(storage);
  assert.deepEqual(
    storage.values.get(`page/${home}`),
    entry(home, { pending: true, project_content: PROJECT }),
  );
});

test("the Space record and its stored receipts lose the retired names", () => {
  const record = { space_id: PROJECT, home_page_id: home, acl: { revision: 2, members: {} } };
  const receipts = new Map([
    [
      "host/receipt/a",
      { fingerprint: "f", receipt: { space_id: PROJECT, home_page_id: home }, at: 1 },
    ],
    [
      "host/receipt/b",
      { fingerprint: "g", receipt: { space_id: PROJECT, document_id: home }, at: 2 },
    ],
  ]);
  const { writes } = planSpaceHomeRemoval(record, receipts);
  assert.deepEqual(writes.get("space/record"), {
    space_id: PROJECT,
    document_id: home,
    acl: { revision: 2, members: {} },
  });
  assert.deepEqual(writes.get("host/receipt/a").receipt, { space_id: PROJECT, document_id: home });
  assert.equal(writes.has("host/receipt/b"), false);
  assert.equal(planSpaceHomeRemoval(writes.get("space/record")).writes.size, 0, "idempotent");
});

/** Run `locationScan` with a pause after it lists `page/`, letting `during`
 * change storage before the scan finishes. */
async function scanAround(storage, during) {
  const list = storage.list.bind(storage);
  let release;
  const paused = new Promise((resolve) => (release = resolve));
  let reached;
  const atPause = new Promise((resolve) => (reached = resolve));
  storage.list = async (options) => {
    const result = await list(options);
    if (options?.prefix === "page/") {
      storage.list = list;
      reached();
      await paused;
    }
    return result;
  };
  const scan = locationScan(storage).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await atPause;
  await during();
  release();
  return scan;
}

test("a scan that captured retired rows refuses when an apply completes before it ends", async () => {
  const storage = retired();
  storage.values.delete(LOCATION_SHAPE_KEY);
  // Rows are captured before the apply starts.
  const result = await scanAround(storage, async () => {
    await applyHomeRemoval(storage, { listAll, perBatch: 127, rewriteSpaces: async () => {} });
  });
  assert.equal(result.error?.code, "location_migration_required", JSON.stringify(result.value));
  // A fresh scan after the apply is sound.
  const { contents } = await locationScan(storage);
  assert.ok(contents.has(home));
});

test("a scan overlapping a resumed apply refuses instead of mixing half-rewritten rows", async () => {
  const storage = wide();
  storage.failAfterTransactions = 1;
  await assert.rejects(
    applyHomeRemoval(storage, { listAll, perBatch: 127, rewriteSpaces: async () => {} }),
    /crash/,
  );
  storage.failAfterTransactions = Infinity;
  // Hide the in-progress state at the scan's start, as a stale read would,
  // then resume the apply while the scan is paused.
  const state = storage.values.get(HOME_REMOVAL_STATE_KEY);
  storage.values.set(HOME_REMOVAL_STATE_KEY, { phase: "done" });
  const result = await scanAround(storage, async () => {
    storage.values.set(HOME_REMOVAL_STATE_KEY, state);
    await applyHomeRemoval(storage, { listAll, perBatch: 127, rewriteSpaces: async () => {} });
  });
  assert.equal(result.error?.code, "location_migration_required");
  const { entries, contents } = await locationScan(storage);
  assert.equal(entries.size, 95);
  assert.equal(contents.size, 10);
  for (const entry of entries.values()) assert.ok(!contents.has(entry.parent_id));
});
