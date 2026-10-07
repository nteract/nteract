import test from "node:test";
import assert from "node:assert/strict";
import { retryableTermination, terminateLoadedPython } from "../src/host-termination.js";
const marker = "Python runtime invalidated after execution termination; recreate the worker";
for (const probe of [
  true,
  false,
  new Error("rejected: " + marker),
  new Error("Worker exceeded CPU limit of 10 ms"),
  new Error(marker),
]) {
  test(`termination requires host entry invalidation: ${String(probe)}`, async () => {
    let called = 0;
    const stub = {
      getEntrypoint(name, options) {
        assert.equal(name, "RuntimeControl");
        assert.deepEqual(options.limits, { cpuMs: 10, subRequests: 0 });
        return {
          terminate: async () => {
            called++;
            throw new Error("Worker exceeded CPU limit of 10 ms");
          },
          isAlive: async () => {
            if (probe instanceof Error) throw probe;
            return probe;
          },
        };
      },
    };
    const result = terminateLoadedPython(stub);
    if (probe instanceof Error && probe.message === marker) await result;
    else await assert.rejects(result, /did not confirm/);
    assert.equal(called, 1);
  });
}

test("termination retries after a failed host invalidation attempt", async () => {
  let attempts = 0;
  const terminate = retryableTermination(async () => {
    attempts++;
    if (attempts === 1) throw new Error("host control unavailable");
  });

  await assert.rejects(terminate(), /host control unavailable/);
  await terminate();
  assert.equal(attempts, 2, "a rejected termination attempt is not cached forever");
});

test("concurrent termination callers share the in-flight attempt", async () => {
  let attempts = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const terminate = retryableTermination(async () => {
    attempts++;
    await pending;
  });

  const first = terminate();
  const second = terminate();
  assert.equal(attempts, 1);
  release();
  await Promise.all([first, second]);
});
