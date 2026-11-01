import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { MemoryByteStore } from "@automerge/automerge-repo-subduction";
import { closePeers, connectPeers, createPeer, eventually } from "../../backend.mjs";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import {
  ACTOR_PREFIX,
  ActorAuthorship,
  ActorPersistence,
  FRESH_MS,
  actorTransition,
  commitAuthor,
  commitFrame,
  loadActorEntries,
  mergeActorEffects,
  observeRecordSaves,
  signedIssuer,
} from "./actor-authorship.mjs";
import { Page } from "./index.mjs";

const SERVER = "5e".repeat(32);
const ANA_KEY = "a1".repeat(32);
const BEN_KEY = "b1".repeat(32);
const ACTOR = "ac".repeat(16);
const ANA = { principal: "user:ana", displayName: "Ana", driver: "Browser" };
const BEN = { principal: "user:ben", displayName: "Ben", driver: "Browser" };
const writer = (profile, extra = {}) => ({
  ...profile,
  senderId: "sender",
  writer: true,
  pending: false,
  revoked: false,
  retired: false,
  ...extra,
});
function authorship(bindings = {}, options = {}) {
  const map = new Map(Object.entries(bindings));
  const state = new ActorAuthorship({
    serverKey: SERVER,
    binding: (key) => map.get(key),
    ...options,
  });
  return { state, bindings: map };
}

test("an unbound actor signed by a current writer is attested and published", () => {
  const { state } = authorship({ [ANA_KEY]: writer(ANA) });
  const effects = state.observe({ key: ANA_KEY, actor: ACTOR, now: 1000 });
  assert.deepEqual(effects.delta, { [ACTOR]: ANA });
  assert.deepEqual(effects.put, [[ACTOR, { key: ANA_KEY, ...ANA, firstSeen: 1000 }]]);
  assert.deepEqual(effects.remove, []);
  assert.deepEqual(state.profiles(1000), { [ACTOR]: ANA });
});

test("the same signer again publishes nothing while fresh, and again once stale", () => {
  const { state } = authorship({ [ANA_KEY]: writer(ANA) });
  state.observe({ key: ANA_KEY, actor: ACTOR, now: 0 });
  const fresh = state.observe({ key: ANA_KEY, actor: ACTOR, now: FRESH_MS });
  assert.deepEqual(fresh, { delta: null, put: [], remove: [] });
  assert.deepEqual(state.profiles(2 * FRESH_MS), { [ACTOR]: ANA });
  assert.deepEqual(state.profiles(2 * FRESH_MS + 1), {}, "stale actors are not published");
  const refreshed = state.observe({ key: ANA_KEY, actor: ACTOR, now: 2 * FRESH_MS + 1 });
  assert.deepEqual(refreshed.delta, { [ACTOR]: ANA });
  assert.deepEqual(refreshed.put, [], "only first binding persists");
});

test("a second signer makes an attested actor a permanent, retracted conflict", () => {
  const { state } = authorship({ [ANA_KEY]: writer(ANA), [BEN_KEY]: writer(BEN) });
  state.observe({ key: ANA_KEY, actor: ACTOR, now: 0 });
  const effects = state.observe({ key: BEN_KEY, actor: ACTOR, now: 1 });
  assert.deepEqual(effects.delta, { [ACTOR]: null });
  assert.deepEqual(effects.put, [[ACTOR, { conflict: true }]]);
  assert.deepEqual(state.profiles(1), {});
  for (const key of [ANA_KEY, BEN_KEY, SERVER])
    assert.deepEqual(state.observe({ key, actor: ACTOR, now: 2 }), {
      delta: null,
      put: [],
      remove: [],
    });
  assert.deepEqual(state.profiles(2), {});
});

test("the host's own actor is held but never published", () => {
  const { state } = authorship({ [ANA_KEY]: writer(ANA) });
  const first = state.observe({ key: SERVER, actor: ACTOR, now: 0 });
  assert.deepEqual(first, { delta: null, put: [[ACTOR, { host: true }]], remove: [] });
  assert.deepEqual(state.observe({ key: SERVER, actor: ACTOR, now: 1 }), {
    delta: null,
    put: [],
    remove: [],
  });
  assert.deepEqual(state.profiles(1), {});
  // A browser claiming the host's actor conflicts it; nothing was published.
  const claimed = state.observe({ key: ANA_KEY, actor: ACTOR, now: 2 });
  assert.deepEqual(claimed, { delta: null, put: [[ACTOR, { conflict: true }]], remove: [] });
  assert.equal(state.actors.get(ACTOR).conflict, true);
  assert.deepEqual(state.profiles(2), {});
});

test("a host-signed change on a browser's actor conflicts and retracts it", () => {
  const { state } = authorship({ [ANA_KEY]: writer(ANA) });
  state.observe({ key: ANA_KEY, actor: ACTOR, now: 0 });
  const effects = state.observe({ key: SERVER, actor: ACTOR, now: 1 });
  assert.deepEqual(effects.delta, { [ACTOR]: null });
  assert.deepEqual(effects.put, [[ACTOR, { conflict: true }]]);
  assert.deepEqual(state.profiles(1), {});
});

test("reader, pending, revoked and unknown keys attest nothing", () => {
  const { state } = authorship({
    reader: writer(ANA, { writer: false }),
    pending: writer(ANA, { pending: true }),
    revoked: writer(ANA, { revoked: true }),
  });
  for (const key of ["reader", "pending", "revoked", "unknown"])
    assert.deepEqual(state.observe({ key, actor: ACTOR, now: 0 }), {
      delta: null,
      put: [],
      remove: [],
    });
  assert.equal(state.actors.size, 0);
  // The actor is still unbound: a current writer binds it afterwards.
  const { state: next, bindings } = authorship({ reader: writer(ANA, { writer: false }) });
  next.observe({ key: "reader", actor: ACTOR, now: 0 });
  bindings.set(ANA_KEY, writer(ANA));
  assert.deepEqual(next.observe({ key: ANA_KEY, actor: ACTOR, now: 1 }).delta, { [ACTOR]: ANA });
});

test("profiles drop actors whose binding is revoked after attestation", () => {
  const { state, bindings } = authorship({ [ANA_KEY]: writer(ANA) });
  state.observe({ key: ANA_KEY, actor: ACTOR, now: 0 });
  bindings.set(ANA_KEY, writer(ANA, { revoked: true }));
  assert.deepEqual(state.profiles(0), {});
  // A revoked signer's later records never republish it.
  assert.equal(state.observe({ key: ANA_KEY, actor: ACTOR, now: 2 * FRESH_MS }).delta, null);
  // Retired writers keep authorship of what they wrote.
  bindings.set(ANA_KEY, writer(ANA, { writer: false, retired: true }));
  assert.deepEqual(state.profiles(2 * FRESH_MS), { [ACTOR]: ANA });
});

test("every state reacts to every signer class as the transition table says", () => {
  const binding = writer(ANA);
  const states = {
    unbound: undefined,
    host: { host: true, lastSeen: 0 },
    attested: { key: ANA_KEY, ...ANA, firstSeen: 0, lastSeen: 0 },
    conflict: { conflict: true, lastSeen: 0 },
  };
  const events = {
    server: { key: SERVER },
    same: { key: ANA_KEY, binding },
    other: { key: BEN_KEY, binding: writer(BEN) },
    reader: { key: BEN_KEY, binding: writer(BEN, { writer: false }) },
  };
  const expected = {
    unbound: { server: "host", same: "attested", other: "attested", reader: "unbound" },
    host: { server: "host", same: "conflict", other: "conflict", reader: "conflict" },
    attested: { server: "conflict", same: "attested", other: "conflict", reader: "conflict" },
    conflict: { server: "conflict", same: "conflict", other: "conflict", reader: "conflict" },
  };
  const kind = (entry) =>
    entry === undefined
      ? "unbound"
      : entry.conflict
        ? "conflict"
        : entry.host
          ? "host"
          : "attested";
  for (const [from, entry] of Object.entries(states))
    for (const [name, event] of Object.entries(events)) {
      const result = actorTransition(entry, { ...event, now: 10, serverKey: SERVER });
      assert.equal(kind(result.entry), expected[from][name], `${from} + ${name}`);
      const retract = from === "attested" && expected[from][name] === "conflict";
      assert.equal(result.delta === "retract", retract, `${from} + ${name} retracts`);
    }
});

const nth = (n) => n.toString(16).padStart(2, "0").repeat(16);
const NONE = { delta: null, put: [], remove: [] };
function fullMap() {
  const { state } = authorship({ [ANA_KEY]: writer(ANA), [BEN_KEY]: writer(BEN) }, { max: 2 });
  state.observe({ key: SERVER, actor: nth(1), now: 0 });
  state.observe({ key: ANA_KEY, actor: nth(2), now: 1 });
  return state;
}

test("a full map of fresh actors refuses a new actor and keeps every binding", () => {
  const state = fullMap();
  const before = structuredClone([...state.actors]);
  assert.deepEqual(state.observe({ key: BEN_KEY, actor: nth(3), now: 2 }), NONE);
  assert.deepEqual(state.observe({ key: SERVER, actor: nth(4), now: 2 }), NONE);
  assert.equal(state.actors.has(nth(3)), false);
  assert.deepEqual(state.profiles(2), { [nth(2)]: ANA });
  assert.deepEqual([...state.actors], before);
  // Updates to stored actors still apply while full.
  assert.deepEqual(state.observe({ key: ANA_KEY, actor: nth(2), now: 3 }), NONE);
  assert.equal(state.actors.get(nth(2)).lastSeen, 3);
});

test("a new actor replaces the least recently seen idle actor, host-owned included", () => {
  const state = fullMap();
  // nth(1) (host-owned, seen at 0) is idle; nth(2) (seen at 1) is still fresh.
  const now = FRESH_MS + 1;
  const effects = state.observe({ key: BEN_KEY, actor: nth(3), now });
  assert.deepEqual(effects, {
    delta: { [nth(3)]: BEN },
    put: [[nth(3), { key: BEN_KEY, ...BEN, firstSeen: now }]],
    remove: [nth(1)],
  });
  assert.deepEqual([...state.actors.keys()], [nth(2), nth(3)]);
  assert.deepEqual(state.profiles(now), { [nth(2)]: ANA, [nth(3)]: BEN });
  // Restored entries load idle and give way first.
  const restored = new ActorAuthorship({
    serverKey: SERVER,
    binding: () => writer(ANA),
    max: 2,
    entries: [
      [nth(5), { conflict: true }],
      [nth(6), { key: ANA_KEY, ...ANA, firstSeen: 0 }],
    ],
  });
  assert.deepEqual(
    restored.observe({ key: ANA_KEY, actor: nth(7), now: 1_790_000_000_000 }).remove,
    [nth(5)],
  );
});

test("a second key signing a fresh actor in a full map conflicts it, never rebinds it", () => {
  const state = fullMap();
  const effects = state.observe({ key: BEN_KEY, actor: nth(2), now: 2 });
  assert.deepEqual(effects, {
    delta: { [nth(2)]: null },
    put: [[nth(2), { conflict: true }]],
    remove: [],
  });
  assert.equal(state.actors.size, 2);
  assert.equal(state.actors.get(nth(1)).host, true);
  assert.deepEqual(state.profiles(2), {});
  // Neither key can claim it afterwards.
  assert.deepEqual(state.observe({ key: ANA_KEY, actor: nth(2), now: 3 }), NONE);
  assert.equal(state.actors.get(nth(2)).conflict, true);
});

// observe takes no profile argument: the profile is always read from the
// policy binding for the record's issuer key.
test("observe ignores any profile the caller supplies and reads only the issuer's binding", () => {
  const { state } = authorship({ [ANA_KEY]: writer(ANA) });
  const forged = { ...BEN, profile: BEN, binding: writer(BEN), identity: BEN };
  const effects = state.observe({ key: ANA_KEY, actor: ACTOR, now: 0, ...forged });
  assert.deepEqual(effects.delta, { [ACTOR]: ANA });
  assert.deepEqual(effects.put, [[ACTOR, { key: ANA_KEY, ...ANA, firstSeen: 0 }]]);
  assert.deepEqual(state.profiles(0), { [ACTOR]: ANA });
});

test("persisted entries restore bindings and conflicts as stale until seen again", async () => {
  const storage = new Storage();
  const persistence = new ActorPersistence(storage);
  const { state } = authorship({ [ANA_KEY]: writer(ANA), [BEN_KEY]: writer(BEN) });
  const host = "11".repeat(16),
    conflicted = "22".repeat(16);
  for (const [key, actor] of [
    [ANA_KEY, ACTOR],
    [SERVER, host],
    [ANA_KEY, conflicted],
    [BEN_KEY, conflicted],
  ])
    await persistence.enqueue(state.observe({ key, actor, now: 5 }));
  await storage.put(`${ACTOR_PREFIX}${"33".repeat(16)}`, { key: "not a key" });
  await storage.put(`${ACTOR_PREFIX}NOT-HEX`, { host: true });
  const entries = await loadActorEntries(storage);
  assert.equal(entries.length, 5);
  const { state: restored } = authorship(
    { [ANA_KEY]: writer(ANA), [BEN_KEY]: writer(BEN) },
    { entries },
  );
  assert.deepEqual([...restored.actors.keys()].sort(), [ACTOR, host, conflicted].sort());
  assert.deepEqual(restored.actors.get(ACTOR), { key: ANA_KEY, ...ANA, firstSeen: 5, lastSeen: 0 });
  assert.deepEqual(restored.profiles(FRESH_MS + 1), {}, "restored actors are stale");
  assert.deepEqual(restored.observe({ key: ANA_KEY, actor: ACTOR, now: FRESH_MS + 1 }).delta, {
    [ACTOR]: ANA,
  });
  assert.deepEqual(restored.observe({ key: ANA_KEY, actor: host, now: 1 }).put, [
    [host, { conflict: true }],
  ]);
  assert.equal(restored.observe({ key: ANA_KEY, actor: conflicted, now: 1 }).delta, null);
  // Eviction deletes the persisted entry.
  await persistence.enqueue({ put: [], remove: [ACTOR] });
  assert.equal(await storage.get(`${ACTOR_PREFIX}${ACTOR}`), undefined);
});

class Store {
  values = new Map();
  async load(key) {
    return this.values.get(key)?.slice();
  }
  async list(prefix) {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
  async save(key, value) {
    this.values.set(key, value.slice());
  }
  async remove(key) {
    this.values.delete(key);
  }
}
class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) await this.put(name, entry);
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async list({ prefix = "", startAfter = "", limit = 1000 } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .slice(0, limit),
    );
  }
  async sync() {}
}

const H = (n) => n.toString(16).padStart(2, "0").repeat(32);

test("change hashes are attested only from the attested signer's own commits", () => {
  const { state, bindings } = authorship({
    [ANA_KEY]: writer(ANA),
    [BEN_KEY]: writer(BEN),
    reader: writer(BEN, { writer: false }),
  });
  const first = state.observe({ key: ANA_KEY, actor: ACTOR, hash: H(1), now: 0 });
  assert.deepEqual(first.attested, { [H(1)]: ACTOR });
  assert.deepEqual(state.observe({ key: ANA_KEY, actor: ACTOR, hash: H(2), now: 1 }).attested, {
    [H(2)]: ACTOR,
  });
  assert.equal(
    state.observe({ key: ANA_KEY, actor: ACTOR, hash: H(2), now: 2 }).attested,
    undefined,
    "a fresh hash is announced once",
  );
  // Host-signed, unattested and other actors' hashes are never attested.
  assert.equal(
    state.observe({ key: SERVER, actor: "11".repeat(16), hash: H(3), now: 2 }).attested,
    undefined,
  );
  assert.equal(
    state.observe({ key: "reader", actor: "22".repeat(16), hash: H(4), now: 2 }).attested,
    undefined,
  );
  state.observe({ key: BEN_KEY, actor: "33".repeat(16), hash: H(5), now: 2 });
  assert.deepEqual(state.attestedChanges(2), {
    [H(1)]: ACTOR,
    [H(2)]: ACTOR,
    [H(5)]: "33".repeat(16),
  });
  // Stale hashes and revoked signers are not served.
  assert.deepEqual(Object.keys(state.attestedChanges(FRESH_MS + 1)), [H(2), H(5)]);
  bindings.set(BEN_KEY, writer(BEN, { revoked: true }));
  assert.deepEqual(state.attestedChanges(2), { [H(1)]: ACTOR, [H(2)]: ACTOR });
  // A conflict drops every hash attested to the actor and attests nothing.
  const conflict = state.observe({ key: SERVER, actor: ACTOR, hash: H(6), now: 3 });
  assert.deepEqual(conflict.delta, { [ACTOR]: null });
  assert.equal(conflict.attested, undefined);
  assert.equal(
    [...state.changes.values()].some((change) => change.actor === ACTOR),
    false,
  );
  assert.deepEqual(state.attestedChanges(3), {});
});

test("attested hashes keep the newest maxChanges and leave with an evicted actor", () => {
  const { state } = authorship({ [ANA_KEY]: writer(ANA) }, { max: 2, maxChanges: 3 });
  for (let n = 1; n <= 4; n++) state.observe({ key: ANA_KEY, actor: nth(1), hash: H(n), now: n });
  assert.deepEqual([...state.changes.keys()], [H(2), H(3), H(4)]);
  state.observe({ key: ANA_KEY, actor: nth(2), hash: H(9), now: 5 });
  // nth(1) goes idle and gives way to nth(3); its hashes go with it.
  const effects = state.observe({ key: ANA_KEY, actor: nth(3), now: FRESH_MS + 5 });
  assert.deepEqual(effects.remove, [nth(1)]);
  assert.deepEqual([...state.changes.keys()], [H(9)]);
});

test("pending actor writes merge: later wins, but a conflict outlives a later binding", () => {
  const pending = new Map();
  mergeActorEffects(pending, { put: [[ACTOR, { conflict: true }]] });
  mergeActorEffects(pending, { put: [[ACTOR, { key: ANA_KEY, ...ANA, firstSeen: 1 }]] });
  assert.deepEqual(pending.get(ACTOR), { conflict: true });
  mergeActorEffects(pending, { remove: [ACTOR] });
  assert.equal(pending.get(ACTOR), null);
  mergeActorEffects(pending, { put: [[ACTOR, { host: true }]] });
  assert.deepEqual(pending.get(ACTOR), { host: true });
});

class FlakyStorage extends Storage {
  failures = 0;
  transactions = [];
  async transaction(callback) {
    const writes = [];
    const txn = {
      put: async (entries) => writes.push(["put", Object.keys(entries).sort()]),
      delete: async (key) => writes.push(["delete", key]),
    };
    await callback(txn);
    if (this.failures > 0) {
      this.failures--;
      throw Error("storage unavailable");
    }
    this.transactions.push(writes);
    // Commit only after the whole callback succeeded.
    const real = new Storage();
    real.values = this.values;
    await callback(real);
  }
}

test("a failed actor write stays pending, retries with the next one, and commits atomically", async () => {
  const storage = new FlakyStorage();
  const persistence = new ActorPersistence(storage);
  const { state } = authorship({ [ANA_KEY]: writer(ANA), [BEN_KEY]: writer(BEN) }, { max: 1 });
  storage.failures = 1;
  state.observe({ key: ANA_KEY, actor: nth(1), now: 0 });
  // The conflict write fails: it must not be lost.
  const conflict = state.observe({ key: BEN_KEY, actor: nth(1), now: 1 });
  await assert.rejects(persistence.enqueue(conflict), /storage unavailable/);
  assert.deepEqual(persistence.pending.get(nth(1)), { conflict: true });
  assert.deepEqual(await loadActorEntries(storage), []);
  // An eviction's put and remove land in one transaction with the retry.
  const eviction = state.observe({ key: ANA_KEY, actor: nth(2), now: FRESH_MS + 2 });
  assert.deepEqual(eviction.remove, [nth(1)]);
  await persistence.enqueue(eviction);
  assert.deepEqual(storage.transactions, [
    [
      ["put", [`${ACTOR_PREFIX}${nth(2)}`]],
      ["delete", `${ACTOR_PREFIX}${nth(1)}`],
    ],
  ]);
  assert.equal(persistence.pending.size, 0);
  assert.deepEqual(
    (await loadActorEntries(storage)).map(([actor]) => actor),
    [nth(2)],
  );
});

test("a restart after a conflict whose first write failed restores the conflict", async () => {
  const storage = new FlakyStorage();
  const persistence = new ActorPersistence(storage);
  const { state } = authorship({ [ANA_KEY]: writer(ANA), [BEN_KEY]: writer(BEN) });
  await persistence.enqueue(state.observe({ key: ANA_KEY, actor: ACTOR, now: 0 }));
  storage.failures = 1;
  await assert.rejects(
    persistence.enqueue(state.observe({ key: BEN_KEY, actor: ACTOR, now: 1 })),
    /storage unavailable/,
  );
  // Any later write carries the pending conflict.
  await persistence.enqueue(state.observe({ key: ANA_KEY, actor: nth(9), now: 2 }));
  const { state: restored } = authorship(
    { [ANA_KEY]: writer(ANA), [BEN_KEY]: writer(BEN) },
    { entries: await loadActorEntries(storage) },
  );
  assert.equal(restored.actors.get(ACTOR).conflict, true);
  assert.equal(restored.observe({ key: ANA_KEY, actor: ACTOR, now: FRESH_MS + 3 }).delta, null);
  assert.deepEqual(restored.profiles(FRESH_MS + 3), {});
});

/** A real native commit record for one Automerge change, signed by `seed`:
 * a peer imports the change and saves it through its own storage bridge. */
async function signedCommit(seed, change, store = new MemoryByteStore()) {
  const decoded = A.decodeChange(change);
  const peer = createPeer({ seed: new Uint8Array(32).fill(seed), storage: store });
  try {
    await peer.repo.import(A.save(A.loadIncremental(A.init(), change)));
    await peer.repo.flush();
    await peer.backend.flush();
    const path = `/commits/${decoded.hash}`;
    const keys = await store.list?.("");
    const found = (keys ?? []).find((key) => key.endsWith(path));
    return {
      path: found,
      value: found && (await store.load(found)),
      key: peer.keyId,
      actor: decoded.actor,
    };
  } finally {
    await closePeers([peer]);
  }
}
const rootChange = (actor) =>
  A.getLastLocalChange(A.change(A.init({ actor }), { time: 0 }, (doc) => (doc.text = actor)));

test("a stored commit record names its signer key and Automerge actor", async () => {
  const record = await signedCommit(41, rootChange(ACTOR));
  assert.match(record.path, /\/commits\/[0-9a-f]{64}$/);
  assert.deepEqual(commitAuthor(record.path, record.value), {
    key: record.key,
    actor: ACTOR,
    hash: A.decodeChange(rootChange(ACTOR)).hash,
  });
  const frame = commitFrame(record.value);
  assert.equal(frame.key, A.decodeChange(rootChange(ACTOR)).hash);
  assert.equal(signedIssuer(frame.signed), record.key);
  // Fail closed: a wrong magic, a short envelope, a fragment path or a path
  // naming another commit attest nothing.
  const forged = frame.signed.slice();
  forged[3] = 1;
  assert.equal(signedIssuer(forged), null);
  assert.equal(signedIssuer(frame.signed.subarray(0, 99)), null);
  assert.equal(signedIssuer(new Uint8Array(100)), null);
  assert.equal(signedIssuer("STC"), null);
  assert.equal(commitAuthor(record.path.replace("/commits/", "/fragments/"), record.value), null);
  assert.equal(
    commitAuthor(record.path.replace(/[0-9a-f]{64}$/, "0".repeat(64)), record.value),
    null,
  );
  assert.equal(commitAuthor(record.path, record.value.subarray(0, 50)), null);
  assert.equal(commitAuthor(record.path, new TextEncoder().encode("{}")), null);
});

test("an observed store reports saves after they resolve and never fails them", async () => {
  const seen = [];
  const inner = new Store();
  inner.saveMany = async (entries) => {
    for (const [key, value] of entries) await inner.save(key, value);
  };
  const store = observeRecordSaves(inner, (key, value) => {
    seen.push([key, value.length]);
    throw Error("observer failure");
  });
  await store.save("a", new Uint8Array(1));
  await store.saveMany([
    ["b", new Uint8Array(2)],
    ["c", new Uint8Array(3)],
  ]);
  assert.deepEqual(seen, [
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
  assert.deepEqual(await store.list(""), ["a", "b", "c"]);
  assert.equal(store.values, inner.values);
  inner.save = async () => {
    throw Error("disk full");
  };
  await assert.rejects(store.save("d", new Uint8Array(1)), /disk full/);
  assert.equal(seen.length, 3, "a failed save reports nothing");
  const plain = observeRecordSaves(new Store(), () => {});
  assert.equal(plain.saveMany, undefined, "no saveMany appears on a store without one");

  // A real bridge: the native engine's signed record reaches the observer.
  const authors = [];
  const record = await signedCommit(
    43,
    rootChange(ACTOR),
    observeRecordSaves(new MemoryByteStore(), (key, value) => {
      const author = commitAuthor(key, value);
      if (author) authors.push(author);
    }),
  );
  assert.deepEqual(authors, [
    { key: record.key, actor: ACTOR, hash: A.decodeChange(rootChange(ACTOR)).hash },
  ]);
});

test("a browser writer's synced commits are attested by hash; fragments and host edits are not", async () => {
  const bindings = new Map();
  const deltas = [];
  const announced = {};
  let state;
  const serverStore = new MemoryByteStore();
  const server = createPeer({
    seed: new Uint8Array(32).fill(51),
    storage: observeRecordSaves(serverStore, (key, value) => {
      const author = commitAuthor(key, value);
      const effects = author && state.observe({ ...author, now: Date.now() });
      if (effects?.delta) deltas.push(effects.delta);
      Object.assign(announced, effects?.attested);
    }),
  });
  const browser = createPeer({ seed: new Uint8Array(32).fill(52) });
  state = new ActorAuthorship({ serverKey: server.keyId, binding: (key) => bindings.get(key) });
  bindings.set(browser.keyId, writer(ANA));
  const peers = [server, browser];
  const wires = [];
  try {
    const base = A.change(A.init({ actor: "0f".repeat(16) }), { time: 0 }, (doc) => {
      doc.text = "base";
    });
    const hosted = await server.repo.import(A.save(base));
    await server.repo.flush();
    await server.backend.flush();
    const local = await browser.repo.import(A.save(base), { docId: hosted.documentId });
    wires.push(await connectPeers(browser, server));
    // Three edits: a change whose hash starts with a zero byte is stored as a
    // fragment, which names no single change.
    for (let n = 0; n < 3; n++)
      local.change((doc) => {
        doc.text = `browser ${n}`;
      });
    const browserActor = A.getActorId(local.doc());
    await eventually(() => state.actors.has(browserActor));
    assert.deepEqual(deltas[0], { [browserActor]: ANA });
    assert.deepEqual(state.profiles(Date.now()), { [browserActor]: ANA });
    await eventually(() => A.getHeads(hosted.doc()).join() === A.getHeads(local.doc()).join());
    // Every browser change the host stored as its own commit record is
    // attested by hash, and only those.
    const keys = await serverStore.list("");
    const browserHashes = A.getAllChanges(local.doc())
      .map((change) => A.decodeChange(change))
      .filter((change) => change.actor === browserActor)
      .map((change) => change.hash);
    const committed = browserHashes.filter((hash) =>
      keys.some((k) => k.endsWith(`/commits/${hash}`)),
    );
    assert.ok(committed.length > 0);
    assert.deepEqual(
      Object.keys(announced).sort(),
      [...committed].sort(),
      "announced hashes are exactly the stored commits",
    );
    assert.deepEqual(
      state.attestedChanges(Date.now()),
      Object.fromEntries(committed.map((hash) => [hash, browserActor])),
    );
    // The browser claims to be Ben over the ephemeral channel. The host
    // receives the claims, but attestation reads only the policy binding of
    // the key that signed each commit record: ANA's admission.
    const received = [];
    hosted.on("ephemeral-message", (event) => received.push(event));
    local.broadcast({ kind: "actor-profiles", actorProfiles: { [browserActor]: BEN } });
    local.broadcast({
      kind: "selection",
      value: { block_id: "b", start: "s", end: "e", heads: [] },
      actor: browserActor,
      identity: BEN,
      profile: BEN,
    });
    local.change((doc) => {
      doc.text = "browser after claims";
    });
    await eventually(() => received.length === 2);
    assert.deepEqual(
      received.map((event) => event.message.kind),
      ["actor-profiles", "selection"],
    );
    await eventually(() => A.getHeads(hosted.doc()).join() === A.getHeads(local.doc()).join());
    assert.deepEqual(state.profiles(Date.now()), { [browserActor]: ANA });
    assert.equal(state.actors.get(browserActor).key, browser.keyId);
    assert.equal(JSON.stringify(deltas).includes(BEN.principal), false);

    // A change whose hash starts with a zero byte heads a fragment. It reaches
    // the host only inside that fragment, so it is never attested by hash,
    // even under an attested actor.
    let fragment;
    for (let time = 1_790_000_000; !fragment; time++) {
      const next = A.change(A.clone(local.doc(), { actor: browserActor }), { time }, (doc) => {
        doc.text = "inside a fragment";
      });
      const [head] = A.getHeads(next);
      if (head.startsWith("00")) fragment = { hash: head, bytes: A.getLastLocalChange(next) };
      A.free(next);
    }
    local.update((doc) => A.applyChanges(doc, [fragment.bytes])[0]);
    await eventually(() => A.hasHeads(hosted.doc(), [fragment.hash]));
    const afterFragment = await serverStore.list("");
    assert.ok(afterFragment.some((key) => key.endsWith(`/fragments/${fragment.hash}`)));
    assert.equal(
      afterFragment.some((key) => key.endsWith(`/commits/${fragment.hash}`)),
      false,
    );
    assert.equal(state.changes.has(fragment.hash), false);
    assert.equal(Object.hasOwn(announced, fragment.hash), false);
    assert.equal(Object.hasOwn(state.attestedChanges(Date.now()), fragment.hash), false);

    for (let n = 0; n < 3; n++)
      hosted.change((doc) => {
        doc.host = `tool ${n}`;
      });
    const hostActor = A.getActorId(hosted.doc());
    await eventually(() => state.actors.get(hostActor)?.host === true);
    assert.equal(state.actors.get("0f".repeat(16)).host, true, "the imported base is host-signed");
    assert.deepEqual(state.profiles(Date.now()), { [browserActor]: ANA });
    assert.equal(deltas.length, 1);
    assert.equal(
      [...state.changes.values()].some((change) => change.actor !== browserActor),
      false,
      "host-signed changes are never attested",
    );
  } finally {
    assert.deepEqual(await closePeers(peers, wires), []);
  }
});

const pageId = "33333333-3333-4333-8333-333333333333";
const requestFor = (token, path, body) =>
  new Request(`https://pages.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const contextFor = (storage) => ({
  id: { name: pageId },
  storage,
  blockConcurrencyWhile: (fn) => fn(),
  waitUntil() {},
});

test("a Page host persists, broadcasts and serves attested actors but never its own", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  const pages = [];
  t.after(async () => {
    for (const page of pages) {
      await page.repo?.shutdown();
      await page.backend?.close();
      page.signer?.free();
    }
  });
  const env = {
    ...auth.env,
    CATALOGS: { getByName: () => ({ fetch: async () => Response.json({}) }) },
  };
  const open = async () => {
    const page = new Page(contextFor(storage), env);
    pages.push(page);
    await page.ready;
    return page;
  };
  const owner = auth.apiKey();
  const connect = async (page) => (await page.fetch(requestFor(owner, "/api/connect"))).json();
  const page = await open();
  const created = await page.fetch(
    requestFor(owner, "/internal/create", { page_id: pageId, title: "Authors", markdown: "Body" }),
  );
  assert.equal(created.status, 201);

  // A host edit on a fixed actor, stored as a loose commit.
  const hostActor = "c0".repeat(16);
  for (let time = 1_790_000_000; ; time++) {
    const next = A.change(A.clone(page.handle.doc(), { actor: hostActor }), { time }, (doc) => {
      doc.toolNote = "host";
    });
    const [head] = A.getHeads(next);
    const bytes = A.getLastLocalChange(next);
    A.free(next);
    if (head.startsWith("00")) continue;
    await page.handle.update((doc) => A.applyChanges(doc, [bytes])[0]);
    break;
  }
  await eventually(() => page.actorAuthorship.actors.get(hostActor)?.host === true);
  await eventually(async () => (await storage.get(`${ACTOR_PREFIX}${hostActor}`))?.host === true);
  assert.deepEqual(
    await connect(page).then(({ actorProfiles, attestedChanges }) => ({
      actorProfiles,
      attestedChanges,
    })),
    {
      actorProfiles: {},
      attestedChanges: {},
    },
  );

  // Browser writers' commit records, as the backend would save them. Saves in
  // one tick go out as one broadcast.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const anaActor = "a0".repeat(16),
    benActor = "b0".repeat(16);
  const record = await signedCommit(61, rootChange(anaActor));
  const benRecord = await signedCommit(62, rootChange(benActor));
  const anaHash = A.decodeChange(rootChange(anaActor)).hash,
    benHash = A.decodeChange(rootChange(benActor)).hash;
  page.policy.bindings.set(record.key, writer(ANA, { generation: 0 }));
  page.policy.bindings.set(benRecord.key, writer(BEN, { generation: 0 }));
  const broadcasts = [];
  t.mock.method(page.handle, "broadcast", (message) => broadcasts.push(message));
  page.recordSaved(page.actorAuthorship, record.path, record.value);
  page.recordSaved(page.actorAuthorship, benRecord.path, benRecord.value);
  assert.deepEqual(broadcasts, [], "deltas wait for the tick");
  await tick();
  assert.deepEqual(broadcasts, [
    {
      kind: "actor-profiles",
      actorProfiles: { [anaActor]: ANA, [benActor]: BEN },
      attestedChanges: { [anaHash]: anaActor, [benHash]: benActor },
    },
  ]);
  const snapshot = await connect(page);
  assert.deepEqual(snapshot.actorProfiles, { [anaActor]: ANA, [benActor]: BEN });
  assert.deepEqual(snapshot.attestedChanges, { [anaHash]: anaActor, [benHash]: benActor });
  await eventually(
    async () => (await storage.get(`${ACTOR_PREFIX}${anaActor}`))?.key === record.key,
  );
  // The same record again, while fresh, publishes nothing new.
  page.recordSaved(page.actorAuthorship, record.path, record.value);
  await tick();
  assert.equal(broadcasts.length, 1);
  // Ephemeral claims from her browser naming Ben reach the Page's handle but
  // never change the attested profile, which comes from her key's binding.
  const delivered = [];
  page.handle.on("ephemeral-message", (event) => delivered.push(event.message.kind));
  for (const message of [
    { kind: "actor-profiles", actorProfiles: { [anaActor]: BEN } },
    {
      kind: "selection",
      value: { block_id: "b", start: "s", end: "e", heads: [] },
      actor: anaActor,
      identity: BEN,
      profile: BEN,
    },
  ])
    page.handle.emit("ephemeral-message", { senderId: "sender", message });
  assert.deepEqual(delivered, ["actor-profiles", "selection"]);
  page.recordSaved(page.actorAuthorship, record.path, record.value);
  await tick();
  assert.deepEqual((await connect(page)).actorProfiles[anaActor], ANA);
  assert.equal(broadcasts.length, 1, "the claims publish nothing");

  // A second signer on Ben's actor conflicts it: one message retracts the
  // actor, and the snapshot drops his attested hash.
  const forged = await signedCommit(61, rootChange(benActor));
  page.recordSaved(page.actorAuthorship, forged.path, forged.value);
  await tick();
  assert.deepEqual(broadcasts.at(-1), {
    kind: "actor-profiles",
    actorProfiles: { [benActor]: null },
    attestedChanges: {},
  });
  const afterConflict = await connect(page);
  assert.deepEqual(afterConflict.actorProfiles, { [anaActor]: ANA });
  assert.deepEqual(afterConflict.attestedChanges, { [anaHash]: anaActor });
  await eventually(
    async () => (await storage.get(`${ACTOR_PREFIX}${benActor}`))?.conflict === true,
  );

  // After a restart, bindings and the conflict are restored but nothing is
  // fresh, and no attested hash survives.
  const restarted = await open();
  assert.equal(restarted.actorAuthorship.actors.get(hostActor).host, true);
  assert.equal(restarted.actorAuthorship.actors.get(anaActor).key, record.key);
  assert.equal(restarted.actorAuthorship.actors.get(benActor).conflict, true);
  const cold = await connect(restarted);
  assert.deepEqual(cold.actorProfiles, {});
  assert.deepEqual(cold.attestedChanges, {});
});
