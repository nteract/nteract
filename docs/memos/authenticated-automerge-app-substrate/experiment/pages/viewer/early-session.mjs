// The viewer's first session check, started by theme.js in <head> so it
// overlaps the app bundle and WASM downloads instead of waiting for them.
//
// Hand-off invariant: theme.js leaves at most one in-flight request on
// window[EARLY_SESSION]. The viewer's first session refresh takes it and
// deletes the property, so it is used once; every later refresh fetches. The
// slot holds the raw Response promise, so request() still observes its
// headers, parses it and applies its errors and deadline.
//
// The answer must still describe the current cookie when the viewer takes it.
// The slot is dropped, and the viewer fetches, when the tab becomes visible
// (the trigger browser-session.mjs uses to notice a sign-in in another tab),
// on a back/forward cache restore, or when it is older than
// EARLY_SESSION_MAX_AGE_MS.
import { readPageRoute } from "../shared/routes.mjs";

export const SESSION_URL = "/api/auth/session";
export const EARLY_SESSION = "__pagesEarlySession";

// Measured from the request's start. A cold load on page9 takes the slot
// about 1.4 s after theme.js starts it (session start ~0.27 s, WASM done
// ~1.66 s). 5 s covers that on slower links; past it, one more round trip is a
// small share of the load and the answer is old enough to have been overtaken.
export const EARLY_SESSION_MAX_AGE_MS = 5_000;

// The viewer's own routes. theme.js also loads on /connect and the OAuth
// pages, which never check the session; an unknown path just loses the head
// start.
const VIEWER_ROUTES = new Set(["home", "page", "project", "projects", "pages"]);

const monotonic = () => globalThis.performance.now();

/** Start the session check from the head script, on viewer routes only. */
export function startEarlySession(win, now = monotonic) {
  if (!VIEWER_ROUTES.has(readPageRoute(win.location.href).kind)) return;
  const controller = new AbortController();
  // Must stay identical to request(SESSION_URL): a GET with default
  // (same-origin) credentials, no headers, and only a signal added.
  const response = win.fetch(SESSION_URL, { signal: controller.signal });
  // The consumer handles failures; a request nobody takes must not report an
  // unhandled rejection.
  response.catch(() => {});
  const page = win.document;
  const onVisibility = () => {
    if (page.visibilityState === "visible") drop();
  };
  const onPageShow = (event) => {
    if (event.persisted) drop();
  };
  const slot = {
    response,
    controller,
    startedAt: now(),
    release() {
      page?.removeEventListener?.("visibilitychange", onVisibility);
      win.removeEventListener?.("pageshow", onPageShow);
    },
  };
  function drop() {
    if (win[EARLY_SESSION] !== slot) return;
    delete win[EARLY_SESSION];
    slot.release();
    controller.abort();
  }
  page?.addEventListener?.("visibilitychange", onVisibility);
  win.addEventListener?.("pageshow", onPageShow);
  win[EARLY_SESSION] = slot;
}

/** Take the head script's request, at most once. Returns undefined when there
 * is none or it is too old to describe the current cookie. */
export function takeEarlySession(win = globalThis, now = monotonic) {
  const early = win[EARLY_SESSION];
  if (!early) return undefined;
  delete win[EARLY_SESSION];
  early.release();
  if (now() - early.startedAt <= EARLY_SESSION_MAX_AGE_MS) return early;
  early.controller.abort();
  return undefined;
}

/** One session check through `request`. The first call adopts the head
 * script's request when one is still current; a transport failure or 5xx
 * there falls back to a normal request instead of surfacing the early error.
 * Any other status, 401 included, is the answer. */
export function requestSession(request, { win = globalThis, now = monotonic } = {}) {
  const early = takeEarlySession(win, now);
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
