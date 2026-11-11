import * as A from "@automerge/automerge";
import { cbor } from "@automerge/automerge-repo";
import {
  BackendError,
  copyRecord,
  equalRecords,
  recordBytes,
  recordHead,
  recordKey,
  sedimentreeId,
} from "@automerge/automerge-repo/sedimentree";
import {
  extractRecords,
  validateDeliveredRecord,
} from "@automerge/automerge-repo/sedimentree/automerge";
import { Observation, ReplayLog } from "./replay-log.mjs";
import { concat } from "./doc-store.mjs";

// Repo 3's SedimentreeBackend over plain Automerge sync with one host.
//
// Each tree keeps a mirror Automerge document: Repo's interface carries
// records, and sync messages need a document to generate from and receive
// into. Local storage is a DocStore (snapshot plus chunks); a chunk is the
// concatenated Automerge chunks of one store or one received message, so a
// tree loads with one A.load.
//
// Repo receives whole documents as one `document` record (patch-document-
// record.mjs): on open, and when a cold tree receives the host's document.
// Increments arrive as loose commits, or one bundle when large.
//
// Records that aren't Automerge chunks are refused, unless `strict: false`:
// then a tree that receives one keeps every record verbatim and never syncs.
// That mode exists for Repo's format-agnostic contract suite.

const LOOSE_LIMIT = 256;
// Refusals that a resend of the same changes would meet again. Later rounds
// acknowledge the host's history without advertising the refused heads.
const TERMINAL_REFUSALS = new Set([
  "actor_claimed",
  "history_capacity",
  "invalid_block",
  "malformed_change",
]);

// One fresh handshake per attempt. Repetition requires an explicit new attempt;
// it is not evidence that any local history may be discarded.
export function dependencyRecoveryStep(state, event) {
  if (event === "start") return state === "retrying" || state === "suspended" ? state : "ready";
  if (event === "complete" || event === "connect") return "ready";
  if (event === "suspend") return state === "retrying" ? "suspended" : state;
  if (event === "resume") return state === "suspended" ? "retrying" : state;
  if (event === "missing") return state === "ready" ? "retrying" : "blocked";
  return "blocked";
}

export class AutomergeSyncBackend {
  #opts;
  #store;
  #trees = new Map();
  #deleting = new Map();
  #collection;
  #collectionWatches = new Set();
  #closed = false;
  #round = 0;
  #conn = null;
  #frame = 0;
  stats = { documentRecords: 0, looseRecords: 0, bundles: 0, compactions: 0 };

  /** Use `AutomergeSyncBackend.load`, which reads stored trees first. */
  constructor(options) {
    this.#opts = {
      strict: options.strict ?? true,
      batchRecords: options.batchRecords ?? 128,
      batchBytes: options.batchBytes ?? 1024 * 1024,
      maxRecordBytes: options.maxRecordBytes ?? 16 * 1024 * 1024,
      // A document record is a whole snapshot, bounded like one.
      maxSnapshotBytes: options.maxSnapshotBytes ?? 16 * 1024 * 1024,
      replayEvents: options.replayEvents ?? 128,
      replayBytes: options.replayBytes ?? 4 * 1024 * 1024,
      syncTimeoutMs: options.syncTimeoutMs ?? 10_000,
      // The app decides when a local store's round starts (OutboundSync).
      scheduleLocalSync: options.scheduleLocalSync ?? ((_id, start) => queueMicrotask(start)),
      onRefusal: options.onRefusal ?? (() => {}),
    };
    this.#store = options.store;
    this.#collection = this.#log();
  }

  /** A backend over `store`, with every stored tree loaded into memory. */
  static async load(options) {
    const backend = new AutomergeSyncBackend(options);
    await backend.#loadAll();
    return backend;
  }

  async #loadAll() {
    for (const id of await this.#store.ids()) {
      const stored = await this.#store.read(id);
      const tree = this.#tree(id);
      tree.persisted = true;
      tree.sync.state = decodeSyncState(await this.#store.syncState(id));
      if (stored.manifest.format === "opaque") {
        tree.opaque = true;
        for (const chunk of stored.chunks)
          for (const record of cbor.decode(chunk).records.map(fromWire)) this.#keep(tree, record);
      } else {
        tree.mirror = A.load(concat([stored.snapshot, ...stored.chunks].filter(Boolean)));
      }
    }
  }

  // ---- SedimentreeBackend ---------------------------------------------------

  observeCollection() {
    this.#assertOpen("observe");
    const ids = [...this.#trees].filter(([, t]) => hasData(t)).map(([id]) => id);
    const sequence = this.#collection.sequence;
    function* initial() {
      for (const id of ids) yield { type: "document", id, phase: "initial", sequence };
      yield { type: "local-load-complete", sequence };
    }
    const watch = new Observation(
      initial(),
      this.#collection,
      (e) => ({ ...e }),
      (sequence) => ({ type: "rescan-required", sequence }),
      () => this.#collectionWatches.delete(watch),
    );
    this.#collectionWatches.add(watch);
    return watch;
  }

  async create(initialRecords, options = {}) {
    this.#assertOpen("create");
    if (!initialRecords.length)
      throw new BackendError("create", "invalid-record", "Initial history is empty");
    const id = sedimentreeId(options.documentId ?? crypto.getRandomValues(new Uint8Array(32)));
    if (this.#deleting.has(id))
      throw new BackendError("create", "deleted", "Deletion in progress", true);
    const existing = this.#trees.get(id);
    if (existing && hasData(existing))
      throw new BackendError("create", "conflict", "Document already exists");
    await this.store(id, initialRecords);
    return id;
  }

  open(rawId) {
    this.#assertOpen("open");
    const id = sedimentreeId(rawId);
    if (this.#deleting.has(id))
      throw new BackendError("open", "deleted", "Deletion in progress", true);
    const tree = this.#tree(id);
    this.#settle(tree);
    // Pin the cut now; encode on first pull.
    const sequence = tree.log.sequence;
    const found = hasData(tree);
    const heads = headsOf(tree);
    const pinned = tree.opaque
      ? [...tree.records.values()].flat()
      : tree.mirror && A.clone(tree.mirror);
    const batches = () =>
      this.#batches(
        tree.opaque ? pinned : pinned && A.getHeads(pinned).length ? [documentRecord(pinned)] : [],
      );
    function* initial() {
      for (const records of batches())
        yield { type: "records", phase: "initial", sequence, records };
      yield {
        type: "local-load-complete",
        checkpoint: { sequence, heads },
        found,
      };
    }
    const watch = new Observation(
      initial(),
      tree.log,
      copyEvent,
      (seq) => ({ type: "rescan-required", sequence: seq }),
      () => {
        session.invalidate();
        tree.sessions.delete(session);
      },
    );
    const session = new Session(
      watch,
      (options) => this.#synchronize(tree, options),
      (message) => this.#publish(tree, message),
    );
    tree.sessions.add(session);
    if (this.#conn && !tree.opaque) this.#kick(tree, false);
    return session;
  }

  async store(rawId, batch) {
    this.#assertOpen("store");
    const id = sedimentreeId(rawId);
    if (this.#deleting.has(id))
      throw new BackendError("store", "deleted", "Deletion in progress", true);
    // Validate and copy before the first await: callers may reuse buffers.
    const staged = [];
    let opaque = false;
    try {
      for (const input of batch) {
        const limit =
          input?.kind === "document" ? this.#opts.maxSnapshotBytes : this.#opts.maxRecordBytes;
        if (recordBytes(input) > limit) throw new TypeError("Record exceeds its size limit");
        try {
          staged.push(validateDeliveredRecord(input));
        } catch (error) {
          if (this.#opts.strict) throw error;
          staged.push(copyRecord(input));
          opaque = true;
        }
      }
    } catch (error) {
      throw new BackendError("store", "invalid-record", "Invalid record", false, { cause: error });
    }
    const tree = this.#tree(id);
    this.#settle(tree);
    if (opaque && !tree.opaque) {
      if (tree.mirror)
        throw new BackendError("store", "invalid-record", "Opaque record for an Automerge tree");
      tree.opaque = true;
    }
    if (tree.opaque) return this.#storeOpaque(tree, staged);
    tree.refusedTerminal = false;

    const mirror = tree.mirror ?? A.init();
    const before = A.getHeads(mirror);
    const fresh = staged.filter((r) => r.kind !== "commit" || !A.hasHeads(mirror, [r.id]));
    if (!fresh.length && !tree.failure) return;
    let next = mirror;
    if (fresh.length) next = A.loadIncremental(mirror, concat(fresh.map((r) => r.blob)));
    tree.mirror = next;
    const added = A.getChangesSince(next, before);
    const pending = A.getMissingDeps(next, []).length > 0;
    // The mirror already contains these edits. Hold reply follow-ups across
    // persistence too, until the app's scheduler can start their batch.
    if (added.length) tree.held = true;
    try {
      if (added.length) this.#announce(tree, staged);
      if (added.length || pending) {
        const chunk = concat(fresh.map((r) => r.blob));
        await this.#enqueue(tree, () => this.#persist(tree, chunk));
      } else if (tree.failure) {
        await this.#enqueue(tree, async () => {});
      }
    } finally {
      if (added.length) {
        tree.sync.recovery = dependencyRecoveryStep(tree.sync.recovery, "start");
        tree.dirty = true;
        // Even a rejected store must release its hold through the scheduler:
        // a duplicate-record retry repairs persistence without adding edits.
        tree.held = true;
        this.#opts.scheduleLocalSync(id, () => {
          tree.held = false;
          this.#kick(tree, false);
        });
      }
    }
  }

  async flush(ids) {
    this.#assertOpen("flush");
    const targets = ids ? ids.map(sedimentreeId) : [...this.#trees.keys()];
    const errors = [];
    for (const id of targets) {
      const tree = this.#trees.get(id);
      if (!tree) continue;
      await tree.queue.catch(() => {});
      if (tree.failure) errors.push(tree.failure);
    }
    if (errors.length)
      throw new BackendError("flush", "io", "Flush failed", true, {
        cause: errors[0],
      });
  }

  async deleteLocal(rawId) {
    this.#assertOpen("delete");
    const id = sedimentreeId(rawId);
    const tree = this.#trees.get(id);
    if (!tree) return;
    let release;
    this.#deleting.set(id, new Promise((r) => (release = r)));
    try {
      this.#trees.delete(id);
      tree.deleted = true;
      clearTimeout(tree.sync.timer);
      for (const session of [...tree.sessions])
        session.end({ type: "deleted", sequence: tree.log.sequence + 1 });
      for (const waiter of tree.sync.waiters.splice(0))
        waiter.reject(new BackendError("synchronize", "deleted", "Deleted"));
      await tree.queue.catch(() => {});
      await this.#store.remove(id);
      tree.log.clear();
      this.#collection.append((sequence) => ({ type: "deleted", id, sequence }), 64);
    } finally {
      this.#deleting.delete(id);
      release();
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const watch of [...this.#collectionWatches]) watch.end();
    const tails = [];
    for (const tree of this.#trees.values()) {
      clearTimeout(tree.sync.timer);
      for (const session of [...tree.sessions]) session.end();
      for (const waiter of tree.sync.waiters.splice(0))
        waiter.reject(new BackendError("synchronize", "closed", "Backend is closed"));
      tails.push(tree.queue.catch((e) => e));
    }
    const results = await Promise.all(tails);
    this.#conn?.transport.close();
    this.#conn = null;
    for (const tree of this.#trees.values()) tree.log.clear();
    this.#trees.clear();
    this.#collection.clear();
    const failure = results.find((r) => r instanceof Error);
    if (failure)
      throw new BackendError("close", "io", "Close drained a failed write", false, {
        cause: failure,
      });
  }

  // ---- Host connection ------------------------------------------------------

  /** Attach the authenticated host socket (wire.mjs transport). One at a time. */
  addConnection(transport, { hostId = "pages-host" } = {}) {
    this.#assertOpen("open");
    this.#conn?.transport.close();
    const conn = { transport, hostId };
    this.#conn = conn;
    for (const tree of this.#trees.values()) {
      this.#settle(tree);
      tree.sync.state = A.decodeSyncState(A.encodeSyncState(tree.sync.state));
      tree.refusedTerminal = false;
      tree.sync.recovery = dependencyRecoveryStep(tree.sync.recovery, "connect");
      tree.sync.inflight = null;
      clearTimeout(tree.sync.timer);
    }
    transport.onMessage((frame) => {
      if (this.#conn === conn) this.#onFrame(frame);
    });
    transport.onClose(() => {
      if (this.#conn !== conn) return;
      this.#conn = null;
      for (const tree of this.#trees.values()) {
        tree.sync.inflight = null;
        clearTimeout(tree.sync.timer);
        this.#finishRound(tree, "failed");
      }
    });
    for (const tree of this.#trees.values())
      if (!tree.opaque && (tree.sessions.size || tree.dirty)) this.#kick(tree, true);
  }

  get connected() {
    return this.#conn !== null;
  }

  /**
   * Run one sync round for `id` without a Repo session and return its result.
   * The host uses it as a durability barrier: a round completes only after the
   * peer answered every message, and the Page host answers after persisting.
   */
  async synchronizeTree(rawId, { create = false } = {}) {
    this.#assertOpen("synchronize");
    const id = sedimentreeId(rawId);
    if (!create && !this.#trees.has(id))
      return {
        outcome: "no-peers",
        peers: [],
        checkpoint: { sequence: 0, heads: [] },
      };
    // `create` pulls the host's copy into a tree this Repo hasn't opened yet.
    return this.#synchronize(this.#tree(id));
  }

  #peer() {
    return {
      kind: "pages-host",
      id: this.#conn?.hostId ?? "pages-host",
      path: [],
    };
  }

  #kick(tree, force) {
    if (tree.deleted || tree.opaque || this.#closed) return;
    this.#settle(tree);
    if (!this.#conn) return this.#finishRound(tree, "no-peers");
    if (tree.held) {
      tree.sync.recovery = dependencyRecoveryStep(tree.sync.recovery, "suspend");
      tree.sync.again ||= force;
      return;
    }
    tree.sync.recovery = dependencyRecoveryStep(tree.sync.recovery, "resume");
    if (tree.sync.inflight !== null) {
      tree.sync.again = true;
      return;
    }
    let m;
    let mirror = tree.mirror ?? A.init();
    if (tree.refusedTerminal) {
      // Acknowledge the host's history without advertising refused local heads.
      // Sync reads the underlying handle, so a view alone does not isolate it.
      const heads = tree.sync.state.theirHeads ?? tree.sync.state.sharedHeads;
      mirror = A.clone(
        A.view(mirror, A.hasHeads(mirror, heads) ? heads : tree.sync.state.sharedHeads),
      );
    }
    try {
      if (tree.sync.recovery === "retrying" && tree.sync.state.theirHave !== null) {
        // Ignore probabilistic membership only. The peer's actual lastSync and
        // empty/reset advertisements must retain their native meaning.
        tree.sync.state.theirHave = tree.sync.state.theirHave.map((have) => ({
          ...have,
          bloom: new Uint8Array(),
        }));
      }
      [tree.sync.state, m] = A.generateSyncMessage(mirror, tree.sync.state);
    } finally {
      if (tree.refusedTerminal) A.free(mirror);
    }
    if (!m && !force) return this.#finishRound(tree, "complete");
    const r = ++this.#frame;
    tree.sync.inflight = r;
    tree.sync.again = false;
    clearTimeout(tree.sync.timer);
    tree.sync.timer = setTimeout(() => {
      if (tree.sync.inflight !== r) return;
      tree.sync.inflight = null;
      // A transport timeout is not a native acknowledgment. Clear inFlight and
      // sent hashes so a new explicit round negotiates the pending history again.
      tree.sync.state = A.decodeSyncState(A.encodeSyncState(tree.sync.state));
      this.#finishRound(tree, "failed");
    }, this.#opts.syncTimeoutMs);
    tree.sync.timer.unref?.();
    this.#conn.transport.send({ t: "sync", doc: tree.id, m: m ?? null, r });
  }

  #onFrame(frame) {
    const tree = this.#trees.get(frame.doc);
    if (!tree || tree.deleted || tree.opaque) return;
    if (frame.t === "eph") {
      if (!frame.sender) return;
      tree.log.append(
        (sequence) => ({
          type: "ephemeral",
          sequence,
          message: frame.e,
          sender: { kind: frame.sender.kind, id: frame.sender.id, path: [] },
        }),
        frame.e.payload.byteLength + 64,
      );
      return;
    }
    if (frame.t === "refused") {
      const correlated = frame.r !== undefined && frame.r === tree.sync.inflight;
      const superseded = frame.r !== undefined && !correlated;
      if (correlated) {
        tree.sync.inflight = null;
        clearTimeout(tree.sync.timer);
      }
      // Retain native peer bookkeeping, never a durability acknowledgment.
      if (!superseded) tree.sync.state = A.decodeSyncState(A.encodeSyncState(tree.sync.state));
      if (!superseded) tree.refusedTerminal = TERMINAL_REFUSALS.has(frame.code);
      // Always retryable for Repo: a fatal refusal also closes the socket, and
      // the app decides from the close code whether to reconnect. A
      // non-retryable failure would leave the handle unavailable after one.
      const error = new BackendError(
        "synchronize",
        "conflict",
        `${frame.code}: ${frame.message}`,
        true,
      );
      error.refusal = {
        code: frame.code,
        message: frame.message,
        fatal: frame.fatal,
        doc: frame.doc,
        ...(frame.r !== undefined && { r: frame.r }),
        correlated,
      };
      tree.log.append((sequence) => ({ type: "failure", sequence, error }), 128);
      // Evidence only: a frame identifies a send, not an offending change.
      // An observer must never interrupt the round's settlement.
      try {
        this.#opts.onRefusal(Object.freeze({ ...error.refusal }));
      } catch {}
      // A timed-out frame's refusal must not settle a newer round's waiters.
      if (superseded) return;
      tree.sync.recovery = dependencyRecoveryStep(
        tree.sync.recovery,
        correlated && !frame.fatal && frame.code === "missing_dependencies" ? "missing" : "stop",
      );
      if (tree.sync.recovery === "retrying") {
        this.#kick(tree, true);
        return;
      }
      return this.#finishRound(tree, "failed");
    }
    const reply = frame.r !== undefined && frame.r === tree.sync.inflight;
    if (reply) {
      tree.sync.inflight = null;
      clearTimeout(tree.sync.timer);
      tree.sync.has = frame.has;
    }
    if (frame.has && frame.heads?.length) {
      tree.log.append(
        (sequence) => ({
          type: "remote-heads",
          sequence,
          remote: this.#peer(),
          heads: frame.heads,
        }),
        frame.heads.length * 32 + 64,
      );
    }
    if (frame.m && this.#receive(tree, frame.m)) return;
    // A reply continues the round, unless local edits are waiting for their
    // scheduled start: that start sends them with this round's follow-up, and
    // ends the round.
    if ((reply || frame.m) && !tree.held) this.#kick(tree, tree.sync.again);
  }

  /** True when the mirror update is deferred; the deferred step kicks. */
  #receive(tree, message) {
    this.#settle(tree);
    if (!hasData(tree)) {
      // Cold tree, and the host sent its whole document as one chunk: give
      // Repo that chunk as-is, store it as the snapshot, and load the mirror
      // after Repo has run. Anything that reads the mirror settles it first.
      const decoded = A.decodeSyncMessage(message);
      const [chunk] = decoded.changes;
      if (decoded.changes.length === 1 && chunk[8] === 0 && decoded.heads.length) {
        const heads = [...decoded.heads].sort();
        tree.deferred = message;
        tree.persisted = true;
        this.stats.documentRecords++;
        this.#announce(tree, [{ kind: "document", heads, blob: chunk }], heads);
        void this.#enqueue(tree, () => this.#store.compact(tree.id, chunk, heads)).catch(() => {});
        setTimeout(() => {
          if (this.#settle(tree)) this.#kick(tree, tree.sync.again);
        }, 0);
        return true;
      }
    }
    const mirror = tree.mirror ?? A.init();
    const before = A.getHeads(mirror);
    [tree.mirror, tree.sync.state] = A.receiveSyncMessage(mirror, tree.sync.state, message);
    const added = A.getChangesSince(tree.mirror, before);
    if (!added.length) return false;
    this.#announce(tree, changeRecords(tree.mirror, before, added, this.stats));
    void this.#enqueue(tree, () => this.#persist(tree, concat(added))).catch(() => {});
    return false;
  }

  /** Apply a deferred cold-sync message to the mirror. True if one ran. */
  #settle(tree) {
    const message = tree.deferred;
    if (!message) return false;
    tree.deferred = null;
    [tree.mirror, tree.sync.state] = A.receiveSyncMessage(
      tree.mirror ?? A.init(),
      tree.sync.state,
      message,
    );
    return !tree.deleted;
  }

  #finishRound(tree, outcome) {
    this.#settle(tree);
    if (outcome === "complete" && tree.refusedTerminal) outcome = "failed";
    if (outcome === "complete") {
      tree.sync.recovery = dependencyRecoveryStep(tree.sync.recovery, "complete");
      tree.dirty = false;
      this.#saveSyncState(tree);
    } else tree.sync.recovery = dependencyRecoveryStep(tree.sync.recovery, "stop");
    if (!tree.sync.waiters.length) return;
    const roundId = String(++this.#round);
    const heads = headsOf(tree);
    const peerOutcome =
      outcome === "failed" ? "failed" : tree.sync.has === false ? "unavailable" : "complete";
    const peers = outcome === "no-peers" ? [] : [{ peer: this.#peer(), outcome: peerOutcome }];
    let result;
    tree.log.append(
      (sequence) => {
        result = { roundId, checkpoint: { sequence, heads }, outcome, peers };
        return { type: "synchronized", result };
      },
      heads.length * 32 + 64,
    );
    for (const waiter of tree.sync.waiters.splice(0)) waiter.resolve(copySyncResult(result));
  }

  #saveSyncState(tree) {
    if (!tree.persisted || tree.opaque) return;
    const encoded = A.encodeSyncState(tree.sync.state);
    void this.#enqueue(tree, () => this.#store.saveSyncState(tree.id, encoded)).catch(() => {});
  }

  #synchronize(tree, options) {
    this.#assertOpen("synchronize");
    options?.signal?.throwIfAborted();
    tree.refusedTerminal = false;
    if (tree.sync.inflight === null)
      tree.sync.recovery = dependencyRecoveryStep(tree.sync.recovery, "start");
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      tree.sync.waiters.push(waiter);
      options?.signal?.addEventListener("abort", () => {
        const i = tree.sync.waiters.indexOf(waiter);
        if (i >= 0) tree.sync.waiters.splice(i, 1);
        reject(options.signal.reason);
      });
      if (tree.opaque || !this.#conn) this.#finishRound(tree, "no-peers");
      else if (tree.sync.inflight === null) this.#kick(tree, true);
      else tree.sync.again = true;
    });
  }

  async #publish(tree, message) {
    if (
      typeof message?.messageId !== "string" ||
      typeof message.origin?.id !== "string" ||
      typeof message.origin?.kind !== "string" ||
      !(message.payload instanceof Uint8Array)
    )
      throw new BackendError("ephemeral", "invalid-record", "Invalid ephemeral envelope");
    if (!this.#conn || tree.opaque) return;
    this.#conn.transport.send({
      t: "eph",
      doc: tree.id,
      e: {
        messageId: message.messageId,
        origin: { ...message.origin },
        payload: new Uint8Array(message.payload),
      },
    });
  }

  // ---- Internals --------------------------------------------------------------

  async #storeOpaque(tree, staged) {
    const fresh = [];
    for (const record of staged) {
      const same = tree.records.get(recordKey(record));
      if (same?.some((r) => equalRecords(r, record))) continue;
      if (same && record.kind === "commit")
        throw new BackendError(
          "store",
          "conflict",
          `Conflicting representation for ${recordKey(record)}`,
        );
      this.#keep(tree, record);
      fresh.push(record);
    }
    if (!fresh.length) return;
    this.#announce(tree, fresh);
    const chunk = new Uint8Array(cbor.encode({ records: fresh.map(toWire) }));
    await this.#enqueue(tree, async () => {
      await this.#store.append(tree.id, chunk, headsOf(tree), [], {
        format: "opaque",
      });
      tree.persisted = true;
    });
  }

  async #persist(tree, chunk) {
    await this.#store.append(tree.id, chunk, A.getHeads(tree.mirror));
    tree.persisted = true;
    if (this.#store.wantsCompaction(tree.id)) {
      this.#settle(tree);
      await this.#store.compact(tree.id, A.save(tree.mirror), A.getHeads(tree.mirror));
      this.stats.compactions++;
    }
  }

  /**
   * Serialize persistence per tree. A failed write is remembered: flush reports
   * it, and the next write first stores a full snapshot of the mirror, which
   * covers whatever the failed write held. The host never re-sends history it
   * already sent, so for received changes this is the only retry.
   */
  #enqueue(tree, work) {
    const run = tree.queue
      .catch(() => {})
      .then(async () => {
        if (tree.deleted) throw new BackendError("store", "deleted", "Deleted", true);
        if (tree.failure && !tree.opaque && tree.mirror) {
          this.#settle(tree);
          await this.#store.compact(tree.id, A.save(tree.mirror), A.getHeads(tree.mirror));
          tree.failure = null;
        }
        try {
          return await work();
        } catch (error) {
          tree.failure = error;
          throw error;
        }
      });
    tree.queue = run;
    return run;
  }

  #announce(tree, records, heads = null) {
    for (const batch of this.#batches(records)) {
      tree.log.append(
        (sequence) => ({
          type: "records",
          phase: "live",
          records: batch,
          sequence,
        }),
        batch.reduce((s, r) => s + recordBytes(r), 0),
      );
    }
    heads ??= headsOf(tree);
    tree.log.append(
      (sequence) => ({ type: "checkpoint", checkpoint: { sequence, heads } }),
      heads.length * 32 + 32,
    );
    this.#collection.append(
      (sequence) => ({
        type: "document",
        phase: "live",
        id: tree.id,
        sequence,
      }),
      64,
    );
  }

  #keep(tree, record) {
    const key = recordKey(record);
    tree.records.set(key, [...(tree.records.get(key) ?? []), record]);
  }

  #assertOpen(operation) {
    if (this.#closed) throw new BackendError(operation, "closed", "Backend is closed");
  }

  #log() {
    return new ReplayLog(this.#opts.replayEvents, this.#opts.replayBytes);
  }

  #tree(id) {
    let tree = this.#trees.get(id);
    if (!tree) {
      tree = {
        id,
        records: new Map(),
        persisted: false,
        opaque: false,
        mirror: null,
        deferred: null,
        failure: null,
        refusedTerminal: false,
        dirty: false,
        deleted: false,
        log: this.#log(),
        sessions: new Set(),
        queue: Promise.resolve(),
        sync: {
          state: A.initSyncState(),
          recovery: "ready",
          inflight: null,
          again: false,
          waiters: [],
          has: undefined,
          timer: null,
        },
      };
      this.#trees.set(id, tree);
    }
    return tree;
  }

  *#batches(records) {
    let batch = [];
    let bytes = 0;
    for (const record of records) {
      const size = recordBytes(record);
      if (
        batch.length &&
        (batch.length >= this.#opts.batchRecords || bytes + size > this.#opts.batchBytes)
      ) {
        yield batch;
        batch = [];
        bytes = 0;
      }
      batch.push(record);
      bytes += size;
    }
    if (batch.length) yield batch;
  }
}

class Session {
  #closed = false;
  constructor(events, synchronize, publish) {
    this.events = events;
    this.synchronizeRound = synchronize;
    this.publish = publish;
  }
  invalidate() {
    this.#closed = true;
  }
  end(event) {
    this.events.end(event);
  }
  async synchronize(options) {
    if (this.#closed) throw new BackendError("synchronize", "closed", "Session is closed");
    return this.synchronizeRound(options);
  }
  async publishEphemeral(message) {
    if (this.#closed) throw new BackendError("ephemeral", "closed", "Session is closed");
    return this.publish(message);
  }
  async close() {
    this.end();
  }
}

// ---- Helpers ------------------------------------------------------------------

function hasData(tree) {
  return tree.opaque
    ? tree.records.size > 0
    : !!tree.deferred || (!!tree.mirror && A.getHeads(tree.mirror).length > 0);
}

/** Materialized heads for Automerge trees; the record frontier for opaque ones. */
function headsOf(tree) {
  if (!tree.opaque) {
    if (tree.deferred) return [...A.decodeSyncMessage(tree.deferred).heads].sort();
    return tree.mirror ? [...A.getHeads(tree.mirror)].sort() : [];
  }
  const records = [...tree.records.values()].flat();
  const candidates = new Set(records.map(recordHead));
  for (const r of records) if (r.kind === "commit") for (const p of r.parents) candidates.delete(p);
  return [...candidates].sort();
}

function documentRecord(doc) {
  return {
    kind: "document",
    heads: [...A.getHeads(doc)].sort(),
    blob: A.save(doc),
  };
}

/** Records for `added` (changes since `before`): loose commits, or one bundle. */
function changeRecords(doc, before, added, stats) {
  if (added.length > LOOSE_LIMIT) {
    const meta = A.getChangesMetaSince(doc, before);
    const members = new Set(meta.map((c) => c.hash));
    const depended = new Set(meta.flatMap((c) => c.deps));
    const tips = meta.filter((c) => !depended.has(c.hash));
    if (tips.length === 1) {
      stats.bundles++;
      const boundary = [
        ...new Set(meta.flatMap((c) => c.deps).filter((d) => !members.has(d))),
      ].sort();
      return [
        {
          kind: "fragment",
          head: tips[0].hash,
          boundary,
          checkpoints: [],
          blob: A.saveBundle(doc, [...members]),
        },
      ];
    }
    return extractRecords(doc, (m) => m.kind === "commit" && members.has(m.id));
  }
  stats.looseRecords += added.length;
  return added.map((blob) => {
    const c = A.decodeChange(blob);
    return { kind: "commit", id: c.hash, parents: [...c.deps].sort(), blob };
  });
}

function decodeSyncState(bytes) {
  if (!bytes) return A.initSyncState();
  try {
    return A.decodeSyncState(bytes);
  } catch {
    return A.initSyncState();
  }
}

function toWire(r) {
  return r.kind === "commit"
    ? { k: "c", i: r.id, p: [...r.parents], d: r.blob }
    : {
        k: "f",
        i: r.head,
        b: [...r.boundary],
        c: [...r.checkpoints],
        d: r.blob,
      };
}

function fromWire(r) {
  return r.k === "c"
    ? { kind: "commit", id: r.i, parents: r.p, blob: new Uint8Array(r.d) }
    : {
        kind: "fragment",
        head: r.i,
        boundary: r.b,
        checkpoints: r.c,
        blob: new Uint8Array(r.d),
      };
}

function copySyncResult(result) {
  return {
    ...result,
    checkpoint: { ...result.checkpoint, heads: [...result.checkpoint.heads] },
    peers: result.peers.map((p) => ({
      ...p,
      peer: { ...p.peer, path: [...p.peer.path] },
    })),
  };
}

function copyEvent(event) {
  switch (event.type) {
    case "records":
      return { ...event, records: event.records.map(copyRecord) };
    case "local-load-complete":
    case "checkpoint":
      return {
        ...event,
        checkpoint: { ...event.checkpoint, heads: [...event.checkpoint.heads] },
      };
    case "synchronized":
      return { ...event, result: copySyncResult(event.result) };
    case "remote-heads":
      return { ...event, remote: { ...event.remote }, heads: [...event.heads] };
    case "ephemeral":
      return {
        ...event,
        message: {
          ...event.message,
          origin: { ...event.message.origin },
          payload: new Uint8Array(event.message.payload),
        },
        sender: { ...event.sender },
      };
    default:
      return { ...event };
  }
}
