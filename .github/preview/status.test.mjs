import assert from "node:assert/strict";
import {test} from "node:test";
import {resolveStatusRequest} from "./status.mjs";
import {REPOSITORY, REPOSITORY_ID, OWNER_ID} from "./protocol.mjs";

function fixture(action = "synchronize") {
  const repo = {id: Number(REPOSITORY_ID), full_name: REPOSITORY, owner: {id: Number(OWNER_ID)}};
  const env = {GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_ID: REPOSITORY_ID, GITHUB_REPOSITORY_OWNER_ID: OWNER_ID,
    GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2", GITHUB_ACTOR_ID: "836375", GITHUB_TOKEN: "test-ephemeral-token"};
  const event = {action, number: 123, repository: repo,
    pull_request: {number: 123, base: {repo}, head: {repo, sha: "a".repeat(40)}}};
  const run = {id: 42, run_attempt: 2, event: "pull_request", status: "in_progress", head_sha: "a".repeat(40),
    repository: repo, head_repository: repo, actor: {id: 836375}, triggering_actor: {id: 107147005}};
  return {env, event, run};
}

async function resolve(f) {
  return resolveStatusRequest(f.env, async (url, request) => {
    assert.equal(url, `https://api.github.com/repos/${REPOSITORY}/actions/runs/42`);
    assert.equal(request.headers.Authorization, "Bearer test-ephemeral-token");
    assert.equal(request.redirect, "error");
    return Response.json(f.run);
  }, f.event);
}

test("status identity uses the immutable run revision for all supported event types", async () => {
  for (const action of ["opened", "reopened", "synchronize", "closed"]) {
    const f = fixture(action);
    assert.deepEqual(await resolve(f), {repository: REPOSITORY, runId: "42", runAttempt: "2",
      action: action === "closed" ? "stop" : "deploy", previewId: "pr-123", pr: 123,
      sourceSha: "a".repeat(40), githubToken: "test-ephemeral-token"});
  }
});

test("Quillaid may report deployment and cleanup status", async () => {
  for (const action of ["synchronize", "closed"]) {
    const f = fixture(action);
    f.run.actor.id = 261289082;
    f.run.triggering_actor.id = 261289082;
    f.env.GITHUB_ACTOR_ID = "261289082";
    assert.equal((await resolve(f)).action, action === "closed" ? "stop" : "deploy");
  }
});

test("report-only identity does not substitute newer event or mutable linkage heads", async () => {
  const f = fixture();
  f.event.pull_request.head.sha = "b".repeat(40);
  f.run.pull_requests = [{number: 123, head: {sha: "c".repeat(40)}}];
  assert.equal((await resolve(f)).sourceSha, "a".repeat(40));
});

test("status reports require fixed repository and matching active run context", async () => {
  const mutations = [
    f => {f.env.GITHUB_REPOSITORY_ID = "999";},
    f => {f.event.number = 0;},
    f => {f.event.pull_request.number = 124;},
    f => {f.event.action = "edited";},
    f => {f.run.repository = {...f.run.repository, id: 999};},
    f => {f.run.head_repository = {...f.run.head_repository, owner: {id: 999}};},
    f => {f.event.pull_request.head.repo = {...f.event.pull_request.head.repo, id: 999};},
    f => {f.run.run_attempt = 1;},
    f => {f.run.id = 43;},
    f => {f.run.event = "workflow_dispatch";},
    f => {f.run.status = "completed";},
    f => {f.run.head_sha = "bad";},
    f => {f.run.actor.id = 999;},
    f => {f.run.triggering_actor.id = 999;},
    f => {f.env.GITHUB_TOKEN = "";},
  ];
  for (const mutate of mutations) {const f = fixture(); mutate(f); await assert.rejects(resolve(f));}
});

test("closed status reports tolerate deleted PR branch metadata but still bind the run repository", async () => {
  const f = fixture("closed");
  f.event.pull_request.head.repo = null;
  assert.equal((await resolve(f)).action, "stop");
  f.run.head_repository.id = 999;
  await assert.rejects(resolve(f), /repository/);
});
