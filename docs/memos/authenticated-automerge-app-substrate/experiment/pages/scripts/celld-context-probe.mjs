// Probe whether celld keeps request context across shared promises.
//
//   CELLD_BIN=/path/to/celld node scripts/celld-context-probe.mjs [runs]
//
// An owner request creates a promise settled by its own 200 ms timer and
// responds after it, optionally lingering. A waiter request arrives 50 ms
// later, awaits that promise, then starts its own timer or D1 query. If the
// waiter's work belongs to the owner, it never finishes once the owner has
// responded. The same pair also runs inside Durable Objects.
//
// It prints each case's outcomes ("missing" means the waiter ran in another
// isolate and proves nothing). Exit status 2 means some waiter hung, so
// worker/isolate-setup.mjs is still needed. Exit status 0 means every waiter
// finished.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const runs = Number(process.argv[2] ?? 10);
const celld = process.env.CELLD_BIN || "celld";

const worker = `
const shared = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function owner(url) {
  const settled = sleep(200);
  shared.set(url.searchParams.get("k"), settled);
  await settled;
  const linger = Number(url.searchParams.get("linger") ?? 0);
  if (linger) await sleep(linger);
  return new Response("owner");
}
async function waiter(url, env) {
  const found = shared.has(url.searchParams.get("k"));
  if (url.searchParams.get("own") === "1") await sleep(200);
  else await shared.get(url.searchParams.get("k"));
  if (url.searchParams.get("then") === "d1") await env.DB.prepare("SELECT 1").first();
  else await sleep(300);
  return new Response(found || url.searchParams.get("own") === "1" ? "done" : "missing");
}
const route = (request, env) => {
  const url = new URL(request.url);
  if (url.pathname === "/owner") return owner(url);
  if (url.pathname === "/waiter") return waiter(url, env);
  return new Response("ok");
};
export class Probe {
  constructor(ctx, env) {
    this.env = env;
  }
  fetch(request) {
    return route(request, this.env);
  }
}
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const object = url.searchParams.get("object");
    return object ? env.PROBE.getByName(object).fetch(request) : route(request, env);
  },
};
`;

// [name, owner object, waiter object, waiter follow-up, owner linger ms, waiter awaits its own timer]
const cases = [
  ["stateless: waiter timer, owner responds at once", "", "", "timer", 0, false],
  ["stateless: waiter timer, owner lingers 100 ms", "", "", "timer", 100, false],
  ["stateless: waiter timer, owner lingers 1000 ms", "", "", "timer", 1000, false],
  ["stateless: waiter D1, owner responds at once", "", "", "d1", 0, false],
  ["stateless: waiter D1, owner lingers 1000 ms", "", "", "d1", 1000, false],
  ["stateless: waiter awaits its own timer", "", "", "timer", 0, true],
  ["object: same object, owner responds at once", "a", "a", "timer", 0, false],
  ["object: other object, owner responds at once", "a", "b", "timer", 0, false],
  ["object: same object, waiter D1", "a", "a", "d1", 0, false],
  ["object: other object, waiter D1", "a", "b", "d1", 0, false],
];

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dir = await mkdtemp(path.join(os.tmpdir(), "celld-context-probe-"));
await writeFile(path.join(dir, "index.js"), worker);
await writeFile(
  path.join(dir, "wrangler.json"),
  JSON.stringify({
    name: "celld-context-probe",
    main: "index.js",
    no_bundle: true,
    compatibility_date: "2026-10-01",
    d1_databases: [{ binding: "DB", database_name: "probe", database_id: "probe" }],
    durable_objects: { bindings: [{ name: "PROBE", class_name: "Probe" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Probe"] }],
  }),
);
const version = execFileSync(celld, ["--version"], { encoding: "utf8" }).trim();
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
);
const child = spawn(
  celld,
  ["dev", dir, "--host", "127.0.0.1", "--port", String(port), "--no-watch"],
  { env, stdio: "ignore", detached: true },
);
let hung = 0;
try {
  for (let i = 0; ; i++) {
    if (i > 300) throw new Error("celld did not start");
    try {
      if ((await fetch(`${base}/`, { signal: AbortSignal.timeout(500) })).ok) break;
    } catch {}
    await sleep(100);
  }
  const get = (query) =>
    fetch(`${base}${query}`, { signal: AbortSignal.timeout(4000) }).then(
      (response) => response.text(),
      () => "hung",
    );
  console.log(version);
  for (const [name, ownerObject, waiterObject, then, linger, own] of cases) {
    const outcomes = {};
    for (let run = 0; run < runs; run++) {
      const k = `${Date.now()}-${run}`;
      const on = (object) => (object ? `&object=${object}` : "");
      const first = own
        ? Promise.resolve()
        : get(`/owner?k=${k}&linger=${linger}${on(ownerObject)}`);
      await sleep(50);
      const [, outcome] = await Promise.all([
        first,
        get(`/waiter?k=${k}&then=${then}${own ? "&own=1" : ""}${on(waiterObject)}`),
      ]);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    hung += outcomes.hung ?? 0;
    console.log(`${name}: ${JSON.stringify(outcomes)}`);
  }
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await sleep(1000);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  await rm(dir, { recursive: true, force: true });
}
process.exitCode = hung ? 2 : 0;
