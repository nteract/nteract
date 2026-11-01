import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRESERVED_CONVERSION_STATES,
  conversionFenced,
  conversionRetryDelay,
  preservedConversionMachine as machine,
} from "./preserved-conversion.mjs";

const STATES = {
  unchecked: { name: "unchecked" },
  clear: { name: "clear" },
  held: { name: "held" },
  converting: { name: "converting", attempt: 2 },
  failed: { name: "failed", attempt: 2 },
};
const OBSERVE = {
  none: { type: "observe", preserved: false, eligible: false },
  held: { type: "observe", preserved: true, eligible: false },
  convert: { type: "observe", preserved: true, eligible: true },
};

// Every state × event: the expected next state and effects, or why the pair
// can't happen.
const TABLE = {
  unchecked: {
    none: [{ name: "clear" }, []],
    held: [{ name: "held" }, []],
    convert: [{ name: "converting", attempt: 1 }, [{ type: "convert" }]],
  },
  clear: {
    none: [{ name: "clear" }, []],
    held: [{ name: "held" }, []],
    convert: [{ name: "converting", attempt: 1 }, [{ type: "convert" }]],
  },
  held: {
    none: [{ name: "clear" }, []],
    held: [{ name: "held" }, []],
    convert: [{ name: "converting", attempt: 1 }, [{ type: "convert" }]],
  },
  converting: {
    none: "rejected",
    held: "rejected",
    convert: "rejected",
    succeeded: [{ name: "unchecked" }, [{ type: "observe" }]],
    failed: [{ name: "failed", attempt: 2 }, [{ type: "scheduleRetry", attempt: 2 }]],
  },
  failed: {
    none: [{ name: "clear" }, []],
    held: [{ name: "held" }, []],
    // A retry counts the attempt.
    convert: [{ name: "converting", attempt: 3 }, [{ type: "convert" }]],
  },
};

test("the conversion machine covers every state and event", () => {
  assert.deepEqual(Object.keys(TABLE), [...PRESERVED_CONVERSION_STATES]);
  for (const name of PRESERVED_CONVERSION_STATES) {
    const state = STATES[name];
    const events = {
      ...OBSERVE,
      succeeded: { type: "succeeded" },
      failed: { type: "failed" },
    };
    for (const [label, event] of Object.entries(events)) {
      const expected = TABLE[name][label];
      if (expected === undefined) {
        assert.ok(machine.unreachableReason(name, event.type), `${name} × ${label} is unreachable`);
        assert.throws(() => machine.step(state, event), /unreachable/);
        continue;
      }
      const result = machine.step(state, event);
      if (expected === "rejected") {
        assert.equal(result.state, state, `${name} × ${label}`);
        assert.ok(result.rejected);
        continue;
      }
      assert.deepEqual([result.state, result.effects], expected, `${name} × ${label}`);
    }
  }
});

test("the fence is up while preserved blocks wait, convert, or failed to convert", () => {
  assert.deepEqual(
    PRESERVED_CONVERSION_STATES.filter((name) => conversionFenced(STATES[name])),
    ["held", "converting", "failed"],
  );
  assert.deepEqual([1, 2, 3, 10].map(conversionRetryDelay), [5_000, 10_000, 20_000, 300_000]);
});
