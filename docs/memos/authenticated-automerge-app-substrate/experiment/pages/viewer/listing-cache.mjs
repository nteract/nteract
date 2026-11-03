// The first page of each library view this tab has shown, kept in memory so
// a return visit (Back from a Page, a tab chosen again) paints it at once
// while the Listing asks for it again (listing-machine.mjs `restore`).
//
// Who an entry belongs to. Entries are keyed by account and the normalized
// request (libraryRequest), and a scope reads only its own account's entries.
// A page is written only under the account that answered it: list_pages
// names its `principal`, and a scope drops a page answered for anyone else.
// The tab's account can lag the cookie (another window signed in as someone
// else), so the tab's account alone can't file a reply.
//
// How long an entry paints. Shared rows reach this tab only after their Page
// host confirmed access, and access can be revoked at any time. So an entry
// paints for `maxAgeMs` (5 minutes) after the page it holds was shown, and no
// longer: a shared title repaints only within 5 minutes of being shown in this
// tab. An older entry doesn't seed the view, which shows its normal loading
// state. Painting an entry doesn't renew it; only a fresh first page does.
//
// What a failed refresh shows. A remembered view whose refresh fails lists
// nothing (listing-machine.mjs `refreshing`/`failed`), like a first visit that
// fails. The failure may be the server refusing this account or a Page host
// it can't confirm; rows painted as current over that would claim access the
// server just didn't confirm. The entry itself stays, under the same age
// limit, and a 401 clears everything (see below).
//
// What keeps it current. Nothing is persisted: a reload starts empty. The
// shell clears every entry on sign-out, on an account change and on any tool
// call the server refuses as signed out. It also patches entries after edits
// this tab made, so a return visit doesn't paint what it just changed: a
// rename overlays the new title (`retitle`), Trash drops the Page (`forget`),
// and a create, move or restore drops every view that lists the account's own
// Pages (`forgetOwnedViews`), since any of them may gain, lose or relabel a
// row. Views of Pages shared with the account can't change that way.
import { libraryRequest } from "../shared/routes.mjs";

/** How many views one tab remembers; the least recently shown goes first. */
export const LISTING_CACHE_LIMIT = 24;
/** How long after it was shown an entry still paints. */
export const LISTING_CACHE_MAX_AGE_MS = 5 * 60_000;

const keyOf = (principal, params) => {
  const { query, access, sort, projectId } = libraryRequest(params);
  return JSON.stringify([principal, query, access, sort, projectId]);
};

export class ListingCache {
  #entries = new Map();
  #limit;
  #maxAge;
  #now;
  /** `now()` is the clock in milliseconds; tests pass a virtual one. */
  constructor({
    limit = LISTING_CACHE_LIMIT,
    maxAgeMs = LISTING_CACHE_MAX_AGE_MS,
    now = () => Date.now(),
  } = {}) {
    this.#limit = limit;
    this.#maxAge = maxAgeMs;
    this.#now = now;
  }
  /** The rows `principal` was shown on the first page of `params` within
   * the age limit, or null. An expired entry is dropped. */
  read(principal, params) {
    if (!principal) return null;
    const key = keyOf(principal, params);
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (this.#now() - entry.shownAt > this.#maxAge) {
      this.#entries.delete(key);
      return null;
    }
    return entry.items;
  }
  /** Remember the first page `principal` was shown for `params`, from now.
   * An empty page forgets the view: there is nothing to paint. */
  write(principal, params, items) {
    if (!principal) return;
    const key = keyOf(principal, params);
    this.#entries.delete(key);
    if (!Array.isArray(items) || items.length === 0) return;
    this.#entries.set(key, {
      principal,
      access: libraryRequest(params).access,
      shownAt: this.#now(),
      items: Object.freeze([...items]),
    });
    while (this.#entries.size > this.#limit)
      this.#entries.delete(this.#entries.keys().next().value);
  }
  #patch(change) {
    for (const [key, entry] of this.#entries) {
      const items = change(entry.items);
      if (items === entry.items) continue;
      if (items.length) this.#entries.set(key, { ...entry, items: Object.freeze(items) });
      else this.#entries.delete(key);
    }
  }
  /** Drop `pageId` from every remembered page (it moved to Trash). */
  forget(pageId) {
    this.#patch((items) =>
      items.some((page) => page.page_id === pageId)
        ? items.filter((page) => page.page_id !== pageId)
        : items,
    );
  }
  /** Show `title` for `pageId` wherever it is remembered (this tab renamed
   * it, or saw it renamed while it was open). */
  retitle(pageId, title) {
    if (typeof title !== "string") return;
    this.#patch((items) =>
      items.some((page) => page.page_id === pageId && page.title !== title)
        ? items.map((page) => (page.page_id === pageId ? { ...page, title } : page))
        : items,
    );
  }
  /** Forget every view that lists the account's own Pages (All and Your
   * items, with or without a Project or search): a create, move or restore
   * changed which rows they hold. Shared-only views stay. */
  forgetOwnedViews() {
    for (const [key, entry] of this.#entries)
      if (entry.access !== "shared") this.#entries.delete(key);
  }
  /** Forget everything: the account changed or signed out. */
  clear() {
    this.#entries.clear();
  }
  /** The read/write pair a Listing takes for one account, or null when no one
   * is signed in. `write` files a page only when `answeredBy`, the principal
   * the reply named, is this account. */
  scope(principal) {
    if (!principal) return null;
    return {
      read: (params) => this.read(principal, params),
      write: (params, items, answeredBy) => {
        if (answeredBy === principal) this.write(principal, params, items);
      },
    };
  }
  get size() {
    return this.#entries.size;
  }
}

/** This tab's cache, shared by every library mount. */
export const listingCache = new ListingCache();
