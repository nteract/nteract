import { Fragment, useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal, Share2, UsersRound } from "lucide-react";
import { SharingControls } from "./SharingControls.jsx";
import { ActivityList, PageActivity, activitySessions, usePageActivity } from "./PageActivity.jsx";
import { initialPageMenu, pageMenuEffects, transition } from "./page-menu-machine.mjs";

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
export function PageControls(props) {
  return <Controls key={props.session.pageId} {...props} />;
}

/**
 * One state machine (page-menu-machine.mjs) owns which surface is open, in
 * both layouts. Handlers dispatch events; effects run after each transition.
 *
 * Both layouts render one keyed list with Share first, so crossing the
 * breakpoint keeps the same SharingControls instance in place: an open
 * Share panel keeps its draft, its role and the focused field.
 */
function Controls({
  phone,
  session,
  actions,
  onReveal,
  activityDisclosure,
  actionsDisclosure,
  children,
}) {
  const [state, setState] = useState(() => initialPageMenu(phone));
  const current = useRef(state),
    button = useRef(null),
    pendingAction = useRef(null);
  // The breakpoint is a prop, so its event applies during render, before
  // either layout paints with the other's state.
  let shown = state;
  if (state.phone !== !!phone) {
    shown = transition(state, { type: "breakpoint", phone });
    setState(shown);
  }
  current.current = shown;
  const dispatch = (event, domEvent) => {
    const previous = current.current;
    const next = transition(previous, event);
    current.current = next;
    if (next !== previous) setState(next);
    for (const effect of pageMenuEffects(previous, next, event)) {
      if (effect === "focusButton") button.current?.focus({ preventScroll: true });
      else if (effect === "preventDefault") domEvent?.preventDefault();
      else if (effect === "runAction") pendingAction.current?.run();
    }
  };
  const sharing = (
    <SharingControls
      key="sharing"
      session={session}
      trigger={!shown.phone}
      open={shown.view === "share"}
      onOpenChange={(open) => dispatch({ type: "share", open })}
      returnFocus={button}
    />
  );
  const comments = <Fragment key="comments">{children}</Fragment>;
  if (shown.phone)
    return [
      sharing,
      comments,
      <PageMenu
        key="menu"
        session={session}
        actions={actions}
        onReveal={onReveal}
        view={shown.view}
        dispatch={dispatch}
        button={button}
        pendingAction={pendingAction}
      />,
    ];
  return [
    <PageActivity
      key="activity"
      session={session}
      disclosure={activityDisclosure}
      onReveal={onReveal}
    />,
    sharing,
    comments,
    <details key="actions" className="document-actions" ref={actionsDisclosure}>
      <summary className="icon-button" aria-label="Document actions" title="Document actions">
        <MoreHorizontal size={20} aria-hidden="true" />
      </summary>
      <div className="menu-popover">
        {actions.map(({ key, label, icon: Icon, kbd, danger, attributes, run }) => (
          <button key={key} className={danger ? "danger" : undefined} {...attributes} onClick={run}>
            {Icon && <Icon size={16} aria-hidden="true" />}
            {label}
            {kbd && <kbd>{kbd}</kbd>}
          </button>
        ))}
      </div>
    </details>,
  ];
}

/**
 * The phone header's ⋯ button, its menu and the activity panel. The menu and
 * the panel close on Escape (focus returns to ⋯), on a tap outside, and when
 * focus moves outside the control; Tab leaves the menu. Menu items are not
 * Tab stops: arrow keys, Home and End move between them. A dot on ⋯ stands in
 * for the desktop activity count while anyone is here.
 */
function PageMenu({ session, actions, onReveal, view, dispatch, button, pendingAction }) {
  const activity = usePageActivity(session, view === "activity");
  const { count } = activity;
  const root = useRef(null),
    menu = useRef(null),
    panel = useRef(null),
    send = useRef(dispatch);
  send.current = dispatch;
  const menuId = useId(),
    countId = useId();
  useEffect(() => {
    if (!count) send.current({ type: "activityExpired" });
  }, [count]);
  useEffect(() => {
    if (view !== "menu" && view !== "activity") return;
    const surface = view === "menu" ? menu : panel;
    const outside = (event) => {
      if (!surface.current?.contains(event.target) && !button.current?.contains(event.target))
        send.current({ type: "outside" });
    };
    const away = (event) => {
      if (!root.current?.contains(event.target)) send.current({ type: "focusAway" });
    };
    const escape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      send.current({ type: "escape" });
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", away, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", away, true);
      document.removeEventListener("keydown", escape);
    };
  }, [view, button]);
  // Opening moves focus into the surface.
  useEffect(() => {
    if (view === "menu") menu.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    else if (view === "activity") panel.current?.focus({ preventScroll: true });
  }, [view]);
  const choose = (item, action) => {
    pendingAction.current = action ?? null;
    dispatch({ type: "choose", item, activity: count });
    pendingAction.current = null;
  };
  const keyDown = (event) => {
    if (event.key === "Tab") {
      dispatch({ type: "tab", shift: event.shiftKey }, event);
      return;
    }
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
        onClick={() => dispatch({ type: "toggle" })}
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
          onKeyDown={keyDown}
        >
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => choose("share")}>
            <Share2 size={18} aria-hidden="true" />
            <span>Share</span>
          </button>
          {count > 0 && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-label={`Activity, ${activitySessions(count)}`}
              onClick={() => choose("activity")}
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
                tabIndex={-1}
                className={action.danger ? "danger" : undefined}
                onClick={() => choose("action", action)}
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
    </div>
  );
}
