#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT_URL = new URL("../", import.meta.url);
const CONFIG_URL = new URL("../wrangler.celld.jsonc", import.meta.url);
const ESBUILD_WRAPPER_URL = new URL("./celld-esbuild.sh", import.meta.url);

export const CELLD_DRY_RUN_BUCKET = "s3://nteract-celld-dry-run";

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(`[celld-dry-run] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export function celldDryRunArgs(configPath = fileURLToPath(CONFIG_URL)) {
  return ["deploy", "--config", configPath, "--bucket", CELLD_DRY_RUN_BUCKET, "--dry-run"];
}

async function main() {
  const celldBinary = process.env.CELLD_BIN || "celld";
  const configPath = fileURLToPath(CONFIG_URL);
  const esbuildWrapperPath = fileURLToPath(ESBUILD_WRAPPER_URL);

  console.log(`[celld-dry-run] bundling ${configPath} with ${celldBinary}`);

  await run(celldBinary, celldDryRunArgs(configPath), {
    ...process.env,
    CELLD_ESBUILD: esbuildWrapperPath,
  });
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: fileURLToPath(APP_ROOT_URL),
      env,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        reject(new Error(`${command} was not found; install celld or set CELLD_BIN to its path`));
        return;
      }
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`celld exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

function isMainModule(importMetaUrl, scriptPath) {
  return Boolean(scriptPath && fileURLToPath(importMetaUrl) === resolve(scriptPath));
}
