// /mcp through the Worker, under both protocol eras: admission, client
// identity for usage and presence, and real SDK clients of each era.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { tools } from "../mcp.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import worker from "./index.mjs";
import {
  MODERN_MCP_CLIENT_UUID,
  USAGE_EVENT,
  mcpSessionClient,
  modernMcpClientId,
} from "./usage.mjs";

const MODERN = "2026-07-28";
const origin = "https://pages.example";
const pageId = "44444444-4444-4444-8444-444444444444";
const pageUri = `${origin}/p/${pageId}`;

const envelope = (clientInfo) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  ...(clientInfo && { "io.modelcontextprotocol/clientInfo": clientInfo }),
  "io.modelcontextprotocol/clientCapabilities": {},
});

/** A conforming 2026-07-28 POST that declares its body length. */
function modern(method, params = {}, { token, clientInfo, headers = {}, id = 1 } = {}) {
  const text = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: { ...params._meta, ...envelope(clientInfo) } },
  });
  const name = params.name ?? params.uri;
  return new Request("http://127.0.0.1:9477/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": String(new TextEncoder().encode(text).byteLength),
      "MCP-Protocol-Version": MODERN,
      "Mcp-Method": method,
      ...(name !== undefined && { "Mcp-Name": name }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: text,
  });
}

test("2026-07-28 admission matches legacy: only tools/list and ping skip the credential", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("anonymous MCP must stay local"));
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "oidc-client",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:example",
  };
  const clientInfo = { name: "connector", version: "1" };
  const listed = await worker.fetch(modern("tools/list", {}, { clientInfo }), env);
  assert.equal(listed.status, 200, await listed.clone().text());
  const result = (await listed.json()).result;
  assert.equal(result.resultType, "complete");
  assert.deepEqual(result.tools, JSON.parse(JSON.stringify(tools)));
  // ping is no longer part of the protocol: it passes the anonymous gate as
  // before, and the modern leg answers that it has no such method.
  const pinged = await worker.fetch(modern("ping", {}, { clientInfo }), env);
  assert.equal(pinged.status, 404);
  assert.equal((await pinged.json()).error.code, -32601);
  for (const [method, params] of [
    ["server/discover", {}],
    ["tools/call", { name: "list_pages", arguments: {} }],
    ["resources/list", {}],
    ["resources/read", { uri: pageUri }],
  ]) {
    const response = await worker.fetch(modern(method, params, { clientInfo }), env);
    assert.equal(response.status, 401, method);
    assert.equal(
      response.headers.get("www-authenticate"),
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      method,
    );
  }
});

test("a 2026-07-28 client's declared clientInfo names it in usage and presence", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const token = auth.apiKey();
  const env = { ...auth.env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin };
  env.PAGES_USAGE = sqliteD1(t).open();
  const forwardedSessions = [];
  env.PAGES = {
    getByName: () => ({
      fetch: async (request) => {
        forwardedSessions.push(request.headers.get("mcp-session-id"));
        return Response.json({ page_id: pageId, title: "T", heads: [] });
      },
    }),
  };
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(JSON.parse(line)));
  const toolCalls = () =>
    lines.filter((line) => line.event === USAGE_EVENT && line.action === "tool.call");
  const presence = (clientInfo, headers) =>
    worker.fetch(
      modern(
        "tools/call",
        { name: "read_page_presence", arguments: { page_id: pageId } },
        { token, clientInfo, headers },
      ),
      env,
      { waitUntil: () => {} },
    );

  const first = { name: "connector", version: "2.0" };
  // A modern client's Mcp-Session-Id is ignored, never used for presence.
  const called = await presence(first, { "Mcp-Session-Id": "stale-session-0001" });
  assert.equal(called.status, 200, await called.clone().text());
  assert.equal(called.headers.get("mcp-session-id"), null);
  const body = await called.json();
  assert.equal(body.result.isError, undefined, JSON.stringify(body));
  assert.equal(forwardedSessions.at(-1), await modernMcpClientId(first));
  const call = toolCalls().at(-1);
  assert.equal(call.surface, "mcp");
  assert.equal(call.operation, "read_page_presence");
  assert.equal(call.mcp_client, "connector/2.0");
  assert.equal(call.client, "connector/2.0");
  assert.match(call.session, /^[0-9a-f]{16}$/);

  // A malformed one is ignored too: authentication never reads it.
  const malformed = await presence(first, { "Mcp-Session-Id": "!" });
  assert.equal(malformed.status, 200, await malformed.clone().text());
  assert.equal((await malformed.json()).result.isError, undefined);
  assert.equal(forwardedSessions.at(-1), await modernMcpClientId(first));
  assert.equal(toolCalls().at(-1).session, call.session);
  // A legacy request still has its session id checked.
  const legacyCall = await worker.fetch(
    new Request("http://127.0.0.1:9477/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Mcp-Session-Id": "!",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "read_page_presence", arguments: { page_id: pageId } },
      }),
    }),
    env,
    { waitUntil: () => {} },
  );
  assert.equal(legacyCall.status, 400);

  // The same client keeps its presence tag across stateless requests; another
  // client, or one with no clientInfo, gets its own.
  assert.equal((await presence(first)).status, 200);
  assert.equal(toolCalls().at(-1).session, call.session);
  assert.equal((await presence({ name: "connector", version: "2.1" })).status, 200);
  const other = toolCalls().at(-1);
  assert.equal(other.mcp_client, "connector/2.1");
  assert.notEqual(other.session, call.session);
  assert.equal((await presence(undefined)).status, 200);
  const anonymousClient = toolCalls().at(-1);
  assert.equal(forwardedSessions.at(-1), MODERN_MCP_CLIENT_UUID);
  assert.equal(anonymousClient.mcp_client, undefined);
  assert.match(anonymousClient.session, /^[0-9a-f]{16}$/);
  assert.notEqual(anonymousClient.session, call.session);
  assert.equal(anonymousClient.principal, call.principal);
});

test("a modern client id tells apart clients whose display labels truncate alike", async () => {
  const long = "c".repeat(64);
  const ids = await Promise.all([
    modernMcpClientId({ name: `${long}-alpha`, version: "1" }),
    modernMcpClientId({ name: `${long}-beta`, version: "1" }),
    modernMcpClientId({ name: long, version: "2.0" }),
    modernMcpClientId({ name: long, version: "2.1" }),
  ]);
  // Each pair shares its truncated display label but not its identity.
  assert.equal(mcpSessionClient(ids[0]), mcpSessionClient(ids[1]));
  assert.equal(mcpSessionClient(ids[2]), mcpSessionClient(ids[3]));
  assert.equal(new Set(ids).size, 4);
  for (const id of ids) {
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]+$/,
    );
    assert.ok(id.length <= 128);
  }
  // The same client gets the same id on every request.
  assert.equal(await modernMcpClientId({ name: long, version: "2.1" }), ids[3]);
  assert.equal(await modernMcpClientId({ version: "1" }), MODERN_MCP_CLIENT_UUID);
  assert.equal(await modernMcpClientId(null), MODERN_MCP_CLIENT_UUID);
});

test("a refused 2026-07-28 call's usage names the modern client, not a sent session id", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const token = auth.apiKey();
  const env = { ...auth.env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin };
  env.PAGES_USAGE = sqliteD1(t).open();
  const namespace = {
    getByName: () => ({
      fetch: async () => Response.json({ pages: [] }),
    }),
  };
  env.CATALOGS = namespace;
  env.PAGES = namespace;
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(JSON.parse(line)));
  const lastCall = () =>
    lines.filter((line) => line.event === USAGE_EVENT && line.action === "tool.call").at(-1);
  const clientInfo = { name: "connector", version: "4.0" };
  const sent = { "Mcp-Session-Id": "caller-chosen-0001" };
  const listPages = (args, headers) =>
    worker.fetch(
      modern("tools/call", { name: "list_pages", arguments: args }, { token, clientInfo, headers }),
      env,
      { waitUntil: () => {} },
    );

  assert.equal((await listPages({})).status, 200);
  const clientSession = lastCall().session;
  assert.match(clientSession, /^[0-9a-f]{16}$/);

  // A renamed argument is refused before invoke() authenticates again.
  const refused = await listPages({ space_id: "sp_x" }, sent);
  assert.equal(refused.status, 200);
  assert.equal((await refused.json()).result.isError, true);
  const refusal = lastCall();
  assert.equal(refusal.operation, "list_pages");
  assert.notEqual(refusal.outcome, "ok");
  assert.equal(refusal.mcp_client, "connector/4.0");
  assert.equal(refusal.session, clientSession);

  // The sent id, on a legacy request, has a session tag of its own.
  const legacy = await worker.fetch(
    new Request("http://127.0.0.1:9477/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        ...sent,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_pages", arguments: { space_id: "sp_x" } },
      }),
    }),
    env,
    { waitUntil: () => {} },
  );
  assert.equal(legacy.status, 200);
  assert.match(lastCall().session, /^[0-9a-f]{16}$/);
  assert.notEqual(lastCall().session, clientSession);
});

/** The Worker as an SDK client sees it: every request goes to worker.fetch. */
function connectedClient(env, token, versionNegotiation, methods = []) {
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:9477/mcp"), {
    fetch: (url, init) => {
      if (typeof init?.body === "string") methods.push(JSON.parse(init.body).method);
      return worker.fetch(new Request(url, init), env);
    },
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: "sdk-client", version: "2.4.0" },
    versionNegotiation ? { versionNegotiation } : undefined,
  );
  return { client, transport };
}

test("the official SDK client speaks 2026-07-28 to the Worker without a handshake", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const token = auth.apiKey();
  const env = { ...auth.env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin };
  const methods = [];
  const namespace = {
    getByName: () => ({
      fetch: async (request) => {
        const { operation } = await request.json();
        return Response.json(
          operation === "list_pages"
            ? { pages: [{ page_id: pageId, title: "Notes" }] }
            : { page_id: pageId, title: "Notes" },
        );
      },
    }),
  };
  env.CATALOGS = namespace;
  env.PAGES = namespace;
  const { client, transport } = connectedClient(env, token, { mode: "auto" }, methods);
  await client.connect(transport);
  try {
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), MODERN);
    assert.deepEqual(client.getServerVersion(), { name: "Pages", version: "0.1.0" });
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      tools.map((tool) => tool.name),
    );
    const called = await client.callTool({ name: "list_pages", arguments: {} });
    assert.equal(called.isError, undefined);
    assert.equal(called.structuredContent.pages[0].url, pageUri);
    const resources = await client.listResources();
    assert.equal(resources.resources[0].uri, pageUri);
    const read = await client.readResource({ uri: pageUri });
    assert.equal(JSON.parse(read.contents[0].text).page_id, pageId);
    assert.equal(methods.includes("initialize"), false);
    assert.equal(methods[0], "server/discover");
  } finally {
    await client.close();
  }
});

test("the official SDK client in legacy mode still initializes", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const env = { ...auth.env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin };
  const { client, transport } = connectedClient(env, auth.apiKey());
  await client.connect(transport);
  try {
    assert.equal(client.getProtocolEra(), "legacy");
    assert.equal(client.getNegotiatedProtocolVersion(), "2025-11-25");
    assert.match(transport.sessionId, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, tools.length);
  } finally {
    await client.close();
  }
});
