/**
 * IndexedDbStorageAdapter — browser-persistent StorageAdapter on IndexedDB.
 *
 * Modeled on automerge-repo's IndexedDB adapter: out-of-line `string[]`
 * keys (IDB array-key ordering makes prefix ranges work), one short-lived
 * transaction per operation, writes resolve on `transaction.oncomplete` so
 * they are durable. Hardened where that adapter is thin:
 * - `create()` returns null when indexedDB is unavailable (private mode,
 *   SSR) so callers can skip persistence instead of throwing.
 * - Operation failures (QuotaExceededError, aborted transactions) reject
 *   the operation's promise and surface through the optional `onError`
 *   callback — never an unhandled rejection inside an IDB event handler.
 * - The cached connection is dropped on `close`/`onversionchange` (another
 *   tab upgrading, the browser closing an idle connection) and reopened on
 *   the next operation, with a single retry when a transaction cannot be
 *   started on a stale connection.
 */

import type { StorageAdapter, StorageChunk, StorageKey } from "./storage-adapter";

const DEFAULT_DATABASE_NAME = "nteract-local-first";
const DEFAULT_STORE_NAME = "notebook-docs";

/**
 * Sentinel for prefix range upper bounds: any longer key
 * `[...prefix, segment]` sorts between `prefix` and `[...prefix, "￿"]`
 * under IDB array-key ordering, as long as key segments stay below U+FFFF
 * (true for notebook ids and the record-type key words).
 */
const PREFIX_UPPER_BOUND = "￿";

export interface IndexedDbStorageAdapterOptions {
  /** Database name (default `"nteract-local-first"`). */
  databaseName?: string;

  /** Object store name (default `"notebook-docs"`). */
  storeName?: string;

  /** IDBFactory override for tests; defaults to the global `indexedDB`. */
  indexedDB?: IDBFactory;

  /**
   * Invoked when an operation fails, in addition to rejecting that
   * operation's promise. Lets hosts log or disable persistence in one
   * place without racing every call site.
   */
  onError?: (error: unknown) => void;
}

export class IndexedDbStorageAdapter implements StorageAdapter {
  private readonly factory: IDBFactory;
  private readonly databaseName: string;
  private readonly storeName: string;
  private readonly onError?: (error: unknown) => void;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private currentDb: IDBDatabase | null = null;
  /** Bumped by close() so an in-flight open never resurrects a closed cache. */
  private connectionGeneration = 0;

  /**
   * Returns null when IndexedDB is unavailable (private browsing modes,
   * SSR, locked-down iframes) so persistence degrades to disabled.
   */
  static create(options: IndexedDbStorageAdapterOptions = {}): IndexedDbStorageAdapter | null {
    const factory = options.indexedDB ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
    if (!factory) return null;
    return new IndexedDbStorageAdapter(factory, options);
  }

  private constructor(factory: IDBFactory, options: IndexedDbStorageAdapterOptions) {
    this.factory = factory;
    this.databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
    this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
    this.onError = options.onError;
  }

  /**
   * Close the cached connection (connection hygiene for effect teardown).
   *
   * Not a terminal state: a later operation reopens on demand. Safe to
   * call repeatedly or while an open is in flight.
   */
  close(): void {
    this.connectionGeneration += 1;
    const db = this.currentDb;
    this.currentDb = null;
    this.dbPromise = null;
    db?.close();
  }

  load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.withStore(
      "readonly",
      (store) =>
        new Promise<Uint8Array | undefined>((resolve, reject) => {
          const request = store.get(key);
          request.onsuccess = () => resolve(asBytes(request.result));
          request.onerror = () => reject(request.error ?? new Error("indexedDB load failed"));
        }),
    );
  }

  save(key: StorageKey, data: Uint8Array): Promise<void> {
    return this.withStore(
      "readwrite",
      (store, transaction) =>
        new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("indexedDB save aborted"));
          transaction.onerror = () =>
            reject(transaction.error ?? new Error("indexedDB save failed"));
          store.put(data, key);
        }),
    );
  }

  remove(key: StorageKey): Promise<void> {
    return this.withStore(
      "readwrite",
      (store, transaction) =>
        new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("indexedDB remove aborted"));
          transaction.onerror = () =>
            reject(transaction.error ?? new Error("indexedDB remove failed"));
          store.delete(key);
        }),
    );
  }

  loadRange(prefix: StorageKey): Promise<StorageChunk[]> {
    return this.withStore(
      "readonly",
      (store) =>
        new Promise<StorageChunk[]>((resolve, reject) => {
          const chunks: StorageChunk[] = [];
          const request = store.openCursor(prefixRange(prefix));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve(chunks);
              return;
            }
            chunks.push({ key: asKeyArray(cursor.key), data: asBytes(cursor.value) });
            cursor.continue();
          };
          request.onerror = () => reject(request.error ?? new Error("indexedDB loadRange failed"));
        }),
    );
  }

  removeRange(prefix: StorageKey): Promise<void> {
    return this.withStore(
      "readwrite",
      (store, transaction) =>
        new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("indexedDB removeRange aborted"));
          transaction.onerror = () =>
            reject(transaction.error ?? new Error("indexedDB removeRange failed"));
          store.delete(prefixRange(prefix));
        }),
    );
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.runWithStore(mode, run, true);
    } catch (error) {
      try {
        this.onError?.(error);
      } catch {
        // onError must never throw back into the storage pipeline
      }
      throw error;
    }
  }

  private async runWithStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, transaction: IDBTransaction) => Promise<T>,
    retryOnStaleConnection: boolean,
  ): Promise<T> {
    const db = await this.getDb();
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(this.storeName, mode);
    } catch (error) {
      // The browser may close an idle connection out from under us
      // (InvalidStateError). Reopen once and retry.
      if (retryOnStaleConnection && isStaleConnectionError(error)) {
        this.invalidate(db);
        return this.runWithStore(mode, run, false);
      }
      throw error;
    }
    return run(transaction.objectStore(this.storeName), transaction);
  }

  private getDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const opened = this.openDb();
    this.dbPromise = opened;
    // Clear the cache through the promise itself, not inside the executor:
    // a synchronous factory.open() throw rejects during openDb()'s own
    // evaluation, before the assignment above — an executor-side reset
    // would be overwritten and the rejection cached forever.
    opened.catch(() => {
      if (this.dbPromise === opened) {
        this.dbPromise = null;
      }
    });
    return opened;
  }

  private openDb(): Promise<IDBDatabase> {
    const generation = this.connectionGeneration;
    return new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory.open(this.databaseName, 1);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        request.result.createObjectStore(this.storeName);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("indexedDB open failed"));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (generation !== this.connectionGeneration) {
          // close() raced the open; don't leak the fresh connection.
          db.close();
          reject(new Error("indexedDB connection closed during open"));
          return;
        }
        // Another tab upgrading the schema, or the browser closing an
        // idle connection: drop the cached connection so the next
        // operation reopens instead of failing forever.
        db.onversionchange = () => {
          db.close();
          this.invalidate(db);
        };
        db.onclose = () => this.invalidate(db);
        this.currentDb = db;
        resolve(db);
      };
    });
  }

  private invalidate(db: IDBDatabase): void {
    // Only clear the cache if it still points at this connection — a
    // concurrent reopen may already have replaced it.
    if (this.currentDb === db) {
      this.currentDb = null;
      this.dbPromise = null;
    }
  }
}

function prefixRange(prefix: StorageKey): IDBKeyRange {
  return IDBKeyRange.bound(prefix, [...prefix, PREFIX_UPPER_BOUND]);
}

function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  // Structured clone can hand back a typed array from another realm
  // (worker boundaries, test fakes); normalize instead of dropping it.
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function asKeyArray(key: IDBValidKey): StorageKey {
  return Array.isArray(key) ? key.map(String) : [String(key)];
}

function isStaleConnectionError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "InvalidStateError";
}
