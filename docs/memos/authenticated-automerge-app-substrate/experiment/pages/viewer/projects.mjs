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

/** What decides whether read_page can find a session's Page: a draft made in
 * this tab or offline isn't on the server until it registers, and nothing is
 * reachable until the session connects. */
const reachability = (session) =>
  `${session.localPage?.registration ? !!session.localPage.registered : true}:${!!session.connection}`;

/**
 * Find where `session`'s Page is, and ask again until it is found.
 *
 * read_page refuses a Page created in this tab, or a draft made offline,
 * until it registers, and can fail while the session is offline. A failed
 * ask waits for the session's reachability (registered, connected) to change
 * and then asks again; an ask never runs twice for the same reachability, so
 * a Page read_page keeps refusing costs one request per change. States:
 * waiting (no ask in flight; `asked` names the reachability last asked
 * under), asking, found, stopped. `found` and `stopped` are terminal.
 *
 * `locate()` is read_page through pageLocation; `onFound(location)` hears the
 * answer once, while `current()` holds. Call `changed()` whenever the session
 * notifies; `stop()` ends it.
 */
export function watchPageLocation(session, { locate, onFound, current }) {
  let state = { name: "waiting", asked: null };
  const ask = () => {
    if (state.name !== "waiting" || !current()) return;
    const asked = reachability(session);
    if (asked === state.asked) return;
    state = { name: "asking", asked };
    let pending;
    try {
      pending = Promise.resolve(locate());
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (location) => {
        if (state.name !== "asking") return;
        state = { name: "found" };
        if (current()) onFound(location);
      },
      () => {
        if (state.name !== "asking") return;
        state = { name: "waiting", asked };
        // Reachability may have changed while the ask was in flight.
        ask();
      },
    );
  };
  ask();
  return {
    changed: ask,
    stop: () => {
      state = { name: "stopped" };
    },
  };
}

/** Breadcrumbs for an open Page, limited to what this account can open. */
export async function pageBreadcrumbs(call, pageId) {
  return (await pageLocation(call, pageId)).breadcrumbs;
}
