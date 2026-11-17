// The first page of each library view this tab has shown, kept in memory so
// a return visit (Back from a Page, a tab chosen again) paints it at once
// while the Listing asks for it again (listing-machine.mjs `restore`).
//
// Who an entry belongs to. Entries are keyed by account and the normalized
// request (libraryRequest), and a scope reads only its own account's entries.
// A page is written only under the account that answered it: list_pages
// names its `principal`, and a scope drops a page answered for anyone else
// (or for no one named), forgetting what it held for that view: the tab's
// account has just seen something else there.
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
// What keeps it current. The entries live in memory: a reload starts empty
// (the device cache below is a separate, narrower copy). The
// shell clears every entry on sign-out, on an account change and on any tool
// call the server refuses as signed out. It also patches entries after edits
// this tab made, so a return visit doesn't paint what it just changed: a
// rename overlays the new title (`retitle`), Trash drops the Page (`forget`),
// and a create, move or restore drops every view that lists the account's own
// Pages (`forgetOwnedViews`), since any of them may gain, lose or relabel a
// row. Views of Pages shared with the account can't change that way.
//
// A reply in flight across a patch. Every patch (`forget`, `retitle`,
// `forgetOwnedViews`, `clear`) moves the cache to a new `revision`. A Listing
// reads the revision when its request starts and hands it back with the
// write; a write from an older revision is refused, so a reply asked for
// before a create or move can't put back the rows the patch dropped.
//
// What reaches the device. The default view's first page (All, Last
// activity, no search, no Project) is also written to the library's device
// cache (library-device-cache.mjs), under the same account and revision
// rules, so a reload paints it before the server answers. `forget` and
// `retitle` patch it too. `forgetOwnedViews` leaves it: a device copy only
// paints while the server is asked again, and the next answer replaces it.
// `clear` leaves it; `clearDevice` removes it with everything else. The
// shell clears it on sign-out and account change, not on a 401 the session
// check hasn't settled yet.
import { LIBRARY_DEFAULTS, libraryRequest, sameLibraryRequest } from "../shared/routes.mjs";
import { libraryDevice } from "./library-device-cache.mjs";
import { monotonicNow } from "./monotonic.mjs";

/** How many views one tab remembers; the least recently shown goes first. */
export const LISTING_CACHE_LIMIT = 24;
/** How long after it was shown an entry still paints. */
export const LISTING_CACHE_MAX_AGE_MS = 5 * 60_000;

const DEFAULT_REQUEST = libraryRequest(LIBRARY_DEFAULTS);
/** Whether `params` is the one view the device cache keeps: the library's
 * default. A search, a tab, a sort or a Project stays in memory only. */
export const deviceView = (params) => sameLibraryRequest(libraryRequest(params), DEFAULT_REQUEST);

const keyOf = (principal, params) => {
  const { query, access, sort, projectId } = libraryRequest(params);
  return JSON.stringify([principal, query, access, sort, projectId]);
};

export class ListingCache {
  #entries = new Map();
  #revision = 0;
  #limit;
  #maxAge;
  #now;
  #device;
  /** `now()` is a monotonic clock in milliseconds (monotonic.mjs), so a
   * system clock change can't stretch or cut short the age limit; tests pass
   * a virtual one. `device` is the library's device cache
   * (library-device-cache.mjs), or null to keep everything in memory. */
  constructor({
    limit = LISTING_CACHE_LIMIT,
    maxAgeMs = LISTING_CACHE_MAX_AGE_MS,
    now = monotonicNow,
    device = null,
  } = {}) {
    this.#limit = limit;
    this.#maxAge = maxAgeMs;
    this.#now = now;
    this.#device = device;
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
   * An empty page forgets the view: there is nothing to paint. `revision` is
   * the one the page's request began under (`revision`); an older one, or
   * none, writes nothing. */
  write(principal, params, items, { revision } = {}) {
    if (!principal || revision === undefined || revision !== this.#revision) return;
    const key = keyOf(principal, params);
    this.#entries.delete(key);
    if (this.#device && deviceView(params)) void this.#device.write(principal, items);
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
  /** Moves with every patch. */
  get revision() {
    return this.#revision;
  }
  #patch(change) {
    this.#revision++;
    for (const [key, entry] of this.#entries) {
      const items = change(entry.items);
      if (items === entry.items) continue;
      if (items.length) this.#entries.set(key, { ...entry, items: Object.freeze(items) });
      else this.#entries.delete(key);
    }
  }
  /** Drop `pageId` from every remembered page (it moved to Trash). */
  forget(pageId) {
    void this.#device?.forget(pageId);
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
    void this.#device?.retitle(pageId, title);
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
    this.#revision++;
    for (const [key, entry] of this.#entries)
      if (entry.access !== "shared") this.#entries.delete(key);
  }
  /** Forget everything in memory: the account changed or signed out, or a
   * tool call was refused as signed out. A write from a request that began
   * before this is refused, the device cache's included. */
  clear() {
    this.#revision++;
    this.#entries.clear();
  }
  /** `clear`, and remove the device cache's records for every account: the
   * account signed out or changed. Resolves once the removal committed or
   * gave up (LibraryDeviceCache.clear), so a sign-out can wait for it before
   * it leaves the page. */
  clearDevice() {
    this.clear();
    return this.#device ? this.#device.clear() : Promise.resolve(true);
  }
  /** What a Listing takes for one account, or null when no one is signed
   * in. `write` files a page only when `answeredBy`, the principal the reply
   * named, is this account; any other reply forgets the view. Either way it
   * does nothing when `revision` (the one the request began under) is
   * missing or no longer current.
   *
   * `device`, when this cache has one, reads the account's device record
   * (`read()`, which never rejects) and keeps `page_cards` answers for its
   * rows (`cards(entries)`); `deviceView(params)` says whether `params` is
   * the view it keeps. A device read happens only through a scope, so only
   * for an account the session named. */
  scope(principal) {
    if (!principal) return null;
    const device = this.#device;
    return {
      read: (params) => this.read(principal, params),
      revision: () => this.#revision,
      write: (params, items, answeredBy, revision) =>
        this.write(principal, params, answeredBy === principal ? items : [], { revision }),
      deviceView,
      device: device
        ? {
            read: () => device.read(principal),
            cards: (entries) => void device.writeCards(principal, entries),
          }
        : null,
    };
  }
  get size() {
    return this.#entries.size;
  }
}

/** This tab's cache, shared by every library mount, over this browser's
 * library device cache. */
export const listingCache = new ListingCache({ device: libraryDevice });
