import assert from "node:assert/strict";
import test from "node:test";
import { VIEW_ABSENT, viewStep } from "./view-lifecycle.mjs";

const STATES = ["absent", "loading", "storing", "recording", "ready", "releasing"];
const EVENTS = [
  { type: "boot", recorded: true },
  { type: "boot", recorded: false },
  { type: "create", recorded: true },
  { type: "create", recorded: false },
  { type: "loaded" },
  { type: "stored" },
  { type: "recorded" },
  { type: "release" },
  { type: "released" },
  { type: "failed" },
  { type: "drop" },
];
const label = (event) =>
  ["boot", "create"].includes(event.type)
    ? `${event.type}:${event.recorded ? "recorded" : "unrecorded"}`
    : event.type;

// Every state and event: `[next state, effects]`, or null for a rejected
// event that leaves the state alone. `recorded` says `host/view/<view_id>`
// is stored.
const TABLE = {
  absent: {
    "boot:recorded": ["loading", ["load"]],
    "boot:unrecorded": ["absent", []],
    "create:recorded": ["loading", ["load"]],
    "create:unrecorded": ["storing", ["store"]],
    loaded: null,
    stored: null,
    recorded: null,
    release: null,
    released: null,
    failed: null,
    drop: ["absent", []],
  },
  loading: {
    "boot:recorded": null,
    "boot:unrecorded": null,
    "create:recorded": null,
    "create:unrecorded": null,
    loaded: ["ready", []],
    stored: null,
    recorded: null,
    release: null,
    released: null,
    failed: ["absent", []],
    drop: ["absent", []],
  },
  storing: {
    "boot:recorded": null,
    "boot:unrecorded": null,
    "create:recorded": null,
    "create:unrecorded": null,
    loaded: null,
    stored: ["recording", ["record"]],
    recorded: null,
    release: null,
    released: null,
    failed: ["absent", []],
    drop: ["absent", []],
  },
  recording: {
    "boot:recorded": null,
    "boot:unrecorded": null,
    "create:recorded": null,
    "create:unrecorded": null,
    loaded: null,
    stored: null,
    recorded: ["ready", []],
    release: null,
    released: null,
    failed: ["absent", []],
    drop: ["absent", []],
  },
  ready: {
    "boot:recorded": ["ready", []],
    "boot:unrecorded": ["ready", []],
    "create:recorded": ["ready", []],
    "create:unrecorded": ["ready", []],
    loaded: null,
    stored: null,
    recorded: null,
    release: ["releasing", ["release"]],
    released: null,
    failed: null,
    drop: ["absent", []],
  },
  releasing: {
    // A boot or the host's own release event runs the release again; no
    // create is taken until it finishes.
    "boot:recorded": ["releasing", ["release"]],
    "boot:unrecorded": ["releasing", ["release"]],
    "create:recorded": null,
    "create:unrecorded": null,
    loaded: null,
    stored: null,
    recorded: null,
    release: ["releasing", ["release"]],
    released: ["absent", []],
    failed: ["releasing", []],
    drop: ["absent", []],
  },
};

test("a view's lifecycle answers every state and event as its table says", () => {
  for (const name of STATES)
    for (const event of EVENTS) {
      const current = Object.freeze({ name });
      const result = viewStep(current, event);
      const expected = TABLE[name][label(event)];
      const at = `${name} + ${label(event)}`;
      if (expected === null) {
        assert.equal(result.rejected, true, at);
        assert.equal(result.state, current, at);
        assert.deepEqual(result.effects, [], at);
      } else {
        assert.equal(result.rejected, undefined, at);
        assert.equal(result.state.name, expected[0], at);
        assert.deepEqual(result.effects, expected[1], at);
        assert.ok(Object.isFrozen(result.state), at);
      }
    }
});

test("views step apart: one view's write leaves another's state alone", () => {
  const views = new Map([
    ["a", VIEW_ABSENT],
    ["b", VIEW_ABSENT],
  ]);
  const step = (id, event) => {
    const result = viewStep(views.get(id), event);
    assert.ok(!result.rejected, `${id}: ${views.get(id).name} + ${event.type}`);
    views.set(id, result.state);
    return result.effects;
  };
  assert.deepEqual(step("a", { type: "boot", recorded: true }), ["load"]);
  assert.deepEqual(step("b", { type: "create", recorded: false }), ["store"]);
  assert.equal(views.get("a").name, "loading");
  assert.deepEqual(step("b", { type: "failed" }), []);
  assert.equal(views.get("a").name, "loading");
  assert.deepEqual(step("a", { type: "loaded" }), []);
  assert.deepEqual(
    [...views].map(([id, state]) => [id, state.name]),
    [
      ["a", "ready"],
      ["b", "absent"],
    ],
  );
  // The failed write starts over with both idempotent steps.
  assert.deepEqual(step("b", { type: "create", recorded: false }), ["store"]);
  assert.deepEqual(step("b", { type: "stored" }), ["record"]);
  assert.deepEqual(step("b", { type: "recorded" }), []);
  assert.equal(views.get("b").name, "ready");
});

test("a slot with no write is released, retried until its key is gone, and taken again", () => {
  let state = VIEW_ABSENT;
  const step = (event) => {
    const result = viewStep(state, event);
    assert.ok(!result.rejected, `${state.name} + ${event.type}`);
    state = result.state;
    return result.effects;
  };
  step({ type: "create", recorded: false });
  step({ type: "stored" });
  step({ type: "recorded" });
  assert.deepEqual(step({ type: "release" }), ["release"]);
  assert.deepEqual(step({ type: "failed" }), []);
  assert.equal(state.name, "releasing", "a failed release stays releasing");
  assert.equal(viewStep(state, { type: "create", recorded: true }).rejected, true);
  assert.deepEqual(step({ type: "boot", recorded: true }), ["release"]);
  assert.deepEqual(step({ type: "released" }), []);
  assert.equal(state.name, "absent");
  assert.deepEqual(step({ type: "create", recorded: false }), ["store"]);
});
