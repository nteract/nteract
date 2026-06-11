/**
 * NotebookDocPersistence — trailing-edge throttled NotebookDoc snapshots.
 *
 * Subscribes a narrow change signal (`SyncEngine.notebookDocChanged$`) and
 * persists one self-contained envelope record under
 * `[notebookId, "snapshot"]`: a 4-byte little-endian meta-JSON length, the
 * meta JSON (utf8), then the full `handle.save()` NotebookDoc bytes. A
 * single record means a single IDB transaction — meta and bytes can never
 * tear apart, so the principal guard always describes the bytes it sits
 * next to.
 *
 * Save semantics mirror automerge-repo's `asyncThrottle`: trailing edge,
 * never two concurrent writes, latest state wins. `flushNow()` (pagehide,
 * teardown) captures unconditionally — local edits inside the engine's
 * flush debounce have not emitted yet, but `handle.save()` already sees
 * them, and saves are idempotent.
 *
 * Persists NotebookDoc bytes only — RuntimeStateDoc/CommsDoc are
 * daemon/room-authoritative and must never be written to storage, and
 * Automerge sync states are per-connection and not persisted either.
 *
 * Failures never propagate into the live session: every error routes to
 * the `onError` callback and the logger, and after
 * `MAX_CONSECUTIVE_SAVE_FAILURES` the controller self-disposes so a dead
 * or quota-exhausted backend cannot generate doomed writes forever.
 */

import type { Observable, Subscription } from "rxjs";

import type { StorageAdapter } from "./storage-adapter";

const DEFAULT_SAVE_THROTTLE_MS = 1_000;
const SNAPSHOT_KEY_SEGMENT = "snapshot";

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

  /** Full NotebookDoc snapshot bytes (raw `NotebookHandle.save()`). */
  getSaveBytes: () => Uint8Array;

  /** Current notebook heads (`NotebookHandle.get_heads_hex()`). */
  getHeadsHex: () => string[];

  /** Trailing-edge save throttle in milliseconds (default 1000). */
  throttleMs?: number;

  /** Persistence failures route here; they never throw into the session. */
  onError?: (error: unknown) => void;

  logger?: NotebookDocPersistenceLogger;
}

export class NotebookDocPersistence {
  private readonly opts: NotebookDocPersistenceOptions;
  private readonly throttleMs: number;
  private readonly logger: NotebookDocPersistenceLogger;
  private readonly subscription: Subscription;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private disposed = false;
  private consecutiveSaveFailures = 0;
  /** Serializes adapter writes so two saves never interleave (latest wins). */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: NotebookDocPersistenceOptions) {
    this.opts = opts;
    this.throttleMs = opts.throttleMs ?? DEFAULT_SAVE_THROTTLE_MS;
    this.logger = opts.logger ?? console;
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
   * Captures unconditionally, ignoring the change-signal dirty flag: local
   * edits inside the engine's flush debounce have not emitted yet, but
   * `getSaveBytes()` already sees them. Bytes are captured synchronously,
   * so a handle freed right after this call returns is never touched by
   * the queued write; the returned promise resolves once the write chain
   * has committed.
   */
  async flushNow(): Promise<void> {
    if (this.disposed) return;
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.captureAndEnqueue();
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

  private captureAndEnqueue(): Promise<void> {
    this.dirty = false;

    // Capture synchronously: getSaveBytes touches the WASM handle, which a
    // disposing session may free as soon as this call returns.
    let envelope: Uint8Array;
    try {
      const meta: NotebookDocPersistenceMeta = {
        headsHex: this.opts.getHeadsHex(),
        savedAt: Date.now(),
        principal: this.opts.principal,
        schemaVersion: 1,
      };
      envelope = encodePersistedNotebookDoc(meta, this.opts.getSaveBytes());
    } catch (error) {
      this.reportSaveFailure("snapshot capture failed", error);
      return this.writeChain;
    }

    const { adapter, notebookId } = this.opts;
    const write = this.writeChain.then(async () => {
      try {
        await adapter.save([notebookId, SNAPSHOT_KEY_SEGMENT], envelope);
        this.consecutiveSaveFailures = 0;
      } catch (error) {
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
 * Load the persisted NotebookDoc record for a notebook.
 *
 * Returns undefined when no record exists. A torn, truncated, or
 * otherwise unparseable record yields `meta: null` (and possibly no
 * bytes) — callers must treat that as unverifiable provenance
 * (clear + bootstrap), never as a match.
 */
export async function loadPersistedNotebookDoc(
  adapter: StorageAdapter,
  notebookId: string,
): Promise<PersistedNotebookDoc | undefined> {
  const envelope = await adapter.load([notebookId, SNAPSHOT_KEY_SEGMENT]);
  if (!envelope) return undefined;
  return decodePersistedNotebookDoc(envelope);
}

/** Remove every persisted record for a notebook. */
export function clearPersistedNotebookDoc(
  adapter: StorageAdapter,
  notebookId: string,
): Promise<void> {
  return adapter.removeRange([notebookId]);
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
