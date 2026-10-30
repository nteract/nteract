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

export function readPageRoute(input) {
  const url = new URL(input, "https://pages.invalid");
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

export function writePageRoute(
  id,
  { replace = false, history = globalThis.history, location = globalThis.location } = {},
) {
  const path = id ? (isProjectId(id) ? projectPath(id) : pagePath(id)) : "/";
  if (`${location.pathname}${location.search}${location.hash}` === path) return;
  history[replace ? "replaceState" : "pushState"]({ pageId: id ?? null }, "", path);
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
