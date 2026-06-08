import os from "node:os";
import path from "node:path";

export function buildWorkstationRegistrationPayload({
  workstationId,
  displayName,
  workingDirectory,
  pythonPath,
  cpuCount = os.cpus().length,
  memoryBytes = os.totalmem(),
}) {
  return {
    workstation_id: workstationId,
    display_name: displayName,
    provider: "runtime_peer",
    default_environment_label: "Current Python",
    environment_policy: "current_python",
    working_directory: workingDirectory,
    cpu_count: cpuCount,
    memory_bytes: memoryBytes,
    capabilities: {
      launch_current_python: true,
    },
    runtime: {
      binary: "runtimed",
      python_path: pythonPath,
    },
  };
}

export function buildAttachJobSpawnPlan({
  job,
  pythonPath,
  agentRoot,
  baseUrl,
  workingDirectory,
  workstationId,
  displayName,
}) {
  assert(typeof job.job_id === "string" && job.job_id.length > 0, "attach job missing id");
  assert(
    typeof job.notebook_id === "string" && job.notebook_id.length > 0,
    `attach job ${job.job_id} missing notebook_id`,
  );

  const runRoot = path.join(agentRoot, safePathPart(job.job_id));
  const blobRoot = path.join(runRoot, "blobs");
  const logPath = path.join(runRoot, "runtime-peer.log");
  const launchDirectory = job.working_directory ?? workingDirectory;
  const args = [
    "cloud-runtime-agent",
    "--auth-kind",
    "anaconda-key",
    "--cloud-url",
    baseUrl,
    "--notebook-id",
    job.notebook_id,
    "--scope",
    "runtime_peer",
    "--python-path",
    pythonPath,
    "--blob-root",
    blobRoot,
    "--working-dir",
    launchDirectory,
    "--workstation-id",
    workstationId,
    "--workstation-display-name",
    displayName,
  ];

  if (typeof job.notebook_path === "string" && job.notebook_path.length > 0) {
    args.push("--notebook-path", job.notebook_path);
  }

  return {
    args,
    blobRoot,
    cwd: launchDirectory,
    logPath,
    runRoot,
  };
}

export function buildRuntimeAgentEnv(env, apiKey) {
  return compactEnv({
    HOME: env.HOME,
    PATH: env.PATH,
    LANG: env.LANG,
    LC_ALL: env.LC_ALL,
    SSL_CERT_FILE: env.SSL_CERT_FILE,
    SSL_CERT_DIR: env.SSL_CERT_DIR,
    RUST_BACKTRACE: env.RUST_BACKTRACE,
    RUST_LOG: env.RUST_LOG ?? "info",
    RUNT_CLOUD_TOKEN: apiKey,
  });
}

export function compactEnv(entries) {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => typeof value === "string" && value.length > 0),
  );
}

export function stableWorkstationId(hostname) {
  return `ws-${safePathPart(hostname).slice(0, 80) || "local"}`;
}

export function safePathPart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parsePositiveInteger(value, name, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
