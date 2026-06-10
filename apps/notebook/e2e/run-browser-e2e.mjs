import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function truthyEnv(name) {
  const value = String(process.env[name] ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function positiveNumberEnv(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const scriptArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const READY_TIMEOUT_MS = positiveNumberEnv("NTERACT_BROWSER_E2E_READY_TIMEOUT_MS") ?? 120_000;
const POLL_MS = 250;

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const exeSuffix = process.platform === "win32" ? ".exe" : "";
const runtBinary = path.join(repoRoot, "target", "debug", `runt${exeSuffix}`);
const port = Number(
  process.env.RUNTIMED_VITE_PORT ?? process.env.CONDUCTOR_PORT ?? vitePort(repoRoot),
);
const usePortless =
  (scriptArgs.includes("--portless") || truthyEnv("NTERACT_BROWSER_E2E_PORTLESS")) &&
  !scriptArgs.includes("--no-portless") &&
  process.env.PORTLESS !== "0";
const portlessName = process.env.NTERACT_BROWSER_E2E_PORTLESS_NAME ?? "nteract-notebook";
const baseURL =
  process.env.NTERACT_BROWSER_E2E_BASE_URL ??
  (usePortless ? portlessUrl(portlessName) : `http://localhost:${port}`);
const healthURL = `${baseURL}/__nteract_dev_relay/health`;
const ignoreHTTPSErrors =
  process.env.NTERACT_BROWSER_E2E_IGNORE_HTTPS_ERRORS === "1" ||
  (usePortless &&
    baseURL.startsWith("https://") &&
    process.env.NTERACT_BROWSER_E2E_IGNORE_HTTPS_ERRORS !== "0");

function portlessUrl(name) {
  const result = spawnSync("pnpm", ["exec", "portless", "get", name], {
    cwd: appRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status === 0) return normalizePortlessUrl(extractUrl(result.stdout));

  const stderr = result.stderr.trim();
  const details = stderr ? `\n${stderr}` : "";
  throw new Error(`failed to resolve Portless URL for ${name}${details}`);
}

function extractUrl(output) {
  const lines = output.trim().split(/\r?\n/).reverse();
  const url = lines.find((line) => line.startsWith("http://") || line.startsWith("https://"));
  if (!url) throw new Error(`failed to find Portless URL in output:\n${output.trim()}`);
  return url;
}

function normalizePortlessUrl(url) {
  const parsed = new URL(url);
  if (process.env.PORTLESS_HTTPS !== undefined) {
    parsed.protocol =
      process.env.PORTLESS_HTTPS === "0" || process.env.PORTLESS_HTTPS === "false"
        ? "http:"
        : "https:";
  }
  if (process.env.PORTLESS_PORT) parsed.port = process.env.PORTLESS_PORT;
  return parsed.toString().replace(/\/$/, "");
}

function worktreeHash(workspace) {
  return crypto.createHash("sha256").update(workspace).digest("hex").slice(0, 12);
}

function vitePort(workspace) {
  const hash = worktreeHash(workspace);
  return 5100 + (Number.parseInt(hash.slice(0, 4), 16) % 4900);
}

function managedEnv(extraEnv = {}) {
  return {
    ...process.env,
    ...extraEnv,
    RUNTIMED_DEV: "1",
    RUNTIMED_WORKSPACE_PATH: repoRoot,
    RUNTIMED_VITE_PORT: String(port),
    NTERACT_BROWSER_E2E_BASE_URL: baseURL,
    ...(ignoreHTTPSErrors ? { NTERACT_BROWSER_E2E_IGNORE_HTTPS_ERRORS: "1" } : {}),
    VITE_E2E: "1",
  };
}

async function ensureRuntBinary() {
  if (fs.existsSync(runtBinary)) return;
  const build = spawnManaged("cargo", ["build", "-p", "runt"]);
  const code = await waitForExit(build);
  if (code !== 0) throw new Error(`cargo build -p runt failed with exit code ${code}`);
  if (!fs.existsSync(runtBinary))
    throw new Error(`cargo build -p runt did not produce ${runtBinary}`);
}

function daemonRunning() {
  if (!fs.existsSync(runtBinary)) return false;
  const result = spawnSync(runtBinary, ["daemon", "status", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: managedEnv(),
  });
  if (result.status !== 0) return false;
  try {
    const status = JSON.parse(result.stdout);
    return status?.running === true && status?.socket_path !== undefined;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childExitDescription(child) {
  if (!child) return null;
  if (child.exitCode !== null) return `exit code ${child.exitCode}`;
  return child.signalCode ? `signal ${child.signalCode}` : null;
}

async function waitUntil(label, predicate, timeoutMs = READY_TIMEOUT_MS, child = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exit = childExitDescription(child);
    if (exit) throw new Error(`${label} process exited before readiness (${exit})`);
    if (await predicate()) return;
    await delay(POLL_MS);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function relayHealthy() {
  try {
    const json = await getJson(healthURL);
    return json?.relay === "ok" && json?.daemon?.socket_exists === true;
  } catch {
    return false;
  }
}

function getJson(url) {
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;
  const rejectUnauthorized = !ignoreHTTPSErrors && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0";

  return new Promise((resolve, reject) => {
    const request = client.get(
      parsed,
      {
        headers: { Accept: "application/json" },
        ...(parsed.protocol === "https:" ? { rejectUnauthorized } : {}),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`GET ${url} failed with status ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(5_000, () => {
      request.destroy(new Error(`GET ${url} timed out`));
    });
  });
}

function spawnManaged(command, args, options = {}) {
  const { env: extraEnv, ...spawnOptions } = options;

  return spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: managedEnv(extraEnv),
    ...spawnOptions,
  });
}

function viteProcess() {
  if (!usePortless) {
    return { command: "pnpm", args: ["--filter", "notebook-ui", "dev"], cwd: repoRoot };
  }

  return {
    command: "pnpm",
    args: [
      "exec",
      "portless",
      "run",
      "--name",
      portlessName,
      "--app-port",
      String(port),
      "pnpm",
      "exec",
      "vp",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    cwd: appRoot,
  };
}

function playwrightArgs() {
  return [
    "--filter",
    "notebook-ui",
    "exec",
    "playwright",
    "test",
    "-c",
    "playwright.config.ts",
    ...scriptArgs.filter((arg) => arg !== "--portless" && arg !== "--no-portless"),
  ];
}

async function waitForExit(child) {
  return await new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await delay(500);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  let daemon = null;
  let vite = null;

  try {
    const args = playwrightArgs();
    if (args.includes("--list")) {
      process.exitCode = await waitForExit(spawnManaged("pnpm", args, { cwd: appRoot }));
      return;
    }

    await ensureRuntBinary();

    if (!daemonRunning()) {
      daemon = spawnManaged("cargo", ["xtask", "dev-daemon"]);
      await waitUntil("dev daemon", daemonRunning, READY_TIMEOUT_MS, daemon);
    }

    if (!(await relayHealthy())) {
      const viteCommand = viteProcess();
      vite = spawnManaged(viteCommand.command, viteCommand.args, { cwd: viteCommand.cwd });
      await waitUntil("Vite browser relay", relayHealthy, READY_TIMEOUT_MS, vite);
    }

    const result = spawnManaged("pnpm", args, { cwd: appRoot });

    process.exitCode = await waitForExit(result);
  } finally {
    await stop(vite);
    await stop(daemon);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
