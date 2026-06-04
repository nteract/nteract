import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NOTEBOOK_CLOUD_URL_ENV = "NOTEBOOK_CLOUD_URL";
export const NTERACT_CLOUD_URL_ENV = "NTERACT_CLOUD_URL";
export const NOTEBOOK_CLOUD_WRANGLER_PORT_ENV = "NOTEBOOK_CLOUD_WRANGLER_PORT";
export const NOTEBOOK_CLOUD_WRANGLER_INSPECTOR_PORT_ENV = "NOTEBOOK_CLOUD_WRANGLER_INSPECTOR_PORT";
export const NOTEBOOK_CLOUD_WRANGLER_HOST_ENV = "NOTEBOOK_CLOUD_WRANGLER_HOST";

export const DEFAULT_WRANGLER_HOST = "127.0.0.1";
export const WRANGLER_PORT_RANGE = 1000;
export const WRANGLER_HTTP_PORT_BASE = 45_000;
export const WRANGLER_INSPECTOR_PORT_BASE = 46_000;

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function notebookCloudAppDir() {
  return appDir;
}

export function notebookCloudWorkspaceRoot({ cwd = appDir } = {}) {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const root = git.status === 0 ? git.stdout.trim() : "";
  return root ? path.resolve(root) : path.resolve(appDir, "../..");
}

export function worktreeHash(workspaceRoot) {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
}

export function notebookCloudPortOffset(workspaceRoot) {
  const prefix = worktreeHash(workspaceRoot).slice(0, 4);
  return Number.parseInt(prefix, 16) % WRANGLER_PORT_RANGE;
}

export function notebookCloudDevPorts({
  env = process.env,
  workspaceRoot = notebookCloudWorkspaceRoot(),
} = {}) {
  const offset = notebookCloudPortOffset(workspaceRoot);
  const host = env[NOTEBOOK_CLOUD_WRANGLER_HOST_ENV] || DEFAULT_WRANGLER_HOST;
  return {
    host,
    port:
      readPort(env[NOTEBOOK_CLOUD_WRANGLER_PORT_ENV], NOTEBOOK_CLOUD_WRANGLER_PORT_ENV) ??
      WRANGLER_HTTP_PORT_BASE + offset,
    inspectorPort:
      readPort(
        env[NOTEBOOK_CLOUD_WRANGLER_INSPECTOR_PORT_ENV],
        NOTEBOOK_CLOUD_WRANGLER_INSPECTOR_PORT_ENV,
      ) ?? WRANGLER_INSPECTOR_PORT_BASE + offset,
    workspaceRoot: path.resolve(workspaceRoot),
    worktreeHash: worktreeHash(workspaceRoot),
  };
}

export function notebookCloudLoopbackUrl(options = {}) {
  const { host, port } = notebookCloudDevPorts(options);
  return `http://${formatHostForUrl(host)}:${port}`;
}

export function notebookCloudBaseUrl({ env = process.env, ...options } = {}) {
  return (
    env[NTERACT_CLOUD_URL_ENV] ||
    env[NOTEBOOK_CLOUD_URL_ENV] ||
    notebookCloudLoopbackUrl({ env, ...options })
  );
}

function readPort(value, name) {
  if (value === undefined || value === "") {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${name} must be an integer TCP port between 1 and 65535`);
  }
  return port;
}

function formatHostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}
