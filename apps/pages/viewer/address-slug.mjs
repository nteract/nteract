// The open Page's title in the address bar: `/p/<id>/<slug>`, with the slug
// pageTitleSlug derives from the title (shared/routes.mjs).
//
// The address follows the title, a rename typed here or one arriving from
// another tab or person, once ADDRESS_SLUG_DEBOUNCE_MS pass with no further
// title change. Titles arrive per keystroke and Safari throws after 100
// history.replaceState calls in 30 seconds, so nothing writes per keystroke.
// The write is a replace in place: the fragment and the entry's history
// state stay, and no history entry is added. A title with no slug leaves the
// address as it is. The timer runs through an RxJS scheduler, so tests drive
// it on virtual time.
//
// This module reaches neither Automerge nor the editor, so the shell
// (main.jsx) imports it directly.
import { Subject, debounceTime, distinctUntilChanged } from "rxjs";
import { pagePath, pageTitleSlug, readPageRoute } from "../shared/routes.mjs";

/** Quiet time after the last title change before the address follows it. */
export const ADDRESS_SLUG_DEBOUNCE_MS = 1_000;

/**
 * The address to show for Page `pageId` titled `title`, with `href` the
 * address showing now, or null to leave it alone. Only a `/p/<id>` address
 * for that same Page changes, and only its path: the title's slug replaces
 * whatever slug it shows, and its search and fragment stay. Null when the
 * title gives no slug, or the path already carries it.
 */
export function addressSlugPath(href, pageId, title) {
  if (typeof href !== "string" || !pageId) return null;
  const url = new URL(href, "https://pages.invalid");
  const route = readPageRoute(url.href);
  if (route.kind !== "page" || route.pageId !== pageId || !url.pathname.startsWith("/p/"))
    return null;
  const slug = pageTitleSlug(title);
  if (slug === null) return null;
  const path = pagePath(pageId, slug);
  return url.pathname === path ? null : `${path}${url.search}${url.hash}`;
}

/** The title `session` shows now, or null while it has no document or hides
 * its Page. */
export const sessionTitle = (session) =>
  session && !session.hidden && typeof session.doc?.title === "string" ? session.doc.title : null;

/**
 * Keep the address on `session`'s title while the session is open. `session`
 * is a PageSession: its `pageId`, `doc`, `hidden` and `subscribe`. Returns the
 * stop function; nothing is written after it runs.
 */
export function followTitleInAddress(
  session,
  { history = globalThis.history, location = globalThis.location, scheduler } = {},
) {
  if (!history || !location) return () => {};
  const titles = new Subject();
  const subscription = titles
    .pipe(distinctUntilChanged(), debounceTime(ADDRESS_SLUG_DEBOUNCE_MS, scheduler))
    .subscribe((title) => {
      const path = addressSlugPath(location.href, session.pageId, title);
      if (path !== null) history.replaceState(history.state, "", path);
    });
  const report = () => {
    const title = sessionTitle(session);
    if (title !== null) titles.next(title);
  };
  const unsubscribe = session.subscribe(report);
  report();
  return () => {
    unsubscribe();
    subscription.unsubscribe();
  };
}
