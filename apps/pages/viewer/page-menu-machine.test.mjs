import assert from "node:assert/strict";
import { test } from "node:test";
import { VIEWS, initialPageMenu, pageMenuEffects, transition } from "./page-menu-machine.mjs";

const EVENTS = {
  toggle: { type: "toggle" },
  chooseShare: { type: "choose", item: "share", activity: 1 },
  chooseActivity: { type: "choose", item: "activity", activity: 1 },
  chooseActivityGone: { type: "choose", item: "activity", activity: 0 },
  chooseAction: { type: "choose", item: "action", activity: 1 },
  escape: { type: "escape" },
  outside: { type: "outside" },
  focusAway: { type: "focusAway" },
  tab: { type: "tab", shift: false },
  shiftTab: { type: "tab", shift: true },
  activityExpired: { type: "activityExpired" },
  shareOpen: { type: "share", open: true },
  shareClose: { type: "share", open: false },
  toPhone: { type: "breakpoint", phone: true },
  toDesktop: { type: "breakpoint", phone: false },
  unknown: { type: "unknown" },
};

// The expected view after each event, by starting view. A breakpoint row
// also flips `phone`; every other event keeps it.
const PHONE = {
  closed: {
    toggle: "menu",
    chooseShare: "closed",
    chooseActivity: "closed",
    chooseActivityGone: "closed",
    chooseAction: "closed",
    escape: "closed",
    outside: "closed",
    focusAway: "closed",
    tab: "closed",
    shiftTab: "closed",
    activityExpired: "closed",
    shareOpen: "share",
    shareClose: "closed",
    toPhone: "closed",
    toDesktop: "closed",
    unknown: "closed",
  },
  menu: {
    toggle: "closed",
    chooseShare: "share",
    chooseActivity: "activity",
    chooseActivityGone: "menu",
    chooseAction: "closed",
    escape: "closed",
    outside: "closed",
    focusAway: "closed",
    tab: "closed",
    shiftTab: "closed",
    activityExpired: "menu",
    shareOpen: "share",
    shareClose: "menu",
    toPhone: "menu",
    toDesktop: "closed",
    unknown: "menu",
  },
  share: {
    toggle: "menu",
    chooseShare: "share",
    chooseActivity: "share",
    chooseActivityGone: "share",
    chooseAction: "share",
    escape: "closed",
    outside: "share",
    focusAway: "share",
    tab: "share",
    shiftTab: "share",
    activityExpired: "share",
    shareOpen: "share",
    shareClose: "closed",
    toPhone: "share",
    toDesktop: "share",
    unknown: "share",
  },
  activity: {
    toggle: "menu",
    chooseShare: "activity",
    chooseActivity: "activity",
    chooseActivityGone: "activity",
    chooseAction: "activity",
    escape: "closed",
    outside: "closed",
    focusAway: "closed",
    tab: "activity",
    shiftTab: "activity",
    activityExpired: "closed",
    shareOpen: "share",
    shareClose: "activity",
    toPhone: "activity",
    toDesktop: "closed",
    unknown: "activity",
  },
};

// Desktop has no ⋯ menu: toggle and choose do nothing, and only Share opens.
const DESKTOP = Object.fromEntries(
  VIEWS.map((view) => [
    view,
    Object.fromEntries(
      Object.keys(EVENTS).map((name) => {
        if (name === "toPhone" || name === "toDesktop") return [name, view];
        if (
          [
            "toggle",
            "chooseShare",
            "chooseActivity",
            "chooseActivityGone",
            "chooseAction",
          ].includes(name)
        )
          return [name, view];
        return [name, PHONE[view][name]];
      }),
    ),
  ]),
);

test("every state × event lands where the table says", () => {
  for (const phone of [true, false])
    for (const view of VIEWS)
      for (const [name, event] of Object.entries(EVENTS)) {
        const state = Object.freeze({ view, phone });
        const next = transition(state, event);
        const expected = (phone ? PHONE : DESKTOP)[view][name];
        const expectedPhone = name === "toPhone" ? true : name === "toDesktop" ? false : phone;
        assert.deepEqual(
          next,
          { view: expected, phone: expectedPhone },
          `${phone ? "phone" : "desktop"} ${view} + ${name}`,
        );
        if (expected === view && expectedPhone === phone)
          assert.equal(next, state, `${view} + ${name} returns the same state`);
      }
});

test("a layout switch keeps an open Share panel and closes the ⋯ surfaces", () => {
  assert.deepEqual(transition({ view: "share", phone: true }, EVENTS.toDesktop), {
    view: "share",
    phone: false,
  });
  assert.deepEqual(transition({ view: "share", phone: false }, EVENTS.toPhone), {
    view: "share",
    phone: true,
  });
  assert.deepEqual(transition({ view: "menu", phone: true }, EVENTS.toDesktop), {
    view: "closed",
    phone: false,
  });
});

test("initial state is closed in either layout", () => {
  assert.deepEqual(initialPageMenu(true), { view: "closed", phone: true });
  assert.deepEqual(initialPageMenu(false), { view: "closed", phone: false });
});

test("effects: focus returns to ⋯ on Escape and Tab, Shift+Tab stays, actions run, Share reclaims focus", () => {
  const at = (view) => ({ view, phone: true });
  const effects = (view, event) => {
    const state = at(view);
    return pageMenuEffects(state, transition(state, event), event);
  };
  assert.deepEqual(effects("menu", EVENTS.escape), ["focusButton"]);
  assert.deepEqual(effects("activity", EVENTS.escape), ["focusButton"]);
  assert.deepEqual(effects("share", EVENTS.escape), []);
  assert.deepEqual(effects("menu", EVENTS.tab), ["focusButton"]);
  assert.deepEqual(effects("menu", EVENTS.shiftTab), ["focusButton", "preventDefault"]);
  assert.deepEqual(effects("menu", EVENTS.chooseAction), ["focusButton", "runAction"]);
  assert.deepEqual(effects("menu", EVENTS.chooseShare), []);
  assert.deepEqual(effects("menu", EVENTS.outside), []);
  // Desktop to phone with Share open reclaims focus only if the removed Share
  // button held it.
  const desktop = (view) => ({ view, phone: false });
  const toPhoneFromShare = { ...EVENTS.toPhone, shareFocused: true };
  assert.deepEqual(transition(desktop("share"), toPhoneFromShare), at("share"));
  const switched = (state, event) => pageMenuEffects(state, transition(state, event), event);
  assert.deepEqual(switched(desktop("share"), toPhoneFromShare), ["reclaimShare"]);
  assert.deepEqual(switched(desktop("share"), EVENTS.toPhone), []);
  for (const view of ["closed", "menu", "activity"])
    for (const event of [EVENTS.toPhone, toPhoneFromShare])
      assert.deepEqual(switched(desktop(view), event), [], `desktop ${view} to phone`);
  for (const view of VIEWS)
    assert.deepEqual(switched(at(view), EVENTS.toDesktop), [], `phone ${view} to desktop`);
  // Nothing runs when the event changed nothing.
  assert.deepEqual(effects("closed", EVENTS.tab), []);
  assert.deepEqual(effects("closed", EVENTS.chooseAction), []);
});
