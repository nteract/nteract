import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MachineError, defineMachine, reject } from "../shared/machine.mjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { backoffDelay, reconnect } from "./example-reconnect.mjs";

const TABLE = new URL("./fixtures/machines/example-reconnect.json", import.meta.url);

const lamp = {
  name: "lamp",
  states: ["off", "on"],
  events: ["flip", "hold"],
  transition(state, event) {
    if (event.type === "hold") return reject(state, "held");
    return state.name === "off"
      ? { state: { name: "on" }, effects: [{ type: "light" }] }
      : { state: { name: "off" }, effects: [{ type: "dark" }] };
  },
};

// A machine whose transition returns whatever `result(state)` builds.
const returning = (result) => defineMachine({ ...lamp, transition: (state) => result(state) });

test("defineMachine rejects malformed definitions", () => {
  const cases = [
    [{ ...lamp, name: "" }, /needs a name/],
    [{ ...lamp, states: [] }, /states must be a non-empty array/],
    [{ ...lamp, states: ["off", "off"] }, /states lists "off" twice/],
    [{ ...lamp, events: ["flip", 3] }, /events must be non-empty strings/],
    [{ ...lamp, transition: undefined }, /transition must be a function/],
    [{ ...lamp, initial: "dim" }, /initial state "dim" is not a state/],
    [{ ...lamp, unreachable: [["off", "flip"]] }, /\[state, event, reason\]/],
    [{ ...lamp, unreachable: [["dim", "flip", "never"]] }, /unknown state "dim"/],
    [{ ...lamp, unreachable: [["off", "kick", "never"]] }, /unknown event "kick"/],
    [{ ...lamp, unreachable: [["off", "flip", " "]] }, /off × flip needs a reason/],
    [
      {
        ...lamp,
        unreachable: [
          ["on", "hold", "a"],
          ["on", "hold", "b"],
        ],
      },
      /on × hold twice/,
    ],
    [{ ...lamp, unreachables: [] }, /unknown option unreachables/],
  ];
  for (const [spec, message] of cases) {
    assert.throws(
      () => defineMachine(spec),
      (error) => error instanceof MachineError && message.test(error.message),
    );
  }
});

test("step validates its input and the transition's result", () => {
  const machine = defineMachine(lamp);
  const off = { name: "off" };
  const flip = { type: "flip" };
  assert.deepEqual(machine.step(off, flip), {
    state: { name: "on" },
    effects: [{ type: "light" }],
  });
  assert.throws(() => machine.step(off, { type: "kick" }), /lamp: event "kick" is not an event/);
  assert.throws(() => machine.step({ name: "dim" }, flip), /state "dim" is not a state/);
  assert.throws(() => machine.step("off", flip), /state must be an object with a name/);
  assert.throws(
    () => machine.step({ name: "off", at: new Date(0) }, flip),
    /state.at is a Date, not JSON data/,
  );

  const cases = [
    [() => ({ state: { name: "dim" }, effects: [] }), /next state "dim" is not a state/],
    [() => ({ state: { name: "on" } }), /effects must be an array/],
    [
      () => ({ state: { name: "on" }, effects: [{ kind: "light" }] }),
      /effects\[0\] must be an object with a type/,
    ],
    [
      () => ({ state: { name: "on" }, effects: [{ type: "light", at: undefined }] }),
      /effects\[0\].at is undefined/,
    ],
    [
      () => ({ state: { name: "on" }, effects: [{ type: "wait", ms: NaN }] }),
      /effects\[0\].ms is not a finite number/,
    ],
    [() => ({ state: { name: "on" }, effects: [], effect: [] }), /unexpected result key effect/],
    [() => ({ state: { name: "on" }, effects: [], response: () => {} }), /response is function/],
    [
      () => ({ state: { name: "on" }, effects: [], rejected: "no" }),
      /a rejection must return the input state/,
    ],
    [
      (state) => ({ state, effects: [{ type: "light" }], rejected: "no" }),
      /a rejection must not emit effects/,
    ],
    [(state) => ({ state, effects: [], rejected: "" }), /rejected must be a reason string/],
    [
      () => {
        const state = { name: "on", self: null };
        state.self = state;
        return { state, effects: [] };
      },
      /next state.self is circular/,
    ],
  ];
  for (const [result, message] of cases)
    assert.throws(() => returning(result).step(off, flip), message);
});

test("reject keeps the state, emits nothing and gives a reason", () => {
  const off = { name: "off" };
  const rejected = defineMachine(lamp).step(off, { type: "hold" });
  assert.deepEqual(rejected, { state: off, effects: [], rejected: "held" });
  assert.equal(rejected.state, off);
  assert.deepEqual(reject(off, "busy", { response: { status: 409 } }), {
    state: off,
    effects: [],
    rejected: "busy",
    response: { status: 409 },
  });
});

test("step throws on a declared unreachable pair without calling the transition", () => {
  let calls = 0;
  const machine = defineMachine({
    ...lamp,
    unreachable: [["on", "hold", "only an off lamp can be held"]],
    transition(state, event) {
      calls++;
      return lamp.transition(state, event);
    },
  });
  assert.throws(
    () => machine.step({ name: "on" }, { type: "hold" }),
    /lamp: on × hold is unreachable: only an off lamp can be held/,
  );
  assert.equal(calls, 0);
  assert.equal(machine.unreachableReason("on", "hold"), "only an off lamp can be held");
  assert.equal(machine.unreachableReason("off", "hold"), undefined);
  assert.throws(
    () => reconnect.step({ name: "open", generation: 1, attempt: 0 }, { type: "timer" }),
    /open × timer is unreachable/,
  );
});

test("initial accepts a state name and is frozen", () => {
  assert.deepEqual(defineMachine({ ...lamp, initial: "off" }).initial, { name: "off" });
  assert.equal(defineMachine(lamp).initial, undefined);
  assert.ok(Object.isFrozen(reconnect.initial));
  assert.throws(() => {
    reconnect.initial.generation = 1;
  }, TypeError);
});

test("the reconnect table covers every pair and passes against the machine", async () => {
  assert.deepEqual(await runTable(reconnect, loadTable(TABLE)), {
    rows: 14,
    pairs: 11,
    unreachable: 5,
  });
});

// Shaped like code before extraction: booleans, a counter, and early throws.
class Refused extends Error {}
class FlagReconnect {
  constructor(fields, emit) {
    Object.assign(
      this,
      { connecting: false, open: false, timer: false, generation: 0, attempt: 0 },
      fields,
    );
    this.emit = emit;
  }
  connect() {
    if (this.connecting) throw new Refused("already connecting");
    if (this.open) throw new Refused("already open");
    if (this.timer) {
      this.timer = false;
      this.emit({ type: "cancelTimer" });
    }
    this.dial();
  }
  socket(type, generation) {
    if (generation !== this.generation) throw new Refused("stale generation");
    if (this.timer) throw new Refused("socket already closed");
    if (type === "opened") {
      if (this.open) throw new Refused("already open");
      Object.assign(this, { connecting: false, open: true, attempt: 0 });
      return;
    }
    Object.assign(this, { connecting: false, open: false, timer: true, attempt: this.attempt + 1 });
    this.emit({ type: "schedule", delayMs: backoffDelay(this.attempt) });
  }
  fire() {
    this.timer = false;
    this.dial();
  }
  dial() {
    this.generation += 1;
    this.connecting = true;
    this.emit({ type: "dial", generation: this.generation });
  }
}

const FLAGS = {
  idle: {},
  connecting: { connecting: true },
  open: { open: true },
  backoff: { timer: true },
};

// The adapter maps a row's state onto the flags, calls the old method, and
// reads the flags back. A refusal becomes a rejection with the same reason.
async function driveFlags(state, event) {
  const effects = [];
  const fields = { ...FLAGS[state.name], generation: state.generation, attempt: state.attempt };
  const legacy = new FlagReconnect(fields, (effect) => effects.push(effect));
  try {
    if (event.type === "connect") legacy.connect();
    else if (event.type === "timer") legacy.fire();
    else legacy.socket(event.type, event.generation);
  } catch (error) {
    if (error instanceof Refused) return { state, effects: [], rejected: error.message };
    throw error;
  }
  const name = legacy.open
    ? "open"
    : legacy.connecting
      ? "connecting"
      : legacy.timer
        ? "backoff"
        : "idle";
  return { state: { name, generation: legacy.generation, attempt: legacy.attempt }, effects };
}

test("the same table drives flag-style code through an adapter", async () => {
  // Before a transition exists, the table needs only the machine's names.
  const spec = {
    name: "example-reconnect",
    states: reconnect.states,
    events: reconnect.events,
    unreachable: reconnect.unreachable,
  };
  assert.deepEqual(await runTable(spec, loadTable(TABLE), { drive: driveFlags }), {
    rows: 14,
    pairs: 11,
    unreachable: 5,
  });
  await assert.rejects(
    runTable(spec, loadTable(TABLE)),
    /pass drive, or a machine from defineMachine/,
  );
});

test("runTable fails when a pair has neither a row nor an unreachable entry", async () => {
  const rows = loadTable(TABLE).rows.filter(
    (row) => !(row.state.name === "backoff" && row.event.type === "timer"),
  );
  await assert.rejects(runTable(reconnect, rows), (error) => {
    assert.match(
      error.message,
      /example-reconnect: no row or unreachable entry for 1 pair:\n {2}backoff × timer$/,
    );
    return true;
  });
  const extra = [["backoff", "timer", "this run skips timers"]];
  assert.equal((await runTable(reconnect, rows, { unreachable: extra })).unreachable, 6);
});

test("runTable fails when a row covers an unreachable pair", async () => {
  const open = { name: "open", generation: 1, attempt: 0 };
  const rows = [
    ...loadTable(TABLE).rows,
    { state: open, event: { type: "timer" }, expect: { state: open, effects: [] } },
  ];
  await assert.rejects(
    runTable(reconnect, rows),
    /row 14 \(open × timer\) covers an unreachable pair/,
  );
});

test("runTable reports every failing row by label", async () => {
  const rows = structuredClone(loadTable(TABLE).rows);
  rows[0].expect.effects = [];
  rows[5].expect.state.attempt = 9;
  await assert.rejects(runTable(reconnect, rows), (error) => {
    assert.match(error.message, /2 of 14 rows failed/);
    assert.match(error.message, /row 0 \(idle × connect\): effects: Expected values/);
    assert.match(
      error.message,
      /row 5 \(connecting × closed caps the delay\): state: Expected values/,
    );
    return true;
  });
});

test("runTable checks a table against the machine", async () => {
  const table = loadTable(TABLE);
  await assert.rejects(
    runTable(reconnect, { ...table, machine: "other" }),
    /the table is for other/,
  );
  await assert.rejects(
    runTable(reconnect, { ...table, states: [...table.states, "paused"] }),
    /the table's states differ from the machine's/,
  );
  await assert.rejects(
    runTable(reconnect, { ...table, unreachable: table.unreachable.slice(1) }),
    /the table's unreachable pairs differ from the machine's/,
  );
  await assert.rejects(runTable(reconnect, { ...table, extra: true }), /unknown table key extra/);
  const typo = structuredClone(table);
  typo.rows[0].expected = typo.rows[0].expect;
  await assert.rejects(
    runTable(reconnect, typo),
    /row 0 \(idle × connect\) has unknown key expected/,
  );
});

test("runTable catches a transition that mutates its input or varies between runs", async () => {
  const counter = { name: "counter", states: ["ready"], events: ["tick"] };
  const row = {
    state: { name: "ready", count: 0 },
    event: { type: "tick" },
    expect: { state: { name: "ready", count: 1 }, effects: [] },
  };
  const mutating = defineMachine({
    ...counter,
    transition(state) {
      state.count += 1;
      return { state: { ...state }, effects: [] };
    },
  });
  await assert.rejects(runTable(mutating, [structuredClone(row)]), /input state was mutated/);
  let ticks = 0;
  const varying = defineMachine({
    ...counter,
    transition: () => ({ state: { name: "ready", count: ++ticks }, effects: [] }),
  });
  await assert.rejects(runTable(varying, [row]), /a second step differed/);
});

test("loadTable reads JSON and rejects a file without the table shape", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pages-machine-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "table.json");
  writeFileSync(
    file,
    JSON.stringify({ machine: "lamp", states: ["off"], events: ["flip"], unreachable: [] }),
  );
  assert.throws(() => loadTable(file), /table.json: rows must be an array/);
  writeFileSync(file, JSON.stringify([]));
  assert.throws(() => loadTable(file), /a table must be an object/);
});
