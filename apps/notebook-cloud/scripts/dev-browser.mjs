import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_LOCAL_BROWSER_AUTH_SCOPE,
  DEFAULT_LOCAL_BROWSER_AUTH_USER,
  notebookCloudAppDir,
  notebookCloudDevPorts,
  notebookCloudLocalAuthUrl,
  notebookCloudWorkspaceRoot,
} from "./local-dev.mjs";

const args = parseArgs(process.argv.slice(2));
const workspaceRoot = notebookCloudWorkspaceRoot();
const appDir = notebookCloudAppDir();
const ports = notebookCloudDevPorts({ workspaceRoot });
const browserUrl = notebookCloudLocalAuthUrl({
  next: args.next,
  scope: args.scope,
  user: args.user,
  workspaceRoot,
});

await ensureViewerAssets({ rebuild: args.rebuild, skipBuild: args.skipBuild });

console.error(`Starting notebook-cloud for Browser UI work.`);
console.error(`Local Worker: http://${ports.host}:${ports.port}`);
console.error(`Browser auth: ${browserUrl}`);

const child = spawn("pnpm", ["--dir", "apps/notebook-cloud", "dev", ...args.wranglerArgs], {
  cwd: workspaceRoot,
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Failed to start notebook-cloud dev server: ${error.message}`);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

async function ensureViewerAssets({ rebuild, skipBuild }) {
  if (skipBuild) {
    console.error("Skipping viewer asset preflight.");
    return;
  }
  if (!rebuild && (await viewerAssetsExist())) {
    console.error("Using existing notebook-cloud viewer assets.");
    return;
  }

  console.error("Preparing notebook-cloud viewer assets with pnpm run build.");
  const result = spawnSync("pnpm", ["--dir", "apps/notebook-cloud", "run", "build"], {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status === 0) {
    return;
  }
  console.error(
    "Fix the build error above, then retry `pnpm --dir apps/notebook-cloud dev:browser --skip-build`.",
  );
  process.exit(result.status ?? 1);
}

async function viewerAssetsExist() {
  try {
    await access(path.join(appDir, "dist/assets/notebook-cloud-viewer.js"));
    await access(path.join(appDir, "dist/assets/notebook-cloud-viewer.css"));
    return true;
  } catch {
    return false;
  }
}

function parseArgs(rawArgs) {
  const parsed = {
    next: "/n",
    rebuild: false,
    scope: DEFAULT_LOCAL_BROWSER_AUTH_SCOPE,
    skipBuild: false,
    user: DEFAULT_LOCAL_BROWSER_AUTH_USER,
    wranglerArgs: [],
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--") {
      parsed.wranglerArgs.push(...rawArgs.slice(index + 1));
      break;
    }
    if (arg === "--rebuild") {
      parsed.rebuild = true;
      continue;
    }
    if (arg === "--skip-build") {
      parsed.skipBuild = true;
      continue;
    }
    const option = optionValue(arg, rawArgs[index + 1]);
    if (option) {
      if (option.consumesNext) {
        index += 1;
      }
      if (option.name === "next") {
        parsed.next = option.value;
      } else if (option.name === "scope") {
        parsed.scope = option.value;
      } else if (option.name === "user") {
        parsed.user = option.value;
      } else {
        parsed.wranglerArgs.push(arg);
        if (option.consumesNext) {
          parsed.wranglerArgs.push(option.value);
        }
      }
      continue;
    }
    parsed.wranglerArgs.push(arg);
  }

  return parsed;
}

function optionValue(arg, nextArg) {
  for (const name of ["next", "scope", "user"]) {
    const flag = `--${name}`;
    if (arg.startsWith(`${flag}=`)) {
      return { name, value: arg.slice(flag.length + 1), consumesNext: false };
    }
    if (arg === flag && nextArg !== undefined) {
      return { name, value: nextArg, consumesNext: true };
    }
  }
  return null;
}
