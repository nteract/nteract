// The first page of each library view this tab has shown, kept in memory so
// a return visit (Back from a Page, a tab chosen again) paints it at once
// while the Listing asks for it again (listing-machine.mjs `restore`).
//
// Entries are keyed by the signed-in account and the normalized request
// (libraryRequest), and a scope only reads its own account's entries. Nothing
// is persisted: a reload starts empty. The shell clears every entry when the
// account changes or signs out, and forgets a Page it moved to Trash so a
// return visit doesn't paint it.
import { libraryRequest } from "../shared/routes.mjs";

/** How many views one tab remembers; the least recently shown goes first. */
export const LISTING_CACHE_LIMIT = 24;

const keyOf = (principal, params) => {
  const { query, access, sort, projectId } = libraryRequest(params);
  return JSON.stringify([principal, query, access, sort, projectId]);
};

export class ListingCache {
  #entries = new Map();
  #limit;
  constructor({ limit = LISTING_CACHE_LIMIT } = {}) {
    this.#limit = limit;
  }
  /** The rows `principal` saw on the first page of `params`, or null. */
  read(principal, params) {
    if (!principal) return null;
    return this.#entries.get(keyOf(principal, params))?.items ?? null;
  }
  /** Remember the first page `principal` was shown for `params`. An empty
   * page forgets the view: there is nothing to paint. */
  write(principal, params, items) {
    if (!principal) return;
    const key = keyOf(principal, params);
    this.#entries.delete(key);
    if (!Array.isArray(items) || items.length === 0) return;
    this.#entries.set(key, { principal, items: Object.freeze([...items]) });
    while (this.#entries.size > this.#limit)
      this.#entries.delete(this.#entries.keys().next().value);
  }
  /** Drop `pageId` from every remembered page (it moved to Trash). */
  forget(pageId) {
    for (const [key, entry] of this.#entries) {
      const items = entry.items.filter((page) => page.page_id !== pageId);
      if (items.length === entry.items.length) continue;
      if (items.length) this.#entries.set(key, { ...entry, items: Object.freeze(items) });
      else this.#entries.delete(key);
    }
  }
  /** Forget everything: the account changed or signed out. */
  clear() {
    this.#entries.clear();
  }
  /** The read/write pair a Listing takes for one account, or null when no one
   * is signed in. */
  scope(principal) {
    if (!principal) return null;
    return {
      read: (params) => this.read(principal, params),
      write: (params, items) => this.write(principal, params, items),
    };
  }
  get size() {
    return this.#entries.size;
  }
}

/** This tab's cache, shared by every library mount. */
export const listingCache = new ListingCache();
