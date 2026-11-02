import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import worker from "./index.mjs";
import {
  LABEL_LIMIT,
  USAGE_EVENT,
  cleanLabel,
  declaredLabels,
  mcpClientLabel,
  mcpSessionClient,
  mcpSessionId,
  requestClient,
  usageEvent,
} from "./usage.mjs";

const identity = {
  principal: "anaconda:user-1",
  displayName: "Kyle",
  namespace: "anaconda",
  credentialKind: "api-key",
  driver: "Kilo",
  agent: "release agent",
  session: "0123456789abcdef",
  canWrite: true,
  verifiedEmail: "kyle@example.com",
  emailProof: { secret: true },
};

test("usage event has a fixed shape and omits secrets and absent fields", () => {
  const record = usageEvent({
    action: "tool.call",
    surface: "mcp",
    identity,
    labels: { client: "kilo-cli/1.2.3", mcp_client: "kilo/1.2.3", model: "claude-opus-5.5" },
    operation: "patch_page",
    pageId: "page-1",
    status: 200,
    outcome: "ok",
    latencyMs: 12.4,
    bytes: 512,
    now: new Date("2026-11-02T00:00:00Z"),
  });
  assert.deepEqual(record, {
    service: "nteract-pages-native",
    event: USAGE_EVENT,
    action: "tool.call",
    surface: "mcp",
    principal: "anaconda:user-1",
    display_name: "Kyle",
    namespace: "anaconda",
    credential: "api-key",
    driver: "Kilo",
    agent: "release agent",
    session: "0123456789abcdef",
    client: "kilo-cli/1.2.3",
    mcp_client: "kilo/1.2.3",
    model: "claude-opus-5.5",
    operation: "patch_page",
    page_id: "page-1",
    outcome: "ok",
    status: 200,
    latency_ms: 12,
    bytes: 512,
    timestamp: "2026-11-02T00:00:00.000Z",
  });
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /kyle@example\.com|secret/);
  assert.throws(() => usageEvent({ action: "page.read" }), TypeError);
  assert.equal(usageEvent({ action: "sync.open", surface: "elsewhere" }).surface, "unknown");
});

test("client and model headers are cleaned, truncated, and never rejected", () => {
  assert.equal(cleanLabel("  claude-code/2.1.0  "), "claude-code/2.1.0");
  assert.equal(cleanLabel("a\u0000b\nc\u202ed"), "abcd");
  assert.equal(cleanLabel("   "), undefined);
  assert.equal(cleanLabel("\u0007"), undefined);
  assert.equal(cleanLabel(42), undefined);
  assert.equal(cleanLabel("x".repeat(500)).length, LABEL_LIMIT);
  const labels = declaredLabels(
    new Request("https://pages.invalid/mcp", {
      headers: { "x-pages-client": "Kilo Desktop/7.0", "x-pages-model": "m".repeat(400) },
    }),
  );
  assert.deepEqual(labels, { client: "Kilo Desktop/7.0", model: "m".repeat(LABEL_LIMIT) });
  assert.deepEqual(declaredLabels(new Request("https://pages.invalid/mcp")), {});
});

test("MCP clientInfo round-trips through the session id within the session id shape", () => {
  assert.equal(mcpClientLabel({ name: "claude-code", version: "2.1.0" }), "claude-code/2.1.0");
  assert.equal(mcpClientLabel({ name: "" }), undefined);
  const id = mcpSessionId({ name: "claude-code", version: "2.1.0" });
  assert.match(id, /^[A-Za-z0-9._-]{8,128}$/);
  assert.equal(mcpSessionClient(id), "claude-code/2.1.0");
  const long = mcpSessionId({ name: "n".repeat(300), version: "v".repeat(300) });
  assert.ok(long.length <= 128);
  assert.match(mcpSessionClient(long), /^n+\/v*$/);
  // Old plain-UUID sessions and malformed ids carry no client.
  assert.equal(
    mcpSessionId(undefined, "11111111-1111-4111-8111-111111111111").includes("."),
    false,
  );
  assert.equal(mcpSessionClient(crypto.randomUUID()), undefined);
  assert.equal(mcpSessionClient("garbage.***"), undefined);
  // A declared header wins over clientInfo; clientInfo stays as mcp_client.
  const request = new Request("https://pages.invalid/mcp", {
    headers: { "mcp-session-id": id, "x-pages-client": "kilo-cli/1.0" },
  });
  assert.deepEqual(requestClient(request), {
    client: "kilo-cli/1.0",
    mcp_client: "claude-code/2.1.0",
  });
});

test("MCP clientInfo from initialize is carried onto tool-call usage events", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const token = auth.apiKey();
  const env = auth.env;
  env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN ??= "https://pages.invalid";
  const pageId = "44444444-4444-4444-8444-444444444444";
  env.PAGES = {
    getByName: () => ({
      fetch: async () => Response.json({ page_id: pageId, title: "T", heads: [] }),
    }),
  };
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(JSON.parse(line)));
  const post = (body, session) =>
    worker.fetch(
      new Request("https://pages.invalid/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-pages-driver": "Claude Code",
          "x-pages-model": "claude-opus-5.5",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(session && { "mcp-session-id": session }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
      }),
      env,
    );
  const init = await post({
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2.1.0" },
    },
  });
  assert.equal(init.status, 200);
  const session = init.headers.get("mcp-session-id");
  const call = await post(
    {
      method: "tools/call",
      params: { name: "read_page_presence", arguments: { page_id: pageId } },
    },
    session,
  );
  assert.equal(call.status, 200);
  const usage = lines.filter((line) => line.event === USAGE_EVENT);
  const initialized = usage.find((line) => line.action === "mcp.initialize");
  assert.equal(initialized.client, "claude-code/2.1.0");
  assert.equal(initialized.protocol_version, "2025-06-18");
  assert.equal(initialized.model, "claude-opus-5.5");
  const tool = usage.find((line) => line.action === "tool.call");
  assert.equal(tool.surface, "mcp");
  assert.equal(tool.operation, "read_page_presence");
  assert.equal(tool.client, "claude-code/2.1.0");
  assert.equal(tool.mcp_client, "claude-code/2.1.0");
  assert.equal(tool.model, "claude-opus-5.5");
  assert.equal(tool.driver, "Claude Code");
  assert.equal(tool.page_id, pageId);
  assert.equal(tool.outcome, "ok");
  assert.ok(tool.principal);
  assert.match(tool.session, /^[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(usage), new RegExp(token));
});
