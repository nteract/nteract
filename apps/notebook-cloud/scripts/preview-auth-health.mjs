#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);

const DEFAULT_CLOUD_URL = "https://preview.runt.run";
const DEFAULT_TOKEN_PATH = path.join(os.homedir(), "token.preview.json");
const DEFAULT_ENV_PATH = path.join(os.homedir(), "preview.runt.run", ".env");
const DEFAULT_STATUS_PATH = path.join(
  os.homedir(),
  ".cache",
  "nteract",
  "preview-auth-health.json",
);
const DEFAULT_MIN_TOKEN_SECONDS = 15 * 60;
const DEFAULT_TIMER_UNIT = "preview-oidc-refresh.timer";
const DEFAULT_SERVICE_UNIT = "preview-oidc-refresh.service";

const STATUS_ORDER = {
  ok: 0,
  skipped: 1,
  unknown: 2,
  warn: 3,
  fail: 4,
};

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(
      `[preview-auth-health] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  const summary = await collectPreviewAuthHealth({
    env: process.env,
    fetchImpl: fetch,
    now: new Date(),
    ...options,
  });

  if (options.writeStatus) {
    await writeHealthSummary(options.statusPath, summary);
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatHealthSummary(summary, options.writeStatus ? options.statusPath : null));
  }

  if (summary.status === "fail") {
    process.exitCode = 1;
  }
}

export function parseArgs(args, env = process.env) {
  const options = {
    cloudUrl: env.NTERACT_CLOUD_URL || env.NOTEBOOK_CLOUD_URL || DEFAULT_CLOUD_URL,
    envPath: env.PREVIEW_RUNT_ENV || path.join(os.homedir(), "preview.runt.run", ".env"),
    json: false,
    minTokenSeconds: parsePositiveInteger(
      env.NTERACT_PREVIEW_AUTH_HEALTH_MIN_TOKEN_SECONDS,
      DEFAULT_MIN_TOKEN_SECONDS,
    ),
    network: true,
    serviceUnit: env.NTERACT_PREVIEW_OIDC_SERVICE_UNIT || DEFAULT_SERVICE_UNIT,
    statusPath: env.NTERACT_PREVIEW_AUTH_HEALTH_PATH || DEFAULT_STATUS_PATH,
    systemd: true,
    timerUnit: env.NTERACT_PREVIEW_OIDC_TIMER_UNIT || DEFAULT_TIMER_UNIT,
    tokenPath:
      env.NTERACT_PREVIEW_OIDC_TOKEN_PATH ||
      env.NOTEBOOK_CLOUD_OIDC_TOKEN_PATH ||
      DEFAULT_TOKEN_PATH,
    writeStatus: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-network") {
      options.network = false;
    } else if (arg === "--no-systemd") {
      options.systemd = false;
    } else if (arg === "--no-write") {
      options.writeStatus = false;
    } else if (arg === "--cloud-url") {
      options.cloudUrl = requireValue(args, (index += 1), arg);
    } else if (arg.startsWith("--cloud-url=")) {
      options.cloudUrl = arg.slice("--cloud-url=".length);
    } else if (arg === "--env") {
      options.envPath = requireValue(args, (index += 1), arg);
    } else if (arg.startsWith("--env=")) {
      options.envPath = arg.slice("--env=".length);
    } else if (arg === "--min-token-seconds") {
      options.minTokenSeconds = parsePositiveInteger(requireValue(args, (index += 1), arg), 0);
    } else if (arg.startsWith("--min-token-seconds=")) {
      options.minTokenSeconds = parsePositiveInteger(arg.slice("--min-token-seconds=".length), 0);
    } else if (arg === "--status-path") {
      options.statusPath = requireValue(args, (index += 1), arg);
    } else if (arg.startsWith("--status-path=")) {
      options.statusPath = arg.slice("--status-path=".length);
    } else if (arg === "--token") {
      options.tokenPath = requireValue(args, (index += 1), arg);
    } else if (arg.startsWith("--token=")) {
      options.tokenPath = arg.slice("--token=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

export async function collectPreviewAuthHealth({
  cloudUrl = DEFAULT_CLOUD_URL,
  env = process.env,
  envPath = DEFAULT_ENV_PATH,
  execFileImpl = execFile,
  fetchImpl = fetch,
  minTokenSeconds = DEFAULT_MIN_TOKEN_SECONDS,
  network = true,
  now = new Date(),
  serviceUnit = DEFAULT_SERVICE_UNIT,
  systemd = true,
  timerUnit = DEFAULT_TIMER_UNIT,
  tokenPath = DEFAULT_TOKEN_PATH,
} = {}) {
  const token = await readTokenHealth(tokenPath, { minTokenSeconds, now });
  const systemdHealth = systemd
    ? await readSystemdHealth({ execFileImpl, serviceUnit, timerUnit })
    : skippedCheck("systemd_disabled");
  const previewEnv = await readPreviewEnvHealth(envPath, env);
  const apiKey = network
    ? await readApiKeyHealth({ cloudUrl, env: previewEnv.values, fetchImpl })
    : skippedCheck("network_disabled");

  const summary = {
    generated_at: now.toISOString(),
    ok: false,
    status: "ok",
    checks: {
      token,
      systemd: systemdHealth,
      preview_env: withoutValues(previewEnv),
      api_key: apiKey,
    },
  };
  summary.status = worstStatus([
    token.status,
    systemdHealth.status,
    previewEnv.status,
    apiKey.status,
  ]);
  summary.ok = summary.status === "ok" || summary.status === "skipped";
  return summary;
}

export async function readTokenHealth(tokenPath, { minTokenSeconds, now = new Date() } = {}) {
  try {
    const stat = await fs.stat(tokenPath);
    const parsed = JSON.parse(await fs.readFile(tokenPath, "utf8"));
    return summarizeToken(parsed, {
      mode: stat.mode & 0o777,
      mtime: stat.mtime.toISOString(),
      path: tokenPath,
      minTokenSeconds,
      now,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        status: "fail",
        reason: "missing_token_file",
        path: tokenPath,
        exists: false,
      };
    }
    return {
      status: "fail",
      reason: "invalid_token_file",
      path: tokenPath,
      exists: true,
      error: safeErrorMessage(error),
    };
  }
}

export function summarizeToken(
  token,
  {
    minTokenSeconds = DEFAULT_MIN_TOKEN_SECONDS,
    mode = null,
    mtime = null,
    now = new Date(),
    path: tokenPath = null,
  } = {},
) {
  const expiresAt = Number(token?.expiresAt);
  const expiresInSeconds = Number.isFinite(expiresAt)
    ? Math.round(expiresAt - now.getTime() / 1000)
    : null;
  const hasAccessToken = typeof token?.accessToken === "string" && token.accessToken.trim() !== "";
  const hasRefreshToken =
    typeof token?.refreshToken === "string" && token.refreshToken.trim() !== "";
  const hasSubject = typeof token?.claims?.sub === "string" && token.claims.sub.trim() !== "";
  const hasEmailClaim =
    typeof token?.claims?.email === "string" && token.claims.email.trim() !== "";
  const privateMode = typeof mode === "number" ? (mode & 0o077) === 0 : null;

  let status = "ok";
  let reason = "fresh";
  if (!hasAccessToken || !hasSubject || !Number.isFinite(expiresAt)) {
    status = "fail";
    reason = "missing_required_token_fields";
  } else if (expiresInSeconds <= 0) {
    status = "fail";
    reason = "expired";
  } else if (expiresInSeconds <= minTokenSeconds) {
    status = "warn";
    reason = "refresh_soon";
  } else if (privateMode === false) {
    status = "warn";
    reason = "token_file_permissions_not_private";
  }

  return {
    status,
    reason,
    path: tokenPath,
    exists: true,
    mode: typeof mode === "number" ? mode.toString(8).padStart(3, "0") : null,
    mtime,
    expires_at: Number.isFinite(expiresAt) ? new Date(expiresAt * 1000).toISOString() : null,
    expires_in_seconds: expiresInSeconds,
    expires_in_minutes: Number.isFinite(expiresInSeconds)
      ? Math.max(0, Math.round(expiresInSeconds / 60))
      : null,
    has_access_token: hasAccessToken,
    has_refresh_token: hasRefreshToken,
    has_subject_claim: hasSubject,
    has_email_claim: hasEmailClaim,
    private_mode: privateMode,
  };
}

export async function readSystemdHealth({
  execFileImpl = execFile,
  serviceUnit = DEFAULT_SERVICE_UNIT,
  timerUnit = DEFAULT_TIMER_UNIT,
} = {}) {
  try {
    const [timer, service] = await Promise.all([
      readSystemdUnit(execFileImpl, timerUnit, [
        "ActiveState",
        "UnitFileState",
        "NextElapseUSecRealtime",
        "LastTriggerUSecRealtime",
      ]),
      readSystemdUnit(execFileImpl, serviceUnit, [
        "ActiveState",
        "Result",
        "ExecMainStatus",
        "InactiveExitTimestamp",
      ]),
    ]);
    return summarizeSystemd({ service, serviceUnit, timer, timerUnit });
  } catch (error) {
    return {
      status: "unknown",
      reason: "systemd_unavailable",
      error: safeErrorMessage(error),
      service_unit: serviceUnit,
      timer_unit: timerUnit,
    };
  }
}

async function readSystemdUnit(execFileImpl, unit, properties) {
  const { stdout } = await execFileImpl("systemctl", [
    "--user",
    "show",
    unit,
    "--no-pager",
    ...properties.map((property) => `--property=${property}`),
  ]);
  return parseSystemdProperties(stdout);
}

export function summarizeSystemd({ service, serviceUnit, timer, timerUnit }) {
  const timerActive = timer.ActiveState === "active";
  const timerEnabled = ["enabled", "static", "linked", ""].includes(timer.UnitFileState ?? "");
  const serviceSucceeded =
    (service.Result === "success" || service.Result === "") &&
    (service.ExecMainStatus === "0" || service.ExecMainStatus === "");

  let status = "ok";
  let reason = "timer_active_last_run_success";
  if (!timerActive) {
    status = "fail";
    reason = "timer_not_active";
  } else if (!timerEnabled) {
    status = "warn";
    reason = "timer_not_enabled";
  } else if (!serviceSucceeded) {
    status = "fail";
    reason = "last_refresh_failed";
  }

  return {
    status,
    reason,
    timer_unit: timerUnit,
    timer_active_state: timer.ActiveState ?? null,
    timer_unit_file_state: timer.UnitFileState ?? null,
    timer_next_elapsed: timer.NextElapseUSecRealtime || null,
    timer_last_trigger: timer.LastTriggerUSecRealtime || null,
    service_unit: serviceUnit,
    service_active_state: service.ActiveState ?? null,
    service_result: service.Result ?? null,
    service_exec_main_status: service.ExecMainStatus ?? null,
    service_inactive_exit_timestamp: service.InactiveExitTimestamp || null,
  };
}

export function parseSystemdProperties(stdout) {
  const result = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const trimmed = line.trim();
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return result;
}

export async function readPreviewEnvHealth(envPath, processEnv = process.env) {
  let fileValues = {};
  let exists = false;
  try {
    fileValues = parseEnvFile(await fs.readFile(envPath, "utf8"));
    exists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return {
        status: "fail",
        reason: "invalid_preview_env",
        path: envPath,
        exists: true,
        values: { ...processEnv },
        error: safeErrorMessage(error),
      };
    }
  }

  const values = { ...fileValues, ...processEnv };
  const hasApiKey =
    typeof values.NTERACT_API_KEY === "string" && values.NTERACT_API_KEY.trim() !== "";
  const hasCloudUrl =
    typeof values.NTERACT_CLOUD_URL === "string" && values.NTERACT_CLOUD_URL.trim() !== "";
  return {
    status: hasApiKey ? "ok" : "fail",
    reason: hasApiKey ? "api_key_configured" : "missing_api_key",
    path: envPath,
    exists,
    has_api_key: hasApiKey,
    has_cloud_url: hasCloudUrl,
    values,
  };
}

export function parseEnvFile(source) {
  const values = {};
  for (const line of String(source).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const index = withoutExport.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = withoutExport.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    values[key] = unquoteEnvValue(withoutExport.slice(index + 1).trim());
  }
  return values;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  const commentIndex = value.search(/\s#/);
  return commentIndex >= 0 ? value.slice(0, commentIndex).trimEnd() : value;
}

export async function readApiKeyHealth({
  cloudUrl = DEFAULT_CLOUD_URL,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const apiKey = typeof env.NTERACT_API_KEY === "string" ? env.NTERACT_API_KEY.trim() : "";
  const baseUrl = env.NTERACT_CLOUD_URL || env.NOTEBOOK_CLOUD_URL || cloudUrl || DEFAULT_CLOUD_URL;
  if (!apiKey) {
    return {
      status: "fail",
      reason: "missing_api_key",
      cloud_url: safeCloudUrl(baseUrl),
    };
  }

  const url = new URL("/api/n?limit=1", baseUrl);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
      },
    });
    const body = await response
      .clone()
      .json()
      .catch(() => null);
    const notebookCount = Array.isArray(body?.notebooks) ? body.notebooks.length : null;
    return {
      status: response.ok ? "ok" : "fail",
      reason: response.ok ? "api_key_smoke_ok" : "api_key_smoke_failed",
      cloud_url: safeCloudUrl(baseUrl),
      endpoint: "/api/n?limit=1",
      http_status: response.status,
      response_ok: response.ok,
      body_ok: body?.ok === true,
      notebook_count: notebookCount,
    };
  } catch (error) {
    return {
      status: "fail",
      reason: "api_key_smoke_error",
      cloud_url: safeCloudUrl(baseUrl),
      endpoint: "/api/n?limit=1",
      error: safeErrorMessage(error),
    };
  }
}

export async function writeHealthSummary(statusPath, summary) {
  await fs.mkdir(path.dirname(statusPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(statusPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(statusPath, 0o600).catch(() => {});
}

export function formatHealthSummary(summary, statusPath = null) {
  const parts = [
    `[preview-auth-health] overall=${summary.status}`,
    `token=${checkBrief(summary.checks.token)}`,
    `oidc_timer=${checkBrief(summary.checks.systemd)}`,
    `api_key=${checkBrief(summary.checks.api_key)}`,
  ];
  if (Number.isFinite(summary.checks.token?.expires_in_minutes)) {
    parts.splice(2, 0, `token_expires_in=${summary.checks.token.expires_in_minutes}m`);
  }
  if (statusPath) {
    parts.push(`status=${statusPath}`);
  }
  return parts.join(" ");
}

function checkBrief(check) {
  if (!check) {
    return "unknown";
  }
  return check.reason ? `${check.status}:${check.reason}` : check.status;
}

function withoutValues(envHealth) {
  const { values: _values, ...safe } = envHealth;
  return safe;
}

function skippedCheck(reason) {
  return { status: "skipped", reason };
}

function worstStatus(statuses) {
  return statuses.reduce((worst, status) => {
    const current = STATUS_ORDER[status] ?? STATUS_ORDER.unknown;
    return current > (STATUS_ORDER[worst] ?? STATUS_ORDER.unknown) ? status : worst;
  }, "ok");
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function requireValue(args, index, flag) {
  if (index >= args.length || !args[index]) {
    throw new Error(`${flag} requires a value`);
  }
  return args[index];
}

function safeCloudUrl(value) {
  try {
    const url = new URL(value || DEFAULT_CLOUD_URL);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return DEFAULT_CLOUD_URL;
  }
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, "Bearer [REDACTED]")
    .replace(
      /(accessToken|refreshToken|idToken|token|Authorization)([^A-Za-z0-9_-]*)([A-Za-z0-9._~+/-]{8,})/gi,
      "$1$2[REDACTED]",
    );
}

function isMainModule(metaUrl, argvPath) {
  return Boolean(argvPath && metaUrl === pathToFileURL(path.resolve(argvPath)).href);
}
