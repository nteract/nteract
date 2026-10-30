import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { PageSession } from "./session.mjs";
import { REFUSAL_LIMIT, backoffStep } from "./reconnect-machine.mjs";

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
function fixture(t, { random } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let doc = A.from({ text: "Pending edit" });
  const identity = { principal: "fixture-owner", displayName: "Fixture owner" };
  const session = new PageSession("receipt-reconnect", {
    refreshSession: async () => ({ identity, canWrite: true }),
    random,
  });
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
    this.close = () => {};
    sockets.push(this);
  });
  t.mock.method(N.SubductionWebSocket, "setup", async () => {
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
      assert.equal(f.session.status, status === 200 ? "Saved" : "Unsaved");
      assert.equal(f.session.problem, status === 200 ? "" : "Requested edits have not arrived");
      assert.equal(f.session.receiptRetryAttempts, status === 200 ? 0 : 1);
      await f.session.openConnection(false);
      assert.equal(f.session.status, status === 200 ? "Saved" : "Unsaved");
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
  f.hooks.receipt = () => Response.json({ error: "Storage unavailable" }, { status: 503 });
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
  assert.equal(f.session.status, "Unsaved");
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
  f.hooks.receipt = () => Response.json({ error: "Storage unavailable" }, { status: 503 });
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
  f.hooks.receipt = () => Response.json({ error: "Storage unavailable" }, { status: 503 });
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
      assert.equal(f.session.status, "Saving");
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
      assert.equal(f.session.status, "Saving");
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
  f.session.socketAdmittedAt.set(stable, Date.now() - 20_000);
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
  f.session.socketAdmittedAt.set(stable, Date.now() - 20_000);
  hostClose(stable, 1006, "");
  f.session.socketDisconnected(stable);
  assert.deepEqual(f.session.reconnect$.snapshot(), { name: "waiting", attempts: 1, refusals: 0 });

  // The same admission close on a stable socket is not a refusal either.
  await f.advance(500);
  const proven = f.sockets.at(-1);
  f.session.socketAdmittedAt.set(proven, Date.now() - 20_000);
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
