// Links to a Page's headings: the "#" beside a heading under the pointer
// copies its link, a fragment in the address scrolls to its heading once the
// Page has synced and drawn it, Back and Forward return to the entry's
// scroll position, and links in Page content to this app's
// Pages open in place instead of in a new tab.
//
// Anchors are computed from the document (model/heading-anchors.mjs). The
// editor owns its DOM, so nothing here writes ids into it: a heading is
// found by its block and its ordinal among the block's headings.
import { useEffect, useRef, useState } from "react";
import { Observable, animationFrameScheduler, auditTime, fromEvent, merge, timer } from "rxjs";
import { Hash } from "lucide-react";
import { pageHeadingAnchors } from "../model/heading-anchors.mjs";
import {
  anchorFragment,
  isPlainNavigation,
  readPageRoute,
  rememberScroll,
  writeRoute,
} from "../shared/routes.mjs";
import {
  SEEK_MS,
  SETTLE_MS,
  headingElement,
  headingForAnchor,
  headingPosition,
  headingScrollActive,
  inAppLink,
} from "./heading-links.mjs";
import { routeIdOf } from "./heading-scroll.mjs";
import { useStore } from "./store.mjs";

const BUTTON_SIZE = 24;
/** How often scrolling records the history entry's position. Browsers
 * throttle history.replaceState, so not on every scroll event. */
const SCROLL_RECORD_MS = 200;

const mutations = (element) =>
  new Observable((subscriber) => {
    const observer = new MutationObserver(() => subscriber.next());
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  });

const resizes = (element) =>
  new Observable((subscriber) => {
    const observer = new ResizeObserver(() => subscriber.next());
    observer.observe(element);
    return () => observer.disconnect();
  });

/** Whether the document can scroll down to `y`. */
const reachable = (y) => y <= 0 || document.documentElement.scrollHeight - window.innerHeight >= y;

/**
 * `session` is the open Page's session; `projectId` the Project whose route
 * shows it, if any. `scroll` is the shell's HeadingScroll (heading-scroll.mjs):
 * this reports its target drawn and runs its scrolls. `onOpenRoute(route,
 * anchor)` opens another Page or Project (readPageRoute's answer) with a
 * heading to show.
 */
export function HeadingAnchors({
  article,
  session,
  projectId,
  scroll: scroller,
  onOpenRoute,
  onNotice,
  onError,
}) {
  const scroll = useStore(scroller.store);
  const [hovered, setHovered] = useState(null);
  const latest = useRef(null);
  latest.current = { session, projectId, onOpenRoute, onNotice, onError };
  const pageId = session?.pageId ?? null;

  const anchorsNow = () => {
    const doc = latest.current.session?.doc;
    return doc ? pageHeadingAnchors(doc) : [];
  };
  const targetElement = (anchor) =>
    headingElement(article.current, headingForAnchor(anchorsNow(), anchor));
  /** Whether `target` is drawn and can be scrolled to now. */
  const targetReady = (target) =>
    target.kind === "anchor"
      ? !!targetElement(target.anchor)
      : !!article.current?.querySelector("wg-content") && reachable(target.y);

  function dispatch(event) {
    const effects = scroller.dispatch(event);
    const state = scroller.store.snapshot();
    for (const effect of effects) {
      if (effect !== "scroll" || !state.target) continue;
      if (state.target.kind === "anchor")
        targetElement(state.target.anchor)?.scrollIntoView({ block: "start" });
      else window.scrollTo({ top: state.target.y, left: 0, behavior: "instant" });
    }
  }
  const located = () =>
    dispatch({
      type: "located",
      pageId: latest.current.session?.pageId ?? null,
      projectId: latest.current.projectId ?? null,
    });

  /** Whether the address now shows the open Page. */
  const addressShowsPage = () => {
    const route = readPageRoute(location.href);
    const current = latest.current;
    if (route.kind === "page") return route.pageId === current.session?.pageId;
    return route.kind === "project" && route.projectId === current.projectId;
  };
  /** The route id the address names, when it shows the open Page. */
  const shownRouteId = () => (addressShowsPage() ? routeIdOf(location.href) : null);
  const remember = () => {
    if (!headingScrollActive(scroller.store.snapshot()) && addressShowsPage())
      rememberScroll(window.scrollY);
  };

  // Pending: look again whenever the Page draws or grows, until the target
  // is there. The wait starts once this Page is open.
  useEffect(() => {
    const element = article.current;
    if (scroll.name !== "pending" || !element) return;
    const look = () => {
      if (targetReady(scroll.target)) located();
    };
    look();
    const subscription = merge(mutations(element), resizes(element))
      .pipe(auditTime(0, animationFrameScheduler))
      .subscribe(look);
    subscription.add(timer(SEEK_MS).subscribe(() => dispatch({ type: "expired" })));
    return () => subscription.unsubscribe();
  }, [scroll, pageId, projectId]);

  // Settling: layout drawn late above the target scrolls to it again.
  useEffect(() => {
    const element = article.current;
    if (scroll.name !== "settling" || !element) return;
    const subscription = resizes(element)
      .pipe(auditTime(0, animationFrameScheduler))
      .subscribe(() => dispatch({ type: "resized" }));
    subscription.add(timer(SETTLE_MS).subscribe(() => dispatch({ type: "settled" })));
    return () => subscription.unsubscribe();
  }, [scroll]);

  // The history entry showing this Page keeps its scroll position for Back
  // and Forward. Not while a scroll is pending or moving: during a Page swap
  // the document is short and the position clamps.
  useEffect(() => {
    if (scroll.name === "done") remember();
  }, [scroll]);
  useEffect(() => {
    const subscription = fromEvent(window, "scroll", { passive: true })
      .pipe(auditTime(SCROLL_RECORD_MS))
      .subscribe(remember);
    return () => subscription.unsubscribe();
  }, []);

  /** Show heading `anchor` of the open Page and put it in the address. */
  function showHere(anchor) {
    const routeId = shownRouteId() ?? latest.current.session?.pageId;
    writeRoute(`${location.pathname}${location.search}${anchorFragment(anchor)}`, {
      state: history.state,
    });
    scroller.request(routeId, anchor);
  }

  // Links in Page content to this app's Pages open here. The editor handles
  // a click on a link it edits (its link menu); a read-only Page's links and
  // the menu's Open link come here.
  useEffect(() => {
    const click = (event) => {
      if (!isPlainNavigation(event)) return;
      const link = event.target.closest?.("a[href]");
      if (!link || link.hasAttribute("download") || link.closest(".wordgard-widget")) return;
      if (!link.closest("[data-block-id], .link-popover")) return;
      const target = inAppLink(link.getAttribute("href"), location.href);
      if (!target) return;
      event.preventDefault();
      const here =
        target.samePage ||
        (target.route.kind === "page" && target.route.pageId === latest.current.session?.pageId);
      if (here) {
        if (target.anchor) showHere(target.anchor);
      } else latest.current.onOpenRoute(target.route, target.anchor);
    };
    document.addEventListener("click", click);
    return () => document.removeEventListener("click", click);
  }, []);

  // The "#" beside the heading under the pointer.
  useEffect(() => {
    const element = article.current;
    if (!element) return;
    const place = (event) => {
      if (event.target.closest?.(".heading-anchor")) return;
      const position = headingPosition(event.target);
      if (!position) {
        setHovered(null);
        return;
      }
      const entry = anchorsNow().find(
        (anchor) => anchor.blockId === position.blockId && anchor.index === position.index,
      );
      if (!entry) {
        setHovered(null);
        return;
      }
      const box = element.getBoundingClientRect();
      const heading = position.heading.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(position.heading).lineHeight);
      const lineHeight = Number.isFinite(line) ? Math.min(line, heading.height) : heading.height;
      const gutter = heading.left - box.left;
      setHovered({
        anchor: entry.anchor,
        text: entry.text,
        top: heading.top - box.top + Math.max(0, (lineHeight - BUTTON_SIZE) / 2),
        // Left of the heading, in the article's padding and the margin
        // beyond it, or at its right end where the screen has no room left
        // of the text (phones).
        left:
          heading.left >= BUTTON_SIZE + 4
            ? gutter - BUTTON_SIZE
            : heading.right - box.left - BUTTON_SIZE,
      });
    };
    const leave = () => setHovered(null);
    const subscription = merge(
      fromEvent(element, "pointerover").pipe(auditTime(0, animationFrameScheduler)),
      fromEvent(element, "pointermove").pipe(auditTime(100)),
    ).subscribe(place);
    subscription.add(fromEvent(element, "pointerleave").subscribe(leave));
    subscription.add(fromEvent(element, "keydown").subscribe(leave));
    return () => {
      subscription.unsubscribe();
      setHovered(null);
    };
  }, [pageId]);

  async function copy(anchor) {
    showHere(anchor);
    try {
      await navigator.clipboard.writeText(location.href);
      latest.current.onNotice?.("Link to section copied");
    } catch {
      latest.current.onError?.("Couldn't copy the link. You can copy it from the address bar.");
    }
  }

  if (!hovered) return null;
  return (
    <button
      type="button"
      className="heading-anchor"
      style={{ top: hovered.top, left: hovered.left }}
      aria-label={`Copy link to section ${hovered.text.trim() || "Untitled"}`}
      title="Copy link to section"
      onClick={() => void copy(hovered.anchor)}
    >
      <Hash size={15} aria-hidden="true" />
    </button>
  );
}
