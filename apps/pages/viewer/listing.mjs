// Interprets listing-machine.mjs for the Pages library and /projects, and
// projects their rows.
//
// The store holds the machine state and the rows on screen. A page of rows
// reaches the store only through the machine's `show` effect (or `paint`, for
// rows remembered from earlier in this tab), so a superseded request can't
// overwrite a newer one.
//
// A listing does nothing while disconnected: React connects it on mount and
// disconnects it on unmount. Disconnecting abandons every request in flight,
// so a reply that lands after the screen is gone, or after the account
// changed, never reaches the store, the banner or `onShown`. Whatever a reply
// says besides its rows (list_pages' `quota` and `principal`) is handed on
// from the same `show` effect, so it follows the same rule.
import { Subject, asyncScheduler, debounceTime } from "rxjs";
import { failureMessage } from "./alerts.mjs";
import { listingMachine } from "./listing-machine.mjs";
import { Store } from "./store.mjs";
import { matchingPages } from "./page-list.mjs";
import {
  LIBRARY_DEFAULTS,
  libraryRequest,
  normalizePagesQuery,
  pageLinkPath,
  pageTitleSlug,
  projectPath,
} from "../shared/routes.mjs";

/** Rows per list_pages request in the library. */
export const PAGES_PER_REQUEST = 50;
/** list_projects' largest page. */
export const PROJECTS_PER_REQUEST = 100;
/** How long typing pauses before a search runs. */
export const SEARCH_DEBOUNCE_MS = 250;

const EMPTY = Object.freeze({ state: listingMachine.initial, items: Object.freeze([]) });
const DEFAULT_PARAMS = libraryRequest(LIBRARY_DEFAULTS);

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
  #cache;
  #onShown;
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
   * - fetch({ params, cursor }): one page as `{ items, cursor }`, cursor null
   *   at the end. A rejection reports `failed`. `params` is normalized
   *   (libraryRequest), so equal params mean the same rows.
   * - report(message): show a failure in the screen's banner.
   * - idOf(item): a row's stable id.
   *   A page may also name the `principal` that answered it and carry the
   *   account's `quota`.
   * - cache: `{ read(params), write(params, items, principal, revision),
   *   revision() }` (listing-cache.mjs scope), or null. A load whose params
   *   it holds rows for paints them while the first page is fetched again;
   *   each first page shown is written back with the principal that answered
   *   it and the cache revision its request began under, so a patch made
   *   while it was in flight wins.
   * - onShown({ items, principal, quota, append }): a page the machine
   *   accepted, as it reaches the screen. A superseded or abandoned reply
   *   never gets here.
   */
  constructor(
    { fetch, report = () => {}, idOf, cache = null, onShown = () => {} },
    {
      newKey = () => crypto.randomUUID(),
      debounce = SEARCH_DEBOUNCE_MS,
      scheduler = asyncScheduler,
    } = {},
  ) {
    this.#fetch = fetch;
    this.#report = report;
    this.#idOf = idOf;
    this.#cache = cache;
    this.#onShown = onShown;
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
        const params = this.params();
        if (query !== params.query) this.load({ ...params, query });
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
  /** What the listing lists, or would list first: the defaults until a load. */
  params() {
    return this.snapshot().state.params ?? DEFAULT_PARAMS;
  }
  /** List `params` from its first page now, superseding any request in
   * flight. Params follow libraryRequest, so the request, the address and
   * Back agree. Rows this tab showed for `params` before paint first. */
  load(params = DEFAULT_PARAMS) {
    if (!this.#connected) return false;
    const next = libraryRequest(params);
    const type = this.#cache?.read(next)?.length ? "restore" : "load";
    return this.#dispatch({ type, key: this.#newKey(), params: next });
  }
  /** List `query`, with the other params unchanged, once typing pauses
   * (while connected). */
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
      case "paint": {
        const items = this.#cache?.read(effect.params) ?? [];
        this.store.update((current) => ({ ...current, items }));
        return;
      }
      case "show": {
        const answer = this.#results.get(effect.key) ?? EMPTY_ANSWER;
        this.#results.delete(effect.key);
        const { items } = answer;
        if (!effect.append)
          this.#cache?.write(
            this.snapshot().state.params,
            items,
            answer.principal,
            answer.revision,
          );
        this.store.update((current) => ({
          ...current,
          items: effect.append ? appendRows(current.items, items, this.#idOf) : items,
        }));
        const { revision: _revision, ...shown } = answer;
        this.#onShown({ ...shown, append: effect.append });
        return;
      }
      case "report":
        return this.#report(effect.message);
    }
    throw new Error(`unknown effect ${effect.type}`);
  }
  #request({ key, params, cursor }) {
    const connection = this.#connection;
    const revision = this.#cache?.revision?.();
    const current = () => connection === this.#connection;
    let pending;
    try {
      pending = this.#fetch({ params, cursor });
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending).then(
      (page) => {
        if (!current()) return;
        this.#results.set(key, {
          items: Array.isArray(page?.items) ? page.items : [],
          principal: typeof page?.principal === "string" && page.principal ? page.principal : null,
          quota: page?.quota ?? null,
          revision,
        });
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

const EMPTY_ANSWER = Object.freeze({
  items: Object.freeze([]),
  principal: null,
  quota: null,
  revision: undefined,
});

const nextCursor = (result) =>
  typeof result?.next_cursor === "string" && result.next_cursor ? result.next_cursor : null;

/** One library request: the Pages the account can open, narrowed by
 * list_pages' title search, `access` and `project_id`, in its `sort` order.
 * Defaults stay off the wire, so the plain listing is the bare call. The
 * page carries the answer's `principal` and `quota` for the Listing to hand
 * on once it shows the page. */
export const pagesRequest =
  (call, { limit = PAGES_PER_REQUEST } = {}) =>
  async ({ params, cursor }) => {
    const { query, access, sort, projectId } = libraryRequest(params);
    const result = await call("list_pages", {
      limit,
      ...(query ? { query } : {}),
      ...(access ? { access } : {}),
      ...(sort !== LIBRARY_DEFAULTS.sort ? { sort } : {}),
      ...(projectId ? { project_id: projectId } : {}),
      ...(cursor ? { cursor } : {}),
    });
    return {
      items: result.pages ?? [],
      cursor: nextCursor(result),
      principal: result.principal ?? null,
      quota: result.quota ?? null,
    };
  };

/** One /projects request. list_projects has no search or filter, so
 * `params` is unused. `first()`, when given, answers the first page: the
 * shell's shared list_projects request (project-list.mjs), so /projects and
 * the shell never ask for it twice. */
export const projectsRequest =
  (call, { limit = PROJECTS_PER_REQUEST, first } = {}) =>
  async ({ cursor }) => {
    const result =
      !cursor && first
        ? await first()
        : await call("list_projects", { limit, ...(cursor ? { cursor } : {}) });
    return { items: result.projects ?? [], cursor: nextCursor(result) };
  };

/**
 * When a Page was last active: the time the Last activity sort orders by, so
 * the Last activity column and the date groups agree with the row order.
 * list_pages items carry `content_updated_at` (when the Page host last
 * accepted a content change, or null) and `updated_at` (when the catalog
 * entry last changed: a rename, move or share). The server's `activity_at`
 * key is `content_updated_at || updated_at` (worker/catalog-index.mjs
 * activityKey); a local draft carries only `updated_at`.
 */
export const activityAt = (page) => page?.content_updated_at || page?.updated_at || null;

/** A library row uses only the Project placement disclosed by the host.
 * Direct-only shares omit placement; Project members can retain it.
 * `local` marks a copy only this browser lists
 * (deviceRows): `pending` when it has never reached the server. */
export function pageRow(page, projectTitles = new Map(), { local = false } = {}) {
  const projectId = page.project_id ?? null;
  return {
    id: page.page_id,
    title: page.title || "Untitled",
    // A link carries the title's slug, and opening it in place pushes the
    // same address (onOpen's `slug`).
    href: pageLinkPath(page),
    slug: pageTitleSlug(page.title),
    activityAt: activityAt(page),
    // The grid keys a card by it, so an edit since the last ask asks again.
    contentUpdatedAt: page.content_updated_at ?? null,
    project: projectId
      ? {
          id: projectId,
          title: projectTitles.get(projectId) || "Project",
          href: projectPath(projectId),
        }
      : null,
    shared: page.shared === true,
    local: local ? (page.pending ? "pending" : "copy") : null,
  };
}

/**
 * The local catalog's Pages (local-catalog.mjs) the library shows above the
 * server's rows: drafts that haven't reached the server, and, when the
 * listing failed (offline), every copy this browser holds. They show on All
 * and Your items with no Project filter, since they carry no Project. The
 * server's search can't see them, so a search keeps those whose title holds
 * it (matchingPages, the Browse picker's rule). A copy the server rows
 * already hold shows once, as the server's row. Copies of shared Pages look
 * the same as owned ones locally, so the offline fallback shows on All only.
 * A Project's content document (`contents`, its document IDs) is never a
 * Page: the server never lists it, so its local copy would otherwise look
 * like a draft forever. `contents` comes from list_projects, so a copy can
 * still show until that answers, if it fails, or past its first 100 Projects.
 */
export function deviceRows(local, items, view, { failed = false, contents = new Set() } = {}) {
  if (view.projectId || view.access === "shared") return [];
  const listed = new Set([...items.map((page) => page.page_id), ...contents]);
  const kept = (local ?? []).filter(
    (page) => !listed.has(page.page_id) && (page.pending || (failed && view.access === null)),
  );
  return view.query ? matchingPages(kept, view.query) : kept;
}

/** Project titles by ID, for the Project label on library rows. */
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
  const params = state.params ?? DEFAULT_PARAMS;
  const busy = state.name === "idle" || state.name === "loading";
  return {
    // The first page is on its way and nothing from an earlier search shows.
    loading: busy && items.length === 0,
    // A new search runs while the previous rows still show.
    searching: busy && items.length > 0,
    // Rows remembered from earlier in this tab show while their first page
    // is fetched again. Nothing says so: they are the rows the account saw.
    refreshing: state.name === "refreshing",
    failed: state.name === "failed",
    // The server's code for a failed first page, or null.
    failureCode: state.name === "failed" ? state.code : null,
    empty: state.name === "ready" && items.length === 0,
    canLoadMore: state.name === "ready" && state.cursor !== null,
    loadingMore: state.name === "more",
    stalled: state.name === "stalled",
    query: params.query,
    params,
  };
}
