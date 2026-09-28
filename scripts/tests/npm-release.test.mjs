import assert from "node:assert/strict";
import {test} from "node:test";
import {
  compareVersions,
  packageName,
  publicationDecision,
  publishPackage,
  registryPackage,
  releaseIdentity,
  releasePlan,
  stampManifest,
} from "../ci/npm-release.mjs";

const sourceSha = "a".repeat(40);
const expected = {repository: "nteract/nteract", runId: "100", runAttempt: "1", sourceSha};
const run = {
  id: 100, run_attempt: 1,
  repository: {full_name: expected.repository}, head_repository: {full_name: expected.repository},
  path: ".github/workflows/release-nightly.yml", event: "schedule",
  status: "completed", conclusion: "success", head_sha: sourceSha,
};
const identity = releaseIdentity(run, expected);
const plan = releasePlan("0.5.6", identity, "true", "true");
const nativeTarget = "darwin-arm64";
const nativeSource = {name: packageName(nativeTarget), version: "0.5.6"};
const manifest = stampManifest(nativeSource, plan, nativeTarget);
const empty = () => ({versions: {}, "dist-tags": {}});
const packument = (versions, tag, version) => ({versions: Object.fromEntries(versions.map(value => [value.version, value])), "dist-tags": tag ? {[tag]: version} : {}});

for (const channel of ["stable", "nightly"]) {
  test(`successful ${channel} release resolves from exact workflow run identity`, () => {
    const resolved = releaseIdentity({...run, path: `.github/workflows/release-${channel}.yml`}, expected);
    assert.deepEqual(resolved, {...identity, channel});
    const first = releasePlan("0.5.6", resolved, "true");
    const retry = releasePlan("0.5.6", {...resolved, runAttempt: "2"}, "true");
    assert.equal(first.version, channel === "stable" ? "0.5.6" : "0.5.6-nightly.100");
    assert.equal(first.version, retry.version);
    assert.equal(first.distTag, channel === "stable" ? "latest" : "nightly");
  });
}

for (const [name, patch] of [
  ["run ID", {id: 101}], ["attempt", {run_attempt: 2}],
  ["foreign source", {head_repository: {full_name: "other/repo"}}],
  ["foreign repository", {repository: {full_name: "other/repo"}}],
  ["untrusted workflow", {path: ".github/workflows/test.yml"}],
  ["pull request event", {event: "pull_request"}],
  ["failed release", {conclusion: "failure"}], ["running release", {status: "in_progress"}],
  ["mismatched source", {head_sha: "b".repeat(40)}], ["non-SHA source", {head_sha: "main"}],
]) {
  test(`rejects ${name}`, () => assert.throws(() => releaseIdentity({...run, ...patch}, expected)));
}

test("nightly version needs a checked-in stable version and a valid immutable run ID", () => {
  assert.throws(() => releasePlan("0.5.6-beta.1", identity), /version/);
  assert.throws(() => releasePlan("0.5.6-nightly.1", identity), /must be stable/);
  assert.throws(() => releasePlan("0.5.6", {...identity, runId: "100\nfoo=bar"}), /run ID/);
  assert.throws(() => releasePlan("0.5.6", {...identity, channel: "main"}), /channel/);
  assert.equal(compareVersions("0.5.6-nightly.10", "0.5.6-nightly.9"), 1);
  assert.equal(compareVersions("0.5.6", "0.5.6-nightly.999"), 1);
  assert.equal(compareVersions("0.5.7-nightly.1", "0.5.6"), 1);
});

test("a retry reuses immutable versions without moving an existing dist-tag", async () => {
  const newer = {...manifest, version: "0.5.6-nightly.101", nteractRelease: {...manifest.nteractRelease, runId: "101"}};
  const state = packument([manifest, newer], "nightly", newer.version);
  let publishes = 0;
  const result = await publishPackage(manifest, {...plan, runAttempt: "2"}, nativeTarget, {
    fetchPackage: async () => state, publish: () => publishes++,
  });
  assert.equal(result.status, "existing");
  assert.equal(publishes, 0);
});

test("an unpublished old candidate fails instead of rolling back or claiming completion", async () => {
  const newer = {...manifest, version: "0.5.6-nightly.101", nteractRelease: {...manifest.nteractRelease, runId: "101"}};
  await assert.rejects(publishPackage(manifest, plan, nativeTarget, {
    fetchPackage: async () => packument([newer], "nightly", newer.version),
    publish: () => assert.fail("stale run must not publish"),
  }), /incomplete older release/);
  const oldRunWithHigherBase = {...manifest, version: "0.5.7-nightly.100"};
  assert.equal(publicationDecision(oldRunWithHigherBase, plan, packument([newer], "nightly", newer.version)), "stale");
});

test("new nightly publication leaves stable/latest untouched", async () => {
  const stable = {...manifest, version: "0.5.6", nteractRelease: undefined};
  const state = packument([stable], "latest", "0.5.6");
  let publishes = 0;
  await publishPackage(manifest, plan, nativeTarget, {
    fetchPackage: async () => state,
    publish() { publishes++; state.versions[manifest.version] = manifest; state["dist-tags"][plan.distTag] = manifest.version; },
  });
  assert.equal(publishes, 1);
  assert.equal(state["dist-tags"].latest, "0.5.6");
  assert.equal(state["dist-tags"].nightly, manifest.version);
});

test("legacy stable versions skip without inventing source provenance; stale stable fails", async () => {
  const stablePlan = releasePlan("0.5.6", {...identity, channel: "stable"}, "true", "true");
  const candidate = stampManifest(nativeSource, stablePlan, nativeTarget);
  const legacy = {...nativeSource};
  const result = await publishPackage(candidate, stablePlan, nativeTarget, {
    fetchPackage: async () => packument([legacy], "latest", legacy.version),
    publish: () => assert.fail("immutable stable version exists"),
  });
  assert.equal(result.status, "existing");
  assert.equal(result.registryRelease, null);
  assert.equal(publicationDecision(candidate, stablePlan, packument([{...legacy, version: "0.5.7"}], "latest", "0.5.7")), "stale");
});

test("nightly provenance collision, malformed metadata and lookup failures stop publication", async () => {
  const wrong = {...manifest, nteractRelease: {...manifest.nteractRelease, sourceSha: "b".repeat(40)}};
  assert.throws(() => publicationDecision(manifest, plan, packument([wrong])), /identity mismatch/);
  assert.throws(() => publicationDecision(manifest, plan, {}), /Invalid registry metadata/);
  for (const invalid of [null, [], {versions: [], "dist-tags": {}}, {versions: {}, "dist-tags": []}, {versions: null, "dist-tags": {}}, {versions: {}, "dist-tags": null}]) {
    assert.throws(() => publicationDecision(manifest, plan, invalid), /Invalid registry metadata/);
  }
  for (const invalid of [null, [], "unexpected", {version: "wrong"}]) {
    assert.throws(() => publicationDecision(manifest, plan, {versions: {[manifest.version]: invalid}, "dist-tags": {}}), /Invalid existing registry version/);
  }
  assert.throws(() => publicationDecision(manifest, plan, packument([], "nightly", "0.5.6-nightly.99")), /missing version/);
  await assert.rejects(registryPackage(manifest.name, async () => ({status: 503, ok: false})), /HTTP 503/);
  await assert.rejects(registryPackage(manifest.name, async () => { throw new Error("network unavailable"); }), /network/);
  assert.deepEqual(await registryPackage(manifest.name, async () => ({status: 404})), empty());
  await registryPackage(manifest.name, async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return {status: 200, ok: true, json: async () => empty()};
  });
  await assert.rejects(registryPackage(manifest.name, async () => ({
    status: 200, ok: true, json: async () => { throw new Error("response body failed"); },
  })), /response body failed/);
});

function wrapperForPlan(release) {
  return stampManifest({name: "@runtimed/node", version: release.baseVersion,
    optionalDependencies: Object.fromEntries(plan.nativeTargets.map(target => [packageName(target), "workspace:*"])),
  }, release, "wrapper");
}

test("partial native publication blocks wrapper; retry can finish after the missing package appears", async () => {
  const wrapper = wrapperForPlan(plan);
  const natives = new Map(plan.nativeTargets.map(target => [packageName(target), stampManifest({name: packageName(target), version: plan.baseVersion}, plan, target)]));
  const last = natives.get(packageName("win32-arm64-msvc"));
  natives.delete(last.name);
  let publishes = 0;
  const dependencies = {
    fetchPackage: async name => natives.has(name) ? packument([natives.get(name)]) : empty(),
    publish: () => { publishes++; },
  };
  await assert.rejects(publishPackage(wrapper, plan, "wrapper", dependencies), /Required native package is not published/);
  assert.equal(publishes, 0);
  natives.set(last.name, last);
  const result = await publishPackage(wrapper, plan, "wrapper", dependencies);
  assert.equal(result.status, "published");
  assert.equal(publishes, 1);
});

test("an existing wrapper cannot claim a newly enabled platform or wrong native version", async () => {
  const wrapper = wrapperForPlan(plan);
  const historical = structuredClone(wrapper);
  delete historical.optionalDependencies[packageName("linux-arm64-gnu")];
  await assert.rejects(publishPackage(wrapper, plan, "wrapper", {
    fetchPackage: async () => packument([historical]), publish: () => assert.fail(),
  }), /publication gate/);
  historical.optionalDependencies = {...wrapper.optionalDependencies, [packageName(nativeTarget)]: "^0.5.6"};
  await assert.rejects(publishPackage(wrapper, plan, "wrapper", {
    fetchPackage: async () => packument([historical]), publish: () => assert.fail(),
  }), /must be exactly/);
});

test("disabled ARM64 is still packable but cannot be published", async () => {
  const gatedPlan = releasePlan(plan.baseVersion, identity, "false");
  for (const target of ["linux-arm64-gnu", "win32-arm64-msvc"]) {
    const gated = stampManifest({name: packageName(target), version: plan.baseVersion}, gatedPlan, target);
    await assert.rejects(publishPackage(gated, gatedPlan, target, {
      fetchPackage: async () => empty(), publish: () => assert.fail(),
    }), /publication gate/);
  }
});
