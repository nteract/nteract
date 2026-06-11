#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const APP_ROOT_URL = new URL("../", import.meta.url);
const CONFIG_URL = new URL("../wrangler.toml", import.meta.url);
const GENERATED_CONFIG_URL = new URL(`../wrangler.deploy.${process.pid}.toml`, import.meta.url);
const BUILD_SHA_VAR = "NOTEBOOK_CLOUD_BUILD_SHA";

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(`[deploy-main] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

async function main() {
  const sha = await resolveBuildSha(process.env);
  const config = await readFile(CONFIG_URL, "utf8");
  const generatedConfig = withBuildShaVar(config, sha);
  const generatedConfigPath = fileURLToPath(GENERATED_CONFIG_URL);

  await writeFile(GENERATED_CONFIG_URL, generatedConfig);
  console.log(`[deploy-main] deploying ${normalizedBuildSha(sha)} from ${generatedConfigPath}`);

  try {
    await runWrangler(["deploy", "-c", generatedConfigPath]);
  } finally {
    await rm(GENERATED_CONFIG_URL, { force: true });
  }
}

export async function resolveBuildSha(env = process.env, execFileImpl = execFile) {
  const explicitSha = env.NOTEBOOK_CLOUD_BUILD_SHA || env.GITHUB_SHA;
  if (explicitSha) {
    return normalizedBuildSha(explicitSha);
  }

  const { stdout } = await execFileImpl("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    encoding: "utf8",
  });
  return normalizedBuildSha(stdout);
}

export function withBuildShaVar(config, sha) {
  const normalizedSha = normalizedBuildSha(sha);
  const eol = config.includes("\r\n") ? "\r\n" : "\n";
  const lines = config.split(/\r?\n/);
  const varsIndex = lines.findIndex((line) => line.trim() === "[vars]");
  const buildShaLine = `${BUILD_SHA_VAR} = "${normalizedSha}"`;

  if (varsIndex === -1) {
    const base = config.replace(/[\r\n]*$/, "");
    return `${base}${eol}${eol}[vars]${eol}${buildShaLine}${eol}`;
  }

  const nextSectionIndex = lines.findIndex(
    (line, index) => index > varsIndex && line.trim().startsWith("["),
  );
  const varsEndIndex = nextSectionIndex === -1 ? lines.length : nextSectionIndex;

  for (let index = varsIndex + 1; index < varsEndIndex; index += 1) {
    if (new RegExp(`^\\s*${BUILD_SHA_VAR}\\s*=`).test(lines[index])) {
      lines[index] = buildShaLine;
      return ensureTrailingNewline(lines.join(eol), eol);
    }
  }

  let insertIndex = varsEndIndex;
  while (insertIndex > varsIndex + 1 && lines[insertIndex - 1]?.trim() === "") {
    insertIndex -= 1;
  }

  lines.splice(insertIndex, 0, buildShaLine);
  return ensureTrailingNewline(lines.join(eol), eol);
}

export function normalizedBuildSha(value) {
  const trimmed = String(value ?? "").trim();
  if (!/^[0-9a-f]{7,40}$/i.test(trimmed)) {
    throw new Error(`${BUILD_SHA_VAR} must be a 7-40 character hexadecimal git SHA`);
  }
  return trimmed.toLowerCase();
}

function runWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "wrangler.cmd" : "wrangler", args, {
      cwd: fileURLToPath(APP_ROOT_URL),
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`wrangler exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

function ensureTrailingNewline(value, eol) {
  return value.endsWith(eol) ? value : `${value}${eol}`;
}

function isMainModule(importMetaUrl, scriptPath) {
  return Boolean(scriptPath && fileURLToPath(importMetaUrl) === resolve(scriptPath));
}
