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
const domainView = process.argv.includes("--domain-view");
const images = process.argv.includes("--images");
const mcpImages = process.argv.includes("--mcp-images");
const taskLists = process.argv.includes("--task-lists");
const admission = process.argv.includes("--admission");
const buildUpdate = process.argv.includes("--build-update");
const trash = process.argv.includes("--trash");
const spaces = process.argv.includes("--spaces");
if (
  [domainView, images, mcpImages, taskLists, admission, buildUpdate, trash, spaces].filter(Boolean)
    .length > 1
)
  throw new Error(
    "Choose one qualification: --domain-view, --images, --mcp-images, --task-lists, --admission, --build-update, --trash or --spaces",
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
async function run(command, args, options, onMessage) {
  const child = start(command, args, options);
  if (onMessage) child.on("message", (message) => onMessage(message, child));
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
async function portFree(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
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
  // The fixture Worker advertises the same build id the viewer bundle embeds.
  let buildId;
  try {
    buildId = JSON.parse(
      await readFile(path.join(app, "dist/build-receipt.json"), "utf8"),
    ).build_id;
  } catch {
    if (buildUpdate) throw new Error("--build-update needs dist/build-receipt.json; build first");
  }
  const workerBuild = {
    entryPoints: [
      path.join(
        app,
        "scripts/fixtures",
        mcpImages
          ? "local-mcp-image-worker.mjs"
          : domainView
            ? "local-domain-sharing-worker.mjs"
            : "local-sharing-worker.mjs",
      ),
    ],
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
      ...(buildId ? { __PAGES_BUILD__: JSON.stringify(buildId) } : {}),
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
  };
  await build(workerBuild);
  await writeFile(
    path.join(runtime, ".dev.vars"),
    Object.entries({
      PAGES_E2E_ONLY: "true",
      ...(domainView ? { PAGES_COMPANY_VIEW_DOMAINS: "anaconda.com" } : {}),
      PAGES_EDITOR: "wordgard",
      PAGES_ASYNC_PERSISTENCE: "true",
      PAGES_COMPACT_RECORDS: "true",
      PAGES_CATALOG_INDEX: "1",
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
  if (images || mcpImages) hostEnv.CELLD_MAX_REQUEST_BODY_BYTES = String(6 * 1024 * 1024);
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
  async function boot() {
    host = start(
      process.env.CELLD_BIN || "celld",
      // celld dev 0.6.3 opens a real private local fleet bucket beneath
      // runtime/.celld/dev, including R2 objects; no cloud credentials are used.
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
  }
  await boot();
  // Simulates a deploy for the build-update smoke: the Worker and the viewer
  // assets both move to another build id while the browser tab stays open.
  async function deploy(next) {
    if (!/^[0-9a-f]{12}$/.test(next) || next === buildId) throw new Error("Invalid next build");
    const viewer = path.join(runtime, "public/app.js");
    const source = await readFile(viewer, "utf8");
    if (!source.includes(JSON.stringify(buildId)))
      throw new Error("Viewer bundle does not embed the build id");
    await writeFile(viewer, source.replaceAll(JSON.stringify(buildId), JSON.stringify(next)));
    await build({
      ...workerBuild,
      define: { ...workerBuild.define, __PAGES_BUILD__: JSON.stringify(next) },
    });
    buildId = next;
  }
  // The admission smoke asks the harness to stop and restart the same runtime
  // directory, so persisted Pages, sessions, and bindings survive the restart.
  const restartOnRequest = async (message, child) => {
    if (message?.type !== "restart-celld") return;
    try {
      await stop(host);
      if (message.build) await deploy(message.build);
      // celld dev's local node can release the listener after its parent exits.
      const deadline = Date.now() + 30000;
      while (!(await portFree(port))) {
        if (Date.now() >= deadline)
          throw new Error(`Port ${port} stayed busy after stopping celld`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await boot();
      child.send({ type: "celld-restarted" });
    } catch (error) {
      child.send({ type: "celld-restart-failed", message: error.message });
    }
  };
  await run(
    process.execPath,
    [
      spaces
        ? "scripts/spaces-smoke.mjs"
        : trash
          ? "scripts/trash-smoke.mjs"
          : admission
            ? "scripts/admission-smoke.mjs"
            : taskLists
              ? "scripts/task-lists-smoke.mjs"
              : mcpImages
                ? "scripts/mcp-image-import-smoke.mjs"
                : images
                  ? "scripts/images-smoke.mjs"
                  : domainView
                    ? "scripts/domain-sharing-smoke.mjs"
                    : buildUpdate
                      ? "scripts/build-update-smoke.mjs"
                      : "scripts/sharing-smoke.mjs",
    ],
    {
      env: {
        ...process.env,
        PAGES_ORIGIN: origin,
        PAGES_SCREENSHOTS: output,
        PAGES_E2E_KEY_FILE: keyFile,
        PAGES_CELLD_LOG: path.join(output, "celld.log"),
      },
      ...((admission || buildUpdate) && { stdio: ["inherit", "inherit", "inherit", "ipc"] }),
    },
    admission || buildUpdate ? restartOnRequest : undefined,
  );
  const result = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
  if (!result.cleaned || result.failure)
    throw new Error("Sharing qualification did not complete cleanly");
  console.log(
    `${admission ? "Local admission and reconnect" : buildUpdate ? "Deploy while open" : "Local OIDC, sharing and MCP"} qualification passed. Artifacts: ${output}`,
  );
} finally {
  await Promise.all([...children].map(stop));
  if (log) await new Promise((resolve) => log.end(resolve));
  await rm(scratch, { recursive: true, force: true });
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
