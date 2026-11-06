// What a link to a Page shows its reader: `GET /p/<id>/meta.json` (title,
// state, role and content time) and `GET /p/<id>/card.json` (the Page's
// first-screen card). The viewer's Page glyph and hover card read them
// (viewer/page-refs.mjs). Nothing about the target is stored with the link:
// each reader's own credentials resolve it, at the time they look.
//
// Two steps:
//
// 1. The gateway (handleLinkPreview) takes exactly these two paths, GET and
//    HEAD only, authenticates the caller as every gateway route does, and
//    asks the target's Page host, with the caller's own credentials, through
//    LINK_PREVIEW_PATH. That route is host-internal: the gateway never
//    forwards a client's path to it (`/internal/*` stays 404 there).
// 2. The Page host (Page#linkPreview in index.mjs) decides from its stored
//    record, as a shared-Page check from the record does, but:
//    - it decides every refusal without starting a boot itself, and starts
//      or waits for one only for a reader it admitted whose title the record
//      can't supply;
//    - it claims no invitation, records no usage or presence, and writes no
//      title projection, index report or Catalog entry.
//    Like every request, the first one to a cold host whose record starts
//    eagerly boots it in the constructor, and the shared `run()` cleanup
//    may flush content activity that earlier requests deferred.
//
// Access is the Page host's: owner, direct grants, Project membership and a
// company domain all count, which the reader's own Catalog doesn't know
// about. A pending invitation grants nothing until the invitee opens the
// Page. A Page whose recovery is blocked still answers, as opening it read
// only does.
//
// A caller who can't open the Page learns nothing, not even whether it
// exists: a missing Page, a malformed ID, a refusal, a deleted or purged
// Page, a Page in Trash (for anyone who can't restore it), a pending
// invitation, and a host error, busy answer or timeout all answer the same
// 404 PAGE_UNAVAILABLE body. That body therefore can't say why; the viewer
// shows only "Page unavailable" and asks again sooner than for an answer.
//
// Answers are `private, no-store`, as Page assets are: a title or a first
// screen never stays in the browser's disk cache after sign-out.
//
// Follow-up, before P2's viewport loading raises the request volume: the
// host check runs in the Page's serial request queue (run()), so a burst of
// previews waits behind edits to that Page and vice versa. It needs only
// the record, so it can move out of the queue.
import { HttpError, authenticate, errorResponse } from "./auth.mjs";
import { catalogIndexTimeouts, withTimeout } from "./catalog-index.mjs";
import { validPageId } from "./registration.mjs";
import { readPageCards } from "./page-cards.mjs";
import { cardImageView, readCardImagePointer } from "./card-images.mjs";

/** The Page host's route for this check. Host-internal; never forwarded. */
export const LINK_PREVIEW_PATH = "/internal/link-preview";
/** The one refusal body. */
export const PAGE_UNAVAILABLE = Object.freeze({
  error: "Page unavailable",
  code: "page_unavailable",
});
/** The host's refusal, raised wherever the host decides not to answer. */
export const linkUnavailable = () =>
  new HttpError(404, PAGE_UNAVAILABLE.error, PAGE_UNAVAILABLE.code);
/** The response body version both routes carry. */
export const LINK_PREVIEW_VERSION = 1;

const ROUTE = /^\/p\/([^/]*)\/(meta|card)\.json$/;
/** `{ pageId, file }` for one of the two routes, or null. `pageId` is the
 * path segment as sent, unchecked: a malformed one answers the same 404 as
 * any Page the caller can't open, after authentication. */
export function readLinkRoute(pathname) {
  const match = ROUTE.exec(pathname);
  return match ? { pageId: match[1], file: match[2] } : null;
}

/** Headers on every answer of both routes. No CORS headers: only this
 * origin reads them. `Vary` keeps a shared cache from mixing accounts. */
const BASE_HEADERS = Object.freeze({
  "content-type": "application/json",
  vary: "Cookie, Authorization",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
});

function withHeaders(response, headers) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}

/** A refusal or error answer: never stored, like every answer here. */
function uncached(response) {
  return withHeaders(response, { ...BASE_HEADERS, "cache-control": "private, no-store" });
}

const unavailable = () => uncached(Response.json(PAGE_UNAVAILABLE, { status: 404 }));

/** A 200 answer. The access check ran for this request; nothing is stored,
 * so the next look checks again. */
function answer(request, body) {
  const text = JSON.stringify(body);
  const headers = { ...BASE_HEADERS, "cache-control": "private, no-store" };
  return new Response(request.method === "HEAD" ? null : text, { status: 200, headers });
}

/**
 * Whether a request's `Sec-Fetch-Site` rules it out. A browser's fetch from
 * this origin says `same-origin`, and a person opening the URL says `none`;
 * scripts send nothing. `cross-site` is already refused by authenticate's
 * origin check. This also refuses `same-site`: another deployment on the same
 * site (page2.runtimed.run beside pages.runtimed.run) sends this origin's
 * session cookie with its requests, and CORS alone would still let it time
 * the answers.
 */
export function foreignFetch(request) {
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

/** The internal POST to the Page host, carrying the caller's credentials.
 * A browser's same-origin GET may send no Origin; this request is the
 * gateway's own, so it names the public origin, as page_cards' does. */
function hostRequest(request, env) {
  const url = new URL(request.url);
  url.pathname = LINK_PREVIEW_PATH;
  url.search = "";
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["authorization", "cookie", "sec-fetch-site"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("origin", new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin);
  return new Request(url, { method: "POST", headers, body: "{}" });
}

/** Bounds: the host check waits as long as other shared-Page checks. */
export const linkPreviewBounds = {
  get hostMs() {
    return catalogIndexTimeouts.verify;
  },
};

/** The host's answer as meta.json's body, keeping only the fields the
 * reader may see: never the owner, members or ACL. */
export function metaBody(page) {
  return {
    v: LINK_PREVIEW_VERSION,
    page_id: page.page_id,
    title: page.title,
    state: page.state,
    role: page.role,
    content_updated_at: page.content_updated_at ?? null,
  };
}

/**
 * Ask `pageId`'s Page host whether the caller of `request` may open it, with
 * the caller's own credentials: the host's answer (`{ page_id, title, state,
 * role, content_updated_at }`), or null for every refusal, error and timeout
 * alike. The caller has already authenticated `request`.
 */
export async function checkLinkPreview(request, env, pageId, { logFailure = () => {} } = {}) {
  if (!validPageId(pageId)) return null;
  try {
    const response = await withTimeout(
      env.PAGES.getByName(pageId).fetch(hostRequest(request, env)),
      linkPreviewBounds.hostMs,
      "Link preview check timed out",
    );
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const page = await response.json();
    return page?.page_id === pageId ? page : null;
  } catch (error) {
    logFailure(error, "link-preview");
    return null;
  }
}

/**
 * Answer `GET`/`HEAD /p/<id>/meta.json` or `/p/<id>/card.json`.
 *
 * - `route` is readLinkRoute's answer.
 * - `logFailure(error, stage)` records a host or bucket failure; the caller
 *   still gets the uniform 404 (or `card: null` for a card read).
 */
export async function handleLinkPreview(request, env, route, { logFailure = () => {} } = {}) {
  if (!["GET", "HEAD"].includes(request.method)) {
    const response = uncached(Response.json({ error: "Use GET or HEAD" }, { status: 405 }));
    response.headers.set("allow", "GET, HEAD");
    return response;
  }
  // Refused before authentication: the answer can't depend on the ID or
  // the account, and no session lookup runs for another site.
  if (foreignFetch(request))
    return uncached(Response.json({ error: "Use this Pages origin" }, { status: 403 }));
  try {
    // A missing credential is a 401 whatever the ID; an MCP OAuth token is
    // refused here as on every route but /mcp.
    await authenticate(request, env);
  } catch (error) {
    return uncached(errorResponse(error, "link-preview"));
  }
  const { pageId, file } = route;
  const page = await checkLinkPreview(request, env, pageId, { logFailure });
  if (!page) return unavailable();
  if (file === "meta") return answer(request, metaBody(page));
  const bucket = env.PAGES_ASSETS;
  const cards = bucket
    ? await readPageCards([pageId], [pageId], {
        readObject: async (key) => {
          const object = await bucket.get(key);
          return object ? await object.text() : null;
        },
        readImage: async (id) => cardImageView(id, await readCardImagePointer(bucket, id)),
        onError: (error) => logFailure(error, "link-preview-card"),
      })
    : { [pageId]: null };
  return answer(request, { v: LINK_PREVIEW_VERSION, page_id: pageId, card: cards[pageId] ?? null });
}
