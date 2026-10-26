// One bounded, headless local OIDC + celld + browser + MCP sharing qualification.
// No pre-existing server, provider account, credentials, or persistent dev state.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { celldCborPlugin } from "./celld-cbor.mjs";
import { CELLD_RELEASE, parseRuntimeVersion } from "./deployment/profiles.mjs";
import { fixtureWhoamiUrl, generateFixtureKeys } from "./fixtures/local-api-keys.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(
  process.env.PAGES_E2E_OUTPUT || path.join(app, "test-results", `sharing-${Date.now()}`),
);
const children = new Set();
let canceled = false;
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await new Promise((resolve) => child.once("exit", resolve));
  } finally {
    clearTimeout(timeout);
  }
}
const abort = () => {
  canceled = true;
  for (const child of children) child.kill("SIGTERM");
};
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
function start(command, args, options = {}) {
  if (canceled) throw new Error("E2E interrupted");
  const child = spawn(command, args, { cwd: app, stdio: "inherit", ...options });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
async function run(command, args, options) {
  const child = start(command, args, options);
  const timeout = setTimeout(() => {
    void stop(child);
  }, 180000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        signal ? reject(new Error(`${command} stopped: ${signal}`)) : resolve(code),
      );
    });
  } finally {
    clearTimeout(timeout);
  }
  if (code !== 0) throw new Error(`${command} failed (${code})`);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), "pages-sharing-e2e-"));
let host, log;
try {
  if (!process.argv.includes("--skip-build")) await run(process.execPath, ["scripts/build.mjs"]);
  const port = await freePort(),
    origin = `http://localhost:${port}`;
  const runtime = path.join(scratch, "runtime");
  await mkdir(runtime);
  // Whitelist build outputs. Never copy .dev.vars, .celld, or a deployable receipt.
  for (const name of ["public", "automerge.wasm", "subduction.wasm", "wrangler.json"])
    await cp(path.join(app, "dist", name), path.join(runtime, name), { recursive: true });
  const { keys, responses } = generateFixtureKeys();
  const keyFile = path.join(scratch, "fixture-keys.json");
  await writeFile(keyFile, JSON.stringify(keys), { mode: 0o600 });
  await build({
    entryPoints: [path.join(app, "scripts/fixtures/local-sharing-worker.mjs")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd"],
    tsconfig: path.join(app, "tsconfig.json"),
    external: ["node:*"],
    outfile: path.join(runtime, "index.js"),
    define: {
      PAGES_E2E_ORIGIN: JSON.stringify(origin),
      PAGES_E2E_RESPONSES: JSON.stringify(responses),
    },
    plugins: [
      celldCborPlugin(),
      {
        name: "e2e-compiled-wasm",
        setup(b) {
          b.onResolve({ filter: /\.wasm$/ }, async (args) => {
            const absolute = path.resolve(args.resolveDir, args.path);
            const name = absolute.includes("subduction") ? "subduction.wasm" : "automerge.wasm";
            await copyFile(absolute, path.join(runtime, name));
            return { path: `./${name}`, external: true };
          });
        },
      },
    ],
  });
  await writeFile(
    path.join(runtime, ".dev.vars"),
    Object.entries({
      PAGES_E2E_ONLY: "true",
      PAGES_EDITOR: "wordgard",
      PAGES_ASYNC_PERSISTENCE: "true",
      PAGES_COMPACT_RECORDS: "true",
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: randomBytes(32).toString("hex"),
      NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
      NOTEBOOK_CLOUD_OIDC_FLOW: "server",
      NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
      NOTEBOOK_CLOUD_OIDC_ISSUER: `${origin}/dev/oidc`,
      NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages-e2e",
      NOTEBOOK_CLOUD_OIDC_AUDIENCE: "pages-e2e",
      NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "pages-e2e",
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: "pages-e2e",
      NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: fixtureWhoamiUrl,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  log = createWriteStream(path.join(output, "celld.log"));
  // Do not inherit fleet, object-store, or provider credentials from the shell.
  const hostEnv = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const version = parseRuntimeVersion(
    execFileSync(process.env.CELLD_BIN || "celld", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      env: hostEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (version !== CELLD_RELEASE.version)
    throw new Error(`Sharing fixture requires ${CELLD_RELEASE.version}; found ${version}`);
  host = start(
    process.env.CELLD_BIN || "celld",
    ["dev", runtime, "--host", "127.0.0.1", "--port", String(port), "--no-watch", "--logs"],
    { cwd: scratch, env: hostEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  host.stdout.pipe(log, { end: false });
  host.stderr.pipe(log, { end: false });
  let startupError;
  host.on("error", (error) => {
    startupError = error;
  });
  const deadline = Date.now() + 60000;
  for (;;) {
    if (startupError) throw startupError;
    if (canceled || host.exitCode !== null || host.signalCode)
      throw new Error("Local celld stopped before qualification");
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).prototype === "pages-celld-native") break;
    } catch {
      /* wait for local runtime startup */
    }
    if (Date.now() >= deadline)
      throw new Error(`Local celld did not become ready; see ${output}/celld.log`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await run(process.execPath, ["scripts/sharing-smoke.mjs"], {
    env: {
      ...process.env,
      PAGES_ORIGIN: origin,
      PAGES_SCREENSHOTS: output,
      PAGES_E2E_KEY_FILE: keyFile,
    },
  });
  const result = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
  if (!result.cleaned || result.failure)
    throw new Error("Sharing qualification did not complete cleanly");
  console.log(`Local OIDC, sharing and MCP qualification passed. Artifacts: ${output}`);
} finally {
  await Promise.all([...children].map(stop));
  if (log) await new Promise((resolve) => log.end(resolve));
  await rm(scratch, { recursive: true, force: true });
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
