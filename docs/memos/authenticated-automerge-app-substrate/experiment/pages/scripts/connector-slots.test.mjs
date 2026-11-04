import test from "node:test";
import assert from "node:assert/strict";
import {
  connectorEffect,
  connectorTransition,
  parseConnectorState,
  serializeConnectorState,
  settleConnector,
} from "./deployment/connector-slots.mjs";

const OLD = "1".repeat(64);
const NEW = "2".repeat(64);

const states = {
  absent: { phase: "absent" },
  "serving legacy": { phase: "serving", live: "legacy", config: OLD },
  "serving a": { phase: "serving", live: "a", config: OLD },
  "serving b": { phase: "serving", live: "b", config: OLD },
  "starting none→a": { phase: "starting", live: "none", config: null, next: "a", nextConfig: NEW },
  "starting legacy→a": {
    phase: "starting",
    live: "legacy",
    config: OLD,
    next: "a",
    nextConfig: NEW,
  },
  "starting a→b": { phase: "starting", live: "a", config: OLD, next: "b", nextConfig: NEW },
  "starting b→a": { phase: "starting", live: "b", config: OLD, next: "a", nextConfig: NEW },
  "stopping legacy→a": { phase: "stopping", live: "a", config: NEW, previous: "legacy" },
  "stopping a→b": { phase: "stopping", live: "b", config: NEW, previous: "a" },
  "stopping b→a": { phase: "stopping", live: "a", config: NEW, previous: "b" },
  "reverting none→a": { phase: "reverting", live: "none", config: null, next: "a" },
  "reverting legacy→a": { phase: "reverting", live: "legacy", config: OLD, next: "a" },
  "reverting a→b": { phase: "reverting", live: "a", config: OLD, next: "b" },
  "reverting b→a": { phase: "reverting", live: "b", config: OLD, next: "a" },
};
const events = {
  swap: { type: "swap", config: NEW },
  ready: { type: "ready" },
  failed: { type: "failed" },
  stopped: { type: "stopped" },
};
// Every allowed (state, event) pair and where it leads. Every other pair throws.
const allowed = {
  "absent/swap": "starting none→a",
  "serving legacy/swap": "starting legacy→a",
  "serving a/swap": "starting a→b",
  "serving b/swap": "starting b→a",
  "starting none→a/ready": { phase: "serving", live: "a", config: NEW },
  "starting legacy→a/ready": "stopping legacy→a",
  "starting a→b/ready": "stopping a→b",
  "starting b→a/ready": "stopping b→a",
  "starting none→a/failed": "reverting none→a",
  "starting legacy→a/failed": "reverting legacy→a",
  "starting a→b/failed": "reverting a→b",
  "starting b→a/failed": "reverting b→a",
  "stopping legacy→a/stopped": { phase: "serving", live: "a", config: NEW },
  "stopping a→b/stopped": { phase: "serving", live: "b", config: NEW },
  "stopping b→a/stopped": { phase: "serving", live: "a", config: NEW },
  "reverting none→a/stopped": "absent",
  "reverting legacy→a/stopped": "serving legacy",
  "reverting a→b/stopped": "serving a",
  "reverting b→a/stopped": "serving b",
};

test("connector transitions cover every state and event", () => {
  for (const [stateName, state] of Object.entries(states))
    for (const [eventName, event] of Object.entries(events)) {
      const expected = allowed[stateName + "/" + eventName];
      const frozen = structuredClone(state);
      if (expected === undefined)
        assert.throws(
          () => connectorTransition(state, event),
          /Connector cannot handle/,
          stateName + "/" + eventName,
        );
      else
        assert.deepEqual(
          connectorTransition(state, event),
          typeof expected === "string" ? states[expected] : expected,
          stateName + "/" + eventName,
        );
      assert.deepEqual(state, frozen, "transitions never mutate their input");
    }
});

test("a swap must name the config digest it serves", () => {
  for (const config of [undefined, "", "abc", "G".repeat(64)])
    assert.throws(
      () => connectorTransition(states["serving a"], { type: "swap", config }),
      /config digest/,
    );
});

test("once a unit serves the tunnel, every reachable state keeps one serving", () => {
  // Units that hold edge connections in each state. `starting` and
  // `reverting` keep the live unit up; `stopping` keeps the new one.
  const serving = (state) =>
    state.phase === "absent" || state.live === "none" ? [] : [state.live];
  const seen = new Set();
  const queue = [states["serving legacy"], states["serving a"]];
  while (queue.length) {
    const state = queue.shift();
    const key = JSON.stringify(state);
    if (seen.has(key)) continue;
    seen.add(key);
    assert.ok(serving(state).length > 0, "no connector in " + key);
    for (const event of Object.values(events)) {
      let next;
      try {
        next = connectorTransition(state, event);
      } catch {
        continue;
      }
      queue.push(next);
    }
  }
  assert.ok(seen.size >= 9);
});

test("each in-flight state owes exactly one effect", () => {
  const owed = Object.fromEntries(
    Object.entries(states).map(([name, state]) => [name, connectorEffect(state)]),
  );
  assert.deepEqual(owed, {
    absent: null,
    "serving legacy": null,
    "serving a": null,
    "serving b": null,
    "starting none→a": { kind: "start", unit: "a" },
    "starting legacy→a": { kind: "start", unit: "a" },
    "starting a→b": { kind: "start", unit: "b" },
    "starting b→a": { kind: "start", unit: "a" },
    "stopping legacy→a": { kind: "stop", unit: "legacy" },
    "stopping a→b": { kind: "stop", unit: "a" },
    "stopping b→a": { kind: "stop", unit: "b" },
    "reverting none→a": { kind: "stop", unit: "a" },
    "reverting legacy→a": { kind: "stop", unit: "a" },
    "reverting a→b": { kind: "stop", unit: "b" },
    "reverting b→a": { kind: "stop", unit: "a" },
  });
});

test("connector state round-trips and rejects anything else", () => {
  for (const state of Object.values(states))
    assert.deepEqual(parseConnectorState(serializeConnectorState(state)), state);
  for (const text of [
    "",
    "null",
    "{}",
    JSON.stringify({ phase: "serving", live: "a", config: OLD }),
    JSON.stringify({ schema: 2, phase: "absent" }),
    serializeConnectorState({ ...states["serving a"], extra: true }),
    serializeConnectorState({ phase: "serving", live: "c", config: OLD }),
    serializeConnectorState({ phase: "serving", live: "none", config: null }),
    serializeConnectorState({ phase: "serving", live: "a", config: "short" }),
    serializeConnectorState({ ...states["starting a→b"], next: "a" }),
    serializeConnectorState({ ...states["starting a→b"], next: "legacy" }),
    serializeConnectorState({ ...states["starting none→a"], next: "b" }),
    serializeConnectorState({ ...states["starting a→b"], nextConfig: null }),
    serializeConnectorState({ ...states["stopping a→b"], previous: "b" }),
    serializeConnectorState({ ...states["stopping a→b"], live: "legacy" }),
    serializeConnectorState({ ...states["reverting a→b"], next: "legacy" }),
    serializeConnectorState({ phase: "paused" }),
  ])
    assert.throws(() => parseConnectorState(text), /Invalid tunnel connector state/, text);
});

function effects({ failStart = [], failStop = [] } = {}) {
  const log = [];
  const persisted = [];
  return {
    log,
    persisted,
    persist: (state) => persisted.push(state),
    start: (unit) => {
      log.push("start " + unit);
      if (failStart.includes(unit)) throw Error("start " + unit + " failed");
    },
    stop: (unit) => {
      log.push("stop " + unit);
      if (failStop.includes(unit)) throw Error("stop " + unit + " failed");
    },
  };
}

test("settling a handoff starts the next unit before stopping the live one", () => {
  const e = effects();
  const result = settleConnector(states["starting legacy→a"], e);
  assert.deepEqual(e.log, ["start a", "stop legacy"]);
  assert.deepEqual(e.persisted, [
    states["stopping legacy→a"],
    { phase: "serving", live: "a", config: NEW },
  ]);
  assert.deepEqual(result, {
    state: { phase: "serving", live: "a", config: NEW },
    failure: null,
  });
});

test("a failed start reverts and returns the failure with the live unit untouched", () => {
  const e = effects({ failStart: ["b"] });
  const result = settleConnector(states["starting a→b"], e);
  assert.deepEqual(e.log, ["start b", "stop b"]);
  assert.deepEqual(result.state, states["serving a"]);
  assert.match(result.failure.message, /start b failed/);
});

test("a failed stop leaves the persisted state owing that stop", () => {
  const e = effects({ failStop: ["a"] });
  assert.throws(() => settleConnector(states["starting a→b"], e), /stop a failed/);
  assert.deepEqual(e.persisted, [states["stopping a→b"]]);
  const retry = effects();
  assert.deepEqual(settleConnector(e.persisted.at(-1), retry).state, {
    phase: "serving",
    live: "b",
    config: NEW,
  });
  assert.deepEqual(retry.log, ["stop a"]);
});

test("settled states run no effects", () => {
  for (const name of ["absent", "serving legacy", "serving a", "serving b"]) {
    const e = effects();
    assert.deepEqual(settleConnector(states[name], e), { state: states[name], failure: null });
    assert.deepEqual(e.log, []);
    assert.deepEqual(e.persisted, []);
  }
});
