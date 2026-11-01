import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal, Share2, UsersRound } from "lucide-react";
import { SharingControls } from "./SharingControls.jsx";
import { ActivityList, PageActivity, activitySessions, usePageActivity } from "./PageActivity.jsx";

/**
 * The Page's header controls. `children` is the Comments button, which both
 * layouts keep in the header.
 *
 * Desktop: activity, Share, Comments and the Document actions menu, each its
 * own control. Phone (`phone`, from MOBILE_EDITOR_QUERY): Comments and one ⋯
 * menu holding Share, activity and the same page actions.
 *
 * `actions` are the page menu entries: `{ key, label, icon, run, danger,
 * kbd, attributes }`. `kbd` and `attributes` belong to the desktop menu.
 */
export function PageControls({
  phone,
  session,
  actions,
  onReveal,
  activityDisclosure,
  actionsDisclosure,
  children,
}) {
  if (phone)
    return (
      <>
        {children}
        <PageMenu key={session.pageId} session={session} actions={actions} onReveal={onReveal} />
      </>
    );
  return (
    <>
      <PageActivity
        key={`activity:${session.pageId}`}
        session={session}
        disclosure={activityDisclosure}
        onReveal={onReveal}
      />
      <SharingControls key={`sharing:${session.pageId}`} session={session} />
      {children}
      <details className="document-actions" ref={actionsDisclosure}>
        <summary className="icon-button" aria-label="Document actions" title="Document actions">
          <MoreHorizontal size={20} aria-hidden="true" />
        </summary>
        <div className="menu-popover">
          {actions.map(({ key, label, icon: Icon, kbd, danger, attributes, run }) => (
            <button
              key={key}
              className={danger ? "danger" : undefined}
              {...attributes}
              onClick={run}
            >
              {Icon && <Icon size={16} aria-hidden="true" />}
              {label}
              {kbd && <kbd>{kbd}</kbd>}
            </button>
          ))}
        </div>
      </details>
    </>
  );
}

/**
 * The phone header's ⋯ menu. `view` is the one surface it shows: "closed",
 * "menu", "share" (the Share panel) or "activity" (the activity panel).
 *
 * The menu and the activity panel close on Escape (focus returns to ⋯), on a
 * tap outside, and when focus moves anywhere outside the control. Choosing an
 * item closes the menu. Share keeps its own dismissal (SharingControls).
 * A dot on ⋯ stands in for the desktop activity count while anyone is here.
 */
export function PageMenu({ session, actions, onReveal }) {
  const [view, setView] = useState("closed");
  const activity = usePageActivity(session, view === "activity");
  const { count } = activity;
  const root = useRef(null),
    button = useRef(null),
    menu = useRef(null),
    panel = useRef(null);
  const menuId = useId(),
    countId = useId();
  // The activity panel closes when the last session leaves, like the header popover.
  useEffect(() => {
    if (!count) setView((current) => (current === "activity" ? "closed" : current));
  }, [count]);
  useEffect(() => {
    if (view !== "menu" && view !== "activity") return;
    const surface = view === "menu" ? menu : panel;
    const outside = (event) => {
      if (!surface.current?.contains(event.target) && !button.current?.contains(event.target))
        setView("closed");
    };
    // Focus moving out by pointer, keyboard or code closes it too.
    const away = (event) => {
      if (!root.current?.contains(event.target)) setView("closed");
    };
    const escape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setView("closed");
      button.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", away, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", away, true);
      document.removeEventListener("keydown", escape);
    };
  }, [view]);
  useEffect(() => {
    if (view === "menu") menu.current?.querySelector('[role="menuitem"]')?.focus();
    else if (view === "activity") panel.current?.focus({ preventScroll: true });
  }, [view]);
  // A page action runs after the menu closes, so focus it moves (the
  // formatting toolbar, a confirm dialog) wins over ⋯.
  const run = (action) => {
    button.current?.focus({ preventScroll: true });
    setView("closed");
    action.run();
  };
  const moveFocus = (event) => {
    const items = [...menu.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = {
      ArrowDown: items[(index + 1) % items.length],
      ArrowUp: items[(index - 1 + items.length) % items.length],
      Home: items[0],
      End: items.at(-1),
    }[event.key];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  return (
    <div className="page-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="icon-button page-menu-button"
        aria-label="More page actions"
        aria-describedby={count ? countId : undefined}
        title="More page actions"
        aria-haspopup="menu"
        aria-expanded={view === "menu"}
        aria-controls={view === "menu" ? menuId : undefined}
        onClick={() => setView((current) => (current === "menu" ? "closed" : "menu"))}
      >
        <MoreHorizontal size={20} aria-hidden="true" />
        {count > 0 && (
          <>
            <span className="page-menu-indicator" aria-hidden="true" />
            <span id={countId} className="sr-only">
              {activitySessions(count)}
            </span>
          </>
        )}
      </button>
      {view === "menu" && (
        <div
          ref={menu}
          id={menuId}
          className="page-menu-list"
          role="menu"
          aria-label="More page actions"
          onKeyDown={moveFocus}
        >
          <button type="button" role="menuitem" onClick={() => setView("share")}>
            <Share2 size={18} aria-hidden="true" />
            <span>Share</span>
          </button>
          {count > 0 && (
            <button
              type="button"
              role="menuitem"
              aria-label={`Activity, ${activitySessions(count)}`}
              onClick={() => setView("activity")}
            >
              <UsersRound size={18} aria-hidden="true" />
              <span>Activity</span>
              <span className="page-menu-count" aria-hidden="true">
                {count}
              </span>
            </button>
          )}
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                className={action.danger ? "danger" : undefined}
                onClick={() => run(action)}
              >
                {Icon && <Icon size={18} aria-hidden="true" />}
                <span>{action.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {view === "activity" && (
        <div
          ref={panel}
          className="activity-popover"
          role="dialog"
          aria-label="Page activity"
          tabIndex={-1}
        >
          <ActivityList {...activity} onReveal={onReveal} />
        </div>
      )}
      <SharingControls
        session={session}
        trigger={false}
        open={view === "share"}
        onOpenChange={(open) =>
          setView((current) => (open ? "share" : current === "share" ? "closed" : current))
        }
        returnFocus={button}
      />
    </div>
  );
}
