import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { secretHash } from "@cloud/oidc-session-store.ts";
import worker, { Page, Catalog } from "./index.mjs";
import { createServerAppSession } from "@cloud/app-session.ts";
import { authenticate } from "./auth.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { applyPageOperation, createPageData, initializePage } from "../model/page.mjs";
import { comment, newCommentsDoc } from "../model/comments-test-support.mjs";
import { retryKey } from "../model/retry-key.mjs";
import {
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  revokeOAuthToken,
  rotateRefreshToken,
} from "./oauth-store.mjs";

const origin = "https://page7.example";
const resource = `${origin}/mcp`;
const pageId = "33333333-3333-4333-8333-333333333333";
const clientId = "https://chatgpt.com/oauth/client.json";
const person = {
  principal: "user:anaconda:person",
  namespace: "user:anaconda",
  displayName: "Example Person",
};
const environment = () => ({
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
  NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
  NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "oidc-client",
  NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda",
});
function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  return {
    prepare(sql) {
      const build = (values = []) => {
        const execute = () => ({
          success: true,
          meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) },
        });
        return {
          bind: (...next) => build(next),
          first: async () => sqlite.prepare(sql).get(...values) ?? null,
          all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values) }),
          run: async () => execute(),
          execute,
        };
      };
      return build();
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
async function fixture(
  t,
  scope = "pages:read pages:write offline_access",
  { identity = person, env: extraEnv = {} } = {},
) {
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("Pages OAuth must not send tokens to an external provider"),
  );
  const env = { ...environment(), DB: database(t), ...extraEnv };
  const verifier = "v".repeat(43);
  const { code } = await issueAuthorizationCode(env, {
    clientId,
    redirectUri: "https://chatgpt.com/connector_platform/oauth_redirect",
    resource,
    scope,
    codeChallenge: await secretHash(verifier),
    identity,
  });
  const tokens = await exchangeAuthorizationCode(env, {
    code,
    clientId,
    redirectUri: "https://chatgpt.com/connector_platform/oauth_redirect",
    resource,
    codeVerifier: verifier,
  });
  return { env, tokens };
}
function request(
  path = "/mcp",
  token,
  headers = {},
  method = "POST",
  body = { jsonrpc: "2.0", id: 1, method: "tools/list" },
) {
  return new Request(`http://127.0.0.1:9477${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token && { authorization: `Bearer ${token}` }),
      ...headers,
    },
    ...(!["GET", "HEAD"].includes(method) && { body: JSON.stringify(body) }),
  });
}
async function call(f, name, args = {}, headers = {}) {
  const response = await worker.fetch(
    request("/mcp", f.tokens.access_token, headers, "POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    f.env,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).result;
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

test("unauthenticated MCP discovers OAuth without Origin, DB, or provider traffic", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("discovery must remain local"));
  const env = environment();
  const response = await worker.fetch(request("/mcp", undefined, {}, "POST", initialize), env);
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("www-authenticate"),
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  for (const body of [initialize, { jsonrpc: "2.0", id: 1, method: "tools/list" }])
    for (const headers of [
      { Origin: "https://attacker.example" },
      { "Sec-Fetch-Site": "cross-site" },
    ]) {
      const rejected = await worker.fetch(request("/mcp", undefined, headers, "POST", body), env);
      assert.equal(rejected.status, 403);
      assert.equal(rejected.headers.get("www-authenticate"), null);
    }
});

/** A credential-free MCP POST that declares its body length, as HTTP clients do. */
function anonymous(body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`http://127.0.0.1:9477/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": String(new TextEncoder().encode(text).byteLength),
      ...headers,
    },
    body: text,
  });
}

test("tools/list and ping answer without a credential; other methods still challenge", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("tool discovery must remain local"));
  const env = environment();
  const listed = await worker.fetch(
    anonymous({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    env,
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  const names = (await listed.json()).result.tools.map((tool) => tool.name);
  for (const name of ["list_pages", "read_page", "patch_page", "delete_page", "restore_page"])
    assert.ok(names.includes(name), name);
  const pinged = await worker.fetch(anonymous({ jsonrpc: "2.0", id: 2, method: "ping" }), env);
  assert.equal(pinged.status, 200);
  const challenged = async (req, label) => {
    const response = await worker.fetch(req, env);
    assert.equal(response.status, 401, label);
    assert.ok(response.headers.get("www-authenticate"), label);
  };
  for (const body of [
    initialize,
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_pages", arguments: {} } },
    [{ jsonrpc: "2.0", id: 4, method: "tools/list" }],
    { jsonrpc: "2.0", id: 5, method: "resources/list" },
  ])
    await challenged(anonymous(body), JSON.stringify(body));
  const list = { jsonrpc: "2.0", id: 6, method: "tools/list" };
  // Without a declared length, or with a large one, the body is never read.
  await challenged(request(), "no Content-Length");
  await challenged(
    anonymous(JSON.stringify(list) + " ".repeat(5000)),
    "declared body over the anonymous limit",
  );
  // A body longer than its declaration stops at the limit.
  const padded = JSON.stringify(list) + " ".repeat(8000);
  await challenged(
    new Request(`http://127.0.0.1:9477/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "64" },
      body: padded,
    }),
    "body longer than declared",
  );
  // A presented credential that fails still gets the reconnect challenge.
  await challenged(request("/mcp", "pages_not-a-real-token"), "stale bearer");
  const withCookie = await worker.fetch(
    anonymous(list, { Origin: origin, Cookie: "nteract_session=expired" }),
    env,
  );
  assert.notEqual(withCookie.status, 200, "a cookie takes the authenticated path");
});

test("Pages-issued tokens authenticate MCP and each host-only forwarding hop locally", async (t) => {
  const f = await fixture(t);
  for (const path of [
    "/mcp",
    "/internal/catalog",
    "/internal/tool",
    "/internal/create",
    "/internal/trash",
    "/internal/restore",
    "/internal/purge",
  ]) {
    const identity = await authenticate(request(path, f.tokens.access_token), f.env);
    assert.equal(identity.principal, person.principal);
    assert.equal(identity.namespace, person.namespace);
    assert.equal(identity.driver, "ChatGPT");
    assert.equal(identity.credentialKind, "oauth");
    assert.equal(identity.canWrite, true);
    assert.ok(identity.expiresAt > Date.now());
  }
  await assert.rejects(
    authenticate(
      request("/mcp", f.tokens.access_token, { Origin: "https://attacker.example" }),
      f.env,
    ),
    { status: 403 },
  );
  const identities = [];
  const namespace = {
    getByName() {
      return {
        async fetch(forwarded) {
          const identity = await authenticate(forwarded, f.env);
          identities.push({
            identity,
            path: new URL(forwarded.url).pathname,
            driverHeader: forwarded.headers.get("x-pages-driver"),
          });
          const { operation } = await forwarded.json();
          return Response.json(
            operation === "list_pages"
              ? { pages: [] }
              : { page_id: pageId, title: "Example", blocks: [] },
          );
        },
      };
    },
  };
  f.env.CATALOGS = namespace;
  f.env.PAGES = namespace;
  await call(f, "list_pages");
  await call(f, "read_page", { page_id: pageId });
  assert.deepEqual(
    identities.map(({ path }) => path),
    ["/internal/catalog", "/internal/tool"],
  );
  assert.ok(
    identities.every(
      ({ identity, driverHeader }) => identity.driver === "ChatGPT" && driverHeader === null,
    ),
  );
  await call(
    f,
    "read_page",
    { page_id: pageId },
    { "X-Pages-Driver": "Dot demo", "x-principal": "user:admin", "x-scope": "admin" },
  );
  assert.equal(identities.at(-1).identity.driver, "Dot demo");
  assert.equal(identities.at(-1).identity.principal, person.principal);
  // An MCP session can't present itself as a person in the browser, on /mcp
  // or on the internal hop it forwards to.
  await call(f, "read_page", { page_id: pageId }, { "X-Pages-Driver": "Browser" });
  assert.equal(identities.at(-1).identity.driver, "API");
  assert.equal(
    (
      await authenticate(
        request("/mcp", f.tokens.access_token, { "X-Pages-Driver": " browser " }),
        f.env,
      )
    ).driver,
    "API",
  );
});

test("read-only OAuth scope rejects every mutating MCP tool before forwarding", async (t) => {
  const f = await fixture(t, "pages:read offline_access");
  f.env.CATALOGS = f.env.PAGES = {
    getByName() {
      assert.fail("read-only mutation reached a namespace");
    },
  };
  assert.equal((await authenticate(request("/mcp", f.tokens.access_token), f.env)).canWrite, false);
  for (const name of [
    "create_page",
    "edit_page",
    "patch_page",
    "manage_page_comment",
    "delete_page",
    "restore_page",
    "purge_page",
  ]) {
    const result = await call(f, name, { page_id: pageId, action: "preview" });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /read-only/, name);
    assert.deepEqual(result._meta, {
      "mcp/www_authenticate": [
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="Allow the requested Pages permissions to continue", scope="pages:read pages:write"`,
      ],
    });
  }
});

test("MCP grants cannot call direct APIs or reach internal routes through the gateway", async (t) => {
  const f = await fixture(t);
  f.env.CATALOGS = f.env.PAGES = {
    getByName() {
      assert.fail("MCP-only credential reached a non-MCP handler");
    },
  };
  const cases = [
    ["/api/tools", "POST", { operation: "list_pages", arguments: {} }],
    [`/api/access?page=${pageId}`, "GET"],
    [`/api/sync?page=${pageId}`, "GET"],
    [`/api/connect?page=${pageId}`, "GET"],
    ["/api/auth/session", "GET"],
  ];
  for (const [path, method, body] of cases) {
    const response = await worker.fetch(
      request(path, f.tokens.access_token, {}, method, body),
      f.env,
    );
    assert.equal(response.status, 403, path);
  }
  for (const path of [
    "/internal/tool",
    "/internal/catalog",
    "/internal/create",
    "/internal/trash",
    "/internal/restore",
    "/internal/purge",
  ]) {
    const response = await worker.fetch(request(path, f.tokens.access_token), f.env);
    assert.equal(response.status, 404, path);
  }
});

test("refresh and revocation apply immediately, and unknown Pages tokens never reach Anaconda", async (t) => {
  const f = await fixture(t);
  const refreshed = await rotateRefreshToken(f.env, {
    refreshToken: f.tokens.refresh_token,
    clientId,
    resource,
    scope: "pages:read offline_access",
  });
  assert.equal(
    (await authenticate(request("/mcp", refreshed.access_token), f.env)).canWrite,
    false,
  );
  await revokeOAuthToken(f.env, { token: refreshed.refresh_token, clientId });
  for (const token of [
    f.tokens.access_token,
    refreshed.access_token,
    `pages_at_${"x".repeat(43)}`,
    `pages_rt_${"x".repeat(43)}`,
    "pages_unknown",
  ]) {
    const response = await worker.fetch(request("/mcp", token), f.env);
    assert.equal(response.status, 401);
    assert.ok(response.headers.get("www-authenticate"));
  }
});

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) await this.put(name, entry);
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async sync() {}
  async list({ prefix = "" } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)));
  }
}

function readPageFixture(t, f, role) {
  const initial = A.from(createPageData({ pageId, title: "Private read fixture" }));
  const blockId = Object.keys(initial.blocks)[0];
  let threadId;
  const doc = A.change(initial, (draft) => {
    initializePage(draft, "## Selected section\n\nVisible selected passage.");
    applyPageOperation(draft, {
      operation: "edit_page",
      arguments: {
        operations: [
          {
            op: "insert_markdown",
            after_block_id: blockId,
            markdown: "Unselected body sentinel.",
          },
        ],
      },
    });
  });
  const commented = comment(
    doc,
    newCommentsDoc(),
    { block_id: blockId, body: "Private comment sentinel." },
    { ...person, driver: "Browser" },
  );
  threadId = commented.result.thread_id;
  t.after(() => A.free(doc));
  const storage = new Storage();
  const page = Object.assign(Object.create(Page.prototype), {
    env: f.env,
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    ctx: { storage },
    metadata: {
      pageId,
      owner: role === "owner" ? person.principal : "user:anaconda:owner",
      deleted: false,
      acl: {
        revision: 1,
        members:
          role === "owner"
            ? {}
            : { [person.principal]: { role, generation: 1, changedAtRevision: 1 } },
        invites: {},
      },
    },
    handle: { doc: () => doc },
    commentsHandle: { doc: () => commented.comments },
    cacheTitle() {},
  });
  page.policy = new DocumentPolicy({ storage, metadata: () => page.metadata });
  f.env.PAGES = {
    getByName(id) {
      assert.equal(id, pageId);
      return page;
    },
  };
  return { page, doc, blockId, threadId };
}

for (const scope of ["pages:read pages:write offline_access", "pages:read offline_access"]) {
  for (const role of ["owner", "editor", "viewer"]) {
    test(`selective and comment reads enforce current ${role} access with ${scope}`, async (t) => {
      const f = await fixture(t, scope);
      const { page, doc, blockId, threadId } = readPageFixture(t, f, role);
      const heads = A.getHeads(doc);
      let authority;
      for (const [name, args, check] of [
        [
          "read_page",
          { block_ids: [blockId], comments: "none" },
          (body) => {
            assert.deepEqual(
              body.blocks.map((block) => block.id),
              [blockId],
            );
            assert.match(body.blocks[0].markdown, /Visible selected passage/);
            assert.doesNotMatch(
              JSON.stringify(body),
              /Unselected body sentinel|Private comment sentinel/,
            );
          },
        ],
        [
          "read_page",
          { include_content: false, comments: "none" },
          (body) => {
            assert.ok(Array.isArray(body.outline.entries));
            assert.match(JSON.stringify(body.outline.entries), /Selected section/);
            assert.doesNotMatch(
              JSON.stringify(body),
              /Visible selected passage|Unselected body sentinel|Private comment sentinel/,
            );
          },
        ],
        [
          "list_page_comments",
          { thread_ids: [threadId], include_messages: false },
          (body) => {
            assert.deepEqual(
              body.comments.map((thread) => thread.id),
              [threadId],
            );
            assert.equal(body.comments[0].block_id, blockId);
            assert.equal(body.comments[0].messages, undefined);
            assert.doesNotMatch(
              JSON.stringify(body),
              /Private comment sentinel|Visible selected passage/,
            );
          },
        ],
      ]) {
        const result = await call(f, name, { page_id: pageId, ...args });
        assert.equal(result.isError, undefined, result.content[0].text);
        const body = JSON.parse(result.content[0].text);
        authority = body;
        check(body);
        assert.deepEqual(body.heads, heads);
        assert.ok(body.retry_token);
        assert.deepEqual(A.getHeads(doc), heads, "read operations do not edit the document");
      }

      if (!scope.includes("pages:write") || role === "viewer") {
        const denied = await call(f, "edit_page", {
          page_id: pageId,
          base_heads: authority.heads,
          retry_token: authority.retry_token,
          idempotency_key: await retryKey(authority.retry_token, "read-token-denied-write"),
          operations: [{ op: "set_title", title: "Must not write" }],
        });
        assert.equal(denied.isError, true);
        assert.match(denied.content[0].text, /read-only/);
        assert.deepEqual(A.getHeads(doc), heads, "retry authority cannot grant Page write access");
        if (scope.includes("pages:write")) assert.equal(denied._meta, undefined);
      }

      // An existing grant or retry token cannot outlive the Page's current ACL.
      page.metadata.owner = "user:anaconda:other-owner";
      page.metadata.acl.members[person.principal] = {
        role: "none",
        generation: 2,
        changedAtRevision: 2,
      };
      page.metadata.acl.revision = 2;
      for (const name of ["read_page", "list_page_comments"]) {
        const result = await call(f, name, { page_id: pageId });
        assert.equal(result.isError, true);
        const denial = { error: "Document access denied", code: "access_denied" };
        assert.deepEqual(JSON.parse(result.content[0].text), denial);
        assert.deepEqual(result.structuredContent, denial);
        assert.equal(result._meta, undefined, "ACL denial cannot be repaired by scope escalation");
      }
    });
  }
}

test("a live Page ACL downgrade and revocation override an existing OAuth write grant", async (t) => {
  const f = await fixture(t);
  const doc = A.from(createPageData({ pageId, title: "ACL fixture" }));
  t.after(() => A.free(doc));
  const storage = new Storage();
  const page = Object.assign(Object.create(Page.prototype), {
    env: f.env,
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    ctx: { storage },
    metadata: {
      pageId,
      owner: "user:anaconda:owner",
      deleted: false,
      acl: {
        revision: 1,
        members: { [person.principal]: { role: "editor", generation: 1, changedAtRevision: 1 } },
        invites: {},
      },
    },
    handle: { doc: () => doc },
    commentsHandle: { doc: () => commented.comments },
    cacheTitle() {},
  });
  page.policy = new DocumentPolicy({ storage, metadata: () => page.metadata });
  f.env.PAGES = {
    getByName(id) {
      assert.equal(id, pageId);
      return page;
    },
  };
  const first = await call(f, "read_page", { page_id: pageId });
  assert.equal(first.isError, undefined);
  assert.equal(JSON.parse(first.content[0].text).title, "ACL fixture");
  page.metadata.acl.members[person.principal] = {
    role: "viewer",
    generation: 2,
    changedAtRevision: 2,
  };
  page.metadata.acl.revision = 2;
  const deniedWrite = await call(f, "edit_page", {
    page_id: pageId,
    operations: [{ op: "set_title", title: "No" }],
  });
  assert.equal(deniedWrite.isError, true);
  assert.match(deniedWrite.content[0].text, /Page is read-only/);
  assert.equal(deniedWrite._meta, undefined, "OAuth scope cannot override a Page ACL");
  assert.equal(
    (await authenticate(request("/mcp", f.tokens.access_token), f.env)).canWrite,
    true,
    "credential scope remains distinct from current Page permission",
  );
  page.metadata.acl.members[person.principal] = {
    role: "none",
    generation: 3,
    changedAtRevision: 3,
  };
  page.metadata.acl.revision = 3;
  const deniedRead = await call(f, "read_page", { page_id: pageId });
  assert.equal(deniedRead.isError, true);
  assert.match(deniedRead.content[0].text, /Document access denied/);
  assert.equal(deniedRead._meta, undefined, "revoked sharing must not prompt scope escalation");
});

test("OAuth domain viewing rechecks company policy, explicit denial, and proof expiry across Page and catalog reads", async (t) => {
  let clock = Math.floor(Date.now() / 1000) * 1000;
  t.mock.method(Date, "now", () => clock);
  const companyEnv = {
    ...environment(),
    PAGES_COMPANY_VIEW_DOMAINS: "anaconda.com",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "domain-oauth-test-secret-".repeat(2),
  };
  const verifiedAt = clock / 1000 - 6 * 3600 + 5;
  const session = await createServerAppSession(
    companyEnv,
    {
      principal: person.principal,
      metadata: {
        provider: "oidc",
        principalNamespace: person.namespace,
        email: "employee@anaconda.com",
        emailVerified: true,
      },
    },
    "domain-session",
    clock / 1000 + 600,
    verifiedAt,
  );
  const f = await fixture(t, undefined, {
    env: companyEnv,
    identity: { ...person, emailProof: { ...session, provider: "app-session" } },
  });
  const document = A.from(createPageData({ pageId, title: "Company-only Page" }));
  t.after(() => A.free(document));
  const jobs = [],
    catalogues = new Map(),
    storage = new Storage();
  f.env.CATALOGS = {
    getByName(principal) {
      if (!catalogues.has(principal))
        catalogues.set(
          principal,
          new Catalog({ id: { name: principal }, storage: new Storage() }, f.env),
        );
      return catalogues.get(principal);
    },
  };
  const page = Object.assign(Object.create(Page.prototype), {
    env: f.env,
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    ctx: { storage, waitUntil: (promise) => jobs.push(promise) },
    metadata: {
      pageId,
      owner: "user:anaconda:other",
      deleted: false,
      acl: {
        revision: 1,
        members: {},
        invites: {},
        domainView: { domain: "anaconda.com", namespace: person.namespace },
      },
    },
    handle: { doc: () => document },
  });
  page.policy = new DocumentPolicy({ storage, metadata: () => page.metadata });
  f.env.PAGES = {
    getByName() {
      return page;
    },
  };
  const reader = await authenticate(request("/mcp", f.tokens.access_token), f.env);
  assert.equal(reader.domainAccess.expiresAt, clock + 5000);
  const read = await call(f, "read_page", { page_id: pageId });
  assert.equal(read.isError, undefined);
  await Promise.all(jobs);
  assert.deepEqual(
    page.metadata.acl.members,
    {},
    "domain access never becomes permanent membership",
  );
  const listed = await call(f, "list_pages");
  assert.equal(JSON.parse(listed.content[0].text).pages[0].page_id, pageId);
  const write = await call(f, "edit_page", {
    page_id: pageId,
    operations: [{ op: "set_title", title: "Denied" }],
  });
  assert.equal(write.isError, true);
  assert.match(write.content[0].text, /Page is read-only/);
  assert.equal(write._meta, undefined);
  f.env.PAGES_COMPANY_VIEW_DOMAINS = "";
  assert.equal((await call(f, "read_page", { page_id: pageId })).isError, true);
  assert.deepEqual(JSON.parse((await call(f, "list_pages")).content[0].text).pages, []);
  f.env.PAGES_COMPANY_VIEW_DOMAINS = "anaconda.com";
  assert.equal((await call(f, "read_page", { page_id: pageId })).isError, undefined);
  await Promise.all(jobs);
  page.metadata.acl.members[person.principal] = { role: "none", generation: 1 };
  assert.equal((await call(f, "read_page", { page_id: pageId })).isError, true);
  assert.deepEqual(JSON.parse((await call(f, "list_pages")).content[0].text).pages, []);
  page.metadata.acl.members = {};
  clock += 5000;
  f.tokens = await rotateRefreshToken(f.env, {
    refreshToken: f.tokens.refresh_token,
    clientId,
    resource,
  });
  const refreshed = await authenticate(request("/mcp", f.tokens.access_token), f.env);
  assert.equal(refreshed.emailProof.identityVerifiedAt, verifiedAt);
  assert.equal(
    refreshed.domainAccess,
    undefined,
    "OAuth refresh cannot renew company identity proof",
  );
  assert.equal((await call(f, "read_page", { page_id: pageId })).isError, true);
});

test("OAuth MCP clients trash, restore, preview and confirm permanent deletion", async (t) => {
  const f = await fixture(t);
  const doc = A.change(A.from(createPageData({ pageId, title: "OAuth lifecycle" })), (draft) =>
    initializePage(draft, "Kept through Trash."),
  );
  t.after(() => A.free(doc));
  const pageStorage = new Storage();
  const catalogStorage = new Storage();
  let removed = 0;
  const page = Object.assign(Object.create(Page.prototype), {
    env: f.env,
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    ctx: { storage: pageStorage, waitUntil() {} },
    metadata: { pageId, owner: person.principal, documentId: "doc", deleted: false },
    handle: { doc: () => doc, broadcast() {} },
    wires: new Set(),
    repo: {
      async delete() {
        removed++;
      },
    },
    backend: { async flush() {} },
  });
  page.policy = new DocumentPolicy({ storage: pageStorage, metadata: () => page.metadata });
  const catalog = new Catalog({ id: { name: person.principal }, storage: catalogStorage }, f.env);
  await catalogStorage.put(`page/${pageId}`, { page_id: pageId, title: "OAuth lifecycle" });
  f.env.CATALOGS = { getByName: () => ({ fetch: (request) => catalog.fetch(request) }) };
  f.env.PAGES = { getByName: () => ({ fetch: (request) => page.fetch(request) }) };
  const parsed = async (name, args) => {
    const result = await call(f, name, args);
    assert.equal(result.isError, undefined, `${name}: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text);
  };
  const authority = async () => {
    const listed = await parsed("list_pages");
    return {
      retry_token: listed.retry_token,
      idempotency_key: listed.retry_key_prefix + crypto.randomUUID(),
    };
  };
  const trashed = await parsed("delete_page", {
    page_id: pageId,
    base_heads: A.getHeads(doc),
    ...(await authority()),
  });
  assert.equal(trashed.state, "trashed");
  assert.equal((await parsed("list_pages", { in_trash: true })).pages.length, 1);
  const restored = await parsed("restore_page", { page_id: pageId, ...(await authority()) });
  assert.equal(restored.restored, true);
  await parsed("delete_page", {
    page_id: pageId,
    base_heads: A.getHeads(doc),
    ...(await authority()),
  });
  const preview = await parsed("purge_page", { page_id: pageId, action: "preview" });
  assert.equal(preview.title, "OAuth lifecycle");
  const purged = await parsed("purge_page", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.preview_token,
    ...(await authority()),
  });
  assert.deepEqual(purged, { page_id: pageId, deleted: true, purged: true });
  assert.equal(removed, 1);
});
