import assert from "node:assert/strict";
import {test} from "node:test";
import {controllerClient} from "./client.mjs";
import {CONTROLLER} from "./protocol.mjs";

const env = {ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-oidc-request-token",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/idtoken?api-version=2"};
const body = {repository: "nteract/nteract", action: "deploy", previewId: "pr-123", pr: 123, sourceSha: "a".repeat(40),
  runId: "42", runAttempt: "1", githubToken: "test-github-token"};
const operationId = "11111111-2222-4333-8444-555555555555";

function mock(responses, options = {}) {
  const calls = [];
  let tokenCount = 0;
  const client = controllerClient(env, async (url, request) => {
    calls.push({url: String(url), request});
    if (String(url).startsWith("https://pipelines.actions.githubusercontent.com/")) {
      tokenCount++;
      return Response.json({value: `header.token${tokenCount}.signature`});
    }
    assert.ok(responses.length > 0, "Unexpected extra controller call");
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return result;
  }, {sleep: async () => {}, ...options});
  return {client, calls, tokenCount: () => tokenCount};
}

test("status reports use fresh OIDC and send only request identity to the fixed controller", async () => {
  const {client, calls, tokenCount} = mock([
    Response.json({...body, updated: true, status: "building"}),
    Response.json({...body, updated: true, status: "ready"}),
  ]);
  await client.status(body);
  await client.status(body);
  const reports = calls.filter(call => call.url === `${CONTROLLER}/status`);
  assert.equal(reports.length, 2);
  assert.equal(tokenCount(), 2);
  for (const call of reports) {
    assert.equal(call.request.method, "POST");
    assert.equal(call.request.redirect, "error");
    assert.deepEqual(JSON.parse(call.request.body), body);
  }
});

test("status accepts controller-derived outcomes and stale no-ops without claiming deployment", async () => {
  for (const status of ["building", "deploying", "ready", "failed", "closed", "stale"]) {
    const updated = status !== "stale";
    const {client} = mock([Response.json({...body, updated, status})]);
    assert.equal((await client.status(body)).status, status);
  }
});

test("status strips artifacts and caller status or error text before forwarding credentials", async () => {
  const {client, calls} = mock([Response.json({...body, updated: true, status: "deploying"})]);
  await client.status({...body, artifactId: "123", status: "ready", error: "untrusted build output"});
  assert.deepEqual(JSON.parse(calls.find(call => call.url === `${CONTROLLER}/status`).request.body), body);
});

test("status rejects substituted identity, unknown state, and a stale mutation", async () => {
  for (const change of [{previewId: "pr-124"}, {pr: 124}, {sourceSha: "b".repeat(40)},
    {updated: "yes"}, {status: "unknown"}, {status: "stale", updated: true}]) {
    const {client} = mock([Response.json({...body, updated: true, status: "building", ...change})]);
    await assert.rejects(client.status(body), /response does not match|Stale preview/);
  }
});

test("status failure never echoes upstream content or repeats an uncertain comment request", async () => {
  for (const response of [new Response("secret echoed by upstream", {status: 503}),
    new Response("secret echoed by upstream", {status: 200})]) {
    const {client, calls} = mock([response]);
    await assert.rejects(client.status(body), error => !error.message.includes("secret"));
    assert.equal(calls.filter(call => call.url === `${CONTROLLER}/status`).length, 1);
  }
});

test("authorization requests the fixed audience and validates the controller response", async () => {
  const {client, calls} = mock([Response.json({...body, authorized: true})]);
  await client.authorize(body);
  assert.equal(new URL(calls[0].url).searchParams.get("audience"), CONTROLLER);
  assert.equal(calls[1].url, `${CONTROLLER}/authorize`);
  assert.equal(calls[1].request.redirect, "error");
  assert.equal(JSON.parse(calls[1].request.body).githubToken, body.githubToken);
});

test("authorization rejects substituted request metadata", async () => {
  for (const change of [{authorized: false}, {pr: 124}, {sourceSha: "b".repeat(40)}, {action: "stop"}, {previewId: "pilot-other"}]) {
    const {client} = mock([Response.json({...body, authorized: true, ...change})]);
    await assert.rejects(client.authorize(body), /does not match/);
  }
});

test("capacity exhaustion is actionable without echoing the upstream error", async () => {
  const {client} = mock([Response.json({code: "PREVIEW_CAPACITY_REACHED", error: "secret echoed by upstream"}, {status: 429})]);
  await assert.rejects(client.authorize(body), error => error.message.startsWith("Preview capacity reached.") &&
    error.message.includes("rerun all jobs") && !error.message.includes("secret"));
});

test("unknown rate limits stay generic and never surface arbitrary upstream text", async () => {
  const {client} = mock([Response.json({code: "OTHER", error: "secret echoed by upstream"}, {status: 429})]);
  await assert.rejects(client.authorize(body), error => error.message === "Preview authorization failed (429); inspect run 42");
});

test("a capacity race after preflight gives the same safe rerun-all guidance", async () => {
  const {client} = mock([Response.json({operationId}, {status: 202}),
    Response.json({status: "failed", errorCode: "PREVIEW_CAPACITY_REACHED", error: "secret echoed by upstream"})]);
  await assert.rejects(client.deploy(body), error => error.message.startsWith("Preview capacity reached.") &&
    error.message.includes("rerun all jobs") && !error.message.includes("secret"));
});

test("refreshes OIDC on busy retry and every poll, with one accepted POST", async () => {
  const {client, calls, tokenCount} = mock([
    new Response(null, {status: 409}), Response.json({operationId}, {status: 202}),
    Response.json({status: "running"}), Response.json({status: "succeeded"}),
  ]);
  await client.deploy(body);
  const controllerCalls = calls.filter(call => call.url.startsWith(CONTROLLER));
  assert.deepEqual(controllerCalls.map(call => call.request.method), ["POST", "POST", "GET", "GET"]);
  assert.equal(tokenCount(), 4);
  assert.equal(new Set(controllerCalls.map(call => call.request.headers.Authorization)).size, 4);
});

test("never repeats an accepted POST after status failure", async () => {
  const {client, calls} = mock([Response.json({operationId}, {status: 202}), new Response("echoed credential", {status: 502})]);
  await assert.rejects(client.deploy(body), error => /Preview status request failed \(502\)/.test(error.message) && !error.message.includes("credential"));
  assert.equal(calls.filter(call => call.request.method === "POST").length, 1);
});

test("does not retry an uncertain POST transport failure", async () => {
  const {client, calls} = mock([new Error("network unavailable")]);
  await assert.rejects(client.deploy(body), /network unavailable/);
  assert.equal(calls.filter(call => call.request.method === "POST").length, 1);
});

test("does not print controller-provided errors or echoed request bodies", async () => {
  const {client} = mock([Response.json({operationId}, {status: 202}),
    Response.json({status: "failed", error: "secret echoed by upstream"})]);
  await assert.rejects(client.deploy(body), error => /Preview operation .* failed; inspect run 42/.test(error.message) && !error.message.includes("secret"));
});

test("sanitizes malformed controller JSON without echoing its contents", async () => {
  const {client} = mock([new Response("secret echoed by upstream", {status: 200})]);
  await assert.rejects(client.authorize(body), error => error.message === "Preview controller returned invalid JSON");
});

test("bounds repeated busy responses without reusing an expired token", async () => {
  let time = 0;
  const {client} = mock([new Response(null, {status: 409})], {now: () => time, sleep: async () => {time = 900_001;}});
  await assert.rejects(client.deploy(body), /timed out/);
});

test("rejects arbitrary OIDC destinations before sending credentials", () => {
  for (const url of ["http://actions.githubusercontent.com/token", "https://actions.githubusercontent.com.example.org/token", "https://user@actions.githubusercontent.com/token", "https://actions.githubusercontent.com:444/token"]) {
    assert.throws(() => controllerClient({...env, ACTIONS_ID_TOKEN_REQUEST_URL: url}), /Unexpected GitHub OIDC/);
  }
});

test("rejects malformed operation identifiers", async () => {
  const {client} = mock([Response.json({operationId: "../../elsewhere"}, {status: 202})]);
  await assert.rejects(client.deploy(body), /Invalid controller operation/);
});
