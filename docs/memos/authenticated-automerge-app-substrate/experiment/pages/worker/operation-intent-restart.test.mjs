// Crash and restart sweeps against a real Page. Each scenario runs once to
// completion, then once per Catalog storage write with that write failing.
// After each crash a fresh Catalog over the same storage retries against the
// same Page, which kept its records, receipts and revision across the
// Catalog's restart. The retry must end where the uninterrupted run did.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { proposeAccessUpdate, pageState } from "./access.mjs";
import { countCapacity, lifecycleSlot, projectLifecycle } from "./catalog.mjs";
import { Catalog, Page, lifecycleBounds } from "./index.mjs";
import { CrashStorage, describe, normalize, scrubbed } from "./operation-intent-fixture.mjs";
import { DocumentPolicy } from "./policy.mjs";

const auth = await createAuthFixture();
const owner = `user:anaconda-fixture:${auth.subject}`;
const member = "user:anaconda-fixture:member-user";
const token = auth.apiKey();
const pageId = "33333333-3333-4333-8333-333333333333";
const parentId = "22222222-2222-4222-8222-222222222222";
const serverKey = "f".repeat(64);
const CREATED = "2026-10-01T00:00:00.000Z";
const KEY = "sweep-key-0001";
const LIMIT = 100;
// The cuts after the forwarded mark and before the retarget's write.
const RETARGET_LOST = [2, 3, 4, 5, 6];
// The cuts after the forwarded mark and before the guarded release's sync.
const GUARD_LOST = [2, 3, 4, 5];
let swept = 0;
const SWEPT = 70;
// Counting keeps a fenced reservation and counts it.
const RETAINED_COUNTED = true;
// The projection's transaction rolls back: nothing it wrote stays.
function afterPartialProjection(storage, before) {
  assert.deepEqual(normalize(storage.values), before);
}
// One document for every run, so request fingerprints over its heads match.
const DOCUMENT = A.save(
  A.change(A.from(createPageData({ pageId, title: "Launch plan" })), (draft) =>
    initializePage(draft, "We ship on Friday."),
  ),
);

/** Any other Page only accepts its creation, so a scenario can add a child. */
async function createdChild(request) {
  const path = new URL(request.url).pathname;
  if (path !== "/internal/create") throw new Error(`Unexpected child request ${path}`);
  const { page_id, title } = await request.json();
  return Response.json({ page_id, title });
}

/** One owner's Catalog and one real Page, connected by a network that can
 * drop a request before the Page sees it or lose the Page's reply. */
async function world({ location } = {}) {
  let doc = A.load(DOCUMENT);
  const base = { pageId, owner, documentId: "fixture-document", tree: "a".repeat(32) };
  const acl = proposeAccessUpdate(
    base,
    { principal: owner, canWrite: true, expiresAt: Date.now() + 60_000 },
    { principal: member, role: "editor", expected_revision: 0 },
  ).acl;
  const network = { drop: 0, lose: 0 };
  const writes = [];
  let armed = false;
  let failAt;
  let count = 0;
  const storage = new CrashStorage((mutation, target) => {
    if (!armed) return;
    const index = count++;
    writes.push({ index, label: describe(mutation, pageId), before: normalize(target.committed) });
    if (index === failAt) throw new Error("injected storage failure");
  });
  const pageStorage = new CrashStorage();
  const env = {
    ...auth.env,
    PAGES: {
      getByName: (id) => ({
        fetch: async (request) => {
          if (id !== pageId) return createdChild(request);
          if (network.drop > 0) {
            network.drop--;
            throw new Error("connection refused");
          }
          const response = await page.fetch(request);
          if (network.lose > 0) {
            network.lose--;
            throw new Error("connection reset");
          }
          return response;
        },
      }),
    },
    // Title projections the Page sends its readers' Catalogs.
    CATALOGS: { getByName: () => ({ fetch: async () => Response.json({}) }) },
  };
  const page = Object.assign(Object.create(Page.prototype), {
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    env,
    ctx: { storage: pageStorage, waitUntil: () => {} },
    metadata: { ...base, ownerName: "Owner", deleted: false, acl },
    handle: { doc: () => doc, broadcast() {}, on() {}, off() {} },
    wires: new Set(),
    serverKey,
    serverSenderId: "server-sender",
    repo: { async delete() {} },
    backend: { async flush() {} },
  });
  page.policy = new DocumentPolicy({
    storage: pageStorage,
    metadata: () => page.metadata,
    serverKey,
  });
  storage.values.set(`page/${pageId}`, {
    page_id: pageId,
    title: "Launch plan",
    created_at: CREATED,
    updated_at: CREATED,
    lifecycle_revision: 0,
    // Only the owner's Catalog records location.
    ...location,
  });
  const catalog = () => new Catalog({ id: { name: owner }, storage }, env);
  const call = async (target, operation, args) => {
    const response = await target.fetch(
      new Request("https://pages.invalid/internal/catalog", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({ operation, arguments: args }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  return {
    storage,
    pageStorage,
    page,
    network,
    writes,
    catalog,
    call,
    heads: () => A.getHeads(doc),
    /** Everything durable or cached on both sides, to start another run from. */
    snapshot: () => ({
      storage: structuredClone(storage.values),
      pageStorage: structuredClone(pageStorage.values),
      metadata: structuredClone(page.metadata),
      doc: A.save(doc),
    }),
    resume(saved) {
      storage.values = structuredClone(saved.storage);
      pageStorage.values = structuredClone(saved.pageStorage);
      page.metadata = structuredClone(saved.metadata);
      doc = A.load(saved.doc);
    },
    edit(title) {
      doc = A.change(doc, (draft) => {
        draft.title = title;
      });
    },
    arm(index) {
      armed = true;
      failAt = index;
    },
    disarm() {
      armed = false;
    },
  };
}

const trash = (w, target, key, heads = w.heads()) =>
  w.call(target, "delete_page", { page_id: pageId, base_heads: heads, idempotency_key: key });
const restore = (w, target, key) =>
  w.call(target, "restore_page", { page_id: pageId, idempotency_key: key });
const expire = (w, key) => {
  const slot = w.storage.values.get(key);
  w.storage.values.set(key, { ...slot, expires_at: Date.now() - 1 });
};
const succeeded = (outcome) =>
  !(outcome instanceof Error) && (outcome?.status === undefined || outcome.status < 500);

async function observe(w, outcome) {
  // Capacity as a fresh count sees it, over a copy so the count changes
  // nothing.
  const copy = new CrashStorage();
  copy.values = structuredClone(w.storage.values);
  return {
    outcome: outcome instanceof Error ? { error: outcome.message } : scrubbed(outcome ?? null),
    storage: normalize(w.storage.values),
    page: {
      state: pageState(w.page.metadata),
      revision: w.page.metadata.lifecycleRevision ?? 0,
      placement: w.page.metadata.placement,
      receipts: [...w.pageStorage.values.keys()].filter((name) =>
        name.startsWith("host/lifecycle/"),
      ).length,
    },
    capacity: {
      trash: await countCapacity(copy, "trash/"),
      pages: await countCapacity(copy, "page/"),
    },
  };
}

/**
 * Run `scenario` uninterrupted, then once per Catalog write in `act` with
 * that write failing. Returns the writes, the indexes of the cuts a retry
 * left different from the uninterrupted run, and what those retries saw.
 */
async function sweep(t, scenario) {
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  // One clock for every run, so tokens and expiries match.
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  // Setup runs once; every run starts from what it left.
  const template = await world(scenario.world);
  await scenario.setup?.(template);
  const saved = template.snapshot();
  const run = async (failAt) => {
    const w = await world(scenario.world);
    w.resume(saved);
    w.arm(failAt);
    const outcome = await scenario.act(w, w.catalog()).catch((error) => error);
    w.disarm();
    return { w, outcome };
  };
  const first = await run();
  assert.ok(succeeded(first.outcome), `${scenario.name}: ${JSON.stringify(first.outcome)}`);
  const expected = await observe(first.w, first.outcome);
  scenario.check?.(expected);
  const unrepaired = [];
  const diverged = [];
  const differences = [];
  for (const write of first.w.writes) {
    const where = `${scenario.name}: crash at ${write.label} (write ${write.index})`;
    const { w, outcome } = await run(write.index);
    assert.ok(
      outcome instanceof Error || outcome?.status >= 500,
      `${where}: reported ${JSON.stringify(outcome)}`,
    );
    assert.equal(w.storage.depth, 0, `${where}: no transaction is left open`);
    assert.deepEqual(
      normalize(w.storage.values),
      write.before,
      `${where}: storage before the write`,
    );
    const retried = await scenario.act(w, w.catalog()).catch((error) => error);
    const actual = await observe(w, retried);
    try {
      assert.deepEqual(actual, expected);
    } catch (error) {
      unrepaired.push(write.index);
      diverged.push(actual);
      differences.push(`${where}\n${error.message}`);
    }
  }
  swept += first.w.writes.length;
  return {
    writes: first.w.writes.map((write) => write.label),
    unrepaired,
    diverged,
    differences: differences.join("\n\n"),
  };
}

const trashedFields = (body) => ({ state: body.state, trashed: body.trashed });

test("a Trash request resumes from every cut", async (t) => {
  const result = await sweep(t, {
    name: "trash",
    act: (w, catalog) => trash(w, catalog, KEY),
    check({ outcome, page, capacity }) {
      assert.deepEqual(trashedFields(outcome.body), { state: "trashed", trashed: true });
      assert.deepEqual(page, { state: "trashed", revision: 1, placement: undefined, receipts: 1 });
      assert.deepEqual(capacity, { trash: 1, pages: 0 });
    },
  });
  assert.deepEqual(result.unrepaired, [], result.differences);
  assert.equal(result.writes.length, 7);
});

test("a restore to the top level resumes from every cut with its location", async (t) => {
  const nested = { parent_id: parentId, position: "a1" };
  const result = await sweep(t, {
    name: "restore",
    world: { location: nested },
    async setup(w) {
      // The parent is in Trash, so the restored Page returns to the top level.
      w.storage.values.set(`trash/${parentId}`, {
        page_id: parentId,
        title: "Parent",
        created_at: CREATED,
        updated_at: CREATED,
        lifecycle_revision: 1,
        state: "trashed",
        trashed_by: owner,
        trash_root_id: parentId,
      });
      assert.equal((await trash(w, w.catalog(), "setup-trash")).status, 200);
    },
    act: (w, catalog) => restore(w, catalog, KEY),
    check({ outcome, page, storage }) {
      assert.equal(outcome.body.restored, true);
      assert.equal(page.revision, 2);
      assert.equal(page.placement, undefined, "the Page learns no location");
      // The parent is in Trash: the Catalog's projection puts the Page at the
      // top level of Your items, and the receipt says so.
      assert.equal(outcome.body.parent_id, undefined);
      const entry = storage[`page/${pageId}`];
      assert.deepEqual(
        {
          parent_id: entry.parent_id,
          position: entry.position,
          lifecycle_revision: entry.lifecycle_revision,
        },
        { parent_id: null, position: "a0", lifecycle_revision: 2 },
      );
      assert.equal(storage[`trash/${pageId}`], undefined);
    },
  });
  assert.deepEqual(result.unrepaired, [], result.differences);
  assert.equal(result.writes.length, 7);
});

test("a purge confirmation resumes from every cut", async (t) => {
  let token;
  const result = await sweep(t, {
    name: "purge",
    async setup(w) {
      const catalog = w.catalog();
      assert.equal((await trash(w, catalog, "setup-trash")).status, 200);
      const preview = await w.call(catalog, "purge_page", { page_id: pageId, action: "preview" });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      token = preview.body.preview_token;
    },
    act: (w, catalog) =>
      w.call(catalog, "purge_page", {
        page_id: pageId,
        action: "confirm",
        preview_token: token,
        idempotency_key: KEY,
      }),
    check({ outcome, page, storage, capacity }) {
      assert.deepEqual(outcome.body, { page_id: pageId, deleted: true, purged: true });
      assert.equal(page.state, "deleted");
      assert.equal(storage[`host/deleted/${pageId}`], true);
      assert.deepEqual(capacity, { trash: 0, pages: 0 });
    },
  });
  assert.deepEqual(result.unrepaired, [], result.differences);
  assert.ok(result.writes.length >= 7);
});

test("a Trash request against a stale index retargets once from every cut", async (t) => {
  const result = await sweep(t, {
    name: "retarget",
    async setup(w) {
      const catalog = w.catalog();
      assert.equal((await trash(w, catalog, "setup-trash")).status, 200);
      assert.equal((await restore(w, catalog, "setup-restore")).status, 200);
      // The Catalog's index is two transitions behind the Page.
      const entry = w.storage.values.get(`page/${pageId}`);
      w.storage.values.set(`page/${pageId}`, { ...entry, lifecycle_revision: 0 });
    },
    act: (w, catalog) => trash(w, catalog, KEY),
    check({ outcome, page, capacity }) {
      assert.deepEqual(trashedFields(outcome.body), { state: "trashed", trashed: true });
      assert.equal(page.revision, 3);
      assert.deepEqual(capacity, { trash: 1, pages: 0 });
    },
  });
  assert.deepEqual(result.writes, [
    "put host/operation/sweep-key-0001+trash/<id>",
    "put host/operation/sweep-key-0001",
    "put host/index/dirty",
    "put page/<id>",
    "delete trash/<id>",
    "put trash/<id>",
    "put host/operation/sweep-key-0001",
    "put host/index/dirty",
    "put trash/<id>",
    "delete page/<id>",
    "put host/operation/sweep-key-0001",
    "sync",
  ]);
  // Once forwarded, the request may have reached the Page, which can have
  // applied it and since evicted the receipt, so a resumed request never
  // retargets. A crash between the Page's superseded answer and the
  // retarget's write therefore ends superseded on retry, applying nothing.
  assert.deepEqual(result.unrepaired, RETARGET_LOST, result.differences);
  for (const actual of result.diverged) {
    assert.deepEqual(actual.outcome.body, {
      page_id: pageId,
      superseded: true,
      applied: false,
      state: "active",
    });
    assert.deepEqual(actual.page, {
      state: "active",
      revision: 2,
      placement: undefined,
      receipts: 2,
    });
    assert.deepEqual(actual.capacity, { trash: 0, pages: 1 });
    assert.equal(actual.storage[`page/${pageId}`].lifecycle_revision, 2);
    assert.equal(actual.storage[`trash/${pageId}`], undefined);
  }
});

test("a resumed Trash reruns the leaf guard before it retargets, from every cut", async (t) => {
  let heads;
  let childId;
  const result = await sweep(t, {
    name: "retarget with children",
    async setup(w) {
      heads = w.heads();
      // The parent's Trash is reserved at revision 0, and the Catalog
      // crashes at the forwarded mark.
      w.arm(1);
      assert.equal((await trash(w, w.catalog(), KEY)).status, 500);
      w.disarm();
      assert.equal(w.writes[1].label, `put host/operation/${KEY}`);
      // The never-forwarded reservation expires, and counting releases it.
      expire(w, `trash/${pageId}`);
      assert.equal(await w.catalog().countEntries("trash/"), 0);
      // Another request trashes and restores the parent: revision 2.
      const catalog = w.catalog();
      assert.equal((await trash(w, catalog, "setup-trash")).status, 200);
      assert.equal((await restore(w, catalog, "setup-restore")).status, 200);
      // A child is created under the active parent.
      const child = await w.call(catalog, "create_page", {
        title: "Child",
        parent_id: pageId,
        idempotency_key: "setup-child",
      });
      assert.equal(child.status, 200, JSON.stringify(child.body));
      childId = child.body.page_id;
    },
    // The original request resumes. The Page supersedes it at revision 0;
    // the guard runs before the retarget at revision 2 and finds the child.
    act: (w, catalog) => trash(w, catalog, KEY, heads),
    check({ outcome, page, storage, capacity }) {
      assert.equal(outcome.status, 409, JSON.stringify(outcome.body));
      assert.equal(outcome.body.code, "page_has_children");
      assert.deepEqual(page, { state: "active", revision: 2, placement: undefined, receipts: 2 });
      assert.equal(storage[`host/operation/${KEY}`], undefined, "the request is released");
      assert.equal(storage[`trash/${pageId}`], undefined);
      assert.equal(storage[`page/${pageId}`].lifecycle_revision, 2);
      assert.equal(storage[`page/${childId}`].parent_id, pageId);
      assert.deepEqual(capacity, { trash: 0, pages: 2 });
    },
  });
  assert.deepEqual(result.writes, [
    "put trash/<id>",
    "put host/operation/sweep-key-0001",
    "put host/index/dirty",
    "put page/<id>",
    "delete trash/<id>",
    "delete host/operation/sweep-key-0001",
    "sync",
  ]);
  // A cut after the forwarded mark loses the retarget, as above: the retry
  // ends superseded. The parent stays active beside its child either way.
  assert.deepEqual(result.unrepaired, GUARD_LOST, result.differences);
  for (const actual of result.diverged) {
    assert.deepEqual(actual.outcome.body, {
      page_id: pageId,
      superseded: true,
      applied: false,
      state: "active",
    });
    assert.deepEqual(actual.page, {
      state: "active",
      revision: 2,
      placement: undefined,
      receipts: 2,
    });
    assert.equal(actual.storage[`page/${childId}`].parent_id, pageId);
    assert.deepEqual(actual.capacity, { trash: 0, pages: 2 });
  }
});

test("a Trash retry after its reply was lost replays from every cut", async (t) => {
  const result = await sweep(t, {
    name: "lost reply",
    async setup(w) {
      w.network.lose = 1;
      assert.equal((await trash(w, w.catalog(), KEY)).status, 500);
    },
    act: (w, catalog) => trash(w, catalog, KEY),
    check({ outcome, page }) {
      assert.deepEqual(trashedFields(outcome.body), { state: "trashed", trashed: true });
      assert.deepEqual([page.revision, page.receipts], [1, 1]);
    },
  });
  assert.deepEqual(result.unrepaired, [], result.differences);
});

test("a replay-only retry the Page never applied completes superseded from every cut", async (t) => {
  const result = await sweep(t, {
    name: "replay only",
    async setup(w) {
      w.network.drop = 1;
      assert.equal((await trash(w, w.catalog(), KEY)).status, 500);
      // Past its lifetime, counting finds the Page unchanged and releases
      // the slot; Trash then fills.
      expire(w, `trash/${pageId}`);
      assert.equal(await w.catalog().countEntries("trash/"), 0);
      for (let index = 0; index < LIMIT; index++) {
        const id = `fill-${String(index).padStart(3, "0")}`;
        w.storage.values.set(`trash/${id}`, { page_id: id, title: id });
      }
    },
    act: (w, catalog) => trash(w, catalog, KEY),
    check({ outcome, page, capacity }) {
      assert.deepEqual(outcome.body, {
        page_id: pageId,
        superseded: true,
        applied: false,
        state: "active",
      });
      assert.deepEqual([page.state, page.revision, page.receipts], ["active", 0, 0]);
      assert.deepEqual(capacity, { trash: LIMIT, pages: 1 });
    },
  });
  assert.deepEqual(result.unrepaired, [], result.differences);
});

test("a Trash request refused before change releases from every cut", async (t) => {
  let stale;
  const result = await sweep(t, {
    name: "refused",
    async setup(w) {
      stale = w.heads();
      w.edit("Launch plan, revised");
    },
    act: (w, catalog) => trash(w, catalog, KEY, stale),
    check({ outcome, page, storage }) {
      assert.equal(outcome.status, 409);
      assert.equal(page.revision, 0);
      assert.equal(storage[`host/operation/${KEY}`], undefined);
      assert.equal(storage[`trash/${pageId}`], undefined);
    },
  });
  assert.deepEqual(result.unrepaired, [], result.differences);
});

test("a Trash retry after an earlier build's tombstone finishes from every cut", async (t) => {
  const result = await sweep(t, {
    name: "tombstone",
    async setup(w) {
      w.network.lose = 1;
      assert.equal((await trash(w, w.catalog(), KEY)).status, 500);
      w.storage.values.set(`host/deleted/${pageId}`, true);
    },
    act: (w, catalog) => trash(w, catalog, KEY),
    check({ page, storage, capacity }) {
      assert.equal(page.state, "deleted");
      assert.equal(storage[`trash/${pageId}`], undefined);
      assert.deepEqual(capacity, { trash: 0, pages: 0 });
    },
  });
  assert.deepEqual(result.unrepaired, [], result.differences);
});

/** A restore the Page applied whose reply was lost: its Page slot waits. */
async function appliedRestore(w) {
  const catalog = w.catalog();
  assert.equal((await trash(w, catalog, "setup-trash")).status, 200);
  w.network.lose = 1;
  assert.equal((await restore(w, catalog, KEY)).status, 500);
}

test("capacity counting settles an applied restore from every cut", async (t) => {
  const result = await sweep(t, {
    name: "count",
    async setup(w) {
      await appliedRestore(w);
      expire(w, `page/${pageId}`);
    },
    act: (w, catalog) => catalog.countEntries("page/"),
    check({ outcome, storage }) {
      assert.equal(outcome, 1);
      assert.equal(storage[`page/${pageId}`].lifecycle_revision, 2);
      assert.equal(storage[`trash/${pageId}`], undefined);
    },
  });
  assert.deepEqual(result.unrepaired, [], result.differences);
});

test("a placement check settles an applied restore from every cut", async (t) => {
  const result = await sweep(t, {
    name: "settle",
    setup: appliedRestore,
    act: (w, catalog) => catalog.settleReservation(pageId),
    check({ storage }) {
      assert.equal(storage[`page/${pageId}`].lifecycle_revision, 2);
      assert.equal(storage[`trash/${pageId}`], undefined);
    },
  });
  assert.deepEqual(result.unrepaired, [], result.differences);
});

test("the sweeps cut every Catalog write in every scenario", () => {
  assert.equal(swept, SWEPT);
});

// A pending restore whose Page slot sits beside a newer Trash entry, as a
// projection that failed partway leaves it: the Trash entry was written and
// the slot's delete was not.
const restoreKey = "host/operation/restore-key-0001";
function besideNewerEntry() {
  return new Map(
    Object.entries({
      [restoreKey]: {
        fingerprint: "restore",
        pending: true,
        forwarded: true,
        pageId,
        createdAt: CREATED,
        expectedRevision: 1,
      },
      ...lifecycleSlot("restore_page", pageId, restoreKey, Date.now() - 8 * 24 * 3600_000),
      [`trash/${pageId}`]: trashEntry(3),
    }),
  );
}
const trashEntry = (revision) => ({
  page_id: pageId,
  title: "Launch plan",
  created_at: CREATED,
  updated_at: CREATED,
  lifecycle_revision: revision,
  state: "trashed",
  trashed_at: CREATED,
  trashed_by: owner,
  trash_root_id: pageId,
});

test("a projection that fails partway rolls back whole", async () => {
  const storage = new CrashStorage((mutation) => {
    if (describe(mutation, pageId) === "delete page/<id>")
      throw new Error("injected storage failure");
  });
  storage.values = besideNewerEntry();
  storage.values.set(`trash/${pageId}`, trashEntry(1));
  const before = normalize(storage.values);
  await assert.rejects(
    projectLifecycle(storage, pageId, {
      page_id: pageId,
      state: "trashed",
      revision: 3,
      title: "Launch plan",
      trashed_at: CREATED,
      trashed_by: owner,
      trash_root_id: pageId,
    }),
    /injected storage failure/,
  );
  afterPartialProjection(storage, before);
});

test("a late lifecycle read after a newer projection meets the fence", async (t) => {
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  const readMs = lifecycleBounds.readMs;
  lifecycleBounds.readMs = 60_000;
  t.after(() => {
    lifecycleBounds.readMs = readMs;
  });
  const storage = new CrashStorage();
  storage.values = besideNewerEntry();
  // The Page answered before the newer Trash; the answer arrives after it.
  let release;
  const late = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const env = {
    ...auth.env,
    PAGES: {
      getByName: () => ({
        fetch: async () => {
          reads++;
          await late;
          return Response.json({
            page_id: pageId,
            state: "active",
            revision: 2,
            title: "Launch plan",
          });
        },
      }),
    },
  };
  const catalog = new Catalog({ id: { name: owner }, storage }, env);
  // A placement check gives up on the read; the read stays in flight.
  await assert.rejects(catalog.settleReservation(pageId, Date.now() + 5), {
    code: "lifecycle_unsettled",
  });
  // Counting shares that read, and gets the older answer.
  const counted = catalog.countEntries("page/");
  release();
  assert.equal(await counted, RETAINED_COUNTED ? 1 : 0);
  assert.equal(reads, 1, "the count reused the late read");
  assert.equal(storage.values.get(`page/${pageId}`).intent, restoreKey, "the fence kept the slot");
  assert.equal(storage.values.get(`trash/${pageId}`).lifecycle_revision, 3);
});
