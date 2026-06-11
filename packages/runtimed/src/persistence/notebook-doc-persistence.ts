/**
 * NotebookDocPersistence — trailing-edge throttled document snapshots.
 *
 * Subscribes a narrow change signal (`SyncEngine.notebookDocChanged$`) and
 * persists one self-contained envelope record under
 * `[notebookId, keySegment]`: a 4-byte little-endian meta-JSON length, the
 * meta JSON (utf8), then the full `handle.save()` doc bytes. A single
 * record means a single IDB transaction — meta and bytes can never tear
 * apart, so the principal guard always describes the bytes it sits next
 * to.
 *
 * Save semantics mirror automerge-repo's `asyncThrottle`: trailing edge,
 * never two concurrent writes, latest state wins. `flushNow()` (pagehide,
 * teardown) captures unconditionally — local edits inside the engine's
 * flush debounce have not emitted yet, but `handle.save()` already sees
 * them, and saves are idempotent.
 *
 * Change signals over-fire by design (`notebookDocChanged$` also emits for
 * protocol-only flushes), so every capture first compares the doc heads
 * against the last heads handed to the adapter — automerge-repo's
 * `#shouldSave` shape. Unchanged heads skip both the full-doc serialization
 * and the write; a failed write forgets its recorded heads so the next
 * signal retries instead of deduping against a record that never landed.
 *
 * Three record families exist per notebook:
 * - `[notebookId, "snapshot"]` — the PR-1 envelope record: NotebookDoc
 *   bytes behind a meta header. Still written by envelope-mode
 *   controllers (the runtime-state cache) and kept as the load fallback
 *   for chunk-less storage; the chunked seed store supersedes it.
 * - `[notebookId, "chunks", ...]` — the chunked NotebookDoc seed store
 *   (automerge-repo's storage model; see "Chunked NotebookDoc store"
 *   below). The only store ever loaded back into a SYNCING handle, via
 *   `loadPersistedNotebookDocChunks`.
 * - `[notebookId, "runtime-state-cache"]` — RuntimeStateDoc bytes as a
 *   render-only paint source for instant first paint. NEVER loaded into
 *   the syncing handle, never flushed, never synced: the syncing handle
 *   still bootstraps RuntimeStateDoc empty and the daemon/room remains the
 *   only writer. The authority invariant forbids restoring runtime state
 *   into the sync path, not caching pixels. Stays an envelope record —
 *   it is a rewrite-whole paint cache, not a history store. CommsDoc and
 *   Automerge sync states are never written to storage.
 *
 * ## Chunked NotebookDoc store (`chunked` option)
 *
 * automerge-repo's proven chunk/compaction model, multi-tab safe by
 * construction rather than by coordination:
 *
 * The store is namespaced by principal — `[notebookId, "chunks",
 * <principal>, ...]` — so a chunk union is single-principal by
 * construction: one last-writer-wins meta record can never vouch for
 * another principal's bytes, and a foreign principal's records are
 * simply a different sub-range (never loaded, never deleted by
 * compaction; the whole-notebook record discard still removes them).
 *
 * - `[notebookId, "chunks", <principal>, "snapshot", <headsKey>]` — a
 *   full `handle.save()` at those heads. Same heads ⇒ same key in every
 *   tab, so concurrent compactions collide idempotently.
 * - `[notebookId, "chunks", <principal>, "incremental",
 *   <sha256hex(bytes)>]` — `save_since_heads(lastCommittedHeads)`
 *   output, content-addressed: two tabs writing identical bytes write
 *   the same record (a no-op collision, never a clobber).
 * - `[notebookId, "chunks", <principal>, "meta"]` — plain meta JSON (the
 *   principal guard, plus the store `generation` epoch). `headsHex` here
 *   is the newest WRITER's heads, an informational dedupe hint — the
 *   chunk union is the truth and may be ahead of it when several tabs
 *   write.
 *
 * Every save is ONE `saveBatch` (atomic on IndexedDB; chunk-then-meta
 * crash-ordering under the sequential fallback). Compaction follows
 * automerge-repo's rule — `snapshotSize < 1024 || incrementalSize >=
 * snapshotSize`, bounding storage at ~2× doc size — and is write-before-
 * delete: the new snapshot commits before old chunks are removed, and
 * only chunks THIS controller knows about (its load inventory + its own
 * writes) are ever deleted. A chunk another tab wrote concurrently is
 * unknown here and therefore survives until a controller that has loaded
 * it compacts. Incremental saves always cut from the last COMMITTED
 * heads, so a failed write can produce overlapping chunks (deduplicated
 * on load) but never a dependency gap. Two guards keep that invariant
 * honest:
 *
 * - **Basis coverage.** The incremental basis must be durable IN THE
 *   CHUNK STORE, not merely durable somewhere: a seed's heads only
 *   become the basis when the chunk inventory is non-empty (an
 *   envelope-migrated seed keeps the heads for dedupe but starts with no
 *   basis), and the incremental arm stays closed until a snapshot chunk
 *   is actually committed/inventoried. Until then every capture takes
 *   the self-contained snapshot arm — even ones racing an in-flight
 *   first snapshot whose write may still fail.
 * - **Generation epoch.** The meta record carries a store `generation`.
 *   Every commit re-reads the live meta: an incremental whose
 *   controller's generation no longer matches (the store was cleared —
 *   poison-pill discard, principal-guard clear — and possibly
 *   re-established by another session) is DROPPED, the controller
 *   resets to a fresh-store posture, and the re-triggered capture takes
 *   the snapshot arm. Snapshots are self-contained, so they commit
 *   regardless, adopting the live generation (or minting one) and
 *   abandoning a stale inventory rather than deleting blind.
 *
 * With no committed basis the save falls back to a full snapshot —
 * `save_since_heads([])` would serialize the entire history as an
 * incremental (automerge-repo's documented pitfall).
 *
 * Failures never propagate into the live session: every error routes to
 * the `onError` callback and the logger, and after
 * `MAX_CONSECUTIVE_SAVE_FAILURES` the controller self-disposes so a dead
 * or quota-exhausted backend cannot generate doomed writes forever.
 */

import type { Observable, Subscription } from "rxjs";

import {
  saveBatch,
  type StorageAdapter,
  type StorageChunk,
  type StorageKey,
} from "./storage-adapter";

const DEFAULT_SAVE_THROTTLE_MS = 1_000;

/** Key segment of the NotebookDoc snapshot record (the seed record). */
export const NOTEBOOK_DOC_SNAPSHOT_KEY_SEGMENT = "snapshot";

/**
 * Key segment of the render-only RuntimeStateDoc cache record — a paint
 * source for instant first paint, never a sync seed.
 */
export const RUNTIME_STATE_CACHE_KEY_SEGMENT = "runtime-state-cache";

/** Key segment of the chunked NotebookDoc seed store. */
export const NOTEBOOK_DOC_CHUNKS_KEY_SEGMENT = "chunks";

/** Chunk-kind key segments under the chunks prefix. */
const CHUNK_KIND_SNAPSHOT = "snapshot";
const CHUNK_KIND_INCREMENTAL = "incremental";
const CHUNK_META_KEY_SEGMENT = "meta";

/**
 * automerge-repo's compaction floor: while the snapshot is tiny, always
 * compact (covers "one huge change on an empty doc").
 */
const CHUNK_COMPACTION_MIN_SNAPSHOT_BYTES = 1024;

/** Consecutive save failures tolerated before persistence self-disables. */
const MAX_CONSECUTIVE_SAVE_FAILURES = 3;

/** Byte width of the envelope's little-endian meta-JSON length prefix. */
const ENVELOPE_META_LENGTH_BYTES = 4;

export interface NotebookDocPersistenceMeta {
  /** Notebook heads at save time (informational; the bytes are the truth). */
  headsHex: string[];
  /** Epoch milliseconds of the save. */
  savedAt: number;
  /** Authoring principal; checked against the session principal before seeding. */
  principal: string;
  schemaVersion: 1;
  /**
   * Chunk-store epoch (chunk meta only; absent on envelope records).
   * Every writer sharing a store carries the same generation; clearing
   * and re-establishing the store mints a new one, so a stale writer
   * detects the reset at commit time instead of orphaning incrementals
   * against deleted chunks.
   */
  generation?: number;
}

export interface PersistedNotebookDoc {
  /** Doc snapshot bytes; absent when the record is torn or truncated. */
  bytes?: Uint8Array;
  /** null when the meta portion is missing or unparseable. */
  meta: NotebookDocPersistenceMeta | null;
}

/** One chunk of the chunked NotebookDoc store, as tracked for compaction. */
export interface NotebookDocChunkInfo {
  key: StorageKey;
  size: number;
  kind: "snapshot" | "incremental";
}

export interface PersistedNotebookDocChunks {
  /**
   * Concatenated chunk bytes, snapshots first then incrementals — the
   * order `NotebookHandle.load()` accepts (a document chunk first allows
   * partial dependencies; automerge deduplicates overlap).
   */
  bytes: Uint8Array;
  /**
   * Decoded `[notebookId, "chunks", <principal>, "meta"]` record; null
   * when missing or unparseable — callers must treat that as
   * unverifiable provenance.
   */
  meta: NotebookDocPersistenceMeta | null;
  /**
   * Inventory of the data chunks backing `bytes`. Hand this to the save
   * controller as `chunked.initialChunks` ONLY when the doc was actually
   * seeded from these bytes — compaction deletes known chunks, and a
   * chunk the doc does not contain must never become deletable.
   */
  chunks: NotebookDocChunkInfo[];
}

export interface NotebookDocChunkedOptions {
  /**
   * `NotebookHandle.save_since_heads` binding: every change that is not a
   * transitive dependency of the given heads. Never called with an empty
   * basis — the controller takes a full snapshot instead.
   */
  getSaveBytesSince: (headsHex: string[]) => Uint8Array;

  /**
   * Chunks already in storage that the seeded doc PROVABLY contains (the
   * `chunks` inventory returned by `loadPersistedNotebookDocChunks` when
   * the session seeded from it). These become compaction-deletable; chunks
   * discovered any other way must not be passed here. Also the gate that
   * lets `initialSavedHeadsHex` become the incremental basis — only a
   * chunk-seeded session may cut incrementals from its seed heads.
   */
  initialChunks?: NotebookDocChunkInfo[];

  /**
   * `generation` of the seed store's meta record, when seeded from the
   * chunk store. Without it (or after any detected store reset) the
   * controller's first commit re-establishes via the snapshot arm.
   */
  initialGeneration?: number;

  /**
   * Content-hash override for tests; defaults to WebCrypto SHA-256.
   * Must be collision-resistant — chunk keys are content addresses and a
   * collision would silently alias two different byte streams.
   */
  digest?: (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;
}

export interface NotebookDocPersistenceLogger {
  warn(msg: string, ...args: unknown[]): void;
}

export interface NotebookDocPersistenceOptions {
  adapter: StorageAdapter;
  notebookId: string;

  /** Authoring principal recorded in meta. */
  principal: string;

  /** Change signal, typically `SyncEngine.notebookDocChanged$`. */
  changes$: Observable<void>;

  /** Full doc snapshot bytes (raw `NotebookHandle.save()` or `save_state_doc()`). */
  getSaveBytes: () => Uint8Array;

  /** Current doc heads (`get_heads_hex()` / `get_runtime_state_heads_hex()`). */
  getHeadsHex: () => string[];

  /**
   * Record key segment under the notebook id; defaults to the NotebookDoc
   * snapshot record (`"snapshot"`). Ignored in chunked mode, which owns
   * the `[notebookId, "chunks", ...]` layout.
   */
  keySegment?: string;

  /**
   * Switch this controller from the single envelope record to the chunked
   * NotebookDoc store (see the module docs). Only the NotebookDoc seed
   * store goes chunked; the runtime-state paint cache stays an envelope.
   */
  chunked?: NotebookDocChunkedOptions;

  /** Trailing-edge save throttle in milliseconds (default 1000). */
  throttleMs?: number;

  /**
   * Heads of the record already sitting in storage, when the session
   * seeded from it (`meta.headsHex`). Lets the first capture dedupe
   * against the existing record instead of unconditionally re-writing
   * identical bytes on the handshake's protocol-only change signal —
   * automerge-repo records loaded heads the same way (`loadDoc` updates
   * its stored-heads handle). Only pass heads that describe the record
   * currently in storage.
   */
  initialSavedHeadsHex?: string[];

  /** Persistence failures route here; they never throw into the session. */
  onError?: (error: unknown) => void;

  logger?: NotebookDocPersistenceLogger;
}

export class NotebookDocPersistence {
  private readonly opts: NotebookDocPersistenceOptions;
  private readonly keySegment: string;
  private readonly throttleMs: number;
  private readonly logger: NotebookDocPersistenceLogger;
  private readonly subscription: Subscription;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private disposed = false;
  private consecutiveSaveFailures = 0;
  /** Serializes adapter writes so two saves never interleave (latest wins). */
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * Heads of the newest capture handed to the write chain (null = none).
   * Recorded optimistically at capture so a protocol-only signal during an
   * in-flight write cannot queue a duplicate; a failed write forgets its
   * own heads (only if no newer capture has superseded them) so the next
   * signal retries.
   */
  private lastSavedHeadsKey: string | null = null;
  /**
   * Heads of the newest write that COMMITTED (or of the seeded record, which
   * is committed by definition). `flushNow` dedupes against this key, never
   * the optimistic one: a teardown flush that skipped because an in-flight
   * write "covered" its state would lose that state forever if the write
   * then failed — errors are swallowed and the handle is freed right after.
   */
  private lastCommittedHeadsKey: string | null = null;
  /**
   * Chunked mode: the heads array behind `lastCommittedHeadsKey` — the
   * basis for the next incremental cut. Committed-only on purpose: a
   * capture racing an in-flight write cuts from the last DURABLE heads,
   * producing overlap (deduplicated on load) rather than a gap if the
   * in-flight write then fails.
   */
  private lastCommittedHeadsHex: string[] | null = null;
  /**
   * Chunked mode: chunks this controller may delete at compaction — the
   * seed inventory plus its own committed writes. Never grows from
   * observation of other tabs' records.
   */
  private chunkInfos: NotebookDocChunkInfo[] = [];
  /**
   * Single-flight compaction guard (automerge-repo's `#compacting`): while
   * a snapshot write is captured-but-unsettled, further captures take the
   * incremental path instead of queueing redundant full saves. Never
   * consulted while the incremental arm is closed — correctness (a
   * self-contained snapshot) outranks redundancy avoidance there.
   */
  private compactionInFlight = false;
  /**
   * Chunked mode: the store epoch this controller joined (seed meta) or
   * established (its own snapshot commit). Compared against the LIVE
   * meta record on every commit to detect external store resets.
   */
  private storeGeneration: number | null = null;

  constructor(opts: NotebookDocPersistenceOptions) {
    this.opts = opts;
    this.keySegment = opts.keySegment ?? NOTEBOOK_DOC_SNAPSHOT_KEY_SEGMENT;
    this.throttleMs = opts.throttleMs ?? DEFAULT_SAVE_THROTTLE_MS;
    this.logger = opts.logger ?? console;
    this.chunkInfos = [...(opts.chunked?.initialChunks ?? [])];
    this.storeGeneration = opts.chunked?.initialGeneration ?? null;
    // An empty heads array is treated as unknown, not as an identity: a
    // freshly-bootstrapped doc (RuntimeStateDoc starts empty by design)
    // would otherwise match a stale prior-session record's empty heads and
    // skip its first save.
    const initialHeads = opts.initialSavedHeadsHex;
    if (initialHeads && initialHeads.length > 0) {
      const initialKey = headsCacheKey(initialHeads);
      this.lastSavedHeadsKey = initialKey;
      this.lastCommittedHeadsKey = initialKey;
      // The incremental basis demands more than dedupe does: these heads
      // must be durable IN THE CHUNK STORE, or an incremental cut from
      // them orphans (its dependencies live only in the envelope
      // record). Only a chunk-seeded session — non-empty inventory —
      // qualifies; an envelope-migrated seed keeps the dedupe keys but
      // starts with no basis, so its first save takes the self-contained
      // snapshot arm.
      if (this.chunkInfos.length > 0) {
        this.lastCommittedHeadsHex = [...initialHeads];
      }
    }
    this.subscription = opts.changes$.subscribe(() => this.onChanged());
  }

  /**
   * Cancel pending work and detach from the change signal.
   *
   * No snapshot capture runs after dispose — callers can free the WASM
   * handle immediately afterwards. Writes already captured (e.g. by a
   * `flushNow()` issued just before dispose) still commit.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.unsubscribe();
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * Commit the current document state immediately (pagehide, teardown).
   *
   * Captures ignoring the change-signal dirty flag: local edits inside
   * the engine's flush debounce have not emitted yet, but `getSaveBytes()`
   * already sees them. The heads-dedupe applies only against COMMITTED
   * writes — an in-flight write may still fail after this call returns
   * (errors are swallowed, the handle freed), so "covered by a pending
   * write" must not skip the teardown's last chance to persist. A flush
   * racing an identical in-flight write costs one redundant idempotent
   * write. Bytes are captured synchronously, so a handle freed right after
   * this call returns is never touched by the queued write; the returned
   * promise resolves once the write chain has committed.
   */
  async flushNow(): Promise<void> {
    if (this.disposed) return;
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.captureAndEnqueue("committed");
  }

  private onChanged(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (this.saveTimer !== null) return; // throttle window already open
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, this.throttleMs);
  }

  private saveNow(): Promise<void> {
    if (this.disposed || !this.dirty) return this.writeChain;
    return this.captureAndEnqueue();
  }

  /**
   * `dedupeAgainst` selects which heads key may skip the capture:
   * change-signal saves use `"newest"` (the optimistic key — prevents
   * queueing duplicates behind an identical in-flight write, and a late
   * failure self-heals through the next signal), while `flushNow` uses
   * `"committed"` (an in-flight write is not proof of durability, and a
   * teardown flush gets no next signal).
   */
  private captureAndEnqueue(dedupeAgainst: "newest" | "committed" = "newest"): Promise<void> {
    this.dirty = false;

    let meta: NotebookDocPersistenceMeta;
    let headsKey: string;
    try {
      const headsHex = this.opts.getHeadsHex();
      headsKey = headsCacheKey(headsHex);
      const skipKey =
        dedupeAgainst === "newest" ? this.lastSavedHeadsKey : this.lastCommittedHeadsKey;
      if (headsKey === skipKey) {
        // Heads unchanged since the newest capture (or, for flushes, the
        // newest COMMITTED write): the signal over-fired (protocol-only
        // flush) — skip the no-op snapshot. Edits inside the engine's
        // flush debounce are already committed to the doc, so they move
        // the heads and never land here.
        return this.writeChain;
      }
      meta = {
        headsHex,
        savedAt: Date.now(),
        principal: this.opts.principal,
        schemaVersion: 1,
      };
    } catch (error) {
      this.reportSaveFailure("snapshot capture failed", error);
      return this.writeChain;
    }

    return this.opts.chunked
      ? this.enqueueChunkedSave(this.opts.chunked, meta, headsKey)
      : this.enqueueEnvelopeSave(meta, headsKey);
  }

  private enqueueEnvelopeSave(meta: NotebookDocPersistenceMeta, headsKey: string): Promise<void> {
    // Capture synchronously: getSaveBytes touches the WASM handle, which a
    // disposing session may free as soon as this call returns.
    let envelope: Uint8Array;
    try {
      envelope = encodePersistedNotebookDoc(meta, this.opts.getSaveBytes());
    } catch (error) {
      this.reportSaveFailure("snapshot capture failed", error);
      return this.writeChain;
    }

    // Record optimistically so signals during the in-flight write dedupe
    // against this capture rather than queueing an identical envelope.
    this.lastSavedHeadsKey = headsKey;

    const { adapter, notebookId } = this.opts;
    const key = [notebookId, this.keySegment];
    const write = this.writeChain.then(async () => {
      try {
        await saveBatch(adapter, [[key, envelope]]);
        this.consecutiveSaveFailures = 0;
        this.lastCommittedHeadsKey = headsKey;
      } catch (error) {
        // Forget this capture's heads so the next signal retries — unless
        // a newer capture already superseded them.
        if (this.lastSavedHeadsKey === headsKey) {
          this.lastSavedHeadsKey = null;
        }
        this.reportSaveFailure("save failed", error);
      }
    });
    this.writeChain = write;
    return write;
  }

  private enqueueChunkedSave(
    chunked: NotebookDocChunkedOptions,
    meta: NotebookDocPersistenceMeta,
    headsKey: string,
  ): Promise<void> {
    // Capture synchronously — only hashing and the writes are async, and
    // they touch plain byte arrays, never the (possibly freed) handle.
    let capture: { kind: "snapshot" | "incremental"; bytes: Uint8Array };
    try {
      const basis = this.lastCommittedHeadsHex;
      // The incremental arm opens only once BOTH hold: a committed basis
      // exists AND a snapshot chunk is inventoried. Until the first
      // snapshot commit, every capture — including one racing the
      // in-flight first snapshot whose write may yet fail — must be
      // self-contained, or a surviving incremental could be the store's
      // only record, with its dependencies nowhere in it.
      const snapshotInventoried = this.chunkInfos.some((chunk) => chunk.kind === "snapshot");
      if (!basis || !snapshotInventoried || this.shouldCompactChunks()) {
        // Full snapshot: the compaction rule fired, the incremental arm
        // is closed, or there is no committed basis to cut from —
        // `save_since_heads([])` would serialize the entire history as
        // an incremental.
        capture = { kind: "snapshot", bytes: this.opts.getSaveBytes() };
      } else {
        const bytes = chunked.getSaveBytesSince(basis);
        if (bytes.byteLength === 0) {
          // Nothing beyond the committed basis: the signal over-fired.
          // The optimistic key is left alone so a later real change at
          // these heads (unreachable today, cheap insurance) retries.
          return this.writeChain;
        }
        capture = { kind: "incremental", bytes };
      }
    } catch (error) {
      this.reportSaveFailure("chunk capture failed", error);
      return this.writeChain;
    }

    if (capture.kind === "snapshot") {
      this.compactionInFlight = true;
    }
    this.lastSavedHeadsKey = headsKey;

    const write = this.writeChain.then(async () => {
      try {
        let committed = true;
        if (capture.kind === "snapshot") {
          await this.commitSnapshotChunk(capture.bytes, meta);
        } else {
          committed = await this.commitIncrementalChunk(chunked, capture.bytes, meta);
        }
        if (committed) {
          this.consecutiveSaveFailures = 0;
          this.lastCommittedHeadsKey = headsKey;
          this.lastCommittedHeadsHex = meta.headsHex;
        } else {
          // Dropped on an external store reset — not a backend failure.
          // Forget the optimistic key and reopen a capture window so the
          // snapshot re-establish runs without waiting for an external
          // signal. (A teardown flush whose tail lands here is the
          // cleared store's intended semantics: the discard already
          // decided those bytes' fate; the room is the backstop.)
          if (this.lastSavedHeadsKey === headsKey) {
            this.lastSavedHeadsKey = null;
          }
          this.onChanged();
        }
      } catch (error) {
        if (this.lastSavedHeadsKey === headsKey) {
          this.lastSavedHeadsKey = null;
        }
        this.reportSaveFailure("chunk save failed", error);
      } finally {
        if (capture.kind === "snapshot") {
          this.compactionInFlight = false;
        }
      }
    });
    this.writeChain = write;
    return write;
  }

  /** Read the LIVE meta record for this principal's store sub-range. */
  private async readStoredChunkMeta(): Promise<NotebookDocPersistenceMeta | null> {
    const bytes = await this.opts.adapter.load(
      notebookDocChunkMetaKey(this.opts.notebookId, this.opts.principal),
    );
    return bytes ? decodeMeta(bytes) : null;
  }

  /** Forget everything tied to the previous store epoch. */
  private resetChunkStoreState(): void {
    this.chunkInfos = [];
    this.lastCommittedHeadsHex = null;
    this.storeGeneration = null;
  }

  /**
   * automerge-repo's compaction rule: compact while the doc is tiny, or
   * once accumulated incrementals reach snapshot size — bounding storage
   * at roughly twice the document size.
   */
  private shouldCompactChunks(): boolean {
    if (this.compactionInFlight) return false;
    let snapshotSize = 0;
    let incrementalSize = 0;
    for (const chunk of this.chunkInfos) {
      if (chunk.kind === "snapshot") {
        snapshotSize += chunk.size;
      } else {
        incrementalSize += chunk.size;
      }
    }
    return snapshotSize < CHUNK_COMPACTION_MIN_SNAPSHOT_BYTES || incrementalSize >= snapshotSize;
  }

  /**
   * Compaction commit: write the new snapshot (plus meta) in one batch,
   * THEN delete the old chunks — write-before-delete, so a crash between
   * the two leaves redundant-but-loadable data, never a hole. Deletions
   * touch only chunks this controller knows about; a chunk another tab
   * wrote concurrently is not in the inventory and survives. Delete
   * failures are non-fatal (the data is durable, merely redundant) and
   * the chunk stays inventoried so the next compaction retries.
   */
  private async commitSnapshotChunk(
    bytes: Uint8Array,
    meta: NotebookDocPersistenceMeta,
  ): Promise<void> {
    const { adapter, notebookId, principal } = this.opts;
    // Establish or verify the store generation against the LIVE meta
    // record. A missing or foreign-generation meta means another session
    // cleared (and possibly re-established) the store since this
    // controller last looked: its inventory names records that no longer
    // exist, so deleting by it would be deleting blind — abandon it. The
    // snapshot itself is self-contained and commits either way, joining
    // the live epoch (or minting one for an empty store).
    const stored = await this.readStoredChunkMeta();
    const storedGeneration = stored?.generation ?? null;
    if (this.storeGeneration === null || storedGeneration !== this.storeGeneration) {
      if (this.storeGeneration !== null) {
        this.logger.warn(
          "[notebook-persistence] chunk store was reset externally; rejoining with a fresh snapshot",
        );
        this.chunkInfos = [];
      }
      this.storeGeneration = storedGeneration ?? mintChunkStoreGeneration();
    }

    const key = notebookDocSnapshotChunkKey(notebookId, principal, meta.headsHex);
    await saveBatch(adapter, [
      [key, bytes],
      [
        notebookDocChunkMetaKey(notebookId, principal),
        encodeNotebookDocChunkMeta({ ...meta, generation: this.storeGeneration }),
      ],
    ]);

    const keyId = chunkKeyId(key);
    const retained: NotebookDocChunkInfo[] = [];
    for (const old of this.chunkInfos) {
      // A same-heads snapshot (another tab compacted at identical heads,
      // or a retried compaction) collides on its own key — never delete
      // the chunk just written.
      if (chunkKeyId(old.key) === keyId) continue;
      try {
        await adapter.remove(old.key);
      } catch (error) {
        this.logger.warn(
          "[notebook-persistence] stale chunk delete failed (kept for retry):",
          error,
        );
        retained.push(old);
      }
    }
    this.chunkInfos = [...retained, { key, size: bytes.byteLength, kind: "snapshot" }];
  }

  /**
   * Returns false (nothing written) when the live meta record shows the
   * store was reset since this controller's epoch: the basis chunks this
   * incremental was cut above are gone, and writing it would create a
   * dependency-orphaned record (a one-write TOCTOU window remains
   * between the meta read and the batch — the bound the design accepts).
   */
  private async commitIncrementalChunk(
    chunked: NotebookDocChunkedOptions,
    bytes: Uint8Array,
    meta: NotebookDocPersistenceMeta,
  ): Promise<boolean> {
    const { adapter, notebookId, principal } = this.opts;
    const stored = await this.readStoredChunkMeta();
    if (
      this.storeGeneration === null ||
      stored === null ||
      (stored.generation ?? null) !== this.storeGeneration
    ) {
      this.logger.warn(
        "[notebook-persistence] chunk store was reset externally; dropping the incremental and re-snapshotting",
      );
      this.resetChunkStoreState();
      return false;
    }

    const digest = await (chunked.digest ?? sha256)(bytes);
    const key = notebookDocIncrementalChunkKey(notebookId, principal, bytesToHex(digest));
    await saveBatch(adapter, [
      [key, bytes],
      [
        notebookDocChunkMetaKey(notebookId, principal),
        encodeNotebookDocChunkMeta({ ...meta, generation: this.storeGeneration }),
      ],
    ]);
    const keyId = chunkKeyId(key);
    if (!this.chunkInfos.some((chunk) => chunkKeyId(chunk.key) === keyId)) {
      this.chunkInfos.push({ key, size: bytes.byteLength, kind: "incremental" });
    }
    return true;
  }

  private reportSaveFailure(label: string, error: unknown): void {
    this.logger.warn(`[notebook-persistence] ${label}:`, error);
    try {
      this.opts.onError?.(error);
    } catch {
      // onError must never throw back into the save pipeline
    }
    this.consecutiveSaveFailures += 1;
    if (!this.disposed && this.consecutiveSaveFailures >= MAX_CONSECUTIVE_SAVE_FAILURES) {
      // A dead backend (quota exhausted, broken IDB) must not trigger a
      // doomed full-doc serialization on every change for the rest of the
      // session. A fresh session recreates persistence and retries.
      this.logger.warn("[notebook-persistence] disabled after repeated save failures");
      this.dispose();
    }
  }
}

/**
 * Comparison key for a heads array. Heads from `get_heads_hex()` are
 * already canonically sorted (automerge sorts `get_heads()`), so plain
 * joining matches automerge-repo's exact-array `headsAreSame`.
 */
function headsCacheKey(headsHex: string[]): string {
  return headsHex.join("\u0000");
}

// ── Chunked NotebookDoc store keys + codec ───────────────────────────

/** The whole chunked store across every principal (read/scan paths). */
export function notebookDocChunksPrefix(notebookId: string): StorageKey {
  return [notebookId, NOTEBOOK_DOC_CHUNKS_KEY_SEGMENT];
}

/**
 * One principal's chunk sub-range. The principal segment makes the
 * union single-principal by construction: another principal's chunks
 * live under a different prefix and can never be vouched for by this
 * sub-range's meta record.
 */
export function notebookDocPrincipalChunksPrefix(
  notebookId: string,
  principal: string,
): StorageKey {
  return [notebookId, NOTEBOOK_DOC_CHUNKS_KEY_SEGMENT, principal];
}

export function notebookDocChunkMetaKey(notebookId: string, principal: string): StorageKey {
  return [...notebookDocPrincipalChunksPrefix(notebookId, principal), CHUNK_META_KEY_SEGMENT];
}

/**
 * Snapshot chunk key. The heads segment is the canonically-sorted heads
 * joined verbatim (automerge-repo hashes them; plain joining keeps the
 * same property — every tab derives the identical key for identical
 * heads — without an async hash on the capture path).
 */
export function notebookDocSnapshotChunkKey(
  notebookId: string,
  principal: string,
  headsHex: string[],
): StorageKey {
  return [
    ...notebookDocPrincipalChunksPrefix(notebookId, principal),
    CHUNK_KIND_SNAPSHOT,
    headsHex.join("-"),
  ];
}

/** Incremental chunk key, content-addressed by the chunk bytes' SHA-256. */
export function notebookDocIncrementalChunkKey(
  notebookId: string,
  principal: string,
  contentHashHex: string,
): StorageKey {
  return [
    ...notebookDocPrincipalChunksPrefix(notebookId, principal),
    CHUNK_KIND_INCREMENTAL,
    contentHashHex,
  ];
}

/** Identity string for chunk-key comparison (unambiguous across segments). */
function chunkKeyId(key: StorageKey): string {
  return JSON.stringify(key);
}

/** Chunk meta is plain meta JSON — no envelope, the chunks carry the bytes. */
export function encodeNotebookDocChunkMeta(meta: NotebookDocPersistenceMeta): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(meta));
}

/** Decode the chunk meta record; any damage degrades to null (unverifiable). */
export function decodeNotebookDocChunkMeta(bytes: Uint8Array): NotebookDocPersistenceMeta | null {
  return decodeMeta(bytes);
}

/**
 * Load one principal's chunked NotebookDoc store.
 *
 * Returns undefined when no data chunks exist in that sub-range (callers
 * fall back to the PR-1 envelope record). Snapshots are concatenated
 * before incrementals; `NotebookHandle.load()` accepts the combined
 * buffer and deduplicates overlap. Records under unknown sub-keys are
 * ignored — and, like every read path here, never deleted: another
 * writer (a newer version, a concurrent tab) may own them.
 */
export async function loadPersistedNotebookDocChunks(
  adapter: StorageAdapter,
  notebookId: string,
  principal: string,
): Promise<PersistedNotebookDocChunks | undefined> {
  const range = await adapter.loadRange(notebookDocPrincipalChunksPrefix(notebookId, principal));
  return chunkStoreFromRange(range);
}

export interface PersistedNotebookDocChunkStore extends PersistedNotebookDocChunks {
  /** The sub-range's principal key segment. */
  principal: string;
}

/**
 * Scan every principal sub-range of a notebook's chunked store (the
 * instant-paint path, which holds a principal MATCHER rather than an
 * exact principal before the handshake). Strictly read-only.
 */
export async function loadAllPersistedNotebookDocChunkStores(
  adapter: StorageAdapter,
  notebookId: string,
): Promise<PersistedNotebookDocChunkStore[]> {
  const range = await adapter.loadRange(notebookDocChunksPrefix(notebookId));
  const byPrincipal = new Map<string, StorageChunk[]>();
  for (const chunk of range) {
    const principal = chunk.key[2];
    if (typeof principal !== "string" || chunk.key.length < 4) continue;
    const group = byPrincipal.get(principal);
    if (group) {
      group.push(chunk);
    } else {
      byPrincipal.set(principal, [chunk]);
    }
  }
  const stores: PersistedNotebookDocChunkStore[] = [];
  for (const [principal, group] of byPrincipal) {
    const store = chunkStoreFromRange(group);
    if (store) {
      stores.push({ ...store, principal });
    }
  }
  return stores;
}

/** Key shape: `[notebookId, "chunks", <principal>, <kind>, <address>?]`. */
function chunkStoreFromRange(range: StorageChunk[]): PersistedNotebookDocChunks | undefined {
  const snapshots: Array<{ key: StorageKey; data: Uint8Array }> = [];
  const incrementals: Array<{ key: StorageKey; data: Uint8Array }> = [];
  let metaBytes: Uint8Array | undefined;
  for (const { key, data } of range) {
    if (!data) continue;
    if (key.length === 4 && key[3] === CHUNK_META_KEY_SEGMENT) {
      metaBytes = data;
      continue;
    }
    if (key.length !== 5) continue;
    if (key[3] === CHUNK_KIND_SNAPSHOT) {
      snapshots.push({ key, data });
    } else if (key[3] === CHUNK_KIND_INCREMENTAL) {
      incrementals.push({ key, data });
    }
  }
  if (snapshots.length === 0 && incrementals.length === 0) {
    return undefined;
  }

  const ordered = [...snapshots, ...incrementals];
  const total = ordered.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
  const bytes = new Uint8Array(total);
  const chunks: NotebookDocChunkInfo[] = [];
  let offset = 0;
  for (const { key, data } of ordered) {
    bytes.set(data, offset);
    offset += data.byteLength;
    chunks.push({
      key,
      size: data.byteLength,
      kind: key[3] === CHUNK_KIND_SNAPSHOT ? "snapshot" : "incremental",
    });
  }
  return { bytes, meta: metaBytes ? decodeMeta(metaBytes) : null, chunks };
}

/**
 * Remove ONLY one principal's chunk sub-range. Used by the chunk-level
 * guard (unverifiable meta inside the caller's own sub-range), which
 * falls back to the envelope record rather than discarding the whole
 * notebook's records. The whole-notebook discard
 * (`clearPersistedNotebookDoc`) removes every principal's chunks via the
 * `[notebookId]` prefix.
 */
export function clearPersistedNotebookDocChunks(
  adapter: StorageAdapter,
  notebookId: string,
  principal: string,
): Promise<void> {
  return adapter.removeRange(notebookDocPrincipalChunksPrefix(notebookId, principal));
}

/**
 * Store-epoch mint. Uniqueness across resets is what matters (writers
 * compare for equality), not monotonicity; collisions across unrelated
 * resets are 1-in-2^31 per pair.
 */
function mintChunkStoreGeneration(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

/** WebCrypto SHA-256 (Node ≥ 20 and every secure browser context). */
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // No silent weak-hash fallback: chunk keys are content addresses and
    // a collision would alias different byte streams. Failing routes
    // through the controller's normal save-failure degradation.
    throw new Error("WebCrypto subtle digest unavailable for chunk content addressing");
  }
  const digest = await subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Load the persisted NotebookDoc record for a notebook.
 *
 * Returns undefined when no record exists. A torn, truncated, or
 * otherwise unparseable record yields `meta: null` (and possibly no
 * bytes) — callers must treat that as unverifiable provenance
 * (clear + bootstrap), never as a match.
 */
export function loadPersistedNotebookDoc(
  adapter: StorageAdapter,
  notebookId: string,
): Promise<PersistedNotebookDoc | undefined> {
  return loadPersistedNotebookRecord(adapter, notebookId, NOTEBOOK_DOC_SNAPSHOT_KEY_SEGMENT);
}

/**
 * Load one persisted envelope record (`[notebookId, keySegment]`); same
 * decode degradation rules as `loadPersistedNotebookDoc`.
 */
export async function loadPersistedNotebookRecord(
  adapter: StorageAdapter,
  notebookId: string,
  keySegment: string,
): Promise<PersistedNotebookDoc | undefined> {
  const envelope = await adapter.load([notebookId, keySegment]);
  if (!envelope) return undefined;
  return decodePersistedNotebookDoc(envelope);
}

/**
 * Remove every persisted record for a notebook (snapshot AND the
 * runtime-state render cache — a discard of one user's seed must not
 * leave their cached pixels behind).
 */
export function clearPersistedNotebookDoc(
  adapter: StorageAdapter,
  notebookId: string,
): Promise<void> {
  return adapter.removeRange([notebookId]);
}

/**
 * Remove exactly one persisted record. Used when only the render-only
 * runtime-state cache is corrupt — the NotebookDoc snapshot record (which
 * may hold offline edits) must survive.
 */
export function clearPersistedNotebookRecord(
  adapter: StorageAdapter,
  notebookId: string,
  keySegment: string,
): Promise<void> {
  return adapter.remove([notebookId, keySegment]);
}

/** Encode meta + doc bytes into one atomic envelope record. */
export function encodePersistedNotebookDoc(
  meta: NotebookDocPersistenceMeta,
  bytes: Uint8Array,
): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const envelope = new Uint8Array(
    ENVELOPE_META_LENGTH_BYTES + metaBytes.byteLength + bytes.byteLength,
  );
  new DataView(envelope.buffer).setUint32(0, metaBytes.byteLength, true);
  envelope.set(metaBytes, ENVELOPE_META_LENGTH_BYTES);
  envelope.set(bytes, ENVELOPE_META_LENGTH_BYTES + metaBytes.byteLength);
  return envelope;
}

/** Decode an envelope record; any structural damage degrades to meta: null. */
export function decodePersistedNotebookDoc(envelope: Uint8Array): PersistedNotebookDoc {
  if (envelope.byteLength < ENVELOPE_META_LENGTH_BYTES) {
    return { meta: null };
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const metaLength = view.getUint32(0, true);
  const metaEnd = ENVELOPE_META_LENGTH_BYTES + metaLength;
  if (metaEnd > envelope.byteLength) {
    // Truncated record: the doc bytes (and possibly the meta) are gone.
    return { meta: null };
  }
  const bytes = envelope.slice(metaEnd);
  if (bytes.byteLength === 0) {
    return { meta: null };
  }
  return { bytes, meta: decodeMeta(envelope.subarray(ENVELOPE_META_LENGTH_BYTES, metaEnd)) };
}

function decodeMeta(bytes: Uint8Array): NotebookDocPersistenceMeta | null {
  let parsed: Partial<NotebookDocPersistenceMeta>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<NotebookDocPersistenceMeta>;
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.principal !== "string" ||
    typeof parsed.savedAt !== "number" ||
    !Array.isArray(parsed.headsHex) ||
    !parsed.headsHex.every((head) => typeof head === "string") ||
    (parsed.generation !== undefined && typeof parsed.generation !== "number")
  ) {
    return null;
  }
  return {
    headsHex: parsed.headsHex,
    savedAt: parsed.savedAt,
    principal: parsed.principal,
    schemaVersion: 1,
    ...(parsed.generation !== undefined ? { generation: parsed.generation } : {}),
  };
}
