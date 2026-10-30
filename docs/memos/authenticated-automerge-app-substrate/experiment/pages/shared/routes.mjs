const pageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function pagePath(id) {
  if (!pageIdPattern.test(id ?? "")) throw Error("Invalid Page ID");
  return `/p/${id}`;
}

const spaceIdPattern = /^sp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function spacePath(id) {
  if (!spaceIdPattern.test(id ?? "")) throw Error("Invalid Space ID");
  return `/s/${id}`;
}

export function readPageRoute(input) {
  const url = new URL(input, "https://pages.invalid");
  const space = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
  if (space)
    return spaceIdPattern.test(space[1])
      ? { kind: "space", spaceId: space[1], path: spacePath(space[1]) }
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
  const path = id ? (id.startsWith("sp_") ? spacePath(id) : pagePath(id)) : "/";
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
