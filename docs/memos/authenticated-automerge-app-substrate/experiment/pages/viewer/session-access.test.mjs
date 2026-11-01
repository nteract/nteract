import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { PageSession } from "./session.mjs";
import { SessionHost } from "./session-host.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { applyComment } from "../model/comments.mjs";
import {
  decodeSnapshot,
  encodeSnapshot,
  readLocalPage,
  writeLocalPage,
  prepareLocalPageReload,
  listLocalRecoveries,
} from "./local-pages.mjs";

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
  identity: { principal: crypto.randomUUID(), displayName: "Writer" },
  canWrite: true,
});
function fixture() {
  const auth = authentication(),
    pageId = crypto.randomUUID();
  const doc = A.change(
    A.from(createPageData({ pageId, title: "Unsynced local draft" })),
    initializePage,
  );
  const session = new PageSession(pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  session.acceptAuthentication(auth);
  session.access = access();
  session.replicaKey = "1:writer";
  session.updateCapabilities();
  session.handle = { doc: () => doc };
  session.repo = { flush: async () => {} };
  session.localPage = {
    principal: auth.identity.principal,
    page_id: pageId,
    document_id: crypto.randomUUID(),
    snapshot: encodeSnapshot(A.save(doc)),
    title: doc.title,
    registered: true,
    pending: true,
    access: session.access,
    replicaKey: session.replicaKey,
  };
  return { session, auth, doc };
}

test("credential renewal cannot promote a page viewer or restore an explicitly denied grant", async (t) => {
  const { session, auth } = fixture();
  t.after(() => session.close());
  session.access = access("viewer");
  await session.refreshAuthentication();
  assert.equal(session.canWrite, false);
  assert.equal(session.canComment, false);
  assert.equal(session.canManageAccess, false);
  session.pauseForAccess("Removed", { denied: true });
  await session.refreshAuthentication();
  assert.equal(session.access.role, "none");
  assert.equal(session.accessDenied, true);
  assert.equal(session.canWrite, false);
  assert.equal(session.authRequired, false);
  assert.equal(session.status, "Access removed");
  assert.equal(session.statusKey, "attention");
  assert.equal(session.identity.principal, auth.identity.principal);
});

test("a forbidden connection keeps the draft and closes its transport without sign-in or retries", async (t) => {
  const { session, doc } = fixture();
  let disconnected = 0;
  session.sockets.add({ close: () => disconnected++ });
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Page is private" }, { status: 403 }),
  );
  t.after(() => session.close());
  await session.retryConnection();
  await session.cacheTail;
  session.scheduleReconnect();
  assert.equal(session.accessDenied, true);
  assert.equal(session.authRequired, false);
  assert.equal(session.canWrite, false);
  assert.equal(session.retryTimer, undefined);
  assert.equal(disconnected, 1);
  assert.equal(session.doc, doc);
  const checkpoint = await readLocalPage(session.identity, session.pageId);
  assert.equal(A.load(decodeSnapshot(checkpoint.snapshot)).title, doc.title);
  assert.equal(checkpoint.access.role, "none");
  assert.match(session.exportRecovery().markdown, /Unsynced local draft/);
});

test("the recovery Markdown lists comments and replies the host never acknowledged", () => {
  const { session } = fixture();
  let doc = session.doc;
  const blockId = Object.keys(doc.blocks)[0];
  const author = { principal: session.identity.principal, displayName: "Writer" };
  const comment = (input) => {
    let result;
    doc = A.change(doc, (d) => {
      result = applyComment(d, input, author);
    });
    session.handle = { doc: () => doc };
    return result;
  };
  const sent = comment({ block_id: blockId, body: "Already on the server" });
  session.savedHeads = A.getHeads(doc);
  comment({ action: "reply", thread_id: sent.thread_id, body: "Reply typed offline" });
  comment({ block_id: blockId, body: "New thread typed offline" });
  const { markdown, heads } = session.exportRecovery();
  assert.deepEqual(heads, A.getHeads(doc));
  const [body, unsent] = markdown.split("\n---\n");
  assert.match(body, /^# Unsynced local draft/);
  assert.match(unsent, /## Unsent comments/);
  assert.match(unsent, /\*\*Writer\*\* · reply · .*\n\n> Reply typed offline/);
  assert.match(unsent, /\*\*Writer\*\* · comment · .*\n\n> New thread typed offline/);
  assert.doesNotMatch(unsent, /Already on the server/, "acknowledged comments are not repeated");
  // Once the host acknowledges everything, the section disappears.
  session.savedHeads = A.getHeads(doc);
  assert.doesNotMatch(session.exportRecovery().markdown, /Unsent comments/);
});

test("a Page in its owner's Trash keeps the local copy instead of forgetting it", async (t) => {
  const { session, doc } = fixture();
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: "This Page is in its owner's Trash", code: "page_trashed" },
      { status: 403 },
    ),
  );
  t.after(() => session.close());
  await session.retryConnection();
  await session.cacheTail;
  assert.equal(session.deleted, false);
  assert.equal(session.accessDenied, true);
  assert.match(session.accessProblem, /owner's Trash/);
  const checkpoint = await readLocalPage(session.identity, session.pageId);
  assert.equal(A.load(decodeSnapshot(checkpoint.snapshot)).title, doc.title);
});

test("a trashed owner previews on a reader replica and restore reloads without a draft", async (t) => {
  const { session } = fixture();
  t.after(() => session.close());
  const trashed = {
    ...access("owner"),
    canWrite: false,
    canComment: false,
    canManageAccess: false,
    canDelete: false,
    canRestore: true,
    trashed: true,
  };
  // An open writer replica pauses with a Trash-specific message.
  await assert.rejects(session.acceptPageAccess(trashed), { code: "PAGE_ACCESS_CHANGED" });
  assert.match(session.accessProblem, /moved to Trash/);
  // The preview replica is a reader replica; its key never authors history.
  session.replicaKey = "1:reader";
  session.localPage.pending = true;
  session.phase$.update(() => ({ name: "open" }));
  await assert.rejects(session.acceptPageAccess(access("owner")), { code: "PAGE_ACCESS_CHANGED" });
  assert.equal(session.accessReloadRequired, true);
  assert.equal(session.recoveryPending, false);
});

test("changed grant generation freezes both clean and dirty old replicas before native connection", async (t) => {
  for (const pending of [false, true]) {
    await t.test(String(pending), async (t) => {
      const { session, doc } = fixture();
      session.localPage.pending = pending;
      if (!pending) session.savedHeads = A.getHeads(doc);
      t.after(() => session.close());
      await assert.rejects(session.acceptPageAccess(access("viewer", 2, 2)), {
        code: "PAGE_ACCESS_CHANGED",
      });
      assert.equal(session.replicaKey, "1:writer");
      assert.equal(session.access.generation, 2);
      assert.equal(session.accessReloadRequired, true);
      assert.equal(session.canWrite, false);
      assert.equal(session.recoveryPending, pending);
      assert.equal(session.exportRecovery().snapshot, encodeSnapshot(A.save(doc)));
      session.scheduleReconnect();
      assert.equal(session.retryTimer, undefined);
    });
  }
});

test("an unrelated collaborator's revision does not retire this principal's key", async (t) => {
  const { session } = fixture();
  t.after(() => session.close());
  await session.acceptPageAccess(access("editor", 1, 5));
  assert.equal(session.accessReloadRequired, false);
  assert.equal(session.replicaKey, "1:writer");
  assert.equal(session.canWrite, true);
});

test("a reader-admitted key cannot be promoted when the credential ceiling rises", async (t) => {
  const { session, auth } = fixture();
  t.after(() => session.close());
  session.replicaKey = "1:reader";
  session.acceptAuthentication({ ...auth, canWrite: false });
  assert.equal(session.canWrite, false);
  session.acceptAuthentication(auth);
  assert.equal(session.canWrite, false, "credential renewal cannot enable a reader-admitted key");
  await assert.rejects(session.acceptPageAccess(access()), { code: "PAGE_ACCESS_CHANGED" });
  assert.equal(session.accessReloadRequired, true);
  assert.equal(session.canWrite, false);
});

test("first remote opening chooses the authoritative generation before creating history", async () => {
  const auth = authentication(),
    session = new PageSession("remote");
  session.acceptAuthentication(auth);
  session.replicaKey = "0:reader";
  const events = [];
  session.releaseLocal = async () => events.push("release");
  session.initializeLocal = async (key) => {
    events.push(key);
    session.replicaKey = key;
  };
  await session.acceptPageAccess(access("editor", 4, 8));
  assert.deepEqual(events, ["release", "4:writer"]);
  assert.equal(session.canWrite, true);
  assert.equal(session.accessReloadRequired, false);
});

test("explicit reload archives dirty history and opens a server-only replacement", async (t) => {
  const { session, auth, doc } = fixture();
  await writeLocalPage(auth.identity, session.localPage);
  await assert.rejects(session.acceptPageAccess(access("viewer", 2, 2)), {
    code: "PAGE_ACCESS_CHANGED",
  });
  const replacement = {};
  t.mock.method(PageSession, "open", async (pageId, options) => {
    assert.equal(pageId, session.pageId);
    assert.equal(options.authentication.identity.principal, auth.identity.principal);
    const checkpoint = await readLocalPage(auth.identity, pageId);
    assert.equal(checkpoint.resetReplica, true);
    assert.equal(checkpoint.replicaKey, "2:reader");
    assert.equal(
      checkpoint.snapshot,
      undefined,
      "replacement must fetch current authorized history",
    );
    return replacement;
  });
  assert.equal(await session.reloadForAccess(), replacement);
  const recoveries = await listLocalRecoveries(auth.identity, session.pageId);
  assert.ok(recoveries.some((entry) => A.load(decodeSnapshot(entry.snapshot)).title === doc.title));
  assert.deepEqual(await listLocalRecoveries(authentication().identity, session.pageId), []);
  assert.equal(session.alive, false);
});

test("retired tabs cannot merge old history into a replacement grant's checkpoint", async () => {
  const { session, auth } = fixture();
  const stale = session.localPage;
  await writeLocalPage(auth.identity, stale);
  await prepareLocalPageReload(auth.identity, stale, access("editor", 3, 3), "3:writer");
  const serverDoc = A.from({ page_id: session.pageId, title: "Current server version" });
  const current = await readLocalPage(auth.identity, session.pageId);
  await writeLocalPage(auth.identity, {
    ...current,
    resetReplica: false,
    snapshot: encodeSnapshot(A.save(serverDoc)),
  });
  await assert.rejects(writeLocalPage(auth.identity, stale), { code: "LOCAL_PAGE_ACCESS_CHANGED" });
  const result = await readLocalPage(auth.identity, session.pageId);
  assert.equal(A.load(decodeSnapshot(result.snapshot)).title, "Current server version");
  assert.ok(
    (await listLocalRecoveries(auth.identity, session.pageId)).some(
      (entry) => entry.snapshot === stale.snapshot,
    ),
  );
});

test("an older cache write cannot resurrect a revoked access fact", async () => {
  const { session, auth } = fixture();
  const stale = session.localPage;
  await writeLocalPage(auth.identity, stale);
  await writeLocalPage(auth.identity, { ...stale, access: access("none", 2, 2), canWrite: false });
  const written = await writeLocalPage(auth.identity, stale);
  assert.equal(written.access.role, "none");
  assert.equal(written.canWrite, false);
});

test("late closes from intentionally retired sockets cannot reconnect their replacement", async (t) => {
  const session = new PageSession("socket-lifecycle");
  let attempts = 0,
    closes = 0;
  t.mock.method(session, "scheduleReconnect", () => attempts++);
  const previous = { close: () => closes++ },
    current = { close: () => closes++ };
  session.sockets.add(previous);
  await session.disconnectSockets();
  session.sockets.add(current);
  session.status = "Connected";
  session.socketDisconnected(previous);
  assert.equal(closes, 1);
  assert.equal(attempts, 0);
  assert.equal(session.status, "Connected");
  assert.deepEqual([...session.sockets], [current]);
  session.socketDisconnected(current);
  assert.equal(attempts, 1);
  assert.equal(session.sockets.size, 0, "natural closure releases the retained browser socket");
  assert.equal(session.status, "Reconnecting");
  session.socketDisconnected(current);
  assert.equal(attempts, 1, "duplicate closure is inert");
});

test("a failed replacement open can retry without a closed backend or duplicate archival", async (t) => {
  const { session, auth, doc } = fixture();
  await writeLocalPage(auth.identity, session.localPage);
  await assert.rejects(session.acceptPageAccess(access("viewer", 2, 2)), {
    code: "PAGE_ACCESS_CHANGED",
  });
  let opens = 0,
    flushes = 0;
  session.repo.flush = async () => flushes++;
  const replacement = {};
  t.mock.method(PageSession, "open", async () => {
    if (++opens === 1) throw Error("Offline while opening");
    return replacement;
  });
  await assert.rejects(session.reloadForAccess(), /Offline while opening/);
  assert.equal(session.alive, false);
  assert.equal(session.repo, undefined);
  assert.equal(session.exportRecovery().title, doc.title, "closed draft remains downloadable");
  const archived = await session.listRecoveries();
  assert.equal(archived.length, 1);
  assert.equal(await session.reloadForAccess(), replacement);
  assert.equal(opens, 2);
  assert.equal(flushes, 1, "retry must not drain the already-closed backend");
  assert.equal((await session.listRecoveries()).length, 1, "retry must not duplicate archival");
});

test("a failed replacement open keeps Reload current Page and retries without archiving again", async (t) => {
  const { session, auth } = fixture();
  await writeLocalPage(auth.identity, session.localPage);
  await assert.rejects(session.acceptPageAccess(access("viewer", 2, 2)), {
    code: "PAGE_ACCESS_CHANGED",
  });
  const host = new SessionHost();
  assert.ok(host.install(session, host.generation, auth.identity.principal));
  let opens = 0,
    flushes = 0;
  session.repo.flush = async () => flushes++;
  const replacement = { identity: auth.identity, pageId: session.pageId };
  t.mock.method(PageSession, "open", async () => {
    if (++opens === 1) throw Error("Offline while opening");
    return replacement;
  });
  const errors = [];
  const options = {
    install: async (next, generation) => host.install(next, generation, auth.identity.principal),
    onError: (error) => errors.push(error.message),
  };
  await host.reloadAccess(session, options);
  assert.deepEqual(errors, ["Offline while opening"]);
  assert.equal(host.current, session, "the archived session stays installed");
  assert.deepEqual(session.phase$.snapshot(), {
    name: "closed",
    checkpointWritten: true,
    drained: false,
    archived: true,
  });
  assert.equal(session.accessReloadRequired, true, "Reload current Page stays offered");
  await host.reloadAccess(session, options);
  assert.equal(host.current, replacement);
  assert.equal(opens, 2);
  assert.equal(flushes, 1, "the retry does not archive again");
  assert.equal((await session.listRecoveries()).length, 1);
});

test("the latest archived draft is selected chronologically rather than by its random key", async (t) => {
  const { session, auth, doc } = fixture();
  const stale = session.localPage;
  await writeLocalPage(auth.identity, stale);
  let nonce = 99;
  t.mock.method(crypto, "randomUUID", () => String(nonce--).padStart(36, "0"));
  await prepareLocalPageReload(auth.identity, stale, access("viewer", 2, 2), "2:reader");
  const latest = A.change(doc, (draft) => {
    draft.title = "Latest retired draft";
  });
  await assert.rejects(
    writeLocalPage(auth.identity, { ...stale, snapshot: encodeSnapshot(A.save(latest)) }),
    { code: "LOCAL_PAGE_ACCESS_CHANGED" },
  );
  const records = await session.listRecoveries();
  assert.deepEqual(
    records.map((record) => record.recovery_sequence),
    [1, 2],
  );
  assert.equal(session.exportRecovery(records.at(-1)).title, "Latest retired draft");
  assert.ok(records.every((record) => Number.isFinite(Date.parse(record.archived_at))));
});

test("another grant change during replacement opening advances the empty reset cache before import", async (t) => {
  const { session, auth } = fixture();
  await writeLocalPage(auth.identity, session.localPage);
  session.localPage = await prepareLocalPageReload(
    auth.identity,
    session.localPage,
    access("viewer", 2, 2),
    "2:reader",
  );
  session.handle = undefined;
  session.replicaKey = "2:reader";
  const events = [];
  t.mock.method(session, "releaseLocal", async () => events.push("release"));
  t.mock.method(session, "initializeLocal", async (key) => {
    session.replicaKey = key;
    events.push(key);
  });
  await session.acceptPageAccess(access("editor", 3, 3));
  assert.deepEqual(events, ["release", "3:writer"]);
  assert.equal(session.accessReloadRequired, false);
  assert.equal(session.localPage.resetReplica, true);
  assert.equal(session.localPage.replicaKey, "3:writer");
  assert.equal(session.localPage.snapshot, undefined);
  const fresh = A.from({ page_id: session.pageId, title: "Fetched after the latest grant" });
  await writeLocalPage(auth.identity, {
    ...session.localPage,
    resetReplica: false,
    snapshot: encodeSnapshot(A.save(fresh)),
  });
  const checkpoint = await readLocalPage(auth.identity, session.pageId);
  assert.equal(A.load(decodeSnapshot(checkpoint.snapshot)).title, fresh.title);
  assert.equal(checkpoint.replicaKey, "3:writer");
  assert.equal(
    (await session.listRecoveries()).length,
    1,
    "empty reset checkpoints need no archive",
  );
});

test("trusted profile rosters replace stale peers and untrusted rosters cannot", async (t) => {
  const { session } = fixture();
  t.after(() => session.close());
  session.connection = { serverSenderId: "server" };
  session.profiles = { removed: { displayName: "Removed" }, active: { displayName: "Active" } };
  session.peers.set("removed", { displayName: "Removed" });
  session.peers.set("active", { displayName: "Active" });
  let notified = 0;
  session.watchPresence(() => notified++);
  session.ephemeral({
    senderId: "impostor",
    message: { kind: "identity-profiles", peerProfiles: {} },
  });
  assert.equal(session.peers.size, 2);
  session.ephemeral({
    senderId: "server",
    message: { kind: "identity-profiles", peerProfiles: { active: { displayName: "Active" } } },
  });
  assert.equal(session.peers.has("removed"), false);
  assert.equal(session.profiles.removed, undefined);
  assert.equal(session.peers.has("active"), true);
  assert.equal(notified, 1);
});

test("reopening a denied local copy checks once and stays read-only while authorization is unresolved", async (t) => {
  const { session, doc } = fixture();
  session.pauseForAccess("Removed", { denied: true });
  await session.cacheTail;
  let requests = 0,
    finish;
  t.mock.method(globalThis, "fetch", async (url) => {
    requests++;
    assert.equal(url, `/api/connect?page=${session.pageId}`);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  t.after(() => session.close());
  const reconnect = session.retryConnection({ recheckDeniedAccess: true });
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.accessDenied, true);
  assert.equal(session.canWrite, false);
  assert.equal(session.doc, doc);
  finish(Response.json({ error: "Still private" }, { status: 403 }));
  await reconnect;
  await session.cacheTail;
  assert.equal(session.accessDenied, true);
  assert.equal(session.canWrite, false);
  assert.equal(session.retryTimer, undefined);
  await session.retryConnection();
  session.scheduleReconnect();
  assert.equal(requests, 1, "ordinary reconnect must not poll a denied Page");
  assert.equal(session.retryTimer, undefined);
  assert.equal(session.exportRecovery().title, doc.title);
});

test("restored access with a new generation cannot publish the denied copy's unsynced history", async (t) => {
  const { session, auth, doc } = fixture();
  session.pauseForAccess("Removed", { denied: true });
  await session.cacheTail;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({
      identity: auth.identity,
      documentId: session.localPage.document_id,
      access: access("editor", 3, 4),
    });
  });
  t.after(() => session.close());
  await session.retryConnection({ recheckDeniedAccess: true });
  assert.equal(requests, 1);
  assert.equal(session.accessDenied, false);
  assert.equal(session.accessReloadRequired, true);
  assert.equal(session.canWrite, false);
  assert.equal(session.replicaKey, "1:writer");
  assert.equal(session.doc, doc);
  assert.equal(session.retryTimer, undefined);
  assert.equal(session.connection, undefined);
  assert.equal(session.exportRecovery().title, doc.title);
});
