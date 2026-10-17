// Local only: generated docs, loopback listener, an empty private dev bucket.
// CELLD_PROBE_BIN=/path/to/celld node scripts/probe-celld-storage.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  stat,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const app = fileURLToPath(new URL("../", import.meta.url));
const binary = process.env.CELLD_PROBE_BIN || "celld";
const port = Number(process.env.CELLD_PROBE_PORT || 19871);
const repeats = Number(process.env.CELLD_PROBE_REPEATS || 3);
const modes = (process.env.CELLD_PROBE_MODES || "full,changed,incremental").split(",");
assert.ok(modes.every((mode) => ["full", "changed", "incremental"].includes(mode)));
const fixturePath = path.join(root, ".context/storage-fixture.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const dir = await mkdtemp(path.join(root, ".context/celld-storage-"));
const esbuild = path.join(app, "node_modules/.bin/esbuild");
const origin = `http://127.0.0.1:${port}`;
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
const runEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  CELLD_ESBUILD: esbuild,
  CELLD_DURABILITY: "bucket",
  CELLD_TOKIO_THREADS: "2",
  CELLD_LTX_TRUNCATE_PAGES: "128",
  RUST_LOG: "info",
};
const results = [];

async function inventory(directory) {
  const totals = { sqlite: 0, wal: 0, ltx: 0, other: 0 };
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(name);
      else {
        const kind = name.endsWith(".ltx")
          ? "ltx"
          : name.endsWith("-wal")
            ? "wal"
            : /\.(sqlite3?|db)$/.test(name)
              ? "sqlite"
              : "other";
        totals[kind] += (await stat(name)).size;
      }
    }
  }
  await walk(directory);
  const db = new DatabaseSync(path.join(directory, "objects.sqlite3"), { readOnly: true });
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
    totals.bucketTables = tables;
    totals.bucketWriteSequence = db.prepare("SELECT next_etag FROM store_sequence").get().next_etag;
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info("${table.name.replaceAll('"', '""')}")`).all();
      const key = columns.find((c) => c.name === "key");
      const value = columns.find((c) => ["value", "body", "data"].includes(c.name));
      if (key && value)
        totals.objects = db
          .prepare(
            `SELECT key, length("${value.name}") AS bytes FROM "${table.name.replaceAll('"', '""')}"`,
          )
          .all();
    }
  } finally {
    db.close();
  }
  return totals;
}
async function start(project) {
  // Never send a probe to a pre-existing listener, including a child that has
  // not finished exiting after its supervisor was killed.
  let available = false;
  for (let i = 0; i < 50 && !available; i++) {
    available = await new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (!available) await delay(100);
  }
  assert.ok(available, "probe loopback port must be free");
  const processHandle = spawn(
    binary,
    ["dev", project, "--port", String(port), "--no-watch", "--logs"],
    { env: runEnv, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let logs = "";
  for (const stream of [processHandle.stdout, processHandle.stderr])
    stream.on("data", (b) => {
      logs += b;
    });
  processHandle.on("error", (e) => {
    logs += e;
  });
  for (let i = 0; i < 300; i++) {
    if (processHandle.exitCode !== null) throw new Error(logs);
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.text()) === "ready")
        return { processHandle, logs: () => logs };
    } catch {
      await delay(100);
    }
  }
  await stop({ processHandle, logs: () => logs }, path.join(project, "startup-failed.log"));
  throw new Error(`celld startup timeout: ${logs}`);
}
async function stop(running, file) {
  const ownedPids = resources(running.processHandle.pid).ownedPids;
  if (running.processHandle.exitCode === null && running.processHandle.signalCode === null) {
    const exited = once(running.processHandle, "exit");
    try {
      process.kill(-running.processHandle.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await exited;
  }
  for (let attempt = 0; ; attempt++) {
    const alive = ownedPids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        return false;
      }
    });
    if (!alive.length) break;
    assert.ok(attempt < 450, `owned celld processes did not exit: ${alive.join(",")}`);
    await delay(100);
  }
  await writeFile(file, running.logs());
}
async function verifyRecovery(data, file, expectedIndex) {
  const entries = JSON.parse(data);
  if (expectedIndex !== undefined)
    assert.ok(entries.every((entry) => entry.index === expectedIndex));
  await writeFile(
    file,
    JSON.stringify(
      entries.map((entry, d) => ({
        bytes: entry.bytes,
        snapshot: fixture[entry.index].docs[d].snapshot,
      })),
    ),
  );
  execFileSync(path.join(root, "target/release/examples/storage_probe"), ["verify", file]);
}
function resources(pid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/));
  const ids = new Set([pid]);
  for (let pass = 0; pass < 5; pass++)
    for (const row of rows) if (ids.has(Number(row[1]))) ids.add(Number(row[0]));
  let rssKiB = 0;
  let cpuSeconds = 0;
  for (const row of rows)
    if (ids.has(Number(row[0]))) {
      rssKiB += Number(row[2]);
      cpuSeconds += row[3].split(":").reduce((total, part) => total * 60 + Number(part), 0);
    }
  return { rssKiB, cpuSeconds, ownedPids: [...ids] };
}
const quantile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))];
async function request(mode, index, fault = "", room = "benchmark") {
  return fetch(`${origin}/commit?mode=${mode}&index=${index}&fault=${fault}&room=${room}`, {
    signal: AbortSignal.timeout(15000),
  });
}

for (let repeat = 0; repeat < repeats; repeat++)
  for (const mode of modes) {
    const project = path.join(dir, `${repeat}-${mode}`);
    await mkdir(project);
    await copyFile(
      new URL("./storage-probe-worker.mjs", import.meta.url),
      path.join(project, "index.mjs"),
    );
    await copyFile(fixturePath, path.join(project, "storage-fixture.json"));
    await writeFile(
      path.join(project, "wrangler.json"),
      JSON.stringify({
        name: "storage-probe",
        main: "index.mjs",
        compatibility_date: "2026-09-01",
        durable_objects: { bindings: [{ name: "PROBE", class_name: "StorageProbe" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["StorageProbe"] }],
      }),
    );
    let running = await start(project);
    try {
      assert.equal((await request(mode, 0)).status, 200);
      const before = await inventory(path.join(project, ".celld/dev"));
      const initial = resources(running.processHandle.pid);
      let peakRssKiB = initial.rssKiB;
      const timings = {};
      let payloadBytes = 0;
      let compactions = 0;
      for (let i = 1; i < fixture.length; i++) {
        const started = performance.now();
        const response = await request(mode, i);
        assert.equal(response.status, 200, await response.clone().text());
        const receipt = await response.json();
        (timings[fixture[i].phase] ??= []).push(performance.now() - started);
        payloadBytes += receipt.written ?? 0;
        compactions += receipt.compactions ?? 0;
        if (i % 10 === 0)
          peakRssKiB = Math.max(peakRssKiB, resources(running.processHandle.pid).rssKiB);
      }
      const afterResources = resources(running.processHandle.pid);
      const after = await inventory(path.join(project, ".celld/dev"));
      const idleBefore = resources(running.processHandle.pid);
      await delay(15000);
      const idleAfter = await inventory(path.join(project, ".celld/dev"));
      const idleResources = resources(running.processHandle.pid);
      const restoredAt = performance.now();
      const recovered = await (await fetch(`${origin}/restore?mode=${mode}`)).text();
      const warmRestoreMs = performance.now() - restoredAt;
      const recoveryPath = path.join(project, "recovered.json");
      await verifyRecovery(recovered, recoveryPath);
      await stop(running, path.join(project, "run.log"));
      running = null;
      // Preserve the local dev bucket, remove only this experiment's discardable
      // runtime cache. This tests local bucket recovery, never S3 durability.
      await rename(
        path.join(project, ".celld/dev/runtime"),
        path.join(project, ".celld/dev/runtime-before-recovery"),
      );
      const coldStart = performance.now();
      running = await start(project);
      const firstRestoreStarted = performance.now();
      const coldRecovered = await (await fetch(`${origin}/restore?mode=${mode}`)).text();
      const firstRestoreMs = performance.now() - firstRestoreStarted;
      const coldStartAndRestoreMs = performance.now() - coldStart;
      await verifyRecovery(coldRecovered, recoveryPath);
      results.push({
        repeat,
        mode,
        payloadBytes,
        compactions,
        latencyMs: Object.fromEntries(
          Object.entries(timings).map(([k, v]) => [
            k,
            { median: quantile(v, 0.5), p95: quantile(v, 0.95) },
          ]),
        ),
        initial,
        peakRssKiB,
        cpuSeconds: afterResources.cpuSeconds - initial.cpuSeconds,
        warmRestoreMs,
        coldStartAndRestoreMs,
        firstRestoreMs,
        idleCpuSeconds: idleResources.cpuSeconds - idleBefore.cpuSeconds,
        before,
        after,
        idleAfter,
      });
      if (repeat === 0 && mode === "incremental") {
        const call = (index, fault = "") => request(mode, index, fault, "faults");
        const validate = async (index) => {
          const data = await (await fetch(`${origin}/restore?mode=${mode}&room=faults`)).text();
          await verifyRecovery(data, recoveryPath, index);
        };
        assert.equal((await call(0)).status, 200);
        assert.equal((await call(1, "commit")).status, 409);
        await validate(0);
        assert.equal((await call(1, "ack")).status, 503);
        assert.equal((await (await call(1)).json()).duplicate, true);
        const concurrent = await Promise.all([call(2), call(2), call(2)]);
        assert.ok(concurrent.every((r) => r.status === 200));
        await validate(2);
        assert.equal((await call(4)).status, 409, "missing predecessor refused");
        for (let i = 3; i < 32; i++) assert.equal((await call(i)).status, 200);
        assert.equal((await call(32, "compact")).status, 409);
        await validate(31);
        assert.equal((await call(32)).status, 200);
        await validate(32);
        for (let i = 33; i < 101; i++) assert.equal((await call(i)).status, 200);
        assert.equal((await call(101, "commit")).status, 409, "widget/comments roll back together");
        await validate(100);
        assert.equal((await call(101)).status, 200);
        await validate(101);
        // Kill the process group while its transaction is open, after writes.
        const pending = call(102, "pause").catch(() => undefined);
        for (let n = 0; !running.logs().includes("storage-probe-paused-before-commit"); n++) {
          assert.ok(n < 100, "pause reached");
          await delay(100);
        }
        const killed = running;
        running = null;
        const ownedPids = resources(killed.processHandle.pid).ownedPids;
        const exited = once(killed.processHandle, "exit");
        // celld gives the native node its own process group. Killing only the
        // supervisor's group leaves that node alive; capture its actual tree.
        for (const pid of ownedPids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        await exited;
        await pending;
        await writeFile(path.join(project, "killed.log"), killed.logs());
        running = await start(project);
        await validate(101);
        assert.equal((await call(102)).status, 200);
        await validate(102);
        results.at(-1).qualification =
          "rollback, lost response retry, concurrent duplicate, sequence gap, compaction rollback, cross-document rollback, process kill during transaction";
      }
      console.log(
        JSON.stringify({
          repeat,
          mode,
          payloadBytes,
          compactions,
          cpuSeconds: results.at(-1).cpuSeconds,
        }),
      );
    } finally {
      if (running) await stop(running, path.join(project, "recovery.log"));
    }
  }
await writeFile(
  path.join(dir, "results.json"),
  JSON.stringify({ version, settings: runEnv, results }, null, 2),
);
const footprint = (v) => {
  const ltx = v.objects.filter((o) => o.key.endsWith(".ltx"));
  return {
    sqliteBytes: v.sqlite,
    walBytes: v.wal,
    localLtxBytes: v.ltx,
    bucketLtxBytes: ltx.reduce((n, o) => n + o.bytes, 0),
    bucketLtxObjects: ltx.length,
    bucketWriteSequence: v.bucketWriteSequence,
  };
};
const nativeSerialization = { fullMs: 0, changedMs: 0, deltaMs: 0 };
for (const entry of fixture.slice(1))
  for (const doc of entry.docs) {
    nativeSerialization.fullMs += doc.native_full_us / 1000;
    if (doc.changed) {
      nativeSerialization.changedMs += doc.native_full_us / 1000;
      nativeSerialization.deltaMs += doc.native_delta_us / 1000;
    }
  }
await writeFile(
  path.join(dir, "report.json"),
  JSON.stringify(
    {
      version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0].model,
      node: process.version,
      fixtureSha256: createHash("sha256")
        .update(await readFile(fixturePath))
        .digest("hex"),
      settings: {
        durability: "bucket",
        backend: "local dev bucket",
        tokioThreads: 2,
        ltxTruncatePages: 128,
        ltxRetentionSeconds: null,
        idleSeconds: 15,
      },
      nativeSerialization,
      runs: results.map(({ before, after, idleAfter, initial, ...result }) => ({
        ...result,
        initial: { rssKiB: initial.rssKiB, cpuSeconds: initial.cpuSeconds },
        before: footprint(before),
        after: footprint(after),
        idleAfter: footprint(idleAfter),
      })),
    },
    null,
    2,
  ),
);
console.log(`Results: ${dir}/results.json`);
