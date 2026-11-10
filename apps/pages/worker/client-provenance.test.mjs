import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { normalizeAgentAssertions } from "../shared/client-provenance.mjs";
import { handleMcp, tools } from "../mcp.mjs";
import { authenticate } from "./auth.mjs";
import { clientProvenance, forwardClientProvenance, withMcpAgent } from "./client-provenance.mjs";
import { mcpSessionId } from "./usage.mjs";
import worker from "./index.mjs";
import { documentMutation, fingerprint } from "./mutations.mjs";
import { Storage } from "./projects-fixture.mjs";

const origin = "https://pages.invalid";
const env = { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin };
const pageId = "33333333-3333-4333-8333-333333333333";
const rpc = (agent, headers = {}, args = { page_id: pageId }) =>
  new Request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "read_page",
        arguments: args,
        _meta: { progressToken: "progress", ...(agent !== undefined && { agent }) },
      },
    }),
  });

test("bounded assertions accept only #4811 name/id/model and copy immutable strings", () => {
  assert.equal(normalizeAgentAssertions(undefined), undefined);
  assert.equal(normalizeAgentAssertions({}), undefined);
  const input = { name: " Release Agent ", id: "session-123", model: "provider/model" };
  const actual = normalizeAgentAssertions(input);
  assert.deepEqual(actual, { name: "Release Agent", id: "session-123", model: "provider/model" });
  input.name = "other";
  assert.equal(actual.name, "Release Agent");
  assert.ok(Object.isFrozen(actual));
  for (const [field, bytes] of [
    ["name", 80],
    ["id", 128],
    ["model", 120],
  ]) {
    assert.equal(normalizeAgentAssertions({ [field]: "x".repeat(bytes) })[field].length, bytes);
    for (const invalid of [
      "x".repeat(bytes + 1),
      "\u00e9".repeat(bytes / 2 + 1),
      "a\tb",
      "a\u202eb",
      " ",
      null,
      42,
      {},
    ])
      assert.throws(() => normalizeAgentAssertions({ [field]: invalid }), {
        code: "invalid_arguments",
        status: 400,
        message: `Invalid _meta.agent.${field}`,
      });
  }
  for (const invalid of [
    null,
    [],
    "agent",
    { principal: "admin" },
    { origin: "harness_observed" },
    { observations: [] },
    { schema_version: 99 },
    { session: { url: "https://private.invalid/trace" } },
    JSON.parse('{"__proto__": {"principal":"admin"}}'),
  ])
    assert.throws(() => normalizeAgentAssertions(invalid), {
      code: "invalid_arguments",
      message: "Invalid _meta.agent",
    });
});

test("real MCP SDK passes request _meta separately, unchanged tool schemas and arguments", async () => {
  const before = JSON.stringify(tools);
  const calls = [];
  const invoke = async (...args) => {
    calls.push(args);
    return Response.json({ ok: true });
  };
  for (const agent of [undefined, { name: "Release", id: "client-session", model: "model-a" }]) {
    const response = await handleMcp(rpc(agent), invoke, env);
    const body = await response.json();
    assert.equal(body.result.isError, undefined, JSON.stringify(body));
    assert.deepEqual(calls.at(-1), [
      "read_page",
      { page_id: pageId },
      agent ? { agent } : undefined,
    ]);
  }
  assert.equal(JSON.stringify(tools), before);
  const response = await handleMcp(rpc({ principal: "do-not-echo" }), invoke, env);
  const body = await response.json();
  assert.equal(body.result.isError, true);
  assert.equal(body.result.structuredContent.code, "invalid_arguments");
  assert.ok(!JSON.stringify(body).includes("do-not-echo"));
  assert.equal(calls.length, 2, "invalid assertions never invoke an operation");
});

test("HTTP legacy fields stay bounded; no server identity, raw session, URLs or assurance is invented", () => {
  const session = mcpSessionId({ name: "Harness", version: "1" });
  const request = new Request(`${origin}/mcp`, {
    headers: { "mcp-session-id": session, "x-pages-model": "model-a" },
  });
  assert.deepEqual(clientProvenance(request), {
    schema_version: 1,
    assertions: { harness: "Harness/1", model: "model-a" },
  });
  assert.ok(!JSON.stringify(clientProvenance(request)).includes(session));
  const firstForward = new Headers();
  forwardClientProvenance(request, firstForward);
  const secondForward = new Headers();
  forwardClientProvenance(
    new Request(`${origin}/internal/catalog`, { headers: firstForward }),
    secondForward,
  );
  assert.equal(
    clientProvenance(new Request(`${origin}/internal/create`, { headers: secondForward }))
      .assertions.harness,
    "Harness/1",
    "nested owner forwards retain clientInfo without the transport session",
  );
  assert.equal(
    clientProvenance(
      new Request(`${origin}/api/tools`, { headers: { "mcp-session-id": session } }),
    ),
    undefined,
  );
  assert.equal(clientProvenance(new Request(`${origin}/api/tools`)), undefined);
  const explicit = withMcpAgent(request, {
    name: "Release",
    id: "harness-session",
    model: "model-a",
  });
  assert.deepEqual(clientProvenance(explicit, "Release").assertions.agent, {
    name: "Release",
    id: "harness-session",
  });
  assert.throws(() => clientProvenance(explicit, "Other"), /Conflicting agent assertions/);
  assert.throws(
    () => clientProvenance(withMcpAgent(request, { model: "model-b" })),
    /Conflicting agent assertions/,
  );
  assert.equal(
    clientProvenance(request).assertions.agent,
    undefined,
    "one call cannot mutate its connection's labels",
  );
  const legacy = new Request(`${origin}/api/tools`, {
    headers: { "x-pages-client": "explicit/2", "x-pages-model": "m".repeat(200) },
  });
  assert.equal(clientProvenance(legacy, "agent").assertions.model.length, 120);
  const headers = new Headers();
  forwardClientProvenance(legacy, headers);
  assert.equal(headers.get("x-pages-model").length, 120);
});

test("gateway forwards request context to authenticated owner without public identity leakage or privilege elevation", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const identities = [];
  const requests = [];
  const environment = {
    ...auth.env,
    ...env,
    PAGES: {
      getByName: () => ({
        fetch: async (request) => {
          requests.push(request);
          identities.push(await authenticate(request, environment));
          return Response.json({ ok: true });
        },
      }),
    },
  };
  const headers = {
    authorization: `Bearer ${auth.apiKey({ scopes: ["cloud:read"] })}`,
    "mcp-session-id": mcpSessionId({ name: "Harness", version: "1" }),
  };
  for (const agent of [
    { name: "Release", id: "session-a", model: "model-a" },
    { name: "Review", id: "session-b", model: "model-b" },
    undefined,
  ]) {
    const response = await worker.fetch(rpc(agent, headers), environment);
    const body = await response.json();
    assert.ok(!body.result.isError, JSON.stringify(body));
    assert.deepEqual(body.result.structuredContent, { ok: true, kind: "page", breadcrumbs: [] });
    assert.equal(identities.at(-1).principal, `user:anaconda-fixture:${auth.subject}`);
    assert.equal(identities.at(-1).canWrite, false);
    assert.equal(
      identities.at(-1).agent,
      undefined,
      "do not feed new metadata into replayable tool-edit hints",
    );
    assert.deepEqual(identities.at(-1).clientProvenance.assertions, {
      harness: "Harness/1",
      ...(agent && { agent: { name: agent.name, id: agent.id }, model: agent.model }),
    });
    assert.deepEqual(await requests.at(-1).json(), {
      operation: "read_page",
      arguments: { page_id: pageId },
    });
  }
  const response = await worker.fetch(
    rpc({ name: "Release" }, { ...headers, "x-pages-agent": "Conflicting" }),
    environment,
  );
  assert.equal((await response.json()).result.structuredContent.code, "invalid_arguments");
  assert.equal(identities.length, 3);
  const publicHeader = {
    ...headers,
    "x-pages-internal-request-agent": encodeURIComponent(
      JSON.stringify({ name: "Forged", principal: "admin" }),
    ),
  };
  const http = await worker.fetch(
    new Request(`${origin}/api/tools`, {
      method: "POST",
      headers: {
        ...publicHeader,
        "x-pages-client": "HTTP/1",
        "x-pages-model": "model-c",
        "x-pages-agent": "Legacy",
      },
      body: JSON.stringify({ operation: "read_page", arguments: { page_id: pageId } }),
    }),
    environment,
  );
  assert.equal(http.status, 200);
  assert.equal(requests.at(-1).headers.has("x-pages-internal-request-agent"), false);
  assert.deepEqual(identities.at(-1).clientProvenance.assertions, {
    harness: "HTTP/1",
    agent: { name: "Legacy" },
    model: "model-c",
  });
  const whoami = await worker.fetch(
    new Request(`${origin}/whoami`, { headers: publicHeader }),
    environment,
  );
  assert.ok(!JSON.stringify(await whoami.json()).includes("clientProvenance"));
});

test("request-only context does not change existing fingerprints or pretend retries record attribution", async () => {
  const identity = { principal: "account", driver: "MCP" };
  const args = { idempotency_key: "same-request", action: "resolve" };
  const original = await fingerprint("manage_page_comment", args, identity);
  for (const model of ["a", "b"]) {
    const request = withMcpAgent(new Request(`${origin}/mcp`), { id: "session", model });
    assert.equal(
      await fingerprint("manage_page_comment", args, {
        ...identity,
        clientProvenance: clientProvenance(request),
      }),
      original,
    );
  }
});

test("changed request assertions replay original mutation; no-op creates no CRDT change or provenance record", async () => {
  const storage = new Storage();
  let doc = A.from({ page_id: "fixture", text: "before" });
  const handle = {
    doc: () => doc,
    update: async (fn) => {
      doc = fn(doc);
    },
  };
  let applies = 0;
  const context = {
    storage,
    handle,
    operation: "edit_page",
    args: { idempotency_key: "original-operation", base_heads: A.getHeads(doc) },
    flush: async () => {},
    apply: (draft) => {
      applies++;
      draft.text = "after";
      return { edited: true };
    },
  };
  const identity = (name) => ({
    principal: "owner",
    driver: "MCP",
    clientProvenance: clientProvenance(
      withMcpAgent(new Request(`${origin}/mcp`), { name, model: name }),
    ),
  });
  const first = await documentMutation({ ...context, identity: identity("original-assertion") });
  const stored = structuredClone([...storage.values]);
  const heads = A.getHeads(doc);
  assert.deepEqual(
    await documentMutation({ ...context, identity: identity("retry-assertion") }),
    first,
  );
  assert.deepEqual([...storage.values], stored);
  assert.deepEqual(A.getHeads(doc), heads);
  assert.equal(applies, 1);
  assert.ok(!JSON.stringify(stored).includes("original-assertion"));
  assert.ok(!JSON.stringify(stored).includes("clientProvenance"));
  const noOp = await documentMutation({
    ...context,
    identity: identity("no-op-assertion"),
    args: { idempotency_key: "no-op-operation", base_heads: heads },
    apply: () => ({ unchanged: true }),
  });
  assert.deepEqual(noOp.heads, heads);
  assert.deepEqual(A.getHeads(doc), heads);
  assert.ok(!JSON.stringify([...storage.values]).includes("no-op-assertion"));
  A.free(doc);
});
