import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { secretHash } from "@cloud/oidc-session-store.ts";
import worker, { Page, Catalog } from "./index.mjs";
import { createServerAppSession } from "@cloud/app-session.ts";
import { authenticate } from "./auth.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { createPageData } from "../model/page.mjs";
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

test("unauthenticated MCP discovers OAuth without Origin, DB, or provider traffic", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("discovery must remain local"));
  const env = environment();
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("www-authenticate"),
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  for (const headers of [
    { Origin: "https://attacker.example" },
    { "Sec-Fetch-Site": "cross-site" },
  ]) {
    const rejected = await worker.fetch(request("/mcp", undefined, headers), env);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("www-authenticate"), null);
  }
});

test("Pages-issued tokens authenticate MCP and each host-only forwarding hop locally", async (t) => {
  const f = await fixture(t);
  for (const path of [
    "/mcp",
    "/internal/catalog",
    "/internal/tool",
    "/internal/create",
    "/internal/delete",
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
  ]) {
    const result = await call(f, name, { page_id: pageId });
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
    "/internal/delete",
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
