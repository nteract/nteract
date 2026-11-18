/** A per-isolate memo of browser session reads, for `authenticate`
 * (auth.mjs).
 *
 * Every host a request crosses authenticates it again: the gateway, then the
 * Catalog, the Page host or the Project host. An open sync socket
 * re-authenticates every 15 seconds. Each of those reads the session row from
 * D1. This module answers repeats of one read from memory for a short time.
 *
 * The browser cookie holds an opaque 43-character token, not a signed value.
 * The session store derives the row's id from it with an HMAC under each key
 * in the session keyring (`serverSessionIds` in oidc-session-store.ts). An
 * entry is keyed by those ids and the deployment's session context (issuer,
 * client and public origin), never by the cookie string. A token of the wrong
 * shape, or one with no row, is never stored, so it can't produce a hit. A
 * changed keyring changes the ids, and with them the key.
 *
 * - Only a settled, successful read of a live session is stored: never a
 *   missing, expired or revoked one, never a failed read, and never a
 *   promise. Two concurrent misses both read D1.
 * - An entry answers for `SESSION_MEMO_MS` from its read, or until the
 *   session's own `expiresAt`, whichever is first. Every session writer sets
 *   `expiresAt` no later than the row's access, idle and absolute expiries.
 * - The entry holds the session as JSON and a hit parses it again, as the
 *   store does with `session_json`. A caller gets its own object, and no
 *   caller can change what another one reads.
 * - Ending or renewing a session in this isolate forgets it:
 *   `forgetServerAppSession` for the request's cookie (sign-out, status
 *   renewal), `forgetPrincipalSessions` for an account (sign out everywhere).
 *   A read that was in flight when a forget ran is not stored. Other isolates
 *   keep accepting a session for at most `SESSION_MEMO_MS` after it ends.
 * - A read never writes. Renewal (touch and refresh) happens only in
 *   `serverOidcSessionStatus`, which reads D1 itself, so the memo can't hide
 *   a renewal that is due.
 * - At most `MAX_REMEMBERED` entries per D1 binding, oldest first out.
 *   Entries expire when read; there is no timer.
 *
 * OAuth access tokens, API keys and Kilo tokens are not memoized here. */
import {
  cookieValue,
  readServerAppSession,
  SERVER_SESSION_COOKIE,
  serverSessionContext,
  serverSessionIds,
} from "@nteract/session";

/** How long one read answers for in this isolate. Not configurable. */
export const SESSION_MEMO_MS = 10_000;
/** How many sessions one isolate remembers per D1 binding. */
export const MAX_REMEMBERED = 1000;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** D1 binding -> { entries, forgets }. `entries` maps a key to
 * `{ json, principal, until }`, oldest first. `forgets` counts forget calls,
 * so a read that overlapped one is not stored. */
const memos = new WeakMap();

function memoFor(db) {
  let memo = memos.get(db);
  if (!memo) {
    memo = { entries: new Map(), forgets: 0 };
    memos.set(db, memo);
  }
  return memo;
}

/** The entry key for this request's cookie, or null when it has no
 * well-formed session token. Throws when the deployment has no keyring. */
async function memoKey(env, request) {
  const token = cookieValue(request, SERVER_SESSION_COOKIE);
  if (!token || !TOKEN.test(token)) return null;
  const origin = env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin;
  const context = serverSessionContext(env, new URL(origin).origin);
  return JSON.stringify([context, await serverSessionIds(env, token)]);
}

/**
 * `readServerAppSession` for this request's cookie, answered from this
 * isolate's memo when a read of the same session settled less than
 * `SESSION_MEMO_MS` ago and the session hasn't expired. `nowMs` is the
 * caller's clock in milliseconds.
 */
export async function rememberedServerAppSession(env, request, nowMs = Date.now()) {
  const nowSeconds = Math.floor(nowMs / 1000);
  let key = null;
  try {
    if (env.DB) key = await memoKey(env, request);
  } catch {
    // The store reports a missing keyring itself, with its own error.
  }
  if (key === null) return readServerAppSession(env, request, nowSeconds);
  const memo = memoFor(env.DB);
  const entry = memo.entries.get(key);
  if (entry) {
    if (nowMs < entry.until) return JSON.parse(entry.json);
    memo.entries.delete(key);
  }
  const forgets = memo.forgets;
  const session = await readServerAppSession(env, request, nowSeconds);
  const until = Math.min(nowMs + SESSION_MEMO_MS, (session?.expiresAt ?? 0) * 1000);
  if (session && memo.forgets === forgets && nowMs < until) {
    memo.entries.delete(key);
    memo.entries.set(key, {
      json: JSON.stringify(session),
      principal: session.principal,
      until,
    });
    while (memo.entries.size > MAX_REMEMBERED)
      memo.entries.delete(memo.entries.keys().next().value);
  }
  return session;
}

/** Forgets this request's cookie session in this isolate. Never throws: if
 * the key can't be derived, it forgets every session of this D1 binding. */
export async function forgetServerAppSession(env, request) {
  if (!env.DB) return;
  const memo = memoFor(env.DB);
  memo.forgets++;
  let key;
  try {
    key = await memoKey(env, request);
  } catch {
    memo.entries.clear();
    return;
  }
  if (key !== null) memo.entries.delete(key);
}

/** Forgets every session `principal` holds in this isolate. */
export function forgetPrincipalSessions(env, principal) {
  if (!env.DB) return;
  const memo = memoFor(env.DB);
  memo.forgets++;
  for (const [key, entry] of memo.entries)
    if (entry.principal === principal) memo.entries.delete(key);
}
