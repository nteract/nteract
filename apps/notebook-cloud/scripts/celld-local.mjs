#!/usr/bin/env node
// Run the current notebook-cloud Workers on a local celld fleet.
//
// celld (https://github.com/denoland/celld) hosts Cloudflare-shaped Workers,
// Durable Objects, D1, and R2 outside Cloudflare. `celld dev` runs one node
// with a persistent local object store, so the hosted notebook experience can
// run on this machine without Wrangler, Miniflare, or a cloud account.
//
// Packaging constraints this script exists to satisfy:
//
// - `celld dev` accepts `wrangler.json`, not `wrangler.toml`, and rejects the
//   `routes`, `dev`, and `observability` keys the Wrangler configs carry.
// - `main` and `assets.directory` must be plain relative paths inside the
//   project directory (no `..`, no absolute paths, no symlinks). Each celld
//   project therefore gets a generated entry shim that re-exports the real
//   Worker module and a copied asset directory.
// - One celld store holds exactly one deployment pointer, so the three Workers
//   (application, output-document shell, renderer sidecar assets) each get
//   their own project directory and their own `celld dev` process. Distinct
//   ports mean distinct browser origins, which preserves the production
//   separation between the authenticated app and untrusted output frames.
// - `celld d1 migrations apply` requires a cloud bucket. The application Worker
//   bootstraps its catalog schema on first use (`ensureCatalogSchema` in
//   src/storage.ts), so no migration step runs here.
//
// Everything generated lives under apps/notebook-cloud/.celld-local/ (ignored
// by git): per-Worker project dirs, celld state (`<project>/.celld/dev`), PID
// files, logs, and the persisted app-session secret.
//
// Usage:
//   node scripts/celld-local.mjs prepare   # regenerate configs + copy assets
//   node scripts/celld-local.mjs start     # prepare, then start detached
//   node scripts/celld-local.mjs stop
//   node scripts/celld-local.mjs restart
//   node scripts/celld-local.mjs status
//   node scripts/celld-local.mjs logs [main|outputs|renderer-assets|workstation]
//   node scripts/celld-local.mjs workstation-start   # `runt workstation run` against this host
//   node scripts/celld-local.mjs workstation-stop
//
// The workstation commands assume `runt workstation connect <origin> --code ...`
// already stored a credential for this worktree (RUNTIMED_DEV=1). They run the
// existing pairing-flow agent; celld hosts rooms, the kernel runs here.
//
// Environment:
//   NOTEBOOK_CLOUD_CELLD_PORT        app Worker port (default 9876)
//   NOTEBOOK_CLOUD_CELLD_BIN         celld executable (default: `celld` on PATH)
//   NOTEBOOK_CLOUD_CELLD_LOGS=1      pass --logs to celld dev (node INFO/WARN)
//   NOTEBOOK_CLOUD_CELLD_CLEAN=1     pass --clean on start (discard local state)
//   NOTEBOOK_CLOUD_RUNT_BIN          runt executable (default target/debug/runt)
//   NOTEBOOK_CLOUD_WORKSTATION_PYTHON  kernel interpreter with ipykernel
//                                    (default .celld-local/kernel-venv/bin/python)

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.join(appDir, ".celld-local");
const stateDir = path.join(rootDir, "state");
const logsDir = path.join(rootDir, "logs");

const HOST = "127.0.0.1";
const basePort = readPort(process.env.NOTEBOOK_CLOUD_CELLD_PORT) ?? 9876;
const celldBin = process.env.NOTEBOOK_CLOUD_CELLD_BIN?.trim() || "celld";
const esbuildBin = path.join(appDir, "node_modules", ".bin", "esbuild");
const workspaceRoot = path.resolve(appDir, "..", "..");
const runtBin = path.resolve(
  workspaceRoot,
  process.env.NOTEBOOK_CLOUD_RUNT_BIN?.trim() || "target/debug/runt",
);
const workstationPython =
  process.env.NOTEBOOK_CLOUD_WORKSTATION_PYTHON?.trim() ||
  path.join(rootDir, "kernel-venv", "bin", "python");

const origins = {
  main: `http://${HOST}:${basePort}`,
  outputs: `http://${HOST}:${basePort + 1}`,
  "renderer-assets": `http://${HOST}:${basePort + 2}`,
};

// Each Worker's celld project. `entry` is re-exported by a generated shim so the
// bundler's `main` stays inside the project; `assets` is copied (not linked).
const WORKERS = [
  {
    name: "main",
    scriptName: "nteract-notebook-cloud-celld-local",
    entry: "src/index.ts",
    entryExports: ["default", "NotebookRoom", "WorkstationEvents", "OwnerComputeIndex"],
    assets: "dist",
    port: basePort,
    healthPath: "/api/health",
    config: (vars) => ({
      durable_objects: {
        bindings: [
          { name: "NOTEBOOK_ROOMS", class_name: "NotebookRoom" },
          { name: "WORKSTATION_EVENTS", class_name: "WorkstationEvents" },
          { name: "OWNER_COMPUTE_INDEX", class_name: "OwnerComputeIndex" },
        ],
      },
      // celld applies the migration list to a fresh store. The Wrangler history
      // (v1..v5, including the deleted MarkdownDocumentRoom) is Cloudflare's
      // record; a new celld store only needs the three live classes.
      migrations: [
        {
          tag: "celld-local-v1",
          new_sqlite_classes: ["NotebookRoom", "WorkstationEvents", "OwnerComputeIndex"],
        },
      ],
      d1_databases: [
        {
          binding: "DB",
          database_name: "nteract-notebook-cloud-celld-local",
          database_id: "nteract-notebook-cloud-celld-local",
          migrations_dir: "migrations",
        },
      ],
      r2_buckets: [
        { binding: "NOTEBOOK_SNAPSHOTS", bucket_name: "nteract-notebook-cloud-celld-local" },
      ],
      assets: { directory: "assets", binding: "ASSETS" },
      vars,
    }),
  },
  {
    name: "outputs",
    scriptName: "nteract-notebook-cloud-celld-local-outputs",
    entry: "src/output-document-worker.ts",
    entryExports: ["default"],
    assets: "dist-output-document",
    port: basePort + 1,
    healthPath: "/frame/",
    config: () => ({
      assets: { directory: "assets", binding: "ASSETS", run_worker_first: true },
    }),
  },
  {
    name: "renderer-assets",
    scriptName: "nteract-notebook-cloud-celld-local-assets",
    entry: "src/renderer-assets-worker.ts",
    entryExports: ["default"],
    assets: "dist/plugins",
    port: basePort + 2,
    healthPath: "/renderer-assets/sift_wasm.wasm",
    healthMethod: "HEAD",
    config: () => ({
      assets: { directory: "assets", binding: "ASSETS", run_worker_first: true },
    }),
  },
];

const command = process.argv[2] ?? "status";
const selection = process.argv[3];

try {
  switch (command) {
    case "prepare":
      await prepare();
      break;
    case "start":
      await prepare();
      await start();
      break;
    case "stop":
      await stop();
      break;
    case "restart":
      await stop();
      await prepare();
      await start();
      break;
    case "status":
      await status();
      break;
    case "logs":
      await logs(selection);
      break;
    case "workstation-start":
      await workstationStart();
      break;
    case "workstation-stop":
      await workstationStop();
      break;
    default:
      throw new Error(
        `unknown command ${command}; use prepare|start|stop|restart|status|logs|workstation-start|workstation-stop`,
      );
  }
} catch (error) {
  console.error(`[celld-local] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function prepare() {
  for (const worker of WORKERS) {
    const assetsSource = path.join(appDir, worker.assets);
    if (!existsSync(assetsSource)) {
      throw new Error(
        `${worker.assets} is missing; run \`pnpm --dir apps/notebook-cloud build\` first`,
      );
    }
  }
  if (!existsSync(esbuildBin)) {
    throw new Error(`esbuild not found at ${esbuildBin}; run pnpm install`);
  }

  await mkdir(stateDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  const sessionSecret = await appSessionSecret();

  for (const worker of WORKERS) {
    const projectDir = path.join(rootDir, worker.name);
    await mkdir(projectDir, { recursive: true });

    // Entry shim: the only file celld's `main` may point at.
    const relativeEntry = path
      .relative(projectDir, path.join(appDir, worker.entry))
      .split(path.sep)
      .join("/");
    const exportsList = worker.entryExports
      .filter((name) => name !== "default")
      .map((name) => `export { ${name} } from "${relativeEntry}";`);
    const shimLines = [
      `// Generated by scripts/celld-local.mjs. celld requires \`main\` inside the project.`,
    ];
    if (worker.name === "main") {
      // celld rejects `await import("*.wasm")` (only static WebAssembly imports
      // are supported), which is how src/runtimed-wasm.ts loads the runtime
      // module on Cloudflare. Import it statically here and seed the module
      // before any room code asks for it.
      const wasmPath = path.join(
        appDir,
        "..",
        "notebook",
        "src",
        "wasm",
        "runtimed-wasm",
        "runtimed_wasm_bg.wasm",
      );
      const relativeWasm = path.relative(projectDir, wasmPath).split(path.sep).join("/");
      const relativeWasmModule = path
        .relative(projectDir, path.join(appDir, "src", "runtimed-wasm.ts"))
        .split(path.sep)
        .join("/");
      shimLines.push(
        `import runtimedWasmModule from "${relativeWasm}";`,
        `import { initializeRuntimedWasm } from "${relativeWasmModule}";`,
        `void initializeRuntimedWasm(runtimedWasmModule);`,
      );
    }
    shimLines.push(`export { default } from "${relativeEntry}";`, ...exportsList, "");
    const shim = shimLines.join("\n");
    await writeFile(path.join(projectDir, "worker.ts"), shim);

    // Assets: fresh copy each prepare so a rebuild is picked up. Dereference so
    // no symlink survives (celld refuses them).
    const assetsDir = path.join(projectDir, "assets");
    await rm(assetsDir, { recursive: true, force: true });
    await cp(path.join(appDir, worker.assets), assetsDir, { recursive: true, dereference: true });

    // Config. `migrations_dir` for D1 must also be inside the project; copy the
    // SQL files so `celld d1 migrations apply` has a valid target if a fleet
    // deployment ever needs it. The local Worker bootstraps its own schema.
    if (worker.name === "main") {
      const migrationsDir = path.join(projectDir, "migrations");
      await rm(migrationsDir, { recursive: true, force: true });
      await cp(path.join(appDir, "migrations"), migrationsDir, { recursive: true });
    }

    const vars = worker.name === "main" ? mainVars(sessionSecret) : undefined;
    const config = {
      name: worker.scriptName,
      main: "worker.ts",
      compatibility_date: "2024-11-06",
      compatibility_flags: ["nodejs_compat"],
      ...worker.config(vars),
    };
    await writeFile(
      path.join(projectDir, "wrangler.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  await writeFile(
    path.join(stateDir, "layout.json"),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        celld: celldVersion(),
        nteract_commit: gitCommit(),
        origins,
        workers: WORKERS.map((worker) => ({
          name: worker.name,
          script_name: worker.scriptName,
          port: worker.port,
          project_dir: path.join(rootDir, worker.name),
          state_dir: path.join(rootDir, worker.name, ".celld", "dev"),
          log: logPath(worker),
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.error(`[celld-local] prepared ${WORKERS.length} celld projects under ${rootDir}`);
}

function mainVars(sessionSecret) {
  const main = origins.main;
  return {
    DEPLOYMENT_ENV: "celld-local",
    NOTEBOOK_CLOUD_BUILD_SHA: gitCommit(),
    NOTEBOOK_CLOUD_ALLOWED_ORIGINS: main,
    // Loopback detection also accepts Host / CF-Connecting-IP. The listener is
    // bound to 127.0.0.1, so the only requests that can carry these headers
    // already arrive over loopback.
    NOTEBOOK_CLOUD_TRUST_LOOPBACK_HEADERS: "true",
    // Dev OIDC issuer mounted by the Worker itself at /dev/oidc. Loopback-only
    // by construction; the verifier fetches JWKS from this same origin.
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    NOTEBOOK_CLOUD_OIDC_ISSUER: `${main}/dev/oidc`,
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "local-oidc-client",
    NOTEBOOK_CLOUD_OIDC_AUDIENCE: "local-oidc-client",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:local",
    NOTEBOOK_CLOUD_OIDC_PROVIDER_LABEL: "Local dev OIDC",
    NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: `${main}/oidc`,
    // Persisted so a restart keeps browser sessions valid. The dev OIDC signing
    // key is still per-boot, so a restart forces one fresh sign-in.
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: sessionSecret,
    RENDERER_ASSETS_BASE_URL: `${origins["renderer-assets"]}/renderer-assets/`,
    OUTPUT_DOCUMENT_BASE_URL: `${origins.outputs}/frame/`,
  };
}

async function start() {
  const running = await runningWorkers();
  for (const worker of WORKERS) {
    if (running.get(worker.name)) {
      console.error(
        `[celld-local] ${worker.name} already running (pid ${running.get(worker.name)})`,
      );
      continue;
    }
    await startWorker(worker);
  }
  await waitHealthy();
  await status();
}

async function startWorker(worker) {
  const projectDir = path.join(rootDir, worker.name);
  const log = await open(logPath(worker), "a");
  const args = [
    "dev",
    path.join(projectDir, "wrangler.json"),
    "--host",
    HOST,
    "--port",
    String(worker.port),
    "--no-watch",
  ];
  if (process.env.NOTEBOOK_CLOUD_CELLD_LOGS === "1") args.push("--logs");
  if (process.env.NOTEBOOK_CLOUD_CELLD_CLEAN === "1") args.push("--clean");

  const child = spawn(celldBin, args, {
    cwd: projectDir,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: {
      ...process.env,
      CELLD_ESBUILD: esbuildBin,
      NO_COLOR: "1",
    },
  });
  child.on("error", (error) => {
    console.error(`[celld-local] failed to start ${worker.name}: ${error.message}`);
  });
  child.unref();
  await log.close();
  await writeFile(pidPath(worker), `${child.pid}\n`);
  console.error(
    `[celld-local] started ${worker.name} pid ${child.pid} on ${origins[worker.name]} (log ${logPath(worker)})`,
  );
}

async function stop() {
  const running = await runningWorkers();
  for (const worker of WORKERS) {
    const pid = running.get(worker.name);
    if (!pid) {
      await rm(pidPath(worker), { force: true });
      await stopOrphanedNode(worker);
      continue;
    }
    // SIGTERM the `celld dev` supervisor; it stops its node child cleanly.
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && isAlive(pid)) {
      await sleep(250);
    }
    if (isAlive(pid)) {
      console.error(`[celld-local] ${worker.name} pid ${pid} did not exit; sending SIGKILL`);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
    await rm(pidPath(worker), { force: true });
    await stopOrphanedNode(worker);
    console.error(`[celld-local] stopped ${worker.name} (pid ${pid})`);
  }
}

// `celld dev` runs the node as a child in its own process group. On Linux the
// kernel kills that child if the supervisor dies; macOS has no equivalent, so a
// SIGKILLed supervisor leaves a node holding the port. Find it by listener.
async function stopOrphanedNode(worker) {
  const pid = listenerPid(worker.port);
  if (!pid) return;
  console.error(
    `[celld-local] stopping orphaned ${worker.name} node pid ${pid} on :${worker.port}`,
  );
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && isAlive(pid)) {
    await sleep(250);
  }
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}

function listenerPid(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  const pid = Number.parseInt(result.stdout.trim().split("\n")[0] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function status() {
  const running = await runningWorkers();
  const rows = [];
  for (const worker of WORKERS) {
    const pid = running.get(worker.name);
    const health = await probe(worker);
    rows.push({
      worker: worker.name,
      pid: pid ?? null,
      origin: origins[worker.name],
      health,
      log: logPath(worker),
    });
  }
  const workstationPid = await readPid(workstationPidPath());
  console.log(
    JSON.stringify(
      {
        celld: celldVersion(),
        nteract_commit: gitCommit(),
        workers: rows,
        workstation_agent: {
          pid: workstationPid ?? null,
          runt: runtBin,
          python: workstationPython,
          log: workstationLogPath(),
        },
      },
      null,
      2,
    ),
  );
}

async function logs(name) {
  const target = name ?? "main";
  const file =
    target === "workstation"
      ? workstationLogPath()
      : logPath(
          WORKERS.find((candidate) => candidate.name === target) ??
            (() => {
              throw new Error(`unknown log target ${target}`);
            })(),
        );
  const text = await readFile(file, "utf8").catch(() => "");
  const lines = text.split("\n");
  process.stdout.write(`${lines.slice(-80).join("\n")}\n`);
}

// Workstation agent: the pairing-flow `runt workstation run`, detached, with
// the same pid/log conventions as the celld processes. It serves attach jobs
// for the workstation registered against this celld origin.

async function workstationStart() {
  const existing = await readPid(workstationPidPath());
  if (existing) {
    console.error(`[celld-local] workstation agent already running (pid ${existing})`);
    return;
  }
  if (!existsSync(runtBin)) {
    throw new Error(`runt not found at ${runtBin}; run \`cargo build -p runt -p runtimed\``);
  }
  if (!existsSync(workstationPython)) {
    throw new Error(
      `kernel interpreter not found at ${workstationPython}; create it with \`uv venv .celld-local/kernel-venv && uv pip install --python .celld-local/kernel-venv/bin/python ipykernel\``,
    );
  }
  await mkdir(stateDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  const log = await open(workstationLogPath(), "a");
  const child = spawn(
    runtBin,
    ["workstation", "run", "--python-path", workstationPython, "--working-directory", rootDir],
    {
      cwd: workspaceRoot,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: {
        ...process.env,
        RUNTIMED_DEV: "1",
        RUST_LOG: process.env.RUST_LOG ?? "info",
        NO_COLOR: "1",
      },
    },
  );
  child.unref();
  await log.close();
  await writeFile(workstationPidPath(), `${child.pid}\n`);
  console.error(
    `[celld-local] started workstation agent pid ${child.pid} (log ${workstationLogPath()})`,
  );
}

async function workstationStop() {
  const pid = await readPid(workstationPidPath());
  if (!pid) {
    await rm(workstationPidPath(), { force: true });
    console.error("[celld-local] workstation agent not running");
    return;
  }
  // The agent spawns one `runtimed cloud-runtime-agent` per attach job in the
  // same process group; signal the group so the kernels stop with it.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone
    }
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && isAlive(pid)) {
    await sleep(250);
  }
  if (isAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  await rm(workstationPidPath(), { force: true });
  console.error(`[celld-local] stopped workstation agent (pid ${pid})`);
}

async function readPid(file) {
  const raw = await readFile(file, "utf8").catch(() => "");
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : undefined;
}

function workstationPidPath() {
  return path.join(stateDir, "workstation.pid");
}

function workstationLogPath() {
  return path.join(logsDir, "workstation.log");
}

async function waitHealthy() {
  const deadline = Date.now() + 120_000;
  const pending = new Set(WORKERS.map((worker) => worker.name));
  while (pending.size > 0 && Date.now() < deadline) {
    for (const worker of WORKERS) {
      if (!pending.has(worker.name)) continue;
      const health = await probe(worker);
      if (health.ok) pending.delete(worker.name);
    }
    if (pending.size > 0) await sleep(1000);
  }
  if (pending.size > 0) {
    throw new Error(`workers not healthy after 120s: ${[...pending].join(", ")}; see ${logsDir}`);
  }
}

async function probe(worker) {
  const url = `${origins[worker.name]}${worker.healthPath}`;
  try {
    const response = await fetch(url, {
      method: worker.healthMethod ?? "GET",
      signal: AbortSignal.timeout(3000),
    });
    return { ok: response.ok, status: response.status, url };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), url };
  }
}

async function runningWorkers() {
  const map = new Map();
  for (const worker of WORKERS) {
    const raw = await readFile(pidPath(worker), "utf8").catch(() => "");
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      map.set(worker.name, pid);
    }
  }
  return map;
}

async function appSessionSecret() {
  const file = path.join(stateDir, "app-session-secret");
  const existing = await readFile(file, "utf8").catch(() => "");
  if (existing.trim()) return existing.trim();
  const secret = randomBytes(32).toString("hex");
  await writeFile(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidPath(worker) {
  return path.join(stateDir, `${worker.name}.pid`);
}

function logPath(worker) {
  return path.join(logsDir, `${worker.name}.log`);
}

function celldVersion() {
  const result = spawnSync(celldBin, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return `unavailable (${celldBin})`;
  // celld writes allocator warnings to stderr and the version to stdout, but
  // the jemalloc banner can still land on stdout; keep only the version line.
  return (
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^celld \d/.test(line)) ?? result.stdout.trim()
  );
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function readPort(value) {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_533) {
    throw new Error("NOTEBOOK_CLOUD_CELLD_PORT must be an integer TCP port below 65534");
  }
  return port;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
