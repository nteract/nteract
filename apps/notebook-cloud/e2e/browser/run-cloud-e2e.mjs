import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  notebookCloudAppDir,
  notebookCloudBaseUrl,
  notebookCloudWorkspaceRoot,
} from "../../scripts/local-dev.mjs";

const scriptArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const READY_TIMEOUT_MS = 120_000;
const POLL_MS = 250;

const appDir = notebookCloudAppDir();
const workspaceRoot = notebookCloudWorkspaceRoot();
const baseURL = notebookCloudBaseUrl({ workspaceRoot });
const healthURL = new URL("/api/health", baseURL).href;

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

async function workerHealthy() {
  try {
    const response = await fetch(healthURL, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function viewerAssetsExist() {
  try {
    await access(path.join(appDir, "dist/assets/notebook-cloud-viewer.js"));
    return true;
  } catch {
    return false;
  }
}

function spawnManaged(command, args, options = {}) {
  return spawn(command, args, {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
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

async function ensureViewerAssets() {
  if (await viewerAssetsExist()) return;
  console.error("notebook-cloud viewer assets missing — running `pnpm run build` first.");
  const build = spawnManaged("pnpm", ["--dir", "apps/notebook-cloud", "run", "build"]);
  const code = await waitForExit(build);
  if (code !== 0)
    throw new Error(`pnpm --dir apps/notebook-cloud run build failed with exit code ${code}`);
}

function playwrightArgs() {
  return [
    "--dir",
    "apps/notebook-cloud",
    "exec",
    "playwright",
    "test",
    "-c",
    "e2e/browser/playwright.config.ts",
    ...scriptArgs,
  ];
}

async function main() {
  let worker = null;

  try {
    const args = playwrightArgs();
    if (args.includes("--list")) {
      process.exitCode = await waitForExit(spawnManaged("pnpm", args));
      return;
    }

    await ensureViewerAssets();

    if (!(await workerHealthy())) {
      // --no-local-oidc: the dev server mounts a local OIDC issuer by design
      // (scripts/dev.mjs), and cloud-auth-controls.tsx makes OIDC take
      // priority over the loopback dev-token path whenever both are
      // configured. Specs that exercise the "Use local auth" flow need that
      // button to actually render, so drop the dev OIDC mount here.
      worker = spawnManaged("pnpm", ["--dir", "apps/notebook-cloud", "dev", "--no-local-oidc"]);
      await waitUntil(
        "notebook-cloud Wrangler dev server",
        workerHealthy,
        READY_TIMEOUT_MS,
        worker,
      );
    }

    const result = spawnManaged("pnpm", args);
    process.exitCode = await waitForExit(result);
  } finally {
    await stop(worker);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
