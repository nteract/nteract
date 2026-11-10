import assert from "node:assert/strict";
import { test } from "node:test";
import { world } from "./projects-fixture.mjs";
import {
  FORWARDED_CREATION_EVENTS,
  FORWARDED_CREATION_STATES,
  PROJECT_CREATE_PATH,
  forwardedCreationTransition,
} from "./project-create.mjs";
import { resetPageQuotaCache } from "./page-quota.mjs";

const stranger = "user:anaconda-fixture:stranger-user";

/** A Project the fixture owner owns, shared with the member as `role`. */
async function sharedProject(w, role, title = "Shared") {
  const project = await w.createProject(title);
  const granted = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role,
    expected_revision: 0,
    idempotency_key: w.key(),
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  return project;
}

const setRole = (w, project, role, expected_revision) =>
  w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role,
    expected_revision,
    idempotency_key: w.key(),
  });

const pageCount = async (w, who) => (await w.call(who, "list_pages")).body.quota.count;

/** Wrap the owner Catalog's forwarded-creation route. `around(run)` gets
 * the real call and returns the Response the member's Catalog sees. */
function aroundForward(t, w, around) {
  const get = w.env.CATALOGS.getByName.bind(w.env.CATALOGS);
  t.mock.method(w.env.CATALOGS, "getByName", (principal) => {
    const catalog = get(principal);
    if (principal !== w.owner) return catalog;
    return {
      ctx: catalog.ctx,
      fetch: (request, init) =>
        new URL(request.url).pathname === PROJECT_CREATE_PATH
          ? around(() => catalog.fetch(request, init))
          : catalog.fetch(request, init),
    };
  });
}

test("every forwarded-creation state takes exactly the events its table names", () => {
  const allowed = {
    absent: { request: ["authorizing", "resolve"] },
    authorizing: { authorized: ["forwarding", "reserve"], denied: ["absent", "reply"] },
    forwarding: {
      request: ["forwarding", "fence"],
      reserved: ["forwarding", "forward"],
      fenced: ["forwarding", "forward"],
      created: ["completed", "complete"],
      refused: ["absent", "release"],
      fence_moved: ["forwarding", "fence"],
      fence_exhausted: ["absent", "release"],
      failed: ["forwarding", "reply"],
    },
    completed: { request: ["completed", "replay"] },
  };
  for (const state of FORWARDED_CREATION_STATES)
    for (const event of FORWARDED_CREATION_EVENTS) {
      const expected = allowed[state][event];
      if (expected)
        assert.deepEqual(forwardedCreationTransition(state, event), {
          state: expected[0],
          effect: expected[1],
        });
      else assert.throws(() => forwardedCreationTransition(state, event), `${state} ${event}`);
    }
});

test("a Project editor creates Pages the Project owner owns, at the top level and under any Page", async (t) => {
  const w = await world(t);
  const project = await sharedProject(w, "editor");
  const ownerBefore = await pageCount(w, "owner");
  const top = await w.createPage(
    { title: "Editor's Page", project_id: project.project_id },
    "member",
  );
  assert.equal(top.status, 200, JSON.stringify(top.body));
  assert.equal(top.body.project_id, project.project_id);
  // Ownership: the Project owner's Page, with the editor recorded as creator.
  const host = w.page(top.body.page_id);
  assert.equal(host.metadata.owner, w.owner);
  assert.equal(host.metadata.ownerName, "Fixture Person");
  assert.deepEqual(host.metadata.creator, {
    principal: w.member,
    displayName: "Fixture Person",
  });
  const entry = await w.catalogStorage(w.owner).get(`page/${top.body.page_id}`);
  assert.equal(entry.creator, w.member);
  assert.equal(entry.pending, undefined);
  assert.equal(entry.owner_name, undefined);
  assert.equal(entry.space_id, project.project_id);
  assert.equal(await w.catalogStorage(w.member).get(`page/${top.body.page_id}`), undefined);
  // Quota: the owner's account pays, the editor's doesn't.
  assert.equal(await pageCount(w, "owner"), ownerBefore + 1);
  assert.equal(await pageCount(w, "member"), 0);
  // The receipt carries edit authority for the editor, and the editor reads
  // the Page through the Project.
  assert.match(top.body.retry_key_prefix, /^v1_[a-f0-9]{64}_$/);
  assert.equal(typeof top.body.retry_token, "string");
  assert.equal((await w.call("member", "read_page", { page_id: top.body.page_id })).status, 200);

  // Under a Page the owner created, and under the Page the editor created.
  const ownersPage = (await w.createPage({ title: "Owner's", project_id: project.project_id }))
    .body;
  for (const parent of [ownersPage.page_id, top.body.page_id]) {
    const child = await w.createPage({ title: "Child", parent_id: parent }, "member");
    assert.equal(child.status, 200, JSON.stringify(child.body));
    assert.equal(child.body.parent_id, parent);
    assert.equal(child.body.project_id, project.project_id);
    assert.equal(w.page(child.body.page_id).metadata.owner, w.owner);
  }
  // Both accounts list the new Pages in the Project.
  for (const who of ["owner", "member"]) {
    const listed = await w.call(who, "list_pages", { project_id: project.project_id });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(
      listed.body.pages.some((page) => page.page_id === top.body.page_id),
      who,
    );
    assert.equal(listed.body.pages.length, 4, who);
  }
  assert.equal(await pageCount(w, "member"), 0);
  // A parent with project_id naming another Project is a mismatch.
  const other = await sharedProject(w, "editor", "Other");
  const mismatch = await w.createPage(
    { parent_id: ownersPage.page_id, project_id: other.project_id },
    "member",
  );
  assert.equal(mismatch.body.code, "placement_mismatch");
});

for (const role of ["viewer", "commenter"])
  test(`a Project ${role} can't add Pages and reserves nothing`, async (t) => {
    const w = await world(t);
    const project = await sharedProject(w, role);
    const parent = (await w.createPage({ title: "Parent", project_id: project.project_id })).body;
    const ownerBefore = await pageCount(w, "owner");
    for (const placement of [{ project_id: project.project_id }, { parent_id: parent.page_id }]) {
      const refused = await w.createPage(placement, "member");
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
      assert.equal(refused.body.code, "project_create_forbidden");
      assert.match(refused.body.error, new RegExp(`your role in this Project is ${role}`));
    }
    assert.equal(await pageCount(w, "owner"), ownerBefore);
    assert.equal((await w.catalogStorage(w.member).list({ prefix: "host/operation/" })).size, 0);
  });

test("someone outside the Project sees it as missing", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Private");
  const parent = (await w.createPage({ title: "Parent", project_id: project.project_id })).body;
  const top = await w.createPage({ project_id: project.project_id }, "stranger");
  assert.equal(top.status, 404);
  assert.equal(top.body.code, "project_not_found");
  const nested = await w.createPage({ parent_id: parent.page_id }, "stranger");
  assert.equal(nested.status, 404);
  assert.equal(nested.body.code, "parent_unavailable");
  assert.equal((await w.catalogStorage(stranger).list({ prefix: "host/operation/" })).size, 0);
});

test("a full owner quota refuses the editor with the owner's limit, not the editor's", async (t) => {
  const w = await world(t);
  const project = await sharedProject(w, "editor");
  // The owner's gateway resolves a limit of 2: the Project's content
  // document and one Page fill it.
  w.env.PAGES_DEFAULT_PAGE_QUOTA = "2";
  resetPageQuotaCache(w.db);
  await w.createPage({ title: "Fills it", project_id: project.project_id });
  assert.equal((await w.call("owner", "list_pages")).body.quota.count, 2);
  w.env.PAGES_DEFAULT_PAGE_QUOTA = "250";
  resetPageQuotaCache(w.db);
  const refused = await w.createPage({ project_id: project.project_id }, "member");
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "project_owner_quota_exceeded");
  assert.match(refused.body.error, /Project's owner has reached their limit of 2 Pages/);
  assert.equal(refused.body.limit, 2);
  assert.equal(refused.body.count, undefined);
  assert.equal((await w.catalogStorage(w.member).list({ prefix: "host/operation/" })).size, 0);
  // The editor's own account still has room for its own Pages.
  assert.equal((await w.createPage({ title: "Mine" }, "member")).status, 200);
  // Room in the owner's account lets the same request through.
  await w.catalogStorage(w.owner).put("host/page-limit", { limit: 10, at: Date.now() });
  const retried = await w.call("member", "create_page", {
    title: "Untitled",
    project_id: project.project_id,
    idempotency_key: w.key(),
  });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
});

test("a retried editor creation resumes the same Page, with or without a retry token", async (t) => {
  const w = await world(t);
  const project = await sharedProject(w, "editor");
  const ownerBefore = await pageCount(w, "owner");
  let lose = true;
  aroundForward(t, w, async (run) => {
    const response = await run();
    if (!lose) return response;
    lose = false;
    return Response.json({ error: "Lost response" }, { status: 500 });
  });
  const listed = (await w.call("member", "list_pages")).body;
  const args = {
    title: "Once",
    project_id: project.project_id,
    idempotency_key: listed.retry_key_prefix + crypto.randomUUID(),
    retry_token: listed.retry_token,
  };
  const lost = await w.call("member", "create_page", args);
  assert.equal(lost.status, 500);
  const first = await w.call("member", "create_page", args);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await w.call("member", "create_page", args);
  assert.deepEqual(again.body, first.body);
  assert.equal(await pageCount(w, "owner"), ownerBefore + 1);
  // The same key with a different payload is a conflict, not a new Page.
  const conflict = await w.call("member", "create_page", { ...args, title: "Twice" });
  assert.equal(conflict.body.code, "idempotency_conflict");
  // A tokenless key replays too.
  const plain = { title: "Plain", project_id: project.project_id, idempotency_key: w.key() };
  const created = await w.call("member", "create_page", plain);
  assert.equal(created.status, 200);
  assert.deepEqual((await w.call("member", "create_page", plain)).body, created.body);
  assert.equal(await pageCount(w, "owner"), ownerBefore + 2);
});

test("a retry after the editor is removed completes the reserved creation once", async (t) => {
  const w = await world(t);
  const project = await sharedProject(w, "editor");
  const ownerBefore = await pageCount(w, "owner");
  let lose = true;
  aroundForward(t, w, async (run) => {
    const response = await run();
    if (!lose) return response;
    lose = false;
    return Response.json({ error: "Lost response" }, { status: 500 });
  });
  const args = { title: "Reserved", project_id: project.project_id, idempotency_key: w.key() };
  assert.equal((await w.call("member", "create_page", args)).status, 500);
  assert.equal((await setRole(w, project, null, 1)).status, 200);
  const retried = await w.call("member", "create_page", args);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(await pageCount(w, "owner"), ownerBefore + 1);
  // The removed editor keeps no access to the Page it created.
  assert.equal(
    (await w.call("member", "read_page", { page_id: retried.body.page_id })).status,
    403,
  );
  // A new request is refused like any non-member's.
  const fresh = await w.createPage({ project_id: project.project_id }, "member");
  assert.equal(fresh.body.code, "project_not_found");
});

test("a downgrade between the editor's decision and the owner's write is refused by the fence", async (t) => {
  const w = await world(t);
  const project = await sharedProject(w, "editor");
  const ownerBefore = await pageCount(w, "owner");
  let downgrade = true;
  aroundForward(t, w, async (run) => {
    if (downgrade) {
      downgrade = false;
      assert.equal((await setRole(w, project, "viewer", 1)).status, 200);
    }
    return run();
  });
  const refused = await w.createPage({ project_id: project.project_id }, "member");
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "project_create_forbidden");
  assert.equal(await pageCount(w, "owner"), ownerBefore);
  assert.equal((await w.catalogStorage(w.member).list({ prefix: "host/operation/" })).size, 0);
});

test("an ACL that keeps moving gives up without reserving a Page", async (t) => {
  const w = await world(t);
  const project = await sharedProject(w, "editor");
  const storage = w.projects.get(project.project_id).ctx.storage;
  let forwards = 0;
  aroundForward(t, w, async (run) => {
    forwards++;
    const record = await storage.get("space/record");
    await storage.put("space/record", {
      ...record,
      acl: { ...record.acl, revision: record.acl.revision + 1 },
    });
    return run();
  });
  const refused = await w.createPage({ project_id: project.project_id }, "member");
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "project_access_changed");
  assert.equal(forwards, 3);
  assert.equal((await w.catalogStorage(w.member).list({ prefix: "host/operation/" })).size, 0);
});

test("a Page host refuses a forged owner and a creation reserved for someone else", async (t) => {
  const w = await world(t);
  const project = await sharedProject(w, "editor");
  const create = (pageId, owner) =>
    w.env.PAGES.getByName(pageId).fetch(
      new Request("https://pages.invalid/internal/create", {
        method: "POST",
        headers: {
          authorization: `Bearer ${w.auth.apiKey({ userId: "member-user" })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ page_id: pageId, title: "Forged", owner }),
      }),
    );
  // No pending entry in the owner's Catalog.
  const forged = crypto.randomUUID();
  assert.equal((await create(forged, w.owner)).status, 403);
  assert.equal(w.page(forged).metadata, undefined);
  // A pending entry reserved for another creator.
  const other = crypto.randomUUID();
  await w.catalogStorage(w.owner).put(`page/${other}`, {
    page_id: other,
    title: "",
    pending: true,
    creator: stranger,
    parent_id: null,
    space_id: project.project_id,
  });
  assert.equal((await create(other, w.owner)).status, 403);
  // The owner's Catalog answers creation checks to hosts only.
  const withCredential = await w.env.CATALOGS.getByName(w.owner).fetch(
    new Request("https://pages.invalid/internal/location", {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey({ userId: "member-user" })}` },
      body: JSON.stringify({ creation_of: other }),
    }),
  );
  assert.equal(withCredential.status, 403);
});

test("a lost Page host answer resumes through the owner's pending entry, after a removal too", async (t) => {
  const w = await world(t);
  const project = await sharedProject(w, "editor");
  const ownerBefore = await pageCount(w, "owner");
  const get = w.env.PAGES.getByName.bind(w.env.PAGES);
  let lose = true;
  t.mock.method(w.env.PAGES, "getByName", (id) => ({
    fetch: async (request, init) => {
      const forward = new URL(request.url).pathname === "/internal/create" && lose;
      const response = await get(id).fetch(request, init);
      if (!forward) return response;
      lose = false;
      return Response.json({ error: "Lost response" }, { status: 500 });
    },
  }));
  const args = { title: "Resumed", project_id: project.project_id, idempotency_key: w.key() };
  assert.equal((await w.call("member", "create_page", args)).status, 500);
  // The Page exists, owned by the Project owner; its Catalog entry is pending.
  const pending = [...(await w.catalogStorage(w.owner).list({ prefix: "page/" })).values()].find(
    (entry) => entry.pending,
  );
  assert.equal(pending.creator, w.member);
  assert.equal(w.page(pending.page_id).metadata.owner, w.owner);
  assert.equal((await setRole(w, project, null, 1)).status, 200);
  const retried = await w.call("member", "create_page", args);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.page_id, pending.page_id);
  assert.equal(await pageCount(w, "owner"), ownerBefore + 1);
  // Once the entry is committed, nothing can vouch for the creator again.
  const replay = await get(pending.page_id).fetch(
    new Request("https://pages.invalid/internal/create", {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey({ userId: "member-user" })}` },
      body: JSON.stringify({ page_id: pending.page_id, title: "Resumed", owner: w.owner }),
    }),
  );
  assert.equal(replay.status, 403);
});
