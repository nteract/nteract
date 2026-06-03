import { spawn } from "node:child_process";
import path from "node:path";

import {
  NOTEBOOK_CLOUD_WRANGLER_INSPECTOR_PORT_ENV,
  NOTEBOOK_CLOUD_WRANGLER_PORT_ENV,
  notebookCloudAppDir,
  notebookCloudDevPorts,
  notebookCloudWorkspaceRoot,
} from "./local-dev.mjs";

const extraArgs = process.argv.slice(2);
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

function formatHostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}
