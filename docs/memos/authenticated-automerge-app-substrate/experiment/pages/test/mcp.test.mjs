import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcp } from "../mcp.mjs";
const request = (method, params = {}) =>
  new Request("https://pages.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
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
test("MCP creation and listings return canonical browser links", async () => {
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
