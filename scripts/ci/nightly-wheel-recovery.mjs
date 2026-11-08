#!/usr/bin/env node
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

// This receipt authorizes completion of one existing nightly wheel set, not a release.
export const receipt = {
  repository: "nteract/nteract",
  runId: "42465470406",
  attempt: 2,
  sourceSha: "84e8d32d1913e113dd142158f61e5d0dfd9a9fb0",
  releaseId: 438364312,
  tag: "v2.10.0-nightly.202611080902",
  pythonVersion: "2.10.1a202611080902",
  wheels: [
    [724483631, "macosx_10_12_x86_64", 20323364, "478452e5736cd3469f887db6c7740730fe911ef07bea22019874d0a41cbafa74"],
    [724483639, "macosx_11_0_arm64", 20724354, "5347f351794b63607707ea213f25a35c796c240e090677b9ad386b837bce9bf4"],
    [724483632, "manylinux_2_39_aarch64", 25346324, "d34c05abe679c0387a6df2d3b992739578381df32467b7375333e2c3730dee63"],
    [724483629, "manylinux_2_39_x86_64", 23927327, "30d26092d02040ce253d774a7257a729b5f9ce06eb5873cb56c3f35bcd0e247a"],
    [724483643, "win_amd64", 20310514, "8a3030672c177e158f9172dd82c4cdc14c1288a426c5d626a2907399cb5ea7d0"],
    [724483630, "win_arm64", 19704028, "f4aafc450e3fc751e7e4f4b7053d0ff8728cb7ea2bec7b94111e8c65bd4459e6"],
  ].map(([id, platform, size, sha256]) => ({id, name: `runtimed-2.10.1a202611080902-cp39-abi3-${platform}.whl`, size, sha256})),
  producerJobs: [
    "Compute Version", "Build WASM artifacts", "Build Linux x64 Executables", "Build Linux arm64 Executables",
    "Build macOS Executables", "Build macOS ARM64 Notebook", "Build macOS x64 Notebook",
    "Build Windows x64 Notebook", "Build Windows ARM64 Notebook", "Build Linux x64 Notebook", "Build Linux arm64 Notebook",
    "Smoke Fedora AppImage (x64)", "Smoke Fedora AppImage (arm64)", "Build and smoke runtime-peer image",
    ...["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"].map(target => `Build Python Wheels (${target})`),
  ].map(name => `release / ${name}`),
};
const wheel = receipt.wheels[5];
class RecoveryError extends Error {}
const requireThat = (condition, message) => { if (!condition) throw new RecoveryError(message); };
export function checkContext(context) {
  requireThat(context.repository === receipt.repository && context.ref === "refs/heads/main" && context.event === "workflow_dispatch" && context.channel === "nightly" && context.runId === receipt.runId, "Recovery requires the allowlisted nightly dispatch on main");
}
function validateSnapshot({run, jobs, release, tag, pypi, simple}) {
  requireThat(String(run.id) === receipt.runId && run.run_attempt === receipt.attempt && run.repository?.full_name === receipt.repository && run.head_repository?.full_name === receipt.repository && run.head_sha === receipt.sourceSha && run.head_branch === "main" && run.path === ".github/workflows/release-nightly.yml" && run.event === "schedule" && run.status === "completed" && run.conclusion === "failure", "Original release run identity changed");
  const expectedJobs = [...receipt.producerJobs, "release / Nightly Release", "release / Publish agent plugins", "release / Publish runtime-peer image"];
  requireThat(Array.isArray(jobs) && jobs.length === expectedJobs.length && new Set(jobs.map(job => job.name)).size === expectedJobs.length && jobs.every(job => expectedJobs.includes(job.name)), "Unexpected original producer job inventory");
  for (const name of receipt.producerJobs) requireThat(jobs.find(job => job.name === name).conclusion === "success", `Producer job did not succeed: ${name}`);
  for (const name of expectedJobs.slice(-2)) requireThat(jobs.find(job => job.name === name).conclusion === "skipped", "Downstream publication state changed");
  const publication = jobs.find(job => job.name === "release / Nightly Release");
  requireThat(publication.conclusion === "failure" && Array.isArray(publication.steps), "Expected failed publisher");
  for (const name of ["Create GitHub Release", "Verify published release tag still matches built source"]) {
    const steps = publication.steps.filter(step => step.name === name);
    requireThat(steps.length === 1 && steps[0].conclusion === "success", "Original GitHub publication/tag check did not succeed");
  }
  const failures = publication.steps.filter(step => step.conclusion === "failure");
  requireThat(failures.length === 1 && failures[0].name === "Publish runtimed to PyPI", "Expected isolated PyPI publication failure");
  requireThat(tag.ref === `refs/tags/${receipt.tag}` && tag.object?.type === "commit" && tag.object.sha === receipt.sourceSha, "Reserved tag no longer matches producer source");
  requireThat(release.id === receipt.releaseId && release.tag_name === receipt.tag && release.draft === false && release.prerelease === true, "GitHub release identity changed");
  const assets = release.assets;
  requireThat(Array.isArray(assets) && assets.length === 56 && new Set(assets.map(asset => asset.id)).size === 56 && new Set(assets.map(asset => asset.name)).size === 56, "Unexpected GitHub asset inventory");
  for (const asset of assets) requireThat(Number.isSafeInteger(asset.id) && asset.id > 0 && typeof asset.name === "string" && asset.name.length > 0 && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.state === "uploaded" && /^sha256:[a-f0-9]{64}$/.test(asset.digest) && Number.isFinite(Date.parse(asset.created_at)) && Number.isFinite(Date.parse(asset.updated_at)), "Invalid GitHub asset metadata");
  for (const expected of receipt.wheels) {
    const asset = assets.find(asset => asset.name === expected.name);
    requireThat(asset?.id === expected.id && asset.size === expected.size && asset.digest === `sha256:${expected.sha256}`, "GitHub wheel does not match pinned receipt");
  }
  requireThat(pypi.info?.name === "runtimed" && pypi.info.version === receipt.pythonVersion && Array.isArray(pypi.urls) && [5, 6].includes(pypi.urls.length) && new Set(pypi.urls.map(file => file.filename)).size === pypi.urls.length, "Unexpected PyPI wheel inventory");
  for (const file of pypi.urls) {
    const expected = receipt.wheels.find(wheel => wheel.name === file.filename);
    requireThat(expected && file.size === expected.size && file.digests?.sha256 === expected.sha256 && file.yanked === false, "PyPI wheel does not match pinned receipt");
  }
  requireThat(receipt.wheels.slice(0, 5).every(wheel => pypi.urls.some(file => file.filename === wheel.name)), "Only Windows ARM64 may be missing");
  requireThat(simple?.name === "runtimed" && Array.isArray(simple.files) && Number.isSafeInteger(simple.meta?.["_last-serial"]), "Invalid PyPI simple index metadata");
  const indexed = simple.files.filter(file => file.filename.startsWith(`runtimed-${receipt.pythonVersion}-`));
  requireThat(indexed.length === pypi.urls.length && new Set(indexed.map(file => file.filename)).size === indexed.length, "PyPI simple index wheel inventory differs");
  for (const file of indexed) {
    const expected = receipt.wheels.find(wheel => wheel.name === file.filename);
    requireThat(expected && file.hashes?.sha256 === expected.sha256 && file.size === expected.size && file.yanked === false, "PyPI simple index wheel differs from receipt");
  }
  const baseline = JSON.stringify(assets.map(({id, name, size, digest, created_at, updated_at}) => ({id, name, size, digest, created_at, updated_at})).sort((a, b) => a.id - b.id));
  return {baseline, complete: pypi.urls.length === 6};
}
export const wheelDigest = bytes => ({size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")});
function verifyWheel(value) {
  requireThat(value.size === wheel.size && value.sha256 === wheel.sha256, "Downloaded wheel bytes do not match pinned receipt");
}

// Interrupted publication resumes by reading PyPI again; it never replays an upload blindly.
export function recoveryTransition(state, event) {
  if (state.phase === "checking" && event.type === "snapshot") {
    const {baseline, complete} = validateSnapshot(event.value);
    return {phase: complete ? "already-complete" : "needs-upload", baseline};
  }
  if (state.phase === "needs-upload" && event.type === "downloaded") {
    verifyWheel(event.value);
    return {...state, phase: "ready"};
  }
  if (state.phase === "ready" && event.type === "recheck") {
    const {baseline, complete} = validateSnapshot(event.value);
    requireThat(baseline === state.baseline, "GitHub assets changed before publication");
    return {...state, phase: complete ? "verifying" : "uploading"};
  }
  if (state.phase === "uploading" && event.type === "uploaded") return {...state, phase: "accepted-unverified"};
  if (["verifying", "already-complete", "accepted-unverified"].includes(state.phase) && event.type === "verify") {
    const {baseline, complete} = validateSnapshot(event.value);
    requireThat(baseline === state.baseline, "GitHub assets changed after publication");
    requireThat(complete, "PyPI wheel set is not complete");
    return {...state, phase: "complete", serial: event.value.simple.meta["_last-serial"]};
  }
  throw new Error("Invalid recovery transition");
}
export async function recoverWheel(context, api) {
  checkContext(context);
  let state = recoveryTransition({phase: "checking"}, {type: "snapshot", value: await api.snapshot()});
  if (state.phase === "needs-upload") {
    state = recoveryTransition(state, {type: "downloaded", value: await api.download()});
    state = recoveryTransition(state, {type: "recheck", value: await api.snapshot()});
    if (state.phase === "uploading") {
      await api.publish();
      state = recoveryTransition(state, {type: "uploaded"});
    }
  }
  try {
    return recoveryTransition(state, {type: "verify", value: await api.snapshot()});
  } catch (cause) {
    if (state.phase === "accepted-unverified") throw new Error("Wheel upload accepted but verification incomplete; reconcile public metadata before retrying", {cause});
    throw cause;
  }
}

export async function downloadWheel(fetcher = fetch) {
  const options = {redirect: "manual", signal: AbortSignal.timeout(120_000)};
  const initial = await fetcher(`https://github.com/${receipt.repository}/releases/download/${receipt.tag}/${wheel.name}`, options);
  requireThat(initial.status === 302, "Unexpected wheel download redirect");
  const redirect = new URL(initial.headers.get("location"));
  requireThat(redirect.origin === "https://release-assets.githubusercontent.com" && !redirect.username && !redirect.password && !redirect.hash, "Untrusted wheel download redirect");
  // Neither request receives the GitHub API token. Signed redirect URLs are never logged.
  const response = await fetcher(redirect, options);
  requireThat(response.status === 200, "Wheel download failed");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireThat(size <= wheel.size, "Downloaded wheel bytes exceed pinned size");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  verifyWheel(wheelDigest(bytes));
  return bytes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    const context = {repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF, event: env.GITHUB_EVENT_NAME, channel: env.RECOVERY_CHANNEL, runId: env.RECOVERY_RUN_ID};
    checkContext(context);
    requireThat(env.GITHUB_WORKFLOW_REF === `${receipt.repository}/.github/workflows/release-nightly.yml@refs/heads/main`, "Unexpected recovery caller workflow");
    requireThat(["check-context", "recover"].includes(process.argv[2]), "Expected explicit recovery command");
    if (process.argv[2] === "check-context") process.exit(0);
    const directory = mkdtempSync(join(env.RUNNER_TEMP, "nightly-wheel-recovery-"));
    const wheelPath = join(directory, wheel.name);
    const json = async (path, github = true, accept = "application/json") => {
      const response = await fetch(github ? `https://api.github.com/repos/${receipt.repository}${path}` : path, {
        redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: github ? {Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Cache-Control": "no-cache"} : {Accept: accept, "Cache-Control": "no-cache"},
      });
      requireThat(response.ok, `Recovery metadata lookup failed: HTTP ${response.status}`);
      return response.json();
    };
    try {
      const result = await recoverWheel(context, {
        snapshot: async () => {
          const [run, jobResponse, release, tag, pypi, simple] = await Promise.all([
            json(`/actions/runs/${receipt.runId}`),
            json(`/actions/runs/${receipt.runId}/attempts/${receipt.attempt}/jobs?per_page=100`),
            json(`/releases/${receipt.releaseId}`),
            json(`/git/ref/tags/${receipt.tag}`),
            json(`https://pypi.org/pypi/runtimed/${receipt.pythonVersion}/json`, false),
            json("https://pypi.org/simple/runtimed/", false, "application/vnd.pypi.simple.v1+json"),
          ]);
          requireThat(jobResponse.total_count === jobResponse.jobs?.length, "Truncated job inventory");
          return {run, jobs: jobResponse.jobs, release, tag, pypi, simple};
        },
        download: async () => {
          const bytes = await downloadWheel();
          writeFileSync(wheelPath, bytes, {flag: "wx", mode: 0o600});
          return wheelDigest(bytes);
        },
        publish: async () => {
          verifyWheel(wheelDigest(readFileSync(wheelPath)));
          requireThat(execFileSync("uv", ["--version"], {encoding: "utf8"}).trim() === "uv 0.13.7", "Expected pinned uv 0.13.7");
          const publishEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("UV_PUBLISH_") && name !== "GH_TOKEN"));
          execFileSync("uv", ["--no-config", "publish", "--trusted-publishing", "always", "--publish-url", "https://upload.pypi.org/legacy/", "--check-url", "https://pypi.org/simple/runtimed/", wheelPath], {env: publishEnv, stdio: "inherit"});
        },
      });
      const message = `PyPI wheel set complete only: runtimed ${receipt.pythonVersion}; producer ${receipt.runId}/${receipt.attempt}, source ${receipt.sourceSha}, PyPI serial ${result.serial}. GitHub assets unchanged. Original run remains failed; channels and downstream consumers remain closed.\n`;
      appendFileSync(env.GITHUB_STEP_SUMMARY, message);
      console.log(message.trim());
    } finally { rmSync(directory, {recursive: true, force: true}); }
  } catch (error) {
    console.error(error instanceof RecoveryError || error.message === "Wheel upload accepted but verification incomplete; reconcile public metadata before retrying"
      ? error.message
      : "Nightly wheel recovery failed closed. Reconcile public metadata before retrying. No GitHub assets or channels were written.");
    process.exitCode = 1;
  }
}
