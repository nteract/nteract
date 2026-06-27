import os from "node:os";
import path from "node:path";

export const DEFAULT_WORKSTATION_AUTH_KIND = "anaconda-key";
export const DEFAULT_WORKSTATION_RETRY_AFTER_MS = 60_000;
export const MAX_WORKSTATION_RETRY_AFTER_MS = 15 * 60_000;
export const WORKSTATION_RETRYABLE_STATUS_CODES = new Set([429, 503]);
export const STALE_WORKSTATION_RETRYABLE_STATUS_CODES = new Set([404, 410, 429, 503]);
export const WORKSTATION_AUTH_KINDS = new Set([DEFAULT_WORKSTATION_AUTH_KIND, "oidc"]);

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
  authKind = DEFAULT_WORKSTATION_AUTH_KIND,
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
  const normalizedAuthKind = normalizeWorkstationAuthKind(authKind);
  const args = [
    "cloud-runtime-agent",
    "--auth-kind",
    normalizedAuthKind,
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
    "--runtime-session-id",
    job.job_id,
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

export function buildRuntimeAgentEnv(env, credential) {
  return compactEnv({
    HOME: env.HOME,
    PATH: env.PATH,
    LANG: env.LANG,
    LC_ALL: env.LC_ALL,
    SSL_CERT_FILE: env.SSL_CERT_FILE,
    SSL_CERT_DIR: env.SSL_CERT_DIR,
    RUST_BACKTRACE: env.RUST_BACKTRACE,
    RUST_LOG: env.RUST_LOG ?? "info",
    RUNT_CLOUD_TOKEN: credential,
  });
}

export function buildWorkstationAuthHeaders(authKind, credential) {
  const normalizedAuthKind = normalizeWorkstationAuthKind(authKind);
  const token = credential?.trim();
  assert(token, "hosted workstation credential is required");
  const headers = {
    Authorization: `Bearer ${token}`,
  };
  if (normalizedAuthKind === "anaconda-key") {
    headers["X-Notebook-Cloud-Auth-Provider"] = "anaconda-api-key";
  }
  return headers;
}

export function normalizeWorkstationAuthKind(value) {
  const normalized = String(value ?? DEFAULT_WORKSTATION_AUTH_KIND)
    .trim()
    .toLowerCase();
  if (normalized === "anaconda-api-key") {
    return DEFAULT_WORKSTATION_AUTH_KIND;
  }
  if (normalized === "oidc-bearer") {
    return "oidc";
  }
  if (WORKSTATION_AUTH_KINDS.has(normalized)) {
    return normalized;
  }
  throw new Error(
    `NOTEBOOK_CLOUD_WORKSTATION_AUTH_KIND must be ${Array.from(WORKSTATION_AUTH_KINDS).join(
      " or ",
    )}`,
  );
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

export async function parseHttpResponseBody(response) {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

export function retryAfterMs(
  response,
  fallbackMs = DEFAULT_WORKSTATION_RETRY_AFTER_MS,
  retryStatuses = WORKSTATION_RETRYABLE_STATUS_CODES,
) {
  if (!retryStatuses.has(response.status)) return 0;
  const header = response.headers?.get?.("Retry-After");
  if (!header) return retryFallbackMs(response.status, fallbackMs);

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1_000, Math.ceil(seconds * 1_000));
  }

  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.max(1_000, dateMs - Date.now());
  }

  return retryFallbackMs(response.status, fallbackMs);
}

function retryFallbackMs(status, fallbackMs) {
  if (status === 404 || status === 410) {
    return MAX_WORKSTATION_RETRY_AFTER_MS;
  }
  return fallbackMs;
}

export function retryCooldownMs({
  retryAfterMs,
  failureCount,
  maxMs = MAX_WORKSTATION_RETRY_AFTER_MS,
  jitterRatio = 0.2,
  random = Math.random,
}) {
  const retryAfter = Math.max(1_000, Number(retryAfterMs) || DEFAULT_WORKSTATION_RETRY_AFTER_MS);
  const failures = Math.max(1, Number(failureCount) || 1);
  const maxDelay = Math.max(retryAfter, Number(maxMs) || MAX_WORKSTATION_RETRY_AFTER_MS);
  const exponent = Math.min(failures - 1, 6);
  const baseDelay = Math.min(maxDelay, retryAfter * 2 ** exponent);
  const jitter = Math.max(0, baseDelay * jitterRatio * random());
  return Math.min(maxDelay, Math.ceil(baseDelay + jitter));
}

export function runtimePeerExitMessage(code, signal) {
  const exitCode = Number.isInteger(code) ? code : null;
  const exitSignal = typeof signal === "string" && signal.length > 0 ? signal : null;

  if (exitCode != null && exitSignal != null) {
    return `Runtime peer exited with code=${exitCode}, signal=${exitSignal}`;
  }
  if (exitCode != null) {
    return `Runtime peer exited with code=${exitCode}`;
  }
  if (exitSignal != null) {
    return `Runtime peer exited with signal=${exitSignal}`;
  }
  return "Runtime peer exited";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
