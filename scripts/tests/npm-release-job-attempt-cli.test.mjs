import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

// Exercise the real CLI adapters without GitHub access or publication. Stop at
// the receipt download: the unit tests separately cover its digest and identity.
const mock = `
import {appendFileSync} from 'node:fs';
const sha = 'a'.repeat(40);
globalThis.fetch = async input => {
  const url = new URL(input);
  if (url.origin !== 'https://github.example') throw new Error('Unexpected network request');
  const path = url.pathname.replace('/repos/nteract/nteract', '');
  appendFileSync(process.env.REQUESTS, path + '\\n');
  let value;
  const match = /^\\/actions\\/runs\\/123\\/attempts\\/([12])(\\/jobs)?$/.exec(path);
  if (match) {
    const attempt = Number(match[1]);
    const start = attempt === 1 ? '2026-11-12T21:45:04Z' : '2026-11-12T23:07:55Z';
    if (match[2]) {
      const fresh = attempt === 2 && process.env.SCENARIO === 'rerun-all';
      value = {jobs: [{id: attempt === 1 ? 131514752546 : 131559168413, run_id: 123, run_attempt: attempt, name: 'release / Build WASM artifacts', status: 'completed', conclusion: 'success', started_at: fresh ? '2026-11-12T23:08:10Z' : '2026-11-12T21:45:10Z', completed_at: fresh ? '2026-11-12T23:12:50Z' : '2026-11-12T21:48:50Z'}]};
    } else {
      value = {id: 123, run_attempt: attempt, run_started_at: process.env.SCENARIO === 'missing-time' ? null : start, created_at: '2026-11-12T21:45:04Z', repository: {full_name: 'nteract/nteract'}, head_repository: {full_name: 'nteract/nteract'}, head_sha: sha, path: '.github/workflows/release-nightly.yml', display_title: 'Nightly Release', event: 'schedule', status: 'completed', conclusion: 'success'};
    }
  } else if (path.startsWith('/actions/workflows/')) {
    value = {workflow_runs: []};
  } else if (path === '/contents/packages/runtimed-wasm/package.json') {
    value = {encoding: 'base64', content: Buffer.from(JSON.stringify({name: '@runtimed/wasm', version: '2.10.0'})).toString('base64')};
  } else if (path === '/actions/runs/123/artifacts') {
    value = {artifacts: [{id: 101, name: 'release-wasm-123-1', workflow_run: {id: 123, head_sha: sha}, expired: false, digest: 'sha256:' + 'b'.repeat(64)}]};
  } else if (path === '/actions/artifacts/101/zip') {
    throw new Error('Selected original immutable receipt 101');
  } else {
    throw new Error('Unexpected GitHub path: ' + path);
  }
  return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
};
`;

for (const cli of ['editor-assets-release-cli.mjs', 'npm-wasm-release-cli.mjs']) {
  for (const [scenario, expected] of [
    ['failed-job-rerun', /Selected original immutable receipt 101/],
    ['rerun-all', /Successful WASM attempt 2 has no retained receipt/],
    ['missing-time', /Missing\/invalid attempt start time/],
  ]) {
    test(`${cli} uses attempt-specific timing for ${scenario}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'release-attempt-test-'));
      try {
        const preload = join(dir, 'mock.mjs'), event = join(dir, 'event.json'), requests = join(dir, 'requests');
        writeFileSync(preload, mock);
        writeFileSync(event, JSON.stringify({repository: {default_branch: 'main'}}));
        const result = spawnSync(process.execPath, ['--import', preload, new URL(`../ci/${cli}`, import.meta.url).pathname, 'prepare', join(dir, 'plan.json')], {
          encoding: 'utf8',
          env: {...process.env, GH_TOKEN: 'test-only', GITHUB_API_URL: 'https://github.example', GITHUB_REPOSITORY: 'nteract/nteract', GITHUB_EVENT_PATH: event, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_RUN_ID: '123', RELEASE_RUN_ATTEMPT: '2', GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), REQUESTS: requests, SCENARIO: scenario},
        });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, expected);
        const calls = readFileSync(requests, 'utf8');
        assert.match(calls, /\/actions\/runs\/123\/attempts\/2\n/);
        assert.match(calls, /\/actions\/runs\/123\/attempts\/2\/jobs\n/);
        if (scenario === 'failed-job-rerun') {
          assert.match(calls, /\/actions\/runs\/123\/attempts\/1\n/);
          assert.match(calls, /\/actions\/runs\/123\/attempts\/1\/jobs\n/);
        } else {
          assert.doesNotMatch(calls, /\/actions\/artifacts\//);
        }
      } finally { rmSync(dir, {recursive: true, force: true}); }
    });
  }
}
