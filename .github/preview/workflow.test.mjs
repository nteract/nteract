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

test("dependency caches stay outside every job with deployment or PR-write authority", () => {
  const cacheAction = /uses: (?:actions\/cache(?:\/[a-z-]+)?|Swatinem\/rust-cache)@/;
  assert.match(jobs.get("build"), cacheAction);
  for (const id of Object.keys(trustedJobs)) assert.doesNotMatch(jobs.get(id), cacheAction);
  assert.deepEqual(permissions(jobs.get("build")), {contents: "read"});
});

test("preview caches exclude workspace crates, installed tools, and generated application outputs", () => {
  const build = jobs.get("build");
  const caches = [...build.matchAll(/^      - name: Cache [^\n]+\n([\s\S]*?)(?=^      - |$(?![\s\S]))/gm)].map(match => match[1]);
  assert.equal(caches.length, 2);
  for (const cache of caches) assert.match(cache, /uses: [^\n]+@[a-f0-9]{40} #/);
  const [pnpm, rust] = caches;
  assert.match(pnpm, /^          path: \$\{\{ runner\.temp \}\}\/preview-pnpm-store$/m);
  assert.match(pnpm, /key: nteract-pr-preview-pnpm-v1-.*hashFiles\('source\/pnpm-lock\.yaml', 'source\/pnpm-workspace\.yaml', 'source\/\.npmrc'\)/);
  assert.doesNotMatch(pnpm, /restore-keys:|node_modules|dist/);
  assert.match(rust, /^          prefix-key: nteract-pr-preview-rust-v1$/m);
  assert.match(rust, /^          workspaces: source -> target$/m);
  for (const option of ["cache-workspace-crates", "cache-all-crates", "cache-bin", "cache-on-failure"]) {
    assert.match(rust, new RegExp(`^          ${option}: false$`, "m"));
  }
  assert.doesNotMatch(rust, /cache-directories:/);
  assert.match(rust, /key: cloud-wasm-.*hashFiles\('source\/rust-toolchain\.toml', 'source\/\.cargo\/config\.toml'\)/);
  assert.match(rust, /^          cmd-format: rustup run 1\.94\.0 \{0\}$/m);
});

test("a dependency cache hit never skips installation, source compilation, or bundle export", () => {
  const build = jobs.get("build");
  assert.doesNotMatch(build, /cache-hit|lookup-only|sccache|SCCACHE/);
  assert.match(build, /run: pnpm install --frozen-lockfile --store-dir "\$RUNNER_TEMP\/preview-pnpm-store" --verify-store-integrity/);
  assert.match(build, /pnpm --dir apps\/notebook-cloud build\n          node apps\/notebook-cloud\/scripts\/celld-local\.mjs export/);
  assert.ok(build.indexOf("name: Cache Rust dependencies") > build.indexOf("name: Install Rust and the WASM builder"));
  assert.ok(build.indexOf("name: Cache Rust dependencies") < build.indexOf("name: Build and export application"));
});
