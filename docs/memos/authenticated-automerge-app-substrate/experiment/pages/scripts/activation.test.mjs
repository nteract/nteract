import test from "node:test";
import assert from "node:assert/strict";
import {
  awaitServing,
  fingerprint,
  fleetServing,
  liveLeases,
  localServing,
  observedFingerprint,
  parseRunning,
  planActivation,
  runningRecord,
  unitInput,
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

test("a pending reload and --restart are restart reasons of their own", () => {
  assert.deepEqual(
    planActivation({ active: true, running: desired, desired, reloadPending: true }),
    { action: "restart", reasons: ["reload"], applyFirewall: false },
  );
  assert.deepEqual(
    planActivation({ active: true, running: desired, desired, requested: true }).reasons,
    ["requested"],
  );
  assert.deepEqual(
    planActivation({
      active: true,
      running: { ...desired, unit_sha256: sha("9") },
      desired,
      reloadPending: true,
      requested: true,
    }).reasons,
    ["requested", "unit", "reload"],
  );
  assert.deepEqual(
    planActivation({ active: true, running: null, desired, reloadPending: true }).reasons,
    ["unknown", "reload"],
  );
  // A stopped service starts; the reasons for a running one do not apply.
  assert.deepEqual(
    planActivation({ active: false, running: null, desired, reloadPending: true }).reasons,
    ["inactive"],
  );
});

test("unitInput covers drop-ins by path order, path and content", () => {
  const fragment = "[Service]\nExecStart=/bin/true\n";
  assert.equal(unitInput(fragment, []), fragment);
  const a = { path: "/etc/systemd/system/x.service.d/10-a.conf", text: "[Service]\nA=1\n" };
  const b = { path: "/etc/systemd/system/x.service.d/20-b.conf", text: "[Service]\nB=1\n" };
  assert.equal(unitInput(fragment, [b, a]), unitInput(fragment, [a, b]));
  assert.notEqual(unitInput(fragment, [a]), unitInput(fragment, []));
  assert.notEqual(
    unitInput(fragment, [a]),
    unitInput(fragment, [{ ...a, text: "[Service]\nA=2\n" }]),
  );
  assert.notEqual(
    unitInput(fragment, [a]),
    unitInput(fragment, [{ ...a, path: "/etc/systemd/system/x.service.d/90-a.conf" }]),
  );
  // Content cannot impersonate a drop-in boundary.
  assert.notEqual(unitInput(fragment + "\n\0drop-in " + a.path + "\n" + a.text, []), fragment);
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
    JSON.stringify({ ...record, schema: 1 }),
    JSON.stringify({ ...record, schema: 3 }),
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
    { exeSha256: null },
    { unit: null },
    { config: null },
    { startedAtSeconds: 0 },
    { startedAtSeconds: Number.NaN },
  ])
    assert.equal(observedFingerprint({ ...observed, ...change }), null);
});

test("waitTransition serves on a serving event and times out otherwise", () => {
  const waiting = { phase: "waiting", startedAt: 0, timeoutMs: 100 };
  assert.equal(waitTransition(waiting, { at: 10, serving: false, detail: "old" }), waiting);
  assert.deepEqual(waitTransition(waiting, { at: 20, serving: true, detail: "new", nodes: 2 }), {
    phase: "serving",
    waitedMs: 20,
    detail: "new",
    nodes: 2,
  });
  assert.deepEqual(waitTransition(waiting, { at: 100, serving: false, detail: "old" }), {
    phase: "timed_out",
    waitedMs: 100,
    detail: "old",
  });
  // Terminal states absorb later events.
  const served = { phase: "serving", waitedMs: 1, detail: "" };
  assert.equal(waitTransition(served, { at: 500, serving: false, detail: "x" }), served);
});

test("localServing wants the manifest build from an ok gateway", () => {
  assert.deepEqual(localServing({ ok: true, build: "aaaaaaaaaaaa" }, "aaaaaaaaaaaa"), {
    serving: true,
    detail: "ok=true build=aaaaaaaaaaaa",
  });
  assert.equal(localServing({ ok: true, build: "bbbbbbbbbbbb" }, "aaaaaaaaaaaa").serving, false);
  assert.equal(localServing({ ok: false, build: "aaaaaaaaaaaa" }, "aaaaaaaaaaaa").serving, false);
  assert.deepEqual(localServing({ error: "curl failed (status 7)" }, "aaaaaaaaaaaa"), {
    serving: false,
    detail: "curl failed (status 7)",
  });
});

test("awaitServing sleeps between probes and reports the last detail on timeout", () => {
  let now = 0;
  const slept = [];
  const sleep = (ms) => {
    slept.push(ms);
    now += ms;
  };
  const sequence = [
    { serving: false, detail: "refused" },
    { serving: false, detail: "old" },
  ];
  let call = 0;
  const served = awaitServing({
    what: "Local node",
    probe: () => sequence[call++] ?? { serving: true, detail: "new" },
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
      awaitServing({
        what: "Local node 127.0.0.1:9480 build new000000000",
        probe: () => ({ serving: false, detail: "curl failed (status 7)" }),
        sleep,
        now: () => now,
        timeoutMs: 6000,
        intervalMs: 2000,
      }),
    /Local node 127[.]0[.]0[.]1:9480 build new000000000 did not serve within 6000 ms; last: curl failed \(status 7\)/,
  );
});

test("liveLeases keeps unexpired leases with an IPv4 listener", () => {
  const lease = { node: "node_a", addr: "172.31.1.152:19480", expires_ms: 2000 };
  assert.deepEqual(liveLeases([lease], 1000), [lease]);
  for (const bad of [
    { ...lease, expires_ms: 1000 },
    { ...lease, addr: "172.31.1.152:19480/x" },
    { ...lease, addr: "evil.example:80" },
    { ...lease, node: undefined },
    { ...lease, expires_ms: "2000" },
    null,
  ])
    assert.deepEqual(liveLeases([bad], 1000), []);
  // A restarted node's predecessor lease on the same listener collapses into
  // the newest one.
  const restarted = { ...lease, node: "node_b", expires_ms: 3000 };
  assert.deepEqual(liveLeases([lease, restarted], 1000), [restarted]);
  assert.deepEqual(liveLeases([restarted, lease], 1000), [restarted]);
  const peer = { ...lease, node: "node_c", addr: "172.31.1.233:19480" };
  assert.deepEqual(liveLeases([lease, peer, restarted], 1000), [restarted, peer]);
});

test("fleetServing needs every live node on the deployed version", () => {
  const version = "c0ffee0123456789";
  const a = { node: "node_a", addr: "172.31.1.152:19480", version };
  const b = { node: "node_b", addr: "172.31.1.233:19480", version };
  assert.deepEqual(fleetServing([a, b], version), {
    serving: true,
    detail: `node_a@172.31.1.152:19480=${version}, node_b@172.31.1.233:19480=${version}`,
    nodes: 2,
  });
  assert.equal(fleetServing([a, { ...b, version: "0000000000000000" }], version).serving, false);
  assert.match(
    fleetServing([a, { ...b, version: null, error: "curl failed (status 28)" }], version).detail,
    /node_b@172[.]31[.]1[.]233:19480=curl failed \(status 28\)/,
  );
  assert.deepEqual(fleetServing([], version), {
    serving: false,
    detail: "no live node lease",
    nodes: 0,
  });
});
