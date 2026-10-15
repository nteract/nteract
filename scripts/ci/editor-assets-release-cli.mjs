#!/usr/bin/env node
// Trusted default-branch orchestration. Downloaded artifacts are data only;
// publishing never extracts/runs package scripts or checks out release source.
import {execFileSync} from 'node:child_process';
import {appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {releaseIdentity} from './npm-release.mjs';
import {assetNames, candidateName, digest, identityFromBuildTitle, positive, publishAssets, resolveEditorCandidate, resolveWasmCandidate, validateBuildRun, validateCandidate, validateWasm} from './editor-assets-release.mjs';
const env = process.env;
const repository = env.GITHUB_REPOSITORY;
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const apiBase = `${env.GITHUB_API_URL}/repos/${repository}`;
const headers = {Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json'};
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const output = (name, value) => appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
async function request(path, options = {}) {
  const response = await fetch(path.startsWith('https://') ? path : `${apiBase}${path}`, {signal: AbortSignal.timeout(120_000), ...options, headers: {...headers, ...options.headers}});
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response;
}
async function json(path) { return (await request(path)).json(); }
async function pages(path, key) {
  const results = [];
  for (let page = 1; ; page++) {
    const value = await json(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = key ? value[key] : value;
    if (!Array.isArray(items)) throw new Error('Invalid paginated GitHub response');
    results.push(...items);
    if (items.length < 100) return results;
  }
}
const run = (id, attempt) => json(`/actions/runs/${positive(id)}/attempts/${positive(attempt)}`);
const artifacts = id => pages(`/actions/runs/${positive(id)}/artifacts`, 'artifacts');
async function successfulJob(id, attempt, name) {
  const jobs = await pages(`/actions/runs/${positive(id)}/attempts/${positive(attempt)}/jobs`, 'jobs');
  return jobs.some(job => (job.name === name || job.name.endsWith(` / ${name}`)) && job.conclusion === 'success');
}
async function zipEntries(artifact, names) {
  const bytes = Buffer.from(await (await request(`/actions/artifacts/${positive(artifact.id)}/zip`)).arrayBuffer());
  if (`sha256:${digest(bytes)}` !== artifact.digest) throw new Error('Downloaded artifact digest mismatch');
  const temp = mkdtempSync(join(tmpdir(), 'editor-artifact-'));
  try {
    const path = join(temp, 'artifact.zip'); writeFileSync(path, bytes);
    // Read selected entries to stdout, never extract potentially executable files.
    const entries = execFileSync('unzip', ['-Z1', path], {encoding: 'utf8'}).trim().split('\n');
    const result = {};
    for (const name of names) {
      if (entries.filter(entry => entry === name).length !== 1) throw new Error(`Missing/duplicate artifact entry ${name}`);
      result[name] = execFileSync('unzip', ['-p', path, name], {maxBuffer: 512 * 1024 * 1024});
    }
    return result;
  } finally { rmSync(temp, {recursive: true, force: true}); }
}
async function upstream(identity) {
  const value = await run(identity.runId, identity.runAttempt);
  return releaseIdentity(value, {repository, runId: identity.runId, runAttempt: identity.runAttempt, sourceSha: identity.sourceSha});
}
async function wasmPlan(identity) {
  return resolveWasmCandidate(identity, {
    releaseRun: run, artifacts, successfulJob,
    readWasmReceipt: async artifact => JSON.parse((await zipEntries(artifact, ['release-wasm.json']))['release-wasm.json']),
  });
}
async function findEditor(identity, excludeCurrent = false) {
  return resolveEditorCandidate(identity, {
    repository, defaultBranch: event.repository.default_branch,
    buildRuns: () => pages('/actions/workflows/build-editor-assets.yml/runs', 'workflow_runs'),
    artifacts, successfulJob,
    readCandidate: async artifact => JSON.parse((await zipEntries(artifact, ['candidate.json']))['candidate.json']),
  }, excludeCurrent ? {runId: env.GITHUB_RUN_ID} : undefined);
}
function guardDefaultBranch() {
  if (env.GITHUB_REF !== `refs/heads/${event.repository.default_branch}`) throw new Error('Use the default-branch workflow');
}
const [command, ...args] = process.argv.slice(2);
if (command === 'prepare') {
  guardDefaultBranch();
  const automatic = env.GITHUB_EVENT_NAME === 'workflow_run';
  const identity = await upstream({runId: positive(automatic ? event.workflow_run.id : env.RELEASE_RUN_ID), runAttempt: positive(automatic ? event.workflow_run.run_attempt : env.RELEASE_RUN_ATTEMPT), sourceSha: automatic ? event.workflow_run.head_sha : undefined});
  const previous = await findEditor(identity, true);
  output('reuse', previous ? 'true' : 'false');
  if (previous) {
    output('artifact_id', previous.artifact.id);
    appendFileSync(env.GITHUB_STEP_SUMMARY, `Reusing immutable editor artifact ${previous.artifact.id}; no build or repack.\n`);
  } else {
    const plan = await wasmPlan(identity);
    writeJson(args[0], plan);
    for (const [name, value] of Object.entries({source_sha: plan.sourceSha, channel: plan.channel, wasm_artifact_id: plan.wasmArtifactId, release_run_id: plan.runId, version: plan.version, candidate_name: candidateName(plan)})) output(name, value);
  }
} else if (command === 'verify-wasm') {
  const plan = readJson(args[0]);
  const root = resolve(args[1]);
  const receipt = readJson(join(root, 'release-wasm.json'));
  validateWasm(receipt, plan);
  if (JSON.stringify(receipt) !== JSON.stringify(plan.wasm)) throw new Error('Downloaded WASM receipt mismatch');
  for (const [path, hash] of Object.entries(receipt.files)) {
    if (digest(readFileSync(join(root, path))) !== hash) throw new Error(`WASM byte mismatch: ${path}`);
  }
} else if (command === 'seal') {
  const plan = readJson(args[0]);
  const files = Object.fromEntries(assetNames(plan).map(name => [name, readFileSync(join(args[1], name))]));
  const candidate = {...plan, schema: 1, buildRunId: positive(env.GITHUB_RUN_ID), buildRunAttempt: positive(env.GITHUB_RUN_ATTEMPT), sha256: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)]))};
  validateCandidate(candidate, files);
  writeJson(join(args[1], 'candidate.json'), candidate);
} else if (command === 'publish') {
  guardDefaultBranch();
  const automatic = env.GITHUB_EVENT_NAME === 'workflow_run';
  const build = await run(automatic ? event.workflow_run.id : env.BUILD_RUN_ID, automatic ? event.workflow_run.run_attempt : env.BUILD_RUN_ATTEMPT);
  validateBuildRun(build, repository, event.repository.default_branch);
  if (build.status !== 'completed' || build.conclusion !== 'success') throw new Error('Editor workflow must have succeeded');
  const identity = await upstream(identityFromBuildTitle(build.display_title));
  const previous = await findEditor(identity);
  if (!previous) throw new Error('No successful packed editor candidate; publication never builds');
  const {candidate, artifact} = previous;
  // The successful read-only pack job verified and sealed the original WASM
  // receipt/digest. Its large input artifact may expire before this candidate.
  // Recheck job provenance without requiring that old storage record to exist.
  if (!await successfulJob(candidate.runId, candidate.wasm.runAttempt, 'Build WASM artifacts')) throw new Error('Original WASM build did not succeed');
  const files = await zipEntries(artifact, assetNames(candidate));
  const api = {
    repository,
    releaseRun: run,
    release: tag => json(`/releases/tags/${encodeURIComponent(tag)}`),
    assets: id => pages(`/releases/${positive(id)}/assets`),
    assetBytes: async id => Buffer.from(await (await request(`/releases/assets/${positive(id)}`, {headers: {Accept: 'application/octet-stream'}})).arrayBuffer()),
    tagSha: async tag => {
      let object = (await json(`/git/ref/tags/${encodeURIComponent(tag)}`)).object;
      for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = (await json(`/git/tags/${object.sha}`)).object;
      if (object.type !== 'commit') throw new Error('Release tag must resolve to a commit');
      return object.sha;
    },
    newerRelease: async (channel, version) => (await pages('/releases')).some(release => !release.draft && release.prerelease === (channel === 'nightly') && new RegExp(`^v\\d+\\.\\d+\\.\\d+-${channel}\\.\\d{12}$`).test(release.tag_name) && release.tag_name.slice(-12) > version.slice(-12)),
    upload: async (release, name, bytes) => {
      // Always upload without clobber: a concurrent conflicting name fails.
      const url = new URL(release.upload_url.replace(/\{.*$/, ''));
      if (url.origin !== 'https://uploads.github.com' || url.pathname !== `/repos/${repository}/releases/${release.id}/assets`) throw new Error('Unexpected upload URL');
      url.searchParams.set('name', name);
      await request(url.href, {method: 'POST', body: bytes, headers: {'Content-Type': 'application/octet-stream'}});
    },
  };
  const result = await publishAssets(candidate, files, api);
  appendFileSync(env.GITHUB_STEP_SUMMARY, `Editor assets ${result}: v${candidate.version}, source ${candidate.sourceSha}, release ${candidate.runId}/${candidate.runAttempt}, build ${candidate.buildRunId}/${candidate.buildRunAttempt}, artifact ${artifact.id} (${artifact.digest}). Verified both uploaded byte hashes.\n`);
} else throw new Error(`Unknown editor release command: ${command}`);
