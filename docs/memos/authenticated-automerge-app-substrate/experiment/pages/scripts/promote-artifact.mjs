// Production promotion from the gate's `pages-release` artifact. GitHub I/O
// goes through the operator's `gh` credentials. The run and artifact rules
// match the lab1 controller (nteract/preview-infra lib/pages-auth.mjs
// validatePagesArtifact); change both together.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RELEASE_ARCHIVE_LIMITS,
  verifyReleaseArchive,
  writeReleaseDist,
} from "./release-archive.mjs";

export const RELEASE_REPOSITORY = "nteract/nteract";
export const RELEASE_WORKFLOW = ".github/workflows/authenticated-automerge-spike.yml";
export const RELEASE_ARTIFACT = "pages-release";
export const RELEASE_JOB = "Pages release bundle";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID = /^[1-9][0-9]{0,19}$/;
const SHA = /^[0-9a-f]{40}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const fromArtifactUsage =
  "Usage: deploy.mjs --target pages prepare --from-artifact GATE_RUN_ID [--attempt N] [--worktree]";

/** Arguments after `prepare`. */
export function parseFromArtifactArgs(args) {
  const [flag, runId, ...rest] = args;
  check(flag === "--from-artifact" && ID.test(runId ?? ""), fromArtifactUsage);
  const parsed = { runId, attempt: undefined, worktree: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--attempt" && parsed.attempt === undefined && ID.test(rest[i + 1] ?? ""))
      parsed.attempt = rest[++i];
    else if (rest[i] === "--worktree" && !parsed.worktree) parsed.worktree = true;
    else throw new Error(fromArtifactUsage);
  }
  return parsed;
}

/** The gate run at one attempt: a green push to main of the Pages workflow in
 * this repository. Returns the attempt and its head SHA. */
export function validateReleaseRun(run, { runId, attempt }) {
  check(String(run?.id) === String(runId), "Gate run metadata does not name the requested run");
  check(
    run.repository?.full_name === RELEASE_REPOSITORY &&
      run.head_repository?.full_name === RELEASE_REPOSITORY,
    `Gate run must belong to ${RELEASE_REPOSITORY}`,
  );
  check(run.path === RELEASE_WORKFLOW, `Gate run must come from ${RELEASE_WORKFLOW}`);
  check(run.event === "push" && run.head_branch === "main", "Gate run must be a push to main");
  check(
    attempt === undefined || String(run.run_attempt) === String(attempt),
    `Gate run is not at attempt ${attempt}`,
  );
  check(
    run.status === "completed" && run.conclusion === "success",
    "Gate run did not succeed at this attempt",
  );
  check(SHA.test(run.head_sha ?? ""), "Gate run has no head SHA");
  return { runId: String(run.id), attempt: String(run.run_attempt), sha: run.head_sha };
}

/** GitHub artifact metadata has no run attempt. The attempt binding is the
 * release job of the exact green attempt, whose window must contain the
 * artifact's creation, plus exactly one pages-release artifact in the run. */
export function validateReleaseArtifact({ runId, attempt, sha }, { artifact, artifacts, jobs }) {
  check(
    Array.isArray(artifacts?.artifacts) && artifacts.total_count === artifacts.artifacts.length,
    "Incomplete artifact list for the gate run",
  );
  const named = artifacts.artifacts.filter((a) => a.name === RELEASE_ARTIFACT);
  check(named.length === 1, `Gate run must hold exactly one ${RELEASE_ARTIFACT} artifact`);
  check(
    artifact && String(artifact.id) === String(named[0].id),
    "Artifact metadata does not name the run's release artifact",
  );
  check(artifact.name === RELEASE_ARTIFACT, `Artifact must be named ${RELEASE_ARTIFACT}`);
  check(artifact.expired === false, "Release artifact expired");
  check(
    String(artifact.workflow_run?.id) === String(runId) && artifact.workflow_run?.head_sha === sha,
    "Release artifact belongs to another run or revision",
  );
  check(DIGEST.test(artifact.digest ?? ""), "Release artifact has no sha256 digest");
  check(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= RELEASE_ARCHIVE_LIMITS.zip,
    "Release artifact size is outside the 64 MiB cap",
  );
  check(
    Array.isArray(jobs?.jobs) && jobs.total_count === jobs.jobs.length,
    "Incomplete release job list",
  );
  const release = jobs.jobs.filter((job) => job.name === RELEASE_JOB);
  check(
    release.length === 1 &&
      release[0].conclusion === "success" &&
      String(release[0].run_id) === String(runId) &&
      String(release[0].run_attempt) === String(attempt) &&
      release[0].head_sha === sha,
    "Release job did not succeed in the green attempt",
  );
  const created = Date.parse(artifact.created_at);
  const started = Date.parse(release[0].started_at);
  const completed = Date.parse(release[0].completed_at);
  check(
    [created, started, completed].every(Number.isFinite) &&
      started <= created &&
      created <= completed,
    "Release artifact was not created by the green attempt's release job",
  );
  return {
    repository: RELEASE_REPOSITORY,
    run_id: String(runId),
    run_attempt: String(attempt),
    head_sha: sha,
    artifact_id: String(artifact.id),
    artifact_name: artifact.name,
    digest: artifact.digest,
    size_in_bytes: artifact.size_in_bytes,
    created_at: artifact.created_at,
    expires_at: artifact.expires_at,
  };
}

/** Resolve the run (latest attempt unless one is named) and its artifact. */
export function resolveReleaseArtifact({ runId, attempt, api }) {
  const base = `repos/${RELEASE_REPOSITORY}/actions`;
  const run = validateReleaseRun(
    api(
      attempt === undefined ? `${base}/runs/${runId}` : `${base}/runs/${runId}/attempts/${attempt}`,
    ),
    { runId, attempt },
  );
  const artifacts = api(
    `${base}/runs/${run.runId}/artifacts?name=${RELEASE_ARTIFACT}&per_page=100`,
  );
  const listed = Array.isArray(artifacts?.artifacts)
    ? artifacts.artifacts.filter((a) => a.name === RELEASE_ARTIFACT)
    : [];
  const artifact = listed.length === 1 ? api(`${base}/artifacts/${listed[0].id}`) : undefined;
  const jobs = api(`${base}/runs/${run.runId}/attempts/${run.attempt}/jobs?per_page=100`);
  return validateReleaseArtifact(run, { artifact, artifacts, jobs });
}

/** Download to a temp file and check its sha256 against the artifact digest
 * before anything parses it. */
export function downloadReleaseArtifact(provenance, { download, fs = nodeFs, tmp = tmpdir() }) {
  const directory = fs.mkdtempSync(path.join(tmp, "pages-release-"));
  try {
    const file = path.join(directory, "pages-release.zip");
    download(`repos/${RELEASE_REPOSITORY}/actions/artifacts/${provenance.artifact_id}/zip`, file);
    const size = fs.lstatSync(file).size;
    check(
      size > 0 && size <= RELEASE_ARCHIVE_LIMITS.zip,
      "Downloaded release artifact is outside the 64 MiB cap",
    );
    const zip = fs.readFileSync(file);
    check(
      `sha256:${sha256(zip)}` === provenance.digest,
      "Downloaded release artifact digest mismatch",
    );
    return zip;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** The checkout prepare runs on: the operator's own, clean and at `sha`, or a
 * new detached worktree at `sha` under .context/pages-promote. */
export function releaseCheckout({ repo, sha, worktree, git, fs = nodeFs }) {
  let root = repo;
  if (worktree) {
    root = path.join(repo, ".context", "pages-promote", sha);
    check(!fs.existsSync(root), "Promotion worktree already exists: " + root);
    try {
      git(repo, ["cat-file", "-e", sha + "^{commit}"]);
    } catch {
      throw new Error(`Commit ${sha} is not in this clone; run git fetch origin main`);
    }
    fs.mkdirSync(path.dirname(root), { recursive: true });
    git(repo, ["worktree", "add", "--detach", root, sha]);
  }
  check(
    path.resolve(git(root, ["rev-parse", "--show-toplevel"])) === path.resolve(root),
    "Provide the source checkout root",
  );
  check(
    !git(root, ["status", "--porcelain"]),
    "Commit or stash local changes, or pass --worktree, before promoting",
  );
  const head = git(root, ["rev-parse", "HEAD"]);
  check(
    head === sha,
    `Checkout HEAD ${head} is not the gate run's ${sha}; check it out or pass --worktree`,
  );
  return root;
}

export const ghApi = (endpoint) =>
  JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        endpoint,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
export function ghDownload(endpoint, file) {
  const fd = nodeFs.openSync(file, "wx", 0o600);
  try {
    execFileSync("gh", ["api", endpoint], { stdio: ["ignore", fd, "inherit"] });
  } finally {
    nodeFs.closeSync(fd);
  }
}
export const gitCommand = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Resolve, download, verify and extract the gate's release into the source
 * checkout's Pages dist, then hand that checkout to the existing prepare. */
export function promoteFromArtifact({
  runId,
  attempt,
  worktree = false,
  repo,
  appRelative,
  prepare,
  api = ghApi,
  download = ghDownload,
  git = gitCommand,
  fs = nodeFs,
  tmp,
}) {
  const provenance = resolveReleaseArtifact({ runId, attempt, api });
  const sourceRoot = releaseCheckout({ repo, sha: provenance.head_sha, worktree, git, fs });
  const sourceApp = path.join(sourceRoot, appRelative);
  const dist = path.join(sourceApp, "dist");
  check(
    !fs.existsSync(dist),
    "Pages dist already exists: " + dist + ". Move it aside or pass --worktree",
  );
  const zip = downloadReleaseArtifact(provenance, { download, fs, tmp });
  const release = verifyReleaseArchive(zip, { sha: provenance.head_sha });
  writeReleaseDist({ checkout: sourceRoot, dist, files: release.files, fs });
  const releaseArtifact = {
    ...provenance,
    build_id: release.receipt.build_id,
    receipt_sha256: release.receiptSha256,
  };
  return prepare({ sourceRoot, sourceApp, releaseArtifact });
}
