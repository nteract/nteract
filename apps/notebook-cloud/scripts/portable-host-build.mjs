#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_OUTPUT = fileURLToPath(new URL("../dist-portable/", import.meta.url));

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(
      `[portable-host-build] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

async function main() {
  const options = parsePortableBuildArgs(process.argv.slice(2));
  const outputDir = resolve(options.output ?? DEFAULT_OUTPUT);
  const startedAt = performance.now();

  if (!options.skipApplicationBuild) {
    await run("pnpm", ["--dir", APP_ROOT, "run", "build"], REPO_ROOT);
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(resolve(outputDir, "worker"), { recursive: true });
  await cp(resolve(APP_ROOT, "dist"), resolve(outputDir, "assets"), { recursive: true });

  const workerPath = resolve(outputDir, "worker/index.js");
  const metafilePath = resolve(outputDir, "worker/esbuild-meta.json");
  await run(
    "pnpm",
    [
      "--dir",
      APP_ROOT,
      "exec",
      "esbuild",
      resolve(APP_ROOT, "src/portable-worker-entry.ts"),
      "--bundle",
      "--format=esm",
      "--platform=browser",
      "--target=es2024",
      "--conditions=workerd,worker,browser",
      "--external:node:*",
      "--external:cloudflare:*",
      "--loader:.wasm=copy",
      "--asset-names=[name]-[hash]",
      `--outfile=${workerPath}`,
      `--metafile=${metafilePath}`,
    ],
    REPO_ROOT,
  );

  const [commit, workerBytes, workerModules, assets] = await Promise.all([
    gitOutput(["rev-parse", "HEAD"]),
    readFile(workerPath),
    workerModuleDigest(resolve(outputDir, "worker")),
    directoryDigest(resolve(outputDir, "assets")),
  ]);
  const configuration = {
    entry: "src/portable-worker-entry.ts",
    format: "esm",
    platform: "browser",
    target: "es2024",
    conditions: ["workerd", "worker", "browser"],
    wasmLoader: "copy",
  };
  const manifest = {
    schema_version: 1,
    commit: commit.trim(),
    configuration,
    configuration_sha256: sha256(JSON.stringify(configuration)),
    worker: {
      path: "worker/index.js",
      bytes: workerBytes.byteLength,
      sha256: sha256(workerBytes),
      modules: workerModules,
    },
    assets,
    elapsed_ms: Math.round(performance.now() - startedAt),
  };
  await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ output: outputDir, ...manifest }));
}

async function workerModuleDigest(directory) {
  const { readdir } = await import("node:fs/promises");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".wasm"))
    .sort((left, right) => left.localeCompare(right));
  const modules = [];
  for (const name of names) {
    const bytes = await readFile(resolve(directory, name));
    modules.push({ path: `worker/${name}`, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  if (modules.length === 0) {
    throw new Error("portable Worker build did not emit a compiled WASM module");
  }
  return modules;
}

export function parsePortableBuildArgs(args) {
  const options = { output: undefined, skipApplicationBuild: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--skip-application-build") {
      options.skipApplicationBuild = true;
      continue;
    }
    if (argument === "--output") {
      options.output = requiredValue(args, ++index, argument);
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function directoryDigest(directory) {
  const entries = [];
  await walk(directory, directory, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    sha256: sha256(entries.map((entry) => `${entry.path}\0${entry.sha256}`).join("\n")),
  };
}

async function walk(root, directory, entries) {
  const { readdir } = await import("node:fs/promises");
  const children = await readdir(directory, { withFileTypes: true });
  for (const child of children) {
    const childPath = resolve(directory, child.name);
    if (child.isDirectory()) {
      await walk(root, childPath, entries);
      continue;
    }
    if (!child.isFile()) {
      throw new Error(`portable assets include a non-file entry: ${childPath}`);
    }
    const [bytes, info] = await Promise.all([readFile(childPath), stat(childPath)]);
    entries.push({
      path: childPath.slice(root.length + 1),
      bytes: info.size,
      sha256: sha256(bytes),
    });
  }
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

async function gitOutput(args) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd: REPO_ROOT, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredValue(args, index, name) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function isMainModule(importMetaUrl, scriptPath) {
  return Boolean(scriptPath && fileURLToPath(importMetaUrl) === resolve(scriptPath));
}
