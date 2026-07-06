import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  NOTEBOOK_CLOUD_WRANGLER_INSPECTOR_PORT_ENV,
  NOTEBOOK_CLOUD_WRANGLER_PORT_ENV,
  notebookCloudAppDir,
  notebookCloudDevPorts,
  notebookCloudWorkspaceRoot,
} from "./local-dev.mjs";

// Strip our own flags plus any caller `--ip` before args reach Wrangler.
// `--no-local-oidc` is ours (Wrangler would reject the unknown flag). `--ip` is
// removed deliberately: the dev worker binds the derived loopback host and
// offers no host override, because the mounted dev OIDC issuer mints real
// tokens and app-session cookies. Binding off-box would turn a localhost
// convenience into a reachable auth bypass.
const rawExtraArgs = process.argv.slice(2);
const localOidcEnabled = !rawExtraArgs.includes("--no-local-oidc");
const extraArgs = stripDevOnlyArgs(rawExtraArgs);
const workspaceRoot = notebookCloudWorkspaceRoot();
const configPath = path.relative(workspaceRoot, path.join(notebookCloudAppDir(), "wrangler.toml"));
const { host, port, inspectorPort, worktreeHash } = notebookCloudDevPorts({ workspaceRoot });
const requestedPort = optionValue(extraArgs, "port") ?? String(port);
const requestedInspectorPort = optionValue(extraArgs, "inspector-port") ?? String(inspectorPort);
const localUrl = `http://${formatHostForUrl(host)}:${requestedPort}`;

const args = ["--workspace-root", "exec", "wrangler", "dev", "--config", configPath];

// Loopback host only; no `--ip` reaches Wrangler, so there is nothing to override.
args.push("--ip", host);
if (!hasOption(extraArgs, "port")) {
  args.push("--port", String(port));
}
if (!hasOption(extraArgs, "inspector-port")) {
  args.push("--inspector-port", String(inspectorPort));
}
if (!hasVar(extraArgs, "NOTEBOOK_CLOUD_TRUST_LOOPBACK_HEADERS")) {
  args.push("--var", "NOTEBOOK_CLOUD_TRUST_LOOPBACK_HEADERS:true");
}

if (localOidcEnabled) {
  // Mount the dev OIDC issuer at <origin>/dev/oidc and point the worker's OIDC
  // verifier + the viewer's auth config at it, so a full sign-in, app-session
  // exchange, and renewal cycle runs locally with no live IdP. These override
  // the Anaconda prototype values from wrangler.toml [vars]; each `--var` is
  // skipped when the caller already passed one. NOTEBOOK_CLOUD_OIDC_ISSUER and
  // the client id must match the mounted issuer for token verification to pass.
  const defaultLocalOidcVars = {
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    NOTEBOOK_CLOUD_OIDC_ISSUER: `${localUrl}/dev/oidc`,
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "local-oidc-client",
    NOTEBOOK_CLOUD_OIDC_AUDIENCE: "local-oidc-client",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:local",
    NOTEBOOK_CLOUD_OIDC_PROVIDER_LABEL: "Local dev OIDC",
    NOTEBOOK_CLOUD_OIDC_REDIRECT_URI: `${localUrl}/oidc`,
    // App sessions use a per-process random dev secret. A Wrangler restart
    // invalidates cookies and forces a fresh sign-in, which is acceptable in
    // local dev because there is no durable session to protect.
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: randomBytes(32).toString("hex"),
  };
  for (const [name, value] of Object.entries(defaultLocalOidcVars)) {
    if (!hasVar(extraArgs, name)) {
      args.push("--var", `${name}:${value}`);
    }
  }
}

args.push(...extraArgs);

console.error(`Starting notebook-cloud Wrangler on ${localUrl}`);
console.error(`Worktree hash ${worktreeHash}; inspector port ${requestedInspectorPort}`);
console.error(
  `Override with ${NOTEBOOK_CLOUD_WRANGLER_PORT_ENV} or ${NOTEBOOK_CLOUD_WRANGLER_INSPECTOR_PORT_ENV}.`,
);

const child = spawn("pnpm", args, {
  cwd: workspaceRoot,
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Failed to start Wrangler: ${error.message}`);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

// Drop `--no-local-oidc` (our flag) and any `--ip`/`--ip=` host override (with
// its value) so neither reaches Wrangler. The loopback bind is fixed above.
function stripDevOnlyArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-local-oidc") {
      continue;
    }
    if (arg === "--ip") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--ip=")) {
      continue;
    }
    result.push(arg);
  }
  return result;
}

function hasOption(args, name) {
  const flag = `--${name}`;
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function optionValue(args, name) {
  const flag = `--${name}`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
    if (arg === flag) {
      return args[index + 1];
    }
  }
  return undefined;
}

function hasVar(args, name) {
  const prefix = `${name}:`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--var" && args[index + 1]?.startsWith(prefix)) {
      return true;
    }
    if (arg.startsWith(`--var=${prefix}`)) {
      return true;
    }
  }
  return false;
}

function formatHostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}
