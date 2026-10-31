// Interprets listing-machine.mjs for the index routes, and projects their rows.
//
// The store holds the machine state and the rows on screen. A page of rows
// reaches the store only through the machine's `show` effect, so a superseded
// request can't overwrite a newer one.
//
// A listing does nothing while disconnected: React connects it on mount and
// disconnects it on unmount. Disconnecting abandons every request in flight,
// so a reply that lands after the screen is gone, or after the account
// changed, never reaches the store or the banner.
import { Subject, asyncScheduler, debounceTime } from "rxjs";
import { failureMessage } from "./alerts.mjs";
import { listingMachine } from "./listing-machine.mjs";
import { Store } from "./store.mjs";
import { normalizePagesQuery, pagePath, projectPath } from "../shared/routes.mjs";

/** Rows per list_pages request on /pages. */
export const PAGES_PER_REQUEST = 50;
/** list_projects' largest page. */
export const PROJECTS_PER_REQUEST = 100;
/** How long typing pauses before a search runs. */
export const SEARCH_DEBOUNCE_MS = 250;

const EMPTY = Object.freeze({ state: listingMachine.initial, items: Object.freeze([]) });

/** Appended rows keep the first occurrence of each id: an edit during
 * pagination can move a row onto the next page. */
export function appendRows(items, next, idOf) {
  const seen = new Set(items.map(idOf));
  const added = next.filter((item) => {
    const id = idOf(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return added.length ? [...items, ...added] : items;
}

export class Listing {
  store = new Store(EMPTY);
  #fetch;
  #report;
  #idOf;
  #newKey;
  #results = new Map();
  #searches = new Subject();
  #debounce;
  #scheduler;
  // Bumped by each disconnect; a request keeps the value it started under
  // and settles only while that value is current.
  #connection = 0;
  #connected = false;
  /**
   * - fetch({ query, cursor }): one page as `{ items, cursor }`, cursor null
   *   at the end. A rejection reports `failed`.
   * - report(message): show a failure in the screen's banner.
   * - idOf(item): a row's stable id.
   */
  constructor(
    { fetch, report = () => {}, idOf },
    {
      newKey = () => crypto.randomUUID(),
      debounce = SEARCH_DEBOUNCE_MS,
      scheduler = asyncScheduler,
    } = {},
  ) {
    this.#fetch = fetch;
    this.#report = report;
    this.#idOf = idOf;
    this.#newKey = newKey;
    this.#debounce = debounce;
    this.#scheduler = scheduler;
  }
  /** Run typed searches while connected. Returns the disconnect, for a React
   * effect's cleanup. */
  connect() {
    const connection = this.#connection;
    this.#connected = true;
    const subscription = this.#searches
      .pipe(debounceTime(this.#debounce, this.#scheduler))
      .subscribe((query) => {
        if (query !== this.snapshot().state.query) this.load(query);
      });
    return () => {
      subscription.unsubscribe();
      if (connection !== this.#connection) return;
      this.#connection++;
      this.#connected = false;
      this.#results.clear();
    };
  }
  snapshot() {
    return this.store.snapshot();
  }
  /** List `query` from its first page now. Queries follow
   * normalizePagesQuery, so the request, the address and Back agree. */
  load(query = "") {
    if (!this.#connected) return false;
    return this.#dispatch({ type: "load", key: this.#newKey(), query: normalizePagesQuery(query) });
  }
  /** List `query` once typing pauses (while connected). */
  search(query) {
    this.#searches.next(normalizePagesQuery(query));
  }
  /** The next page, or a retry of the one that stalled. */
  more() {
    if (!this.#connected) return false;
    return this.#dispatch({ type: "more", key: this.#newKey() });
  }
  #dispatch(event) {
    const result = listingMachine.step(this.snapshot().state, event);
    if (result.rejected) return false;
    this.store.update((current) => ({ ...current, state: result.state }));
    for (const effect of result.effects) this.#run(effect);
    return true;
  }
  #run(effect) {
    switch (effect.type) {
      case "fetch":
        return this.#request(effect);
      case "show": {
        const items = this.#results.get(effect.key) ?? [];
        this.#results.delete(effect.key);
        this.store.update((current) => ({
          ...current,
          items: effect.append ? appendRows(current.items, items, this.#idOf) : items,
        }));
        return;
      }
      case "report":
        return this.#report(effect.message);
    }
    throw new Error(`unknown effect ${effect.type}`);
  }
  #request({ key, query, cursor }) {
    const connection = this.#connection;
    const current = () => connection === this.#connection;
    let pending;
    try {
      pending = this.#fetch({ query, cursor });
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending).then(
      (page) => {
        if (!current()) return;
        this.#results.set(key, Array.isArray(page?.items) ? page.items : []);
        const next = typeof page?.cursor === "string" && page.cursor ? page.cursor : null;
        if (!this.#dispatch({ type: "loaded", key, cursor: next })) this.#results.delete(key);
      },
      (error) => {
        if (!current()) return;
        const code = typeof error?.code === "string" && error.code ? error.code : null;
        this.#dispatch({ type: "failed", key, message: failureMessage(error), code });
      },
    );
  }
}

const nextCursor = (result) =>
  typeof result?.next_cursor === "string" && result.next_cursor ? result.next_cursor : null;

/** One /pages request: every Page the account can open, newest first,
 * narrowed by list_pages' own title search. */
export const pagesRequest =
  (call, limit = PAGES_PER_REQUEST) =>
  async ({ query, cursor }) => {
    const text = normalizePagesQuery(query);
    const result = await call("list_pages", {
      limit,
      ...(text ? { query: text } : {}),
      ...(cursor ? { cursor } : {}),
    });
    return { items: result.pages ?? [], cursor: nextCursor(result) };
  };

/** One /projects request. list_projects has no search, so `query` is unused. */
export const projectsRequest =
  (call, limit = PROJECTS_PER_REQUEST) =>
  async ({ cursor }) => {
    const result = await call("list_projects", { limit, ...(cursor ? { cursor } : {}) });
    return { items: result.projects ?? [], cursor: nextCursor(result) };
  };

/** A /pages row. Owned Pages in a Project name it; a Project the account
 * can't list (or that hasn't loaded) still links by ID. Shared Pages never
 * reveal their Project. */
export function pageRow(page, projectTitles = new Map()) {
  const projectId = page.shared ? null : (page.project_id ?? null);
  return {
    id: page.page_id,
    title: page.title || "Untitled",
    href: pagePath(page.page_id),
    project: projectId
      ? {
          id: projectId,
          title: projectTitles.get(projectId) || "Project",
          href: projectPath(projectId),
        }
      : null,
    shared: page.shared === true,
    home: page.home === true,
  };
}

/** Project titles by ID, for the Project label on /pages rows. */
export const projectTitles = (projects) =>
  new Map((projects ?? []).map((project) => [project.project_id, project.title || "Untitled"]));

/** A /projects row. */
export function projectRow(project) {
  return {
    id: project.project_id,
    title: project.title || "Untitled",
    description: (project.description ?? "").trim(),
    href: projectPath(project.project_id),
  };
}

/** What a listing screen shows besides its rows. */
export function listingView({ state, items }) {
  const busy = state.name === "idle" || state.name === "loading";
  return {
    // The first page is on its way and nothing from an earlier search shows.
    loading: busy && items.length === 0,
    // A new search runs while the previous rows still show.
    searching: busy && items.length > 0,
    failed: state.name === "failed",
    empty: state.name === "ready" && items.length === 0,
    canLoadMore: state.name === "ready" && state.cursor !== null,
    loadingMore: state.name === "more",
    stalled: state.name === "stalled",
    query: state.query ?? "",
  };
}
