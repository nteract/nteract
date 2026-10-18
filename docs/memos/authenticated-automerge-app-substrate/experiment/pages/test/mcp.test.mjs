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
