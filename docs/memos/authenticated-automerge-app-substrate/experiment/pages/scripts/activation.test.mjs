import test from "node:test";
import assert from "node:assert/strict";
import {
  awaitBuild,
  fingerprint,
  observedFingerprint,
  parseRunning,
  planActivation,
  runningRecord,
  waitTransition,
} from "./deployment/activation.mjs";

const sha = (c) => c.repeat(64);
const desired = fingerprint({
  unit: sha("1"),
  celld: sha("2"),
  config: sha("3"),
  firewall: sha("4"),
});

test("planActivation restarts only for startup inputs and applies the firewall live", () => {
  assert.deepEqual(planActivation({ active: true, running: desired, desired }), {
    action: "adopt",
    reasons: [],
    applyFirewall: false,
  });
  assert.deepEqual(
    planActivation({ active: true, running: { ...desired, firewall_sha256: sha("9") }, desired }),
    { action: "adopt", reasons: [], applyFirewall: true },
  );
  for (const [key, reason] of [
    ["unit_sha256", "unit"],
    ["celld_sha256", "celld"],
    ["config_sha256", "config"],
  ])
    assert.deepEqual(
      planActivation({
        active: true,
        running: { ...desired, [key]: sha("9"), firewall_sha256: sha("9") },
        desired,
      }),
      // The restart's ExecStartPre applies the firewall.
      { action: "restart", reasons: [reason], applyFirewall: false },
    );
  assert.deepEqual(
    planActivation({
      active: true,
      running: { ...desired, unit_sha256: sha("9"), celld_sha256: sha("9") },
      desired,
    }).reasons,
    ["unit", "celld"],
  );
  assert.deepEqual(planActivation({ active: false, running: desired, desired }).reasons, [
    "inactive",
  ]);
  assert.deepEqual(planActivation({ active: true, running: null, desired }).reasons, ["unknown"]);
});

test("a running record describes only the process it was written for", () => {
  const current = { pid: 4242, startedAtSeconds: 1_800_000_000 };
  const record = runningRecord(desired, current);
  assert.deepEqual(parseRunning(JSON.stringify(record), current), desired);
  for (const other of [
    { ...current, pid: 4243 },
    { ...current, startedAtSeconds: 1_800_000_001 },
    { pid: 0, startedAtSeconds: 0 },
    undefined,
  ])
    assert.equal(parseRunning(JSON.stringify(record), other), null);
  for (const text of [
    "",
    "null",
    "{",
    JSON.stringify(desired),
    JSON.stringify({ ...record, schema: 2 }),
    JSON.stringify({ ...record, unit_sha256: "short" }),
    JSON.stringify({ ...record, firewall_sha256: undefined }),
  ])
    assert.equal(parseRunning(text, current), null);
});

test("observedFingerprint trusts only files written before the process started", () => {
  const startedAtSeconds = 1_800_000_000;
  const before = (c) => ({ sha256: sha(c), mtimeMs: startedAtSeconds * 1000 - 1 });
  const observed = {
    startedAtSeconds,
    exeSha256: sha("2"),
    needDaemonReload: false,
    unit: before("1"),
    config: before("3"),
    firewall: before("4"),
  };
  assert.deepEqual(observedFingerprint(observed), desired);
  // The same second as the start is not provably earlier.
  for (const key of ["unit", "config", "firewall"])
    assert.equal(
      observedFingerprint({
        ...observed,
        [key]: { sha256: sha("1"), mtimeMs: startedAtSeconds * 1000 },
      }),
      null,
    );
  for (const change of [
    { needDaemonReload: true },
    { exeSha256: null },
    { unit: null },
    { config: null },
    { startedAtSeconds: 0 },
    { startedAtSeconds: Number.NaN },
  ])
    assert.equal(observedFingerprint({ ...observed, ...change }), null);
});

test("waitTransition serves on the wanted build and times out on anything else", () => {
  const waiting = { phase: "waiting", startedAt: 0, timeoutMs: 100, want: "aaaaaaaaaaaa" };
  assert.equal(
    waitTransition(waiting, { at: 10, health: { ok: true, build: "bbbbbbbbbbbb" } }),
    waiting,
  );
  assert.equal(
    waitTransition(waiting, { at: 10, health: { ok: false, error: "refused" } }),
    waiting,
  );
  assert.deepEqual(
    waitTransition(waiting, { at: 20, health: { ok: true, build: "aaaaaaaaaaaa" } }),
    { phase: "serving", waitedMs: 20, health: { ok: true, build: "aaaaaaaaaaaa" } },
  );
  // A wrong build that reports ok is not serving.
  assert.equal(
    waitTransition(waiting, { at: 100, health: { ok: true, build: "bbbbbbbbbbbb" } }).phase,
    "timed_out",
  );
  // Terminal states absorb later events.
  const served = { phase: "serving", waitedMs: 1, health: {} };
  assert.equal(waitTransition(served, { at: 500, health: { ok: false } }), served);
});

test("awaitBuild sleeps between probes and reports the last health on timeout", () => {
  let now = 0;
  const slept = [];
  const sleep = (ms) => {
    slept.push(ms);
    now += ms;
  };
  const sequence = [
    { ok: false, error: "refused" },
    { ok: true, build: "old000000000" },
  ];
  let call = 0;
  const served = awaitBuild({
    want: "new000000000",
    probe: () => sequence[call++] ?? { ok: true, build: "new000000000" },
    sleep,
    now: () => now,
    timeoutMs: 10_000,
    intervalMs: 2000,
  });
  assert.equal(served.phase, "serving");
  assert.equal(served.waitedMs, 4000);
  assert.deepEqual(slept, [2000, 2000]);

  now = 0;
  assert.throws(
    () =>
      awaitBuild({
        want: "new000000000",
        probe: () => ({ ok: false, error: "curl failed (status 7)" }),
        sleep,
        now: () => now,
        timeoutMs: 6000,
        intervalMs: 2000,
      }),
    /did not serve build new000000000 within 6000 ms; last health: curl failed \(status 7\)/,
  );
});
