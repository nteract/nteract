import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";

const workflow = readFileSync(new URL("../workflows/preview-reusable.yml", import.meta.url), "utf8");
const helperSha = "4d26ab818dd3891a7a6c7f29749412a426514bcc";
// This workflow intentionally uses plain, one-line job names. Fail on layout
// drift as well as renamed jobs: these names are a controller API contract.
const jobs = new Map();
let current;
for (const line of workflow.split("\njobs:\n")[1].split("\n")) {
  const start = /^  ([a-z][a-z0-9_-]*):$/.exec(line);
  if (start) {
    current = start[1];
    assert.ok(!jobs.has(current), "duplicate workflow job");
    jobs.set(current, "");
  } else if (current) jobs.set(current, `${jobs.get(current)}${line}\n`);
}

const trustedJobs = {
  authorize: "authorize.mjs",
  deploy: "send-deployment.mjs",
  stop: "send-deployment.mjs",
  status: "report-status.mjs",
};

function permissions(body) {
  const block = /^    permissions:\n((?:      [^\n]+\n)+)/m.exec(body)?.[1];
  assert.ok(block, "explicit job permissions required");
  return Object.fromEntries([...block.matchAll(/^      ([a-z-]+): ([a-z]+)$/gm)].map(match => [match[1], match[2]]));
}

test("preview job names remain the exact five-name controller contract", () => {
  assert.deepEqual(Object.fromEntries([...jobs].map(([id, body]) => [id, /^    name: (.+)$/m.exec(body)?.[1]])), {
    authorize: "Authorize PR preview",
    build: "Build preview",
    deploy: "Request trusted deployment",
    stop: "Stop closed PR preview",
    status: "Update preview comment",
  });
});

test("PR write and OIDC stay in trusted jobs while the application build is read-only", () => {
  assert.deepEqual(permissions(jobs.get("build")), {contents: "read"});
  for (const id of Object.keys(trustedJobs)) {
    assert.deepEqual(permissions(jobs.get(id)), {contents: "read", actions: "read", "id-token": "write", "pull-requests": "write"});
  }
});

test("trusted jobs execute only reviewed helper entry points at the published revision", () => {
  for (const [id, script] of Object.entries(trustedJobs)) {
    const body = jobs.get(id);
    assert.deepEqual([...body.matchAll(/^        run: (.+)$/gm)].map(match => match[1]), [`node .github/preview/${script}`]);
    assert.deepEqual([...body.matchAll(/^          ref: (.+)$/gm)].map(match => match[1]), [`${helperSha} # Reviewed preview helpers`]);
    assert.match(body, /^          persist-credentials: false$/m);
    assert.match(body, /^          sparse-checkout: \.github\/preview$/m);
  }
});

test("the strict finalizer runs after every predecessor even after failure or skip", () => {
  const body = jobs.get("status");
  assert.match(body, /^    needs: \[authorize, build, deploy, stop\]$/m);
  assert.match(body, /^    if: always\(\)$/m);
  assert.doesNotMatch(body, /needs\.[a-z]+\.outputs/);
  assert.match(workflow, /^  cancel-in-progress: false$/m);
});
