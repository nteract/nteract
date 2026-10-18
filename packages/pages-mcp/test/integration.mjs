import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
// Generated fixtures against local celld only; no production data or credentials.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { PagesClient } from "@nteract/pages-client";
import { prepareConnection, saveConnection, watchPage } from "@nteract/pages-client/node";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9890";
assert.equal(new URL(origin).hostname, "localhost", "Local OIDC fixtures only");
async function login() {
  const cookies = new Map();
  let url = origin + "/api/auth/login";
  for (let i = 0; i < 12; i++) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const c of response.headers.getSetCookie()) {
      const p = c.split(";")[0],
        at = p.indexOf("=");
      cookies.set(p.slice(0, at), p.slice(at + 1));
    }
    if (!response.headers.has("location")) {
      assert.equal(response.status, 200);
      return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    url = new URL(response.headers.get("location"), url).href;
    assert.equal(new URL(url).origin, origin);
  }
  throw Error("Sign-in did not finish");
}
const cookie = await login();
async function browser(path, body, method = "POST") {
  const response = await fetch(origin + path, {
    method,
    headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}
const made = await browser("/api/tools", {
  operation: "create_page",
  arguments: {
    idempotency_key: crypto.randomUUID(),
    title: "Agent collaboration fixture",
    block_units: [
      { markdown: "People and agents write together.", format: "automerge-rich-text-v1" },
    ],
  },
});
const pending = prepareConnection(origin, made.page_id, "ChatGPT");
const client = new PagesClient(origin, { token: pending.config.token });
await assert.rejects(client.connection(), (e) => e.status === 401);
const request = JSON.parse(new URL(pending.approvalUrl).searchParams.get("connect"));
assert.equal(new URL(pending.approvalUrl).href.includes(pending.config.token), false);
const approved = await browser("/api/agent-connections", request);
const directory = await mkdtemp(path.join(tmpdir(), "pages-agent-smoke-")),
  file = path.join(directory, "connection.json");
await saveConnection(file, pending.config);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/cli.js")],
  env: { ...process.env, PAGES_CONNECTION_FILE: file },
  stderr: "pipe",
});
const hosted = new Client({ name: "pages-hosted-smoke", version: "1" });
const mcp = new Client({ name: "pages-smoke", version: "1" });
const events = [],
  errors = [];
const watch = watchPage(pending.config, (e) => events.push(e), {
  onError: (e) => errors.push(e.message),
});
async function until(fn, label) {
  const deadline = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() > deadline) throw Error("Timed out: " + label);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const value = (result) => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
try {
  await mcp.connect(transport);
  await hosted.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${pending.config.token}` } },
    }),
  );
  assert.ok(
    !(await hosted.listTools()).tools.some((t) => t.name === "list_pages"),
    "scoped credentials cannot discover the account",
  );
  const remoteRead = await hosted.callTool({
    name: "read_page",
    arguments: { page_id: made.page_id },
  });
  assert.equal(value(remoteRead).content.page_id, made.page_id);
  const listed = await mcp.listTools();
  assert.ok(listed.tools.some((t) => t.name === "patch_page"));
  const resource = (await mcp.listResources()).resources[0];
  assert.equal(resource.uri, origin + "/?page=" + made.page_id);
  let notifications = 0;
  mcp.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
    notifications++;
  });
  await mcp.subscribeResource({ uri: resource.uri });
  await until(() => events.length > 0, "initial events");
  // Subscriptions may emit one initial catch-up; repeated reads must not create updates.
  await new Promise((r) => setTimeout(r, 150));
  const baseline = events.length;
  const read = value(
    await mcp.callTool({ name: "read_page", arguments: { page_id: made.page_id } }),
  );
  await client.readPage(made.page_id);
  await client.readPage(made.page_id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.length, baseline, "reads do not emit change events");
  const patch = {
    page_id: made.page_id,
    base_sequence: read.content.through_sequence,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "patch_block_markdown",
        block_id: read.content.blocks[0].id,
        expected_hash: read.content.blocks[0].hash,
        replacements: [{ old: "write together", new: "edit together in realtime" }],
      },
    ],
  };
  const receipt = value(await mcp.callTool({ name: "patch_page", arguments: patch }));
  assert.equal(receipt.attribution.driver, "ChatGPT");
  assert.deepEqual(
    value(await mcp.callTool({ name: "patch_page", arguments: patch })),
    receipt,
    "retry is exactly once",
  );
  await until(
    () => events.some((e) => e.through_sequence === receipt.through_sequence) && notifications > 0,
    "live semantic updates and MCP notifications",
  );
  const latest = await client.readPage(made.page_id);
  assert.match(latest.content.blocks[0].markdown, /edit together in realtime/);
  const wrong = await mcp.callTool({
    name: "read_page",
    arguments: { page_id: "page_" + "0".repeat(32) },
  });
  assert.equal(wrong.isError, true);
  const comment = value(
    await hosted.callTool({
      name: "manage_page_comment",
      arguments: {
        page_id: made.page_id,
        base_sequence: latest.content.through_sequence,
        idempotency_key: crypto.randomUUID(),
        action: "add",
        block_id: latest.content.blocks[0].id,
        selected_text: "edit together",
        body: "A comment from the MCP client.",
      },
    }),
  );
  assert.ok(comment.thread_id);
  await browser("/api/agent-connections", { id: approved.connection.id }, "DELETE");
  await until(() => errors.some((e) => /revoked/.test(e)), "subscription revocation");
  assert.equal(
    (await mcp.callTool({ name: "read_page", arguments: { page_id: made.page_id } })).isError,
    true,
  );
  await assert.rejects(
    hosted.callTool({ name: "read_page", arguments: { page_id: made.page_id } }),
  );
  console.log(
    "PASS: local OIDC approval → scoped SDK → real stdio + hosted MCP edits/comments → live event/resource notifications → revocation; no read-notification loop",
  );
} finally {
  watch.close();
  await mcp.close();
  await hosted.close();
  await rm(directory, { recursive: true, force: true });
}
