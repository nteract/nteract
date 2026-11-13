import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import { gatewayFixture, pageId, privateOrigin, publicOrigin } from "./gateway-fixture.mjs";
import { API_ARGUMENTS, REST_ARGUMENTS, allowedArguments } from "./tool-arguments.mjs";
import { tools } from "../mcp.mjs";

/** A gateway whose Catalog records what reaches it and answers 200. */
async function gateway(t) {
  const f = await gatewayFixture(t);
  const catalog = [];
  f.env.CATALOGS = {
    getByName() {
      return {
        async fetch(request) {
          catalog.push(await request.clone().json());
          return Response.json({ page_id: pageId, state: "trashed" });
        },
      };
    },
  };
  const headers = (credential) =>
    credential === "cookie"
      ? { cookie: f.cookie, origin: publicOrigin, "sec-fetch-site": "same-origin" }
      : { authorization: f.bearer };
  const tool = async (credential, operation, args) => {
    const response = await worker.fetch(
      new Request(`${privateOrigin}/api/tools`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers(credential) },
        body: JSON.stringify({ operation, arguments: args }),
      }),
      f.env,
    );
    return { status: response.status, body: await response.json() };
  };
  const mcp = async (name, args) => {
    const response = await worker.fetch(
      new Request(`${privateOrigin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: f.bearer,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      f.env,
    );
    const envelope = await response.json();
    return JSON.parse(envelope.result.content[0].text);
  };
  return { ...f, catalog, tool, mcp };
}

const refused = (answer, name) => {
  assert.equal(answer.status ?? 400, 400, JSON.stringify(answer));
  const body = answer.body ?? answer;
  assert.equal(body.code, "invalid_arguments", JSON.stringify(body));
  assert.match(body.error, new RegExp(`\`${name}\``));
};

test("an argument an operation doesn't take is refused before anything runs, over both transports", async (t) => {
  const g = await gateway(t);
  const nonce = crypto.randomUUID();
  const cases = [
    // A read.
    ["read_page", { page_id: pageId, comments: "none", since_heads: [] }, "since_heads"],
    // A Page write.
    [
      "edit_page",
      { page_id: pageId, revision: "r1", nonce, operations: [], base_heads: ["a".repeat(64)] },
      "base_heads",
    ],
    // A catalog write.
    ["create_page", { title: "New", nonce, idempotency_key: "old-key-name" }, "idempotency_key"],
    ["move_page", { page_id: pageId, project_id: null, nonce, retry_token: "old" }, "retry_token"],
  ];
  for (const [operation, args, name] of cases) {
    refused(await g.tool("bearer", operation, args), name);
    refused(await g.mcp(operation, args), name);
  }
  // A viewer-only operation, which has no MCP tool.
  refused(await g.tool("cookie", "page_cards", { page_ids: [pageId], extra: true }), "extra");
  refused(
    await g.tool("bearer", "reply_page_comment", { page_id: pageId, thread_id: "t", oops: 1 }),
    "oops",
  );
  // The MCP schema names no viewer extras.
  refused(
    await g.mcp("restore_page", { page_id: pageId, nonce, expected_principal: "x" }),
    "expected_principal",
  );
  assert.equal(g.forwarded.length, 0, "no Page saw a refused call");
  assert.deepEqual(g.catalog, [], "no Catalog saw a refused call");
});

test("delete_page with base_heads from an agent credential is refused and nothing is trashed", async (t) => {
  const g = await gateway(t);
  const args = { page_id: pageId, base_heads: ["a".repeat(64)], nonce: crypto.randomUUID() };
  refused(await g.tool("bearer", "delete_page", args), "base_heads");
  refused(await g.mcp("delete_page", args), "base_heads");
  assert.deepEqual(g.catalog, []);
  // A browser session sends its heads, and the call reaches the Catalog with them.
  const browser = await g.tool("cookie", "delete_page", {
    ...args,
    expected_principal: g.page.metadata.owner,
  });
  assert.notEqual(browser.body.code, "invalid_arguments", JSON.stringify(browser.body));
  assert.equal(g.catalog.length, 1);
  assert.deepEqual(g.catalog[0].arguments.base_heads, args.base_heads);
});

test("only a browser session's delete_page takes base_heads", () => {
  for (const credentialKind of ["api-key", "oauth", "kilo-token", undefined])
    for (const transport of ["http-tools", "mcp"])
      assert.ok(
        !allowedArguments("delete_page", transport, { credentialKind }).has("base_heads"),
        `${credentialKind} over ${transport}`,
      );
  assert.ok(
    allowedArguments("delete_page", "http-tools", { credentialKind: "oidc" }).has("base_heads"),
  );
});

test("the REST routes take list_pages' schema, and the tag operations only their own arguments", () => {
  const listed = tools.find((tool) => tool.name === "list_pages");
  assert.deepEqual(
    [...allowedArguments("list_pages", "http-rest")].sort(),
    Object.keys(listed.inputSchema.properties).sort(),
  );
  for (const operation of ["put_page_tag", "delete_page_tag"]) {
    assert.deepEqual([...allowedArguments(operation, "http-rest")].sort(), ["page_id", "tag"]);
    // Only the REST routes call them: neither /mcp nor /api/tools takes any argument.
    for (const transport of ["mcp", "http-tools"])
      assert.equal(allowedArguments(operation, transport).size, 0, `${operation} ${transport}`);
    assert.equal(API_ARGUMENTS[operation], undefined);
  }
  assert.deepEqual(Object.keys(REST_ARGUMENTS).sort(), ["delete_page_tag", "put_page_tag"]);
});

test("every /api/tools operation declares the arguments it takes", () => {
  const schemaless = Object.keys(API_ARGUMENTS).filter(
    (name) => !tools.some((tool) => tool.name === name),
  );
  assert.deepEqual(schemaless.sort(), ["page_cards", "reply_page_comment"]);
  for (const name of schemaless) assert.ok(allowedArguments(name, "http-tools").size > 0, name);
  // Over MCP an operation takes exactly its schema.
  for (const tool of tools)
    assert.deepEqual(
      [...allowedArguments(tool.name, "mcp", { credentialKind: "oidc" })].sort(),
      Object.keys(tool.inputSchema.properties ?? {}).sort(),
      tool.name,
    );
});
