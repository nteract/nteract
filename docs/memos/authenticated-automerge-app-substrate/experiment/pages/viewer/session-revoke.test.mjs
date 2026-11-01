// Host refusals that retire this browser's copy of a Page. A removed account
// or a deleted Page stops rendering at once and after a reload; the copy moves
// to the recovery archive, comments included. A transient failure, Trash and a
// refusal without a code keep the copy. A re-grant opens the server's version.
import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { PageSession, refusalOf, listLocalPages, signingKeyRefused } from "./session.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { applyComment } from "../model/comments.mjs";
import { admissionCloseOutcome } from "../shared/admission.mjs";
import { retiredCopies } from "./retired-copies.mjs";
import {
  decodeSnapshot,
  encodeSnapshot,
  listLocalRecoveries,
  readLocalPage,
  retireLocalPage,
  writeLocalPage,
} from "./local-pages.mjs";

const BODY = "Only the collaborator's browser still holds this sentence.";
const COMMENT = "A comment that must survive in the archive.";

const access = (role = "editor", generation = 1, revision = 1) => ({
  role,
  generation,
  revision,
  canRead: role !== "none",
  canWrite: ["owner", "editor"].includes(role),
  canComment: ["owner", "editor"].includes(role),
  canManageAccess: role === "owner",
  canDelete: role === "owner",
});
const authentication = () => ({
  identity: { principal: crypto.randomUUID(), displayName: "Collaborator" },
  canWrite: true,
});

function browser(t) {
  const values = new Map();
  const locks = new Set();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
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
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
    delete globalThis.sessionStorage;
  });
}

/** A Page with one paragraph and one comment, as a collaborator's browser
 * holds it: an open session and a written checkpoint. */
async function openCopy(auth = authentication()) {
  const pageId = crypto.randomUUID();
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  let doc = A.change(A.from(createPageData({ pageId, title: "Shared garden" })), (d) =>
    initializePage(d, BODY),
  );
  const blockId = Object.keys(doc.blocks)[0];
  doc = A.change(doc, (d) => {
    applyComment(d, { block_id: blockId, body: COMMENT }, auth.identity);
  });
  const session = new PageSession(pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  session.acceptAuthentication(auth);
  session.access = access();
  session.replicaKey = "1:writer";
  session.handle = { doc: () => doc, documentId };
  session.repo = { flush: async () => {} };
  session.localPage = {
    principal: auth.identity.principal,
    page_id: pageId,
    document_id: documentId,
    snapshot: encodeSnapshot(A.save(doc)),
    title: doc.title,
    registered: true,
    pending: false,
    canWrite: true,
    access: session.access,
    replicaKey: session.replicaKey,
  };
  session.savedHeads = A.getHeads(doc);
  session.dispatch({ type: "opened", denied: false });
  session.updateCapabilities();
  await writeLocalPage(auth.identity, session.localPage);
  return { session, auth, doc, pageId, documentId };
}

const respond = (status, body) => async () => Response.json(body, { status });
const textOf = (record) => {
  const doc = A.load(decodeSnapshot(record.snapshot));
  try {
    return JSON.stringify(doc);
  } finally {
    A.free(doc);
  }
};

/** The host's answers to /api/connect, and what each does to the copy. */
const ANSWERS = [
  {
    name: "access removed",
    fetch: respond(403, { error: "Document access denied", code: "page_access_denied" }),
    outcome: "revoked",
  },
  {
    // The host answers a Page missing to this account, purged included,
    // exactly as an unreadable one.
    name: "purged, as a removed collaborator sees it",
    fetch: respond(403, { error: "Document access denied", code: "page_access_denied" }),
    outcome: "revoked",
  },
  {
    name: "access fact with a role of none",
    fetch: null,
    outcome: "revoked",
  },
  {
    name: "deleted, as the owner or a member sees it",
    fetch: respond(404, { error: "Page not found", code: "page_deleted" }),
    outcome: "deleted",
  },
  {
    name: "purged, the legacy missing-Page answer",
    fetch: respond(404, { error: "Page not found" }),
    outcome: "deleted",
  },
  {
    name: "in its owner's Trash",
    fetch: respond(403, { error: "This Page is in its owner's Trash", code: "page_trashed" }),
    outcome: "kept",
  },
  {
    name: "refused without a code",
    fetch: respond(403, { error: "Page is private" }),
    outcome: "kept",
  },
  {
    name: "host restarting",
    fetch: respond(503, {
      error: "Page is temporarily unavailable",
      code: "temporarily_unavailable",
      retryable: true,
    }),
    outcome: "kept",
  },
  {
    name: "network failure",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
    outcome: "kept",
  },
];

test("refusalOf names only the refusals that retire the copy", () => {
  assert.equal(refusalOf({ status: 403, code: "page_access_denied" }), "access");
  assert.equal(refusalOf({ status: 404, code: "page_deleted" }), "deleted");
  assert.equal(refusalOf({ status: 404 }), "deleted");
  for (const kept of [
    { status: 403, code: "page_trashed" },
    { status: 403, code: "signing_key_rejected" },
    { status: 403 },
    { status: 401, code: "sign_in_required" },
    { status: 503, code: "temporarily_unavailable" },
    { code: "NETWORK_ERROR" },
    undefined,
  ])
    assert.equal(refusalOf(kept), undefined, JSON.stringify(kept));
});

test("each host answer retires, deletes or keeps the open copy", async (t) => {
  for (const answer of ANSWERS) {
    await t.test(answer.name, async (t) => {
      const { session, auth, doc, pageId, documentId } = await openCopy();
      t.mock.method(
        globalThis,
        "fetch",
        answer.fetch ??
          (async () =>
            Response.json({ identity: auth.identity, documentId, access: access("none", 1, 2) })),
      );
      t.after(() => session.close());
      await session.retryConnection();
      await session.cacheTail?.catch(() => {});
      clearTimeout(session.retryTimer);
      const stored = await readLocalPage(auth.identity, pageId, { markers: true });
      const recoveries = await listLocalRecoveries(auth.identity, pageId);
      if (answer.outcome === "kept") {
        assert.equal(session.hidden, false);
        assert.equal(session.revoked, false);
        assert.equal(session.deleted, false);
        assert.ok(session.snapshot(), "the copy still renders");
        assert.equal(A.load(decodeSnapshot(stored.snapshot)).title, doc.title);
        assert.equal(stored.revoked, undefined);
        assert.deepEqual(recoveries, []);
        assert.equal((await listLocalPages(auth.identity)).length, 1);
        return;
      }
      assert.equal(session.hidden, true);
      assert.equal(session.revoked, answer.outcome === "revoked");
      assert.equal(session.deleted, answer.outcome === "deleted");
      assert.equal(session.alive, false);
      assert.equal(session.canWrite, false);
      assert.equal(session.snapshot(), null, "nothing renders the copy");
      assert.equal(session.status, answer.outcome === "revoked" ? "Access removed" : "Deleted");
      assert.equal(session.recoveryArchived, true);
      assert.equal(session.retryTimer, undefined);
      // The checkpoint is gone from the catalog; a marker holds its place.
      assert.equal(await readLocalPage(auth.identity, pageId), null);
      assert.equal(stored.snapshot, undefined);
      assert.equal(stored[answer.outcome], true);
      assert.deepEqual(await listLocalPages(auth.identity), []);
      // The bytes moved to the recovery archive, comments included.
      assert.equal(recoveries.length, 1);
      assert.match(textOf(recoveries.at(-1)), new RegExp(BODY));
      const exported = session.exportRecovery(recoveries.at(-1));
      assert.match(exported.markdown, new RegExp(BODY));
      assert.match(exported.markdown, new RegExp(COMMENT));
      // This tab's own export of the live replica stays downloadable.
      assert.match(session.exportRecovery().markdown, new RegExp(BODY));
    });
  }
});

test("a refused receipt retires the open copy", async (t) => {
  const { session, auth, pageId } = await openCopy();
  t.mock.method(
    globalThis,
    "fetch",
    respond(403, { error: "Document access denied", code: "page_access_denied" }),
  );
  t.after(() => session.close());
  session.connection = { documentId: session.localPage.document_id };
  await session.saveReceipt();
  assert.equal(session.revoked, true);
  assert.equal(session.snapshot(), null);
  assert.equal(session.receiptRetryTimer, undefined);
  assert.equal((await readLocalPage(auth.identity, pageId, { markers: true })).revoked, true);
  assert.equal((await listLocalRecoveries(auth.identity, pageId)).length, 1);
});

test("a tab that hasn't seen the refusal archives its own copy and retires too", async (t) => {
  const { session, auth, doc, pageId } = await openCopy();
  t.after(() => session.close());
  // Another tab retired the shared checkpoint before this tab's edit.
  await retireLocalPage(auth.identity, pageId, { reason: "access" });
  const edited = A.change(doc, (d) => {
    d.title = "Typed in the stale tab";
  });
  session.handle = { doc: () => edited, documentId: session.localPage.document_id };
  await session.saveReceipt();
  assert.equal(session.revoked, true);
  assert.equal(session.snapshot(), null);
  const recoveries = await listLocalRecoveries(auth.identity, pageId);
  assert.ok(recoveries.some((record) => textOf(record).includes("Typed in the stale tab")));
  assert.equal(await readLocalPage(auth.identity, pageId), null);
});

test("reopening a revoked copy shows the refusal without rendering it", async (t) => {
  browser(t);
  const first = await openCopy();
  t.mock.method(
    globalThis,
    "fetch",
    respond(403, { error: "Document access denied", code: "page_access_denied" }),
  );
  await first.session.retryConnection();
  await first.session.closeSettled();
  // The reload: a new session for the same account and Page.
  const session = await PageSession.open(first.pageId, {
    authentication: first.auth,
    refreshSession: async () => first.auth,
  });
  t.after(() => session.close());
  assert.equal(session.revoked, true);
  assert.equal(session.hidden, true);
  assert.equal(session.doc, undefined, "no replica opened");
  assert.equal(session.snapshot(), null);
  assert.equal(session.closedRecovery, undefined);
  const recoveries = await session.listRecoveries();
  assert.equal(recoveries.length, 1, "the earlier archive is not archived again");
  assert.match(session.exportRecovery(recoveries.at(-1)).markdown, new RegExp(COMMENT));
});

test("reopening a deleted Page's copy shows the deletion without rendering it", async (t) => {
  browser(t);
  const first = await openCopy();
  t.mock.method(
    globalThis,
    "fetch",
    respond(404, { error: "Page not found", code: "page_deleted" }),
  );
  await first.session.retryConnection();
  await first.session.closeSettled();
  const session = await PageSession.open(first.pageId, {
    authentication: first.auth,
    refreshSession: async () => first.auth,
  });
  t.after(() => session.close());
  assert.equal(session.deleted, true);
  assert.equal(session.snapshot(), null);
  assert.equal((await session.listRecoveries()).length, 1);
});

test("a transient failure while reopening a revoked copy keeps the marker and the archive", async (t) => {
  browser(t);
  const first = await openCopy();
  await first.session.close();
  await retireLocalPage(first.auth.identity, first.pageId, {
    reason: "access",
    snapshot: first.session.localPage.snapshot,
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    PageSession.open(first.pageId, {
      authentication: first.auth,
      refreshSession: async () => first.auth,
    }),
    { code: "NETWORK_ERROR" },
  );
  const stored = await readLocalPage(first.auth.identity, first.pageId, { markers: true });
  assert.equal(stored.revoked, true);
  assert.equal(stored.snapshot, undefined);
  assert.equal((await listLocalRecoveries(first.auth.identity, first.pageId)).length, 1);
});

test("a re-grant opens the server's version, never the archived copy", async (t) => {
  const first = await openCopy();
  await first.session.close();
  await retireLocalPage(first.auth.identity, first.pageId, {
    reason: "access",
    snapshot: first.session.localPage.snapshot,
  });
  const server = A.change(
    A.from(createPageData({ pageId: first.pageId, title: "Server version after re-grant" })),
    initializePage,
  );
  const session = new PageSession(first.pageId, {
    authentication: first.auth,
    refreshSession: async () => first.auth,
  });
  const keys = [];
  session.initializeLocal = async (key) => {
    keys.push(key);
    session.replicaKey = key;
    session.repo = {
      flush: async () => {},
      find: async () => ({ doc: () => server, documentId: first.documentId, on() {} }),
    };
  };
  session.releaseLocal = async () => {};
  // The host's answer: a new grant, so a new generation and replica key.
  session.connect = async () => {
    await session.acceptPageAccess(access("editor", 2, 3));
    session.connection = { documentId: first.documentId };
  };
  session.queueSaved = () => {};
  t.after(() => session.close());
  await session.start();
  clearInterval(session.presenceTimer);
  assert.deepEqual(keys, ["0:reader", "2:writer"], "the re-grant's replica, not the retired one");
  assert.equal(session.hidden, false);
  assert.equal(session.phase$.snapshot().name, "open");
  assert.equal(session.canWrite, true);
  const page = session.snapshot();
  assert.equal(page.title, "Server version after re-grant");
  assert.doesNotMatch(JSON.stringify(page), new RegExp(BODY));
  const stored = await readLocalPage(first.auth.identity, first.pageId);
  assert.equal(stored.revoked, undefined);
  assert.equal(stored.replicaKey, "2:writer");
  assert.equal(A.load(decodeSnapshot(stored.snapshot)).title, "Server version after re-grant");
  assert.equal((await listLocalPages(first.auth.identity)).length, 1);
  // The archived copy stays downloadable, and only from the archive.
  const recoveries = await listLocalRecoveries(first.auth.identity, first.pageId);
  assert.equal(recoveries.length, 1);
  assert.match(textOf(recoveries[0]), new RegExp(BODY));
});

test("an access marker refuses ordinary writes and yields only to a re-grant", async () => {
  const { session, auth, pageId } = await openCopy();
  await session.close();
  const page = { ...session.localPage };
  assert.deepEqual(await retireLocalPage(auth.identity, pageId, { reason: "access" }), {
    principal: auth.identity.principal,
    page_id: pageId,
    document_id: page.document_id,
    revoked: true,
    recovery_sequence: 1,
  });
  await assert.rejects(writeLocalPage(auth.identity, page), { code: "LOCAL_PAGE_REVOKED" });
  // The refused write's snapshot is kept beside the archive, not dropped.
  assert.equal((await listLocalRecoveries(auth.identity, pageId)).length, 2);
  const regranted = await writeLocalPage(
    auth.identity,
    { ...page, replicaKey: "2:writer" },
    { regrant: true },
  );
  assert.equal(regranted.revoked, undefined);
  assert.equal(regranted.recovery_sequence, 2);
  // A deletion marker outranks access and never yields.
  await retireLocalPage(auth.identity, pageId, { reason: "deleted" });
  await retireLocalPage(auth.identity, pageId, { reason: "access" });
  assert.equal((await readLocalPage(auth.identity, pageId, { markers: true })).deleted, true);
  await assert.rejects(writeLocalPage(auth.identity, page, { regrant: true }), {
    code: "LOCAL_PAGE_DELETED",
  });
  // A refusal for a Page this browser never held writes nothing.
  const stranger = crypto.randomUUID();
  assert.equal(await retireLocalPage(auth.identity, stranger, { reason: "access" }), null);
  assert.equal(await readLocalPage(auth.identity, stranger, { markers: true }), null);
});

test("the host's 4404 page_deleted socket close retires the copy as deleted", async (t) => {
  const { session, auth, pageId } = await openCopy();
  t.after(() => session.close());
  let reconnects = 0;
  t.mock.method(session, "scheduleReconnect", () => reconnects++);
  const socket = { close() {} };
  session.sockets.add(socket);
  session.socketOutcomes.set(socket, admissionCloseOutcome({ code: 4404, reason: "page_deleted" }));
  session.socketDisconnected(socket);
  assert.equal(session.deleted, true, "not the signing-key refusal");
  assert.equal(session.snapshot(), null);
  await session.closeSettled();
  assert.equal(session.phase$.snapshot().name, "retired");
  assert.equal(reconnects, 0);
  assert.notEqual(session.problem, signingKeyRefused({ code: "page_deleted" }).message);
  assert.equal((await readLocalPage(auth.identity, pageId, { markers: true })).deleted, true);
  assert.equal((await listLocalRecoveries(auth.identity, pageId)).length, 1);
});

test("a failed archive keeps the tab's copy downloadable and never claims it was written", async (t) => {
  const { session, auth, pageId } = await openCopy();
  const quota = Object.assign(Error("The quota has been exceeded."), {
    name: "QuotaExceededError",
  });
  session.retireLocal = async () => {
    throw quota;
  };
  await session.revoke();
  t.after(() => session.close());
  assert.deepEqual(session.phase$.snapshot(), { name: "retireFailed", reason: "access" });
  assert.equal(session.hidden, true);
  assert.equal(session.snapshot(), null, "the Page still doesn't render");
  assert.equal(session.recoveryArchived, false);
  assert.equal(session.retireFailed, true);
  assert.equal(session.retireProblem, quota.message);
  // Nothing reached IndexedDB: the stored checkpoint is untouched, no marker.
  const stored = await readLocalPage(auth.identity, pageId, { markers: true });
  assert.equal(stored.revoked, undefined);
  assert.ok(stored.snapshot);
  assert.deepEqual(await listLocalRecoveries(auth.identity, pageId), []);
  // The notice still offers the tab's export, alone in the bundle.
  assert.equal(retiredCopies(session, []), 1);
  const bundle = session.exportRecoveries([]);
  assert.equal(bundle.copies.length, 1);
  assert.match(bundle.copies[0].markdown, new RegExp(BODY));
  assert.match(bundle.copies[0].markdown, new RegExp(COMMENT));
});

test("a leave during a pending archive waits for it, then for the release", async (t) => {
  const { session, auth, pageId } = await openCopy();
  const archive = Promise.withResolvers();
  const released = [];
  session.releaseLocal = async () => released.push("release");
  session.retireLocal = (...args) =>
    archive.promise.then(() => PageSession.prototype.retireLocal.apply(session, args));
  void session.revoke();
  assert.equal(session.phase$.snapshot().name, "retiring");
  let left = false;
  const leaving = session.leave({ drain: false }).then(() => (left = true));
  const closing = session.closeSettled();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(left, false, "the leave waits for the archive");
  assert.deepEqual(released, [], "nothing released the backend under the archive");
  assert.equal((await readLocalPage(auth.identity, pageId)).snapshot !== undefined, true);
  archive.resolve();
  await Promise.all([leaving, closing]);
  t.after(() => session.close());
  assert.equal(left, true);
  assert.deepEqual(released, ["release"]);
  assert.equal(session.phase$.snapshot().name, "retired");
  assert.equal((await listLocalRecoveries(auth.identity, pageId)).length, 1);
});

test("retirement disconnects before the outbound flush, so queued sends reach no host", async (t) => {
  const { session } = await openCopy();
  t.after(() => session.close());
  const order = [];
  session.disconnectSockets = async () => {
    order.push("disconnect");
  };
  session.releaseLocal = async () => order.push("release");
  // A keystroke's round waits in the batch when the refusal lands.
  session.outbound.scheduleLocalSync("tree", () => order.push("send"));
  await session.revoke();
  assert.equal(order[0], "disconnect");
  assert.deepEqual(order, ["disconnect", "send", "release"]);
  // A leave on the retired session sends nothing more.
  session.outbound.scheduleLocalSync("tree", () => order.push("late send"));
  await session.leave();
  assert.equal(order.filter((entry) => entry === "late send").length, 1, "close() sends at once");
});

test("unsent comment drafts go into the recovery record and the download", async (t) => {
  const { session, auth, pageId } = await openCopy();
  t.after(() => session.close());
  session.watchCommentDrafts(() => [
    { kind: "comment", body: "A draft never sent.", quote: "Only the collaborator's" },
    { kind: "comment", body: "   " },
  ]);
  session.watchCommentDrafts(() => [
    { kind: "reply", thread_id: "thread-1", body: { markdown: "ignored" }.markdown },
  ]);
  await session.revoke();
  const [record] = await listLocalRecoveries(auth.identity, pageId);
  assert.deepEqual(record.comment_drafts, [
    { kind: "comment", body: "A draft never sent.", quote: "Only the collaborator's" },
    { kind: "reply", body: "ignored", thread_id: "thread-1" },
  ]);
  const exported = session.exportRecovery(record);
  assert.match(exported.markdown, /## Unsent comment drafts/);
  assert.match(exported.markdown, /On “Only the collaborator's”/);
  assert.match(exported.markdown, /> A draft never sent\./);
  assert.match(exported.markdown, /Reply to thread thread-1/);
  assert.deepEqual(exported.comment_drafts, record.comment_drafts);
});

test("drafts survive a retirement with no replica to export", async () => {
  const auth = authentication();
  const pageId = crypto.randomUUID();
  const session = new PageSession(pageId, { authentication: auth });
  session.acceptAuthentication(auth);
  session.dispatch({ type: "opened", denied: false });
  session.watchCommentDrafts(() => [{ kind: "comment", body: "Typed before the refusal." }]);
  session.releaseLocal = async () => {};
  await session.revoke();
  const [record] = await listLocalRecoveries(auth.identity, pageId);
  assert.equal(record.snapshot, undefined);
  assert.match(session.exportRecovery(record).markdown, /Typed before the refusal\./);
  assert.equal((await readLocalPage(auth.identity, pageId, { markers: true })).revoked, true);
});

test("divergent stored and live copies are both offered, before and after a reload", async (t) => {
  browser(t);
  const first = await openCopy();
  // The live replica moved on after the checkpoint was written.
  const live = A.change(first.doc, (d) => {
    d.title = "Live edit after the checkpoint";
  });
  first.session.handle = { doc: () => live, documentId: first.documentId };
  t.mock.method(
    globalThis,
    "fetch",
    respond(403, { error: "Document access denied", code: "page_access_denied" }),
  );
  await first.session.retryConnection();
  await first.session.closeSettled();
  const records = await first.session.listRecoveries();
  assert.equal(records.length, 2);
  const before = first.session.exportRecoveries(records);
  assert.equal(before.copies.length, 2, "the archived live copy isn't offered twice");
  assert.deepEqual(before.copies.map((copy) => copy.title).sort(), [
    "Live edit after the checkpoint",
    "Shared garden",
  ]);
  assert.equal(retiredCopies(first.session, records), 2);
  const session = await PageSession.open(first.pageId, {
    authentication: first.auth,
    refreshSession: async () => first.auth,
  });
  t.after(() => session.close());
  assert.equal(session.revoked, true);
  const after = session.exportRecoveries(await session.listRecoveries());
  assert.deepEqual(after.copies.map((copy) => copy.title).sort(), [
    "Live edit after the checkpoint",
    "Shared garden",
  ]);
  for (const copy of after.copies) assert.match(copy.markdown, new RegExp(COMMENT));
});
