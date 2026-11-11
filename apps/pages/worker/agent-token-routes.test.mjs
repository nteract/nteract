// Agent credentials (a Pages OAuth token, a Kilo agent token) through every
// internal hop a tool forwards to, over real Catalog, Project and Page hosts
// (projects-fixture.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { secretHash } from "@cloud/oidc-session-store.ts";
import { startLocalKiloHandoff } from "../scripts/fixtures/local-kilo-handoff.mjs";
import worker from "./index.mjs";
import { exchangeAuthorizationCode, issueAuthorizationCode } from "./oauth-store.mjs";
import { world } from "./projects-fixture.mjs";

const origin = "https://pages.invalid";
const audience = "pages-test";
const secret = "kilo-exchange-fixture-secret-0123456789";
// The fixture replaces fetch; the fake Kilo needs the real one.
const send = globalThis.fetch;

async function oauthToken(env, identity) {
  const verifier = "v".repeat(43);
  const client = {
    clientId: "https://chatgpt.com/oauth/client.json",
    redirectUri: "https://chatgpt.com/connector_platform/oauth_redirect",
    resource: `${origin}/mcp`,
  };
  const { code } = await issueAuthorizationCode(env, {
    ...client,
    scope: "pages:read pages:write offline_access",
    codeChallenge: await secretHash(verifier),
    identity,
  });
  const tokens = await exchangeAuthorizationCode(env, { ...client, code, codeVerifier: verifier });
  return tokens.access_token;
}

/** One MCP tools/call with `token` through the public gateway. */
async function mcp(env, token, name, args) {
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
        params: { name, arguments: args },
      }),
    }),
    env,
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const { result } = JSON.parse(text);
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

/** create_project, delete_project preview, then confirm, all as `token`. */
async function createAndDelete(env, token) {
  const created = await mcp(env, token, "create_project", {
    title: "Retiring",
    nonce: crypto.randomUUID(),
  });
  assert.equal(created.isError, false, JSON.stringify(created.body));
  const projectId = created.body.project_id;
  const previewed = await mcp(env, token, "delete_project", {
    project_id: projectId,
    action: "preview",
  });
  assert.equal(previewed.isError, false, JSON.stringify(previewed.body));
  const deleted = await mcp(env, token, "delete_project", {
    project_id: projectId,
    action: "confirm",
    preview_token: previewed.body.preview_token,
    nonce: crypto.randomUUID(),
  });
  assert.equal(deleted.isError, false, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body, { project_id: projectId, deleted: true });
}

test("a Pages OAuth token previews and confirms delete_project", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const env = { ...w.env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin };
  w.env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN = origin;
  const token = await oauthToken(env, {
    principal: w.owner,
    namespace: "user:anaconda-fixture",
    displayName: "Fixture Person",
  });
  await createAndDelete(env, token);
  await w.settle();
});

test("a Kilo agent token previews and confirms delete_project", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const kilo = await startLocalKiloHandoff({ deployments: { [audience]: origin }, secret });
  t.after(() => kilo.close());
  t.mock.method(globalThis, "fetch", send);
  Object.assign(w.env, {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    PAGES_KILO_APP_URL: kilo.origin,
    PAGES_KILO_AUDIENCE: audience,
    PAGES_KILO_EXCHANGE_SECRET: secret,
  });
  const token = kilo.mintToken({ id: "deleting-agent", name: "Agent Person" }, { audience });
  await createAndDelete(w.env, token);
  assert.equal(kilo.exchanges().length, 1);
  await w.settle();
});

/** A Project member adds a Page to the owner's Project: the member's Catalog
 * forwards the creation to the owner's. */
async function memberCreates(env, { ownerToken, memberToken, member }) {
  const created = await mcp(env, ownerToken, "create_project", {
    title: "Shared",
    nonce: crypto.randomUUID(),
  });
  assert.equal(created.isError, false, JSON.stringify(created.body));
  const projectId = created.body.project_id;
  const shared = await mcp(env, ownerToken, "manage_project_access", {
    project_id: projectId,
    action: "set_role",
    principal: member,
    role: "editor",
    expected_revision: 0,
    nonce: crypto.randomUUID(),
  });
  assert.equal(shared.isError, false, JSON.stringify(shared.body));
  const page = await mcp(env, memberToken, "create_page", {
    title: "From a member",
    project_id: projectId,
    nonce: crypto.randomUUID(),
  });
  assert.equal(page.isError, false, JSON.stringify(page.body));
}

test("a Project member adds a Page with a Pages OAuth token", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  w.env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN = origin;
  const identity = (principal) => ({
    principal,
    namespace: "user:anaconda-fixture",
    displayName: principal,
  });
  const issue = async (principal) => {
    const verifier = "v".repeat(43);
    const client = {
      clientId: "https://chatgpt.com/oauth/client.json",
      redirectUri: "https://chatgpt.com/connector_platform/oauth_redirect",
      resource: `${origin}/mcp`,
    };
    const { code } = await issueAuthorizationCode(w.env, {
      ...client,
      scope: "pages:read pages:write pages:share offline_access",
      codeChallenge: await secretHash(verifier),
      identity: identity(principal),
    });
    return (await exchangeAuthorizationCode(w.env, { ...client, code, codeVerifier: verifier }))
      .access_token;
  };
  await memberCreates(w.env, {
    ownerToken: await issue(w.owner),
    memberToken: await issue(w.member),
    member: w.member,
  });
  await w.settle();
});

test("a Project member adds a Page with a Kilo agent token", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const kilo = await startLocalKiloHandoff({ deployments: { [audience]: origin }, secret });
  t.after(() => kilo.close());
  t.mock.method(globalThis, "fetch", send);
  Object.assign(w.env, {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    PAGES_KILO_APP_URL: kilo.origin,
    PAGES_KILO_AUDIENCE: audience,
    PAGES_KILO_EXCHANGE_SECRET: secret,
  });
  await memberCreates(w.env, {
    ownerToken: kilo.mintToken({ id: "sharing-owner" }, { audience }),
    memberToken: kilo.mintToken({ id: "sharing-member" }, { audience }),
    member: "user:kilo:sharing-member",
  });
  await w.settle();
});

test("the public gateway answers 404 for every internal path", async (t) => {
  const w = await world(t);
  const kilo = await startLocalKiloHandoff({ deployments: { [audience]: origin }, secret });
  t.after(() => kilo.close());
  t.mock.method(globalThis, "fetch", send);
  Object.assign(w.env, {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    PAGES_KILO_APP_URL: kilo.origin,
    PAGES_KILO_AUDIENCE: audience,
    PAGES_KILO_EXCHANGE_SECRET: secret,
  });
  const token = kilo.mintToken({ id: "probing-agent" }, { audience });
  for (const path of [
    "/internal/catalog",
    "/internal/tool",
    "/internal/create",
    "/internal/project-create",
    "/internal/trash",
    "/internal/restore",
    "/internal/purge",
    "/internal/assets/authorize",
    "/internal/content-impact",
    "/internal/space/create",
    "/internal/space/read",
    "/internal/space/update",
    "/internal/space/delete",
    "/internal/space/access",
    "/internal/access",
  ])
    for (const method of ["GET", "POST"]) {
      const response = await worker.fetch(
        new Request(`${origin}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}` },
          ...(method === "POST" && { body: "{}" }),
        }),
        w.env,
      );
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  assert.deepEqual(kilo.exchanges(), []);
});
