import { spawn } from "node:child_process";
import path from "node:path";

import {
  NOTEBOOK_CLOUD_WRANGLER_INSPECTOR_PORT_ENV,
  NOTEBOOK_CLOUD_WRANGLER_PORT_ENV,
  notebookCloudAppDir,
  notebookCloudDevPorts,
  notebookCloudWorkspaceRoot,
} from "./local-dev.mjs";

// `--no-local-oidc` opts out of the default-on local OIDC issuer. Strip it here
// so it never reaches Wrangler, which would reject the unknown flag.
const rawExtraArgs = process.argv.slice(2);
const localOidcEnabled = !rawExtraArgs.includes("--no-local-oidc");
const extraArgs = rawExtraArgs.filter((arg) => arg !== "--no-local-oidc");
const workspaceRoot = notebookCloudWorkspaceRoot();
const configPath = path.relative(workspaceRoot, path.join(notebookCloudAppDir(), "wrangler.toml"));
const { host, port, inspectorPort, worktreeHash } = notebookCloudDevPorts({ workspaceRoot });
const requestedHost = optionValue(extraArgs, "ip") ?? host;
const requestedPort = optionValue(extraArgs, "port") ?? String(port);
const requestedInspectorPort = optionValue(extraArgs, "inspector-port") ?? String(inspectorPort);
const localUrl = `http://${formatHostForUrl(requestedHost)}:${requestedPort}`;

const args = ["--workspace-root", "exec", "wrangler", "dev", "--config", configPath];

if (!hasOption(extraArgs, "ip")) {
  args.push("--ip", host);
}
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
    // App sessions decouple the live-room WebSocket from OIDC token rotation, so
    // seed a fixed dev secret to exercise that path. Only the local dev worker
    // sees it; production supplies its own secret binding.
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "notebook-cloud-local-dev-app-session-secret",
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
