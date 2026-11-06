import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RELEASE_ARTIFACT,
  RELEASE_JOB,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW,
  downloadReleaseArtifact,
  parseFromArtifactArgs,
  promoteFromArtifact,
  resolveReleaseArtifact,
  validateReleaseArtifact,
  validateReleaseRun,
} from "./promote-artifact.mjs";
import { releaseZip, sha256 } from "./fixtures/release-zip.mjs";

const RUN = "19000000001";
const ARTIFACT = 4200;
const base = `repos/${RELEASE_REPOSITORY}/actions`;

const gateRun = (sha, overrides = {}) => ({
  id: Number(RUN),
  run_attempt: 2,
  repository: { full_name: RELEASE_REPOSITORY },
  head_repository: { full_name: RELEASE_REPOSITORY },
  path: RELEASE_WORKFLOW,
  event: "push",
  head_branch: "main",
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  ...overrides,
});
const artifactOf = (sha, zip, overrides = {}) => ({
  id: ARTIFACT,
  name: RELEASE_ARTIFACT,
  expired: false,
  size_in_bytes: zip.length,
  digest: "sha256:" + sha256(zip),
  created_at: "2026-11-05T10:05:00Z",
  expires_at: "2026-12-05T10:05:00Z",
  workflow_run: { id: Number(RUN), head_sha: sha },
  ...overrides,
});
const listOf = (...artifacts) => ({ total_count: artifacts.length, artifacts });
const releaseJob = (sha, overrides = {}) => ({
  name: RELEASE_JOB,
  conclusion: "success",
  run_id: Number(RUN),
  run_attempt: 2,
  head_sha: sha,
  started_at: "2026-11-05T10:00:00Z",
  completed_at: "2026-11-05T10:06:00Z",
  ...overrides,
});
const jobsOf = (...jobs) => ({
  total_count: jobs.length + 1,
  jobs: [{ name: "Native suite (1)", conclusion: "success" }, ...jobs],
});

/** A gh stand-in: endpoint → JSON, plus a download that writes `zip`. */
function fakeGitHub(sha, zip, overrides = {}) {
  const artifact = artifactOf(sha, zip, overrides.artifact);
  const responses = {
    [`${base}/runs/${RUN}`]: gateRun(sha, overrides.run),
    [`${base}/runs/${RUN}/attempts/2`]: gateRun(sha, overrides.run),
    [`${base}/runs/${RUN}/attempts/1`]: gateRun(sha, { run_attempt: 1, conclusion: "failure" }),
    [`${base}/runs/${RUN}/artifacts?name=${RELEASE_ARTIFACT}&per_page=100`]:
      overrides.artifacts ?? listOf({ id: ARTIFACT, name: RELEASE_ARTIFACT }),
    [`${base}/artifacts/${ARTIFACT}`]: artifact,
    [`${base}/runs/${RUN}/attempts/2/jobs?per_page=100`]: overrides.jobs ?? jobsOf(releaseJob(sha)),
  };
  const calls = [];
  return {
    calls,
    api(endpoint) {
      calls.push(endpoint);
      if (!(endpoint in responses)) throw new Error("unexpected gh api " + endpoint);
      return structuredClone(responses[endpoint]);
    },
    download(endpoint, file) {
      calls.push("download " + endpoint);
      assert.equal(endpoint, `${base}/artifacts/${ARTIFACT}/zip`);
      fs.writeFileSync(file, overrides.downloaded ?? zip, { flag: "wx" });
    },
  };
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function sourceRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "promote-artifact-")));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, "app", "source.mjs"), "export {};\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n.context/\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "source"]);
  return { root, sha: git(root, ["rev-parse", "HEAD"]) };
}
function withRepo(fn) {
  const repo = sourceRepo();
  try {
    return fn(repo);
  } finally {
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
}
const recordPrepare = () => {
  const calls = [];
  const prepare = (options) => {
    calls.push({
      ...options,
      dist: fs.readdirSync(path.join(options.sourceApp, "dist"), { recursive: true }).sort(),
    });
    return { prepared: "stage" };
  };
  return { calls, prepare };
};

test("the from-artifact arguments parse strictly", () => {
  assert.deepEqual(parseFromArtifactArgs(["--from-artifact", RUN]), {
    runId: RUN,
    attempt: undefined,
    worktree: false,
  });
  assert.deepEqual(
    parseFromArtifactArgs(["--from-artifact", RUN, "--attempt", "3", "--worktree"]),
    {
      runId: RUN,
      attempt: "3",
      worktree: true,
    },
  );
  for (const args of [
    ["--from-artifact"],
    ["--from-artifact", "abc"],
    ["--from-artifact", RUN, "--attempt"],
    ["--from-artifact", RUN, "--attempt", "0"],
    ["--from-artifact", RUN, "--attempt", "1", "--attempt", "2"],
    ["--from-artifact", RUN, "--force"],
  ])
    assert.throws(() => parseFromArtifactArgs(args), /Usage/);
});

test("only a green main push of the Pages workflow at the attempt is accepted", () => {
  const sha = "c".repeat(40);
  assert.deepEqual(validateReleaseRun(gateRun(sha), { runId: RUN }), {
    runId: RUN,
    attempt: "2",
    sha,
  });
  assert.deepEqual(validateReleaseRun(gateRun(sha), { runId: RUN, attempt: "2" }).attempt, "2");
  const refusals = [
    [{ path: ".github/workflows/pages-browser-e2e.yml" }, /must come from/],
    [{ event: "pull_request" }, /push to main/],
    [{ event: "workflow_dispatch" }, /push to main/],
    [{ head_branch: "feature" }, /push to main/],
    [{ conclusion: "failure" }, /did not succeed/],
    [{ status: "in_progress", conclusion: null }, /did not succeed/],
    [{ head_repository: { full_name: "fork/nteract" } }, /must belong/],
    [{ id: 1 }, /does not name the requested run/],
    [{ head_sha: "short" }, /no head SHA/],
  ];
  for (const [overrides, message] of refusals)
    assert.throws(() => validateReleaseRun(gateRun(sha, overrides), { runId: RUN }), message);
  assert.throws(
    () => validateReleaseRun(gateRun(sha), { runId: RUN, attempt: "1" }),
    /not at attempt 1/,
  );
});

test("exactly one unexpired, bounded artifact from the attempt's release job is accepted", () => {
  const sha = "c".repeat(40);
  const zip = releaseZip({ sha });
  const run = { runId: RUN, attempt: "2", sha };
  const good = {
    artifact: artifactOf(sha, zip),
    artifacts: listOf({ id: ARTIFACT, name: RELEASE_ARTIFACT }),
    jobs: jobsOf(releaseJob(sha)),
  };
  assert.deepEqual(validateReleaseArtifact(run, good), {
    repository: RELEASE_REPOSITORY,
    run_id: RUN,
    run_attempt: "2",
    head_sha: sha,
    artifact_id: String(ARTIFACT),
    artifact_name: RELEASE_ARTIFACT,
    digest: "sha256:" + sha256(zip),
    size_in_bytes: zip.length,
    created_at: "2026-11-05T10:05:00Z",
    expires_at: "2026-12-05T10:05:00Z",
  });
  const refusals = [
    [{ artifacts: listOf() }, /exactly one pages-release/],
    [
      {
        artifacts: listOf(
          { id: ARTIFACT, name: RELEASE_ARTIFACT },
          { id: ARTIFACT + 1, name: RELEASE_ARTIFACT },
        ),
      },
      /exactly one pages-release/,
    ],
    [
      { artifacts: { total_count: 2, artifacts: [{ id: ARTIFACT, name: RELEASE_ARTIFACT }] } },
      /Incomplete artifact list/,
    ],
    [{ artifact: artifactOf(sha, zip, { expired: true }) }, /expired/],
    [{ artifact: artifactOf(sha, zip, { size_in_bytes: 64 * 1024 * 1024 + 1 }) }, /64 MiB/],
    [{ artifact: artifactOf(sha, zip, { size_in_bytes: 0 }) }, /64 MiB/],
    [{ artifact: artifactOf(sha, zip, { digest: undefined }) }, /no sha256 digest/],
    [{ artifact: artifactOf(sha, zip, { workflow_run: { id: 1, head_sha: sha } }) }, /another run/],
    [
      {
        artifact: artifactOf(sha, zip, {
          workflow_run: { id: Number(RUN), head_sha: "d".repeat(40) },
        }),
      },
      /another run/,
    ],
    [{ artifact: artifactOf(sha, zip, { id: ARTIFACT + 1 }) }, /does not name/],
    [{ artifact: artifactOf(sha, zip, { created_at: "2026-11-05T09:59:59Z" }) }, /not created by/],
    [{ artifact: artifactOf(sha, zip, { created_at: "2026-11-05T10:06:01Z" }) }, /not created by/],
    [{ artifact: artifactOf(sha, zip, { created_at: "soon" }) }, /not created by/],
    [{ jobs: jobsOf(releaseJob(sha, { conclusion: "failure" })) }, /did not succeed/],
    [{ jobs: jobsOf(releaseJob(sha, { run_attempt: 1 })) }, /did not succeed/],
    [{ jobs: jobsOf(releaseJob(sha), releaseJob(sha)) }, /did not succeed/],
    [{ jobs: jobsOf() }, /did not succeed/],
    [{ jobs: { total_count: 9, jobs: [releaseJob(sha)] } }, /Incomplete release job list/],
  ];
  for (const [overrides, message] of refusals)
    assert.throws(() => validateReleaseArtifact(run, { ...good, ...overrides }), message);
});

test("resolution reads the latest attempt by default and the named attempt otherwise", () => {
  const sha = "c".repeat(40);
  const gh = fakeGitHub(sha, releaseZip({ sha }));
  assert.equal(resolveReleaseArtifact({ runId: RUN, api: gh.api }).run_attempt, "2");
  assert.deepEqual(gh.calls, [
    `${base}/runs/${RUN}`,
    `${base}/runs/${RUN}/artifacts?name=${RELEASE_ARTIFACT}&per_page=100`,
    `${base}/artifacts/${ARTIFACT}`,
    `${base}/runs/${RUN}/attempts/2/jobs?per_page=100`,
  ]);
  gh.calls.length = 0;
  assert.equal(resolveReleaseArtifact({ runId: RUN, attempt: "2", api: gh.api }).run_attempt, "2");
  assert.equal(gh.calls[0], `${base}/runs/${RUN}/attempts/2`);
  assert.throws(
    () => resolveReleaseArtifact({ runId: RUN, attempt: "1", api: gh.api }),
    /did not succeed/,
  );
});

test("a download whose sha256 differs from the artifact digest is refused before parsing", () => {
  const sha = "c".repeat(40);
  const zip = releaseZip({ sha });
  const gh = fakeGitHub(sha, zip, { downloaded: Buffer.concat([zip, Buffer.from("x")]) });
  const provenance = resolveReleaseArtifact({ runId: RUN, api: gh.api });
  const tmp = fs.mkdtempSync(path.join(tmpdir(), "promote-download-"));
  try {
    assert.throws(
      () => downloadReleaseArtifact(provenance, { download: gh.download, tmp }),
      /digest mismatch/,
    );
    assert.deepEqual(fs.readdirSync(tmp), [], "the temp download is removed");
    const ok = fakeGitHub(sha, zip);
    assert.deepEqual(downloadReleaseArtifact(provenance, { download: ok.download, tmp }), zip);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("promotion extracts the verified release into the checkout's dist and runs prepare there", () =>
  withRepo(({ root, sha }) => {
    const zip = releaseZip({ sha });
    const gh = fakeGitHub(sha, zip);
    const { calls, prepare } = recordPrepare();
    assert.deepEqual(
      promoteFromArtifact({ runId: RUN, repo: root, appRelative: "app", prepare, ...gh }),
      { prepared: "stage" },
    );
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.sourceRoot, root);
    assert.equal(call.sourceApp, path.join(root, "app"));
    assert.deepEqual(call.dist, [
      "build-receipt.json",
      "index.js",
      "public",
      "public/chunks",
      "public/chunks/a.js",
      "public/index.html",
    ]);
    assert.equal(fs.readFileSync(path.join(root, "app/dist/index.js"), "utf8"), "worker");
    assert.deepEqual(call.releaseArtifact, {
      repository: RELEASE_REPOSITORY,
      run_id: RUN,
      run_attempt: "2",
      head_sha: sha,
      artifact_id: String(ARTIFACT),
      artifact_name: RELEASE_ARTIFACT,
      digest: "sha256:" + sha256(zip),
      size_in_bytes: zip.length,
      created_at: "2026-11-05T10:05:00Z",
      expires_at: "2026-12-05T10:05:00Z",
      build_id: "0123456789ab",
      receipt_sha256: call.releaseArtifact.receipt_sha256,
    });
    assert.match(call.releaseArtifact.receipt_sha256, /^[0-9a-f]{64}$/);
  }));

test("a dirty checkout, another HEAD or an existing dist is refused before download", () =>
  withRepo(({ root, sha }) => {
    const zip = releaseZip({ sha });
    const attempt = (gh) =>
      promoteFromArtifact({
        runId: RUN,
        repo: root,
        appRelative: "app",
        prepare: () => assert.fail("prepare must not run"),
        ...gh,
      });
    const refuse = (gh, message) => {
      assert.throws(() => attempt(gh), message);
      assert.equal(
        gh.calls.some((call) => call.startsWith("download")),
        false,
      );
    };

    fs.writeFileSync(path.join(root, "app", "source.mjs"), "export const dirty = 1;\n");
    refuse(fakeGitHub(sha, zip), /Commit or stash local changes/);
    git(root, ["checkout", "-q", "--", "."]);

    refuse(
      fakeGitHub("e".repeat(40), releaseZip({ sha: "e".repeat(40) })),
      /is not the gate run's/,
    );

    fs.mkdirSync(path.join(root, "app", "dist"));
    refuse(fakeGitHub(sha, zip), /dist already exists/);
  }));

test("an archive that fails extraction checks leaves no dist and never reaches prepare", () =>
  withRepo(({ root, sha }) => {
    for (const zip of [
      releaseZip({ sha, extra: [{ name: "public/link", data: "/etc/passwd", mode: 0o120777 }] }),
      releaseZip({ sha, extra: [{ name: "uncertified.js", data: "x" }] }),
      releaseZip({ sha: "f".repeat(40) }),
    ]) {
      assert.throws(() =>
        promoteFromArtifact({
          runId: RUN,
          repo: root,
          appRelative: "app",
          prepare: () => assert.fail("prepare must not run"),
          ...fakeGitHub(sha, zip),
        }),
      );
      assert.equal(fs.existsSync(path.join(root, "app", "dist")), false);
    }
  }));

test("--worktree extracts into a new detached worktree at the gate SHA", () =>
  withRepo(({ root, sha }) => {
    const zip = releaseZip({ sha });
    // The operator's checkout is elsewhere and dirty; the worktree is not.
    fs.writeFileSync(path.join(root, "app", "source.mjs"), "export const local = 1;\n");
    fs.mkdirSync(path.join(root, "app", "dist"));
    const { calls, prepare } = recordPrepare();
    promoteFromArtifact({
      runId: RUN,
      worktree: true,
      repo: root,
      appRelative: "app",
      prepare,
      ...fakeGitHub(sha, zip),
    });
    const worktree = path.join(root, ".context", "pages-promote", sha);
    assert.equal(calls[0].sourceRoot, worktree);
    assert.equal(git(worktree, ["rev-parse", "HEAD"]), sha);
    assert.equal(git(worktree, ["status", "--porcelain"]), "");
    assert.equal(fs.readFileSync(path.join(worktree, "app/dist/index.js"), "utf8"), "worker");
    assert.throws(
      () =>
        promoteFromArtifact({
          runId: RUN,
          worktree: true,
          repo: root,
          appRelative: "app",
          prepare,
          ...fakeGitHub(sha, zip),
        }),
      /worktree already exists/,
    );
  }));
