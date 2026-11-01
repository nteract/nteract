import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { PageSession, pageSyncAddress } from "./session.mjs";

const activityMessage = (revision = 1, epoch = "epoch-one") => ({
  kind: "page-activity",
  epoch,
  revision,
  observed_at: "2026-10-28T00:00:00Z",
  progress: [
    {
      progress_id: "agent-one",
      principal: "account",
      displayName: "Kyle Kelley",
      driver: "ChatGPT",
      message: "Reviewing the introduction",
      targets: [],
      expires_at: "2026-10-28T00:01:00Z",
    },
  ],
});

test("native admission pins the freshly discovered activity epoch without changing legacy URLs", () => {
  const address = pageSyncAddress("fixture", "https://page8.runtimed.run/p/fixture", "host+epoch");
  assert.equal(address.protocol, "wss:");
  assert.equal(address.pathname, "/api/sync");
  assert.equal(address.searchParams.get("page"), "fixture");
  assert.equal(address.searchParams.get("activity_epoch"), "host+epoch");
  const legacy = pageSyncAddress("fixture", "http://localhost:8910/", null);
  assert.equal(legacy.protocol, "ws:");
  assert.equal(legacy.searchParams.has("activity_epoch"), false);
});

test("a rejected stale-epoch upgrade retires the discovered activity before retry", async (t) => {
  const session = new PageSession("fixture");
  session.credentialCanWrite = true;
  session.replicaKey = "0:writer";
  const locationBefore = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://page8.runtimed.run/" },
  });
  t.after(() => {
    if (locationBefore) Object.defineProperty(globalThis, "location", locationBefore);
    else delete globalThis.location;
    session.clearPresence();
  });
  t.mock.method(session, "registerDraft", async () => {});
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      identity: { principal: "account", displayName: "Kyle Kelley" },
      access: { role: "owner", generation: 0, revision: 0, canRead: true, canWrite: true },
      serverPeerId: "00".repeat(32),
      serverSenderId: "host",
      peerProfiles: {},
      activity: activityMessage(),
    }),
  );
  let closed = 0;
  t.mock.method(globalThis, "WebSocket", function (address) {
    Object.defineProperty(this, "binaryType", { value: "blob", writable: true });
    this.address = address;
    this.addEventListener = () => {};
    this.close = () => closed++;
  });
  t.mock.method(N.SubductionWebSocket, "setup", async (socket) => {
    assert.equal(socket.address.searchParams.get("activity_epoch"), "epoch-one");
    assert.equal(session.agentProgress.size, 1, "connection discovery installed the snapshot");
    throw Object.assign(Error("Activity host changed"), { status: 409 });
  });
  await assert.rejects(session.openConnection(false), { status: 409 });
  assert.equal(closed, 1);
  assert.equal(session.sockets.size, 0);
  assert.equal(session.agentProgress.size, 0);
  assert.equal(session.activityEpoch, null);
  assert.equal(session.presencePaused, true);
  assert.equal(session.activityTimer, undefined);
});

test("activity trusts only the current host and ordered snapshots in its admitted epoch", (t) => {
  const session = new PageSession("fixture");
  session.connection = { serverSenderId: "host" };
  t.after(() => session.clearPresence());
  const send = (message, senderId = "host") => session.ephemeral({ senderId, message });
  send(activityMessage());
  assert.equal(session.agentProgress.size, 0, "ephemeral traffic cannot establish an epoch");
  assert.equal(session.receiveActivity(activityMessage(), { initial: true }), true);
  const original = session.agentProgress.get("agent-one");
  const update = activityMessage(2);
  update.progress[0].message = "Checking citations";
  send(update, "forged-peer");
  assert.equal(session.agentProgress.get("agent-one"), original);
  send(update);
  assert.equal(session.agentProgress.get("agent-one").message, "Checking citations");
  send(activityMessage(1));
  send(activityMessage(9, "retired-epoch"));
  assert.equal(session.agentProgress.get("agent-one").message, "Checking citations");
  send({ ...activityMessage(3), progress: [] });
  assert.equal(session.agentProgress.size, 0);
  assert.equal(session.activityTimer, undefined);
});

test("activity expires locally despite clock skew and replay cannot extend its lifetime", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  // Activity lifetimes run on the session's monotonic clock; here it follows
  // the mocked timers.
  const session = new PageSession("fixture", { now: () => Date.now() });
  session.connection = { serverSenderId: "host" };
  session.receiveActivity(activityMessage(), { initial: true });
  assert.equal(session.agentProgress.get("agent-one").until, 61000);
  t.mock.timers.tick(30000);
  session.ephemeral({ senderId: "host", message: activityMessage() });
  assert.equal(session.agentProgress.get("agent-one").until, 61000);
  t.mock.timers.tick(30000);
  assert.equal(session.agentProgress.size, 0);
});

test("disconnect, auth loss, access pause and close immediately retire ephemeral state", async (t) => {
  for (const stop of [
    (session) => session.disconnectSockets(),
    (session) => session.requireSignIn(),
    (session) => session.pauseForAccess("Access changed", { checkpoint: false }),
    (session) => {
      session.skipCloseCheckpoint = true;
      return session.close();
    },
  ]) {
    const session = new PageSession("fixture");
    session.connection = { serverSenderId: "host" };
    session.receiveActivity(activityMessage(), { initial: true });
    session.peers.set("browser", { at: Date.now(), value: {} });
    await stop(session);
    assert.equal(session.peers.size, 0);
    assert.equal(session.agentProgress.size, 0);
    assert.equal(session.activityEpoch, null);
    assert.equal(session.activityTimer, undefined);
    session.ephemeral({ senderId: "host", message: activityMessage(2) });
    assert.equal(session.agentProgress.size, 0);
  }
});

test("late old-socket closure cannot clear a successor connection activity", async (t) => {
  const session = new PageSession("fixture");
  const old = { close() {} },
    next = { close() {} };
  session.sockets.add(old);
  await session.disconnectSockets();
  session.sockets.add(next);
  session.presencePaused = false;
  session.receiveActivity(activityMessage(1, "new-epoch"), { initial: true });
  session.socketDisconnected(old);
  assert.equal(session.agentProgress.size, 1);
  assert.equal(session.activityEpoch, "new-epoch");
  t.after(() => session.disconnectSockets());
});

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
test("host tool-edit hints name each change by hash, with the session label", () => {
  let doc = A.from({ text: "one" });
  const agentChange = A.change(A.clone(doc), (d) => A.updateText(d, ["text"], "two"));
  const session = new PageSession("fixture");
  session.handle = { doc: () => doc };
  session.connection = { serverSenderId: "verified-host" };
  session.ephemeral({
    senderId: "verified-host",
    message: {
      kind: "tool-edit",
      heads: A.getHeads(agentChange),
      identity: {
        principal: "user:kyle",
        displayName: "Kyle Kelley",
        driver: "Kilo",
        agent: "rich text",
      },
    },
  });
  doc = agentChange;
  session.resolveToolHints();
  assert.deepEqual(session.changeIdentity(A.getHeads(agentChange)[0]), {
    principal: "user:kyle",
    displayName: "Kyle Kelley",
    driver: "Kilo",
    agent: "rich text",
    session: null,
  });
  // A browser can't attest an author: a selection's claimed actor is ignored,
  // and selections carry no actor at all.
  session.profiles = { peer: { principal: "user:ana", displayName: "Ana", driver: "Browser" } };
  session.ephemeral({
    senderId: "peer",
    message: {
      kind: "selection",
      value: { block_id: "b", start: "s", end: "e", heads: [], actor: A.getActorId(agentChange) },
    },
  });
  assert.equal(session.changeIdentity(A.getHeads(agentChange)[0]).principal, "user:kyle");
  assert.equal(typeof session.actorIdentity, "undefined");
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
  // A person in the browser is shown by name alone; the profile keeps the driver.
  session.profiles = { peer: { displayName: "Kyle Kelley", driver: "Browser" } };
  session.ephemeral({
    senderId: "peer",
    message: { kind: "selection", value: { block_id: "b", start: "s", end: "e", heads: [] } },
  });
  assert.equal(session.peers.get("peer").displayName, "Kyle Kelley");
  assert.equal(session.peers.get("peer").profile.driver, "Browser");
});

test("a local write requests durability even when its handle emits no visible patch", async (t) => {
  const session = new PageSession("fixture");
  session.canWrite = true;
  session.status = "Saved";
  const doc = A.from({ text: "unchanged" });
  session.handle = {
    doc: () => doc,
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
  assert.equal(session.status, "Syncing", "a remote change syncs; it is not a local save");
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
  assert.equal(session.status, "Syncing");
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
