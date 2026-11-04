import assert from "node:assert/strict";
import { test } from "node:test";
import { RECEIVE_LIMITS, RECEIVE_OPEN, receiveStep } from "./receive-queue.mjs";

const limits = { maxFrames: 2, maxBytes: 100 };
const open = (frames, bytes) => ({ phase: "open", frames, bytes });
const overflowed = (frames, bytes) => ({ phase: "overflowed", frames, bytes });
const closed = { phase: "closed", frames: 0, bytes: 0 };

// Every state the queue can be in, crossed with every event.
const cases = [
  // open, empty
  [open(0, 0), { type: "arrive", bytes: 40 }, open(1, 40), "admit"],
  [open(0, 0), { type: "arrive", bytes: 100 }, open(1, 100), "admit"],
  [open(0, 0), { type: "arrive", bytes: 101 }, overflowed(0, 0), "refuse"],
  [open(0, 0), { type: "settle", bytes: 0 }, open(0, 0), null],
  [open(0, 0), { type: "close" }, closed, null],
  // open, one frame waiting
  [open(1, 40), { type: "arrive", bytes: 60 }, open(2, 100), "admit"],
  [open(1, 40), { type: "arrive", bytes: 61 }, overflowed(1, 40), "refuse"],
  [open(1, 40), { type: "settle", bytes: 40 }, open(0, 0), null],
  [open(1, 40), { type: "close" }, closed, null],
  // open, at the frame limit
  [open(2, 10), { type: "arrive", bytes: 0 }, overflowed(2, 10), "refuse"],
  [open(2, 10), { type: "settle", bytes: 4 }, open(1, 6), null],
  [open(2, 10), { type: "close" }, closed, null],
  // overflowed: later arrivals drop, settles still count down
  [overflowed(2, 10), { type: "arrive", bytes: 0 }, overflowed(2, 10), "drop"],
  [overflowed(2, 10), { type: "settle", bytes: 4 }, overflowed(1, 6), null],
  [overflowed(1, 6), { type: "settle", bytes: 6 }, overflowed(0, 0), null],
  [overflowed(2, 10), { type: "close" }, closed, null],
  // closed is terminal
  [closed, { type: "arrive", bytes: 1 }, closed, "drop"],
  [closed, { type: "settle", bytes: 1 }, closed, null],
  [closed, { type: "close" }, closed, null],
];

test("receiveStep covers every state and event", () => {
  for (const [state, event, next, effect] of cases) {
    const result = receiveStep(state, event, limits);
    assert.deepEqual(
      result,
      { state: next, effect },
      `${state.phase}(${state.frames},${state.bytes}) + ${event.type}`,
    );
  }
});

test("receiveStep never counts below zero and rejects unknown events", () => {
  assert.deepEqual(receiveStep(open(0, 0), { type: "settle", bytes: 9 }, limits).state, open(0, 0));
  assert.throws(() => receiveStep(RECEIVE_OPEN, { type: "tick" }, limits), TypeError);
});

test("the default limits match the native receive queue", () => {
  assert.deepEqual({ ...RECEIVE_LIMITS }, { maxFrames: 256, maxBytes: 32 * 1024 * 1024 });
  // One maximal frame on an empty queue is admitted, as natively.
  assert.equal(
    receiveStep(RECEIVE_OPEN, { type: "arrive", bytes: 32 * 1024 * 1024 }).effect,
    "admit",
  );
  let state = RECEIVE_OPEN;
  for (let i = 0; i < 256; i++) state = receiveStep(state, { type: "arrive", bytes: 1 }).state;
  assert.equal(receiveStep(state, { type: "arrive", bytes: 1 }).effect, "refuse");
});
