#!/usr/bin/env node
// Default-branch orchestration only. Publisher artifacts are parsed as data;
// package code is executed only by the producer's unprivileged consumer test.
import {execFileSync} from "node:child_process";
import {appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {releaseIdentity, registryPackage} from "./npm-release.mjs";
import {positive, successfulJobAtAttempt, validateWasm} from "./editor-assets-release.mjs";
import {candidateName, digest, packJobStatusAtAttempt, resolveCandidate, resolveWasmPlan, seal, tarballName, validatePacked, wasmPublicationDecision} from "./npm-wasm-release.mjs";

const env = process.env;
const [command, ...args] = process.argv.slice(2);
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const output = (name, value) => appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
const summary = value => appendFileSync(env.GITHUB_STEP_SUMMARY, `${value}\n`);

if (command === "seal") {
  writeJson(join(args[1], "candidate.json"), seal(readJson(args[0]), readFileSync(join(args[1], tarballName)), env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT));
} else if (command === "publish") {
  // No checkout, dependency install, source build, or lifecycle scripts here.
  if (env.NPM_WASM_ENABLED !== "true") throw new Error("WASM npm publication gate is disabled");
  const candidate = readJson(join(args[0], "candidate.json"));
  const tarball = join(args[0], tarballName);
  const bytes = readFileSync(tarball);
  const {manifest} = validatePacked(candidate, bytes);
  const npmVersion = execFileSync("npm", ["--version"], {encoding: "utf8"}).trim();
  if (!/^\d+\.\d+\.\d+$/.test(npmVersion)) throw new Error("Invalid npm CLI version");
  const version = npmVersion.split(".").map(Number);
  if (version[0] < 11 || (version[0] === 11 && (version[1] < 5 || (version[1] === 5 && version[2] < 1)))) throw new Error("npm 11.5.1 or newer is required for trusted publishing");
  const decision = wasmPublicationDecision(candidate, bytes, await registryPackage(manifest.name));
  if (decision === "publish") {
    execFileSync("npm", ["publish", tarball, "--tag", candidate.plan.distTag, "--access", "public", "--provenance", "--ignore-scripts"], {stdio: "inherit"});
    let verified = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (wasmPublicationDecision(candidate, bytes, await registryPackage(manifest.name)) === "existing") { verified = true; break; }
      await sleep(5000);
    }
    if (!verified) throw new Error("Published WASM tarball integrity has not appeared in registry metadata; retry this retained candidate");
  }
  summary(`@runtimed/wasm@${manifest.version}: **${decision === "existing" ? "existing" : "published"}**; verified immutable integrity ${candidate.integrity}; source ${candidate.plan.sourceSha}.`);
} else {
  const event = readJson(env.GITHUB_EVENT_PATH);
  const repository = env.GITHUB_REPOSITORY;
  if (env.GITHUB_REF !== `refs/heads/${event.repository.default_branch}`) throw new Error("Use the default-branch workflow");
  const apiBase = `${env.GITHUB_API_URL}/repos/${repository}`;
  async function request(path) {
    const response = await fetch(`${apiBase}${path}`, {signal: AbortSignal.timeout(120_000), headers: {Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json"}});
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
    return response;
  }
  async function json(path) { return (await request(path)).json(); }
  async function pages(path, key) {
    const results = [];
    for (let page = 1; ; page++) {
      const value = await json(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(value[key])) throw new Error("Invalid GitHub pagination");
      results.push(...value[key]);
      if (value[key].length < 100) return results;
    }
  }
  const run = (id, attempt) => json(`/actions/runs/${positive(id)}/attempts/${positive(attempt)}`);
  const artifacts = id => pages(`/actions/runs/${positive(id)}/artifacts`, "artifacts");
  const jobs = (id, attempt) => pages(`/actions/runs/${positive(id)}/attempts/${positive(attempt)}/jobs`, "jobs");
  const successfulJob = async (id, attempt, name) => successfulJobAtAttempt(await jobs(id, attempt), attempt, name);
  async function entries(artifact, names) {
    const bytes = Buffer.from(await (await request(`/actions/artifacts/${positive(artifact.id)}/zip`)).arrayBuffer());
    if (`sha256:${digest(bytes)}` !== artifact.digest) throw new Error("GitHub artifact digest mismatch");
    const temp = mkdtempSync(join(tmpdir(), "npm-wasm-artifact-"));
    try {
      const path = join(temp, "artifact.zip");
      writeFileSync(path, bytes);
      const listing = execFileSync("unzip", ["-Z1", path], {encoding: "utf8"}).trim().split("\n");
      return Object.fromEntries(names.map(name => {
        if (listing.filter(entry => entry === name).length !== 1) throw new Error(`Missing/duplicate artifact entry ${name}`);
        return [name, execFileSync("unzip", ["-p", path, name], {maxBuffer: 128 * 1024 * 1024})];
      }));
    } finally { rmSync(temp, {recursive: true, force: true}); }
  }
  const automatic = env.GITHUB_EVENT_NAME === "workflow_run";
  const runId = positive(automatic ? event.workflow_run.id : env.RELEASE_RUN_ID);
  const runAttempt = positive(automatic ? event.workflow_run.run_attempt : env.RELEASE_RUN_ATTEMPT);
  const upstreamRun = await run(runId, runAttempt);
  const identity = releaseIdentity(upstreamRun, {repository, runId, runAttempt, sourceSha: automatic ? event.workflow_run.head_sha : undefined});
  // Historical releases without this new source package stay eligible for all
  // existing publishers; the additive WASM producer/publisher skips them.
  const sourceResponse = await fetch(`${apiBase}/contents/packages/runtimed-wasm/package.json?ref=${identity.sourceSha}`, {signal: AbortSignal.timeout(30_000), headers: {Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json"}});
  if (sourceResponse.status === 404) {
    output("present", "false");
    summary("Upstream source predates @runtimed/wasm; skipping the WASM package.");
    process.exit(0);
  }
  if (!sourceResponse.ok) throw new Error(`Source manifest lookup: HTTP ${sourceResponse.status}`);
  const sourceData = await sourceResponse.json();
  if (sourceData.encoding !== "base64") throw new Error("Invalid source manifest encoding");
  const sourceManifest = JSON.parse(Buffer.from(sourceData.content, "base64"));
  if (sourceManifest.name !== "@runtimed/wasm") throw new Error("Unexpected source package");
  output("present", "true");
  const candidateApi = {
    repository, defaultBranch: event.repository.default_branch,
    // A producer cannot predate its upstream release. Bound repeated polling
    // without excluding earlier producer retries for the same release identity.
    buildRuns: () => pages(`/actions/workflows/build-wasm-npm.yml/runs?created=${encodeURIComponent(`>=${upstreamRun.created_at}`)}`, "workflow_runs"),
    artifacts, successfulJob,
    packJobStatus: async (id, attempt) => packJobStatusAtAttempt(await jobs(id, attempt), attempt),
    readCandidate: async artifact => JSON.parse((await entries(artifact, ["candidate.json"]))["candidate.json"]),
  };
  if (command === "prepare") {
    const previous = await resolveCandidate(identity, candidateApi, {runId: env.GITHUB_RUN_ID});
    output("reuse", previous ? "true" : "false");
    if (previous) {
      summary(`Reusing successful WASM npm artifact ${previous.artifact.id}; no repack.`);
    } else {
      const plan = await resolveWasmPlan(sourceManifest, identity, upstreamRun, {
        artifacts, successfulJob,
        readReceipt: async artifact => JSON.parse((await entries(artifact, ["release-wasm.json"]))["release-wasm.json"]),
      });
      writeJson(args[0], plan);
      for (const [key, value] of Object.entries({source_sha: plan.sourceSha, wasm_artifact_id: plan.wasmArtifactId, release_run_id: runId, candidate_name: candidateName(plan), plan_name: `npm-wasm-plan-${env.GITHUB_RUN_ATTEMPT}`})) output(key, value);
    }
  } else if (command === "resolve-publish") {
    // Producer and existing npm workflow both follow the release. Wait only in
    // this independent job; no existing npm publisher depends on this wait.
    const deadline = Date.now() + 30 * 60 * 1000;
    let previous;
    do {
      previous = await resolveCandidate(identity, candidateApi);
      if (previous) break;
      if (Date.now() >= deadline) throw new Error("No completed WASM npm candidate; inspect Build WASM npm package, then retry this publisher");
      await sleep(30_000);
    } while (!previous);
    const {candidate, artifact} = previous;
    if (candidate.plan.baseVersion !== sourceManifest.version) throw new Error("WASM candidate source version mismatch");
    // The successful producer sealed the original artifact identity and every
    // shipped byte. Its older input artifact need not still exist after packing.
    validateWasm(candidate.plan.wasm, identity);
    const files = await entries(artifact, ["candidate.json", tarballName]);
    validatePacked(candidate, files[tarballName]);
    mkdirSync(args[0], {recursive: true});
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(args[0], name), bytes);
    summary(`Verified retained WASM npm artifact ${artifact.id} (${artifact.digest}), producer ${candidate.buildRunId}/${candidate.buildRunAttempt}, release ${runId}/${runAttempt}.`);
  } else throw new Error(`Unknown WASM release command: ${command}`);
}
