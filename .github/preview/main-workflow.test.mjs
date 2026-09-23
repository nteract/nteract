import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";

const workflow = readFileSync(new URL("../workflows/main-preview-reusable.yml", import.meta.url), "utf8");
const helperSha = "cc55c85aec0441894941ac1f47321c4bc0e1231a";
const job = workflow.split("\njobs:\n")[1];

test("main reusable workflow exposes only workflow_call without inputs or inherited secrets", () => {
  assert.match(workflow, /^on:\n  workflow_call:\n\npermissions: \{\}$/m);
  assert.doesNotMatch(workflow, /^\s+(?:inputs|secrets):|\$\{\{\s*(?:inputs|secrets)\./m);
  assert.deepEqual([...job.matchAll(/^  ([a-z][a-z0-9_-]*):$/gm)].map(match => match[1]), ["deploy"]);
});

test("main deploy permission scope excludes source writes and is explicit", () => {
  const block = /^    permissions:\n((?:      [^\n]+\n)+)/m.exec(job)?.[1];
  assert.ok(block);
  assert.deepEqual(Object.fromEntries([...block.matchAll(/^      ([a-z-]+): ([a-z]+)$/gm)]
    .map(match => [match[1], match[2]])), {contents: "read", actions: "read", "id-token": "write"});
});

test("main deploy checks out only the reviewed helper revision and runs one trusted entry point", () => {
  assert.deepEqual([...job.matchAll(/^          ref: (.+)$/gm)].map(match => match[1]),
    [`${helperSha} # Reviewed main deployment helpers`]);
  assert.deepEqual([...job.matchAll(/^          repository: (.+)$/gm)].map(match => match[1]), ["nteract/nteract"]);
  assert.match(job, /^          persist-credentials: false$/m);
  assert.match(job, /^          sparse-checkout: \.github\/preview$/m);
  assert.deepEqual([...job.matchAll(/^        run: (.+)$/gm)].map(match => match[1]),
    ["node .github/preview/send-main-deployment.mjs"]);
  assert.deepEqual([...job.matchAll(/^\s+- (?:name: [^\n]+\n\s+)?uses: (.+)$/gm)].map(match => match[1]), [
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6",
  ]);
  assert.doesNotMatch(job, /github\.(?:sha|workflow_sha)|workflow_run\.head_sha|download-artifact|actions\/cache|secrets\.|secrets: inherit/);
  assert.match(job, /^          node-version: '22'$/m);
  assert.match(job, /^          package-manager-cache: false$/m);
});

test("main deployment environment and serialized update group are fixed", () => {
  assert.match(workflow, /^concurrency:\n  group: runtimed-main\n  cancel-in-progress: false$/m);
  assert.match(job, /^    environment:\n      name: runtimed-main\n      url: https:\/\/main\.runtimed\.run$/m);
  assert.match(job, /^    runs-on: ubuntu-24.04$/m);
  assert.match(job, /^    timeout-minutes: 20$/m);
  assert.match(job, /^        env:\n          GITHUB_TOKEN: \$\{\{ github.token \}\}$/m);
});
