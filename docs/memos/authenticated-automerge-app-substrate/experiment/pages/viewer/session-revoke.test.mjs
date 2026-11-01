// Host refusals that retire this browser's copy of a Page. A removed account
// or a deleted Page stops rendering at once and after a reload; the copy moves
// to the recovery archive, its comments document included. A transient failure, Trash and a
// refusal without a code keep the copy. A re-grant opens the server's version.
import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { SubductionBackend } from "@automerge/automerge-repo-subduction";
import { PageSession, refusalOf, listLocalPages, signingKeyRefused } from "./session.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { applyComment } from "../model/comments.mjs";
import { COMMENTS_FEATURE } from "../model/comments-doc.mjs";
import { comment, newCommentsDoc } from "../model/comments-test-support.mjs";
import { stampFeatures } from "../model/schema-features.mjs";
import { admissionCloseOutcome } from "../shared/admission.mjs";
import { retiredCopies } from "./retired-copies.mjs";
import { decoder, encoder, entryStanding, key, store } from "./local-catalog.mjs";
import {
  decodeSnapshot,
  encodeSnapshot,
  listLocalRecoveries,
  prepareLocalPageReload,
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

/** A Page with one paragraph and one comment in its comments document, as a
 * collaborator's browser holds it: an open session with both documents and a
 * written checkpoint of both. */
async function openCopy(auth = authentication(), { grant = access(), key = "1:writer" } = {}) {
  const pageId = crypto.randomUUID();
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  const commentsDocumentId = interpretAsDocumentId(generateAutomergeUrl());
  const doc = A.change(A.from(createPageData({ pageId, title: "Shared garden" })), (d) => {
    initializePage(d, BODY);
    stampFeatures(d, [COMMENTS_FEATURE]);
  });
  const blockId = Object.keys(doc.blocks)[0];
  let comments = comment(
    doc,
    newCommentsDoc(),
    { block_id: blockId, body: COMMENT },
    auth.identity,
  ).comments;
  const session = new PageSession(pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  session.acceptAuthentication(auth);
  session.access = grant;
  session.replicaKey = key;
  session.handle = { doc: () => doc, documentId };
  session.commentsHandle = {
    doc: () => comments,
    documentId: commentsDocumentId,
    on() {},
    change(fn) {
      comments = A.change(comments, fn);
    },
  };
  session.repo = { flush: async () => {} };
  session.localPage = {
    principal: auth.identity.principal,
    page_id: pageId,
    document_id: documentId,
    snapshot: encodeSnapshot(A.save(doc)),
    comments_snapshot: encodeSnapshot(A.save(comments)),
    comments_document_id: commentsDocumentId,
    title: doc.title,
    registered: true,
    pending: false,
    canWrite: true,
    access: session.access,
    replicaKey: session.replicaKey,
  };
  session.savedHeads = A.getHeads(doc);
  session.savedCommentHeads = A.getHeads(comments);
  session.localPage.comment_saved_heads = session.savedCommentHeads;
  session.dispatch({ type: "opened", denied: false });
  session.updateCapabilities();
  await writeLocalPage(auth.identity, session.localPage);
  return {
    session,
    auth,
    doc,
    pageId,
    documentId,
    commentsDocumentId,
    blockId,
    comments: () => comments,
  };
}

const hexOf = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

const reopen = (first) =>
  PageSession.open(first.pageId, {
    authentication: first.auth,
    refreshSession: async () => first.auth,
  });
const quota = () =>
  Object.assign(Error("The quota has been exceeded."), { name: "QuotaExceededError" });
async function until(condition, label) {
  for (let i = 0; i < 200 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), label);
}

test("a failed archive leaves the copy as stored; the next refusal retires it", async (t) => {
  browser(t);
  const first = await openCopy();
  first.session.retireLocal = async () => {
    throw quota();
  };
  await first.session.revoke();
  assert.equal(first.session.phase$.snapshot().name, "retireFailed");
  await first.session.close();
  // Nothing claims the copy was retired: the checkpoint is as it was, listed.
  const stored = await readLocalPage(first.auth.identity, first.pageId, { markers: true });
  assert.equal(stored.revoked, undefined);
  assert.ok(stored.snapshot);
  assert.equal((await listLocalPages(first.auth.identity)).length, 1);
  assert.deepEqual(await listLocalRecoveries(first.auth.identity, first.pageId), []);
  // The next open reaches the host, which refuses again: retirement runs again.
  t.mock.method(
    globalThis,
    "fetch",
    respond(403, { error: "Document access denied", code: "page_access_denied" }),
  );
  const session = await reopen(first);
  t.after(() => session.close());
  await until(() => session.recoveryArchived, "the second retirement archives the copy");
  assert.equal(session.snapshot(), null);
  const marker = await readLocalPage(first.auth.identity, first.pageId, { markers: true });
  assert.equal(marker.revoked, true);
  assert.deepEqual(await listLocalPages(first.auth.identity), []);
  const records = await listLocalRecoveries(first.auth.identity, first.pageId);
  assert.ok(records.some((record) => textOf(record).includes(BODY)));
});

test("Try again in the same tab archives the copy", async (t) => {
  const first = await openCopy();
  let fail = true;
  first.session.retireLocal = (...args) =>
    fail ? Promise.reject(quota()) : PageSession.prototype.retireLocal.apply(first.session, args);
  await first.session.revoke();
  t.after(() => first.session.close());
  assert.equal(first.session.retireFailed, true);
  fail = false;
  await first.session.retryRetirement();
  assert.equal(first.session.recoveryArchived, true);
  assert.equal(first.session.retireProblem, undefined);
  assert.equal(
    (await readLocalPage(first.auth.identity, first.pageId, { markers: true })).revoked,
    true,
  );
  const records = await listLocalRecoveries(first.auth.identity, first.pageId);
  assert.ok(records.some((record) => textOf(record).includes(BODY)));
});

/** Tab B opens the Page under a re-grant: the reset marker for the new key,
 * then the new grant's first checkpoint. */
async function regrantedTab(first) {
  const granted = access("editor", 2, 3);
  await prepareLocalPageReload(first.auth.identity, first.session.localPage, granted, "2:writer");
  const doc = A.change(
    A.from(createPageData({ pageId: first.pageId, title: "Tab B after the re-grant" })),
    initializePage,
  );
  const page = {
    ...first.session.localPage,
    access: granted,
    replicaKey: "2:writer",
    snapshot: encodeSnapshot(A.save(doc)),
    title: doc.title,
    pending: false,
  };
  await writeLocalPage(first.auth.identity, page);
  return page;
}

test("Try again after a re-grant leaves the newer grant's checkpoint and marks nothing", async (t) => {
  const first = await openCopy();
  let fail = true;
  first.session.retireLocal = (...args) =>
    fail ? Promise.reject(quota()) : PageSession.prototype.retireLocal.apply(first.session, args);
  await first.session.revoke();
  t.after(() => first.session.close());
  assert.equal(first.session.retireFailed, true);
  // The owner shares the Page again and tab B opens it.
  const tabB = await regrantedTab(first);
  const before = await listLocalRecoveries(first.auth.identity, first.pageId);
  fail = false;
  await first.session.retryRetirement();
  assert.equal(first.session.recoveryArchived, true, "tab A's own copy is archived");
  const stored = await readLocalPage(first.auth.identity, first.pageId, { markers: true });
  assert.equal(stored.revoked, undefined, "no marker over the newer grant");
  assert.equal(stored.replicaKey, "2:writer");
  assert.equal(stored.snapshot, tabB.snapshot, "tab B's checkpoint is untouched");
  const after = await listLocalRecoveries(first.auth.identity, first.pageId);
  assert.equal(after.length, before.length + 1, "only tab A's live copy joins the archive");
  assert.match(textOf(after.at(-1)), new RegExp(BODY));
  assert.ok(!after.some((record) => record.snapshot === tabB.snapshot));
  // Tab B keeps writing; nothing refuses it.
  await writeLocalPage(first.auth.identity, { ...tabB, pending: true });
  assert.equal((await listLocalPages(first.auth.identity)).length, 1);
});

test("a first retirement or a purge under an older grant leaves a newer checkpoint", async (t) => {
  for (const reason of ["access", "deleted"]) {
    const first = await openCopy();
    const tabB = await regrantedTab(first);
    // Tab A still holds the first grant's replica ("1:writer") when its
    // refusal lands.
    if (reason === "access") await first.session.revoke();
    else await first.session.markDeleted();
    t.after(() => first.session.close());
    assert.equal(first.session.phase$.snapshot().name, "retired", reason);
    const stored = await readLocalPage(first.auth.identity, first.pageId, { markers: true });
    assert.equal(stored.snapshot, tabB.snapshot, reason);
    assert.equal(stored.revoked ?? stored.deleted, undefined, reason);
    // A purge read under the older grant is stale the same way.
    assert.deepEqual(
      await retireLocalPage(first.auth.identity, first.pageId, { reason, grant: "1:writer" }),
      { superseded: true },
    );
  }
});

test("a retirement under the same or a newer grant writes the marker", async () => {
  for (const [stored, grant] of [
    ["1:writer", "1:writer"],
    ["1:writer", "2:writer"],
    ["1:writer", undefined],
  ]) {
    const { session, auth, pageId } = await openCopy();
    await session.close();
    await writeLocalPage(auth.identity, { ...session.localPage, replicaKey: stored });
    const marker = await retireLocalPage(auth.identity, pageId, { reason: "access", grant });
    assert.equal(marker.revoked, true, `${stored} retired under ${grant}`);
    assert.equal((await listLocalRecoveries(auth.identity, pageId)).length, 1);
  }
  // A reset marker from a newer grant counts as that grant's entry.
  const { session, auth, pageId } = await openCopy();
  await session.close();
  await prepareLocalPageReload(
    auth.identity,
    session.localPage,
    access("editor", 2, 3),
    "2:writer",
  );
  assert.deepEqual(
    await retireLocalPage(auth.identity, pageId, { reason: "access", grant: "1:writer" }),
    { superseded: true },
  );
});

test("every recovery record is offered, equal snapshots with different drafts included", async (t) => {
  const { session, pageId } = await openCopy();
  t.after(() => session.close());
  const snapshot = session.localPage.snapshot;
  const record = (comment_drafts, at) => ({
    page_id: pageId,
    snapshot,
    archived_at: at,
    ...(comment_drafts && { comment_drafts }),
  });
  const records = [
    record(undefined, "2026-11-01T00:00:00.000Z"),
    record([{ kind: "comment", body: "First draft" }], "2026-11-01T00:00:01.000Z"),
    record([{ kind: "comment", body: "Second draft" }], "2026-11-01T00:00:02.000Z"),
  ];
  const { copies } = session.exportRecoveries(records);
  assert.equal(copies.length, 3);
  assert.doesNotMatch(copies[0].markdown, /Unsent comment drafts/);
  assert.match(copies[1].markdown, /First draft/);
  assert.doesNotMatch(copies[1].markdown, /Second draft/);
  assert.match(copies[2].markdown, /Second draft/);
  assert.deepEqual(
    copies.map((copy) => copy.archived_at),
    records.map((entry) => entry.archived_at),
  );
});

/** A company reader's copy: owner and company access stay at member
 * generation 0, so only the host access revision tells grants apart. */
function companyCopy(revision) {
  const reader = { ...access("viewer", 0, revision), canWrite: false, canComment: false };
  return openCopy(authentication(), { grant: reader, key: "0:reader" });
}

test("a company grant's newer checkpoint survives a stale Try again at the same generation", async (t) => {
  const first = await companyCopy(3);
  assert.equal(
    (await readLocalPage(first.auth.identity, first.pageId)).grant_revision,
    3,
    "each checkpoint records the readable grant revision it was written under",
  );
  let fail = true;
  first.session.retireLocal = (...args) =>
    fail ? Promise.reject(quota()) : PageSession.prototype.retireLocal.apply(first.session, args);
  // Company sharing goes off (revision 4); tab A is refused and its archive fails.
  await first.session.revoke();
  t.after(() => first.session.close());
  assert.equal(first.session.retireFailed, true);
  // Sharing comes back on (revision 5) and tab B checkpoints under "0:reader".
  const reader = { ...access("viewer", 0, 5), canWrite: false, canComment: false };
  const edited = A.change(first.doc, (d) => {
    d.title = "Tab B under the restored company grant";
  });
  const tabB = {
    ...first.session.localPage,
    access: reader,
    replicaKey: "0:reader",
    snapshot: encodeSnapshot(A.save(edited)),
    title: edited.title,
  };
  await writeLocalPage(first.auth.identity, tabB);
  assert.equal((await readLocalPage(first.auth.identity, first.pageId)).grant_revision, 5);
  fail = false;
  await first.session.retryRetirement();
  assert.equal(first.session.recoveryArchived, true, "tab A's own copy is archived");
  const stored = await readLocalPage(first.auth.identity, first.pageId, { markers: true });
  assert.equal(stored.revoked, undefined, "no marker over the restored grant");
  assert.equal(stored.snapshot, tabB.snapshot, "tab B's checkpoint survives");
  assert.equal(stored.replicaKey, "0:reader");
  assert.equal(stored.grant_revision, 5);
  await writeLocalPage(first.auth.identity, { ...tabB, pending: true });
});

test("the revision guard writes the marker for the same revision and for legacy entries", async () => {
  // Same revision: the refused grant is the stored one.
  {
    const { session, auth, pageId } = await companyCopy(4);
    await session.close();
    const marker = await retireLocalPage(auth.identity, pageId, {
      reason: "access",
      grant: "0:reader",
      revision: 4,
    });
    assert.equal(marker.revoked, true);
  }
  // A refused fact never raises the stored revision.
  {
    const { session, auth, pageId } = await companyCopy(4);
    await session.close();
    await writeLocalPage(auth.identity, {
      ...session.localPage,
      access: { ...access("none", 0, 6), canRead: false },
    });
    assert.equal((await readLocalPage(auth.identity, pageId)).grant_revision, 4);
  }
  // Legacy entry without grant_revision: only the generation decides.
  {
    const { session, auth, pageId } = await companyCopy(4);
    await session.close();
    await store.run("readwrite", (records, done) => {
      const entryKey = key(auth.identity, pageId);
      const request = records.get(entryKey);
      request.onsuccess = () => {
        const legacy = JSON.parse(decoder.decode(request.result));
        delete legacy.grant_revision;
        delete legacy.access;
        records.put(encoder.encode(JSON.stringify(legacy)), entryKey);
        done();
      };
      return request;
    });
    assert.equal((await readLocalPage(auth.identity, pageId)).grant_revision, undefined);
    const marker = await retireLocalPage(auth.identity, pageId, {
      reason: "access",
      grant: "0:reader",
      revision: 1,
    });
    assert.equal(marker.revoked, true);
  }
});

test("superseded retirements advance the entry's sequence, so the newest sorts last", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00.000Z") });
  // Each archive key sorts before the one written earlier.
  let uuid = 0xffff;
  t.mock.method(
    crypto,
    "randomUUID",
    () => `00000000-0000-4000-8000-${(uuid--).toString(16).padStart(12, "0")}`,
  );
  const first = await openCopy();
  await first.session.close();
  const tabB = await regrantedTab(first);
  const before = (await readLocalPage(first.auth.identity, first.pageId)).recovery_sequence;
  const snapshotOf = (title) => {
    const doc = A.change(A.clone(first.doc), (d) => {
      d.title = title;
    });
    return encodeSnapshot(A.save(doc));
  };
  for (const title of ["Older stale archive", "Newer stale archive"])
    assert.deepEqual(
      await retireLocalPage(first.auth.identity, first.pageId, {
        reason: "access",
        grant: "1:writer",
        revision: 1,
        snapshot: snapshotOf(title),
        title,
      }),
      { superseded: true },
    );
  const stored = await readLocalPage(first.auth.identity, first.pageId);
  assert.equal(stored.recovery_sequence, before + 2, "only the sequence advanced");
  assert.equal(stored.snapshot, tabB.snapshot);
  assert.equal(stored.replicaKey, "2:writer");
  assert.equal(stored.grant_revision, 3);
  const records = await listLocalRecoveries(first.auth.identity, first.pageId);
  assert.equal(records.at(-1).title, "Newer stale archive");
  assert.equal(records.at(-2).title, "Older stale archive");
  assert.equal(records.at(-1).archived_at, records.at(-2).archived_at, "same millisecond");
});

// The comments document retires with the Page: the archive holds both, a
// hidden Page shows neither, and no late lookup or restore brings them back.

const UNSENT = "Typed after the last receipt; the host never saw it.";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const commentsText = (record) => {
  const comments = A.load(decodeSnapshot(record.comments_snapshot));
  try {
    return JSON.stringify(comments);
  } finally {
    A.free(comments);
  }
};
/** Write one comment to the open session's comments document, with no
 * checkpoint or receipt after it. */
function typeUnsentComment(copy, body = UNSENT) {
  copy.session.commentsHandle.change((draft) => {
    applyComment(draft, { block_id: copy.blockId, body }, copy.auth.identity, undefined, {
      page: copy.doc,
      role: "editor",
      literal: true,
    });
  });
}

test("retiring a Page with an unsent comment archives it, and Download lists it", async (t) => {
  browser(t);
  const copy = await openCopy();
  const { session, auth, pageId, commentsDocumentId } = copy;
  typeUnsentComment(copy);
  assert.equal(session.recoveryPending, true, "the comment is unsent");
  t.mock.method(
    globalThis,
    "fetch",
    respond(403, { error: "Document access denied", code: "page_access_denied" }),
  );
  await session.retryConnection();
  await session.closeSettled();
  assert.equal(session.recoveryArchived, true);
  assert.deepEqual(session.commentThreads, {}, "a hidden Page shows no comments");
  assert.equal(session.snapshot(), null);
  const records = await listLocalRecoveries(auth.identity, pageId);
  // The stored checkpoint, and the live copy: same Page, newer comments.
  assert.equal(records.length, 2);
  const [stored, live] = records;
  assert.equal(live.snapshot, stored.snapshot);
  for (const record of records) assert.equal(record.comments_document_id, commentsDocumentId);
  assert.doesNotMatch(commentsText(stored), new RegExp(UNSENT));
  assert.match(commentsText(live), new RegExp(UNSENT));
  assert.match(commentsText(live), new RegExp(COMMENT));
  const download = session.exportRecoveries(records);
  assert.ok(download.copies.some((c) => c.markdown.includes(UNSENT)));
  assert.match(session.exportRecovery(live).markdown, new RegExp(UNSENT));
  // After a reload, the archive alone still lists it.
  const reopened = await PageSession.open(pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  t.after(() => reopened.close());
  assert.equal(reopened.revoked, true);
  const after = reopened.exportRecoveries(await reopened.listRecoveries());
  assert.equal(after.copies.length, 2, "nothing in memory joins the archive");
  assert.match(after.copies.at(-1).markdown, new RegExp(UNSENT));
  assert.equal(after.copies.at(-1).comments_document_id, commentsDocumentId);
});

test("a revoked Page doesn't restore or open its comments document on reopen", async (t) => {
  browser(t);
  const first = await openCopy();
  typeUnsentComment(first);
  await first.session.persistLocal({ pending: true });
  t.mock.method(
    globalThis,
    "fetch",
    respond(403, { error: "Document access denied", code: "page_access_denied" }),
  );
  await first.session.retryConnection();
  await first.session.closeSettled();
  const stored = [];
  t.mock.method(SubductionBackend.prototype, "storeSnapshot", async function (id, ...rest) {
    stored.push(hexOf(id));
    return SubductionBackend.prototype.storeSnapshot.mock.original.call(this, id, ...rest);
  });
  const opened = [];
  t.mock.method(PageSession.prototype, "openComments", function (...args) {
    opened.push(args);
    return PageSession.prototype.openComments.mock.original.apply(this, args);
  });
  const session = await PageSession.open(first.pageId, {
    authentication: first.auth,
    refreshSession: async () => first.auth,
  });
  t.after(() => session.close());
  assert.equal(session.revoked, true);
  assert.ok(
    !stored.includes(hexOf(documentIdToBinary(first.commentsDocumentId))),
    "the comments checkpoint never reaches native storage",
  );
  assert.deepEqual(opened, []);
  assert.equal(session.commentsOpen$.snapshot().name, "closed");
  assert.equal(session.commentsDoc, undefined);
  assert.deepEqual(session.commentThreads, {});
  assert.equal(session.snapshot(), null);
  // The archive still holds the unsent comment.
  const records = await session.listRecoveries();
  assert.match(commentsText(records.at(-1)), new RegExp(UNSENT));
});

test("a comments lookup running at retirement is cancelled and never installs", async () => {
  const copy = await openCopy();
  const { session, auth, pageId, commentsDocumentId } = copy;
  const handle = session.commentsHandle;
  session.commentsHandle = undefined;
  const calls = [];
  session.repo = {
    flush: async () => {},
    find(id, { signal } = {}) {
      return new Promise((resolve, reject) => {
        calls.push({ id, signal, resolve });
        signal?.addEventListener("abort", () => reject(signal.reason ?? Error("aborted")));
      });
    },
  };
  session.openComments(commentsDocumentId);
  await tick();
  assert.equal(calls.length, 1);
  await session.revoke();
  assert.equal(calls[0].signal.aborted, true, "retirement cancels the lookup");
  calls[0].resolve(handle);
  await tick();
  await tick();
  assert.equal(session.commentsHandle, undefined, "the late result never installs");
  assert.equal(session.commentsOpen$.snapshot().name, "closed");
  assert.deepEqual(session.commentThreads, {});
  // Nothing reopens it: the Page is hidden.
  session.openComments(commentsDocumentId);
  assert.equal(session.commentsOpen$.snapshot().name, "closed");
  assert.equal((await readLocalPage(auth.identity, pageId, { markers: true })).revoked, true);
  // The stored checkpoint's comments went to the archive.
  const [record] = await listLocalRecoveries(auth.identity, pageId);
  assert.equal(record.comments_document_id, commentsDocumentId);
  assert.match(commentsText(record), new RegExp(COMMENT));
});

test("a comments restore that starts after another tab retired the copy writes nothing", async (t) => {
  const { session, auth, pageId } = await openCopy();
  t.after(() => session.close());
  const record = session.localPage;
  const stores = [];
  session.backend = { storeSnapshot: async (...args) => stores.push(args) };
  // Another tab sees the refusal first.
  await retireLocalPage(auth.identity, pageId, {
    reason: "access",
    grant: "1:writer",
    revision: 1,
  });
  await session.restoreCommentsCheckpoint(record);
  assert.deepEqual(stores, []);
  // A deletion marker fences it the same way.
  await retireLocalPage(auth.identity, pageId, { reason: "deleted" });
  await session.restoreCommentsCheckpoint(record);
  assert.deepEqual(stores, []);
});

/** Wait until `check` passes, or `limit` turns. */
async function turnsUntil(check, limit = 100) {
  for (let turn = 0; turn < limit && !check(); turn++) await tick();
}
/** Take the open copy's comments document away, as before its lookup
 * settles, and return a repo whose lookup finds `handle` when released. */
function pendingLookup(session) {
  const handle = session.commentsHandle;
  session.commentsHandle = undefined;
  const found = { resolve: undefined };
  session.repo = {
    flush: async () => {},
    find: () => new Promise((resolve) => (found.resolve = () => resolve(handle))),
  };
  return { handle, found };
}

for (const keepsId of [true, false])
  test(`a lookup that settles after another tab retired the copy retires this tab too${keepsId ? ", with the comments ID already known" : ""}`, async (t) => {
    const copy = await openCopy();
    const { session, auth, pageId, commentsDocumentId } = copy;
    t.after(() => session.close());
    const { handle, found } = pendingLookup(session);
    if (!keepsId) session.localPage = { ...session.localPage, comments_document_id: undefined };
    session.openComments(commentsDocumentId);
    await tick();
    const sequence = (await readLocalPage(auth.identity, pageId)).recovery_sequence ?? 0;
    // Another tab sees the refusal first.
    await retireLocalPage(auth.identity, pageId, {
      reason: "access",
      grant: "1:writer",
      revision: 1,
    });
    // This replica's comments document holds a comment no checkpoint has.
    typeUnsentComment({ ...copy, session: { commentsHandle: handle } });
    let rendered = false;
    session.subscribe(() => {
      if (!session.hidden && Object.keys(session.commentThreads).length) rendered = true;
    });
    found.resolve();
    await turnsUntil(() => session.recoveryArchived);
    await session.closeSettled();
    assert.equal(session.revoked, true);
    assert.equal(rendered, false, "the retired comments never render");
    assert.deepEqual(session.commentThreads, {});
    const stored = await readLocalPage(auth.identity, pageId, { markers: true });
    assert.equal(stored.revoked, true, "the marker stays");
    assert.equal(stored.snapshot, undefined);
    const records = await listLocalRecoveries(auth.identity, pageId);
    assert.ok(records.length > sequence);
    assert.match(
      commentsText(records.at(-1)),
      new RegExp(UNSENT),
      "the unsent comment is archived",
    );
  });

test("a lookup that settles after another grant replaced the copy installs nothing", async (t) => {
  const copy = await openCopy();
  const { session, auth, pageId, commentsDocumentId } = copy;
  t.after(() => session.close());
  const { found } = pendingLookup(session);
  session.openComments(commentsDocumentId);
  await tick();
  // Company sharing went off and on again: the same replica key, a newer
  // grant revision.
  const stored = await readLocalPage(auth.identity, pageId);
  await writeLocalPage(auth.identity, { ...stored, access: access("editor", 1, 5) });
  found.resolve();
  await turnsUntil(() => session.accessReloadRequired || session.commentsHandle);
  assert.equal(session.commentsHandle, undefined);
  assert.equal(session.hidden, false, "another grant's entry is not a refusal");
});

test("a comments serialization that throws fails the retirement and keeps both documents", async (t) => {
  const copy = await openCopy();
  const { session, auth, pageId, commentsDocumentId } = copy;
  t.after(() => session.close());
  typeUnsentComment(copy);
  session.watchCommentDrafts(() => [{ kind: "comment", body: "A draft beside it." }]);
  const handle = session.commentsHandle;
  const real = handle.doc;
  // The comments document can still be read, but not serialized.
  let broken = true;
  handle.doc = () => (broken ? JSON.parse(JSON.stringify(real())) : real());
  const releases = t.mock.method(session, "releaseLocal", async () => {});
  const before = await readLocalPage(auth.identity, pageId, { markers: true });
  await session.revoke();
  assert.deepEqual(session.phase$.snapshot(), {
    name: "retireFailed",
    reason: "access",
    held: true,
  });
  assert.equal(session.hidden, true, "the Page stays hidden");
  assert.equal(session.recoveryArchived, false);
  assert.match(session.retireProblem, /couldn't copy the Page/);
  assert.equal(releases.mock.callCount(), 0, "the backend stays for Try again");
  assert.equal(session.commentsHandle, handle, "the comments document stays open");
  assert.ok(session.handle);
  assert.equal(session.closedRecovery, undefined, "nothing claims a complete copy");
  // Nothing was archived and the stored checkpoint is as it was.
  assert.deepEqual(await listLocalRecoveries(auth.identity, pageId), []);
  assert.deepEqual(await readLocalPage(auth.identity, pageId, { markers: true }), before);
  // The notice and the reload gate still get the Markdown it projects.
  assert.match(session.retainedCopy.markdown, new RegExp(UNSENT));
  assert.match(session.retainedCopy.markdown, /A draft beside it\./);
  const download = session.exportRecoveries([]);
  assert.equal(download.copies.length, 1);
  assert.match(download.copies[0].markdown, new RegExp(UNSENT));
  assert.equal(download.copies[0].snapshot, undefined);
  assert.equal(retiredCopies(session, []), 1);
  // Try again captures both documents and archives them.
  broken = false;
  await session.retryRetirement();
  assert.equal(session.recoveryArchived, true);
  assert.equal(releases.mock.callCount(), 1, "the release follows the archive");
  const records = await listLocalRecoveries(auth.identity, pageId);
  const live = records.at(-1);
  assert.equal(live.comments_document_id, commentsDocumentId);
  assert.match(commentsText(live), new RegExp(UNSENT));
  assert.deepEqual(live.comment_drafts, [{ kind: "comment", body: "A draft beside it." }]);
  assert.equal((await readLocalPage(auth.identity, pageId, { markers: true })).revoked, true);
});

test("leaving a failed capture releases the backend and keeps its best-effort copy", async (t) => {
  const copy = await openCopy();
  const { session } = copy;
  typeUnsentComment(copy);
  const handle = session.commentsHandle;
  const real = handle.doc;
  handle.doc = () => JSON.parse(JSON.stringify(real()));
  const releases = t.mock.method(session, "releaseLocal", async () => {});
  await session.revoke();
  assert.equal(session.phase$.snapshot().held, true);
  await session.close();
  assert.deepEqual(session.phase$.snapshot(), { name: "retireFailed", reason: "access" });
  assert.equal(releases.mock.callCount(), 1);
  assert.match(session.retainedCopy.markdown, new RegExp(UNSENT));
});

test("Try again keeps the drafts the first capture read after the UI resets", async (t) => {
  const copy = await openCopy();
  const { session, auth, pageId } = copy;
  t.after(() => session.close());
  // The inline composer keeps its draft in state; a hidden Page resets it.
  let composer = [{ kind: "comment", body: "Composer draft.", quote: "Only the collaborator's" }];
  session.watchCommentDrafts(() => composer);
  // The comments panel unmounts on a hidden Page and removes its source.
  const panel = [{ kind: "reply", thread_id: "thread-1", body: "Panel reply." }];
  const unwatchPanel = session.watchCommentDrafts(() => panel);
  // A panel that mounts again later still holds the same reply.
  let remounted;
  session.subscribe(() => {
    if (!session.hidden || remounted) return;
    composer = [];
    unwatchPanel();
    remounted = session.watchCommentDrafts(() => panel);
  });
  const handle = session.commentsHandle;
  const real = handle.doc;
  let broken = true;
  handle.doc = () => (broken ? JSON.parse(JSON.stringify(real())) : real());
  t.mock.method(session, "releaseLocal", async () => {});
  await session.revoke();
  assert.equal(session.phase$.snapshot().held, true);
  assert.ok(remounted, "the UI reset between the failed capture and Try again");
  assert.match(session.exportRecoveries([]).copies[0].markdown, /Composer draft\./);
  broken = false;
  await session.retryRetirement();
  assert.equal(session.recoveryArchived, true);
  const records = await listLocalRecoveries(auth.identity, pageId);
  const live = records.at(-1);
  assert.deepEqual(live.comment_drafts, [
    { kind: "comment", body: "Composer draft.", quote: "Only the collaborator's" },
    { kind: "reply", body: "Panel reply.", thread_id: "thread-1" },
  ]);
  const download = session.exportRecoveries(records);
  const markdown = download.copies.at(-1).markdown;
  assert.match(markdown, /Composer draft\./);
  assert.equal(markdown.split("Panel reply.").length - 1, 1, "a draft read twice is listed once");
});

test("a same-tab retirement during a comments install archives the found document", async (t) => {
  const copy = await openCopy();
  const { session, auth, pageId, commentsDocumentId } = copy;
  t.after(() => session.close());
  const { handle, found } = pendingLookup(session);
  session.openComments(commentsDocumentId);
  await tick();
  // A comment that exists only in the document the lookup finds.
  typeUnsentComment({ ...copy, session: { commentsHandle: handle } });
  let rendered = false;
  session.subscribe(() => {
    if (Object.keys(session.commentThreads).length) rendered = true;
  });
  found.resolve();
  // The install starts at once and then waits on its stored-entry read.
  for (let turn = 0; turn < 50 && session.pendingComments !== handle; turn++)
    await Promise.resolve();
  assert.equal(session.pendingComments, handle, "the install's stored-entry read is pending");
  assert.equal(session.commentsHandle, undefined, "nothing is adopted yet");
  await session.revoke();
  await turnsUntil(() => false, 20);
  assert.equal(session.recoveryArchived, true);
  assert.equal(rendered, false, "the found document never renders");
  assert.equal(session.commentsHandle, undefined);
  const records = await listLocalRecoveries(auth.identity, pageId);
  const live = records.at(-1);
  assert.equal(live.comments_document_id, commentsDocumentId);
  assert.match(commentsText(live), new RegExp(UNSENT), "the found document's comment is archived");
});

/** A native backend whose history read waits on `gate` before it reports
 * the replica's records, so a test can act between a restore's check and its
 * write. */
function pausedBackend() {
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const reading = { started: false };
  const stores = [];
  return {
    open: () => open(),
    reading,
    stores,
    backend: {
      open: () => ({
        events: (async function* () {
          reading.started = true;
          await gate;
          yield { type: "local-load-complete" };
        })(),
        close: async () => {},
      }),
      storeSnapshot: async (...args) => stores.push(args),
    },
  };
}

test("a restore paused before its native write stores nothing once the copy is retired or replaced", async (t) => {
  const interleavings = {
    "no interference": async () => {},
    "another tab retires the copy": ({ auth, pageId }) =>
      retireLocalPage(auth.identity, pageId, { reason: "access", grant: "1:writer", revision: 1 }),
    "another tab deletes it": ({ auth, pageId }) =>
      retireLocalPage(auth.identity, pageId, { reason: "deleted" }),
    "a replacement grant keeps the replica key with a newer revision": async ({ auth, pageId }) => {
      const stored = await readLocalPage(auth.identity, pageId);
      await writeLocalPage(auth.identity, { ...stored, access: access("editor", 1, 7) });
    },
    "this tab retires": ({ session }) => {
      session.releaseLocal = async () => {};
      return session.revoke();
    },
  };
  for (const [name, interfere] of Object.entries(interleavings))
    await t.test(name, async () => {
      const copy = await openCopy();
      const { session } = copy;
      const record = await readLocalPage(copy.auth.identity, copy.pageId);
      const paused = pausedBackend();
      session.backend = paused.backend;
      const restoring = session.restoreCommentsCheckpoint(record);
      await turnsUntil(() => paused.reading.started);
      await interfere(copy);
      paused.open();
      await restoring;
      assert.equal(paused.stores.length, name === "no interference" ? 1 : 0);
      await session.close();
    });
});

test("entryStanding names markers, other grants and the current copy", () => {
  const grant = { grant: "0:reader", revision: 3 };
  assert.equal(entryStanding(undefined, grant), "missing");
  assert.equal(entryStanding({ deleted: true }, grant), "deleted");
  assert.equal(entryStanding({ revoked: true }, grant), "revoked");
  assert.equal(entryStanding({ replicaKey: "1:reader", grant_revision: 3 }, grant), "replaced");
  assert.equal(entryStanding({ replicaKey: "0:reader", grant_revision: 4 }, grant), "replaced");
  assert.equal(entryStanding({ replicaKey: "0:reader", grant_revision: 3 }, grant), "current");
  assert.equal(entryStanding({ replicaKey: "0:reader" }, grant), "current", "a legacy entry");
  assert.equal(entryStanding({ replicaKey: "0:reader", grant_revision: 9 }, {}), "current");
});

test("a superseded retirement archives its own comments, never the newer grant's", async () => {
  const first = await openCopy();
  await first.session.close();
  const tabB = await regrantedTab(first);
  // Tab B comments under the newer grant.
  const tabBPage = A.load(decodeSnapshot(tabB.snapshot));
  const newerComments = comment(
    tabBPage,
    A.load(decodeSnapshot(tabB.comments_snapshot)),
    { block_id: Object.keys(tabBPage.blocks)[0], body: "Tab B" },
    first.auth.identity,
  ).comments;
  await writeLocalPage(first.auth.identity, {
    ...tabB,
    comments_snapshot: encodeSnapshot(A.save(newerComments)),
  });
  const retire = (extra) =>
    retireLocalPage(first.auth.identity, first.pageId, {
      reason: "access",
      grant: "1:writer",
      revision: 1,
      snapshot: first.session.localPage.snapshot,
      title: "Tab A",
      ...extra,
    });
  // Without comments of its own, the stale copy carries none.
  assert.deepEqual(await retire(), { superseded: true });
  let records = await listLocalRecoveries(first.auth.identity, first.pageId);
  assert.equal(records.at(-1).comments_snapshot, undefined);
  assert.equal(records.at(-1).comments_document_id, undefined);
  // With them, its own comments go with it.
  assert.deepEqual(
    await retire({
      comments_snapshot: first.session.localPage.comments_snapshot,
      comments_document_id: first.commentsDocumentId,
    }),
    { superseded: true },
  );
  records = await listLocalRecoveries(first.auth.identity, first.pageId);
  assert.match(commentsText(records.at(-1)), new RegExp(COMMENT));
  assert.equal(records.at(-1).comments_document_id, first.commentsDocumentId);
  const stored = await readLocalPage(first.auth.identity, first.pageId);
  assert.match(commentsText(stored), /Tab B/, "the newer grant's comments stay");
});
