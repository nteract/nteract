// The viewer's first session check and, on a Page route, its first connection
// discovery, both started by theme.js in <head> so they overlap the app bundle
// and WASM downloads instead of waiting for them.
//
// Hand-off invariant: theme.js leaves at most one in-flight request in each
// slot, window[EARLY_SESSION] and window[EARLY_CONNECT]. The viewer's first
// session refresh takes the session slot, and its first /api/connect for the
// same Page takes the connect slot. Taking deletes the property, so each is
// used once; every later request fetches. A slot holds the raw Response
// promise, so request() still observes its headers, parses it and applies its
// errors and deadline.
//
// The answer must still describe the current cookie when the viewer takes it.
// A slot is dropped, and the viewer fetches, when the tab becomes visible
// (the trigger browser-session.mjs uses to notice a sign-in in another tab),
// on a back/forward cache restore, or when it is older than its bound
// (EARLY_SESSION_MAX_AGE_MS, EARLY_CONNECT_MAX_AGE_MS).
import { ADMISSION_CAPABILITY } from "../shared/admission.mjs";
import { readPageRoute } from "../shared/routes.mjs";

export const SESSION_URL = "/api/auth/session";
export const EARLY_SESSION = "__pagesEarlySession";
export const EARLY_CONNECT = "__pagesEarlyConnect";

// Measured from the request's start. A cold load on page9 takes the slot
// about 1.4 s after theme.js starts it (session start ~0.27 s, WASM done
// ~1.66 s). 5 s covers that on slower links; past it, one more round trip is a
// small share of the load and the answer is old enough to have been overtaken.
export const EARLY_SESSION_MAX_AGE_MS = 5_000;
// The connection discovery is taken later: only once the WASM runtimes are
// up. On Fast 3G with nothing cached that is about 11 s after theme.js starts
// it, and a refetch then costs a full round trip before the socket opens.
// Discovery names the host and the access to expect; it grants nothing. The
// sync socket's admission checks the cookie and access again, so an older
// discovery only risks a refused socket, which reconnects with a fresh one.
export const EARLY_CONNECT_MAX_AGE_MS = 20_000;

// The viewer's own routes. theme.js also loads on /connect and the OAuth
// pages, which never check the session; an unknown path just loses the head
// start.
const VIEWER_ROUTES = new Set(["home", "page", "project", "projects", "pages"]);

/** The discovery request PageSession.openConnection makes for a Page. */
export const connectUrl = (pageId) => `/api/connect?page=${encodeURIComponent(pageId)}`;
export const CONNECT_HEADERS = Object.freeze({
  [ADMISSION_CAPABILITY.header]: ADMISSION_CAPABILITY.value,
});

const monotonic = () => globalThis.performance.now();

/** Put one request in `win[slotName]` with the invalidation listeners.
 * `key` names what a consumer must ask for to adopt it. */
function startEarly(win, slotName, key, url, init, now) {
  const controller = new AbortController();
  const response = win.fetch(url, { ...init, signal: controller.signal });
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
    key,
    response,
    controller,
    startedAt: now(),
    // Called when the tab drops this request, not when the viewer takes it.
    dropped: new Set(),
    release() {
      page?.removeEventListener?.("visibilitychange", onVisibility);
      win.removeEventListener?.("pageshow", onPageShow);
    },
  };
  function drop() {
    if (win[slotName] !== slot) return;
    delete win[slotName];
    slot.release();
    controller.abort();
    // A listener may unsubscribe while this runs; call the ones held now.
    const listeners = Array.from(slot.dropped);
    slot.dropped.clear();
    for (const listener of listeners) listener();
  }
  page?.addEventListener?.("visibilitychange", onVisibility);
  win.addEventListener?.("pageshow", onPageShow);
  win[slotName] = slot;
  return slot;
}

/** Take `win[slotName]`, at most once. Returns undefined when there is none,
 * it was started for another key, or it is too old to describe the current
 * cookie. */
function takeEarly(win, slotName, key, now, maxAge) {
  const early = win[slotName];
  if (!early) return undefined;
  delete win[slotName];
  early.release();
  if (early.key === key && now() - early.startedAt <= maxAge) return early;
  early.controller.abort();
  return undefined;
}

/** Start the session check from the head script, on viewer routes only. */
export function startEarlySession(win, now = monotonic) {
  if (!VIEWER_ROUTES.has(readPageRoute(win.location.href).kind)) return;
  // Must stay identical to request(SESSION_URL): a GET with default
  // (same-origin) credentials, no headers, and only a signal added.
  startEarly(win, EARLY_SESSION, SESSION_URL, SESSION_URL, {}, now);
}

/** Start the Page's connection discovery from the head script, on a Page
 * route only. It runs beside the session check, so a Page this device has
 * never opened doesn't wait for the session answer before it asks. It also
 * asks for the Page's read-only preview (model/page-preview.mjs), which the
 * shell may show while the editor loads (boot-preview.mjs); openConnection
 * ignores that field. */
export function startEarlyConnect(win, now = monotonic) {
  const route = readPageRoute(win.location.href);
  if (route.kind !== "page") return;
  // Otherwise identical to openConnection's request: a GET with default
  // credentials, the admission header, and only a signal added.
  const slot = startEarly(
    win,
    EARLY_CONNECT,
    route.pageId,
    `${connectUrl(route.pageId)}&preview=1`,
    { headers: CONNECT_HEADERS },
    now,
  );
  // Tee the body before the session reads it. This reader is registered
  // first, so it clones before openConnection's request() consumes the
  // original.
  slot.answer = slot.response
    .then((response) =>
      response.ok && /json/i.test(response.headers.get("content-type") ?? "")
        ? response
            .clone()
            .json()
            .then((body) => previewAnswer(body, response.status))
        : { ok: false, status: response.status },
    )
    .catch(() => ({ ok: false, status: 0 }));
}

/**
 * The part of a discovery answer the boot preview may use:
 * `{ ok: true, principal, preview }` when the host authenticated a principal
 * that can read the Page and sent a preview, otherwise `{ ok: false, status }`.
 * A Page in Trash is refused here too: its preview would hide the Trash
 * notice the live Page shows.
 */
export function previewAnswer(body, status = 200) {
  const principal = body?.identity?.principal;
  if (
    status < 200 ||
    status >= 300 ||
    typeof principal !== "string" ||
    principal === "" ||
    body.access?.canRead === false ||
    body.trash ||
    !body.preview ||
    typeof body.preview !== "object"
  )
    return { ok: false, status };
  return { ok: true, principal, preview: body.preview };
}

/** The head script's discovery of `pageId` for the boot preview, without
 * taking it: `{ answer, onInvalidate }`, or null when there is none for that
 * Page. `answer` resolves with previewAnswer's result. `onInvalidate(fn)`
 * calls `fn` if the tab drops the request (visibility or a back/forward
 * cache restore) and returns its unsubscribe. */
export function earlyConnectAnswer(pageId, win = globalThis) {
  const early = win[EARLY_CONNECT];
  if (early?.key !== pageId || !early.answer) return null;
  return {
    answer: early.answer,
    onInvalidate(listener) {
      early.dropped.add(listener);
      return () => early.dropped.delete(listener);
    },
  };
}

/** Take the head script's session request, at most once. */
export function takeEarlySession(win = globalThis, now = monotonic) {
  return takeEarly(win, EARLY_SESSION, SESSION_URL, now, EARLY_SESSION_MAX_AGE_MS);
}

/** One session check through `request`. The first call adopts the head
 * script's request when one is still current; a transport failure or 5xx
 * there falls back to a normal request instead of surfacing the early error.
 * Any other status, 401 included, is the answer. */
export function requestSession(request, { win = globalThis, now = monotonic } = {}) {
  const early = takeEarlySession(win, now);
  if (!early) return request(SESSION_URL);
  return request(
    SESSION_URL,
    {},
    {
      fetch: (url, init) => adopt(early, url, init, (status) => status < 500),
    },
  );
}

/** One connection discovery for `pageId` through `request`. The first call
 * adopts the head script's request for the same Page when it succeeded. Any
 * refusal asks again: a Page this tab created is unknown to the host until its
 * registration lands, which can be after the head script asked. */
export function requestConnect(pageId, request, { win = globalThis, now = monotonic } = {}) {
  const url = connectUrl(pageId);
  const options = { headers: CONNECT_HEADERS };
  const early = takeEarly(win, EARLY_CONNECT, pageId, now, EARLY_CONNECT_MAX_AGE_MS);
  if (!early) return request(url, options);
  return request(url, options, {
    fetch: (url, init) => adopt(early, url, init, (status) => status >= 200 && status < 300),
  });
}

/** The early response when `usable(status)`, else the request it stood in for. */
async function adopt(early, url, init, usable) {
  const signal = init.signal;
  // request()'s deadline or caller abort also cancels the early fetch and its body.
  signal?.addEventListener("abort", () => early.controller.abort(signal.reason), { once: true });
  try {
    const response = await early.response;
    if (usable(response.status)) return response;
    void response.body?.cancel().catch(() => {});
  } catch {
    signal?.throwIfAborted();
  }
  // The same fetch request() makes when there is no early request.
  return globalThis.fetch(url, init);
}
