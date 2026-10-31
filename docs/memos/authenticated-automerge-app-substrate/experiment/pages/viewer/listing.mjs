// Interprets listing-machine.mjs for the index routes, and projects their rows.
//
// The store holds the machine state and the rows on screen. A page of rows
// reaches the store only through the machine's `show` effect, so a superseded
// request can't overwrite a newer one.
import { Subject, asyncScheduler, debounceTime } from "rxjs";
import { failureMessage } from "./alerts.mjs";
import { listingMachine } from "./listing-machine.mjs";
import { Store } from "./store.mjs";
import { pagePath, projectPath } from "../shared/routes.mjs";

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
    const subscription = this.#searches
      .pipe(debounceTime(this.#debounce, this.#scheduler))
      .subscribe((query) => {
        if (query !== this.snapshot().state.query) this.load(query);
      });
    return () => subscription.unsubscribe();
  }
  snapshot() {
    return this.store.snapshot();
  }
  /** List `query` from its first page now. */
  load(query = "") {
    return this.#dispatch({ type: "load", key: this.#newKey(), query: query.trim() });
  }
  /** List `query` once typing pauses (while connected). */
  search(query) {
    this.#searches.next(query.trim());
  }
  /** The next page, or a retry of the one that stalled. */
  more() {
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
    let pending;
    try {
      pending = this.#fetch({ query, cursor });
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending).then(
      (page) => {
        this.#results.set(key, Array.isArray(page?.items) ? page.items : []);
        const next = typeof page?.cursor === "string" && page.cursor ? page.cursor : null;
        if (!this.#dispatch({ type: "loaded", key, cursor: next })) this.#results.delete(key);
      },
      (error) => this.#dispatch({ type: "failed", key, message: failureMessage(error) }),
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
    const result = await call("list_pages", {
      limit,
      ...(query ? { query } : {}),
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
