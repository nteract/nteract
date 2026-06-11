/**
 * Per-runtime local-first persistence controllers for the cloud session.
 *
 * Two throttled envelope records per notebook, one principal:
 *
 * - `[notebookId, "snapshot"]` — NotebookDoc bytes from `handle.save()`,
 *   driven by `notebookDocChanged$`. The seed record: the only one ever
 *   loaded back into a SYNCING handle (see resolveCloudNotebookHandle).
 * - `[notebookId, "runtime-state-cache"]` — RuntimeStateDoc bytes from
 *   `handle.save_state_doc()`, driven by the engine's runtime-state
 *   stream. A PAINT SOURCE ONLY for the next page load's instant first
 *   paint: never loaded into the syncing handle, never flushed, never
 *   synced. The syncing handle still bootstraps RuntimeStateDoc empty and
 *   the room remains the only writer — the authority invariant forbids
 *   restoring runtime state into the sync path, not caching pixels.
 *
 * Anonymous principals skip persistence entirely (their records could
 * never match the next session, and an anonymous session must never clear
 * a signed-in user's records), so the factory returns null for them.
 */

import { map, type Observable } from "rxjs";
import {
  NotebookDocPersistence,
  RUNTIME_STATE_CACHE_KEY_SEGMENT,
  type StorageAdapter,
} from "runtimed";
import { isAnonymousCloudPrincipal } from "./live-sync";

export interface CloudPersistenceChangeSignals {
  /** `SyncEngine.notebookDocChanged$` — the NotebookDoc save hint. */
  notebookDocChanged$: Observable<void>;
  /** `SyncEngine.runtimeState$` — fires per applied RuntimeStateDoc change. */
  runtimeState$: Observable<unknown>;
}

export interface CloudPersistenceHandleSurface {
  save(): Uint8Array;
  get_heads_hex(): string[];
  save_state_doc(): Uint8Array;
  get_runtime_state_heads_hex(): string[];
}

export interface CloudNotebookPersistenceController {
  readonly principal: string;
  /** Commit both records immediately (pagehide, teardown); never rejects late captures. */
  flushNow(): Promise<void>;
  dispose(): void;
}

export interface CreateCloudNotebookPersistenceOptions {
  adapter: StorageAdapter;
  notebookId: string;
  principal: string;
  engine: CloudPersistenceChangeSignals;
  handle: CloudPersistenceHandleSurface;
  /**
   * `meta.headsHex` of the snapshot record this runtime seeded from, when
   * that record is still the one in storage. Initializes the NotebookDoc
   * controller's heads-dedupe so the handshake's protocol-only change
   * signal does not re-write the identical envelope it just loaded. Never
   * applies to the runtime-state cache (the seed meta describes the
   * snapshot record only).
   */
  seedSavedHeadsHex?: string[];
  onError?: (error: unknown) => void;
  /** Test hook: trailing-edge throttle for both controllers. */
  throttleMs?: number;
}

export function createCloudNotebookPersistence({
  adapter,
  notebookId,
  principal,
  engine,
  handle,
  seedSavedHeadsHex,
  onError,
  throttleMs,
}: CreateCloudNotebookPersistenceOptions): CloudNotebookPersistenceController | null {
  if (isAnonymousCloudPrincipal(principal)) {
    return null;
  }

  const notebookDoc = new NotebookDocPersistence({
    adapter,
    notebookId,
    principal,
    changes$: engine.notebookDocChanged$,
    getSaveBytes: () => handle.save(),
    getHeadsHex: () => handle.get_heads_hex(),
    initialSavedHeadsHex: seedSavedHeadsHex,
    onError,
    ...(throttleMs !== undefined ? { throttleMs } : {}),
  });
  const runtimeStateCache = new NotebookDocPersistence({
    adapter,
    notebookId,
    principal,
    keySegment: RUNTIME_STATE_CACHE_KEY_SEGMENT,
    changes$: engine.runtimeState$.pipe(map(() => undefined)),
    getSaveBytes: () => handle.save_state_doc(),
    getHeadsHex: () => handle.get_runtime_state_heads_hex(),
    onError,
    ...(throttleMs !== undefined ? { throttleMs } : {}),
  });

  return {
    principal,
    flushNow: async () => {
      // Both captures run synchronously inside flushNow before the first
      // await, so the caller may free the WASM handle as soon as this call
      // returns; the promise settles once both write chains commit.
      await Promise.all([notebookDoc.flushNow(), runtimeStateCache.flushNow()]);
    },
    dispose: () => {
      notebookDoc.dispose();
      runtimeStateCache.dispose();
    },
  };
}
