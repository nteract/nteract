import {readFile} from "node:fs/promises";
import {check, eventRequest, REPOSITORY, responseJson, sourceSha, workflowContext} from "./protocol.mjs";

export async function github(path, token, fetcher = fetch) {
  check(path.startsWith(`/repos/${REPOSITORY}/`), "Unexpected GitHub API path");
  const response = await fetcher(`https://api.github.com${path}`, {
    headers: {Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  check(response.ok, `GitHub API request failed (${response.status})`);
  return responseJson(response, "GitHub API");
}

// Total wait is bounded at 30 seconds, well inside each trusted job's timeout.
export const RUN_SETTLE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// GitHub's run API can trail the job that is reading it. A job that is already
// executing can see its own run as `queued`, or see the previous attempt right
// after a rerun. Only those lagging views of this exact run are read again.
// A completed run, a different run, or a later attempt is final.
export function runIsSettling(run, context) {
  if (String(run?.id) !== context.runId) return false;
  const attempt = String(run.run_attempt);
  if (/^[1-9][0-9]{0,19}$/.test(attempt) && BigInt(attempt) < BigInt(context.runAttempt)) return true;
  return attempt === context.runAttempt && run.status !== "in_progress" && run.status !== "completed";
}

// The returned run is not trusted here. Callers still apply every identity,
// attempt, event and `in_progress` check to it. Re-reading only gives GitHub
// time to report the state the controller will also require.
export async function fetchCurrentRun(context, token, fetcher = fetch, {delays = RUN_SETTLE_DELAYS_MS, sleep = wait} = {}) {
  const path = `/repos/${REPOSITORY}/actions/runs/${context.runId}`;
  let run = await github(path, token, fetcher);
  for (const delay of delays) {
    if (!runIsSettling(run, context)) break;
    await sleep(delay);
    run = await github(path, token, fetcher);
  }
  return run;
}

export async function resolveRequest(env, fetcher = fetch, event, runOptions) {
  const context = workflowContext(env);
  check(typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.length > 0, "Ephemeral GitHub token required");
  event ??= JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  check(Number.isSafeInteger(event.number) && event.number > 0 && event.number < 100000000, "Invalid PR number");
  // Read the PR after the run settles so its open state and head are no older
  // than the run evidence they are checked against.
  const run = await fetchCurrentRun(context, env.GITHUB_TOKEN, fetcher, runOptions);
  const pr = await github(`/repos/${REPOSITORY}/pulls/${event.number}`, env.GITHUB_TOKEN, fetcher);
  let associatedPrs = [];
  if (event.action === "closed" && pr.state === "closed" && pr.merged === true &&
    Array.isArray(run.pull_requests) && run.pull_requests.length === 0) {
    associatedPrs = await github(`/repos/${REPOSITORY}/commits/${sourceSha(run.head_sha)}/pulls?per_page=100`, env.GITHUB_TOKEN, fetcher);
    check(Array.isArray(associatedPrs), "Invalid GitHub commit association response");
  }
  return {...eventRequest(event, env, run, pr, associatedPrs), githubToken: env.GITHUB_TOKEN};
}
