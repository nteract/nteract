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
const siftManifest = JSON.parse(readFileSync(new URL("../../packages/sift/package.json", import.meta.url), "utf8"));
const siftCsvManifest = JSON.parse(readFileSync(new URL("../../packages/sift-csv/package.json", import.meta.url), "utf8"));
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

test("Linux publishers build on 22.04 and audit the installed tarball before upload", () => {
  const native = jobs.get("pack-native");
  assert.match(native, /target: linux-x64-gnu\n\s+runner: ubuntu-22\.04\n/);
  assert.match(native, /target: linux-arm64-gnu\n\s+runner: ubuntu-22\.04-arm\n/);
  const install = native.indexOf('npm install --prefix "$RUNNER_TEMP/npm-native-smoke"');
  const audit = native.indexOf('node "$RUNNER_TEMP/npm-release-tools/audit-linux-node.mjs" "$ARCH" "$RUNNER_TEMP/npm-native-smoke/node_modules/');
  const upload = native.indexOf("uses: actions/upload-artifact@");
  assert.ok(install >= 0 && audit > install && upload > audit);
  assert.doesNotMatch(native, /continue-on-error:/);
  const helpers = jobs.get("resolve-release");
  const copy = helpers.indexOf('cp scripts/ci/audit-linux-node.mjs "$RUNNER_TEMP/npm-release-tools/"');
  assert.ok(copy >= 0 && helpers.indexOf("uses: actions/upload-artifact@") > copy);
});

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
  for (const target of ["native", "wrapper", "pi", "sift", "sift-csv"]) {
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
  for (const id of ["pack-native", "pack-wrapper", "pack-pi", "pack-sift"]) {
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

test("wrapper job budget leaves room for native propagation and publication", () => {
  const timeout = /^    timeout-minutes: (\d+)$/m.exec(jobs.get("publish-wrapper"));
  assert.ok(timeout, "declare a bounded wrapper job budget");
  assert.ok(Number(timeout[1]) >= 40, "allow the 30-minute native wait plus setup and publication");
});

test("Sift packs independently, tests the stamped package, and publishes only behind its gate", () => {
  const resolve = jobs.get("resolve-release");
  assert.match(resolve, /plan "\$RUNNER_TEMP\/release-identity\.json" release-source\/packages\/sift\/package\.json "\$RUNNER_TEMP\/npm-release-tools\/sift-plan\.json"/);
  assert.match(resolve, /NPM_SIFT_ENABLED: \$\{\{ vars\.NPM_SIFT_ENABLED \}\}/);
  assert.match(resolve, /sift_enabled: \$\{\{ steps\.sift-plan\.outputs\.enabled \}\}/);
  assert.ok(resolve.indexOf("id: sift-plan") < resolve.indexOf("uses: actions/upload-artifact@"), "upload the Sift plan with the tools");

  const pack = jobs.get("pack-sift");
  assert.match(pack, /^    needs: \[resolve-release\]$/m, "Sift must not wait for the Node SDK");
  const order = [
    "pnpm install --frozen-lockfile",
    "cargo xtask wasm sift --skip-renderer-plugins",
    'stamp-build "$RUNNER_TEMP/npm-release-tools/sift-plan.json" packages/sift sift',
    "pnpm --dir packages/sift test:package",
    'pnpm --dir packages/sift pack --pack-destination "$RUNNER_TEMP"',
    'stamp-tarball "$RUNNER_TEMP/npm-release-tools/sift-plan.json" sift "$RUNNER_TEMP"',
    'verify "$RUNNER_TEMP/npm-release-tools/sift-plan.json" sift',
    "uses: actions/upload-artifact@",
  ].map(step => pack.indexOf(step));
  assert.ok(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1])), `pack-sift step order: ${order}`);

  const publish = jobs.get("publish-sift");
  assert.match(publish, /^    needs: \[resolve-release, pack-sift\]$/m);
  assert.match(publish, /- name: Publish Sift package\n\s+if: needs\.resolve-release\.outputs\.sift_enabled == 'true'\n/);
  assert.match(publish, /- name: Report Sift bootstrap prerequisite\n\s+if: needs\.resolve-release\.outputs\.sift_enabled != 'true'\n/);
  assert.match(publish, /publish "\$RUNNER_TEMP\/npm-release-tools\/sift-plan\.json" sift "\$RUNNER_TEMP\/npm-package"/);
});

test("Sift CSV packs and publishes like Sift, independent of both the Node SDK and Sift", () => {
  const resolve = jobs.get("resolve-release");
  assert.match(resolve, /plan "\$RUNNER_TEMP\/release-identity\.json" release-source\/packages\/sift-csv\/package\.json "\$RUNNER_TEMP\/npm-release-tools\/sift-csv-plan\.json"/);
  assert.match(resolve, /NPM_SIFT_CSV_ENABLED: \$\{\{ vars\.NPM_SIFT_CSV_ENABLED \}\}/);
  assert.match(resolve, /sift_csv_enabled: \$\{\{ steps\.sift-csv-plan\.outputs\.enabled \}\}/);
  assert.ok(resolve.indexOf("id: sift-csv-plan") < resolve.indexOf("uses: actions/upload-artifact@"), "upload the Sift CSV plan with the tools");

  const pack = jobs.get("pack-sift-csv");
  assert.match(pack, /^    needs: \[resolve-release\]$/m, "Sift CSV must not wait for the Node SDK or Sift");
  const order = [
    "pnpm install --frozen-lockfile",
    "cargo xtask wasm sift-csv",
    "Install cargo-about",
    'stamp-build "$RUNNER_TEMP/npm-release-tools/sift-csv-plan.json" packages/sift-csv sift-csv',
    "pnpm --dir packages/sift-csv test:package",
    'pnpm --dir packages/sift-csv pack --pack-destination "$RUNNER_TEMP"',
    'stamp-tarball "$RUNNER_TEMP/npm-release-tools/sift-csv-plan.json" sift-csv "$RUNNER_TEMP"',
    'verify "$RUNNER_TEMP/npm-release-tools/sift-csv-plan.json" sift-csv',
    "uses: actions/upload-artifact@",
  ].map(step => pack.indexOf(step));
  assert.ok(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1])), `pack-sift-csv step order: ${order}`);
  assert.match(pack, /name: npm-package-sift-csv\n/);

  const publish = jobs.get("publish-sift-csv");
  assert.match(publish, /^    needs: \[resolve-release, pack-sift-csv\]$/m);
  assert.match(publish, /- name: Publish Sift CSV package\n\s+if: needs\.resolve-release\.outputs\.sift_csv_enabled == 'true'\n/);
  assert.match(publish, /- name: Report Sift CSV bootstrap prerequisite\n\s+if: needs\.resolve-release\.outputs\.sift_csv_enabled != 'true'\n/);
  assert.match(publish, /publish "\$RUNNER_TEMP\/npm-release-tools\/sift-csv-plan\.json" sift-csv "\$RUNNER_TEMP\/npm-package"/);
  assert.match(publish, /npm-result\/sift-csv\.json/);
});

test("Sift CSV manifest carries its own version, provenance and no workspace dependencies", () => {
  assert.equal(packageName("sift-csv"), siftCsvManifest.name);
  assert.equal(siftCsvManifest.repository?.url, "git+https://github.com/nteract/nteract.git", "npm provenance needs the source repository");
  assert.equal(siftCsvManifest.repository?.directory, "packages/sift-csv");
  assert.equal(siftCsvManifest.dependencies, undefined, "sift-csv ships only first-party JS and its WASM");
  for (const channel of ["stable", "nightly"]) {
    const plan = releasePlan(siftCsvManifest.version, {...identity, channel});
    assert.equal(plan.version, channel === "stable" ? siftCsvManifest.version : `${siftCsvManifest.version}-nightly.${identity.runId}`);
    const build = stampBuildManifest(siftCsvManifest, plan, "sift-csv");
    const finalized = finalizePackedManifest(build, plan, "sift-csv");
    assert.equal(finalized.version, plan.version);
    assert.doesNotThrow(() => verifyManifest(finalized, plan, "sift-csv"));
    assert.throws(() => stampManifest({...siftCsvManifest, version: "0.0.1"}, plan, "sift-csv"), /Checked-in version mismatch/);
    assert.throws(() => stampManifest(siftManifest, plan, "sift-csv"), /Unexpected package/);
  }
});

test("Sift manifests carry their own version, provenance and no private or workspace dependencies", () => {
  assert.equal(packageName("sift"), siftManifest.name);
  assert.equal(siftManifest.repository?.url, "git+https://github.com/nteract/nteract.git", "npm provenance needs the source repository");
  assert.equal(siftManifest.repository?.directory, "packages/sift");
  for (const channel of ["stable", "nightly"]) {
    const plan = releasePlan(siftManifest.version, {...identity, channel});
    assert.equal(plan.version, channel === "stable" ? siftManifest.version : `${siftManifest.version}-nightly.${identity.runId}`);
    const build = stampBuildManifest(siftManifest, plan, "sift");
    const packed = {...build, devDependencies: {...build.devDependencies, "@nteract/odometer": "0.1.0"}};
    const finalized = finalizePackedManifest(packed, plan, "sift");
    assert.equal(finalized.version, plan.version);
    assert.doesNotThrow(() => verifyManifest(finalized, plan, "sift"));
    assert.throws(() => verifyManifest({...finalized, dependencies: {...finalized.dependencies, "@nteract/odometer": "0.1.0"}}, plan, "sift"), /private package @nteract\/odometer/);
    assert.throws(() => verifyManifest({...finalized, peerDependencies: {...finalized.peerDependencies, react: "workspace:*"}}, plan, "sift"), /peerDependencies\.react uses workspace protocol/);
    assert.throws(() => stampManifest({...siftManifest, version: "0.0.1"}, plan, "sift"), /Checked-in version mismatch/);
    assert.throws(() => stampManifest(sourceManifest, plan, "sift"), /Unexpected package/);
  }
});

test("Sift build stamping rewrites only the Sift manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "nteract-npm-sift-"));
  try {
    const plan = releasePlan(siftManifest.version, identity);
    const planPath = join(directory, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    mkdirSync(join(directory, "sift"));
    writeFileSync(join(directory, "sift", "package.json"), JSON.stringify(siftManifest));
    const cli = fileURLToPath(new URL("../ci/npm-release-cli.mjs", import.meta.url));
    execFileSync(process.execPath, [cli, "stamp-build", planPath, join(directory, "sift"), "sift"]);
    const stamped = JSON.parse(readFileSync(join(directory, "sift", "package.json"), "utf8"));
    assert.deepEqual(stamped, stampBuildManifest(siftManifest, plan, "sift"));
    assert.equal(stamped.version, `${siftManifest.version}-nightly.${identity.runId}`);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
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

// Execute the workflow's actual plan shell against an old release checkout.
test("old upstream source skips CSV without blocking other release plans", () => {
  const dir = mkdtempSync(join(tmpdir(), "npm-old-source-"));
  try {
    const output = join(dir, "output"), summary = join(dir, "summary");
    const step = jobs.get("resolve-release").split("      - name: Prepare immutable Sift CSV release plan")[1].split("      - uses:")[0];
    const shell = step.split("        run: |\n")[1].split("\n").filter(line => line.startsWith("          ")).map(line => line.slice(10)).join("\n");
    execFileSync("bash", ["-e", "-c", shell], {cwd: dir, env: {...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary}});
    assert.equal(readFileSync(output, "utf8"), "present=false\n");
    assert.match(jobs.get("pack-sift-csv"), /if: needs.resolve-release.outputs.sift_csv_present == 'true'/);
    for (const job of ["pack-sift", "pack-sift-csv"]) {
      assert.doesNotMatch(jobs.get(job), /uses: \.\/\.github\/actions\/install-cargo-about/);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
