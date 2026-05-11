import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const READY_TIMEOUT_MS = positiveNumberEnv("NTERACT_BROWSER_E2E_READY_TIMEOUT_MS") ?? 120_000;
const POLL_MS = 250;

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const port = Number(
  process.env.RUNTIMED_VITE_PORT ?? process.env.CONDUCTOR_PORT ?? vitePort(repoRoot),
);
const baseURL = process.env.NTERACT_BROWSER_E2E_BASE_URL ?? `http://localhost:${port}`;
const healthURL = `${baseURL}/__nteract_dev_relay/health`;

function positiveNumberEnv(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function cacheDir() {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches");
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  }
  return path.join(os.homedir(), ".cache");
}

function worktreeHash(workspace) {
  return crypto.createHash("sha256").update(workspace).digest("hex").slice(0, 12);
}

function vitePort(workspace) {
  const hash = worktreeHash(workspace);
  return 5100 + (Number.parseInt(hash.slice(0, 4), 16) % 4900);
}

function daemonJsonPath(workspace) {
  const namespace = process.env.RUNTIMED_CACHE_NAMESPACE ?? "runt-nightly";
  return path.join(cacheDir(), namespace, "worktrees", worktreeHash(workspace), "daemon.json");
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readDaemonState(workspace) {
  try {
    return JSON.parse(fs.readFileSync(daemonJsonPath(workspace), "utf8"));
  } catch {
    return null;
  }
}

function socketExists(state) {
  const socketPath = state?.socket_path ?? state?.endpoint;
  if (!socketPath) return false;
  try {
    return fs.statSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

function daemonRunning(workspace) {
  const state = readDaemonState(workspace);
  if (!socketExists(state)) return false;
  return state?.pid === undefined || processIsRunning(state.pid);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(label, predicate, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(POLL_MS);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function relayHealthy() {
  try {
    const response = await fetch(healthURL, { headers: { Accept: "application/json" } });
    if (!response.ok) return false;
    const json = await response.json();
    return json?.relay === "ok" && json?.daemon?.socket_exists === true;
  } catch {
    return false;
  }
}

function spawnManaged(command, args, options) {
  return spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      RUNTIMED_DEV: "1",
      RUNTIMED_WORKSPACE_PATH: repoRoot,
      RUNTIMED_VITE_PORT: String(port),
      VITE_E2E: "1",
    },
    ...options,
  });
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
    ...process.argv.slice(2).filter((arg) => arg !== "--"),
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

    if (!daemonRunning(repoRoot)) {
      daemon = spawnManaged("cargo", ["xtask", "dev-daemon"]);
      await waitUntil("dev daemon", () => daemonRunning(repoRoot));
    }

    if (!(await relayHealthy())) {
      vite = spawnManaged("pnpm", ["--filter", "notebook-ui", "dev"]);
      await waitUntil("Vite browser relay", relayHealthy);
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
