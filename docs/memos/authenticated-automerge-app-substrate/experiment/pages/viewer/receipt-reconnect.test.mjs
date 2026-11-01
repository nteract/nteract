import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { PageSession } from "./session.mjs";
import {
  HANDSHAKE_TIMEOUT_MS,
  OUTAGE_ATTEMPTS,
  OUTAGE_MS,
  REFUSAL_LIMIT,
  backoffStep,
} from "./reconnect-machine.mjs";
import { SERVER_UNREACHABLE } from "./alerts.mjs";
import { SLOW_SAVE_MS } from "./sync-status-machine.mjs";

const drain = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Exercise the real discovery, authentication, socket lifecycle and receipt
// methods. Only external I/O and time are controlled; no receipt methods are mocked.
function fixture(t, { random, date = false } = {}) {
  // `date` mocks Date too, and performance.now(), the session's default
  // outage clock, as a fake monotonic clock that moves with the mocked
  // timers: Date.now() minus every wall-clock jump the test makes with
  // jumpWall(), the way the real one ignores them.
  // The mocked wall clock starts a day in, so it can jump back.
  t.mock.timers.enable(
    date ? { apis: ["setTimeout", "Date"], now: 86_400_000 } : { apis: ["setTimeout"] },
  );
  let wallShift = 0;
  let doc = A.from({ text: "Pending edit" });
  const identity = { principal: "fixture-owner", displayName: "Fixture owner" };
  const session = new PageSession("receipt-reconnect", {
    refreshSession: async () => ({ identity, canWrite: true }),
    random,
  });
  if (date) t.mock.method(globalThis.performance, "now", () => Date.now() - wallShift);
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  session.identity = identity;
  session.credentialCanWrite = true;
  session.replicaKey = "0:writer";
  session.handle = {
    doc: () => doc,
    documentId,
    change(fn) {
      doc = A.change(doc, fn);
      return hooks.change?.();
    },
  };
  const requests = [],
    sockets = [],
    hooks = {};
  let added = 0,
    freed = 0,
    synchronized = 0;
  session.repo = { flush: async () => hooks.flush?.() };
  session.backend = {
    async addConnection() {
      added++;
      await hooks.addConnection?.();
    },
    open() {
      return {
        async synchronize() {
          synchronized++;
        },
        async close() {},
      };
    },
  };
  t.mock.method(session, "registerDraft", async () => {});
  t.mock.method(session, "persistLocal", async () => {});
  const locationBefore = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://localhost:9894/" },
  });
  t.mock.method(globalThis, "WebSocket", function () {
    const events = new EventTarget();
    Object.defineProperty(this, "binaryType", { value: "blob", writable: true });
    this.addEventListener = events.addEventListener.bind(events);
    this.dispatchEvent = events.dispatchEvent.bind(events);
    this.closed = 0;
    this.close = () => {
      this.closed++;
    };
    sockets.push(this);
  });
  t.mock.method(N.SubductionWebSocket, "setup", async (_socket, _signer, _peer, onDisconnect) => {
    // The native wrapper's disconnect callback, for a close under a pending setup.
    hooks.disconnect = onDisconnect;
    await hooks.setup?.();
    return {
      free() {
        freed++;
      },
      toTransport: () => ({ free() {} }),
    };
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.startsWith("/api/connect?"))
      return (
        hooks.connect?.() ??
        Response.json({
          identity,
          documentId,
          access: { role: "owner", generation: 0, revision: 0, canRead: true, canWrite: true },
          serverPeerId: "00".repeat(32),
          serverSenderId: "fixture-host",
          peerProfiles: {},
        })
      );
    assert.ok(url.startsWith("/api/saved?"), `unexpected fixture request: ${url}`);
    const pending = { ...deferred(), heads: JSON.parse(options.body).heads };
    requests.push(pending);
    return hooks.receipt ? hooks.receipt(pending) : pending.promise;
  });
  t.after(async () => {
    session.skipCloseCheckpoint = true;
    await session.close();
    if (locationBefore) Object.defineProperty(globalThis, "location", locationBefore);
    else delete globalThis.location;
  });
  return {
    session,
    requests,
    sockets,
    hooks,
    mutate(text = "New edit") {
      doc = A.change(doc, (draft) => A.updateText(draft, ["text"], text));
    },
    counts: () => ({ added, freed, synchronized }),
    async advance(ms) {
      t.mock.timers.tick(ms);
      await drain();
    },
    /** Set the wall clock `ms` forward (or back, if negative). */
    jumpWall(ms) {
      t.mock.timers.setTime(Date.now() + ms);
      wallShift += ms;
    },
    async start() {
      await session.openConnection(false);
      await this.advance(300);
    },
  };
}

test("same-head reconnect keeps a delayed successful or failed receipt current", async (t) => {
  for (const status of [200, 409]) {
    await t.test(String(status), async (t) => {
      const f = fixture(t);
      await f.start();
      const revision = f.session.receiptRevision;
      assert.equal(f.requests.length, 1);
      for (let i = 0; i < 3; i++) await f.session.openConnection(false);
      assert.equal(f.session.receiptRevision, revision);
      assert.equal(f.requests.length, 1);
      assert.equal(f.session.savedTimer, undefined);
      f.requests[0].resolve(
        Response.json(
          status === 200
            ? { durableHeads: f.requests[0].heads }
            : { error: "Requested edits have not arrived" },
          { status },
        ),
      );
      await drain();
      assert.equal(f.session.status, status === 200 ? "Saved" : "Not saved");
      assert.equal(f.session.problem, status === 200 ? "" : "Requested edits have not arrived");
      assert.equal(f.session.receiptRetryAttempts, status === 200 ? 0 : 1);
      await f.session.openConnection(false);
      assert.equal(f.session.status, status === 200 ? "Saved" : "Not saved");
      assert.equal(f.session.problem, status === 200 ? "" : "Requested edits have not arrived");
      if (status === 200) {
        await f.advance(10000);
        assert.equal(f.requests.length, 1, "already saved heads need no new receipt");
      } else {
        await f.advance(500);
        assert.equal(f.counts().synchronized, 1);
        assert.equal(f.requests.length, 2, "existing bounded retry remains scheduled");
        f.requests[1].resolve(Response.json({ durableHeads: f.requests[1].heads }));
        await drain();
        assert.equal(f.session.status, "Saved");
        assert.equal(f.session.problem, "");
      }
    });
  }
});

test("duplicate notifications and reconnect do not postpone the same-head debounce", async (t) => {
  const f = fixture(t);
  await f.session.openConnection(false);
  const timer = f.session.savedTimer,
    revision = f.session.receiptRevision;
  await f.advance(200);
  f.session.queueSaved();
  await f.session.openConnection(false);
  assert.equal(f.session.savedTimer, timer);
  assert.equal(f.session.receiptRevision, revision);
  await f.advance(100);
  assert.equal(f.requests.length, 1);
  assert.equal(f.session.savedTimer, undefined);
  const original = f.session.saveReceipt();
  const duplicate = f.session.saveReceipt();
  assert.equal(original, duplicate, "same receipt shares one in-flight request");
  f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
  await original;
  assert.equal(f.requests.length, 1);
});

test("duplicate events and a successful receipt cannot erase a failed native connection", async (t) => {
  const f = fixture(t);
  await f.start();
  f.hooks.setup = () => {
    throw Error("Native handshake failed");
  };
  await f.session.retryConnection();
  assert.equal(f.session.status, "Offline");
  assert.equal(f.session.statusRetry, true);
  assert.equal(f.session.problem, "Native handshake failed");
  f.session.queueSaved();
  assert.equal(f.session.status, "Offline");
  assert.equal(f.session.problem, "Native handshake failed");
  assert.equal(f.requests.length, 1, "same heads retain their pending receipt");
  f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
  await drain();
  assert.deepEqual(f.session.savedHeads, f.requests[0].heads, "the HTTP durability proof is valid");
  assert.equal(f.session.status, "Offline", "durability does not prove native connectivity");
  assert.equal(f.session.connectionProblem, "Native handshake failed");
  f.session.queueSaved();
  assert.equal(f.session.status, "Offline");
  assert.equal(f.session.problem, "Native handshake failed");
});

test("same-head reconnect preserves an asynchronous local change error while flush is pending", async (t) => {
  const f = fixture(t);
  await f.session.openConnection(false);
  const storage = deferred(),
    flush = deferred();
  f.hooks.change = () => storage.promise;
  f.hooks.flush = () => flush.promise;
  const stored = f.session.change((draft) => A.updateText(draft, ["text"], "Local edit"));
  await f.advance(300);
  storage.reject(Error("Local change persistence failed"));
  await assert.rejects(stored, /Local change persistence failed/);
  await drain();
  assert.equal(f.session.status, "Local save failed");
  assert.equal(f.session.statusKey, "failed");
  assert.equal(f.session.statusRetry, false, "a failed local save has nothing to retry");
  await f.session.openConnection(false);
  f.session.queueSaved();
  assert.equal(f.session.status, "Local save failed");
  assert.equal(f.session.problem, "Local change persistence failed");
  assert.equal(f.requests.length, 0, "the unresolved flush still gates remote receipts");
  flush.resolve();
  await drain();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
  assert.equal(f.session.problem, "");
});

test("an older asynchronous local change error cannot replace a newer saved cycle", async (t) => {
  const f = fixture(t);
  await f.session.openConnection(false);
  const storage = deferred();
  f.hooks.change = () => storage.promise;
  const old = f.session.change((draft) => A.updateText(draft, ["text"], "Older edit"));
  f.hooks.change = undefined;
  f.session.change((draft) => A.updateText(draft, ["text"], "Newer edit"));
  await f.advance(300);
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
  storage.reject(Error("Stale local persistence failure"));
  await assert.rejects(old, /Stale local persistence failure/);
  await drain();
  assert.equal(f.session.status, "Saved");
  assert.equal(f.session.problem, "");
  assert.equal(f.session.localProblem, "");
  assert.deepEqual(f.session.savedHeads, A.getHeads(f.session.doc));
});

test("automatic reconnect preserves exhausted retry budget; explicit Retry starts a new cycle", async (t) => {
  const f = fixture(t);
  f.hooks.receipt = () => Response.json({ error: "Storage unavailable" }, { status: 500 });
  await f.start();
  const revision = f.session.receiptRevision;
  for (const delay of [500, 1000, 2000]) {
    const timer = f.session.receiptRetryTimer,
      attempts = f.session.receiptRetryAttempts;
    f.session.queueSaved();
    await f.session.openConnection(false);
    assert.equal(f.session.receiptRetryTimer, timer);
    assert.equal(f.session.receiptRetryAttempts, attempts);
    assert.equal(f.session.problem, "Storage unavailable");
    await f.advance(delay);
  }
  assert.equal(f.requests.length, 4);
  assert.equal(f.session.receiptRetryAttempts, 3);
  for (let i = 0; i < 3; i++) await f.session.retryConnection();
  await f.advance(10000);
  assert.equal(f.requests.length, 4);
  assert.equal(f.session.receiptRevision, revision);
  assert.equal(f.session.receiptRetryTimer, undefined);
  assert.equal(f.session.status, "Not saved");
  f.hooks.receipt = ({ heads }) => Response.json({ durableHeads: heads });
  await f.session.retryConnection({ retryReceipt: true });
  assert.ok(f.session.receiptRevision > revision);
  await f.advance(300);
  assert.equal(f.requests.length, 5);
  assert.equal(f.session.status, "Saved");
  assert.equal(f.session.problem, "");
});

test("a new edit restarts an exhausted cycle while unchanged-head reconnect does not", async (t) => {
  const f = fixture(t);
  f.hooks.receipt = () => Response.json({ error: "Storage unavailable" }, { status: 500 });
  await f.start();
  for (const delay of [500, 1000, 2000]) await f.advance(delay);
  const revision = f.session.receiptRevision;
  assert.equal(f.requests.length, 4);
  await f.session.openConnection(false);
  await f.advance(10000);
  assert.equal(f.requests.length, 4);
  f.mutate();
  f.session.queueSaved();
  assert.ok(f.session.receiptRevision > revision);
  assert.equal(f.session.receiptRetryAttempts, 0);
  f.hooks.receipt = ({ heads }) => Response.json({ durableHeads: heads });
  await f.advance(300);
  assert.equal(f.requests.length, 5);
  assert.deepEqual(f.requests[4].heads, A.getHeads(f.session.doc));
  assert.equal(f.session.status, "Saved");
  assert.equal(f.session.problem, "");
});

test("explicit Retry can obtain a receipt even when native reconnect still fails", async (t) => {
  const f = fixture(t);
  f.hooks.receipt = () => Response.json({ error: "Storage unavailable" }, { status: 500 });
  await f.start();
  for (const delay of [500, 1000, 2000]) await f.advance(delay);
  assert.equal(f.requests.length, 4);
  f.hooks.setup = async () => {
    throw Error("Native connection unavailable");
  };
  f.hooks.receipt = ({ heads }) => Response.json({ durableHeads: heads });
  await f.session.retryConnection({ retryReceipt: true });
  await f.advance(300);
  assert.equal(f.requests.length, 5);
  assert.deepEqual(f.session.savedHeads, A.getHeads(f.session.doc));
  assert.equal(f.session.receiptRetryAttempts, 0);
  assert.equal(
    f.session.status,
    "Offline",
    "receipt success does not claim native connection success",
  );
  assert.equal(f.session.problem, "Native connection unavailable");
});

test("heads advancing before notification cannot let an older receipt claim the new edit", async (t) => {
  for (const phase of ["flush", "response"]) {
    await t.test(phase, async (t) => {
      const f = fixture(t);
      const gate = deferred();
      if (phase === "flush") f.hooks.flush = () => gate.promise;
      await f.start();
      const oldHeads = A.getHeads(f.session.doc);
      f.mutate(); // Intentionally do not notify queueSaved yet.
      if (phase === "flush") {
        f.hooks.flush = undefined;
        gate.resolve();
      } else {
        f.requests[0].resolve(Response.json({ durableHeads: oldHeads }));
      }
      await drain();
      // Heads that move without session.change() are a remote change.
      assert.equal(f.session.status, "Syncing");
      assert.deepEqual(f.session.savedHeads, []);
      await f.advance(300);
      const latest = f.requests.at(-1);
      assert.deepEqual(latest.heads, A.getHeads(f.session.doc));
      latest.resolve(Response.json({ durableHeads: latest.heads }));
      await drain();
      assert.equal(f.session.status, "Saved");
      assert.deepEqual(f.session.savedHeads, A.getHeads(f.session.doc));
    });
  }
});

test("a locally saved same-head cycle asks for a host receipt once connection is available", async (t) => {
  const f = fixture(t);
  f.session.localPage = { document_id: f.session.handle.documentId, pending: true };
  await f.session.saveReceipt();
  assert.equal(f.session.status, "Saved locally");
  assert.equal(f.requests.length, 0);
  await f.session.openConnection(false);
  await f.advance(300);
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
});

test("edits queued during expired sign-in resume after reauthentication at unchanged heads", async (t) => {
  const f = fixture(t);
  f.session.requireSignIn();
  f.mutate();
  f.session.queueSaved();
  await f.advance(300);
  assert.equal(f.requests.length, 0);
  assert.equal(f.session.status, "Sign in to sync");
  assert.equal(f.session.statusKey, "attention");
  assert.equal(f.session.statusRetry, false, "signing in, not Retry, resumes sync");
  await f.session.openConnection(true);
  await f.advance(300);
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
});

test("pre-expiry replies stay stale after reauthentication starts a same-head request", async (t) => {
  for (const oldStatus of [200, 503]) {
    await t.test(String(oldStatus), async (t) => {
      const f = fixture(t);
      await f.start();
      f.session.requireSignIn();
      await f.session.openConnection(true);
      await f.advance(300);
      assert.equal(f.requests.length, 2);
      assert.deepEqual(f.requests[0].heads, f.requests[1].heads);
      f.requests[0].resolve(
        Response.json(
          oldStatus === 200
            ? { durableHeads: f.requests[0].heads }
            : { error: "Expired request failure" },
          { status: oldStatus },
        ),
      );
      await drain();
      assert.equal(f.session.status, "Syncing", "no local edit is waiting on this receipt");
      assert.equal(f.session.problem, "");
      assert.deepEqual(f.session.savedHeads, []);
      assert.equal(f.session.receiptRetryTimer, undefined);
      f.requests[1].resolve(Response.json({ durableHeads: f.requests[1].heads }));
      await drain();
      assert.equal(f.session.status, "Saved");
      assert.deepEqual(f.session.savedHeads, f.requests[1].heads);
    });
  }
});

test("late receipt success cannot overwrite sign-in, access, deletion or closed-session state", async (t) => {
  for (const stop of ["sign-in", "access", "deleted", "closed"]) {
    await t.test(stop, async (t) => {
      const f = fixture(t);
      await f.start();
      if (stop === "sign-in") f.session.requireSignIn();
      else if (stop === "access")
        f.session.pauseForAccess("Removed", { denied: true, checkpoint: false });
      else {
        f.session.skipCloseCheckpoint = true;
        if (stop === "deleted") {
          f.session.phase$.update(() => ({ name: "deleted" }));
          f.session.status = "Deleted";
          f.session.statusId = "deleted";
        }
        await f.session.close();
      }
      const status = f.session.status;
      f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
      await drain();
      assert.equal(f.session.status, status);
      assert.deepEqual(f.session.savedHeads, []);
      assert.equal(f.session.receiptRetryTimer, undefined);
    });
  }
});

test("native completion after socket loss or expired sign-in cannot announce a connection", async (t) => {
  for (const phase of ["setup", "addConnection"]) {
    for (const stop of ["socket", "sign-in"]) {
      await t.test(`${phase}: ${stop}`, async (t) => {
        const f = fixture(t);
        const gate = deferred();
        f.hooks[phase] = () => gate.promise;
        const opening = f.session.openConnection(false);
        await drain();
        assert.equal(f.sockets.length, 1);
        if (stop === "socket") f.session.socketDisconnected(f.sockets[0]);
        else f.session.requireSignIn();
        const status = f.session.status;
        gate.resolve();
        await opening;
        assert.equal(f.session.status, status);
        assert.equal(f.session.savedTimer, undefined);
        assert.equal(f.requests.length, 0);
        assert.equal(f.counts().added, phase === "setup" ? 0 : 1);
        assert.equal(f.counts().freed, phase === "setup" ? 1 : 0);
      });
    }
  }
});

const hostClose = (socket, code, reason) =>
  socket.dispatchEvent(Object.assign(new Event("close"), { code, reason }));

test("refused native admission does not reset reconnect backoff", async (t) => {
  const f = fixture(t);
  await f.start();
  for (const attempts of [1, 2, 3]) {
    const socket = f.sockets.at(-1);
    hostClose(socket, 4503, "temporarily_unavailable");
    f.session.socketDisconnected(socket);
    assert.equal(f.session.retryAttempts, attempts, "an unadmitted socket proves nothing");
    assert.ok(f.session.retryTimer);
    await f.advance(500 * 2 ** (attempts - 1));
    assert.equal(f.sockets.length, attempts + 1);
  }
  // A connection open beyond the stability threshold resets backoff.
  const stable = f.sockets.at(-1);
  f.session.socketAdmittedAt.set(stable, f.session.now() - 20_000);
  hostClose(stable, 4409, "access_changed");
  f.session.socketDisconnected(stable);
  assert.equal(f.session.retryAttempts, 1);
});

test("a refused signing key stops automatic reconnects until an explicit retry", async (t) => {
  const f = fixture(t);
  await f.start();
  const socket = f.sockets.at(-1);
  hostClose(socket, 4422, "signing_key_rejected");
  f.session.socketDisconnected(socket);
  assert.equal(f.session.retryTimer, undefined);
  assert.equal(f.session.nativeRefused, true);
  assert.match(f.session.problem, /refused this tab's signing key/);
  f.session.scheduleReconnect();
  assert.equal(f.session.retryTimer, undefined);
  await f.advance(60_000);
  assert.equal(f.sockets.length, 1, "no automatic reconnect");

  // Refusal during the native handshake is reported the same way.
  f.hooks.setup = () => {
    hostClose(f.sockets.at(-1), 4422, "signing_key_rejected");
    throw Error("Native handshake failed");
  };
  await f.session.retryConnection();
  assert.equal(f.sockets.length, 2, "explicit Retry makes one attempt");
  assert.equal(f.session.nativeRefused, true);
  assert.equal(f.session.retryTimer, undefined);

  f.hooks.setup = undefined;
  await f.session.retryConnection();
  assert.equal(f.session.nativeRefused, false);
  assert.equal(f.session.connectionProblem, "");
});

test("transient and mismatched close outcomes keep normal backoff", async (t) => {
  const f = fixture(t);
  await f.start();
  for (const [code, reason] of [
    [4503, "temporarily_unavailable"],
    [4422, "temporarily_unavailable"],
    [1006, ""],
  ]) {
    const socket = f.sockets.at(-1);
    hostClose(socket, code, reason);
    f.session.socketDisconnected(socket);
    assert.ok(f.session.retryTimer, `${code} ${reason} reconnects`);
    assert.equal(f.session.nativeRefused, false);
    await f.advance(10_000);
  }
});

test("a handshake that never answers times out, backs off and reconnects", async (t) => {
  const f = fixture(t, { random: () => 0 });
  await f.start();
  assert.equal(f.session.reconnect$.snapshot().name, "ready");
  // The host accepts the socket and then says nothing.
  f.hooks.setup = () => new Promise(() => {});
  const stalled = f.sockets.length;
  const attempt = f.session.retryConnection();
  await f.advance(0);
  assert.equal(f.sockets.length, stalled + 1);
  assert.deepEqual(f.session.reconnect$.snapshot(), {
    name: "handshaking",
    attempts: 0,
    refusals: 0,
  });
  assert.ok(f.session.handshakeTimer, "the handshake deadline is armed");
  await f.advance(HANDSHAKE_TIMEOUT_MS - 1);
  assert.equal(f.session.reconnect$.snapshot().name, "handshaking", "still within the deadline");
  assert.equal(f.sockets.at(-1).closed, 0);
  await f.advance(1);
  await attempt;
  // The stalled socket is closed and the attempt fails like any closed socket:
  // Offline without a banner, the first backoff step pending.
  assert.ok(f.sockets.at(-1).closed > 0);
  assert.deepEqual(f.session.reconnect$.snapshot(), { name: "waiting", attempts: 1, refusals: 0 });
  assert.equal(f.session.handshakeTimer, undefined);
  assert.ok(f.session.retryTimer);
  assert.equal(f.session.status, "Offline");
  assert.equal(f.session.connectionProblem, "");
  assert.equal(f.counts().added, 1, "the stalled socket never joined the backend");
  // The host answers on the retry.
  f.hooks.setup = undefined;
  await f.advance(backoffStep(0) / 2);
  assert.equal(f.sockets.length, stalled + 2);
  assert.deepEqual(f.session.reconnect$.snapshot(), { name: "ready", attempts: 1, refusals: 0 });
  assert.equal(f.session.handshakeTimer, undefined);
  assert.equal(f.counts().added, 2);
  assert.notEqual(f.session.status, "Offline");
  await f.advance(HANDSHAKE_TIMEOUT_MS);
  assert.equal(f.sockets.length, stalled + 2, "an admitted socket has no deadline left to fire");
});

test("a slow handshake that answers within the deadline connects without a retry", async (t) => {
  const f = fixture(t);
  await f.start();
  f.hooks.setup = () => new Promise((resolve) => setTimeout(resolve, HANDSHAKE_TIMEOUT_MS - 1));
  const attempt = f.session.retryConnection();
  await f.advance(0);
  assert.equal(f.session.reconnect$.snapshot().name, "handshaking");
  const sockets = f.sockets.length;
  await f.advance(HANDSHAKE_TIMEOUT_MS - 1);
  await attempt;
  assert.deepEqual(f.session.reconnect$.snapshot(), { name: "ready", attempts: 0, refusals: 0 });
  assert.equal(f.session.handshakeTimer, undefined);
  assert.equal(f.session.retryTimer, undefined);
  assert.equal(f.counts().added, 2);
  assert.equal(f.sockets.at(-1).closed, 0);
  await f.advance(HANDSHAKE_TIMEOUT_MS * 2);
  assert.equal(f.sockets.length, sockets, "no retry follows a handshake that finished in time");
  assert.equal(f.session.reconnect$.snapshot().name, "ready");
});

test("Retry during a stalled handshake abandons it and the next attempt connects at once", async (t) => {
  const f = fixture(t, { random: () => 0 });
  await f.start();
  f.hooks.setup = () => new Promise(() => {});
  const stalled = f.session.retryConnection();
  await f.advance(1000);
  assert.equal(f.session.reconnect$.snapshot().name, "handshaking");
  const socket = f.sockets.at(-1);
  f.hooks.setup = undefined;
  const retried = f.session.retryConnection();
  await f.advance(0);
  assert.ok(socket.closed > 0, "Retry gives up on the silent socket");
  await Promise.all([stalled, retried]);
  // The abandoned attempt schedules nothing; Retry's own attempt connected.
  assert.equal(f.session.handshakeTimer, undefined);
  assert.equal(f.session.retryTimer, undefined);
  assert.deepEqual(f.session.reconnect$.snapshot(), { name: "ready", attempts: 0, refusals: 0 });
  assert.equal(f.counts().added, 2);
  assert.equal(f.session.connecting, undefined);
  assert.notEqual(f.session.status, "Offline");
});

test("sign-in loss during a stalled handshake settles the attempt, and Retry after sign-in connects", async (t) => {
  const f = fixture(t);
  await f.start();
  f.hooks.setup = () => new Promise(() => {});
  const stalled = f.session.retryConnection();
  await f.advance(1000);
  assert.equal(f.session.reconnect$.snapshot().name, "handshaking");
  const socket = f.sockets.at(-1);
  // The session's phase stops sync: the deadline is dropped and the pending
  // attempt ends, so connecting is free for the attempt after sign-in.
  f.session.requireSignIn();
  await stalled;
  assert.equal(f.session.authRequired, true);
  assert.equal(f.session.status, "Sign in to sync");
  assert.ok(socket.closed > 0);
  assert.equal(f.session.handshakeTimer, undefined);
  assert.equal(f.session.connecting, undefined, "the stalled attempt no longer holds connect()");
  assert.deepEqual(f.session.reconnect$.snapshot(), { name: "ready", attempts: 0, refusals: 0 });
  await f.advance(HANDSHAKE_TIMEOUT_MS * 2);
  assert.equal(f.sockets.length, 2, "nothing retries while sign-in is required");
  // Signing in again (the fixture's refreshSession answers) and Retry connect.
  f.hooks.setup = undefined;
  await f.session.retryConnection();
  assert.equal(f.session.authRequired, false);
  assert.equal(f.counts().added, 2);
  assert.equal(f.session.reconnect$.snapshot().name, "ready");
  assert.equal(f.sockets.length, 3);
});

test("a handshake that answers after its timeout is disposed while the successor keeps its own deadline", async (t) => {
  const f = fixture(t, { random: () => 0 });
  await f.start();
  const late = deferred();
  f.hooks.setup = () => late.promise;
  const attempt = f.session.retryConnection();
  await f.advance(0);
  assert.equal(f.session.reconnect$.snapshot().name, "handshaking");
  await f.advance(HANDSHAKE_TIMEOUT_MS);
  await attempt;
  assert.deepEqual(f.session.reconnect$.snapshot(), { name: "waiting", attempts: 1, refusals: 0 });
  const successor = deferred();
  f.hooks.setup = () => successor.promise;
  await f.advance(backoffStep(0) / 2);
  assert.equal(f.session.reconnect$.snapshot().name, "handshaking");
  const deadline = f.session.handshakeTimer;
  assert.ok(deadline);
  const freedBefore = f.counts().freed;
  // The abandoned socket's handshake finishes now.
  late.resolve();
  await drain();
  assert.equal(f.counts().freed, freedBefore + 1, "the late wrapper is freed");
  assert.equal(f.counts().added, 1, "it installs nothing");
  assert.equal(f.session.reconnect$.snapshot().name, "handshaking", "the successor is untouched");
  assert.equal(f.session.handshakeTimer, deadline, "its deadline is intact");
  successor.resolve();
  await drain();
  assert.deepEqual(f.session.reconnect$.snapshot(), { name: "ready", attempts: 1, refusals: 0 });
  assert.equal(f.counts().added, 2);
  assert.equal(f.session.connecting, undefined);
  await f.advance(HANDSHAKE_TIMEOUT_MS * 2);
  assert.equal(f.sockets.length, 3, "no deadline fires after admission");
});

test("at the deadline, whichever of the handshake and the timer lands first wins alone", async (t) => {
  for (const order of ["handshake-then-timer", "timer-then-handshake"]) {
    await t.test(order, async (t) => {
      const f = fixture(t, { random: () => 0 });
      await f.start();
      const transitions = [];
      f.session.reconnect$.select((state) => state).subscribe((state) => transitions.push(state));
      const setup = deferred();
      f.hooks.setup = () => setup.promise;
      const attempt = f.session.retryConnection();
      await f.advance(0);
      await f.advance(HANDSHAKE_TIMEOUT_MS - 1);
      assert.equal(f.session.reconnect$.snapshot().name, "handshaking");
      transitions.length = 0;
      if (order === "handshake-then-timer") {
        setup.resolve();
        await drain();
        await f.advance(1);
      } else {
        await f.advance(1);
        setup.resolve();
        await drain();
      }
      await attempt;
      assert.equal(f.session.connecting, undefined, "connect() is released");
      if (order === "handshake-then-timer") {
        assert.deepEqual(transitions, [{ name: "ready", attempts: 0, refusals: 0 }]);
        assert.equal(f.session.retryTimer, undefined, "no retry");
        assert.equal(f.counts().added, 2);
        assert.equal(f.counts().freed, 0);
      } else {
        assert.deepEqual(transitions, [{ name: "waiting", attempts: 1, refusals: 0 }]);
        assert.ok(f.session.retryTimer, "exactly one retry is pending");
        assert.equal(f.counts().added, 1, "the late handshake installs nothing");
        assert.equal(f.counts().freed, 1, "and is disposed");
        f.hooks.setup = undefined;
        await f.advance(backoffStep(0) / 2);
        assert.deepEqual(transitions.at(-1), { name: "ready", attempts: 1, refusals: 0 });
        assert.equal(f.counts().added, 2);
      }
      assert.equal(f.session.handshakeTimer, undefined);
      await f.advance(HANDSHAKE_TIMEOUT_MS * 2);
      assert.equal(f.sockets.length, order === "handshake-then-timer" ? 2 : 3);
    });
  }
});

/** After a handshake and its deadline raced, exactly one of them settled the
 * attempt: the socket was installed, or the late wrapper was disposed and one
 * retry is pending. Returns which. */
function assertOneWinner(f, transitions) {
  assert.equal(
    transitions.length,
    1,
    `one terminal transition, got ${JSON.stringify(transitions)}`,
  );
  assert.equal(f.session.connecting, undefined, "connect() is released");
  assert.equal(f.session.handshakeTimer, undefined, "no deadline is left armed");
  const [{ name }] = transitions;
  if (name === "ready") {
    assert.equal(f.counts().added, 2, "the socket joined the backend once");
    assert.equal(f.counts().freed, 0);
    assert.equal(f.session.retryTimer, undefined, "no retry");
  } else {
    assert.equal(name, "waiting");
    assert.equal(f.counts().added, 1, "the late handshake installs nothing");
    assert.equal(f.counts().freed, 1, "and its wrapper is disposed once");
    assert.ok(f.session.retryTimer, "exactly one retry is pending");
  }
  return name;
}

test("a same-tick tie between the handshake and its deadline has exactly one winner, in either order", async (t) => {
  for (const order of ["setup-then-timer", "timer-then-setup"]) {
    await t.test(order, async (t) => {
      const f = fixture(t, { random: () => 0 });
      await f.start();
      const transitions = [];
      f.session.reconnect$.select((state) => state).subscribe((state) => transitions.push(state));
      const setup = deferred();
      f.hooks.setup = () => setup.promise;
      const attempt = f.session.retryConnection();
      await f.advance(0);
      await f.advance(HANDSHAKE_TIMEOUT_MS - 1);
      assert.equal(f.session.reconnect$.snapshot().name, "handshaking");
      transitions.length = 0;
      // No drain between the two: both land in one tick.
      if (order === "setup-then-timer") {
        setup.resolve();
        t.mock.timers.tick(1);
      } else {
        t.mock.timers.tick(1);
        setup.resolve();
      }
      await drain();
      await attempt;
      const winner = assertOneWinner(f, transitions);
      // The timer callback runs inside the tick and setup's resolution is a
      // microtask, so the deadline wins both orders; the shape holds either way.
      assert.equal(winner, "waiting");
      await f.advance(HANDSHAKE_TIMEOUT_MS * 2);
      // Only the retry follows: its backoff timer, its own handshake under its
      // own deadline, and its admission. The loser fires nothing late.
      assert.deepEqual(
        transitions.map((state) => state.name),
        ["waiting", "ready", "handshaking", "ready"],
      );
      assert.equal(f.counts().added, 2);
      assert.equal(f.counts().freed, 1);
      assert.equal(f.sockets.length, 3);
    });
  }
});

test("a late winner never disturbs the successor's deadline", async (t) => {
  const f = fixture(t, { random: () => 0 });
  await f.start();
  const first = deferred();
  f.hooks.setup = () => first.promise;
  const attempt = f.session.retryConnection();
  await f.advance(0);
  // The timer wins outright and the retry starts its own handshake.
  await f.advance(HANDSHAKE_TIMEOUT_MS);
  await attempt;
  const successor = deferred();
  f.hooks.setup = () => successor.promise;
  await f.advance(backoffStep(0) / 2);
  assert.equal(f.session.reconnect$.snapshot().name, "handshaking");
  const deadline = f.session.handshakeTimer;
  const transitions = [];
  f.session.reconnect$.select((state) => state).subscribe((state) => transitions.push(state));
  transitions.length = 0;
  first.resolve();
  await drain();
  assert.deepEqual(transitions, [], "the loser's late result changes nothing");
  assert.equal(f.session.handshakeTimer, deadline);
  assert.equal(f.counts().freed, 1);
  await f.advance(HANDSHAKE_TIMEOUT_MS - 1);
  assert.equal(
    f.session.reconnect$.snapshot().name,
    "handshaking",
    "the successor's full deadline",
  );
  successor.resolve();
  await drain();
  assert.deepEqual(transitions, [{ name: "ready", attempts: 1, refusals: 0 }]);
  assert.equal(f.counts().added, 2);
});

test("the socket's disconnect callback under a pending setup settles the attempt and backs off", async (t) => {
  const f = fixture(t, { random: () => 0 });
  await f.start();
  const setup = deferred();
  f.hooks.setup = () => setup.promise;
  const attempt = f.session.retryConnection();
  await f.advance(1000);
  assert.equal(f.session.reconnect$.snapshot().name, "handshaking");
  const socket = f.sockets.at(-1);
  const transitions = [];
  f.session.reconnect$.select((state) => state).subscribe((state) => transitions.push(state));
  transitions.length = 0;
  // The native wrapper reports the close itself; setup stays pending.
  f.hooks.disconnect();
  await drain();
  await attempt;
  assert.deepEqual(transitions, [{ name: "waiting", attempts: 1, refusals: 0 }]);
  assert.equal(f.session.connecting, undefined, "the pending setup no longer holds connect()");
  assert.equal(f.session.handshakeTimer, undefined);
  assert.ok(socket.closed > 0);
  assert.equal(f.session.status, "Reconnecting");
  // Its late answer is disposed; the retry connects on the first backoff step.
  setup.resolve();
  await drain();
  assert.equal(f.counts().freed, 1);
  assert.equal(f.counts().added, 1);
  assert.equal(transitions.length, 1);
  f.hooks.setup = undefined;
  await f.advance(backoffStep(0) / 2);
  assert.deepEqual(transitions.at(-1), { name: "ready", attempts: 1, refusals: 0 });
  assert.equal(f.counts().added, 2);
  await f.advance(HANDSHAKE_TIMEOUT_MS * 2);
  assert.equal(f.sockets.length, 3);
});

test("a socket closed before its handshake retries on the first backoff step", async (t) => {
  const f = fixture(t, { random: () => 0 });
  await f.start();
  // What Subduction rejects with when the socket closes mid-handshake: no
  // status, no admission code.
  f.hooks.setup = () => {
    throw Error("handshake failed: transport error: inbound channel closed");
  };
  const sockets = f.sockets.length;
  await f.session.retryConnection();
  assert.deepEqual(f.session.reconnect$.snapshot(), { name: "waiting", attempts: 1, refusals: 0 });
  assert.equal(f.session.handshakeTimer, undefined, "the deadline ends with the handshake");
  assert.ok(f.session.retryTimer);
  f.hooks.setup = undefined;
  await f.advance(backoffStep(0) / 2);
  assert.equal(f.sockets.length, sockets + 2);
  assert.equal(f.session.reconnect$.snapshot().name, "ready");
  assert.equal(f.counts().added, 2);
});

test("jittered reconnect delays stay within [step / 2, step] up to a 60 s ceiling", async (t) => {
  // random() = 0 retries at exactly half the step; just under 1 at the step.
  for (const [label, random, share] of [
    ["lower bound", () => 0, 0.5],
    ["upper bound", () => 0.999_999, 1],
  ]) {
    await t.test(label, async (t) => {
      const f = fixture(t, { random });
      await f.start();
      // Transient: the native connection fails without an admission close.
      f.hooks.setup = () => {
        throw Error("Native connection unavailable");
      };
      f.session.socketDisconnected(f.sockets.at(-1));
      const steps = [];
      for (let attempts = 0; attempts < 10; attempts++) {
        const step = backoffStep(attempts);
        steps.push(step);
        const delay = step * share;
        const before = f.sockets.length;
        await f.advance(delay - 1);
        assert.equal(f.sockets.length, before, `no retry before ${delay} ms`);
        await f.advance(1);
        assert.equal(f.sockets.length, before + 1, `a retry at ${delay} ms`);
        assert.equal(f.session.retryAttempts, attempts + 2);
        assert.ok(f.session.retryTimer, "transient failures keep backing off");
      }
      assert.deepEqual(steps.slice(-3), [60_000, 60_000, 60_000]);
      assert.equal(f.session.syncPaused, false);
      assert.equal(f.session.reconnect$.snapshot().refusals, 0);
      assert.equal(f.session.status, "Offline");
      assert.equal(f.session.connectionProblem, "Native connection unavailable");
    });
  }
});

/** Refuse native admission with `code` until sync pauses. `handshake`
 * refuses during the native handshake; otherwise each retry is admitted
 * and the host closes it before it proves stable. Returns the refusals. */
async function refuseUntilPaused(f, code, reason, { handshake }) {
  if (handshake)
    f.hooks.setup = () => {
      hostClose(f.sockets.at(-1), code, reason);
      throw Error("Native handshake failed");
    };
  // The live socket is the first refusal; each retry adds one.
  let refusals = 0;
  for (;;) {
    if (refusals === 0 || !handshake) {
      const socket = f.sockets.at(-1);
      hostClose(socket, code, reason);
      f.session.socketDisconnected(socket);
    }
    refusals++;
    assert.equal(f.session.reconnect$.snapshot().refusals, refusals);
    if (refusals === REFUSAL_LIMIT) return refusals;
    assert.equal(f.session.syncPaused, false);
    assert.ok(f.session.retryTimer);
    await f.advance(backoffStep(f.session.retryAttempts - 1));
  }
}

test("repeated admission refusals pause sync until Retry or online", async (t) => {
  for (const [code, reason, handshake] of [
    [4409, "access_changed", true],
    [4503, "temporarily_unavailable", false],
  ]) {
    await t.test(`${code} ${handshake ? "during the handshake" : "after admission"}`, async (t) => {
      const f = fixture(t);
      const online = new EventTarget();
      globalThis.addEventListener = online.addEventListener.bind(online);
      globalThis.removeEventListener = online.removeEventListener.bind(online);
      t.after(() => {
        delete globalThis.addEventListener;
        delete globalThis.removeEventListener;
      });
      await f.start();
      f.session.watchOnline();
      await refuseUntilPaused(f, code, reason, { handshake });
      assert.equal(f.sockets.length, REFUSAL_LIMIT, "one socket per attempt");
      assert.equal(f.session.syncPaused, true);
      assert.equal(f.session.retryTimer, undefined);
      assert.match(f.session.problem, /^Sync paused/);
      assert.match(f.session.problem, /Retry to reconnect/);
      assert.equal(f.session.status, "Offline", "the Retry control is shown");
      await f.advance(3_600_000);
      assert.equal(f.sockets.length, REFUSAL_LIMIT, "no automatic retries while paused");

      // Retry clears the pause and attempts at once.
      await f.session.retryConnection({ retryReceipt: true });
      if (!handshake) {
        const socket = f.sockets.at(-1);
        hostClose(socket, code, reason);
        f.session.socketDisconnected(socket);
      }
      assert.equal(f.sockets.length, REFUSAL_LIMIT + 1);
      assert.equal(f.session.syncPaused, false);
      assert.equal(f.session.reconnect$.snapshot().refusals, 1, "Retry starts a fresh count");
      assert.equal(f.session.retryAttempts, 1, "and a fresh backoff");
      assert.ok(f.session.retryTimer);
      await f.advance(backoffStep(0));

      // Pause again; coming back online resumes.
      let refusals = 1;
      for (; refusals < REFUSAL_LIMIT; refusals++) {
        if (!handshake) {
          const socket = f.sockets.at(-1);
          hostClose(socket, code, reason);
          f.session.socketDisconnected(socket);
        }
        if (refusals + 1 < REFUSAL_LIMIT) await f.advance(backoffStep(refusals));
      }
      assert.equal(f.session.syncPaused, true);
      const paused = f.sockets.length;
      f.hooks.setup = undefined;
      online.dispatchEvent(new Event("online"));
      await drain();
      assert.equal(f.sockets.length, paused + 1);
      assert.equal(f.session.syncPaused, false);
      assert.equal(f.session.retryTimer, undefined, "the host admitted the new socket");
      assert.equal(f.session.connectionProblem, "");
      assert.doesNotMatch(f.session.problem, /Sync paused/);
    });
  }
});

test("a connection admitted past the stability threshold clears both counters", async (t) => {
  const f = fixture(t);
  await f.start();
  f.hooks.setup = () => {
    hostClose(f.sockets.at(-1), 4409, "access_changed");
    throw Error("Native handshake failed");
  };
  const first = f.sockets.at(-1);
  hostClose(first, 4409, "access_changed");
  f.session.socketDisconnected(first);
  for (const delay of [500, 1000]) await f.advance(delay);
  assert.equal(f.session.reconnect$.snapshot().refusals, 3);
  assert.equal(f.session.retryAttempts, 3);

  // The host admits the next socket and keeps it longer than the threshold.
  f.hooks.setup = undefined;
  await f.advance(2000);
  assert.equal(f.session.retryTimer, undefined);
  const stable = f.sockets.at(-1);
  f.session.socketAdmittedAt.set(stable, f.session.now() - 20_000);
  hostClose(stable, 1006, "");
  f.session.socketDisconnected(stable);
  assert.deepEqual(f.session.reconnect$.snapshot(), { name: "waiting", attempts: 1, refusals: 0 });

  // The same admission close on a stable socket is not a refusal either.
  await f.advance(500);
  const proven = f.sockets.at(-1);
  f.session.socketAdmittedAt.set(proven, f.session.now() - 20_000);
  hostClose(proven, 4409, "access_changed");
  f.session.socketDisconnected(proven);
  assert.deepEqual(f.session.reconnect$.snapshot(), { name: "waiting", attempts: 1, refusals: 0 });
});

test("a refusal the next discovery answers with 401 or 403 stops there", async (t) => {
  for (const [code, reason, status] of [
    [4401, "sign_in_required", 401],
    [4403, "page_access_denied", 403],
  ]) {
    await t.test(String(code), async (t) => {
      const f = fixture(t);
      await f.start();
      const socket = f.sockets.at(-1);
      hostClose(socket, code, reason);
      f.session.socketDisconnected(socket);
      assert.equal(f.session.reconnect$.snapshot().refusals, 1);
      f.hooks.connect = () => Response.json({ error: "Stopped" }, { status });
      await f.advance(500);
      assert.equal(f.sockets.length, 1, "discovery stopped before another socket");
      assert.equal(f.session.retryTimer, undefined);
      if (status === 401) assert.equal(f.session.authRequired, true);
      else assert.equal(f.session.accessDenied, true);
      assert.equal(f.session.syncPaused, false);
      await f.advance(3_600_000);
      assert.equal(f.sockets.length, 1);
    });
  }
});

// A deploy restarts the host: for a few seconds the gateway answers with its
// own error page, or the connection fails outright.
const cloudflare503 = () =>
  new Response("<!DOCTYPE html><title>503: origin unreachable | Cloudflare</title>", {
    status: 503,
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
const restartFailures = [
  ["Cloudflare's HTML 503", { connect: cloudflare503 }],
  ["an empty 502", { connect: () => new Response(null, { status: 502 }) }],
  [
    "a JSON 504",
    { connect: () => Response.json({ error: "Pages request failed" }, { status: 504 }) },
  ],
  [
    "a retryable JSON 500",
    {
      connect: () =>
        Response.json({ error: "Host busy", code: "host_busy", retryable: true }, { status: 500 }),
    },
  ],
  [
    "a lost connection",
    {
      connect: () => {
        throw new TypeError("Failed to fetch");
      },
    },
  ],
  [
    "a 503 from the session refresh",
    {
      refresh: () => {
        throw Object.assign(Error("The server returned an unexpected response (503)"), {
          code: "INVALID_RESPONSE",
          status: 503,
          httpStatus: 503,
        });
      },
    },
  ],
];

/** Drop the live socket and fail `failures` reconnect attempts in a row with
 * random() = 0, so each retry waits exactly half its backoff step. */
async function failReconnects(f, failures) {
  f.session.socketDisconnected(f.sockets.at(-1));
  for (let i = 1; i < failures; i++) await f.advance(backoffStep(f.session.retryAttempts - 1) / 2);
}
function failWith(f, { connect, refresh }) {
  if (connect) f.hooks.connect = connect;
  if (refresh) {
    const working = f.session.refreshSession;
    f.session.refreshSession = async () => refresh();
    return () => {
      f.hooks.connect = undefined;
      f.session.refreshSession = working;
    };
  }
  return () => {
    f.hooks.connect = undefined;
  };
}

test("a brief host restart shows Offline without a banner, then Saved", async (t) => {
  for (const [label, failure] of restartFailures) {
    await t.test(label, async (t) => {
      const f = fixture(t, { random: () => 0 });
      await f.start();
      f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
      await drain();
      assert.equal(f.session.status, "Saved");

      const recover = failWith(f, failure);
      await failReconnects(f, 3);
      assert.equal(f.session.status, "Offline");
      assert.equal(f.session.problem, "", "a transient failure is not a banner");
      assert.equal(f.session.connectionProblem, "");
      assert.ok(f.session.retryTimer, "it keeps retrying");

      // An edit during the restart saves once the host answers again.
      f.mutate("Typed during the restart");
      recover();
      await f.advance(backoffStep(f.session.retryAttempts - 1) / 2);
      assert.equal(f.session.retryTimer, undefined, "the host admitted the next socket");
      await f.advance(300);
      const receipt = f.requests.at(-1);
      assert.deepEqual(receipt.heads, A.getHeads(f.session.doc));
      receipt.resolve(Response.json({ durableHeads: receipt.heads }));
      await drain();
      assert.equal(f.session.status, "Saved");
      assert.equal(f.session.problem, "");
      assert.equal(f.session.unreachable, false);
    });
  }
});

test("an outage past the reconnect threshold shows one plain sentence until the host returns", async (t) => {
  const f = fixture(t, { random: () => 0 });
  await f.start();
  f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
  await drain();
  f.hooks.connect = cloudflare503;
  await failReconnects(f, OUTAGE_ATTEMPTS - 1);
  assert.equal(f.session.problem, "", "no banner before the threshold");
  await f.advance(backoffStep(f.session.retryAttempts - 1) / 2);
  assert.equal(f.session.retryAttempts, OUTAGE_ATTEMPTS);
  assert.equal(f.session.problem, SERVER_UNREACHABLE);
  assert.doesNotMatch(f.session.problem, /\d{3}/, "no status code");
  assert.equal(f.session.status, "Offline");
  assert.ok(f.session.retryTimer, "retries continue past the report");
  // Later failures repeat the report; it stays one sentence.
  await f.advance(backoffStep(f.session.retryAttempts - 1) / 2);
  assert.equal(f.session.problem, SERVER_UNREACHABLE);

  f.hooks.connect = undefined;
  f.mutate("Typed during the outage");
  await f.advance(backoffStep(f.session.retryAttempts - 1) / 2);
  assert.equal(f.session.problem, "", "the banner leaves with the outage");
  await f.advance(300);
  const receipt = f.requests.at(-1);
  receipt.resolve(Response.json({ durableHeads: receipt.heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
  assert.equal(f.session.problem, "");
});

test("an outage keeps a specific connection failure in front of the plain sentence", async (t) => {
  const f = fixture(t, { random: () => 0 });
  await f.start();
  f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
  await drain();
  f.hooks.connect = () => Response.json({ error: "Storage is read-only" }, { status: 500 });
  await failReconnects(f, 2);
  assert.equal(f.session.problem, "Storage is read-only");
  f.hooks.connect = cloudflare503;
  while (f.session.retryAttempts < OUTAGE_ATTEMPTS + 1)
    await f.advance(backoffStep(f.session.retryAttempts - 1) / 2);
  assert.equal(f.session.problem, "Storage is read-only");
  assert.equal(f.session.status, "Offline");
});

test("transient receipt failures retry quietly; an outage reports once and reconnect restarts it", async (t) => {
  for (const respond of [
    () => cloudflare503(),
    () => Response.json({ error: "Pages request failed" }, { status: 503 }),
  ]) {
    await t.test(String(respond().status), async (t) => {
      const f = fixture(t);
      f.hooks.receipt = respond;
      await f.start();
      assert.equal(f.requests.length, 1);
      assert.equal(f.session.status, "Not saved");
      assert.equal(f.session.problem, "");
      // A short outage recovers on a retry, without a banner.
      for (let attempt = 0; attempt < 2; attempt++) {
        await f.advance(backoffStep(attempt));
        assert.equal(f.session.problem, "");
      }
      f.hooks.receipt = ({ heads }) => Response.json({ durableHeads: heads });
      await f.advance(backoffStep(2));
      assert.equal(f.session.status, "Saved");
      assert.equal(f.session.problem, "");

      // A long one spends the retries and reports in a plain sentence.
      f.hooks.receipt = respond;
      f.mutate("Typed during the outage");
      f.session.queueSaved();
      await f.advance(300);
      for (let attempt = 0; attempt < OUTAGE_ATTEMPTS - 1; attempt++) {
        assert.equal(f.session.problem, "");
        await f.advance(backoffStep(attempt));
      }
      assert.equal(f.session.problem, SERVER_UNREACHABLE);
      assert.equal(f.session.receiptRetryTimer, undefined);
      const spent = f.requests.length;
      await f.advance(3_600_000);
      assert.equal(f.requests.length, spent, "no retries once spent");

      // The next admitted connection restarts the receipt.
      f.hooks.receipt = ({ heads }) => Response.json({ durableHeads: heads });
      await f.session.openConnection(false);
      await f.advance(300);
      assert.equal(f.requests.length, spent + 1);
      assert.equal(f.session.status, "Saved");
      assert.equal(f.session.problem, "");
    });
  }
});

test("edits during a receipt outage don't restart its quiet window; one success clears it", async (t) => {
  const f = fixture(t, { date: true });
  f.hooks.receipt = () => cloudflare503();
  await f.start();
  assert.equal(f.requests.length, 1, "the first receipt failed");
  const startedAt = Date.now();
  assert.equal(f.session.problem, "");
  // Keep typing every 1.5 s. Each edit starts a new receipt revision with a
  // fresh retry budget, and each receipt fails.
  let edits = 0;
  while (Date.now() - startedAt < OUTAGE_MS - 1500) {
    f.mutate(`Edit ${++edits}`);
    f.session.queueSaved();
    assert.equal(f.session.problem, "", `quiet after ${Date.now() - startedAt} ms`);
    await f.advance(1500);
  }
  assert.equal(f.session.problem, "");
  assert.ok(f.requests.length > edits, "every edit asked for a receipt");
  // The failure after the threshold reports the outage, despite the edits.
  for (let i = 0; i < 2; i++) {
    f.mutate(`Edit ${++edits}`);
    f.session.queueSaved();
    await f.advance(1500);
  }
  assert.equal(f.session.problem, SERVER_UNREACHABLE);
  assert.equal(f.session.receiptState.outage, true);
  // More edits keep it on screen, including while their receipt is pending.
  for (let i = 0; i < 3; i++) {
    f.mutate(`Edit ${++edits}`);
    f.session.queueSaved();
    assert.equal(f.session.problem, SERVER_UNREACHABLE);
    await f.advance(1500);
    assert.equal(f.session.problem, SERVER_UNREACHABLE);
  }
  // One successful receipt clears it and ends the run.
  f.hooks.receipt = ({ heads }) => Response.json({ durableHeads: heads });
  f.mutate("Saved at last");
  f.session.queueSaved();
  await f.advance(300);
  assert.equal(f.session.status, "Saved");
  assert.equal(f.session.problem, "");
  assert.equal(f.session.receiptOutageSince, null);
  // A new failure starts a new quiet window.
  f.hooks.receipt = () => cloudflare503();
  f.mutate("After the outage");
  f.session.queueSaved();
  await f.advance(300);
  assert.equal(f.session.problem, "");
});

test("a wall-clock jump during a receipt outage neither hides nor hastens the notice", async (t) => {
  for (const jump of [-3_600_000, 3_600_000]) {
    await t.test(jump < 0 ? "an hour back" : "an hour forward", async (t) => {
      const f = fixture(t, { date: true });
      f.hooks.receipt = () => cloudflare503();
      await f.start();
      const quiet = async (ms) => {
        for (let spent = 0; spent < ms; spent += 1500) {
          f.mutate(`Edit at ${spent}`);
          f.session.queueSaved();
          await f.advance(1500);
        }
      };
      await quiet(6000);
      f.jumpWall(jump);
      assert.equal(f.session.problem, "");
      // Forward: the next failures stay quiet until 20 s of outage.
      await quiet(OUTAGE_MS - 9000);
      assert.equal(f.session.problem, "", "no notice before the threshold");
      // Back: the notice still comes once 20 s have passed.
      await quiet(4500);
      assert.equal(f.session.problem, SERVER_UNREACHABLE);
    });
  }
});

test("signing out during an outage drops the stale outage notice for the sign-in prompt", async (t) => {
  const f = fixture(t, { random: () => 0 });
  await f.start();
  f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
  await drain();
  f.hooks.connect = cloudflare503;
  await failReconnects(f, OUTAGE_ATTEMPTS);
  assert.equal(f.session.problem, SERVER_UNREACHABLE);
  // A renewal answers 401: the viewer hands the Page a signed-out session.
  assert.equal(f.session.acceptAuthentication({ identity: null, canWrite: false }), false);
  assert.equal(f.session.authRequired, true);
  assert.equal(f.session.status, "Sign in to sync");
  assert.match(f.session.authProblem, /^Sign in again/);
  assert.equal(f.session.problem, "", "the prompt is the only notice");
});

test("a wall-clock jump doesn't change whether a socket proved stable", async (t) => {
  for (const [label, jump, open] of [
    ["forward, closed at once", 3_600_000, 0],
    ["back, open 20 s", -3_600_000, 20_000],
  ]) {
    await t.test(label, async (t) => {
      const f = fixture(t, { date: true });
      await f.start();
      // Two quick admission refusals build up the backoff.
      for (const attempts of [1, 2]) {
        hostClose(f.sockets.at(-1), 4503, "temporarily_unavailable");
        f.session.socketDisconnected(f.sockets.at(-1));
        assert.equal(f.session.retryAttempts, attempts);
        await f.advance(500 * 2 ** (attempts - 1));
      }
      // The next socket is admitted; the wall clock jumps while it is open.
      const socket = f.sockets.at(-1);
      assert.ok(f.session.socketAdmittedAt.has(socket));
      await f.advance(open);
      f.jumpWall(jump);
      hostClose(socket, 4503, "temporarily_unavailable");
      f.session.socketDisconnected(socket);
      // Stable only if it was open 15 s on the monotonic clock.
      assert.equal(f.session.retryAttempts, open >= 15_000 ? 1 : 3);
    });
  }
});

test("catching up on remote changes after a reopen is syncing; only a local edit is saving", async (t) => {
  const f = fixture(t);
  f.session.syncStatus({ type: "opened", pending: false });
  const seen = [];
  f.session.subscribe(() => seen.push(f.session.statusId));
  await f.session.openConnection(false);
  assert.equal(f.session.status, "Syncing", "the connect receipt only syncs");
  // Remote batches keep arriving while the host catches this replica up.
  for (let i = 0; i < 5; i++) {
    f.mutate(`Remote ${i}`);
    f.session.receiveChange({});
    await f.advance(100);
  }
  assert.ok(!seen.includes("saving"), `catch-up is never saving: ${seen.join(", ")}`);
  await f.advance(300);
  const caughtUp = f.requests.at(-1);
  caughtUp.resolve(Response.json({ durableHeads: caughtUp.heads }));
  await drain();
  assert.equal(f.session.status, "Saved");

  await f.session.change((doc) => A.updateText(doc, ["text"], "Typed here"));
  assert.equal(f.session.statusId, "saving");
  // A remote change during the save keeps the edit pending.
  f.mutate("Remote during save");
  f.session.receiveChange({});
  assert.equal(f.session.statusId, "saving");
  await f.advance(300);
  const latest = f.requests.at(-1);
  assert.deepEqual(latest.heads, A.getHeads(f.session.doc));
  latest.resolve(Response.json({ durableHeads: latest.heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
  assert.equal(f.session.sync$.snapshot().pending, false);
});

test("a checkpoint left before its receipt reopens as Saving until the host acknowledges it", async (t) => {
  const f = fixture(t);
  f.session.syncStatus({ type: "opened", pending: true });
  await f.session.openConnection(false);
  assert.equal(f.session.statusId, "saving");
  await f.advance(300);
  f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
  f.mutate("Remote after the save");
  f.session.receiveChange({});
  assert.equal(f.session.status, "Syncing");
});

// The slow-save threshold in virtual time. A save shows nothing for its first
// SLOW_SAVE_MS, measured from the latest local edit; after that it shows
// Saving until the receipt is acknowledged or fails.
async function savedFixture(t) {
  const f = fixture(t);
  await f.start();
  f.requests[0].resolve(Response.json({ durableHeads: f.requests[0].heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
  const keys = [];
  const unsubscribe = f.session.subscribe(() => keys.push(f.session.statusKey));
  t.after(unsubscribe);
  const edit = (text) => f.session.change((doc) => A.updateText(doc, ["text"], text));
  return { ...f, keys, edit };
}

test("a fast save never shows Saving", async (t) => {
  const f = await savedFixture(t);
  await f.edit("Typed here");
  assert.equal(f.session.statusId, "saving", "the reload gate reads it as saving");
  assert.equal(f.session.status, "Syncing", "people read Syncing");
  assert.equal(f.session.statusKey, "quiet");
  await f.advance(300);
  assert.equal(f.requests.length, 2, "the debounced receipt is out");
  await f.advance(500);
  f.requests[1].resolve(Response.json({ durableHeads: f.requests[1].heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
  assert.equal(f.session.slowSaveTimer, undefined, "the acknowledgement disarms the timer");
  await f.advance(SLOW_SAVE_MS * 2);
  assert.ok(!f.keys.includes("saving"), f.keys.join(", "));
});

test("typing longer than the threshold stays quiet until typing stops", async (t) => {
  const f = await savedFixture(t);
  // Ten seconds of typing, a keystroke every 250 ms: the receipt debounce
  // never fires, and every edit re-arms the threshold.
  for (let i = 0; i < 40; i++) {
    await f.edit(`Typing ${i}`);
    await f.advance(250);
  }
  assert.equal(f.requests.length, 1, "no receipt went out while typing");
  assert.ok(!f.keys.includes("saving"), f.keys.join(", "));
  // Typing stopped 250 ms ago. The receipt goes out at 300 ms and is still
  // pending SLOW_SAVE_MS after the last keystroke.
  await f.advance(SLOW_SAVE_MS - 251);
  assert.equal(f.requests.length, 2);
  assert.equal(f.session.statusKey, "quiet");
  await f.advance(1);
  assert.equal(f.session.statusKey, "saving");
  f.requests[1].resolve(Response.json({ durableHeads: f.requests[1].heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
});

test("a slow save shows Saving at the threshold", async (t) => {
  const f = await savedFixture(t);
  await f.edit("Typed here");
  await f.advance(SLOW_SAVE_MS - 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.session.statusKey, "quiet");
  assert.ok(!f.keys.includes("saving"));
  await f.advance(1);
  assert.equal(f.session.statusId, "saving");
  assert.equal(f.session.statusKey, "saving");
  // A remote change while Saving shows keeps it showing.
  f.mutate("Remote during save");
  f.session.receiveChange({});
  assert.equal(f.session.statusKey, "saving");
  await f.advance(300);
  const latest = f.requests.at(-1);
  latest.resolve(Response.json({ durableHeads: latest.heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
  assert.equal(f.session.statusKey, "saved");
});

test("a save that fails after showing stays Unsaved, and the next save shows at once", async (t) => {
  const f = await savedFixture(t);
  await f.edit("Typed here");
  await f.advance(SLOW_SAVE_MS);
  assert.equal(f.session.statusKey, "saving");
  f.requests[1].resolve(
    Response.json({ error: "Requested edits have not arrived" }, { status: 409 }),
  );
  await drain();
  assert.equal(f.session.status, "Not saved");
  assert.equal(f.session.statusKey, "failed");
  assert.equal(f.session.saveState, "stalled", "the reload gate retries it like Retry");
  // Unsaved stays visible while nothing new happens.
  await f.advance(SLOW_SAVE_MS * 2 - 600);
  assert.equal(f.session.status, "Not saved");
  // An edit after a failure never goes quiet: that would read as the failure
  // clearing.
  await f.edit("Typed after the failure");
  assert.equal(f.session.statusId, "saving");
  assert.equal(f.session.statusKey, "saving");
  await f.advance(300);
  const latest = f.requests.at(-1);
  latest.resolve(Response.json({ durableHeads: latest.heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
});

test("a quiet save that goes offline shows Offline, then stays quiet when it lands", async (t) => {
  const f = await savedFixture(t);
  await f.edit("Typed here");
  f.session.syncStatus({ type: "unreachable" });
  f.session.renderStatus();
  assert.equal(f.session.status, "Offline");
  assert.equal(f.session.statusKey, "attention");
  f.session.syncStatus({ type: "admitted" });
  f.session.renderStatus();
  assert.equal(f.session.statusKey, "quiet");
  await f.advance(300);
  f.requests[1].resolve(Response.json({ durableHeads: f.requests[1].heads }));
  await drain();
  assert.equal(f.session.status, "Saved");
  assert.ok(!f.keys.includes("saving"), f.keys.join(", "));
});
