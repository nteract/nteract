import assert from "node:assert/strict";
import { test } from "node:test";
import { Page } from "./index.mjs";
import { world } from "./projects-fixture.mjs";

// A shared-Page check (`/internal/catalog`) on a Page host that hasn't booted
// answers from its record (catalogFromRecord). For a caller who isn't the
// owner it resolves the Page's Project access once, in `identify`, and the
// answer reuses that resolution. These hosts are built by the real
// constructor over the storage of a Page the world created.

/** Count the owner Catalog's location reads and the Project policy reads
 * that resolveProjectAccess makes. */
function countResolutions(t, w) {
  const counts = { catalog: 0, project: 0 };
  const catalogs = w.env.CATALOGS.getByName.bind(w.env.CATALOGS);
  t.mock.method(w.env.CATALOGS, "getByName", (principal) => {
    const catalog = catalogs(principal);
    return {
      fetch: (request, init) => {
        if (principal === w.owner && new URL(request.url).pathname === "/internal/location")
          counts.catalog++;
        return catalog.fetch(request, init);
      },
    };
  });
  const projects = w.env.PROJECTS.getByName.bind(w.env.PROJECTS);
  let failing = false;
  t.mock.method(w.env.PROJECTS, "getByName", (id) => {
    const project = projects(id);
    return {
      fetch: async (request, init) => {
        if (new URL(request.url).pathname === "/internal/space/policy") {
          counts.project++;
          if (failing) throw Error("Project unavailable");
        }
        return project.fetch(request, init);
      },
    };
  });
  return {
    counts,
    fail: (value) => {
      failing = value;
    },
    reset: () => {
      counts.catalog = 0;
      counts.project = 0;
    },
  };
}

/** A shared-Page check as `who`, on a new host over the Page's storage that
 * answers from its record. */
async function check(t, w, pageId, who) {
  t.mock.method(Page.prototype, "initializeRepo", async () => {
    throw Error("a check from the record must not boot");
  });
  const storage = w.page(pageId).ctx.storage;
  // The title the record answers with, as a host that projected it stores.
  await storage.put("host/title-projection", {
    title: "Child",
    observed_at: "2026-11-01T10:00:00.000Z",
    keep: true,
  });
  const host = new Page(
    {
      id: { name: pageId },
      storage,
      blockConcurrencyWhile: (fn) => fn(),
      waitUntil: (promise) => w.jobs.push(promise),
    },
    w.env,
  );
  await host.ready;
  assert.equal(host.startup.name, "metadata");
  const response = await host.fetch(
    new Request("https://pages.invalid/internal/catalog", {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey(USERS[who])}` },
      body: "{}",
    }),
  );
  Page.prototype.initializeRepo.mock.restore();
  return { status: response.status, body: await response.json() };
}

const USERS = {
  member: { userId: "member-user" },
  stranger: { userId: "stranger-user" },
};

async function projectPage(t) {
  const w = await world(t);
  const project = await w.createProject("Shared");
  const created = await w.createPage({ title: "Child", project_id: project.project_id });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  await w.settle();
  return { w, project, pageId: created.body.page_id };
}

const setProjectRole = (w, project, role, expected_revision) =>
  w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role,
    expected_revision,
    nonce: w.key(),
  });

test("a shared check from the record resolves Project access once", async (t) => {
  const { w, project, pageId } = await projectPage(t);
  assert.equal((await setProjectRole(w, project, "editor", 0)).status, 200);
  const resolutions = countResolutions(t, w);
  const inherited = await check(t, w, pageId, "member");
  assert.equal(inherited.status, 200, JSON.stringify(inherited.body));
  assert.equal(inherited.body.role, "editor");
  // One resolution: two location reads of the owner's Catalog (before and
  // after the policy read) and one Project policy read.
  assert.deepEqual(resolutions.counts, { catalog: 2, project: 1 });
});

test("a shared check from the record answers each relation as before", async (t) => {
  const { w, project, pageId } = await projectPage(t);
  const resolutions = countResolutions(t, w);

  // Not a member of the Project or the Page.
  const stranger = await check(t, w, pageId, "stranger");
  assert.equal(stranger.status, 403);
  assert.deepEqual(resolutions.counts, { catalog: 2, project: 1 });

  // An inherited Project member.
  assert.equal((await setProjectRole(w, project, "commenter", 0)).status, 200);
  resolutions.reset();
  const inherited = await check(t, w, pageId, "member");
  assert.equal(inherited.status, 200, JSON.stringify(inherited.body));
  assert.equal(inherited.body.role, "commenter");
  assert.deepEqual(resolutions.counts, { catalog: 2, project: 1 });

  // A failed resolution grants nothing inherited. This new host has no
  // settled snapshot to know the member by, so it refuses as for a stranger.
  resolutions.reset();
  resolutions.fail(true);
  assert.equal((await check(t, w, pageId, "member")).status, 403);
  assert.deepEqual(resolutions.counts, { catalog: 1, project: 1 });
  resolutions.fail(false);

  // Removed from the Project.
  assert.equal((await setProjectRole(w, project, null, 1)).status, 200);
  resolutions.reset();
  assert.equal((await check(t, w, pageId, "member")).status, 403);
  assert.deepEqual(resolutions.counts, { catalog: 2, project: 1 });
});

test("a moved Page answers with the Project it is in now", async (t) => {
  const { w, project: from, pageId } = await projectPage(t);
  const to = await w.createProject("Elsewhere");
  const moved = await w.call("owner", "move_page", {
    page_id: pageId,
    project_id: to.project_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  await w.settle();
  // A member of the Project the Page left.
  assert.equal((await setProjectRole(w, from, "editor", 0)).status, 200);
  const resolutions = countResolutions(t, w);
  assert.equal((await check(t, w, pageId, "member")).status, 403);
  assert.deepEqual(resolutions.counts, { catalog: 2, project: 1 });
  // A member of the Project it is in now.
  assert.equal((await setProjectRole(w, to, "viewer", 0)).status, 200);
  resolutions.reset();
  const inherited = await check(t, w, pageId, "member");
  assert.equal(inherited.status, 200, JSON.stringify(inherited.body));
  assert.equal(inherited.body.role, "viewer");
  assert.deepEqual(resolutions.counts, { catalog: 2, project: 1 });
});

test("a direct Page member outside any Project resolves once", async (t) => {
  const w = await world(t);
  const created = await w.createPage({ title: "Direct" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const pageId = created.body.page_id;
  const shared = await w.call("owner", "manage_page_access", {
    page_id: pageId,
    action: "set_role",
    principal: w.member,
    role: "viewer",
    expected_revision: 0,
    nonce: w.key(),
  });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  await w.settle();
  const resolutions = countResolutions(t, w);
  const member = await check(t, w, pageId, "member");
  assert.equal(member.status, 200, JSON.stringify(member.body));
  assert.equal(member.body.role, "viewer");
  // Outside a Project the location read ends the resolution.
  assert.deepEqual(resolutions.counts, { catalog: 1, project: 0 });
});
