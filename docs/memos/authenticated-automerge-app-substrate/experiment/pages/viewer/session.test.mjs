import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { PageSession } from "./session.mjs";

test("a delayed old receipt cannot replace the Saved state from a newer edit", async (t) => {
  let doc = A.from({ text: "one" });
  const pending = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, request) =>
    new Promise((resolve) => pending.push({ heads: JSON.parse(request.body).heads, resolve }));
  t.after(() => {
    globalThis.fetch = original;
  });
  const session = new PageSession("fixture");
  session.handle = { doc: () => doc };
  session.repo = { flush: async () => {} };
  session.receiptRevision = 1;
  const old = session.saveReceipt();
  await new Promise((resolve) => setTimeout(resolve, 0));
  doc = A.change(doc, (d) => A.updateText(d, ["text"], "two"));
  session.receiptRevision = 2;
  const recent = session.saveReceipt();
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending[1].resolve(
    new Response(JSON.stringify({ durableHeads: pending[1].heads }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  await recent;
  assert.equal(session.status, "Saved");
  pending[0].resolve(
    new Response(JSON.stringify({ durableHeads: pending[0].heads }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  await old;
  assert.equal(session.status, "Saved");
  assert.deepEqual(session.savedHeads, A.getHeads(doc));
});

test("only signed host profile hints name edits, including hints arriving before their changes", () => {
  let doc = A.from({ text: "one" });
  const later = A.change(A.clone(doc), (d) => A.updateText(d, ["text"], "two"));
  const session = new PageSession("fixture");
  session.handle = { doc: () => doc };
  session.connection = { serverSenderId: "verified-host" };
  const hint = {
    kind: "tool-edit",
    heads: A.getHeads(later),
    identity: { displayName: "Kyle Kelley", driver: "ChatGPT" },
  };
  session.ephemeral({ senderId: "untrusted-client", message: hint });
  assert.equal(session.toolHints.length, 0);
  session.ephemeral({ senderId: "verified-host", message: hint });
  assert.equal(session.toolHints.length, 1);
  doc = later;
  session.resolveToolHints();
  assert.equal(session.toolHints.length, 0);
  assert.equal(session.actorDisplayName(A.getActorId(later)), "Kyle Kelley · ChatGPT");
});
test("presence rejects malformed causal heads and ignores claimed display identity", () => {
  const session = new PageSession("fixture");
  session.connection = { serverSenderId: "verified-host" };
  session.profiles = { peer: { displayName: "Kyle Kelley", driver: "Mobile" } };
  session.ephemeral({
    senderId: "peer",
    message: {
      kind: "selection",
      value: { block_id: "b", start: "s", end: "e", heads: ["malformed"] },
    },
  });
  assert.equal(session.peers.size, 0);
  session.ephemeral({
    senderId: "peer",
    message: {
      kind: "selection",
      displayName: "Impersonated",
      value: { block_id: "b", start: "s", end: "e", heads: [] },
    },
  });
  assert.equal(session.peers.get("peer").displayName, "Kyle Kelley · Mobile");
});

test("a local write requests durability even when its handle emits no visible patch", async (t) => {
  const session = new PageSession("fixture");
  session.canWrite = true;
  session.status = "Saved";
  session.handle = {
    change(fn) {
      fn({});
      return Promise.resolve();
    },
  };
  session.change(() => {});
  assert.equal(session.status, "Saving");
  assert.ok(session.savedTimer);
  t.after(() => clearTimeout(session.savedTimer));
});

test("observer failures cannot suppress other observers, subscribers or durable receipts", async (t) => {
  const before = A.from({ text: "before" });
  const after = A.change(before, (d) => A.updateText(d, ["text"], "after"));
  const session = new PageSession("fixture");
  let observed = 0,
    emitted = 0,
    flushed = 0;
  session.handle = { doc: () => after };
  session.repo = { flush: async () => flushed++ };
  session.observeChange(() => {
    throw Error("stale editor");
  });
  session.observeChange(() => observed++);
  session.subscribe(() => {
    throw Error("stale subscriber");
  });
  session.subscribe(() => emitted++);
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, request) =>
    Response.json({ durableHeads: JSON.parse(request.body).heads });
  t.after(() => {
    globalThis.fetch = original;
    clearTimeout(session.savedTimer);
  });
  assert.doesNotThrow(() =>
    session.receiveChange({
      doc: after,
      patches: A.diff(after, A.getHeads(before), A.getHeads(after)),
      patchInfo: { before, after },
    }),
  );
  assert.equal(observed, 1);
  assert.ok(emitted > 0);
  assert.equal(session.problem, "stale subscriber", "callback failures remain visible");
  assert.equal(session.status, "Saving");
  assert.ok(session.savedTimer);
  clearTimeout(session.savedTimer);
  await session.saveReceipt();
  assert.equal(flushed, 1);
  assert.equal(session.status, "Saved");
  assert.deepEqual(session.savedHeads, A.getHeads(after));
});

test("deferred observer failures do not interrupt composition release or later observers", (t) => {
  const before = A.from({ text: "before" });
  const after = A.change(before, (d) => A.updateText(d, ["text"], "after"));
  const session = new PageSession("fixture");
  session.handle = { doc: () => after };
  let observed = 0;
  session.observeChange(() => {
    throw Error("stale editor during composition");
  });
  session.observeChange(() => observed++);
  const release = session.holdRemote();
  session.receiveChange({ doc: after, patchInfo: { before, after } });
  t.after(() => clearTimeout(session.savedTimer));
  assert.equal(observed, 0);
  assert.equal(session.status, "Saving");
  assert.ok(session.savedTimer);
  assert.doesNotThrow(release);
  assert.equal(observed, 1);
  assert.equal(session.problem, "stale editor during composition");
  assert.equal(session.deferredBefore, null);
});

test("auth expiry pauses reconnect but preserves the document and locally persisted edits", async (t) => {
  let doc = A.from({ text: "Draft" }),
    flushes = 0;
  const session = new PageSession("fixture", {
    refreshSession: async () => ({ identity: null, canWrite: false }),
  });
  session.identity = { principal: "one", displayName: "Kyle" };
  session.canWrite = true;
  session.handle = {
    doc: () => doc,
    change(fn) {
      doc = A.change(doc, fn);
      return Promise.resolve();
    },
  };
  session.repo = { flush: async () => flushes++ };
  t.after(() => {
    clearTimeout(session.savedTimer);
    clearTimeout(session.retryTimer);
  });
  await assert.rejects(session.connect(), { status: 401 });
  assert.equal(session.authRequired, true);
  assert.equal(session.status, "Sign in to sync");
  session.scheduleReconnect();
  assert.equal(session.retryTimer, undefined);
  await session.change((d) => A.updateText(d, ["text"], "Unsynced draft"));
  clearTimeout(session.savedTimer);
  await session.saveReceipt();
  assert.equal(doc.text, "Unsynced draft");
  assert.equal(flushes, 1);
  assert.equal(session.alive, true);
  assert.equal(session.status, "Sign in to sync");
});

test("reconnect renews before requesting document access and a 401 does not retry forever", async (t) => {
  const calls = [];
  const session = new PageSession("fixture", {
    refreshSession: async () => {
      calls.push("renew");
      return { identity: { principal: "one" }, canWrite: true };
    },
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(url, /^\/api\/connect/);
    calls.push("connect");
    return Response.json({ error: "Session expired" }, { status: 401 });
  };
  t.after(() => {
    globalThis.fetch = original;
    clearTimeout(session.retryTimer);
  });
  await session.retryConnection();
  assert.deepEqual(calls, ["renew", "connect"]);
  assert.equal(session.authRequired, true);
  assert.equal(session.retryTimer, undefined);
});

test("a different signed-in account cannot resume the open Page's replica", async () => {
  const session = new PageSession("fixture", {
    refreshSession: async () => ({ identity: { principal: "other" }, canWrite: true }),
  });
  session.identity = { principal: "original" };
  await assert.rejects(session.connect(), { status: 401 });
  assert.equal(session.identity.principal, "original");
  assert.match(session.authProblem, /original account/);
  assert.equal(session.alive, true);
});

test("save receipts renew once on 401 and stop if the retry is still unauthorized", async (t) => {
  for (const retrySucceeds of [true, false]) {
    await t.test(String(retrySucceeds), async (t) => {
      const doc = A.from({ text: "Draft" });
      let renewals = 0,
        requests = 0,
        flushes = 0;
      const session = new PageSession("fixture", {
        refreshSession: async () => {
          renewals++;
          return { identity: { principal: "one" }, canWrite: true };
        },
      });
      session.identity = { principal: "one" };
      session.handle = { doc: () => doc };
      session.repo = { flush: async () => flushes++ };
      const original = globalThis.fetch;
      globalThis.fetch = async () => {
        requests++;
        return requests === 2 && retrySucceeds
          ? Response.json({ durableHeads: A.getHeads(doc) })
          : Response.json({ error: "Sign in" }, { status: 401 });
      };
      t.after(() => {
        globalThis.fetch = original;
        clearTimeout(session.savedTimer);
      });
      await session.saveReceipt();
      assert.equal(renewals, 1);
      assert.equal(requests, 2);
      assert.equal(session.status, retrySucceeds ? "Saved" : "Sign in to sync");
      if (!retrySucceeds) {
        await session.saveReceipt();
        assert.equal(requests, 2);
        assert.equal(flushes, 2, "local persistence still runs after auth expiry");
      }
    });
  }
});

test("an in-flight save receipt cannot clear a subsequently expired sign-in state", async (t) => {
  const doc = A.from({ text: "Draft" });
  const session = new PageSession("fixture");
  session.handle = { doc: () => doc };
  session.repo = { flush: async () => {} };
  let resolve;
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    new Promise((done) => {
      resolve = done;
    });
  t.after(() => {
    globalThis.fetch = original;
  });
  const saving = session.saveReceipt();
  await new Promise((done) => setTimeout(done, 0));
  session.requireSignIn();
  resolve(Response.json({ durableHeads: A.getHeads(doc) }));
  await saving;
  assert.equal(session.status, "Sign in to sync");
  assert.equal(session.authRequired, true);
});
