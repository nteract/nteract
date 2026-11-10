// The Page header's Share, activity and ⋯ menu state (PageControls.jsx).
//
// State: `{ view, phone }`. `view` is the one surface open:
//   closed    nothing open
//   menu      the phone ⋯ menu
//   share     the Share panel (the desktop popover or the phone panel)
//   activity  the phone activity panel
// `phone` follows MOBILE_EDITOR_QUERY. The ⋯ menu and its activity panel exist
// only on phones; the desktop activity popover keeps its own <details> state.
//
// Events:
//   { type: "toggle" }                       ⋯ pressed
//   { type: "choose", item, activity }       a menu item chosen: "share",
//                                            "activity" (with the live session
//                                            count) or "action" (a page action)
//   { type: "escape" }                       Escape
//   { type: "outside" }                      a tap outside the menu or panel
//   { type: "focusAway" }                    focus moved outside the control
//   { type: "tab", shift }                   Tab or Shift+Tab inside the menu
//   { type: "activityExpired" }              the last active session left
//   { type: "share", open }                  Share opened or dismissed itself
//   { type: "breakpoint", phone, shareFocused }
//                                            the phone query changed;
//                                            `shareFocused` says whether the
//                                            Share button held focus then
//
// Share dismisses itself (SharingControls: Escape and taps outside) and
// reports that as `share` with `open: false`, so `outside` and `focusAway`
// only close the menu and the activity panel.

export const VIEWS = Object.freeze(["closed", "menu", "share", "activity"]);

export const initialPageMenu = (phone) => ({ view: "closed", phone: !!phone });

const to = (state, view) => (state.view === view ? state : { ...state, view });
const dismissible = (view) => view === "menu" || view === "activity";

/** The next state. Pure: returns `state` itself when the event changes nothing. */
export function transition(state, event) {
  switch (event?.type) {
    case "toggle":
      if (!state.phone) return state;
      return to(state, state.view === "menu" ? "closed" : "menu");
    case "choose":
      if (!state.phone || state.view !== "menu") return state;
      if (event.item === "share") return to(state, "share");
      if (event.item === "activity") return event.activity > 0 ? to(state, "activity") : state;
      if (event.item === "action") return to(state, "closed");
      return state;
    case "escape":
      return state.view === "closed" ? state : to(state, "closed");
    case "outside":
    case "focusAway":
      return dismissible(state.view) ? to(state, "closed") : state;
    case "tab":
      return state.view === "menu" ? to(state, "closed") : state;
    case "activityExpired":
      return state.view === "activity" ? to(state, "closed") : state;
    case "share":
      if (event.open) return to(state, "share");
      return state.view === "share" ? to(state, "closed") : state;
    case "breakpoint": {
      const phone = !!event.phone;
      if (phone === state.phone) return state;
      // Share survives the switch in the other layout's panel; the ⋯ menu and
      // its activity panel have no desktop form.
      return { view: phone || state.view === "share" ? state.view : "closed", phone };
    }
    default:
      return state;
  }
}

/**
 * What runs after a transition, in order:
 *   focusButton     focus returns to ⋯
 *   preventDefault  the key's own action is cancelled (Shift+Tab stays on ⋯)
 *   runAction       the chosen page action runs
 *   reclaimShare    focus moves into the Share panel; the phone layout has
 *                   no Share button, so focus it held leaves with the switch
 * Plain Tab focuses ⋯ and keeps its default, so focus moves on to the next
 * control after ⋯ (the menu items are not Tab stops).
 */
export function pageMenuEffects(previous, next, event) {
  if (previous === next) return [];
  switch (event.type) {
    case "escape":
      return dismissible(previous.view) ? ["focusButton"] : [];
    case "tab":
      return event.shift ? ["focusButton", "preventDefault"] : ["focusButton"];
    case "choose":
      return event.item === "action" ? ["focusButton", "runAction"] : [];
    case "breakpoint":
      return next.phone && next.view === "share" && event.shareFocused ? ["reclaimShare"] : [];
    default:
      return [];
  }
}
