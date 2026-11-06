import test from "node:test";
import assert from "node:assert/strict";
import {
  projectionAt,
  projectionStep,
  publishedProjection,
  sameHeads,
  synced,
  unknown,
  writing,
} from "./wordgard-projection-state.mjs";

const H0 = ["h0"],
  H1 = ["h1"],
  H2 = ["h2"];
const P0 = { name: "P0" },
  P1 = { name: "P1" },
  P2 = { name: "P2" },
  P3 = { name: "P3" };
const check = [{ at: 0, text: "x" }];

const states = {
  synced: synced(H1, P1),
  unknown: unknown(P0),
  "writing from synced": writing(H1, P2, check, synced(H1, P1)),
  "writing from unknown": writing(H1, P2, null, unknown(P0)),
};
const events = {
  read: { type: "read", heads: H2, projection: P3 },
  invalidate: { type: "invalidate" },
  begin: { type: "begin", heads: H1, pending: P3, check },
  "commit, checked from the write's heads": {
    type: "commit",
    before: H1,
    after: H2,
    checked: true,
  },
  "commit, check failed": { type: "commit", before: H1, after: H2, checked: false },
  "commit from other heads": { type: "commit", before: H0, after: H2, checked: true },
  end: { type: "end" },
  "advance, unchanged text": { type: "advance", before: H1, after: H2 },
  "advance with a projection": { type: "advance", before: H1, after: H2, projection: P3 },
  "advance from other heads": { type: "advance", before: H0, after: H2, projection: P3 },
};

// Expected next state for every state and event.
const expected = {
  synced: {
    read: synced(H2, P3),
    invalidate: unknown(P1),
    begin: writing(H1, P3, check, synced(H1, P1)),
    "commit, checked from the write's heads": unknown(P1),
    "commit, check failed": unknown(P1),
    "commit from other heads": unknown(P1),
    end: synced(H1, P1),
    "advance, unchanged text": synced(H2, P1),
    "advance with a projection": synced(H2, P3),
    "advance from other heads": unknown(P1),
  },
  unknown: {
    read: synced(H2, P3),
    invalidate: unknown(P0),
    begin: writing(H1, P3, check, unknown(P0)),
    "commit, checked from the write's heads": unknown(P0),
    "commit, check failed": unknown(P0),
    "commit from other heads": unknown(P0),
    end: unknown(P0),
    "advance, unchanged text": unknown(P0),
    "advance with a projection": unknown(P0),
    "advance from other heads": unknown(P0),
  },
  "writing from synced": {
    read: synced(H2, P3),
    invalidate: unknown(P1),
    begin: writing(H1, P3, check, synced(H1, P1)),
    "commit, checked from the write's heads": synced(H2, P2),
    "commit, check failed": unknown(P1),
    "commit from other heads": unknown(P1),
    end: synced(H1, P1),
    "advance, unchanged text": writing(H1, P2, check, synced(H2, P1)),
    "advance with a projection": writing(H1, P2, check, synced(H2, P3)),
    "advance from other heads": writing(H1, P2, check, unknown(P1)),
  },
  "writing from unknown": {
    read: synced(H2, P3),
    invalidate: unknown(P0),
    begin: writing(H1, P3, check, unknown(P0)),
    "commit, checked from the write's heads": synced(H2, P2),
    "commit, check failed": unknown(P0),
    "commit from other heads": unknown(P0),
    end: unknown(P0),
    "advance, unchanged text": writing(H1, P2, null, unknown(P0)),
    "advance with a projection": writing(H1, P2, null, unknown(P0)),
    "advance from other heads": writing(H1, P2, null, unknown(P0)),
  },
};

test("the projection lifecycle covers every state and event", () => {
  for (const [stateName, state] of Object.entries(states))
    for (const [eventName, event] of Object.entries(events))
      assert.deepEqual(
        projectionStep(state, event),
        expected[stateName][eventName],
        `${stateName} + ${eventName}`,
      );
});

test("only a synced state at the same heads lends its projection", () => {
  assert.equal(projectionAt(synced(H1, P1), H1), P1);
  assert.equal(projectionAt(synced(H1, P1), H2), null);
  assert.equal(projectionAt(synced(H1, P1), null), null);
  assert.equal(projectionAt(unknown(P0), H1), null);
  assert.equal(projectionAt(writing(H1, P2, check, synced(H1, P1)), H1), null);
  // A write publishes nothing until its change event commits it.
  assert.equal(publishedProjection(writing(H1, P2, check, synced(H1, P1))), P1);
  assert.equal(publishedProjection(unknown(P0)), P0);
});

test("heads compare as sets", () => {
  assert.ok(sameHeads(["a", "b"], ["b", "a"]));
  assert.ok(!sameHeads(["a"], ["a", "b"]));
  assert.ok(!sameHeads(null, ["a"]));
  assert.throws(() => projectionStep(unknown(P0), { type: "nope" }), /Unknown projection event/);
});
