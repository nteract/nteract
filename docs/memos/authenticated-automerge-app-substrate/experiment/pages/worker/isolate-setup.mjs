import { oidcDatabase } from "@cloud/oidc-session-store.ts";
import { withAdmissionReason } from "./admission-reasons.mjs";

/** Mutable so tests can shorten them. `wait` bounds how long a request waits
 * for another request's setup; `poll` is the interval of its own timer. */
export const isolateSetupTimeouts = { wait: 10_000, poll: 5 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Plain fields, not HttpError: auth.mjs imports a module that uses this one.
const setupTimeout = () =>
  withAdmissionReason(
    Object.assign(new Error("Pages is starting. Try again."), {
      status: 503,
      code: "request_timeout",
    }),
    "credential_unverified",
  );

/**
 * One-time setup per key for this isolate, such as a D1 schema per binding.
 *
 * celld 0.6.3 resumes a promise continuation under the request whose I/O
 * settled that promise. If request B awaits a module-level promise that
 * request A created, the rest of B runs inside A, including the Durable Object
 * fetch that B forwards. When A responds, celld drops the timers and I/O that
 * B started, and B never settles. A Page's serialized HTTP queue then waits
 * behind B forever.
 *
 * Only the request that starts a setup awaits it. Any other request waits on
 * its own timer until the setup settles, so it keeps running in its own
 * context. A failed setup lets the next request start it again. A waiter
 * fails with a retryable 503 after `isolateSetupTimeouts.wait`.
 */
export function isolateSetup(run) {
  const pending = new WeakSet();
  const ready = new WeakSet();
  return async (key, ...args) => {
    const deadline = Date.now() + isolateSetupTimeouts.wait;
    while (pending.has(key)) {
      if (Date.now() >= deadline) throw setupTimeout();
      await sleep(isolateSetupTimeouts.poll);
    }
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
