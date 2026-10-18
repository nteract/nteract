import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as A from "@automerge/automerge/slim";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PagesClient } from "@nteract/pages-client";
import worker, { type Env } from "../src/worker.ts";
import { PagesWorkspace, type Storage } from "../src/workspace.ts";
import { SqliteD1 } from "./sqlite.ts";
await A.initializeWasm(
  await readFile(new URL(import.meta.resolve("@automerge/automerge/automerge.wasm"))),
);
class Memory implements Storage {
  values = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values)) this.values.set(key, structuredClone(value));
  }
}

test("hosted MCP and native API use verified key identity, scopes and attribution on each request", async (t) => {
  const origin = "https://pages.example",
    issuer = "https://auth.example",
    db = new SqliteD1();
  t.after(() => db.sqlite.close());
  const rooms = new Map<string, PagesWorkspace>();
  const env: Env = {
    DB: db,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_OIDC_ISSUER: issuer,
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages",
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "pages-test",
    NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: "https://whoami.example/test",
    PAGES_WORKSPACES: {
      idFromName: (name) => ({ toString: () => name }),
      get: (id) => ({ fetch: (request) => room(id.toString()).fetch(request) }),
    },
  };
  function room(principal: string) {
    let result = rooms.get(principal);
    if (!result) {
      result = new PagesWorkspace({ storage: new Memory() }, env);
      rooms.set(principal, result);
    }
    return result;
  }
  const tokens = {
    write: crypto.randomUUID(),
    read: crypto.randomUUID(),
    other: crypto.randomUUID(),
    oidc: crypto.randomUUID(),
  };
  let revoked = false,
    lookups = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL);
    lookups++;
    const token = request.headers.get("Authorization")?.slice(7);
    if (revoked || !Object.values(tokens).some((value) => value === token))
      return new Response(null, { status: 401 });
    return Response.json({
      passport: {
        source: token === tokens.oidc ? "oidc" : "api_key",
        user_id: token === tokens.other ? "other" : "kyle",
        scopes: token === tokens.read ? ["cloud:read"] : ["cloud:write"],
        profile: { first_name: "Kyle", last_name: "Kelley", email: "kyle@example.test" },
      },
    });
  });
  const principal = JSON.stringify([issuer, "pages-test:kyle"]);
  const existing = (await room(principal).call(principal, {
    operation: "create_page",
    arguments: {
      title: "Browser Page",
      markdown: "Hello human",
      idempotency_key: crypto.randomUUID(),
    },
  })) as { page_id: string };
  const localFetch: typeof fetch = async (input, init) =>
    worker.fetch(new Request(input, init), env);
  const headers = {
    Authorization: `Bearer ${tokens.write}`,
    "X-Pages-Driver": "Kilo",
    "x-pages-principal": "forged",
    "x-scope": "owner",
  };
  const mcp = new Client({ name: "hosted-test", version: "1" });
  t.after(() => mcp.close());
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      fetch: localFetch,
      requestInit: { headers },
    }),
  );
  const tools = await mcp.listTools();
  assert.ok(tools.tools.some((t) => t.name === "create_page"));
  const result = (value: unknown) => {
    const v = value as { isError?: boolean; content: { text: string }[] };
    assert.equal(v.isError, undefined, JSON.stringify(v));
    return JSON.parse(v.content[0].text);
  };
  const pages = result(await mcp.callTool({ name: "list_pages", arguments: {} }));
  assert.equal(
    pages.pages[0].page_id,
    existing.page_id,
    "same verified identity reaches browser workspace",
  );
  const read = result(
    await mcp.callTool({ name: "read_page", arguments: { page_id: existing.page_id } }),
  );
  const patch = {
    page_id: existing.page_id,
    base_sequence: read.content.through_sequence,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "patch_block_markdown",
        block_id: read.content.blocks[0].id,
        expected_hash: read.content.blocks[0].hash,
        replacements: [{ old: "human", new: "collaborator" }],
      },
    ],
  };
  const receipt = result(await mcp.callTool({ name: "patch_page", arguments: patch }));
  assert.equal(receipt.attribution.driver, "Kilo");
  assert.equal(receipt.attribution.display_name, "Kyle Kelley");
  assert.deepEqual(result(await mcp.callTool({ name: "patch_page", arguments: patch })), receipt);
  const api = new PagesClient(origin, { token: tokens.write, driver: "Kilo", fetch: localFetch });
  assert.equal(
    (await api.readPage(existing.page_id)).content.blocks[0].markdown,
    "Hello collaborator",
  );
  const created = result(
    await mcp.callTool({
      name: "create_page",
      arguments: {
        title: "From agent",
        markdown: "Rich body",
        idempotency_key: crypto.randomUUID(),
      },
    }),
  );
  assert.equal(created.attribution.driver, "Kilo");
  assert.equal(created.content.blocks[0].format, "automerge-rich-text-v1");
  const resources = await mcp.listResources();
  assert.equal(resources.resources.length, 2);
  await mcp.readResource({ uri: resources.resources[0].uri });
  assert.equal(lookups, 1, "scope checks share the existing bounded provider validation cache");
  const readonly = new Client({ name: "reader", version: "1" });
  t.after(() => readonly.close());
  await readonly.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      fetch: localFetch,
      requestInit: { headers: { Authorization: `Bearer ${tokens.read}` } },
    }),
  );
  assert.ok(!(await readonly.listTools()).tools.some((t) => t.name === "patch_page"));
  assert.equal((await readonly.callTool({ name: "patch_page", arguments: patch })).isError, true);
  const deletion = {
    page_id: created.page_id,
    base_sequence: created.content.through_sequence,
    idempotency_key: crypto.randomUUID(),
  };
  assert.ok(!(await readonly.listTools()).tools.some((t) => t.name === "delete_page"));
  assert.equal(
    (await readonly.callTool({ name: "delete_page", arguments: deletion })).isError,
    true,
  );
  const other = new PagesClient(origin, { token: tokens.other, fetch: localFetch });
  await assert.rejects(
    other.deletePage(deletion.page_id, deletion.base_sequence, deletion.idempotency_key),
    (e) => (e as { status: number }).status === 404,
  );
  const deleted = result(await mcp.callTool({ name: "delete_page", arguments: deletion }));
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.attribution.driver, "Kilo");
  assert.deepEqual(
    result(await mcp.callTool({ name: "delete_page", arguments: deletion })),
    deleted,
  );
  assert.equal((await mcp.listResources()).resources.length, 1);
  await assert.rejects(
    api.readPage(created.page_id),
    (e) => (e as { status: number }).status === 404,
  );
  await assert.rejects(
    other.readPage(existing.page_id),
    (e) => (e as { status: number }).status === 404,
  );
  await assert.rejects(
    new PagesClient(origin, { token: tokens.oidc, fetch: localFetch }).connection(),
    (e) => (e as { status: number }).status === 401,
  );
  const request = async (method: string, body?: unknown, extra: Record<string, string> = {}) =>
    localFetch(origin + "/mcp", {
      method,
      headers: { ...headers, ...extra, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await request("GET")).status, 405);
  assert.equal(
    (
      await request(
        "POST",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal((await request("POST", { padding: "x".repeat(300000) })).status, 413);
  assert.equal((await localFetch(origin + "/mcp", { method: "POST" })).status, 401);
  // Provider revocation becomes effective after the shared validator's 60s TTL.
  revoked = true;
  const later = Date.now() + 61000;
  t.mock.method(Date, "now", () => later);
  await assert.rejects(
    api.readPage(existing.page_id),
    (e) => (e as { status: number }).status === 401,
  );
});
