import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HEADING_SCROLL_STATES,
  anchorFromHash,
  headingForAnchor,
  headingScrollTransition,
  inAppLink,
  initialHeadingScroll,
} from "./heading-links.mjs";

const id = "1a160b47-6df1-4983-81eb-489ca5a26812";
const other = "2b160b47-6df1-4983-81eb-489ca5a26812";
const project = `prj_${id}`;
const here = `https://pages.example/p/${id}`;

test("a fragment names its anchor, percent-decoded", () => {
  assert.equal(anchorFromHash("#plan"), "plan");
  assert.equal(anchorFromHash("plan"), "plan");
  assert.equal(anchorFromHash("#caf%C3%A9-%E6%9D%B1"), "café-東");
  assert.equal(anchorFromHash("#100%"), "100%");
  assert.equal(anchorFromHash("#"), null);
  assert.equal(anchorFromHash(""), null);
  assert.equal(anchorFromHash(undefined), null);
});

test("links to this app's Pages and Projects open in place; everything else doesn't", () => {
  const page = (pageId) => ({ kind: "page", pageId, path: `/p/${pageId}` });
  const rows = [
    ["#plan", { route: page(id), anchor: "plan", samePage: true }],
    [`${here}#plan`, { route: page(id), anchor: "plan", samePage: true }],
    [`/p/${id}#plan`, { route: page(id), anchor: "plan", samePage: true }],
    [`/p/${other}#plan`, { route: page(other), anchor: "plan", samePage: false }],
    [`/p/${other}`, { route: page(other), anchor: null, samePage: false }],
    [
      `/project/${project}#intro`,
      {
        route: { kind: "project", projectId: project, path: `/project/${project}` },
        anchor: "intro",
        samePage: false,
      },
    ],
    ["https://elsewhere.example/p/" + id + "#plan", null],
    ["https://example.com", null],
    ["/projects", null],
    ["/api/auth/logout", null],
    ["/p/not-a-page#x", null],
    ["javascript:alert(1)", null],
    ["mailto:someone@example.com", null],
    ["", null],
    [null, null],
  ];
  for (const [href, expected] of rows) assert.deepEqual(inAppLink(href, here), expected, href);
  // A Project route's own fragment is the same Page.
  assert.equal(inAppLink("#intro", `https://pages.example/project/${project}`).samePage, true);
});

test("an anchor finds its heading exactly, or by case for a hand-typed fragment", () => {
  const anchors = [
    { blockId: "a", index: 0, anchor: "plan" },
    { blockId: "b", index: 0, anchor: "plan-1" },
  ];
  assert.equal(headingForAnchor(anchors, "plan-1"), anchors[1]);
  assert.equal(headingForAnchor(anchors, "Plan"), anchors[0]);
  assert.equal(headingForAnchor(anchors, "missing"), null);
  assert.equal(headingForAnchor(anchors, null), null);
  assert.equal(headingForAnchor(undefined, "plan"), null);
});

const EVENTS = {
  requested: { type: "requested", pageId: "p", anchor: "plan" },
  requestedOther: { type: "requested", pageId: "q", anchor: "intro" },
  requestedEmpty: { type: "requested", pageId: "p", anchor: null },
  located: { type: "located", pageId: "p" },
  locatedOther: { type: "located", pageId: "q" },
  resized: { type: "resized" },
  expired: { type: "expired" },
  settled: { type: "settled" },
  userScrolled: { type: "userScrolled" },
  left: { type: "left" },
  unknown: { type: "unknown" },
};
const STATES = {
  idle: initialHeadingScroll,
  seeking: { name: "seeking", pageId: "p", anchor: "plan" },
  settling: { name: "settling", pageId: "p", anchor: "plan" },
};
const seekingOther = { name: "seeking", pageId: "q", anchor: "intro" };
// [next state, effects] for every state and event.
const TABLE = {
  idle: {
    requested: [STATES.seeking, []],
    requestedOther: [seekingOther, []],
    requestedEmpty: [STATES.idle, []],
    located: [STATES.idle, []],
    locatedOther: [STATES.idle, []],
    resized: [STATES.idle, []],
    expired: [STATES.idle, []],
    settled: [STATES.idle, []],
    userScrolled: [STATES.idle, []],
    left: [STATES.idle, []],
    unknown: [STATES.idle, []],
  },
  seeking: {
    requested: [STATES.seeking, []],
    requestedOther: [seekingOther, []],
    requestedEmpty: [STATES.idle, []],
    located: [STATES.settling, ["scroll"]],
    locatedOther: [STATES.seeking, []],
    resized: [STATES.seeking, []],
    expired: [STATES.idle, []],
    settled: [STATES.seeking, []],
    userScrolled: [STATES.idle, []],
    left: [STATES.idle, []],
    unknown: [STATES.seeking, []],
  },
  settling: {
    requested: [STATES.seeking, []],
    requestedOther: [seekingOther, []],
    requestedEmpty: [STATES.idle, []],
    located: [STATES.settling, []],
    locatedOther: [STATES.settling, []],
    resized: [STATES.settling, ["scroll"]],
    expired: [STATES.settling, []],
    settled: [STATES.idle, []],
    userScrolled: [STATES.idle, []],
    left: [STATES.idle, []],
    unknown: [STATES.settling, []],
  },
};

test("the heading scroll transition covers every state and event", () => {
  assert.deepEqual(Object.keys(TABLE), [...HEADING_SCROLL_STATES]);
  for (const [name, row] of Object.entries(TABLE)) {
    assert.deepEqual(Object.keys(row).sort(), Object.keys(EVENTS).sort(), name);
    for (const [event, [state, effects]] of Object.entries(row)) {
      const result = headingScrollTransition(STATES[name], EVENTS[event]);
      assert.deepEqual(result, { state, effects }, `${name} × ${event}`);
    }
  }
});

test("an event that changes nothing returns the same state object", () => {
  for (const [name, state] of Object.entries(STATES))
    for (const event of Object.values(EVENTS)) {
      const result = headingScrollTransition(state, event);
      if (result.state.name === name && JSON.stringify(result.state) === JSON.stringify(state))
        assert.equal(
          result.state === state || event.type === "requested",
          true,
          `${name} × ${event.type}`,
        );
    }
});
