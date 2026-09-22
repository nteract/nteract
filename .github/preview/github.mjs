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

export async function resolveRequest(env, fetcher = fetch, event) {
  const context = workflowContext(env);
  check(typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.length > 0, "Ephemeral GitHub token required");
  event ??= JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  check(Number.isSafeInteger(event.number) && event.number > 0 && event.number < 100000000, "Invalid PR number");
  const [run, pr] = await Promise.all([
    github(`/repos/${REPOSITORY}/actions/runs/${context.runId}`, env.GITHUB_TOKEN, fetcher),
    github(`/repos/${REPOSITORY}/pulls/${event.number}`, env.GITHUB_TOKEN, fetcher),
  ]);
  let associatedPrs = [];
  if (event.action === "closed" && pr.state === "closed" && pr.merged === true &&
    Array.isArray(run.pull_requests) && run.pull_requests.length === 0) {
    associatedPrs = await github(`/repos/${REPOSITORY}/commits/${sourceSha(run.head_sha)}/pulls?per_page=100`, env.GITHUB_TOKEN, fetcher);
    check(Array.isArray(associatedPrs), "Invalid GitHub commit association response");
  }
  return {...eventRequest(event, env, run, pr, associatedPrs), githubToken: env.GITHUB_TOKEN};
}
