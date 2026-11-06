// The hover card for a link to another Page or to a Project
// (page-link-card.mjs runs it; page-refs.mjs holds what it shows). It draws
// the card's four faces:
//
// - loading: a quiet skeleton while the target's meta is asked for.
// - readable:
//   - for a Page, its title, when it was edited, and its first screen as the
//     library grid draws it (PageCardPreview);
//   - for a Project, a small "Project" label with the Project icon, its
//     title, its description (at most three lines, omitted when empty), and
//     its content document's first screen the same way;
//   then Open (in place, through the same route opener in-app links use) and
//   Open in new tab. A link in a comment offers only Open in new tab, as
//   comment links always open, so a comment draft is never navigated away
//   from.
// - unavailable: a lock and "Page unavailable" or "Project unavailable",
//   nothing else. The same face shows whatever the reason, and for a host
//   that didn't answer, so it claims none.
// - failed: "Couldn't load a preview".
//
// The card never takes focus when the pointer opens it. From a link that
// has keyboard focus (read-only blocks, comments), Tab reaches its actions;
// Escape closes it and returns focus to the link, or to the editor a link in
// an editable block lives in. Using an action closes it. It sits under the
// link, or above it when there's no room below, inside the visual viewport,
// as the link menu does (LinkPopover.jsx).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Boxes, ExternalLink, Lock } from "lucide-react";
import { isPlainNavigation } from "../shared/routes.mjs";
import { takesFocus } from "./editor-focus.mjs";
import { openInNewTab } from "./link-destination.mjs";
import { PAGE_LINK_CARD_CLASS, PageLinkCards } from "./page-link-card.mjs";
import { PageCardPreview } from "./PageCardPreview.jsx";
import { refKey, settledOf } from "./page-refs.mjs";
import { useStore } from "./store.mjs";
import { toDate } from "./relative-time.mjs";
import "./page-link-card.css";

/** "Edited 2 hours ago", or null for a missing time. */
export function editedLabel(value, now = Date.now(), locale) {
  const date = toDate(value);
  if (!date) return null;
  const elapsed = now - date.getTime();
  const units = [
    ["year", 365.25 * 24 * 3600_000],
    ["month", 30.44 * 24 * 3600_000],
    ["week", 7 * 24 * 3600_000],
    ["day", 24 * 3600_000],
    ["hour", 3600_000],
    ["minute", 60_000],
  ];
  if (elapsed < 60_000) return "Edited just now";
  const [unit, size] = units.find(([, size]) => elapsed >= size);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  return `Edited ${format.format(-Math.floor(elapsed / size), unit)}`;
}

/** What the card shows for a Page: its face and the answers behind it. */
export function cardFace(meta, card) {
  const settledMeta = settledOf(meta);
  if (settledMeta?.name === "unavailable") return { face: "unavailable" };
  if (settledMeta?.name === "readable") {
    const settledCard = settledOf(card);
    return {
      face: "readable",
      meta: settledMeta.value,
      card: settledCard?.name === "readable" ? settledCard.value.card : null,
      cardLoading: !settledCard && card.name !== "failed",
    };
  }
  if (meta.name === "failed") return { face: "failed" };
  return { face: "loading" };
}

/** The route a target opens: a Page's or a Project's. */
export const targetRoute = (target) =>
  target.kind === "project"
    ? { kind: "project", projectId: target.id }
    : { kind: "page", pageId: target.id };

/**
 * The tab's link card. Mount it once.
 *
 * - `refs`: the tab's PageRefs.
 * - `currentPageId`: the Page open now, whose links are section links.
 * - `currentProjectId`: the Project whose content is open now, whose own
 *   links get no card.
 * - `onOpenRoute(route, anchor)`: open a Page or a Project in place, as an
 *   in-app link does (main.jsx openRoute).
 */
export function PageLinkCard({ refs, currentPageId = null, currentProjectId = null, onOpenRoute }) {
  const latest = useRef(null);
  latest.current = { currentPageId, currentProjectId, onOpenRoute };
  const [cards] = useState(
    () =>
      new PageLinkCards({
        refs,
        currentPageId: () => latest.current.currentPageId,
        currentProjectId: () => latest.current.currentProjectId,
      }),
  );
  useEffect(() => cards.attach(document), [cards]);
  const state = useStore(cards.store);
  if (state.name !== "open" && state.name !== "closing") return null;
  return (
    <CardBody
      cards={cards}
      refs={refs}
      target={state.target}
      onOpen={() => {
        cards.acted();
        latest.current.onOpenRoute(targetRoute(state.target), state.target.anchor);
      }}
    />
  );
}

function CardBody({ cards, refs, target, onOpen }) {
  const element = useRef(null);
  const [position, setPosition] = useState({ left: 12, top: 12, visibility: "hidden" });
  const ref = { kind: target.kind, id: target.id };
  const meta = useStore(refs.store, (state) => state.refs.get(refKey(ref, "meta")));
  const card = useStore(refs.store, (state) => state.refs.get(refKey(ref, "card")));
  const project = target.kind === "project";
  const view = cardFace(meta ?? { name: "idle" }, card ?? { name: "idle" });
  const labelId = `page-link-card-${target.key}`;
  useLayoutEffect(() => {
    cards.card = element.current;
    return () => {
      if (cards.card === element.current) cards.card = null;
    };
  }, [cards]);
  // A link that takes focus itself (read-only blocks, comments) is described
  // by the card while it shows. Never a link inside editable content: that
  // markup belongs to the editor, which would read the change as an edit.
  useLayoutEffect(() => {
    const link = cards.link;
    if (!takesFocus(link) || link.closest("[contenteditable='true']")) return;
    const before = link.getAttribute("aria-describedby");
    link.setAttribute("aria-describedby", [before, labelId].filter(Boolean).join(" "));
    return () => {
      if (before === null) link.removeAttribute("aria-describedby");
      else link.setAttribute("aria-describedby", before);
    };
  }, [cards, labelId]);
  useLayoutEffect(() => {
    const place = () => {
      const links = cards.linkElements.filter((link) => link.isConnected);
      if (!element.current || !links.length) return;
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 12;
      const top = (viewport?.offsetTop ?? 0) + 12;
      const right = left + (viewport?.width ?? innerWidth) - 24;
      const bottom = top + (viewport?.height ?? innerHeight) - 24;
      // The link's last line box: a link that wraps, or one drawn as several
      // fragments, has several.
      const rects = links.flatMap((link) => [...link.getClientRects()]);
      const anchor = rects[rects.length - 1] ?? links[0].getBoundingClientRect();
      const first = rects[0] ?? anchor;
      const bounds = element.current.getBoundingClientRect();
      const below = anchor.bottom + 8;
      const above = first.top - 8 - bounds.height;
      const placeTop = below + bounds.height <= bottom || above < top ? below : above;
      setPosition({
        left: Math.max(left, Math.min(anchor.left, right - bounds.width)),
        top: Math.max(top, Math.min(placeTop, bottom - bounds.height)),
      });
    };
    const observer = new ResizeObserver(place);
    observer.observe(element.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    place();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [cards, target.key]);
  return createPortal(
    <div
      ref={element}
      className={PAGE_LINK_CARD_CLASS}
      data-face={view.face}
      data-kind={target.kind}
      style={position}
      role="group"
      aria-labelledby={labelId}
      aria-busy={view.face === "loading" || undefined}
    >
      {view.face === "readable" && (
        <Readable
          view={view}
          labelId={labelId}
          target={target}
          onOpen={onOpen}
          onActed={() => cards.acted()}
        />
      )}
      {view.face === "unavailable" && (
        <div className="page-link-card-lock">
          <Lock size={18} aria-hidden="true" />
          <div className="page-link-card-title" id={labelId}>
            {project ? "Project unavailable" : "Page unavailable"}
          </div>
        </div>
      )}
      {view.face === "failed" && (
        <div className="page-link-card-meta" id={labelId} role="status">
          Couldn't load a preview
        </div>
      )}
      {view.face === "loading" && (
        <div className="page-link-card-skeleton">
          <span className="sr-only" id={labelId}>
            Loading preview
          </span>
          <i />
          <i />
          <i />
        </div>
      )}
    </div>,
    document.body,
  );
}

function Readable({ view, labelId, target, onOpen, onActed }) {
  const project = target.kind === "project";
  const edited = project ? null : editedLabel(view.meta.content_updated_at);
  const title = view.meta.title || "Untitled";
  const description = project ? view.meta.description?.trim() : "";
  return (
    <>
      {project && (
        <div className="page-link-card-kind">
          <Boxes size={13} aria-hidden="true" /> Project
        </div>
      )}
      <bdi className="page-link-card-title" id={labelId} dir="auto" title={title}>
        {title}
      </bdi>
      {description && (
        <bdi className="page-link-card-description" dir="auto" title={description}>
          {description}
        </bdi>
      )}
      {(edited || view.meta.state === "trashed") && (
        <div className="page-link-card-meta">
          {view.meta.state === "trashed" ? "In Trash" : edited}
        </div>
      )}
      <div className="page-link-card-preview">
        {view.cardLoading ? (
          <div className="index-card-preview page-link-card-preview-wait" aria-hidden="true" />
        ) : (
          <PageCardPreview card={view.card} />
        )}
      </div>
      <div className="page-link-card-actions">
        {!target.comment && (
          <a
            className="primary"
            href={target.href}
            onClick={(event) => {
              if (event.defaultPrevented) return;
              if (!isPlainNavigation(event)) return void onActed();
              event.preventDefault();
              onOpen();
            }}
            // A middle click opens a tab and fires no click.
            onAuxClick={(event) => {
              if (event.button === 1) onActed();
            }}
          >
            Open
          </a>
        )}
        <button
          type="button"
          className={target.comment ? "primary" : "subtle-button"}
          onClick={() => {
            openInNewTab(target.href);
            onActed();
          }}
        >
          <ExternalLink size={15} aria-hidden="true" /> Open in new tab
        </button>
      </div>
    </>
  );
}
