import {createHash} from 'node:crypto';
import {releaseIdentity} from './npm-release.mjs';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const positive = value => {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error('Expected a positive run or artifact ID');
  return String(value);
};
export const candidateName = identity => `editor-assets-${positive(identity.runId)}-${positive(identity.runAttempt)}`;
export const buildTitle = identity => `Editor assets for release ${positive(identity.runId)}/${positive(identity.runAttempt)}`;
export const assetNames = identity => [`notebook-cloud-assets-${identity.channel}.tar.gz`, `notebook-cloud-assets-${identity.channel}.tar.gz.sha256`];
export function validateWasm(receipt, identity) {
  for (const key of ['sourceSha', 'channel', 'runId']) {
    if (receipt[key] !== identity[key]) throw new Error(`WASM identity mismatch: ${key}`);
  }
  if (BigInt(positive(receipt.runAttempt)) > BigInt(identity.runAttempt)) throw new Error('WASM was built after the requested release attempt');
  if (!new RegExp(`^\\d+\\.\\d+\\.\\d+-${identity.channel}\\.\\d{12}$`).test(receipt.version)) throw new Error('Invalid release version');
  if (receipt.schema !== 1 || !receipt.files || !Object.keys(receipt.files).length) throw new Error('Missing WASM byte manifest');
  for (const [path, hash] of Object.entries(receipt.files)) {
    if (!/^(apps\/notebook\/src\/(wasm\/runtimed-wasm|renderer-plugins)|crates\/sift-wasm\/pkg|packages\/sift\/public\/wasm|target\/xtask)\//.test(path) || path.split('/').some(part => part === '..' || !part) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid WASM manifest entry');
  }
  return receipt;
}
export function validateArtifact(artifact, run, name) {
  if (artifact.name !== name || String(artifact.workflow_run?.id) !== String(run.id) || artifact.workflow_run?.head_sha !== run.head_sha) throw new Error('Artifact origin mismatch');
  if (artifact.expired) throw new Error('Immutable artifact expired; create a new release candidate, never rebuild this identity');
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) throw new Error('Missing artifact SHA-256');
  return artifact;
}
export function validateBuildRun(run, repository, defaultBranch) {
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository || run.path !== '.github/workflows/build-editor-assets.yml' || run.head_branch !== defaultBranch || !['workflow_run', 'workflow_dispatch'].includes(run.event)) throw new Error('Untrusted editor build run');
}
export function validateCandidate(candidate, files) {
  if (candidate.schema !== 1) throw new Error('Unknown editor candidate schema');
  positive(candidate.buildRunId); positive(candidate.buildRunAttempt);
  const names = assetNames(candidate);
  if (JSON.stringify(Object.keys(candidate.sha256 ?? {}).sort()) !== JSON.stringify(names.sort())) throw new Error('Unexpected editor asset inventory');
  for (const name of names) {
    if (!files[name] || digest(files[name]) !== candidate.sha256[name]) throw new Error(`Editor asset checksum mismatch: ${name}`);
  }
  if (files[names.find(name => name.endsWith('.sha256'))].toString() !== `${candidate.sha256[names.find(name => name.endsWith('.gz'))]}  ${names.find(name => name.endsWith('.gz'))}\n`) throw new Error('Invalid editor sidecar');
  return candidate;
}
// api is deliberately injectable: tests exercise ordering, interrupted pair
// uploads, exact-byte retries and stale protection against an in-memory server.
export async function publishAssets(candidate, files, api) {
  validateCandidate(candidate, files);
  const run = await api.releaseRun(candidate.runId, candidate.runAttempt);
  const identity = releaseIdentity(run, {runId: candidate.runId, runAttempt: candidate.runAttempt, repository: api.repository, sourceSha: candidate.sourceSha});
  validateWasm(candidate.wasm, identity);
  if (candidate.version !== candidate.wasm.version || candidate.channel !== identity.channel) throw new Error('Editor candidate release mismatch');
  const release = await api.release(`v${candidate.version}`);
  if (release.draft || release.prerelease !== (identity.channel === 'nightly') || await api.tagSha(release.tag_name) !== identity.sourceSha) throw new Error('Published release/tag does not match candidate');
  const names = assetNames(candidate);
  const existing = await api.assets(release.id);
  const missing = [];
  // Compare ALL existing bytes before creating either asset. Never clobber.
  for (const name of names) {
    const matches = existing.filter(asset => asset.name === name);
    if (matches.length > 1) throw new Error('Duplicate release asset');
    if (!matches.length) missing.push(name);
    else if (digest(await api.assetBytes(matches[0].id)) !== candidate.sha256[name]) throw new Error(`Existing release asset differs: ${name}`);
  }
  if (missing.length && await api.newerRelease(identity.channel, candidate.version)) throw new Error('Candidate is stale; refusing to complete older channel assets');
  for (const name of missing) await api.upload(release, name, files[name]);
  // An upload response alone is not acceptance: fetch and hash the public pair.
  const result = await api.assets(release.id);
  for (const name of names) {
    const asset = result.find(entry => entry.name === name);
    if (!asset || digest(await api.assetBytes(asset.id)) !== candidate.sha256[name]) throw new Error(`Published asset verification failed: ${name}`);
  }
  return missing.length ? 'published' : 'existing';
}

export async function resolveEditorCandidate(identity, api, current) {
  let completedPack = false;
  for (const build of await api.buildRuns()) {
    if (build.display_title !== buildTitle(identity)) continue;
    validateBuildRun(build, api.repository, api.defaultBranch);
    const matches = (await api.artifacts(build.id)).filter(item => item.name === candidateName(identity));
    if (matches.length > 1) throw new Error('Duplicate immutable editor candidate');
    if (matches.length) {
      const artifact = validateArtifact(matches[0], build, candidateName(identity));
      const candidate = await api.readCandidate(artifact);
      if (String(build.id) !== candidate.buildRunId || candidateName(candidate) !== candidateName(identity)) throw new Error('Editor candidate origin mismatch');
      if (!await api.successfulJob(build.id, candidate.buildRunAttempt, 'Pack editor assets')) throw new Error('Packed bytes exist but their build job did not succeed; refusing to rebuild or publish');
      return {artifact, candidate};
    }
    for (let attempt = Number(build.run_attempt) - (String(build.id) === current?.runId ? 1 : 0); attempt >= 1; attempt--) {
      if (await api.successfulJob(build.id, attempt, 'Pack editor assets')) completedPack = true;
    }
  }
  if (completedPack) throw new Error('Successful editor candidate artifact missing/expired; create a new release candidate, never rebuild this identity');
  return null;
}
