import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import worker, { Catalog, Page, Space, lifecycleBounds } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { pageState, proposeAccessUpdate } from "./access.mjs";
import { CATALOG_MIGRATIONS, migrateCatalogIndex, reportPageIndex } from "./catalog-index.mjs";
import { MAX_DEPTH, validSpaceId } from "./spaces.mjs";
import { tools } from "../mcp.mjs";

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
  async list({ prefix = "", startAfter, limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit),
    );
  }
}

/** Real Catalog, Space and Page hosts over in-memory storage. Page hosts stub
 * only native sync: documents load from the bytes the Page records. */
async function world(t, { index = "1" } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const owner = `user:anaconda-fixture:${auth.subject}`;
  const member = "user:anaconda-fixture:member-user";
  const tokens = {
    owner: auth.apiKey(),
    member: auth.apiKey({ userId: "member-user" }),
    stranger: auth.apiKey({ userId: "stranger-user" }),
    reader: auth.apiKey({ scopes: ["cloud:read"] }),
  };
  const db = sqliteD1(t).open();
  const pages = new Map();
  const spaces = new Map();
  const catalogs = new Map();
  const jobs = [];
  // Inject a failure into the next request to one object: "before" fails
  // without reaching it, "lost" drops the response after it ran.
  const faults = new Map();
  // Runs before every lifecycle-state read; a test can delay or stall it.
  const hooks = { lifecycle: null };
  // A hook may return a Response to answer in the Page's place.
  const faulty = (id, target) => ({
    fetch: async (request, init) => {
      if (hooks.lifecycle && new URL(request.url).pathname === "/internal/lifecycle-state") {
        const replaced = await hooks.lifecycle(id, init?.signal);
        if (replaced instanceof Response) return replaced;
      }
      const fault = faults.get(id);
      if (fault === "before") {
        faults.delete(id);
        return Response.json({ error: "Injected outage" }, { status: 500 });
      }
      const response = await target().fetch(request);
      if (fault === "lost") {
        faults.delete(id);
        return Response.json({ error: "Lost response" }, { status: 500 });
      }
      return response;
    },
  });
  const env = {
    ...auth.env,
    DB: db,
    ...(index && { PAGES_CATALOG_INDEX: index }),
    PAGES: { getByName: (id) => faulty(id, () => pageHost(id)) },
    SPACES: {
      getByName: (id) =>
        faulty(id, () => {
          if (!spaces.has(id))
            spaces.set(id, new Space({ id: { name: id }, storage: new Storage() }, env));
          return spaces.get(id);
        }),
    },
    CATALOGS: {
      getByName(principal) {
        if (!catalogs.has(principal))
          catalogs.set(
            principal,
            new Catalog({ id: { name: principal }, storage: new Storage() }, env),
          );
        return catalogs.get(principal);
      },
    },
  };
  function pageHost(id) {
    if (pages.has(id)) return pages.get(id);
    const storage = new Storage();
    let doc;
    const handle = { doc: () => doc, broadcast() {}, on() {}, off() {} };
    const page = Object.assign(Object.create(Page.prototype), {
      env,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      ctx: { id: { name: id }, storage, waitUntil: (promise) => jobs.push(promise) },
      wires: new Set(),
      serverKey: "f".repeat(64),
      serverSenderId: "server-sender",
      repo: {
        async import(bytes) {
          doc = A.load(bytes);
          return handle;
        },
        async flush() {},
        async delete() {},
      },
      backend: { async flush() {} },
    });
    page.policy = new DocumentPolicy({
      storage,
      metadata: () => page.policyMetadata ?? page.metadata,
      serverKey: "f".repeat(64),
    });
    pages.set(id, page);
    return page;
  }
  const request = (who, path, body) =>
    new Request(`https://pages.invalid${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens[who]}`, "x-pages-driver": "Spaces test" },
      body: JSON.stringify(body),
    });
  /** The public HTTP tool route, through the gateway. */
  const call = async (who, operation, args = {}) => {
    const response = await worker.fetch(
      request(who, "/api/tools", { operation, arguments: args }),
      env,
    );
    return { status: response.status, body: await response.json() };
  };
  let keys = 0;
  const key = () => `spaces-test-${++keys}-${crypto.randomUUID()}`;
  const createSpace = async (title = "Launch", description) => {
    const created = await call("owner", "create_space", {
      title,
      ...(description !== undefined && { description }),
      idempotency_key: key(),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body;
  };
  const createPage = async (args, who = "owner") => {
    const created = await call(who, "create_page", {
      title: "Untitled",
      idempotency_key: key(),
      ...args,
    });
    return created;
  };
  const heads = (pageId) => A.getHeads(pages.get(pageId).handle.doc());
  const catalogStorage = (principal = owner) => env.CATALOGS.getByName(principal).ctx.storage;
  return {
    auth,
    owner,
    member,
    env,
    db,
    pages,
    spaces,
    faults,
    hooks,
    jobs,
    call,
    key,
    createSpace,
    createPage,
    heads,
    catalogStorage,
    page: (id) => pages.get(id),
    catalog: (principal = owner) => env.CATALOGS.getByName(principal),
  };
}

const ids = (listing) => listing.body.pages.map((page) => page.page_id).sort();

test("a Space is created with its home Page, then read, listed and updated", async (t) => {
  const w = await world(t);
  const space = await w.createSpace("Launch", "Ship the beta on Friday.");
  assert.ok(validSpaceId(space.space_id));
  assert.equal(space.title, "Launch");
  assert.equal(space.description, "Ship the beta on Friday.");
  assert.equal(space.role, "owner");
  assert.equal(space.revision, 0);

  const home = w.page(space.home_page_id);
  assert.deepEqual(home.metadata.placement, {
    space_id: space.space_id,
    parent_id: null,
    position: "a0",
    placement_epoch: 0,
    home: true,
  });
  assert.equal(home.metadata.owner, w.owner);

  const read = await w.call("owner", "get_space", { space_id: space.space_id });
  assert.equal(read.status, 200);
  assert.equal(read.body.home_page_id, space.home_page_id);

  const listed = await w.call("owner", "list_spaces");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.spaces.map((entry) => entry.space_id),
    [space.space_id],
  );
  assert.ok(listed.body.retry_token);

  const homeRead = await w.call("owner", "read_page", {
    page_id: space.home_page_id,
    include_content: false,
  });
  assert.equal(homeRead.status, 200);
  assert.equal(homeRead.body.space_id, space.space_id);
  assert.equal(homeRead.body.parent_id, null);
  assert.equal(homeRead.body.home, true);
  assert.equal(homeRead.body._placement, undefined);
  assert.deepEqual(homeRead.body.breadcrumbs, [
    { kind: "space", space_id: space.space_id, title: "Launch" },
  ]);

  const updateKey = w.key();
  const update = { space_id: space.space_id, title: "Launch v2", expected_revision: 0 };
  const updated = await w.call("owner", "update_space", { ...update, idempotency_key: updateKey });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.title, "Launch v2");
  assert.equal(updated.body.revision, 1);
  const replay = await w.call("owner", "update_space", { ...update, idempotency_key: updateKey });
  assert.deepEqual(replay.body, updated.body);
  const conflict = await w.call("owner", "update_space", {
    ...update,
    title: "Other",
    idempotency_key: updateKey,
  });
  assert.equal(conflict.status, 409);
  const stale = await w.call("owner", "update_space", { ...update, idempotency_key: w.key() });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "space_revision_conflict");
  assert.equal(
    (await w.call("owner", "list_spaces")).body.spaces[0].title,
    "Launch v2",
    "the owner's listing follows the Space record",
  );

  // Another account cannot tell this Space from a missing one.
  const missing = `sp_${crypto.randomUUID()}`;
  for (const target of [space.space_id, missing]) {
    const denied = await w.call("member", "get_space", { space_id: target });
    assert.equal(denied.status, 404);
    assert.deepEqual(denied.body, { error: "Space not found", code: "space_not_found" });
  }
  assert.equal(
    (await w.call("member", "update_space", { ...update, idempotency_key: w.key() })).status,
    404,
  );
  assert.deepEqual((await w.call("member", "list_spaces")).body.spaces, []);
  // A read-only credential reads but cannot create or change a Space.
  assert.equal((await w.call("reader", "list_spaces")).status, 200);
  assert.equal(
    (await w.call("reader", "create_space", { title: "No", idempotency_key: w.key() })).status,
    403,
  );
});

test("tools name the right argument when a Space ID and a Page ID are swapped", async (t) => {
  const w = await world(t);
  const space = await w.createSpace();
  const pageId = space.home_page_id;
  const cases = [
    ["read_page", { page_id: space.space_id }, "space_id_as_page_id", /get_space/],
    ["patch_page", { page_id: space.space_id }, "space_id_as_page_id", /get_space/],
    [
      "delete_page",
      { page_id: space.space_id, base_heads: [], idempotency_key: w.key() },
      "space_id_as_page_id",
      /get_space/,
    ],
    ["get_space", { space_id: pageId }, "page_id_as_space_id", /read_page/],
    [
      "update_space",
      { space_id: pageId, title: "x", idempotency_key: w.key() },
      "page_id_as_space_id",
      /read_page/,
    ],
    ["list_pages", { space_id: pageId }, "page_id_as_space_id", /parent_id/],
    ["list_pages", { parent_id: space.space_id }, "space_id_as_page_id", /space_id/],
    [
      "create_page",
      { title: "x", parent_id: space.space_id, idempotency_key: w.key() },
      "space_id_as_page_id",
      /space_id/,
    ],
    [
      "create_page",
      { title: "x", space_id: pageId, idempotency_key: w.key() },
      "page_id_as_space_id",
      /parent_id/,
    ],
  ];
  for (const [operation, args, code, hint] of cases) {
    const result = await w.call("owner", operation, args);
    assert.equal(result.status, 400, `${operation} ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, code, operation);
    assert.match(result.body.error, hint, operation);
  }
  // Nothing was created by the rejected calls.
  assert.equal(
    [...(await w.catalogStorage().list({ prefix: "page/" })).keys()].length,
    1,
    "only the home Page exists",
  );
});

test("an interrupted create_space resumes the same Space and home Page on retry", async (t) => {
  const w = await world(t);
  const args = { title: "Recovery", idempotency_key: "space-recovery-key" };
  // The Space record commits, then the home Page creation fails.
  const originalPages = w.env.PAGES.getByName;
  let failHome = true;
  w.env.PAGES.getByName = (id) => {
    const stub = originalPages(id);
    return {
      fetch: async (request) => {
        if (failHome && new URL(request.url).pathname === "/internal/create") {
          failHome = false;
          return Response.json({ error: "Injected crash" }, { status: 500 });
        }
        return stub.fetch(request);
      },
    };
  };
  const first = await w.call("owner", "create_space", args);
  assert.equal(first.status, 500);
  const storage = w.catalogStorage();
  const intent = await storage.get("host/operation/space-recovery-key");
  assert.equal(intent.pending, true);
  assert.equal(intent.phase, "space_recorded", "the retry resumes after the Space record");
  assert.equal(w.spaces.get(intent.spaceId) !== undefined, true, "the Space record exists");
  assert.equal(w.page(intent.pageId)?.metadata, undefined, "the home Page does not");
  assert.equal((await storage.get(`space/${intent.spaceId}`)).pending, true);
  assert.deepEqual((await w.call("owner", "list_spaces")).body.spaces, []);
  const pending = await w.call("owner", "get_space", { space_id: intent.spaceId });
  assert.equal(pending.status, 409);
  assert.equal(pending.body.code, "space_pending");

  // The retry resumes at the home Page. A lost response after the Page
  // committed is safe to retry too.
  w.faults.set(intent.pageId, "lost");
  assert.equal((await w.call("owner", "create_space", args)).status, 500);
  assert.ok(w.page(intent.pageId).metadata, "the home Page committed");
  assert.equal((await storage.get("host/operation/space-recovery-key")).phase, "space_recorded");

  const retry = await w.call("owner", "create_space", args);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.space_id, intent.spaceId);
  assert.equal(retry.body.home_page_id, intent.pageId);
  assert.equal(w.page(intent.pageId).metadata.placement.home, true);
  const again = await w.call("owner", "create_space", args);
  assert.deepEqual(again.body, retry.body);
  assert.equal(
    [...(await storage.list({ prefix: "space/" })).keys()].length,
    1,
    "retries never create a second Space",
  );
  const listed = await w.call("owner", "list_spaces");
  assert.deepEqual(
    listed.body.spaces.map((space) => space.space_id),
    [intent.spaceId],
  );
  const changed = await w.call("owner", "create_space", { ...args, title: "Other" });
  assert.equal(changed.status, 409);
});

test("create_page places Pages in a Space, under a parent, and enforces depth and mismatch", async (t) => {
  const w = await world(t);
  const space = await w.createSpace("Docs");
  const other = await w.createSpace("Other");
  const top = await w.createPage({ title: "Guide", space_id: space.space_id });
  assert.equal(top.status, 200);
  assert.equal(top.body.space_id, space.space_id);
  assert.equal(top.body.parent_id, null);
  const child = await w.createPage({ title: "Install", parent_id: top.body.page_id });
  assert.equal(child.status, 200);
  assert.equal(child.body.space_id, space.space_id, "a parent implies its Space");
  assert.equal(child.body.parent_id, top.body.page_id);
  const sibling = await w.createPage({ title: "Configure", parent_id: top.body.page_id });
  const positions = [child, sibling].map(
    (result) => w.page(result.body.page_id).metadata.placement.position,
  );
  assert.ok(positions[0] < positions[1], "new siblings sort after existing ones");

  const mismatch = await w.createPage({
    title: "Wrong",
    space_id: other.space_id,
    parent_id: top.body.page_id,
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.code, "placement_mismatch");
  const matching = await w.createPage({
    title: "Both",
    space_id: space.space_id,
    parent_id: top.body.page_id,
  });
  assert.equal(matching.status, 200);

  // Depth: a top-level Page is at depth 1; the chain may reach MAX_DEPTH.
  let parent = top.body.page_id;
  for (let depth = 2; depth <= MAX_DEPTH; depth++) {
    const nested = await w.createPage({ title: `Depth ${depth}`, parent_id: parent });
    assert.equal(nested.status, 200, `depth ${depth}`);
    parent = nested.body.page_id;
  }
  const tooDeep = await w.createPage({ title: "Too deep", parent_id: parent });
  assert.equal(tooDeep.status, 400);
  assert.equal(tooDeep.body.code, "nesting_depth_exceeded");

  // Your items can nest too; they have no Space.
  const loose = await w.createPage({ title: "Loose" });
  assert.equal(loose.body.space_id, undefined);
  assert.equal(w.page(loose.body.page_id).metadata.placement, undefined);
  const looseChild = await w.createPage({ title: "Loose child", parent_id: loose.body.page_id });
  assert.equal(looseChild.body.space_id, null);
  assert.equal(looseChild.body.parent_id, loose.body.page_id);

  // Only Spaces and parents the caller owns hold new Pages in this build.
  const foreignSpace = await w.createPage({ title: "No", space_id: space.space_id }, "member");
  assert.equal(foreignSpace.status, 404);
  assert.equal(foreignSpace.body.code, "space_not_found");
  const foreignParent = await w.createPage({ title: "No", parent_id: top.body.page_id }, "member");
  assert.equal(foreignParent.status, 404);
  assert.equal(foreignParent.body.code, "parent_unavailable");
  const unknownSpace = await w.createPage({ title: "No", space_id: `sp_${crypto.randomUUID()}` });
  assert.deepEqual(unknownSpace.body, foreignSpace.body);

  // A caller-supplied placement is ignored; only the resolved one is stored.
  const forged = await w.createPage({
    title: "Forged",
    placement: {
      space_id: other.space_id,
      parent_id: null,
      position: "a0",
      placement_epoch: 0,
      home: true,
    },
  });
  assert.equal(forged.status, 200);
  assert.equal(w.page(forged.body.page_id).metadata.placement, undefined);
});

test("list_pages filters by Space and parent, verifies every row and hides the Space from grantees", async (t) => {
  const w = await world(t);
  const space = await w.createSpace("Team");
  const top = (await w.createPage({ title: "Roadmap", space_id: space.space_id })).body;
  const child = (await w.createPage({ title: "Q4 plan", parent_id: top.page_id })).body;
  const loose = (await w.createPage({ title: "Loose note" })).body;

  const inSpace = await w.call("owner", "list_pages", { space_id: space.space_id });
  assert.equal(inSpace.status, 200);
  assert.deepEqual(ids(inSpace), [space.home_page_id, top.page_id, child.page_id].sort());
  const row = inSpace.body.pages.find((page) => page.page_id === child.page_id);
  assert.equal(row.space_id, space.space_id);
  assert.equal(row.parent_id, top.page_id);
  assert.ok(row.position);
  assert.equal(inSpace.body.pages.find((page) => page.page_id === space.home_page_id).home, true);

  const topLevel = await w.call("owner", "list_pages", {
    space_id: space.space_id,
    parent_id: null,
  });
  assert.deepEqual(ids(topLevel), [space.home_page_id, top.page_id].sort());
  const children = await w.call("owner", "list_pages", { parent_id: top.page_id });
  assert.deepEqual(ids(children), [child.page_id]);
  const all = await w.call("owner", "list_pages");
  assert.ok(ids(all).includes(loose.page_id));
  assert.equal(
    all.body.pages.find((page) => page.page_id === loose.page_id).space_id,
    undefined,
    "Your items keep the original row shape",
  );
  assert.deepEqual(
    (await w.call("owner", "list_pages", { space_id: space.space_id, kind: "notebook" })).body
      .pages,
    [],
  );

  // A stale D1 row cannot list a Page: the owner's entry must agree.
  await w.db
    .prepare("UPDATE pages_catalog_pages SET space_id = ? WHERE page_id = ?")
    .bind(space.space_id, loose.page_id)
    .run();
  assert.ok(
    !ids(await w.call("owner", "list_pages", { space_id: space.space_id })).includes(loose.page_id),
  );

  // A direct grant on the child keeps working without revealing the Space.
  const childHost = w.page(child.page_id);
  const ownerIdentity = { principal: w.owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  const acl = proposeAccessUpdate(childHost.metadata, ownerIdentity, {
    principal: w.member,
    role: "viewer",
    expected_revision: 0,
  }).acl;
  childHost.metadata = { ...childHost.metadata, acl };
  await childHost.ctx.storage.put("host/document", childHost.metadata);
  await w.catalogStorage(w.member).put(`shared/${child.page_id}`, {
    page_id: child.page_id,
    title: "Q4 plan",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    shared: true,
  });
  const shared = await w.call("member", "list_pages");
  assert.deepEqual(ids(shared), [child.page_id]);
  assert.equal(shared.body.pages[0].space_id, undefined);
  assert.equal(shared.body.pages[0].parent_id, undefined);
  const hidden = await w.call("member", "list_pages", { space_id: space.space_id });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.code, "space_not_found");
  const parentHidden = await w.call("member", "list_pages", { parent_id: top.page_id });
  assert.equal(parentHidden.status, 404);
  const memberRead = await w.call("member", "read_page", {
    page_id: child.page_id,
    include_content: false,
  });
  assert.equal(memberRead.status, 200);
  assert.equal(memberRead.body.space_id, undefined);
  assert.equal(memberRead.body.parent_id, undefined);
  assert.deepEqual(memberRead.body.breadcrumbs, []);

  const ownerRead = await w.call("owner", "read_page", {
    page_id: child.page_id,
    include_content: false,
  });
  assert.deepEqual(ownerRead.body.breadcrumbs, [
    { kind: "space", space_id: space.space_id, title: "Team" },
    { kind: "page", page_id: top.page_id, title: "Roadmap" },
  ]);
  assert.equal(ownerRead.body.parent_id, top.page_id);

  // The same filters work from Catalog entries while the index is off.
  delete w.env.PAGES_CATALOG_INDEX;
  const fallback = await w.call("owner", "list_pages", { space_id: space.space_id });
  assert.deepEqual(ids(fallback), ids(inSpace));
  assert.deepEqual(
    (await w.call("owner", "list_spaces")).body.spaces.map((entry) => entry.space_id),
    [space.space_id],
  );
});

test("list_spaces pages with a cursor and confirms D1 candidates against the Catalog", async (t) => {
  const w = await world(t);
  const created = [];
  for (let index = 0; index < 3; index++) created.push(await w.createSpace(`Space ${index}`));
  const first = await w.call("owner", "list_spaces", { limit: 2 });
  assert.equal(first.body.spaces.length, 2);
  assert.ok(first.body.next_cursor);
  const second = await w.call("owner", "list_spaces", { limit: 2, cursor: first.body.next_cursor });
  assert.equal(second.body.spaces.length, 1);
  assert.equal(second.body.next_cursor, null);
  assert.deepEqual(
    [...first.body.spaces, ...second.body.spaces].map((space) => space.space_id).sort(),
    created.map((space) => space.space_id).sort(),
  );
  // A list_pages cursor does not open a Space listing.
  assert.equal(
    (
      await w.call("owner", "list_spaces", {
        cursor: (await w.call("owner", "list_pages", { limit: 1 })).body.next_cursor,
      })
    ).status,
    400,
  );
  // A D1 row without a Catalog entry never lists.
  await w.db
    .prepare(
      `INSERT INTO pages_catalog_spaces
        (space_id, owner, title, title_search, home_page_id, created_at, updated_at)
      VALUES (?, ?, 'Ghost', 'ghost', ?, ?, ?)`,
    )
    .bind(
      `sp_${crypto.randomUUID()}`,
      w.owner,
      crypto.randomUUID(),
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:00:00.000Z",
    )
    .run();
  const listed = await w.call("owner", "list_spaces");
  assert.equal(listed.body.spaces.length, 3);
  assert.ok(listed.body.spaces.every((space) => space.title !== "Ghost"));
});

test("Trash moves one Page at a time; restore returns a Page to its parent or the Space top level", async (t) => {
  const w = await world(t);
  const space = await w.createSpace("Wiki");
  const a = (await w.createPage({ title: "A", space_id: space.space_id })).body.page_id;
  const b = (await w.createPage({ title: "B", parent_id: a })).body.page_id;
  const c = (await w.createPage({ title: "C", parent_id: b })).body.page_id;
  const storage = w.catalogStorage();
  const trash = (pageId, idempotency_key = w.key()) =>
    w.call("owner", "delete_page", {
      page_id: pageId,
      base_heads: w.heads(pageId),
      idempotency_key,
    });
  const restore = (pageId) =>
    w.call("owner", "restore_page", { page_id: pageId, idempotency_key: w.key() });

  const refused = await trash(a, "parent-with-children");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "page_has_children");
  assert.match(refused.body.error, /sub-pages first/);
  assert.equal(pageState(w.page(a).metadata), "active");
  assert.equal(await storage.get(`trash/${a}`), undefined, "no trash slot was reserved");
  assert.equal(await storage.get("host/operation/parent-with-children"), undefined);

  for (const pageId of [c, b, a]) {
    const trashed = await trash(pageId);
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
    assert.equal(w.page(pageId).metadata.trash.root_page_id, pageId);
    assert.equal(w.page(pageId).metadata.trash.reason, "page");
  }
  const orphan = await w.createPage({ title: "Under trash", parent_id: a });
  assert.equal(orphan.status, 409);
  assert.equal(orphan.body.code, "parent_unavailable");

  // B's parent is in Trash, so B returns to the Space's top level.
  const back = await restore(b);
  assert.equal(back.status, 200);
  assert.equal(back.body.parent_id, null);
  assert.equal(back.body.space_id, space.space_id);
  assert.equal(pageState(w.page(a).metadata), "trashed", "restoring B leaves A in Trash");
  assert.equal(w.page(b).metadata.placement.parent_id, null);
  assert.equal(w.page(b).metadata.placement.placement_epoch, 1);
  const entry = await storage.get(`page/${b}`);
  assert.equal(entry.parent_id, null);
  assert.equal(entry.placement_epoch, 1);
  // C's parent is active again, so C keeps its place.
  const child = await restore(c);
  assert.equal(child.status, 200);
  assert.equal(child.body.parent_id, b);
  assert.equal(w.page(c).metadata.placement.parent_id, b);
  assert.equal(w.page(c).metadata.placement.placement_epoch, 0);
  assert.deepEqual(
    ids(await w.call("owner", "list_pages", { space_id: space.space_id, parent_id: null })),
    [space.home_page_id, b].sort(),
  );

  const home = await trash(space.home_page_id);
  assert.equal(home.status, 409);
  assert.equal(home.body.code, "home_page_protected");
  assert.equal(pageState(w.page(space.home_page_id).metadata), "active");
});

/** Make the next lifecycle request to a Page apply but fail to answer:
 * "lost" drops the response; "barrier" fails the Page's durability barrier,
 * leaving the transition for the Page to finish on its next request. */
function interrupt(w, pageId, variant) {
  if (variant === "lost") return w.faults.set(pageId, "lost");
  const storage = w.page(pageId).ctx.storage;
  const sync = storage.sync.bind(storage);
  let failures = 1;
  storage.sync = async () => {
    if (failures-- > 0) throw Error("injected barrier failure");
    return sync();
  };
}
async function nested(w) {
  const space = await w.createSpace("Settle");
  const parent = (await w.createPage({ title: "P", space_id: space.space_id })).body.page_id;
  const child = (await w.createPage({ title: "C", parent_id: parent })).body.page_id;
  const trash = (pageId) =>
    w.call("owner", "delete_page", {
      page_id: pageId,
      base_heads: w.heads(pageId),
      idempotency_key: w.key(),
    });
  return { space, parent, child, trash };
}

for (const variant of ["lost", "barrier"])
  test(`a restore that applied without a receipt (${variant}) still counts as a child`, async (t) => {
    const w = await world(t);
    const { parent, child, trash } = await nested(w);
    assert.equal((await trash(child)).status, 200);
    interrupt(w, child, variant);
    const restore = { page_id: child, idempotency_key: `restore-${variant}` };
    assert.ok((await w.call("owner", "restore_page", restore)).status >= 500);
    const storage = w.catalogStorage();
    const slot = await storage.get(`page/${child}`);
    assert.equal(slot.reservation, "restore_page");
    assert.equal(slot.parent_id, parent, "the reservation records where the Page returns");

    // The Page can't answer yet: refuse instead of guessing.
    w.faults.set(child, "before");
    const unsettled = await trash(parent);
    assert.equal(unsettled.status, 409);
    assert.equal(unsettled.body.code, "lifecycle_unsettled");

    const refused = await trash(parent);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "page_has_children");
    assert.equal(pageState(w.page(parent).metadata), "active");
    assert.equal(pageState(w.page(child).metadata), "active");
    assert.equal((await storage.get(`page/${child}`)).reservation, undefined, "settled");
    assert.equal((await w.call("owner", "restore_page", restore)).body.restored, true);
  });

/** Children of one parent, each trashed with a restore reserved but never
 * applied, so a leaf check has to read every child's lifecycle. */
async function unsettledChildren(w, count) {
  const { parent, trash, space } = await nested(w);
  const children = [];
  for (let index = 0; index < count; index++) {
    const child = (await w.createPage({ title: `Child ${index}`, parent_id: parent })).body.page_id;
    assert.equal((await trash(child)).status, 200);
    w.faults.set(child, "before");
    await w.call("owner", "restore_page", { page_id: child, idempotency_key: w.key() });
    children.push(child);
  }
  // nested() made one more child; settle it into Trash too.
  const first = (await w.call("owner", "list_pages", { parent_id: parent })).body.pages;
  for (const page of first) assert.equal((await trash(page.page_id)).status, 200);
  return { parent, trash, space, children };
}

test("a stalled lifecycle read is bounded and refuses the request as retryable", async (t) => {
  const w = await world(t);
  const { parent, trash, children } = await unsettledChildren(w, 1);
  const saved = { ...lifecycleBounds };
  t.after(() => Object.assign(lifecycleBounds, saved));
  Object.assign(lifecycleBounds, { readMs: 50, passMs: 500 });
  // The stall ends only when the Catalog aborts the read.
  w.hooks.lifecycle = async (id, signal) => {
    if (id === children[0])
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
  };
  const started = Date.now();
  const stalled = await trash(parent);
  assert.equal(stalled.status, 409);
  assert.equal(stalled.body.code, "lifecycle_unsettled");
  assert.ok(Date.now() - started < 400, "the read gave up after its own bound");
  assert.equal(pageState(w.page(parent).metadata), "active");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(w.catalog().lifecycleReads.size, 0, "the aborted read freed its slot");
  w.hooks.lifecycle = null;
  assert.equal((await trash(parent)).status, 200, "the retry settles and proceeds");
  assert.equal(w.catalog().lifecycleReads.size, 0, "a settled read frees its slot");
});

test("many slow children share one pass budget and at most four reads at a time", async (t) => {
  const w = await world(t);
  const { parent, trash } = await unsettledChildren(w, 12);
  const saved = { ...lifecycleBounds };
  t.after(() => Object.assign(lifecycleBounds, saved));
  let active = 0;
  let peak = 0;
  w.hooks.lifecycle = async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active--;
  };
  // 12 reads of 40 ms at four at a time need about 120 ms.
  Object.assign(lifecycleBounds, { readMs: 200, passMs: 60 });
  const started = Date.now();
  const exhausted = await trash(parent);
  const elapsed = Date.now() - started;
  assert.equal(exhausted.status, 409);
  assert.equal(exhausted.body.code, "lifecycle_unsettled");
  assert.ok(elapsed < 300, `the pass stopped near its budget (${elapsed} ms)`);
  assert.equal(pageState(w.page(parent).metadata), "active");
  assert.ok(peak <= 4, `at most four reads at once (${peak})`);

  // Reads cut off at the deadline finish in the background; let them drain.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(active, 0);
  peak = 0;
  Object.assign(lifecycleBounds, { passMs: 2000 });
  const settled = await trash(parent);
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(peak, 4);
});

test("back-to-back passes against stalled reads never run more than four reads", async (t) => {
  const w = await world(t);
  const { parent, trash } = await unsettledChildren(w, 6);
  const saved = { ...lifecycleBounds };
  t.after(() => Object.assign(lifecycleBounds, saved));
  Object.assign(lifecycleBounds, { readMs: 30, passMs: 80 });
  // These stalls ignore the abort, like a runtime that can't cancel a fetch.
  let started = 0;
  w.hooks.lifecycle = async () => {
    started++;
    await new Promise(() => {});
  };
  for (let pass = 0; pass < 3; pass++) {
    const result = await trash(parent);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "lifecycle_unsettled");
    assert.ok(w.catalog().lifecycleReads.size <= 4);
  }
  assert.equal(started, 4, "later passes reuse the stalled reads instead of adding more");
  assert.equal(pageState(w.page(parent).metadata), "active");
});

test("a stalled lifecycle body is cancelled and its read frees its slot", async (t) => {
  const w = await world(t);
  const { parent, trash, children } = await unsettledChildren(w, 1);
  const saved = { ...lifecycleBounds };
  t.after(() => Object.assign(lifecycleBounds, saved));
  Object.assign(lifecycleBounds, { readMs: 40, passMs: 500 });
  let cancelled = false;
  w.hooks.lifecycle = async (id) => {
    if (id !== children[0]) return;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"state":'));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  };
  const stalled = await trash(parent);
  assert.equal(stalled.status, 409);
  assert.equal(stalled.body.code, "lifecycle_unsettled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cancelled, true, "the abort cancelled the body");
  assert.equal(w.catalog().lifecycleReads.size, 0);
  w.hooks.lifecycle = null;
  assert.equal((await trash(parent)).status, 200);
});

test("a resumed parent trash that lost its slot runs the leaf guard again", async (t) => {
  const w = await world(t);
  const { space, parent, child, trash } = await nested(w);
  assert.equal((await trash(child)).status, 200);
  const storage = w.catalogStorage();
  const args = { page_id: parent, base_heads: w.heads(parent), idempotency_key: "resumed-trash" };
  // Forwarded, but the request never reached the Page.
  w.faults.set(parent, "before");
  assert.ok((await w.call("owner", "delete_page", args)).status >= 500);
  const intent = await storage.get("host/operation/resumed-trash");
  assert.equal(intent.forwarded, true);
  // The slot expires; counting Trash capacity finds the Page unchanged and
  // releases it.
  const slot = await storage.get(`trash/${parent}`);
  await storage.put(`trash/${parent}`, { ...slot, expires_at: Date.now() - 1 });
  const other = (await w.createPage({ title: "Other", space_id: space.space_id })).body.page_id;
  assert.equal((await trash(other)).status, 200);
  assert.equal(await storage.get(`trash/${parent}`), undefined, "the slot was released");
  const late = await w.createPage({ title: "Late child", parent_id: parent });
  assert.equal(late.status, 200);

  const retried = await w.call("owner", "delete_page", args);
  assert.equal(retried.status, 409);
  assert.equal(retried.body.code, "page_has_children");
  assert.equal(pageState(w.page(parent).metadata), "active");
  assert.equal(await storage.get("host/operation/resumed-trash"), undefined, "released");
  assert.equal(await storage.get(`trash/${parent}`), undefined);
});

test("a resumed trash that already applied still replays its receipt", async (t) => {
  const w = await world(t);
  const { child, trash } = await nested(w);
  const args = { page_id: child, base_heads: w.heads(child), idempotency_key: "applied-trash" };
  w.faults.set(child, "lost");
  assert.ok((await w.call("owner", "delete_page", args)).status >= 500);
  const storage = w.catalogStorage();
  const slot = await storage.get(`trash/${child}`);
  await storage.put(`trash/${child}`, { ...slot, expires_at: Date.now() - 1 });
  const replay = await w.call("owner", "delete_page", args);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.state, "trashed");
  assert.equal(pageState(w.page(child).metadata), "trashed");
  void trash;
});

test("an unapplied restore does not hold its parent, and returns to the top level later", async (t) => {
  const w = await world(t);
  const { space, parent, child, trash } = await nested(w);
  assert.equal((await trash(child)).status, 200);
  w.faults.set(child, "before");
  const restore = { page_id: child, idempotency_key: "restore-never-arrived" };
  assert.ok((await w.call("owner", "restore_page", restore)).status >= 500);
  assert.equal(pageState(w.page(child).metadata), "trashed");
  assert.equal((await trash(parent)).status, 200, "the settled child is still in Trash");
  const retried = await w.call("owner", "restore_page", restore);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.parent_id, null);
  assert.equal(retried.body.space_id, space.space_id);
  assert.equal(w.page(child).metadata.placement.placement_epoch, 1);
});

for (const variant of ["lost", "barrier"])
  test(`a restore after its parent's trash lost its receipt (${variant}) goes to the top level`, async (t) => {
    const w = await world(t);
    const { space, parent, child, trash } = await nested(w);
    assert.equal((await trash(child)).status, 200);
    interrupt(w, parent, variant);
    assert.ok((await trash(parent)).status >= 500);
    const storage = w.catalogStorage();
    assert.equal((await storage.get(`trash/${parent}`)).reservation, "delete_page");
    assert.ok(await storage.get(`page/${parent}`), "the Catalog still lists the parent");
    const restored = await w.call("owner", "restore_page", {
      page_id: child,
      idempotency_key: w.key(),
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.parent_id, null);
    assert.equal(restored.body.space_id, space.space_id);
    assert.equal(pageState(w.page(parent).metadata), "trashed");
    assert.equal((await storage.get(`trash/${parent}`)).reservation, undefined, "settled");
    assert.equal(await storage.get(`page/${parent}`), undefined);
  });

test("a pending child creation blocks its parent's Trash, and a resumed one rechecks its parent", async (t) => {
  const w = await world(t);
  const space = await w.createSpace("Pending");
  const a = (await w.createPage({ title: "A", space_id: space.space_id })).body.page_id;
  const originalPages = w.env.PAGES.getByName;
  let failCreate = true;
  let creates = 0;
  w.env.PAGES.getByName = (id) => {
    const stub = originalPages(id);
    return {
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/internal/create") {
          creates++;
          if (failCreate) {
            failCreate = false;
            return Response.json({ error: "Injected outage" }, { status: 500 });
          }
        }
        return stub.fetch(request);
      },
    };
  };
  const args = { title: "Child", parent_id: a, idempotency_key: "pending-child" };
  assert.equal((await w.call("owner", "create_page", args)).status, 500);
  const storage = w.catalogStorage();
  assert.equal((await storage.get("host/operation/pending-child")).pending, true);
  const blocked = await w.call("owner", "delete_page", {
    page_id: a,
    base_heads: w.heads(a),
    idempotency_key: w.key(),
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "page_has_children");

  // A build without this check trashes the parent anyway.
  const parent = await storage.get(`page/${a}`);
  await storage.delete(`page/${a}`);
  await storage.put(`trash/${a}`, { ...parent, trash_root_id: a });
  const resumed = await w.call("owner", "create_page", args);
  assert.equal(resumed.status, 409);
  assert.equal(resumed.body.code, "parent_unavailable");
  assert.equal(creates, 1, "the resumed creation did not reach a Page");
  assert.equal((await storage.get("host/operation/pending-child")).pending, true);

  await storage.delete(`trash/${a}`);
  await storage.put(`page/${a}`, parent);
  const finished = await w.call("owner", "create_page", args);
  assert.equal(finished.status, 200);
  assert.equal(finished.body.parent_id, a);
});

test("an update_space retry whose receipt was evicted is superseded and never applies", async (t) => {
  const w = await world(t);
  const space = await w.createSpace("Fenced");
  const missing = await w.call("owner", "update_space", {
    space_id: space.space_id,
    title: "No fence",
    idempotency_key: w.key(),
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /expected_revision/);

  const lost = {
    space_id: space.space_id,
    title: "Lost",
    expected_revision: 0,
    idempotency_key: "lost-update",
  };
  w.faults.set(space.space_id, "lost");
  assert.equal((await w.call("owner", "update_space", lost)).status, 500);
  assert.equal((await w.catalogStorage().get("host/operation/lost-update")).expectedRevision, 0);
  for (let revision = 1; revision <= 64; revision++) {
    const newer = await w.call("owner", "update_space", {
      space_id: space.space_id,
      title: `Title ${revision}`,
      expected_revision: revision,
      idempotency_key: w.key(),
    });
    assert.equal(newer.status, 200, JSON.stringify(newer.body));
  }
  const receipts = await w.spaces.get(space.space_id).ctx.storage.list({ prefix: "host/receipt/" });
  assert.equal(receipts.size, 64);
  assert.ok(![...receipts.keys()].some((name) => name.endsWith("lost-update")), "evicted");

  const retry = await w.call("owner", "update_space", lost);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.superseded, true);
  assert.equal(retry.body.applied, false);
  assert.equal(retry.body.space.title, "Title 64");
  assert.equal(retry.body.space.revision, 65);
  const current = await w.call("owner", "get_space", { space_id: space.space_id });
  assert.equal(current.body.title, "Title 64");
  assert.deepEqual((await w.call("owner", "update_space", lost)).body, retry.body);
});

test("rollback: storage written here stays readable by a build without Spaces", async (t) => {
  const w = await world(t);
  const space = await w.createSpace("Rollback");
  const child = (await w.createPage({ title: "Child", space_id: space.space_id })).body;
  // Page records and Catalog entries keep every field older builds read;
  // placement and space entries are additions under new names.
  const metadata = w.page(child.page_id).metadata;
  for (const field of ["pageId", "owner", "documentId", "tree", "deleted", "createdReceipt"])
    assert.ok(Object.hasOwn(metadata, field), field);
  const entry = await w.catalogStorage().get(`page/${child.page_id}`);
  for (const field of ["page_id", "title", "created_at", "updated_at"])
    assert.ok(Object.hasOwn(entry, field), field);
  assert.equal(entry.pending, undefined);

  // A build that knows migrations 1-3 runs against schema 4 unchanged.
  const latest = CATALOG_MIGRATIONS.at(-1).version;
  assert.equal(await migrateCatalogIndex(w.db), latest);
  assert.equal(await migrateCatalogIndex(w.db, CATALOG_MIGRATIONS.slice(0, 3)), latest);
  // Its page upsert (no placement columns) neither fails nor clears placement.
  const legacyUpsert = (title, at) =>
    w.db
      .prepare(
        `INSERT INTO pages_catalog_pages
          (page_id, owner, title, title_search, state, created_at, updated_at, trashed_at,
            acl_revision, lifecycle_revision)
        VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, 0, 0)
        ON CONFLICT (page_id) DO UPDATE SET title = excluded.title,
          updated_at = max(pages_catalog_pages.updated_at, excluded.updated_at)`,
      )
      .bind(child.page_id, w.owner, title, title.toLowerCase(), at, at)
      .run();
  await reportPageIndex(w.env, { metadata, title: "Child", observedAt: new Date().toISOString() });
  await legacyUpsert("Child renamed", "2031-01-01T00:00:00.000Z");
  const [row] = w.db.rows(
    "SELECT space_id, parent_id, placement_epoch FROM pages_catalog_pages WHERE page_id = ?",
    child.page_id,
  );
  assert.equal(row.space_id, space.space_id);
  assert.equal(row.placement_epoch, 0);
  // A row an older build inserted has no placement until a report supplies it.
  const legacyPage = crypto.randomUUID();
  await w.db
    .prepare(
      `INSERT INTO pages_catalog_pages
        (page_id, owner, title, title_search, state, created_at, updated_at)
      VALUES (?, ?, 'Old', 'old', 'active', ?, ?)`,
    )
    .bind(legacyPage, w.owner, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")
    .run();
  await reportPageIndex(w.env, {
    metadata: { pageId: legacyPage, owner: w.owner, deleted: false },
    title: "Old",
    observedAt: "2026-01-02T00:00:00.000Z",
  });
  const [legacy] = w.db.rows(
    "SELECT space_id, placement_epoch FROM pages_catalog_pages WHERE page_id = ?",
    legacyPage,
  );
  assert.equal(legacy.space_id, null);
  assert.equal(legacy.placement_epoch, 0);

  // A Page record from a build without Spaces reads as Your items.
  const plain = (await w.createPage({ title: "Plain" })).body.page_id;
  const read = await w.call("owner", "read_page", { page_id: plain, include_content: false });
  assert.equal(read.body.space_id, null);
  assert.equal(read.body.parent_id, null);
  assert.deepEqual(read.body.breadcrumbs, []);
});

test("Space tools are concise and keep the untrusted-content rule", () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of ["create_space", "list_spaces", "get_space", "update_space"]) {
    const tool = byName.get(name);
    assert.ok(tool, name);
    assert.ok(tool.description.length < 900, `${name} description stays short`);
  }
  assert.match(byName.get("get_space").description, /home Page/);
  assert.match(byName.get("get_space").description, /untrusted/);
  assert.deepEqual(byName.get("get_space").inputSchema.required, ["space_id"]);
  assert.equal(byName.get("list_spaces").annotations.readOnlyHint, true);
  for (const name of ["space_id", "parent_id"])
    assert.ok(byName.get("create_page").inputSchema.properties[name], name);
  for (const name of ["space_id", "parent_id", "kind"])
    assert.ok(byName.get("list_pages").inputSchema.properties[name], name);
  assert.match(byName.get("read_page").description, /breadcrumbs/);
});
