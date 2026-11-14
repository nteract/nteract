const pageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A Page link may carry a slug after its id, `/p/<id>/<slug>`, which names
 * nothing: the id alone finds and authorizes the Page. The slug gives a
 * reader and a link preview words to show (pageSlugWords) for a Page its
 * unfurler can't read. Every link Pages builds for a Page whose title it has
 * carries the title's slug (pageTitleSlug, pageLinkPath), in the app, in
 * tool results and in the open Page's address; a link with an older or
 * hand-typed slug opens the same Page. Grammar: 1 to 80 of
 * `A-Z a-z 0-9 _ -`, at least one letter or digit, and not `view` in any case. No dot, so a file route under `/p/<id>/`
 * (`meta.json`, `card.json`) never reads as one, and nothing that needs
 * percent-encoding, so the address shows it as typed. Anything else after
 * the id is not a Page route.
 */
const pageSlugPattern = /^[A-Za-z0-9_-]{1,80}$/;
const RESERVED_SLUGS = new Set(["view"]);
export const isPageSlug = (slug) =>
  typeof slug === "string" &&
  pageSlugPattern.test(slug) &&
  /[A-Za-z0-9]/.test(slug) &&
  !RESERVED_SLUGS.has(slug.toLowerCase());

/** A slug as words: `-` and `_` become spaces, runs of spaces collapse to
 * one, and the ends are trimmed. "My-Dashboard" reads "My Dashboard". */
export const pageSlugWords = (slug) => slug.replace(/[-_]+/g, " ").trim();

const PAGE_SLUG_MAX = 80;
/** How far back from the cap a long slug looks for a `-` to end at. */
const PAGE_SLUG_BOUNDARY_WINDOW = 24;

/**
 * The slug for a Page titled `title`, or null when the title gives none.
 * Accents come off (NFKD, then combining marks dropped: "Café" is "Cafe"),
 * letter case stays as typed, and every run of anything else outside
 * `A-Z a-z 0-9` becomes one `-`, trimmed from both ends. A slug over 80
 * characters ends at the last `-` within the final stretch before the cap,
 * or at the cap when there is none. A title with no Latin letter or digit,
 * an empty one and one that reads `view` give null (isPageSlug). There is no
 * transliteration: a title in another script gives null.
 */
export function pageTitleSlug(title) {
  if (typeof title !== "string") return null;
  let slug = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > PAGE_SLUG_MAX) {
    const cut = slug.slice(0, PAGE_SLUG_MAX);
    const boundary = cut.lastIndexOf("-");
    slug =
      slug[PAGE_SLUG_MAX] === "-"
        ? cut
        : boundary >= PAGE_SLUG_MAX - PAGE_SLUG_BOUNDARY_WINDOW
          ? cut.slice(0, boundary)
          : cut;
    slug = slug.replace(/-+$/, "");
  }
  return isPageSlug(slug) ? slug : null;
}

/** A Page's address, with `slug` after its id when one is given. */
export function pagePath(id, slug = null) {
  if (!pageIdPattern.test(id ?? "")) throw Error("Invalid Page ID");
  if (slug === null) return `/p/${id}`;
  if (!isPageSlug(slug)) throw Error("Invalid Page slug");
  return `/p/${id}/${slug}`;
}

/** The address a link to `page` (`{ page_id, title }`) carries: its title's
 * slug after the id when the title gives one, else `/p/<id>`. */
export const pageLinkPath = (page) => pagePath(page.page_id, pageTitleSlug(page.title));

/** The full URL of a link to `page` (`{ page_id, title }`) at `origin`. A
 * caller without the title passes none and gets `/p/<id>`. */
export const pageUrl = (origin, page) => new URL(pageLinkPath(page), origin).href;

// New Projects get prj_ IDs; sp_ IDs predate the Project name and stay valid.
const projectIdPattern =
  /^(prj|sp)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isProjectId = (id) => projectIdPattern.test(id ?? "");

export function projectPath(id) {
  if (!isProjectId(id)) throw Error("Invalid Project ID");
  return `/project/${id}`;
}

// The index routes list what the account can open. /projects lists every
// Project. The Pages library lists Pages at two addresses, / and /pages,
// which show the same screen; each keeps its view in the address (below) so
// Back, a reload and a shared link reproduce it.
export const PROJECTS_PATH = "/projects";
export const PAGES_PATH = "/pages";
/** list_pages accepts a query of at most this many UTF-16 code units. */
export const PAGES_QUERY_MAX = 200;
/** Cut `value` to at most PAGES_QUERY_MAX UTF-16 code units, by code point:
 * a cut never keeps half of a surrogate pair, and a lone high surrogate at
 * the end (a pair something else already split) is dropped. The search box
 * stores this, so what it shows is what a search sends. */
export function clampPagesQuery(value) {
  const text = typeof value === "string" ? value : "";
  let end = Math.min(text.length, PAGES_QUERY_MAX);
  // A high surrogate just before the cut either starts a pair the cut splits
  // or has already lost its partner; drop it either way.
  const unit = end > 0 ? text.charCodeAt(end - 1) : 0;
  if (unit >= 0xd800 && unit <= 0xdbff) end--;
  return end === text.length ? text : text.slice(0, end);
}
/** The one rule for a /pages search, wherever it comes from (the search box,
 * the address, a request): trimmed, then clamped by clampPagesQuery. */
export function normalizePagesQuery(value) {
  return clampPagesQuery(typeof value === "string" ? value.trim() : "").trimEnd();
}
/** The library's sort orders, list_pages' `sort` values. The first is the
 * default. `dated` orders rows newest first by the time the date groups read
 * (list_pages' activity key, activityAt in viewer/listing.mjs), which
 * grouping by date needs. A new order is one entry here. */
export const LIBRARY_SORTS = Object.freeze([
  Object.freeze({ value: "activity", label: "Last activity", dated: true }),
  Object.freeze({ value: "title", label: "Title", dated: false }),
]);
/** The library's tabs: list_pages' `access`, null for everything. */
export const LIBRARY_ACCESS = Object.freeze([null, "owned", "shared"]);
/** How the library groups the rows it has loaded; null shows one list. */
export const LIBRARY_GROUPS = Object.freeze([null, "project", "date"]);
export const LIBRARY_DEFAULTS = Object.freeze({
  query: "",
  access: null,
  sort: LIBRARY_SORTS[0].value,
  projectId: null,
  group: null,
});
/** Whether `group` applies under `sort`: date groups need a dated order. */
export const groupApplies = (group, sort) =>
  group !== "date" || LIBRARY_SORTS.some((entry) => entry.value === sort && entry.dated);

/**
 * The one rule for the library's view, wherever it comes from (the address,
 * a control, a request). Unknown values fall back to the defaults.
 * - A Project holds only its owner's Pages, so a Project filter lists Your
 *   items (`access: "owned"`), and the shared tab takes no Project:
 *   list_pages refuses `access: "shared"` with `project_id`.
 * - Date groups need a dated sort; under any other the rows show ungrouped.
 */
export function normalizeLibraryView(input = {}) {
  const value = input ?? {};
  const sort = LIBRARY_SORTS.some((entry) => entry.value === value.sort)
    ? value.sort
    : LIBRARY_DEFAULTS.sort;
  const access = LIBRARY_ACCESS.includes(value.access) ? value.access : null;
  const projectId = access !== "shared" && isProjectId(value.projectId) ? value.projectId : null;
  const group =
    LIBRARY_GROUPS.includes(value.group) && groupApplies(value.group, sort) ? value.group : null;
  return Object.freeze({
    query: normalizePagesQuery(value.query),
    access: projectId ? "owned" : access,
    sort,
    projectId,
    group,
  });
}
/** The part of a library view a list_pages request reads. */
export function libraryRequest(view) {
  const { query, access, sort, projectId } = normalizeLibraryView(view);
  return Object.freeze({ query, access, sort, projectId });
}
/** Whether two library requests list the same rows. */
export const sameLibraryRequest = (a, b) =>
  a?.query === b?.query &&
  a?.access === b?.access &&
  a?.sort === b?.sort &&
  a?.projectId === b?.projectId;

/** Whether two library views show the same thing: the same request and the
 * same grouping. */
export const sameLibraryView = (a, b) => {
  const left = normalizeLibraryView(a);
  const right = normalizeLibraryView(b);
  return sameLibraryRequest(left, right) && left.group === right.group;
};

/** A library view read from an address's search: `q`, `show` (owned or
 * shared), `sort` (title), `group` (project or date) and `project`. */
export const readLibraryView = (search) =>
  normalizeLibraryView({
    query: search.get("q"),
    access: search.get("show"),
    sort: search.get("sort"),
    group: search.get("group"),
    projectId: search.get("project"),
  });

/** `base` (/ or /pages) with `view` in its search. Defaults are left out, so
 * the plain library is its bare path. */
export function libraryPath(base, view = LIBRARY_DEFAULTS) {
  const current = normalizeLibraryView(view);
  // Built on URL alone: the head script (theme.js) reads routes before
  // anything else loads, where URLSearchParams may not be a global.
  const url = new URL(base, "https://pages.invalid");
  const search = url.searchParams;
  if (current.query) search.set("q", current.query);
  if (current.access) search.set("show", current.access);
  if (current.sort !== LIBRARY_DEFAULTS.sort) search.set("sort", current.sort);
  if (current.group) search.set("group", current.group);
  if (current.projectId) search.set("project", current.projectId);
  return `${base}${url.search}`;
}
export const pagesPath = (query = "") => libraryPath(PAGES_PATH, { query });
/** Index routes render from the shell alone; the editor chunk waits until a
 * Page opens. Home (/) is the library too but starts the editor at boot,
 * since a Page usually opens next. */
export const isIndexRoute = (route) => route?.kind === "projects" || route?.kind === "pages";
/** Both addresses of the Pages library. */
export const isLibraryRoute = (route) => route?.kind === "home" || route?.kind === "pages";
/** The path a library route keeps its view on. */
export const libraryBase = (route) => (route?.kind === "pages" ? PAGES_PATH : "/");

export function readPageRoute(input) {
  const url = new URL(input, "https://pages.invalid");
  if (/^\/projects\/?$/.test(url.pathname)) return { kind: "projects", path: PROJECTS_PATH };
  if (/^\/pages\/?$/.test(url.pathname)) {
    const library = readLibraryView(url.searchParams);
    return { kind: "pages", library, path: libraryPath(PAGES_PATH, library) };
  }
  // /s/<id> links predate the Project name; they open the Project's own path.
  const project = /^\/(?:project|s)\/([^/]+)\/?$/.exec(url.pathname);
  if (project)
    return isProjectId(project[1])
      ? { kind: "project", projectId: project[1], path: projectPath(project[1]) }
      : { kind: "missing" };
  // `path` is the Page's canonical address, without the slug; `slug` is the
  // one the address carries (isPageSlug), or null.
  const match = /^\/p\/([^/]+)(?:\/([^/]+))?\/?$/.exec(url.pathname);
  const legacy = url.pathname === "/" && url.searchParams.has("page");
  const id = match?.[1] ?? (legacy ? url.searchParams.get("page") : null);
  if (id !== null) {
    const slug = match?.[2] ?? null;
    if (!pageIdPattern.test(id) || (slug !== null && !isPageSlug(slug))) return { kind: "missing" };
    return { kind: "page", pageId: id, path: pagePath(id), slug };
  }
  if (url.pathname !== "/") return { kind: "missing" };
  const library = readLibraryView(url.searchParams);
  return { kind: "home", library, path: libraryPath("/", library) };
}

/**
 * The path a "Copy link" action copies for Page or Project `id`, with `href`
 * the address showing now and `title` the Page's title when the caller has
 * it. A Page link carries the title's slug (pageTitleSlug). When the title
 * gives none, or no title is passed, it keeps the slug the address shows for
 * that same Page, read through readPageRoute; with neither it is `/p/<id>`.
 * Either way the slug is one isPageSlug admits.
 */
export function copyLinkPath(id, href = globalThis.location?.href, title = null) {
  if (isProjectId(id)) return projectPath(id);
  return pagePath(id, pageTitleSlug(title) ?? shownSlug(id, href));
}

/** The slug address `href` shows for Page `id`, or null when it shows none
 * or shows something else. */
function shownSlug(id, href) {
  const shown = href ? readPageRoute(href) : null;
  return shown?.kind === "page" && shown.pageId === id ? shown.slug : null;
}

// Modified and auxiliary clicks retain normal browser link behavior.
export function isPlainNavigation(event) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** The fragment that names heading anchor `anchor`. */
export const anchorFragment = (anchor) => (anchor ? `#${encodeURIComponent(anchor)}` : "");

/**
 * Show Page or Project `id` in the address (`/` for none). `anchor` names a
 * heading to add as the fragment. Without one, a replace keeps the current
 * fragment: it rewrites the same visit's address into canonical form, and a
 * heading link that opened the Page still names its heading. `slug` is the
 * Page's slug when the caller knows its title (pageTitleSlug); without one, a
 * replace keeps the slug the address shows for the same Page, until the open
 * Page's title gives its own (viewer/address-slug.mjs). A push is a new
 * visit and starts with neither fragment nor shown slug.
 */
export function writePageRoute(id, options = {}) {
  const { anchor = null, slug: given = null, location = globalThis.location, ...rest } = options;
  const slug =
    id && !isProjectId(id)
      ? (given ?? (rest.replace ? shownSlug(id, location?.href) : null))
      : null;
  const path = id ? (isProjectId(id) ? projectPath(id) : pagePath(id, slug)) : "/";
  const fragment = !id
    ? ""
    : anchor
      ? anchorFragment(anchor)
      : rest.replace
        ? (location?.hash ?? "")
        : "";
  writeRoute(`${path}${fragment}`, { ...rest, location, state: { pageId: id ?? null } });
}

// A history entry's scroll position, in its state under SCROLL_STATE_KEY:
// `{ path, y }`, where `path` is the address (without fragment) it was
// measured at. The Page shown at an address swaps in place, so a position
// counts only for the address it was measured at, compared as sameScrollAddress
// does: a Page's slug names nothing, so the title's slug arriving in the
// address, or changing with a rename, keeps the position.
export const SCROLL_STATE_KEY = "scroll";

/** The part of `path` (pathname and search) a scroll position belongs to: a
 * Page route's canonical path, or `path` itself for any other route. */
const scrollAddress = (path) => {
  const route = readPageRoute(path);
  return route.kind === "page" ? route.path : path;
};
/** Whether a position measured at `a` counts at `b`. */
export const sameScrollAddress = (a, b) =>
  typeof a === "string" && typeof b === "string" && scrollAddress(a) === scrollAddress(b);

/** Record scroll position `y` in the current history entry. */
export function rememberScroll(
  y,
  { history = globalThis.history, location = globalThis.location } = {},
) {
  if (!Number.isFinite(y)) return;
  const path = `${location.pathname}${location.search}`;
  const saved = history.state?.[SCROLL_STATE_KEY];
  if (saved?.path === path && saved.y === y) return;
  history.replaceState({ ...history.state, [SCROLL_STATE_KEY]: { path, y } }, "");
}

/** The scroll position recorded for the current history entry, or null. */
export function savedScroll({ history = globalThis.history, location = globalThis.location } = {}) {
  const saved = history.state?.[SCROLL_STATE_KEY];
  return sameScrollAddress(saved?.path, `${location.pathname}${location.search}`) &&
    Number.isFinite(saved.y)
    ? saved.y
    : null;
}

/**
 * Push (or replace) `path` unless the address already shows it. A push first
 * records the current scroll position in the entry it leaves, so Back can
 * return to it, and starts the new entry without one. A replace keeps the
 * entry's position while the address (without fragment) stays the same, by
 * sameScrollAddress.
 */
export function writeRoute(
  path,
  {
    replace = false,
    state = null,
    history = globalThis.history,
    location = globalThis.location,
    scrollY = globalThis.scrollY,
  } = {},
) {
  if (`${location.pathname}${location.search}${location.hash}` === path) return;
  const saved = history.state?.[SCROLL_STATE_KEY];
  let next = state;
  if (next && SCROLL_STATE_KEY in next) {
    next = { ...next };
    delete next[SCROLL_STATE_KEY];
  }
  if (replace) {
    const url = new URL(path, "https://pages.invalid");
    if (saved && sameScrollAddress(saved.path, `${url.pathname}${url.search}`))
      next = { ...next, [SCROLL_STATE_KEY]: saved };
  } else rememberScroll(scrollY, { history, location });
  history[replace ? "replaceState" : "pushState"](next, "", path);
}

export function mergePageListings(remote, local) {
  const pages = new Map((remote ?? []).map((page) => [page.page_id, page]));
  for (const page of local) {
    if ((remote === null || page.pending) && !pages.has(page.page_id))
      pages.set(page.page_id, page);
  }
  return [...pages.values()];
}
