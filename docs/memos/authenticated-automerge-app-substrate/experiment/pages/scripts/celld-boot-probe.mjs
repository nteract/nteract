// Probe how celld runs a Durable Object boot started by a request inside
// `ctx.blockConcurrencyWhile`, as a Page host's lazy boot does.
//
//   CELLD_BIN=/path/to/celld node scripts/celld-boot-probe.mjs [--limit]
//
// Cases:
// - throw: the boot throws once. Does the object reset (constructor runs
//   again, instance state fresh) so the next request boots again?
// - queued: a second request arrives while a boot that throws is running.
//   Is it held until the boot ends, and what does it get?
// - succeed: a request boots and responds. Does a later request see the
//   booted state, and does a timer chain the boot started keep running after
//   the booting request has responded?
// - limit (with --limit): a boot that runs 35 s. Does celld end it at 30 s?
//
// Prints each case's observations as JSON. Exit status 0 means a throw reset
// the object and the next request booted again.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const celld = process.env.CELLD_BIN || "celld";
const limit = process.argv.includes("--limit");

const worker = `
let constructed = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class Probe {
  constructor(ctx) {
    this.ctx = ctx;
    this.instance = ++constructed;
    this.booted = false;
    this.ticks = 0;
  }
  state() {
    return { instance: this.instance, constructed, booted: this.booted, ticks: this.ticks };
  }
  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    if (action === "state") return Response.json(this.state());
    if (action === "boot") {
      const fail = url.searchParams.get("fail") === "1";
      const ms = Number(url.searchParams.get("ms") ?? 0);
      const tick = url.searchParams.get("tick") === "1";
      const started = Date.now();
      try {
        await this.ctx.blockConcurrencyWhile(async () => {
          await sleep(ms);
          if (fail) throw new Error("transient boot failure");
          this.booted = true;
          if (tick) {
            const step = () => {
              this.ticks++;
              if (this.ticks < 40) setTimeout(step, 50);
            };
            setTimeout(step, 50);
          }
        });
      } catch (error) {
        return Response.json(
          { caught: String(error?.message ?? error), ms: Date.now() - started, ...this.state() },
          { status: 500 },
        );
      }
      return Response.json({ ms: Date.now() - started, ...this.state() });
    }
    return new Response("ok");
  }
}
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const object = url.searchParams.get("object");
    return object ? env.PROBE.getByName(object).fetch(request) : new Response("ok");
  },
};
`;

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

const dir = await mkdtemp(path.join(os.tmpdir(), "celld-boot-probe-"));
await writeFile(path.join(dir, "index.js"), worker);
await writeFile(
  path.join(dir, "wrangler.json"),
  JSON.stringify({
    name: "celld-boot-probe",
    main: "index.js",
    no_bundle: true,
    compatibility_date: "2026-10-01",
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
const results = { version };
let reset = false;
try {
  for (let i = 0; ; i++) {
    if (i > 300) throw new Error("celld did not start");
    try {
      if ((await fetch(`${base}/`, { signal: AbortSignal.timeout(500) })).ok) break;
    } catch {}
    await sleep(100);
  }
  const get = async (query, timeout = 10000) => {
    const started = Date.now();
    try {
      const response = await fetch(`${base}/?${query}`, { signal: AbortSignal.timeout(timeout) });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 200);
      }
      return { status: response.status, body, at: Date.now() - started };
    } catch (error) {
      return { status: "hung", error: String(error), at: Date.now() - started };
    }
  };

  // throw
  const before = await get("object=throw&action=state");
  const failed = await get("object=throw&action=boot&fail=1");
  const after = await get("object=throw&action=state");
  const retried = await get("object=throw&action=boot");
  results.throw = { before, failed, after, retried };
  reset =
    after.status === 200 &&
    after.body.instance !== before.body.instance &&
    retried.status === 200 &&
    retried.body.booted === true;

  // queued
  await get("object=queued&action=state");
  const booting = get("object=queued&action=boot&fail=1&ms=400");
  await sleep(100);
  const queued = get("object=queued&action=state");
  results.queued = { booting: await booting, queued: await queued };

  // succeed
  const booted = await get("object=succeed&action=boot&tick=1");
  await sleep(1000);
  const later = await get("object=succeed&action=state");
  await sleep(1500);
  const latest = await get("object=succeed&action=state");
  results.succeed = { booted, later, latest };

  if (limit) results.limit = await get("object=limit&action=boot&ms=35000", 60000);
  console.log(JSON.stringify(results, null, 2));
  console.log(reset ? "a throw resets the object" : "a throw did NOT reset the object");
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
process.exitCode = reset ? 0 : 2;
