import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {assetNames, buildTitle, candidateName, digest, publishAssets, resolveEditorCandidate, validateWasm} from '../ci/editor-assets-release.mjs';
const identity = {sourceSha: 'a'.repeat(40), channel: 'nightly', runId: '123', runAttempt: '2'};
const wasm = {...identity, schema: 1, version: '0.7.6-nightly.202610151200', runAttempt: '1', files: {'apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm': 'b'.repeat(64)}};
const names = assetNames(identity);
const files = {[names[0]]: Buffer.from('packed bytes')};
files[names[1]] = Buffer.from(`${digest(files[names[0]])}  ${names[0]}\n`);
const candidate = {...identity, schema: 1, wasm, version: wasm.version, buildRunId: '456', buildRunAttempt: '1', sha256: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)]))};
function server() {
  const calls = [], assets = [];
  const bytes = new Map();
  const api = {
    repository: 'nteract/nteract',
    releaseRun: async (id, attempt) => {
      calls.push(`release:${id}/${attempt}`);
      return {id: Number(id), run_attempt: Number(attempt), repository: {full_name: api.repository}, head_repository: {full_name: api.repository}, head_sha: identity.sourceSha, path: '.github/workflows/release-nightly.yml', event: 'schedule', status: 'completed', conclusion: 'success'};
    },
    release: async tag => { calls.push(`tag:${tag}`); return {id: 789, tag_name: tag, draft: false, prerelease: true}; },
    tagSha: async () => identity.sourceSha,
    assets: async () => { calls.push('list'); return assets; },
    assetBytes: async id => { calls.push(`download:${id}`); return bytes.get(id); },
    newerRelease: async () => { calls.push('stale-check'); return false; },
    upload: async (release, name, data) => { calls.push(`upload:${name}`); const id = assets.length + 1; assets.push({id, name}); bytes.set(id, data); },
  };
  return {api, calls, assets, bytes};
}
test('publish uploads the packed bytes once, then verifies both remote hashes; retry only reads', async () => {
  const {api, calls, bytes} = server();
  assert.equal(await publishAssets(candidate, files, api), 'published');
  assert.deepEqual([...bytes.values()], Object.values(files));
  assert.ok(calls.indexOf('stale-check') < calls.indexOf(`upload:${names[0]}`));
  assert.deepEqual(calls.slice(-3), ['list', 'download:1', 'download:2']);
  calls.length = 0;
  assert.equal(await publishAssets(candidate, files, api), 'existing');
  assert.ok(!calls.some(call => call.startsWith('upload:')));
});
test('interrupted pair upload retries only the missing sidecar using original bytes', async () => {
  const {api, calls} = server(); const upload = api.upload;
  api.upload = async (...args) => { if (args[1].endsWith('.sha256')) throw new Error('network interruption'); return upload(...args); };
  await assert.rejects(publishAssets(candidate, files, api), /network interruption/);
  api.upload = upload; calls.length = 0;
  await publishAssets(candidate, files, api);
  assert.deepEqual(calls.filter(call => call.startsWith('upload:')), [`upload:${names[1]}`]);
});
test('an existing different byte fails before any upload, never clobbers', async () => {
  const {api, calls, assets, bytes} = server(); assets.push({id: 1, name: names[1]}); bytes.set(1, Buffer.from('wrong checksum'));
  await assert.rejects(publishAssets(candidate, files, api), /Existing release asset differs/);
  assert.ok(!calls.some(call => call.startsWith('upload:')));
});
test('newer channel release rejects missing older assets but exact complete retries remain valid', async () => {
  const {api} = server(); api.newerRelease = async () => true;
  await assert.rejects(publishAssets(candidate, files, api), /stale/);
  api.newerRelease = async () => false; await publishAssets(candidate, files, api);
  api.newerRelease = async () => true;
  assert.equal(await publishAssets(candidate, files, api), 'existing');
});
test('failed upstream, mismatched tag/source, or changed local bytes cannot upload', async () => {
  const {api, calls} = server();
  const releaseRun = api.releaseRun;
  api.releaseRun = async (...args) => ({...await releaseRun(...args), conclusion: 'failure'});
  await assert.rejects(publishAssets(candidate, files, api), /successfully/);
  api.releaseRun = releaseRun; api.tagSha = async () => 'b'.repeat(40);
  await assert.rejects(publishAssets(candidate, files, api), /does not match/);
  await assert.rejects(publishAssets(candidate, {...files, [names[0]]: Buffer.from('repacked')}, api), /checksum/);
  assert.ok(!calls.some(call => call.startsWith('upload:')));
});
function buildServer() {
  const build = {id: 456, run_attempt: 1, display_title: buildTitle(identity), repository: {full_name: 'nteract/nteract'}, head_repository: {full_name: 'nteract/nteract'}, head_branch: 'main', head_sha: 'c'.repeat(40), path: '.github/workflows/build-editor-assets.yml', event: 'workflow_run'};
  const artifact = {id: 10, name: candidateName(identity), workflow_run: {id: 456, head_sha: build.head_sha}, expired: false, digest: `sha256:${'d'.repeat(64)}`};
  const api = {repository: 'nteract/nteract', defaultBranch: 'main', buildRuns: async () => [build], artifacts: async () => [artifact], readCandidate: async () => candidate, successfulJob: async () => true};
  return {api, artifact, build};
}
test('duplicate events and reruns reuse the same immutable candidate including an earlier attempt of the current build run', async () => {
  const {api, build} = buildServer();
  const first = await resolveEditorCandidate(identity, api);
  build.run_attempt = 2;
  const retry = await resolveEditorCandidate(identity, api, {runId: '456'});
  assert.deepEqual(retry, first);
});
test('expired/deleted successful artifacts fail closed rather than requesting a rebuild', async () => {
  const {api, artifact} = buildServer(); artifact.expired = true;
  await assert.rejects(resolveEditorCandidate(identity, api), /expired/);
  api.artifacts = async () => [];
  await assert.rejects(resolveEditorCandidate(identity, api), /missing\/expired/);
});
test('only an incomplete build with no packed artifact can be retried', async () => {
  const {api} = buildServer(); api.successfulJob = async () => false;
  await assert.rejects(resolveEditorCandidate(identity, api), /Packed bytes exist/);
  api.artifacts = async () => [];
  assert.equal(await resolveEditorCandidate(identity, api), null);
});
test('untrusted workflow artifacts and future WASM attempts are rejected', async () => {
  const {api, build} = buildServer(); build.head_repository.full_name = 'attacker/fork';
  await assert.rejects(resolveEditorCandidate(identity, api), /Untrusted/);
  assert.throws(() => validateWasm({...wasm, runAttempt: '3'}, identity), /after/);
  assert.equal(validateWasm(wasm, identity), wasm);
});
test('workflow separates optional builds from release and all publishing from builds', () => {
  const read = name => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
  const release = read('release-common'), build = read('build-editor-assets'), publish = read('publish-editor-assets');
  assert.doesNotMatch(release, /build-notebook-cloud-assets|notebook-cloud-assets/);
  assert.match(release, /name: release-wasm-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}\n\s+retention-days: 90/);
  assert.doesNotMatch(build, /contents: write|id-token: write|cargo xtask wasm|artifacts ensure/);
  assert.match(build, /needs.resolve.outputs.reuse != 'true'/);
  assert.match(build, /artifacts verify runtime sift renderer/);
  assert.doesNotMatch(publish.replace(/^#.*$/gm, ""), /pnpm|cargo|npm install|release-source|download-artifact/);
  assert.match(publish, /editor-assets-release-cli.mjs publish/);
  assert.match(publish, /contents: write\n\s+actions: read/);
});
