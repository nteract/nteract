import * as A from "@automerge/automerge";

/** Host-attested authorship: which authenticated profile wrote an Automerge
 * actor's changes. A browser never names its own actor. The host reads the
 * issuer key of each signed commit record it stores, and DocumentPolicy binds
 * that key to the profile that was admitted with it. */

// An attested actor is published while its signer wrote within this window.
export const FRESH_MS = 15 * 60 * 1000;
export const MAX_ACTORS = 1024;
export const MAX_ATTESTED_CHANGES = 4096;
export const ACTOR_PREFIX = "host/actor/";

// Native signed envelope: "STC\0", the issuer's Ed25519 verifying key,
// the payload, then a 64-byte signature.
const SIGNED_MAGIC = [0x53, 0x54, 0x43, 0x00];
const ISSUER_START = SIGNED_MAGIC.length;
const ISSUER_END = ISSUER_START + 32;
const MIN_SIGNED_BYTES = ISSUER_END + 64;
const COMMIT_PATH = /\/commits\/([0-9a-f]{64})$/;
const ACTOR = /^[0-9a-f]{1,128}$/;
const KEY = /^[0-9a-f]{64}$/;

const hex = (value) => Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

// Stored compound record, binary v2 (patch-record-codec.mjs): "SDR", version
// 2, kind (0 = commit), 3 reserved zero bytes, big-endian u32 signed and blob
// lengths, tree, key, signed-envelope checksum, signed envelope, blob. Every
// save writes v2; legacy v1 JSON records are only ever read, never saved.
const FRAME_MAGIC = [0x53, 0x44, 0x52, 0x02];
const FRAME_HEADER_BYTES = 112;

/** The key, signed envelope and blob of a saved v2 commit frame, or null.
 * Reads only; the record codec in the storage bridge stays the authority. */
export function commitFrame(value) {
  if (!(value instanceof Uint8Array) || value.length < FRAME_HEADER_BYTES) return null;
  if (!FRAME_MAGIC.every((byte, i) => value[i] === byte)) return null;
  if (value[4] !== 0 || value[5] !== 0 || value[6] !== 0 || value[7] !== 0) return null;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const signedLength = view.getUint32(8),
    blobLength = view.getUint32(12);
  if (FRAME_HEADER_BYTES + signedLength + blobLength !== value.length) return null;
  const blobStart = FRAME_HEADER_BYTES + signedLength;
  return {
    key: hex(value.subarray(48, 80)),
    signed: value.subarray(FRAME_HEADER_BYTES, blobStart),
    blob: value.subarray(blobStart),
  };
}

/** The issuer key of a native signed envelope, or null if it isn't one. */
export function signedIssuer(signed) {
  if (!(signed instanceof Uint8Array) || signed.length < MIN_SIGNED_BYTES) return null;
  if (!SIGNED_MAGIC.every((byte, i) => signed[i] === byte)) return null;
  return hex(signed.subarray(ISSUER_START, ISSUER_END));
}

/** The signer, Automerge actor and change hash of a stored commit record, or null. Every
 * part must agree: the storage path's commit id, the frame's key, and the
 * change's own hash. Anything undecodable yields no attestation. */
export function commitAuthor(path, value) {
  const match = typeof path === "string" ? COMMIT_PATH.exec(path) : null;
  if (!match) return null;
  try {
    const frame = commitFrame(value);
    if (!frame || frame.key !== match[1]) return null;
    const key = signedIssuer(frame.signed);
    if (!key) return null;
    const change = A.decodeChange(frame.blob);
    if (change.hash !== frame.key || typeof change.actor !== "string" || !ACTOR.test(change.actor))
      return null;
    return { key, actor: change.actor, hash: change.hash };
  } catch {
    return null;
  }
}

/** A byte store whose resolved saves also report each saved key and value.
 * Everything else, including errors and results, is the store's own. */
export function observeRecordSaves(store, onSaved) {
  const report = (key, value) => {
    try {
      onSaved(key, value);
    } catch {
      // Attestation never fails a save.
    }
  };
  return new Proxy(store, {
    get(target, property) {
      if (property === "save")
        return async (key, value) => {
          const result = await target.save(key, value);
          report(key, value);
          return result;
        };
      if (property === "saveMany" && typeof target.saveMany === "function")
        return async (entries) => {
          const result = await target.saveMany(entries);
          for (const [key, value] of entries) report(key, value);
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const attestable = (binding) =>
  !!binding &&
  typeof binding.principal === "string" &&
  !binding.pending &&
  !!binding.writer &&
  !binding.revoked;
const publishable = (binding) => !!binding && !binding.revoked;
const conflicted = (now) => ({ conflict: true, lastSeen: now });

/** One actor's transition on one observed commit signer. States: unbound
 * (undefined), host-owned, attested to one signer key, or conflicted. The
 * first signer wins; any other signer makes the actor a permanent conflict.
 * `delta` is "publish" when viewers should learn the profile and "retract"
 * when an attested actor must be withdrawn. `persist` marks a first binding
 * or conflict, which survives a host restart. */
export function actorTransition(entry, { key, now, serverKey, binding }) {
  if (entry?.conflict) return { entry: { ...entry, lastSeen: now }, persist: false };
  if (entry?.host) {
    if (key === serverKey) return { entry: { ...entry, lastSeen: now }, persist: false };
    return { entry: conflicted(now), persist: true };
  }
  if (entry) {
    if (key !== entry.key) return { entry: conflicted(now), delta: "retract", persist: true };
    const stale = now - entry.lastSeen > FRESH_MS;
    return {
      entry: { ...entry, lastSeen: now },
      delta: stale && publishable(binding) ? "publish" : undefined,
      persist: false,
    };
  }
  // Every agent writes through the host's actor, so a host-signed actor never
  // names one person. It is held only to detect a browser claiming it.
  if (key === serverKey) return { entry: { host: true, lastSeen: now }, persist: true };
  if (!attestable(binding)) return { entry: undefined, persist: false };
  return {
    entry: {
      key,
      principal: binding.principal,
      displayName: text(binding.displayName, 256),
      driver: text(binding.driver, 64),
      firstSeen: now,
      lastSeen: now,
    },
    delta: "publish",
    persist: true,
  };
}

const profileOf = ({ principal, displayName, driver }) => ({ principal, displayName, driver });
const stored = (entry) =>
  entry.conflict
    ? { conflict: true }
    : entry.host
      ? { host: true }
      : {
          key: entry.key,
          principal: entry.principal,
          displayName: entry.displayName,
          driver: entry.driver,
          firstSeen: entry.firstSeen,
        };
function restored(value) {
  if (!value || typeof value !== "object") return null;
  if (value.conflict === true) return { conflict: true, lastSeen: 0 };
  if (value.host === true) return { host: true, lastSeen: 0 };
  if (!KEY.test(value.key) || typeof value.principal !== "string") return null;
  return {
    key: value.key,
    principal: value.principal,
    displayName: text(value.displayName, 256),
    driver: text(value.driver, 64),
    firstSeen: Number.isFinite(value.firstSeen) ? value.firstSeen : 0,
    lastSeen: 0,
  };
}

/** Actor attestations for one Page host. It performs no I/O: `observe`
 * returns the broadcast delta and the storage writes for the caller to apply.
 *
 * A viewer names a person only for a change hash listed here: one this host
 * read from that change's own signed commit record while its actor was
 * attested to the record's signer. Changes that reach the host only inside
 * fragments are never observed, so they are never listed. The recent set
 * holds at most `maxChanges` hashes in memory, serves only those observed
 * within FRESH_MS, and drops an actor's hashes when the actor conflicts or is
 * evicted.
 *
 * The map holds at most `max` actors. An entry is evictable only once it is
 * idle: its last observed record is older than FRESH_MS. Restored entries
 * load with lastSeen 0, so they start idle. A new actor takes the least
 * recently seen idle entry's place; with no idle entry it is not stored and
 * stays unattested. Host-owned, attested and conflicted entries follow the
 * same rule, so an actor that wrote within FRESH_MS keeps its first signer,
 * and any other signer conflicts it. An actor idle past FRESH_MS that was
 * evicted is unbound again, and its next signer can bind it. Even then the
 * published profile comes from that signer's own admitted binding in
 * DocumentPolicy, never from the record or the browser. */
export class ActorAuthorship {
  constructor({
    serverKey,
    binding,
    entries = [],
    max = MAX_ACTORS,
    maxChanges = MAX_ATTESTED_CHANGES,
  }) {
    this.serverKey = serverKey;
    this.binding = binding;
    this.max = max;
    this.maxChanges = maxChanges;
    this.actors = new Map();
    // Change hash -> { actor, seenAt }, oldest first.
    this.changes = new Map();
    for (const [actor, value] of entries) {
      if (this.actors.size >= this.max) break;
      const entry = ACTOR.test(actor) ? restored(value) : null;
      if (entry) this.actors.set(actor, entry);
    }
  }

  /** The least recently seen idle actor, or undefined. Map order is least
   * recently seen first. */
  idleActor(now) {
    for (const [actor, entry] of this.actors) if (now - entry.lastSeen > FRESH_MS) return actor;
    return undefined;
  }

  forgetChanges(actor) {
    for (const [hash, change] of this.changes)
      if (change.actor === actor) this.changes.delete(hash);
  }

  /** One stored commit record's signer `key`, change `actor` and change
   * `hash`. Profiles are never an input: they come from `binding(key)`. When
   * the change is newly attested, `attested` is `{ [hash]: actor }`. */
  observe({ key, actor, hash, now }) {
    const current = this.actors.get(actor);
    const { entry, delta, persist } = actorTransition(current, {
      key,
      now,
      serverKey: this.serverKey,
      binding: key === this.serverKey ? undefined : this.binding(key),
    });
    const unchanged = { delta: null, put: [], remove: [] };
    if (!entry) return unchanged;
    const remove = [];
    if (!current && this.actors.size >= this.max) {
      const idle = this.idleActor(now);
      // Every stored actor wrote recently: refuse the new one rather than
      // unbind a live actor.
      if (idle === undefined) return unchanged;
      this.actors.delete(idle);
      this.forgetChanges(idle);
      remove.push(idle);
    }
    // Reinsertion keeps Map order least-recently-seen first.
    this.actors.delete(actor);
    this.actors.set(actor, entry);
    if (entry.conflict) this.forgetChanges(actor);
    const recorded =
      typeof hash === "string" && !entry.conflict && !entry.host && entry.key === key;
    const known = recorded ? this.changes.get(hash) : undefined;
    const repeated = known?.actor === actor && now - known.seenAt <= FRESH_MS;
    if (recorded) {
      this.changes.delete(hash);
      this.changes.set(hash, { actor, seenAt: now });
      while (this.changes.size > this.maxChanges)
        this.changes.delete(this.changes.keys().next().value);
    }
    // A hash is announced once while fresh. A revoked signer's changes stay
    // recorded but are not announced.
    const attested = recorded && !repeated && publishable(this.binding(key));
    return {
      delta:
        delta === "publish"
          ? { [actor]: profileOf(entry) }
          : delta === "retract"
            ? { [actor]: null }
            : null,
      put: persist ? [[actor, stored(entry)]] : [],
      remove,
      ...(attested && { attested: { [hash]: actor } }),
    };
  }

  /** Attested actors whose signer wrote recently and is not revoked now. */
  profiles(now) {
    const result = {};
    for (const [actor, entry] of this.actors) {
      if (entry.conflict || entry.host || now - entry.lastSeen > FRESH_MS) continue;
      if (!publishable(this.binding(entry.key))) continue;
      result[actor] = profileOf(entry);
    }
    return result;
  }

  /** Attested change hashes seen within FRESH_MS whose actor is published. */
  attestedChanges(now, profiles = this.profiles(now)) {
    const result = {};
    for (const [hash, { actor, seenAt }] of this.changes)
      if (now - seenAt <= FRESH_MS && Object.hasOwn(profiles, actor)) result[hash] = actor;
    return result;
  }
}

/** Every persisted actor entry, in storage order. */
export async function loadActorEntries(storage) {
  const entries = [];
  let startAfter;
  do {
    const page = await storage.list({
      prefix: ACTOR_PREFIX,
      limit: 256,
      ...(startAfter && { startAfter }),
    });
    for (const [key, value] of page) entries.push([key.slice(ACTOR_PREFIX.length), value]);
    startAfter = page.size === 256 ? [...page.keys()].at(-1) : undefined;
  } while (startAfter);
  return entries;
}

/** Merge one effect into pending actor writes: value to put, or null to
 * delete. A later effect for an actor wins, except that a pending conflict is
 * never replaced by a put of a non-conflict entry. */
export function mergeActorEffects(pending, { put = [], remove = [] }) {
  for (const [actor, value] of put)
    if (!(pending.get(actor)?.conflict && !value.conflict)) pending.set(actor, value);
  for (const actor of remove) pending.set(actor, null);
  return pending;
}

/** One storage step for a batch of actor writes. In a transaction the puts
 * and deletes commit together. Without one they are issued back to back with
 * no await between them, so Durable Object storage coalesces them into one
 * atomic write. */
export function writeActorBatch(storage, batch) {
  const apply = (target) => {
    const puts = {};
    const deletes = [];
    for (const [actor, value] of batch)
      if (value === null) deletes.push(ACTOR_PREFIX + actor);
      else puts[ACTOR_PREFIX + actor] = value;
    return Promise.all([
      ...(Object.keys(puts).length ? [target.put(puts)] : []),
      ...deletes.map((key) => target.delete(key)),
    ]);
  };
  if (typeof storage.transaction === "function") return storage.transaction(apply);
  return apply(storage);
}

/** Serialized actor persistence. Each `enqueue` merges its effects into the
 * pending set and queues one write of everything pending. A failed write
 * leaves its entries pending, so the next write retries them. */
export class ActorPersistence {
  constructor(storage) {
    this.storage = storage;
    this.pending = new Map();
    this.tail = Promise.resolve();
  }

  enqueue(effects) {
    mergeActorEffects(this.pending, effects);
    const run = this.tail.then(() => this.write());
    this.tail = run.catch(() => {});
    return run;
  }

  async write() {
    if (!this.pending.size) return;
    const batch = new Map(this.pending);
    await writeActorBatch(this.storage, batch);
    // Entries merged while this write ran stay pending for the next one.
    for (const [actor, value] of batch)
      if (this.pending.get(actor) === value) this.pending.delete(actor);
  }
}
