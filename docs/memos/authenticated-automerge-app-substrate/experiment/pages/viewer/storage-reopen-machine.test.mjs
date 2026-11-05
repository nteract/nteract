// The storage reopen's transition over every state and event. SessionHost's
// use of it, with real PageSessions, is covered in storage-reopen.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REJECT, STORAGE_REOPEN_STATES, storageReopenMachine } from "./storage-reopen-machine.mjs";

const EVENTS = {
  adopted: { type: "adopted" },
  closed: { type: "closed" },
  opened: { type: "opened" },
  failed: { type: "failed" },
};
const go = (name, effects = []) => ({ state: { name }, effects });
const no = (reason) => ({ rejected: reason });
const stale = no(REJECT.stale);
const busy = no(REJECT.busy);
const reload = go("failed", [{ type: "reloadRequired" }]);

const TABLE = {
  idle: {
    adopted: go("closing", [{ type: "close" }]),
    closed: stale,
    opened: stale,
    failed: stale,
  },
  closing: {
    adopted: busy,
    closed: go("opening", [{ type: "open" }]),
    opened: stale,
    failed: reload,
  },
  opening: {
    adopted: busy,
    closed: stale,
    opened: go("reopened", [{ type: "install" }]),
    failed: reload,
  },
  // A second adoption in this tab is a loop: reload instead.
  reopened: { adopted: reload, closed: stale, opened: stale, failed: stale },
  failed: { adopted: reload, closed: stale, opened: stale, failed: stale },
};

test("the storage reopen answers every event in every state", () => {
  assert.deepEqual(Object.keys(TABLE), [...STORAGE_REOPEN_STATES]);
  for (const [stateName, row] of Object.entries(TABLE)) {
    assert.deepEqual(Object.keys(row), Object.keys(EVENTS), stateName);
    for (const [eventName, expected] of Object.entries(row)) {
      const state = { name: stateName };
      const result = storageReopenMachine.step(state, EVENTS[eventName]);
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

test("a reopen closes, opens and installs, and a second adoption asks for a reload", () => {
  const effects = [];
  let state = storageReopenMachine.initial;
  for (const event of [EVENTS.adopted, EVENTS.closed, EVENTS.opened, EVENTS.adopted]) {
    const result = storageReopenMachine.step(state, event);
    state = result.state;
    effects.push(...result.effects.map((effect) => effect.type));
  }
  assert.deepEqual(state, { name: "failed" });
  assert.deepEqual(effects, ["close", "open", "install", "reloadRequired"]);
});
