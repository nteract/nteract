/**
 * Revision handles: the short names agents use for one revision of one
 * document. `r<n>` names a Page document revision and `c<n>` a comments
 * document revision. Browsers, sync and host-to-host calls keep Automerge
 * heads; only the agent edge sees a handle.
 *
 * Each document's host keeps a counter and a table from handle number to
 * `{ heads, at }`, `at` being the host time it was minted:
 *
 *   host/revision/<doc>/counter    the last number minted
 *   host/revision/<doc>/latest     { n, heads, at } of that number
 *   host/revision/<doc>/h/<n>      { heads, at }, n zero-padded to 16 digits
 *
 * A number is never reissued for other heads. Minting writes all three keys
 * in one multi-key put, and a handle reaches a caller only after a sync
 * barrier, so a crash before the barrier forgets only a number nobody holds.
 * A write's handles go into the put that records its pending journal entry
 * (revisionPlan), so the receipt and its handles exist together.
 *
 * The table keeps the newest REVISION_LIMIT handles of a document; the
 * latest is never dropped. Callers serialize minting with the resource's
 * mutation queue.
 */
export const REVISION_LIMIT = 2000;
export const REVISION_PATTERN = /^[rc][1-9][0-9]{0,15}$/;
export const REVISION_DOCS = Object.freeze({ page: "r", comments: "c" });
const PREFIX = "host/revision/";
const counterKey = (doc) => `${PREFIX}${doc}/counter`;
const latestKey = (doc) => `${PREFIX}${doc}/latest`;
const recordPrefix = (doc) => `${PREFIX}${doc}/h/`;
export const revisionKey = (doc, n) => `${recordPrefix(doc)}${String(n).padStart(16, "0")}`;
/** Per storage: the latest number of each document known durable in this
 * isolate. A reused handle confirmed here needs no barrier of its own. */
const confirmed = new WeakMap();

function reject(status, code, message, details) {
  throw Object.assign(new Error(message), { status, code, ...(details && { details }) });
}
function letterOf(doc) {
  const letter = REVISION_DOCS[doc];
  if (!letter) throw new TypeError(`Unknown revision document ${doc}`);
  return letter;
}
export const formatRevision = (doc, n) => `${letterOf(doc)}${n}`;
const sameHeads = (left, right) =>
  left.length === right.length && [...left].sort().join() === [...right].sort().join();

/** The number a handle names for document `doc`, or a 400
 * `invalid_revision` for anything else, a handle with the other document's
 * letter included. */
export function parseRevision(value, doc, name = "revision") {
  const letter = letterOf(doc);
  if (typeof value !== "string" || !REVISION_PATTERN.test(value) || value[0] !== letter)
    reject(
      400,
      "invalid_revision",
      `${name} must be a ${letter}… revision from a read or receipt of this ${doc === "page" ? "Page" : "Page's comments"}`,
    );
  const n = Number(value.slice(1));
  if (!Number.isSafeInteger(n)) reject(400, "invalid_revision", `${name} is out of range`);
  return n;
}

/** The latest minted handle of `doc`: `{ n, heads, at }`, or undefined
 * before the first one. */
export function latestRevision(storage, doc) {
  letterOf(doc);
  return storage.get(latestKey(doc));
}

/** The stored record of handle number `n`: `{ heads, at }`, or undefined
 * when it was never minted or was pruned. */
export function revisionRecord(storage, doc, n) {
  return storage.get(revisionKey(doc, n));
}

/**
 * Handles minted for one put. `handle(doc, heads)` reuses the latest handle
 * when it names the same heads and otherwise takes the next number; `writes`
 * collects the keys to put, alone or beside a journal entry. After that put,
 * `settle()` runs the barrier the handles need and prunes old records.
 * `at` is the host time the handles record.
 */
export function revisionPlan(storage, at) {
  if (!Number.isSafeInteger(at) || at < 0) throw new TypeError("Invalid revision time");
  const docs = new Map();
  const writes = {};
  return {
    writes,
    async handle(doc, heads) {
      if (!Array.isArray(heads) || heads.some((head) => typeof head !== "string"))
        throw new TypeError("Revision heads must be a list of hashes");
      let state = docs.get(doc);
      if (!state) {
        const latest = await latestRevision(storage, doc);
        const counter = (await storage.get(counterKey(doc))) ?? 0;
        if (!Number.isSafeInteger(counter) || counter < 0)
          throw Error("Invalid stored revision counter");
        state = { latest, counter, minted: false };
        docs.set(doc, state);
      }
      if (state.latest && sameHeads(state.latest.heads, heads))
        return formatRevision(doc, state.latest.n);
      // The counter never moves back: a put that landed without a confirmed
      // barrier may already have spent a number.
      const n = Math.max(state.counter, state.latest?.n ?? 0) + 1;
      const record = { heads: [...heads], at };
      Object.assign(writes, {
        [counterKey(doc)]: n,
        [latestKey(doc)]: { n, ...record },
        [revisionKey(doc, n)]: record,
      });
      state.latest = { n, ...record };
      state.counter = n;
      state.minted = true;
      return formatRevision(doc, n);
    },
    /** Whether a handle from this plan still needs a sync barrier: one was
     * minted, or a reused one isn't known durable in this isolate. */
    needsBarrier() {
      return [...docs].some(
        ([doc, state]) =>
          state.latest && (state.minted || confirmed.get(storage)?.get(doc) !== state.latest.n),
      );
    },
    /** After the put and its barrier: note the handles durable and drop
     * records older than the newest REVISION_LIMIT. */
    async settle() {
      let known = confirmed.get(storage);
      if (!known) confirmed.set(storage, (known = new Map()));
      for (const [doc, state] of docs) {
        if (!state.latest) continue;
        known.set(doc, state.latest.n);
        if (state.minted) await prune(storage, doc, state.latest.n - REVISION_LIMIT);
      }
    },
  };
}

/** Delete records numbered at or below `cutoff`. Numbers are contiguous, so
 * one mint retires about one record; a short list also clears any that a
 * failed delete left behind. */
async function prune(storage, doc, cutoff) {
  if (cutoff < 1) return;
  const prefix = recordPrefix(doc);
  for (const [key] of await storage.list({ prefix, limit: 8 })) {
    if (Number(key.slice(prefix.length)) > cutoff) break;
    await storage.delete(key);
  }
}

/** The handles naming each `[doc, heads]` of `requests`, in order, minted
 * where the latest handle names other heads. New ones share one put and one
 * barrier. */
export async function revisionsFor(storage, requests, at = Date.now()) {
  const plan = revisionPlan(storage, at);
  const handles = [];
  for (const [doc, heads] of requests) handles.push(await plan.handle(doc, heads));
  if (Object.keys(plan.writes).length) await storage.put(plan.writes);
  if (plan.needsBarrier()) await storage.sync();
  await plan.settle();
  return handles;
}

/** The handle naming `heads` in `doc` (revisionsFor for one). */
export async function revisionFor(storage, doc, heads, at = Date.now()) {
  return (await revisionsFor(storage, [[doc, heads]], at))[0];
}

/** The heads a handle names, or a 409 `resync_required` when this host
 * never minted it or has pruned it. */
export async function headsFor(storage, doc, handle, name = "revision") {
  const n = parseRevision(handle, doc, name);
  const record = await revisionRecord(storage, doc, n);
  if (!record)
    reject(
      409,
      "resync_required",
      `${name} ${handle} is unknown or too old; read again and decide from what the document holds now`,
    );
  return [...record.heads];
}

/**
 * The fence for a new write against handle `handle` of `doc`, given the
 * journal's receipt horizon: a refusal unless the handle is the latest, or
 * the handle after it was minted after the horizon. Otherwise a receipt for
 * a write made against it may be gone, and a retry can't be told from a new
 * request. Returns the heads the handle names.
 */
export async function fencedHeads(storage, doc, handle, horizon, name = "revision") {
  const heads = await headsFor(storage, doc, handle, name);
  const n = parseRevision(handle, doc, name);
  const latest = await latestRevision(storage, doc);
  if (latest?.n === n) return heads;
  const next = await revisionRecord(storage, doc, n + 1);
  if (!next || next.at <= horizon)
    reject(
      409,
      "resync_required",
      `${name} ${handle} is older than the receipts this Page keeps; read again and decide from what the document holds now`,
    );
  return heads;
}
