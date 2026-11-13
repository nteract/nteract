import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HEADING_SCROLL_STATES,
  anchorFromHash,
  headingForAnchor,
  headingScrollActive,
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
  const page = (pageId, slug = null) => ({ kind: "page", pageId, path: `/p/${pageId}`, slug });
  const rows = [
    ["#plan", { route: page(id), anchor: "plan", samePage: true }],
    [`${here}#plan`, { route: page(id), anchor: "plan", samePage: true }],
    [`/p/${id}#plan`, { route: page(id), anchor: "plan", samePage: true }],
    [`/p/${other}#plan`, { route: page(other), anchor: "plan", samePage: false }],
    [`/p/${other}`, { route: page(other), anchor: null, samePage: false }],
    [`/p/${other}/Plan#goals`, { route: page(other, "Plan"), anchor: "goals", samePage: false }],
    [`/p/${id}/Plan#goals`, { route: page(id, "Plan"), anchor: "goals", samePage: true }],
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

const anchor = { kind: "anchor", anchor: "plan" };
const position = { kind: "position", y: 640 };
const EVENTS = {
  requested: { type: "requested", routeId: "p", target: anchor },
  requestedPosition: { type: "requested", routeId: "p", target: position },
  requestedOther: { type: "requested", routeId: "q", target: { kind: "anchor", anchor: "intro" } },
  requestedEmpty: { type: "requested", routeId: "p", target: null },
  requestedNoRoute: { type: "requested", routeId: null, target: anchor },
  requestedBadPosition: { type: "requested", routeId: "p", target: { kind: "position", y: NaN } },
  navigated: { type: "navigated", routeId: "p" },
  navigatedOther: { type: "navigated", routeId: "q" },
  navigatedNone: { type: "navigated", routeId: null },
  located: { type: "located", pageId: "p", projectId: null },
  locatedProject: { type: "located", pageId: "doc", projectId: "p" },
  locatedOther: { type: "located", pageId: "q", projectId: null },
  resized: { type: "resized" },
  expired: { type: "expired" },
  settled: { type: "settled" },
  userIntent: { type: "userIntent" },
  unknown: { type: "unknown" },
};
const STATES = {
  idle: initialHeadingScroll,
  pending: { name: "pending", routeId: "p", target: anchor },
  settling: { name: "settling", routeId: "p", target: anchor },
  done: { name: "done" },
  cancelled: { name: "cancelled" },
};
const pending = STATES.pending;
const pendingPosition = { name: "pending", routeId: "p", target: position };
const pendingOther = { name: "pending", routeId: "q", target: { kind: "anchor", anchor: "intro" } };
const settling = STATES.settling;
const { idle, done, cancelled } = STATES;
// A resting state (idle, done, cancelled) takes a new request and otherwise
// stays put.
const resting = (state) => ({
  requested: [pending, []],
  requestedPosition: [pendingPosition, []],
  requestedOther: [pendingOther, []],
  requestedEmpty: [idle, []],
  requestedNoRoute: [idle, []],
  requestedBadPosition: [idle, []],
  navigated: [state, []],
  navigatedOther: [state, []],
  navigatedNone: [state, []],
  located: [state, []],
  locatedProject: [state, []],
  locatedOther: [state, []],
  resized: [state, []],
  expired: [state, []],
  settled: [state, []],
  userIntent: [state, []],
  unknown: [state, []],
});
// [next state, effects] for every state and event.
const TABLE = {
  idle: resting(idle),
  pending: {
    requested: [pending, []],
    requestedPosition: [pendingPosition, []],
    requestedOther: [pendingOther, []],
    requestedEmpty: [idle, []],
    requestedNoRoute: [idle, []],
    requestedBadPosition: [idle, []],
    navigated: [pending, []],
    navigatedOther: [cancelled, []],
    navigatedNone: [cancelled, []],
    located: [settling, ["scroll"]],
    locatedProject: [settling, ["scroll"]],
    locatedOther: [pending, []],
    resized: [pending, []],
    expired: [cancelled, []],
    settled: [pending, []],
    userIntent: [cancelled, []],
    unknown: [pending, []],
  },
  settling: {
    requested: [pending, []],
    requestedPosition: [pendingPosition, []],
    requestedOther: [pendingOther, []],
    requestedEmpty: [idle, []],
    requestedNoRoute: [idle, []],
    requestedBadPosition: [idle, []],
    navigated: [settling, []],
    navigatedOther: [cancelled, []],
    navigatedNone: [cancelled, []],
    located: [settling, []],
    locatedProject: [settling, []],
    locatedOther: [settling, []],
    resized: [settling, ["scroll"]],
    expired: [settling, []],
    settled: [done, []],
    userIntent: [cancelled, []],
    unknown: [settling, []],
  },
  done: resting(done),
  cancelled: resting(cancelled),
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

test("only pending and settling are active", () => {
  assert.deepEqual(
    Object.entries(STATES)
      .filter(([, state]) => headingScrollActive(state))
      .map(([name]) => name),
    ["pending", "settling"],
  );
});
