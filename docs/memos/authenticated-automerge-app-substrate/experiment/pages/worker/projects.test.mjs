import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import worker, { Catalog, Page, Space, lifecycleBounds, sharedChildBounds } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { pageState, proposeAccessUpdate } from "./access.mjs";
import { CATALOG_MIGRATIONS, migrateCatalogIndex, reportPageIndex } from "./catalog-index.mjs";
import { validSpaceId } from "./spaces.mjs";
import { MAX_DEPTH, deriveLocation } from "../model/location.mjs";
import { locationEntries } from "./catalog-location.mjs";
import { tools } from "../mcp.mjs";

/** Object state for direct index calls; the test awaits each one. */
const testCtx = {};

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

/** Real Catalog, Project and Page hosts over in-memory storage. Page hosts stub
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
  const projects = new Map();
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
    PROJECTS: {
      getByName: (id) =>
        faulty(id, () => {
          if (!projects.has(id))
            projects.set(id, new Space({ id: { name: id }, storage: new Storage() }, env));
          return projects.get(id);
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
      headers: { authorization: `Bearer ${tokens[who]}`, "x-pages-driver": "Projects test" },
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
  /** A call as the 3548b9750 gateway sent it: Space names, straight to the
   * caller's Catalog, without the Project API. */
  const oldGateway = async (who, operation, args = {}) => {
    const response = await env.CATALOGS.getByName(who === "owner" ? owner : member).fetch(
      request(who, "/internal/catalog", { operation, arguments: args }),
    );
    return { status: response.status, body: await response.json() };
  };
  /** One MCP tools/call through the gateway. */
  const mcp = async (who, name, args = {}) => {
    const response = await worker.fetch(
      new Request("https://pages.invalid/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens[who]}`,
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
      // MCP results carry links, so the gateway needs its public origin.
      { ...env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.invalid" },
    );
    const { result } = await response.json();
    return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
  };
  let keys = 0;
  const key = () => `projects-test-${++keys}-${crypto.randomUUID()}`;
  const createProject = async (title = "Launch", description) => {
    const created = await call("owner", "create_project", {
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
    projects,
    faults,
    hooks,
    jobs,
    call,
    oldGateway,
    mcp,
    key,
    createProject,
    createPage,
    heads,
    catalogStorage,
    page: (id) => pages.get(id),
    catalog: (principal = owner) => env.CATALOGS.getByName(principal),
  };
}

const ids = (listing) => listing.body.pages.map((page) => page.page_id).sort();
/** A Catalog entry's location fields. */
const locationOf = (entry) =>
  Object.fromEntries(
    ["parent_id", "position", "space_id", "home", "restore_space_id"]
      .filter((field) => Object.hasOwn(entry, field))
      .map((field) => [field, entry[field]]),
  );

test("a Project is created with its home Page, then read, listed and updated", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Launch", "Ship the beta on Friday.");
  assert.ok(validSpaceId(project.project_id));
  assert.equal(project.title, "Launch");
  assert.equal(project.description, "Ship the beta on Friday.");
  assert.equal(project.role, "owner");
  assert.equal(project.revision, 0);
  assert.equal(project.org, null);
  assert.match(project.project_id, /^prj_/);

  const home = w.page(project.home_page_id);
  // Only the owner's Catalog records location; the Page record has none.
  assert.equal(home.metadata.placement, undefined);
  assert.equal(home.metadata.owner, w.owner);
  const homeEntry = await w.catalogStorage().get(`page/${project.home_page_id}`);
  assert.deepEqual(locationOf(homeEntry), {
    parent_id: null,
    position: "a0",
    space_id: project.project_id,
    home: true,
  });

  const read = await w.call("owner", "get_project", { project_id: project.project_id });
  assert.equal(read.status, 200);
  assert.equal(read.body.home_page_id, project.home_page_id);

  const listed = await w.call("owner", "list_projects");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.projects.map((entry) => entry.project_id),
    [project.project_id],
  );
  assert.ok(listed.body.retry_token);

  const homeRead = await w.call("owner", "read_page", {
    page_id: project.home_page_id,
    include_content: false,
  });
  assert.equal(homeRead.status, 200);
  assert.equal(homeRead.body.project_id, project.project_id);
  assert.equal(homeRead.body.parent_id, null);
  assert.equal(homeRead.body.home, true);
  assert.equal(homeRead.body._placement, undefined);
  assert.deepEqual(homeRead.body.breadcrumbs, [
    { kind: "project", project_id: project.project_id, title: "Launch" },
  ]);

  // Pages under the home Page keep it in their chain, marked home:true.
  const underHome = (await w.createPage({ title: "Plan", parent_id: project.home_page_id })).body;
  const nested = (await w.createPage({ title: "Risks", parent_id: underHome.page_id })).body;
  const nestedRead = await w.call("owner", "read_page", {
    page_id: nested.page_id,
    include_content: false,
  });
  assert.equal(nestedRead.status, 200);
  assert.deepEqual(nestedRead.body.breadcrumbs, [
    { kind: "project", project_id: project.project_id, title: "Launch" },
    { kind: "page", page_id: project.home_page_id, title: "Launch", home: true },
    { kind: "page", page_id: underHome.page_id, title: "Plan" },
  ]);

  const updateKey = w.key();
  const update = { project_id: project.project_id, title: "Launch v2", expected_revision: 0 };
  const updated = await w.call("owner", "update_project", {
    ...update,
    idempotency_key: updateKey,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.title, "Launch v2");
  assert.equal(updated.body.revision, 1);
  const replay = await w.call("owner", "update_project", { ...update, idempotency_key: updateKey });
  assert.deepEqual(replay.body, updated.body);
  const conflict = await w.call("owner", "update_project", {
    ...update,
    title: "Other",
    idempotency_key: updateKey,
  });
  assert.equal(conflict.status, 409);
  const stale = await w.call("owner", "update_project", { ...update, idempotency_key: w.key() });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "project_revision_conflict");
  assert.equal(
    (await w.call("owner", "list_projects")).body.projects[0].title,
    "Launch v2",
    "the owner's listing follows the Project record",
  );

  // Another account cannot tell this Project from a missing one.
  const missing = `prj_${crypto.randomUUID()}`;
  for (const target of [project.project_id, missing]) {
    const denied = await w.call("member", "get_project", { project_id: target });
    assert.equal(denied.status, 404);
    assert.deepEqual(denied.body, { error: "Project not found", code: "project_not_found" });
  }
  assert.equal(
    (await w.call("member", "update_project", { ...update, idempotency_key: w.key() })).status,
    404,
  );
  assert.deepEqual((await w.call("member", "list_projects")).body.projects, []);
  // A read-only credential reads but cannot create or change a Project.
  assert.equal((await w.call("reader", "list_projects")).status, 200);
  assert.equal(
    (await w.call("reader", "create_project", { title: "No", idempotency_key: w.key() })).status,
    403,
  );
});

test("tools name the right argument when a Project ID and a Page ID are swapped", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  const pageId = project.home_page_id;
  const cases = [
    ["read_page", { page_id: project.project_id }, "project_id_as_page_id", /get_project/],
    ["patch_page", { page_id: project.project_id }, "project_id_as_page_id", /get_project/],
    [
      "delete_page",
      { page_id: project.project_id, base_heads: [], idempotency_key: w.key() },
      "project_id_as_page_id",
      /get_project/,
    ],
    ["get_project", { project_id: pageId }, "page_id_as_project_id", /read_page/],
    [
      "update_project",
      { project_id: pageId, title: "x", idempotency_key: w.key() },
      "page_id_as_project_id",
      /read_page/,
    ],
    ["list_pages", { project_id: pageId }, "page_id_as_project_id", /parent_id/],
    ["list_pages", { parent_id: project.project_id }, "project_id_as_page_id", /project_id/],
    [
      "create_page",
      { title: "x", parent_id: project.project_id, idempotency_key: w.key() },
      "project_id_as_page_id",
      /project_id/,
    ],
    [
      "create_page",
      { title: "x", project_id: pageId, idempotency_key: w.key() },
      "page_id_as_project_id",
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

test("an interrupted create_project resumes the same Project and home Page on retry", async (t) => {
  const w = await world(t);
  const args = { title: "Recovery", idempotency_key: "project-recovery-key" };
  // The Project record commits, then the home Page creation fails.
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
  const first = await w.call("owner", "create_project", args);
  assert.equal(first.status, 500);
  const storage = w.catalogStorage();
  const intent = await storage.get("host/operation/project-recovery-key");
  assert.equal(intent.pending, true);
  assert.equal(intent.phase, "space_recorded", "the retry resumes after the Project record");
  assert.equal(w.projects.get(intent.spaceId) !== undefined, true, "the Project record exists");
  assert.equal(w.page(intent.pageId)?.metadata, undefined, "the home Page does not");
  assert.equal((await storage.get(`space/${intent.spaceId}`)).pending, true);
  assert.deepEqual((await w.call("owner", "list_projects")).body.projects, []);
  const pending = await w.call("owner", "get_project", { project_id: intent.spaceId });
  assert.equal(pending.status, 409);
  assert.equal(pending.body.code, "project_pending");

  // The retry resumes at the home Page. A lost response after the Page
  // committed is safe to retry too.
  w.faults.set(intent.pageId, "lost");
  assert.equal((await w.call("owner", "create_project", args)).status, 500);
  assert.ok(w.page(intent.pageId).metadata, "the home Page committed");
  assert.equal((await storage.get("host/operation/project-recovery-key")).phase, "space_recorded");

  const retry = await w.call("owner", "create_project", args);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.project_id, intent.spaceId);
  assert.equal(retry.body.home_page_id, intent.pageId);
  assert.equal(w.page(intent.pageId).metadata.placement, undefined);
  assert.equal((await storage.get(`page/${intent.pageId}`)).home, true);
  const again = await w.call("owner", "create_project", args);
  assert.deepEqual(again.body, retry.body);
  assert.equal(
    [...(await storage.list({ prefix: "space/" })).keys()].length,
    1,
    "retries never create a second Project",
  );
  const listed = await w.call("owner", "list_projects");
  assert.deepEqual(
    listed.body.projects.map((project) => project.project_id),
    [intent.spaceId],
  );
  const changed = await w.call("owner", "create_project", { ...args, title: "Other" });
  assert.equal(changed.status, 409);
});

test("create_page places Pages in a Project, under a parent, and enforces depth and mismatch", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Docs");
  const other = await w.createProject("Other");
  const top = await w.createPage({ title: "Guide", project_id: project.project_id });
  assert.equal(top.status, 200);
  assert.equal(top.body.project_id, project.project_id);
  assert.equal(top.body.parent_id, null);
  const child = await w.createPage({ title: "Install", parent_id: top.body.page_id });
  assert.equal(child.status, 200);
  assert.equal(child.body.project_id, project.project_id, "a parent implies its Project");
  assert.equal(child.body.parent_id, top.body.page_id);
  const sibling = await w.createPage({ title: "Configure", parent_id: top.body.page_id });
  const positions = [];
  for (const result of [child, sibling]) {
    assert.equal(w.page(result.body.page_id).metadata.placement, undefined);
    positions.push((await w.catalogStorage().get(`page/${result.body.page_id}`)).position);
  }
  assert.ok(positions[0] < positions[1], "new siblings sort after existing ones");

  const mismatch = await w.createPage({
    title: "Wrong",
    project_id: other.project_id,
    parent_id: top.body.page_id,
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.code, "placement_mismatch");
  const matching = await w.createPage({
    title: "Both",
    project_id: project.project_id,
    parent_id: top.body.page_id,
  });
  assert.equal(matching.status, 200);

  // Depth comes from the model: a root is at depth 1. Until Project top-level
  // Pages move under the home Page, they are roots, so a Project's chain
  // starts at depth 1 there too.
  assert.equal(MAX_DEPTH, 9);
  let parent = top.body.page_id;
  for (let depth = 2; depth <= MAX_DEPTH; depth++) {
    const nested = await w.createPage({ title: `Depth ${depth}`, parent_id: parent });
    assert.equal(nested.status, 200, `depth ${depth}`);
    parent = nested.body.page_id;
  }
  const deepest = deriveLocation(await locationEntries(w.catalogStorage()), parent);
  assert.equal(deepest.depth, 9, "the model puts the last Page at depth 9");
  assert.equal(deepest.space_id, project.project_id);
  const tooDeep = await w.createPage({ title: "Depth 10", parent_id: parent });
  assert.equal(tooDeep.status, 400);
  assert.equal(tooDeep.body.code, "nesting_depth_exceeded");
  assert.match(tooDeep.body.error, /at most 9 levels/);

  // Your items can nest too; they have no Project.
  const loose = await w.createPage({ title: "Loose" });
  assert.equal(loose.body.project_id, undefined);
  assert.equal(w.page(loose.body.page_id).metadata.placement, undefined);
  const looseChild = await w.createPage({ title: "Loose child", parent_id: loose.body.page_id });
  assert.equal(looseChild.body.project_id, null);
  assert.equal(looseChild.body.parent_id, loose.body.page_id);

  // Only Projects and parents the caller owns hold new Pages in this build.
  const foreignProject = await w.createPage(
    { title: "No", project_id: project.project_id },
    "member",
  );
  assert.equal(foreignProject.status, 404);
  assert.equal(foreignProject.body.code, "project_not_found");
  const foreignParent = await w.createPage({ title: "No", parent_id: top.body.page_id }, "member");
  assert.equal(foreignParent.status, 404);
  assert.equal(foreignParent.body.code, "parent_unavailable");
  const unknownProject = await w.createPage({
    title: "No",
    project_id: `prj_${crypto.randomUUID()}`,
  });
  assert.deepEqual(unknownProject.body, foreignProject.body);

  // A caller-supplied placement is ignored; only the resolved one is stored.
  const forged = await w.createPage({
    title: "Forged",
    placement: {
      project_id: other.project_id,
      parent_id: null,
      position: "a0",
      placement_epoch: 0,
      home: true,
    },
  });
  assert.equal(forged.status, 200);
  assert.equal(w.page(forged.body.page_id).metadata.placement, undefined);
  assert.equal(forged.body.project_id, undefined);
  const forgedEntry = await w.catalogStorage().get(`page/${forged.body.page_id}`);
  assert.equal(forgedEntry.parent_id, null);
  assert.equal(forgedEntry.space_id, undefined);
  assert.equal(forgedEntry.home, undefined);
});

test("list_pages filters by Project and parent, verifies every row and hides the Project from grantees", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Team");
  const top = (await w.createPage({ title: "Roadmap", project_id: project.project_id })).body;
  const child = (await w.createPage({ title: "Q4 plan", parent_id: top.page_id })).body;
  const loose = (await w.createPage({ title: "Loose note" })).body;

  const inProject = await w.call("owner", "list_pages", { project_id: project.project_id });
  assert.equal(inProject.status, 200);
  assert.deepEqual(ids(inProject), [project.home_page_id, top.page_id, child.page_id].sort());
  const row = inProject.body.pages.find((page) => page.page_id === child.page_id);
  assert.equal(row.project_id, project.project_id);
  assert.equal(row.parent_id, top.page_id);
  assert.ok(row.position);
  assert.equal(
    inProject.body.pages.find((page) => page.page_id === project.home_page_id).home,
    true,
  );

  const topLevel = await w.call("owner", "list_pages", {
    project_id: project.project_id,
    parent_id: null,
  });
  assert.deepEqual(ids(topLevel), [project.home_page_id, top.page_id].sort());
  const children = await w.call("owner", "list_pages", { parent_id: top.page_id });
  assert.deepEqual(ids(children), [child.page_id]);
  const all = await w.call("owner", "list_pages");
  assert.ok(ids(all).includes(loose.page_id));
  assert.equal(
    all.body.pages.find((page) => page.page_id === loose.page_id).project_id,
    undefined,
    "Your items keep the original row shape",
  );
  // Reserved kinds list nothing yet; an unknown kind is an input error.
  for (const kind of ["notebook", "dashboard", "result"])
    assert.deepEqual(
      (await w.call("owner", "list_pages", { project_id: project.project_id, kind })).body.pages,
      [],
      kind,
    );
  assert.equal(
    (await w.call("owner", "list_pages", { project_id: project.project_id, kind: "sheet" })).status,
    400,
  );

  // A stale D1 row cannot list a Page: the owner's entry must agree.
  await w.db
    .prepare("UPDATE pages_catalog_pages SET space_id = ? WHERE page_id = ?")
    .bind(project.project_id, loose.page_id)
    .run();
  assert.ok(
    !ids(await w.call("owner", "list_pages", { project_id: project.project_id })).includes(
      loose.page_id,
    ),
  );

  // A direct grant on the child keeps working without revealing the Project.
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
  assert.equal(shared.body.pages[0].project_id, undefined);
  assert.equal(shared.body.pages[0].parent_id, undefined);
  const hidden = await w.call("member", "list_pages", { project_id: project.project_id });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.code, "project_not_found");
  const parentHidden = await w.call("member", "list_pages", { parent_id: top.page_id });
  assert.equal(parentHidden.status, 404);
  const memberRead = await w.call("member", "read_page", {
    page_id: child.page_id,
    include_content: false,
  });
  assert.equal(memberRead.status, 200);
  assert.equal(memberRead.body.project_id, undefined);
  assert.equal(memberRead.body.parent_id, undefined);
  assert.deepEqual(memberRead.body.breadcrumbs, []);

  const ownerRead = await w.call("owner", "read_page", {
    page_id: child.page_id,
    include_content: false,
  });
  assert.deepEqual(ownerRead.body.breadcrumbs, [
    { kind: "project", project_id: project.project_id, title: "Team" },
    { kind: "page", page_id: top.page_id, title: "Roadmap" },
  ]);
  assert.equal(ownerRead.body.parent_id, top.page_id);

  // The same filters work from Catalog entries while the index is off.
  delete w.env.PAGES_CATALOG_INDEX;
  const fallback = await w.call("owner", "list_pages", { project_id: project.project_id });
  assert.deepEqual(ids(fallback), ids(inProject));
  assert.deepEqual(
    (await w.call("owner", "list_projects")).body.projects.map((entry) => entry.project_id),
    [project.project_id],
  );
});

test("list_projects pages with a cursor and confirms D1 candidates against the Catalog", async (t) => {
  const w = await world(t);
  const created = [];
  for (let index = 0; index < 3; index++) created.push(await w.createProject(`Project ${index}`));
  const first = await w.call("owner", "list_projects", { limit: 2 });
  assert.equal(first.body.projects.length, 2);
  assert.ok(first.body.next_cursor);
  const second = await w.call("owner", "list_projects", {
    limit: 2,
    cursor: first.body.next_cursor,
  });
  assert.equal(second.body.projects.length, 1);
  assert.equal(second.body.next_cursor, null);
  assert.deepEqual(
    [...first.body.projects, ...second.body.projects].map((project) => project.project_id).sort(),
    created.map((project) => project.project_id).sort(),
  );
  // A list_pages cursor does not open a Project listing.
  assert.equal(
    (
      await w.call("owner", "list_projects", {
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
      `prj_${crypto.randomUUID()}`,
      w.owner,
      crypto.randomUUID(),
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:00:00.000Z",
    )
    .run();
  const listed = await w.call("owner", "list_projects");
  assert.equal(listed.body.projects.length, 3);
  assert.ok(listed.body.projects.every((project) => project.title !== "Ghost"));
});

test("Trash moves one Page at a time; restore returns a Page to its parent or the Project top level", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Wiki");
  const a = (await w.createPage({ title: "A", project_id: project.project_id })).body.page_id;
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

  // B's parent is in Trash, so B returns to the Project's top level.
  const back = await restore(b);
  assert.equal(back.status, 200);
  assert.equal(back.body.parent_id, null);
  assert.equal(back.body.project_id, project.project_id);
  assert.equal(pageState(w.page(a).metadata), "trashed", "restoring B leaves A in Trash");
  assert.equal(w.page(b).metadata.placement, undefined);
  const entry = await storage.get(`page/${b}`);
  assert.equal(entry.parent_id, null);
  assert.equal(entry.space_id, project.project_id, "a Project top-level Page is a root");
  assert.equal(entry.restore_space_id, undefined);
  assert.ok(entry.position > (await storage.get(`page/${project.home_page_id}`)).position);
  // C's parent is active again, so C keeps its place.
  const child = await restore(c);
  assert.equal(child.status, 200);
  assert.equal(child.body.parent_id, b);
  assert.equal(child.body.project_id, project.project_id, "derived through B");
  assert.equal((await storage.get(`page/${c}`)).parent_id, b);
  assert.deepEqual(
    ids(await w.call("owner", "list_pages", { project_id: project.project_id, parent_id: null })),
    [project.home_page_id, b].sort(),
  );

  const home = await trash(project.home_page_id);
  assert.equal(home.status, 409);
  assert.equal(home.body.code, "home_page_protected");
  assert.equal(pageState(w.page(project.home_page_id).metadata), "active");
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
  const project = await w.createProject("Settle");
  const parent = (await w.createPage({ title: "P", project_id: project.project_id })).body.page_id;
  const child = (await w.createPage({ title: "C", parent_id: parent })).body.page_id;
  const trash = (pageId) =>
    w.call("owner", "delete_page", {
      page_id: pageId,
      base_heads: w.heads(pageId),
      idempotency_key: w.key(),
    });
  return { project, parent, child, trash };
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

/** Real I/O turns. Tests that mock timers mock only setTimeout and Date, so
 * these still advance. */
async function turns(count = 20) {
  for (let index = 0; index < count; index++) await new Promise((resolve) => setImmediate(resolve));
}

/** Await `promise` while advancing mocked time 5 ms per step, with real I/O
 * turns between steps. `drain` keeps advancing that many ms after it settles. */
async function advance(t, promise, { drain = 0, limit = 10_000 } = {}) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let elapsed = 0; !settled && elapsed <= limit; elapsed += 5) {
    await turns();
    if (!settled) t.mock.timers.tick(5);
  }
  for (let elapsed = 0; elapsed < drain; elapsed += 5) {
    await turns();
    t.mock.timers.tick(5);
  }
  await turns();
  return promise;
}

/** Children of one parent, each trashed with a restore reserved but never
 * applied, so a leaf check has to read every child's lifecycle. */
async function unsettledChildren(w, count) {
  const { parent, trash, project } = await nested(w);
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
  return { parent, trash, project, children };
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
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const started = Date.now();
  const stalled = await advance(t, trash(parent));
  assert.equal(stalled.status, 409);
  assert.equal(stalled.body.code, "lifecycle_unsettled");
  assert.ok(Date.now() - started < 400, "the read gave up after its own bound");
  assert.equal(pageState(w.page(parent).metadata), "active");
  await turns();
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
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const started = Date.now();
  const exhausted = await advance(t, trash(parent));
  const elapsed = Date.now() - started;
  assert.equal(exhausted.status, 409);
  assert.equal(exhausted.body.code, "lifecycle_unsettled");
  assert.ok(elapsed < 300, `the pass stopped near its budget (${elapsed} ms)`);
  assert.equal(pageState(w.page(parent).metadata), "active");
  assert.ok(peak <= 4, `at most four reads at once (${peak})`);

  // Reads cut off at the deadline finish in the background; let them drain.
  await advance(t, Promise.resolve(), { drain: 100 });
  assert.equal(active, 0);
  peak = 0;
  Object.assign(lifecycleBounds, { passMs: 2000 });
  const settled = await advance(t, trash(parent));
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
  const { project, parent, child, trash } = await nested(w);
  assert.equal((await trash(child)).status, 200);
  const storage = w.catalogStorage();
  const args = { page_id: parent, base_heads: w.heads(parent), idempotency_key: "resumed-trash" };
  // Forwarded, but the request never reached the Page.
  w.faults.set(parent, "before");
  assert.ok((await w.call("owner", "delete_page", args)).status >= 500);
  const intent = await storage.get("host/operation/resumed-trash");
  assert.equal(intent.forwarded, true);
  // The slot expires. Another Trash leaves it alone: a capacity check below
  // the limit reads the stored count, not the slots.
  const slot = await storage.get(`trash/${parent}`);
  await storage.put(`trash/${parent}`, { ...slot, expires_at: Date.now() - 1 });
  const other = (await w.createPage({ title: "Other", project_id: project.project_id })).body
    .page_id;
  assert.equal((await trash(other)).status, 200);
  assert.equal((await storage.get(`trash/${parent}`)).intent, "host/operation/resumed-trash");
  // A child under the parent counts the parent's slot, finds the Page
  // unchanged and releases it.
  const late = await w.createPage({ title: "Late child", parent_id: parent });
  assert.equal(late.status, 200);
  assert.equal(await storage.get(`trash/${parent}`), undefined, "the slot was released");

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
  const { project, parent, child, trash } = await nested(w);
  assert.equal((await trash(child)).status, 200);
  w.faults.set(child, "before");
  const restore = { page_id: child, idempotency_key: "restore-never-arrived" };
  assert.ok((await w.call("owner", "restore_page", restore)).status >= 500);
  assert.equal(pageState(w.page(child).metadata), "trashed");
  assert.equal((await trash(parent)).status, 200, "the settled child is still in Trash");
  const retried = await w.call("owner", "restore_page", restore);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.parent_id, null);
  assert.equal(retried.body.project_id, project.project_id);
  const entry = await w.catalogStorage().get(`page/${child}`);
  assert.equal(entry.parent_id, null);
  assert.equal(entry.space_id, project.project_id);
});

for (const variant of ["lost", "barrier"])
  test(`a restore after its parent's trash lost its receipt (${variant}) goes to the top level`, async (t) => {
    const w = await world(t);
    const { project, parent, child, trash } = await nested(w);
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
    assert.equal(restored.body.project_id, project.project_id);
    assert.equal(pageState(w.page(parent).metadata), "trashed");
    assert.equal((await storage.get(`trash/${parent}`)).reservation, undefined, "settled");
    assert.equal(await storage.get(`page/${parent}`), undefined);
  });

test("a pending child creation blocks its parent's Trash, and a resumed one rechecks its parent", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Pending");
  const a = (await w.createPage({ title: "A", project_id: project.project_id })).body.page_id;
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

test("an update_project retry whose receipt was evicted is superseded and never applies", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Fenced");
  const missing = await w.call("owner", "update_project", {
    project_id: project.project_id,
    title: "No fence",
    idempotency_key: w.key(),
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /expected_revision/);

  const lost = {
    project_id: project.project_id,
    title: "Lost",
    expected_revision: 0,
    idempotency_key: "lost-update",
  };
  w.faults.set(project.project_id, "lost");
  assert.equal((await w.call("owner", "update_project", lost)).status, 500);
  assert.equal((await w.catalogStorage().get("host/operation/lost-update")).expectedRevision, 0);
  for (let revision = 1; revision <= 64; revision++) {
    const newer = await w.call("owner", "update_project", {
      project_id: project.project_id,
      title: `Title ${revision}`,
      expected_revision: revision,
      idempotency_key: w.key(),
    });
    assert.equal(newer.status, 200, JSON.stringify(newer.body));
  }
  const receipts = await w.projects
    .get(project.project_id)
    .ctx.storage.list({ prefix: "host/receipt/" });
  assert.equal(receipts.size, 64);
  assert.ok(![...receipts.keys()].some((name) => name.endsWith("lost-update")), "evicted");

  const retry = await w.call("owner", "update_project", lost);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.superseded, true);
  assert.equal(retry.body.applied, false);
  assert.equal(retry.body.project.title, "Title 64");
  assert.equal(retry.body.project.revision, 65);
  const current = await w.call("owner", "get_project", { project_id: project.project_id });
  assert.equal(current.body.title, "Title 64");
  assert.deepEqual((await w.call("owner", "update_project", lost)).body, retry.body);
});

test("rollback: storage written here stays readable by older builds", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Rollback");
  const child = (await w.createPage({ title: "Child", project_id: project.project_id })).body;
  // Page records and Catalog entries keep every field older builds read, and
  // storage keeps the Space names a build from before the Project name reads.
  const metadata = w.page(child.page_id).metadata;
  for (const field of ["pageId", "owner", "documentId", "tree", "deleted", "createdReceipt"])
    assert.ok(Object.hasOwn(metadata, field), field);
  const entry = await w.catalogStorage().get(`page/${child.page_id}`);
  for (const field of ["page_id", "title", "created_at", "updated_at"])
    assert.ok(Object.hasOwn(entry, field), field);
  assert.equal(entry.pending, undefined);
  assert.equal(entry.space_id, project.project_id);
  assert.equal(Object.hasOwn(entry, "project_id"), false);
  assert.equal(metadata.placement, undefined, "the Page record holds no location");
  const catalog = w.catalogStorage();
  assert.ok(await catalog.get(`space/${project.project_id}`), "Catalog keeps space/<id>");
  assert.equal((await catalog.list({ prefix: "project/" })).size, 0);
  const record = await w.projects.get(project.project_id).ctx.storage.get("space/record");
  assert.equal(record.space_id, project.project_id);
  assert.equal(Object.hasOwn(record, "project_id"), false);

  // The schema is the Spaces build's: a build that knows migrations 1-3 runs
  // against it unchanged.
  const latest = CATALOG_MIGRATIONS.at(-1).version;
  assert.equal(latest, 4);
  assert.equal(await migrateCatalogIndex(w.db), latest);
  assert.equal(await migrateCatalogIndex(w.db, CATALOG_MIGRATIONS.slice(0, 3)), latest);
  // Page reports write no D1 location: the owner's Catalog records it.
  const reported = crypto.randomUUID();
  await reportPageIndex(w.env, testCtx, {
    metadata: { pageId: reported, owner: w.owner, deleted: false },
    title: "Reported",
    observedAt: "2026-01-02T00:00:00.000Z",
  });
  const [row] = w.db.rows(
    "SELECT space_id, parent_id, placement_epoch FROM pages_catalog_pages WHERE page_id = ?",
    reported,
  );
  assert.deepEqual({ ...row }, { space_id: null, parent_id: null, placement_epoch: null });

  // A Page record from a build without Projects reads as Your items.
  const plain = (await w.createPage({ title: "Plain" })).body.page_id;
  const read = await w.call("owner", "read_page", { page_id: plain, include_content: false });
  assert.equal(read.body.project_id, null);
  assert.equal(read.body.parent_id, null);
  assert.deepEqual(read.body.breadcrumbs, []);
});

/** Fail the next Page creation, as a crash between the intent and the Page. */
function failNextPageCreate(w) {
  const originalPages = w.env.PAGES.getByName;
  let fail = true;
  w.env.PAGES.getByName = (id) => {
    const stub = originalPages(id);
    return {
      fetch: async (request) => {
        if (fail && new URL(request.url).pathname === "/internal/create") {
          fail = false;
          return Response.json({ error: "Injected crash" }, { status: 500 });
        }
        return stub.fetch(request);
      },
    };
  };
}

test("intents a build from before the Project name left pending resume through the Project API", async (t) => {
  const w = await world(t);
  const storage = w.catalogStorage();

  // create_space as the old gateway sent it, interrupted before its home Page.
  failNextPageCreate(w);
  const spaceArgs = { title: "Old build", idempotency_key: "old-create-space" };
  assert.equal((await w.oldGateway("owner", "create_space", spaceArgs)).status, 500);
  const spaceIntent = await storage.get("host/operation/old-create-space");
  assert.equal(spaceIntent.pending, true);
  assert.equal(spaceIntent.phase, "space_recorded");
  const resumed = await w.call("owner", "create_project", spaceArgs);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.project_id, spaceIntent.spaceId);
  assert.equal(resumed.body.home_page_id, spaceIntent.pageId);
  assert.equal(resumed.body.org, null);
  assert.equal(Object.hasOwn(resumed.body, "space_id"), false);
  const projectId = resumed.body.project_id;

  // create_page with space_id, interrupted before the Page. The intent
  // names no Project: the pending Catalog entry alone records the location.
  failNextPageCreate(w);
  const pageArgs = { title: "Queued", space_id: projectId, idempotency_key: "old-create-page" };
  assert.equal((await w.oldGateway("owner", "create_page", pageArgs)).status, 500);
  const pageIntent = await storage.get("host/operation/old-create-page");
  assert.equal(pageIntent.pending, true);
  assert.equal(pageIntent.placement, undefined);
  const pendingEntry = await storage.get(`page/${pageIntent.pageId}`);
  assert.equal(pendingEntry.pending, true);
  assert.equal(pendingEntry.space_id, projectId);
  assert.equal(pendingEntry.parent_id, null);
  // The same call with the new argument name. Fingerprints cover the
  // arguments in order, as they always have.
  const apiArgs = { title: "Queued", project_id: projectId, idempotency_key: "old-create-page" };
  const page = await w.call("owner", "create_page", apiArgs);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.page_id, pageIntent.pageId);
  assert.equal(page.body.project_id, projectId);
  assert.equal(w.page(page.body.page_id).metadata.placement, undefined);
  // The completed receipt replays in the API's names, and once.
  const replay = await w.call("owner", "create_page", apiArgs);
  assert.deepEqual(replay.body, page.body);
  assert.deepEqual(
    ids(await w.call("owner", "list_pages", { project_id: projectId })),
    [resumed.body.home_page_id, page.body.page_id].sort(),
  );
});

test("cached clients: old tool names and space_id are refused before anything runs", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Cached");
  const renamed = {
    create_space: ["create_project", { title: "Old", idempotency_key: w.key() }],
    list_spaces: ["list_projects", {}],
    get_space: ["get_project", { space_id: project.project_id }],
    update_space: [
      "update_project",
      {
        space_id: project.project_id,
        title: "Old",
        expected_revision: 0,
        idempotency_key: w.key(),
      },
    ],
  };
  for (const [old, [replacement, args]] of Object.entries(renamed)) {
    const viaApi = await w.call("owner", old, args);
    assert.equal(viaApi.status, 400, old);
    assert.deepEqual(viaApi.body, {
      error: `\`${old}\` was renamed \`${replacement}\``,
      code: "tool_renamed",
    });
    const viaMcp = await w.mcp("owner", old, args);
    assert.equal(viaMcp.isError, true, old);
    assert.deepEqual(viaMcp.body, viaApi.body);
  }
  assert.equal((await w.call("owner", "list_projects")).body.projects.length, 1);
  assert.equal(
    (await w.call("owner", "get_project", { project_id: project.project_id })).body.revision,
    0,
  );

  // space_id on create_page or list_pages is refused, not ignored, and the
  // refusal consumes nothing: the same key then applies once with project_id.
  const pageKey = w.key();
  const refusals = [
    ["create_page", { title: "Cached", space_id: project.project_id, idempotency_key: pageKey }],
    ["list_pages", { space_id: project.project_id }],
  ];
  for (const [operation, args] of refusals) {
    const expected = { error: "`space_id` is now `project_id`", code: "argument_renamed" };
    const viaApi = await w.call("owner", operation, args);
    assert.equal(viaApi.status, 400, operation);
    assert.deepEqual(viaApi.body, expected);
    const viaMcp = await w.mcp("owner", operation, args);
    assert.equal(viaMcp.isError, true, operation);
    assert.deepEqual(viaMcp.body, expected);
  }
  assert.equal(await w.catalogStorage().get(`host/operation/${pageKey}`), undefined);
  const created = await w.call("owner", "create_page", {
    title: "Cached",
    project_id: project.project_id,
    idempotency_key: pageKey,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.project_id, project.project_id);
  assert.deepEqual(
    ids(await w.call("owner", "list_pages", { project_id: project.project_id })),
    [project.home_page_id, created.body.page_id].sort(),
  );
});

test("Project tools are concise and keep the untrusted-content rule", () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of ["create_project", "list_projects", "get_project", "update_project"]) {
    const tool = byName.get(name);
    assert.ok(tool, name);
    assert.ok(tool.description.length < 900, `${name} description stays short`);
  }
  assert.match(byName.get("get_project").description, /home Page/);
  assert.match(byName.get("get_project").description, /untrusted/);
  assert.deepEqual(byName.get("get_project").inputSchema.required, ["project_id"]);
  assert.equal(byName.get("list_projects").annotations.readOnlyHint, true);
  for (const name of ["project_id", "parent_id"])
    assert.ok(byName.get("create_page").inputSchema.properties[name], name);
  for (const name of ["project_id", "parent_id", "kind"])
    assert.ok(byName.get("list_pages").inputSchema.properties[name], name);
  assert.match(byName.get("read_page").description, /breadcrumbs/);
});

test("a credential that expires while the Project reads its record is refused", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Expiring");
  // The internal route and stored record keep the Space name.
  const host = w.projects.get(project.project_id);
  const read = () =>
    host.fetch(
      new Request("https://pages.invalid/internal/space/read", {
        method: "POST",
        headers: { authorization: `Bearer ${w.auth.apiKey()}` },
        body: JSON.stringify({ space_id: project.project_id }),
      }),
    );
  assert.equal((await read()).status, 200);
  // API-key credentials last 60 s from authentication. Advance the clock past
  // that while the Project awaits its record, after authenticate() returned.
  const start = Date.now();
  let elapsed = 0;
  t.mock.method(Date, "now", () => start + elapsed);
  const storage = host.ctx.storage;
  const get = storage.get.bind(storage);
  t.mock.method(storage, "get", async (key) => {
    const value = await get(key);
    if (key === "space/record") elapsed = 60_001;
    return value;
  });
  const refused = await read();
  assert.equal(refused.status, 404);
  assert.equal((await refused.json()).code, "project_not_found");
});

/** Give `principal` a direct viewer grant on an owned Page. */
async function grant(w, pageId, principal = w.member) {
  const host = w.page(pageId);
  const ownerIdentity = { principal: w.owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  const acl = proposeAccessUpdate(host.metadata, ownerIdentity, {
    principal,
    role: "viewer",
    expected_revision: host.metadata.acl?.revision ?? 0,
  }).acl;
  host.metadata = { ...host.metadata, acl };
  await host.ctx.storage.put("host/document", host.metadata);
}

/** Count requests by object and path. */
function spy(w) {
  const calls = [];
  for (const binding of ["PAGES", "CATALOGS"]) {
    const original = w.env[binding].getByName;
    w.env[binding].getByName = (name) => {
      const stub = original(name);
      return {
        ...stub,
        ctx: stub.ctx,
        fetch: async (request, init) => {
          calls.push({
            binding,
            name,
            path: new URL(request.url).pathname,
            body: await request
              .clone()
              .json()
              .catch(() => null),
          });
          return stub.fetch(request, init);
        },
      };
    };
  }
  return calls;
}

test("create under a parent records its location only in the owner's Catalog", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Docs");
  const top = (await w.createPage({ title: "Guide", project_id: project.project_id })).body;
  const calls = spy(w);
  const childKey = w.key();
  const child = await w.createPage({
    title: "Install",
    parent_id: top.page_id,
    idempotency_key: childKey,
  });
  assert.equal(child.status, 200);
  const grandchild = (await w.createPage({ title: "macOS", parent_id: child.body.page_id })).body;

  // The Page learned its content, never a parent or Project.
  const creates = calls.filter((call) => call.path === "/internal/create");
  assert.equal(creates.length, 2);
  for (const { body } of creates) assert.deepEqual(Object.keys(body).sort(), ["page_id", "title"]);
  for (const pageId of [top.page_id, child.body.page_id, grandchild.page_id])
    assert.equal(w.page(pageId).metadata.placement, undefined);
  // The intent names no location; the Catalog entry is the only record.
  const intent = await w.catalogStorage().get(`host/operation/${childKey}`);
  for (const field of ["placement", "parent_id", "space_id", "parentId", "spaceId"])
    assert.equal(Object.hasOwn(intent, field), false, field);
  const storage = w.catalogStorage();
  assert.deepEqual(locationOf(await storage.get(`page/${top.page_id}`)), {
    parent_id: null,
    position: "a1",
    space_id: project.project_id,
  });
  assert.deepEqual(locationOf(await storage.get(`page/${child.body.page_id}`)), {
    parent_id: top.page_id,
    position: "a0",
  });
  // The Project is derived through the root, and receipts report it.
  assert.equal(child.body.project_id, project.project_id);
  assert.equal(child.body.parent_id, top.page_id);
  assert.equal(grandchild.project_id, project.project_id);
  const read = await w.call("owner", "read_page", {
    page_id: grandchild.page_id,
    include_content: false,
  });
  assert.equal(read.body.project_id, project.project_id);

  // Only the root records the Project: without it the subtree is Your items.
  const root = await storage.get(`page/${top.page_id}`);
  const { space_id: _space, ...unplaced } = root;
  await storage.put(`page/${top.page_id}`, unplaced);
  const moved = await w.call("owner", "read_page", {
    page_id: grandchild.page_id,
    include_content: false,
  });
  assert.equal(moved.body.project_id, undefined);
  assert.deepEqual(
    moved.body.breadcrumbs.map((crumb) => crumb.page_id),
    [top.page_id, child.body.page_id],
  );
  await storage.put(`page/${top.page_id}`, root);
});

test("breadcrumbs come from one Catalog call, and a viewer's stop at the first Page they can't read", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Team");
  const a = (await w.createPage({ title: "A", project_id: project.project_id })).body.page_id;
  const b = (await w.createPage({ title: "B", parent_id: a })).body.page_id;
  const c = (await w.createPage({ title: "C", parent_id: b })).body.page_id;
  const calls = spy(w);
  const readC = async (who) => {
    calls.length = 0;
    const read = await w.call(who, "read_page", { page_id: c, include_content: false });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    return read.body;
  };

  const owner = await readC("owner");
  assert.deepEqual(owner.breadcrumbs, [
    { kind: "project", project_id: project.project_id, title: "Team" },
    { kind: "page", page_id: a, title: "A" },
    { kind: "page", page_id: b, title: "B" },
  ]);
  const locationCalls = calls.filter((call) => call.path === "/internal/location");
  assert.deepEqual(
    locationCalls.map(({ name, body }) => ({ name, body })),
    [{ name: w.owner, body: { page_id: c } }],
    "one call to the owner's Catalog",
  );
  // Every other Page read is an access check of an ancestor, one each.
  assert.deepEqual(
    calls
      .filter((call) => call.binding === "PAGES" && call.path === "/internal/catalog")
      .map((call) => call.name)
      .sort(),
    [a, b].sort(),
  );

  // A viewer of C alone: B is unreadable, so nothing above C shows.
  await grant(w, c);
  const alone = await readC("member");
  assert.deepEqual(alone.breadcrumbs, []);
  assert.equal(alone.parent_id, undefined);
  assert.equal(alone.project_id, undefined);
  assert.equal(JSON.stringify(alone).includes(a), false);
  // Readable A doesn't help while B, nearer, is unreadable.
  await grant(w, a);
  assert.deepEqual((await readC("member")).breadcrumbs, []);
  // With B readable too the chain shows, but never the owner-only Project.
  await grant(w, b);
  const chain = await readC("member");
  assert.deepEqual(chain.breadcrumbs, [
    { kind: "page", page_id: a, title: "A" },
    { kind: "page", page_id: b, title: "B" },
  ]);
  assert.equal(chain.parent_id, b);
  assert.equal(chain.project_id, undefined);
  assert.equal(calls.filter((call) => call.path === "/internal/location").length, 1);
});

test("list_pages by Project lists every descendant; by parent, direct children, also under a shared parent", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Wiki");
  const a = (await w.createPage({ title: "A", project_id: project.project_id })).body.page_id;
  const b = (await w.createPage({ title: "B", parent_id: a })).body.page_id;
  const c = (await w.createPage({ title: "C", parent_id: b })).body.page_id;
  const c2 = (await w.createPage({ title: "C2", parent_id: b })).body.page_id;
  const loose = (await w.createPage({ title: "Loose" })).body.page_id;
  const looseChild = (await w.createPage({ title: "Loose child", parent_id: loose })).body.page_id;

  for (const index of ["1", undefined]) {
    if (index) w.env.PAGES_CATALOG_INDEX = index;
    else delete w.env.PAGES_CATALOG_INDEX;
    const inProject = await w.call("owner", "list_pages", { project_id: project.project_id });
    assert.deepEqual(ids(inProject), [project.home_page_id, a, b, c, c2].sort());
    const rows = new Map(inProject.body.pages.map((page) => [page.page_id, page]));
    assert.equal(rows.get(project.home_page_id).home, true);
    assert.equal(rows.get(c).project_id, project.project_id, "derived through A");
    assert.equal(rows.get(c).parent_id, b);
    assert.ok(rows.get(c).position < rows.get(c2).position);
    assert.deepEqual(
      ids(await w.call("owner", "list_pages", { project_id: project.project_id, parent_id: null })),
      [project.home_page_id, a].sort(),
    );
    assert.deepEqual(ids(await w.call("owner", "list_pages", { parent_id: b })), [c, c2].sort());
    assert.deepEqual(ids(await w.call("owner", "list_pages", { parent_id: loose })), [looseChild]);
    const mismatch = await w.call("owner", "list_pages", {
      project_id: project.project_id,
      parent_id: loose,
    });
    assert.equal(mismatch.body.code, "placement_mismatch");
  }

  // A viewer of B lists B's children with an empty discovery cache: the
  // owner's Catalog names them, and each is checked with the viewer's
  // credentials. C is readable; C2 is not, so its title never shows.
  await grant(w, b);
  await grant(w, c);
  const viewerStorage = w.catalogStorage(w.member);
  assert.equal((await viewerStorage.list({ prefix: "shared/" })).size, 0, "nothing discovered");
  const calls = spy(w);
  const shared = await w.call("member", "list_pages", { parent_id: b });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  assert.deepEqual(ids(shared), [c]);
  assert.equal(shared.body.pages[0].title, "C");
  assert.equal(shared.body.pages[0].parent_id, b);
  assert.equal(shared.body.pages[0].shared, true);
  assert.equal(shared.body.pages[0].project_id, undefined);
  // The denied child's ID and title appear nowhere in the response. Match the
  // quoted title, because retry tokens are random base64 that can contain "C2".
  const body = JSON.stringify(shared.body);
  assert.equal(body.includes(c2), false);
  assert.equal(body.includes('"C2"'), false);
  assert.deepEqual(
    calls
      .filter((call) => call.path === "/internal/location")
      .map(({ name, body }) => ({ name, body })),
    [{ name: w.owner, body: { children_of: b } }],
  );
  // Both children were checked with the viewer's credentials.
  assert.deepEqual(
    calls
      .filter((call) => call.binding === "PAGES" && call.path === "/internal/catalog")
      .map((call) => call.name)
      .filter((name) => name !== b)
      .sort(),
    [c, c2].sort(),
  );
  // Granting C2 later shows it, though the viewer never discovered it.
  await grant(w, c2);
  assert.equal(await viewerStorage.get(`shared/${c2}`), undefined);
  assert.deepEqual(ids(await w.call("member", "list_pages", { parent_id: b })), [c, c2].sort());
  // A shared Page with no children lists none.
  assert.deepEqual(ids(await w.call("member", "list_pages", { parent_id: c })), []);
  // A, unreadable, can't be listed.
  assert.equal((await w.call("member", "list_pages", { parent_id: a })).status, 404);
});

test("an interrupted create under a parent keeps that parent on retry", async (t) => {
  const w = await world(t);
  const parent = (await w.createPage({ title: "Parent" })).body.page_id;
  const args = { title: "Child", parent_id: parent, idempotency_key: "interrupted-child" };
  failNextPageCreate(w);
  assert.equal((await w.call("owner", "create_page", args)).status, 500);
  const storage = w.catalogStorage();
  const intent = await storage.get("host/operation/interrupted-child");
  assert.equal(intent.pending, true);
  const pending = await storage.get(`page/${intent.pageId}`);
  assert.equal(pending.pending, true);
  assert.equal(pending.parent_id, parent, "the pending entry holds the parent");
  // A sibling created meanwhile doesn't take its slot.
  const sibling = (await w.createPage({ title: "Sibling", parent_id: parent })).body.page_id;
  assert.ok((await storage.get(`page/${sibling}`)).position > pending.position);

  const retry = await w.call("owner", "create_page", args);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.page_id, intent.pageId);
  assert.equal(retry.body.parent_id, parent);
  const created = await storage.get(`page/${intent.pageId}`);
  assert.equal(created.pending, undefined);
  assert.deepEqual(locationOf(created), locationOf(pending));
  assert.deepEqual(
    ids(await w.call("owner", "list_pages", { parent_id: parent })),
    [intent.pageId, sibling].sort(),
  );
  assert.deepEqual((await w.call("owner", "create_page", args)).body, retry.body);
});

test("a restore whose parent was purged returns to the Project it was trashed from", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Archive");
  const a = (await w.createPage({ title: "A", project_id: project.project_id })).body.page_id;
  const b = (await w.createPage({ title: "B", parent_id: a })).body.page_id;
  for (const pageId of [b, a]) {
    const trashed = await w.call("owner", "delete_page", {
      page_id: pageId,
      base_heads: w.heads(pageId),
      idempotency_key: w.key(),
    });
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  }
  const storage = w.catalogStorage();
  assert.equal((await storage.get(`trash/${b}`)).restore_space_id, project.project_id);
  assert.equal((await storage.get(`trash/${a}`)).restore_space_id, undefined, "a root has its own");
  const preview = await w.call("owner", "purge_page", { page_id: a, action: "preview" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const purged = await w.call("owner", "purge_page", {
    page_id: a,
    action: "confirm",
    preview_token: preview.body.preview_token,
    idempotency_key: w.key(),
  });
  assert.equal(purged.status, 200, JSON.stringify(purged.body));

  const restored = await w.call("owner", "restore_page", { page_id: b, idempotency_key: w.key() });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.project_id, project.project_id);
  assert.equal(restored.body.parent_id, null);
  const entry = await storage.get(`page/${b}`);
  assert.deepEqual(locationOf(entry), {
    parent_id: null,
    position: "a1",
    space_id: project.project_id,
  });
});

test("the Catalog location route is host-only and answers only its own account", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Private");
  const a = (await w.createPage({ title: "A", project_id: project.project_id })).body.page_id;
  const b = (await w.createPage({ title: "B", parent_id: a })).body.page_id;
  const body = JSON.stringify({ page_id: b });

  // The gateway never forwards /internal/*, with or without a credential.
  for (const headers of [{}, { authorization: `Bearer ${w.auth.apiKey()}` }]) {
    const outside = await worker.fetch(
      new Request("https://pages.invalid/internal/location", { method: "POST", headers, body }),
      w.env,
    );
    assert.equal(outside.status, 404);
    assert.equal(JSON.stringify(await outside.json()).includes(a), false);
  }
  // Nor is it a tool or a Catalog operation.
  assert.equal((await w.call("owner", "location", { page_id: b })).status, 400);
  const asOperation = await w.oldGateway("owner", "location", { page_id: b });
  assert.equal(asOperation.status, 400);

  const ask = (headers) =>
    w
      .catalog()
      .fetch(
        new Request("https://pages.internal/internal/location", { method: "POST", headers, body }),
      );
  // A request carrying another account's credential is refused.
  const other = await ask({ authorization: `Bearer ${w.auth.apiKey({ userId: "member-user" })}` });
  assert.equal(other.status, 403);
  assert.equal(JSON.stringify(await other.json()).includes(a), false);
  // The owner's own credential, or a host request with none, gets IDs only.
  const expected = {
    page_id: b,
    state: "active",
    parent_id: a,
    ancestors: [a],
    complete: true,
    space_id: project.project_id,
    home: false,
  };
  assert.deepEqual(
    await (await ask({ authorization: `Bearer ${w.auth.apiKey()}` })).json(),
    expected,
  );
  const host = await ask({});
  assert.equal(host.status, 200);
  assert.deepEqual(await host.json(), expected);
  const children = await w.catalog().fetch(
    new Request("https://pages.internal/internal/location", {
      method: "POST",
      body: JSON.stringify({ children_of: a }),
    }),
  );
  assert.deepEqual(await children.json(), { children: [b] });
  // Another account's Catalog doesn't know the Page.
  const elsewhere = await w
    .catalog(w.member)
    .fetch(new Request("https://pages.internal/internal/location", { method: "POST", body }));
  assert.equal(elsewhere.status, 404);
});

test("a shared parent's hidden children never show through pagination", async (t) => {
  const w = await world(t);
  const empty = (await w.createPage({ title: "Empty" })).body.page_id;
  const parent = (await w.createPage({ title: "Parent" })).body.page_id;
  await grant(w, empty);
  await grant(w, parent);
  // More hidden children than a bounded scan for limit 1 reads (2 * 1 + 16).
  const children = [];
  for (let index = 0; index < 20; index++)
    children.push(
      (await w.createPage({ title: `Hidden ${index}`, parent_id: parent })).body.page_id,
    );
  const list = async (parentId, args = {}) => {
    const listed = await w.call("member", "list_pages", { parent_id: parentId, limit: 1, ...args });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const {
      retry_token: _token,
      retry_key_prefix: _prefix,
      retry_until: _until,
      ...visible
    } = listed.body;
    return visible;
  };

  // Every child denied: the same answer as a parent with no children.
  const none = await list(empty);
  // `quota` is the member's own account, which owns no Pages.
  assert.deepEqual(none, {
    pages: [],
    limit: 1,
    next_cursor: null,
    quota: { limit: 250, count: 0, trash_count: 0 },
  });
  assert.deepEqual(await list(parent), none);

  // Readable children past the bound: only they show, with a cursor exactly
  // while another readable child follows. Rows order by Page ID, descending,
  // so the two smallest IDs sit after every hidden child.
  const readable = [...children].sort().slice(0, 2);
  for (const pageId of readable) await grant(w, pageId);
  const first = await list(parent);
  assert.deepEqual(
    first.pages.map((page) => page.page_id),
    [readable[1]],
  );
  assert.equal(typeof first.next_cursor, "string");
  const second = await list(parent, { cursor: first.next_cursor });
  assert.deepEqual(
    second.pages.map((page) => page.page_id),
    [readable[0]],
  );
  assert.equal(second.next_cursor, null);
  // One page that holds every readable child has no cursor.
  const whole = await list(parent, { limit: 5 });
  assert.deepEqual(whole.pages.map((page) => page.page_id).sort(), readable);
  assert.equal(whole.next_cursor, null);
  // A query that matches only a hidden child answers like the empty parent.
  const hidden = children.findIndex((pageId, index) => index >= 10 && !readable.includes(pageId));
  assert.deepEqual(await list(parent, { query: `Hidden ${hidden}` }), none);
});

test("a shared parent's readable children past the first 100 are reached through cursors", async (t) => {
  const w = await world(t);
  const parent = (await w.createPage({ title: "Parent" })).body.page_id;
  await grant(w, parent);
  const children = [];
  for (let index = 0; index < sharedChildBounds.scan + 5; index++)
    children.push(
      (await w.createPage({ title: `Child ${index}`, parent_id: parent })).body.page_id,
    );
  // Rows order by Page ID, descending, so the two smallest IDs sit past the
  // first 100 children a request checks.
  const readable = [...children].sort().slice(0, 2);
  for (const pageId of readable) await grant(w, pageId);
  const list = async (args = {}) => {
    const listed = await w.call("member", "list_pages", { parent_id: parent, ...args });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    return listed.body;
  };
  const follow = async (args) => {
    const seen = [];
    let cursor;
    for (let request = 0; request < 10; request++) {
      const page = await list({ ...args, ...(cursor && { cursor }) });
      seen.push(...page.pages.map((entry) => entry.page_id));
      cursor = page.next_cursor;
      if (!cursor) return { seen, requests: request + 1 };
    }
    assert.fail("the cursor never ended");
  };
  // The first request checks 100 hidden children and continues past them.
  const first = await list({ limit: 100 });
  assert.deepEqual(first.pages, []);
  assert.equal(typeof first.next_cursor, "string");
  const all = await follow({ limit: 100 });
  assert.deepEqual(all.seen.sort(), readable);
  assert.equal(all.requests, 2);
  // Title search reaches a readable child past the bound too.
  const title = `Child ${children.indexOf(readable[0])}`;
  const searched = await follow({ query: title });
  assert.deepEqual(searched.seen, [readable[0]]);
});

test("MCP location refusals carry their stable codes in structuredContent", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Codes");
  // A home Page can't move to Trash on its own.
  const home = await w.mcp("owner", "delete_page", {
    page_id: project.home_page_id,
    base_heads: w.heads(project.home_page_id),
    idempotency_key: w.key(),
  });
  assert.equal(home.isError, true);
  assert.equal(home.body.code, "home_page_protected");
  // A parent with sub-pages stays put.
  const parent = (await w.createPage({ title: "Parent", project_id: project.project_id })).body;
  const child = (await w.createPage({ title: "Child", parent_id: parent.page_id })).body;
  const busy = await w.mcp("owner", "delete_page", {
    page_id: parent.page_id,
    base_heads: w.heads(parent.page_id),
    idempotency_key: w.key(),
  });
  assert.equal(busy.body.code, "page_has_children");
  // A parent in another Project, and a parent in Trash.
  const other = await w.createProject("Other");
  const mismatch = await w.mcp("owner", "create_page", {
    title: "Wrong",
    project_id: other.project_id,
    parent_id: child.page_id,
    idempotency_key: w.key(),
  });
  assert.equal(mismatch.body.code, "placement_mismatch");
  const trashed = await w.call("owner", "delete_page", {
    page_id: child.page_id,
    base_heads: w.heads(child.page_id),
    idempotency_key: w.key(),
  });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  const underTrash = await w.mcp("owner", "create_page", {
    title: "Orphan",
    parent_id: child.page_id,
    idempotency_key: w.key(),
  });
  assert.equal(underTrash.body.code, "parent_unavailable");
  // One level past the model's depth limit.
  let deepest = parent.page_id;
  for (let depth = 2; depth <= MAX_DEPTH; depth++)
    deepest = (await w.createPage({ title: `Depth ${depth}`, parent_id: deepest })).body.page_id;
  const tooDeep = await w.mcp("owner", "create_page", {
    title: "Too deep",
    parent_id: deepest,
    idempotency_key: w.key(),
  });
  assert.equal(tooDeep.isError, true);
  assert.equal(tooDeep.body.code, "nesting_depth_exceeded");
});
