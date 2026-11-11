import assert from "node:assert/strict";
import { test } from "node:test";
import { createServerAppSession } from "@cloud/app-session.ts";
import {
  SERVER_SESSION_COOKIE,
  oidcDatabase,
  randomSecret,
  sealServerSecret,
  secretHash,
  serverSessionContext,
  serverSessionId,
} from "@cloud/oidc-session-store.ts";
import worker, { Page } from "./index.mjs";
import { world } from "./projects-fixture.mjs";
import { proposeAccessUpdate } from "./access.mjs";
import { cardBucket } from "./card-bucket-fixture.mjs";
import { catalogIndexTimeouts } from "./catalog-index.mjs";
import { CONTENT_ACTIVITY_KEY } from "./content-activity.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { plainStub } from "./plain-stub.mjs";
import { PAGE_CARD_KEY } from "./page-card-writer.mjs";
import { proposeSharingMutation } from "./sharing.mjs";
import { trashRecord } from "./trash.mjs";
import { commentsUuid, fixture, pageId as fixturePageId } from "./trash-fixture.mjs";
import { exchangeAuthorizationCode, issueAuthorizationCode } from "./oauth-store.mjs";
import {
  LINK_PREVIEW_PATH,
  PAGE_UNAVAILABLE,
  PROJECT_UNAVAILABLE,
  checkLinkPreview,
  checkProjectPreview,
  foreignFetch,
  readLinkRoute,
} from "./link-previews.mjs";
import { invitedProjects } from "./project-invitations.mjs";
import { cardKey, pageCard } from "../model/page-card.mjs";

const origin = "https://pages.invalid";
const namespace = "user:anaconda-fixture";
const UNAVAILABLE = JSON.stringify(PAGE_UNAVAILABLE);
const PROJECT_REFUSED = JSON.stringify(PROJECT_UNAVAILABLE);

// ---------------------------------------------------------------------------
// Through the gateway, against booted Page hosts (projects-fixture.mjs).

async function linksWorld(t) {
  const w = await world(t);
  const assets = cardBucket();
  w.env.PAGES_ASSETS = assets;
  const users = ["viewer", "commenter", "editor", "project", "stranger", "member"];
  const tokens = {
    owner: w.auth.apiKey(),
    ...Object.fromEntries(
      users.map((who) => [
        who,
        w.auth.apiKey({ userId: who === "member" ? "member-user" : `${who}-user` }),
      ]),
    ),
  };
  const principal = (who) =>
    who === "owner" ? w.owner : who === "member" ? w.member : `${namespace}:${who}-user`;
  /** One request to a link route under `prefix` ("p" or "project"). `who`
   * null sends no credential. */
  const at =
    (prefix) =>
    async (who, id, file = "meta", { method = "GET", headers = {} } = {}) => {
      const response = await worker.fetch(
        new Request(`${origin}/${prefix}/${id}/${file}.json`, {
          method,
          headers: { ...(who && { authorization: `Bearer ${tokens[who] ?? who}` }), ...headers },
        }),
        w.env,
      );
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {}
      return { status: response.status, headers: response.headers, text, body };
    };
  const get = at("p");
  const getProject = at("project");
  const settle = async () => {
    while (w.jobs.length) await Promise.allSettled(w.jobs.splice(0));
  };
  const create = async (title, args = {}) => {
    const created = await w.createPage({ title, ...args });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await settle();
    return created.body.page_id;
  };
  /** Store the card the Page's host would write on its first flush. */
  const seedCard = async (id) => {
    const card = await pageCard(w.page(id).handle.doc());
    await assets.seed(cardKey(id), card);
    await w.page(id).ctx.storage.put(PAGE_CARD_KEY, { card_hash: card.card_hash });
    return card;
  };
  /** `who`'s direct role on an owned Page, as a sharing change sets it. */
  const setRole = async (id, who, role) => {
    const host = w.page(id);
    const acl = proposeAccessUpdate(
      host.metadata,
      { principal: w.owner, canWrite: true, expiresAt: Date.now() + 60_000 },
      { principal: principal(who), role, expected_revision: host.metadata.acl?.revision ?? 0 },
    ).acl;
    host.metadata = { ...host.metadata, acl };
    await host.ctx.storage.put("host/document", host.metadata);
  };
  /** Move an owned Page to Trash, and optionally purge it. */
  const trash = async (id) => {
    const trashed = await w.call("owner", "delete_page", {
      page_id: id,
      nonce: w.key(),
    });
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  };
  const purge = async (id) => {
    await trash(id);
    const preview = await w.call("owner", "purge_page", { page_id: id, action: "preview" });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const purged = await w.call("owner", "purge_page", {
      page_id: id,
      action: "confirm",
      preview_token: preview.body.preview_token,
      nonce: w.key(),
    });
    assert.equal(purged.status, 200, JSON.stringify(purged.body));
    await settle();
  };
  /** `who`'s membership role in Project `projectId`; null removes it. */
  const projectRole = async (projectId, who, role) => {
    const roster = await w.call("owner", "get_project_access", { project_id: projectId });
    assert.equal(roster.status, 200, JSON.stringify(roster.body));
    const changed = await w.call("owner", "manage_project_access", {
      project_id: projectId,
      action: "set_role",
      principal: principal(who),
      role,
      expected_revision: roster.body.revision,
      nonce: w.key(),
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    await settle();
  };
  return {
    w,
    assets,
    tokens,
    principal,
    get,
    getProject,
    settle,
    create,
    seedCard,
    setRole,
    trash,
    purge,
    projectRole,
  };
}

const meta = (id, title, role, state = "active") => ({
  v: 1,
  page_id: id,
  title,
  state,
  role,
  content_updated_at: null,
});

test("the owner, direct grants and a Project member read meta.json and card.json", async (t) => {
  const l = await linksWorld(t);
  const project = await l.w.createProject("Launch");
  const id = await l.create("Linked plan", {
    markdown: "# Goals\n\nShip previews.",
    project_id: project.project_id,
  });
  for (const role of ["viewer", "commenter", "editor"]) await l.setRole(id, role, role);
  const shared = await l.w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: l.principal("project"),
    role: "viewer",
    expected_revision: 0,
    nonce: l.w.key(),
  });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  // Neither the direct grantees nor the Project member has a Catalog entry
  // for this Page: access is the Page host's, not the reader's Catalog.
  for (const who of ["viewer", "project"])
    assert.equal(await l.w.catalogStorage(l.principal(who)).get(`shared/${id}`), undefined);
  // No card stored yet: a reader who can open the Page gets `card: null`.
  const empty = await l.get("project", id, "card");
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.body, { v: 1, page_id: id, card: null });
  const card = await l.seedCard(id);
  for (const [who, role] of [
    ["owner", "owner"],
    ["viewer", "viewer"],
    ["commenter", "commenter"],
    ["editor", "editor"],
    ["project", "viewer"],
  ]) {
    const answer = await l.get(who, id);
    assert.equal(answer.status, 200, `${who}: ${answer.text}`);
    assert.deepEqual(answer.body, meta(id, "Linked plan", role), who);
    // Never the owner, members or ACL.
    assert.doesNotMatch(answer.text, /"owner":|members|acl|user:anaconda/, who);
    const cards = await l.get(who, id, "card");
    assert.equal(cards.status, 200, `${who}: ${cards.text}`);
    assert.deepEqual(cards.body, { v: 1, page_id: id, card }, who);
  }
});

test("every refusal answers the same 404, for both routes", async (t) => {
  const l = await linksWorld(t);
  const id = await l.create("Private plan");
  const revoked = await l.create("Revoked plan");
  await l.setRole(revoked, "member", "viewer");
  assert.equal((await l.get("member", revoked)).status, 200);
  await l.setRole(revoked, "member", null);
  const trashed = await l.create("Trashed plan");
  await l.setRole(trashed, "member", "editor");
  await l.trash(trashed);
  const purged = await l.create("Purged plan");
  await l.purge(purged);

  const refusals = [
    ["a stranger", "stranger", id],
    ["a revoked grant", "member", revoked],
    ["a member of a trashed Page", "member", trashed],
    ["a stranger to a trashed Page", "stranger", trashed],
    ["the owner of a purged Page", "owner", purged],
    ["a missing Page", "owner", crypto.randomUUID()],
    ["a malformed ID", "owner", "not-a-page"],
    ["an uppercase ID", "owner", id.toUpperCase()],
    ["a version 1 UUID", "owner", "1a160b47-6df1-11e3-81eb-489ca5a26812"],
    ["an encoded ID", "owner", encodeURIComponent(`../${id}`)],
  ];
  const seen = new Set();
  for (const [label, who, target] of refusals)
    for (const file of ["meta", "card"]) {
      const answer = await l.get(who, target, file);
      assert.equal(answer.status, 404, `${label} (${file}): ${answer.text}`);
      assert.equal(answer.headers.get("cache-control"), "private, no-store", label);
      assert.equal(answer.headers.get("etag"), null, label);
      assert.equal(answer.headers.get("x-content-type-options"), "nosniff", label);
      seen.add(answer.text);
    }
  // A host that fails or doesn't answer in time is refused the same way.
  l.w.faults.set(id, "before");
  const failed = await l.get("owner", id);
  assert.equal(failed.status, 404);
  seen.add(failed.text);
  const verify = catalogIndexTimeouts.verify;
  catalogIndexTimeouts.verify = 30;
  t.after(() => (catalogIndexTimeouts.verify = verify));
  const pages = l.w.env.PAGES;
  l.w.env.PAGES = { getByName: () => ({ fetch: () => new Promise(() => {}) }) };
  const late = await l.get("owner", id);
  l.w.env.PAGES = pages;
  assert.equal(late.status, 404);
  seen.add(late.text);
  assert.deepEqual([...seen], [UNAVAILABLE]);
  // The owner still reads both Pages that refused others.
  assert.equal((await l.get("owner", id)).status, 200);
  assert.equal((await l.get("owner", revoked)).status, 200);
});

test("a trashed Page answers its owner, who may restore it, as trashed", async (t) => {
  const l = await linksWorld(t);
  const id = await l.create("Old plan");
  await l.seedCard(id);
  await l.setRole(id, "editor", "editor");
  await l.trash(id);
  const owner = await l.get("owner", id);
  assert.equal(owner.status, 200, owner.text);
  assert.deepEqual(owner.body, meta(id, "Old plan", "owner", "trashed"));
  assert.equal((await l.get("owner", id, "card")).body.card.title, "Old plan");
  // An editor can't restore it: refused like anyone who can't open it.
  for (const file of ["meta", "card"])
    assert.equal((await l.get("editor", id, file)).text, UNAVAILABLE);
});

test("signed out is the same 401 for every ID; an MCP OAuth token is refused", async (t) => {
  const l = await linksWorld(t);
  const id = await l.create("Plan");
  const bodies = new Set();
  for (const target of [id, crypto.randomUUID(), "not-a-page"])
    for (const file of ["meta", "card"]) {
      const answer = await l.get(null, target, file);
      assert.equal(answer.status, 401, answer.text);
      assert.equal(answer.body.code, "auth_required");
      assert.equal(answer.headers.get("cache-control"), "private, no-store");
      bodies.add(answer.text);
    }
  assert.equal(bodies.size, 1);
  const clientId = "https://chatgpt.com/oauth/client.json";
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const verifier = "v".repeat(43);
  const env = { ...l.w.env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin };
  const { code } = await issueAuthorizationCode(env, {
    clientId,
    redirectUri,
    resource: `${origin}/mcp`,
    scope: "pages:read pages:write offline_access",
    codeChallenge: await secretHash(verifier),
    identity: { principal: l.w.owner, namespace, displayName: "Fixture" },
  });
  const { access_token: token } = await exchangeAuthorizationCode(env, {
    code,
    clientId,
    redirectUri,
    resource: `${origin}/mcp`,
    codeVerifier: verifier,
  });
  for (const file of ["meta", "card"]) {
    const refused = await l.get(token, id, file);
    assert.equal(refused.status, 403, refused.text);
    assert.doesNotMatch(refused.text, /Plan/);
  }
});

test("answers are never stored, carry no ETag, and every request checks access again", async (t) => {
  const l = await linksWorld(t);
  const id = await l.create("Versioned plan");
  await l.setRole(id, "member", "viewer");
  for (const file of ["meta", "card"]) {
    const first = await l.get("member", id, file);
    assert.equal(first.status, 200);
    for (const [name, value] of [
      ["content-type", "application/json"],
      ["cache-control", "private, no-store"],
      ["vary", "Cookie, Authorization"],
      ["cross-origin-resource-policy", "same-origin"],
      ["x-content-type-options", "nosniff"],
    ])
      assert.equal(first.headers.get(name), value, `${file}: ${name}`);
    assert.equal(first.headers.get("etag"), null, file);
    assert.equal(first.headers.get("access-control-allow-origin"), null, file);
    // A conditional request is answered in full: there's no stored copy.
    const again = await l.get("member", id, file, { headers: { "if-none-match": "*" } });
    assert.equal(again.status, 200, file);
    assert.equal(again.text, first.text, file);
  }
  // HEAD: the same headers, no body.
  const head = await l.get("member", id, "meta", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assert.equal(head.headers.get("cache-control"), "private, no-store");
  assert.equal((await l.get("member", id, "card", { method: "HEAD" })).status, 200);
  // A new title shows on the next look.
  l.w.page(id).handle.doc = ((doc) => () => ({ ...doc(), title: "Renamed plan" }))(
    l.w.page(id).handle.doc,
  );
  assert.equal((await l.get("member", id)).body.title, "Renamed plan");
  // A revoked reader is refused on the next look.
  await l.setRole(id, "member", null);
  const revoked = await l.get("member", id, "meta", { headers: { "if-none-match": "*" } });
  assert.equal(revoked.status, 404);
  assert.equal(revoked.text, UNAVAILABLE);
  // Only GET and HEAD.
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
    for (const file of ["meta", "card"]) {
      const refused = await l.get("owner", id, file, { method });
      assert.equal(refused.status, 405, method);
      assert.equal(refused.headers.get("allow"), "GET, HEAD");
    }
});

/** A browser session for `principal`, as the server sign-in flow stores it,
 * over the world's database. The world names its public origin so the
 * session's context matches, as a deployment's does. */
async function browserSession(l, principal) {
  Object.assign(l.w.env, {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "link-preview-session-fixture-".repeat(2),
  });
  const env = l.w.env;
  await oidcDatabase(env);
  const now = Math.floor(Date.now() / 1000);
  const token = randomSecret();
  const id = await serverSessionId(env, token);
  const context = serverSessionContext(env, origin);
  const session = await createServerAppSession(
    env,
    {
      principal,
      metadata: {
        provider: "oidc",
        principalNamespace: namespace,
        displayName: "Session Reader",
        email: "reader@example.invalid",
        emailVerified: true,
      },
    },
    id,
    now + 3600,
    now,
  );
  await env.DB.prepare(
    "INSERT INTO oidc_server_sessions (id,context,session_json,sealed,access_expires_at,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      context,
      JSON.stringify(session),
      await sealServerSecret(env, {}, `session:${id}:${context}`),
      now + 3600,
      now + 7200,
      now + 86400,
    )
    .run();
  return `${SERVER_SESSION_COOKIE}=${token}`;
}

test("a browser session cookie reads both routes; sign-out everywhere and a foreign Origin don't", async (t) => {
  const l = await linksWorld(t);
  const id = await l.create("Session plan");
  await l.setRole(id, "member", "viewer");
  const cookie = await browserSession(l, l.w.member);
  // As a browser's same-origin fetch sends it: no Origin on a GET, the
  // session cookie, and Sec-Fetch-Site. The host still sees this origin
  // (the gateway names it), so its own Origin check passes.
  const browser = (file, headers = {}) =>
    l.get(null, id, file, {
      headers: { cookie, "sec-fetch-site": "same-origin", ...headers },
    });
  for (const file of ["meta", "card"]) {
    const answer = await browser(file);
    assert.equal(answer.status, 200, `${file}: ${answer.text}`);
    assert.equal(answer.body.page_id, id, file);
  }
  assert.equal((await browser("meta")).body.role, "viewer");
  // A same-origin Origin header is fine too.
  assert.equal((await browser("meta", { origin })).status, 200);
  // A foreign Origin is refused before anything about the Page.
  for (const from of ["https://evil.example", "https://page2.pages.invalid"]) {
    const refused = await l.get(null, id, "meta", { headers: { cookie, origin: from } });
    assert.equal(refused.status, 403, from);
    assert.doesNotMatch(refused.text, /Session plan/);
  }
  // Signing out everywhere ends this session: the next look is a 401.
  const out = await worker.fetch(
    new Request(`${origin}/api/auth/logout-all`, {
      method: "POST",
      headers: { cookie, origin },
    }),
    l.w.env,
  );
  assert.equal(out.status, 200, await out.clone().text());
  for (const file of ["meta", "card"]) {
    const signedOut = await browser(file);
    assert.equal(signedOut.status, 401, file);
    assert.equal(signedOut.body.code, "auth_required", file);
    assert.doesNotMatch(signedOut.text, /Session plan/);
  }
});

test("only same-origin and direct browser requests are answered", async (t) => {
  const l = await linksWorld(t);
  const id = await l.create("Plan");
  const reached = [];
  const pages = l.w.env.PAGES;
  l.w.env.PAGES = {
    getByName: (name) => {
      reached.push(name);
      return pages.getByName(name);
    },
  };
  for (const site of ["same-site", "cross-site"]) {
    const refused = await l.get("owner", id, "meta", { headers: { "sec-fetch-site": site } });
    assert.equal(refused.status, 403, site);
    assert.doesNotMatch(refused.text, /Plan/);
  }
  assert.deepEqual(reached, []);
  for (const site of ["same-origin", "none"])
    assert.equal(
      (await l.get("owner", id, "meta", { headers: { "sec-fetch-site": site } })).status,
      200,
      site,
    );
  assert.equal(foreignFetch(new Request(origin)), false);
});

test("card.json reads the stored card and the card image info page_cards attaches", async (t) => {
  const l = await linksWorld(t);
  const project = await l.w.createProject("Launch");
  const id = await l.create("Pictured plan", {
    markdown: "# Goals\n\nShip card images.",
    project_id: project.project_id,
  });
  const card = await l.seedCard(id);
  const upload = async (theme, type, bytes) => {
    const response = await worker.fetch(
      new Request(`${origin}/api/pages/${id}/card-image?hash=${card.card_hash}&theme=${theme}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${l.tokens.owner}`, "content-type": type },
        body: bytes,
      }),
      l.w.env,
    );
    assert.equal(response.status, 201, await response.text());
  };
  const png = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await upload("light", "image/png", png);
  await upload("dark", "image/png", png);
  await l.settle();
  assert.equal(
    (
      await l.w.call("owner", "manage_project_access", {
        project_id: project.project_id,
        action: "set_role",
        principal: l.principal("project"),
        role: "viewer",
        expected_revision: 0,
        nonce: l.w.key(),
      })
    ).status,
    200,
  );
  const image = {
    card_hash: card.card_hash,
    light: `/api/pages/${id}/card-image/${card.card_hash}-light.png`,
    dark: `/api/pages/${id}/card-image/${card.card_hash}-dark.png`,
  };
  const imageStatus = async (who) =>
    (
      await worker.fetch(
        new Request(`${origin}${image.light}`, {
          headers: { authorization: `Bearer ${l.tokens[who]}` },
        }),
        l.w.env,
      )
    ).status;
  for (const who of ["owner", "project"]) {
    const answer = await l.get(who, id, "card");
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.body, { v: 1, page_id: id, card: { ...card, image } }, who);
  }
  // The image route is unchanged: page_cards' decision, from the reader's
  // Catalog. The owner loads the image; a Project member with no Catalog
  // entry for the Page gets a 404, and the viewer keeps the JSON card
  // (PageCardImage.jsx). A stranger gets neither.
  assert.equal(await imageStatus("owner"), 200);
  assert.equal(await imageStatus("project"), 404);
  assert.equal(await imageStatus("stranger"), 404);
  assert.equal((await l.get("stranger", id, "card")).text, UNAVAILABLE);
  // A stored card whose images are for an older hash keeps its JSON only.
  await l.assets.seed(cardKey(id), { ...card, card_hash: "newer" });
  assert.equal((await l.get("owner", id, "card")).body.card.image, undefined);
});

test("a preview records no usage and writes no Catalog or host state", async (t) => {
  const l = await linksWorld(t);
  const project = await l.w.createProject("Launch");
  const id = await l.create("Quiet plan", { project_id: project.project_id });
  await l.seedCard(id);
  await l.setRole(id, "member", "viewer");
  await l.settle();
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(String(line)));
  const catalogPaths = [];
  const catalogs = l.w.env.CATALOGS;
  l.w.env.CATALOGS = {
    getByName: (principal) => {
      const target = catalogs.getByName(principal);
      return {
        fetch: (request, init) => {
          catalogPaths.push(new URL(request.url).pathname);
          return target.fetch(request, init);
        },
        ctx: target.ctx,
      };
    },
  };
  const snapshot = () =>
    JSON.stringify(
      [l.w.owner, l.w.member, l.principal("stranger")].map((principal) => [
        ...catalogs.getByName(principal).ctx.storage.values,
      ]),
    ) + JSON.stringify([...l.w.page(id).ctx.storage.values]);
  const before = snapshot();
  for (const who of ["owner", "member", "stranger"])
    for (const file of ["meta", "card"]) await l.get(who, id, file);
  await l.settle();
  assert.equal(snapshot(), before);
  assert.deepEqual(
    lines.filter((line) => line.includes("pages.usage.v1")),
    [],
  );
  // Project access is resolved with the owner's read-only location route.
  assert.deepEqual([...new Set(catalogPaths)], ["/internal/location"]);
  // The spy sees usage: opening the Page through a tool records it.
  await l.w.call("member", "read_page", { page_id: id });
  assert.ok(lines.some((line) => line.includes("pages.usage.v1")));
});

test("only the four JSON paths are routes; the gateway never forwards a host's route", async (t) => {
  assert.deepEqual(readLinkRoute(`/p/${fixturePageId}/meta.json`), {
    kind: "page",
    pageId: fixturePageId,
    file: "meta",
  });
  assert.deepEqual(readLinkRoute(`/p/x/card.json`), { kind: "page", pageId: "x", file: "card" });
  assert.deepEqual(readLinkRoute(`/project/prj_${fixturePageId}/meta.json`), {
    kind: "project",
    projectId: `prj_${fixturePageId}`,
    file: "meta",
  });
  assert.deepEqual(readLinkRoute(`/project/x/card.json`), {
    kind: "project",
    projectId: "x",
    file: "card",
  });
  for (const path of [
    `/p/${fixturePageId}`,
    `/p/${fixturePageId}/`,
    `/p/${fixturePageId}/meta.json/`,
    `/p/${fixturePageId}/meta.jsonx`,
    `/p/${fixturePageId}/other.json`,
    `/p/${fixturePageId}/meta.json/card.json`,
    `/p//x/meta.json`,
    `/project/prj_${fixturePageId}`,
    `/project/prj_${fixturePageId}/meta.json/`,
    `/project/prj_${fixturePageId}/other.json`,
    `/s/prj_${fixturePageId}/meta.json`,
    `/projects/prj_${fixturePageId}/meta.json`,
  ])
    assert.equal(readLinkRoute(path), null, path);
  const l = await linksWorld(t);
  const id = await l.create("Plan");
  const host = l.w.page(id);
  const run = t.mock.method(host, "run");
  for (const method of ["GET", "POST"]) {
    const response = await worker.fetch(
      new Request(`${origin}${LINK_PREVIEW_PATH}`, {
        method,
        headers: { authorization: `Bearer ${l.tokens.owner}` },
        ...(method === "POST" && { body: "{}" }),
      }),
      l.w.env,
    );
    assert.equal(response.status, 404);
  }
  assert.equal(run.mock.callCount(), 0);
});

// ---------------------------------------------------------------------------
// Project routes, through the gateway, against Project (Space) hosts.

const projectMeta = (id, title, description, role) => ({
  v: 1,
  kind: "project",
  project_id: id,
  title,
  description,
  role,
});

/** A world with one Project, its content document's id, and a stored card
 * for that document. */
async function projectWorld(t, { description = "Ship link previews this week." } = {}) {
  const l = await linksWorld(t);
  const project = await l.w.createProject("Launch", description);
  await l.settle();
  assert.match(project.document_id, /^[0-9a-f-]{36}$/);
  return { ...l, project, projectId: project.project_id, documentId: project.document_id };
}

test("the owner and Project members read a Project's meta.json and card.json", async (t) => {
  const p = await projectWorld(t);
  for (const role of ["viewer", "commenter", "editor"])
    await p.projectRole(p.projectId, role, role);
  // No card stored for the content document yet: `card: null`.
  const empty = await p.getProject("viewer", p.projectId, "card");
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.body, { v: 1, project_id: p.projectId, card: null });
  const card = await p.seedCard(p.documentId);
  for (const [who, role] of [
    ["owner", "owner"],
    ["viewer", "viewer"],
    ["commenter", "commenter"],
    ["editor", "editor"],
  ]) {
    const answer = await p.getProject(who, p.projectId);
    assert.equal(answer.status, 200, `${who}: ${answer.text}`);
    assert.deepEqual(
      answer.body,
      projectMeta(p.projectId, "Launch", "Ship link previews this week.", role),
      who,
    );
    // Never the owner, revision, members or content document.
    assert.doesNotMatch(
      answer.text,
      /"owner":|revision|members|acl|user:anaconda|document_id|created_at|updated_at/,
      who,
    );
    assert.doesNotMatch(answer.text, new RegExp(p.documentId), who);
    const cards = await p.getProject(who, p.projectId, "card");
    assert.equal(cards.status, 200, `${who}: ${cards.text}`);
    assert.deepEqual(cards.body, { v: 1, project_id: p.projectId, card }, who);
    for (const [name, value] of [
      ["content-type", "application/json"],
      ["cache-control", "private, no-store"],
      ["vary", "Cookie, Authorization"],
      ["cross-origin-resource-policy", "same-origin"],
      ["x-content-type-options", "nosniff"],
    ])
      assert.equal(cards.headers.get(name), value, `${who}: ${name}`);
    assert.equal(cards.headers.get("etag"), null);
    assert.equal(cards.headers.get("access-control-allow-origin"), null);
  }
  // An empty description is an empty string.
  const bare = await projectWorld(t, { description: "" });
  assert.equal((await bare.getProject("owner", bare.projectId)).body.description, "");
  // HEAD: the same headers, no body; only GET and HEAD.
  const head = await p.getProject("viewer", p.projectId, "meta", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assert.equal(head.headers.get("cache-control"), "private, no-store");
  assert.equal((await p.getProject("viewer", p.projectId, "card", { method: "HEAD" })).status, 200);
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
    for (const file of ["meta", "card"]) {
      const refused = await p.getProject("owner", p.projectId, file, { method });
      assert.equal(refused.status, 405, method);
      assert.equal(refused.headers.get("allow"), "GET, HEAD");
    }
});

test("every Project refusal answers the same 404, and malformed IDs never reach a host", async (t) => {
  const p = await projectWorld(t);
  await p.seedCard(p.documentId);
  await p.projectRole(p.projectId, "member", "viewer");
  assert.equal((await p.getProject("member", p.projectId)).status, 200);
  await p.projectRole(p.projectId, "member", null);
  const reached = [];
  const projects = p.w.env.PROJECTS;
  p.w.env.PROJECTS = {
    getByName: (name) => {
      reached.push(name);
      return projects.getByName(name);
    },
  };
  const uuid = crypto.randomUUID();
  const refusals = [
    ["a non-member", "stranger", p.projectId],
    ["a revoked member", "member", p.projectId],
    ["a missing Project", "owner", `prj_${uuid}`],
    ["a missing older Project", "owner", `sp_${uuid}`],
  ];
  const malformed = [
    ["a Page ID", "owner", p.documentId],
    ["an uppercase prefix", "owner", `PRJ_${uuid}`],
    ["an uppercase UUID", "owner", `prj_${uuid.toUpperCase()}`],
    ["a version 1 UUID", "owner", "prj_1a160b47-6df1-11e3-81eb-489ca5a26812"],
    ["another prefix", "owner", `xyz_${uuid}`],
    ["a dash for the underscore", "owner", `prj-${uuid}`],
    ["a bare prefix", "owner", "prj_"],
    ["an encoded ID", "owner", encodeURIComponent(`../${p.projectId}`)],
    ["an ID with trailing text", "owner", `${p.projectId}0`],
  ];
  const seen = new Set();
  for (const [label, who, target] of [...refusals, ...malformed])
    for (const file of ["meta", "card"]) {
      const before = p.assets.reads.length;
      const answer = await p.getProject(who, target, file);
      assert.equal(answer.status, 404, `${label} (${file}): ${answer.text}`);
      assert.equal(answer.headers.get("cache-control"), "private, no-store", label);
      assert.equal(answer.headers.get("x-content-type-options"), "nosniff", label);
      // The content document's card is never read for a refused reader.
      assert.equal(p.assets.reads.length, before, `${label}: no card read`);
      seen.add(answer.text);
    }
  assert.deepEqual(
    [...new Set(reached)].sort(),
    [p.projectId, `prj_${uuid}`, `sp_${uuid}`].sort(),
    "malformed IDs answer before any Project host",
  );
  // A host that fails or doesn't answer in time is refused the same way.
  p.w.env.PROJECTS = projects;
  p.w.faults.set(p.projectId, "before");
  const failed = await p.getProject("owner", p.projectId);
  assert.equal(failed.status, 404);
  seen.add(failed.text);
  const verify = catalogIndexTimeouts.verify;
  catalogIndexTimeouts.verify = 30;
  t.after(() => (catalogIndexTimeouts.verify = verify));
  p.w.env.PROJECTS = { getByName: () => ({ fetch: () => new Promise(() => {}) }) };
  const late = await p.getProject("owner", p.projectId);
  seen.add(late.text);
  p.w.env.PROJECTS = {
    getByName: () => ({ fetch: async () => Response.json({ error: "Busy" }, { status: 503 }) }),
  };
  seen.add((await p.getProject("owner", p.projectId)).text);
  // An answer for another Project, or one without a title, is refused too.
  p.w.env.PROJECTS = {
    getByName: () => ({
      fetch: async () =>
        Response.json({
          space_id: `prj_${uuid}`,
          title: "Other",
          role: "owner",
          document_id: uuid,
        }),
    }),
  };
  seen.add((await p.getProject("owner", p.projectId)).text);
  p.w.env.PROJECTS = projects;
  assert.deepEqual([...seen], [PROJECT_REFUSED]);
  // The owner still reads it.
  assert.equal((await p.getProject("owner", p.projectId)).status, 200);
});

test("a Page ID on a Project route and a Project ID on a Page route both get the uniform 404", async (t) => {
  const p = await projectWorld(t);
  const pageId = await p.create("Plain plan");
  const pages = p.w.env.PAGES;
  const projects = p.w.env.PROJECTS;
  const reached = [];
  p.w.env.PAGES = { getByName: (name) => (reached.push(["page", name]), pages.getByName(name)) };
  p.w.env.PROJECTS = {
    getByName: (name) => (reached.push(["project", name]), projects.getByName(name)),
  };
  for (const file of ["meta", "card"]) {
    const crossed = await p.getProject("owner", pageId, file);
    assert.equal(crossed.status, 404);
    assert.equal(crossed.text, PROJECT_REFUSED);
    const reverse = await p.get("owner", p.projectId, file);
    assert.equal(reverse.status, 404);
    assert.equal(reverse.text, UNAVAILABLE);
  }
  assert.deepEqual(reached, []);
});

test("a pending Project invitee is refused, the invitation stays pending, and nothing is discovered", async (t) => {
  const p = await projectWorld(t);
  const email = "fixture@example.invalid";
  const invited = await p.w.call("owner", "manage_project_access", {
    project_id: p.projectId,
    action: "invite",
    email,
    role: "editor",
    expected_revision: 0,
    nonce: p.w.key(),
  });
  assert.equal(invited.status, 200, JSON.stringify(invited.body));
  await p.settle();
  const invitee = { principal: p.w.member, namespace, verifiedEmail: email };
  assert.deepEqual(await invitedProjects(p.w.env, invitee), [p.projectId]);
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(String(line)));
  for (const file of ["meta", "card"]) {
    const answer = await p.getProject("member", p.projectId, file);
    assert.equal(answer.status, 404, answer.text);
    assert.equal(answer.text, PROJECT_REFUSED);
  }
  await p.settle();
  // The previews recorded no usage and accepted no invitation.
  assert.deepEqual(
    lines.filter((line) => /pages\.usage\.v1|invitation\.accepted/.test(line)),
    [],
  );
  // Still pending: no member, the invite, its discovery index, and no
  // Catalog discovery hint for the invitee.
  const roster = await p.w.call("owner", "get_project_access", { project_id: p.projectId });
  assert.equal(roster.body.invites.length, 1);
  assert.equal(roster.body.members[p.w.member], undefined);
  assert.deepEqual(await invitedProjects(p.w.env, invitee), [p.projectId]);
  assert.equal(
    (await p.w.catalogStorage(p.w.member).list({ prefix: "project-discovery/" })).size,
    0,
  );
  // Opening the Project still claims it; then the preview answers.
  const listed = await p.w.call("member", "list_projects");
  assert.equal(listed.body.projects[0]?.project_id, p.projectId);
  const claimed = await p.getProject("member", p.projectId);
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.role, "editor");
});

test("a Project preview writes no Space or Catalog state and records no usage", async (t) => {
  const p = await projectWorld(t);
  await p.seedCard(p.documentId);
  await p.projectRole(p.projectId, "member", "viewer");
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(String(line)));
  const catalogPaths = [];
  const catalogs = p.w.env.CATALOGS;
  p.w.env.CATALOGS = {
    getByName: (principal) => {
      const target = catalogs.getByName(principal);
      return {
        fetch: (request, init) => {
          catalogPaths.push(new URL(request.url).pathname);
          return target.fetch(request, init);
        },
        ctx: target.ctx,
      };
    },
  };
  const spaceStorage = p.w.projects.get(p.projectId).ctx.storage;
  const missing = `prj_${crypto.randomUUID()}`;
  const snapshot = () =>
    JSON.stringify([
      [...spaceStorage.values],
      ...[p.w.owner, p.w.member, p.principal("stranger")].map((principal) => [
        ...catalogs.getByName(principal).ctx.storage.values,
      ]),
      [...p.w.page(p.documentId).ctx.storage.values],
    ]);
  const before = snapshot();
  for (const who of ["owner", "member", "stranger"])
    for (const file of ["meta", "card"]) await p.getProject(who, p.projectId, file);
  await p.getProject("owner", missing);
  await p.settle();
  assert.equal(snapshot(), before);
  // A missing Project's host was only instantiated: nothing stored.
  assert.equal(p.w.projects.get(missing).ctx.storage.values.size, 0);
  assert.deepEqual(catalogPaths, [], "no Catalog is asked at all");
  assert.deepEqual(
    lines.filter((line) => line.includes("pages.usage.v1")),
    [],
  );
  // The spy sees usage: a tool call records it.
  await p.w.call("member", "get_project", { project_id: p.projectId });
  assert.ok(lines.some((line) => line.includes("pages.usage.v1")));
});

test("a Project's card.json carries its content document's card image info; the images fail closed", async (t) => {
  const p = await projectWorld(t);
  const card = await p.seedCard(p.documentId);
  const png = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  for (const theme of ["light", "dark"]) {
    const response = await worker.fetch(
      new Request(
        `${origin}/api/pages/${p.documentId}/card-image?hash=${card.card_hash}&theme=${theme}`,
        {
          method: "PUT",
          headers: { authorization: `Bearer ${p.tokens.owner}`, "content-type": "image/png" },
          body: png,
        },
      ),
      p.w.env,
    );
    assert.equal(response.status, 201, await response.text());
  }
  await p.settle();
  await p.projectRole(p.projectId, "member", "viewer");
  const image = {
    card_hash: card.card_hash,
    light: `/api/pages/${p.documentId}/card-image/${card.card_hash}-light.png`,
    dark: `/api/pages/${p.documentId}/card-image/${card.card_hash}-dark.png`,
  };
  for (const who of ["owner", "member"]) {
    const answer = await p.getProject(who, p.projectId, "card");
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.body, { v: 1, project_id: p.projectId, card: { ...card, image } }, who);
  }
  const imageStatus = async (who) =>
    (
      await worker.fetch(
        new Request(`${origin}${image.light}`, {
          headers: { authorization: `Bearer ${p.tokens[who]}` },
        }),
        p.w.env,
      )
    ).status;
  // The image route decides as page_cards does, from the reader's Catalog:
  // the owner loads it; a member gets 404 and keeps the JSON card.
  assert.equal(await imageStatus("owner"), 200);
  assert.equal(await imageStatus("member"), 404);
  assert.equal(await imageStatus("stranger"), 404);
});

test("Project routes: signed out, OAuth, upload capabilities and foreign fetches are refused", async (t) => {
  const p = await projectWorld(t);
  const reached = [];
  const projects = p.w.env.PROJECTS;
  p.w.env.PROJECTS = {
    getByName: (name) => (reached.push(name), projects.getByName(name)),
  };
  const bodies = new Set();
  for (const target of [p.projectId, `prj_${crypto.randomUUID()}`, "not-a-project"])
    for (const file of ["meta", "card"]) {
      const answer = await p.getProject(null, target, file);
      assert.equal(answer.status, 401, answer.text);
      assert.equal(answer.body.code, "auth_required");
      assert.equal(answer.headers.get("cache-control"), "private, no-store");
      bodies.add(answer.text);
    }
  assert.equal(bodies.size, 1);
  for (const authorization of ["Pages-Upload pu1.a.b", "Bearer pu1.a.b"]) {
    const refused = await p.getProject(null, p.projectId, "meta", { headers: { authorization } });
    assert.equal(refused.status, 401, authorization);
  }
  for (const site of ["same-site", "cross-site"]) {
    const refused = await p.getProject("owner", p.projectId, "meta", {
      headers: { "sec-fetch-site": site },
    });
    assert.equal(refused.status, 403, site);
    assert.doesNotMatch(refused.text, /Launch/);
  }
  assert.deepEqual(reached, [], "no refusal before authentication reaches the Project");
  for (const site of ["same-origin", "none"])
    assert.equal(
      (await p.getProject("owner", p.projectId, "meta", { headers: { "sec-fetch-site": site } }))
        .status,
      200,
    );
  const clientId = "https://chatgpt.com/oauth/client.json";
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const verifier = "v".repeat(43);
  const env = { ...p.w.env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin };
  const { code } = await issueAuthorizationCode(env, {
    clientId,
    redirectUri,
    resource: `${origin}/mcp`,
    scope: "pages:read pages:write offline_access",
    codeChallenge: await secretHash(verifier),
    identity: { principal: p.w.owner, namespace, displayName: "Fixture" },
  });
  const { access_token: token } = await exchangeAuthorizationCode(env, {
    code,
    clientId,
    redirectUri,
    resource: `${origin}/mcp`,
    codeVerifier: verifier,
  });
  for (const file of ["meta", "card"]) {
    const refused = await p.getProject(token, p.projectId, file);
    assert.equal(refused.status, 403, refused.text);
    assert.doesNotMatch(refused.text, /Launch/);
  }
});

test("a browser session cookie reads a Project's routes; sign-out everywhere doesn't", async (t) => {
  const p = await projectWorld(t);
  await p.projectRole(p.projectId, "member", "commenter");
  const cookie = await browserSession(p, p.w.member);
  const browser = (file, headers = {}) =>
    p.getProject(null, p.projectId, file, {
      headers: { cookie, "sec-fetch-site": "same-origin", ...headers },
    });
  for (const file of ["meta", "card"]) {
    const answer = await browser(file);
    assert.equal(answer.status, 200, `${file}: ${answer.text}`);
    assert.equal(answer.body.project_id, p.projectId, file);
  }
  assert.equal((await browser("meta")).body.role, "commenter");
  const foreign = await p.getProject(null, p.projectId, "meta", {
    headers: { cookie, origin: "https://evil.example" },
  });
  assert.equal(foreign.status, 403);
  const out = await worker.fetch(
    new Request(`${origin}/api/auth/logout-all`, { method: "POST", headers: { cookie, origin } }),
    p.w.env,
  );
  assert.equal(out.status, 200, await out.clone().text());
  for (const file of ["meta", "card"]) {
    const signedOut = await browser(file);
    assert.equal(signedOut.status, 401, file);
    assert.doesNotMatch(signedOut.text, /Launch/);
  }
});

// ---------------------------------------------------------------------------
// In the Page host, on a host that hasn't booted (page-startup.mjs). Hosts
// are built by the real constructor over trash-fixture.mjs's storage; boots
// are counted.

const observedAt = "2026-10-20T10:00:00.000Z";
const contentAt = "2026-10-21T10:00:00.000Z";

async function hosts(t, options = {}) {
  const f = await fixture(t, options);
  let boots = 0;
  const host = { f, boots: () => boots };
  const handleOf = (doc) => ({ doc, broadcast() {}, on() {}, off() {} });
  t.mock.method(Page.prototype, "initializeRepo", async function () {
    boots++;
    this.policy = new DocumentPolicy({ metadata: () => this.metadata });
    this.serverSenderId = "server-sender";
    this.repo = {
      find: async () => handleOf(f.doc),
      import: async (_bytes, { docId } = {}) =>
        handleOf(docId === f.initial.documentId ? f.doc : f.commentsDoc),
      async delete() {},
      async flush() {},
    };
    this.plain = plainStub(this.repo);
    this.commentsUuid = commentsUuid;
  });
  host.cold = () =>
    new Page(
      {
        id: { name: fixturePageId },
        storage: f.storage,
        blockConcurrencyWhile: (fn) => fn(),
        waitUntil: (promise) => f.tasks.push(promise),
      },
      f.env,
    );
  host.record = (metadata) => f.storage.put("host/document", metadata);
  await host.record(f.initial);
  await f.storage.put("host/title-projection", {
    title: "Launch plan",
    observed_at: observedAt,
    keep: true,
  });
  await f.storage.put(CONTENT_ACTIVITY_KEY, { content_updated_at: contentAt });
  /** A link preview check as `who` (a token name), or as `identity`. */
  host.preview = async (page, who, identity) => {
    if (identity) page.linkIdentity = async () => identity;
    const response = await page.fetch(
      f.request(f.tokens[who] ?? f.tokens.owner, LINK_PREVIEW_PATH, {}),
    );
    return { status: response.status, body: await response.json() };
  };
  /** A fresh host that hasn't booted. */
  host.lazy = async () => {
    const page = host.cold();
    await page.ready;
    assert.equal(page.startup.name, "metadata");
    return page;
  };
  /** The storage's values, to show a check wrote nothing. */
  host.values = () => JSON.stringify([...f.storage.values]);
  return host;
}

const answered = (role, state = "active") => ({
  status: 200,
  body: {
    page_id: fixturePageId,
    title: "Launch plan",
    state,
    role,
    content_updated_at: contentAt,
  },
});
const refused = { status: 404, body: PAGE_UNAVAILABLE };

test("from the record, every relation reads its role, with no boot and no writes", async (t) => {
  for (const memberRole of ["viewer", "commenter", "editor"]) {
    const h = await hosts(t, { memberRole });
    const before = h.values();
    const page = await h.lazy();
    assert.deepEqual(await h.preview(page, "member"), answered(memberRole));
    assert.deepEqual(await h.preview(page, "owner"), answered("owner"));
    assert.deepEqual(await h.preview(page, "stranger"), refused);
    assert.equal(h.boots(), 0);
    assert.equal(page.startup.name, "metadata");
    await Promise.allSettled(h.f.tasks.splice(0));
    assert.equal(h.values(), before);
    // A booted host gives the same answers.
    await page.documentReady();
    assert.deepEqual(await h.preview(page, "member"), answered(memberRole));
  }
});

test("a company reader reads from the record; an expired lease is refused", async (t) => {
  const h = await hosts(t);
  await h.record({
    ...h.f.initial,
    acl: { ...h.f.initial.acl, domainView: { domain: "example.com", namespace } },
  });
  const identity = {
    principal: `${namespace}:company-reader`,
    namespace,
    displayName: "Reader",
    driver: "Browser",
    canWrite: false,
    expiresAt: Date.now() + 60_000,
    domainAccess: { domain: "example.com", namespace, expiresAt: Date.now() + 30_000 },
  };
  const page = await h.lazy();
  assert.deepEqual(await h.preview(page, "reader", identity), answered("viewer"));
  const expired = { ...identity, domainAccess: { ...identity.domainAccess, expiresAt: 1 } };
  assert.deepEqual(await h.preview(page, "reader", expired), refused);
  assert.equal(h.boots(), 0);
});

test("a pending invitee is refused like a stranger, and the invitation stays pending", async (t) => {
  const h = await hosts(t);
  const { metadata } = await proposeSharingMutation(
    h.f.initial,
    { principal: h.f.owner, namespace, canWrite: true, expiresAt: Date.now() + 60_000 },
    {
      action: "invite",
      email: "invitee@example.com",
      role: "viewer",
      expected_revision: 1,
      nonce: "preview-invite",
    },
    Date.now(),
  );
  await h.record(metadata);
  const before = h.values();
  const invitee = {
    principal: `${namespace}:invitee`,
    namespace,
    displayName: "Invitee",
    driver: "Browser",
    canWrite: true,
    expiresAt: Date.now() + 60_000,
    // The invited address: opening the Page would claim it.
    verifiedEmail: "invitee@example.com",
  };
  const page = await h.lazy();
  assert.deepEqual(await h.preview(page, "invitee", invitee), refused);
  // A loaded host doesn't claim it either.
  await page.documentReady();
  assert.deepEqual(await h.preview(page, "invitee", invitee), refused);
  await Promise.allSettled(h.f.tasks.splice(0));
  assert.equal(h.values(), before);
  const stored = await h.f.storage.get("host/document");
  assert.equal(stored.acl.members[invitee.principal], undefined);
  assert.equal(Object.keys(stored.acl.invites).length, 1);
});

test("Trash answers only the owner, as trashed; deletion refuses everyone; neither boots", async (t) => {
  const h = await hosts(t);
  const now = new Date().toISOString();
  await h.record({
    ...h.f.initial,
    deleted: true,
    lifecycleRevision: 1,
    trash: trashRecord({
      pageId: fixturePageId,
      principal: h.f.owner,
      now,
      receipt: { page_id: fixturePageId, state: "trashed", trashed: true, title: "Launch plan" },
    }),
  });
  let page = await h.lazy();
  assert.deepEqual(await h.preview(page, "owner"), answered("owner", "trashed"));
  assert.deepEqual(await h.preview(page, "member"), refused);
  assert.deepEqual(await h.preview(page, "stranger"), refused);
  assert.equal(h.boots(), 0);

  await h.f.storage.delete("host/title-projection");
  await h.record({
    ...h.f.initial,
    deleted: true,
    lifecycleRevision: 2,
    purged: { purged_at: now, purged_by: h.f.owner },
    deletion: { key: "host/operation/purge", fingerprint: "f", receipt: { deleted: true } },
  });
  page = await h.lazy();
  for (const who of ["owner", "member", "stranger"])
    assert.deepEqual(await h.preview(page, who), refused, who);
  assert.equal(h.boots(), 0);
});

test("without a usable stored title, refusals still don't boot; an admitted reader does, once", async (t) => {
  for (const [label, setup] of [
    ["no stored title", (h) => h.f.storage.delete("host/title-projection")],
    [
      "a projection not yet seen to land",
      (h) => h.f.storage.put("host/title-projection/pending", true),
    ],
  ]) {
    const h = await hosts(t);
    await setup(h);
    const page = await h.lazy();
    const documentReady = t.mock.method(page, "documentReady");
    assert.deepEqual(await h.preview(page, "stranger"), refused, label);
    assert.equal(documentReady.mock.callCount(), 0, label);
    assert.equal(h.boots(), 0, label);
    const member = await h.preview(page, "member");
    assert.equal(member.status, 200, label);
    assert.equal(member.body.title, "Launch plan", label);
    assert.equal(h.boots(), 1, label);
    assert.equal(documentReady.mock.callCount(), 1, label);
    // Booted now: the stranger is still refused, and nothing boots again.
    assert.deepEqual(await h.preview(page, "stranger"), refused, label);
    assert.equal(h.boots(), 1, label);
  }
});

test("a Page whose recovery is blocked answers its readers, as opening it read only does", async (t) => {
  const h = await hosts(t);
  const page = await h.lazy();
  await page.documentReady();
  page.recoveryBlocked = { code: "page_recovery_blocked", pending: true, message: "Blocked" };
  for (const [who, role] of [
    ["member", "editor"],
    ["owner", "owner"],
  ]) {
    const answer = await h.preview(page, who);
    assert.equal(answer.status, 200, who);
    assert.equal(answer.body.role, role, who);
  }
  assert.deepEqual(await h.preview(page, "stranger"), refused);
});

test("a missing record refuses", async (t) => {
  const h = await hosts(t);
  await h.f.storage.delete("host/document");
  const missing = h.cold();
  await missing.ready;
  assert.deepEqual(await h.preview(missing, "owner"), refused);
  assert.equal(h.boots(), 0);
});

test("a boot another request starts during the check still answers an admitted reader", async (t) => {
  // /api/sync and /api/saved skip the queue, so a boot can start while the
  // check reads storage. Here one starts from inside the projection read.
  for (const finish of ["booting", "booted"]) {
    const h = await hosts(t);
    await h.f.storage.delete("host/title-projection");
    const page = await h.lazy();
    const get = h.f.storage.get.bind(h.f.storage);
    let started = null;
    t.mock.method(h.f.storage, "get", async (key) => {
      if (key === "host/title-projection" && !started) {
        started = page.documentReady();
        // Either still booting when the check looks again, or already done.
        if (finish === "booted") await started;
      }
      return get(key);
    });
    const member = await h.preview(page, "member");
    assert.equal(member.status, 200, `${finish}: ${JSON.stringify(member.body)}`);
    assert.equal(member.body.title, "Launch plan", finish);
    assert.equal(member.body.role, "editor", finish);
    await started;
    assert.equal(h.boots(), 1, `${finish}: one boot, the other request's`);
    // A stranger checked under the same race is still refused.
    assert.deepEqual(await h.preview(page, "stranger"), refused, finish);
  }
});

test("a host binding that fails to set up refuses like any other host failure", async () => {
  // A missing binding or a bad origin setting must not escape as a 500: it
  // answers null, which the route turns into the kind's one 404.
  const failures = [];
  const logFailure = (error, stage) => failures.push(stage);
  const broken = {
    getByName() {
      throw new Error("binding unavailable");
    },
  };
  const request = new Request("https://pages.example/p/x/meta.json", {
    headers: { authorization: "Bearer key" },
  });
  const env = {
    PAGES: broken,
    PROJECTS: broken,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example",
  };
  const pageId = "a5531f64-5dcc-4696-9e97-0ca58113b61b";
  const projectId = "prj_83b8d037-6749-448e-95d9-4c1ac8e530f9";
  assert.equal(await checkLinkPreview(request, env, pageId, { logFailure }), null);
  assert.equal(await checkProjectPreview(request, env, projectId, { logFailure }), null);
  assert.deepEqual(failures, ["link-preview", "project-link-preview"]);
});
