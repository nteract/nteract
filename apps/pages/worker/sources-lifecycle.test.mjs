import assert from "node:assert/strict";
import test from "node:test";
import { SOURCES_ABSENT, sourcesStep } from "./sources-lifecycle.mjs";

const STATES = ["absent", "loading", "storing", "recording", "ready"];
const EVENTS = [
  { type: "boot", recorded: true },
  { type: "boot", recorded: false },
  { type: "create", recorded: true },
  { type: "create", recorded: false },
  { type: "loaded" },
  { type: "stored" },
  { type: "recorded" },
  { type: "failed" },
  { type: "drop" },
];
const label = (event) =>
  ["boot", "create"].includes(event.type)
    ? `${event.type}:${event.recorded ? "recorded" : "unrecorded"}`
    : event.type;

// Every state and event: `[next state, effects]`, or null for a rejected
// event that leaves the state alone.
const TABLE = {
  absent: {
    "boot:recorded": ["loading", ["load"]],
    "boot:unrecorded": ["absent", []],
    "create:recorded": ["loading", ["load"]],
    "create:unrecorded": ["storing", ["store"]],
    loaded: null,
    stored: null,
    recorded: null,
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
    failed: null,
    drop: ["absent", []],
  },
};

test("the sources lifecycle answers every state and event as its table says", () => {
  for (const name of STATES)
    for (const event of EVENTS) {
      const current = Object.freeze({ name });
      const result = sourcesStep(current, event);
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

test("a first write runs store then record, and a failure at either starts over", () => {
  const run = (events) => {
    let state = SOURCES_ABSENT;
    const effects = [];
    for (const event of events) {
      const result = sourcesStep(state, event);
      assert.ok(!result.rejected, `${state.name} + ${event.type}`);
      state = result.state;
      effects.push(...result.effects);
    }
    return { state: state.name, effects };
  };
  assert.deepEqual(
    run([{ type: "create", recorded: false }, { type: "stored" }, { type: "recorded" }]),
    {
      state: "ready",
      effects: ["store", "record"],
    },
  );
  // A failed record (or store) leaves nothing to resume: the next write runs
  // both idempotent steps again.
  assert.deepEqual(
    run([
      { type: "create", recorded: false },
      { type: "stored" },
      { type: "failed" },
      { type: "create", recorded: false },
      { type: "stored" },
      { type: "recorded" },
    ]),
    { state: "ready", effects: ["store", "record", "store", "record"] },
  );
  // A failed load forgets nothing the record holds: a write on a Page whose
  // record names the type loads it and replays its journal, never stores.
  assert.deepEqual(
    run([
      { type: "boot", recorded: true },
      { type: "failed" },
      { type: "create", recorded: true },
      { type: "loaded" },
    ]),
    { state: "ready", effects: ["load", "load"] },
  );
  // A restart boots from the record alone.
  assert.deepEqual(run([{ type: "boot", recorded: false }]), { state: "absent", effects: [] });
  assert.deepEqual(run([{ type: "boot", recorded: true }, { type: "loaded" }]), {
    state: "ready",
    effects: ["load"],
  });
});
