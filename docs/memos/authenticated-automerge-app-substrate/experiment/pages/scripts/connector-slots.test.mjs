import test from "node:test";
import assert from "node:assert/strict";
import {
  FULL_CONNECTIONS,
  MIN_CONNECTIONS,
  connectorEffect,
  connectorTransition,
  parseConnectorState,
  readyVerdict,
  serializeConnectorState,
  settleConnector,
  startMode,
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
  "stopping legacy→a": {
    phase: "stopping",
    live: "a",
    config: NEW,
    previous: "legacy",
    previousConfig: OLD,
  },
  "stopping a→b": { phase: "stopping", live: "b", config: NEW, previous: "a", previousConfig: OLD },
  "stopping b→a": { phase: "stopping", live: "a", config: NEW, previous: "b", previousConfig: OLD },
  "reverting none→a": { phase: "reverting", live: "none", config: null, next: "a" },
  "reverting legacy→a": { phase: "reverting", live: "legacy", config: OLD, next: "a" },
  "reverting a→b": { phase: "reverting", live: "a", config: OLD, next: "b" },
  "reverting b→a": { phase: "reverting", live: "b", config: OLD, next: "a" },
};
const events = {
  swap: { type: "swap", config: NEW },
  ready: { type: "ready" },
  failed: { type: "failed" },
  lost: { type: "lost" },
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
  // The new unit stopped serving before the old one stopped: start it again
  // while the old one serves.
  "stopping legacy→a/lost": "starting legacy→a",
  "stopping a→b/lost": "starting a→b",
  "stopping b→a/lost": "starting b→a",
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

test("each in-flight state owes exactly one effect, and a handoff's stop names what it keeps", () => {
  const owed = Object.fromEntries(
    Object.entries(states).map(([name, state]) => [name, connectorEffect(state)]),
  );
  assert.deepEqual(owed, {
    absent: null,
    "serving legacy": null,
    "serving a": null,
    "serving b": null,
    "starting none→a": { kind: "start", unit: "a", live: "none" },
    "starting legacy→a": { kind: "start", unit: "a", live: "legacy" },
    "starting a→b": { kind: "start", unit: "b", live: "a" },
    "starting b→a": { kind: "start", unit: "a", live: "b" },
    "stopping legacy→a": { kind: "stop", unit: "legacy", keep: "a" },
    "stopping a→b": { kind: "stop", unit: "a", keep: "b" },
    "stopping b→a": { kind: "stop", unit: "b", keep: "a" },
    "reverting none→a": { kind: "stop", unit: "a" },
    "reverting legacy→a": { kind: "stop", unit: "a" },
    "reverting a→b": { kind: "stop", unit: "b" },
    "reverting b→a": { kind: "stop", unit: "a" },
  });
});

test("an active next unit restarts only while the live one runs", () => {
  assert.equal(startMode({ nextActive: false, liveActive: false }), "start");
  assert.equal(startMode({ nextActive: false, liveActive: true }), "start");
  assert.equal(startMode({ nextActive: true, liveActive: true }), "restart");
  assert.equal(startMode({ nextActive: true, liveActive: false }), "adopt");
});

test("a slot is ready with all its connections, or with two once the budget runs out", () => {
  assert.equal(FULL_CONNECTIONS, 4);
  assert.equal(MIN_CONNECTIONS, 2);
  const report = (readyConnections, status = 200) => ({ status, readyConnections });
  for (const [value, last, expected] of [
    [null, false, "wait"],
    [null, true, "fail"],
    [report(0, 503), false, "wait"],
    [report(4, 503), true, "fail"],
    [report(1), false, "wait"],
    [report(1), true, "fail"],
    [report(2), false, "wait"],
    [report(2), true, "ready"],
    [report(3), false, "wait"],
    [report(3), true, "ready"],
    [report(4), false, "ready"],
    [report(4), true, "ready"],
    [{ status: 200 }, true, "fail"],
  ])
    assert.equal(readyVerdict(value, last), expected, JSON.stringify([value, last]));
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
    serializeConnectorState({ ...states["stopping a→b"], previousConfig: null }),
    serializeConnectorState({ phase: "stopping", live: "b", config: NEW, previous: "a" }),
    serializeConnectorState({ ...states["reverting a→b"], next: "legacy" }),
    serializeConnectorState({ phase: "paused" }),
  ])
    assert.throws(() => parseConnectorState(text), /Invalid tunnel connector state/, text);
});

// A model of systemd and the edge. `running` units hold a process; `ready`
// ones hold edge connections. The harness, not the effects, kills units to
// model crashes. `removals` records every moment an effect takes a unit down,
// with how many ready units remained.
function world({ running = [], failStarts = 0, unready = false } = {}) {
  const w = {
    running: new Set(running),
    ready: new Set(running),
    failStarts,
    unready,
    log: [],
    persisted: [],
    removals: [],
  };
  const take = (unit) => {
    const before = [...w.ready].filter((u) => w.running.has(u)).length;
    w.running.delete(unit);
    const wasReady = w.ready.delete(unit);
    const after = [...w.ready].filter((u) => w.running.has(u)).length;
    w.removals.push({ unit, before, after, wasReady });
  };
  w.effects = {
    persist: (state) => w.persisted.push(state),
    active: (unit) => w.running.has(unit),
    launch: (unit, mode) => {
      w.log.push(mode + " " + unit);
      if (mode === "adopt") return;
      if (mode === "restart") take(unit);
      if (w.failStarts > 0) {
        w.failStarts--;
        throw Error("start " + unit + " failed");
      }
      w.running.add(unit);
      if (!w.unready) w.ready.add(unit);
    },
    ready: (unit) => {
      if (!w.running.has(unit) || !w.ready.has(unit)) throw Error(unit + " is not ready");
    },
    serving: (unit) => w.running.has(unit) && w.ready.has(unit),
    promote: (unit) => w.log.push("promote " + unit),
    stop: (unit) => {
      w.log.push("stop " + unit);
      take(unit);
    },
  };
  return w;
}

test("settling a handoff starts the next unit before stopping the live one", () => {
  const w = world({ running: ["legacy"] });
  const result = settleConnector(states["starting legacy→a"], w.effects);
  assert.deepEqual(w.log, ["start a", "promote a", "stop legacy"]);
  assert.deepEqual(w.persisted, [
    states["stopping legacy→a"],
    { phase: "serving", live: "a", config: NEW },
  ]);
  assert.deepEqual(result, { state: { phase: "serving", live: "a", config: NEW }, failure: null });
});

test("a resumed stop restarts a new unit that died before stopping the old one", () => {
  // The run crashed after persisting `stopping`; slot a died since.
  const w = world({ running: ["legacy"] });
  const result = settleConnector(states["stopping legacy→a"], w.effects);
  assert.deepEqual(w.log, ["start a", "promote a", "stop legacy"]);
  assert.deepEqual(w.persisted, [
    states["starting legacy→a"],
    states["stopping legacy→a"],
    { phase: "serving", live: "a", config: NEW },
  ]);
  assert.equal(result.failure, null);
  assert.ok(w.removals.every(({ after }) => after > 0));
});

test("a resumed start adopts an active next unit when the live one is gone", () => {
  const w = world({ running: ["a"] });
  settleConnector(states["starting legacy→a"], w.effects);
  assert.deepEqual(w.log, ["adopt a", "promote a", "stop legacy"]);
  const both = world({ running: ["legacy", "a"] });
  settleConnector(states["starting legacy→a"], both.effects);
  assert.deepEqual(both.log, ["restart a", "promote a", "stop legacy"]);
  assert.ok(both.removals.every(({ after }) => after > 0));
});

test("a failed start reverts and returns the failure with the live unit untouched", () => {
  const w = world({ running: ["a"], failStarts: 1 });
  const result = settleConnector(states["starting a→b"], w.effects);
  assert.deepEqual(w.log, ["start b", "stop b"]);
  assert.deepEqual(result.state, states["serving a"]);
  assert.match(result.failure.message, /start b failed/);
  assert.ok(w.running.has("a"));
});

test("a revert whose stop fails keeps the original failure as its cause", () => {
  const w = world({ running: ["a"], unready: true });
  w.effects.stop = (unit) => {
    throw Error("stop " + unit + " timed out");
  };
  let thrown;
  try {
    settleConnector(states["starting a→b"], w.effects);
  } catch (error) {
    thrown = error;
  }
  assert.match(thrown.message, /stop b timed out/);
  assert.match(thrown.cause.message, /b is not ready/);
  assert.deepEqual(w.persisted, [states["reverting a→b"]], "the record still owes the stop");
  // A resumed revert has no original failure to carry.
  assert.throws(
    () => settleConnector(states["reverting a→b"], w.effects),
    (error) => {
      assert.equal(error.cause, undefined);
      return /stop b timed out/.test(error.message);
    },
  );
});

test("a failed stop leaves the persisted state owing that stop", () => {
  const w = world({ running: ["a"] });
  w.effects.stop = (unit) => {
    throw Error("stop " + unit + " failed");
  };
  assert.throws(() => settleConnector(states["starting a→b"], w.effects), /stop a failed/);
  assert.deepEqual(w.persisted, [states["stopping a→b"]]);
  const retry = world({ running: ["a", "b"] });
  assert.deepEqual(settleConnector(w.persisted.at(-1), retry.effects).state, {
    phase: "serving",
    live: "b",
    config: NEW,
  });
  assert.deepEqual(retry.log, ["stop a"]);
});

test("a unit that keeps losing readiness stops the handoff instead of looping", () => {
  const w = world({ running: ["legacy"] });
  // Ready when started, gone by the time the old unit would stop.
  w.effects.serving = () => false;
  assert.throws(() => settleConnector(states["starting legacy→a"], w.effects), /did not settle/);
  assert.ok(w.running.has("legacy"), "the old unit never stopped");
});

test("settled states run no effects", () => {
  for (const name of ["absent", "serving legacy", "serving a", "serving b"]) {
    const w = world();
    assert.deepEqual(settleConnector(states[name], w.effects), {
      state: states[name],
      failure: null,
    });
    assert.deepEqual(w.log, []);
    assert.deepEqual(w.persisted, []);
  }
});

// Crash the handoff at every persist, kill any running unit at the crash, then
// resume as the publisher does. No effect may take down the last ready unit.
test("no crash point, failed start or dead unit makes an effect drop the last ready connector", () => {
  class Crash extends Error {}
  let scenarios = 0;
  for (const [initial, running] of [
    [states["serving legacy"], ["legacy"]],
    [states["serving a"], ["a"]],
  ])
    for (const injection of [{}, { failStarts: 1 }, { failStarts: 2 }, { unready: true }])
      for (let crashAt = 1; crashAt <= 6; crashAt++)
        for (const written of [false, true])
          for (const kill of [null, "legacy", "a", "b"]) {
            const w = world({ running, ...injection });
            let record = initial;
            let persists = 0;
            const persist = (state) => {
              if (++persists === crashAt) {
                if (written) record = state;
                throw new Crash();
              }
              record = state;
            };
            const effects = { ...w.effects, persist };
            const publish = () => {
              let { state, failure } = settleConnector(record, effects);
              if (!failure && (state.live === "legacy" || state.config !== NEW)) {
                const swap = connectorTransition(state, { type: "swap", config: NEW });
                effects.persist(swap);
                ({ state, failure } = settleConnector(swap, effects));
              }
              // The publisher's steady step starts a settled live slot that
              // isn't running.
              if (!failure && !w.running.has(state.live))
                try {
                  effects.launch(state.live, "start");
                } catch (error) {
                  failure = error;
                }
              return { state, failure };
            };
            let outcome;
            try {
              outcome = publish();
            } catch (error) {
              if (!(error instanceof Crash)) throw error;
              if (kill) {
                w.running.delete(kill);
                w.ready.delete(kill);
              }
              outcome = publish();
            }
            scenarios++;
            const label = JSON.stringify({
              initial: initial.live,
              injection,
              crashAt,
              written,
              kill,
            });
            for (const removal of w.removals)
              assert.ok(
                removal.before === 0 || removal.after > 0,
                label + " dropped the last ready connector: " + w.log.join(", "),
              );
            assert.equal(outcome.state.phase, "serving", label);
            if (!outcome.failure) {
              assert.equal(outcome.state.config, NEW, label);
              assert.ok(w.ready.has(outcome.state.live), label + " ends without a ready live unit");
            }
          }
  assert.ok(scenarios > 300);
});
