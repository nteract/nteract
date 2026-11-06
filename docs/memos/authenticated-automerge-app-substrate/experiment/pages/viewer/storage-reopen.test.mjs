// A native replica of a Page the host converted to plain Automerge sync,
// reopened in place by SessionHost (storage-reopen-machine.mjs). Real
// PageSessions, real IndexedDB checkpoints (fake-indexeddb) and real
// replicas; only the host is faked: discovery, the plain socket and
// /api/saved.
import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { PageSession, STORAGE_ADOPTED, STORAGE_REOPENING } from "./session.mjs";
import { SessionHost } from "./session-host.mjs";
import { decodeSnapshot, encodeSnapshot, readLocalPage, writeLocalPage } from "./local-pages.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { createPageData, initializePage } from "../model/page.mjs";

/** Resolves once `check` returns true, or fails after `ms`. */
async function until(check, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A plain sync socket the host has opened. Frames the replica sends are
 * dropped; nothing arrives from the host. */
class OpenSocket extends EventTarget {
  readyState = 1;
  binaryType = "blob";
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "" }));
  }
}

/** One browser tab with a host that has converted every Page to plain
 * sync. Discovery waits for `release()`; receipts are acknowledged at once
 * and kept in `receipts`. */
function tab(t) {
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
  const sockets = [];
  t.mock.method(globalThis, "WebSocket", function (address) {
    const socket = new OpenSocket();
    socket.url = String(address);
    sockets.push(socket);
    return socket;
  });
  t.after(() => {
    for (const socket of sockets) socket.close();
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator);
    else delete globalThis.navigator;
    if (location) Object.defineProperty(globalThis, "location", location);
    else delete globalThis.location;
    delete globalThis.sessionStorage;
  });
  const auth = {
    identity: { principal: crypto.randomUUID(), displayName: "Kyle", driver: "Browser" },
    canWrite: true,
  };
  let release;
  const state = {
    recordStorage: "automerge",
    documentId: undefined,
    commentsDocumentId: undefined,
    discovered: new Promise((resolve) => (release = resolve)),
    connects: 0,
  };
  const receipts = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.startsWith("/api/connect?")) {
      state.connects++;
      await state.discovered;
      return Response.json({
        page_id: state.pageId,
        identity: auth.identity,
        documentId: state.documentId,
        commentsDocumentId: state.commentsDocumentId,
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
        ...(state.recordStorage && { recordStorage: state.recordStorage }),
      });
    }
    assert.ok(url.startsWith("/api/saved?"), `unexpected request: ${url}`);
    const body = JSON.parse(options.body);
    receipts.push(body);
    return Response.json({ durableHeads: body.heads, durableCommentHeads: body.comment_heads });
  });
  return { auth, state, receipts, sockets, release: () => release() };
}

/** A Page this browser cached from a Subduction host: a native local copy,
 * registered and acknowledged, with its comments document. */
async function cachedNativePage(h) {
  const pageId = (h.state.pageId = crypto.randomUUID());
  h.state.documentId = interpretAsDocumentId(generateAutomergeUrl());
  const commentsUuid = crypto.randomUUID();
  h.state.commentsDocumentId = interpretAsDocumentId(generateAutomergeUrl());
  const doc = A.change(
    A.change(
      A.from(createPageData({ pageId, title: "Converted" }), { actor: "ab".repeat(16) }),
      initializePage,
    ),
    (page) => {
      page.schema = { features: ["comments-doc"] };
    },
  );
  await writeLocalPage(h.auth.identity, {
    principal: h.auth.identity.principal,
    page_id: pageId,
    document_id: h.state.documentId,
    title: doc.title,
    snapshot: encodeSnapshot(A.save(doc)),
    comments_snapshot: encodeSnapshot(A.save(commentsGenesis(commentsUuid))),
    comments_document_id: h.state.commentsDocumentId,
    canWrite: true,
    access: {
      role: "owner",
      generation: 0,
      revision: 0,
      canRead: true,
      canWrite: true,
      canComment: true,
    },
    registered: true,
    pending: false,
  });
  return pageId;
}

/** The viewer's wiring (main.jsx install): each installed session's
 * adoption reopens it through the host. `problems` collects every banner a
 * session showed; `errors` what the host reported. */
function viewer(h, host) {
  const problems = [];
  const errors = [];
  const reopens = [];
  const watch = (session) => {
    session.subscribe(() => {
      if (session.problem) problems.push(session.problem);
      if (host.current === session && session.storageAdopted && session.reopenInPlace)
        reopens.push(host.reopenStorage(session, { install, onError: (e) => errors.push(e) }));
    });
  };
  async function install(next, generation) {
    if (!host.install(next, generation, h.auth.identity.principal)) {
      await next.close();
      return false;
    }
    watch(next);
    return true;
  }
  async function open(pageId) {
    const session = await PageSession.open(pageId, {
      authentication: h.auth,
      refreshSession: async () => h.auth,
      reopenInPlace: true,
    });
    await install(session, host.navigate());
    return session;
  }
  return { open, problems, errors, settled: () => Promise.all(reopens) };
}

/** A native session of a converted Page, installed, with an edit and a
 * comment typed before discovery answers. */
async function nativeWithEdits(t) {
  const h = tab(t);
  const host = new SessionHost();
  t.after(() =>
    Promise.allSettled(host.store.snapshot().owned.map(({ session }) => session.close())),
  );
  const pageId = await cachedNativePage(h);
  const ui = viewer(h, host);
  const first = await ui.open(pageId);
  assert.equal(first.recordStorage, "native");
  await until(() => first.commentsDoc && first.canComment, "the cached comments document");
  await first.change((doc) => A.updateText(doc, ["title"], "Typed before discovery"));
  const blockId = Object.keys(first.doc.blocks)[0];
  await first.comment({ action: "add", block_id: blockId, body: "Commented before discovery" });
  clearTimeout(first.savedTimer);
  return { h, host, ui, first, pageId };
}

test("a native replica of a converted Page reopens in place on plain sync, and its edits are acknowledged", async (t) => {
  const { h, host, ui, first, pageId } = await nativeWithEdits(t);
  h.release();
  await until(() => host.current && host.current !== first, "the replacement session");
  await ui.settled();
  const next = host.current;
  assert.equal(first.alive, false, "the native session closed");
  assert.deepEqual(ui.errors, []);
  assert.ok(
    !ui.problems.includes(STORAGE_ADOPTED),
    `no reload banner: ${JSON.stringify(ui.problems)}`,
  );
  assert.equal(next.pageId, pageId);
  assert.equal(next.recordStorage, "automerge");
  assert.equal(next.handle.documentId, h.state.documentId);
  assert.equal(next.doc.title, "Typed before discovery");
  // The comments document restored from the checkpoint into the plain replica.
  await until(() => next.commentsDoc, "the restored comments document");
  const threads = Object.values(next.commentsDoc.threads);
  assert.equal(threads.length, 1);
  assert.equal(
    String(Object.values(threads[0].messages)[0].richText),
    "Commented before discovery",
  );
  // The plain socket opened, and the unacknowledged edits went out with a
  // receipt for both documents.
  await until(() => h.sockets.some((s) => s.url.includes("sender=")), "a plain sync socket");
  const heads = A.getHeads(next.doc);
  const commentHeads = A.getHeads(next.commentsDoc);
  await until(
    () => h.receipts.some((r) => heads.every((head) => r.heads.includes(head))),
    "a receipt for the edit",
  );
  await until(() => !next.recoveryPending, "the acknowledgement");
  assert.deepEqual(next.savedCommentHeads, commentHeads);
  const stored = await readLocalPage(h.auth.identity, pageId);
  assert.equal(stored.recordStorage, "automerge");
  assert.equal(A.load(decodeSnapshot(stored.snapshot)).title, "Typed before discovery");
  const databases = (await indexedDB.databases()).map(({ name }) => name);
  assert.ok(
    databases.some((name) => name.startsWith("pages-plain-")),
    "a plain replica",
  );
  // The person keeps editing in the same tab.
  assert.equal(next.canWrite, true);
  await next.change((doc) => A.updateText(doc, ["title"], "Typed after the reopen"));
  assert.equal(next.doc.title, "Typed after the reopen");
  assert.equal(next.problem, "");
  assert.deepEqual(
    host.store.snapshot().owned.map(({ session, held }) => [session === next, held]),
    [[true, true]],
    "only the replacement holds a replica",
  );
});

test("while the reopen runs, edits are held with a reopening notice", async (t) => {
  const { h, host, ui, first } = await nativeWithEdits(t);
  // Hold the close at its start, so the adopted session is still installed.
  const close = first.close.bind(first);
  let finish;
  const held = new Promise((resolve) => (finish = resolve));
  t.mock.method(first, "close", async () => {
    await held;
    return close();
  });
  h.release();
  await until(() => first.storageAdopted, "the adoption");
  assert.equal(first.canWrite, false);
  assert.throws(() => first.change((doc) => A.updateText(doc, ["title"], "Too soon")), {
    message: STORAGE_REOPENING,
  });
  assert.equal(first.problem, "");
  finish();
  await until(() => host.current && host.current !== first, "the replacement session");
  await ui.settled();
  assert.equal(host.current.canWrite, true);
});

test("a second adoption after a reopen asks for a reload instead of looping", async (t) => {
  const { h, host, ui, first } = await nativeWithEdits(t);
  h.release();
  await until(() => host.current && host.current !== first, "the replacement session");
  await ui.settled();
  const next = host.current;
  await until(() => h.sockets.some((s) => s.url.includes("sender=")), "a plain sync socket");
  // The host's answer flips back: the replacement adopts again.
  h.state.recordStorage = undefined;
  await next.retryConnection();
  await ui.settled();
  assert.equal(host.current, next, "no second reopen");
  assert.equal(next.alive, true);
  assert.equal(next.problem, STORAGE_ADOPTED);
  assert.equal(next.retryTimer, undefined, "nothing reconnects");
  assert.throws(() => next.change((doc) => A.updateText(doc, ["title"], "Loop")), {
    message: STORAGE_ADOPTED,
  });
});

test("a failed reopen keeps the reload banner, and the checkpoint stays on the device", async (t) => {
  await t.test("the replacement can't open", async (t) => {
    const { h, host, ui, first, pageId } = await nativeWithEdits(t);
    t.mock.method(PageSession, "open", async () => {
      throw Error("simulated IndexedDB failure");
    });
    h.release();
    await until(() => ui.errors.length > 0, "the host's report");
    await ui.settled();
    assert.equal(host.current, first, "the closed session stays installed");
    assert.equal(first.alive, false);
    assert.equal(ui.errors.length, 1);
    assert.equal(ui.errors[0].message, STORAGE_ADOPTED);
    assert.equal(ui.errors[0].code, "RECORD_STORAGE_CHANGED");
    const stored = await readLocalPage(h.auth.identity, pageId);
    assert.equal(stored.recordStorage, "automerge");
    assert.equal(A.load(decodeSnapshot(stored.snapshot)).title, "Typed before discovery");
  });
  await t.test("the adopted session can't be torn down", async (t) => {
    const { h, host, ui, first } = await nativeWithEdits(t);
    t.mock.method(first, "close", async () => {
      throw Error("simulated close failure");
    });
    h.release();
    await until(() => first.problem === STORAGE_ADOPTED, "the reload banner");
    await ui.settled();
    assert.equal(host.current, first);
    assert.equal(first.alive, true);
    assert.deepEqual(ui.errors, []);
    assert.deepEqual(
      host.store.snapshot().owned.map(({ session, held }) => [session === first, held]),
      [[true, true]],
      "the session still holds its replica",
    );
    assert.throws(() => first.change((doc) => A.updateText(doc, ["title"], "Held")), {
      message: STORAGE_ADOPTED,
    });
    first.close.mock.restore();
  });
});
