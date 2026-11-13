// The /mcp handler serves two protocol eras on one endpoint: 2026-07-28
// requests that declare their version per request, and legacy requests that
// open with initialize. These tests drive handleMcp directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcp, tools } from "../mcp.mjs";
import { PRODUCT_NAME } from "../shared/product.mjs";

const env = { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example" };
const MODERN = "2026-07-28";
const pageId = "1a160b47-6df1-4983-81eb-489ca5a26812";
const pageUri = `https://pages.example/p/${pageId}`;
const clientInfo = { name: "era-test", version: "3.1" };
const serverInfo = { name: PRODUCT_NAME, version: "0.1.0" };

const envelope = (version = MODERN, extra = {}) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientInfo": clientInfo,
  "io.modelcontextprotocol/clientCapabilities": {},
  ...extra,
});

const post = (body, headers = {}) =>
  new Request("http://127.0.0.1:9477/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A 2026-07-28 request with the standard headers a conforming client sends. */
const modern = (method, params = {}, { version = MODERN, headers = {}, id = 1 } = {}) => {
  const name = params.name ?? params.uri;
  return post(
    { jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope(version, params._meta) } },
    {
      "MCP-Protocol-Version": version,
      "Mcp-Method": method,
      ...(name !== undefined && { "Mcp-Name": name }),
      ...headers,
    },
  );
};

const legacy = (method, params, { id = 1, headers = {} } = {}) =>
  post({ jsonrpc: "2.0", id, method, ...(params && { params }) }, headers);

const recording = () => {
  const calls = [];
  const invoke = async (operation, args, options) => {
    calls.push({ operation, args, options });
    return operation === "list_pages"
      ? Response.json({ pages: [{ page_id: pageId, title: "Notes" }] })
      : Response.json({ page_id: pageId, title: "Notes" });
  };
  return { calls, invoke };
};

const noInvoke = async () => assert.fail("this request must not invoke a tool");

async function exchange(request, invoke = noInvoke) {
  const response = await handleMcp(request, invoke, env);
  const text = await response.text();
  return { response, status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function legacyInstructions() {
  const { body } = await exchange(
    legacy("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo }),
  );
  return body.result.instructions;
}

test("server/discover advertises versions, capabilities, identity and instructions", async () => {
  const { response, status, body } = await exchange(modern("server/discover"));
  assert.equal(status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.deepEqual(body, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      resultType: "complete",
      supportedVersions: [MODERN],
      capabilities: { tools: {}, resources: {} },
      instructions: await legacyInstructions(),
      ttlMs: 60_000,
      cacheScope: "public",
      _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
    },
  });
});

test("2026-07-28 tools/list returns the same catalog with cache hints and server identity", async () => {
  const { status, body, response } = await exchange(modern("tools/list"));
  assert.equal(status, 200);
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.deepEqual(body.result.tools, JSON.parse(JSON.stringify(tools)));
  assert.equal(body.result.resultType, "complete");
  assert.equal(body.result.ttlMs, 60_000);
  assert.equal(body.result.cacheScope, "public");
  assert.deepEqual(body.result._meta, { "io.modelcontextprotocol/serverInfo": serverInfo });
});

test("2026-07-28 tools/call hands invoke() the declared client and agent assertions", async () => {
  const { calls, invoke } = recording();
  const { status, body } = await exchange(
    modern("tools/call", {
      name: "list_pages",
      arguments: {},
      _meta: { agent: { model: "model-1" } },
    }),
    invoke,
  );
  assert.equal(status, 200);
  assert.equal(body.result.resultType, "complete");
  assert.equal(body.result.isError, undefined);
  assert.equal(body.result.structuredContent.pages[0].url, pageUri);
  assert.deepEqual(JSON.parse(body.result.content[0].text), body.result.structuredContent);
  assert.deepEqual(calls, [
    {
      operation: "list_pages",
      args: {},
      options: { agent: { model: "model-1" }, client: clientInfo },
    },
  ]);
});

test("2026-07-28 tools/call without clientInfo hands invoke() a null client", async () => {
  const { calls, invoke } = recording();
  const request = post(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "list_pages",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": "list_pages" },
  );
  const { status } = await exchange(request, invoke);
  assert.equal(status, 200);
  assert.deepEqual(calls[0].options, { client: null });
});

test("2026-07-28 resources/list and resources/read reach invoke() as resources", async () => {
  const { calls, invoke } = recording();
  const listed = await exchange(modern("resources/list"), invoke);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.result.resources, [
    { uri: pageUri, name: "Notes", mimeType: "application/json" },
  ]);
  assert.equal(listed.body.result.cacheScope, "private");
  assert.equal(listed.body.result.ttlMs, 0);
  const read = await exchange(modern("resources/read", { uri: pageUri }), invoke);
  assert.equal(read.status, 200);
  assert.equal(read.body.result.contents[0].uri, pageUri);
  assert.equal(JSON.parse(read.body.result.contents[0].text).page_id, pageId);
  assert.equal(read.body.result.cacheScope, "private");
  assert.deepEqual(
    calls.map(({ operation, options }) => [operation, options]),
    [
      ["list_pages", { kind: "resource", client: clientInfo }],
      ["read_page", { kind: "resource", client: clientInfo }],
    ],
  );
});

test("2026-07-28 has no ping or initialize: both are unknown methods", async () => {
  for (const method of ["ping", "initialize"]) {
    const { status, body } = await exchange(modern(method));
    assert.equal(status, 404, method);
    assert.deepEqual(body, {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });
  }
});

test("a 2026-07-28 request ignores a client's Mcp-Session-Id and is issued none", async () => {
  const { calls, invoke } = recording();
  const { status, response } = await exchange(
    modern(
      "tools/call",
      { name: "list_pages", arguments: {} },
      { headers: { "Mcp-Session-Id": "stale-session-1" } },
    ),
    invoke,
  );
  assert.equal(status, 200);
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.deepEqual(calls[0].options, { client: clientInfo });
});

test("2026-07-28 header validation rejects missing and mismatched headers", async () => {
  const cases = [
    {
      name: "missing MCP-Protocol-Version",
      request: modern("tools/list", {}, { headers: { "MCP-Protocol-Version": "" } }),
      code: -32020,
    },
    {
      name: "MCP-Protocol-Version differs from _meta",
      request: modern("tools/list", {}, { headers: { "MCP-Protocol-Version": "2026-08-01" } }),
      code: -32020,
    },
    {
      name: "Mcp-Method differs from the body",
      request: modern("tools/list", {}, { headers: { "Mcp-Method": "resources/list" } }),
      code: -32020,
    },
    {
      name: "Mcp-Name missing on tools/call",
      request: modern(
        "tools/call",
        { name: "list_pages", arguments: {} },
        { headers: { "Mcp-Name": "" } },
      ),
      code: -32020,
    },
    {
      name: "header names 2026-07-28 but the body has no _meta",
      request: post(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/list" },
      ),
      code: -32602,
    },
    {
      name: "_meta without clientCapabilities",
      request: post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
        },
        { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/list" },
      ),
      code: -32602,
    },
  ];
  for (const { name, request, code } of cases) {
    // An empty header value is the same as a missing one.
    for (const [key, value] of [...request.headers]) if (value === "") request.headers.delete(key);
    const { status, body } = await exchange(request);
    assert.equal(status, 400, name);
    assert.equal(body.jsonrpc, "2.0", name);
    assert.equal(body.id, 1, name);
    assert.equal(body.error.code, code, name);
  }
});

test("an Mcp-Name in the Base64 sentinel form matches its decoded body value", async () => {
  const { calls, invoke } = recording();
  const { status } = await exchange(
    modern(
      "tools/call",
      { name: "list_pages", arguments: {} },
      { headers: { "Mcp-Name": `=?base64?${btoa("list_pages")}?=` } },
    ),
    invoke,
  );
  assert.equal(status, 200);
  assert.equal(calls.length, 1);
});

test("an unknown future version gets UnsupportedProtocolVersionError", async () => {
  const { status, body } = await exchange(
    modern("tools/list", {}, { version: "2099-01-01", id: "x" }),
  );
  assert.equal(status, 400);
  assert.deepEqual(body, {
    jsonrpc: "2.0",
    id: "x",
    error: {
      code: -32022,
      message: "Unsupported protocol version: 2099-01-01",
      data: { supported: [MODERN], requested: "2099-01-01" },
    },
  });
});

test("a known legacy version declared per request gets UnsupportedProtocolVersionError", async () => {
  // 2025-11-25 is served only after initialize, never from a per-request claim.
  const { status, body } = await exchange(modern("server/discover", {}, { version: "2025-11-25" }));
  assert.equal(status, 400);
  assert.deepEqual(body, {
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32022,
      message: "Unsupported protocol version: 2025-11-25",
      data: { supported: [MODERN], requested: "2025-11-25" },
    },
  });
});

test("legacy initialize then tools/list is served as before", async () => {
  const initialized = await exchange(
    legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo }),
  );
  assert.equal(initialized.status, 200);
  assert.equal(initialized.response.headers.get("content-type"), "application/json");
  assert.match(
    initialized.response.headers.get("mcp-session-id"),
    /^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/,
  );
  assert.deepEqual(initialized.body, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo,
      instructions: initialized.body.result.instructions,
    },
  });
  assert.match(initialized.body.result.instructions, /^Start with list_pages/);
  const session = initialized.response.headers.get("mcp-session-id");
  const listed = await exchange(
    legacy("tools/list", undefined, {
      id: 2,
      headers: { "MCP-Protocol-Version": "2025-06-18", "Mcp-Session-Id": session },
    }),
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.response.headers.get("mcp-session-id"), null);
  // A legacy result has no 2026-07-28 fields.
  assert.deepEqual(listed.body, {
    jsonrpc: "2.0",
    id: 2,
    result: { tools: JSON.parse(JSON.stringify(tools)) },
  });
});

test("a legacy client's responses are pinned", async () => {
  const { calls, invoke } = recording();
  const pinned = [
    {
      name: "initialize with an unknown version negotiates the latest legacy one",
      request: legacy("initialize", {
        protocolVersion: "2099-01-01",
        capabilities: {},
        clientInfo,
      }),
      status: 200,
      check: (body) => assert.equal(body.result.protocolVersion, "2025-11-25"),
    },
    {
      name: "ping",
      request: legacy("ping"),
      status: 200,
      body: { jsonrpc: "2.0", id: 1, result: {} },
    },
    {
      name: "tools/call",
      request: legacy("tools/call", { name: "list_pages", arguments: {} }),
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ pages: [{ page_id: pageId, title: "Notes", url: pageUri }] }),
            },
          ],
          structuredContent: { pages: [{ page_id: pageId, title: "Notes", url: pageUri }] },
        },
      },
    },
    {
      name: "resources/list",
      request: legacy("resources/list"),
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: { resources: [{ uri: pageUri, name: "Notes", mimeType: "application/json" }] },
      },
    },
    {
      name: "a foreign resource",
      request: legacy("resources/read", { uri: "https://elsewhere.example/p/x" }),
      status: 200,
      body: { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Unknown Page resource" } },
    },
    {
      name: "an unknown method",
      request: legacy("frobnicate"),
      status: 200,
      body: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
    },
    {
      name: "server/discover without a per-request version is a legacy unknown method",
      request: legacy("server/discover"),
      status: 200,
      body: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
    },
    {
      name: "an unsupported legacy header version",
      request: legacy("tools/list", undefined, {
        headers: { "MCP-Protocol-Version": "2024-01-01" },
      }),
      status: 400,
      body: {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message:
            "Bad Request: Unsupported protocol version: 2024-01-01 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)",
        },
      },
    },
    {
      name: "malformed JSON",
      request: post("{not json"),
      status: 400,
      body: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Invalid JSON" },
      },
    },
    {
      name: "a missing Accept header",
      request: new Request("http://127.0.0.1:9477/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      status: 406,
      body: {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: "Not Acceptable: Client must accept both application/json and text/event-stream",
        },
      },
    },
    {
      name: "notifications/initialized",
      request: post({ jsonrpc: "2.0", method: "notifications/initialized" }),
      status: 202,
    },
  ];
  for (const { name, request, status, body, check } of pinned) {
    const result = await exchange(request, invoke);
    assert.equal(result.status, status, name);
    assert.equal(result.response.headers.get("cache-control"), "no-store", name);
    if (body) assert.deepEqual(result.body, body, name);
    else if (status === 202) assert.equal(result.body, undefined, name);
    check?.(result.body);
  }
  // Legacy invocations carry no client: the session id names it.
  assert.deepEqual(
    calls.map(({ operation, options }) => [operation, options]),
    [
      ["list_pages", undefined],
      ["list_pages", { kind: "resource" }],
    ],
  );
  const get = await handleMcp(new Request("http://127.0.0.1:9477/mcp"), noInvoke, env);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
});

test("a 2026-07-28 change budget counts the fields the protocol adds to a result", async () => {
  const outcomes = new Set();
  for (let length = 1600; length <= 2000; length += 4) {
    const changes = {
      page_id: pageId,
      heads: ["c".repeat(64)],
      changes: [{ block_id: "block", node_index: 0, markdown: "a".repeat(length) }],
      retry_token: "authority",
      retry_key_prefix: "prefix_",
    };
    const response = await handleMcp(
      modern("tools/call", {
        name: "read_page_changes",
        arguments: { page_id: pageId, since_heads: ["b".repeat(64)], max_bytes: 4096 },
      }),
      async () => Response.json(changes),
      env,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length <= 4096, `${length}: complete response is ${bytes.length} bytes`);
    const { result } = JSON.parse(new TextDecoder().decode(bytes));
    assert.equal(result.resultType, "complete");
    if (result.isError === true) assert.equal(result.structuredContent.retry_token, "authority");
    outcomes.add(result.isError === true ? result.structuredContent.code : "fits");
  }
  // The sweep crosses the budget, so both sides of it were measured.
  assert.deepEqual([...outcomes].sort(), ["changes_budget_exceeded", "fits"]);
});
