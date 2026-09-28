import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {
  nativeTargets,
  packageName,
  releasePlan,
  stampManifest,
  verifyManifest,
} from "../ci/npm-release.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
const sourceManifest = JSON.parse(readFileSync(new URL("../../packages/runtimed-node/package.json", import.meta.url), "utf8"));
const identity = {channel: "nightly", sourceSha: "a".repeat(40), runId: "100", runAttempt: "1"};
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

for (const enabled of [undefined, "false", "true"]) {
  for (const channel of ["stable", "nightly"]) {
    test(`${channel} wrapper has exact native versions and ARM64 gate=${enabled}`, () => {
      const plan = releasePlan(sourceManifest.version, {...identity, channel}, enabled);
      const selected = stampManifest(sourceManifest, plan, "wrapper");
      assert.equal(Boolean(selected.optionalDependencies[packageName("linux-arm64-gnu")]), enabled === "true");
      assert.deepEqual(selected.optionalDependencies, Object.fromEntries(plan.nativeTargets.map(target => [packageName(target), plan.version])));
      assert.doesNotThrow(() => verifyManifest(selected, plan, "wrapper"));
      const mismatched = structuredClone(selected);
      if (enabled === "true") delete mismatched.optionalDependencies[packageName("linux-arm64-gnu")];
      else mismatched.optionalDependencies[packageName("linux-arm64-gnu")] = plan.version;
      assert.throws(() => verifyManifest(mismatched, plan, "wrapper"), /publication gate/);
      const ranged = structuredClone(selected);
      ranged.optionalDependencies[packageName("darwin-arm64")] = `^${plan.version}`;
      assert.throws(() => verifyManifest(ranged, plan, "wrapper"), /must be exactly/);
    });
  }
}

test("all native manifests share wrapper version and immutable provenance", () => {
  const plan = releasePlan(sourceManifest.version, identity, "true", "true");
  const retry = {...plan, runAttempt: "2"};
  for (const target of ["wrapper", ...nativeTargets]) {
    const source = target === "wrapper" ? sourceManifest : {name: packageName(target), version: sourceManifest.version};
    const manifest = stampManifest(source, plan, target);
    assert.equal(manifest.version, plan.version);
    assert.deepEqual(stampManifest(source, retry, target), manifest);
    assert.doesNotThrow(() => verifyManifest(manifest, plan, target));
  }
});

test("Linux and Windows ARM64 bootstrap gates are independent and default off", () => {
  for (const linux of [undefined, "false", "true"]) {
    for (const windows of [undefined, "false", "true"]) {
      const plan = releasePlan(sourceManifest.version, identity, linux, windows);
      const wrapper = stampManifest(sourceManifest, plan, "wrapper");
      assert.equal(Boolean(wrapper.optionalDependencies[packageName("linux-arm64-gnu")]), linux === "true");
      assert.equal(Boolean(wrapper.optionalDependencies[packageName("win32-arm64-msvc")]), windows === "true");
      for (const target of ["darwin-arm64", "linux-x64-gnu", "win32-x64-msvc"]) {
        assert.equal(wrapper.optionalDependencies[packageName(target)], plan.version);
      }
      assert.doesNotThrow(() => verifyManifest(wrapper, plan, "wrapper"));
    }
  }
});

test("source inventory drift, private dependencies and workspace leaks fail closed", () => {
  const plan = releasePlan(sourceManifest.version, identity, "true", "true");
  const changed = structuredClone(sourceManifest);
  delete changed.optionalDependencies[packageName("win32-arm64-msvc")];
  assert.throws(() => stampManifest(changed, plan, "wrapper"), /inventory/);
  const manifest = stampManifest(sourceManifest, plan, "wrapper");
  assert.throws(() => verifyManifest({...manifest, dependencies: {runtimed: "*"}}, plan, "wrapper"), /private/);
  assert.throws(() => verifyManifest({...manifest, dependencies: {rxjs: "workspace:*"}}, plan, "wrapper"), /workspace/);
});

test("standalone OIDC publishers only consume artifacts, with no source build or tokens", () => {
  assert.match(workflow, /^name: Publish npm packages$/m);
  assert.match(workflow, /workflows: \["Stable Release", "Nightly Release"\]/);
  assert.match(workflow, /^concurrency:\n  group: npm-publish\n  queue: max\n  cancel-in-progress: false$/m);
  assert.doesNotMatch(workflow, /workflow_call:|NODE_AUTH_TOKEN|NPM_TOKEN|continue-on-error:|if: always\(\)/);
  for (const target of ["native", "wrapper", "pi"]) {
    const publisher = jobs.get(`publish-${target}`);
    assert.match(publisher, /^      id-token: write$/m);
    assert.doesNotMatch(publisher, /actions\/checkout|pnpm|cargo|npm (?:install|ci)|secrets\./);
    assert.match(publisher, /npm-release-cli\.mjs" publish/);
    assert.doesNotMatch(jobs.get(`pack-${target}`), /id-token: write/);
  }
});

test("native failures block wrapper, Pi is stable-only, and source/channel are explicit", () => {
  assert.match(jobs.get("pack-wrapper"), /^    needs: \[resolve-release, publish-native\]$/m);
  assert.match(jobs.get("publish-native"), /if: \(matrix\.target != 'linux-arm64-gnu' \|\| needs\.resolve-release\.outputs\.linux_arm64_enabled == 'true'\) && \(matrix\.target != 'win32-arm64-msvc' \|\| needs\.resolve-release\.outputs\.windows_arm64_enabled == 'true'\)/);
  assert.match(jobs.get("pack-pi"), /^    if: needs\.resolve-release\.outputs\.channel == 'stable'$/m);
  for (const id of ["pack-native", "pack-wrapper", "pack-pi"]) {
    assert.match(jobs.get(id), /ref: \$\{\{ needs\.resolve-release\.outputs\.source_sha \}\}/);
  }
  for (const id of ["pack-native", "pack-wrapper"]) {
    const job = jobs.get(id);
    assert.match(job, /RUNT_BUILD_CHANNEL: \$\{\{ needs\.resolve-release\.outputs\.channel \}\}/);
    assert.ok(job.indexOf("pnpm install --frozen-lockfile") < job.indexOf("Stamp exact Node package versions"));
    assert.ok(job.indexOf("Stamp exact Node package versions") < job.indexOf("run: pnpm --dir packages/runtimed-node build"));
  }
  assert.match(jobs.get("pack-native"), /Smoke installed native tarball and compiled channel/);
});
