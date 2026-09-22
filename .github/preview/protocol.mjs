export const REPOSITORY = "nteract/nteract";
export const REPOSITORY_ID = "1155631492";
export const OWNER_ID = "12401040";
export const CONTROLLER = "https://deploy.runtimed.run";
export const ELIGIBLE_IDS = new Set(["836375", "107147005"]);
export const SERVICES = ["main", "outputs", "renderer-assets"];

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

export async function responseJson(response, label) {
  try {
    return await response.json();
  } catch {
    // JSON parser errors can include upstream text, including echoed secrets.
    throw new Error(`${label} returned invalid JSON`);
  }
}

export function sourceSha(value) {
  check(typeof value === "string" && /^[a-f0-9]{40}$/.test(value), "Full source SHA required");
  return value;
}

export function decimal(value, label) {
  check(typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value), `Invalid ${label} id`);
  return value;
}

export function sha256(value, label) {
  check(typeof value === "string" && /^(sha256:)?[a-f0-9]{64}$/.test(value), `Invalid ${label} digest`);
  return value.replace(/^sha256:/, "");
}

export function repository(repo) {
  check(repo?.full_name === REPOSITORY && String(repo.id) === REPOSITORY_ID, "Fork or unexpected repository");
  check(String(repo.owner?.id) === OWNER_ID, "Unexpected repository owner");
}

export function workflowContext(env) {
  check(env.GITHUB_EVENT_NAME === "pull_request", "A pull_request event is required");
  check(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REPOSITORY_ID === REPOSITORY_ID &&
    env.GITHUB_REPOSITORY_OWNER_ID === OWNER_ID, "Unexpected workflow repository");
  return {
    repository: REPOSITORY,
    runId: decimal(env.GITHUB_RUN_ID, "run"),
    runAttempt: decimal(env.GITHUB_RUN_ATTEMPT, "run attempt"),
  };
}

export function eventRequest(event, env, run, pr) {
  const context = workflowContext(env);
  check(["opened", "reopened", "synchronize", "closed"].includes(event?.action), "Unsupported PR event action");
  check(Number.isSafeInteger(event.number) && event.number > 0 && event.number < 100000000, "Invalid PR number");
  check(pr.number === event.number, "Unexpected PR response");
  repository(event.repository);
  repository(pr.base?.repo);
  const action = event.action === "closed" ? "stop" : "deploy";
  // A closed PR can lose head repository metadata when its branch is deleted.
  if (action === "deploy" || pr.head?.repo != null) repository(pr.head?.repo);
  repository(run.repository);
  check(String(run.id) === context.runId && String(run.run_attempt) === context.runAttempt, "Workflow run mismatch");
  check(run.event === "pull_request" && run.status === "in_progress", "Workflow run is not an active PR event");
  check(String(run.actor?.id) === env.GITHUB_ACTOR_ID, "Workflow actor mismatch");
  check(run.pull_requests?.some(link => link.number === pr.number &&
    String(link.base?.repo?.id) === REPOSITORY_ID &&
    String(link.head?.repo?.id) === REPOSITORY_ID), "Workflow is not linked to this same-repository PR");
  const sha = sourceSha(run.head_sha);
  if (action === "deploy") {
    repository(run.head_repository);
    check(ELIGIBLE_IDS.has(String(pr.user?.id)), "PR author is not eligible for automatic previews");
    check(ELIGIBLE_IDS.has(String(run.actor?.id)) && ELIGIBLE_IDS.has(String(run.triggering_actor?.id)),
      "Workflow actor is not eligible for automatic previews");
    check(pr.state === "open", "PR is no longer open");
    check(event.pull_request?.head?.sha === sha && pr.head.sha === sha, "PR head changed; this run is stale");
  } else {
    // Cleanup remains possible after an author loses eligibility. The controller
    // also verifies registry ownership and resolves the deployed revision.
    check(pr.state === "closed", "PR must remain closed for cleanup");
  }
  return {...context, action, previewId: `pr-${pr.number}`, pr: pr.number, sourceSha: sha};
}

export function artifactFields(env) {
  return {
    artifactId: decimal(env.ARTIFACT_ID, "artifact"),
    artifactDigest: sha256(env.ARTIFACT_DIGEST, "artifact"),
    bundleSha256: sha256(env.BUNDLE_SHA256, "bundle"),
  };
}
