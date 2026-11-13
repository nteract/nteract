import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../auth-fixtures.mjs";
import worker from "./index.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import {
  LABEL_LIMIT,
  USAGE_EVENT,
  cleanLabel,
  declaredLabels,
  logUsage,
  mcpClientLabel,
  mcpSessionClient,
  mcpSessionId,
  cleanText,
  requestClient,
  usageDropped,
  usageEvent,
  usageOperation,
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
    operation: "edit_page",
    pageId: "44444444-4444-4444-8444-444444444444",
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
    operation: "edit_page",
    page_id: "44444444-4444-4444-8444-444444444444",
    outcome: "ok",
    status: 200,
    latency_ms: 12,
    bytes: 512,
    timestamp: "2026-11-02T00:00:00.000Z",
  });
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /kyle@example\.com|secret/);
  assert.throws(() => usageEvent({ action: "page.unknown" }), TypeError);
  assert.equal(usageEvent({ action: "sync.open", surface: "elsewhere" }).surface, "unknown");
  // The REST routes are a surface of their own, beside /mcp and /api/tools.
  for (const surface of ["mcp", "http-tools", "http-rest", "browser-sync"])
    assert.equal(usageEvent({ action: "tool.call", surface }).surface, surface);
});

test("only known operations and real Page and Project ids reach the record", () => {
  const known = new Set(["read_page", "create_project"]);
  assert.equal(usageOperation("read_page", known), "read_page");
  assert.equal(usageOperation("create_project", known), "create_project");
  // Identifier-shaped free text is still free text.
  assert.equal(usageOperation("summarize_secret_plans", known), "unknown");
  assert.equal(usageOperation(undefined, known), "unknown");
  const record = usageEvent({
    action: "tool.call",
    surface: "http-tools",
    identity: { ...identity, displayName: "kyle@example.com" },
    operation: "Please summarize: secret plans",
    pageId: "secret_plans_page",
    projectId: "prj_secret-plans",
    outcome: "http_404",
  });
  assert.equal(record.operation, "unknown");
  assert.equal(record.page_id, undefined);
  assert.equal(record.project_id, undefined);
  assert.equal(record.outcome, "http_404");
  // An email-shaped display name is a profile without a name: never logged.
  assert.equal(record.display_name, undefined);
  assert.doesNotMatch(JSON.stringify(record), /example\.com|secret/);
  for (const projectId of [
    "prj_11111111-1111-4111-8111-111111111111",
    "sp_11111111-1111-4111-8111-111111111111",
  ])
    assert.equal(usageEvent({ action: "page.create", projectId }).project_id, projectId);
  assert.equal(
    usageEvent({ action: "page.create", projectId: "prj_11111111-1111-1111-8111-111111111111" })
      .project_id,
    undefined,
  );
  assert.equal(usageEvent({ action: "sync.open" }).operation, undefined);
});

test("driver, agent and display name lose control and format characters and are capped", () => {
  const record = usageEvent({
    action: "tool.call",
    identity: {
      ...identity,
      driver: "Ki\u202elo\u0000\u200b",
      agent: "rel\u2066ease\u00ad agent " + "a".repeat(200),
      displayName: "Ky\u200dle\u0007 Kélley " + "名".repeat(400),
    },
  });
  assert.equal(record.driver, "Kilo");
  assert.equal([...record.agent].length, 80);
  assert.match(record.agent, /^release agent a+$/);
  assert.equal([...record.display_name].length, 256);
  assert.match(record.display_name, /^Kyle Kélley 名+$/);
  assert.equal(cleanText("\u200e\u0001 ", 80), undefined);
  assert.equal(cleanText(42, 80), undefined);
  assert.doesNotMatch(JSON.stringify(record), /[\p{Cc}\p{Cf}]/u);
});

test("a lost usage record is counted on the next one and never throws", (t) => {
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(JSON.parse(line)));
  assert.equal(logUsage({ action: "not.an.action" }), undefined);
  usageDropped();
  const next = logUsage({ action: "sync.open", surface: "browser-sync" });
  assert.equal(next.dropped, 2);
  assert.equal(lines.at(-1).dropped, 2);
  assert.equal(logUsage({ action: "sync.close", surface: "browser-sync" }).dropped, undefined);
  t.mock.method(console, "info", () => {
    throw new Error("sink unavailable");
  });
  assert.doesNotThrow(() => logUsage({ action: "sync.open" }));
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
  env.PAGES_USAGE = sqliteD1(t).open();
  const holds = [];
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
      { waitUntil: (work) => holds.push(work) },
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

  const readPresence = {
    method: "tools/call",
    params: { name: "read_page_presence", arguments: { page_id: pageId } },
  };
  const toolCalls = () =>
    lines.filter((line) => line.event === USAGE_EVENT && line.action === "tool.call");

  // A plain-UUID session id issued before this format still works after a
  // deploy: same presence tag shape, no client from the id.
  const before = toolCalls().length;
  const legacy = await post(readPresence, "11111111-1111-4111-8111-111111111111");
  assert.equal(legacy.status, 200);
  const legacyCall = toolCalls().slice(before).at(-1);
  assert.match(legacyCall.session, /^[0-9a-f]{16}$/);
  assert.notEqual(legacyCall.session, tool.session);
  assert.equal(legacyCall.mcp_client, undefined);
  assert.equal(legacyCall.client, undefined);
  assert.equal(legacyCall.principal, tool.principal);

  // A forged client segment only changes the self-declared client label,
  // cleaned like a header. Identity still comes from the credential.
  const forgedLabel = btoa('admin\n{"principal":"x"}\u0007')
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const forged = await post(readPresence, `22222222-2222-4222-8222-222222222222.${forgedLabel}`);
  assert.equal(forged.status, 200);
  const forgedCall = toolCalls().at(-1);
  assert.equal(forgedCall.mcp_client, 'admin{"principal":"x"}');
  assert.equal(forgedCall.principal, tool.principal);
  assert.equal(forgedCall.driver, "Claude Code");
  assert.equal(forgedCall.credential, "api-key");

  // A refusal before invoke() authenticates still names the caller.
  const refused = await post({
    method: "tools/call",
    params: { name: "get_project", arguments: { space_id: "sp_x" } },
  });
  assert.equal(refused.status, 200);
  const refusedCall = toolCalls().at(-1);
  assert.equal(refusedCall.operation, "get_project");
  assert.equal(refusedCall.outcome, "http_400");
  assert.equal(refusedCall.principal, tool.principal);
  assert.equal(refusedCall.kind, "tool");

  // A resource read goes through the same invoke(), recorded as a resource.
  const resource = await post({
    method: "resources/read",
    params: { uri: `https://pages.invalid/p/${pageId}` },
  });
  assert.equal(resource.status, 200);
  const resourceCall = toolCalls().at(-1);
  assert.equal(resourceCall.operation, "read_page");
  assert.equal(resourceCall.kind, "resource");
  assert.equal(resourceCall.page_id, pageId);
  assert.equal(tool.kind, "tool");
  await Promise.all(holds);
  const stored = env.PAGES_USAGE.rows("SELECT * FROM pages_usage_events");
  assert.equal(stored.filter((row) => row.action === "tool.call").length, toolCalls().length);
  assert.ok(stored.every((row) => row.principal === tool.principal));
  assert.doesNotMatch(JSON.stringify(stored), /Fixture Person|claude-opus|clientInfo/);
});

test("a gateway response never awaits a hung or failed usage database", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "info", () => {});
  const token = auth.apiKey();
  const pageId = "44444444-4444-4444-8444-444444444444";
  for (const mode of ["hang", "fail"]) {
    const db = sqliteD1(t).open();
    db.mode = mode;
    const holds = [];
    const env = {
      ...auth.env,
      PAGES_USAGE: db,
      PAGES: { getByName: () => ({ fetch: async () => Response.json({ page_id: pageId }) }) },
    };
    const response = await worker.fetch(
      new Request("https://pages.invalid/api/tools", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "Kilo" },
        body: JSON.stringify({ operation: "read_page_presence", arguments: { page_id: pageId } }),
      }),
      env,
      { waitUntil: (work) => holds.push(work) },
    );
    assert.equal(response.status, 200);
    assert.equal(db.calls, 0, "D1 I/O has not started when the response returns");
    // Recover the fixture before the scheduled work starts, avoiding a real
    // five-second hold in this integration test; virtual time covers timeout.
    db.mode = "ok";
    await Promise.all(holds);
  }
});
