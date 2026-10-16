import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {gzipSync} from "node:zlib";
import {candidateName, buildTitle, digest, integrity, packageManifest, packedPaths, packJobStatusAtAttempt, publishWasmPackage, readTarball, resolveCandidate, resolveWasmPlan, runtimeFiles, runtimeRoot, seal, validatePacked, waitForWasmPublication, wasmPublicationDecision, wasmReleasePlan} from "../ci/npm-wasm-release.mjs";

const source = JSON.parse(readFileSync(new URL("../../packages/runtimed-wasm/package.json", import.meta.url)));
const identity = {sourceSha: "a".repeat(40), channel: "nightly", runId: "100", runAttempt: "2"};
const raw = Object.fromEntries([...runtimeFiles, "LICENSE", "package.json"].map(name => [name, Buffer.from(name)]));
const wasm = {...identity, runAttempt: "1", schema: 1, version: "0.7.6-nightly.202610150000", files: Object.fromEntries(Object.entries(raw).map(([name, bytes]) => [`${runtimeRoot}/${name}`, digest(bytes)]))};
const plan = wasmReleasePlan(source, identity, wasm, {id: 10, digest: `sha256:${"b".repeat(64)}`});
function tar(files, type = 48) {
  const chunks = [];
  for (const [name, bytes] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0);
    header.write("0000644\0", 100);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header[156] = type;
    header.fill(32, 148, 156);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
const files = {
  "package.json": Buffer.from(JSON.stringify(packageManifest(source, plan))),
  "README.md": Buffer.from("readme"), "LICENSE": raw.LICENSE,
  "lib/THIRD_PARTY_NOTICES.md": Buffer.from("notices"),
  "lib/build-info.json": Buffer.from(JSON.stringify({release: identity, wasm: Object.fromEntries(runtimeFiles.map(file => [file, digest(raw[file])]))})),
  ...Object.fromEntries(runtimeFiles.map(file => [`lib/${file}`, raw[file]])),
};
const bytes = tar(files);
const candidate = seal(plan, bytes, "200", "1");
const empty = {versions: {}, "dist-tags": {}};

test("WASM plan retains earlier successful release attempt and stable/nightly identity", () => {
  assert.equal(plan.version, `${source.version}-nightly.100`);
  assert.equal(plan.wasm.runAttempt, "1");
  const stable = {...identity, channel: "stable"};
  assert.equal(wasmReleasePlan(source, stable, {...wasm, channel: "stable", version: "0.7.6-stable.202610150000"}, {id: 10}).version, source.version);
  assert.throws(() => wasmReleasePlan({...source, name: "wrong"}, identity, wasm, {id: 10}), /package name/);
  assert.throws(() => wasmReleasePlan(source, identity, {...wasm, sourceSha: "b".repeat(40)}, {id: 10}), /identity/);
  assert.throws(() => wasmReleasePlan(source, identity, {...wasm, runAttempt: "3"}, {id: 10}), /after/);
  assert.throws(() => wasmReleasePlan(source, identity, {...wasm, files: {}}, {id: 10}), /manifest/);
});

test("packed bytes preserve generated JS, wasm, types, license and source receipt", () => {
  assert.deepEqual(Object.keys(readTarball(bytes)).sort(), packedPaths);
  assert.equal(validatePacked(candidate, bytes).manifest.name, "@runtimed/wasm");
  assert.throws(() => validatePacked({...candidate, sha256: "0".repeat(64)}, bytes), /checksum/);
  const changed = tar({...files, "lib/runtimed_wasm_bg.wasm": Buffer.from("wrong module")});
  assert.throws(() => seal(plan, changed, "200", "1"), /Changed release WASM/);
  const badManifest = Buffer.from(JSON.stringify({...JSON.parse(files["package.json"]), scripts: {postinstall: "bad"}}));
  assert.throws(() => seal(plan, tar({...files, "package.json": badManifest}), "200", "1"), /no scripts/);
});

test("WASM selection uses latest successful prior attempt, ignoring failed/future jobs", async () => {
  const upstream = {id: 100, head_sha: identity.sourceSha};
  const attempts = [1, 2, 3].map(attempt => ({id: 10 + attempt, name: `release-wasm-100-${attempt}`, digest: `sha256:${"b".repeat(64)}`, workflow_run: {id: 100, head_sha: identity.sourceSha}}));
  const wasmApi = {
    artifacts: async () => attempts,
    successfulJob: async (_id, attempt) => attempt === "1",
    readReceipt: async artifact => ({...wasm, runAttempt: artifact.name.slice(-1)}),
  };
  assert.equal((await resolveWasmPlan(source, identity, upstream, wasmApi)).wasm.runAttempt, "1");
  assert.equal((await resolveWasmPlan(source, identity, upstream, {...wasmApi, successfulJob: async () => true})).wasm.runAttempt, "2");
  await assert.rejects(resolveWasmPlan(source, identity, upstream, {...wasmApi, successfulJob: async () => true, artifacts: async () => [attempts[0]]}), /attempt 2 has no retained receipt/);
  await assert.rejects(resolveWasmPlan(source, identity, upstream, {...wasmApi, successfulJob: async () => false}), /do not rebuild/);
  await assert.rejects(resolveWasmPlan(source, identity, upstream, {...wasmApi, readReceipt: async () => ({...wasm, runAttempt: "2"})}), /attempt mismatch/);
  await assert.rejects(resolveWasmPlan(source, identity, upstream, {...wasmApi, artifacts: async () => attempts.map(item => ({...item, expired: true}))}), /expired/);
});

test("publisher parses only an exact regular-file inventory and rejects traversal/links", () => {
  assert.throws(() => readTarball(tar({...files, "../../outside": Buffer.from("bad")})), /Unexpected/);
  assert.throws(() => readTarball(tar(files, 50)), /tar header/);
  const missing = {...files}; delete missing.LICENSE;
  assert.throws(() => readTarball(tar(missing)), /Incomplete/);
});

test("publication gate is enforced before any API or npm invocation", async () => {
  const {spawnSync} = await import("node:child_process");
  const result = spawnSync(process.execPath, [new URL("../ci/npm-wasm-release-cli.mjs", import.meta.url).pathname, "publish", "/nonexistent"], {env: {...process.env, NPM_WASM_ENABLED: "false"}, encoding: "utf8"});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gate is disabled/);
});

for (const channel of ["stable", "nightly"]) {
  test(`${channel} immutable registry retries need exact source and SHA-512`, () => {
    const selectedPlan = {...plan, channel, distTag: channel === "stable" ? "latest" : "nightly", version: channel === "stable" ? source.version : plan.version, wasm: {...plan.wasm, channel, version: `0.7.6-${channel}.202610150000`}};
    const selectedFiles = {...files,
      "package.json": Buffer.from(JSON.stringify(packageManifest(source, selectedPlan))),
      "lib/build-info.json": Buffer.from(JSON.stringify({...JSON.parse(files["lib/build-info.json"]), release: {...identity, channel}})),
    };
    const packed = tar(selectedFiles);
    const selected = seal(selectedPlan, packed, "200", "1");
    const manifest = JSON.parse(selectedFiles["package.json"]);
    assert.equal(wasmPublicationDecision(selected, packed, empty), "publish");
    const published = {...manifest, dist: {integrity: integrity(packed)}};
    const registry = {versions: {[manifest.version]: published}, "dist-tags": {[selectedPlan.distTag]: manifest.version}};
    assert.equal(wasmPublicationDecision(selected, packed, registry), "existing");
    published.dist.integrity = "sha512-wrong";
    assert.throws(() => wasmPublicationDecision(selected, packed, registry), /tarball differs/);
    published.dist.integrity = integrity(packed);
    published.nteractRelease = {...published.nteractRelease, sourceSha: "f".repeat(40)};
    assert.throws(() => wasmPublicationDecision(selected, packed, registry), /identity/);
  });
}

test("stale missing version fails without changing a channel", () => {
  const newer = {...JSON.parse(files["package.json"]), version: `${source.version}-nightly.101`, nteractRelease: {...identity, runId: "101"}};
  assert.throws(() => wasmPublicationDecision(candidate, bytes, {versions: {[newer.version]: newer}, "dist-tags": {nightly: newer.version}}), /backwards/);
});

const publishedManifest = {...JSON.parse(files["package.json"]), dist: {integrity: candidate.integrity}};
const visible = {versions: {[plan.version]: publishedManifest}, "dist-tags": {nightly: plan.version}};
function visibilityClock() {
  let elapsed = 0;
  const waits = [];
  return {get elapsed() {return elapsed;}, waits, options: {
    now: () => elapsed, wait: async ms => {waits.push(ms); elapsed += ms;}, onWait: () => {},
  }};
}

test("accepted upload waits through five minutes of processing without another upload", async () => {
  const clock = visibilityClock();
  const events = [];
  const result = await publishWasmPackage(candidate, bytes, {
    fetchPackage: async name => {assert.equal(name, source.name); events.push("read"); return clock.elapsed >= 300_000 ? visible : empty;},
    publish: async () => {events.push("upload");},
    onAccepted: () => {events.push("accepted");}, visibility: clock.options,
  });
  assert.equal(result, "publish");
  assert.equal(clock.elapsed, 300_000);
  assert.equal(events.filter(event => event === "upload").length, 1);
  assert.deepEqual(events.slice(0, 4), ["read", "upload", "accepted", "read"]);
  assert(clock.waits.every(ms => ms > 0 && ms <= 15_000));
});

test("invisible accepted upload fails at the bounded deadline with verification-only recovery", async () => {
  const clock = visibilityClock();
  let uploads = 0;
  await assert.rejects(publishWasmPackage(candidate, bytes, {
    fetchPackage: async () => empty, publish: async () => {uploads++;}, visibility: clock.options,
  }), /visibility is still pending after 900000ms.*verify-published.*do not rebuild or blindly republish/);
  assert.equal(clock.elapsed, 900_000);
  assert.equal(uploads, 1);
});

test("visibility checks once at the deadline and never sleep past it", async () => {
  const clock = visibilityClock();
  await waitForWasmPublication(candidate, bytes, {
    ...clock.options, timeoutMs: 37, intervalMs: 15,
    fetchPackage: async () => clock.elapsed === 37 ? visible : empty,
  });
  assert.deepEqual(clock.waits, [15, 15, 7]);
});

test("existing exact version skips upload and visibility waiting", async () => {
  const clock = visibilityClock();
  assert.equal(await publishWasmPackage(candidate, bytes, {
    fetchPackage: async () => visible, publish: () => assert.fail("must not upload"),
    onAccepted: () => assert.fail("must not claim a new upload"), visibility: clock.options,
  }), "existing");
  assert.equal(clock.elapsed, 0);
});

test("visibility fails closed on changed source/integrity, malformed registry, or stale channel", async () => {
  const newer = {...publishedManifest, version: `${source.version}-nightly.101`, nteractRelease: {...identity, runId: "101"}};
  const cases = [
    [{...visible, versions: {[plan.version]: {...publishedManifest, dist: {integrity: "sha512-wrong"}}}}, /tarball differs/],
    [{...visible, versions: {[plan.version]: {...publishedManifest, nteractRelease: {...identity, sourceSha: "f".repeat(40)}}}}, /identity/],
    [{versions: [], "dist-tags": {}}, /Invalid registry metadata/],
    [{versions: {[newer.version]: newer}, "dist-tags": {nightly: newer.version}}, /backwards/],
  ];
  for (const [packument, error] of cases) {
    const clock = visibilityClock();
    let reads = 0, uploads = 0;
    await assert.rejects(publishWasmPackage(candidate, bytes, {
      fetchPackage: async () => ++reads === 1 ? empty : packument,
      publish: async () => {uploads++;}, visibility: clock.options,
    }), error);
    assert.equal(uploads, 1);
    assert.equal(clock.elapsed, 0);
  }
});

test("failed upload or registry lookup is not silently retried or called verified", async () => {
  let reads = 0;
  await assert.rejects(publishWasmPackage(candidate, bytes, {
    fetchPackage: async () => {reads++; return empty;}, publish: async () => {throw new Error("upload rejected");},
    onAccepted: () => assert.fail("upload was not accepted"),
  }), /upload rejected/);
  assert.equal(reads, 1);
  await assert.rejects(waitForWasmPublication(candidate, bytes, {
    fetchPackage: async () => {throw new Error("HTTP 503");}, wait: () => assert.fail("lookup errors must remain visible"),
  }), /HTTP 503/);
});

test("verification-only CLI reads exact public metadata without npm, OIDC, or an enabled gate", () => {
  const directory = mkdtempSync(join(tmpdir(), "wasm-visibility-test-"));
  try {
    writeFileSync(join(directory, "candidate.json"), JSON.stringify(candidate));
    writeFileSync(join(directory, "runtimed-wasm.tgz"), bytes);
    const preload = join(directory, "registry.mjs");
    writeFileSync(preload, `import assert from 'node:assert/strict';
      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://registry.npmjs.org/%40runtimed%2Fwasm');
        assert.deepEqual(options.headers, {'Cache-Control': 'no-cache'});
        return new Response(${JSON.stringify(JSON.stringify(visible))});
      };`);
    const environment = {...process.env, PATH: "", NPM_WASM_ENABLED: "false"};
    for (const name of ["GITHUB_STEP_SUMMARY", "GITHUB_EVENT_PATH", "GH_TOKEN", "NODE_AUTH_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) delete environment[name];
    const result = spawnSync(process.execPath, ["--import", preload, new URL("../ci/npm-wasm-release-cli.mjs", import.meta.url).pathname, "verify-published", directory], {env: environment, encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /existing.*verified immutable integrity/);
    assert(result.stdout.includes(candidate.integrity));
  } finally {rmSync(directory, {recursive: true, force: true});}
});

const repository = "nteract/nteract";
const build = {id: 200, run_attempt: 2, display_title: buildTitle(identity), head_sha: "c".repeat(40), repository: {full_name: repository}, head_repository: {full_name: repository}, path: ".github/workflows/build-wasm-npm.yml", head_branch: "main", event: "workflow_run"};
const artifact = {id: 300, name: candidateName(identity), digest: `sha256:${"d".repeat(64)}`, workflow_run: {id: 200, head_sha: build.head_sha}};
function api(overrides = {}) {
  return {repository, defaultBranch: "main", buildRuns: async () => [build], artifacts: async () => [artifact], readCandidate: async () => candidate, successfulJob: async () => true, packJobStatus: async () => "success", ...overrides};
}

test("duplicate events and failed-job retries reuse the first successful pack attempt", async () => {
  const result = await resolveCandidate(identity, api());
  assert.equal(result.artifact.id, 300);
  assert.equal(result.candidate.buildRunAttempt, "1");
});

test("expired or deleted successful packs fail; incomplete pack may retry", async () => {
  await assert.rejects(resolveCandidate(identity, api({artifacts: async () => [{...artifact, expired: true}]})), /expired/);
  await assert.rejects(resolveCandidate(identity, api({artifacts: async () => []})), /never repack/);
  assert.equal(await resolveCandidate(identity, api({artifacts: async () => [], successfulJob: async () => false})), null);
  await assert.rejects(resolveCandidate(identity, api({packJobStatus: async () => "failed"})), /did not succeed/);
});

test("visible candidate waits for its owning pack job; producers cannot repack it", async () => {
  const pending = api({packJobStatus: async () => "pending"});
  assert.equal(await resolveCandidate(identity, pending), null);
  await assert.rejects(resolveCandidate(identity, pending, {runId: "201"}), /still running/);
  await assert.rejects(resolveCandidate(identity, api({packJobStatus: async () => "missing"})), /did not succeed/);
});

test("pack proof distinguishes pending, failed and carried-forward job attempts", () => {
  const job = {name: "Pack WASM npm package", run_attempt: 1, status: "completed", conclusion: "success"};
  assert.equal(packJobStatusAtAttempt([job], "1"), "success");
  assert.equal(packJobStatusAtAttempt([job], "2"), "missing");
  assert.equal(packJobStatusAtAttempt([{...job, status: "in_progress", conclusion: null}], "1"), "pending");
  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    assert.equal(packJobStatusAtAttempt([{...job, conclusion}], "1"), "failed");
  }
});

test("untrusted enumerated runs cannot poison recovery; artifact/source mismatches fail", async () => {
  for (const patch of [{path: ".github/workflows/other.yml"}, {head_branch: "feature"}, {repository: {full_name: "other/repo"}}]) {
    assert.equal(await resolveCandidate(identity, api({buildRuns: async () => [{...build, ...patch}]})), null);
    assert.equal((await resolveCandidate(identity, api({buildRuns: async () => [{...build, id: 199, ...patch}, build]}))).artifact.id, 300);
  }
  await assert.rejects(resolveCandidate(identity, api({artifacts: async () => [{...artifact, workflow_run: {id: 201, head_sha: build.head_sha}}]})), /origin/);
  await assert.rejects(resolveCandidate(identity, api({readCandidate: async () => ({...candidate, plan: {...plan, sourceSha: "f".repeat(40)}})})), /origin/);
});

test("WASM producer has no recompilation/publication and publisher stays independent", () => {
  const producer = readFileSync(new URL("../../.github/workflows/build-wasm-npm.yml", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
  assert.doesNotMatch(producer, /id-token: write|contents: write|npm publish|\bwasm-pack\s|cargo xtask wasm|overwrite: true/);
  assert.match(producer, /queue: max\n  cancel-in-progress: false/);
  assert.match(producer, /plan_name: \$\{\{ steps\.plan\.outputs\.plan_name \}\}/);
  assert.match(producer, /name: \$\{\{ needs\.resolve\.outputs\.plan_name \}\}/);
  const publisher = workflow.split("  publish-wasm:\n")[1].split("\n  resolve-release:")[0];
  assert.match(publisher, /needs: \[resolve-wasm\]/);
  assert.match(publisher, /id-token: write/);
  assert.match(publisher, /vars.NPM_WASM_ENABLED == 'true'/);
  assert.doesNotMatch(publisher, /actions\/checkout|npm (install|pack)\b|pnpm|cargo|secrets\./);
  assert.doesNotMatch(workflow.slice(workflow.indexOf("  resolve-release:\n")), /needs:.*wasm/);
});
