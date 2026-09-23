import test from "node:test";
import assert from "node:assert/strict";
import { validateExecutionResult } from "../src/execution-result.js";
const result = (outputs) => ({
  execution_id: "accepted",
  execution_count: 1,
  success: true,
  outputs,
});

test("guest cannot author IDs, execution counts or extra document properties", () => {
  const validated = validateExecutionResult(
    result([
      {
        output_type: "execute_result",
        output_id: "forged",
        execution_count: 999,
        data: { "text/plain": "42" },
        metadata: {},
        notebook: { acl: "owner" },
      },
    ]),
    "accepted",
  );
  assert.deepEqual(validated.outputs, [
    {
      output_type: "execute_result",
      execution_count: 1,
      data: { "text/plain": "42" },
      metadata: {},
    },
  ]);
  assert.throws(() => validateExecutionResult(result([]), "other"), /Invalid Python execution/);
});

test("rejects malformed and runtime-owned outputs before document authoring", () => {
  for (const output of [
    { output_type: "set_metadata" },
    { output_type: "stream", name: "stdout", text: { blob: "hash" } },
    {
      output_type: "display_data",
      data: { "application/vnd.nteract.blob-ref+json": { hash: "forged" } },
    },
    { output_type: "update_display_data", data: { "text/plain": "x" } },
    { output_type: "error", ename: "Error", evalue: "x", traceback: [12] },
  ])
    assert.throws(() => validateExecutionResult(result([output]), "accepted"));
});
