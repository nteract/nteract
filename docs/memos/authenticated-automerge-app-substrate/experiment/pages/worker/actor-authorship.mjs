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

// An uncompressed Automerge change chunk: magic, the first 4 bytes of the
// change hash, chunk type 1, a LEB128 body length, then the body, which opens
// with the dependency hashes and the actor. The change hash is the SHA-256 of
// everything after the checksum.
const CHANGE_MAGIC = [0x85, 0x6f, 0x4a, 0x83];
const CHANGE_CHUNK = 1;

function uleb(bytes, at) {
  let value = 0;
  for (let shift = 0; shift < 35 && at < bytes.length; shift += 7) {
    const byte = bytes[at++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return Number.isSafeInteger(value) ? { value, at } : null;
  }
  return null;
}

/** The actor named in an uncompressed change chunk's header, or null. The
 * caller checks the chunk's hash; this only reads the layout. */
export function changeHeaderActor(blob) {
  if (!(blob instanceof Uint8Array) || blob.length < 12) return null;
  if (!CHANGE_MAGIC.every((byte, i) => blob[i] === byte) || blob[8] !== CHANGE_CHUNK) return null;
  const length = uleb(blob, 9);
  if (!length || length.at + length.value !== blob.length) return null;
  const deps = uleb(blob, length.at);
  if (!deps) return null;
  const actorLength = uleb(blob, deps.at + deps.value * 32);
  if (!actorLength || actorLength.value < 1 || actorLength.value > 64) return null;
  const end = actorLength.at + actorLength.value;
  if (end > blob.length) return null;
  return hex(blob.subarray(actorLength.at, end));
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

// A commenter's key authors comments-document changes, attested the same way.
const attestable = (binding) =>
  !!binding &&
  typeof binding.principal === "string" &&
  !binding.pending &&
  (!!binding.writer || !!binding.commenter) &&
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
    const changed = {};
    if (!current && this.actors.size >= this.max) {
      const idle = this.idleActor(now);
      // Every stored actor wrote recently: refuse the new one rather than
      // unbind a live actor.
      if (idle === undefined) return unchanged;
      // Viewers may still hold an evicted attested actor and its hashes.
      // Retract it, so a later signer binding it never inherits them.
      if (this.actors.get(idle).key) changed[idle] = null;
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
    if (delta === "publish") changed[actor] = profileOf(entry);
    if (delta === "retract") changed[actor] = null;
    return {
      delta: Object.keys(changed).length ? changed : null,
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

  /** Rebuild bindings and conflicts from the signers of stored commit
   * records, before anything is published. Persisted entries can lag the
   * records: a conflict whose write never landed lives only in the records.
   * The rule is order-free: an actor whose records, together with its
   * persisted entry, name more than one signer key is a conflict. An actor
   * with one signer and no entry is bound to it: host-owned for the host's
   * key, attested for an admitted binding, and a conflict for a key with no
   * binding, so no later signer can claim it. Replayed entries are idle.
   * Conflicts are placed first and may evict idle entries; new bindings take
   * only free room. Returns the storage writes. */
  replay(authors) {
    const signers = new Map();
    for (const { key, actor } of authors) {
      if (typeof key !== "string" || typeof actor !== "string" || !ACTOR.test(actor)) continue;
      if (!signers.has(actor)) signers.set(actor, new Set());
      signers.get(actor).add(key);
    }
    const put = [];
    const remove = [];
    const conflicts = [];
    const bindings = [];
    for (const [actor, keys] of signers) {
      const current = this.actors.get(actor);
      if (current?.conflict) continue;
      if (current) keys.add(current.host ? this.serverKey : current.key);
      if (keys.size > 1) conflicts.push(actor);
      else if (!current) bindings.push([actor, [...keys][0]]);
    }
    const conflicting = new Set(conflicts);
    for (const actor of conflicts) {
      if (!this.actors.has(actor) && this.actors.size >= this.max) {
        // An actor about to become a conflict is never the one evicted.
        const victim = [...this.actors].find(
          ([other, entry]) => !entry.conflict && !conflicting.has(other),
        )?.[0];
        if (victim === undefined) continue;
        this.actors.delete(victim);
        this.forgetChanges(victim);
        remove.push(victim);
      }
      this.actors.delete(actor);
      this.actors.set(actor, { conflict: true, lastSeen: 0 });
      this.forgetChanges(actor);
      put.push([actor, { conflict: true }]);
    }
    for (const [actor, key] of bindings) {
      if (this.actors.size >= this.max) break;
      const binding = key === this.serverKey ? undefined : this.binding(key);
      const entry =
        key === this.serverKey
          ? { host: true, lastSeen: 0 }
          : binding && typeof binding.principal === "string" && !binding.pending
            ? {
                key,
                principal: binding.principal,
                displayName: text(binding.displayName, 256),
                driver: text(binding.driver, 64),
                firstSeen: 0,
                lastSeen: 0,
              }
            : { conflict: true, lastSeen: 0 };
      this.actors.set(actor, entry);
      put.push([actor, stored(entry)]);
    }
    // The writes describe the final map: no actor is both put and removed.
    return {
      put: put.filter(([actor]) => this.actors.has(actor)),
      remove: remove.filter((actor) => !this.actors.has(actor)),
    };
  }

  /** Attested change hashes seen within FRESH_MS whose actor is published. */
  attestedChanges(now, profiles = this.profiles(now)) {
    const result = {};
    for (const [hash, { actor, seenAt }] of this.changes)
      if (now - seenAt <= FRESH_MS && Object.hasOwn(profiles, actor)) result[hash] = actor;
    return result;
  }
}

/** The signer and actor of a stored commit record, for replay, or null.
 * It agrees with commitAuthor on every record: the change hash (SHA-256 of
 * the chunk after its checksum) must equal the storage path's commit id and
 * the frame's key, and the actor is read from that verified chunk's header.
 * A full decode of a large change costs tens of milliseconds, so this reads
 * only the header; a compressed or unusual chunk falls back to commitAuthor. */
export async function replayAuthor(path, value) {
  const match = typeof path === "string" ? COMMIT_PATH.exec(path) : null;
  if (!match) return null;
  const frame = commitFrame(value);
  if (!frame || frame.key !== match[1]) return null;
  const key = signedIssuer(frame.signed);
  if (!key) return null;
  const actor = changeHeaderActor(frame.blob);
  if (!actor || !ACTOR.test(actor)) {
    const author = commitAuthor(path, value);
    return author && { key: author.key, actor: author.actor };
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", frame.blob.subarray(8)));
  return hex(digest) === frame.key ? { key, actor } : null;
}

/** The signer and actor of every stored commit record in a byte store.
 * `authorOf(key, value)` reads one record (replayAuthor). The store holds at
 * most the backend's record and byte limits per document, the same records
 * the host already reads to load the document at startup. */
export async function loadCommitAuthors(store, authorOf = replayAuthor) {
  const authors = [];
  for (const key of await store.list("")) {
    if (!COMMIT_PATH.test(key)) continue;
    const author = await authorOf(key, await store.load(key));
    if (author) authors.push(author);
  }
  return authors;
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
 * delete. Each actor keeps one pending write, and a later effect replaces an
 * earlier one: a put cancels a pending delete, and a delete cancels a pending
 * put. A pending conflict is never replaced by a put of a non-conflict entry.
 * Within one effect a put outranks a delete of the same actor: effects
 * describe the final map, and an actor put there is in it. */
export function mergeActorEffects(pending, { put = [], remove = [] }) {
  const kept = new Set(put.map(([actor]) => actor));
  for (const actor of remove) if (!kept.has(actor)) pending.set(actor, null);
  for (const [actor, value] of put)
    if (!(pending.get(actor)?.conflict && !value.conflict)) pending.set(actor, value);
  return pending;
}

// Durable Object storage takes at most 128 keys per put or delete call.
export const STORAGE_KEYS_PER_CALL = 128;

/** One storage step for a batch of actor writes. Puts go out in objects of at
 * most STORAGE_KEYS_PER_CALL keys, deletes one key per call. In a transaction
 * they all commit together. Without one they are issued back to back with no
 * await between them, so Durable Object storage coalesces them into one
 * atomic write. */
export function writeActorBatch(storage, batch) {
  const apply = (target) => {
    const puts = [];
    const deletes = [];
    for (const [actor, value] of batch)
      if (value === null) deletes.push(ACTOR_PREFIX + actor);
      else puts.push([ACTOR_PREFIX + actor, value]);
    const chunks = [];
    for (let at = 0; at < puts.length; at += STORAGE_KEYS_PER_CALL)
      chunks.push(Object.fromEntries(puts.slice(at, at + STORAGE_KEYS_PER_CALL)));
    return Promise.all([
      ...chunks.map((entries) => target.put(entries)),
      ...deletes.map((key) => target.delete(key)),
    ]);
  };
  if (typeof storage.transaction === "function") return storage.transaction(apply);
  return apply(storage);
}

export const ACTOR_RETRY_MIN_MS = 1000;
export const ACTOR_RETRY_MAX_MS = 30_000;
export const actorRetryDelay = (attempt) =>
  Math.min(ACTOR_RETRY_MIN_MS * 2 ** Math.max(0, attempt - 1), ACTOR_RETRY_MAX_MS);

/** Actor persistence lifecycle. State: `phase` (`idle`, nothing being
 * written; `writing`, one batch in flight; `failed`, the last batch failed),
 * `attempt` (consecutive failures), `cycle` (a counter that grows with every
 * failure and fences retry timers) and `deadline` (when a failed batch may be
 * written again). Events: `enqueue` (new effects merged), `nudge` (a request,
 * connection or save offers a retry), `succeeded` / `failed` (the batch
 * settled; `pending` says whether writes remain), and `retry` (the timer for
 * `cycle` is due). `enqueue`, `nudge` and `failed` carry `now`. Effects:
 * `write` starts a batch; `schedule` arms the one timer for `cycle` after
 * `delay` ms. Before the deadline, `enqueue` and `nudge` only merge effects.
 * A timer from an earlier cycle never matches. Events that do not apply
 * leave the state unchanged with no effect. */
export const initialPersistenceState = Object.freeze({
  phase: "idle",
  attempt: 0,
  cycle: 0,
  deadline: 0,
});
export function persistenceTransition(state, event) {
  const same = { state, effect: null };
  const write = (next) => ({ state: { ...next, phase: "writing" }, effect: { type: "write" } });
  switch (state.phase) {
    case "idle":
      return event.type === "enqueue" ? write({ ...state, attempt: 0 }) : same;
    case "writing":
      if (event.type === "succeeded")
        return event.pending
          ? write({ ...state, attempt: 0, deadline: 0 })
          : { state: { ...state, phase: "idle", attempt: 0, deadline: 0 }, effect: null };
      if (event.type === "failed") {
        const attempt = state.attempt + 1;
        const cycle = state.cycle + 1;
        const delay = actorRetryDelay(attempt);
        return {
          state: { phase: "failed", attempt, cycle, deadline: event.now + delay },
          effect: { type: "schedule", cycle, delay },
        };
      }
      return same;
    case "failed":
      if ((event.type === "enqueue" || event.type === "nudge") && event.now >= state.deadline)
        return write(state);
      if (event.type === "retry" && event.cycle === state.cycle) return write(state);
      return same;
    default:
      return same;
  }
}

/** Serialized actor persistence with its own retries. `enqueue` merges
 * effects into the pending set; one batch of everything pending is written
 * at a time. A failed batch stays pending and is retried once its backoff
 * deadline passes: by its timer, or by the first `enqueue` or `nudge` after
 * the deadline. `hold` keeps each write and retry wait alive past the request
 * that started it. A restart drops whatever is pending; `replay` rebuilds it
 * from the stored records. */
export class ActorPersistence {
  constructor(
    storage,
    {
      hold = () => {},
      sleep = (ms) =>
        new Promise((resolve) => {
          // A retry wait never keeps a Node test process alive.
          setTimeout(resolve, ms).unref?.();
        }),
      now = Date.now,
      onError = () => {},
    } = {},
  ) {
    this.storage = storage;
    this.hold = hold;
    this.sleep = sleep;
    this.now = now;
    this.onError = onError;
    this.pending = new Map();
    this.state = initialPersistenceState;
    this.current = Promise.resolve();
  }

  enqueue(effects) {
    mergeActorEffects(this.pending, effects);
    if (this.pending.size) this.dispatch({ type: "enqueue", now: this.now() });
  }

  nudge() {
    this.dispatch({ type: "nudge", now: this.now() });
  }

  /** Settles once no batch is in flight. */
  async drain() {
    while (this.state.phase === "writing") await this.current;
  }

  /** Resolves once every accepted effect is stored; rejects while any is
   * still pending. Compaction waits on it before it removes commit records,
   * the evidence `replay` reads. */
  async durable() {
    await this.drain();
    if (this.pending.size) throw Error("Actor attestations are not yet durable");
  }

  dispatch(event) {
    const { state, effect } = persistenceTransition(this.state, event);
    this.state = state;
    if (effect?.type === "write") this.startWrite();
    if (effect?.type === "schedule") {
      const due = this.sleep(effect.delay).then(() =>
        this.dispatch({ type: "retry", cycle: effect.cycle }),
      );
      this.hold(due);
    }
  }

  startWrite() {
    const batch = new Map(this.pending);
    const work = Promise.resolve()
      .then(() => writeActorBatch(this.storage, batch))
      .then(
        () => {
          // Entries merged while this batch ran stay pending for the next one.
          for (const [actor, value] of batch)
            if (this.pending.get(actor) === value) this.pending.delete(actor);
          this.dispatch({ type: "succeeded", pending: this.pending.size > 0 });
        },
        (error) => {
          this.onError(error);
          this.dispatch({ type: "failed", now: this.now() });
        },
      );
    this.current = work;
    this.hold(work);
  }
}
