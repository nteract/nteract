// The storage switch's transition over every state and event. PageSession's
// use of it (edits during the move, close, a second refusal, two tabs) is
// covered in local-first-session.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REJECT, STORAGE_SWITCH_STATES, storageSwitchMachine } from "./storage-switch-machine.mjs";

const database = "pages-plain-fixture";
const STATES = {
  idle: { name: "idle" },
  stripping: { name: "stripping" },
  checkpointing: { name: "checkpointing" },
  moving: { name: "moving" },
  recording: { name: "recording", database },
  failed: { name: "failed" },
  closed: { name: "closed" },
};
const EVENTS = {
  refusedPlain: { type: "refused", storage: "automerge" },
  refusedNative: { type: "refused", storage: "native" },
  stripped: { type: "stripped" },
  checkpointed: { type: "checkpointed" },
  moved: { type: "moved", database },
  recorded: { type: "recorded" },
  failed: { type: "failed" },
  close: { type: "close" },
};
const go = (name, effects = [], extra = {}) => ({ state: { name, ...extra }, effects });
const no = (reason) => ({ rejected: reason });
const closed = go("closed");
const stale = no(REJECT.stale);

// Every row: the result of each event from that state.
const TABLE = {
  idle: {
    refusedPlain: go("checkpointing", [{ type: "pause" }, { type: "checkpoint" }]),
    refusedNative: go("stripping", [{ type: "strip" }]),
    stripped: stale,
    checkpointed: stale,
    moved: stale,
    recorded: stale,
    failed: stale,
    close: closed,
  },
  stripping: {
    refusedPlain: no(REJECT.busy),
    refusedNative: no(REJECT.busy),
    stripped: go("idle"),
    checkpointed: stale,
    moved: stale,
    recorded: stale,
    failed: go("idle"),
    close: closed,
  },
  checkpointing: {
    refusedPlain: no(REJECT.busy),
    refusedNative: no(REJECT.busy),
    stripped: stale,
    checkpointed: go("moving", [{ type: "move" }]),
    moved: stale,
    recorded: stale,
    failed: go("idle", [{ type: "resume" }]),
    close: closed,
  },
  moving: {
    refusedPlain: no(REJECT.busy),
    refusedNative: no(REJECT.busy),
    stripped: stale,
    checkpointed: stale,
    moved: go("recording", [{ type: "record" }], { database }),
    recorded: stale,
    failed: go("failed", [{ type: "reloadRequired" }]),
    close: closed,
  },
  recording: {
    refusedPlain: no(REJECT.busy),
    refusedNative: no(REJECT.busy),
    stripped: stale,
    checkpointed: stale,
    moved: stale,
    recorded: go("idle", [{ type: "resume" }, { type: "deletePlain", database }]),
    failed: go("failed", [{ type: "reloadRequired" }]),
    close: closed,
  },
  failed: {
    refusedPlain: no(REJECT.failed),
    refusedNative: no(REJECT.failed),
    stripped: stale,
    checkpointed: stale,
    moved: stale,
    recorded: stale,
    failed: stale,
    close: closed,
  },
  closed: Object.fromEntries(Object.keys(EVENTS).map((event) => [event, no(REJECT.closed)])),
};

test("the storage switch answers every event in every state", () => {
  assert.deepEqual(Object.keys(TABLE), [...STORAGE_SWITCH_STATES]);
  for (const [stateName, row] of Object.entries(TABLE)) {
    assert.deepEqual(Object.keys(row), Object.keys(EVENTS), stateName);
    for (const [eventName, expected] of Object.entries(row)) {
      const state = STATES[stateName];
      const result = storageSwitchMachine.step(state, EVENTS[eventName]);
      const label = `${stateName} × ${eventName}`;
      if (expected.rejected) {
        assert.equal(result.rejected, expected.rejected, label);
        assert.equal(result.state, state, label);
      } else {
        assert.equal(result.rejected, undefined, label);
        assert.deepEqual(result.state, expected.state, label);
        assert.deepEqual(result.effects, expected.effects, label);
      }
    }
  }
});

test("a plain draft's move pauses before its checkpoint and deletes the plain replica last", () => {
  const effects = [];
  let state = storageSwitchMachine.initial;
  for (const event of [EVENTS.refusedPlain, EVENTS.checkpointed, EVENTS.moved, EVENTS.recorded]) {
    const result = storageSwitchMachine.step(state, event);
    state = result.state;
    effects.push(...result.effects.map((effect) => effect.type));
  }
  assert.deepEqual(state, { name: "idle" });
  assert.deepEqual(effects, ["pause", "checkpoint", "move", "record", "resume", "deletePlain"]);
});
