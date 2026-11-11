import test from "node:test";
import assert from "node:assert/strict";
import { FORMAT_GATE_INITIAL, FORMAT_UNSUPPORTED_CODE, formatGateStep } from "./format-gate.mjs";

// Every state × event of the format gate.
test("the format gate stops on document_format_unsupported and never reopens", () => {
  const open = FORMAT_GATE_INITIAL;
  const stopped = formatGateStep(open, { type: "refused", code: FORMAT_UNSUPPORTED_CODE }).gate;
  const cases = [
    [open, { type: "refused", code: FORMAT_UNSUPPORTED_CODE }, "stopped", false],
    [open, { type: "refused", code: "schema_unsupported" }, "open", true],
    [open, { type: "refused", code: "signing_key_rejected" }, "open", true],
    [open, { type: "edit" }, "open", true],
    [stopped, { type: "refused", code: FORMAT_UNSUPPORTED_CODE }, "stopped", false],
    [stopped, { type: "refused", code: "schema_unsupported" }, "stopped", false],
    [stopped, { type: "edit" }, "stopped", false],
  ];
  for (const [state, event, name, allowed] of cases) {
    const result = formatGateStep(state, event);
    const label = `${state.name} × ${JSON.stringify(event)}`;
    assert.equal(result.gate.name, name, label);
    assert.equal(result.allowed, allowed, label);
  }
  // An event that changes nothing returns the same state.
  assert.equal(formatGateStep(open, { type: "edit" }).gate, open);
  assert.equal(formatGateStep(stopped, { type: "edit" }).gate, stopped);
  assert.throws(() => formatGateStep(open, { type: "reload" }), /Unknown format gate event/);
  assert.throws(
    () => formatGateStep({ name: "nope" }, { type: "edit" }),
    /Unknown format gate state/,
  );
});
