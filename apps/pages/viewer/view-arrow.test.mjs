// The decoder warm-up decodes one empty Parquet file through the chart's
// call, once per page, and says nothing when it fails.
import assert from "node:assert/strict";
import test from "node:test";
import { warmDecoder } from "./view-arrow.mjs";

test("the decoder warms once, from a Parquet file, and a failure is quiet and retried", async () => {
  const calls = [];
  const failing = async (bytes) => {
    calls.push(bytes);
    throw Error("no WASM here");
  };
  await warmDecoder(failing);
  assert.equal(calls.length, 1);
  const bytes = calls[0];
  assert.ok(bytes instanceof Uint8Array);
  const magic = (from) => String.fromCharCode(...bytes.subarray(from, from + 4));
  assert.equal(magic(0), "PAR1");
  assert.equal(magic(bytes.length - 4), "PAR1");
  const working = async (input) => {
    calls.push(input);
    return new Uint8Array();
  };
  await Promise.all([warmDecoder(working), warmDecoder(working)]);
  assert.equal(calls.length, 2, "a failed warm-up runs again, then once");
  await warmDecoder(working);
  assert.equal(calls.length, 2);
});
