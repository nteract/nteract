/**
 * Storage layer for local-first NotebookDoc persistence.
 *
 * Borrowed from automerge-repo's storage subsystem shapes: hierarchical
 * `string[]` keys enable range queries by prefix, and the adapter stays
 * agnostic to key meaning so the key layout can grow (e.g. incremental
 * chunks alongside snapshots) without adapter changes or data migration.
 */

export type StorageKey = string[];

export interface StorageChunk {
  key: StorageKey;
  data: Uint8Array | undefined;
}

export interface StorageAdapter {
  load(key: StorageKey): Promise<Uint8Array | undefined>;
  save(key: StorageKey, data: Uint8Array): Promise<void>;
  remove(key: StorageKey): Promise<void>;
  loadRange(prefix: StorageKey): Promise<StorageChunk[]>;
  removeRange(prefix: StorageKey): Promise<void>;

  /**
   * Save multiple key-value pairs as a staged batch (upstream
   * automerge-repo's `StorageAdapterInterface.saveBatch` extension, kept
   * optional here so plain adapters keep working via {@link saveBatch}'s
   * sequential fallback).
   *
   * Implementations SHOULD apply the batch in two phases — stage every
   * entry durably, then commit — so a failure before commit leaves no
   * entry observable. At minimum each entry must be atomic on its own.
   *
   * The contract is per-batch, not cross-batch: callers that need
   * crash-ordering across record kinds must issue separate sequential
   * `saveBatch` calls in dependency order (payload chunks first, metadata
   * second, the visibility marker last), so a crash between batches
   * leaves invisible orphans rather than a visible-but-incomplete record.
   */
  saveBatch?(entries: Array<[StorageKey, Uint8Array]>): Promise<void>;
}

/**
 * Save a batch through the adapter's `saveBatch` when it has one,
 * falling back to sequential `save` calls (upstream's default-impl
 * shape). The fallback is per-entry-atomic only: when entry N fails,
 * entries 0..N-1 are already durable and N.. were never attempted — the
 * thrown `SaveBatchEntryError` carries the failed key and index so
 * callers can tell a clean prefix from an unknown state. Callers that
 * need the stronger staged semantics get them exactly when the adapter
 * provides them.
 */
export async function saveBatch(
  adapter: StorageAdapter,
  entries: Array<[StorageKey, Uint8Array]>,
): Promise<void> {
  if (entries.length === 0) return;
  if (adapter.saveBatch) {
    await adapter.saveBatch(entries);
    return;
  }
  for (const [index, [key, data]] of entries.entries()) {
    try {
      await adapter.save(key, data);
    } catch (cause) {
      throw new SaveBatchEntryError(key, index, cause);
    }
  }
}

/**
 * Sequential-fallback failure: entries before `index` are durable,
 * `index` and after are not written.
 */
export class SaveBatchEntryError extends Error {
  readonly key: StorageKey;
  readonly index: number;
  // Declared and assigned directly rather than via the ES2022 ErrorOptions
  // constructor argument — apps/notebook compiles this package under
  // lib: ES2020, where Error has no `cause` member.
  readonly cause: unknown;

  constructor(key: StorageKey, index: number, cause: unknown) {
    super(`saveBatch fallback failed at entry ${index} (${key.join("/")})`);
    this.name = "SaveBatchEntryError";
    this.key = key;
    this.index = index;
    this.cause = cause;
  }
}
