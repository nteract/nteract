import { retryKey } from "../model/retry-key.mjs";

/** Projects this account can open. A failed listing shows none instead of
 * blocking the Page list. */
export async function listProjects(call) {
  const result = await call("list_projects", { limit: 100 });
  return result.projects ?? [];
}

/** Every Page of one Project, following list_pages cursors. */
export async function listProjectPages(call, projectId, { maxRequests = 10 } = {}) {
  const pages = new Map();
  let cursor;
  for (let request = 0; request < maxRequests; request++) {
    const result = await call("list_pages", {
      project_id: projectId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const page of result.pages ?? [])
      if (!pages.has(page.page_id)) pages.set(page.page_id, page);
    cursor = result.next_cursor;
    if (typeof cursor !== "string") break;
  }
  return [...pages.values()];
}

/** Rows for a Project view: the home Page first with the Pages nested under
 * it, then the other top-level Pages, each followed by its descendants in
 * position order. A Page whose parent is missing (in Trash, or not listed)
 * shows at the top level. */
export function projectTree(pages) {
  const ids = new Set(pages.map((page) => page.page_id));
  const children = new Map();
  for (const page of pages) {
    const parent = page.parent_id && ids.has(page.parent_id) ? page.parent_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(page);
  }
  const order = (a, b) =>
    Number(!!b.home) - Number(!!a.home) ||
    ((a.position ?? "") === (b.position ?? "")
      ? a.page_id.localeCompare(b.page_id)
      : (a.position ?? "") < (b.position ?? "")
        ? -1
        : 1);
  const rows = [];
  const seen = new Set();
  const visit = (parent, depth) => {
    for (const page of (children.get(parent) ?? []).sort(order)) {
      if (seen.has(page.page_id)) continue;
      seen.add(page.page_id);
      rows.push({ page, depth });
      if (depth < 8) visit(page.page_id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** Create an empty Page at a Project's top level and return its receipt. */
export async function createPageInProject(call, projectId) {
  const prepared = await call("list_projects", { limit: 1 });
  return call("create_page", {
    title: "Untitled",
    project_id: projectId,
    retry_token: prepared.retry_token,
    idempotency_key: await retryKey(prepared.retry_token),
  });
}

/** Deepest nesting the server allows; a top-level Page is at depth 1. */
const MAX_DEPTH = 8;

/**
 * Rows for the "Move to…" picker: Your items, then each Project's top level
 * followed by its Pages to nest under, in Project-view order. `pages` are
 * this account's listing rows (owned rows carry project_id and parent_id).
 * A row is disabled, with a reason, when it is where the Page already is,
 * when it is the Page or one of its sub-pages, or when the Page's subtree
 * would nest too deep there. The server checks the same rules.
 */
export function moveDestinations({ pageId, projects, pages }) {
  const moving = pages.find((page) => page.page_id === pageId);
  const current = {
    project_id: moving?.project_id ?? null,
    parent_id: moving?.parent_id ?? null,
  };
  const children = new Map();
  for (const page of pages) {
    if (!page.parent_id) continue;
    if (!children.has(page.parent_id)) children.set(page.parent_id, []);
    children.get(page.parent_id).push(page.page_id);
  }
  const subtree = new Set();
  let height = 0;
  for (let level = [pageId], depth = 0; level.length && depth <= MAX_DEPTH; depth++) {
    const next = [];
    for (const id of level) {
      if (subtree.has(id)) continue;
      subtree.add(id);
      height = depth;
      next.push(...(children.get(id) ?? []));
    }
    level = next;
  }
  const here = (projectId, parentId) =>
    current.project_id === projectId && current.parent_id === parentId;
  const rows = [
    {
      key: "your-items",
      label: "Your items",
      depth: 0,
      project_id: null,
      parent_id: null,
      disabled: here(null, null),
      ...(here(null, null) && { reason: "Current location" }),
    },
  ];
  const sorted = [...projects].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
  for (const project of sorted) {
    const top = here(project.project_id, null);
    rows.push({
      key: `project:${project.project_id}`,
      label: project.title || "Untitled",
      depth: 0,
      project_id: project.project_id,
      parent_id: null,
      disabled: top,
      ...(top && { reason: "Current location" }),
    });
    const inProject = pages.filter((page) => page.project_id === project.project_id);
    for (const { page, depth } of projectTree(inProject)) {
      // The row's Page is at depth + 1; the moved Page would sit one below.
      const reason = subtree.has(page.page_id)
        ? "Can't move a Page under itself"
        : here(project.project_id, page.page_id)
          ? "Current location"
          : depth + 2 + height > MAX_DEPTH
            ? "Too deeply nested"
            : undefined;
      rows.push({
        key: `page:${page.page_id}`,
        label: page.title || "Untitled",
        depth: depth + 1,
        project_id: project.project_id,
        parent_id: page.page_id,
        disabled: reason !== undefined,
        ...(reason && { reason }),
        ...(page.home && { home: true }),
      });
    }
  }
  return rows;
}

/** Move a Page with fresh catalog retry authority from list_pages. */
export async function movePage(call, pageId, destination) {
  const prepared = await call("list_pages", { limit: 1 });
  if (typeof prepared?.retry_token !== "string") throw Error("Could not prepare the move");
  return call("move_page", {
    page_id: pageId,
    project_id: destination.project_id,
    ...(destination.parent_id && { parent_id: destination.parent_id }),
    retry_token: prepared.retry_token,
    idempotency_key: await retryKey(prepared.retry_token),
  });
}

/** Crumbs to show: a Project's home Page stands for its Project, so a home
 * crumb right after its Project crumb is dropped. A home crumb with no Project
 * crumb before it stays, so the chain still leads somewhere. */
export function visibleCrumbs(crumbs) {
  return crumbs.filter((crumb, index) => !(crumb.home && crumbs[index - 1]?.kind === "project"));
}

/** An open Page's placement as this account can see it: breadcrumbs, its
 * Project and parent, and whether it is a Project's home Page. */
export async function pagePlacement(call, pageId) {
  const result = await call("read_page", {
    page_id: pageId,
    include_content: false,
    comments: "none",
    outline_limit: 1,
  });
  return {
    page_id: pageId,
    breadcrumbs: Array.isArray(result.breadcrumbs) ? result.breadcrumbs : [],
    project_id: result.project_id ?? null,
    parent_id: result.parent_id ?? null,
    home: result.home === true,
  };
}

/** Breadcrumbs for an open Page, limited to what this account can open. */
export async function pageBreadcrumbs(call, pageId) {
  return (await pagePlacement(call, pageId)).breadcrumbs;
}
