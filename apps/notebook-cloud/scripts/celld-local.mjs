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
//   node scripts/celld-local.mjs export <dir>  # self-contained celld projects for a fleet
//
// `export` writes one deployable project per Worker: a pre-bundled `index.js`
// (esbuild, ESM, `node:*` left external for nodejs_compat), the runtime WASM
// as a sibling module, copied assets, migrations, and `wrangler.json`. A node
// deploys it with `celld deploy <dir>/<worker> --bucket s3://...` needing only
// the celld and esbuild binaries; nothing from this checkout.
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
//   NOTEBOOK_CLOUD_ESBUILD           esbuild executable for celld's bundler
//   NOTEBOOK_CLOUD_CELLD_PUBLIC_ORIGINS  "https://app,https://outputs,https://assets"
//                                    for `export` behind a TLS ingress; requires
//                                    NOTEBOOK_CLOUD_CELLD_OIDC_{ISSUER,CLIENT_ID,
//                                    AUDIENCE,PRINCIPAL_NAMESPACE[,PROVIDER_LABEL]}
//                                    (default: the esbuild devDependency's bin)
//   NOTEBOOK_CLOUD_RUNT_BIN          runt executable (default target/debug/runt)
//   NOTEBOOK_CLOUD_WORKSTATION_PYTHON  kernel interpreter with ipykernel
//                                    (default .celld-local/kernel-venv/bin/python)

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
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
const esbuildBin = resolveEsbuild();
const workspaceRoot = path.resolve(appDir, "..", "..");
const runtBin = path.resolve(
  workspaceRoot,
  process.env.NOTEBOOK_CLOUD_RUNT_BIN?.trim() || "target/debug/runt",
);
const workstationPython =
  process.env.NOTEBOOK_CLOUD_WORKSTATION_PYTHON?.trim() ||
  path.join(rootDir, "kernel-venv", "bin", "python");

// Browser-facing origins. The defaults are the loopback listeners, which is
// what `celld dev` serves and what an SSH port-forward to a remote node
// reproduces. `export` for a public deployment sets
// NOTEBOOK_CLOUD_CELLD_PUBLIC_ORIGINS=<app>,<outputs>,<renderer-assets> (three
// distinct https origins behind the operator's TLS ingress); the node
// listeners stay on loopback either way.
const publicOrigins = readPublicOrigins(process.env.NOTEBOOK_CLOUD_CELLD_PUBLIC_ORIGINS);
const origins = publicOrigins ?? {
  main: `http://${HOST}:${basePort}`,
  outputs: `http://${HOST}:${basePort + 1}`,
  "renderer-assets": `http://${HOST}:${basePort + 2}`,
};

// Identity provider for a public deployment. Loopback deployments use the
// Worker's own dev issuer; a public origin cannot (it is loopback-gated), so
// these must all be set together with the public origins. Values match the
// wrangler.toml var names without the NOTEBOOK_CLOUD_ prefix.
const publicOidc = publicOrigins
  ? {
      issuer: requireEnv("NOTEBOOK_CLOUD_CELLD_OIDC_ISSUER"),
      clientId: requireEnv("NOTEBOOK_CLOUD_CELLD_OIDC_CLIENT_ID"),
      audience: requireEnv("NOTEBOOK_CLOUD_CELLD_OIDC_AUDIENCE"),
      principalNamespace: requireEnv("NOTEBOOK_CLOUD_CELLD_OIDC_PRINCIPAL_NAMESPACE"),
      providerLabel: process.env.NOTEBOOK_CLOUD_CELLD_OIDC_PROVIDER_LABEL?.trim() || "Sign in",
    }
  : undefined;

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
    case "export":
      await exportProjects(selection);
      break;
    case "workstation-start":
      await workstationStart();
      break;
    case "workstation-stop":
      await workstationStop();
      break;
    default:
      throw new Error(
        `unknown command ${command}; use prepare|start|stop|restart|status|logs|export|workstation-start|workstation-stop`,
      );
  }
} catch (error) {
  console.error(`[celld-local] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function prepare() {
  assertBuildOutputs();
  if (!esbuildBin) {
    throw new Error(
      "esbuild not found; run `pnpm install` (declared in apps/notebook-cloud devDependencies) or set NOTEBOOK_CLOUD_ESBUILD",
    );
  }

  await mkdir(stateDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  const sessionSecret = await appSessionSecret();

  for (const worker of WORKERS) {
    const projectDir = path.join(rootDir, worker.name);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "worker.ts"), entryShim(worker, projectDir));
    await copyProjectFiles(worker, projectDir);
    await writeWorkerConfig(worker, projectDir, "worker.ts", sessionSecret);
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

// Self-contained projects for a real fleet. Each Worker is bundled here with
// esbuild so the output has no reference to this checkout: `index.js` plus the
// runtime WASM as a sibling module (celld's own esbuild pass turns the static
// import into a Wasm module, which `no_bundle` would not), assets, migrations,
// and `wrangler.json`. The vars are the same loopback origins `prepare` uses;
// reach a remote node through SSH port-forwards of the same ports, or edit the
// exported `wrangler.json` for a public origin.
async function exportProjects(outDir) {
  if (!outDir) throw new Error("export needs an output directory");
  assertBuildOutputs();
  const esbuild = await import("esbuild");
  const exportRoot = path.resolve(outDir);
  const buildRoot = path.join(rootDir, "export-build");
  await mkdir(stateDir, { recursive: true });
  const sessionSecret = await appSessionSecret();

  for (const worker of WORKERS) {
    const stageDir = path.join(exportRoot, worker.name);
    await rm(stageDir, { recursive: true, force: true });
    await mkdir(stageDir, { recursive: true });

    // The shim lives at the same depth as the prepare() projects so its
    // relative imports resolve identically.
    const buildDir = path.join(buildRoot, worker.name);
    await mkdir(buildDir, { recursive: true });
    const shimPath = path.join(buildDir, "worker.ts");
    await writeFile(shimPath, entryShim(worker, buildDir));

    const result = await esbuild.build({
      entryPoints: [shimPath],
      outfile: path.join(stageDir, "index.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["workerd", "browser", "module", "main"],
      external: ["node:*", "cloudflare:*"],
      legalComments: "none",
      logLevel: "warning",
      metafile: true,
      plugins: [wasmSiblingPlugin(stageDir)],
    });
    const bundledBytes = Object.values(result.metafile.outputs)
      .map((output) => output.bytes)
      .reduce((total, bytes) => total + bytes, 0);

    await copyProjectFiles(worker, stageDir);
    await writeWorkerConfig(worker, stageDir, "index.js", sessionSecret);
    console.error(
      `[celld-local] exported ${worker.name} -> ${stageDir} (${(bundledBytes / 1024).toFixed(0)} KiB bundled)`,
    );
  }

  await writeFile(
    path.join(exportRoot, "export.json"),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        nteract_commit: gitCommit(),
        celld_target: "v0.4.1",
        origins,
        workers: WORKERS.map((worker) => ({
          name: worker.name,
          script_name: worker.scriptName,
          port: worker.port,
          health: `${origins[worker.name]}${worker.healthPath}`,
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.error(`[celld-local] export complete: ${exportRoot}`);
}

// Rewrites `import x from "<anywhere>/foo.wasm"` to a sibling `./foo.wasm` and
// copies the file next to the bundle, so the exported project carries the
// module and celld's bundler sees a static WebAssembly import it can register.
function wasmSiblingPlugin(stageDir) {
  return {
    name: "wasm-sibling",
    setup(build) {
      build.onResolve({ filter: /\.wasm$/ }, async (args) => {
        const resolved = path.resolve(args.resolveDir, args.path);
        const sibling = path.basename(resolved);
        await cp(resolved, path.join(stageDir, sibling));
        return { path: `./${sibling}`, external: true };
      });
    },
  };
}

function assertBuildOutputs() {
  for (const worker of WORKERS) {
    const assetsSource = path.join(appDir, worker.assets);
    if (!existsSync(assetsSource)) {
      throw new Error(
        `${worker.assets} is missing; run \`pnpm --dir apps/notebook-cloud build\` first`,
      );
    }
  }
}

// Entry shim: the only file celld's `main` may point at when bundling from
// source, and the esbuild entry for `export`.
function entryShim(worker, projectDir) {
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
  return shimLines.join("\n");
}

// Assets: fresh copy each time so a rebuild is picked up. Dereference so no
// symlink survives (celld refuses them). `migrations_dir` for D1 must also be
// inside the project; the local Worker bootstraps its own schema, the SQL is
// there for `celld d1 migrations apply` on a fleet.
async function copyProjectFiles(worker, projectDir) {
  const assetsDir = path.join(projectDir, "assets");
  await rm(assetsDir, { recursive: true, force: true });
  await cp(path.join(appDir, worker.assets), assetsDir, { recursive: true, dereference: true });
  if (worker.name === "main") {
    const migrationsDir = path.join(projectDir, "migrations");
    await rm(migrationsDir, { recursive: true, force: true });
    await cp(path.join(appDir, "migrations"), migrationsDir, { recursive: true });
  }
}

async function writeWorkerConfig(worker, projectDir, main, sessionSecret) {
  const vars = worker.name === "main" ? mainVars(sessionSecret) : undefined;
  const config = {
    name: worker.scriptName,
    main,
    compatibility_date: "2024-11-06",
    compatibility_flags: ["nodejs_compat"],
    ...worker.config(vars),
  };
  await writeFile(path.join(projectDir, "wrangler.json"), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

function mainVars(sessionSecret) {
  const main = origins.main;
  if (publicOidc) {
    return {
      DEPLOYMENT_ENV: "celld",
      NOTEBOOK_CLOUD_BUILD_SHA: gitCommit(),
      // The TLS terminator in front of celld delivers plain HTTP, so
      // request.url carries the hop's scheme and host. Absolute URLs the
      // Worker hands out (viewer links, runtime peer cloud_url) come from here.
      NOTEBOOK_CLOUD_PUBLIC_ORIGIN: main,
      NOTEBOOK_CLOUD_ALLOWED_ORIGINS: main,
      NOTEBOOK_CLOUD_OIDC_ISSUER: publicOidc.issuer,
      NOTEBOOK_CLOUD_OIDC_CLIENT_ID: publicOidc.clientId,
      NOTEBOOK_CLOUD_OIDC_AUDIENCE: publicOidc.audience,
      NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: publicOidc.principalNamespace,
      NOTEBOOK_CLOUD_OIDC_PROVIDER_LABEL: publicOidc.providerLabel,
      NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: `${main}/oidc`,
      NOTEBOOK_CLOUD_APP_SESSION_SECRET: sessionSecret,
      RENDERER_ASSETS_BASE_URL: `${origins["renderer-assets"]}/renderer-assets/`,
      OUTPUT_DOCUMENT_BASE_URL: `${origins.outputs}/frame/`,
    };
  }
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
    if (isAlive(pid) && isOurSupervisor(pid, worker)) {
      console.error(`[celld-local] ${worker.name} pid ${pid} did not exit; sending SIGKILL`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    await rm(pidPath(worker), { force: true });
    await stopOrphanedNode(worker);
    console.error(`[celld-local] stopped ${worker.name} (pid ${pid})`);
  }
}

// `celld dev` runs the node as a child in its own process group. On Linux the
// kernel kills that child if the supervisor dies; macOS has no equivalent, so a
// SIGKILLed supervisor leaves a node holding the port. Find it by listener, but
// only signal it once it is proven to be this project's node: the port alone
// says nothing about who owns the process.
async function stopOrphanedNode(worker) {
  const pid = listenerPid(worker.port);
  if (!pid) return;
  if (!isOurNode(pid, worker)) {
    console.error(
      `[celld-local] :${worker.port} is held by pid ${pid}, which is not this project's celld node; leaving it alone`,
    );
    return;
  }
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
  if (isAlive(pid) && isOurNode(pid, worker)) {
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

// Process identity. PIDs get reused and ports get shared with unrelated
// software, so every signal is preceded by a check that the process is the one
// this script started (or the node a supervisor it started spawned).

function processCommand(pid) {
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const command = result.stdout.trim();
  return command.length > 0 ? command : undefined;
}

// Environment of a same-user process (`ps -E`), as `KEY=value` strings.
// Empty when the platform or permissions do not expose it.
function processEnvironment(pid) {
  const result = spawnSync("ps", ["-Eo", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .trim()
    .split(/\s+/)
    .filter((token) => token.includes("="));
}

function processCwd(pid) {
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith("n"));
  return line ? line.slice(1) : undefined;
}

// The `celld dev` supervisor this script launched: argv carries the absolute
// path of this project's generated config.
function isOurSupervisor(pid, worker) {
  const command = processCommand(pid);
  if (!command) return false;
  const configPath = path.join(rootDir, worker.name, "wrangler.json");
  return /\bcelld\b/.test(command) && /\bdev\b/.test(command) && command.includes(configPath);
}

// The node a supervisor spawned: `celld --no-control-plane --bucket celld-dev
// --listen 127.0.0.1:<port> ...`, launched from this project directory with
// `CELLD_INTERNAL_DEV_STORE` pointing at this project's `.celld/dev` store.
// Either the env var or the cwd proves ownership; both are checked because a
// hardened `ps` may hide the environment.
function isOurNode(pid, worker) {
  const command = processCommand(pid);
  if (!command) return false;
  if (!/\bcelld\b/.test(command) || !command.includes(`--listen ${HOST}:${worker.port}`)) {
    return false;
  }
  const projectDir = path.join(rootDir, worker.name);
  const store = path.join(projectDir, ".celld", "dev", "objects.sqlite3");
  if (processEnvironment(pid).includes(`CELLD_INTERNAL_DEV_STORE=${store}`)) return true;
  return processCwd(pid) === projectDir;
}

// The `runt workstation run` this script launched: argv carries this
// project's working directory.
function isOurWorkstationAgent(pid) {
  const command = processCommand(pid);
  if (!command) return false;
  return (
    /\bworkstation\b/.test(command) &&
    /\brun\b/.test(command) &&
    command.includes(`--working-directory ${rootDir}`)
  );
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
  const workstationPid = await readPid(workstationPidPath(), isOurWorkstationAgent);
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
  const existing = await readPid(workstationPidPath(), isOurWorkstationAgent);
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
  const pid = await readPid(workstationPidPath(), isOurWorkstationAgent);
  if (!pid) {
    await rm(workstationPidPath(), { force: true });
    console.error("[celld-local] workstation agent not running");
    return;
  }
  // The agent was spawned detached, so it leads its own process group, which
  // also holds the `runtimed cloud-runtime-agent` children (one per attach job)
  // and their kernels. `readPid` already confirmed the identity of the leader.
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
  if (isAlive(pid) && isOurWorkstationAgent(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  await rm(workstationPidPath(), { force: true });
  console.error(`[celld-local] stopped workstation agent (pid ${pid})`);
}

// A stored PID counts only if a live process with that PID still matches the
// identity we recorded it under; a reused PID is reported as "not running".
async function readPid(file, isOurs) {
  const raw = await readFile(file, "utf8").catch(() => "");
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return undefined;
  if (!isOurs(pid)) {
    console.error(
      `[celld-local] ignoring stale pid file ${file}: pid ${pid} is a different process now`,
    );
    return undefined;
  }
  return pid;
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
    const pid = await readPid(pidPath(worker), (candidate) => isOurSupervisor(candidate, worker));
    if (pid) map.set(worker.name, pid);
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

// celld bundles Worker sources with esbuild and needs an executable path.
// `esbuild` is a declared devDependency of this package; resolve its bin
// through node's resolver so the location does not depend on pnpm's shim layout.
function resolveEsbuild() {
  const override = process.env.NOTEBOOK_CLOUD_ESBUILD?.trim();
  if (override) return override;
  try {
    const require = createRequire(path.join(appDir, "package.json"));
    const packageJson = require.resolve("esbuild/package.json");
    return path.join(path.dirname(packageJson), "bin", "esbuild");
  } catch {
    // fall through
  }
  const shim = path.join(appDir, "node_modules", ".bin", "esbuild");
  return existsSync(shim) ? shim : undefined;
}

function readPublicOrigins(value) {
  if (!value?.trim()) return undefined;
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 3) {
    throw new Error(
      "NOTEBOOK_CLOUD_CELLD_PUBLIC_ORIGINS must list three origins: app,outputs,renderer-assets",
    );
  }
  const parsed = parts.map((part) => {
    const url = new URL(part);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`public origin must be a bare https origin: ${part}`);
    }
    return url.origin;
  });
  if (new Set(parsed).size !== 3) {
    throw new Error(
      "public origins must be three distinct origins (untrusted output frames need their own)",
    );
  }
  return { main: parsed[0], outputs: parsed[1], "renderer-assets": parsed[2] };
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required when NOTEBOOK_CLOUD_CELLD_PUBLIC_ORIGINS is set`);
  return value;
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
