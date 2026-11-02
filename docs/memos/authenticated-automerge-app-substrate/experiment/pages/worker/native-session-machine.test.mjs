import assert from "node:assert/strict";
import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import { REJECT, nativeSessionMachine } from "./native-session-machine.mjs";

const tab = { principal: "user:owner", driver: "browser" };
const held = (session, holder = tab) => ({ name: "held", session, ...holder });

test("every native session slot state answers every event", async () => {
  assert.deepEqual(
    await runTable(nativeSessionMachine, [
      {
        label: "a first connection takes the free slot",
        state: { name: "free" },
        event: { type: "admit", session: 1, ...tab },
        expect: { state: held(1), effects: [{ type: "install", session: 1 }] },
      },
      {
        label: "a late cleanup after the slot was freed changes nothing",
        state: { name: "free" },
        event: { type: "end", session: 1 },
        expect: { state: { name: "free" }, effects: [], rejected: REJECT.empty },
      },
      {
        case: "same-holder",
        label: "the same tab reconnecting replaces the connection that still holds its key",
        state: held(1),
        event: { type: "admit", session: 2, ...tab },
        expect: {
          state: held(2),
          effects: [
            { type: "install", session: 2 },
            { type: "replace", session: 1 },
          ],
        },
      },
      {
        case: "other-holder",
        label: "another driver never takes a held key",
        state: held(1),
        event: { type: "admit", session: 2, principal: "user:owner", driver: "Mobile" },
        expect: { state: held(1), effects: [], rejected: REJECT.mismatch },
      },
      {
        case: "this-session",
        label: "the holder's socket closed",
        state: held(1),
        event: { type: "end", session: 1 },
        expect: { state: { name: "free" }, effects: [{ type: "remove", session: 1 }] },
      },
      {
        case: "replaced-session",
        label: "a replaced connection's cleanup leaves its replacement",
        state: held(2),
        event: { type: "end", session: 1 },
        expect: { state: held(2), effects: [], rejected: REJECT.replaced },
      },
    ]),
    { rows: 6, pairs: 4, unreachable: 0, cases: 4 },
  );
});

test("a credential without a driver holds the slot as null, and only null matches it", () => {
  const anonymous = { principal: "user:owner", driver: null };
  const first = nativeSessionMachine.step(nativeSessionMachine.initial, {
    type: "admit",
    session: 1,
    ...anonymous,
  });
  assert.deepEqual(first.state, held(1, anonymous));
  const again = nativeSessionMachine.step(first.state, { type: "admit", session: 2, ...anonymous });
  assert.deepEqual(again.state, held(2, anonymous));
  const named = nativeSessionMachine.step(first.state, { type: "admit", session: 2, ...tab });
  assert.equal(named.rejected, REJECT.mismatch);
});

test("the slot rejects malformed sessions and holders", () => {
  for (const event of [
    { type: "admit", session: 0, ...tab },
    { type: "admit", session: 1, principal: "", driver: null },
    { type: "admit", session: 1, principal: "user:owner" },
    { type: "end", session: 1.5 },
    { type: "end", session: 1, extra: true },
  ])
    assert.throws(() => nativeSessionMachine.step(held(1), event), /native-session/);
});
