import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAttachJobSpawnPlan,
  buildRuntimeAgentEnv,
  buildWorkstationAuthHeaders,
  buildWorkstationRegistrationPayload,
  DEFAULT_WORKSTATION_AUTH_KIND,
  normalizeWorkstationAuthKind,
  parsePositiveInteger,
  stableWorkstationId,
} from "./hosted-workstation-agent-core.mjs";
import { notebookCloudBaseUrl, notebookCloudWorkspaceRoot } from "./local-dev.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = notebookCloudWorkspaceRoot({ cwd: appDir });

await loadOptionalEnvFile();

const baseUrl = notebookCloudBaseUrl();
const cloudCredential =
  process.env.NTERACT_API_KEY ?? process.env.NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN;
const authKind = normalizeWorkstationAuthKind(
  process.env.NOTEBOOK_CLOUD_WORKSTATION_AUTH_KIND ??
    process.env.NTERACT_CLOUD_AUTH_KIND ??
    DEFAULT_WORKSTATION_AUTH_KIND,
);
const workstationId =
  process.env.NOTEBOOK_CLOUD_WORKSTATION_ID ?? stableWorkstationId(os.hostname());
const displayName =
  process.env.NOTEBOOK_CLOUD_WORKSTATION_DISPLAY_NAME ?? `${os.hostname()} workstation`;
const workingDirectory = path.resolve(process.env.NOTEBOOK_CLOUD_WORKSTATION_CWD ?? process.cwd());
const pollIntervalMs = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_WORKSTATION_POLL_MS,
  "NOTEBOOK_CLOUD_WORKSTATION_POLL_MS",
  2_000,
);
const heartbeatIntervalMs = parsePositiveInteger(
  process.env.NOTEBOOK_CLOUD_WORKSTATION_HEARTBEAT_MS,
  "NOTEBOOK_CLOUD_WORKSTATION_HEARTBEAT_MS",
  20_000,
);
const runtimedBin = path.resolve(
  workspaceRoot,
  process.env.NOTEBOOK_CLOUD_RUNTIMED_BIN ?? "target/release/runtimed",
);
const agentRoot = path.resolve(
  workspaceRoot,
  process.env.NOTEBOOK_CLOUD_WORKSTATION_AGENT_ROOT ??
    path.join(".context", "smokes", "hosted-workstation-agent"),
);

const activeJobs = new Map();
let lastHeartbeatAt = 0;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  requireCloudCredential();
  await assertBinaryExists(runtimedBin, "runtimed");
  const pythonPath = await resolvePythonPath();
  await mkdir(agentRoot, { recursive: true });

  console.log(
    JSON.stringify({
      event: "workstation_agent_starting",
      baseUrl,
      workstationId,
      displayName,
      workingDirectory,
      pythonPath,
      authKind,
      pollIntervalMs,
    }),
  );

  while (true) {
    await heartbeatIfNeeded(pythonPath);
    await pollAttachJobs(pythonPath);
    await sleep(pollIntervalMs);
  }
}

async function heartbeatIfNeeded(pythonPath) {
  const now = Date.now();
  if (now - lastHeartbeatAt < heartbeatIntervalMs) {
    return;
  }
  await registerWorkstation(pythonPath);
  lastHeartbeatAt = now;
}

async function registerWorkstation(pythonPath) {
  const response = await fetch(new URL("/api/workstations", baseUrl), {
    method: "POST",
    headers: {
      ...cloudAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      buildWorkstationRegistrationPayload({
        workstationId,
        displayName,
        workingDirectory,
        pythonPath,
      }),
    ),
  });
  const body = await responseJson(response);
  assertResponse(response, body, "register workstation", [200, 201]);
}

async function pollAttachJobs(pythonPath) {
  const response = await fetch(
    new URL(`/api/workstations/${encodeURIComponent(workstationId)}/attach-jobs`, baseUrl),
    {
      headers: cloudAuthHeaders(),
    },
  );
  const body = await responseJson(response);
  assertResponse(response, body, "poll attach jobs", [200]);
  for (const job of normalizeJobs(body)) {
    if (activeJobs.has(job.job_id)) continue;
    await startAttachJob(job, pythonPath);
  }
}

async function startAttachJob(job, pythonPath) {
  const plan = buildAttachJobSpawnPlan({
    job,
    pythonPath,
    agentRoot,
    baseUrl,
    workingDirectory,
    workstationId,
    displayName,
    authKind,
  });
  await mkdir(plan.blobRoot, { recursive: true });
  await patchAttachJob(job.job_id, {
    status: "accepted",
  });

  const logFd = openSync(plan.logPath, "a");
  const child = spawn(runtimedBin, plan.args, {
    cwd: plan.cwd,
    env: runtimeAgentEnv(),
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);

  const active = { child, logPath: plan.logPath, ready: false };
  activeJobs.set(job.job_id, active);
  console.log(
    JSON.stringify({
      event: "attach_job_spawned",
      jobId: job.job_id,
      notebookId: job.notebook_id,
      pid: child.pid,
      logPath: plan.logPath,
    }),
  );

  watchRuntimePeer(job.job_id, active).catch((error) => {
    console.error(
      JSON.stringify({
        event: "attach_job_watch_failed",
        jobId: job.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}

async function watchRuntimePeer(jobId, active) {
  const readyPoll = setInterval(async () => {
    if (active.ready) return;
    const output = await readFile(active.logPath, "utf8").catch(() => "");
    if (!output.includes("Infrastructure ready, entering main loop")) return;
    active.ready = true;
    await patchAttachJob(jobId, {
      status: "running",
    });
  }, 250);

  active.child.on("exit", async (code, signal) => {
    clearInterval(readyPoll);
    activeJobs.delete(jobId);
    await patchAttachJob(jobId, {
      status: code === 0 ? "completed" : "failed",
      error_message:
        code === 0 ? null : `Runtime peer exited with code=${code}, signal=${signal ?? ""}`,
    }).catch((error) => {
      console.error(
        JSON.stringify({
          event: "attach_job_exit_patch_failed",
          jobId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });

  active.child.on("error", async (error) => {
    clearInterval(readyPoll);
    activeJobs.delete(jobId);
    await patchAttachJob(jobId, {
      status: "failed",
      error_message: error.message,
    });
  });
}

async function patchAttachJob(jobId, patch) {
  const response = await fetch(
    new URL(
      `/api/workstations/${encodeURIComponent(workstationId)}/attach-jobs/${encodeURIComponent(jobId)}`,
      baseUrl,
    ),
    {
      method: "PATCH",
      headers: {
        ...cloudAuthHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    },
  );
  const body = await responseJson(response);
  assertResponse(response, body, `patch attach job ${jobId}`, [200, 204]);
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

function requireCloudCredential() {
  if (!cloudCredential) {
    throw new Error(
      "NTERACT_API_KEY or NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN is required for hosted workstation agent",
    );
  }
}

function cloudAuthHeaders() {
  return buildWorkstationAuthHeaders(authKind, cloudCredential);
}

function runtimeAgentEnv() {
  return buildRuntimeAgentEnv(process.env, cloudCredential);
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
      { stdio: ["ignore", "ignore", "ignore"] },
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

async function assertBinaryExists(binaryPath, name) {
  try {
    await access(binaryPath);
  } catch {
    throw new Error(
      `Missing ${name} binary at ${binaryPath}. Run \`cargo build --release -p runtimed\` first, or set NOTEBOOK_CLOUD_${name.toUpperCase().replaceAll("-", "_")}_BIN.`,
    );
  }
}

async function responseJson(response) {
  if (response.status === 204) return {};
  return response.json().catch(async () => ({ error: await response.text() }));
}

function assertResponse(response, body, label, expectedStatuses) {
  if (expectedStatuses.includes(response.status)) return;
  throw new Error(`${label} failed: HTTP ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
}

function normalizeJobs(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.jobs)) return body.jobs;
  if (Array.isArray(body?.attach_jobs)) return body.attach_jobs;
  return [];
}

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
