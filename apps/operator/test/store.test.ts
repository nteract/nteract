import assert from "node:assert/strict";
import { test } from "node:test";
import { OperatorStore } from "../viewer/store.ts";
import { cpu, currentHost, gapBetween, type Metrics, type Observation } from "../viewer/metrics.ts";

const metrics: Metrics = {
  schema: 1,
  provenance: "Synthetic test",
  stale: false,
  now: 180000,
  intervalMs: 60000,
  strideMs: 60000,
  retentionDays: 14,
  latest: {
    at: 180000,
    discovery_status: "ok",
    journal_status: "ok",
    duration_ms: 50,
    recovery: null,
  },
  previews: [],
  observations: [],
  currentHost: [],
  gaps: [],
  sourceGaps: [],
  sourceGapsTruncated: false,
  deployments: [],
  runtime: null,
};
const row = (at: number, total: number, idle: number): Observation => ({
  at,
  kind: "host",
  preview: "",
  role: "",
  class: "",
  status: "ok",
  process: "boot",
  values: { cpu_total_ticks: total, cpu_idle_ticks: idle },
});

test("CPU counters preserve zero, gaps, process resets and unknown current values", () => {
  const a = row(120000, 100, 100),
    b = row(180000, 200, 200);
  assert.equal(cpu(metrics, a, b), 0);
  assert.equal(cpu(metrics, a, { ...b, process: "new-boot" }), null);
  assert.equal(cpu({ ...metrics, gaps: [{ from: 150000, to: 160000 }] }, a, b), null);
  assert.equal(
    cpu(metrics, a, { ...b, values: { cpu_total_ticks: null, cpu_idle_ticks: 200 } }),
    null,
  );
  assert.equal(currentHost({ ...metrics, currentHost: [a, b], stale: true }), undefined);
  assert.equal(currentHost({ ...metrics, currentHost: [a] }), undefined);
  const truncated = { ...metrics, sourceGapsTruncated: true };
  assert.equal(gapBetween(truncated, 120000, 180000, "host"), false);
  assert.equal(cpu(truncated, a, b), 0);
  assert.equal(cpu(truncated, a, { ...b, at: 420000 }), null);
});
test("refreshes started during or after logout cannot restore private data", async () => {
  let finish!: (response: Response) => void;
  let reads = 0;
  const store = new OperatorStore(async (_input, init) => {
    if (init?.method === "DELETE")
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    reads++;
    return Response.json(metrics);
  });
  const logout = store.signOut();
  assert.equal(store.snapshot.phase, "signing-out");
  await store.refresh();
  finish(Response.json({ ok: true }));
  await logout;
  await store.refresh();
  assert.equal(reads, 0);
  assert.equal(store.snapshot.phase, "signed-out");
  assert.equal(store.snapshot.data, null);
});
test("a disposed store ignores a late logout failure", async () => {
  let finish!: (response: Response) => void;
  const store = new OperatorStore(
    async () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const logout = store.signOut();
  store.dispose();
  const before = store.snapshot;
  finish(new Response(null, { status: 503 }));
  await logout;
  assert.equal(store.snapshot, before);
});
test("retained measurements keep their loaded range while a new range fails", async () => {
  let fail = false;
  const store = new OperatorStore(async (input) => {
    if (String(input).endsWith("session")) return Response.json({});
    if (fail) throw new Error("Offline");
    return Response.json(metrics);
  });
  await store.refresh();
  assert.equal(store.snapshot.dataHours, 24);
  fail = true;
  store.setHours(6);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.snapshot.dataHours, 24);
  assert.equal(store.snapshot.data?.stale, true);
});
test("incompatible collector responses become errors and retain only stale history", async () => {
  let payload: unknown = metrics;
  const store = new OperatorStore(async (input) =>
    Response.json(String(input).endsWith("session") ? {} : payload),
  );
  await store.refresh();
  for (const payloadChange of [
    { currentHost: undefined },
    { latest: { at: "invalid" } },
    { observations: [{ values: null }] },
    { deployments: [null] },
    { sourceGaps: null },
  ]) {
    payload = { ...metrics, ...payloadChange };
    await store.refresh();
    assert.equal(store.snapshot.phase, "error");
    assert.equal(store.snapshot.message, "Unsupported metrics response.");
    assert.equal(store.snapshot.data?.stale, true);
  }
});
test("logout fences in-flight data and clears private metrics immediately", async () => {
  let release!: (r: Response) => void;
  const store = new OperatorStore(async (input, init) => {
    if (init?.method === "DELETE") return Response.json({ ok: true });
    if (String(input).endsWith("session")) return Response.json({ displayName: "Operator" });
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const pending = store.refresh();
  await new Promise((r) => setImmediate(r));
  await store.signOut();
  release(Response.json(metrics));
  await pending;
  assert.equal(store.snapshot.phase, "signed-out");
  assert.equal(store.snapshot.data, null);
});
test("network failure retains only stale measurements; session loss removes them", async () => {
  let mode = "ok";
  const store = new OperatorStore(async (input) => {
    if (mode === "unauthorized") return new Response(null, { status: 401 });
    if (mode === "offline") throw new Error("Offline");
    return Response.json(String(input).endsWith("session") ? { displayName: "Operator" } : metrics);
  });
  await store.refresh();
  assert.equal(store.snapshot.phase, "ready");
  mode = "offline";
  await store.refresh();
  assert.equal(store.snapshot.data?.stale, true);
  mode = "unauthorized";
  await store.refresh();
  assert.equal(store.snapshot.data, null);
});
test("a newer range discards an older response even if abort is ignored", async () => {
  let release!: (r: Response) => void;
  let queries = 0;
  const store = new OperatorStore(async (input) => {
    if (String(input).endsWith("session")) return Response.json({});
    if (++queries === 1)
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    return Response.json({ ...metrics, provenance: "New range" });
  });
  const first = store.refresh();
  await new Promise((r) => setImmediate(r));
  await store.refresh();
  release(Response.json({ ...metrics, provenance: "Old range" }));
  await first;
  assert.equal(store.snapshot.data?.provenance, "New range");
});
