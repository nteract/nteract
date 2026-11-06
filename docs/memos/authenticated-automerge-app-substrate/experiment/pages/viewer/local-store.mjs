// The local catalog's IndexedDB store: one database, one object store of
// byte values under out-of-line string keys. `run` hands a callback the
// object store inside one transaction, so a read and a write in it are
// atomic across tabs. Databases created by earlier builds open unchanged:
// the store opens at the database's current version and adds the object
// store only when it is missing.

/** Bytes by key in IndexedDB `database`, object store `store`. */
export class LocalStore {
  #db;

  constructor({ database, store = "bytes" }) {
    this.database = database;
    this.store = store;
  }

  #open() {
    if (this.#db) return this.#db;
    const { database: name, store } = this;
    const opening = new Promise((resolve, reject) => {
      let abandoned = false;
      const openVersion = (version) => {
        const request =
          version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
          abandoned = true;
          reject(new Error(`IndexedDB open blocked: ${name}`));
        };
        request.onsuccess = () => {
          const db = request.result;
          if (abandoned || this.#db !== opening) {
            db.close();
            resolve(db);
          } else if (!db.objectStoreNames.contains(store)) {
            const next = db.version + 1;
            db.close();
            openVersion(next);
          } else {
            const invalidate = () => {
              if (this.#db === opening) this.#db = undefined;
            };
            db.onclose = invalidate;
            db.onversionchange = () => {
              db.close();
              invalidate();
            };
            resolve(db);
          }
        };
      };
      openVersion();
    });
    this.#db = opening;
    void opening.catch(() => {
      if (this.#db === opening) this.#db = undefined;
    });
    return opening;
  }

  /** Run `operation(objectStore, done, fail)` in one transaction. It returns
   * its IDBRequest; `done(value)` sets the result the transaction resolves
   * with once it commits, and `fail(cause)` aborts it with `cause`. */
  async run(mode, operation) {
    const db = await this.#open();
    const transaction = db.transaction(this.store, mode);
    return new Promise((resolve, reject) => {
      let result;
      let failure;
      const request = operation(
        transaction.objectStore(this.store),
        (value) => {
          result = value;
        },
        (cause) => {
          failure = cause;
          transaction.abort();
        },
      );
      transaction.onabort = () =>
        reject(
          failure ??
            transaction.error ??
            request?.error ??
            new Error("IndexedDB transaction failed"),
        );
      transaction.oncomplete = () => resolve(result);
    });
  }

  load(key) {
    return this.run("readonly", (store, done, fail) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const value = request.result;
        if (value !== undefined && !(value instanceof Uint8Array)) {
          fail(new TypeError(`Invalid IndexedDB byte value for ${key}`));
          return;
        }
        done(value);
      };
      return request;
    });
  }

  save(key, bytes) {
    // Copy synchronously: callers may reuse the buffer while the database opens.
    const copy = new Uint8Array(bytes);
    return this.run("readwrite", (store) => store.put(copy, key));
  }

  remove(key) {
    return this.run("readwrite", (store) => store.delete(key));
  }

  list(prefix) {
    return this.run("readonly", (store, done) => {
      const keys = [];
      const request = store.openKeyCursor(IDBKeyRange.lowerBound(prefix));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && typeof cursor.key === "string" && cursor.key.startsWith(prefix)) {
          keys.push(cursor.key);
          cursor.continue();
        } else done(keys);
      };
      return request;
    });
  }

  /** Close the connection after any pending open; later calls reopen it. */
  async close() {
    const opening = this.#db;
    this.#db = undefined;
    if (opening) (await opening).close();
  }
}
