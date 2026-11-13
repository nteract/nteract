// Links to headings, in the browser: reading a fragment, telling an in-app
// link from an outside one, finding a heading's element, and the state of a
// scroll to it. Anchors themselves come from model/heading-anchors.mjs.
//
// This module reaches neither Automerge nor the editor, so the shell
// (main.jsx) can import it before the editor chunk loads.
import { anchorFromHash, appRoute } from "../shared/page-links.mjs";
import { readPageRoute } from "../shared/routes.mjs";

export { anchorFromHash };

/**
 * Where a link in Page content goes, when this app can show it without a
 * reload: `{ route, anchor, samePage }`, or null for a link the browser
 * should follow. `route` is readPageRoute's answer (a Page or a Project);
 * `samePage` says the link names what `base`, the address showing now,
 * shows, with the same search: only its fragment changes. A slug on either
 * side doesn't count, since it names nothing. Which links count is shared/page-links.mjs's one
 * test (appRoute), so a link opens in place exactly when it gets the Page
 * glyph or is a Project link.
 */
export function inAppLink(href, base) {
  const target = appRoute(href, base);
  if (!target) return null;
  const { route, url } = target;
  const here = new URL(base);
  const shown = readPageRoute(here.href);
  const same =
    route.kind === "page"
      ? shown.kind === "page" && shown.pageId === route.pageId
      : shown.kind === "project" && shown.projectId === route.projectId;
  return {
    route,
    anchor: anchorFromHash(url.hash),
    samePage: url.search === here.search && (same || url.pathname === here.pathname),
  };
}

/** The heading `anchor` names in `anchors` (pageHeadingAnchors' list). An
 * exact match wins; a hand-typed fragment that differs only in case still
 * finds its heading. */
export function headingForAnchor(anchors, anchor) {
  if (!anchor) return null;
  const list = anchors ?? [];
  const exact = list.find((entry) => entry.anchor === anchor);
  if (exact) return exact;
  const folded = anchor.toLowerCase();
  return list.find((entry) => entry.anchor === folded) ?? null;
}

export const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/** The block's editor content: its first Wordgard content element. */
const blockContent = (root, blockId) =>
  root?.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)?.querySelector("wg-content") ??
  null;

/** The drawn element of heading `entry` ({ blockId, index }) under `root`,
 * or null while its block hasn't drawn it. The editor draws every heading
 * marker as an h1–h6, so the index-th one in the block is the heading. */
export function headingElement(root, entry) {
  if (!entry) return null;
  return blockContent(root, entry.blockId)?.querySelectorAll(HEADING_SELECTOR)[entry.index] ?? null;
}

/** Which heading a drawn element is: `{ blockId, index }`, or null for an
 * element outside a Page block's editor. */
export function headingPosition(element) {
  const heading = element?.closest?.(HEADING_SELECTOR);
  const section = heading?.closest?.("[data-block-id]");
  if (!heading || !section) return null;
  const content = section.querySelector("wg-content");
  if (!content?.contains(heading)) return null;
  const index = [...content.querySelectorAll(HEADING_SELECTOR)].indexOf(heading);
  return index < 0 ? null : { blockId: section.dataset.blockId, index, heading };
}

/** How long a scroll waits, once its Page is open, for its heading to draw
 * or its position to fit. */
export const SEEK_MS = 15000;
/** How long after the first scroll late layout (images, diagrams, tables
 * drawing above the target) scrolls to it again. */
export const SETTLE_MS = 1500;

// A scroll to a place on a Page: a heading, or a position Back or Forward
// returns to. The shell owns one from page load (heading-scroll.mjs runs
// the effects), so the reader can call it off before the Page has synced.
//
// Targets:
//   { kind: "anchor", anchor }   a heading's anchor
//   { kind: "position", y }      a scroll position the history entry recorded
//
// States:
//   idle       nothing asked yet
//   pending    { routeId, target }: the Page hasn't opened, synced or drawn
//              the target yet. `routeId` is the Page or Project id the
//              address names.
//   settling   { routeId, target }: scrolled; layout above may still move it
//   done       the scroll held through the settle window
//   cancelled  the reader took over, the app went elsewhere, or the target
//              never drew
//
// Events:
//   { type: "requested", routeId, target }  an address to show: page load,
//                                           Back/Forward, a link
//   { type: "navigated", routeId }          the app opened that route (or
//                                           null: a screen with no Page)
//   { type: "located", pageId, projectId }  the target is drawn on the open
//                                           Page, shown at that Project's route
//   { type: "resized" }                     the Page's layout changed
//   { type: "expired" }                     SEEK_MS passed while pending
//   { type: "settled" }                     SETTLE_MS passed while settling
//   { type: "userIntent" }                  the reader scrolled, typed or clicked
//
// Effects: "scroll" scrolls to the target.
export const HEADING_SCROLL_STATES = Object.freeze([
  "idle",
  "pending",
  "settling",
  "done",
  "cancelled",
]);
export const initialHeadingScroll = Object.freeze({ name: "idle" });
const DONE = Object.freeze({ name: "done" });
const CANCELLED = Object.freeze({ name: "cancelled" });

/** Whether a scroll is waiting or moving: the reader can still call it off. */
export const headingScrollActive = (state) => state.name === "pending" || state.name === "settling";

const validTarget = (target) =>
  (target?.kind === "anchor" && typeof target.anchor === "string" && target.anchor !== "") ||
  (target?.kind === "position" && Number.isFinite(target.y));

const shows = (state, event) =>
  !!state.routeId && (event.pageId === state.routeId || event.projectId === state.routeId);

/** `{ state, effects }` after `event`. Pure; an event that changes nothing
 * returns `state` itself. */
export function headingScrollTransition(state, event) {
  const same = { state, effects: [] };
  const active = headingScrollActive(state);
  switch (event?.type) {
    case "requested":
      if (!event.routeId || !validTarget(event.target))
        return { state: state.name === "idle" ? state : initialHeadingScroll, effects: [] };
      return {
        state: { name: "pending", routeId: event.routeId, target: event.target },
        effects: [],
      };
    case "navigated":
      return active && event.routeId !== state.routeId ? { state: CANCELLED, effects: [] } : same;
    case "located":
      if (state.name !== "pending" || !shows(state, event)) return same;
      return { state: { ...state, name: "settling" }, effects: ["scroll"] };
    case "resized":
      return state.name === "settling" ? { state, effects: ["scroll"] } : same;
    case "expired":
      return state.name === "pending" ? { state: CANCELLED, effects: [] } : same;
    case "settled":
      return state.name === "settling" ? { state: DONE, effects: [] } : same;
    case "userIntent":
      return active ? { state: CANCELLED, effects: [] } : same;
    default:
      return same;
  }
}
