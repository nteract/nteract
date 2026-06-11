/**
 * NotebookDocPersistence — trailing-edge throttled NotebookDoc snapshots.
 *
 * Subscribes a narrow change signal (`SyncEngine.notebookDocChanged$`) and
 * persists full `handle.save()` bytes under `[notebookId, "snapshot"]` plus
 * a JSON meta record under `[notebookId, "meta"]`.
 *
 * Save semantics mirror automerge-repo's `asyncThrottle`: trailing edge,
 * never two concurrent writes, latest state wins, and the final state is
 * always committed (`flushNow()` on pagehide).
 *
 * Persists NotebookDoc bytes only — RuntimeStateDoc/CommsDoc are
 * daemon/room-authoritative and must never be written to storage, and
 * Automerge sync states are per-connection and not persisted either.
 *
 * Failures never propagate into the live session: every error routes to
 * the `onError` callback and the logger.
 */

import type { Observable, Subscription } from "rxjs";

import type { StorageAdapter } from "./storage-adapter";

const DEFAULT_SAVE_THROTTLE_MS = 1_000;
const SNAPSHOT_KEY_SEGMENT = "snapshot";
const META_KEY_SEGMENT = "meta";

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
  bytes: Uint8Array;
  /** null when the meta record is missing or unparseable. */
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
   * handle immediately afterwards.
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
   * Commit the current document state immediately (pagehide path).
   *
   * Bytes are captured synchronously, so a handle freed right after this
   * call returns is never touched by the queued write; the returned
   * promise resolves once the write chain has committed.
   */
  async flushNow(): Promise<void> {
    if (this.disposed) return;
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      await this.saveNow();
    } else {
      await this.writeChain;
    }
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
    this.dirty = false;

    // Capture synchronously: getSaveBytes touches the WASM handle, which a
    // disposing session may free as soon as this call returns.
    let bytes: Uint8Array;
    let meta: NotebookDocPersistenceMeta;
    try {
      bytes = this.opts.getSaveBytes();
      meta = {
        headsHex: this.opts.getHeadsHex(),
        savedAt: Date.now(),
        principal: this.opts.principal,
        schemaVersion: 1,
      };
    } catch (error) {
      this.reportError("snapshot capture failed", error);
      return this.writeChain;
    }

    const { adapter, notebookId } = this.opts;
    const write = this.writeChain.then(async () => {
      try {
        await adapter.save([notebookId, SNAPSHOT_KEY_SEGMENT], bytes);
        await adapter.save([notebookId, META_KEY_SEGMENT], encodeMeta(meta));
      } catch (error) {
        this.reportError("save failed", error);
      }
    });
    this.writeChain = write;
    return write;
  }

  private reportError(label: string, error: unknown): void {
    this.logger.warn(`[notebook-persistence] ${label}:`, error);
    try {
      this.opts.onError?.(error);
    } catch {
      // onError must never throw back into the save pipeline
    }
  }
}

/**
 * Load the persisted NotebookDoc record for a notebook.
 *
 * Returns undefined when no snapshot exists. A missing or corrupt meta
 * record yields `{ bytes, meta: null }` — callers must treat that as
 * unverifiable provenance (clear + bootstrap), never as a match.
 */
export async function loadPersistedNotebookDoc(
  adapter: StorageAdapter,
  notebookId: string,
): Promise<PersistedNotebookDoc | undefined> {
  const bytes = await adapter.load([notebookId, SNAPSHOT_KEY_SEGMENT]);
  if (!bytes) return undefined;
  const metaBytes = await adapter.load([notebookId, META_KEY_SEGMENT]);
  return { bytes, meta: metaBytes ? decodeMeta(metaBytes) : null };
}

/** Remove every persisted record for a notebook. */
export function clearPersistedNotebookDoc(
  adapter: StorageAdapter,
  notebookId: string,
): Promise<void> {
  return adapter.removeRange([notebookId]);
}

function encodeMeta(meta: NotebookDocPersistenceMeta): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(meta));
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
