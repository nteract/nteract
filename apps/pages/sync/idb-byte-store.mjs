// Byte store over one IndexedDB object store, for DocStore in the browser.
// saveMany is one readwrite transaction: every entry or none.

const STORE = "bytes";

export class IdbByteStore {
  #name;
  #db;

  constructor(name) {
    this.#name = name;
  }

  get name() {
    return this.#name;
  }

  #open() {
    this.#db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
    return this.#db;
  }

  async #run(mode, body) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      body(tx.objectStore(STORE), (value) => (result = value));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }

  load(key) {
    return this.#run("readonly", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () =>
        done(request.result === undefined ? undefined : new Uint8Array(request.result));
    });
  }

  saveMany(entries) {
    // Copy synchronously: callers may reuse buffers while the database opens.
    const copies = entries.map(([key, value]) => [key, new Uint8Array(value)]);
    return this.#run("readwrite", (store) => {
      for (const [key, value] of copies) store.put(value, key);
    });
  }

  save(key, value) {
    return this.saveMany([[key, value]]);
  }

  remove(key) {
    return this.#run("readwrite", (store) => store.delete(key));
  }

  list(prefix) {
    return this.#run("readonly", (store, done) => {
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      const request = store.getAllKeys(range);
      request.onsuccess = () => done(request.result.filter((k) => typeof k === "string"));
    });
  }

  async close() {
    const opening = this.#db;
    this.#db = undefined;
    if (opening) (await opening).close();
  }

  /** Delete the whole database (local recovery and retirement). */
  async destroy() {
    await this.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.#name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  }
}
