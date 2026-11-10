/**
 * Stored counts of a Catalog's `page/` and `trash/` keys.
 *
 * `host/count/active` and `host/count/trash` equal the number of keys under
 * `page/` and `trash/`. Pending creations and Trash or restore reservations
 * are keys too, so the counts are at least what countCapacity counts;
 * capacityFor (catalog.mjs) relies on that.
 *
 * Every write that adds or removes such a key runs in one storage transaction
 * that reads the key's existence and the stored counts and writes the entry
 * with the new counts. Counted writes run one at a time per object: each waits
 * for the previous one to commit or roll back, so two writes never derive
 * counts from the same stored value. A caller's own transaction holds that turn
 * for its whole run, and the writes inside it join it.
 *
 * Memory holds the counts only as a cache, through the countCache machine. It
 * takes a committed value only after its transaction resolves, so a rolled-back
 * or retried transaction never leaves a count it computed. A failed write marks
 * the cache invalid and the next read loads storage.
 *
 * Until the counts are first stored (capacityFor or verifyCounts does that),
 * writes leave them absent. A build without this wrapper writes keys without
 * counts; verifyCounts, which every Page listing runs, repairs that.
 */
import { listAll } from "./catalog.mjs";
import { holdUntilSettled } from "./request-hold.mjs";

/** Where each counted prefix keeps its count. */
export const COUNT_KEYS = Object.freeze({
  "page/": "host/count/active",
  "trash/": "host/count/trash",
});
const COUNTED = Object.keys(COUNT_KEYS);
const countedPrefix = (key) =>
  typeof key === "string" ? COUNTED.find((prefix) => key.startsWith(prefix)) : undefined;
const countEntries = (counts) =>
  Object.fromEntries(COUNTED.map((prefix) => [COUNT_KEYS[prefix], counts[prefix]]));
const sameCounts = (a, b) =>
  a === b || (!!a && !!b && COUNTED.every((prefix) => a[prefix] === b[prefix]));

/**
 * The count cache's states:
 *
 * - `unloaded`: nothing read yet.
 * - `loaded`: `counts` equals storage; null means storage holds no counts.
 * - `writing`: a counted write holds the turn; `prior` is the state before it.
 * - `invalid`: a write failed, so storage may hold either value.
 *
 * Events: `read` (counts read from storage), `begin` (a write takes the
 * turn), `commit` (its transaction resolved; `counts` is what it stored, or
 * undefined when it wrote none) and `fail`. Returns `{ state }`, or
 * `{ state, rejected }` with the state unchanged.
 */
export function countCache(state, event) {
  const reject = (rejected) => ({ state, rejected });
  switch (event.type) {
    case "read":
      if (state.name === "writing") return reject("a write holds the turn");
      return { state: { name: "loaded", counts: event.counts } };
    case "begin":
      if (state.name === "writing") return reject("a write already holds the turn");
      return { state: { name: "writing", prior: state } };
    case "commit":
      if (state.name !== "writing") return reject("no write holds the turn");
      return {
        state:
          event.counts !== undefined
            ? { name: "loaded", counts: event.counts }
            : state.prior.name === "loaded"
              ? state.prior
              : { name: "unloaded" },
      };
    case "fail":
      if (state.name !== "writing") return reject("no write holds the turn");
      return { state: { name: "invalid" } };
    default:
      return reject("unknown event");
  }
}

async function readCounts(storage) {
  const active = await storage.get(COUNT_KEYS["page/"]);
  const trash = await storage.get(COUNT_KEYS["trash/"]);
  return Number.isSafeInteger(active) && Number.isSafeInteger(trash)
    ? { "page/": active, "trash/": trash }
    : null;
}

/**
 * Counted writes against one transaction (or plain storage). `tally.counts`
 * is what the transaction has stored so far: undefined until it reads them,
 * null when storage holds none. Writes inside one transaction also run in
 * turn, so their reads and the tally agree.
 */
function transactionWriter(target, tally) {
  let turn = Promise.resolve();
  const inTurn = (work) => {
    const run = turn.then(work);
    turn = run.catch(() => {});
    return run;
  };
  const delta = async (keys, adding) => {
    const change = { "page/": 0, "trash/": 0 };
    let changed = false;
    for (const key of new Set(keys)) {
      const prefix = countedPrefix(key);
      if (!prefix || ((await target.get(key)) !== undefined) === adding) continue;
      change[prefix] += adding ? 1 : -1;
      changed = true;
    }
    return changed ? change : null;
  };
  const next = async (change) => {
    if (tally.counts === undefined) tally.counts = await readCounts(target);
    if (!change || !tally.counts) return null;
    tally.counts = Object.fromEntries(
      COUNTED.map((prefix) => [prefix, Math.max(0, tally.counts[prefix] + change[prefix])]),
    );
    return countEntries(tally.counts);
  };
  return {
    put: (keyOrEntries, valueOrOptions, options) =>
      inTurn(async () => {
        const single = typeof keyOrEntries === "string";
        const keys = single ? [keyOrEntries] : Object.keys(keyOrEntries);
        const counts = keys.some(countedPrefix) ? await next(await delta(keys, true)) : null;
        if (!counts) return target.put(keyOrEntries, valueOrOptions, options);
        const entries = single ? { [keyOrEntries]: valueOrOptions } : { ...keyOrEntries };
        return target.put({ ...entries, ...counts }, single ? options : valueOrOptions);
      }),
    delete: (keyOrKeys, options) =>
      inTurn(async () => {
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        const counts = keys.some(countedPrefix) ? await next(await delta(keys, false)) : null;
        // Issued in one step, so storage without transactions still batches
        // them.
        const [result] = await Promise.all([
          target.delete(keyOrKeys, options),
          counts && target.put(counts),
        ]);
        return result;
      }),
    /** Store `counts` as given. */
    store: (counts) =>
      inTurn(async () => {
        await target.put(countEntries(counts));
        tally.counts = { ...counts };
      }),
  };
}

/** `storage` with its own methods, plus `overrides`. */
function overlay(storage, overrides) {
  return new Proxy(storage, {
    get(target, name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The Catalog's storage, keeping the stored counts. `ctx` is the object's
 * state: each counted write holds the request open until it settles
 * (request-hold.mjs), so a caller that goes away can't strand the turn.
 */
export function countedStorage(storage, { ctx } = {}) {
  let cache = { name: "unloaded" };
  let turn = Promise.resolve();
  const step = (event) => {
    const result = countCache(cache, event);
    if (result.rejected) throw new Error(`Count cache: ${result.rejected}`);
    cache = result.state;
  };
  const inTurn = (work) => {
    const run = turn.then(work);
    turn = run.catch(() => {});
    holdUntilSettled(ctx, run);
    return run;
  };
  const transact = (work) =>
    typeof storage.transaction === "function" ? storage.transaction(work) : work(storage);
  /** Run `work(writer, target)` as one counted write. */
  const write = (work) =>
    inTurn(async () => {
      step({ type: "begin" });
      let tally;
      try {
        const result = await transact((target) => {
          // A transaction that retries runs this again from a fresh tally.
          tally = {};
          return work(transactionWriter(target, tally), target);
        });
        step({ type: "commit", counts: tally.counts });
        return result;
      } catch (error) {
        step({ type: "fail" });
        throw error;
      }
    });
  const counts = () =>
    inTurn(async () => {
      if (cache.name !== "loaded") step({ type: "read", counts: await readCounts(storage) });
      return cache.counts && { ...cache.counts };
    });
  const overrides = {
    put: (keyOrEntries, valueOrOptions, options) => {
      const keys = typeof keyOrEntries === "string" ? [keyOrEntries] : Object.keys(keyOrEntries);
      if (!keys.some(countedPrefix)) return storage.put(keyOrEntries, valueOrOptions, options);
      return write((writer) => writer.put(keyOrEntries, valueOrOptions, options));
    },
    delete: (keyOrKeys, options) => {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      if (!keys.some(countedPrefix)) return storage.delete(keyOrKeys, options);
      return write((writer) => writer.delete(keyOrKeys, options));
    },
    /** The stored counts, or null before they are first stored. */
    counts,
    /** Count every key under both prefixes and store the result. */
    rebuildCounts: () =>
      write(async (writer, target) => {
        const counted = {
          "page/": (await listAll(target, "page/")).size,
          "trash/": (await listAll(target, "trash/")).size,
        };
        await writer.store(counted);
        return counted;
      }),
    /** Store `scanned`, counts read by a full scan, if they differ from the
     * stored ones. Returns true when stored counts existed and disagreed. A
     * count written between the scan and this turn is overwritten by the
     * scan, so callers scan inside the Catalog's serial queue. */
    verifyCounts: (scanned) =>
      write(async (writer, target) => {
        const stored = await readCounts(target);
        if (sameCounts(stored, scanned)) return false;
        await writer.store(scanned);
        return stored !== null;
      }),
    ...(typeof storage.transaction === "function" && {
      transaction: (run) =>
        write((writer, target) => {
          const joined = overlay(target, {
            put: writer.put,
            delete: writer.delete,
            transaction: (inner) => inner(joined),
          });
          return run(joined);
        }),
    }),
  };
  return overlay(storage, overrides);
}
