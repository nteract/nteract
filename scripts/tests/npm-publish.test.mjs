import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
import {
  nativeTargets,
  finalizePackedManifest,
  packageName,
  releasePlan,
  stampManifest,
  stampBuildManifest,
  verifyManifest,
} from "../ci/npm-release.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/publish-npm.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
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
    const stamp = job.indexOf("Stamp Node build versions");
    const build = job.indexOf("run: pnpm --dir packages/runtimed-node build");
    const pack = job.indexOf('pack --pack-destination "$RUNNER_TEMP"');
    const finalize = job.indexOf("Finalize packed");
    assert.ok(stamp > job.indexOf("pnpm install --frozen-lockfile"));
    assert.ok(build > stamp, "napi-rs must generate its loader with the release version");
    assert.ok(pack > job.indexOf("pack:dry-run"));
    assert.ok(finalize > pack, "finalize only after pnpm has packed the workspace");
    assert.doesNotMatch(job.slice(finalize), /\bpnpm\b|--no-frozen-lockfile/);
    assert.match(job.slice(finalize), /npm-release-cli\.mjs" stamp-tarball/);
  }
  assert.match(jobs.get("pack-native"), /Smoke installed native tarball and compiled channel/);
});

test("build versions preserve workspace links and finalization applies the publication gates", () => {
  for (const channel of ["stable", "nightly"]) {
    const plan = releasePlan(sourceManifest.version, {...identity, channel});
    const build = stampBuildManifest(sourceManifest, plan, "wrapper");
    assert.equal(build.version, plan.version);
    assert.deepEqual(build.optionalDependencies, sourceManifest.optionalDependencies);
    const packed = {...build, optionalDependencies: Object.fromEntries(nativeTargets.map(target => [packageName(target), plan.version]))};
    assert.deepEqual(finalizePackedManifest(packed, plan, "wrapper"), stampManifest(sourceManifest, plan, "wrapper"));
    assert.throws(() => finalizePackedManifest({...packed, version: "0.0.0"}, plan, "wrapper"), /build version/);
    assert.throws(() => finalizePackedManifest({...packed, nteractRelease: {...packed.nteractRelease, sourceSha: "b".repeat(40)}}, plan, "wrapper"), /build identity/);
  }
});

test("tarball finalization preserves pnpm payload and modes, changing only its manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "nteract-npm-pack-"));
  try {
    const plan = releasePlan(sourceManifest.version, identity);
    const planPath = join(directory, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    const cli = fileURLToPath(new URL("../ci/npm-release-cli.mjs", import.meta.url));
    for (const target of ["wrapper", "linux-x64-gnu"]) {
      const root = join(directory, target);
      const payload = join(root, "package");
      mkdirSync(join(payload, "src"), {recursive: true});
      const source = target === "wrapper" ? sourceManifest : {
        name: packageName(target), version: sourceManifest.version,
      };
      const stamped = stampBuildManifest(source, plan, target);
      if (target === "wrapper") stamped.optionalDependencies = Object.fromEntries(nativeTargets.map(native => [packageName(native), plan.version]));
      // pnpm has already selected the files, included the workspace LICENSE
      // and removed prepack scripts. Finalization must retain that payload.
      delete stamped.scripts;
      writeFileSync(join(payload, "package.json"), JSON.stringify(stamped));
      const files = {
        LICENSE: "workspace license\n",
        "src/binding.cjs": `module.exports = '${plan.version}';\n`,
        "runtimed-node.linux-x64-gnu.node": Buffer.from([0, 1, 255, 0, 42]),
        "cli.cjs": "#!/usr/bin/env node\n",
      };
      for (const [name, data] of Object.entries(files)) writeFileSync(join(payload, name), data);
      chmodSync(join(payload, "cli.cjs"), 0o755);
      const tarball = join(root, "package.tgz");
      const tar = args => execFileSync("tar", args, {cwd: root, encoding: "utf8"});
      tar(["-czf", "package.tgz", "package"]);
      const listing = tar(["-tzf", "package.tgz"]).split("\n").sort();
      execFileSync(process.execPath, [cli, "stamp-tarball", planPath, target, root]);
      const manifest = JSON.parse(tar(["-xOf", "package.tgz", "package/package.json"]));
      verifyManifest(manifest, plan, target);
      assert.deepEqual(manifest, finalizePackedManifest(stamped, plan, target));
      assert.deepEqual(tar(["-tzf", "package.tgz"]).split("\n").sort(), listing);
      const extracted = join(root, "extracted");
      mkdirSync(extracted);
      tar(["-xzf", "package.tgz", "-C", "extracted"]);
      for (const [name, data] of Object.entries(files)) assert.deepEqual(readFileSync(join(extracted, "package", name)), Buffer.from(data));
      if (process.platform !== "win32") assert.equal(statSync(join(extracted, "package", "cli.cjs")).mode & 0o777, 0o755);
      const originalTarball = readFileSync(tarball);
      const badPlan = {...plan, sourceSha: "b".repeat(40)};
      writeFileSync(planPath, JSON.stringify(badPlan));
      assert.throws(() => execFileSync(process.execPath, [cli, "stamp-tarball", planPath, target, root], {stdio: "pipe"}), /build identity/);
      assert.deepEqual(readFileSync(tarball), originalTarball, "failed finalization leaves the original tarball intact");
      writeFileSync(planPath, JSON.stringify(plan));
    }
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
