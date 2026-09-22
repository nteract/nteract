import assert from "node:assert/strict";
import {test} from "node:test";
import {eventRequest, artifactFields, REPOSITORY, REPOSITORY_ID, OWNER_ID} from "./protocol.mjs";
import {resolveRequest} from "./github.mjs";

function fixture(action = "opened") {
  const sha = "a".repeat(40);
  const repo = {id: Number(REPOSITORY_ID), full_name: REPOSITORY, owner: {id: Number(OWNER_ID)}};
  const env = {GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_ID: REPOSITORY_ID, GITHUB_REPOSITORY_OWNER_ID: OWNER_ID,
    GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1", GITHUB_ACTOR_ID: "836375", GITHUB_TOKEN: "test-ephemeral-token"};
  const pr = {number: 123, state: action === "closed" ? "closed" : "open", user: {id: 836375},
    base: {repo}, head: {repo, sha}};
  const event = {action, number: pr.number, repository: repo, pull_request: structuredClone(pr)};
  const run = {id: 42, run_attempt: 1, event: "pull_request", status: "in_progress", head_sha: sha,
    repository: repo, head_repository: repo, actor: {id: 836375}, triggering_actor: {id: 836375},
    pull_requests: [{number: pr.number, base: {repo}, head: {repo, sha}}]};
  return {event, env, run, pr};
}

function request(f) {return eventRequest(f.event, f.env, f.run, f.pr);}

test("opened, reopened and synchronize deploy the exact current head", () => {
  for (const action of ["opened", "reopened", "synchronize"]) {
    const f = fixture(action);
    assert.deepEqual(request(f), {repository: REPOSITORY, runId: "42", runAttempt: "1", action: "deploy",
      previewId: "pr-123", pr: 123, sourceSha: "a".repeat(40)});
  }
});

test("both explicitly configured maintainers may author and trigger previews", () => {
  const f = fixture();
  f.pr.user.id = 107147005;
  f.run.actor.id = 107147005;
  f.env.GITHUB_ACTOR_ID = "107147005";
  assert.equal(request(f).action, "deploy");
});

test("rejects unapproved author, actor, and rerun initiator independently", () => {
  for (const target of ["author", "actor", "triggering_actor"]) {
    const f = fixture();
    if (target === "author") f.pr.user.id = 999;
    else {f.run[target].id = 999; if (target === "actor") f.env.GITHUB_ACTOR_ID = "999";}
    assert.throws(() => request(f), /not eligible/);
  }
});

test("same repository name cannot replace immutable repository or owner IDs", () => {
  for (const target of ["base", "head"]) {
    for (const kind of ["id", "owner"]) {
      const f = fixture();
      f.pr[target].repo = structuredClone(f.pr[target].repo);
      if (kind === "id") f.pr[target].repo.id = 999;
      else f.pr[target].repo.owner.id = 999;
      assert.throws(() => request(f), /repository/i);
    }
  }
});

test("rejects fork run even when request and live PR look eligible", () => {
  const f = fixture();
  f.run.head_repository = {...f.run.head_repository, id: 999};
  assert.throws(() => request(f), /Fork/);
});

test("rejects forged PR linkage, run attempts, event contexts and closed deploys", () => {
  const mutations = [
    f => {f.run.pull_requests[0].number = 124;},
    f => {f.run.run_attempt = 2;},
    f => {f.run.event = "workflow_dispatch";},
    f => {f.env.GITHUB_EVENT_NAME = "workflow_dispatch";},
    f => {f.pr.state = "closed";},
    f => {f.event.action = "edited";},
  ];
  for (const mutate of mutations) {const f = fixture(); mutate(f); assert.throws(() => request(f));}
});

test("does not mistake mutable run pull_requests head metadata for the run revision", () => {
  const f = fixture("synchronize");
  const newer = "b".repeat(40);
  f.pr.head.sha = newer;
  f.run.pull_requests[0].head.sha = newer;
  assert.throws(() => request(f), /stale/);
});

test("rejects substituted event head even when run and live PR agree", () => {
  const f = fixture();
  f.event.pull_request.head.sha = "b".repeat(40);
  assert.throws(() => request(f), /stale/);
});

test("cleanup keeps the event revision after an undeployed push and author removal", () => {
  const f = fixture("closed");
  f.pr.head.sha = "b".repeat(40);
  f.pr.user.id = 999;
  f.pr.head.repo = null;
  assert.equal(request(f).action, "stop");
  assert.equal(request(f).sourceSha, f.run.head_sha);
});

test("cleanup refuses a reopened PR", () => {
  const f = fixture("closed");
  f.pr.state = "open";
  assert.throws(() => request(f), /remain closed/);
});

test("resolves live GitHub metadata using only fixed same-repository endpoints", async () => {
  const f = fixture();
  const calls = [];
  const result = await resolveRequest(f.env, async (url, options) => {
    calls.push({url, options});
    return Response.json(url.endsWith("/pulls/123") ? f.pr : f.run);
  }, f.event);
  assert.equal(result.githubToken, f.env.GITHUB_TOKEN);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.startsWith(`https://api.github.com/repos/${REPOSITORY}/`) && call.options.redirect === "error"));
});

test("does not echo GitHub response bodies on failure", async () => {
  const f = fixture();
  await assert.rejects(resolveRequest(f.env, async () => new Response("secret echoed by upstream", {status: 403}), f.event),
    error => error.message === "GitHub API request failed (403)");
});

test("artifact fields validate decimal IDs and normalize a SHA-256 prefix", () => {
  assert.equal(artifactFields({ARTIFACT_ID: "123", ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`, BUNDLE_SHA256: "b".repeat(64)}).artifactDigest, "a".repeat(64));
  assert.throws(() => artifactFields({ARTIFACT_ID: "../123"}), /Invalid artifact/);
});
