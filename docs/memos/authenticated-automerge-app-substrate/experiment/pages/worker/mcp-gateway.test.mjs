import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import worker from "./index.mjs";
import { TOOL_REQUEST_TIMEOUT_MS } from "./tool-deadline.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const publicOrigin = "https://page7.runtimed.run";
const pageUrl = `${publicOrigin}/p/${pageId}`;

test("MCP gateway returns its normal error response when public origin is missing", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const env = { ...auth.env };
  delete env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN;
  const response = await worker.fetch(
    new Request("http://127.0.0.1:9477/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.apiKey()}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env,
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Pages request failed" });
});

test("MCP gateway passes the configured public origin through a private HTTP tunnel", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const calls = [];
  const namespace = {
    getByName() {
      return {
        async fetch(request) {
          const { operation, arguments: args } = await request.json();
          calls.push({ operation, args });
          return Response.json(
            operation === "list_pages"
              ? { pages: [{ page_id: pageId, title: "Public link" }] }
              : { page_id: pageId, title: "Public link", blocks: [] },
          );
        },
      };
    },
  };
  const env = {
    ...auth.env,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: publicOrigin,
    CATALOGS: namespace,
    PAGES: namespace,
  };
  const rpc = async (method, params = {}) => {
    const response = await worker.fetch(
      new Request("http://127.0.0.1:9477/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.apiKey()}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Host: "untrusted.example",
          "X-Forwarded-Host": "also-untrusted.example",
          "X-Forwarded-Proto": "http",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
      env,
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  for (const name of ["list_pages", "create_page", "read_page"]) {
    const result = await rpc("tools/call", { name, arguments: { page_id: pageId } });
    assert.equal(result.result.isError, undefined);
    const body = JSON.parse(result.result.content[0].text);
    assert.equal((body.pages?.[0] ?? body).url, pageUrl);
  }
  const resources = await rpc("resources/list");
  assert.equal(resources.result.resources[0].uri, pageUrl);
  const resource = await rpc("resources/read", { uri: pageUrl });
  assert.equal(resource.result.contents[0].uri, pageUrl);
  assert.equal(JSON.parse(resource.result.contents[0].text).page_id, pageId);
  assert.deepEqual(
    calls.map(({ operation }) => operation),
    ["list_pages", "create_page", "read_page", "list_pages", "read_page"],
  );
});

test("a tool request whose host never answers returns a retryable timeout", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  let reached;
  const called = new Promise((resolve) => {
    reached = resolve;
  });
  const silent = {
    getByName: () => ({
      fetch() {
        reached();
        return new Promise(() => {});
      },
    }),
  };
  const env = { ...auth.env, CATALOGS: silent, PAGES: silent };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const call = (operation, args) =>
    worker.fetch(
      new Request("http://127.0.0.1:9477/api/tools", {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.apiKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ operation, arguments: args }),
      }),
      env,
    );
  const pending = call("patch_page", { page_id: pageId, idempotency_key: "timeout-fixture" });
  await called;
  t.mock.timers.tick(TOOL_REQUEST_TIMEOUT_MS);
  const response = await pending;
  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.code, "request_timeout");
  assert.equal(body.retryable, true);
  assert.match(body.error, /same idempotency_key/);
});
