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
 * Two records exist per notebook:
 * - `[notebookId, "snapshot"]` — NotebookDoc bytes, the seed record. The
 *   only record ever loaded back into a SYNCING handle.
 * - `[notebookId, "runtime-state-cache"]` — RuntimeStateDoc bytes as a
 *   render-only paint source for instant first paint. NEVER loaded into
 *   the syncing handle, never flushed, never synced: the syncing handle
 *   still bootstraps RuntimeStateDoc empty and the daemon/room remains the
 *   only writer. The authority invariant forbids restoring runtime state
 *   into the sync path, not caching pixels. CommsDoc and Automerge sync
 *   states are never written to storage.
 *
 * Failures never propagate into the live session: every error routes to
 * the `onError` callback and the logger, and after
 * `MAX_CONSECUTIVE_SAVE_FAILURES` the controller self-disposes so a dead
 * or quota-exhausted backend cannot generate doomed writes forever.
 */

import type { Observable, Subscription } from "rxjs";

import { saveBatch, type StorageAdapter } from "./storage-adapter";

const DEFAULT_SAVE_THROTTLE_MS = 1_000;

/** Key segment of the NotebookDoc snapshot record (the seed record). */
export const NOTEBOOK_DOC_SNAPSHOT_KEY_SEGMENT = "snapshot";

/**
 * Key segment of the render-only RuntimeStateDoc cache record — a paint
 * source for instant first paint, never a sync seed.
 */
export const RUNTIME_STATE_CACHE_KEY_SEGMENT = "runtime-state-cache";

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
}

export interface PersistedNotebookDoc {
  /** Doc snapshot bytes; absent when the record is torn or truncated. */
  bytes?: Uint8Array;
  /** null when the meta portion is missing or unparseable. */
  meta: NotebookDocPersistenceMeta | null;
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
   * snapshot record (`"snapshot"`).
   */
  keySegment?: string;

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

  constructor(opts: NotebookDocPersistenceOptions) {
    this.opts = opts;
    this.keySegment = opts.keySegment ?? NOTEBOOK_DOC_SNAPSHOT_KEY_SEGMENT;
    this.throttleMs = opts.throttleMs ?? DEFAULT_SAVE_THROTTLE_MS;
    this.logger = opts.logger ?? console;
    // An empty heads array is treated as unknown, not as an identity: a
    // freshly-bootstrapped doc (RuntimeStateDoc starts empty by design)
    // would otherwise match a stale prior-session record's empty heads and
    // skip its first save.
    const initialHeads = opts.initialSavedHeadsHex;
    if (initialHeads && initialHeads.length > 0) {
      const initialKey = headsCacheKey(initialHeads);
      this.lastSavedHeadsKey = initialKey;
      this.lastCommittedHeadsKey = initialKey;
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

    // Capture synchronously: getSaveBytes touches the WASM handle, which a
    // disposing session may free as soon as this call returns.
    let envelope: Uint8Array;
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
      const meta: NotebookDocPersistenceMeta = {
        headsHex,
        savedAt: Date.now(),
        principal: this.opts.principal,
        schemaVersion: 1,
      };
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
  return headsHex.join(" ");
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
    !parsed.headsHex.every((head) => typeof head === "string")
  ) {
    return null;
  }
  return {
    headsHex: parsed.headsHex,
    savedAt: parsed.savedAt,
    principal: parsed.principal,
    schemaVersion: 1,
  };
}
