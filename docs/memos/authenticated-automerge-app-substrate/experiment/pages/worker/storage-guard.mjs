/**
 * A Durable Object's storage that refuses writes once its object is retired.
 *
 * After a runtime reset the old object keeps running: its boot, timers and
 * requests still hold the storage the new object reads
 * (scripts/celld-boot-probe.mjs). A Page host wraps its context once, in the
 * constructor, so every storage user it builds (the policy, the record
 * store, the journal, actor persistence, content activity) shares one gate.
 * `refusal()` returns the error to refuse with, or nothing while writes are
 * allowed. Reads always pass.
 */

/** Storage methods that write, or open a scope that writes. */
export const STORAGE_WRITES = Object.freeze([
  "put",
  "delete",
  "deleteAll",
  "sync",
  "transaction",
  "transactionSync",
  "setAlarm",
  "deleteAlarm",
]);
const WRITES = new Set(STORAGE_WRITES);

/** `storage` with every write refused while `refusal()` returns an error. A
 * transaction's own storage is guarded too, so a write inside one that
 * started earlier is refused and rolls it back. */
export function guardStorage(storage, refusal) {
  return new Proxy(storage, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (!WRITES.has(prop)) return value.bind(target);
      if (prop === "transactionSync")
        return (...args) => {
          const error = refusal();
          if (error) throw error;
          return value.apply(target, args);
        };
      return (...args) => {
        const error = refusal();
        if (error) return Promise.reject(error);
        if (prop === "transaction") {
          const [closure, ...rest] = args;
          return value.call(target, (txn) => closure(guardStorage(txn, refusal)), ...rest);
        }
        return value.apply(target, args);
      };
    },
  });
}

/** `ctx` with its `storage` guarded. Everything else is the context's own,
 * with methods bound to it. A storage object assigned later is guarded too. */
export function guardContext(ctx, refusal) {
  let raw;
  let guarded;
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "storage") {
        const storage = target.storage;
        if (storage !== raw) {
          raw = storage;
          guarded = storage && guardStorage(storage, refusal);
        }
        return guarded;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A Durable Object stub whose writes are refused the same way. Every
 * request but a GET writes: PageRecords takes its lease and its records by
 * POST. */
export function guardStub(stub, refusal) {
  return {
    fetch(input, init) {
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const error = method === "GET" ? undefined : refusal();
      return error ? Promise.reject(error) : stub.fetch(input, init);
    },
  };
}
