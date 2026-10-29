import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { proposeAccessUpdate } from "./access.mjs";
import { DocumentPolicy } from "./policy.mjs";

const key = "1".repeat(64);
const otherKey = "2".repeat(64);
const serverKey = "f".repeat(64);
const bindingKey = (signer) => `host/binding/${signer}`;
const options = { timeout: 2000 };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class Storage {
  values = new Map();
  writes = [];
  events = [];
  steps = [];

  deferPut({ commitBeforeWait = false } = {}) {
    const gate = deferred();
    const entered = deferred();
    this.steps.push({ gate, entered, commitBeforeWait });
    return { ...gate, entered: entered.promise };
  }

  async put(name, value) {
    const snapshot = structuredClone(value);
    this.writes.push({ name, value: snapshot });
    this.events.push({ kind: "put", name, value: snapshot });
    const step = this.steps.shift();
    if (step?.commitBeforeWait) this.values.set(name, snapshot);
    if (step) {
      step.entered.resolve();
      await step.gate.promise;
    }
    this.values.set(name, snapshot);
  }

  async get(name) {
    return structuredClone(this.values.get(name));
  }

  async list({ prefix = "" } = {}) {
    return new Map(
      [...this.values].filter(([name]) => name.startsWith(prefix)).map(structuredCloneEntry),
    );
  }

  async sync() {
    this.events.push({ kind: "sync" });
  }
}

const structuredCloneEntry = ([name, value]) => [name, structuredClone(value)];

function fixture() {
  let now = 1000;
  const storage = new Storage();
  const metadata = { owner: "user:owner", tree: "a".repeat(32), deleted: false };
  const identity = {
    principal: metadata.owner,
    displayName: "Owner",
    driver: "Browser",
    canWrite: true,
    expiresAt: 61_000,
  };
  const policy = new DocumentPolicy({
    storage,
    metadata: () => metadata,
    serverKey,
    now: () => now,
  });
  const background = [];
  const disconnected = [];
  const bind = (signer = key, current = identity, extra = {}) => {
    const promise = policy.bind(signer, signer, current, {
      reauthenticate: async () => current,
      disconnect: async () => disconnected.push(signer),
      waitUntil: (pending) => {
        background.push(pending);
        pending.catch(() => {});
      },
      ...extra,
    });
    // Assertions may inspect the pending write before observing the rejection.
    promise.catch(() => {});
    return promise;
  };
  const grant = (principal, role) => {
    metadata.acl = proposeAccessUpdate(
      metadata,
      identity,
      { principal, role, expected_revision: metadata.acl?.revision ?? 0 },
      { now },
    ).acl;
  };
  return {
    policy,
    storage,
    metadata,
    identity,
    background,
    disconnected,
    bind,
    grant,
    advance: (value) => {
      now = value;
    },
    drain: async () => {
      await Promise.allSettled(background);
      await setImmediate();
    },
  };
}

test("unchanged and unrelated ACL refresh cannot demote a pending writer", options, async () => {
  const f = fixture();
  const write = f.storage.deferPut();
  const admission = f.bind();
  await write.entered;
  assert.equal(f.policy.sessions.size, 0, "pending admission is not a live lease");
  assert.equal(f.policy.admissions.size, 1);
  assert.deepEqual(f.policy.profiles(), {});
  await f.policy.refreshAccess({ persist: false });
  f.grant("user:unrelated", "viewer");
  await f.policy.refreshAccess({ persist: false });
  assert.equal(f.storage.writes.length, 1);
  assert.equal(f.policy.sessions.size, 0);
  write.resolve();
  const release = await admission;
  await f.policy.active(key, true);
  assert.equal(f.policy.bindings.get(key).writer, true);
  assert.equal(f.policy.bindings.get(key).pending, false);
  release();
});

test(
  "a canceled waiter releases promptly and a compatible reconnect joins its one write",
  options,
  async () => {
    const f = fixture();
    const write = f.storage.deferPut();
    const controller = new AbortController();
    const first = f.bind(key, f.identity, { signal: controller.signal });
    await write.entered;
    controller.abort();
    await assert.rejects(first);
    assert.equal(f.policy.sessions.size, 0);
    assert.ok(f.background.length > 0, "detached persistence has a runtime owner");
    const second = f.bind();
    await setImmediate();
    assert.equal(f.storage.writes.length, 1, "reconnect must not issue a competing binding write");
    write.resolve();
    const release = await second;
    await f.drain();
    await f.policy.active(key, true);
    assert.equal(f.policy.sessions.size, 1, "late cleanup cannot remove the replacement lease");
    release();
  },
);

test(
  "pending identity reservations survive cancellation and reject principal or driver reassignment",
  options,
  async () => {
    const f = fixture();
    f.grant("user:other", "editor");
    const write = f.storage.deferPut();
    const controller = new AbortController();
    const first = f.bind(key, f.identity, { signal: controller.signal });
    await write.entered;
    controller.abort();
    await assert.rejects(first);
    await assert.rejects(
      f.bind(key, { ...f.identity, principal: "user:other" }),
      /another binding/i,
    );
    await assert.rejects(
      f.bind(key, { ...f.identity, driver: "Other client" }),
      /another binding/i,
    );
    assert.equal(f.storage.writes.length, 1);
    write.resolve();
    await f.drain();
    assert.equal(f.policy.sessions.size, 0, "late success must not revive the canceled connection");
    assert.equal(f.policy.bindings.get(key).pending, false);
    assert.equal(f.policy.bindings.get(key).principal, f.identity.principal);
    assert.equal(f.policy.bindings.get(key).driver, f.identity.driver);
    assert.equal(f.policy.authorAllowed(f.policy.bindings.get(key)), true);
  },
);

for (const commitBeforeWait of [false, true]) {
  test(
    `rejected ${commitBeforeWait ? "already-written" : "not-yet-written"} binding retries exact bytes without promoting its first reader`,
    options,
    async () => {
      const f = fixture();
      const write = f.storage.deferPut({ commitBeforeWait });
      const first = f.bind(key, { ...f.identity, canWrite: false });
      await write.entered;
      const original = structuredClone(f.storage.writes[0]);
      write.reject(new Error("fixture uncertain persistence"));
      await assert.rejects(first, { code: "native_binding_persistence_failed", status: 503 });
      assert.equal(f.policy.sessions.size, 0);
      assert.equal(f.policy.bindings.get(key).writer, false);
      await assert.rejects(
        f.bind(key, { ...f.identity, driver: "Other client" }),
        /another binding/i,
      );
      const release = await f.bind(key, { ...f.identity, displayName: "Renamed owner" });
      assert.equal(f.storage.writes.length, 2);
      assert.deepEqual(f.storage.writes[1], original, "retry must replay the reserved payload");
      assert.equal(f.policy.bindings.get(key).writer, false);
      await assert.rejects(f.policy.active(key, true), /read-only/i);
      release();

      const restored = new DocumentPolicy({
        storage: f.storage,
        metadata: () => f.metadata,
        serverKey,
        now: () => 1000,
      });
      await restored.load();
      assert.equal(restored.authorAllowed(restored.bindings.get(key)), false);
    },
  );
}

test(
  "late failure after waiter cancellation remains retryable without replacing its candidate",
  options,
  async () => {
    const f = fixture();
    const write = f.storage.deferPut();
    const controller = new AbortController();
    const first = f.bind(key, f.identity, { signal: controller.signal });
    await write.entered;
    const original = structuredClone(f.storage.writes[0]);
    controller.abort();
    await assert.rejects(first);
    write.reject(new Error("fixture detached failure"));
    await f.drain();
    assert.equal(f.policy.sessions.size, 0);
    const release = await f.bind();
    assert.deepEqual(f.storage.writes[1], original);
    await f.policy.active(key, true);
    release();
  },
);

test(
  "an uncertain failed admission retains its signing-key quota until exact retry succeeds",
  options,
  async () => {
    const f = fixture();
    const member = { ...f.identity, principal: "user:member" };
    f.grant(member.principal, "viewer");
    const numberedKey = (number) => number.toString(16).padStart(64, "0");
    for (let number = 1; number < 32; number++) (await f.bind(numberedKey(number), member))();
    const write = f.storage.deferPut();
    const admission = f.bind(numberedKey(32), member);
    await write.entered;
    write.reject(new Error("fixture uncertain persistence"));
    await assert.rejects(admission, { code: "native_binding_persistence_failed", status: 503 });
    await assert.rejects(f.bind(numberedKey(33), member), /32 signing keys per member/);
    (await f.bind(numberedKey(32), member))();
    assert.equal(f.policy.bindings.size, 32);
  },
);

test(
  "late admission cannot overwrite retirement or regain authority after revoke and regrant",
  options,
  async () => {
    const f = fixture();
    const editor = { ...f.identity, principal: "user:editor" };
    f.grant(editor.principal, "editor");
    const write = f.storage.deferPut();
    const admission = f.bind(key, editor);
    await write.entered;
    f.grant(editor.principal, null);
    f.metadata.aclCommitting = true;
    await f.policy.refreshAccess({ persist: false });
    assert.equal(f.storage.writes.length, 1, "uncommitted ACL changes must not persist retirement");
    assert.equal(f.policy.authorAllowed(f.policy.bindings.get(key)), false);
    await f.storage.put("host/document", f.metadata);
    await f.storage.sync();
    delete f.metadata.aclCommitting;
    const refresh = f.policy.refreshAccess();
    refresh.catch(() => {});
    await setImmediate();
    assert.equal(
      f.storage.writes.filter(({ name }) => name === bindingKey(key)).length,
      1,
      "retirement must wait behind the pending same-key write",
    );
    write.resolve();
    await assert.rejects(admission);
    await refresh;
    assert.equal((await f.storage.get(bindingKey(key))).retired, true);
    assert.equal((await f.storage.get(bindingKey(key))).writer, false);
    assert.equal(f.policy.sessions.size, 0);
    const syncIndex = f.storage.events.findIndex(({ kind }) => kind === "sync");
    const retirementIndex = f.storage.events.findIndex(({ value }) => value?.retired);
    assert.ok(retirementIndex > syncIndex, "retirement crossed storage only after host ACL sync");

    f.grant(editor.principal, "editor");
    await f.policy.refreshAccess();
    const release = await f.bind(key, editor);
    await assert.rejects(f.policy.active(key, true), /read-only/i);
    release();
    const freshRelease = await f.bind(otherKey, editor);
    await f.policy.active(otherKey, true);
    await assert.rejects(f.policy.put(otherKey, key, f.metadata.tree), /Unknown document author/);
    freshRelease();
  },
);

test(
  "expiry during binding persistence rejects the waiter without leaving a live lease",
  options,
  async () => {
    const f = fixture();
    const write = f.storage.deferPut();
    const admission = f.bind(key, { ...f.identity, expiresAt: 1001 });
    await write.entered;
    f.advance(1002);
    write.resolve();
    await assert.rejects(admission, /access denied|expired/i);
    await f.drain();
    assert.equal(f.policy.sessions.size, 0);
    assert.equal(f.policy.bindings.get(key).pending, false);
    (await f.bind())();
  },
);

test(
  "closing policy cancels pending waiters and active leases without canceling durable binding work",
  options,
  async () => {
    const f = fixture();
    await f.bind(otherKey);
    const write = f.storage.deferPut();
    const admission = f.bind();
    await write.entered;
    await f.policy.close();
    await assert.rejects(admission);
    assert.equal(f.policy.sessions.size, 0);
    assert.ok(f.disconnected.includes(otherKey));
    write.resolve();
    await f.drain();
    assert.equal(f.policy.sessions.size, 0);
    assert.equal(f.policy.bindings.get(key).pending, false);
    assert.equal((await f.storage.get(bindingKey(key))).principal, f.identity.principal);
  },
);

test(
  "pre-write validation and an already-canceled waiter do not reserve signing keys",
  options,
  async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.bind(key, f.identity, { signal: controller.signal }));
    await assert.rejects(f.bind("not-a-signing-key"));
    await assert.rejects(f.bind(key, { ...f.identity, principal: "user:outsider" }));
    assert.equal(f.storage.writes.length, 0);
    assert.equal(f.policy.bindings.size, 0);
    assert.equal(f.policy.admissions.size, 0);
    assert.equal(f.policy.sessions.size, 0);
  },
);
