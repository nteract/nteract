import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { PageSession } from "./session.mjs";
import { openPageWithRetry } from "./page-open.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an opening timeout is visible while native cleanup drains and retains its identity lock", async (t) => {
  const failure = new DOMException("Opening timed out", "TimeoutError");
  const calls = [];
  let session, finishFlush;
  const flushing = new Promise((resolve) => (finishFlush = resolve));
  t.after(() => finishFlush());
  t.mock.method(PageSession.prototype, "start", async function () {
    session = this;
    this.repo = {
      async flush() {
        calls.push("flush");
        await flushing;
      },
      async shutdown() {
        calls.push("shutdown");
      },
    };
    this.backend = { close: async () => calls.push("backend-close") };
    this.storage = { close: async () => calls.push("storage-close") };
    this.signer = { free: () => calls.push("signer-free") };
    this.local = { release: () => calls.push("identity-release") };
    throw failure;
  });
  let outcome;
  const opening = PageSession.open("remote-page").then(
    () => (outcome = "unexpectedly opened"),
    (error) => (outcome = error),
  );
  await tick();
  assert.equal(outcome, failure, "the original timeout must not wait for storage cleanup");
  assert.equal(outcome.cleanupPromise, session.closing, "retry receives the actual native drain");
  assert.equal(session.alive, false, "stale session callbacks are disabled immediately");
  assert.deepEqual(calls, ["flush"], "the identity stays owned while native I/O is pending");
  assert.equal(session.close(), session.closing, "repeated cleanup shares the same drain");
  finishFlush();
  await opening;
  await session.closing;
  assert.deepEqual(calls, [
    "flush",
    "shutdown",
    "backend-close",
    "storage-close",
    "signer-free",
    "identity-release",
  ]);
});

test("failed opening handles background cleanup rejection and still releases local ownership", async (t) => {
  const failure = Error("Document unavailable");
  const calls = [];
  t.mock.method(PageSession.prototype, "start", async function () {
    this.storage = {
      async close() {
        calls.push("storage-close");
        throw Error("IndexedDB close failed");
      },
    };
    this.signer = { free: () => calls.push("signer-free") };
    this.local = { release: () => calls.push("identity-release") };
    throw failure;
  });
  await assert.rejects(PageSession.open("remote-page"), (error) => error === failure);
  // Node's test runner treats any unhandled rejection as a failure. Let the
  // independently running cleanup reject without attaching a test-side catch.
  await tick();
  await tick();
  assert.deepEqual(calls, ["storage-close", "signer-free", "identity-release"]);
  await assert.rejects(failure.cleanupPromise, /IndexedDB close failed/);
});

test("a cold lookup's DOMException timeout retries only after its native identity is released", async (t) => {
  const timeout = new DOMException("The operation timed out", "TimeoutError");
  assert.equal(timeout.code, 23);
  const authentication = { identity: { principal: crypto.randomUUID() }, canWrite: true };
  const pageId = crypto.randomUUID();
  const doc = A.from({ title: "Ready after retry", page_id: pageId });
  const deadlines = [];
  let attempts = 0,
    released = false,
    finishFlush,
    opened,
    caught;
  const flushing = new Promise((resolve) => {
    finishFlush = resolve;
  });
  const timers = new Map();
  let cleanupScheduled, backoffScheduled;
  const cleanupReady = new Promise((resolve) => {
    cleanupScheduled = resolve;
  });
  const backoffReady = new Promise((resolve) => {
    backoffScheduled = resolve;
  });
  let nextTimer = 0;
  t.after(async () => {
    finishFlush();
    await opened?.close();
    A.free(doc);
  });
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 15000);
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  t.mock.method(PageSession.prototype, "initializeLocal", async function (key) {
    const first = ++attempts === 1;
    if (!first) assert.equal(released, true, "automatic retry must not rotate a held identity");
    this.replicaKey = key;
    this.local = {
      release: () => {
        released = true;
      },
    };
    this.repo = {
      async find(_id, { signal }) {
        if (first) {
          deadlines.at(-1).abort(timeout);
          throw signal.reason;
        }
        return { documentId: crypto.randomUUID(), doc: () => doc, on() {} };
      },
      flush: () => (first ? flushing : Promise.resolve()),
      async shutdown() {},
    };
  });
  t.mock.method(PageSession.prototype, "connect", async function () {
    this.connection = { documentId: "remote-document" };
  });
  t.mock.method(PageSession.prototype, "queueSaved", () => {});
  const result = openPageWithRetry(
    async () => {
      try {
        return await PageSession.open(pageId, { authentication });
      } catch (error) {
        caught = error;
        throw error;
      }
    },
    {
      signal: new AbortController().signal,
      delays: [1],
      setTimeout(fn, delay) {
        timers.set(++nextTimer, { fn, delay });
        if (delay === 15000) cleanupScheduled();
        if (delay === 1) backoffScheduled();
        return nextTimer;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  );
  void result.catch(() => {});
  await cleanupReady;
  assert.equal(caught.code, "REQUEST_TIMEOUT");
  assert.equal(caught.cause, timeout);
  assert.equal(attempts, 1);
  assert.equal(released, false);
  assert.deepEqual(
    [...timers.values()].map(({ delay }) => delay),
    [15000],
  );
  finishFlush();
  await backoffReady;
  assert.equal(released, true);
  assert.deepEqual(
    [...timers.values()].map(({ delay }) => delay),
    [1],
  );
  const [id, { fn }] = [...timers][0];
  timers.delete(id);
  fn();
  opened = await result;
  assert.equal(opened.doc.title, "Ready after retry");
  assert.equal(attempts, 2);
  assert.equal(timers.size, 0);
});

test("a TimeoutError outside the cold lookup's own deadline is not normalized for retry", async (t) => {
  const failure = new DOMException("Another subsystem timed out", "TimeoutError");
  const authentication = { identity: { principal: crypto.randomUUID() }, canWrite: true };
  t.mock.method(PageSession.prototype, "initializeLocal", async function () {
    this.repo = {
      find: async () => {
        throw failure;
      },
      async flush() {},
      async shutdown() {},
    };
  });
  t.mock.method(PageSession.prototype, "connect", async function () {
    this.connection = { documentId: "remote-document" };
  });
  let attempts = 0;
  await assert.rejects(
    openPageWithRetry(
      () => {
        attempts++;
        return PageSession.open(crypto.randomUUID(), { authentication });
      },
      { signal: new AbortController().signal },
    ),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
  assert.equal(failure.code, 23);
  await failure.cleanupPromise;
});

// Drive the real first-open path: discovery, native socket, then the cold
// document lookup. Only network, socket and storage boundaries are replaced.
function coldOpenFixture(t, { refuseDuringHandshake = false } = {}) {
  const authentication = { identity: { principal: crypto.randomUUID() }, canWrite: true };
  const state = { attempts: 0, sockets: [], backoff: [], capability: [] };
  let lookupStarted;
  state.lookup = new Promise((resolve) => (lookupStarted = resolve));
  const locationBefore = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://localhost:9894/" },
  });
  t.after(() => {
    if (locationBefore) Object.defineProperty(globalThis, "location", locationBefore);
    else delete globalThis.location;
  });
  // The cold lookup deadline never fires: only the refusal can end the wait.
  t.mock.method(AbortSignal, "timeout", () => new AbortController().signal);
  t.mock.method(PageSession.prototype, "initializeLocal", async function (key) {
    state.attempts++;
    this.replicaKey = key;
    this.local = { release() {} };
    this.signer = { free() {} };
    this.storage = { async close() {} };
    this.backend = { async addConnection() {}, async close() {} };
    this.repo = {
      find(_id, { signal }) {
        lookupStarted();
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      },
      async flush() {},
      async shutdown() {},
    };
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(url.startsWith("/api/connect?"), url);
    state.capability.push(new Headers(options?.headers).get("x-pages-admission"));
    return Response.json({
      identity: authentication.identity,
      documentId: "remote-document",
      access: { role: "viewer", generation: 0, revision: 0, canRead: true, canWrite: false },
      serverPeerId: "00".repeat(32),
      serverSenderId: "host",
      peerProfiles: {},
    });
  });
  t.mock.method(globalThis, "WebSocket", function () {
    const events = new EventTarget();
    Object.defineProperty(this, "binaryType", { value: "blob", writable: true });
    this.addEventListener = events.addEventListener.bind(events);
    this.dispatchEvent = events.dispatchEvent.bind(events);
    this.close = () => {};
    state.sockets.push(this);
  });
  const refuse = (socket) =>
    socket.dispatchEvent(
      Object.assign(new Event("close"), { code: 4422, reason: "signing_key_rejected" }),
    );
  t.mock.method(N.SubductionWebSocket, "setup", async (socket, _signer, _peer, onDisconnect) => {
    state.disconnect = () => {
      refuse(socket);
      onDisconnect();
    };
    if (refuseDuringHandshake) {
      refuse(socket);
      throw Error("Native handshake failed");
    }
    return { free() {}, toTransport: () => ({ free() {} }) };
  });
  state.open = () =>
    openPageWithRetry(() => PageSession.open(crypto.randomUUID(), { authentication }), {
      signal: new AbortController().signal,
      delays: [1, 1, 1],
      setTimeout(fn, delay) {
        state.backoff.push(delay);
        return setTimeout(fn, delay);
      },
      clearTimeout,
    });
  return state;
}

test("a signing key refused after the handshake ends the cold lookup without retrying", async (t) => {
  const f = coldOpenFixture(t);
  const opening = f.open();
  void opening.catch(() => {});
  await f.lookup;
  f.disconnect();
  const error = await opening.then(
    () => assert.fail("opened despite refusal"),
    (error) => error,
  );
  assert.equal(error.code, "SIGNING_KEY_REFUSED");
  assert.match(error.message, /refused this tab's signing key/);
  assert.equal(error.admission.code, "signing_key_rejected");
  assert.equal(f.attempts, 1, "a permanent refusal is not reopened");
  assert.deepEqual(f.backoff, []);
  assert.deepEqual(f.capability, ["1"], "discovery declares the admission capability");
  await error.cleanupPromise;
});

test("a signing key refused during the handshake reports the diagnosis without retrying", async (t) => {
  const f = coldOpenFixture(t, { refuseDuringHandshake: true });
  const error = await f.open().then(
    () => assert.fail("opened despite refusal"),
    (error) => error,
  );
  assert.equal(error.code, "SIGNING_KEY_REFUSED");
  assert.equal(error.cause.message, "Native handshake failed");
  assert.equal(f.attempts, 1);
  assert.deepEqual(f.backoff, []);
  await error.cleanupPromise;
});
