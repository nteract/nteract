// What a reopened Page's status says, through real PageSession close and
// reopen: the IndexedDB checkpoint, the native replica in fake IndexedDB, and
// the receipt path. Only the host is faked: discovery, the native socket and
// /api/saved.
import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { SubductionBackend } from "@automerge/automerge-repo-subduction";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { PageSession } from "./session.mjs";
import { encodeSnapshot, readLocalPage, writeLocalPage } from "./local-pages.mjs";
import { createPageData, initializePage } from "../model/page.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const AGENT = "bb".repeat(16);

/** A browser tab: one sessionStorage, so a reopen uses the same native
 * replica, and Web Locks. The host answers discovery and the native
 * handshake; receipts wait in `receipts` until a test answers them. */
function host(t) {
  const values = new Map();
  const locks = new Set();
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        async request(key, _options, callback) {
          if (locks.has(key)) return callback(null);
          locks.add(key);
          try {
            return await callback({ name: key });
          } finally {
            locks.delete(key);
          }
        },
      },
    },
  });
  globalThis.sessionStorage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://localhost:9894/" },
  });
  t.after(() => {
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator);
    else delete globalThis.navigator;
    if (location) Object.defineProperty(globalThis, "location", location);
    else delete globalThis.location;
    delete globalThis.sessionStorage;
  });
  t.mock.method(globalThis, "WebSocket", function () {
    const events = new EventTarget();
    Object.defineProperty(this, "binaryType", { value: "blob", writable: true });
    this.addEventListener = events.addEventListener.bind(events);
    this.close = () => {};
  });
  t.mock.method(N.SubductionWebSocket, "setup", async () => ({
    free() {},
    toTransport: () => ({ free() {} }),
  }));
  t.mock.method(SubductionBackend.prototype, "addConnection", async () => {});
  const auth = {
    identity: { principal: crypto.randomUUID(), displayName: "Kyle", driver: "Browser" },
    canWrite: true,
  };
  const state = { offline: false, documentId: undefined };
  const receipts = [];
  // Answer receipts still waiting when a test ends, so none outlives it.
  t.after(() => {
    for (const { resolve } of receipts)
      resolve(Response.json({ error: "Closed" }, { status: 503 }));
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.startsWith("/api/connect?")) {
      if (state.offline) throw new TypeError("fetch failed");
      return Response.json({
        identity: auth.identity,
        documentId: state.documentId,
        access: {
          role: "owner",
          generation: 0,
          revision: 0,
          canRead: true,
          canWrite: true,
          canComment: true,
        },
        serverPeerId: "00".repeat(32),
        serverSenderId: "fixture-host",
        peerProfiles: {},
      });
    }
    assert.ok(url.startsWith("/api/saved?"), `unexpected request: ${url}`);
    let resolve;
    const response = new Promise((done) => (resolve = done));
    receipts.push({ heads: JSON.parse(options.body).heads, resolve });
    return response;
  });
  return { auth, state, receipts };
}

/** A registered Page cached in this tab at a clean receipt, as a host write
 * by another actor. */
async function cachedPage(h) {
  const pageId = crypto.randomUUID();
  h.state.documentId = interpretAsDocumentId(generateAutomergeUrl());
  const doc = A.change(
    A.from(createPageData({ pageId, title: "Cached" }), { actor: "ab".repeat(16) }),
    initializePage,
  );
  await writeLocalPage(h.auth.identity, {
    principal: h.auth.identity.principal,
    page_id: pageId,
    document_id: h.state.documentId,
    title: doc.title,
    snapshot: encodeSnapshot(A.save(doc)),
    canWrite: true,
    registered: true,
    pending: false,
  });
  return pageId;
}

async function open(h, pageId, seen = []) {
  const session = await PageSession.open(pageId, {
    authentication: h.auth,
    refreshSession: async () => h.auth,
  });
  session.subscribe(() => seen.push(session.statusId));
  await session.connecting?.catch(() => {});
  await tick();
  clearTimeout(session.retryTimer);
  return session;
}

/** Send the debounced receipt now and return the host's request for it. */
async function receipt(h, session) {
  clearTimeout(session.savedTimer);
  const count = h.receipts.length;
  const sent = session.saveReceipt();
  while (h.receipts.length === count) await tick();
  return { ...h.receipts.at(-1), sent };
}

async function acknowledge(h, session) {
  const request = await receipt(h, session);
  request.resolve(Response.json({ durableHeads: request.heads }));
  await request.sent;
}

/** Another peer's change arriving over native sync. */
const remoteChange = (session, title) =>
  session.handle.update((doc) =>
    A.merge(
      doc,
      A.change(A.clone(doc, { actor: AGENT }), (draft) => A.updateText(draft, ["title"], title)),
    ),
  );

test("a Page closed while syncing remote changes reopens Syncing, not Saving", async (t) => {
  const h = host(t);
  const pageId = await cachedPage(h);
  const first = await open(h, pageId);
  assert.equal(first.status, "Syncing");
  assert.equal(first.statusKey, "syncing");
  await acknowledge(h, first);
  assert.equal(first.status, "Saved");
  assert.equal(first.statusKey, "saved");
  await remoteChange(first, "From an agent");
  assert.equal(first.status, "Syncing");
  assert.equal(first.statusKey, "syncing");
  await receipt(h, first); // Outstanding when the Page closes.
  await first.close();
  const closed = await readLocalPage(h.auth.identity, pageId);
  assert.equal(closed.pending, true, "the checkpoint records the outstanding receipt");

  const seen = [];
  const reopened = await open(h, pageId, seen);
  t.after(() => reopened.close());
  assert.equal(reopened.sync$.snapshot().pending, false);
  assert.equal(reopened.status, "Syncing");
  assert.ok(!seen.includes("saving"), seen.join(", "));
  await acknowledge(h, reopened);
  assert.equal(reopened.status, "Saved");
});

test("a Page closed offline with no local edit reopens without Saving", async (t) => {
  const h = host(t);
  const pageId = await cachedPage(h);
  const first = await open(h, pageId);
  await acknowledge(h, first);
  await remoteChange(first, "From an agent");
  await receipt(h, first);
  h.state.offline = true;
  await first.retryConnection();
  clearTimeout(first.retryTimer);
  assert.equal(first.status, "Offline");
  await first.close();
  assert.equal((await readLocalPage(h.auth.identity, pageId)).pending, true);

  const seen = [];
  const offline = await open(h, pageId, seen);
  assert.equal(offline.sync$.snapshot().pending, false);
  assert.equal(offline.status, "Saved locally");
  assert.equal(offline.snapshot().title, "From an agent");
  h.state.offline = false;
  await offline.retryConnection();
  await tick();
  t.after(() => offline.close());
  assert.equal(offline.status, "Syncing");
  assert.ok(!seen.includes("saving"), seen.join(", "));
});

test("a local edit that reached native storage but not the checkpoint reopens Saving", async (t) => {
  const h = host(t);
  const pageId = await cachedPage(h);
  const first = await open(h, pageId);
  await acknowledge(h, first);
  await first.change((doc) => A.updateText(doc, ["title"], "Typed before the crash"));
  // The tab dies after native persistence, before the debounced receipt
  // writes its checkpoint and before close writes another.
  clearTimeout(first.savedTimer);
  await first.repo.flush();
  first.skipCloseCheckpoint = true;
  await first.close();
  const checkpoint = await readLocalPage(h.auth.identity, pageId);
  assert.equal(checkpoint.pending, false, "the checkpoint never saw the edit");

  const reopened = await open(h, pageId);
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().title, "Typed before the crash");
  assert.equal(reopened.sync$.snapshot().pending, true);
  assert.equal(reopened.recoveryPending, true, "the restored edit is not claimed as saved");
  assert.ok(!A.getHeads(reopened.doc).every((head) => reopened.savedHeads.includes(head)));
  // Saving, drawn quiet until the receipt has been pending SLOW_SAVE_MS.
  assert.equal(reopened.statusId, "saving");
  assert.equal(reopened.statusKey, "quiet");
  // Remote catch-up before the receipt lands keeps it Saving.
  await remoteChange(reopened, "From an agent");
  assert.equal(reopened.statusId, "saving");
  await acknowledge(h, reopened);
  assert.equal(reopened.status, "Saved");
  assert.equal(reopened.slowSaveTimer, undefined, "the acknowledgement disarms the timer");
  const saved = await readLocalPage(h.auth.identity, pageId);
  assert.deepEqual(saved.localEdits.ackedHeads, A.getHeads(reopened.doc));
});

test("an acknowledged local edit followed by remote catch-up never reopens Saving", async (t) => {
  const h = host(t);
  const pageId = await cachedPage(h);
  const first = await open(h, pageId);
  await acknowledge(h, first);
  await first.change((doc) => A.updateText(doc, ["title"], "Typed and saved"));
  assert.equal(first.statusId, "saving");
  await acknowledge(h, first);
  assert.equal(first.status, "Saved");
  await remoteChange(first, "From an agent");
  assert.equal(first.status, "Syncing");
  await receipt(h, first);
  const actor = first.actor();
  await first.close();
  const closed = await readLocalPage(h.auth.identity, pageId);
  assert.equal(closed.pending, true);
  assert.ok(
    !closed.localEdits.actors.some((entry) => entry.actor === actor),
    "a close with nothing unconfirmed retires its actor",
  );

  const seen = [];
  const reopened = await open(h, pageId, seen);
  t.after(() => reopened.close());
  assert.equal(reopened.sync$.snapshot().pending, false);
  assert.equal(reopened.status, "Syncing");
  await acknowledge(h, reopened);
  assert.equal(reopened.status, "Saved");
  assert.ok(!seen.includes("saving"), seen.join(", "));
});

test("a checkpoint from before local-edit tracking keeps its receipt flag until acknowledged", async (t) => {
  const h = host(t);
  const pageId = await cachedPage(h);
  const legacy = await readLocalPage(h.auth.identity, pageId);
  await writeLocalPage(h.auth.identity, { ...legacy, pending: true });
  h.state.offline = true;
  const first = await open(h, pageId);
  assert.equal(first.sync$.snapshot().pending, true);
  assert.equal(first.localPage.localEdits.unattributed, true);
  await first.close();

  h.state.offline = false;
  const reopened = await open(h, pageId);
  t.after(() => reopened.close());
  assert.equal(reopened.statusId, "saving", "unattributed edits stay unconfirmed across reopens");
  await acknowledge(h, reopened);
  assert.equal(reopened.status, "Saved");
  assert.equal((await readLocalPage(h.auth.identity, pageId)).localEdits.unattributed, false);
});

/** A local edit that reaches native storage, then the tab dies before the
 * debounced receipt and before close writes a checkpoint. */
async function crashAfterEdit(session, title) {
  await session.change((doc) => A.updateText(doc, ["title"], title));
  clearTimeout(session.savedTimer);
  await session.repo.flush();
  session.skipCloseCheckpoint = true;
  await session.close();
}
const ownEntries = (page, replica) =>
  page.localEdits.actors.filter((entry) => entry.replica === replica);

test("an unacknowledged edit stays attributed behind any number of other actors", async (t) => {
  const h = host(t);
  const pageId = await cachedPage(h);
  const cached = await readLocalPage(h.auth.identity, pageId);
  const others = Array.from({ length: 600 }, (_, i) => ({
    actor: i.toString(16).padStart(32, "0"),
    replica: (i + 1).toString(16).padStart(32, "f"),
  }));
  await writeLocalPage(h.auth.identity, {
    ...cached,
    localEdits: { actors: others, ackedHeads: [], unattributed: false },
  });
  const first = await open(h, pageId);
  await acknowledge(h, first);
  const actor = first.actor();
  await crashAfterEdit(first, "Behind 600 actors");
  // More opens elsewhere add more actors; none of them can push this one out.
  const later = await readLocalPage(h.auth.identity, pageId);
  await writeLocalPage(h.auth.identity, {
    ...later,
    localEdits: {
      ...later.localEdits,
      actors: [
        ...later.localEdits.actors,
        ...others.map(({ replica }, i) => ({
          actor: `ee${i.toString(16).padStart(30, "0")}`,
          replica,
        })),
      ],
    },
  });

  const reopened = await open(h, pageId);
  t.after(() => reopened.close());
  assert.ok(reopened.localPage.localEdits.actors.some((entry) => entry.actor === actor));
  assert.equal(reopened.snapshot().title, "Behind 600 actors");
  assert.equal(reopened.statusId, "saving");
  assert.equal(reopened.recoveryPending, true);
});

test("another tab's live actor survives this tab's covering receipt and clean close", async (t) => {
  const h = host(t);
  const pageId = await cachedPage(h);
  const left = await open(h, pageId);
  const right = await open(h, pageId);
  assert.notEqual(left.replicaId, right.replicaId, "each tab owns its native replica");
  await acknowledge(h, left);
  await acknowledge(h, right);
  const actor = right.actor();
  await right.change((doc) => A.updateText(doc, ["title"], "Typed in the right tab"));
  clearTimeout(right.savedTimer);
  await right.repo.flush();
  // The left tab's receipt covers everything it holds, then it closes clean.
  await remoteChange(left, "From an agent");
  await acknowledge(h, left);
  await left.close();
  const afterLeft = await readLocalPage(h.auth.identity, pageId);
  assert.deepEqual(ownEntries(afterLeft, left.replicaId), [], "the left tab retired its own");
  assert.ok(afterLeft.localEdits.actors.some((entry) => entry.actor === actor));
  // The right tab dies with its edit only in native storage.
  right.skipCloseCheckpoint = true;
  await right.close();

  const reopened = await open(h, pageId);
  t.after(() => reopened.close());
  assert.equal(reopened.replicaId, right.replicaId, "the right tab's replica reopens");
  assert.ok(
    A.getChangesMetaSince(reopened.doc, []).some((change) => change.actor === actor),
    "the right tab's edit is restored from its native replica",
  );
  assert.equal(reopened.statusId, "saving");
});

test("a covering receipt frees its replica's earlier actors and a clean close frees its own", async (t) => {
  const h = host(t);
  const pageId = await cachedPage(h);
  const first = await open(h, pageId);
  await crashAfterEdit(first, "Unsaved in the first session");

  const second = await open(h, pageId);
  const replica = second.replicaId;
  assert.equal(replica, first.replicaId);
  assert.deepEqual(
    ownEntries(second.localPage, replica).map((entry) => entry.actor),
    [first.actor(), second.actor()],
  );
  assert.equal(second.statusId, "saving");
  await acknowledge(h, second);
  assert.equal(second.status, "Saved");
  const acknowledged = await readLocalPage(h.auth.identity, pageId);
  assert.deepEqual(
    ownEntries(acknowledged, replica).map((entry) => entry.actor),
    [second.actor()],
    "the receipt covers the first session's edit",
  );
  await second.close();
  assert.deepEqual(ownEntries(await readLocalPage(h.auth.identity, pageId), replica), []);
});

test("an open that fails before classifying keeps the replica's unconfirmed actors", async (t) => {
  const h = host(t);
  const pageId = await cachedPage(h);
  const first = await open(h, pageId);
  await acknowledge(h, first);
  const actor = first.actor();
  await crashAfterEdit(first, "Unsaved before a failed open");

  // Recording the next session's actor fails once, as a transient IndexedDB
  // error would. open() then closes the half-open session, and that close's
  // checkpoint write succeeds.
  t.mock.method(
    PageSession.prototype,
    "recordActor",
    async () => {
      throw Object.assign(Error("IndexedDB is briefly unavailable"), { name: "UnknownError" });
    },
    { times: 1 },
  );
  const failed = await PageSession.open(pageId, {
    authentication: h.auth,
    refreshSession: async () => h.auth,
  }).then(
    () => assert.fail("the open should fail"),
    (error) => error,
  );
  assert.equal(failed.message, "IndexedDB is briefly unavailable");
  await failed.cleanupPromise;
  const cleaned = await readLocalPage(h.auth.identity, pageId);
  assert.ok(
    cleaned.localEdits.actors.some((entry) => entry.actor === actor),
    "the cleanup close keeps the actor with the unconfirmed edit",
  );

  const reopened = await open(h, pageId);
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().title, "Unsaved before a failed open");
  assert.equal(reopened.recoveryPending, true);
  assert.equal(reopened.statusId, "saving");
});

test("closing a legacy pending checkpoint early keeps its receipt flag as unattributed", async (t) => {
  const h = host(t);
  const pageId = await cachedPage(h);
  const legacy = await readLocalPage(h.auth.identity, pageId);
  await writeLocalPage(h.auth.identity, { ...legacy, pending: true });
  t.mock.method(
    PageSession.prototype,
    "recordActor",
    async () => {
      throw Error("IndexedDB is briefly unavailable");
    },
    { times: 1 },
  );
  const failed = await PageSession.open(pageId, {
    authentication: h.auth,
    refreshSession: async () => h.auth,
  }).catch((error) => error);
  await failed.cleanupPromise;
  const cleaned = await readLocalPage(h.auth.identity, pageId);
  assert.ok(
    !cleaned.localEdits || cleaned.localEdits.unattributed,
    "a cleanup close never turns a legacy pending checkpoint into a clean one",
  );
  h.state.offline = true;
  const reopened = await open(h, pageId);
  t.after(() => reopened.close());
  assert.equal(reopened.sync$.snapshot().pending, true);
});
