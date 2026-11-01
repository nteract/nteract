import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRESERVED_CONVERSION_STATES,
  conversionFenced,
  conversionRetryDelay,
  permanentFailure,
  preservedConversionMachine as machine,
} from "./preserved-conversion.mjs";

const STATES = {
  unchecked: { name: "unchecked" },
  clear: { name: "clear" },
  held: { name: "held" },
  converting: { name: "converting", mode: "native", attempt: 2 },
  convertingLiteral: { name: "converting", mode: "literal", attempt: 1 },
  failed: { name: "failed", mode: "native", attempt: 2 },
  failedLiteral: { name: "failed", mode: "literal", attempt: 1 },
  stuck: { name: "stuck", reason: "history_capacity" },
};
const observe = (preserved, unfinished, eligible) => ({
  type: "observe",
  preserved,
  unfinished,
  eligible,
});
const EVENTS = {
  none: observe(false, false, false),
  held: observe(true, false, false),
  convert: observe(true, false, true),
  unfinished: observe(false, true, true),
  succeeded: { type: "succeeded" },
  transient: { type: "failed", permanent: false, reason: "storage_or_runtime" },
  permanent: { type: "failed", permanent: true, reason: "history_capacity" },
};
const converting = (mode, attempt) => [
  { name: "converting", mode, attempt },
  [{ type: "convert", mode }],
];
const idle = {
  none: [{ name: "clear" }, []],
  held: [{ name: "held" }, []],
  convert: converting("native", 1),
  // An unfinished journal entry is work even with no preserved block left.
  unfinished: converting("native", 1),
};
const running = (mode, attempt) => ({
  none: "rejected",
  held: "rejected",
  convert: "rejected",
  unfinished: "rejected",
  succeeded: [{ name: "unchecked" }, [{ type: "observe" }]],
  transient: [{ name: "failed", mode, attempt }, [{ type: "scheduleRetry", attempt }]],
  permanent:
    mode === "native"
      ? converting("literal", 1)
      : [
          { name: "stuck", reason: "history_capacity" },
          [{ type: "logStuck", reason: "history_capacity" }],
        ],
});
// Every state × event: the expected next state and effects, "rejected", or
// absent where the pair can't happen.
const TABLE = {
  unchecked: idle,
  clear: idle,
  held: idle,
  converting: running("native", 2),
  convertingLiteral: running("literal", 1),
  failed: { ...idle, convert: converting("native", 3), unfinished: converting("native", 3) },
  failedLiteral: {
    ...idle,
    convert: converting("literal", 2),
    unfinished: converting("literal", 2),
  },
  stuck: {
    none: [{ name: "clear" }, []],
    held: "rejected",
    convert: "rejected",
    unfinished: "rejected",
  },
};

test("the conversion machine covers every state and event", () => {
  assert.deepEqual(
    [...new Set(Object.values(STATES).map((state) => state.name))],
    [...PRESERVED_CONVERSION_STATES],
  );
  for (const [label, state] of Object.entries(STATES))
    for (const [name, event] of Object.entries(EVENTS)) {
      const expected = TABLE[label][name];
      if (expected === undefined) {
        assert.ok(machine.unreachableReason(state.name, event.type), `${label} × ${name}`);
        assert.throws(() => machine.step(state, event), /unreachable/);
        continue;
      }
      const result = machine.step(state, event);
      if (expected === "rejected") {
        assert.equal(result.state, state, `${label} × ${name}`);
        assert.ok(result.rejected);
        continue;
      }
      assert.deepEqual([result.state, result.effects], expected, `${label} × ${name}`);
    }
});

test("the fence is up while work waits, runs or failed transiently; stuck is open", () => {
  assert.deepEqual(
    Object.entries(STATES)
      .filter(([, state]) => conversionFenced(state))
      .map(([label]) => label),
    ["held", "converting", "convertingLiteral", "failed", "failedLiteral"],
  );
  assert.deepEqual([1, 2, 3, 10].map(conversionRetryDelay), [5_000, 10_000, 20_000, 300_000]);
});

test("permanent failures are the ones that would fail the same way again", () => {
  const capacity = Error("capacity");
  for (const [error, permanent] of [
    [Object.assign(Error("x"), { conversion: true }), true],
    [capacity, true],
    [Object.assign(Error("x"), { status: 413 }), true],
    [Object.assign(Error("x"), { status: 400 }), true],
    [Object.assign(Error("x"), { status: 409, code: "stale_heads" }), false],
    [Object.assign(Error("x"), { status: 429 }), false],
    [Object.assign(Error("x"), { status: 503 }), false],
    [Error("storage unavailable"), false],
  ])
    assert.equal(
      permanentFailure(error, { isHistoryCapacityError: (e) => e === capacity }),
      permanent,
      error.message + (error.status ?? ""),
    );
});
