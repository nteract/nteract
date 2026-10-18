import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {assetNames, buildTitle, candidateName, digest, identityFromBuildTitle, publishAssets, resolveEditorCandidate, resolveWasmCandidate, successfulJobAtAttempt, validateBuildRun, validateWasm} from '../ci/editor-assets-release.mjs';
const identity = {sourceSha: 'a'.repeat(40), channel: 'nightly', runId: '123', runAttempt: '2'};
const wasm = {...identity, schema: 1, version: '0.7.6-nightly.202610151200', runAttempt: '1', files: {'apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm': 'b'.repeat(64)}};
const names = assetNames(identity);
const files = {[names[0]]: Buffer.from('packed bytes')};
files[names[1]] = Buffer.from(`${digest(files[names[0]])}  ${names[0]}\n`);
const candidate = {...identity, schema: 1, wasm, version: wasm.version, buildRunId: '456', buildRunAttempt: '1', wasmArtifactId: '100', wasmArtifactDigest: `sha256:${'e'.repeat(64)}`, sha256: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)]))};
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
    upload: async (release, name, data) => { calls.push(`upload:${name}`); const id = assets.length + 1; assets.push({id, name, state: 'uploaded'}); bytes.set(id, data); },
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
  const {api, calls, assets, bytes} = server(); assets.push({id: 1, name: names[1], state: 'uploaded'}); bytes.set(1, Buffer.from('wrong checksum'));
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
  assert.throws(() => validateBuildRun(build, api.repository, 'main'), /Untrusted/);
  assert.equal(await resolveEditorCandidate(identity, api), null);
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


test('an interrupted starter asset is reported by ID without deletion or new uploads', async () => {
  const {api, calls, assets} = server();
  assets.push({id: 99, name: names[0], state: 'starter', size: 0});
  await assert.rejects(publishAssets(candidate, files, api), /Incomplete release asset 99.*retry this same editor build/);
  assert.ok(!calls.some(call => call.startsWith('upload:') || call.startsWith('download:')));
});
test('a failed wrong-branch dispatch cannot poison a valid completed candidate', async () => {
  const {api, build} = buildServer();
  const wrong = {...build, id: 999, head_branch: 'feature-branch'};
  api.buildRuns = async () => [wrong, build];
  const read = api.artifacts;
  api.artifacts = async id => { assert.equal(id, 456); return read(id); };
  assert.equal((await resolveEditorCandidate(identity, api)).candidate.buildRunId, '456');
});
function wasmServer(attempts = ['1']) {
  const entries = attempts.map(attempt => ({id: Number(attempt) + 100, name: `release-wasm-123-${attempt}`, workflow_run: {id: 123, head_sha: identity.sourceSha}, digest: `sha256:${'b'.repeat(64)}`, expired: false}));
  return {entries, api: {
    releaseRun: async () => ({id: 123, head_sha: identity.sourceSha}),
    artifacts: async () => entries,
    successfulJob: async (_id, attempt) => attempts.includes(String(attempt)),
    readWasmReceipt: async artifact => ({...wasm, runAttempt: artifact.name.split('-').at(-1)}),
  }};
}
test('failed-job release rerun reuses earlier successful WASM bytes and records both attempts', async () => {
  const {api} = wasmServer();
  const plan = await resolveWasmCandidate(identity, api);
  assert.equal(plan.runAttempt, '2'); assert.equal(plan.wasm.runAttempt, '1'); assert.equal(plan.wasmArtifactId, '101');
});
test('rerun-all selects its newer successful WASM, but ignores artifacts from failed or future attempts', async () => {
  const {api} = wasmServer(['1', '3', '2']);
  assert.equal((await resolveWasmCandidate(identity, api)).wasm.runAttempt, '2');
  api.successfulJob = async (_id, attempt) => attempt !== '2';
  assert.equal((await resolveWasmCandidate(identity, api)).wasm.runAttempt, '1');
});
test('expired selected WASM fails rather than falling back to a different attempt', async () => {
  const {api, entries} = wasmServer(['1', '2']); entries[1].expired = true;
  await assert.rejects(resolveWasmCandidate(identity, api), /expired/);
  api.artifacts = async () => [];
  await assert.rejects(resolveWasmCandidate(identity, api), /no retained receipt/);
});
test('WASM selection verifies artifact origin and receipt attempt before returning bytes', async () => {
  const {api, entries} = wasmServer(['2']);
  api.readWasmReceipt = async () => wasm;
  await assert.rejects(resolveWasmCandidate(identity, api), /receipt attempt mismatch/);
  entries[0].workflow_run.head_sha = 'c'.repeat(40);
  await assert.rejects(resolveWasmCandidate(identity, api), /origin mismatch/);
});
test('publisher recovers exact positive release run and attempt from the builder title', () => {
  assert.deepEqual(identityFromBuildTitle(buildTitle(identity)), {runId: '123', runAttempt: '2'});
  for (const title of ['Editor assets for release 123/0', 'Editor assets for release 1/2 extra', 'unrelated workflow']) assert.throws(() => identityFromBuildTitle(title), /Invalid/);
});
test('optional retention cannot gate required release outputs, and editor workflows preserve all queued retries', () => {
  const read = name => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
  const release = read('release-common');
  assert.match(release, /name: Record immutable release WASM identity\n\s+id: wasm-receipt\n\s+continue-on-error: true/);
  assert.match(release, /name: Retain release WASM for independent downstream publishers\n\s+if: steps.wasm-receipt.outcome == 'success'\n\s+continue-on-error: true/);
  assert.match(release, /name: Upload WASM artifacts\n\s+uses: actions\/upload-artifact@v7/);
  for (const name of ['build-editor-assets','publish-editor-assets']) assert.match(read(name), /queue: max\n\s+cancel-in-progress: false/);
  assert.match(read('build-editor-assets'), /package_json_file: release-source\/package.json/);
});

test('a newer successful WASM job without retained bytes cannot fall back to an older receipt', async () => {
  const {api} = wasmServer(['1']); api.successfulJob = async () => true;
  await assert.rejects(resolveWasmCandidate(identity, api), /Successful WASM attempt 2 has no retained receipt/);
});
test('job identity follows its own attempt rather than the jobs endpoint used to retrieve it', () => {
  const jobs = [{name: 'release / Build WASM artifacts', run_attempt: 1, conclusion: 'success'}];
  assert.equal(successfulJobAtAttempt(jobs, '2', 'Build WASM artifacts'), false);
  assert.equal(successfulJobAtAttempt(jobs, '1', 'Build WASM artifacts'), true);
  assert.equal(successfulJobAtAttempt([{...jobs[0], conclusion: 'failure'}], '1', 'Build WASM artifacts'), false);
});
