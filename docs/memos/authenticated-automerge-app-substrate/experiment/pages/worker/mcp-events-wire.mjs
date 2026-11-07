/** Internal wire primitives for OpenAI MCP Events, not an enabled endpoint.
 * https://developers.openai.com/plugins/build/mcp-events
 *
 * These helpers do not authorize filters, verify callbacks, store subscriptions,
 * or deliver events. URL parsing is NOT SSRF protection. A future transport must
 * validate DNS at connection time and pin the address with TLS hostname checks.
 */
const encoder = new TextEncoder();
const MAX_IDENTITY_BYTES = 16 * 1024;
export const MAX_WEBHOOK_BYTES = 256 * 1024;

function invalid() {
  // Never include callback URLs, signing secrets, arguments or principal data.
  throw new TypeError("Invalid MCP Events wire value");
}
function record(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function text(value, max = 1024) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    // Reject control bytes in URLs and header fields.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
  return value;
}
function exact(value, allowed, required) {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}

/** Canonical JSON for identity only. Reject values JSON.stringify would silently
 * omit/coerce. Bounds also cap recursion and repeated work on hostile inputs. */
function canonical(value) {
  let remaining = MAX_IDENTITY_BYTES;
  let bytesLeft = MAX_IDENTITY_BYTES;
  const spend = (serialized) => {
    bytesLeft -= encoder.encode(serialized).length;
    if (bytesLeft < 0) invalid();
    return serialized;
  };
  const seen = new Set();
  function visit(item, depth) {
    if (--remaining < 0 || depth > 16) invalid();
    if (typeof item === "string") {
      if (item.length > bytesLeft) invalid();
      return spend(JSON.stringify(item));
    }
    if (item === null || typeof item === "boolean") return spend(JSON.stringify(item));
    if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid();
      return spend(JSON.stringify(item));
    }
    if (typeof item !== "object" || seen.has(item)) invalid();
    seen.add(item);
    let result;
    if (Array.isArray(item)) {
      if (item.length > MAX_IDENTITY_BYTES || Object.keys(item).length !== item.length) invalid();
      spend("[]" + ",".repeat(Math.max(0, item.length - 1)));
      result = `[${Array.from(item, (entry) => visit(entry, depth + 1)).join(",")}]`;
    } else {
      if (!record(item)) invalid();
      const keys = Object.keys(item);
      if (keys.length > remaining) invalid();
      let keyBytes = 0;
      for (const key of keys) {
        if (key.length > MAX_IDENTITY_BYTES) invalid();
        keyBytes += encoder.encode(key).length;
        if (keyBytes > MAX_IDENTITY_BYTES) invalid();
      }
      spend("{}" + ",".repeat(Math.max(0, keys.length - 1)) + ":".repeat(keys.length));
      result = `{${keys
        .sort()
        .map((key) => `${spend(JSON.stringify(key))}:${visit(item[key], depth + 1)}`)
        .join(",")}}`;
    }
    seen.delete(item);
    return result;
  }
  return visit(value, 0);
}

/** Strict Standard Webhooks secret: canonical padded base64, 24–64 key bytes. */
export function webhookKey(secret) {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]{32,86}={0,2}$/.test(secret)) invalid();
  const encoded = secret.slice(6);
  let raw;
  try {
    raw = atob(encoded);
  } catch {
    invalid();
  }
  if (raw.length < 24 || raw.length > 64 || btoa(raw) !== encoded) invalid();
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/** Parse wire shape only. The host must validate name/arguments against its
 * advertised event schema and authorize the authenticated account separately.
 * Preserve the callback URL exactly for identity; do not normalize signed URLs.
 * No callback, including one accepted here, is safe to fetch without the pinned
 * public-address transport described above. */
export function parseWebhookSubscription(params, method = "subscribe") {
  if (method !== "subscribe" && method !== "unsubscribe") invalid();
  const subscribing = method === "subscribe";
  exact(
    params,
    subscribing
      ? ["name", "arguments", "delivery", "cursor", "ttlMs", "_meta"]
      : ["name", "arguments", "delivery", "_meta"],
    ["name", "arguments", "delivery"],
  );
  // MCP request metadata is accepted but cannot affect subscription identity.
  if (params._meta !== undefined) {
    if (!record(params._meta)) invalid();
    canonical(params._meta);
  }
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(text(params.name, 128))) invalid();
  if (!record(params.arguments)) invalid();
  // Parse the canonical representation to detach all retained caller objects.
  const args = JSON.parse(canonical(params.arguments));
  exact(
    params.delivery,
    subscribing ? ["mode", "url", "secret"] : ["mode", "url"],
    subscribing ? ["mode", "url", "secret"] : ["mode", "url"],
  );
  if (params.delivery.mode !== "webhook") invalid();
  const url = text(params.delivery.url, 4096);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    invalid();
  }
  if (
    !url.startsWith("https://") ||
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    url.includes("#") ||
    /\s|\\/u.test(url)
  )
    invalid();
  const delivery = { mode: "webhook", url };
  if (subscribing) {
    webhookKey(params.delivery.secret);
    delivery.secret = params.delivery.secret;
    // The first implementation has no replay. Never silently discard a cursor.
    if (params.cursor !== undefined && params.cursor !== null) invalid();
    if (
      params.ttlMs !== undefined &&
      params.ttlMs !== null &&
      (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0)
    )
      invalid();
  }
  return {
    name: params.name,
    arguments: args,
    delivery,
    ...(subscribing
      ? { cursor: null, ...(params.ttlMs === undefined ? {} : { ttlMs: params.ttlMs }) }
      : {}),
  };
}

/** Same principal, callback, event and canonical arguments => same ID. Secrets,
 * expiration and replay position never create a second subscription. The caller
 * must supply a trusted authenticated principal, never one from request params. */
export async function webhookSubscriptionId(principal, params) {
  text(principal, 1024);
  const identity = parseWebhookSubscription(
    {
      name: params?.name,
      arguments: params?.arguments,
      delivery: { mode: params?.delivery?.mode, url: params?.delivery?.url },
    },
    "unsubscribe",
  );
  // Arguments already have their own depth/byte bound. Do not spend it again
  // on the identity wrapper: every accepted boundary-sized filter must get an
  // ID. Fixed fields have separate length bounds; serialization stays bounded.
  // This is byte-identical to canonical JSON of the previous array envelope.
  const fields = ["pages-mcp-events-v1", principal, identity.delivery.url, identity.name];
  const envelope = `[${fields.map((value) => JSON.stringify(value)).join(",")},${canonical(identity.arguments)}]`;
  const bytes = encoder.encode(envelope);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sub_${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Finite leases only, with policy supplied by the future subscription owner.
 * null asks for indefinite retention; we instead grant the finite default.
 * A short requested lease is never silently increased. */
export function webhookRefreshBefore(ttlMs, { now, defaultTtlMs, maxTtlMs }) {
  for (const value of [now, defaultTtlMs, maxTtlMs])
    if (!Number.isSafeInteger(value) || value < 0) invalid();
  if (!defaultTtlMs || !maxTtlMs || defaultTtlMs > maxTtlMs) invalid();
  if (ttlMs !== undefined && ttlMs !== null && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0))
    invalid();
  const expires = now + Math.min(ttlMs ?? defaultTtlMs, maxTtlMs);
  if (!Number.isSafeInteger(expires) || expires > 8_640_000_000_000_000) invalid();
  return new Date(expires).toISOString();
}

// TextEncoder replaces unpaired surrogates. Refuse them rather than sign bytes
// different from the body a caller supplied. Avoid newer runtime-only APIs.
function wellFormed(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Sign already-serialized bytes once. Return that same body with its headers;
 * never stringify again at delivery. The owner supplies eventId as messageId,
 * or a fresh unique verification ID, and enforces any old-key rotation deadline.
 * No network access, challenge verification or retry is performed here. */
export async function signWebhookBody({
  subscriptionId,
  messageId,
  body,
  secret,
  previousSecret,
  signedAt,
}) {
  for (const id of [subscriptionId, messageId]) {
    text(id, 256);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) invalid();
  }
  if (
    typeof body !== "string" ||
    !body.length ||
    body.length > MAX_WEBHOOK_BYTES ||
    !wellFormed(body) ||
    encoder.encode(body).length > MAX_WEBHOOK_BYTES
  )
    invalid();
  if (!Number.isSafeInteger(signedAt) || signedAt < 0) invalid();
  const timestamp = String(Math.floor(signedAt / 1000));
  const content = encoder.encode(`${messageId}.${timestamp}.${body}`);
  const secrets =
    previousSecret === undefined || previousSecret === secret ? [secret] : [secret, previousSecret];
  // Validate all keys before performing crypto work.
  const keys = secrets.map(webhookKey);
  const signatures = [];
  for (const keyBytes of keys) {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, content));
    signatures.push(`v1,${btoa(String.fromCharCode(...signature))}`);
  }
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "webhook-id": messageId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signatures.join(" "),
      "X-MCP-Subscription-Id": subscriptionId,
    },
  };
}
