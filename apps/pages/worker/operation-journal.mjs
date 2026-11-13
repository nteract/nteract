/** One receipt lane per journal, bounded by time and capacity. Forgetting a
 * completed receipt is allowed; running an uncertain request again on the
 * strength of a forgotten one is not, so the journal keeps a horizon. Caller
 * serializes these helpers with its resource's mutation queue and persists
 * the returned entry before applying its side effect. Pending entries are
 * never collected.
 *
 * An entry moves absent → pending (persisted) → applied → completed; a retry
 * or restart resumes from the persisted state. Every client receipt carries
 * `recordedAt` from the host's journal time (journalTime). Collection deletes completed
 * receipts older than RECEIPT_LIFETIME_MS, and at capacity reserving evicts
 * the oldest completed receipts; only pending entries can make it refuse.
 *
 * The horizon (`host/receipt-horizon`) is the largest `recordedAt` of any
 * receipt this journal deleted, and never less than the clock minus
 * RECEIPT_LIFETIME_MS (receiptHorizon). It is made durable before the
 * deletes it covers. A write that names a revision handle minted at or before
 * the horizon may have a forgotten receipt, so its host refuses it
 * (`resync_required`) rather than guess whether it is a retry; that holds
 * whether or not the write moves the document it names (revisions.mjs).
 */
import { validNonce } from "../model/nonce.mjs";
import { latestRevision, REVISION_DOCS, revisionsFor } from "./revisions.mjs";

export const RECEIPT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const JOURNAL_LIMITS = Object.freeze({
  entries: 1000,
  bytes: 8 * 1024 * 1024,
  pendingEntries: 64,
  pendingBytes: 4 * 1024 * 1024,
});
const PREFIX = "host/operation/";
/** The host's own writes. A client key can't reach it: client keys hold only
 * letters, digits, `_` and `-`, never `:`. Its entries count against neither
 * the client lane nor the client pending budget. */
export const INTERNAL_PREFIX = `${PREFIX}internal:`;
export const INTERNAL_LIMITS = Object.freeze({ pendingEntries: 4 });
const isInternal = (key) => key.startsWith(INTERNAL_PREFIX);
const SECRET = "host/retry-secret-v1";
export const HORIZON = "host/receipt-horizon";
const LANE = /^[a-z][a-z0-9-]{0,31}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const durableSigningKeys = new WeakMap();

function reject(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}
export { validNonce };

/** The receipt key of a client write: `host/operation/n1_<first 32 hex of
 * SHA-256 of the principal>_<lane>_<nonce>`. The host derives the account
 * part from the authenticated request; a caller sends only its nonce. */
export async function receiptKey({ principal, lane, nonce }, prefix = PREFIX) {
  if (typeof principal !== "string" || !principal.length || principal.length > 1024)
    throw new TypeError("An authenticated principal is required");
  if (!LANE.test(lane ?? "")) throw new TypeError("Invalid receipt lane");
  if (!validNonce(nonce))
    reject(
      400,
      "invalid_nonce",
      "nonce must be 6–64 letters, digits, underscores or hyphens, new for each request",
    );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(principal)));
  // Text, built byte by byte: a typed array's own map() would coerce each
  // hex pair back into a byte.
  let account = "";
  for (const byte of digest.subarray(0, 16)) account += byte.toString(16).padStart(2, "0");
  return `${prefix}n1_${account}_${lane}_${nonce}`;
}

function encode(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw Error("Invalid token encoding");
  const result = Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  if (encode(result) !== text) throw Error("Noncanonical token encoding");
  return result;
}
async function signingKey(storage, create) {
  let bytes = await storage.get(SECRET);
  if (!bytes && create) {
    bytes = crypto.getRandomValues(new Uint8Array(32));
    await storage.put(SECRET, bytes);
  }
  if (!bytes && !create) return null;
  if (!bytes || bytes.byteLength !== 32) throw Error("Capability signing key is unavailable");
  const cached = durableSigningKeys.get(storage);
  if (cached && cached.bytes.every((byte, index) => byte === bytes[index])) return cached.key;
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  if (create) {
    // Cache only a confirmed barrier. A failed first signing retries this
    // sync; warm verifications need no metadata writes or sync calls.
    await storage.sync();
    durableSigningKeys.set(storage, { bytes: new Uint8Array(bytes), key });
  }
  return key;
}
/** The host's journal time: the wall clock, never below the receipt horizon
 * or the time of either document's latest revision handle. Those floors are
 * durable, so the time a receipt or handle records never runs back behind
 * one recorded before it, across a restart or a clock stepped backwards, and
 * keeping the time writes nothing. Receipts and handles take their times
 * from here. */
export async function journalTime(storage, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid journal clock");
  const horizon = (await storage.get(HORIZON)) ?? 0;
  if (!Number.isSafeInteger(horizon)) throw Error("Invalid stored receipt horizon");
  let current = Math.max(now, horizon);
  for (const doc of Object.keys(REVISION_DOCS))
    current = Math.max(current, (await latestRevision(storage, doc))?.at ?? 0);
  return current;
}
/** The journal time and receipt horizon a revision plan or fence uses
 * (revisions.mjs): handles are minted after `horizon`, and a write naming
 * one minted at or before it is refused. */
export async function revisionClock(storage, now = Date.now()) {
  const at = await journalTime(storage, now);
  return { at, horizon: await receiptHorizon(storage, at) };
}
/** The handles a read names for each `[doc, heads]` of `requests`, minted
 * in one put when needed: never one at or before the receipt horizon, so the
 * fence never refuses a write that names a handle a read just returned. */
export async function readRevisions(storage, requests, now = Date.now()) {
  const { at, horizon } = await revisionClock(storage, now);
  return revisionsFor(storage, requests, at, horizon);
}
/** readRevisions for one document. */
export async function readRevision(storage, doc, heads, now = Date.now()) {
  return (await readRevisions(storage, [[doc, heads]], now))[0];
}
/** The time at or before which this journal may have forgotten a receipt:
 * the stored horizon, or `now` minus the receipt lifetime when later. */
export async function receiptHorizon(storage, now) {
  const stored = (await storage.get(HORIZON)) ?? 0;
  if (!Number.isSafeInteger(stored)) throw Error("Invalid stored receipt horizon");
  return Math.max(stored, now - RECEIPT_LIFETIME_MS);
}
/** Raise the horizon to `newest`, the latest time of a receipt about to be
 * forgotten, and make it durable. Every store of client receipts on this
 * object calls it before it deletes any: the journal (forget) and a Page's
 * lifecycle receipts. */
export async function raiseHorizon(storage, newest, now = Date.now()) {
  await storage.put(HORIZON, Math.max(await receiptHorizon(storage, now), newest));
  await storage.sync();
}
/** Delete completed receipts `entries`, raising the horizon to the newest of
 * them first. The horizon is durable before any delete is. */
async function forget(storage, entries, now) {
  if (!entries.length) return;
  await raiseHorizon(storage, Math.max(...entries.map(([, value]) => value.recordedAt ?? 0)), now);
  for (const [key] of entries) await storage.delete(key);
}

export async function listOperationEntries(storage) {
  const result = new Map();
  let startAfter;
  do {
    const page = await storage.list({
      prefix: PREFIX,
      limit: 128,
      ...(startAfter && { startAfter }),
    });
    for (const [key, value] of page) result.set(key, value);
    const next = page.size === 128 ? [...page.keys()].at(-1) : undefined;
    if (next && next === startAfter) throw Error("Invalid operation journal cursor");
    startAfter = next;
  } while (startAfter);
  return result;
}
/** Remove completed client receipts past their lifetime. A receipt without
 * `recordedAt` counts as the oldest. */
async function collect(storage, now) {
  const values = await listOperationEntries(storage);
  const expired = [...values].filter(
    ([key, value]) =>
      !isInternal(key) &&
      value.pending === false &&
      (value.recordedAt ?? -1) <= now - RECEIPT_LIFETIME_MS,
  );
  await forget(storage, expired, now);
  for (const [key] of expired) values.delete(key);
  return values;
}

/**
 * A short-lived host capability, signed with this resource's key:
 * `<prefix>.<payload>.<signature>`, base64url. Its MAC covers
 * `<purpose>\n<payload JSON>` and the payload repeats `purpose`, so two
 * purposes never stand in for each other. Expiry and binding belong to the
 * caller's own check.
 */
export async function signCapability(storage, { purpose, prefix, payload }) {
  if (!validPurpose(purpose) || !/^[a-z0-9]{1,16}$/.test(prefix))
    throw new TypeError("A capability needs a purpose and a token prefix");
  const key = await signingKey(storage, true);
  const bytes = encoder.encode(JSON.stringify({ ...payload, purpose }));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, capabilityInput(purpose, bytes)),
  );
  return `${prefix}.${encode(bytes)}.${encode(signature)}`;
}

/** The payload of a capability this resource signed for `purpose`, or null
 * for anything else: another purpose or prefix, a forged or truncated token,
 * or a resource that has never signed one. A storage failure throws: it is a
 * service failure, not a verdict on the token. */
export async function openCapability(storage, token, { purpose, prefix }) {
  if (!validPurpose(purpose)) throw new TypeError("A capability needs a purpose");
  let bytes, signature, payload;
  try {
    if (typeof token !== "string" || token.length > 4096) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== prefix) return null;
    bytes = decode(parts[1]);
    signature = decode(parts[2]);
  } catch {
    return null;
  }
  const key = await signingKey(storage, false);
  if (
    !key ||
    !(await crypto.subtle.verify("HMAC", key, signature, capabilityInput(purpose, bytes)))
  )
    return null;
  try {
    payload = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  return payload && typeof payload === "object" && payload.purpose === purpose ? payload : null;
}

const validPurpose = (purpose) =>
  typeof purpose === "string" && /^[a-z][a-z0-9-]{2,63}$/.test(purpose);
function capabilityInput(purpose, bytes) {
  const label = encoder.encode(`${purpose}\n`);
  const input = new Uint8Array(label.byteLength + bytes.byteLength);
  input.set(label);
  input.set(bytes, label.byteLength);
  return input;
}

/** The entry stored under `key`, checked against this request's digest: the
 * same key with another digest is `nonce_conflict`. */
export async function inspectOperation(storage, { key, digest, legacyDigest, pendingEntry }) {
  const stored = await storage.get(key);
  // Only the internal admission owner may supply its exact retained pending
  // intent after a failed journal put. This is not a caller-controlled fallback.
  if (!stored && pendingEntry !== undefined && pendingEntry.pending !== true)
    throw new TypeError("Only a trusted pending admission may resume without a journal row");
  const entry = stored ?? pendingEntry;
  // `legacyDigest` matches only an entry that records no writer: one
  // journaled before its request's fingerprint covered the writer's agent.
  if (
    entry &&
    entry.fingerprint !== digest &&
    !(legacyDigest && entry.writer === undefined && entry.fingerprint === legacyDigest)
  )
    reject(409, "nonce_conflict", "This nonce was used for a different request");
  return { entry };
}

/** Conservative structured-clone estimate; binary histories are charged by
 * bytes, not their potentially much larger JSON representation. */
export function operationEntryBytes(key, entry) {
  const size = (value) => {
    if (value === null || value === undefined) return 16;
    if (typeof value === "string") return encoder.encode(value).byteLength + 32;
    if (typeof value === "number" || typeof value === "boolean") return 16;
    if (ArrayBuffer.isView(value)) return value.byteLength + 64;
    if (value instanceof ArrayBuffer) return value.byteLength + 64;
    if (Array.isArray(value)) return 64 + value.reduce((sum, child) => sum + size(child), 0);
    if (typeof value === "object")
      return (
        128 +
        Object.entries(value).reduce((sum, [name, child]) => sum + size(name) + size(child), 0)
      );
    throw new TypeError("Invalid operation journal value");
  };
  return size(key) + size(entry);
}

/** Checks headroom for an immutable intent and stamps its `recordedAt` with
 * the journal clock. The caller durably installs the returned entry under
 * its serialized mutation queue before any side effect. */
export async function reserveOperation(storage, { key, entry, now = Date.now() }) {
  if (!key.startsWith(PREFIX) || entry.pending !== true)
    throw new TypeError("Only new pending operation entries can reserve capacity");
  const current = await journalTime(storage, now);
  const values = await collect(storage, current);
  if (values.has(key))
    throw Error("Operation already exists; inspect it before reserving capacity");
  if (isInternal(key)) {
    // A finished migration's receipt is never read again: its key names the
    // heads it converted, which the document has moved past. Drop them.
    for (const [name, value] of values)
      if (isInternal(name) && value.pending === false) await storage.delete(name);
    const pendingInternal = [...values].filter(
      ([name, value]) => isInternal(name) && value.pending === true,
    );
    if (pendingInternal.length >= INTERNAL_LIMITS.pendingEntries)
      reject(429, "pending_operation_capacity", "Pending host migrations need recovery first");
    return { ...entry };
  }
  const prepared = { ...entry, recordedAt: current };
  const lane = [...values].filter(([name]) => !isInternal(name));
  const pending = lane.filter(([, value]) => value.pending === true);
  const bytes = operationEntryBytes(key, prepared);
  if (
    pending.length >= JOURNAL_LIMITS.pendingEntries ||
    pending.reduce((sum, [name, value]) => sum + operationEntryBytes(name, value), bytes) >
      JOURNAL_LIMITS.pendingBytes
  )
    reject(
      429,
      "pending_operation_capacity",
      "Pending operations need recovery before accepting more edits",
    );
  // Each receipt is sized once; eviction keeps the running totals.
  const sizes = new Map(lane.map(([name, value]) => [name, operationEntryBytes(name, value)]));
  let laneEntries = lane.length,
    laneBytes = bytes;
  for (const size of sizes.values()) laneBytes += size;
  const full = () => laneEntries >= JOURNAL_LIMITS.entries || laneBytes > JOURNAL_LIMITS.bytes;
  if (full()) {
    const evictable = lane
      .filter(([, value]) => value.pending === false)
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          (left.recordedAt ?? -1) - (right.recordedAt ?? -1) ||
          (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0),
      );
    const evicted = [];
    for (let next = 0; full() && next < evictable.length; next++) {
      evicted.push(evictable[next]);
      laneEntries--;
      laneBytes -= sizes.get(evictable[next][0]);
    }
    await forget(storage, evicted, current);
  }
  if (full())
    reject(
      429,
      "operation_receipt_capacity",
      "Pending operations fill the receipt journal; finish or recover them before new requests",
    );
  return prepared;
}
