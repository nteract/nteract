import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { MEMBER_FORMATS } from "../model/document-types.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { startLocalKiloHandoff } from "../scripts/fixtures/local-kilo-handoff.mjs";
import { authenticate } from "./auth.mjs";
import worker, { Page } from "./index.mjs";
import { kiloIdentity, kiloSignIn } from "./kilo-config.mjs";
import { exchangeKiloToken, KILO_EXCHANGE_PATH } from "./kilo-exchange.mjs";
import { kiloToken, MAX_KILO_TOKEN_LENGTH, unverifiedClaims } from "./kilo-token.mjs";
import { receiptKey } from "./operation-journal.mjs";
import { plainStub } from "./plain-stub.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";

const origin = "https://pages.invalid";
const audience = "pages-test";
const secret = "kilo-exchange-fixture-secret-0123456789";
const pageId = "33333333-3333-4333-8333-333333333333";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
// Unique per test: the lease outlives a test, and a token is its key.
let people = 0;
const person = () => ({ id: `person:${++people}`, name: "Example Person" });
// A distinct token for one holder: an earlier iat, a lifetime still in bounds.
let minted = 0;
const unique = () => ({ iat: Math.floor(Date.now() / 1000) - (++minted % 500) });

/** A Kilo deployment beside a fake Kilo. Every outbound request is recorded
 * and every console line is captured. */
async function fixture(t, extra = {}) {
  const kilo = await startLocalKiloHandoff({ deployments: { [audience]: origin }, secret });
  const env = {
    DB: sqliteD1(t).open(),
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    PAGES_KILO_APP_URL: kilo.origin,
    PAGES_KILO_AUDIENCE: audience,
    PAGES_KILO_EXCHANGE_SECRET: secret,
    ...extra,
  };
  const outbound = [];
  const send = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    outbound.push(String(input?.url ?? input));
    return send(input, init);
  });
  const lines = [];
  for (const method of ["info", "warn", "error", "log"])
    t.mock.method(console, method, (...args) =>
      lines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      ),
    );
  t.after(() => kilo.close());
  return { env, kilo, outbound, lines };
}

const request = (token, { path = "/mcp", method = "POST", headers = {} } = {}) =>
  new Request(`${origin}${path}`, {
    method,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...headers },
  });
const toolCall = (token, operation, args = {}) =>
  new Request(`${origin}/api/tools`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation, arguments: args }),
  });

test("a Kilo-shaped bearer's claims are read without trusting it, and never throw", () => {
  const claims = { aud: audience, tokenPurpose: "delegated-workload", exp: 1 };
  assert.deepEqual(unverifiedClaims(`${encode({ alg: "HS256" })}.${encode(claims)}.sig`), claims);
  for (const token of [
    "kilo-cli-token",
    "a.b.c",
    "a.!!!.c",
    "a..c",
    "a.b.c.d",
    `x.${Buffer.from("not json").toString("base64url")}.y`,
    `x.${encode([claims])}.y`,
    `x.${encode("text")}.y`,
    `x.${Buffer.from([0xff, 0xfe]).toString("base64url")}.y`,
    `x.${encode({ ...claims, pad: "p".repeat(MAX_KILO_TOKEN_LENGTH) })}.y`,
    undefined,
  ])
    assert.equal(unverifiedClaims(token), null, String(token).slice(0, 40));
});

test("only a token for this deployment's audience and purpose goes to Kilo", async (t) => {
  const { env, kilo, outbound } = await fixture(t);
  const holder = person();
  const mine = kilo.mintToken(holder, { audience });
  assert.ok(kiloToken(env, request(mine), mine));
  // A deployment without Kilo sign-in reads no claims at all.
  assert.equal(kiloToken({ ...env, PAGES_KILO_APP_URL: undefined }, request(mine), mine), null);
  for (const token of [
    kilo.mintToken(holder, { audience: "pages-other" }),
    kilo.mintToken(holder, { audience, claims: { tokenPurpose: "credential-exchange" } }),
    kilo.mintToken(holder, { audience, claims: { tokenPurpose: undefined } }),
    kilo.mintToken(holder, { audience, claims: { aud: [audience] } }),
    `${kilo.mintToken(holder, { audience })}${"x".repeat(MAX_KILO_TOKEN_LENGTH)}`,
  ]) {
    assert.equal(kiloToken(env, request(token), token), null);
    // Refused as any other bearer on this deployment is, with no outbound call.
    await assert.rejects(authenticate(request(token), env), {
      status: 401,
      code: "api_keys_unsupported",
    });
  }
  // Malformed bearers are a 401, never a 500.
  for (const token of [
    "a.!!!.c",
    `x.${Buffer.from("{").toString("base64url")}.y`,
    "z".repeat(5000),
  ])
    await assert.rejects(authenticate(request(token), env), { status: 401 });
  // The prefixes Pages issues keep their own branches.
  await assert.rejects(authenticate(request("pu1.capability"), env), {
    status: 401,
    code: "upload_capability_invalid",
  });
  await assert.rejects(authenticate(request("pages_not-a-grant", { path: "/api/tools" }), env), {
    status: 403,
  });
  assert.deepEqual(outbound, []);
  assert.deepEqual(kilo.exchanges(), []);
});

test("on a deployment without Kilo sign-in a Kilo token is an API key, as before", async (t) => {
  const auth = await createAuthFixture();
  const outbound = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    outbound.push(String(url));
    return Response.json({}, { status: 401 });
  });
  const kilo = await startLocalKiloHandoff({ deployments: { [audience]: origin }, secret });
  t.after(() => kilo.close());
  const token = kilo.mintToken(person(), { audience });
  const env = { ...auth.env, PAGES_KILO_AUDIENCE: audience, PAGES_KILO_EXCHANGE_SECRET: secret };
  await assert.rejects(authenticate(request(token), env), {
    status: 401,
    code: "invalid_api_key",
  });
  // Only the account service that verifies API keys was asked.
  assert.deepEqual(outbound, [env.NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL]);
  assert.deepEqual(kilo.exchanges(), []);
});

test("the exchange sends exactly the token and audience, with the deployment's secret", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ user: { id: "person:1", name: " Example " }, organizations: [] });
  };
  const account = await exchangeKiloToken(fetcher, {
    appUrl: "https://kilo.invalid",
    secret,
    token: "header.payload.signature",
    audience,
  });
  assert.deepEqual(account, { id: "person:1", name: "Example", organizations: [] });
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, `https://kilo.invalid${KILO_EXCHANGE_PATH}`);
  assert.equal(url, "https://kilo.invalid/api/pages-auth/exchange");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    accept: "application/json",
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
  });
  assert.equal(init.body, JSON.stringify({ token: "header.payload.signature", audience }));
  assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ["audience", "token"]);
  assert.equal(init.redirect, "manual");
  assert.ok(init.signal instanceof AbortSignal);
  const answer = (status, body) =>
    exchangeKiloToken(async () => Response.json(body, { status }), {
      appUrl: "https://kilo.invalid",
      secret,
      token: "t.t.t",
      audience,
    });
  assert.deepEqual(await answer(400, { error: "invalid_token" }), { refused: "token" });
  assert.deepEqual(await answer(403, { error: "account_unavailable" }), { refused: "account" });
  assert.deepEqual(await answer(401, { error: "invalid_client" }), { refused: "client" });
  assert.deepEqual(await answer(401, {}), { refused: "client" });
  for (const [status, body] of [
    [400, { error: "invalid_request" }],
    [400, {}],
    [403, { error: "forbidden" }],
    [403, {}],
    [404, { error: "invalid_token" }],
    [408, {}],
    [410, { error: "invalid_token" }],
  ])
    await assert.rejects(answer(status, body), /Kilo/, `${status} ${JSON.stringify(body)}`);
});

test("a Kilo that doesn't answer in time is a 503, and the token is asked about again", async (t) => {
  const { env, kilo } = await fixture(t);
  // The exchange's timeout is a signal the test fires itself, once Kilo holds
  // the request without answering. No wall-clock timer decides the order.
  const timeouts = [];
  const asked = t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 10_000, "the code flow's timeout");
    const timeout = new AbortController();
    timeouts.push(timeout);
    return timeout.signal;
  });
  const token = kilo.mintToken(person(), { audience });
  let hung;
  kilo.respond((req, res) => {
    hung = res;
    timeouts.at(-1).abort(new DOMException("The operation timed out.", "TimeoutError"));
  });
  await assert.rejects(authenticate(request(token), env), {
    status: 503,
    code: "sign_in_unavailable",
    retryable: true,
  });
  assert.equal(asked.mock.callCount(), 1);
  hung?.destroy();
  assert.equal((await authenticate(request(token), env)).credentialKind, "kilo-token");
  assert.equal(kilo.exchanges().length, 2);
});

test("a token names the person the browser sign-in names", async (t) => {
  const { env, kilo, outbound } = await fixture(t, {
    PAGES_KILO_PRINCIPAL_NAMESPACE: "user:kilo-test",
  });
  const holder = person();
  const token = kilo.mintToken(holder, { audience });
  const identity = await authenticate(
    request(token, { headers: { "x-pages-driver": "Browser" } }),
    env,
  );
  const browser = kiloIdentity(kiloSignIn(env, request(token)), holder);
  assert.equal(identity.principal, browser.principal);
  assert.equal(identity.principal, `user:kilo-test:${encodeURIComponent(holder.id)}`);
  assert.equal(identity.namespace, browser.metadata.principalNamespace);
  assert.equal(identity.displayName, holder.name);
  assert.equal(identity.accountDisplayName, holder.name);
  assert.equal(identity.credentialKind, "kilo-token");
  assert.equal(identity.canWrite, true);
  // A bearer is a client acting for the account, never the browser.
  assert.equal(identity.driver, "API");
  assert.ok(identity.expiresAt > Date.now() && identity.expiresAt <= Date.now() + 300_000);
  assert.deepEqual(kilo.exchanges(), [
    { authorization: `Bearer ${secret}`, fields: ["audience", "token"], audience, token },
  ]);
  assert.deepEqual(outbound, [`${kilo.origin}/api/pages-auth/exchange`]);
});

test("a token reaches the tool routes and nothing else, and is refused before Kilo is asked", async (t) => {
  const { env, kilo } = await fixture(t);
  const token = kilo.mintToken(person(), { audience });
  for (const [path, method] of [
    ["/api/connect", "GET"],
    ["/api/sync", "GET"],
    ["/api/saved", "POST"],
    ["/api/access", "GET"],
    ["/api/pages/register", "POST"],
    ["/api/auth/session", "GET"],
    [`/api/pages/${pageId}/assets/abc`, "GET"],
    // Only one tag of one Page, never a path under it or above the listing.
    [`/api/pages/${pageId}/tags`, "PUT"],
    [`/api/pages/${pageId}/tags/a/b`, "PUT"],
    ["/api/pages/list", "GET"],
    ["/whoami", "POST"],
  ])
    await assert.rejects(
      authenticate(request(token, { path, method }), env),
      { status: 403, reason: "credential_scope" },
      path,
    );
  assert.deepEqual(kilo.exchanges(), []);
  for (const [path, method] of [
    ["/mcp", "POST"],
    ["/api/tools", "POST"],
    ["/api/pages", "GET"],
    [`/api/pages/${pageId}/tags/repo%3Aorg%2Fname`, "PUT"],
    [`/api/pages/${pageId}/tags/code`, "DELETE"],
    ["/whoami", "GET"],
    ["/internal/tool", "POST"],
  ])
    assert.ok((await authenticate(request(token, { path, method }), env)).principal, path);
  assert.equal(kilo.exchanges().length, 1);
});

test("an asset route refuses a Kilo token before any Project lookup or exchange", async (t) => {
  const { env, kilo, outbound } = await fixture(t);
  const token = kilo.mintToken(person(), { audience });
  env.PROJECTS = env.PAGES = {
    getByName: () => assert.fail("no host is asked before the route authenticates"),
  };
  const projectId = `prj_${crypto.randomUUID()}`;
  for (const [path, method] of [
    [`/api/projects/${projectId}/assets/${"a".repeat(64)}`, "GET"],
    [`/api/projects/${projectId}/assets`, "POST"],
    [`/api/pages/${pageId}/assets/${"a".repeat(64)}`, "GET"],
    [`/api/pages/${pageId}/assets`, "POST"],
    [`/api/pages/${pageId}/card-image`, "GET"],
  ]) {
    const response = await worker.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
        ...(method === "POST" && { body: new Uint8Array(4) }),
      }),
      env,
    );
    assert.equal(response.status, 403, `${method} ${path}: ${await response.clone().text()}`);
  }
  assert.deepEqual(outbound, []);
  assert.deepEqual(kilo.exchanges(), []);
});

test("Kilo's refusals reach the caller as codes, and nothing of the token or Kilo's body", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  const holder = person();
  const json = (status, value) => (req, res) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  const leak = "kilo-private-detail";
  const mcp = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_pages" } };
  const call = (token) =>
    worker.fetch(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(mcp),
      }),
      env,
    );
  for (const [label, answer, status, code] of [
    [
      "invalid_token",
      json(400, { error: "invalid_token", detail: leak }),
      401,
      "invalid_kilo_token",
    ],
    // Only Kilo's explicit refusal of the token is a refusal of it.
    [
      "invalid_request",
      json(400, { error: "invalid_request", detail: leak }),
      503,
      "sign_in_unavailable",
    ],
    ["400 without a body", (req, res) => res.writeHead(400).end(), 503, "sign_in_unavailable"],
    ["400 not json", (req, res) => res.writeHead(400).end(leak), 503, "sign_in_unavailable"],
    [
      "403 with another error",
      json(403, { error: "forbidden", detail: leak }),
      503,
      "sign_in_unavailable",
    ],
    ["404", json(404, { error: "invalid_token" }), 503, "sign_in_unavailable"],
    ["408", json(408, { error: "invalid_token" }), 503, "sign_in_unavailable"],
    ["410", json(410, { error: "invalid_token" }), 503, "sign_in_unavailable"],
    [
      "400 over the size limit",
      json(400, { error: "invalid_token", detail: leak.repeat(1000) }),
      503,
      "sign_in_unavailable",
    ],
    [
      "account",
      json(403, { error: "account_unavailable", detail: leak }),
      403,
      "account_unavailable",
    ],
    [
      "invalid_client",
      json(401, { error: "invalid_client", detail: leak }),
      503,
      "sign_in_unavailable",
    ],
    ["500", json(500, { detail: leak }), 503, "sign_in_unavailable"],
    ["429", json(429, { detail: leak }), 503, "sign_in_unavailable"],
    ["no id", json(200, { user: { name: leak } }), 503, "sign_in_unavailable"],
    ["not json", (req, res) => res.writeHead(200).end(leak), 503, "sign_in_unavailable"],
    [
      "over the size limit",
      json(200, { user: { id: "x", name: leak.repeat(1000) } }),
      503,
      "sign_in_unavailable",
    ],
    [
      "3xx",
      (req, res) => res.writeHead(302, { location: "https://elsewhere.invalid/" }).end(),
      503,
      "sign_in_unavailable",
    ],
  ]) {
    const token = kilo.mintToken(holder, { audience, claims: unique() });
    kilo.respond(answer);
    const response = await call(token);
    assert.equal(response.status, status, label);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.code, code, label);
    if (status === 503) assert.equal(body.retryable, true);
    if (status === 401) {
      assert.match(body.error, /Mint a new Kilo token for this Pages deployment/);
      assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    }
    for (const hidden of [token, secret, leak, audience]) assert.ok(!text.includes(hidden), hidden);
    // A refusal of the token answers its repeats without an exchange. A Kilo
    // that couldn't answer is not remembered: the repeat is asked again, and
    // this time the fake accepts it.
    const before = kilo.exchanges().length;
    if (status === 503) {
      assert.equal((await authenticate(request(token), env)).credentialKind, "kilo-token", label);
      assert.equal(kilo.exchanges().length, before + 1, label);
    } else {
      for (let repeat = 0; repeat < 3; repeat++)
        await assert.rejects(authenticate(request(token), env), { status, code }, label);
      assert.equal(kilo.exchanges().length, before, label);
    }
  }
  // Kilo itself refuses a forged, expired or foreign token; Pages says so.
  const token = kilo.mintToken(holder, { audience, claims: unique() });
  for (const forged of [
    `${token.slice(0, token.lastIndexOf(".") + 1)}forged`,
    kilo.mintToken(holder, { audience, seconds: -1 }),
  ])
    assert.equal(JSON.parse(await (await call(forged)).text()).code, "invalid_kilo_token");
  const minted = kilo.mintToken(holder, { audience, claims: unique() });
  kilo.block(holder.id);
  const blocked = await call(minted);
  assert.equal(blocked.status, 403);
  assert.equal(JSON.parse(await blocked.text()).code, "account_unavailable");
  // An unreachable Kilo is unavailable, not a refusal.
  await kilo.close();
  const unreachable = await call(kilo.mintToken(holder, { audience, claims: unique() }));
  assert.equal(unreachable.status, 503);
  // The operator gets one coded line per refusal, without the token or secret.
  const refusals = lines
    .filter((line) => line.includes('"pages.auth.v1"'))
    .map((line) => JSON.parse(line))
    .filter((event) => event.action === "kilo_token.refused");
  assert.ok(refusals.length >= 9);
  assert.ok(refusals.every((event) => event.credential === "kilo-token" && event.reason));
  for (const line of lines) {
    assert.ok(!line.includes(secret), line);
    assert.ok(!/eyJ[\w-]+\.eyJ/.test(line), line);
    assert.ok(!line.includes(leak), line);
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
    this.values.delete(key);
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .slice(0, limit),
    );
  }
  async sync() {}
}

/** One Page owned by `holder`, and the tool calls a Kilo agent sends with a
 * token over /mcp and /api/tools. */
function pageWorld(t, { env, holder }) {
  let doc = A.change(A.from(createPageData({ pageId, title: "Kilo Page" })), (draft) =>
    initializePage(draft, "Ship on Monday."),
  );
  t.after(() => A.free(doc));
  const handle = Object.assign(new EventEmitter(), {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
    broadcast() {},
  });
  const page = Object.assign(Object.create(Page.prototype), {
    plain: plainStub(),
    env,
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    ctx: { storage: new Storage() },
    metadata: {
      pageId,
      documentFormats: MEMBER_FORMATS,
      owner: kiloIdentity(kiloSignIn(env, request("x")), holder).principal,
      deleted: false,
      acl: { revision: 0, members: {}, invites: {} },
    },
    handle,
    cacheTitle() {},
    flush: async () => {},
  });
  page.policy = new DocumentPolicy({ metadata: () => page.metadata });
  env.PAGES = { getByName: () => page };
  const bodies = [];
  const tools = async (token, operation, args) => {
    const response = await worker.fetch(
      toolCall(token, operation, { page_id: pageId, ...args }),
      env,
    );
    const text = await response.text();
    bodies.push(text);
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
  };
  const mcp = async (token, operation, args) => {
    const response = await worker.fetch(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: operation, arguments: { page_id: pageId, ...args } },
        }),
      }),
      env,
    );
    const text = await response.text();
    bodies.push(text);
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);
    assert.ok(!body.result?.isError, text);
    return body.result.structuredContent;
  };
  return { tools, mcp, bodies, page, doc: () => doc };
}

test("a Kilo agent reads and writes its person's Page over /mcp and /api/tools with one exchange", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  const holder = person();
  const token = kilo.mintToken(holder, { audience });
  const w = pageWorld(t, { env, holder });
  const read = await w.mcp(token, "read_page", {});
  assert.match(JSON.stringify(read), /Ship on Monday/);
  await w.mcp(token, "edit_page", {
    operations: [{ op: "set_title", title: "Kilo over MCP" }],
    revision: read.revision,
    nonce: crypto.randomUUID(),
  });
  assert.equal(w.doc().title, "Kilo over MCP");
  const again = await w.tools(token, "read_page", {});
  await w.tools(token, "edit_page", {
    operations: [{ op: "set_title", title: "Kilo over HTTP" }],
    revision: again.revision,
    nonce: crypto.randomUUID(),
  });
  assert.equal(w.doc().title, "Kilo over HTTP");
  // Every call, and every hop it forwarded, used the one exchange.
  assert.equal(kilo.exchanges().length, 1);
  for (const text of [...w.bodies, ...lines]) assert.ok(!text.includes(token));
  const usage = lines.filter((line) => line.includes('"pages.usage.v1"'));
  assert.ok(usage.length >= 4);
  assert.ok(usage.every((line) => line.includes('"credential":"kilo-token"')));
});

test("a Kilo agent's write keys its receipt on the principal its person's browser has", async (t) => {
  const { env, kilo } = await fixture(t);
  const holder = person();
  const token = kilo.mintToken(holder, { audience });
  const w = pageWorld(t, { env, holder });
  // The same principal a browser session of this person signs in as.
  const browser = kiloIdentity(kiloSignIn(env, request("x")), holder).principal;
  assert.match(browser, /^user:kilo:/);
  const read = await w.mcp(token, "read_page", {});
  const nonce = crypto.randomUUID();
  const args = { operations: [{ op: "set_title", title: "Once" }], revision: read.revision, nonce };
  await w.mcp(token, "edit_page", args);
  const key = await receiptKey({ principal: browser, lane: "page", nonce });
  assert.equal(
    (await w.page.ctx.storage.get(key))?.pending,
    false,
    "the receipt sits under that key",
  );
  // An exact retry replays that receipt.
  const replay = await w.tools(token, "edit_page", args);
  assert.equal(replay.revision, (await w.page.ctx.storage.get(key)).receipt.revision);
});

test("a Kilo agent token is held to the argument check and can't send the browser's Trash guard", async (t) => {
  const { env, kilo } = await fixture(t);
  const holder = person();
  const token = kilo.mintToken(holder, { audience });
  const w = pageWorld(t, { env, holder });
  const refused = async (operation, args) => {
    const response = await worker.fetch(
      toolCall(token, operation, { page_id: pageId, ...args }),
      env,
    );
    assert.equal(response.status, 400);
    return response.json();
  };
  assert.deepEqual(await refused("read_page", { since_heads: [] }), {
    error: "read_page has no argument `since_heads`",
    code: "invalid_arguments",
  });
  const trash = await refused("delete_page", {
    base_heads: A.getHeads(w.doc()),
    nonce: crypto.randomUUID(),
  });
  assert.equal(trash.code, "invalid_arguments");
  assert.match(trash.error, /`base_heads`/);
  assert.equal(w.page.metadata.deleted, false);
  assert.equal(w.page.metadata.trash, undefined);
});

test("a token Kilo accepts but Pages doesn't lease still authorizes its request", async (t) => {
  const { env, kilo } = await fixture(t);
  const holder = person();
  const w = pageWorld(t, { env, holder });
  for (const [label, token] of [
    // Inside the 30-second clock allowance: no lease.
    ["20 seconds left", kilo.mintToken(holder, { audience, seconds: 20 })],
    // No iat: the lifetime is unknown, so no lease.
    ["no iat", kilo.mintToken(holder, { audience, claims: { iat: undefined } })],
  ])
    for (const [surface, call] of [
      ["mcp", w.mcp],
      ["tools", w.tools],
    ]) {
      const before = kilo.exchanges().length;
      const read = await call(token, "read_page", {});
      assert.match(JSON.stringify(read), /Ship on Monday/, `${label} ${surface}`);
      // Nothing is leased, so each call asks Kilo again.
      assert.ok(kilo.exchanges().length > before, `${label} ${surface}`);
    }
  // The identity is valid for 30 seconds from Kilo's answer.
  const before = Date.now();
  const identity = await authenticate(
    request(kilo.mintToken(holder, { audience, seconds: 20 })),
    env,
  );
  assert.ok(identity.expiresAt > Date.now());
  assert.ok(identity.expiresAt <= Date.now() + 30_000 && identity.expiresAt >= before + 30_000);
});

test("a member of the organization a Page is shared with edits it through edit_page at the grant's role", async (t) => {
  const { env, kilo } = await fixture(t);
  const owner = person();
  const w = pageWorld(t, { env, holder: owner });
  const organization = { id: "org-agents", name: "Agent Guild" };
  const share = (role) =>
    (w.page.metadata = {
      ...w.page.metadata,
      acl: {
        ...w.page.metadata.acl,
        organizationAccess: role ? { ...organization, namespace: "user:kilo", role } : null,
      },
    });
  const holder = { ...person(), organizations: [{ ...organization, role: "member" }] };
  const outsider = person();
  const edit = async (token, title) => {
    const read = await w.tools(token, "read_page", {});
    return worker.fetch(
      toolCall(token, "edit_page", {
        page_id: pageId,
        operations: [{ op: "set_title", title }],
        revision: read.revision,
        nonce: crypto.randomUUID(),
      }),
      env,
    );
  };
  share("editor");
  const token = kilo.mintToken(holder, { audience });
  assert.equal((await edit(token, "Edited by the guild")).status, 200);
  assert.equal(w.doc().title, "Edited by the guild");
  assert.deepEqual(w.page.metadata.acl.members, {});
  for (const role of ["commenter", "viewer"]) {
    share(role);
    const refused = await edit(token, `Edited as ${role}`);
    assert.equal(refused.status, 403, role);
    assert.match((await refused.json()).error, /read-only/);
    assert.equal(w.doc().title, "Edited by the guild");
  }
  const stranger = kilo.mintToken(outsider, { audience });
  const denied = await worker.fetch(toolCall(stranger, "read_page", { page_id: pageId }), env);
  assert.equal(denied.status, 403);
  share(null);
  const withdrawn = await worker.fetch(toolCall(token, "read_page", { page_id: pageId }), env);
  assert.equal(withdrawn.status, 403);
});
