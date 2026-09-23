import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {MAIN_BUILD, MAIN_CALLER, mainRequest, mainArtifact, resolveMainRequest} from "./main-github.mjs";
import {deployMain} from "./send-main-deployment.mjs";
import {controllerClient} from "./client.mjs";
import {CONTROLLER, OWNER_ID, REPOSITORY, REPOSITORY_ID} from "./protocol.mjs";

function fixture() {
  const sha = "a".repeat(40);
  const repo = {id: Number(REPOSITORY_ID), full_name: REPOSITORY, owner: {id: Number(OWNER_ID)}};
  const env = {GITHUB_EVENT_NAME: "workflow_run", GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_ID: REPOSITORY_ID, GITHUB_REPOSITORY_OWNER_ID: OWNER_ID,
    GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GITHUB_WORKFLOW_REF: `${REPOSITORY}/${MAIN_CALLER}@refs/heads/main`,
    GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1", GITHUB_ACTOR_ID: "836375", GITHUB_TOKEN: "test-ephemeral-token"};
  const run = {id: 42, run_attempt: 1, repository: repo, head_repository: repo, head_sha: sha, head_branch: "main",
    actor: {id: 836375}, triggering_actor: {id: 836375}};
  const deployment = {...run, event: "workflow_run", path: MAIN_CALLER, status: "in_progress"};
  const build = {...structuredClone(run), id: 41, event: "push", path: MAIN_BUILD, status: "completed", conclusion: "success"};
  const event = {action: "completed", repository: repo, workflow_run: structuredClone(build)};
  const ref = {ref: "refs/heads/main", object: {type: "commit", sha}};
  const artifacts = {total_count: 1, artifacts: [{id: 123, name: "preview-bundle", expired: false, size_in_bytes: 500,
    digest: `sha256:${"b".repeat(64)}`, workflow_run: {id: 41, head_sha: sha}}]};
  const jobs = {total_count: 1, jobs: [{run_id: 41, name: "Build shared UI artifacts", status: "completed", conclusion: "success"}]};
  return {env, deployment, build, event, ref, artifacts, jobs};
}

const request = f => mainRequest(f.event, f.env, f.deployment, f.build, f.ref);
function fetcherFor(f, calls = []) {
  return async (url, options) => {
    calls.push({url: String(url), options});
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${f.env.GITHUB_TOKEN}`);
    const base = `https://api.github.com/repos/${REPOSITORY}/`;
    const responses = {
      "actions/runs/42": f.deployment, "actions/runs/41": f.build, "git/ref/heads/main": f.ref,
      "actions/runs/41/artifacts?per_page=100": f.artifacts,
      "actions/runs/41/attempts/1/jobs?per_page=100": f.jobs,
    };
    assert.ok(String(url).startsWith(base));
    const response = responses[String(url).slice(base.length)];
    assert.ok(response, `Unexpected request: ${url}`);
    return Response.json(response);
  };
}

test("main binds completed Build and active deployment identities without a synthetic PR", () => {
  const f = fixture();
  assert.deepEqual(request(f), {repository: REPOSITORY, runId: "42", runAttempt: "1", sourceSha: "a".repeat(40),
    action: "deploy", previewId: "main", buildRunId: "41", buildRunAttempt: "1"});
});

test("main rejects failed, unfinished, non-push, wrong-workflow, and superseded Build runs", () => {
  for (const target of ["event", "build"]) {
    for (const [field, value] of Object.entries({event: "pull_request", path: ".github/workflows/other.yml",
      status: "in_progress", conclusion: "failure", head_branch: "topic", head_sha: "c".repeat(40)})) {
      const f = fixture();
      (target === "event" ? f.event.workflow_run : f.build)[field] = value;
      assert.throws(() => request(f), /Build|branch|stale/);
    }
  }
  for (const conclusion of ["cancelled", "skipped", "neutral", "timed_out"]) {
    const f = fixture(); f.build.conclusion = conclusion;
    assert.throws(() => request(f), /successfully/);
  }
});

test("main rejects changed source or deployment run attempts and main advancing", () => {
  for (const mutate of [f => {f.build.run_attempt = 2;}, f => {f.deployment.run_attempt = 2;},
    f => {f.build.id = 40;}, f => {f.deployment.id = 40;},
    f => {f.ref.object.sha = "c".repeat(40);}, f => {f.ref.ref = "refs/heads/topic";},
    f => {f.ref.object.type = "tag";}, f => {f.deployment.head_sha = "c".repeat(40);}]) {
    const f = fixture(); mutate(f); assert.throws(() => request(f));
  }
});

test("main rejects untrusted event contexts and inactive deployment workflows", () => {
  for (const [key, value] of Object.entries({GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/heads/topic",
    GITHUB_REPOSITORY_ID: "999", GITHUB_REPOSITORY_OWNER_ID: "999", GITHUB_ACTOR_ID: "999",
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/preview.yml@refs/heads/main`})) {
    const f = fixture(); f.env[key] = value; assert.throws(() => request(f));
  }
  for (const [key, value] of Object.entries({event: "push", path: MAIN_BUILD, status: "completed"})) {
    const f = fixture(); f.deployment[key] = value; assert.throws(() => request(f));
  }
  const f = fixture(); f.event.action = "requested"; assert.throws(() => request(f));
});

test("main pins immutable repository identities and rejects forks at every source", () => {
  for (const runName of ["deployment", "build", "event"]) {
    for (const side of ["repository", "head_repository"]) {
      for (const field of ["id", "owner"]) {
        const f = fixture();
        const run = runName === "event" ? f.event.workflow_run : f[runName];
        run[side] = structuredClone(run[side]);
        if (field === "id") run[side].id = 999; else run[side].owner.id = 999;
        assert.throws(() => request(f), /repository/i);
      }
    }
  }
});

test("main checks both original and rerun actors for source and deployment runs", () => {
  for (const runName of ["deployment", "build", "event"]) {
    for (const actor of ["actor", "triggering_actor"]) {
      const f = fixture();
      (runName === "event" ? f.event.workflow_run : f[runName])[actor] = {id: 999};
      assert.throws(() => request(f), /eligible/);
    }
  }
  const f = fixture();
  for (const run of [f.deployment, f.build, f.event.workflow_run]) {
    run.actor = {id: 107147005}; run.triggering_actor = {id: 107147005};
  }
  f.env.GITHUB_ACTOR_ID = "107147005";
  assert.equal(request(f).previewId, "main");
});

test("main accepts only a unique revision-bound artifact from its successful build job", () => {
  const f = fixture();
  assert.deepEqual(mainArtifact(request(f), f.artifacts, f.jobs), {artifactId: "123", artifactDigest: "b".repeat(64)});
  const mutations = [
    f => {f.artifacts.artifacts[0].expired = true;},
    f => {f.artifacts.artifacts[0].size_in_bytes = 181 * 1024 * 1024;},
    f => {f.artifacts.artifacts[0].workflow_run.id = 40;},
    f => {f.artifacts.artifacts[0].workflow_run.head_sha = "c".repeat(40);},
    f => {f.artifacts.artifacts[0].digest = "wrong";},
    f => {f.artifacts.artifacts[0].name = "other";},
    f => {f.artifacts.artifacts.push(structuredClone(f.artifacts.artifacts[0])); f.artifacts.total_count++;},
    f => {f.artifacts.total_count = 101;},
    f => {f.jobs.jobs[0].conclusion = "failure";},
    f => {f.jobs.jobs[0].run_id = 40;},
    f => {f.jobs.jobs[0].name = "Unrelated build";},
    f => {f.jobs.total_count = 101;},
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f); assert.throws(() => mainArtifact(request(f), f.artifacts, f.jobs));
  }
});

test("resolver fetches fresh evidence with credentials only at fixed GitHub API URLs", async () => {
  const f = fixture(), calls = [];
  const result = await resolveMainRequest(f.env, fetcherFor(f, calls), f.event);
  assert.deepEqual(result, {...request(f), artifactId: "123", artifactDigest: "b".repeat(64), githubToken: f.env.GITHUB_TOKEN});
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => !call.url.includes("/zip") && !call.url.includes("/pulls/")));
  assert.equal(result.pr, undefined);
  assert.equal(result.bundleSha256, undefined);
});

test("resolver fails closed on incomplete or malformed upstream responses", async () => {
  const f = fixture();
  await assert.rejects(resolveMainRequest(f.env, async () => new Response("sensitive provider text", {status: 503}), f.event),
    error => !error.message.includes("sensitive") && /503/.test(error.message));
  await assert.rejects(resolveMainRequest(f.env, async () => new Response("sensitive provider text"), f.event),
    error => !error.message.includes("sensitive") && /invalid JSON/.test(error.message));
});

test("sender rechecks main after admission and requires controller confirmation", async () => {
  const f = fixture(); let deployments = 0;
  const options = {event: f.event, fetcher: fetcherFor(f), client: {
    authorize: async body => {assert.equal(body.previewId, "main");},
    deploy: async body => {deployments++; return {result: {id: "main", sha: body.sourceSha, status: "ready"}};},
  }};
  assert.equal(await deployMain(f.env, options), f.env.GITHUB_SHA);
  assert.equal(deployments, 1);
  options.client.authorize = async () => {f.ref.object.sha = "c".repeat(40);};
  await assert.rejects(deployMain(f.env, options), /stale/);
  assert.equal(deployments, 1);
});

test("sender does not claim readiness for a different deployment or revision", async () => {
  for (const result of [{id: "pr-1", sha: "a".repeat(40), status: "ready"},
    {id: "main", sha: "b".repeat(40), status: "ready"}, {id: "main", sha: "a".repeat(40), status: "failed"}]) {
    const f = fixture();
    await assert.rejects(deployMain(f.env, {event: f.event, fetcher: fetcherFor(f), client: {
      authorize: async () => {}, deploy: async () => ({result}),
    }}), /did not confirm/);
  }
});

test("main uses the existing controller transport without PR comments or artifact downloads", async () => {
  const f = fixture(), calls = [];
  const body = await resolveMainRequest(f.env, fetcherFor(f), f.event);
  const id = "11111111-2222-4333-8444-555555555555";
  const client = controllerClient({ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-request-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/idtoken"}, async (url, options) => {
    if (String(url).startsWith("https://pipelines.actions.githubusercontent.com/")) return Response.json({value: "a.b.c"});
    calls.push(String(url));
    if (options.body) assert.deepEqual(JSON.parse(options.body), body);
    if (url === `${CONTROLLER}/authorize`) return Response.json({...body, authorized: true});
    if (url === `${CONTROLLER}/deploy`) return Response.json({operationId: id}, {status: 202});
    assert.equal(url, `${CONTROLLER}/deployments/${id}`);
    return Response.json({status: "succeeded", result: {id: "main", status: "ready", sha: body.sourceSha}});
  }, {sleep: async () => {}});
  assert.equal(await deployMain(f.env, {event: f.event, fetcher: fetcherFor(f), client}), body.sourceSha);
  assert.deepEqual(calls, [`${CONTROLLER}/authorize`, `${CONTROLLER}/deploy`, `${CONTROLLER}/deployments/${id}`]);
});

test("main artifact packaging stays in the read-only Build job and only runs on main pushes", () => {
  const workflow = readFileSync(new URL("../workflows/build.yml", import.meta.url), "utf8");
  const job = workflow.split("\n  build-ui:\n")[1].split("\n  js-tests:\n")[0];
  assert.match(job, /permissions:\n      contents: read/);
  assert.doesNotMatch(job, /id-token:|secrets\.|send-main-deployment|deploy\.runtimed\.run/);
  assert.match(job, /\(github.event_name == 'push' && github.ref == 'refs\/heads\/main'\) \|\|/);
  for (const name of ["Build and package main cloud deployment", "Upload main cloud deployment bundle"]) {
    const step = job.split(`      - name: ${name}\n`)[1].split("\n      - ")[0];
    assert.match(step, /^        if: github.event_name == 'push' && github.ref == 'refs\/heads\/main'$/m);
  }
  assert.match(job, /pnpm --dir apps\/notebook-cloud build:viewer/);
  assert.match(job, /node \.github\/preview\/pack.mjs "\$RUNNER_TEMP\/main-preview-export" "\$GITHUB_SHA" "\$RUNNER_TEMP\/preview.bundle.gz"/);
  assert.match(job, /name: preview-bundle\n          path: \$\{\{ runner.temp \}\}\/preview.bundle.gz/);
});
