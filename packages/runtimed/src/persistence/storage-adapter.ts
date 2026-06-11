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
}
