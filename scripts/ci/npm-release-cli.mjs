#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  nativeTargets,
  finalizePackedManifest,
  packageName,
  publishPackage,
  releaseIdentity,
  releasePlan,
  stampManifest,
  stampBuildManifest,
  verifyManifest,
} from "./npm-release.mjs";

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
const [command, ...args] = process.argv.slice(2);

if (command === "resolve") {
  const event = readJson(process.env.GITHUB_EVENT_PATH);
  const automatic = process.env.GITHUB_EVENT_NAME === "workflow_run";
  if (!automatic && process.env.GITHUB_REF !== `refs/heads/${event.repository.default_branch}`) {
    throw new Error("Manual npm publication must use the default-branch publisher workflow");
  }
  const runId = String(automatic ? event.workflow_run.id : process.env.RELEASE_RUN_ID);
  const runAttempt = String(automatic ? event.workflow_run.run_attempt : process.env.RELEASE_RUN_ATTEMPT);
  if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(runAttempt)) {
    throw new Error("A numeric upstream release run ID and attempt are required");
  }
  const response = await fetch(`${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`, {
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`Release run lookup failed: HTTP ${response.status}`);
  const identity = releaseIdentity(await response.json(), {
    repository: process.env.GITHUB_REPOSITORY,
    runId,
    runAttempt,
    sourceSha: automatic ? event.workflow_run.head_sha : undefined,
  });
  writeJson(args[0], identity);
  output("source_sha", identity.sourceSha);
  output("channel", identity.channel);
  output("run_id", identity.runId);
  output("run_attempt", identity.runAttempt);
} else if (command === "plan") {
  const identity = readJson(args[0]);
  const sourceManifest = readJson(args[1]);
  const plan = releasePlan(sourceManifest.version, identity, process.env.NPM_LINUX_ARM64_ENABLED, process.env.NPM_WINDOWS_ARM64_ENABLED);
  writeJson(args[2], plan);
  output("version", plan.version);
  output("dist_tag", plan.distTag);
  output("linux_arm64_enabled", String(plan.nativeTargets.includes("linux-arm64-gnu")));
  output("windows_arm64_enabled", String(plan.nativeTargets.includes("win32-arm64-msvc")));
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Node release: **${plan.version}** → **${plan.distTag}**, source \`${plan.sourceSha}\`, upstream run ${plan.runId} (attempt ${plan.runAttempt}).\n`);
} else if (command === "stamp" || command === "stamp-build") {
  const plan = readJson(args[0]);
  const root = args[1];
  for (const target of ["wrapper", ...nativeTargets]) {
    const path = target === "wrapper" ? join(root, "package.json") : join(root, "npm", target, "package.json");
    const stamp = command === "stamp-build" ? stampBuildManifest : stampManifest;
    writeJson(path, stamp(readJson(path), plan, target));
  }
} else if (command === "stamp-tarball") {
  const [planPath, target, directory] = args;
  const plan = readJson(planPath);
  const tarballs = readdirSync(directory).filter(path => path.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`Expected exactly one package tarball, found ${tarballs.length}`);
  const tarball = join(directory, tarballs[0]);
  const temporary = mkdtempSync(join(directory, ".npm-release-"));
  try {
    // Preserve pnpm's payload, license inclusion and lifecycle-script removal.
    // Only the packed manifest changes; the installed workspace stays intact.
    execFileSync("tar", ["-xzf", tarball, "-C", temporary]);
    const manifestPath = join(temporary, "package", "package.json");
    writeJson(manifestPath, finalizePackedManifest(readJson(manifestPath), plan, target));
    const finalized = join(temporary, "finalized.tgz");
    execFileSync("tar", ["-czf", finalized, "-C", temporary, "package"]);
    renameSync(finalized, tarball);
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
} else if (command === "verify") {
  verifyManifest(readJson(args[2]), readJson(args[0]), args[1]);
} else if (command === "smoke") {
  const [planPath, target, directory] = args;
  const plan = readJson(planPath);
  delete process.env.RUNTIMED_SOCKET_PATH;
  delete process.env.RUNTIMED_DEV;
  delete process.env.RUNTIMED_WORKSPACE_PATH;
  const require = createRequire(join(directory, "package.json"));
  const binding = require(packageName(target));
  const socket = binding.defaultSocketPath();
  if (socket !== binding.socketPathForChannel(plan.channel)) {
    throw new Error(`Installed native package has the wrong compiled channel: ${socket}`);
  }
  console.log(`Installed ${packageName(target)} loads and defaults to ${plan.channel}: ${socket}`);
} else if (command === "publish") {
  const [planPath, target, directory] = args;
  const plan = readJson(planPath);
  const tarballs = readdirSync(directory).filter(path => path.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`Expected exactly one package tarball, found ${tarballs.length}`);
  const tarball = join(directory, tarballs[0]);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  const minimum = process.env.NPM_TRUSTED_PUBLISHING_MIN_VERSION ?? "11.5.1";
  const versionTuple = value => value.split(".").map(Number);
  const current = versionTuple(npmVersion);
  const required = versionTuple(minimum);
  if (current.some(Number.isNaN) || current.length !== 3) throw new Error(`Invalid npm version ${npmVersion}`);
  for (let index = 0; index < 3; index++) {
    if (current[index] > required[index]) break;
    if (current[index] < required[index]) throw new Error(`npm ${npmVersion} is older than ${minimum}`);
  }
  const result = await publishPackage(manifest, plan, target, {
    publish() {
      // OIDC supports publish, not npm dist-tag. Workflow concurrency serializes
      // these preflight/publish pairs; no publish lifecycle scripts run here.
      execFileSync("npm", ["publish", tarball, "--tag", plan.distTag, "--access", "public", "--provenance", "--ignore-scripts"], { stdio: "inherit" });
    },
  });
  console.log(`${manifest.name}@${manifest.version}: ${result.status}; existing versions leave dist-tags unchanged.`);
  const registrySource = result.registryRelease?.sourceSha;
  const sourceLabel = typeof registrySource === "string" && /^[a-f0-9]{40}$/.test(registrySource)
    ? registrySource : "unrecorded";
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- \`${manifest.name}@${manifest.version}\`: **${result.status}**; registry source: \`${sourceLabel}\`.\n`);
  mkdirSync(join(process.env.RUNNER_TEMP, "npm-result"), { recursive: true });
  writeJson(join(process.env.RUNNER_TEMP, "npm-result", `${target}.json`), result);
} else {
  throw new Error(`Unknown npm release command: ${command}`);
}
