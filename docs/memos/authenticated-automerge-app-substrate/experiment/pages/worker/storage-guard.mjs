/**
 * A Durable Object's storage that refuses writes once its object is retired.
 *
 * After a runtime reset the old object keeps running: its boot, timers and
 * requests still hold the storage the new object reads
 * (scripts/celld-boot-probe.mjs). A Page host wraps its context once, in the
 * constructor, so every storage user it builds (the policy, plain sync, the
 * journal, content activity) shares one gate.
 * `refusal()` returns the error to refuse with, or nothing while writes are
 * allowed. Reads always pass, except through `sql.exec`.
 *
 * The SQLite APIs are gated too, though the Page uses neither: `kv.put` and
 * `kv.delete` throw, and so does every `sql.exec`, reads included, because a
 * statement's text can't be trusted to say whether it writes (one call can
 * run several statements).
 */

/** Durable Object storage takes at most 128 keys per put or delete call. */
export const STORAGE_KEYS_PER_CALL = 128;

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
/** `storage.kv` methods that write. They are synchronous, so they throw. */
export const KV_WRITES = Object.freeze(["put", "delete"]);

/** `target` with the synchronous methods named in `writes` throwing while
 * `refusal()` returns an error. Everything else passes, bound to `target`. */
function guardSync(target, writes, refusal) {
  return new Proxy(target, {
    get(object, prop) {
      const value = Reflect.get(object, prop, object);
      if (typeof value !== "function") return value;
      if (!writes.includes(prop)) return value.bind(object);
      return (...args) => {
        const error = refusal();
        if (error) throw error;
        return value.apply(object, args);
      };
    },
  });
}

/** `storage` with every write refused while `refusal()` returns an error. A
 * transaction's own storage is guarded too, so a write inside one that
 * started earlier is refused. The transaction rolls back only if the closure
 * lets that refusal propagate; a closure that catches it and returns commits
 * whatever it wrote before the gate closed. */
export function guardStorage(storage, refusal) {
  return new Proxy(storage, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "sql" && value) return guardSync(value, ["exec"], refusal);
      if (prop === "kv" && value) return guardSync(value, KV_WRITES, refusal);
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
