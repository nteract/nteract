// Drive the Page host through page-lifecycle events, for the table, crash and
// restart tests. Node tests only.
//
// Counterparts are stateful. D1 is SQLite behind the D1 binding
// (test/sqlite-d1.mjs). The owner's and member's Catalogs are real Catalog
// objects over in-memory storage. A document store stands in for PageRecords:
// it holds each document's bytes, a cold start loads them back, and a
// deletion removes them independently of the Page's own storage.
//
// The clock is frozen per suite, and every host starts from the same document
// bytes and preview secret, so two runs of one row produce byte-identical
// records, receipts and projections.

import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { SqliteD1 } from "../test/sqlite-d1.mjs";
import { loadTable } from "../shared/machine-test.mjs";
import { Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { pageState } from "./access.mjs";
import { PURGE_PREVIEW_TTL_MS } from "./trash.mjs";
import { catalogIndexDatabase } from "./catalog-index.mjs";
import { fixture, memberKey, ownerKey, pageId, readerKey, serverKey } from "./trash-fixture.mjs";

export const TABLE = new URL("../test/fixtures/machines/page-lifecycle.json", import.meta.url);
const CHILD_ID = "66666666-6666-4666-8666-666666666666";
const PREVIEW_SECRET = new Uint8Array(32).fill(7);
/** A writer key whose grant was revoked before its retirement was written. */
export const STALE_KEY = "4".repeat(64);
const STALE_BINDING = {
  principal: "user:anaconda-fixture:former-member",
  displayName: "Former member",
  driver: "Browser",
  senderId: STALE_KEY,
  generation: 1,
  writer: true,
  retired: false,
  revoked: false,
  pending: false,
};
const PHASES = { trash_page: "trashing", restore_page: "restoring", purge_page: "purging" };
const ROUTES = {
  trash: "/internal/trash",
  restore: "/internal/restore",
  purgePreview: "/internal/purge",
  purgeConfirm: "/internal/purge",
};
/** Reasons for refusals whose responses carry no code. */
const REASONS = {
  "Page not found": "page_not_found",
  "Document access denied": "not_owner",
  "This credential is read-only": "read_only",
};

/** An effect-level crash for setting up pending states. */
export class Crash extends Error {}
/** A storage, D1 or document-store mutation that rejected. */
export class Cut extends Error {}

export const rowLabel = (row) =>
  `${row.state.name} × ${row.event.type}${row.case ? ` [${row.case}]` : ""}`;

/** Shared auth, document and frozen clock for every host in one test. */
export async function suite(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const base = await fixture(t, { auth });
  const docBytes = A.save(base.doc());
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  return { t, auth, docBytes, now, table: loadTable(TABLE) };
}

// ---------------------------------------------------------------------------
// Effect trace. Every effect the lifecycle table names is observed at the
// method or storage call that performs it, never inferred from the outcome.

function tracer() {
  const effects = [];
  let crash;
  let enabled = false;
  return {
    effects,
    start(options = {}) {
      effects.length = 0;
      crash = options.crash;
      enabled = true;
    },
    stop() {
      enabled = false;
      crash = undefined;
    },
    record(effect) {
      if (!enabled) return;
      // A flush of the repo and then of the backend is one barrier.
      if (effect.type === "flush" && effects.at(-1)?.type === "flush") return;
      effects.push(effect);
      if (crash?.(effect, effects.length - 1)) throw new Crash(`crash after ${effect.type}`);
    },
  };
}

/** Mutation cuts. Cut points cover every storage mutation within the named
 * I/O effects, including receipt pruning and access-refresh binding writes,
 * plus D1 writes and document-store imports and deletions. While armed, each
 * is logged in order; the one at `at` rejects before or after it applies. */
function cutter() {
  const log = [];
  let armed = false;
  let at = -1;
  let outcome = "before";
  return {
    log,
    arm(cut) {
      log.length = 0;
      armed = true;
      at = cut?.index ?? -1;
      outcome = cut?.outcome ?? "before";
    },
    disarm() {
      armed = false;
    },
    async mutate(kind, detail, apply) {
      if (!armed) return apply();
      const index = log.length;
      log.push({ kind, detail });
      const fail = () => new Cut(`${kind} ${detail} rejected ${outcome} it applied`);
      if (index === at && outcome === "before") throw fail();
      const result = await apply();
      if (index === at && outcome === "after") throw fail();
      return result;
    },
  };
}

function metadataEffect(previous, next) {
  if (previous === next) return undefined;
  const before = pageState(previous);
  const after = pageState(next);
  if (after !== before && (after === "trashed" || after === "deleted"))
    return { type: "withdrawAccess", record: after };
  return { type: "install" };
}

/** Accessors that report memory transitions: the installed record, the commit
 * phase, the deletion barrier flag and the document handle. `boot` skips the
 * constructor's first read of the durable record. */
function memoryAccessors(trace, read, write, { boot = false } = {}) {
  const loading = new WeakSet();
  const accessor = (name, effectOf) => ({
    configurable: true,
    enumerable: true,
    get() {
      return read(this)[name];
    },
    set(next) {
      const values = read(this);
      const previous = values[name];
      write(this, name, next);
      if (name === "metadata" && boot && !loading.has(this)) {
        loading.add(this);
        return;
      }
      const effect = effectOf(previous, next);
      if (effect) trace.record(effect);
    },
  });
  return {
    metadata: accessor("metadata", metadataEffect),
    pendingLifecycle: accessor("pendingLifecycle", (previous, next) => {
      if (next && next !== previous)
        return { type: "begin", phase: PHASES[next.operation], revision: next.record.revision };
      if (!next && previous) return { type: "end" };
      return undefined;
    }),
    deletionFinished: accessor("deletionFinished", (previous, next) =>
      next && !previous ? { type: "finishDeletion" } : undefined,
    ),
    handle: accessor("handle", (previous, next) =>
      !next && previous ? { type: "dropDocument" } : undefined,
    ),
  };
}

function watchMemory(page, trace) {
  const values = {
    metadata: page.metadata,
    pendingLifecycle: page.pendingLifecycle,
    deletionFinished: page.deletionFinished,
    handle: page.handle,
  };
  Object.defineProperties(
    page,
    memoryAccessors(
      trace,
      () => values,
      (_, name, value) => {
        values[name] = value;
      },
    ),
  );
}

/** Every put, delete and sync is a cut point. The effect trace names only the
 * lifecycle writes: records and receipts, the creation intent, and syncs. */
function watchStorage(storage, trace, cuts) {
  storage.put = (key, value) => {
    const entries = typeof key === "object" ? Object.entries(key) : [[key, value]];
    return cuts.mutate("put", entries.map(([name]) => name).join(","), async () => {
      for (const [name, entry] of entries) storage.values.set(name, structuredClone(entry));
      const receipt = entries.some(([name]) => name.startsWith("host/lifecycle/"));
      const record = entries.some(([name]) => name === "host/document");
      if (receipt || record) trace.record({ type: "putRecord", receipt, record });
    });
  };
  storage.delete = (key) =>
    cuts.mutate("delete", key, async () => {
      const existed = storage.values.delete(key);
      if (key === "host/creation") trace.record({ type: "deleteCreation" });
      return existed;
    });
  // Rejected before it applies, a sync makes nothing new durable.
  storage.sync = () =>
    cuts.mutate("sync", "", async () => {
      trace.record({ type: "sync" });
      storage.synced = structuredClone(storage.values);
    });
}

/** D1 writes are cut points too; reads are not. */
function watchDatabase(db, cuts) {
  const batch = db.batch.bind(db);
  db.batch = (statements) =>
    cuts.mutate("d1", `batch(${statements.length})`, () => batch(statements));
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const wrap = (statement) => ({
      ...statement,
      bind: (...values) => wrap(statement.bind(...values)),
      run: () => cuts.mutate("d1", "run", () => statement.run()),
    });
    return wrap(prepare(sql));
  };
}

const handleOf = (doc) => ({ doc: () => doc, broadcast() {}, on() {}, off() {} });

/** The document store's side of a repo: load, import and delete by id.
 * The Page's comments document rides along with each Page document effect,
 * so only the Page document's calls are traced; both are cut points. */
function documentRepo(h) {
  const { documents, trace, cuts } = h;
  const traced = (id) => id === h.f.initial.documentId;
  return {
    async find(documentId) {
      if (!documents.has(documentId)) throw Error(`Document ${documentId} is unavailable`);
      trace.record({ type: "loadDocument" });
      return handleOf(A.load(documents.get(documentId)));
    },
    async import(bytes, { docId }) {
      await cuts.mutate("documents", `import ${docId}`, async () => {
        const stored = documents.get(docId);
        documents.set(docId, stored ? A.save(A.merge(A.load(stored), A.load(bytes))) : bytes);
      });
      if (traced(docId)) trace.record({ type: "importDocument" });
      return handleOf(A.load(documents.get(docId) ?? bytes));
    },
    async delete(documentId) {
      await cuts.mutate("documents", `delete ${documentId}`, async () => {
        documents.delete(documentId);
      });
      if (traced(documentId)) trace.record({ type: "deleteDocument" });
    },
    async flush() {
      trace.record({ type: "flush" });
    },
  };
}

/** Observe a Page's effects at their call sites. Index calls run against D1. */
function watchHost(page, h) {
  const { trace } = h;
  if (!page.policy) return;
  const restrict = page.restrictIndex.bind(page);
  page.restrictIndex = async (...args) => {
    await restrict(...args);
    trace.record({ type: "restrictIndex" });
  };
  const retire = page.retireIndex.bind(page);
  page.retireIndex = async () => {
    await retire();
    trace.record({ type: "retireIndex" });
  };
  const cacheTitle = Page.prototype.cacheTitle;
  page.cacheTitle = function (identity) {
    cacheTitle.call(this, identity);
    trace.record({ type: "projectTitle" });
  };
  const convert = page.convertPreservedMarkdown.bind(page);
  page.convertPreservedMarkdown = async () => {
    await convert();
    trace.record({ type: "convertPreserved" });
  };
  const policy = page.policy;
  const refresh = policy.refreshAccess.bind(policy);
  policy.refreshAccess = async (options) => {
    await refresh(options);
    if (options?.persist !== false) trace.record({ type: "refreshAccess" });
  };
  const close = policy.close.bind(policy);
  policy.close = async () => {
    await close();
    trace.record({ type: "closePolicy" });
  };
  page.repo = documentRepo(h);
  page.backend = {
    async flush() {
      trace.record({ type: "flush" });
    },
  };
}

// ---------------------------------------------------------------------------
// Hosts in a named state.

/** A Page over fresh storage, D1 and Catalogs. `prune` fills the receipt
 * store to its limit so each new receipt prunes one; `staleBinding` leaves a
 * revoked writer key for the next access refresh to retire. */
export async function host(s, { prune = false, staleBinding = false } = {}) {
  const db = new SqliteD1(":memory:");
  s.t.after(() => db.sqlite.close());
  s.t.mock.timers.setTime(s.now);
  const f = await fixture(s.t, {
    auth: s.auth,
    docBytes: s.docBytes,
    env: { PAGES_CATALOG_INDEX: "lifecycle-drive", DB: db },
  });
  const h = {
    s,
    t: s.t,
    f,
    db,
    table: s.table,
    trace: tracer(),
    cuts: cutter(),
    documents: new Map([[f.initial.documentId, s.docBytes]]),
    staleBinding,
    token: undefined,
  };
  watchStorage(f.storage, h.trace, h.cuts);
  watchDatabase(db, h.cuts);
  // Migrate now, so no migration write lands inside a row's cuts. The harness
  // awaits it outright, so no request needs to hold it.
  await catalogIndexDatabase(f.env, {});
  // Previews sign with a per-Page secret created on first use.
  f.storage.values.set("host/purge-preview-secret", PREVIEW_SECRET);
  if (prune)
    for (let n = 0; n < 256; n++)
      f.storage.values.set(`host/lifecycle/seed-${String(n).padStart(3, "0")}`, {
        operation: "trash_page",
        fingerprint: "seed",
        revision: 0,
        receipt: { page_id: pageId, state: "trashed", trashed: true },
        at: 0,
      });
  h.install = (metadata) => {
    const page = f.build(metadata);
    if (metadata && pageState(metadata) === "deleted") page.handle = undefined;
    watchHost(page, h);
    watchMemory(page, h.trace);
    f.setPage(page);
    return page;
  };
  return h;
}

/** Wait for every waitUntil task, including the ones they start. */
export async function settle(h) {
  while (h.f.tasks.length) await Promise.allSettled(h.f.tasks.splice(0));
}

export const call = async (h, who, path, body, method) => {
  const response = await h.f.page.fetch(h.f.request(h.f.tokens[who], path, body, method));
  return { status: response.status, headers: response.headers, body: await response.json() };
};

/** Run one setup step, crashing where `crash` says. */
async function step(h, crash, run) {
  h.trace.start({ crash });
  try {
    return await run();
  } finally {
    h.trace.stop();
  }
}

const after = (type) => (effect) => effect.type === type;

/** A creation intent as `/internal/create` records it before importing. */
export function creationIntent(h) {
  const metadata = structuredClone(h.f.initial);
  delete metadata.acl;
  metadata.createdReceipt = { page_id: pageId, title: "Launch plan", heads: h.f.heads() };
  return { metadata, bytes: A.save(h.f.doc()) };
}

const trashBody = (h, revision, k) => ({
  page_id: pageId,
  base_heads: h.f.heads(),
  idempotency_key: `setup-trash-${k}`,
  expected_revision: revision,
});
const restoreBody = (revision, k) => ({
  page_id: pageId,
  idempotency_key: `setup-restore-${k}`,
  expected_revision: revision,
});
async function previewRequest(h) {
  const preview = await call(h, "owner", "/internal/purge", { page_id: pageId, action: "preview" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  h.token = preview.body.preview_token;
  return h.token;
}
const purgeBody = async (h, revision) => ({
  page_id: pageId,
  action: "confirm",
  preview_token: await previewRequest(h),
  idempotency_key: "setup-purge-1",
  expected_revision: revision,
});

/** Send a setup request and remember it: a pending state's client retries it. */
async function setupRequest(h, route, body) {
  h.crashed = { route, body };
  return call(h, "owner", route, body);
}

/** Walk a fresh Page through trash and restore requests to `revision`. Even
 * revisions are active, odd ones trashed. */
export async function walk(h, revision) {
  const metadata = structuredClone(h.f.initial);
  await h.f.storage.put("host/document", metadata);
  await h.f.storage.sync();
  const page = h.install(metadata);
  await page.policy.load();
  await page.reportIndex({ title: "Launch plan", observedAt: new Date().toISOString() });
  for (let current = 0; current < revision; current++) {
    const k = Math.floor(current / 2) + 1;
    const response =
      current % 2 === 0
        ? await call(h, "owner", "/internal/trash", trashBody(h, current, k))
        : await call(h, "owner", "/internal/restore", restoreBody(current, k));
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  await settle(h);
}

/** The boot event's record says whether the interrupted write landed. */
const written = (state, event) =>
  event.type === "boot" && event.record?.revision === state.revision;

/** Put a host in `state` by running real requests, crashing where a pending
 * state needs it. */
export async function reach(h, state, event) {
  const { f } = h;
  switch (state.name) {
    case "missing":
      h.install(undefined);
      break;
    case "creating":
      await f.storage.put("host/creation", creationIntent(h));
      await f.storage.sync();
      h.install(undefined);
      break;
    case "active":
    case "trashed":
      await walk(h, state.revision);
      break;
    case "trashing":
      await walk(h, state.revision - 1);
      await step(h, after(written(state, event) ? "putRecord" : "restrictIndex"), () =>
        setupRequest(
          h,
          "/internal/trash",
          trashBody(h, state.revision - 1, Math.floor(state.revision / 2) + 1),
        ),
      );
      break;
    case "restoring":
      await walk(h, state.revision - 1);
      await step(h, after(written(state, event) ? "putRecord" : "begin"), () =>
        setupRequest(h, "/internal/restore", restoreBody(state.revision - 1, state.revision / 2)),
      );
      break;
    case "purging":
      await walk(h, state.revision - 1);
      await step(h, after(written(state, event) ? "putRecord" : "restrictIndex"), async () =>
        setupRequest(h, "/internal/purge", await purgeBody(h, state.revision - 1)),
      );
      break;
    case "deleting":
    case "deleted": {
      await walk(h, state.revision - 1);
      const purged = await call(
        h,
        "owner",
        "/internal/purge",
        await purgeBody(h, state.revision - 1),
      );
      assert.equal(purged.status, 200, JSON.stringify(purged.body));
      // A restart forgets that the deletion barriers finished.
      if (state.name === "deleting")
        await h.install(await f.storage.get("host/document")).policy.load();
      break;
    }
  }
  if (state.intent) {
    await f.storage.put("host/creation", creationIntent(h));
    await f.storage.sync();
  }
  await settle(h);
  assert.deepEqual(readState(h), state, "setup reached the row's state");
}

/** The lifecycle state as the host holds it: the installed record, the
 * memory-only commit phase, the deletion barrier flag and any creation intent. */
export function readState(h) {
  const page = h.f.page;
  const metadata = page.metadata;
  const creation = h.f.storage.values.has("host/creation");
  if (!metadata) return { name: creation ? "creating" : "missing" };
  const intent = creation ? { intent: true } : {};
  const pending = page.pendingLifecycle;
  if (pending) {
    const name = PHASES[pending.operation];
    return { name, revision: pending.record.revision, ...intent };
  }
  const state = pageState(metadata);
  const revision = metadata.lifecycleRevision ?? 0;
  if (state === "deleted")
    return {
      name: page.deletionFinished || !metadata.deletion ? "deleted" : "deleting",
      revision,
      ...intent,
    };
  return { name: state, revision, ...intent };
}

function recordSummary(record) {
  if (!record) return null;
  return {
    state: pageState(record),
    revision: record.lifecycleRevision ?? 0,
    ...(pageState(record) === "deleted" && record.deletion && { deletion: true }),
  };
}

// ---------------------------------------------------------------------------
// Delivering events to the current host.

function summarizeReceipt(receipt) {
  if (receipt.superseded) return { superseded: true, state: receipt.state };
  if (receipt.deleted) return { deleted: true, ...(receipt.purged && { purged: true }) };
  if (receipt.state === "trashed") return { state: "trashed" };
  return { state: receipt.state, restored: receipt.restored === true };
}
const summarizeCurrent = (current) => ({ state: current.state, revision: current.revision });

function keyFor(event, operation) {
  if (event.key === "fresh") return `event-${operation}-request`;
  return `setup-${operation}-1`;
}

async function requestBody(h, state, event) {
  const { f } = h;
  const expected = "expected" in event ? { expected_revision: event.expected } : {};
  const replay = event.replayOnly ? { replay_only: true } : {};
  const conflict = event.key === "conflict" ? { extra: true } : {};
  switch (event.type) {
    case "trash": {
      let heads = f.heads();
      if (event.heads === "mismatch") f.edit("A newer title");
      if (event.heads === "invalid") heads = ["not-a-head"];
      return {
        page_id: pageId,
        base_heads: heads,
        idempotency_key: keyFor(event, "trash"),
        ...expected,
        ...replay,
        ...conflict,
      };
    }
    case "restore":
      return {
        page_id: pageId,
        idempotency_key: keyFor(event, "restore"),
        ...expected,
        ...replay,
        ...conflict,
      };
    case "purgePreview":
      return { page_id: pageId, action: "preview" };
    case "purgeConfirm": {
      let token = state.name === "trashed" ? await previewRequest(h) : (h.token ?? "pp1.a.b");
      if (event.preview === "changed") f.edit("Changed after the preview");
      if (event.preview === "invalid") token = `${token}x`;
      return {
        page_id: pageId,
        action: "confirm",
        preview_token: token,
        idempotency_key: keyFor(event, "purge"),
        ...expected,
        ...replay,
        ...conflict,
      };
    }
  }
  throw Error(`no request for ${event.type}`);
}

function describeResponse(response, body, recorded, deletion) {
  if (response.status !== 200)
    return {
      status: response.status,
      error: body.error,
      ...(body.code && { code: body.code }),
      ...(response.headers.get("x-pages-lifecycle-rejected") === "before-change" && {
        beforeChange: true,
      }),
    };
  if (typeof body.preview_token === "string") return { status: 200, reply: "preview" };
  if (body.receipt && body.current) {
    const reply = body.receipt.superseded
      ? "superseded"
      : recorded && isDeepStrictEqual(body.receipt, recorded.receipt)
        ? "recorded"
        : deletion && isDeepStrictEqual(body.receipt, deletion.receipt)
          ? "deletion"
          : "receipt";
    return {
      status: 200,
      reply,
      receipt: summarizeReceipt(body.receipt),
      current: summarizeCurrent(body.current),
    };
  }
  if (Object.keys(body).length === 1 && typeof body.state === "string")
    return { status: 200, reply: "state", state: body.state };
  return { status: 200, reply: "current", current: summarizeCurrent(body) };
}

function rejection(event, response, effects, changed) {
  if (effects.length > 0 || changed) return undefined;
  if (["boot", "commitOk", "commitFailed"].includes(event.type)) return undefined;
  if (response.status >= 400 && response.status < 500)
    return response.code ?? REASONS[response.error] ?? `http_${response.status}`;
  if (response.reply === "superseded") return "superseded";
  if (response.reply === "recorded" || response.reply === "deletion") return "replayed";
  if (response.reply === "state") return "not_trashed";
  return undefined;
}

/** Sessions that show admission effects: the owner's writer key and the
 * member's key on an active Page, the owner's reader key on a trashed one.
 * A host with `staleBinding` also holds a revoked writer key. */
async function bindSessions(h, state) {
  const { f } = h;
  if (state.name === "active") {
    await f.bind(ownerKey, f.owner);
    await f.bind(memberKey, f.member);
  } else if (state.name === "trashed") {
    await f.bind(readerKey, f.owner);
  }
  // Admission writes run behind the bind; let them land before the event.
  await new Promise((resolve) => setImmediate(resolve));
}

/** Leave a revoked writer key whose retirement was never written. */
async function seedStaleBinding(h) {
  const policy = h.f.page.policy;
  if (!h.staleBinding || !policy || policy.bindings.has(STALE_KEY)) return;
  await h.f.storage.put(`host/binding/${STALE_KEY}`, STALE_BINDING);
  policy.bindings.set(STALE_KEY, { ...STALE_BINDING });
}

const READABLE = new Set(["active"]);
function assertAdmission(h, before, result) {
  const { f } = h;
  const types = new Set(result.effects.map((effect) => effect.type));
  if (!types.has("refreshAccess") && !types.has("closePolicy")) return;
  const page = f.page;
  const name = result.state.name;
  const owner = f.identity(f.owner);
  const member = f.identity(f.member);
  if (READABLE.has(name)) {
    page.policy.account(member);
    page.policy.account(owner, true);
    return;
  }
  // Members lose access; the owner keeps at most a read-only view.
  assert.throws(() => page.policy.account(member), "member keeps access");
  assert.throws(() => page.policy.account(owner, true), "owner keeps write access");
  if (before.name === "active") {
    assert.ok(f.disconnected.includes(memberKey), "member session stays connected");
    assert.ok(f.disconnected.includes(ownerKey), "owner writer session stays connected");
  }
  if (types.has("closePolicy") && before.name === "trashed")
    assert.ok(f.disconnected.includes(readerKey), "owner reader session stays connected");
}

const OPERATIONS = { trash: "trash_page", restore: "restore_page", purgeConfirm: "purge_page" };

/** Storage after the event: the durable record agrees with the state, and a
 * new receipt is stored whole under this request's key. */
async function assertStorage(h, event, result, keys, reply) {
  const { storage } = h.f;
  if (result.effects.some((effect) => effect.type === "putRecord" && effect.receipt)) {
    // A settle writes the pending request's receipt; a request writes its own.
    const stored = keys.filter((key) => storage.values.has(`host/lifecycle/${key}`));
    assert.ok(stored.length === keys.length && stored.length > 0, "receipt stored");
  }
  if (reply?.request && result.response.reply === "receipt") {
    const record = await storage.get(`host/lifecycle/${reply.request}`);
    assert.deepEqual(
      record,
      {
        operation: OPERATIONS[event.type],
        fingerprint: record.fingerprint,
        revision: result.state.revision,
        receipt: reply.body.receipt,
        at: Date.now(),
      },
      "stored receipt",
    );
    assert.match(record.fingerprint, /^[0-9a-f]{64}$/);
  }
  if (["active", "trashed", "deleted", "deleting"].includes(result.state.name)) {
    const record = await storage.get("host/document");
    const durable = pageState(record);
    const expected = result.state.name === "deleting" ? "deleted" : result.state.name;
    assert.equal(durable, expected, "durable record state");
    assert.equal(record.lifecycleRevision ?? 0, result.state.revision, "durable revision");
  }
  if (event.type === "boot" && result.effects.some((effect) => effect.type === "deleteCreation"))
    assert.equal(storage.values.has("host/creation"), false, "creation intent removed");
}

/** A cold start over the host's storage, observed from the constructor on. */
export async function boot(h, event, options = {}) {
  const { f, trace, t } = h;
  if (options.values) f.storage.values = structuredClone(options.values);
  if (options.check !== false) {
    assert.deepEqual(recordSummary(await f.storage.get("host/document")), event.record);
    const creation = await f.storage.get("host/creation");
    assert.deepEqual(
      creation ? recordSummary(creation.metadata) : null,
      event.creation,
      "creation intent",
    );
  }
  const store = new WeakMap();
  const read = (instance) => {
    if (!store.has(instance)) store.set(instance, {});
    return store.get(instance);
  };
  const descriptors = memoryAccessors(
    trace,
    read,
    (instance, name, value) => {
      read(instance)[name] = value;
    },
    { boot: true },
  );
  const repo = documentRepo(h);
  const mocked = t.mock.method(Page.prototype, "initializeRepo", async function () {
    this.policy = new DocumentPolicy({
      storage: this.ctx.storage,
      metadata: () => this.metadata,
      serverKey,
    });
    await this.policy.load();
    this.serverKey = serverKey;
    this.serverSenderId = "server-sender";
    this.backend = {
      async flush() {
        trace.record({ type: "flush" });
      },
    };
    this.repo = repo;
  });
  Object.defineProperties(Page.prototype, descriptors);
  trace.start({ crash: options.crash });
  let page;
  let failure;
  try {
    page = new Page(
      {
        id: { name: pageId },
        storage: f.storage,
        blockConcurrencyWhile: (fn) => fn(),
        waitUntil: (promise) => f.tasks.push(promise),
      },
      f.env,
    );
    await page.ready;
  } catch (error) {
    failure = error;
  } finally {
    trace.stop();
    for (const name of Object.keys(descriptors)) delete Page.prototype[name];
    mocked.mock.restore();
  }
  if (page) {
    const values = read(page);
    for (const name of Object.keys(descriptors))
      Object.defineProperty(page, name, {
        value: values[name],
        writable: true,
        configurable: true,
        enumerable: true,
      });
    watchHost(page, h);
    watchMemory(page, trace);
    f.setPage(page);
  }
  if (failure) throw failure;
  return page;
}

/** The request a row sends, built once so a retry repeats it exactly. */
async function prepare(h, state, event, options = {}) {
  const { f } = h;
  await seedStaleBinding(h);
  if (event.type === "tombstone")
    return {
      request: () => new Request("https://pages.internal/internal/tombstone", { method: "POST" }),
    };
  if (event.type === "commitOk" || event.type === "commitFailed")
    return { request: () => new Request("https://pages.internal/internal/lifecycle-state") };
  if (options.sessions !== false) await bindSessions(h, state);
  const body = await requestBody(h, state, event);
  return {
    body,
    request: () => f.request(f.tokens[event.actor], ROUTES[event.type], body),
  };
}

/** The owner's Catalog runs its leaf check before it forwards a trash. */
async function leafCheck(h) {
  const { f } = h;
  await f.catalogOf(f.owner).storage.put(`page/${CHILD_ID}`, {
    page_id: CHILD_ID,
    title: "Child",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    parent_id: pageId,
    position: "a0",
  });
  try {
    await f.catalogOf(f.owner).catalog.requireLeafPage(pageId);
  } catch (error) {
    if (!error.status) throw error;
    return { status: error.status, error: error.message, code: error.code };
  }
  throw Error("the leaf check passed");
}

/** Send a prepared request at the row's moment: an expired preview is
 * confirmed after its lifetime. */
async function send(h, event, request) {
  if (event.preview === "expired") h.t.mock.timers.tick(PURGE_PREVIEW_TTL_MS + 1);
  try {
    return await h.f.page.fetch(request);
  } finally {
    h.t.mock.timers.setTime(h.s.now);
  }
}

/** Deliver one event to the host as the Page receives it today. */
export async function deliver(h, state, event, options = {}) {
  const { f, trace } = h;
  if (event.type === "boot") {
    await boot(h, event, options);
    return { state: readState(h), effects: [...trace.effects] };
  }
  if (event.children) {
    const response = await leafCheck(h);
    return { state, effects: [], response, rejected: response.code };
  }
  // A settle writes the pending request's receipt.
  const settling = f.page.pendingLifecycle?.key.slice("host/operation/".length);
  const deletion = f.page.metadata?.deletion;
  const prepared = await prepare(h, state, event, options);
  const key = prepared.body?.idempotency_key;
  const recorded = key ? await f.storage.get(`host/lifecycle/${key}`) : undefined;
  // The event's observations match what the host holds.
  if (event.key === "recorded")
    assert.deepEqual(summarizeReceipt(recorded.receipt), event.recorded);
  if (event.deletion) assert.deepEqual(summarizeReceipt(deletion.receipt), event.deletion);
  const crash = event.type === "commitFailed" ? (effect) => effect.type === "sync" : options.crash;
  trace.start({ crash });
  let response;
  try {
    response = await send(h, event, prepared.request());
  } finally {
    trace.stop();
  }
  let effects = [...trace.effects];
  const body = await response.json();
  const described = describeResponse(response, body, recorded, deletion);
  if (event.type === "commitFailed") {
    // The settle ran commitOk's sequence up to its failed barrier. The
    // failure step itself emits nothing.
    const ok = h.table.rows.find(
      (row) => row.event.type === "commitOk" && isDeepStrictEqual(row.state, state),
    );
    assert.ok(ok, "a commitOk row for this state");
    const barrier = ok.expect.effects.findIndex((effect) => effect.type === "sync");
    assert.deepEqual(effects, ok.expect.effects.slice(0, barrier + 1), "attempted settle");
    effects = [];
  }
  await settle(h);
  const next = readState(h);
  const result = { state: next, effects, response: described };
  const rejected = rejection(event, described, effects, !isDeepStrictEqual(next, state));
  if (rejected) result.rejected = rejected;
  assertAdmission(h, state, result);
  const writes = result.effects.filter((effect) => effect.type === "putRecord" && effect.receipt);
  const keys = [settling, writes.length > (settling ? 1 : 0) ? key : undefined].filter(Boolean);
  await assertStorage(h, event, result, keys, { request: key, body });
  return result;
}

export async function drive(s, state, event, options) {
  const h = await host(s);
  await reach(h, state, event);
  return { h, result: await deliver(h, state, event, options) };
}

// ---------------------------------------------------------------------------
// Crash, restart and exact replay.

const dirtyToken = (key) => key === "host/index/dirty" || key === "host/index/spaces-dirty";
const entries = (storage, skip = () => false) =>
  [...storage.values]
    .filter(([key]) => !skip(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => [key, dirtyToken(key) ? "<token>" : value]);

/** Everything durable the row can touch: the Page's storage, the document
 * store, both Catalogs, and this Page's D1 rows. */
export function snapshot(h) {
  const { f, db } = h;
  return {
    page: entries(f.storage, (key) => key === "host/purge-preview-secret"),
    documents: [...h.documents].map(([id, bytes]) => {
      const doc = A.load(bytes);
      const heads = A.getHeads(doc);
      A.free(doc);
      return [id, heads];
    }),
    owner: entries(f.catalogOf(f.owner).storage),
    member: entries(f.catalogOf(f.member).storage),
    index: {
      page: db.rows("SELECT * FROM pages_catalog_pages WHERE page_id = ?", pageId),
      access: db.rows(
        "SELECT * FROM pages_catalog_access WHERE page_id = ? ORDER BY principal",
        pageId,
      ),
    },
  };
}

const PUBLIC = {
  deleting: "deleted",
  purging: "deleted",
  trashing: "trashed",
  restoring: "active",
};
/** The state a client was told: a lifecycle receipt's current state, a
 * settled lifecycle-state reply, or a tombstone's answer. */
async function reported(response) {
  if (response.status !== 200) return undefined;
  const body = await response.json();
  const current = body.current ?? body;
  if (typeof current.state !== "string" || current.state === "missing") return undefined;
  return {
    state: current.state,
    ...(current.revision !== undefined && { revision: current.revision }),
  };
}
const publicState = (state) => ({
  state: PUBLIC[state.name] ?? state.name,
  revision: state.revision,
});

/** One row under one cut. The row's event runs with the cut armed. In
 * `retry` mode the client then repeats its outstanding request in the same
 * process, as after any rejected call; in `crash` mode the process dies at
 * the cut. A restart then boots from `view` ("written" keeps every applied
 * write; "synced" keeps only what the last successful sync covered), the
 * client repeats the request once more, and the result is snapshotted. A
 * pending state's outstanding request is the setup request that began its
 * phase; a tombstone's is the tombstone. */
export async function scenario(
  s,
  row,
  { cut, view = "written", mode = "crash", documentAbsent = false } = {},
) {
  const h = await host(s, { prune: true, staleBinding: true });
  await reach(h, row.state, row.event);
  // An earlier build deleted the document; this record still says trashed.
  if (documentAbsent) h.documents.delete(h.f.initial.documentId);
  const outcome = { label: rowLabel(row), cut, view, mode, told: [] };
  let retry;
  const prepared =
    row.event.type === "boot" || row.event.children
      ? undefined
      : await prepare(h, row.state, row.event);
  // Setup is durable; only the event's own writes are at risk.
  await h.f.storage.sync();
  h.cuts.arm(cut);
  if (row.event.type === "boot") {
    try {
      await boot(h, row.event, { check: false });
    } catch (error) {
      if (!(error instanceof Cut)) throw error;
      outcome.failed = error.message;
    }
  } else if (row.event.children) {
    await leafCheck(h);
  } else {
    const crashed = h.crashed && row.event.type === "commitOk" ? h.crashed : undefined;
    retry = crashed
      ? () => h.f.request(h.f.tokens.owner, crashed.route, crashed.body)
      : prepared.request;
    h.trace.start();
    const response = await send(h, row.event, prepared.request());
    outcome.status = response.status;
    outcome.told.push(await reported(response));
    await settle(h);
    h.trace.stop();
  }
  // The effects that completed before the cut, in order.
  outcome.effects = h.trace.effects.map((effect) => effect.type);
  h.cuts.disarm();
  outcome.mutations = h.cuts.log.map(({ kind, detail }) => `${kind} ${detail}`.trim());
  if (mode === "retry" && retry) {
    const response = await send(h, row.event, retry());
    outcome.retried = response.status;
    outcome.told.push(await reported(response));
    await settle(h);
  }
  const values = view === "synced" ? h.f.storage.durable() : structuredClone(h.f.storage.values);
  try {
    await boot(h, row.event, { values, check: false });
  } catch (error) {
    outcome.restart = error.message;
    outcome.final = snapshot(h);
    return outcome;
  }
  outcome.booted = readState(h);
  outcome.document = !!h.f.page.handle;
  if (retry) {
    const response = await send(h, row.event, retry());
    outcome.replay = response.status;
    await settle(h);
  }
  outcome.state = readState(h);
  outcome.final = snapshot(h);
  return outcome;
}

/** What a restart lost that a client was told: the last success reported
 * before it must be the state the restart boots. */
export function lostSuccess(outcome) {
  const told = outcome.told.filter(Boolean).at(-1);
  if (!told || !outcome.booted) return undefined;
  const booted = publicState(outcome.booted);
  if (told.state !== booted.state) return `told ${told.state}, booted ${booted.state}`;
  if (told.revision !== undefined && told.revision !== booted.revision)
    return `told revision ${told.revision}, booted ${booted.revision}`;
  return undefined;
}
