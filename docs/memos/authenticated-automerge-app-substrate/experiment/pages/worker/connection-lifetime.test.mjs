import assert from "node:assert/strict";
import { test } from "node:test";
import * as N from "@automerge/subduction";
import { Page } from "./index.mjs";
import { DocumentPolicy, PermissionDenied } from "./policy.mjs";

const drain = () => new Promise(setImmediate);

function fixture(
  t,
  failure,
  {
    credentialKind = "session",
    reauthenticate,
    identity: identityOptions = {},
    metadata = { owner: "user:owner" },
  } = {},
) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const events = [],
    background = [],
    broadcasts = [],
    writes = [],
    bindings = [],
    records = new Map();
  let pairs = 0,
    socket,
    released = false;
  class Socket extends EventTarget {
    closeCalls = 0;
    accept() {}
    close(code, reason) {
      this.closeCalls++;
      this.closed ??= { code, reason };
      this.dispatchEvent(new Event("close"));
    }
  }
  const globals = {
    WebSocketPair: class {
      constructor() {
        pairs++;
        this[0] = new Socket();
        this[1] = socket = new Socket();
      }
    },
    Response: class {
      constructor(_body, options) {
        Object.assign(this, options);
      }
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  const transport = {
    peerId: {
      toBytes: () => new Uint8Array(32),
      toString: () => "fixture-peer",
      free: () => events.push("peer.free"),
    },
    free: () => events.push("transport.free"),
  };
  t.mock.method(N.AuthenticatedTransport, "accept", async (wire) => {
    if (failure === "handshake-timeout") await wire.recvBytes();
    if (failure === "handshake") throw Error("Fixture handshake failed");
    return transport;
  });
  t.mock.method(console, "error", () => {});
  const admissionLogs = [];
  t.mock.method(console, "warn", (line) => admissionLogs.push(JSON.parse(line)));
  const page = Object.assign(Object.create(Page.prototype), {
    ctx: {
      waitUntil: (promise) => background.push(promise),
      storage: {
        async get(key) {
          return structuredClone(records.get(key));
        },
        async put(key, value) {
          writes.push("put");
          records.set(key, structuredClone(value));
        },
        async delete(key) {
          writes.push("delete");
          records.delete(key);
        },
        async sync() {
          writes.push("sync");
        },
      },
    },
    env: {},
    signer: {},
    wires: new Set(),
    wirePrincipals: new Map(),
    metadata,
    policy: {
      leaseExpiresAt(identity) {
        return identity.expiresAt;
      },
      async bind(_key, _senderId, _identity, options) {
        events.push("bind");
        bindings.push(options);
        if (failure === "binding") throw Error("Fixture binding failed");
        if (failure === "binding-mismatch")
          throw new PermissionDenied("Signing key has another binding", "native_binding_mismatch");
        return () => {
          released = true;
        };
      },
      async active() {
        events.push("active");
      },
    },
    backend: {
      async addConnection() {
        events.push("admitted");
        if (failure === "backend") throw Error("Fixture backend failed");
      },
    },
    handle: {
      broadcast: (value) => {
        events.push("broadcast");
        broadcasts.push(value);
      },
    },
    profiles: () => ({}),
  });
  if (reauthenticate) {
    page.policy = new DocumentPolicy({
      storage: page.ctx.storage,
      metadata: () => page.metadata,
      serverKey: "f".repeat(64),
      now: () => Date.now(),
    });
    const bind = page.policy.bind.bind(page.policy);
    t.mock.method(page.policy, "bind", (key, senderId, identity, options) =>
      bind(key, senderId, identity, {
        ...options,
        reauthenticate: () => reauthenticate(identity),
      }),
    );
  }
  t.after(async () => {
    for (const wire of page.wires) await wire.disconnect();
  });
  const open = (principal = identityOptions.principal ?? "user:owner", activityEpoch) => {
    const url = new URL("http://localhost/api/sync?page=fixture");
    if (activityEpoch !== undefined) url.searchParams.set("activity_epoch", activityEpoch);
    const response = page.connect(
      new Request(url, {
        headers: { upgrade: "websocket" },
      }),
      {
        credentialKind,
        driver: "fixture-browser",
        namespace: "fixture-provider",
        canWrite: true,
        expiresAt: 61000,
        ...identityOptions,
        principal,
      },
    );
    assert.equal(response.status, 101);
    return { socket, background: background.at(-1) };
  };
  const initial = open();
  assert.equal(background.length, 1);
  return {
    page,
    events,
    broadcasts,
    writes,
    pairCount: () => pairs,
    renewal: (expiresAt) => {
      assert.equal(
        typeof bindings[0]?.onRenewal,
        "function",
        "socket admission subscribes to validated lease renewal",
      );
      bindings[0].onRenewal(expiresAt);
    },
    background: initial.background,
    backgrounds: background,
    socket: initial.socket,
    open,
    released: () => released,
    admissionLogs,
  };
}

test("native admission rejects a discovery epoch from an earlier host before allocating a socket", async (t) => {
  const f = fixture(t);
  await drain();
  const discoveredEpoch = crypto.randomUUID(),
    currentEpoch = crypto.randomUUID();
  t.mock.method(f.page, "activityState", () => ({ epoch: currentEpoch }));
  const pairs = f.pairCount(),
    wires = f.page.wires.size,
    backgrounds = f.backgrounds.length;
  assert.throws(() => f.open("user:owner", discoveredEpoch), {
    status: 409,
    message: "Page activity session changed; reconnect",
  });
  assert.equal(f.pairCount(), pairs);
  assert.equal(f.page.wires.size, wires);
  assert.equal(f.backgrounds.length, backgrounds);
  const fresh = f.open("user:owner", currentEpoch);
  await drain();
  assert.equal(f.pairCount(), pairs + 1);
  assert.equal(f.page.wires.size, wires + 1);
  fresh.socket.close();
  await fresh.background;
});

test("legacy admission may omit the activity epoch but malformed or repeated values are rejected", async (t) => {
  const f = fixture(t);
  await drain();
  // fixture's first socket deliberately uses the legacy URL without an epoch.
  assert.equal(f.page.wires.size, 1);
  const currentEpoch = crypto.randomUUID();
  t.mock.method(f.page, "activityState", () => ({ epoch: currentEpoch }));
  const pairs = f.pairCount();
  for (const invalid of ["", "not-a-uuid", "a".repeat(36), `${currentEpoch}suffix`])
    assert.throws(() => f.open("user:owner", invalid), { status: 400 });
  assert.throws(
    () =>
      f.page.connect(
        new Request(
          `http://localhost/api/sync?page=fixture&activity_epoch=${currentEpoch}&activity_epoch=${currentEpoch}`,
          { headers: { upgrade: "websocket" } },
        ),
        { principal: "user:owner" },
      ),
    { status: 400 },
  );
  assert.equal(f.pairCount(), pairs);
  assert.equal(f.page.wires.size, 1);
});

test("native admission keeps its context until the socket closes, then releases it", async (t) => {
  const f = fixture(t);
  let settled = false;
  f.background.then(() => {
    settled = true;
  });
  await drain();
  assert.deepEqual(f.events, ["peer.free", "bind", "admitted", "broadcast", "transport.free"]);
  assert.equal(settled, false, "admission completing must not retire the connection context");
  assert.equal(f.page.wires.size, 1);
  t.mock.timers.tick(15001);
  await drain();
  assert.equal(f.events.filter((event) => event === "active").length, 1);
  assert.equal(settled, false);
  f.socket.close();
  await f.background;
  assert.equal(settled, true);
  assert.equal(f.page.wires.size, 0);
  assert.equal(f.released(), true);
  t.mock.timers.tick(120000);
  await drain();
  assert.equal(
    f.events.filter((event) => event === "active").length,
    1,
    "close cancels the lease timer",
  );
});

for (const failure of ["handshake", "binding", "backend", "handshake-timeout"]) {
  test(`native ${failure} failure settles admission and closes the socket`, async (t) => {
    const f = fixture(t, failure);
    if (failure === "handshake-timeout") t.mock.timers.tick(10000);
    await f.background;
    assert.equal(f.page.wires.size, 0);
    assert.equal(f.page.wirePrincipals.size, 0);
    assert.equal(
      f.events.filter((event) => event === "transport.free").length,
      failure.startsWith("handshake") ? 0 : 1,
    );
    if (failure === "backend") assert.equal(f.released(), true);
    const events = [...f.events];
    t.mock.timers.tick(120000);
    await drain();
    assert.deepEqual(f.events, events, "failed admission leaves no lease timer running");
  });
}

for (const cancellation of ["timeout", "disconnect"]) {
  test(`native ${cancellation} releases its admission while a reconnect joins pending persistence`, async (t) => {
    const f = fixture(t, undefined, { reauthenticate: async (identity) => identity });
    const put = f.page.ctx.storage.put;
    let settleWrite,
      puts = 0;
    const pending = new Promise((resolve) => {
      settleWrite = resolve;
    });
    f.page.ctx.storage.put = async (...args) => {
      puts++;
      await pending;
      return put(...args);
    };
    await drain();
    const key = "0".repeat(64);
    assert.equal(puts, 1);
    assert.equal(f.page.policy.sessions.size, 0, "a pending author is not an active socket");
    assert.equal(f.page.policy.authorAllowed(f.page.policy.bindings.get(key)), false);
    assert.equal(f.backgrounds.length, 2, "persistence has its own background lifetime");
    if (cancellation === "timeout") t.mock.timers.tick(10000);
    else f.socket.close();
    await f.background;
    assert.equal(f.page.wires.size, 0);
    assert.equal(f.page.policy.admissions.get(key).claim, null);
    assert.equal(f.events.includes("admitted"), false);

    const replacement = f.open();
    await drain();
    assert.equal(puts, 1, "a reconnect must not start a competing binding write");
    assert.equal(replacement.socket.closeCalls, 0);
    settleWrite();
    await drain();
    assert.equal(f.page.wires.size, 1);
    assert.equal(f.page.policy.sessions.size, 1);
    assert.equal(f.page.policy.admissions.size, 0);
    assert.equal(f.page.policy.authorAllowed(f.page.policy.bindings.get(key)), true);
    assert.equal(
      f.events.filter((event) => event === "admitted").length,
      1,
      "late persistence may admit only the replacement socket",
    );
    replacement.socket.close();
    await Promise.all(f.backgrounds);
    assert.equal(f.page.policy.sessions.size, 0);
    assert.equal(f.page.wires.size, 0);
  });
}

for (const [failure, reason, close] of [
  ["handshake", "native_handshake_failed", [4503, "temporarily_unavailable"]],
  ["handshake-timeout", "native_admission_timeout", [4503, "temporarily_unavailable"]],
  ["binding", "server_error", [4503, "temporarily_unavailable"]],
  ["binding-mismatch", "native_binding_mismatch", [4422, "signing_key_rejected"]],
  ["backend", "native_connection_failed", [4503, "temporarily_unavailable"]],
]) {
  test(`native ${failure} failure logs ${reason} and closes with its client code`, async (t) => {
    const f = fixture(t, failure);
    if (failure === "handshake-timeout") t.mock.timers.tick(10000);
    await f.background;
    assert.deepEqual(f.socket.closed, { code: close[0], reason: close[1] });
    assert.equal(f.admissionLogs.length, 1);
    assert.equal(f.admissionLogs[0].reason, reason);
    assert.equal(f.admissionLogs[0].stage, "native");
    assert.equal(f.admissionLogs[0].code, close[1]);
  });
}

test("a handshake deadline during an unsettled binding write is reported as a storage stall", async (t) => {
  const f = fixture(t, undefined, { reauthenticate: async (identity) => identity });
  f.page.ctx.storage.put = () => new Promise(() => {});
  await drain();
  t.mock.timers.tick(10000);
  await f.background;
  assert.deepEqual(f.socket.closed, { code: 4503, reason: "temporarily_unavailable" });
  assert.deepEqual(
    f.admissionLogs.map(({ reason }) => reason),
    ["native_binding_stalled"],
  );
});

test("lease endings close with access, sign-in and shutdown codes", async (t) => {
  const f = fixture(t, undefined, { reauthenticate: async (identity) => identity });
  await drain();
  assert.equal(f.page.policy.sessions.size, 1);
  // An ACL change that alters this session's role closes it for a recheck.
  f.page.metadata = { ...f.page.metadata, acl: { revision: 1, members: {} } };
  f.page.metadata.owner = "user:someone-else";
  await f.page.policy.refreshAccess({ persist: false });
  await f.background;
  assert.deepEqual(f.socket.closed, { code: 4409, reason: "access_changed" });

  f.page.metadata = { owner: "user:owner" };
  const expiring = f.open();
  await drain();
  t.mock.timers.tick(60_001);
  await expiring.background;
  assert.deepEqual(expiring.socket.closed, { code: 4401, reason: "sign_in_required" });
  assert.equal(f.admissionLogs.length, 0, "lease endings are not admission denials");
});

test("closing the Page policy ends leases with a transient code", async (t) => {
  const f = fixture(t, undefined, { reauthenticate: async (identity) => identity });
  await drain();
  await f.page.policy.close();
  await f.background;
  assert.deepEqual(f.socket.closed, { code: 4503, reason: "temporarily_unavailable" });
});

test("pending native handshakes count toward each authenticated account's connection quota", async (t) => {
  const f = fixture(t, "handshake-timeout");
  const member = [];
  for (let i = 0; i < 4; i++) member.push(f.open("user:viewer"));
  assert.throws(() => f.open("user:viewer"), {
    status: 429,
    message: "Too many connections for this account",
  });
  f.open("user:other");
  assert.equal(f.page.wires.size, 6);
  member[0].socket.close();
  await member[0].background;
  f.open("user:viewer");
  t.mock.timers.tick(10_000);
  await Promise.all(f.backgrounds);
  assert.equal(f.page.wires.size, 0);
  assert.equal(f.page.wirePrincipals.size, 0);
});

test("twenty member wires preserve four owner connections under the global cap", async (t) => {
  const f = fixture(t, "handshake-timeout");
  for (let principal = 0; principal < 5; principal++)
    for (let i = 0; i < 4; i++) f.open(`user:member-${principal}`);
  assert.throws(() => f.open("user:sixth-member"), {
    status: 429,
    message: "Member connection capacity reached",
  });
  for (let i = 0; i < 3; i++) f.open("user:owner");
  assert.equal(f.page.wires.size, 24);
  assert.throws(() => f.open("user:another"), { status: 429, message: "Too many connected peers" });
  t.mock.timers.tick(10_000);
  await Promise.all(f.backgrounds);
  assert.equal(f.page.wires.size, 0);
  assert.equal(f.page.wirePrincipals.size, 0);
});

test("disconnect broadcasts the remaining presence roster after releasing its lease", async (t) => {
  const f = fixture(t);
  await drain();
  f.page.profiles = () => {
    assert.equal(f.released(), true);
    assert.equal(f.page.wires.size, 0);
    assert.equal(f.page.wirePrincipals.size, 0);
    return { server: { principal: "service:pages" } };
  };
  f.socket.close();
  await f.background;
  assert.deepEqual(f.broadcasts.at(-1), {
    kind: "identity-profiles",
    peerProfiles: { server: { principal: "service:pages" } },
  });
});

test("validated API-key renewals retain a socket past its original deadline without runtime writes", async (t) => {
  const f = fixture(t, undefined, { credentialKind: "api-key" });
  await drain();
  t.mock.method(f.page.policy, "active", async () => {
    f.events.push("active");
    f.renewal(Date.now() + 60000);
  });
  for (let check = 0; check < 4; check++) {
    t.mock.timers.tick(15000);
    await drain();
    assert.equal(f.events.filter((event) => event === "active").length, check + 1);
    assert.equal(f.page.wires.size, 1);
  }
  t.mock.timers.tick(1);
  await drain();
  assert.equal(Date.now(), 61001, "the initial 60-second credential lease has elapsed");
  assert.equal(f.page.wires.size, 1);
  assert.equal(f.socket.closeCalls, 0);
  assert.deepEqual(f.writes, [], "lease extension changes only connection-local timers");
  f.socket.close();
  await f.background;
});

test("a hanging API-key recheck closes the socket at its last validated renewal deadline", async (t) => {
  const f = fixture(t, undefined, { credentialKind: "api-key" });
  await drain();
  let checks = 0;
  t.mock.method(f.page.policy, "active", async () => {
    f.events.push("active");
    if (++checks === 1) f.renewal(Date.now() + 60000);
    else await new Promise(() => {});
  });
  t.mock.timers.tick(15000);
  await drain();
  // The accepted renewal at t=16s expires at t=76s. Later authorization calls
  // intentionally never settle; they cannot extend that confirmed deadline.
  for (let check = 0; check < 3; check++) {
    t.mock.timers.tick(15000);
    await drain();
  }
  assert.equal(Date.now(), 61000);
  assert.equal(f.page.wires.size, 1, "initial expiry must have been replaced");
  t.mock.timers.tick(14999);
  await drain();
  assert.equal(f.page.wires.size, 1);
  t.mock.timers.tick(1);
  await f.background;
  assert.equal(Date.now(), 76000);
  assert.equal(f.page.wires.size, 0);
  assert.equal(f.socket.closeCalls, 1);
  assert.equal(f.released(), true);
  const priorChecks = checks;
  t.mock.timers.tick(120000);
  await drain();
  assert.equal(checks, priorChecks, "expiry cancels authorization polling even when a check hangs");
  assert.deepEqual(f.writes, []);
});

test("OIDC sessions retain their original hard expiry despite successful periodic checks", async (t) => {
  const f = fixture(t, undefined, { credentialKind: "session" });
  await drain();
  for (let check = 0; check < 3; check++) {
    t.mock.timers.tick(15000);
    await drain();
    // A fixed OIDC credential deadline cannot be extended by a lease callback.
    if (check === 0) f.renewal(Date.now() + 60000);
  }
  assert.equal(f.events.filter((event) => event === "active").length, 3);
  t.mock.timers.tick(14999);
  await drain();
  assert.equal(f.page.wires.size, 1);
  t.mock.timers.tick(1);
  await f.background;
  assert.equal(Date.now(), 61000);
  assert.equal(f.page.wires.size, 0);
  assert.equal(f.socket.closeCalls, 1);
  assert.deepEqual(f.writes, []);
});

test("real policy closes domain viewer sockets at the earlier proof deadline", async (t) => {
  let checks = 0;
  const domainView = { domain: "anaconda.com", namespace: "fixture-provider" };
  const f = fixture(t, undefined, {
    credentialKind: "oidc",
    identity: {
      principal: "user:employee",
      domainAccess: { ...domainView, expiresAt: 21000 },
    },
    metadata: {
      owner: "user:owner",
      acl: { revision: 1, members: {}, domainView },
    },
    reauthenticate: async (identity) => {
      checks++;
      return { ...identity, expiresAt: Date.now() + 60000 };
    },
  });
  await drain();
  assert.equal(f.page.wires.size, 1);
  const binding = await f.page.ctx.storage.get(`host/binding/${"0".repeat(64)}`);
  assert.equal(binding.writer, false, "company viewing admits a reader signing key");
  f.writes.length = 0;
  t.mock.timers.tick(15000);
  await drain();
  assert.equal(checks, 1);
  assert.equal(f.page.wires.size, 1);
  t.mock.timers.tick(4999);
  await drain();
  assert.equal(f.page.wires.size, 1);
  t.mock.timers.tick(1);
  await f.background;
  assert.equal(Date.now(), 21000, "the original credential remains valid until 61000");
  assert.equal(f.page.wires.size, 0);
  assert.equal(f.page.policy.sessions.size, 0);
  assert.equal(f.socket.closeCalls, 1);
  t.mock.timers.tick(120000);
  await drain();
  assert.equal(checks, 1, "proof expiry cancels further authorization checks");
  assert.deepEqual(f.writes, [], "proof expiry never changes the durable reader binding");
});

for (const ending of ["disconnect", "expiry"]) {
  test(`a late validated renewal after ${ending} cannot resurrect a socket timer`, async (t) => {
    const f = fixture(t, undefined, { credentialKind: "api-key" });
    await drain();
    if (ending === "disconnect") f.socket.close();
    else t.mock.timers.tick(60000);
    await f.background;
    const schedule = t.mock.method(globalThis, "setTimeout");
    f.renewal(Date.now() + 60000);
    assert.equal(
      schedule.mock.callCount(),
      0,
      "ended connections must ignore late renewal callbacks",
    );
    assert.equal(f.page.wires.size, 0);
    assert.equal(f.socket.closeCalls, 1);
    const priorChecks = f.events.filter((event) => event === "active").length;
    t.mock.timers.tick(120000);
    await drain();
    assert.equal(f.socket.closeCalls, 1);
    assert.equal(f.events.filter((event) => event === "active").length, priorChecks);
    assert.deepEqual(f.writes, []);
  });
}

test("real policy rechecks delayed API verification every timer period and promptly rejects revocation", async (t) => {
  const checks = [];
  const f = fixture(t, undefined, {
    credentialKind: "api-key",
    reauthenticate: async (identity) => {
      checks.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (checks.length === 4) throw Error("Fixture API key revoked");
      return { ...identity, expiresAt: Date.now() + 60000 };
    },
  });
  await drain();
  assert.equal(f.page.wires.size, 1);
  assert.deepEqual(f.writes, ["put"], "admission persists the author binding once");
  const persisted = await f.page.ctx.storage.get(`host/binding/${"0".repeat(64)}`);
  f.writes.length = 0;
  for (let check = 0; check < 4; check++) {
    // Complete each check 1ms after the fixed 15s socket timer fires. The next
    // timer must still verify the key, rather than skip because only 14999ms
    // have elapsed since the prior verifier finished.
    t.mock.timers.tick(check === 0 ? 15000 : 14999);
    await drain();
    assert.deepEqual(
      checks,
      Array.from({ length: check + 1 }, (_, i) => 16000 + i * 15000),
    );
    assert.equal(f.page.wires.size, 1);
    t.mock.timers.tick(1);
    await drain();
    assert.equal(f.page.wires.size, check === 3 ? 0 : 1);
  }
  await f.background;
  assert.equal(Date.now(), 61001);
  assert.equal(f.page.policy.sessions.size, 0, "revocation terminates the real policy lease");
  assert.deepEqual(f.writes, [], "rechecks do not rewrite durable author bindings");
  assert.deepEqual(await f.page.ctx.storage.get(`host/binding/${"0".repeat(64)}`), persisted);
});
