// Links to headings, in the browser: reading a fragment, telling an in-app
// link from an outside one, finding a heading's element, and the state of a
// scroll to it. Anchors themselves come from model/heading-anchors.mjs.
//
// This module reaches neither Automerge nor the editor, so the shell
// (main.jsx) can import it before the editor chunk loads.
import { safeUrl } from "../model/marks.mjs";
import { readPageRoute } from "../shared/routes.mjs";

/** The anchor a fragment names, percent-decoded, or null for none. */
export function anchorFromHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Where a link in Page content goes, when this app can show it without a
 * reload: `{ route, anchor, samePage }`, or null for a link the browser
 * should follow. `route` is readPageRoute's answer (a Page or a Project);
 * `samePage` says the link only changes the fragment of `base`, the
 * address showing now. Links to another origin, other app routes and
 * executable schemes are null.
 */
export function inAppLink(href, base) {
  if (typeof href !== "string" || !href || !safeUrl(href)) return null;
  let url, here;
  try {
    here = new URL(base);
    url = new URL(href, here);
  } catch {
    return null;
  }
  if (url.origin !== here.origin) return null;
  const route = readPageRoute(url.href);
  if (route.kind !== "page" && route.kind !== "project") return null;
  return {
    route,
    anchor: anchorFromHash(url.hash),
    samePage: url.pathname === here.pathname && url.search === here.search,
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

/** How long a scroll waits for its heading to sync and draw. */
export const SEEK_MS = 15000;
/** How long after the first scroll late layout (images, diagrams, tables
 * drawing above the heading) scrolls to it again. */
export const SETTLE_MS = 1500;

// The scroll to a heading (main.jsx runs the effects).
//
// States:
//   idle      nothing to scroll to
//   seeking   { pageId, anchor }: the Page or its heading hasn't drawn yet
//   settling  { pageId, anchor }: scrolled; layout above may still move it
//
// Events:
//   { type: "requested", pageId, anchor }  a fragment to show: the address
//                                          on open, Back/Forward, a link
//   { type: "located", pageId }            the heading is drawn on that Page
//   { type: "resized" }                    the Page's layout changed
//   { type: "expired" }                    SEEK_MS passed while seeking
//   { type: "settled" }                    SETTLE_MS passed while settling
//   { type: "userScrolled" }               the reader scrolled or typed
//   { type: "left" }                       the Page closed
//
// Effects: "scroll" scrolls the heading to the top of the view.
export const HEADING_SCROLL_STATES = Object.freeze(["idle", "seeking", "settling"]);
export const initialHeadingScroll = Object.freeze({ name: "idle" });

const idle = (state) => (state.name === "idle" ? state : initialHeadingScroll);

/** `{ state, effects }` after `event`. Pure; an event that changes nothing
 * returns `state` itself. */
export function headingScrollTransition(state, event) {
  const same = { state, effects: [] };
  switch (event?.type) {
    case "requested":
      if (!event.pageId || !event.anchor) return { state: idle(state), effects: [] };
      return {
        state: { name: "seeking", pageId: event.pageId, anchor: event.anchor },
        effects: [],
      };
    case "located":
      if (state.name !== "seeking" || event.pageId !== state.pageId) return same;
      return { state: { ...state, name: "settling" }, effects: ["scroll"] };
    case "resized":
      return state.name === "settling" ? { state, effects: ["scroll"] } : same;
    case "expired":
      return state.name === "seeking" ? { state: idle(state), effects: [] } : same;
    case "settled":
      return state.name === "settling" ? { state: idle(state), effects: [] } : same;
    case "userScrolled":
    case "left":
      return { state: idle(state), effects: [] };
    default:
      return same;
  }
}
