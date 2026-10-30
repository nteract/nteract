import { oidcDatabase } from "@cloud/oidc-session-store.ts";
import { withAdmissionReason } from "./admission-reasons.mjs";

/*
 * Shared work in a stateless Worker isolate, for celld 0.6.3.
 *
 * celld 0.6.3 resumes a promise continuation under the request whose I/O
 * settled that promise. If gateway request B awaits a module-level promise
 * that request A created, the rest of B runs inside A, including the Durable
 * Object fetch that B forwards. When A responds, celld drops the timers and
 * I/O that B started, and B never settles. A Page's serialized HTTP queue then
 * waits behind B. Continuations inside Durable Objects keep their own context,
 * so caches used only by objects don't need these helpers.
 *
 * So no gateway request awaits a promise that another request may still be
 * settling. The request that starts the work awaits it. Others wait on their
 * own timers until it settles and then run in their own context. A waiter
 * fails with a retryable 503 after `isolateSetupTimeouts.wait`.
 *
 * Remove these helpers when celld keeps request context across shared
 * promises: `scripts/celld-context-probe.mjs` then exits 0 on the new celld.
 */

/** Mutable so tests can shorten them. `wait` bounds how long a request waits
 * for another request's work; `poll` is the interval of its own timer. */
export const isolateSetupTimeouts = { wait: 10_000, poll: 5 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Plain fields, not HttpError: auth.mjs imports a module that uses this one.
const waitTimeout = () =>
  withAdmissionReason(
    Object.assign(new Error("Pages is starting. Try again."), {
      status: 503,
      code: "request_timeout",
    }),
    "credential_unverified",
  );

// One poll of a waiter's own timer. Callers re-check and claim their key in
// the same synchronous step after it returns.
async function pause(deadline) {
  if (Date.now() >= deadline) throw waitTimeout();
  await sleep(isolateSetupTimeouts.poll);
}

/**
 * One-time setup per key for this isolate, such as a D1 schema per binding.
 * A failed setup lets the next request start it again.
 */
export function isolateSetup(run) {
  const pending = new WeakSet();
  const ready = new WeakSet();
  return async (key, ...args) => {
    const deadline = Date.now() + isolateSetupTimeouts.wait;
    while (pending.has(key)) await pause(deadline);
    if (ready.has(key)) return;
    pending.add(key);
    try {
      await run(key, ...args);
      ready.add(key);
    } finally {
      pending.delete(key);
    }
  };
}

/**
 * Run `work` for one key at a time in this isolate. Use it in front of a
 * library cache that hands every caller the same pending promise: a later
 * caller reaches the cache only after the earlier call settles, so it gets a
 * settled entry or starts its own lookup.
 *
 * The caller running `work` also gives up after `isolateSetupTimeouts.wait`
 * with the same retryable 503. The key stays held until `work` settles, or for
 * `holdMs` after it started if it never does. `holdMs` must exceed the
 * library cache's lifetime for a pending entry, so the next caller after
 * release starts a new lookup instead of meeting the abandoned one.
 */
export function isolateSingleFlight({ holdMs }) {
  const running = new Map();
  return async (key, work) => {
    const deadline = Date.now() + isolateSetupTimeouts.wait;
    for (;;) {
      const held = running.get(key);
      if (held === undefined || Date.now() >= held) break;
      await pause(deadline);
    }
    const token = Date.now() + holdMs;
    running.set(key, token);
    const release = () => {
      if (running.get(key) === token) running.delete(key);
    };
    const settled = Promise.resolve().then(work);
    settled.then(release, release);
    let timer;
    try {
      return await Promise.race([
        settled,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(waitTimeout()), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

const sessionSchema = isolateSetup((db, env) => oidcDatabase(env));

/** Sign-in routes always read the D1 session store. Other routes read it only
 * for a session cookie. Bearer credentials use the OAuth store instead, which
 * sets up its own schema through `isolateSetup`. */
function readsSessionStore(request) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/auth/") || pathname === "/oidc") return true;
  return request.headers.has("cookie") && /^\/(?:api\/|oauth\/|mcp$)/.test(pathname);
}

/**
 * Set up the session schema before a gateway route reads the session store.
 * That store caches one schema promise per D1 binding, which the first
 * concurrent requests in a fresh isolate would otherwise all await. Without a
 * D1 binding this does nothing, and the route reports the missing store.
 */
export async function sessionStoreReady(request, env) {
  if (env.DB && readsSessionStore(request)) await sessionSchema(env.DB, env);
}
