import assert from "node:assert/strict";
import {test} from "node:test";
import {receipt, recoveryTransition, recoverWheel, downloadWheel, wheelDigest} from "../ci/nightly-wheel-recovery.mjs";

const context = () => ({repository: receipt.repository, ref: "refs/heads/main", event: "workflow_dispatch", channel: "nightly", runId: receipt.runId});
function snapshot(complete = false) {
  const assets = receipt.wheels.map(wheel => ({...wheel, state: "uploaded", digest: `sha256:${wheel.sha256}`, created_at: "2026-11-08T16:21:48Z", updated_at: "2026-11-08T16:21:52Z"}));
  for (let i = assets.length; i < 56; i++) assets.push({id: i + 1, name: `asset-${i}`, state: "uploaded", size: 100, digest: `sha256:${"a".repeat(64)}`, created_at: "2026-11-08T16:21:48Z", updated_at: "2026-11-08T16:21:52Z"});
  return {
    run: {id: Number(receipt.runId), run_attempt: 2, repository: {full_name: receipt.repository}, head_repository: {full_name: receipt.repository}, head_sha: receipt.sourceSha, head_branch: "main", path: ".github/workflows/release-nightly.yml", event: "schedule", status: "completed", conclusion: "failure"},
    jobs: [...receipt.producerJobs.map(name => ({name, conclusion: "success"})), {name: "release / Nightly Release", conclusion: "failure", steps: [
      {name: "Create GitHub Release", conclusion: "success"},
      {name: "Verify published release tag still matches built source", conclusion: "success"},
      {name: "Publish runtimed to PyPI", conclusion: "failure"},
    ]}, ...["release / Publish agent plugins", "release / Publish runtime-peer image"].map(name => ({name, conclusion: "skipped"}))],
    release: {id: receipt.releaseId, tag_name: receipt.tag, draft: false, prerelease: true, assets},
    tag: {ref: `refs/tags/${receipt.tag}`, object: {type: "commit", sha: receipt.sourceSha}},
    pypi: {info: {name: "runtimed", version: receipt.pythonVersion}, urls: receipt.wheels.slice(0, complete ? 6 : 5).map(wheel => ({filename: wheel.name, size: wheel.size, digests: {sha256: wheel.sha256}, yanked: false}))},
    simple: {name: "runtimed", meta: {"_last-serial": 43376237}, files: receipt.wheels.slice(0, complete ? 6 : 5).map(wheel => ({filename: wheel.name, size: wheel.size, hashes: {sha256: wheel.sha256}, yanked: false}))},
  };
}

test("five matching wheels need one upload; six matching wheels are already complete", () => {
  assert.equal(recoveryTransition({phase: "checking"}, {type: "snapshot", value: snapshot()}).phase, "needs-upload");
  assert.equal(recoveryTransition({phase: "checking"}, {type: "snapshot", value: snapshot(true)}).phase, "already-complete");
});

for (const [name, change] of [
  ["source", s => s.run.head_sha = "a".repeat(40)],
  ["attempt", s => s.run.run_attempt = 3],
  ["run", s => s.run.id++],
  ["repository", s => s.run.repository.full_name = "foreign/repo"],
  ["head repository", s => s.run.head_repository.full_name = "foreign/repo"],
  ["workflow", s => s.run.path = ".github/workflows/release-stable.yml"],
  ["event", s => s.run.event = "pull_request"],
  ["producer failure", s => s.jobs[0].conclusion = "failure"],
  ["producer missing", s => s.jobs.shift()],
  ["duplicate producer", s => s.jobs.push(s.jobs[0])],
  ["unexpected job", s => s.jobs.push({name: "other", conclusion: "success"})],
  ["wrong failed step", s => s.jobs[20].steps[2].name = "Create GitHub Release"],
  ["GitHub failure", s => s.jobs[20].steps[0].conclusion = "failure"],
  ["tag", s => s.tag.object.sha = "a".repeat(40)],
  ["release ID", s => s.release.id++],
  ["stable release", s => s.release.prerelease = false],
  ["GitHub asset ID", s => s.release.assets[5].id++],
  ["GitHub wheel hash", s => s.release.assets[0].digest = `sha256:${"a".repeat(64)}`],
  ["incomplete asset", s => s.release.assets[10].state = "starter"],
  ["missing asset", s => s.release.assets.pop()],
  ["duplicate asset", s => s.release.assets[10].name = s.release.assets[11].name],
  ["missing digest", s => delete s.release.assets[10].digest],
  ["PyPI hash", s => s.pypi.urls[0].digests.sha256 = "a".repeat(64)],
  ["PyPI size", s => s.pypi.urls[0].size++],
  ["PyPI version", s => s.pypi.info.version = "2.10.0"],
  ["other missing wheel", s => s.pypi.urls.shift()],
  ["extra wheel", s => s.pypi.urls.push({...s.pypi.urls[0], filename: "extra.whl"})],
  ["duplicate wheel", s => s.pypi.urls.push(s.pypi.urls[0])],
  ["yanked wheel", s => s.pypi.urls[0].yanked = true],
  ["simple index mismatch", s => s.simple.files[0].hashes.sha256 = "a".repeat(64)],
  ["simple index missing wheel", s => s.simple.files.pop()],
  ["simple index missing serial", s => delete s.simple.meta["_last-serial"]],
]) {
  test(`recovery refuses ${name}`, () => {
    const value = snapshot(); change(value);
    assert.throws(() => recoveryTransition({phase: "checking"}, {type: "snapshot", value}));
  });
}

function api(complete = false) {
  const calls = [];
  let value = snapshot(complete);
  return {
    calls,
    snapshot: async () => { calls.push("snapshot"); return structuredClone(value); },
    download: async () => { calls.push("download"); return {size: receipt.wheels[5].size, sha256: receipt.wheels[5].sha256}; },
    publish: async () => { calls.push("publish"); value = snapshot(true); },
  };
}
test("first recovery publishes once and verifies fresh metadata; repeat has no download or publish", async () => {
  const first = api();
  assert.equal((await recoverWheel(context(), first)).phase, "complete");
  assert.deepEqual(first.calls, ["snapshot", "download", "snapshot", "publish", "snapshot"]);
  const repeat = api(true);
  assert.equal((await recoverWheel(context(), repeat)).phase, "complete");
  assert.deepEqual(repeat.calls, ["snapshot", "snapshot"]);
});
for (const [field, value] of [["runId", "other"], ["runId", ""], ["channel", "stable"], ["event", "schedule"], ["ref", "refs/heads/other"], ["repository", "foreign/repo"]]) {
  test(`dispatch rejects ${field}=${value} before effects`, async () => {
    const mock = api();
    await assert.rejects(recoverWheel({...context(), [field]: value}, mock));
    assert.deepEqual(mock.calls, []);
  });
}
test("downloaded byte mismatch stops before publication", async () => {
  const mock = api();
  mock.download = async () => wheelDigest(Buffer.from("not the wheel"));
  await assert.rejects(recoverWheel(context(), mock), /wheel bytes/);
  assert.deepEqual(mock.calls, ["snapshot"]);
});
test("failed publish is not retried or reported complete", async () => {
  const mock = api();
  mock.publish = async () => { mock.calls.push("publish"); throw new Error("upload failed"); };
  await assert.rejects(recoverWheel(context(), mock), /upload failed/);
  assert.equal(mock.calls.filter(x => x === "publish").length, 1);
});
test("a concurrent matching sixth wheel skips publication after download", async () => {
  const mock = api(); let reads = 0;
  mock.snapshot = async () => snapshot(++reads > 1);
  assert.equal((await recoverWheel(context(), mock)).phase, "complete");
  assert.deepEqual(mock.calls, ["download"]);
});
test("a previously complete set disappearing on verification fails without uploading", async () => {
  const mock = api(true); let reads = 0;
  mock.snapshot = async () => snapshot(++reads === 1);
  await assert.rejects(recoverWheel(context(), mock), /PyPI wheel set is not complete/);
  assert.deepEqual(mock.calls, []);
});
for (const when of [2, 3]) {
  test(`GitHub change in snapshot ${when} aborts recovery`, async () => {
    const mock = api(); let count = 0;
    mock.snapshot = async () => {
      const value = snapshot(++count === 3);
      if (count >= when) value.release.assets[10].updated_at = "2026-11-08T22:00:00Z";
      return value;
    };
    await assert.rejects(recoverWheel(context(), mock), when === 2 ? /GitHub assets changed/ : /upload accepted but verification incomplete/);
    assert.equal(mock.calls.filter(x => x === "publish").length, when === 2 ? 0 : 1);
  });
}
test("missing post-upload wheel cannot report completion", async () => {
  const mock = api(); mock.publish = async () => {};
  await assert.rejects(recoverWheel(context(), mock), /upload accepted but verification incomplete/);
});
test("metadata HTTP failure stops before download and publish", async () => {
  const mock = api(); mock.snapshot = async () => { throw new Error("HTTP 503"); };
  await assert.rejects(recoverWheel(context(), mock), /HTTP 503/);
  assert.deepEqual(mock.calls, []);
});
test("state machine rejects invalid events", () => {
  for (const phase of ["checking", "needs-upload", "ready", "uploading", "verifying", "already-complete", "accepted-unverified", "complete"]) {
    assert.throws(() => recoveryTransition({phase}, {type: "unexpected"}), /Invalid recovery transition/);
  }
});
test("download permits only a fixed GitHub URL and one credential-free asset redirect", async () => {
  const calls = [];
  await assert.rejects(downloadWheel(async (url, options) => {
    calls.push({url: String(url), options});
    return calls.length === 1 ? new Response(null, {status: 302, headers: {location: "https://release-assets.githubusercontent.com/asset?signature=private"}}) : new Response("wrong bytes");
  }), /wheel bytes/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://github.com/${receipt.repository}/releases/download/${receipt.tag}/${receipt.wheels[5].name}`);
  for (const call of calls) {
    assert.equal(call.options.redirect, "manual");
    assert.equal(call.options.headers, undefined);
  }
});
for (const location of ["https://evil.example/file", "http://release-assets.githubusercontent.com/file", "https://user:pass@release-assets.githubusercontent.com/file", "https://release-assets.githubusercontent.com:444/file"]) {
  test(`download rejects redirect ${location}`, async () => {
    let calls = 0;
    await assert.rejects(downloadWheel(async () => { calls++; return new Response(null, {status: 302, headers: {location}}); }), /redirect/);
    assert.equal(calls, 1);
  });
}
test("download rejects another redirect and never follows it", async () => {
  let calls = 0;
  await assert.rejects(downloadWheel(async () => {
    calls++;
    return new Response(null, {status: 302, headers: {location: "https://release-assets.githubusercontent.com/asset"}});
  }), /Wheel download failed/);
  assert.equal(calls, 2);
});
test("download hash checks use SHA256 over exact bytes", () => {
  assert.deepEqual(wheelDigest(Buffer.from("abc")), {size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"});
});
