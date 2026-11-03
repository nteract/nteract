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

/** Crumbs to show: a Project's home Page stands for its Project, so a home
 * crumb right after its Project crumb is dropped. A home crumb with no Project
 * crumb before it stays, so the chain still leads somewhere. */
export function visibleCrumbs(crumbs) {
  return crumbs.filter((crumb, index) => !(crumb.home && crumbs[index - 1]?.kind === "project"));
}

/** Where an open Page is, from read_page: `{ project_id, parent_id, home,
 * breadcrumbs }`, limited to what this account can open. project_id and
 * parent_id are null when absent; a Project's top-level Page has its home
 * Page as parent_id. */
export async function pageLocation(call, pageId) {
  const result = await call("read_page", {
    page_id: pageId,
    include_content: false,
    comments: "none",
    outline_limit: 1,
  });
  return {
    project_id: result.project_id ?? null,
    parent_id: result.parent_id ?? null,
    home: result.home === true,
    breadcrumbs: Array.isArray(result.breadcrumbs) ? result.breadcrumbs : [],
  };
}

/** Breadcrumbs for an open Page, limited to what this account can open. */
export async function pageBreadcrumbs(call, pageId) {
  return (await pageLocation(call, pageId)).breadcrumbs;
}
