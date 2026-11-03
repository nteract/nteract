import { isTransientFailure } from "./request.mjs";

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
 * reachable until the session connects. `connectionGeneration` counts the
 * session's accepted connections, so each reconnect is a change. */
const reachability = (session) =>
  `${session.localPage?.registration ? !!session.localPage.registered : true}:${
    session.connectionGeneration ?? (session.connection ? 1 : 0)
  }`;

/** How many times a transient failure is asked again under one
 * reachability, and the first wait; each wait doubles. */
export const LOCATION_RETRIES = 3;
export const LOCATION_RETRY_MS = 2000;

/**
 * Find where `session`'s Page is, and ask again until it is found.
 *
 * read_page refuses a Page created in this tab, or a draft made offline,
 * until it registers, and can fail while the session is offline. A failed ask
 * waits for the session's reachability (registered, connection generation)
 * to change, then asks again, at most once per reachability. A transient
 * failure (isTransientFailure: a restart, a gateway, a lost connection) also
 * asks again after 2, 4 and 8 seconds under the same reachability, and then
 * waits for a change like any other.
 *
 * States: waiting (`asked` names the reachability last asked under, `tries`
 * the transient retries spent on it), asking, backoff (a retry is scheduled),
 * found and stopped. `found` and `stopped` are terminal.
 *
 * `locate()` is read_page through pageLocation; `onFound(location)` hears the
 * answer once, while `current()` holds. Call `changed()` whenever the session
 * notifies; `stop()` ends it. `schedule(fn, ms)` returns a cancel function
 * (setTimeout by default; tests pass a virtual one).
 */
export function watchPageLocation(
  session,
  {
    locate,
    onFound,
    current,
    transient = isTransientFailure,
    schedule = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  },
) {
  let state = { name: "waiting", asked: null, tries: 0 };
  const run = (asked, tries) => {
    state = { name: "asking", asked, tries };
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
      (error) => {
        if (state.name !== "asking") return;
        if (reachability(session) === asked && transient(error) && tries < LOCATION_RETRIES) {
          const cancel = schedule(
            () => {
              if (state.name !== "backoff" || !current()) return;
              run(asked, tries + 1);
            },
            LOCATION_RETRY_MS * 2 ** tries,
          );
          state = { name: "backoff", asked, tries, cancel };
          return;
        }
        state = { name: "waiting", asked, tries };
        // Reachability may have changed while the ask was in flight.
        ask();
      },
    );
  };
  const ask = () => {
    if (!current()) return;
    const reach = reachability(session);
    if (state.name === "backoff" && reach !== state.asked) {
      // A change beats the scheduled retry: ask under it now.
      state.cancel();
      run(reach, 0);
      return;
    }
    if (state.name !== "waiting" || reach === state.asked) return;
    run(reach, 0);
  };
  ask();
  return {
    changed: ask,
    stop: () => {
      if (state.name === "backoff") state.cancel();
      state = { name: "stopped" };
    },
  };
}

/** Breadcrumbs for an open Page, limited to what this account can open. */
export async function pageBreadcrumbs(call, pageId) {
  return (await pageLocation(call, pageId)).breadcrumbs;
}
