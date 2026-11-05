import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Page, PageRecords } from "./index.mjs";
import { claimFromNative } from "./plain-sync.mjs";
import { migrationSlot, SLOT_WAIT_MS } from "./record-storage-migration.mjs";

const pageId = "55555555-5555-4555-8555-555555555555";

/** Durable Object storage: multi-key put and delete, prefix lists. */
class Storage {
  values = new Map();
  failPut = null;
  failSyncAfterFlip = false;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    const first = typeof key === "string" ? key : Object.keys(key)[0];
    if (this.failPut && first.startsWith(this.failPut)) {
      this.failPut = null;
      throw new Error("injected put failure");
    }
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key))
        this.values.set(name, structuredClone(entry));
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    const keys = Array.isArray(key) ? key : [key];
    for (const name of keys) this.values.delete(name);
    return keys.length;
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort()
      .slice(0, limit);
    return new Map(keys.map((key) => [key, structuredClone(this.values.get(key))]));
  }
  async sync() {
    // Fails the first barrier after the record says plain: after the flip.
    if (this.failSyncAfterFlip && this.values.get("host/document")?.recordStorage === "automerge") {
      this.failSyncAfterFlip = false;
      throw new Error("injected sync failure");
    }
  }
  keys(prefix) {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
}

const requestFor = (token, path, body) =>
  new Request(`https://pages.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function fixture(t, { buffered = false } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  const records = new Storage();
  const base = {
    ...auth.env,
    CATALOGS: { getByName: () => ({ fetch: async () => Response.json({}) }) },
    ...(buffered && {
      PAGES_ASYNC_PERSISTENCE: "true",
      PAGE_RECORDS: { getByName: () => new PageRecords({ storage: records }) },
    }),
  };
  const native = base;
  const migrating = {
    ...base,
    PAGES_RECORD_STORAGE: "automerge",
    PAGES_MIGRATE_RECORD_STORAGE: "true",
    PAGES_MIGRATE_PAGE_IDS: JSON.stringify([pageId]),
    PAGES_MIGRATE_QUIET_MS: "20",
  };
  const pages = [];
  const open = async (env) => {
    const page = new Page(
      {
        id: { name: pageId },
        storage,
        blockConcurrencyWhile: (fn) => fn(),
        waitUntil() {},
      },
      env,
    );
    pages.push(page);
    await page.ready;
    return page;
  };
  const close = async (page) => {
    // A host left in backoff keeps a retry timer armed.
    page.disarmMigration();
    if (page.migration) page.migration = { name: "off" };
    await page.plain?.close().catch(() => {});
    await page.policy?.close?.().catch?.(() => {});
    await page.repo?.shutdown().catch(() => {});
    await page.backend?.close?.().catch(() => {});
    try {
      page.signer?.free();
    } catch {}
  };
  t.after(async () => {
    for (const page of pages) await close(page);
  });
  const owner = auth.apiKey();
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  const migrationLines = () =>
    lines
      .filter((line) => line.includes("record_storage.migration"))
      .map((line) => JSON.parse(line));
  /** A Subduction Page with an edit, a comment thread, a person's actor
   * entry and a comment-blocked binding. */
  const nativePage = async () => {
    const first = await open(native);
    const created = await first.fetch(
      requestFor(owner, "/internal/create", {
        page_id: pageId,
        title: "Kept",
        markdown: "Body",
      }),
    );
    assert.equal(created.status, 201, await created.clone().text());
    assert.notEqual(first.metadata.recordStorage, "automerge");
    await first.handle.change((d) => (d.edited = "before migration"));
    await first.commentsHandle.change((d) => {
      d.threads.t1 = { target: "page", messages: {} };
    });
    await first.flush();
    await storage.put("host/actor/" + "ab".repeat(16), {
      key: "cd".repeat(32),
      principal: "account:alice",
      displayName: "Alice",
      driver: "Browser",
      firstSeen: 1,
    });
    await storage.put("host/actor/" + "ef".repeat(16), { conflict: true });
    await storage.put("host/binding/" + "11".repeat(32), {
      principal: "account:bob",
      commentsBlocked: true,
    });
    const heads = A.getHeads(first.handle.doc());
    await close(first);
    return { heads };
  };
  /** Boot a host, then open and close a browser socket on it. */
  const session = async (page) => {
    await page.documentReady();
    const wire = {};
    page.wires.add(wire);
    page.reportActivity();
    page.wires.delete(wire);
    page.reportActivity();
  };
  const settled = async (page, names, timeout = 5000) => {
    const start = Date.now();
    while (!names.includes(page.migration?.name)) {
      if (Date.now() - start > timeout)
        throw Error(`migration stayed ${JSON.stringify(page.migration)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return {
    owner,
    storage,
    records,
    native,
    migrating,
    open,
    close,
    nativePage,
    session,
    settled,
    migrationLines,
  };
}

test("native actor entries become plain claims; conflicts stay unclaimable", () => {
  assert.deepEqual(
    claimFromNative({ key: "k", principal: "p", displayName: "P", driver: "B", firstSeen: 3 }, 9),
    { principal: "p", displayName: "P", driver: "B", firstSeen: 3 },
  );
  assert.deepEqual(claimFromNative({ conflict: true }, 9), {
    conflict: true,
    firstSeen: 9,
  });
  assert.equal(claimFromNative({ key: "k" }, 9), null);
});

for (const buffered of [false, true]) {
  test(`a ${buffered ? "buffered" : "local"} Page converts once its last browser leaves`, async (t) => {
    const f = await fixture(t, { buffered });
    const { heads } = await f.nativePage();
    const host = await f.open(f.migrating);
    // Booting alone, as a listing check would, makes nothing eligible.
    await host.documentReady();
    assert.equal(host.migration.name, "dormant");
    await f.session(host);
    await f.settled(host, ["retired"]);
    const stored = await f.storage.get("host/document");
    assert.equal(stored.recordStorage, "automerge");
    assert.equal(stored.recordStorageMigratedFrom, buffered ? "buffered" : "local");
    assert.ok(stored.recordStorageMigratedAt);
    // The retired object never serves or writes again.
    await assert.rejects(host.documentReady(), {
      code: "record_storage_migrated",
    });
    await assert.rejects(host.ctx.storage.put("probe", 1), {
      code: "record_storage_migrated",
    });
    assert.equal(await f.storage.get("probe"), undefined);
    // The next object boots plain, with everything carried over.
    const plain = await f.open(f.migrating);
    await plain.documentReady();
    assert.ok(plain.plain, "booted plain");
    assert.equal(plain.migration, undefined);
    assert.ok(A.hasHeads(plain.handle.doc(), heads), "same change hashes");
    assert.equal(plain.handle.doc().edited, "before migration");
    assert.ok(plain.commentsHandle.doc().threads.t1);
    assert.equal(plain.plain.host.actor("ab".repeat(16)).principal, "account:alice");
    assert.equal(plain.plain.host.actor("ef".repeat(16)).conflict, true);
    assert.ok(plain.plain.blocked.has("account:bob"));
    // Edits after the conversion are plain and survive a restart.
    await plain.handle.change((d) => (d.after = "plain"));
    await plain.flush();
    await f.close(plain);
    const again = await f.open(f.migrating);
    await again.documentReady();
    assert.equal(again.handle.doc().after, "plain");
    assert.equal(again.metadata.recordStorageMigratedAt, stored.recordStorageMigratedAt);
  });
}

test("a Page outside the canary stays native after its browser leaves", async (t) => {
  const f = await fixture(t);
  await f.nativePage();
  const host = await f.open({
    ...f.migrating,
    PAGES_MIGRATE_PAGE_IDS: JSON.stringify([crypto.randomUUID()]),
  });
  await host.documentReady();
  await f.session(host);
  assert.equal(host.migration.name, "off");
  assert.equal(host.migrationTimer, undefined);
  assert.notEqual((await f.storage.get("host/document")).recordStorage, "automerge");
  assert.deepEqual(f.storage.keys("plain/"), []);
});

test("nothing converts while a socket is open, and a new socket cancels the wait", async (t) => {
  const f = await fixture(t);
  await f.nativePage();
  const host = await f.open({ ...f.migrating, PAGES_MIGRATE_QUIET_MS: "60" });
  await host.documentReady();
  const wire = {};
  host.wires.add(wire);
  host.reportActivity();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(host.migration.name, "connected");
  host.wires.delete(wire);
  host.reportActivity();
  assert.equal(host.migration.name, "quiet");
  host.wires.add(wire);
  host.reportActivity();
  assert.equal(host.migration.name, "connected");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(host.migration.name, "connected");
  assert.equal(f.storage.keys("plain/").length, 0);
  assert.notEqual((await f.storage.get("host/document")).recordStorage, "automerge");
  host.wires.delete(wire);
});

test("without the switch a Subduction Page never becomes eligible", async (t) => {
  const f = await fixture(t);
  await f.nativePage();
  const host = await f.open({
    ...f.migrating,
    PAGES_MIGRATE_RECORD_STORAGE: undefined,
  });
  await f.session(host);
  assert.equal(host.migration.name, "off");
  assert.equal(f.storage.keys("plain/").length, 0);
});

test("a pending journal entry skips the conversion and backs off", async (t) => {
  const f = await fixture(t);
  await f.nativePage();
  const host = await f.open(f.migrating);
  await host.documentReady();
  await f.storage.put("host/operation/pending-test", {
    pending: true,
    doc: "page",
    changes: [],
  });
  await f.session(host);
  await f.settled(host, ["backoff"]);
  assert.equal(host.migration.attempts, 1);
  assert.equal(f.storage.keys("plain/").length, 0);
  assert.notEqual((await f.storage.get("host/document")).recordStorage, "automerge");
  // Still serving natively.
  assert.equal(host.handle.doc().edited, "before migration");
});

test("a failed put of the record leaves a Subduction Page that converts later", async (t) => {
  const f = await fixture(t);
  await f.nativePage();
  const host = await f.open(f.migrating);
  f.storage.failPut = "host/document";
  await f.session(host);
  await f.settled(host, ["retired"]);
  // The put reported failure: the object resets anyway, and the record says
  // what happened. Here it stayed Subduction, with orphaned plain keys.
  assert.notEqual((await f.storage.get("host/document")).recordStorage, "automerge");
  assert.ok(f.storage.keys("plain/").length > 0);
  const next = await f.open(f.migrating);
  await next.documentReady();
  assert.ok(next.signer, "boots native");
  await next.handle.change((d) => (d.native = "after the failed attempt"));
  await next.flush();
  await f.session(next);
  await f.settled(next, ["retired"]);
  const plain = await f.open(f.migrating);
  await plain.documentReady();
  assert.equal(plain.handle.doc().native, "after the failed attempt");
});

test("a failed barrier after the put retires the object on the first attempt; the next boot is plain", async (t) => {
  const f = await fixture(t);
  await f.nativePage();
  const host = await f.open(f.migrating);
  await host.documentReady();
  f.storage.failSyncAfterFlip = true;
  await f.session(host);
  await f.settled(host, ["retired"]);
  assert.equal(f.storage.failSyncAfterFlip, false, "the barrier after the put failed");
  assert.deepEqual(f.migrationLines(), [], "one attempt: no skip, no second try");
  assert.equal((await f.storage.get("host/document")).recordStorage, "automerge");
  const plain = await f.open(f.migrating);
  await plain.documentReady();
  assert.ok(plain.plain);
});

test("a pending access commit skips the conversion, and the stored ACL survives", async (t) => {
  const f = await fixture(t);
  await f.nativePage();
  const host = await f.open(f.migrating);
  await host.documentReady();
  // An access change whose record landed but whose barrier failed.
  const revoked = { ...host.metadata, access: { revision: 99, grants: [] } };
  await f.storage.put("host/document", revoked);
  host.pendingAccess = revoked;
  await f.session(host);
  await f.settled(host, ["backoff"]);
  assert.equal(f.migrationLines().at(-1).reason, "record_pending");
  assert.deepEqual((await f.storage.get("host/document")).access, revoked.access);
  // A stored record that differs from memory, with nothing pending, is caught too.
  host.pendingAccess = undefined;
  host.migration = { ...host.migration, name: "quiet" };
  host.stepMigration({ type: "elapsed" });
  await f.settled(host, ["backoff"]);
  assert.equal(f.migrationLines().at(-1).reason, "record_pending");
  assert.deepEqual((await f.storage.get("host/document")).access, revoked.access);
  assert.equal(f.storage.keys("plain/").length, 0);
});

test("a conversion the runtime gave up on is fenced and writes nothing", async (t) => {
  const f = await fixture(t);
  await f.nativePage();
  const host = await f.open(f.migrating);
  await host.documentReady();
  // The runtime rejects the conversion's blockConcurrencyWhile at its
  // deadline, before the callback starts. A late callback must touch nothing.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  host.ctx.blockConcurrencyWhile = (fn) => {
    void gate.then(fn).catch(() => {});
    return Promise.reject(new Error("blockConcurrencyWhile timed out"));
  };
  await f.session(host);
  await f.settled(host, ["converting"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(host.migrationAbandoned, "fenced at once");
  assert.equal(host.migrationRetiring, true, "an unstarted callback borrows nothing");
  const state = host.migration;
  for (const event of [
    { type: "failed" },
    { type: "elapsed" },
    { type: "activity", sockets: 1, requests: 0 },
  ]) {
    assert.deepEqual(host.stepMigration(event), { state, effects: [] });
    assert.equal(host.migration, state);
  }
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.storage.keys("plain/").length, 0, "no snapshot written");
  assert.notEqual((await f.storage.get("host/document")).recordStorage, "automerge");
  assert.equal(host.migrationRetiring, true);
  assert.equal(host.migrationTimer, undefined, "abandoned callback cannot re-arm");
  await assert.rejects(host.documentReady(), /timed out/);
});

// A recorded hold tracks settlement and the handoff order, not just calls to
// waitUntil. setImmediate drains promise continuations without ticking timers.
const drain = () => new Promise((resolve) => setImmediate(resolve));
function heldHost(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = [];
  const host = Object.assign(Object.create(Page.prototype), {
    migration: { name: "connected", attempts: 0, quietMs: 10 },
    wires: new Set(),
    requestsRunning: 0,
    tail: Promise.resolve(),
    ctx: {
      blockConcurrencyWhile: (fn) => fn(),
      waitUntil(promise) {
        const hold = { settled: false, successors: 0 };
        held.push(hold);
        void promise.then(() => {
          hold.settled = true;
          hold.successors = held.length;
        });
      },
    },
  });
  t.after(() => host.disarmMigration());
  return { host, held };
}

test("quiet hands its hold to the whole conversion; backoff holds nothing", async (t) => {
  const { host, held } = heldHost(t);
  let finish;
  host.convertRecordStorage = () => new Promise((resolve) => (finish = resolve));
  host.reportActivity();
  assert.equal(held.length, 1);
  t.mock.timers.tick(10);
  await drain();
  assert.equal(held.length, 2);
  assert.equal(held[0].settled, true);
  assert.equal(held[0].successors, 2, "conversion hold exists before quiet settles");
  assert.equal(held[1].settled, false);
  finish({ type: "skipped", reason: "test" });
  await drain();
  assert.equal(host.migration.name, "backoff");
  assert.equal(held.length, 2, "no backoff hold");
  assert.ok(held.every((hold) => hold.settled));
  assert.equal(host.migrationRelease, undefined);
  t.mock.timers.tick(10);
  assert.equal(host.migration.name, "quiet");
  assert.equal(held.length, 3);
});

for (const path of ["/api/saved", "/api/sync", "/api/read"]) {
  test(`fetch holds its settle continuation until quiet is armed: ${path}`, async (t) => {
    const { host, held } = heldHost(t);
    let finish;
    host.run = () => new Promise((resolve) => (finish = resolve));
    const request = host.fetch(new Request(`https://pages.invalid${path}`));
    await drain();
    assert.equal(host.requestsRunning, 1);
    assert.equal(held.length, 1);
    finish(new Response("ok"));
    await request;
    await drain();
    assert.equal(host.requestsRunning, 0);
    assert.equal(host.migration.name, "quiet");
    assert.equal(held[0].settled, true);
    assert.equal(held[0].successors, 2, "quiet is held before request hold settles");
    assert.equal(held[1].settled, false);
  });
}

test("slot timeout skips and backs off without abandoning the host", async (t) => {
  const { host, held } = heldHost(t);
  let release;
  const occupant = migrationSlot(() => new Promise((resolve) => (release = resolve)));
  t.after(async () => {
    release();
    await occupant;
  });
  host.convertRecordStorage = () => assert.fail("occupied slot cannot convert");
  host.reportActivity();
  t.mock.timers.tick(10);
  await drain();
  assert.equal(held[1].settled, false, "slot wait is held");
  t.mock.timers.tick(SLOT_WAIT_MS);
  await drain();
  assert.equal(host.migration.name, "backoff");
  assert.equal(host.migration.attempts, 1);
  assert.equal(host.migrationAbandoned, undefined);
  assert.ok(held.every((hold) => hold.settled));
});

test("three skipped attempts stop timers and holds until a new browser session", async (t) => {
  const { host, held } = heldHost(t);
  let attempts = 0;
  host.convertRecordStorage = async () => {
    attempts++;
    return { type: "skipped", reason: "journal_pending" };
  };
  host.reportActivity();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(10);
    await drain();
    if (i < 2) t.mock.timers.tick(10 * 2 ** i);
  }
  assert.equal(attempts, 3);
  assert.equal(host.migration.name, "off");
  assert.equal(host.migrationTimer, undefined);
  assert.ok(held.every((hold) => hold.settled));
  host.requestsRunning = 1;
  host.reportActivity();
  assert.equal(host.migration.name, "off", "API traffic cannot restart migration");
  host.wires.add({});
  host.reportActivity();
  assert.equal(host.migration.name, "connected");
  assert.equal(host.migration.attempts, 0);
});

test("a browser session retries after celld drops an unheld backoff timer", async (t) => {
  const { host, held } = heldHost(t);
  let attempts = 0;
  host.convertRecordStorage = async () => {
    attempts++;
    return { type: "skipped", reason: "journal_pending" };
  };
  host.reportActivity();
  t.mock.timers.tick(10);
  await drain();
  assert.equal(host.migration.name, "backoff");
  assert.ok(held.every((hold) => hold.settled));
  clearTimeout(host.migrationTimer);
  const wire = {};
  host.wires.add(wire);
  host.reportActivity();
  assert.equal(host.migration.name, "connected");
  assert.equal(host.migration.attempts, 1);
  assert.equal(host.migrationTimer, undefined);
  host.wires.delete(wire);
  host.reportActivity();
  assert.equal(host.migration.name, "quiet");
  t.mock.timers.tick(10);
  await drain();
  assert.equal(attempts, 2);
  assert.equal(host.migration.attempts, 2);
});

test("a rejected wrapper that never starts its callback closes and releases its hold", async (t) => {
  const { host, held } = heldHost(t);
  host.ctx.blockConcurrencyWhile = () => Promise.reject(Error("deadline before start"));
  host.convertRecordStorage = () => assert.fail("callback never started");
  let closed = false;
  host.retireMigratedHost = async () => {
    closed = true;
  };
  host.reportActivity();
  t.mock.timers.tick(10);
  await drain();
  assert.ok(host.migrationAbandoned);
  assert.equal(closed, true);
  assert.ok(held.every((hold) => hold.settled));
});

test("deadline abandonment waits for an already running conversion before closing", async (t) => {
  const { host, held } = heldHost(t);
  let finish, expire;
  host.convertRecordStorage = () => new Promise((resolve) => (finish = resolve));
  host.ctx.blockConcurrencyWhile = (fn) => {
    void fn().catch(() => {});
    return new Promise((_resolve, reject) => (expire = reject));
  };
  let closed = false;
  host.retireMigratedHost = async () => {
    closed = true;
  };
  host.reportActivity();
  t.mock.timers.tick(10);
  expire(Error("deadline"));
  await drain();
  assert.ok(host.migrationAbandoned);
  assert.equal(closed, false);
  assert.equal(held[1].settled, false);
  finish({ type: "failed" });
  await drain();
  assert.equal(closed, true);
  assert.equal(held[1].settled, true);
  assert.equal(host.migration.name, "converting", "abandoned completion is a no-op");
  assert.equal(host.migrationTimer, undefined);
});

test("time spent before flushing counts toward the pre-flip deadline margin", async (t) => {
  const f = await fixture(t);
  await f.nativePage();
  const host = await f.open(f.migrating);
  await host.documentReady();
  const get = f.storage.get.bind(f.storage);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(f.storage, "get", async (key) => {
    if (key === "host/document") now += 20_001;
    return get(key);
  });
  host.migration = { name: "converting", attempts: 0, quietMs: 10 };
  await host.runMigration();
  assert.equal(f.migrationLines().at(-1).reason, "deadline_margin");
  assert.equal(host.migration.name, "backoff");
  assert.notEqual((await get("host/document")).recordStorage, "automerge");
  assert.ok(f.storage.keys("plain/").length, "snapshots may be orphaned, but never selected");
});

test("cancelled quiet windows settle their holds", async (t) => {
  const f = await fixture(t);
  await f.nativePage();
  const held = [];
  const host = await f.open({
    ...f.migrating,
    PAGES_MIGRATE_QUIET_MS: "60000",
  });
  host.ctx.waitUntil = (promise) => held.push(promise);
  await host.documentReady();
  const wire = {};
  for (let i = 0; i < 3; i++) {
    host.wires.add(wire);
    host.reportActivity();
    host.wires.delete(wire);
    host.reportActivity();
  }
  host.wires.add(wire);
  host.reportActivity();
  const settled = await Promise.race([
    Promise.all(held).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 200)),
  ]);
  assert.ok(held.length >= 3);
  assert.equal(settled, true, "every armed window released its hold");
  host.wires.delete(wire);
});

test("deleting a Subduction Page clears plain history left by a failed conversion", async (t) => {
  const f = await fixture(t);
  await f.nativePage();
  const host = await f.open(f.migrating);
  f.storage.failPut = "host/document";
  await f.session(host);
  await f.settled(host, ["retired"]);
  assert.ok(f.storage.keys("plain/").length > 0, "orphaned plain keys");
  const next = await f.open(f.native);
  await next.documentReady();
  assert.ok(next.signer);
  await next.lifecycleEffect({ type: "deleteDocument" }, {});
  assert.deepEqual(f.storage.keys("plain/"), []);
});

for (const buffered of [false, true]) {
  test(`deleting a converted ${buffered ? "buffered" : "local"} Page deletes its Subduction history`, async (t) => {
    const f = await fixture(t, { buffered });
    await f.nativePage();
    assert.ok(
      (buffered ? f.records : f.storage).keys("repo/").length > 0,
      "native records exist before",
    );
    const host = await f.open(f.migrating);
    await f.session(host);
    await f.settled(host, ["retired"]);
    const plain = await f.open(f.migrating);
    await plain.documentReady();
    assert.ok(f.storage.keys("host/binding/").length, "migration preserves native bindings");
    // Persist the deletion before its barriers, as a purge does.
    plain.metadata = {
      ...plain.metadata,
      deleted: true,
      deletion: { receipt: { deleted: true, purged: true } },
    };
    await f.storage.put("host/document", plain.metadata);
    await plain.lifecycleEffect({ type: "closePolicy" }, {});
    await plain.lifecycleEffect({ type: "deleteDocument" }, {});
    assert.deepEqual(f.storage.keys("repo/"), []);
    assert.deepEqual(f.storage.keys("host/actor/"), []);
    assert.deepEqual(f.storage.keys("host/binding/"), []);
    assert.deepEqual(f.storage.keys("plain/"), []);
    assert.equal(await f.storage.get("host/signer"), undefined);
    if (buffered) assert.deepEqual(f.records.keys("repo/"), []);
    // A repeat after a crash finishes cleanly.
    await plain.purgeMigratedRecords();
    await f.close(plain);
    const deleted = await f.open(f.migrating);
    await deleted.documentReady();
    const replay = await deleted.fetch(
      requestFor(f.owner, "/internal/purge", {
        page_id: pageId,
        action: "confirm",
        idempotency_key: "purge-replay-after-restart",
      }),
    );
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal(deleted.deletionFinished, true, "cold host replays deletion barriers");
    assert.equal(deleted.handle, undefined);
    assert.deepEqual(f.storage.keys("host/binding/"), []);
  });
}
