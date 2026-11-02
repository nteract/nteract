import { retryKeyPrefix } from "../model/retry-key.mjs";

/** Bounded, explicitly expiring retries. Expiration is authority to forget a
 * completed receipt, never authority to run an uncertain request again. Caller
 * serializes these helpers with its resource's mutation queue and persists the
 * returned entry before applying its side effect. Pending entries never expire.
 *
 * Receipts sit in two lanes, each bounded by JOURNAL_LIMITS. A call with a
 * retry token holds its receipt for the token's seven-day window: an exact
 * retry replays it, and a full lane refuses new work until collection frees
 * expired receipts. A call without a token has no window, so its receipt
 * can't expire; it serves only to replay an exact repeat of the same key,
 * normally a client retrying a lost response moments later. That lane keeps
 * the newest receipts instead: at capacity, reserving a new entry evicts the
 * oldest completed tokenless receipts to make room, so a Page that takes
 * thousands of tokenless comments never turns read-only. A key whose receipt
 * was evicted is a new request again.
 */
export const RETRY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const JOURNAL_LIMITS = Object.freeze({
  entries: 1000,
  bytes: 8 * 1024 * 1024,
  pendingEntries: 64,
  pendingBytes: 4 * 1024 * 1024,
});
const PREFIX = "host/operation/";
/** The host's own migrations, such as the preserved-block conversion. A
 * client key can't reach it: client keys hold only letters, digits, `_` and
 * `-`, never `:`. Its entries count against neither client lane nor the
 * client pending budget, so a full legacy receipt store can't block them. */
export const INTERNAL_PREFIX = `${PREFIX}internal:`;
export const INTERNAL_LIMITS = Object.freeze({ pendingEntries: 4 });
const isInternal = (key) => key.startsWith(INTERNAL_PREFIX);
const SECRET = "host/retry-secret-v1";
const CLOCK = "host/retry-clock-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const durableSigningKeys = new WeakMap();

function reject(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}
function validContext(scope, principal) {
  if (
    typeof scope !== "string" ||
    !scope.length ||
    scope.length > 1024 ||
    typeof principal !== "string" ||
    !principal.length ||
    principal.length > 1024
  )
    throw new TypeError("A resource scope and authenticated principal are required");
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
  if (!bytes || bytes.byteLength !== 32) throw Error("Retry signing key is unavailable");
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
    // Cache only a confirmed barrier. A failed first issue retries this sync;
    // warm pure reads need no metadata writes, journal scans, or sync calls.
    await storage.sync();
    durableSigningKeys.set(storage, { bytes: new Uint8Array(bytes), key });
  }
  return key;
}
async function readClock(storage, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid retry clock");
  const old = (await storage.get(CLOCK)) ?? 0;
  if (!Number.isSafeInteger(old) || old < 0) throw Error("Invalid stored retry clock");
  return { old, current: Math.max(old, now) };
}
async function clock(storage, now) {
  const { old, current } = await readClock(storage, now);
  if (current !== old) await storage.put(CLOCK, current);
  // Repeat even when unchanged: a previous put may have succeeded before a
  // failed sync. No terminal receipt is removed before this floor is durable.
  await storage.sync();
  return current;
}
function retryMetadata(payload, keyPrefix) {
  return {
    version: 1,
    scope: payload.scope,
    principal: payload.principal,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    keyPrefix,
  };
}
function isWindow(value) {
  return (
    value?.version === 1 &&
    typeof value.scope === "string" &&
    typeof value.principal === "string" &&
    Number.isSafeInteger(value.issuedAt) &&
    value.issuedAt >= 0 &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt - value.issuedAt === RETRY_LIFETIME_MS
  );
}
function isRetry(value) {
  return (
    isWindow(value) &&
    typeof value.keyPrefix === "string" &&
    /^v1_[a-f0-9]{64}_$/.test(value.keyPrefix)
  );
}
/** Where a caller gets the retry_token a v1_ key is built from. */
const WHERE_TOKENS =
  "send the retry_token from the same result as retry_key_prefix (read_page for edits; list_pages for create_page, delete, restore and purge; list_projects for create_project), or use a plain key of 8–128 characters without a token";
function checkRetryKey(key, retry) {
  const prefix = `${PREFIX}${retry.keyPrefix}`;
  if (!key.startsWith(prefix) || !/^[A-Za-z0-9_-]{8,60}$/.test(key.slice(prefix.length)))
    reject(
      400,
      "invalid_retry_token",
      "Use retry_key_prefix plus a unique nonce; a replacement token cannot reuse an old idempotency_key",
    );
}

async function verify(storage, token, scope, principal) {
  validContext(scope, principal);
  let bytes, signature, payload;
  try {
    if (typeof token !== "string" || token.length > 8192) throw Error("Invalid token size");
    const parts = token.split(".");
    if (parts.length !== 2) throw Error("Invalid token");
    bytes = decode(parts[0]);
    signature = decode(parts[1]);
    payload = JSON.parse(decoder.decode(bytes));
    if (!isWindow(payload) || payload.scope !== scope || payload.principal !== principal)
      throw Error("Invalid retry scope or time");
  } catch {
    reject(
      400,
      "invalid_retry_token",
      "Use the retry_token from a fresh read_page or list_pages result",
    );
  }
  // Storage failures are service failures, not malformed credentials.
  const key = await signingKey(storage, false);
  if (!key || !(await crypto.subtle.verify("HMAC", key, signature, bytes)))
    reject(
      400,
      "invalid_retry_token",
      "Use the retry_token from a fresh read_page or list_pages result",
    );
  return retryMetadata(payload, await retryKeyPrefix(token));
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
async function collect(storage, floor) {
  const values = await listOperationEntries(storage);
  for (const [key, value] of values) {
    if (value.retry !== undefined && !isRetry(value.retry))
      throw Error("Invalid operation retry metadata");
    if (value.pending === false && value.retry && value.retry.expiresAt <= floor) {
      await storage.delete(key);
      values.delete(key);
    }
  }
  return values;
}

export async function issueRetryToken(storage, { scope, principal, now = Date.now() }) {
  validContext(scope, principal);
  const key = await signingKey(storage, true);
  const { current: floor } = await readClock(storage, now);
  const payload = {
    version: 1,
    scope,
    principal,
    issuedAt: floor,
    expiresAt: floor + RETRY_LIFETIME_MS,
  };
  const bytes = encoder.encode(JSON.stringify(payload));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  const token = `${encode(bytes)}.${encode(signature)}`;
  return {
    retry_token: token,
    retry_key_prefix: await retryKeyPrefix(token),
    retry_until: new Date(payload.expiresAt).toISOString(),
  };
}

/** An expired, matching pending entry may still be resumed. Completed requests
 * past the durable deadline are always expired, even before their row is GC'd.
 */
export async function inspectOperation(
  storage,
  { key, digest, retryToken, pendingEntry, scope, principal, now = Date.now() },
) {
  const stored = await storage.get(key);
  // Only the internal admission owner may supply its exact retained pending
  // intent after a failed journal put. This is not a caller-controlled fallback.
  if (!stored && pendingEntry !== undefined && pendingEntry.pending !== true)
    throw new TypeError("Only a trusted pending admission may resume without a journal row");
  const entry = stored ?? pendingEntry;
  if (entry && entry.fingerprint !== digest)
    reject(409, "idempotency_conflict", "idempotency_key was used for a different request");
  const versionedKey = key.startsWith(`${PREFIX}v1_`);
  if (retryToken !== undefined && !versionedKey)
    reject(
      400,
      "invalid_retry_token",
      "Requests with retry_token require a v1_ idempotency_key: append a new UUID to the retry_key_prefix returned with that token",
    );
  if (retryToken === undefined) {
    // A forgotten token must not turn an expired versioned request into a fresh
    // legacy request. Existing pre-protocol v1_ receipts still replay exactly.
    if (versionedKey && !entry)
      reject(
        400,
        "invalid_retry_token",
        `v1_ idempotency keys require the original retry_token: ${WHERE_TOKENS}`,
      );
    if (entry?.retry) reject(400, "invalid_retry_token", "Retry the same token, key and payload");
    return { entry, retry: undefined };
  }
  const floor = await clock(storage, now);
  const retry = await verify(storage, retryToken, scope, principal);
  checkRetryKey(key, retry);
  if (
    entry &&
    (!isRetry(entry.retry) ||
      ["version", "scope", "principal", "issuedAt", "expiresAt", "keyPrefix"].some(
        (field) => entry.retry[field] !== retry[field],
      ))
  )
    reject(409, "idempotency_conflict", "idempotency_key was used for a different retry token");
  if (retry.expiresAt <= floor && !entry?.pending)
    reject(
      410,
      "retry_expired",
      "Retry window expired; outcome may be unknown. Read the Page or catalog to reconcile before making a new request. Do not retry with a replacement token.",
    );
  return { entry, retry };
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

/** Checks headroom for an immutable intent; the caller durably installs the
 * returned entry under its serialized mutation queue before any side effect. */
export async function reserveOperation(storage, { key, entry, retry, now = Date.now() }) {
  if (!key.startsWith(PREFIX) || entry.pending !== true)
    throw new TypeError("Only new pending operation entries can reserve capacity");
  if (retry !== undefined && !isRetry(retry)) throw new TypeError("Invalid retry metadata");
  if (retry) checkRetryKey(key, retry);
  if (key.startsWith(`${PREFIX}v1_`) !== Boolean(retry))
    reject(
      400,
      "invalid_retry_token",
      `A v1_ idempotency_key and retry_token must be used together: ${WHERE_TOKENS}`,
    );
  // Existing legacy clients need no retirement barrier until this resource has
  // issued versioned tokens. Floor zero retains every versioned entry even if
  // anomalous storage contains one without a clock; it never authorizes GC.
  const floor =
    retry === undefined && (await storage.get(CLOCK)) === undefined ? 0 : await clock(storage, now);
  if (retry && retry.expiresAt <= floor)
    reject(
      410,
      "retry_expired",
      "Retry window expired before admission; read again before making a new request",
    );
  const values = await collect(storage, floor);
  if (values.has(key))
    throw Error("Operation already exists; inspect it before reserving capacity");
  const prepared = { ...entry, ...(retry && { retry }) };
  if (isInternal(key)) {
    if (retry) throw new TypeError("Internal operations take no retry token");
    // A finished migration's receipt is never read again: its key names the
    // heads it converted, which the document has moved past. Drop them.
    for (const [name, value] of values)
      if (isInternal(name) && value.pending === false) await storage.delete(name);
    const pendingInternal = [...values].filter(
      ([name, value]) => isInternal(name) && value.pending === true,
    );
    if (pendingInternal.length >= INTERNAL_LIMITS.pendingEntries)
      reject(429, "pending_operation_capacity", "Pending host migrations need recovery first");
    return prepared;
  }
  // A tokenless receipt's age orders eviction; entries from builds before the
  // stamp sort oldest.
  if (!retry) prepared.recordedAt = now;
  const lane = [...values].filter(
    ([name, value]) => !isInternal(name) && Boolean(value.retry) === Boolean(retry),
  );
  const pending = [...values].filter(
    ([name, value]) => !isInternal(name) && value.pending === true,
  );
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
  if (!retry && full()) {
    const evictable = lane
      .filter(([, value]) => value.pending === false)
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          (left.recordedAt ?? -1) - (right.recordedAt ?? -1) ||
          (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0),
      );
    for (let next = 0; full() && next < evictable.length; next++) {
      const [name] = evictable[next];
      await storage.delete(name);
      laneEntries--;
      laneBytes -= sizes.get(name);
    }
  }
  if (full())
    reject(
      429,
      "operation_receipt_capacity",
      retry
        ? "The active retry window is full; retry later with the same token, key and payload"
        : "Pending operations fill the receipt journal; finish or recover them before new requests",
    );
  return prepared;
}
