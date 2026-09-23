import {readFile} from "node:fs/promises";
import {github} from "./github.mjs";
import {check, decimal, ELIGIBLE_IDS, OWNER_ID, REPOSITORY, REPOSITORY_ID, repository, sha256, sourceSha} from "./protocol.mjs";

export const MAIN_CALLER = ".github/workflows/main-preview.yml";
export const MAIN_BUILD = ".github/workflows/build.yml";
const MAX_ARTIFACT_BYTES = 180 * 1024 * 1024;

function actors(run) {
  check(ELIGIBLE_IDS.has(String(run.actor?.id)) && ELIGIBLE_IDS.has(String(run.triggering_actor?.id)),
    "Main workflow actor is not eligible");
}

export function mainContext(env) {
  check(env.GITHUB_EVENT_NAME === "workflow_run", "Main deployment requires a workflow_run event");
  check(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REPOSITORY_ID === REPOSITORY_ID &&
    env.GITHUB_REPOSITORY_OWNER_ID === OWNER_ID, "Unexpected main workflow repository");
  check(env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${MAIN_CALLER}@refs/heads/main`, "Unexpected main caller workflow");
  return {repository: REPOSITORY, runId: decimal(env.GITHUB_RUN_ID, "deployment run"),
    runAttempt: decimal(env.GITHUB_RUN_ATTEMPT, "deployment run attempt"), sourceSha: sourceSha(env.GITHUB_SHA)};
}

export function mainRequest(event, env, deployment, build, ref) {
  const context = mainContext(env);
  repository(event.repository);
  check(event.action === "completed", "Build completion event required");
  const eventBuild = event.workflow_run;
  check(eventBuild && String(eventBuild.id) === String(build.id) &&
    String(eventBuild.run_attempt) === String(build.run_attempt), "Build run or attempt changed");
  for (const run of [eventBuild, build, deployment]) {
    repository(run.repository);
    repository(run.head_repository);
    actors(run);
    check(run.head_sha === context.sourceSha, "Main revision changed; this run is stale");
    check(run.head_branch === "main", "Main workflow ran for another branch");
  }
  check(String(deployment.id) === context.runId && String(deployment.run_attempt) === context.runAttempt &&
    String(deployment.actor.id) === env.GITHUB_ACTOR_ID, "Deployment run identity mismatch");
  check(deployment.event === "workflow_run" && deployment.path === MAIN_CALLER &&
    deployment.status === "in_progress", "Deployment workflow is not active or trusted");
  for (const run of [eventBuild, build]) {
    check(run.event === "push" && run.path === MAIN_BUILD && run.status === "completed" &&
      run.conclusion === "success", "Main Build must finish successfully");
  }
  check(ref.ref === "refs/heads/main" && ref.object?.type === "commit" &&
    ref.object.sha === context.sourceSha, "Main revision changed; this run is stale");
  return {...context, action: "deploy", previewId: "main", buildRunId: decimal(String(build.id), "build run"),
    buildRunAttempt: decimal(String(build.run_attempt), "build run attempt")};
}

export function mainArtifact(request, listing, jobs) {
  check(Number.isSafeInteger(listing.total_count) && listing.total_count >= 0 && listing.total_count <= 100 &&
    Array.isArray(listing.artifacts) && listing.total_count === listing.artifacts.length, "Incomplete build artifact listing");
  const matches = listing.artifacts.filter(artifact => artifact.name === "preview-bundle");
  check(matches.length === 1, "Main Build must publish exactly one deployment bundle");
  const artifact = matches[0];
  check(artifact.expired === false && Number.isSafeInteger(artifact.size_in_bytes) &&
    artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_ARTIFACT_BYTES, "Main artifact is expired or too large");
  check(String(artifact.workflow_run?.id) === request.buildRunId &&
    artifact.workflow_run?.head_sha === request.sourceSha, "Artifact belongs to another build or revision");
  check(Number.isSafeInteger(jobs.total_count) && jobs.total_count <= 100 && Array.isArray(jobs.jobs) &&
    jobs.total_count === jobs.jobs.length, "Incomplete build job listing");
  const builders = jobs.jobs.filter(job => job.name === "Build shared UI artifacts");
  check(builders.length === 1 && builders[0].status === "completed" && builders[0].conclusion === "success" &&
    String(builders[0].run_id) === request.buildRunId, "Cloud bundle build job did not succeed");
  return {artifactId: decimal(String(artifact.id), "artifact"), artifactDigest: sha256(artifact.digest, "artifact")};
}

export async function resolveMainRequest(env, fetcher = fetch, event) {
  const context = mainContext(env);
  check(typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.length > 0, "Ephemeral GitHub token required");
  event ??= JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const buildId = decimal(String(event.workflow_run?.id), "build run");
  const api = path => github(`/repos/${REPOSITORY}/${path}`, env.GITHUB_TOKEN, fetcher);
  const [deployment, build, ref] = await Promise.all([
    api(`actions/runs/${context.runId}`), api(`actions/runs/${buildId}`), api("git/ref/heads/main"),
  ]);
  const request = mainRequest(event, env, deployment, build, ref);
  const [artifacts, jobs] = await Promise.all([
    api(`actions/runs/${buildId}/artifacts?per_page=100`),
    api(`actions/runs/${buildId}/attempts/${request.buildRunAttempt}/jobs?per_page=100`),
  ]);
  return {...request, ...mainArtifact(request, artifacts, jobs), githubToken: env.GITHUB_TOKEN};
}
