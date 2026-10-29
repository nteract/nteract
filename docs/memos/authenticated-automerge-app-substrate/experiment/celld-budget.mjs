import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { build } from "esbuild";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { createPeer, closePeers, eventually, synchronize } from "./backend.mjs";
import { buildPersistenceFixture, assertSameIdentity } from "./persistence-workload.mjs";
import {
  MAX_WEBSOCKET_MESSAGE_BYTES,
  WebSocketByteTransport,
} from "./pages/shared/byte-transport.mjs";
import { celldCborPlugin } from "./pages/scripts/celld-cbor.mjs";
import { CELLD_RELEASE, parseRuntimeVersion } from "./pages/scripts/deployment/profiles.mjs";
const root = dirname(fileURLToPath(import.meta.url));
const value = (key, fallback) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? fallback : process.argv[i + 1];
};
const capacityMiB = Number(value("--capacity-mib", 18)),
  budgetMiB = Number(value("--budget-mib", 32));
const frameMiB = Number(value("--frame-mib", MAX_WEBSOCKET_MESSAGE_BYTES / 1024 / 1024));
const binary = value("--celld", process.env.CELLD_BIN || "celld");
assert.ok(Number.isFinite(capacityMiB) && capacityMiB >= 0 && capacityMiB <= 64);
assert.ok(Number.isFinite(budgetMiB) && budgetMiB > 0 && budgetMiB <= 64);
assert.ok(Number.isFinite(frameMiB) && frameMiB > 0 && frameMiB <= 32);
const out = await mkdtemp(join(tmpdir(), "page7-celld-budget-")),
  runtime = join(out, "runtime");
await mkdir(runtime);
const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const origin = `http://127.0.0.1:${port}`;
await build({
  entryPoints: [join(root, "celld-budget-worker.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd"],
  external: ["node:*"],
  outfile: join(runtime, "index.js"),
  define: {
    BUDGET_FRAME_MIB: String(frameMiB),
    BUDGET_MIB: String(budgetMiB),
    BUDGET_ORIGIN: JSON.stringify(origin),
  },
  plugins: [
    celldCborPlugin(),
    {
      name: "wasm",
      setup(b) {
        b.onResolve({ filter: /\.wasm$/ }, async (args) => {
          const p = resolve(args.resolveDir, args.path),
            name = p.includes("subduction") ? "subduction.wasm" : "automerge.wasm";
          await copyFile(p, join(runtime, name));
          return { path: `./${name}`, external: true };
        });
      },
    },
  ],
});
await writeFile(
  join(runtime, "wrangler.json"),
  JSON.stringify({
    name: "page7-local-budget",
    main: "index.js",
    no_bundle: true,
    compatibility_date: "2026-10-01",
    durable_objects: {
      bindings: [
        { name: "PAGES", class_name: "BudgetPage" },
        { name: "RECORDS", class_name: "PageRecords" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["BudgetPage", "PageRecords"] }],
  }),
);
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "TEMP", "TMP"]
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
const runtimeVersion = parseRuntimeVersion(
  execFileSync(binary, ["--version"], { env, encoding: "utf8" }),
);
assert.equal(runtimeVersion, CELLD_RELEASE.version, "Use the qualified celld release");
const report = {
  out,
  budgetMiB,
  capacityMiB,
  frameMiB,
  binary,
  runtime: runtimeVersion,
  evidence:
    "Real local celld dev SQLite persistence and native WebSocket sync. Test-only worker uses production native adapter/record stores/transport, omits auth/UI; no S3/R2 or Cloudflare claim.",
  runs: [],
};
let host,
  log,
  sampler,
  maximumRss = 0;
function rss() {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((s) => s.trim().split(/\s+/).map(Number));
    const ids = new Set([host.pid]);
    let n;
    do {
      n = ids.size;
      for (const [pid, parent] of rows) if (ids.has(parent)) ids.add(pid);
    } while (ids.size !== n);
    return rows.filter(([pid]) => ids.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0);
  } catch {
    return 0;
  }
}
async function start() {
  log = createWriteStream(join(out, `celld-${report.runs.length}.log`));
  host = spawn(
    binary,
    ["dev", runtime, "--host", "127.0.0.1", "--port", String(port), "--no-watch", "--logs"],
    { cwd: out, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  host.stdout.pipe(log, { end: false });
  host.stderr.pipe(log, { end: false });
  maximumRss = 0;
  sampler = setInterval(() => {
    maximumRss = Math.max(maximumRss, rss());
  }, 100);
  await eventually(async () => {
    const r = await fetch(`${origin}/health`);
    assert.equal(r.status, 200);
  }, 30000);
}
async function stop() {
  clearInterval(sampler);
  if (!host) return;
  const h = host;
  host = undefined;
  h.kill("SIGTERM");
  await Promise.race([
    new Promise((r) => h.once("exit", r)),
    new Promise((r) =>
      setTimeout(() => {
        h.kill("SIGKILL");
        r();
      }, 5000),
    ),
  ]);
  log.end();
}
async function request(path, body) {
  const r = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  if (!r.ok) throw Error(`${path} ${r.status}: ${text}`);
  return JSON.parse(text);
}
const fixture = buildPersistenceFixture({ rounds: 320, capacityMiB }),
  id = interpretAsDocumentId(generateAutomergeUrl());
report.fixture = fixture.metrics;
let peer, wire;
try {
  await start();
  let started = performance.now();
  await request("/initialize", { documentId: id });
  for (const r of fixture.loose)
    await request("/ingest", [{ ...r, blob: Buffer.from(r.blob).toString("base64") }]);
  // Keep original loose bytes; add only independently keyed native fragments.
  for (const r of fixture.covering.filter((r) => r.kind === "fragment"))
    await request("/ingest", [{ ...r, blob: Buffer.from(r.blob).toString("base64") }]);
  const ingestedMs = performance.now() - started;
  started = performance.now();
  await request("/flush");
  const flushMs = performance.now() - started;
  started = performance.now();
  const summary = await request("/summary");
  assert.deepEqual(summary.heads, A.getHeads(fixture.doc));
  assert.equal(summary.changes, fixture.loose.length);
  report.runs.push({
    stage: "ingest",
    ingestedMs,
    flushMs,
    openMs: performance.now() - started,
    summary,
    maxCelldRssKiB: maximumRss,
  });
  await stop();
  await start();
  started = performance.now();
  const reopened = await request("/summary");
  const reopenMs = performance.now() - started;
  assert.deepEqual(reopened, summary);
  report.runs.push({ stage: "restart", reopenMs, summary: reopened, maxCelldRssKiB: maximumRss });
  peer = createPeer();
  const state = await request("/stats");
  const socket = new WebSocket(origin.replace("http:", "ws:") + "/ws");
  wire = new WebSocketByteTransport(socket, {
    maxFrameBytes: frameMiB * 1024 * 1024,
    maxQueuedBytes: Math.max(8, frameMiB) * 1024 * 1024,
  });
  await new Promise((r, j) => {
    socket.addEventListener("open", r, { once: true });
    socket.addEventListener("error", j, { once: true });
  });
  const expected = new N.PeerId(Buffer.from(state.peer, "hex"));
  const transport = await N.AuthenticatedTransport.setup(wire, peer.signer, expected);
  try {
    await peer.backend.addConnection(transport);
  } finally {
    transport.free();
    expected.free();
  }
  started = performance.now();
  const handle = await peer.repo.find(id, { signal: AbortSignal.timeout(60000) });
  await synchronize(peer, id);
  await eventually(() => assertSameIdentity(handle.doc(), fixture.doc), 15000);
  const coldSyncMs = performance.now() - started;
  started = performance.now();
  const edited = await request("/edit");
  await eventually(() => assert.deepEqual(A.getHeads(handle.doc()), edited.heads), 10000);
  const editToPeerMs = performance.now() - started;
  started = performance.now();
  await handle.change((d) => {
    A.splice(
      d,
      ["blocks", "notes", "richText"],
      d.blocks.notes.richText.length,
      0,
      " peer budget edit",
    );
  });
  await peer.repo.flush([id]);
  await synchronize(peer, id);
  let peerEdited;
  await eventually(async () => {
    peerEdited = await request("/summary");
    assert.deepEqual(peerEdited.heads, A.getHeads(handle.doc()));
  }, 10000);
  const peerToHostMs = performance.now() - started;
  await request("/flush");
  const received = [];
  handle.on("ephemeral-message", (event) => received.push(event));
  handle.broadcast({ probe: "client-cursor", offset: 7 });
  await eventually(
    async () =>
      assert.ok(
        (await request("/presence-state")).messages.some(
          (e) => e.message.probe === "client-cursor",
        ),
      ),
    10000,
  );
  await request("/presence");
  await eventually(() => assert.ok(received.some((e) => e.message.probe === "host-cursor")), 10000);
  report.runs.push({
    stage: "restart-sync-edit",
    reopenMs,
    coldSyncMs,
    editToPeerMs,
    peerToHostMs,
    bidirectionalPresence: true,
    summary: peerEdited,
    maxCelldRssKiB: maximumRss,
    transport: await request("/stats"),
  });
  await wire.disconnect();
  await closePeers([peer]);
  wire = peer = undefined;
  await stop();
  await start();
  const final = await request("/summary");
  assert.deepEqual(final.heads, peerEdited.heads);
  assert.equal(final.text, peerEdited.text);
  report.finalEditedStateReopened = true;
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = { message: String(error), stack: error.stack };
  process.exitCode = 1;
} finally {
  await wire?.disconnect();
  if (peer) await closePeers([peer]);
  await stop();
  fixture.free();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { out, ok: report.ok, error: report.error?.message, runs: report.runs },
      null,
      2,
    ),
  );
}
