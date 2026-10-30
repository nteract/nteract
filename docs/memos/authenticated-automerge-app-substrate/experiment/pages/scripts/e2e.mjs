// Curated browser E2E runner: one build, then each suite against its own
// loopback celld 0.6.3 with temporary state. Suites run one at a time.
//
//   node scripts/e2e.mjs                  # the default suites
//   node scripts/e2e.mjs wordgard images  # selected suites, opt-in ones included
//   node scripts/e2e.mjs --list
//
// Two suite kinds:
// - `script`: a smoke that expects a running local Wordgard fixture. The runner
//   stages dist/ into a temporary runtime, starts `celld dev` with loopback OIDC
//   and the Page8 persistence flags, and points PAGES_ORIGIN at it.
// - `harness`: a self-hosting harness (local-sharing-e2e.mjs mode or
//   local-oauth-e2e.mjs). It starts its own fixture Worker and celld; the runner
//   passes --skip-build and PAGES_E2E_OUTPUT.
//
// Artifacts for each suite land in test-results/e2e-<timestamp>/<suite>/:
// output.log (suite stdout/stderr), celld.log, report.json, and the smoke's
// screenshots (failure-*.png/html on failure). CELLD_BIN selects the runtime.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CELLD_RELEASE, parseRuntimeVersion } from "./deployment/profiles.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const celld = process.env.CELLD_BIN || "celld";
const minute = 60_000;

// Each timeout bounds the whole suite, including fixture startup and cleanup.
// `optIn` suites run only when named. A new local-sharing-e2e.mjs mode joins
// with one entry: { name, harness: sharing("--mode"), timeout }.
const sharing = (...flags) => ["scripts/local-sharing-e2e.mjs", ...flags];
const SUITES = Object.freeze([
  { name: "wordgard", script: "scripts/wordgard-smoke.mjs", timeout: 5 * minute },
  { name: "rich-comments", script: "scripts/rich-comments-smoke.mjs", timeout: 3 * minute },
  { name: "comments-layout", script: "scripts/comments-layout-smoke.mjs", timeout: 3 * minute },
  { name: "editable-table", script: "scripts/editable-table-smoke.mjs", timeout: 3 * minute },
  { name: "navigation", script: "scripts/navigation-smoke.mjs", timeout: 3 * minute },
  { name: "passages", script: "scripts/passages-changes-smoke.mjs", timeout: 3 * minute },
  { name: "presence", script: "scripts/presence-smoke.mjs", timeout: 3 * minute },
  { name: "title-warning", script: "scripts/title-warning-smoke.mjs", timeout: 2 * minute },
  { name: "native", script: "scripts/smoke.mjs", timeout: 2 * minute },
  { name: "task-lists", harness: sharing("--task-lists"), timeout: 3 * minute },
  { name: "images", harness: sharing("--images"), timeout: 4 * minute },
  { name: "mcp-images", harness: sharing("--mcp-images"), timeout: 4 * minute },
  { name: "sharing", harness: sharing(), timeout: 4 * minute },
  { name: "admission", harness: sharing("--admission"), timeout: 4 * minute },
  { name: "domain-view", harness: sharing("--domain-view"), timeout: 4 * minute },
  { name: "build-update", harness: sharing("--build-update"), timeout: 4 * minute },
  { name: "trash", harness: sharing("--trash"), timeout: 4 * minute },
  { name: "spaces", harness: sharing("--spaces"), timeout: 4 * minute },
  { name: "oauth", harness: ["scripts/local-oauth-e2e.mjs"], timeout: 4 * minute },
]);

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const suite of SUITES) console.log(suite.name + (suite.optIn ? " (opt-in)" : ""));
  process.exit(0);
}
const requested = args.filter((arg) => !arg.startsWith("--"));
const unknown = requested.filter((name) => !SUITES.some((suite) => suite.name === name));
if (unknown.length) throw new Error(`Unknown suite(s): ${unknown.join(", ")}. Use --list.`);
const selected = requested.length
  ? SUITES.filter((suite) => requested.includes(suite.name))
  : SUITES.filter((suite) => !suite.optIn);

// Only these variables reach celld; fleet, object-store, and provider
// credentials in the caller's shell stay out of the fixture.
const hostEnv = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);

const version = parseRuntimeVersion(
  execFileSync(celld, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    env: hostEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
if (version !== CELLD_RELEASE.version)
  throw new Error(`Pages E2E requires ${CELLD_RELEASE.version}; ${celld} is ${version}`);

const runRoot = path.join(
  app,
  "test-results",
  `e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
await mkdir(runRoot, { recursive: true });

const live = new Set();
let interrupted = false;
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    interrupted = true;
    for (const child of live) killGroup(child, "SIGTERM");
  });

// Every child leads its own process group so a timeout also reaches celld's
// local node and the smoke's Chromium.
function launch(command, argv, { env, cwd = app, log }) {
  const child = spawn(command, argv, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.add(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.pipe(log, { end: false });
    if (log.mirror)
      stream.pipe(stream === child.stdout ? process.stdout : process.stderr, { end: false });
  }
  child.exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      live.delete(child);
      resolve({ code, signal });
    }),
  );
  child.once("error", (error) => {
    log.write(`spawn error: ${error.message}\n`);
    live.delete(child);
  });
  return child;
}

async function stop(child, grace = 10_000) {
  if (child.exitCode !== null || child.signalCode) return;
  // The leader handles SIGTERM itself (local-sharing-e2e cleans up its
  // children and scratch directory); the group kill is the fallback.
  child.kill("SIGTERM");
  const timer = setTimeout(() => killGroup(child, "SIGKILL"), grace);
  await child.exited;
  clearTimeout(timer);
  killGroup(child, "SIGKILL");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function openLog(file, mirror) {
  const log = createWriteStream(file);
  log.mirror = mirror;
  return log;
}

async function closeLog(log) {
  await new Promise((resolve) => log.end(resolve));
}

// A local Wordgard fixture equivalent to `npm run dev` with Page8's persistence
// flags, staged from dist/ into a temporary directory so no dev state is reused.
async function startServer(output, deadline) {
  const scratch = await mkdtemp(path.join(tmpdir(), "pages-e2e-"));
  const runtime = path.join(scratch, "runtime");
  await mkdir(runtime);
  for (const name of ["index.js", "public", "automerge.wasm", "subduction.wasm", "wrangler.json"])
    await cp(path.join(app, "dist", name), path.join(runtime, name), { recursive: true });
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  await writeFile(
    path.join(runtime, ".dev.vars"),
    [
      `NOTEBOOK_CLOUD_APP_SESSION_SECRET=${randomBytes(32).toString("hex")}`,
      "NOTEBOOK_CLOUD_LOCAL_OIDC=true",
      "PAGES_ASYNC_PERSISTENCE=true",
      "PAGES_COMPACT_RECORDS=true",
      "PAGES_CATALOG_INDEX=1",
      "NOTEBOOK_CLOUD_OIDC_FLOW=server",
      `NOTEBOOK_CLOUD_PUBLIC_ORIGIN=${origin}`,
      `NOTEBOOK_CLOUD_OIDC_ISSUER=${origin}/dev/oidc`,
      "NOTEBOOK_CLOUD_OIDC_CLIENT_ID=pages-e2e",
      "NOTEBOOK_CLOUD_OIDC_AUDIENCE=pages-e2e",
      "NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE=pages-e2e",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const log = openLog(path.join(output, "celld.log"), false);
  const host = launch(
    celld,
    ["dev", runtime, "--host", "127.0.0.1", "--port", String(port), "--no-watch", "--logs"],
    { cwd: scratch, env: hostEnv, log },
  );
  const server = {
    origin,
    async close() {
      await stop(host);
      await closeLog(log);
      await rm(scratch, { recursive: true, force: true });
    },
  };
  const ready = Math.min(deadline, Date.now() + minute);
  try {
    for (;;) {
      if (interrupted) throw new Error("Interrupted");
      if (host.exitCode !== null || host.signalCode)
        throw new Error(`celld exited before it became ready; see ${output}/celld.log`);
      try {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).prototype === "pages-celld-native") break;
      } catch {
        /* still starting */
      }
      if (Date.now() >= ready)
        throw new Error(`celld did not become ready; see ${output}/celld.log`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
}

async function runSuite(suite, attempt) {
  const output = path.join(runRoot, attempt > 1 ? `${suite.name}-attempt-${attempt}` : suite.name);
  await mkdir(output, { recursive: true });
  const started = Date.now();
  const deadline = started + suite.timeout;
  const log = openLog(path.join(output, "output.log"), true);
  let server,
    child,
    timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child) void stop(child);
  }, suite.timeout);
  try {
    let command;
    let env = { ...process.env, CELLD_BIN: celld };
    if (suite.harness) {
      const [script, ...flags] = suite.harness;
      command = [script, "--skip-build", ...flags];
      env.PAGES_E2E_OUTPUT = output;
    } else {
      server = await startServer(output, deadline);
      command = [suite.script];
      env = { ...env, PAGES_ORIGIN: server.origin, PAGES_SCREENSHOTS: output };
    }
    if (timedOut || interrupted) throw new Error(timedOut ? "timed out" : "interrupted");
    child = launch(process.execPath, command, { env, log });
    const { code, signal } = await child.exited;
    if (timedOut) throw new Error(`timed out after ${suite.timeout / 1000}s`);
    if (code !== 0) throw new Error(signal ? `stopped by ${signal}` : `exited ${code}`);
    return { name: suite.name, result: "pass", seconds: (Date.now() - started) / 1000 };
  } catch (error) {
    return {
      name: suite.name,
      result: "fail",
      seconds: (Date.now() - started) / 1000,
      error: error.message,
      artifacts: path.relative(app, output),
    };
  } finally {
    clearTimeout(timer);
    await server?.close();
    await closeLog(log);
  }
}

if (!args.includes("--skip-build"))
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: app, stdio: "inherit" });

// PAGES_E2E_RETRIES reruns a failed suite in a fresh fixture. A suite that
// passes only on retry is reported as flaky and keeps every attempt's
// artifacts. More than PAGES_E2E_MAX_FLAKY flaky suites fail the run.
function envInteger(name, fallback, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new Error(`${name} must be an integer from 0 to ${max}`);
  return value;
}
const retries = envInteger("PAGES_E2E_RETRIES", 0, 2);
const maxFlaky = envInteger("PAGES_E2E_MAX_FLAKY", 1, SUITES.length);

// Results are written as each suite finishes, so a cancelled or timed-out job
// keeps the suites it completed: one JSON line per suite in results.jsonl, the
// whole list in summary.json, and a row in the GitHub step summary.
const stepSummary = process.env.GITHUB_STEP_SUMMARY;
const summarize = (text) => (stepSummary ? appendFile(stepSummary, text) : undefined);
await summarize("### Pages browser E2E\n\n| Suite | Result | Seconds |\n| --- | --- | --- |\n");
const results = [];
for (const suite of selected) {
  if (interrupted) break;
  const attempts = [];
  for (let attempt = 1; attempt <= retries + 1 && !interrupted; attempt++) {
    console.log(`\n=== ${suite.name}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
    const result = await runSuite(suite, attempt);
    attempts.push(result);
    console.log(
      `=== ${suite.name}: ${result.result.toUpperCase()} in ${result.seconds.toFixed(1)}s` +
        (result.error ? ` (${result.error}; artifacts in ${result.artifacts})` : ""),
    );
    if (result.result === "pass") break;
  }
  const last = attempts.at(-1);
  const result = {
    ...last,
    result: last.result === "pass" && attempts.length > 1 ? "flaky" : last.result,
    seconds: attempts.reduce((total, { seconds }) => total + seconds, 0),
    attempts,
  };
  results.push(result);
  await appendFile(path.join(runRoot, "results.jsonl"), JSON.stringify(result) + "\n");
  await writeFile(path.join(runRoot, "summary.json"), JSON.stringify(results, null, 2) + "\n");
  const label = result.result === "pass" ? "pass" : `**${result.result.toUpperCase()}**`;
  await summarize(`| ${result.name} | ${label} | ${result.seconds.toFixed(1)} |\n`);
}

console.log("\nPages E2E summary");
for (const { name, result, seconds } of results)
  console.log(`  ${result.toUpperCase().padEnd(5)} ${name.padEnd(16)} ${seconds.toFixed(1)}s`);
const failed = results.filter((result) => result.result === "fail");
const flaky = results.filter((result) => result.result === "flaky");
const overBudget = flaky.length > maxFlaky;
const verdict = [];
if (failed.length) verdict.push(`**Failed:** ${failed.map(({ name }) => name).join(", ")}`);
if (flaky.length)
  verdict.push(
    `**Flaky (passed only on retry): ${flaky.map(({ name }) => name).join(", ")}.** ` +
      `${flaky.length} of a budget of ${maxFlaky} (PAGES_E2E_MAX_FLAKY)` +
      (overBudget ? "; over budget, so the run fails." : "."),
  );
if (results.length !== selected.length)
  verdict.push(`**Incomplete:** ${results.length} of ${selected.length} suites ran.`);
await summarize("\n" + (verdict.length ? verdict.join("\n\n") : "All suites passed.") + "\n");
for (const line of verdict) console.log(line.replaceAll("**", ""));
if (interrupted || failed.length || flaky.length || results.length !== selected.length)
  console.log(`Artifacts: ${path.relative(process.cwd(), runRoot)}`);
if (interrupted || failed.length || overBudget || results.length !== selected.length)
  process.exitCode = 1;
