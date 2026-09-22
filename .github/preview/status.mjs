import {readFile} from "node:fs/promises";
import {github} from "./github.mjs";
import {check, ELIGIBLE_IDS, REPOSITORY, repository, sourceSha, workflowContext} from "./protocol.mjs";

// This identifies a status report, not a deployment. The controller rechecks
// live PR/run provenance and decides whether a stale report is a no-op. Never
// use this request in place of resolveRequest() for authorize/deploy.
export async function resolveStatusRequest(env, fetcher = fetch, event) {
  const context = workflowContext(env);
  check(typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.length > 0, "Ephemeral GitHub token required");
  event ??= JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  check(["opened", "reopened", "synchronize", "closed"].includes(event?.action), "Unsupported PR event action");
  check(Number.isSafeInteger(event.number) && event.number > 0 && event.number < 100000000, "Invalid PR number");
  check(event.pull_request?.number === event.number, "Unexpected event PR number");
  repository(event.repository);
  repository(event.pull_request.base?.repo);
  const action = event.action === "closed" ? "stop" : "deploy";
  if (action === "deploy" || event.pull_request.head?.repo != null) repository(event.pull_request.head?.repo);
  const run = await github(`/repos/${REPOSITORY}/actions/runs/${context.runId}`, env.GITHUB_TOKEN, fetcher);
  repository(run.repository);
  repository(run.head_repository);
  check(String(run.id) === context.runId && String(run.run_attempt) === context.runAttempt, "Workflow run mismatch");
  check(run.event === "pull_request" && run.status === "in_progress", "Workflow run is not an active PR event");
  check(String(run.actor?.id) === env.GITHUB_ACTOR_ID, "Workflow actor mismatch");
  check(ELIGIBLE_IDS.has(String(run.actor?.id)) && ELIGIBLE_IDS.has(String(run.triggering_actor?.id)),
    "Workflow actor is not eligible for automatic previews");
  return {...context, action, previewId: `pr-${event.number}`, pr: event.number,
    sourceSha: sourceSha(run.head_sha), githubToken: env.GITHUB_TOKEN};
}
