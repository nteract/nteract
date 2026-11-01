const pageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function pagePath(id) {
  if (!pageIdPattern.test(id ?? "")) throw Error("Invalid Page ID");
  return `/p/${id}`;
}

// New Projects get prj_ IDs; sp_ IDs predate the Project name and stay valid.
const projectIdPattern =
  /^(prj|sp)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isProjectId = (id) => projectIdPattern.test(id ?? "");

export function projectPath(id) {
  if (!isProjectId(id)) throw Error("Invalid Project ID");
  return `/project/${id}`;
}

// The two index routes list what the account can open: every Project, and
// every Page newest first. /pages keeps its search in `q` so Back restores it.
export const PROJECTS_PATH = "/projects";
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
export function pagesPath(query = "") {
  const text = normalizePagesQuery(query);
  return text ? `/pages?${new URLSearchParams({ q: text })}` : "/pages";
}
/** Index routes render from the shell alone; the editor chunk waits until a
 * Page opens. */
export const isIndexRoute = (route) => route?.kind === "projects" || route?.kind === "pages";

export function readPageRoute(input) {
  const url = new URL(input, "https://pages.invalid");
  if (/^\/projects\/?$/.test(url.pathname)) return { kind: "projects", path: PROJECTS_PATH };
  if (/^\/pages\/?$/.test(url.pathname)) {
    const query = normalizePagesQuery(url.searchParams.get("q"));
    return { kind: "pages", query, path: pagesPath(query) };
  }
  // /s/<id> links predate the Project name; they open the Project's own path.
  const project = /^\/(?:project|s)\/([^/]+)\/?$/.exec(url.pathname);
  if (project)
    return isProjectId(project[1])
      ? { kind: "project", projectId: project[1], path: projectPath(project[1]) }
      : { kind: "missing" };
  const match = /^\/p\/([^/]+)\/?$/.exec(url.pathname);
  const legacy = url.pathname === "/" && url.searchParams.has("page");
  const id = match?.[1] ?? (legacy ? url.searchParams.get("page") : null);
  if (id !== null) {
    if (!pageIdPattern.test(id)) return { kind: "missing" };
    return { kind: "page", pageId: id, path: pagePath(id) };
  }
  return url.pathname === "/" ? { kind: "home", path: "/" } : { kind: "missing" };
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

export function writePageRoute(id, options = {}) {
  const path = id ? (isProjectId(id) ? projectPath(id) : pagePath(id)) : "/";
  writeRoute(path, { ...options, state: { pageId: id ?? null } });
}

/** Push (or replace) `path` unless the address already shows it. */
export function writeRoute(
  path,
  {
    replace = false,
    state = null,
    history = globalThis.history,
    location = globalThis.location,
  } = {},
) {
  if (`${location.pathname}${location.search}${location.hash}` === path) return;
  history[replace ? "replaceState" : "pushState"](state, "", path);
}

export function mergePageListings(remote, local) {
  const pages = new Map((remote ?? []).map((page) => [page.page_id, page]));
  for (const page of local) {
    if ((remote === null || page.pending) && !pages.has(page.page_id))
      pages.set(page.page_id, page);
  }
  return [...pages.values()];
}

// One catalog refresh's listing. The remote result and the local snapshot each
// replace their previous value whole, in whichever order they arrive, and the
// listing is recomputed from both. An entry the newer snapshot no longer holds
// (moved to Trash, deleted, forgotten) leaves the listing.
export function pageListing(remote, local) {
  let remotePages = remote,
    localPages = local;
  return {
    get pages() {
      return mergePageListings(remotePages, localPages);
    },
    remote(value) {
      remotePages = value;
      return this.pages;
    },
    local(value) {
      localPages = value;
      return this.pages;
    },
  };
}
