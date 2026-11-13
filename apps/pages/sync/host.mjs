import * as A from "@automerge/automerge";
import { cbor } from "@automerge/automerge-repo";
import { ADMISSION_OUTCOMES } from "../shared/admission.mjs";
import { concat, DocStore } from "./doc-store.mjs";
import { COMPACTION_READY, compactionStep } from "./compaction-machine.mjs";
import { RECEIVE_LIMITS, RECEIVE_OPEN, receiveStep } from "./receive-queue.mjs";

// The Page host's side of plain Automerge sync. Each connection arrives
// authenticated, with { principal, role, senderId, sessionId, expiresAt }.
// Per document the host keeps one live Automerge doc and one sync state per
// connection. A sync message runs in the document's serialized queue:
//
//   1. policy.denied (lease, revocation) on every frame and every delivery
//   2. role gate: a connection that can't write has its changes stripped,
//      and the rest of the message stands
//   3. preview: the message's changes on a clone of the live doc; refuse
//      missing dependencies; take the changes that are new
//   4. actor claims: each new change's actor is unclaimed or claimed by this
//      principal. New claims are reserved before anything awaits, so two
//      documents can't claim one actor for two principals
//   5. policy.admit (the Worker asks the document's type module: the block
//      shape of the Page document, the comment rules of the comments
//      document; worker/document-modules.mjs)
//   6. persist: chunk, new claims and manifest in one saveMany
//   7. adopt the preview, reply (the ack), fan out to the other connections
//   8. compact when the chunks outgrow the snapshot. The frame is already
//      stored and acked, so a compaction failure is reported, not refused,
//      and later writes back off (compaction-machine.mjs)
//
// A refusal leaves the live doc and every sync state untouched. Changes the
// host already holds are filtered in step 3, so re-sending accepted history is
// a no-op whoever sends it. A `trusted` connection is the host's own Repo:
// it skips the role gate, claims, policy.admit and the receive limits, and is
// never closed.
//
// Each browser connection has a receive queue bound (receive-queue.mjs) and
// an ephemeral payload cap; going over either refuses the frame and closes the
// socket. Every preview the host doesn't adopt is freed, and so is the live
// doc an adopted preview replaces, unless it was handed to a reader.

/** Receive bounds per browser connection. */
export const HOST_LIMITS = Object.freeze({
  ...RECEIVE_LIMITS,
  // Presence (a selection) is a few hundred bytes; the host fans each
  // message out to every reader.
  maxEphemeralBytes: 64 * 1024,
});

/**
 * A refused frame. `fatal` closes the connection, with `close` as the WebSocket
 * code and reason when given (default 4400 `request_rejected`).
 */
export class Refusal extends Error {
  constructor(code, message, { fatal = false, close } = {}) {
    super(message);
    this.code = code;
    this.fatal = fatal;
    this.close = close;
  }
}

const ACTOR_PREFIX = "actor/";
const WRITE_ROLES = {
  page: ["owner", "editor"],
  comments: ["owner", "editor", "commenter"],
};
const READ_ROLES = ["owner", "editor", "commenter", "viewer"];

const DURABLE = Object.freeze({ status: "durable" });
function durabilityStep(state, event) {
  if (event.type === "failed")
    return {
      status: "failed",
      error: event.error,
      heads: [...new Set([...(state.heads ?? []), ...event.heads])],
      contexts: {
        ...state.contexts,
        ...Object.fromEntries(
          event.changes.map((bytes) => [A.decodeChange(bytes).hash, event.context]),
        ),
      },
      pending: [
        ...new Map(
          [...(state.pending ?? []), ...event.changes].map((bytes) => [
            A.decodeChange(bytes).hash,
            bytes,
          ]),
        ).values(),
      ],
    };
  // A terminal refusal retires the pending closure, including dependent bytes.
  if (event.type === "repaired" || event.type === "refused") return DURABLE;
  return state;
}

/** Lease expiry and role checks; the worker supplies its own policy. */
export const defaultPolicy = {
  denied(conn, now) {
    if (conn.expiresAt !== undefined && conn.expiresAt <= now)
      return new Refusal("expired", "The connection's lease has expired", {
        fatal: true,
      });
    return null;
  },
  canRead: (conn) => READ_ROLES.includes(conn.role),
  canWrite: (conn, doc) => WRITE_ROLES[doc.kind]?.includes(conn.role) ?? false,
  /** Returns `preview`, or a replacement on its own handle (the host frees
   * whichever it doesn't adopt). */
  admit: (_conn, _doc, _live, _fresh, preview) => preview,
  /** Trusted write fences and schema/history limits, before persistence.
   * Arguments: (doc, live, fresh, preview, context, conn, origin).
   * origin is mutate, replay, retry, or bridge (test/benchmark transports).
   * Already-admitted pending bytes bypass this hook on retry. */
  admitTrusted: (_doc, _live, _fresh, preview) => preview,
  /** After persist: `fresh` changes and the actor `claims` made for them. */
  admitted() {},
  /** A connection's first frame for `doc`; from now on it receives fan-out. */
  joined() {},
  refused() {},
  /** A frame whose changes were stored and acked: `ms` from its arrival to
   * the ack, `waitMs` of that in the document's queue. */
  synced() {},
  /** A compaction attempt after an ack failed (`{ failures }` in a row); the
   * frame's history is already stored. */
  compactionFailed() {},
  /** A closed browser connection has nothing left running: no later
   * refusal or round will be reported for it. */
  released() {},
};

export class SyncHost {
  #bytes;
  #actors = new Map();
  #reserved = new Map();
  #docs = new Map();
  #conns = new Set();
  #listeners = new Map();
  #borrowed = new WeakSet();
  hostActorPrefix;
  stats = {
    admitted: 0,
    refused: 0,
    stripped: 0,
    compactions: 0,
    compactionFailures: 0,
    freed: 0,
  };

  constructor({ bytes, policy = {}, hostId = "pages-host", now = () => Date.now(), limits = {} }) {
    this.#bytes = bytes;
    this.store = new DocStore(bytes);
    this.policy = { ...defaultPolicy, ...policy };
    this.hostId = hostId;
    this.now = now;
    this.limits = { ...HOST_LIMITS, ...limits };
  }

  /** Read stored actor claims. Call once before accepting connections. */
  async load() {
    for (const key of await this.#bytes.list(ACTOR_PREFIX)) {
      const bytes = await this.#bytes.load(key);
      if (bytes) this.#actors.set(key.slice(ACTOR_PREFIX.length), cbor.decode(bytes));
    }
    return this;
  }

  /** Declare a document this host serves. Its live doc loads on first use.
   * One id is one document of one kind: declaring a served id under another
   * kind (a derived id that equals the Page's own, say) is refused, so no
   * document is ever written under two kinds' rules. */
  register(id, kind = "page") {
    let doc = this.#docs.get(id);
    if (doc && doc.kind !== kind)
      throw Object.assign(
        Error(`This Page already serves that document as ${doc.kind}, not ${kind}`),
        { status: 409, code: "document_conflict" },
      );
    if (!doc) {
      doc = {
        id,
        kind,
        live: null,
        loading: null,
        reloadNeeded: false,
        conns: new Map(),
        queue: Promise.resolve(),
        durability: DURABLE,
        publishedHeads: null,
        compaction: COMPACTION_READY,
      };
      this.#docs.set(id, doc);
    }
    return doc;
  }

  /** Host-created history (a new Page or comments genesis) as the first snapshot. */
  async seed(id, kind, automergeDoc) {
    const doc = this.register(id, kind);
    await this.#run(doc, async () => {
      const live = await this.#live(doc);
      const next = A.merge(A.clone(live), automergeDoc);
      if (!A.getChangesSince(next, A.getHeads(live)).length) return this.#free(next);
      try {
        await this.store.compact(id, A.save(next), A.getHeads(next));
      } catch (error) {
        this.#free(next);
        throw error;
      }
      doc.live = next;
      this.#repair(doc, next);
      this.#committed(doc);
      this.#free(live);
    });
    return doc;
  }

  /** Borrow the committed root synchronously; null until document(id) loads it.
   * Readers must not mutate or free it. Clone before changing it. */
  doc(id) {
    return this.#borrow(this.#docs.get(id)?.live ?? null);
  }

  /** The borrowed live document, loading it from storage if needed. */
  async document(id) {
    const doc = this.#docs.get(id);
    return doc ? this.#borrow(await this.#live(doc)) : null;
  }

  on(event, listener) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(listener);
    return this;
  }

  off(event, listener) {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  /** Trusted host edits pass admitTrusted and share admission and storage.
   * fn is synchronous. Actors must belong to the configured host namespace.
   * An append rejection with error.queued=true retains this call's exact
   * changes: do not re-run fn; await durable(id) to confirm it. A prerequisite
   * retry failure has code pending_retry_failed and queued=false: this call
   * did not run, so retry it after storage recovers. */
  mutate(id, fn, { actor } = {}) {
    if (!this.hostActorPrefix) throw new Error("mutate requires hostActorPrefix");
    actor ??=
      this.hostActorPrefix +
      Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    if (typeof actor !== "string" || !actor.startsWith(this.hostActorPrefix))
      throw new Error("Mutation actor must belong to hostActorPrefix");
    return this.#mutate(id, (clone) => A.change(clone, fn), { actor });
  }

  /** Replay exact recorded bytes, including a dependency-reversed closure.
   * The queued/pending_retry_failed error contract is the same as mutate. */
  applyChanges(id, changes, { fenceExempt = false } = {}) {
    // Own the queued input; callers may reuse their journal buffers meanwhile.
    const bytes = concat(changes);
    return this.#mutate(
      id,
      (clone) => A.loadIncremental(clone, bytes),
      undefined,
      {
        fenceExempt: fenceExempt === true,
      },
      "replay",
    );
  }

  #mutate(id, build, options, context = {}, origin = "mutate") {
    const doc = this.#docs.get(id);
    if (!doc) return Promise.reject(new Error(`Unknown document ${id}`));
    return this.#run(doc, async () => {
      try {
        await this.#retryPending(doc);
      } catch (cause) {
        if (cause.code === "pending_retry_refused") throw cause;
        const error = new Error("Earlier pending changes could not be persisted; retry this call", {
          cause,
        });
        error.code = "pending_retry_failed";
        error.queued = false;
        throw error;
      }
      const live = await this.#live(doc);
      const clone = A.clone(live, options);
      let preview = clone;
      let next;
      try {
        preview = build(clone);
        next = await this.#admitPreview({ trusted: true, context, origin }, doc, live, preview, {});
        if (!next) return { heads: A.getHeads(live), changes: [] };
        const changes = A.getChangesSince(next, A.getHeads(live));
        const heads = A.getHeads(next);
        doc.live = next;
        this.#committed(doc);
        this.#free(live);
        await this.#compact(doc);
        return { heads, changes };
      } finally {
        if (next !== preview) this.#free(preview);
      }
    });
  }

  /** Fence earlier work and retry pending trusted bytes. Failures clear only
   * when their exact heads are contained in stored-and-adopted history. */
  durable(id) {
    const doc = this.#docs.get(id);
    if (!doc) return Promise.reject(new Error(`Unknown document ${id}`));
    return this.#run(doc, async () => {
      await this.#retryPending(doc);
      this.#repair(doc, await this.#live(doc));
      if (doc.durability.status === "failed") throw doc.durability.error;
    });
  }

  /** Heads of the last durable commit (what /api/saved reports). */
  async durableHeads(id) {
    const doc = this.#docs.get(id);
    if (!doc) return [];
    await doc.queue;
    return (await this.store.open(id))?.heads ?? [];
  }

  /** Unregister before draining, so arriving frames cannot resurrect removed history. */
  async remove(id) {
    const doc = this.#docs.get(id);
    if (doc) {
      this.#docs.delete(id);
      await doc.queue;
      await doc.loading;
      if (doc.live) this.#free(doc.live);
    }
    await this.store.remove(id);
  }

  /** Close transports and drain admitted work without removing durable history. */
  async close() {
    await Promise.all(
      [...this.#conns].map(
        (conn) =>
          new Promise((resolve) => {
            conn.transport.onClose(resolve);
            conn.transport.close(1001, "Going away");
          }),
      ),
    );
    for (const doc of this.#docs.values()) {
      await doc.queue;
      await doc.loading;
      if (doc.live) this.#free(doc.live);
    }
    this.#docs.clear();
    this.#listeners.clear();
  }

  actor(actor) {
    return this.#actors.get(actor);
  }

  actors() {
    return new Map(this.#actors);
  }

  connections() {
    return [...this.#conns];
  }

  accept(transport, identity) {
    const conn = { transport, ...identity, closed: false, receive: RECEIVE_OPEN };
    this.#conns.add(conn);
    transport.onMessage((frame) => this.#onFrame(conn, frame));
    transport.onClose(() => {
      conn.closed = true;
      this.#receive(conn, { type: "close" });
      this.#conns.delete(conn);
      for (const doc of this.#docs.values()) doc.conns.delete(conn);
    });
    return conn;
  }

  /** Close every connection the predicate selects with an application code. */
  disconnect(predicate, code = 4409, reason = "access_changed") {
    for (const conn of [...this.#conns])
      if (!conn.trusted && predicate(conn)) conn.transport.close(code, reason);
  }

  /** Send a host message to every reader of `id` (or one connection). */
  broadcast(id, envelope, { to, sender } = {}) {
    const doc = this.#docs.get(id);
    if (!doc) return;
    for (const conn of to ? [to] : doc.conns.keys())
      if (this.#deliverable(conn, doc))
        conn.transport.send({
          t: "eph",
          doc: id,
          e: envelope,
          sender: sender ?? { kind: "pages-host", id: this.hostId },
        });
  }

  #onFrame(conn, frame) {
    const doc = this.#docs.get(frame.doc);
    if (!doc || !(conn.trusted || this.policy.canRead(conn, doc))) {
      conn.transport.send({
        t: "sync",
        doc: frame.doc,
        m: null,
        r: frame.r,
        heads: [],
        has: false,
      });
      return;
    }
    const denied = !conn.trusted && this.policy.denied(conn, this.now());
    if (denied) return this.#refuse(conn, doc, frame, denied);
    if (frame.t === "eph") return this.#ephemeral(conn, doc, frame);
    if (frame.t !== "sync") return;
    const received = this.now();
    if (conn.trusted) {
      this.#run(doc, () => this.#sync(conn, doc, frame, received)).catch((error) =>
        this.#refuse(conn, doc, frame, error),
      );
      return;
    }
    const bytes = frame.m?.byteLength ?? 0;
    const arrived = receiveStep(conn.receive, { type: "arrive", bytes }, this.limits);
    conn.receive = arrived.state;
    if (arrived.effect === "refuse")
      return this.#refuse(
        conn,
        doc,
        frame,
        new Refusal("receive_queue_full", "Too many sync frames are waiting on this connection", {
          fatal: true,
          close: {
            code: ADMISSION_OUTCOMES.temporarily_unavailable.close,
            reason: "temporarily_unavailable",
          },
        }),
      );
    if (arrived.effect !== "admit") return;
    const settle = () => this.#receive(conn, { type: "settle", bytes });
    // Refuse before settling: a closed connection's release follows its
    // last refusal.
    this.#run(doc, () => this.#sync(conn, doc, frame, received)).then(settle, (error) => {
      this.#refuse(conn, doc, frame, error);
      settle();
    });
  }

  /** A close or settle on the receive queue, and its release effect. */
  #receive(conn, event) {
    const { state, effect } = receiveStep(conn.receive, event, this.limits);
    conn.receive = state;
    if (effect !== "release" || conn.trusted) return;
    try {
      this.policy.released(conn);
    } catch {
      /* Reporting must not stop the close. */
    }
  }

  #borrow(doc) {
    // Roots/views share a WASM handle. Track that handle, not a JS root. Legacy
    // doc() consumers retain snapshots across awaits without release callbacks,
    // so exposed handles use Automerge's GC finalizer instead of explicit free.
    // This keeps reads safe, but retained snapshots and delayed GC raise peak
    // memory; the WeakSet itself does not keep retired handles alive.
    if (doc) this.#borrowed.add(A.getBackend(doc));
    return doc;
  }

  #emit(event, payload) {
    // Snapshot subscriptions so listeners added during delivery wait for the next event.
    const listeners = [...(this.#listeners.get(event) ?? [])];
    for (const listener of listeners)
      try {
        listener(payload);
      } catch {
        /* Observers must not turn a durable commit into a failed write. */
      }
  }

  #committed(doc, origin) {
    const heads = A.getHeads(doc.live);
    const before = doc.publishedHeads;
    if (before === null) {
      doc.publishedHeads = heads;
      return;
    }
    if (heads.length === before.length && heads.every((head) => before.includes(head))) return;
    // Publication is independent of loading: an append can commit even when
    // its response is lost. Reload must publish that history exactly once.
    doc.publishedHeads = heads;
    if (this.#listeners.get("change")?.size)
      this.#emit("change", {
        id: doc.id,
        patches: A.diff(doc.live, before, heads),
        heads,
      });
    this.#emit("heads-changed", { id: doc.id, heads });
    this.#fanOut(doc, origin);
  }

  #repair(doc, live) {
    if (doc.durability.status !== "failed") return;
    if (A.hasHeads(live, doc.durability.heads))
      doc.durability = durabilityStep(doc.durability, { type: "repaired" });
    else
      doc.durability = {
        ...doc.durability,
        pending: doc.durability.pending.filter(
          (bytes) => !A.hasHeads(live, [A.decodeChange(bytes).hash]),
        ),
      };
  }

  async #retryPending(doc) {
    if (!doc.durability.pending?.length) return;
    const live = await this.#live(doc);
    if (!doc.durability.pending?.length) return;
    // A retry carries only the capability captured with these exact bytes.
    // A later internal operation must never exempt an earlier ordinary write.
    const pending = doc.durability.pending;
    const context = doc.durability.contexts[A.decodeChange(pending[0]).hash] ?? {};
    const end = pending.findIndex(
      (bytes) =>
        !!doc.durability.contexts[A.decodeChange(bytes).hash]?.fenceExempt !==
          !!context.fenceExempt ||
        !!doc.durability.contexts[A.decodeChange(bytes).hash]?.admitted !== !!context.admitted,
    );
    let next;
    try {
      next = await this.#admit(
        { trusted: true, context, origin: "retry" },
        doc,
        live,
        pending.slice(0, end < 0 ? pending.length : end),
        {},
      );
    } catch (cause) {
      if (!(cause instanceof Refusal)) throw cause;
      // No later durable call may resurrect a refused closure. Ordinary IO
      // errors still retain exact bytes; dependent pending bytes retire too.
      doc.durability = durabilityStep(doc.durability, { type: "refused" });
      throw Object.assign(new Error("Pending changes were refused and discarded", { cause }), {
        code: "pending_retry_refused",
        queued: false,
      });
    }
    if (!next) return;
    doc.live = next;
    this.#repair(doc, next);
    this.#committed(doc);
    this.#free(live);
    await this.#compact(doc);
    await this.#retryPending(doc);
  }

  /** Free an unexposed Automerge handle the host no longer holds. */
  #free(automergeDoc) {
    if (this.#borrowed.has(A.getBackend(automergeDoc))) return;
    try {
      A.free(automergeDoc);
      this.stats.freed++;
    } catch {
      /* Already freed. */
    }
  }

  #run(doc, work) {
    const run = doc.queue
      .catch(() => {})
      .then(async () => {
        if (doc.reloadNeeded) await this.#live(doc);
        return work();
      });
    doc.queue = run.catch(() => {});
    return run;
  }

  async #live(doc) {
    if (doc.live && !doc.reloadNeeded) return doc.live;
    doc.loading ??= (doc.reloadNeeded ? this.load() : Promise.resolve())
      .then(() => this.store.read(doc.id))
      .then((stored) => {
        const previous = doc.live;
        doc.live = stored
          ? A.load(concat([stored.snapshot, ...stored.chunks].filter(Boolean)))
          : A.init();
        doc.reloadNeeded = false;
        this.#repair(doc, doc.live);
        this.#committed(doc);
        if (previous) this.#free(previous);
        doc.loading = null;
        return doc.live;
      })
      .catch((error) => {
        doc.loading = null;
        throw error;
      });
    return doc.loading;
  }

  async #sync(conn, doc, frame, received) {
    const started = this.now();
    let live = await this.#live(doc);
    if (conn.closed) return;
    const denied = !conn.trusted && this.policy.denied(conn, this.now());
    if (denied) throw denied;
    this.#join(conn, doc);
    let state = doc.conns.get(conn);
    let message = frame.m;
    const decoded = message ? A.decodeSyncMessage(message) : null;
    let replaced = null;
    const round = { changes: 0, bytes: 0 };
    if (decoded?.changes.length) {
      if (!conn.trusted && !this.policy.canWrite(conn, doc)) {
        this.stats.stripped += decoded.changes.length;
        decoded.changes = [];
        message = A.encodeSyncMessage(decoded);
      } else {
        const next = await this.#admit(conn, doc, live, decoded.changes, round);
        if (next) [replaced, live] = [live, next];
      }
    }
    if (message) [live, state] = A.receiveSyncMessage(live, state, message);
    doc.live = live;
    if (replaced) this.#free(replaced);
    let reply;
    [state, reply] = A.generateSyncMessage(live, state);
    doc.conns.set(conn, state);
    conn.transport.send({
      t: "sync",
      doc: doc.id,
      m: reply ?? null,
      r: frame.r,
      heads: A.getHeads(live),
      has: true,
    });
    if (round.changes)
      try {
        const acked = this.now();
        this.policy.synced(conn, doc, {
          ms: acked - received,
          waitMs: started - received,
          ...round,
        });
      } catch {
        /* Reporting must not stop the sync. */
      }
    this.#committed(doc, conn);
    await this.#compact(doc);
  }

  /**
   * Fold the chunks into one snapshot, after the ack. The frame's history is
   * already stored, so a failure is reported and left for the next write.
   */
  async #compact(doc) {
    if (!this.store.wantsCompaction(doc.id)) return;
    const due = compactionStep(doc.compaction, { type: "due" });
    doc.compaction = due.state;
    if (due.effect !== "compact") return;
    try {
      await this.store.compact(doc.id, A.save(doc.live), A.getHeads(doc.live));
      doc.compaction = compactionStep(doc.compaction, { type: "succeeded" }).state;
      this.stats.compactions++;
    } catch (error) {
      const failed = compactionStep(doc.compaction, { type: "failed" });
      doc.compaction = failed.state;
      this.stats.compactionFailures++;
      if (failed.effect === "report")
        try {
          this.policy.compactionFailed(doc, error, { failures: failed.state.failures });
        } catch {
          /* Reporting must not fail the frame. */
        }
    }
  }

  /**
   * Steps 3-6. Returns the admitted doc, or null when nothing was new. The
   * preview is a clone of `live`; it is freed unless it is returned.
   */
  async #admit(conn, doc, live, changes, round) {
    const clone = A.clone(live);
    let preview;
    try {
      preview = A.loadIncremental(clone, concat(changes));
    } catch {
      this.#free(clone);
      throw new Refusal("malformed_change", "A change could not be loaded");
    }
    let admitted;
    try {
      admitted = await this.#admitPreview(conn, doc, live, preview, round);
      return admitted;
    } finally {
      if (admitted !== preview) this.#free(preview);
    }
  }

  async #admitPreview(conn, doc, live, preview, round) {
    const heads = A.getHeads(live);
    if (A.getMissingDeps(preview, []).length)
      throw new Refusal("missing_dependencies", "A change arrived before its dependencies");
    const fresh = A.getChangesSince(preview, heads);
    if (!fresh.length) return null;
    const claims = new Map();
    for (const bytes of fresh) {
      const { actor } = A.decodeChange(bytes);
      // This namespace belongs to the host, including actors not seen yet.
      // Its fresh mutation actors need no persisted claim; knowing the prefix
      // never grants a browser authority to author or relay new host changes.
      if (this.hostActorPrefix && actor.startsWith(this.hostActorPrefix)) {
        if (!conn.trusted)
          throw new Refusal("actor_claimed", `Actor ${actor} belongs to the host`, { fatal: true });
        continue;
      }
      const claimed = this.#actors.has(actor) || this.#reserved.has(actor);
      const owner = this.#actors.get(actor)?.principal ?? this.#reserved.get(actor);
      // The host's own Repo may carry anyone's history; it claims only actors
      // nobody has claimed yet.
      if (!conn.trusted && claimed && owner !== conn.principal)
        throw new Refusal("actor_claimed", `Actor ${actor} belongs to another principal`);
      if (!claimed && !claims.has(actor)) claims.set(actor, this.#claim(conn));
    }
    const next = conn.trusted
      ? conn.origin === "retry" && conn.context?.admitted
        ? preview
        : await this.policy.admitTrusted(
            doc,
            live,
            fresh,
            preview,
            conn.context ?? {},
            conn,
            conn.origin ?? "bridge",
          )
      : await this.policy.admit(conn, doc, live, fresh, preview, (actor) =>
          this.#owner(actor, claims, conn),
        );
    try {
      await this.#persist(conn, doc, fresh, next, claims);
    } catch (error) {
      // #admit frees the original preview; a replacement is ours to free.
      if (next !== preview) this.#free(next);
      throw error;
    }
    this.stats.admitted += fresh.length;
    round.changes = fresh.length;
    round.bytes = fresh.reduce((n, c) => n + c.byteLength, 0);
    // Before the reply and fan-out, so a host message it sends (who wrote
    // these changes) reaches each reader ahead of the changes themselves.
    try {
      this.policy.admitted(conn, doc, fresh, claims);
    } catch {
      /* Reporting must not undo a durable admission. */
    }
    return next;
  }

  /** Steps 4 (re-check after policy.admit) and 6: claims and history, stored. */
  async #persist(conn, doc, fresh, next, claims) {
    if (!conn.trusted) {
      if (conn.closed) throw new Refusal("closed", "The connection closed during admission");
      // policy.admit may await: re-check that no other document claimed
      // these actors meanwhile, before reserving them.
      for (const actor of claims.keys())
        if (this.#actors.has(actor) || this.#reserved.has(actor))
          throw new Refusal("actor_claimed", `Actor ${actor} belongs to another principal`);
    }
    for (const actor of claims.keys()) this.#reserved.set(actor, conn.principal);
    try {
      const extra = [...claims].map(([actor, claim]) => [ACTOR_PREFIX + actor, cbor.encode(claim)]);
      await this.store.append(doc.id, concat(fresh), A.getHeads(next), extra);
      for (const [actor, claim] of claims) this.#actors.set(actor, claim);
      this.#repair(doc, next);
    } catch (error) {
      // Only trusted attempts may be replayed without browser authorization.
      // Keep our own bytes: callers can journal or modify error.changes.
      if (!(error instanceof Error)) error = new Error(String(error), { cause: error });
      if (conn.trusted) {
        const changes = fresh.map((bytes) => bytes.slice());
        error.changes = fresh.map((bytes) => bytes.slice());
        error.queued = true;
        doc.durability = durabilityStep(doc.durability, {
          type: "failed",
          error,
          heads: A.getHeads(next),
          changes,
          // Reaching persistence proves these exact bytes passed trusted policy.
          // applyChanges never accepts this marker from its caller.
          context: { ...conn.context, admitted: true },
        });
      }
      // A failed append may have committed before its response was lost.
      // Keep the last committed root readable, never the failed candidate.
      // Reload history and claims before queued work can compact or extend it;
      // publishedHeads ensures an ambiguous commit is published exactly once.
      doc.reloadNeeded = true;
      throw error;
    } finally {
      for (const actor of claims.keys()) this.#reserved.delete(actor);
    }
  }

  /** The principal an actor is (or, in this admission, would be) claimed by. */
  #owner(actor, claims, conn) {
    if (claims.has(actor)) return conn.principal;
    return this.#actors.get(actor)?.principal ?? this.#reserved.get(actor);
  }

  #claim(conn) {
    return conn.trusted
      ? { host: true, firstSeen: this.now() }
      : {
          principal: conn.principal,
          displayName: conn.displayName,
          driver: conn.driver,
          senderId: conn.senderId,
          firstSeen: this.now(),
        };
  }

  #join(conn, doc) {
    if (doc.conns.has(conn)) return;
    doc.conns.set(conn, A.initSyncState());
    try {
      this.policy.joined(conn, doc);
    } catch {
      /* Reporting must not stop the sync. */
    }
  }

  #deliverable(conn, doc) {
    if (conn.closed) return false;
    if (conn.trusted) return true;
    const denied = this.policy.denied(conn, this.now());
    if (!denied) return true;
    this.#refuse(conn, doc, {}, denied);
    doc.conns.delete(conn);
    return false;
  }

  #fanOut(doc, origin) {
    for (const [conn, state] of doc.conns) {
      if (conn === origin || !this.#deliverable(conn, doc)) continue;
      const [next, m] = A.generateSyncMessage(doc.live, state);
      doc.conns.set(conn, next);
      if (m)
        conn.transport.send({
          t: "sync",
          doc: doc.id,
          m,
          heads: A.getHeads(doc.live),
          has: true,
        });
    }
  }

  #refuse(conn, doc, frame, error) {
    if (!(error instanceof Refusal))
      error = new Refusal("io", "The host couldn't store this change");
    this.stats.refused++;
    try {
      this.policy.refused(conn, doc, error);
    } catch {
      /* Logging must not stop the refusal. */
    }
    if (conn.closed) return;
    conn.transport.send({
      t: "refused",
      doc: doc.id,
      r: frame.r,
      code: error.code,
      message: error.message,
      fatal: error.fatal,
    });
    if (error.fatal && !conn.trusted)
      conn.transport.close(error.close?.code ?? 4400, error.close?.reason ?? "request_rejected");
  }

  #ephemeral(conn, doc, frame) {
    if (!conn.trusted && frame.e.payload.byteLength > this.limits.maxEphemeralBytes)
      return this.#refuse(
        conn,
        doc,
        frame,
        new Refusal("ephemeral_too_large", "An ephemeral message is over the host's limit", {
          fatal: true,
        }),
      );
    if (!conn.trusted && this.policy.ephemeral && !this.policy.ephemeral(conn, doc, frame.e))
      return;
    const sender = {
      kind: conn.trusted ? "pages-host" : "pages-session",
      id: conn.trusted ? this.hostId : conn.senderId,
    };
    this.#join(conn, doc);
    if (!conn.trusted)
      this.#emit("ephemeral", { id: doc.id, senderId: sender.id, message: frame.e });
    for (const other of doc.conns.keys())
      if (other !== conn && this.#deliverable(other, doc))
        other.transport.send({ t: "eph", doc: doc.id, e: frame.e, sender });
  }
}
