// What a link to a Page or a Project shows its reader. Four browser routes:
//
// - `GET /p/<id>/meta.json` (title, state, role and content time) and
//   `GET /p/<id>/card.json` (the Page's first-screen card);
// - `GET /project/<id>/meta.json` (title, description and role) and
//   `GET /project/<id>/card.json` (the first screen of the Project's
//   content document).
//
// The viewer's glyphs and hover card read them (viewer/page-refs.mjs).
// Nothing about the target is stored with the link: each reader's own
// credentials resolve it, at the time they look.
//
// Every route runs the same steps (handleLinkPreview): exactly these paths, GET
// and HEAD only (405 otherwise); a foreign `Sec-Fetch-Site` refused before
// authentication; `authenticate` as every gateway route does; then one
// check with the caller's own credentials, bounded by linkPreviewBounds,
// whose every failure is the kind's one uniform 404; then the answer, with
// the same headers.
//
// Pages. The gateway asks the target's Page host through LINK_PREVIEW_PATH.
// That route is host-internal: the gateway never forwards a client's path to
// it (`/internal/*` stays 404 there). The Page host (Page#linkPreview in
// index.mjs) decides from its stored record, as a shared-Page check from the
// record does, but:
//    - it decides every refusal without starting a boot itself, and starts
//      or waits for one only for a reader it admitted whose title the record
//      can't supply;
//    - it claims no invitation, records no usage or presence, and writes no
//      title projection, index report or Catalog entry.
//    Like every request, the first one to a cold host whose record starts
//    eagerly boots it in the constructor, and the shared `run()` cleanup
//    may flush content activity that earlier requests deferred.
// Access is the Page host's: owner, direct grants, Project membership and a
// company domain all count, which the reader's own Catalog doesn't know
// about. A pending invitation grants nothing until the invitee opens the
// Page. A Page whose recovery is blocked still answers, as opening it read
// only does.
//
// Projects. The Project's host (the `Space` object behind PROJECTS,
// spaces.mjs) is the authority for its title, description, owner and
// members. The gateway asks it `/internal/space/read` with `claim: false`,
// the read-only check read_page's breadcrumbs and project_id content
// addresses already use: it authenticates the caller, reads the record, and
// answers only a caller who may read the Project. With `claim: false` it
// claims no invitation, writes no storage, publishes no discovery hint and
// logs no usage line or invitation event (authenticating an API key may
// still log its periodic acceptance line); a missing record costs only the object's
// instantiation. The owner and members (viewer, commenter, editor) read
// it; a pending invitee doesn't until they open the Project. The answer
// keeps only `title`, `description` and `role`, never the owner or
// revision. Project readers read its content document, so card.json reads
// that document's stored card, only after the Project admitted the reader.
//
// A caller who can't open the target learns nothing, not even whether it
// exists: a missing target, a malformed ID (a Page ID on a Project route or
// the reverse included), a refusal, a deleted, purged or trashed Page (for
// anyone who can't restore it), a pending invitation, a revoked member, and
// a host error, busy answer or timeout all answer the kind's one 404 body,
// PAGE_UNAVAILABLE or PROJECT_UNAVAILABLE. That body therefore can't say
// why; the viewer shows only "Page unavailable" or "Project unavailable" and
// asks again sooner than for an answer.
//
// Answers are `private, no-store`, as Page assets are: a title or a first
// screen never stays in the browser's disk cache after sign-out.
//
// Follow-up, before P2's viewport loading raises the request volume: both
// checks run in their host's serial request queue (the Page's run(), the
// Space's queue), so a burst of previews waits behind edits to that Page or
// membership changes to that Project, and the reverse. Each needs only its
// record, so it can move out of the queue.
import { HttpError, authenticate, errorResponse } from "./auth.mjs";
import { catalogIndexTimeouts, withTimeout } from "./catalog-index.mjs";
import { validPageId } from "./registration.mjs";
import { validSpaceId } from "./spaces.mjs";
import { readPageCards } from "./page-cards.mjs";
import { cardImageView, readCardImagePointer } from "./card-images.mjs";

/** The Page host's route for this check. Host-internal; never forwarded. */
export const LINK_PREVIEW_PATH = "/internal/link-preview";
/** The Project host's read-only check (spaces.mjs), asked with `claim: false`. */
export const PROJECT_READ_PATH = "/internal/space/read";
/** The one refusal body of the Page routes. */
export const PAGE_UNAVAILABLE = Object.freeze({
  error: "Page unavailable",
  code: "page_unavailable",
});
/** The one refusal body of the Project routes. */
export const PROJECT_UNAVAILABLE = Object.freeze({
  error: "Project unavailable",
  code: "project_unavailable",
});
/** The Page host's refusal, raised wherever the host decides not to answer. */
export const linkUnavailable = () =>
  new HttpError(404, PAGE_UNAVAILABLE.error, PAGE_UNAVAILABLE.code);
/** The response body version every route carries. */
export const LINK_PREVIEW_VERSION = 1;

const ROUTE = /^\/(p|project)\/([^/]*)\/(meta|card)\.json$/;
/**
 * The route a path names, or null: `{ kind: "page", pageId, file }` for
 * `/p/<id>/<file>.json` or `{ kind: "project", projectId, file }` for
 * `/project/<id>/<file>.json`, where `file` is "meta" or "card". The ID is
 * the path segment as sent, unchecked: a malformed one answers the kind's
 * one 404, after authentication. The older `/s/<id>` Project route has no
 * JSON routes; those paths stay the app's.
 */
export function readLinkRoute(pathname) {
  const match = ROUTE.exec(pathname);
  if (!match) return null;
  const [, prefix, id, file] = match;
  return prefix === "p"
    ? { kind: "page", pageId: id, file }
    : { kind: "project", projectId: id, file };
}

/** Headers on every answer of every route. No CORS headers: only this
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

/** The kind's one refusal. */
const unavailable = (body) => uncached(Response.json(body, { status: 404 }));

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

/** The internal POST to a host's `path` with `body`, carrying the caller's
 * credentials. A browser's same-origin GET may send no Origin; this request
 * is the gateway's own, so it names the public origin, as page_cards' does. */
function hostRequest(request, env, path = LINK_PREVIEW_PATH, body = {}) {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["authorization", "cookie", "sec-fetch-site"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("origin", new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Bounds: a host check waits as long as other shared-Page checks. */
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

/** The project meta.json body: what a Project reader may see of it, never
 * its owner, revision, members or content document ID. */
export function projectMetaBody(project) {
  return {
    v: LINK_PREVIEW_VERSION,
    kind: "project",
    project_id: project.space_id,
    title: project.title,
    description: typeof project.description === "string" ? project.description : "",
    role: project.role,
  };
}

/**
 * Call `send()` (a host fetch) and return its 200 JSON answer, or null for
 * any other status, an error or a timeout (logged through `logFailure`).
 * Building the stub and request inside `send` keeps a setup failure (a
 * missing binding, a bad origin setting) on the same uniform refusal.
 */
async function askHost(send, stage, logFailure) {
  try {
    const response = await withTimeout(
      send(),
      linkPreviewBounds.hostMs,
      "Link preview check timed out",
    );
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    return await response.json();
  } catch (error) {
    logFailure(error, stage);
    return null;
  }
}

/**
 * Ask `pageId`'s Page host whether the caller of `request` may open it, with
 * the caller's own credentials: the host's answer (`{ page_id, title, state,
 * role, content_updated_at }`), or null for every refusal, error and timeout
 * alike. The caller has already authenticated `request`.
 */
export async function checkLinkPreview(request, env, pageId, { logFailure = () => {} } = {}) {
  if (!validPageId(pageId)) return null;
  const page = await askHost(
    () => env.PAGES.getByName(pageId).fetch(hostRequest(request, env)),
    "link-preview",
    logFailure,
  );
  return page?.page_id === pageId ? page : null;
}

/**
 * Ask Project `projectId`'s host whether the caller of `request` may read
 * it, with the caller's own credentials and `claim: false`: its public
 * record (spaces.mjs publicSpace), or null for every refusal, error and
 * timeout alike. An answer for another Project, or without a title or a
 * content document, is null too. The caller has already authenticated
 * `request`.
 */
export async function checkProjectPreview(request, env, projectId, { logFailure = () => {} } = {}) {
  if (!validSpaceId(projectId)) return null;
  const project = await askHost(
    () =>
      env.PROJECTS.getByName(projectId).fetch(
        hostRequest(request, env, PROJECT_READ_PATH, { space_id: projectId, claim: false }),
      ),
    "project-link-preview",
    logFailure,
  );
  if (
    project?.space_id !== projectId ||
    typeof project.title !== "string" ||
    typeof project.role !== "string" ||
    !validPageId(project.document_id)
  )
    return null;
  return project;
}

/** The stored card of Page document `pageId`, with its card image view, or
 * null: page_cards' reads (page-cards.mjs, card-images.mjs) for one ID. Only
 * call it for a reader admitted to the document. */
async function storedCard(env, pageId, logFailure) {
  const bucket = env.PAGES_ASSETS;
  if (!bucket) return null;
  const cards = await readPageCards([pageId], [pageId], {
    readObject: async (key) => {
      const object = await bucket.get(key);
      return object ? await object.text() : null;
    },
    readImage: async (id) => cardImageView(id, await readCardImagePointer(bucket, id)),
    onError: (error) => logFailure(error, "link-preview-card"),
  });
  return cards[pageId] ?? null;
}

/** How each kind's routes check and answer. */
const KINDS = {
  page: {
    refusal: PAGE_UNAVAILABLE,
    id: (route) => route.pageId,
    check: checkLinkPreview,
    meta: (page) => metaBody(page),
    card: async (env, page, logFailure) => ({
      v: LINK_PREVIEW_VERSION,
      page_id: page.page_id,
      card: await storedCard(env, page.page_id, logFailure),
    }),
  },
  project: {
    refusal: PROJECT_UNAVAILABLE,
    id: (route) => route.projectId,
    check: checkProjectPreview,
    meta: (project) => projectMetaBody(project),
    // The content document's card, read only now that the Project admitted
    // this reader: its readers read the content.
    card: async (env, project, logFailure) => ({
      v: LINK_PREVIEW_VERSION,
      project_id: project.space_id,
      card: await storedCard(env, project.document_id, logFailure),
    }),
  },
};

/**
 * Answer `GET`/`HEAD` on one of the four routes.
 *
 * - `route` is readLinkRoute's answer.
 * - `logFailure(error, stage)` records a host or bucket failure; the caller
 *   still gets the kind's uniform 404 (or `card: null` for a card read).
 */
export async function handleLinkPreview(request, env, route, { logFailure = () => {} } = {}) {
  const kind = KINDS[route.kind];
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
    // A missing credential is a 401 whatever the ID; an MCP OAuth token and
    // an upload capability are refused here as on every route but their own.
    await authenticate(request, env);
  } catch (error) {
    return uncached(errorResponse(error, "link-preview"));
  }
  const target = await kind.check(request, env, kind.id(route), { logFailure });
  if (!target) return unavailable(kind.refusal);
  if (route.file === "meta") return answer(request, kind.meta(target));
  return answer(request, await kind.card(env, target, logFailure));
}
