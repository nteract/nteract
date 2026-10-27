import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcp as handleMcpRequest, tools } from "../mcp.mjs";
const env = { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example" };
const handleMcp = (request, invoke) => handleMcpRequest(request, invoke, env);
const request = (method, params = {}) =>
  new Request("http://127.0.0.1:9477/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: "untrusted.example",
      "X-Forwarded-Host": "also-untrusted.example",
      "X-Forwarded-Proto": "http",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
test("MCP forwards authorized operations and preserves stale-write failure", async () => {
  const calls = [];
  const response = await handleMcp(
    request("tools/call", {
      name: "edit_page",
      arguments: {
        page_id: "page_x",
        base_heads: ["old"],
        idempotency_key: "request-1234",
        operations: [],
      },
    }),
    async (op, args) => {
      calls.push({ op, args });
      return Response.json({ error: "stale_heads" }, { status: 409 });
    },
  );
  const result = await response.json();
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /stale_heads/);
  assert.deepEqual(calls[0].args.base_heads, ["old"]);
});
test("MCP refuses resource URLs outside this service before invoking tools", async () => {
  let invoked = false;
  const response = await handleMcp(
    request("resources/read", { uri: "https://elsewhere.example/?page=page_" + "a".repeat(32) }),
    async () => {
      invoked = true;
      return Response.json({});
    },
  );
  assert.equal(invoked, false);
  assert.ok((await response.json()).error);
});
const pageId = "1a160b47-6df1-4983-81eb-489ca5a26812";
test("MCP creation and listings use the configured HTTPS origin behind an HTTP proxy", async () => {
  const response = await handleMcp(
    request("tools/call", {
      name: "create_page",
      arguments: { title: "Test", idempotency_key: "create-route" },
    }),
    async () => Response.json({ page_id: pageId, title: "Test" }),
  );
  const created = JSON.parse((await response.json()).result.content[0].text);
  assert.equal(created.url, `https://pages.example/p/${pageId}`);
  const list = await handleMcp(request("resources/list"), async () =>
    Response.json({ pages: [{ page_id: pageId, title: "Test" }] }),
  );
  assert.equal((await list.json()).result.resources[0].uri, created.url);
});
test("MCP reads canonical and legacy links while rejecting ambiguous resource URLs", async () => {
  for (const uri of [
    `https://pages.example/p/${pageId}`,
    `https://pages.example/?page=${pageId}`,
  ]) {
    let invoked = false;
    const response = await handleMcp(request("resources/read", { uri }), async (op, args) => {
      invoked = true;
      assert.equal(op, "read_page");
      assert.equal(args.page_id, pageId);
      return Response.json({ page_id: pageId });
    });
    assert.equal((await response.json()).result.contents[0].uri, uri);
    assert.equal(invoked, true);
  }
  for (const uri of [
    `https://pages.example/p/${pageId}?other=1`,
    `https://pages.example/p/${pageId}#other`,
    `https://pages.example/?page=${pageId}&other=1`,
    `http://127.0.0.1:9477/p/${pageId}`,
    `http://pages.example/p/${pageId}`,
    `https://untrusted.example/p/${pageId}`,
    `https://also-untrusted.example/p/${pageId}`,
  ]) {
    let invoked = false;
    const response = await handleMcp(request("resources/read", { uri }), async () => {
      invoked = true;
      return Response.json({});
    });
    assert.ok((await response.json()).error);
    assert.equal(invoked, false);
  }
});

test("MCP advertises visible-text replacement separately from Markdown replacement", async () => {
  const patch = tools.find((tool) => tool.name === "patch_page");
  const variants = patch.inputSchema.properties.operations.items.oneOf;
  assert.deepEqual(
    variants.map((operation) => operation.properties.op.const),
    ["replace_match", "patch_block_markdown"],
  );
  assert.deepEqual(variants[0].required, ["op", "block_id", "match_text", "replacement"]);
  assert.equal(variants[0].properties.context_before.type, "string");
  assert.equal(variants[0].properties.context_after.type, "string");
  assert.match(patch.description, /without a typing cursor/);
  const args = {
    page_id: pageId,
    base_heads: ["a".repeat(64)],
    idempotency_key: "replace-visible-text",
    operations: [
      {
        op: "replace_match",
        block_id: "block-a",
        match_text: "word",
        replacement: "phrase",
        context_before: "second",
      },
    ],
  };
  const response = await handleMcp(
    request("tools/call", { name: "patch_page", arguments: args }),
    async (operation, received) => {
      assert.equal(operation, "patch_page");
      assert.deepEqual(received, args);
      return Response.json({
        page_id: pageId,
        result: { edits: [{ op: "replace_match", block_id: "block-a", matched: 1 }] },
      });
    },
  );
  assert.equal(
    JSON.parse((await response.json()).result.content[0].text).result.edits[0].matched,
    1,
  );
});

test("MCP list and read tool links use the public origin regardless of proxy headers", async () => {
  for (const [name, body] of [
    ["list_pages", { pages: [{ page_id: pageId, title: "Test" }] }],
    ["read_page", { page_id: pageId, title: "Test", blocks: [] }],
  ]) {
    const response = await handleMcp(
      request("tools/call", { name, arguments: name === "read_page" ? { page_id: pageId } : {} }),
      async () => Response.json(body),
    );
    const result = JSON.parse((await response.json()).result.content[0].text);
    assert.equal((result.pages?.[0] ?? result).url, `https://pages.example/p/${pageId}`);
  }
});

test("MCP does not fall back to the request URL when public origin configuration is missing", async () => {
  await assert.rejects(() =>
    handleMcpRequest(request("tools/list"), async () => Response.json({}), {}),
  );
});

test("MCP tool metadata declares the OAuth scopes needed by each operation", async () => {
  const response = await handleMcp(request("tools/list"), async () =>
    assert.fail("listing invoked an operation"),
  );
  const listed = (await response.json()).result.tools;
  assert.equal(listed.length, tools.length);
  for (const tool of listed) {
    assert.deepEqual(
      tool.securitySchemes,
      [
        {
          type: "oauth2",
          scopes: ["list_pages", "read_page"].includes(tool.name)
            ? ["pages:read"]
            : ["pages:read", "pages:write"],
        },
      ],
      tool.name,
    );
  }
});

test("only verified OAuth credential failures produce tool reauthorization challenges", async () => {
  for (const [token, status, code, expected] of [
    ["pages_at_fixture", 401, "oauth_invalid_token", "invalid_token"],
    ["pages_at_fixture", 403, "oauth_insufficient_scope", "insufficient_scope"],
    ["pages_at_fixture", 403, undefined, undefined],
    ["pages_at_fixture", 409, "oauth_insufficient_scope", undefined],
    ["anaconda-fixture-key", 403, "oauth_insufficient_scope", undefined],
    ["anaconda-fixture-key", 401, undefined, undefined],
  ]) {
    const req = request("tools/call", { name: "read_page", arguments: { page_id: pageId } });
    req.headers.set("authorization", `Bearer ${token}`);
    const response = await handleMcp(req, async () =>
      Response.json({ error: "Denied", ...(code && { code }) }, { status }),
    );
    const result = (await response.json()).result;
    assert.equal(result.isError, true);
    if (!expected) {
      assert.equal(result._meta, undefined);
      continue;
    }
    const [challenge] = result._meta["mcp/www_authenticate"];
    assert.match(challenge, new RegExp(`error="${expected}"`));
    assert.match(challenge, /error_description="[^"\n]+"/);
    assert.match(challenge, /scope="pages:read"/);
    assert.ok(
      challenge.includes(
        'resource_metadata="https://pages.example/.well-known/oauth-protected-resource/mcp"',
      ),
    );
    assert.equal(challenge.includes(token), false);
    assert.equal(challenge.includes("untrusted.example"), false);
    assert.equal(challenge.includes("127.0.0.1"), false);
  }
});
