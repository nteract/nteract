// fast-check parameters shared by the Pages property suites.
// PAGES_FUZZ_SEED and PAGES_FUZZ_PATH replay a failure from its report.
// PAGES_FUZZ_RUNS scales a search without changing its seed or arbitrary.
// PAGES_FUZZ_DEPTH changes nesting (default 2); keep it unchanged when
// replaying a failure path. PAGES_FUZZ_TIME_LIMIT_MS bounds one property's
// search (default two minutes); reaching it fails the property.
import assert from "node:assert/strict";

export const fuzzParameters = {
  seed: Number(process.env.PAGES_FUZZ_SEED ?? 0x5eed),
  numRuns: Number(process.env.PAGES_FUZZ_RUNS ?? 50),
  interruptAfterTimeLimit: Number(process.env.PAGES_FUZZ_TIME_LIMIT_MS ?? 120_000),
  markInterruptAsFailure: true,
  ...(process.env.PAGES_FUZZ_PATH !== undefined && { path: process.env.PAGES_FUZZ_PATH }),
};
assert.ok(Number.isSafeInteger(fuzzParameters.seed), "PAGES_FUZZ_SEED must be an integer");
assert.ok(
  Number.isSafeInteger(fuzzParameters.numRuns) && fuzzParameters.numRuns > 0,
  "PAGES_FUZZ_RUNS must be positive",
);
assert.ok(
  Number.isSafeInteger(fuzzParameters.interruptAfterTimeLimit) &&
    fuzzParameters.interruptAfterTimeLimit > 0,
  "PAGES_FUZZ_TIME_LIMIT_MS must be positive",
);
export const fuzzDepth = Number(process.env.PAGES_FUZZ_DEPTH ?? 2);
assert.ok(
  Number.isInteger(fuzzDepth) && fuzzDepth >= 0,
  "PAGES_FUZZ_DEPTH must be a nonnegative integer",
);
