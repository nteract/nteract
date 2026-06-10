import { spawn } from "node:child_process";
import { closeSync, createWriteStream, openSync, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runtimeAgentBinaryFromEnv,
  runtimeAgentBinaryLabel,
} from "./hosted-workstation-agent-core.mjs";
import { notebookCloudBaseUrl, notebookCloudWorkspaceRoot } from "./local-dev.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = notebookCloudWorkspaceRoot({ cwd: appDir });

await loadOptionalEnvFile();

const baseUrl = notebookCloudBaseUrl();
const apiKey = process.env.NTERACT_API_KEY ?? process.env.NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN;
const vanityName = process.env.NOTEBOOK_CLOUD_RUNTIME_PEER_SMOKE_VANITY ?? "lab2-dualpeer";
const source =
  process.env.NOTEBOOK_CLOUD_RUNTIME_PEER_SMOKE_CODE ?? "print('preview runtime peer smoke')";
const seconds = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_RUNTIME_PEER_SMOKE_SECONDS,
  "NOTEBOOK_CLOUD_RUNTIME_PEER_SMOKE_SECONDS",
  35,
);
const readyTimeoutMs = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_RUNTIME_PEER_READY_TIMEOUT_MS,
  "NOTEBOOK_CLOUD_RUNTIME_PEER_READY_TIMEOUT_MS",
  20_000,
);
const keepRuntimePeer = process.env.NOTEBOOK_CLOUD_KEEP_RUNTIME_PEER === "1";
const runId = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
const smokeRoot = path.resolve(
  workspaceRoot,
  ".context",
  "smokes",
  "notebook-cloud-runtime-peer",
  runId,
);
const blobRoot = path.join(smokeRoot, "blobs");
const computeLogPath = path.join(smokeRoot, "runtime-peer.log");
const ownerLogPath = path.join(smokeRoot, "owner-peer.log");
const runtimeAgentBin = runtimeAgentBinaryFromEnv(process.env, workspaceRoot);
// The diagnostic cloud peer is a hidden subcommand on the same runtime-agent
// binary family (the standalone runt-cloud-peer binary was absorbed).
const cloudPeerBin = runtimeAgentBinaryFromEnv(
  {
    ...process.env,
    NOTEBOOK_CLOUD_RUNTIME_AGENT_BIN:
      process.env.NOTEBOOK_CLOUD_CLOUD_PEER_BIN ??
      process.env.NOTEBOOK_CLOUD_RUNT_CLOUD_PEER_BIN ??
      process.env.NOTEBOOK_CLOUD_RUNTIME_AGENT_BIN,
  },
  workspaceRoot,
);

const timingsMs = {};
const startedAt = performance.now();
let runtimePeer;
let runtimeKeptAlive = false;
let tempDir;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  try {
    requireApiKey();
    await assertBinaryExists(
      runtimeAgentBin,
      `${runtimeAgentBinaryLabel(runtimeAgentBin)} cloud-runtime-agent`,
    );
    await assertBinaryExists(cloudPeerBin, `${runtimeAgentBinaryLabel(cloudPeerBin)} cloud-peer`);
    const pythonPath = await resolvePythonPath();
    await mkdir(blobRoot, { recursive: true });
    tempDir = await mkdtemp(path.join(os.tmpdir(), "nteract-runtime-peer-smoke-"));

    const room = await timed("create_room_and_grant_runtime_peer", async () => {
      const created = await createNotebookRoom();
      await grantRuntimePeer(created.notebookId);
      return created;
    });

    runtimePeer = await timed("runtime_peer_ready", () =>
      startRuntimePeer({ notebookId: room.notebookId, pythonPath }),
    );

    const owner = await timed("owner_execute_cell", () =>
      runOwnerPeerWithRuntimeGuard({ notebookId: room.notebookId }),
    );
    const combinedOwnerLog = `${owner.stdout}\n${owner.stderr}`;
    assert(
      /status=queued\b/.test(combinedOwnerLog),
      `owner peer did not observe queued execution; see ${ownerLogPath}`,
    );
    assert(
      /status=done\b/.test(combinedOwnerLog),
      `owner peer did not observe done execution; see ${ownerLogPath}`,
    );
    assert(
      /Sent execute_request|Queued execution/.test(runtimePeer.output()),
      `runtime peer did not log kernel execution; see ${computeLogPath}`,
    );

    if (keepRuntimePeer) {
      runtimeKeptAlive = true;
      detachRuntimePeer(runtimePeer);
    } else {
      await stopRuntimePeer(runtimePeer.child);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl,
          notebookId: room.notebookId,
          vanityName,
          viewerUrl: viewerUrl(room.notebookId, vanityName),
          source,
          checks: [
            "preview_api_key_room_created",
            "runtime_peer_acl_granted",
            "runtime_peer_current_python_ready",
            "owner_execute_cell_request_sent",
            "runtime_state_observed_queued",
            "runtime_state_observed_done",
            "kernel_execute_request_logged",
          ],
          timings_ms: {
            ...timingsMs,
            total: elapsedMs(startedAt),
          },
          runtimePeer: {
            pid: runtimeKeptAlive ? runtimePeer.child.pid : null,
            keptAlive: runtimeKeptAlive,
            logPath: computeLogPath,
          },
          ownerPeer: {
            logPath: ownerLogPath,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    if (!runtimeKeptAlive && runtimePeer?.child) {
      await stopRuntimePeer(runtimePeer.child).catch(() => {});
    }
    await cleanupTemp();
  }
}

async function loadOptionalEnvFile() {
  const envFile =
    process.env.PREVIEW_RUNT_ENV ??
    process.env.NOTEBOOK_CLOUD_ENV_FILE ??
    path.join(os.homedir(), "preview.runt.run", ".env");
  try {
    const raw = await readFile(envFile, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, "").trim();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function requireApiKey() {
  if (!apiKey) {
    throw new Error(
      "NTERACT_API_KEY or NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN is required for hosted runtime-peer smoke",
    );
  }
}

async function assertBinaryExists(binaryPath, name) {
  if (!isPathLike(binaryPath)) {
    if (await which(binaryPath)) return;
    throw new Error(`Missing ${name} command ${binaryPath} on PATH.`);
  }
  try {
    await access(binaryPath);
  } catch {
    throw new Error(
      `Missing ${name} at ${binaryPath}. Run \`cargo xtask artifacts ensure sift,renderer && cargo build --release -p runtimed\` first, or set NOTEBOOK_CLOUD_RUNTIME_AGENT_BIN.`,
    );
  }
}

function isPathLike(value) {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

async function resolvePythonPath() {
  const explicit = process.env.NOTEBOOK_CLOUD_RUNTIME_PEER_PYTHON ?? process.env.PYTHON_PATH;
  if (explicit) {
    await assertPythonCanLaunchKernel(explicit);
    return explicit;
  }
  const candidates = [
    path.join(os.homedir(), "k", "bin", "python"),
    await which("python3"),
    await which("python"),
  ].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    if (await pythonCanLaunchKernel(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "No Python with ipykernel was found. Set NOTEBOOK_CLOUD_RUNTIME_PEER_PYTHON to a kernel-capable interpreter.",
  );
}

function which(command) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${quoteShell(command)}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (code) => {
      resolve(code === 0 ? stdout.trim() : null);
    });
    child.on("error", () => resolve(null));
  });
}

async function assertPythonCanLaunchKernel(pythonPath) {
  if (await pythonCanLaunchKernel(pythonPath)) return;
  throw new Error(
    `${pythonPath} cannot import ipykernel. Set NOTEBOOK_CLOUD_RUNTIME_PEER_PYTHON to a kernel-capable interpreter.`,
  );
}

async function pythonCanLaunchKernel(pythonPath) {
  try {
    await access(pythonPath);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const child = spawn(
      pythonPath,
      [
        "-c",
        "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('ipykernel') else 1)",
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(false);
    }, 5_000);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

async function createNotebookRoom() {
  const response = await fetch(new URL("/api/n", baseUrl), {
    method: "POST",
    headers: {
      ...apiKeyHeaders("owner"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ vanity_name: vanityName }),
  });
  const body = await response.json().catch(async () => ({ error: await response.text() }));
  assertResponse(response, body, "create notebook room", 201);
  const notebookId = body.notebook_id;
  assert(
    typeof notebookId === "string" && notebookId.length > 0,
    "room create missing notebook_id",
  );
  return { notebookId };
}

async function grantRuntimePeer(notebookId) {
  const acl = await fetchJson(`/api/n/${encodeURIComponent(notebookId)}/acl`);
  const owner = acl.acl?.find(
    (entry) => entry.scope === "owner" && entry.subject_kind === "principal",
  );
  assert(owner?.subject, "room ACL did not include owner principal to grant runtime_peer");

  const response = await fetch(new URL(`/api/n/${encodeURIComponent(notebookId)}/acl`, baseUrl), {
    method: "POST",
    headers: {
      ...apiKeyHeaders("owner"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject_kind: "principal",
      subject: owner.subject,
      scope: "runtime_peer",
    }),
  });
  const body = await response.json().catch(async () => ({ error: await response.text() }));
  assertResponse(response, body, "grant runtime_peer", 201);
}

async function fetchJson(pathname) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: apiKeyHeaders("owner"),
  });
  const body = await response.json().catch(async () => ({ error: await response.text() }));
  assertResponse(response, body, `GET ${pathname}`, 200);
  return body;
}

function apiKeyHeaders(scope) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
    "X-Scope": scope,
  };
}

function startRuntimePeer({ notebookId, pythonPath }) {
  return new Promise((resolve, reject) => {
    const logFd = openSync(computeLogPath, "a");
    let settled = false;
    let exitRecord = null;
    let resolveExited;
    const exited = new Promise((resolveExit) => {
      resolveExited = resolveExit;
    });
    const recordExit = (exit) => {
      if (exitRecord) return;
      exitRecord = exit;
      resolveExited(exit);
    };
    let child;
    try {
      child = spawn(
        runtimeAgentBin,
        [
          "cloud-runtime-agent",
          "--auth-kind",
          "anaconda-key",
          "--cloud-url",
          baseUrl,
          "--notebook-id",
          notebookId,
          "--scope",
          "runtime_peer",
          "--python-path",
          pythonPath,
          "--blob-root",
          blobRoot,
        ],
        {
          cwd: workspaceRoot,
          detached: keepRuntimePeer,
          env: {
            ...process.env,
            RUNT_CLOUD_TOKEN: apiKey,
            RUST_LOG: process.env.RUST_LOG ?? "info",
          },
          stdio: ["ignore", logFd, logFd],
        },
      );
    } catch (error) {
      closeSync(logFd);
      reject(error);
      return;
    }
    closeSync(logFd);

    const poll = setInterval(async () => {
      if (settled) return;
      const output = await readFile(computeLogPath, "utf8").catch(() => "");
      if (!output.includes("Infrastructure ready, entering main loop")) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      resolve({
        child,
        exited,
        exitRecord: () => exitRecord,
        output: () => readFileSync(computeLogPath, "utf8"),
      });
    }, 250);

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      child.kill("SIGTERM");
      reject(
        new Error(
          `runtime peer did not become ready within ${readyTimeoutMs}ms; see ${computeLogPath}`,
        ),
      );
    }, readyTimeoutMs);
    child.on("error", (error) => {
      recordExit({ error });
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      recordExit({ code, signal });
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      reject(
        new Error(
          `runtime peer exited before ready (code=${code}, signal=${signal}); see ${computeLogPath}`,
        ),
      );
    });
  });
}

function detachRuntimePeer(peer) {
  peer.child.unref();
}

async function runOwnerPeerWithRuntimeGuard({ notebookId }) {
  const existingExit = runtimePeer.exitRecord();
  if (existingExit) {
    throw new Error(runtimePeerExitMessage(existingExit));
  }
  const ownerResult = runOwnerPeer({ notebookId })
    .then((owner) => ({ type: "owner", owner }))
    .catch((error) => ({ type: "owner_error", error }));
  const runtimeExit = runtimePeer.exited.then((exit) => ({ type: "runtime_exit", exit }));
  const result = await Promise.race([ownerResult, runtimeExit]);
  if (result.type === "runtime_exit") {
    throw new Error(runtimePeerExitMessage(result.exit));
  }
  if (result.type === "owner_error") {
    throw result.error;
  }
  const exit = runtimePeer.exitRecord();
  if (exit) {
    throw new Error(runtimePeerExitMessage(exit));
  }
  return result.owner;
}

function runtimePeerExitMessage(exit) {
  if (exit.error) {
    return `runtime peer exited during owner execution: ${exit.error.message}; see ${computeLogPath}`;
  }
  return `runtime peer exited during owner execution (code=${exit.code}, signal=${exit.signal}); see ${computeLogPath}`;
}

async function runOwnerPeer({ notebookId }) {
  return runCommand(
    cloudPeerBin,
    [
      "cloud-peer",
      "--auth-kind",
      "anaconda-key",
      "--cloud-url",
      baseUrl,
      "--notebook-id",
      notebookId,
      "--scope",
      "owner",
      "--add-cell",
      source,
      "--run-cell",
      "--seconds",
      String(seconds),
    ],
    {
      cwd: workspaceRoot,
      logPath: ownerLogPath,
      completeWhen: /status=done\b/,
      timeoutMs: seconds * 1000 + 20_000,
      env: {
        ...process.env,
        // `cloud-peer` reads the credential from the environment, never argv,
        // so it cannot leak into the process command line.
        RUNT_CLOUD_TOKEN: apiKey,
        RUST_LOG: process.env.RUST_LOG ?? "info",
      },
    },
  );
}

function runCommand(command, args, { completeWhen, cwd, env, logPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logPath, { flags: "a" });
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let completedEarly = false;
    let settled = false;
    let timeout;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      log.end();
      callback();
    };
    const maybeCompleteEarly = () => {
      if (!completeWhen || completedEarly) return;
      if (!completeWhen.test(`${stdout}\n${stderr}`)) return;
      completedEarly = true;
      child.kill("SIGTERM");
    };
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() =>
        reject(
          new Error(`${path.basename(command)} timed out after ${timeoutMs}ms; see ${logPath}`),
        ),
      );
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk;
      log.write(chunk);
      maybeCompleteEarly();
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      stderr += chunk;
      log.write(chunk);
      maybeCompleteEarly();
    });
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0 || completedEarly) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(`${path.basename(command)} exited with ${code}; see ${logPath}`));
      });
    });
  });
}

async function stopRuntimePeer(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function cleanupTemp() {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function timed(name, fn) {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    timingsMs[name] = elapsedMs(started);
  }
}

function assertResponse(response, body, label, expectedStatus) {
  assert(
    response.status === expectedStatus,
    `${label} failed: HTTP ${response.status} ${JSON.stringify(body).slice(0, 500)}`,
  );
}

function viewerUrl(notebookId, name) {
  return new URL(`/n/${encodeURIComponent(notebookId)}/${encodeURIComponent(name)}`, baseUrl).href;
}

function parsePositiveInteger(value, name, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function elapsedMs(started) {
  return Math.max(0, Math.round((performance.now() - started) * 100) / 100);
}

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
