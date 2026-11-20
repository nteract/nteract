import assert from "node:assert/strict";
import { test } from "node:test";
import { world } from "./projects-fixture.mjs";
import { PROJECT_ACCESS_LEASE_MS, resolveProjectAccess } from "./project-access.mjs";

// A Page in a Project grants its members access through a Project snapshot
// the Page host resolves on each request. A resolution that could not read
// the Project is not an answer: it must not refuse as "access denied", and it
// must not take inherited access away from callers it did not belong to.

/** Make every Project policy read fail while `failing` is set. */
function projectOutage(t, w) {
  const projects = w.env.PROJECTS.getByName.bind(w.env.PROJECTS);
  const state = { failing: false };
  t.mock.method(w.env.PROJECTS, "getByName", (id) => {
    const project = projects(id);
    return {
      fetch: async (request, init) => {
        if (state.failing && new URL(request.url).pathname === "/internal/space/policy")
          throw Error("Project unavailable");
        return project.fetch(request, init);
      },
    };
  });
  return state;
}

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

const read = (w, who, pageId) => w.call(who, "read_page", { page_id: pageId });

const codeOf = (body) => body?.code ?? body?.error?.code;

test("a known Project member whose Project read fails is told to try again, not refused", async (t) => {
  const { w, project, pageId } = await projectPage(t);
  assert.equal((await setProjectRole(w, project, "editor", 0)).status, 200);
  assert.equal((await read(w, "member", pageId)).status, 200);
  // The snapshot's lease runs out; the next read can't renew it.
  const host = w.page(pageId);
  host.projectAccessState = {
    ...host.projectAccessState,
    snapshot: { ...host.projectAccessState.snapshot, valid_until: Date.now() - 1 },
  };
  const outage = projectOutage(t, w);
  outage.failing = true;
  const unavailable = await read(w, "member", pageId);
  assert.equal(unavailable.status, 503, JSON.stringify(unavailable.body));
  assert.equal(codeOf(unavailable.body), "project_policy_unavailable");
  outage.failing = false;
  const admitted = await read(w, "member", pageId);
  assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
});

test("during a Project outage a stranger is refused exactly as without one", async (t) => {
  const { w, project, pageId } = await projectPage(t);
  assert.equal((await setProjectRole(w, project, "editor", 0)).status, 200);
  assert.equal((await read(w, "member", pageId)).status, 200, "the host holds a snapshot");
  const usual = await read(w, "stranger", pageId);
  assert.equal(usual.status, 403, JSON.stringify(usual.body));
  const outage = projectOutage(t, w);
  outage.failing = true;
  const refused = await read(w, "stranger", pageId);
  assert.equal(refused.status, usual.status, JSON.stringify(refused.body));
  assert.deepEqual(refused.body, usual.body);
});

test("a host with no settled Project snapshot refuses a member as for a stranger", async (t) => {
  const { w, project, pageId } = await projectPage(t);
  assert.equal((await setProjectRole(w, project, "editor", 0)).status, 200);
  const outage = projectOutage(t, w);
  outage.failing = true;
  const refused = await read(w, "member", pageId);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
});

test("a direct Page grant still opens a Project Page while the Project can't be read", async (t) => {
  const { w, pageId } = await projectPage(t);
  const shared = await w.call("owner", "manage_page_access", {
    page_id: pageId,
    action: "set_role",
    principal: w.member,
    role: "viewer",
    expected_revision: 0,
    nonce: w.key(),
  });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  const outage = projectOutage(t, w);
  outage.failing = true;
  const admitted = await read(w, "member", pageId);
  assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
});

test("a Page outside any Project refuses a stranger as before", async (t) => {
  const w = await world(t);
  const created = await w.createPage({ title: "Alone" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  await w.settle();
  const outage = projectOutage(t, w);
  outage.failing = true;
  const refused = await read(w, "stranger", created.body.page_id);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
});

test("one caller's failed Project read leaves inherited access in place for others", async (t) => {
  const { w, project, pageId } = await projectPage(t);
  assert.equal((await setProjectRole(w, project, "editor", 0)).status, 200);
  const host = w.page(pageId);
  const identities = new Map();
  const identify = host.identify.bind(host);
  t.mock.method(host, "identify", async (request) => {
    const identity = await identify(request);
    identities.set(identity.principal, identity);
    return identity;
  });
  assert.equal((await read(w, "member", pageId)).status, 200);
  const member = identities.get(w.member);
  const snapshot = host.projectAccess;
  assert.ok(snapshot, "the member's read installed the Project snapshot");

  // Someone else asks while the Project can't be read.
  const outage = projectOutage(t, w);
  outage.failing = true;
  await read(w, "stranger", pageId);
  outage.failing = false;

  assert.equal(host.projectAccess, snapshot, "a failed read installs nothing");
  assert.equal(host.policy.account(member, true).role, "editor");
});

test("a member removed from the Project loses access at the next read after a failed one", async (t) => {
  const { w, project, pageId } = await projectPage(t);
  assert.equal((await setProjectRole(w, project, "editor", 0)).status, 200);
  assert.equal((await read(w, "member", pageId)).status, 200);
  const outage = projectOutage(t, w);
  outage.failing = true;
  await read(w, "stranger", pageId);
  outage.failing = false;
  assert.equal((await setProjectRole(w, project, null, 1)).status, 200);
  const refused = await read(w, "member", pageId);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(w.page(pageId).projectAccess.revision, 2, "the removal is installed");
});

// resolveProjectAccess on its own: a settled answer is a snapshot or null; a
// read it could not finish throws project_policy_unavailable.

const now = 1000;
const metadata = { pageId: "page", owner: "user:owner" };
const project = {
  space_id: "prj_00000000-0000-4000-8000-000000000001",
  owner: "user:owner",
  acl: { revision: 1, members: { "user:member": { role: "editor", generation: 1 } } },
};

/** An env whose Catalog answers `locations` in turn and whose Project answers
 * `policy`. Each answer is a value to send as JSON, or a Response. */
function env({ locations, policy = project }) {
  let reads = 0;
  const answer = (value) => (value instanceof Response ? value : Response.json(value));
  return {
    CATALOGS: {
      getByName: () => ({
        fetch: async () => answer(locations[Math.min(reads++, locations.length - 1)]),
      }),
    },
    PROJECTS: { getByName: () => ({ fetch: async () => answer(policy) }) },
  };
}

const placed = { complete: true, space_id: project.space_id };

test("resolveProjectAccess answers null only for a settled placement outside a Project", async () => {
  assert.equal(
    await resolveProjectAccess(
      env({ locations: [{ complete: true, space_id: null }] }),
      metadata,
      now,
    ),
    null,
  );
  assert.equal(
    await resolveProjectAccess(
      env({ locations: [{ complete: false, space_id: null }] }),
      metadata,
      now,
    ),
    null,
    "a broken parent chain reaches no Project",
  );
  assert.equal(
    await resolveProjectAccess(
      env({ locations: [placed], policy: { ...project, owner: "user:other" } }),
      metadata,
      now,
    ),
    null,
    "a Project with another owner grants nothing",
  );
  const snapshot = await resolveProjectAccess(env({ locations: [placed] }), metadata, now);
  assert.equal(snapshot.valid_until, now + PROJECT_ACCESS_LEASE_MS);
});

test("resolveProjectAccess throws project_policy_unavailable for a read it could not finish", async () => {
  const failed = new Response("{}", { status: 500 });
  for (const [label, setup] of [
    ["the first location read fails", { locations: [failed] }],
    ["the Project policy read fails", { locations: [placed], policy: failed }],
    ["the second location read fails", { locations: [placed, failed] }],
    [
      "the Page moves between the location reads",
      { locations: [placed, { complete: true, space_id: null }] },
    ],
  ])
    await assert.rejects(resolveProjectAccess(env(setup), metadata, now), (error) => {
      assert.equal(error.status, 503, label);
      assert.equal(error.code, "project_policy_unavailable", label);
      return true;
    });
  const thrown = {
    CATALOGS: { getByName: () => ({ fetch: async () => Promise.reject(Error("down")) }) },
    PROJECTS: env({ locations: [placed] }).PROJECTS,
  };
  await assert.rejects(resolveProjectAccess(thrown, metadata, now), {
    code: "project_policy_unavailable",
  });
});
