/**
 * Per-runtime local-first persistence controllers for the cloud session.
 *
 * Two throttled stores per notebook, one principal:
 *
 * - `[notebookId, "chunks", ...]` — the chunked NotebookDoc seed store
 *   (content-addressed incrementals + heads-keyed snapshots + a meta
 *   record carrying the principal guard), driven by `notebookDocChanged$`
 *   over `handle.save_since_heads()` with `handle.save()` as the
 *   compaction source. The seed store: the only one ever loaded back
 *   into a SYNCING handle (see resolveCloudNotebookHandle /
 *   loadCloudPersistedNotebookSeed). The PR-1 `[notebookId, "snapshot"]`
 *   envelope record is no longer written for the NotebookDoc but remains
 *   the load fallback (older-version rollback keeps a usable — if stale —
 *   record).
 * - `[notebookId, "runtime-state-cache"]` — RuntimeStateDoc bytes from
 *   `handle.save_state_doc()`, driven by the engine's runtime-state
 *   stream. A PAINT SOURCE ONLY for the next page load's instant first
 *   paint: never loaded into the syncing handle, never flushed, never
 *   synced. The syncing handle still bootstraps RuntimeStateDoc empty and
 *   the room remains the only writer — the authority invariant forbids
 *   restoring runtime state into the sync path, not caching pixels. This
 *   record stays an ENVELOPE: it is a rewrite-whole paint cache, not a
 *   history store.
 *
 * Anonymous principals skip persistence entirely (their records could
 * never match the next session, and an anonymous session must never clear
 * a signed-in user's records), so the factory returns null for them.
 */

import { map, type Observable } from "rxjs";
import {
  NotebookDocPersistence,
  RUNTIME_STATE_CACHE_KEY_SEGMENT,
  clearPersistedNotebookDocChunks,
  loadPersistedNotebookDoc,
  loadPersistedNotebookDocChunks,
  type NotebookDocChunkInfo,
  type StorageAdapter,
} from "runtimed";
import { isAnonymousCloudPrincipal, type PersistedCloudNotebookSeed } from "./live-sync";

export interface CloudPersistenceChangeSignals {
  /** `SyncEngine.notebookDocChanged$` — the NotebookDoc save hint. */
  notebookDocChanged$: Observable<void>;
  /** `SyncEngine.runtimeState$` — fires per applied RuntimeStateDoc change. */
  runtimeState$: Observable<unknown>;
}

export interface CloudPersistenceHandleSurface {
  save(): Uint8Array;
  save_since_heads(headsHex: string[]): Uint8Array;
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
  /**
   * Chunk inventory the handle was seeded from, under the same first-arm
   * + principal gate as `seedSavedHeadsHex`. These become compaction-
   * deletable; chunks the doc was not seeded from must never be passed.
   */
  seedChunks?: NotebookDocChunkInfo[];
  onError?: (error: unknown) => void;
  /** Test hook: trailing-edge throttle for both controllers. */
  throttleMs?: number;
  /** Test hook: content-hash override for incremental chunk keys. */
  chunkDigest?: (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;
}

export function createCloudNotebookPersistence({
  adapter,
  notebookId,
  principal,
  engine,
  handle,
  seedSavedHeadsHex,
  seedChunks,
  onError,
  throttleMs,
  chunkDigest,
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
    chunked: {
      getSaveBytesSince: (headsHex) => handle.save_since_heads(headsHex),
      initialChunks: seedChunks,
      ...(chunkDigest ? { digest: chunkDigest } : {}),
    },
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

/**
 * Read the persisted NotebookDoc seed for a notebook, preferring the
 * chunked store and falling back to the PR-1 envelope record.
 *
 * Chunk-level principal guard (the envelope's rules, applied per store):
 * a chunk store whose meta is unverifiable (missing/corrupt) or stamped
 * with another principal is discarded — but ONLY the `[notebookId,
 * "chunks"]` range — and the load falls back to the envelope record,
 * which the resolver then verifies with the record-level guard as
 * before. Never called for anonymous principals (the resolver gates
 * first), so the chunk clear can never discard a signed-in user's store
 * from an anonymous session.
 *
 * Migration note: an envelope-seeded session's first chunked save writes
 * a fresh snapshot chunk (the compaction floor fires on an empty chunk
 * inventory); the envelope record is left in place for older-version
 * rollback and simply goes stale.
 */
export async function loadCloudPersistedNotebookSeed(
  adapter: StorageAdapter,
  notebookId: string,
  principal: string,
): Promise<PersistedCloudNotebookSeed | undefined> {
  const chunked = await loadPersistedNotebookDocChunks(adapter, notebookId);
  if (chunked) {
    if (chunked.meta && chunked.meta.principal === principal) {
      return { bytes: chunked.bytes, meta: chunked.meta, chunks: chunked.chunks };
    }
    try {
      await clearPersistedNotebookDocChunks(adapter, notebookId);
    } catch (error) {
      console.warn("[notebook-cloud] failed to clear mismatched chunk store", error);
    }
  }
  return loadPersistedNotebookDoc(adapter, notebookId);
}
