import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { PageSession } from "./session.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { newCommentsDoc } from "../model/comments-test-support.mjs";
import { stampFeatures } from "../model/schema-features.mjs";

// PageSession's interpreter for the comments-open machine: lookups with a
// timeout, retries, a visible failure, and restarts on reconnect or replica
// replacement. The machine itself is covered by its table.

const tick = () => new Promise((resolve) => setImmediate(resolve));
const access = {
  role: "commenter",
  generation: 1,
  revision: 1,
  canRead: true,
  canWrite: false,
  canComment: true,
  canManageAccess: false,
  canDelete: false,
};

/** A repo whose `find` calls are held until the test settles them. */
function heldRepo() {
  const calls = [];
  return {
    calls,
    find(id, { signal } = {}) {
      return new Promise((resolve, reject) => {
        const call = { id, signal, resolve, reject };
        calls.push(call);
        signal?.addEventListener("abort", () => reject(signal.reason ?? Error("aborted")));
      });
    },
    flush: async () => {},
  };
}

function fixture(t) {
  const auth = { identity: { principal: crypto.randomUUID(), displayName: "C" }, canWrite: true };
  const pageId = crypto.randomUUID();
  const doc = A.change(A.from(createPageData({ pageId, title: "P" })), (draft) => {
    initializePage(draft);
    stampFeatures(draft, ["comments-doc"]);
  });
  const session = new PageSession(pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  session.acceptAuthentication(auth);
  session.access = access;
  session.replicaKey = "1:commenter";
  session.handle = { doc: () => doc, on() {} };
  session.repo = heldRepo();
  session.queueSaved = () => {};
  session.updateCapabilities();
  t.after(() => {
    session.commentsOpen({ type: "close" });
    session.close();
  });
  return { session, repo: session.repo };
}
const handleFor = (id) => {
  const comments = newCommentsDoc();
  return { documentId: id, doc: () => comments, on() {} };
};

test("a lookup that times out retries, then a later success installs and enables comments", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, repo } = fixture(t);
  session.openComments("doc-1");
  await tick();
  assert.equal(repo.calls.length, 1);
  assert.equal(session.canComment, false, "no comments until the document is open");
  repo.calls[0].reject(Error("timed out"));
  await tick();
  assert.equal(session.commentsOpen$.snapshot().name, "retrying");
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(repo.calls.length, 2);
  repo.calls[1].resolve(handleFor("doc-1"));
  await tick();
  await tick();
  assert.equal(session.commentsOpen$.snapshot().name, "ready");
  assert.equal(session.commentsHandle.documentId, "doc-1");
  assert.equal(session.canComment, true);
});

test("a cancelled lookup completing late never installs", async (t) => {
  const { session, repo } = fixture(t);
  session.openComments("doc-1");
  await tick();
  // Discovery names a different document: the first lookup is cancelled.
  session.openComments("doc-2");
  await tick();
  assert.equal(repo.calls[0].signal.aborted, true);
  repo.calls[0].resolve(handleFor("doc-1"));
  await tick();
  assert.equal(session.commentsHandle, undefined);
  repo.calls[1].resolve(handleFor("doc-2"));
  await tick();
  await tick();
  assert.equal(session.commentsHandle.documentId, "doc-2");
});

test("repeated failures show a visible failure; a reconnect starts over", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, repo } = fixture(t);
  session.openComments("doc-1");
  for (let attempt = 1; attempt <= 5; attempt++) {
    await tick();
    repo.calls.at(-1).reject(Error("unreachable"));
    await tick();
    t.mock.timers.tick(8000);
  }
  await tick();
  assert.equal(session.commentsUnavailable, true);
  assert.equal(session.canComment, false);
  assert.equal(repo.calls.length, 5);
  session.commentsOpen({ type: "reconnected" });
  await tick();
  assert.equal(session.commentsUnavailable, false);
  assert.equal(repo.calls.length, 6);
  repo.calls[5].resolve(handleFor("doc-1"));
  await tick();
  await tick();
  assert.equal(session.canComment, true);
});

test("a reconnect while a lookup runs keeps that lookup", async (t) => {
  const { session, repo } = fixture(t);
  session.openComments("doc-1");
  await tick();
  session.commentsOpen({ type: "reconnected" });
  await tick();
  assert.equal(repo.calls.length, 1, "no duplicate lookup");
  assert.equal(repo.calls[0].signal.aborted, false);
});

test("replacing the replica cancels its lookup; the new replica opens its own", async (t) => {
  const { session, repo } = fixture(t);
  session.openComments("doc-1");
  await tick();
  session.commentsOpen({ type: "close" });
  assert.equal(repo.calls[0].signal.aborted, true);
  const next = heldRepo();
  session.repo = next;
  repo.calls[0].resolve(handleFor("doc-1"));
  await tick();
  assert.equal(session.commentsHandle, undefined, "the old replica's lookup never installs");
  session.openComments("doc-1");
  await tick();
  assert.equal(next.calls.length, 1);
  next.calls[0].resolve(handleFor("doc-1"));
  await tick();
  await tick();
  assert.equal(session.commentsOpen$.snapshot().name, "ready");
});
