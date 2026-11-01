import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import worker from "./index.mjs";
import { catalogIndexTimeouts } from "./catalog-index.mjs";
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

test("a tool request whose host never answers times out with advice that fits the request", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  let reached;
  const silent = {
    getByName: () => ({
      fetch() {
        reached();
        return new Promise(() => {});
      },
    }),
  };
  const env = {
    ...auth.env,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: publicOrigin,
    CATALOGS: silent,
    PAGES: silent,
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const headers = {
    Authorization: `Bearer ${auth.apiKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const http = async (operation, args) => {
    const called = new Promise((resolve) => {
      reached = resolve;
    });
    const pending = worker.fetch(
      new Request("http://127.0.0.1:9477/api/tools", {
        method: "POST",
        headers,
        body: JSON.stringify({ operation, arguments: args }),
      }),
      env,
    );
    await called;
    t.mock.timers.tick(TOOL_REQUEST_TIMEOUT_MS);
    const response = await pending;
    assert.equal(response.status, 504, operation);
    return response.json();
  };
  const mcp = async (name, args) => {
    const called = new Promise((resolve) => {
      reached = resolve;
    });
    const pending = worker.fetch(
      new Request("http://127.0.0.1:9477/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      env,
    );
    await called;
    t.mock.timers.tick(TOOL_REQUEST_TIMEOUT_MS);
    const result = (await (await pending).json()).result;
    assert.equal(result.isError, true, name);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, name);
    return result.structuredContent;
  };
  const tokened = {
    page_id: pageId,
    retry_token: "token",
    idempotency_key: `v1_${"a".repeat(64)}_timeout-fixture`,
    base_heads: ["b".repeat(64)],
    operations: [],
  };
  const tokenless = { ...tokened, retry_token: undefined, idempotency_key: "timeout-fixture" };
  for (const call of [http, mcp]) {
    // A tokenless write's receipt is kept best-effort, so a blind retry after
    // the host finished the work could apply it twice.
    const plain = await call("patch_page", tokenless);
    assert.equal(plain.code, "request_timeout");
    assert.equal(plain.retryable, false);
    assert.match(plain.error, /may still have completed. Read back and reconcile before retrying/);
    assert.doesNotMatch(plain.error, /retry the same request/);
    const comment = await call("manage_page_comment", {
      page_id: pageId,
      idempotency_key: "timeout-comment",
      action: "add",
      block_id: "b1",
      body: "Hi",
    });
    assert.equal(comment.retryable, false);
    // A tokened write replays its receipt; a read has nothing to repeat.
    const keyed = await call("patch_page", tokened);
    assert.equal(keyed.code, "request_timeout");
    assert.equal(keyed.retryable, true);
    assert.match(keyed.error, /same idempotency_key and retry_token/);
    const read = await call("read_page", { page_id: pageId });
    assert.equal(read.code, "request_timeout");
    assert.equal(read.retryable, true);
    const created = await call("create_page", { title: "T", idempotency_key: "timeout-create" });
    assert.equal(created.retryable, false, "a tokenless create_page could make a second Page");
    // A progress creation mints ids, so a repeat would start a second session;
    // a renewal or clear names its session and is safe.
    const creating = await call("report_page_progress", { page_id: pageId, message: "Working" });
    assert.equal(creating.code, "request_timeout");
    assert.equal(creating.retryable, false);
    assert.match(creating.error, /do not loop creating sessions/);
    assert.match(creating.error, /progress_id and lease_token, retry that session/);
    const renewing = await call("report_page_progress", {
      page_id: pageId,
      progress_id: "11111111-1111-4111-8111-111111111111",
      lease_token: "lease",
    });
    assert.equal(renewing.retryable, true);
    assert.match(renewing.error, /retry the same request/);
  }
});

test("a registration whose Catalog never answers returns a retryable timeout", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  let reached;
  const called = new Promise((resolve) => {
    reached = resolve;
  });
  let signal;
  const env = {
    ...auth.env,
    CATALOGS: {
      getByName: () => ({
        fetch(request, init) {
          signal = init?.signal;
          reached();
          return new Promise(() => {});
        },
      }),
    },
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = worker.fetch(
    new Request("http://127.0.0.1:9477/api/pages/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.apiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ page_id: pageId }),
    }),
    env,
  );
  await called;
  t.mock.timers.tick(TOOL_REQUEST_TIMEOUT_MS);
  const response = await pending;
  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.code, "request_timeout");
  assert.equal(body.retryable, true);
  assert.equal(signal?.aborted, true, "the Catalog fetch is cancelled");
});

const parentId = "44444444-4444-4444-8444-444444444444";
const spaceId = "55555555-5555-4555-8555-555555555555";

/** A body that sends `prefix` and then stalls; `state.cancelled` records a
 * reader cancelling it. */
function stalledBody(prefix, state) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

const owner = "user:anaconda-fixture:owner-user";
/** A read_page result naming the owner whose Catalog records its location. */
const placedPage = () => JSON.stringify({ page_id: pageId, title: "Placed", _owner: owner });
/** The owner's Catalog: the Page sits under `parentId` in Project `spaceId`. */
const ownerCatalog = (seen = []) =>
  answer(async (name, request) => {
    seen.push({
      name,
      path: new URL(request.url).pathname,
      credential: request.headers.has("authorization") || request.headers.has("cookie"),
      body: await request.json(),
    });
    return Response.json({
      page_id: pageId,
      state: "active",
      parent_id: parentId,
      ancestors: [parentId],
      complete: true,
      space_id: spaceId,
      home: false,
    });
  });

function readPage(auth, env) {
  return worker.fetch(
    new Request("http://127.0.0.1:9477/api/tools", {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.apiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "read_page", arguments: { page_id: pageId } }),
    }),
    env,
  );
}

const answer = (fetch) => ({ getByName: (name) => ({ fetch: (request) => fetch(name, request) }) });

test("a stalled read_page body times out and cancels its reader", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const stalled = {};
  let reached;
  const called = new Promise((resolve) => {
    reached = resolve;
  });
  const env = {
    ...auth.env,
    PAGES: answer(() => {
      reached();
      return new Response(stalledBody('{"page_id":', stalled));
    }),
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = readPage(auth, env);
  await called;
  t.mock.timers.tick(TOOL_REQUEST_TIMEOUT_MS);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, "request_timeout");
  assert.equal(stalled.cancelled, true, "the Page body reader is cancelled");
});

test("stalled breadcrumb and Project bodies end their reads and keep the location private", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  const verify = catalogIndexTimeouts.verify;
  catalogIndexTimeouts.verify = 50;
  t.after(() => {
    catalogIndexTimeouts.verify = verify;
  });
  const parent = {};
  const space = {};
  const seen = [];
  const env = {
    ...auth.env,
    PAGES: answer((name) =>
      name === pageId ? new Response(placedPage()) : new Response(stalledBody('{"title":', parent)),
    ),
    PROJECTS: answer(() => new Response(stalledBody('{"space_id":', space))),
    CATALOGS: ownerCatalog(seen),
  };
  const response = await readPage(auth, env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body._owner, undefined);
  // One host request to the owner's Catalog, without the caller's credential.
  assert.deepEqual(seen, [
    { name: owner, path: "/internal/location", credential: false, body: { page_id: pageId } },
  ]);
  assert.deepEqual(body.breadcrumbs, []);
  assert.equal(body.space_id, undefined, "an unreadable Space stays hidden");
  assert.equal(body.parent_id, undefined, "an unreadable parent stays hidden");
  assert.equal(JSON.stringify(body).includes(spaceId), false);
  assert.equal(JSON.stringify(body).includes(parentId), false);
  assert.equal(parent.cancelled, true);
  assert.equal(space.cancelled, true);
});

test("a location view that outlasts the tool deadline returns 504, not the raw location", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const verify = catalogIndexTimeouts.verify;
  catalogIndexTimeouts.verify = TOOL_REQUEST_TIMEOUT_MS * 2;
  t.after(() => {
    catalogIndexTimeouts.verify = verify;
  });
  let reached;
  const walking = new Promise((resolve) => {
    reached = resolve;
  });
  const env = {
    ...auth.env,
    PAGES: answer((name) => {
      if (name === pageId) return new Response(placedPage());
      // The parent answers slowly: later than the whole request may take.
      reached();
      return new Promise(() => {});
    }),
    CATALOGS: ownerCatalog(),
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = readPage(auth, env);
  await walking;
  t.mock.timers.tick(TOOL_REQUEST_TIMEOUT_MS);
  const response = await pending;
  assert.equal(response.status, 504);
  const text = await response.text();
  assert.match(text, /request_timeout/);
  assert.equal(text.includes(spaceId), false);
  assert.equal(text.includes(parentId), false);
  assert.equal(text.includes("Placed"), false);
});
