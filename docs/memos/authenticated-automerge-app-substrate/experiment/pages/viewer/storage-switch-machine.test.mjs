// The storage switch's transition over every state and event. PageSession's
// use of it (edits during the move or after adopting the host's storage,
// close, a second refusal, two tabs) is covered in
// local-first-session.test.mjs.
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
  adopting: { name: "adopting" },
  adopted: { name: "adopted" },
  closed: { name: "closed" },
};
const EVENTS = {
  refusedPlain: { type: "refused", storage: "automerge" },
  refusedNative: { type: "refused", storage: "native" },
  mismatchedPlain: { type: "mismatched", storage: "automerge" },
  mismatchedNative: { type: "mismatched", storage: "native" },
  stripped: { type: "stripped" },
  checkpointed: { type: "checkpointed" },
  moved: { type: "moved", database },
  recorded: { type: "recorded" },
  adopted: { type: "adopted" },
  failed: { type: "failed" },
  close: { type: "close" },
};
const go = (name, effects = [], extra = {}) => ({ state: { name, ...extra }, effects });
const no = (reason) => ({ rejected: reason });
const stale = no(REJECT.stale);
const busy = no(REJECT.busy);
/** A full row: requests answered `request`, completions stale, close closes,
 * then `cells`. */
const row = (request, cells = {}) => ({
  refusedPlain: request,
  refusedNative: request,
  mismatchedPlain: request,
  mismatchedNative: request,
  stripped: stale,
  checkpointed: stale,
  moved: stale,
  recorded: stale,
  adopted: stale,
  failed: stale,
  close: go("closed"),
  ...cells,
});

// Every row: the result of each event from that state.
const TABLE = {
  idle: row(undefined, {
    refusedPlain: go("checkpointing", [{ type: "pause" }, { type: "checkpoint" }]),
    refusedNative: go("stripping", [{ type: "strip" }]),
    mismatchedPlain: go("adopting", [{ type: "pause" }, { type: "adopt", storage: "automerge" }]),
    mismatchedNative: go("adopting", [{ type: "pause" }, { type: "adopt", storage: "native" }]),
  }),
  stripping: row(busy, { stripped: go("idle"), failed: go("idle") }),
  checkpointing: row(busy, {
    checkpointed: go("moving", [{ type: "move" }]),
    failed: go("idle", [{ type: "resume" }]),
  }),
  moving: row(busy, {
    moved: go("recording", [{ type: "record" }], { database }),
    failed: go("failed", [{ type: "reloadRequired" }]),
  }),
  recording: row(busy, {
    recorded: go("idle", [{ type: "resume" }, { type: "deletePlain", database }]),
    failed: go("failed", [{ type: "reloadRequired" }]),
  }),
  failed: row(no(REJECT.failed)),
  adopting: row(busy, {
    // Edits stay paused: the recorded checkpoint is what the reload opens.
    adopted: go("adopted"),
    failed: go("idle", [{ type: "resume" }]),
  }),
  adopted: row(no(REJECT.adopted)),
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
