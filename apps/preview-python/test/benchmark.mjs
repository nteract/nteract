/** Explicit opt-in benchmark; real isolated celld processes, no live cluster. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { startProviderFixture } from "./provider-fixture.mjs";

const trials = Number(process.env.PYTHON_BENCH_TRIALS ?? 5);
assert.ok(Number.isInteger(trials) && trials >= 2 && trials <= 20);
const cold = [],
  warm = [],
  memory = [];
function rss(rootPid) {
  // Include only the supervisor and its current descendants. macOS/Linux ps
  // reports RSS in KiB. This is process RSS, including shared-page accounting,
  // compiler/native caches and the supervisor; it is not Python heap usage.
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set([rootPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [pid, parent] of rows)
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
  }
  const processes = rows
    .filter(([pid]) => owned.has(pid))
    .map(([pid, parent, kib]) => ({ pid, parent, rssBytes: kib * 1024 }));
  return { rssBytes: processes.reduce((sum, row) => sum + row.rssBytes, 0), processes };
}
function summary(samples, key) {
  const sorted = samples.map((row) => row[key]).sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}
for (let trial = 0; trial < trials; trial++) {
  console.error(`Python benchmark trial ${trial + 1}/${trials}`);
  const server = await startProviderFixture();
  try {
    async function request(path, body, expectedStatus = 200) {
      const response = await fetch(server.url + path, {
        method: body ? "POST" : "GET",
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(65000),
      });
      const text = await response.text();
      assert.equal(response.status, expectedStatus, text);
      return JSON.parse(text);
    }
    const identity = (sessionId) => ({
      ownerPrincipal: "benchmark",
      notebookId: sessionId,
      sessionId,
    });
    async function firstOutput(sessionId) {
      const began = performance.now();
      const info = await request("/open", identity(sessionId));
      const allocated = performance.now();
      const result = await request("/execute", {
        ...identity(sessionId),
        execution: {
          execution_id: "first",
          source: "import sys\nprint('hello', file=sys.stderr)\n40 + 2",
        },
      });
      assert.equal(result.outputs.at(-1).data["text/plain"], "42");
      assert.ok(
        result.outputs.some((output) => output.name === "stderr" && output.text.includes("hello")),
      );
      return {
        trial,
        allocationMs: allocated - began,
        firstOutputMs: performance.now() - began,
        interpreterStartupMs: info.info.startupMs,
      };
    }
    await request("/probe");
    if (trial === 0)
      memory.push({
        phase: "provider_without_interpreters",
        assigned: 0,
        warm: 0,
        ...rss(server.pid),
      });
    cold.push(await firstOutput("cold"));
    await request("/close", identity("cold"));
    await request("/prewarm");
    warm.push(await firstOutput("warm"));
    await request("/close", identity("warm"));
    if (trial === 0) {
      const standby = await request("/prewarm");
      memory.push({ phase: "warm_pool", assigned: 0, warm: standby.length, ...rss(server.pid) });
      for (let count = 1; count <= 4; count++) {
        await firstOutput(`concurrent-${count}`);
        const ready = await request("/prewarm");
        memory.push({ phase: "assigned", assigned: count, warm: ready.length, ...rss(server.pid) });
      }
      const rejected = await request("/open", identity("over-capacity"), 409);
      assert.match(rejected.error, /capacity/);
      // Concurrent independent namespaces: every interpreter sees its own value.
      await Promise.all(
        [1, 2, 3, 4].map(async (n) => {
          const result = await request("/execute", {
            ...identity(`concurrent-${n}`),
            execution: {
              execution_id: "isolated",
              source: `import asyncio\nprivate_value = ${n}\nawait asyncio.sleep(0.1)\nprivate_value`,
            },
          });
          assert.equal(result.outputs.at(-1).data["text/plain"], String(n));
        }),
      );
      await request("/close", identity("concurrent-1"));
      await firstOutput("after-capacity-release");
      for (const name of ["after-capacity-release", "concurrent-2", "concurrent-3", "concurrent-4"])
        await request("/close", identity(name));
      memory.push({ phase: "released", assigned: 0, warm: 0, ...rss(server.pid) });
    }
  } finally {
    await server.close();
  }
}
const evidence = {
  collectedAt: new Date().toISOString(),
  host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  boundary:
    "Loopback private provider /open through complete /execute response; excludes browser, room sync, fleet boot and asset build. Fresh host processes use the same OS file cache. Warm trials await a clean standby. RSS is summed process-tree RSS, not per-interpreter heap or unique physical pages.",
  cold,
  warm,
  distributionsMs: { cold: summary(cold, "firstOutputMs"), warm: summary(warm, "firstOutputMs") },
  memory,
  checks: [
    "stderr_and_expression",
    "four_concurrent_isolated_namespaces",
    "fifth_session_rejected",
    "capacity_released_after_termination",
  ],
};
await mkdir(new URL("../.scratch/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../.scratch/benchmark-evidence.json", import.meta.url),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence, null, 2));
