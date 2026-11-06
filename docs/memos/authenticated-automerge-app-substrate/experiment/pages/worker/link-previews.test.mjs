import assert from "node:assert/strict";
import { test } from "node:test";
import { secretHash } from "@cloud/oidc-session-store.ts";
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
  foreignFetch,
  readLinkRoute,
  tagMatches,
} from "./link-previews.mjs";
import { cardKey, pageCard } from "../model/page-card.mjs";

const origin = "https://pages.invalid";
const namespace = "user:anaconda-fixture";
const UNAVAILABLE = JSON.stringify(PAGE_UNAVAILABLE);

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
  /** One request to a link route. `who` null sends no credential. */
  const get = async (who, id, file = "meta", { method = "GET", headers = {} } = {}) => {
    const response = await worker.fetch(
      new Request(`${origin}/p/${id}/${file}.json`, {
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
      base_heads: w.heads(id),
      idempotency_key: w.key(),
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
      idempotency_key: w.key(),
    });
    assert.equal(purged.status, 200, JSON.stringify(purged.body));
    await settle();
  };
  return { w, assets, tokens, principal, get, settle, create, seedCard, setRole, trash, purge };
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
    idempotency_key: l.w.key(),
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

test("answers carry an ETag; a match is a 304, and the access check still runs", async (t) => {
  const l = await linksWorld(t);
  const id = await l.create("Versioned plan");
  await l.setRole(id, "member", "viewer");
  const first = await l.get("member", id);
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  for (const [name, value] of [
    ["content-type", "application/json"],
    ["cache-control", "private, no-cache"],
    ["vary", "Cookie, Authorization"],
    ["cross-origin-resource-policy", "same-origin"],
    ["x-content-type-options", "nosniff"],
  ])
    assert.equal(first.headers.get(name), value, name);
  assert.equal(first.headers.get("access-control-allow-origin"), null);
  for (const match of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
    const again = await l.get("member", id, "meta", { headers: { "if-none-match": match } });
    assert.equal(again.status, 304, match);
    assert.equal(again.text, "");
    assert.equal(again.headers.get("etag"), etag);
    assert.equal(again.headers.get("cache-control"), "private, no-cache");
  }
  assert.equal(
    (await l.get("member", id, "meta", { headers: { "if-none-match": '"other"' } })).status,
    200,
  );
  // HEAD: the same headers, no body.
  const head = await l.get("member", id, "meta", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assert.equal(head.headers.get("etag"), etag);
  assert.equal((await l.get("member", id, "card", { method: "HEAD" })).status, 200);
  // A new title is a new tag.
  l.w.page(id).handle.doc = ((doc) => () => ({ ...doc(), title: "Renamed plan" }))(
    l.w.page(id).handle.doc,
  );
  const renamed = await l.get("member", id, "meta", { headers: { "if-none-match": etag } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.title, "Renamed plan");
  assert.notEqual(renamed.headers.get("etag"), etag);
  // A revoked reader holding the tag is refused, never told 304.
  await l.setRole(id, "member", null);
  const revoked = await l.get("member", id, "meta", {
    headers: { "if-none-match": renamed.headers.get("etag") },
  });
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
        idempotency_key: l.w.key(),
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

test("only the two JSON paths are routes; the gateway never forwards the host's route", async (t) => {
  assert.deepEqual(readLinkRoute(`/p/${fixturePageId}/meta.json`), {
    pageId: fixturePageId,
    file: "meta",
  });
  assert.deepEqual(readLinkRoute(`/p/x/card.json`), { pageId: "x", file: "card" });
  for (const path of [
    `/p/${fixturePageId}`,
    `/p/${fixturePageId}/`,
    `/p/${fixturePageId}/meta.json/`,
    `/p/${fixturePageId}/meta.jsonx`,
    `/p/${fixturePageId}/other.json`,
    `/p/${fixturePageId}/meta.json/card.json`,
    `/p//x/meta.json`,
    `/project/prj_${fixturePageId}/meta.json`,
  ])
    assert.equal(readLinkRoute(path), null, path);
  assert.ok(tagMatches('W/"a", "b"', '"b"'));
  assert.ok(!tagMatches(null, '"b"'));
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
      idempotency_key: "preview-invite",
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

test("a loaded host whose recovery is blocked refuses; a missing record refuses", async (t) => {
  const h = await hosts(t);
  const page = await h.lazy();
  await page.documentReady();
  page.recoveryBlocked = { code: "page_recovery_blocked", pending: true, message: "Blocked" };
  assert.deepEqual(await h.preview(page, "member"), refused);
  assert.deepEqual(await h.preview(page, "owner"), refused);
  await h.f.storage.delete("host/document");
  const missing = h.cold();
  await missing.ready;
  assert.deepEqual(await h.preview(missing, "owner"), refused);
  assert.equal(h.boots(), 1);
});
