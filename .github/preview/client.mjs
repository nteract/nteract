import {check, CONTROLLER, responseJson} from "./protocol.mjs";

const CAPACITY_MESSAGE = "Preview capacity reached. Close an unused preview PR or ask an operator to free a slot, then rerun all jobs.";

export async function reportProgress(client, body, warn = console.warn) {
  try {
    return await client.status(body);
  } catch {
    // Comment availability must not block cleanup or turn a completed deployment
    // into a failure. The separate finalizer reports comment failures strictly.
    warn("::warning::Preview comment could not be updated; the preview operation will continue. See the final status job.");
    return null;
  }
}

export function controllerClient(env, fetcher = fetch, {
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
} = {}) {
  check(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "GitHub OIDC request token is missing");
  const oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  check(oidcUrl.protocol === "https:" && !oidcUrl.username && !oidcUrl.password && !oidcUrl.port &&
    (oidcUrl.hostname === "actions.githubusercontent.com" || oidcUrl.hostname.endsWith(".actions.githubusercontent.com")),
  "Unexpected GitHub OIDC endpoint");
  oidcUrl.searchParams.set("audience", CONTROLLER);
  const deadline = now() + 900_000;

  async function request(path, body) {
    check(now() < deadline, "Preview controller operation timed out; inspect the run before retrying");
    const oidc = await fetcher(oidcUrl, {
      headers: {Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    check(oidc.ok, `GitHub OIDC request failed (${oidc.status})`);
    const {value: token} = await responseJson(oidc, "GitHub OIDC");
    check(typeof token === "string" && token.split(".").length === 3, "GitHub returned no OIDC token");
    return fetcher(`${CONTROLLER}${path}`, {
      method: body ? "POST" : "GET",
      headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      ...(body ? {body: JSON.stringify(body)} : {}),
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
  }

  return {
    async status(body) {
      // The controller derives status from GitHub and its deployment registry.
      // Do not forward artifacts, caller-supplied phases, or error/log text.
      const identity = Object.fromEntries(["repository", "runId", "runAttempt", "pr", "previewId", "sourceSha", "action", "githubToken"]
        .map(key => [key, body[key]]));
      const response = await request("/status", identity);
      check(response.ok, `Preview comment update failed (${response.status}); inspect run ${body.runId}`);
      const result = await responseJson(response, "Preview controller");
      check(typeof result?.updated === "boolean" &&
        ["building", "deploying", "ready", "failed", "closed", "stale"].includes(result.status) &&
        ["previewId", "pr", "sourceSha"].every(key => result[key] === body[key]),
      "Preview status response does not match this request");
      check(result.status !== "stale" || result.updated === false, "Stale preview status must not update the comment");
      return result;
    },
    async authorize(body) {
      const response = await request("/authorize", body);
      if (response.status === 429) {
        const result = await responseJson(response, "Preview controller");
        check(result?.code !== "PREVIEW_CAPACITY_REACHED", CAPACITY_MESSAGE);
      }
      check(response.ok, `Preview authorization failed (${response.status}); inspect run ${body.runId}`);
      const result = await responseJson(response, "Preview controller");
      check(result?.authorized === true && ["action", "previewId", "pr", "sourceSha"].every(key => result[key] === body[key]),
        "Preview authorization response does not match this request");
      return result;
    },
    async deploy(body) {
      let operationId;
      while (!operationId) {
        const response = await request("/deploy", body);
        if (response.status === 409) {await sleep(10_000); continue;}
        check(response.status === 202, `Preview controller rejected the request (${response.status}); inspect run ${body.runId}`);
        ({operationId} = await responseJson(response, "Preview controller"));
        check(typeof operationId === "string" && /^[a-f0-9-]{36}$/.test(operationId), "Invalid controller operation id");
      }
      // Once accepted, never repeat POST, even if a subsequent poll fails.
      while (true) {
        await sleep(5_000);
        const response = await request(`/deployments/${operationId}`);
        check(response.ok, `Preview status request failed (${response.status}); inspect operation ${operationId}`);
        const result = await responseJson(response, "Preview controller");
        check(["running", "succeeded", "failed"].includes(result?.status), "Invalid controller operation status");
        check(!(result.status === "failed" && result.errorCode === "PREVIEW_CAPACITY_REACHED"), CAPACITY_MESSAGE);
        check(result.status !== "failed", `Preview operation ${operationId} failed; inspect run ${body.runId}`);
        if (result.status === "succeeded") return result;
      }
    },
  };
}
