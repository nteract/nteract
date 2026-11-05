import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { PageSession, classifyRefusal } from "./session.mjs";
import { projectGrantGeneration } from "../shared/grant-generation.mjs";
import { SessionHost } from "./session-host.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { applyComment } from "../model/comments.mjs";
import { newCommentsDoc } from "../model/comments-test-support.mjs";
import {
  decodeSnapshot,
  encodeSnapshot,
  readLocalPage,
  writeLocalPage,
  prepareLocalPageReload,
  retireLocalPage,
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
  const doc = session.doc;
  let comments = newCommentsDoc();
  const blockId = Object.keys(doc.blocks)[0];
  const author = { principal: session.identity.principal, displayName: "Writer" };
  // Comments live in the comments document, acknowledged by their own heads.
  session.commentsHandle = { doc: () => comments };
  const comment = (input) => {
    let result;
    comments = A.change(comments, (d) => {
      result = applyComment(d, input, author, undefined, { page: doc, role: "owner" });
    });
    return result;
  };
  const sent = comment({ block_id: blockId, body: "Already on the server" });
  session.savedHeads = A.getHeads(doc);
  session.savedCommentHeads = A.getHeads(comments);
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
  session.savedCommentHeads = A.getHeads(comments);
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

test("commenter promotion waits for the receipt frontier or preserves recovery until explicit reload", async (t) => {
  for (const acknowledged of [false, true]) {
    await t.test(acknowledged ? "applied receipt" : "held receipt", async (t) => {
      const { session, auth, doc } = fixture();
      t.after(() => session.close());
      session.phase$.update(() => ({ name: "open" }));
      session.access = { ...access("commenter"), canComment: true };
      session.replicaKey = "1:commenter";
      session.localPage = {
        ...session.localPage,
        access: session.access,
        replicaKey: session.replicaKey,
        pending: false,
      };
      session.savedHeads = A.getHeads(doc);
      const genesis = newCommentsDoc();
      session.savedCommentHeads = A.getHeads(genesis);
      const comments = A.change(A.clone(genesis), (draft) =>
        applyComment(
          draft,
          { block_id: Object.keys(doc.blocks)[0], body: "Accepted remote reply awaiting receipt" },
          { principal: "remote-author", displayName: "Remote author" },
          undefined,
          { page: doc, role: "owner" },
        ),
      );
      session.commentsHandle = { doc: () => comments, documentId: crypto.randomUUID() };
      assert.equal(session.localPage.pending, false);
      assert.equal(session.recoveryPending, true, "remote heads alone can precede their receipt");
      await writeLocalPage(auth.identity, session.localPage);
      const receipt = Promise.withResolvers();
      const requested = Promise.withResolvers();
      session.connection = {};
      t.mock.method(session, "requestWithRenewal", async (url, options) => {
        assert.equal(url, `/api/saved?page=${session.pageId}`);
        assert.deepEqual(JSON.parse(options.body).comment_heads, A.getHeads(comments));
        requested.resolve();
        return receipt.promise;
      });
      const saving = session.saveReceipt();
      await requested.promise;
      if (acknowledged) {
        receipt.resolve({ durableHeads: A.getHeads(doc) });
        await saving;
        assert.equal(session.localPage.pending, false);
        assert.deepEqual(session.savedCommentHeads, A.getHeads(comments));
      }
      await assert.rejects(session.acceptPageAccess(access("editor", 2, 2)), {
        code: "PAGE_ACCESS_CHANGED",
      });
      await session.cacheTail;
      assert.equal(session.recoveryPending, !acknowledged);
      assert.equal(session.accessReloadRequired, true);
      assert.equal(session.canWrite, false, "the old commenter key never becomes a writer");
      assert.equal(session.replicaKey, "1:commenter");
      assert.equal(session.access.role, "editor");
      assert.equal(session.accessReloadRequired && !session.recoveryPending, acknowledged);
      assert.equal((await session.listRecoveries()).length, 0, "promotion discards no history");
      if (!acknowledged) {
        receipt.resolve({ durableHeads: A.getHeads(doc) });
        await saving;
        assert.deepEqual(
          session.savedCommentHeads,
          A.getHeads(genesis),
          "late receipt cannot clear the access pause",
        );
        assert.equal(session.recoveryPending, true);
        assert.match(session.exportRecovery().markdown, /Accepted remote reply awaiting receipt/);
        const replacement = {};
        t.mock.method(PageSession, "open", async () => replacement);
        assert.equal(await session.reloadForAccess(), replacement);
        const recoveries = await session.listRecoveries();
        assert.ok(recoveries.length);
        assert.ok(
          recoveries.some((entry) =>
            /Accepted remote reply awaiting receipt/.test(session.exportRecovery(entry).markdown),
          ),
        );
        const local = await readLocalPage(auth.identity, session.pageId);
        assert.equal(local.replicaKey, "2:writer");
        assert.equal(local.resetReplica, true);
        assert.equal(local.snapshot, undefined, "replacement cannot import the retired history");
      }
    });
  }
});

test("inherited editor, commenter and viewer answers use validated host grant identities", async (t) => {
  for (const role of ["editor", "commenter", "viewer"]) {
    const { session } = fixture();
    t.after(() => session.close());
    session.handle = null;
    const token = projectGrantGeneration("prj_00000000-0000-4000-8000-000000000001", 1, 0);
    session.replicaKey = `${token}:${role === "editor" ? "writer" : role === "commenter" ? "commenter" : "reader"}`;
    await session.acceptPageAccess({ ...access(role, token, 0), canComment: role !== "viewer" });
    assert.equal(session.access.generation, token);
    assert.equal(
      session.replicaKey,
      `${token}:${role === "editor" ? "writer" : role === "commenter" ? "commenter" : "reader"}`,
    );
    assert.equal(session.canWrite, role === "editor");
    for (const malformed of ["project:prj_invalid:1:0", token + ":extra", "1"])
      await assert.rejects(
        session.acceptPageAccess(access(role, malformed, 0)),
        /Invalid Page access/,
      );
  }
});

test("Project checkpoint replacement and stale retirement never order unrelated grant sources", async (t) => {
  const project = "prj_00000000-0000-4000-8000-000000000001";
  const other = "prj_00000000-0000-4000-8000-000000000002";
  const token = projectGrantGeneration(project, 2, 1);
  for (const staleGeneration of [
    1,
    projectGrantGeneration(project, 1, 1),
    projectGrantGeneration(other, 99, 99),
  ]) {
    const { session, auth } = fixture();
    t.after(() => session.close());
    const stale = {
      ...session.localPage,
      access: access("editor", staleGeneration, 0),
      replicaKey: `${staleGeneration}:writer`,
    };
    await writeLocalPage(auth.identity, stale);
    await prepareLocalPageReload(
      auth.identity,
      stale,
      access("editor", token, 0),
      `${token}:writer`,
    );
    await assert.rejects(
      prepareLocalPageReload(
        auth.identity,
        stale,
        access("editor", staleGeneration, 0),
        stale.replicaKey,
      ),
      { code: "LOCAL_PAGE_ACCESS_CHANGED" },
    );
    await assert.rejects(writeLocalPage(auth.identity, stale), {
      code: "LOCAL_PAGE_ACCESS_CHANGED",
    });
    const retired = await retireLocalPage(auth.identity, session.pageId, {
      reason: "access",
      grant: stale.replicaKey,
      revision: 0,
      snapshot: stale.snapshot,
    });
    assert.equal(retired.superseded, true);
    const current = await readLocalPage(auth.identity, session.pageId);
    assert.equal(current.replicaKey, `${token}:writer`);
    assert.equal(current.snapshot, undefined);
    assert.ok((await session.listRecoveries()).length);
    await assert.rejects(
      prepareLocalPageReload(
        auth.identity,
        current,
        access("editor", projectGrantGeneration(project, 1, 1), 0),
        `${projectGrantGeneration(project, 1, 1)}:writer`,
      ),
      { code: "LOCAL_PAGE_ACCESS_CHANGED" },
    );
  }
});

test("direct to inherited to direct reloads archive each source and isolate late checkpoint writes", async (t) => {
  const { session, auth, doc } = fixture();
  t.after(() => session.close());
  const token = projectGrantGeneration("prj_00000000-0000-4000-8000-000000000001", 2, 1);
  let current = await writeLocalPage(auth.identity, session.localPage);
  for (const [generation, title] of [
    [token, "Inherited server content"],
    [1, "Direct server content"],
  ]) {
    const observed = current;
    const before = await listLocalRecoveries(auth.identity, session.pageId);
    const reset = await prepareLocalPageReload(
      auth.identity,
      observed,
      access("editor", generation, 1),
      `${generation}:writer`,
    );
    assert.equal(reset.snapshot, undefined, "reloading never imports the old grant's history");
    assert.equal(reset.resetReplica, true);
    const archived = await listLocalRecoveries(auth.identity, session.pageId);
    assert.equal(archived.length, before.length + 1);
    assert.equal(archived.at(-1).snapshot, observed.snapshot);
    const serverDoc = A.change(A.clone(doc), (draft) => {
      draft.title = title;
    });
    current = await writeLocalPage(auth.identity, {
      ...reset,
      resetReplica: false,
      snapshot: encodeSnapshot(A.save(serverDoc)),
      title,
    });
    const delayedDoc = A.change(A.load(decodeSnapshot(observed.snapshot)), (draft) => {
      draft.title = `Late checkpoint from ${observed.replicaKey}`;
    });
    const delayed = {
      ...observed,
      snapshot: encodeSnapshot(A.save(delayedDoc)),
      title: delayedDoc.title,
      pending: true,
    };
    await assert.rejects(writeLocalPage(auth.identity, delayed), {
      code: "LOCAL_PAGE_ACCESS_CHANGED",
    });
    const preserved = await readLocalPage(auth.identity, session.pageId);
    assert.equal(preserved.replicaKey, `${generation}:writer`);
    assert.equal(
      preserved.snapshot,
      current.snapshot,
      "the retired source cannot merge into the new checkpoint",
    );
    assert.equal(A.load(decodeSnapshot(preserved.snapshot)).title, title);
    const recoveries = await listLocalRecoveries(auth.identity, session.pageId);
    assert.equal(recoveries.length, archived.length + 1);
    assert.equal(recoveries.at(-1).snapshot, delayed.snapshot);
    assert.equal(recoveries.at(-1).replicaKey, observed.replicaKey);
    current = preserved;
  }
  assert.equal(
    current.replicaKey,
    "1:writer",
    "a legitimate direct fallback keeps its shipped generation",
  );
});

test("incomparable Project counters cannot replace or retire the observed checkpoint", async (t) => {
  const project = "prj_00000000-0000-4000-8000-000000000001";
  for (const [stored, incoming] of [
    [2, 1],
    [1, 2],
  ]) {
    const { session, auth } = fixture();
    t.after(() => session.close());
    const generation = projectGrantGeneration(project, stored, incoming);
    const conflicting = projectGrantGeneration(project, incoming, stored);
    const current = await writeLocalPage(auth.identity, {
      ...session.localPage,
      access: access("editor", generation, 1),
      replicaKey: `${generation}:writer`,
    });
    await assert.rejects(
      prepareLocalPageReload(
        auth.identity,
        current,
        access("editor", conflicting, 1),
        `${conflicting}:writer`,
      ),
      { code: "LOCAL_PAGE_ACCESS_CHANGED" },
    );
    assert.deepEqual(await readLocalPage(auth.identity, session.pageId), current);
    assert.equal((await listLocalRecoveries(auth.identity, session.pageId)).length, 0);
    const result = await retireLocalPage(auth.identity, session.pageId, {
      reason: "access",
      grant: `${conflicting}:writer`,
      revision: 1,
      drafts: [{ block_id: "block", body: "Keep the conflicting tab's draft" }],
    });
    assert.equal(result.superseded, true);
    const kept = await readLocalPage(auth.identity, session.pageId);
    assert.equal(kept.snapshot, current.snapshot);
    assert.equal(kept.replicaKey, current.replicaKey);
    assert.equal(kept.revoked, undefined);
    const recovery = (await listLocalRecoveries(auth.identity, session.pageId)).at(-1);
    assert.equal(recovery.comment_drafts[0].body, "Keep the conflicting tab's draft");
  }
});

test("losing read access throws a refusal classified as access", async (t) => {
  const { session } = fixture();
  t.after(() => session.close());
  const error = await session.acceptPageAccess(access("none", 2, 2)).catch((e) => e);
  assert.equal(classifyRefusal(error), "access");
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
  session.statusId = "connected";
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
    assert.equal(url, `/api/connect?page=${session.pageId}&sync=automerge`);
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

test("an offline comment is checkpointed beside the Page, archived, and exported from the archive", async (t) => {
  const { session } = fixture();
  t.after(() => session.close());
  const doc = A.change(session.doc, (draft) => {
    draft.schema = { features: ["comments-doc"] };
  });
  session.handle = { doc: () => doc };
  // Every tab's copy starts from the same deterministic genesis.
  const genesis = newCommentsDoc("c0000000-0000-4000-8000-0000000000bb");
  let comments = A.clone(genesis);
  const commentsId = crypto.randomUUID();
  session.commentsHandle = { doc: () => comments, documentId: commentsId };
  const blockId = Object.keys(doc.blocks)[0];
  comments = A.change(comments, (d) =>
    applyComment(
      d,
      { block_id: blockId, body: "Typed offline, never sent" },
      { principal: session.identity.principal, displayName: "Writer" },
      undefined,
      { page: doc, role: "owner" },
    ),
  );
  // The checkpoint carries both documents, each with its own heads.
  await session.persistLocal({ pending: true });
  await session.cacheTail;
  const stored = await readLocalPage(session.identity, session.pageId);
  assert.equal(stored.comments_document_id, commentsId);
  const checkpoint = A.load(decodeSnapshot(stored.comments_snapshot));
  assert.deepEqual(A.getHeads(checkpoint), A.getHeads(comments));
  // A slower tab's checkpoint without the comment never drops it.
  await writeLocalPage(session.identity, {
    ...stored,
    comments_snapshot: encodeSnapshot(A.save(genesis)),
  });
  const merged = await readLocalPage(session.identity, session.pageId);
  const mergedComments = A.load(decodeSnapshot(merged.comments_snapshot));
  assert.equal(Object.keys(mergedComments.threads).length, 1);
  // A reload archives both; the archive exports the unsent comment.
  await prepareLocalPageReload(session.identity, merged, access("editor", 1, 2), "1:writer");
  const [archived] = await listLocalRecoveries(session.identity, session.pageId);
  assert.ok(archived.comments_snapshot);
  const exported = session.exportRecovery(archived);
  assert.match(exported.markdown, /## Unsent comments/);
  assert.match(exported.markdown, /Typed offline, never sent/);
  assert.ok(exported.comments_snapshot);
});
