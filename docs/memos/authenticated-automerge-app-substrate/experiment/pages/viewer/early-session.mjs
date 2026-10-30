// The viewer's first session check, started by theme.js in <head> so it
// overlaps the app bundle and WASM downloads instead of waiting for them.
//
// Hand-off invariant: theme.js leaves at most one in-flight request on
// window[EARLY_SESSION]. The viewer's first session refresh takes it and
// deletes the property, so it is used once; every later refresh fetches. The
// slot holds the raw Response promise, so request() still observes its
// headers, parses it and applies its errors and deadline.
import { readPageRoute } from "../shared/routes.mjs";

export const SESSION_URL = "/api/auth/session";
export const EARLY_SESSION = "__pagesEarlySession";

// The viewer's own routes. theme.js also loads on /connect and the OAuth
// pages, which never check the session; an unknown path just loses the head
// start.
const VIEWER_ROUTES = new Set(["home", "page", "project"]);

/** Start the session check from the head script, on viewer routes only. */
export function startEarlySession(win) {
  if (!VIEWER_ROUTES.has(readPageRoute(win.location.href).kind)) return;
  const controller = new AbortController();
  // Must stay identical to request(SESSION_URL): a GET with default
  // (same-origin) credentials, no headers, and only a signal added.
  const response = win.fetch(SESSION_URL, { signal: controller.signal });
  // The consumer handles failures; a request nobody takes must not report an
  // unhandled rejection.
  response.catch(() => {});
  win[EARLY_SESSION] = { response, controller };
}

/** Take the head script's request, at most once. */
export function takeEarlySession(win = globalThis) {
  const early = win[EARLY_SESSION];
  delete win[EARLY_SESSION];
  return early;
}

/** One session check through `request`. The first call adopts the head
 * script's request when there is one; a transport failure or 5xx there falls
 * back to a normal request instead of surfacing the early error. */
export function requestSession(request, { win = globalThis } = {}) {
  const early = takeEarlySession(win);
  if (!early) return request(SESSION_URL);
  return request(SESSION_URL, {}, { fetch: (url, init) => adopt(early, url, init) });
}

async function adopt(early, url, init) {
  const signal = init.signal;
  // request()'s deadline or caller abort also cancels the early fetch and its body.
  signal?.addEventListener("abort", () => early.controller.abort(signal.reason), { once: true });
  try {
    const response = await early.response;
    if (response.status < 500) return response;
    void response.body?.cancel().catch(() => {});
  } catch {
    signal?.throwIfAborted();
  }
  // The same fetch request() makes when there is no early request.
  return globalThis.fetch(url, init);
}
