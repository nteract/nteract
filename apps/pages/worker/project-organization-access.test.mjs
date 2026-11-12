import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_ACTOR_CHAIN, decide, pageObject, principalOf, projectObject } from "./authz.mjs";
import { KILO_MEMBERSHIP_SECONDS } from "./kilo-config.mjs";
import { resetMembershipCache } from "./kilo-membership.mjs";
import { PROJECT_ACCESS_LEASE_MS } from "./project-access.mjs";
import { world } from "./projects-fixture.mjs";

const now = Math.floor(Date.now() / 1000) * 1000;
const namespace = "user:kilo";
const acme = Object.freeze({ id: "org-acme", name: "Acme Research" });
const other = Object.freeze({ id: "org-other", name: "Other Guild" });
const owner = `${namespace}:owner`;
const reader = `${namespace}:reader`;

const grant = (role, organization = acme, space = namespace) => ({
  id: organization.id,
  name: organization.name,
  namespace: space,
  role,
});
const project = (organizationAccess, members = {}) => ({
  space_id: "prj_00000000-0000-4000-8000-000000000001",
  owner,
  acl: {
    revision: 3,
    members,
    invites: {},
    ...(organizationAccess && { organizationAccess }),
  },
});
const memberRow = (role) => ({ role, generation: 1 });
/** An identity whose organization leases are `organizations`. */
const identity = (
  organizations = [acme],
  { expiresAt = now + 30_000, space = namespace } = {},
) => ({
  principal: reader,
  namespace,
  canWrite: true,
  expiresAt: now + 60_000,
  organizations: organizations.map((organization) => ({
    ...organization,
    namespace: space,
    expiresAt,
  })),
});
/** decide() on a Page in `record`, as its host sees it with a current
 * Project lease. */
const onPage = (record, who, at = now) => {
  const principal = principalOf(who);
  const container = {
    ...projectObject(record),
    members: record.acl.members,
    valid_until: now + PROJECT_ACCESS_LEASE_MS,
  };
  return decide(
    principal,
    NO_ACTOR_CHAIN,
    pageObject({ pageId: "in-project", owner, deleted: false, projectAccess: container }, reader),
    at,
  );
};
const onProject = (record, who, at = now) =>
  decide(principalOf(who), NO_ACTOR_CHAIN, projectObject(record), at);

test("a Project's organization grant gives each role to current members on the Project and its Pages", () => {
  const expected = {
    viewer: { page: ["read"], project: ["read"] },
    commenter: { page: ["read", "comment"], project: ["read"] },
    editor: {
      page: ["read", "comment", "edit", "create_items"],
      project: ["read", "create_items"],
    },
  };
  for (const [role, capabilities] of Object.entries(expected)) {
    const record = project(grant(role));
    const page = onPage(record, identity());
    assert.deepEqual(page.capabilities, capabilities.page, role);
    assert.deepEqual(page.basis, { relation: role, via: "project" }, role);
    const own = onProject(record, identity());
    assert.deepEqual(own.capabilities, capabilities.project, role);
    assert.deepEqual(own.basis, { relation: role, via: "organization" }, role);
  }
});

test("the grant holds until the earlier of the Project lease and the organization lease", () => {
  const record = project(grant("editor"));
  assert.equal(
    onPage(record, identity([acme], { expiresAt: now + 5_000 })).valid_until,
    now + 5_000,
  );
  assert.equal(
    onPage(record, identity([acme], { expiresAt: now + 60_000 })).valid_until,
    now + PROJECT_ACCESS_LEASE_MS,
  );
  // At the lease's end the decision has lapsed.
  assert.deepEqual(
    onPage(record, identity([acme], { expiresAt: now + 5_000 }), now + 5_000).capabilities,
    [],
  );
});

test("no lease, an expired lease, a cleared grant or another namespace's organization grants nothing", () => {
  const record = project(grant("editor"));
  for (const [label, who, target] of [
    ["no lease", identity([]), record],
    ["another organization", identity([other]), record],
    ["an expired lease", identity([acme], { expiresAt: now }), record],
    ["a cleared grant", identity(), project(null)],
    ["another namespace", identity([acme], { space: "user:elsewhere" }), record],
    ["a grant in another namespace", identity(), project(grant("editor", acme, "user:elsewhere"))],
  ]) {
    assert.deepEqual(onPage(target, who).capabilities, [], label);
    assert.deepEqual(onProject(target, who).capabilities, [], label);
  }
});

test("a member row and the organization grant combine: the higher role wins", () => {
  const lower = project(grant("editor"), { [reader]: memberRow("viewer") });
  assert.deepEqual(onPage(lower, identity()).basis, { relation: "editor", via: "project" });
  assert.deepEqual(onProject(lower, identity()).basis, { relation: "editor", via: "organization" });
  const higher = project(grant("viewer"), { [reader]: memberRow("editor") });
  assert.deepEqual(onPage(higher, identity()).basis, { relation: "editor", via: "project" });
  assert.deepEqual(onProject(higher, identity()).basis, { relation: "editor", via: "direct" });
  // Without the lease, the member row alone stands.
  assert.deepEqual(onPage(lower, identity([])).basis, { relation: "viewer", via: "project" });
});

// ---------------------------------------------------------------------------
// Through the hosts, with Kilo agent tokens.

const manage = (w, who, args) => w.call(who, "manage_project_access", { nonce: w.key(), ...args });
const share = (w, projectId, organization_id, role, expected_revision) =>
  manage(w, "owner", {
    project_id: projectId,
    action: "set_organization_access",
    organization_id,
    ...(role !== undefined && { role }),
    expected_revision,
  });
/** The Project ids `who`'s list_projects returns. Any answer but a 200 with a
 * `projects` array fails, so an empty list always means an empty listing. */
const listed = async (w, who) => {
  const response = await w.call(who, "list_projects");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(Array.isArray(response.body.projects), JSON.stringify(response.body));
  return response.body.projects.map(({ project_id }) => project_id);
};

test("an owner shares a Project only with an organization they hold a lease for, and the name is the lease's", async (t) => {
  const w = await world(t, { kilo: { owner: [acme], member: [acme], stranger: [other] } });
  const { project_id } = await w.createProject("Guild");
  const read = await w.call("owner", "get_project_access", { project_id });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.organizationOptions, [acme]);
  assert.deepEqual(read.body.organizationProof, { [acme.id]: "verified" });
  assert.equal(read.body.organizationAccess, null);
  const refused = await share(w, project_id, other.id, "viewer", 0);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "organization_proof_required");
  const named = await manage(w, "owner", {
    project_id,
    action: "set_organization_access",
    organization_id: acme.id,
    role: "viewer",
    name: "Forged Name",
    expected_revision: 0,
  });
  assert.equal(named.status, 400);
  assert.equal(named.body.code, "invalid_arguments");
  const nonce = w.key();
  const args = {
    project_id,
    action: "set_organization_access",
    organization_id: acme.id,
    role: "editor",
    expected_revision: 0,
    nonce,
  };
  const set = await w.call("owner", "manage_project_access", args);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.revision, 1);
  assert.deepEqual(set.body.organizationAccess, { ...acme, role: "editor" });
  assert.deepEqual((await w.call("owner", "manage_project_access", args)).body, set.body);
  const stored = await w.projects.get(project_id).ctx.storage.get("space/record");
  assert.deepEqual(stored.acl.organizationAccess, grant("editor"));
  assert.deepEqual(stored.acl.members, {});
  // Only the owner manages it.
  const member = await manage(w, "member", { ...args, nonce: w.key(), expected_revision: 1 });
  assert.equal(member.status, 403);
  // Clearing needs no lease.
  w.organizations("owner", []);
  const cleared = await share(w, project_id, null, undefined, 1);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.organizationAccess, null);
});

test("an organization member reaches the Project and its Pages at the grant's role, and finds it after opening it", async (t) => {
  const w = await world(t, { kilo: { owner: [acme], member: [acme], stranger: [other] } });
  const { project_id } = await w.createProject("Guild");
  const child = (await w.createPage({ title: "Child", project_id })).body;
  assert.equal((await share(w, project_id, acme.id, "editor", 0)).status, 200);
  assert.deepEqual(await listed(w, "member"), [], "nothing is listed before an open");
  const opened = await w.call("member", "get_project", { project_id });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.role, "editor");
  assert.deepEqual(await listed(w, "member"), [project_id]);
  const pages = await w.call("member", "list_pages", { project_id });
  assert.equal(pages.status, 200, JSON.stringify(pages.body));
  assert.ok(pages.body.pages.some((page) => page.page_id === child.page_id));
  const edit = async (title) => {
    const read = await w.call("member", "read_page", { page_id: child.page_id });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    return w.call("member", "edit_page", {
      page_id: child.page_id,
      operations: [{ op: "set_title", title }],
      revision: read.body.revision,
      nonce: w.key(),
    });
  };
  const edited = await edit("Edited by the guild");
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(w.page(child.page_id).metadata.acl?.members?.[w.member], undefined);
  assert.equal((await share(w, project_id, acme.id, "viewer", 1)).status, 200);
  assert.equal((await edit("Edited as a viewer")).status, 403);
  // Another organization's member reaches nothing.
  assert.equal((await w.call("stranger", "get_project", { project_id })).status, 404);
  assert.equal((await w.call("stranger", "read_page", { page_id: child.page_id })).status, 403);
});

test("the Project leaves the member's list when the grant clears, the lease ends, or Kilo stops listing them", async (t) => {
  const w = await world(t, { kilo: { owner: [acme], member: [acme] } });
  const { project_id } = await w.createProject("Guild");
  const child = (await w.createPage({ title: "Child", project_id })).body;
  let revision = 0;
  const open = async () => {
    assert.equal((await w.call("member", "get_project", { project_id })).status, 200);
    assert.deepEqual(await listed(w, "member"), [project_id]);
  };
  const gone = async (label) => {
    assert.deepEqual(await listed(w, "member"), [], label);
    assert.equal((await w.call("member", "get_project", { project_id })).status, 404, label);
    assert.equal(
      (await w.call("member", "read_page", { page_id: child.page_id })).status,
      403,
      label,
    );
  };
  assert.equal((await share(w, project_id, acme.id, "viewer", revision++)).status, 200);
  await open();
  assert.equal((await share(w, project_id, null, undefined, revision++)).status, 200);
  await gone("the grant cleared");
  assert.equal((await share(w, project_id, acme.id, "viewer", revision++)).status, 200);
  await open();
  // The member's evidence ages past its lease.
  await w.env.DB.prepare("UPDATE kilo_memberships SET verified_at_ms = ? WHERE principal = ?")
    .bind(Date.now() - KILO_MEMBERSHIP_SECONDS * 1000 - 1000, w.member)
    .run();
  resetMembershipCache();
  await gone("the lease ended");
  // A new exchange that lists the organization restores it; one that doesn't
  // ends it again.
  w.organizations("member", [acme]);
  await open();
  w.organizations("member", []);
  await gone("Kilo stopped listing the organization");
});

test("an organization member's repeated opens write the discovery hint once, with when it was written", async (t) => {
  const w = await world(t, { kilo: { owner: [acme], member: [acme] } });
  const { project_id } = await w.createProject("Guild");
  assert.equal((await share(w, project_id, acme.id, "viewer", 0)).status, 200);
  const before = Date.now();
  assert.equal((await w.call("member", "get_project", { project_id })).status, 200);
  const storage = w.catalogStorage(w.member);
  const hint = await storage.get(`project-discovery/${project_id}`);
  assert.equal(hint.space_id, project_id);
  assert.ok(hint.at >= before && hint.at <= Date.now(), JSON.stringify(hint));
  const put = t.mock.method(storage, "put");
  assert.equal((await w.call("member", "get_project", { project_id })).status, 200);
  assert.equal(
    put.mock.calls.filter(({ arguments: [key] }) => String(key).startsWith("project-discovery/"))
      .length,
    0,
  );
});

/** Fills `w.member`'s Catalog with `count` discovery hints for Projects that
 * exist, each shared with acme, and with a member row for `w.member` when
 * `member`. Hints are written oldest first, one millisecond apart, the first
 * without a time. Returns their Project ids in that order. */
async function fillHints(w, count, { member = false, from = 0 } = {}) {
  const storage = w.catalogStorage(w.member);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = `prj_${crypto.randomUUID()}`;
    // Reaching the host creates it; then give it a record.
    await (await w.env.PROJECTS.getByName(id).fetch(policyRequest(id, w.owner))).body?.cancel();
    await w.projects.get(id).ctx.storage.put("space/record", {
      space_id: id,
      owner: w.owner,
      acl: {
        revision: 1,
        members: member ? { [w.member]: { role: "viewer", generation: 1 } } : {},
        invites: {},
        organizationAccess: grant("viewer"),
      },
    });
    await storage.put(`project-discovery/${id}`, {
      space_id: id,
      owner: w.owner,
      ...(from + i > 0 && { at: 1_000_000 + from + i }),
    });
    ids.push(id);
  }
  return ids;
}
const policyRequest = (id, owner) =>
  new Request("https://pages.internal/internal/space/policy", {
    method: "POST",
    body: JSON.stringify({ space_id: id, owner }),
  });
const hintIds = async (w) =>
  [...(await w.catalogStorage(w.member).list({ prefix: "project-discovery/" })).keys()].map(
    (key) => key.slice("project-discovery/".length),
  );

test("at capacity, a new organization open evicts the oldest organization hint", async (t) => {
  const w = await world(t, { kilo: { owner: [acme], member: [acme] } });
  const filled = await fillHints(w, 500);
  const { project_id } = await w.createProject("Newest");
  assert.equal((await share(w, project_id, acme.id, "viewer", 0)).status, 200);
  assert.equal((await w.call("member", "get_project", { project_id })).status, 200);
  const hints = await hintIds(w);
  assert.equal(hints.length, 500);
  assert.ok(hints.includes(project_id), "the open recorded its hint");
  assert.ok(!hints.includes(filled[0]), "the hint without a time went first");
  assert.ok(filled.slice(1).every((id) => hints.includes(id)));
});

test("at capacity, a direct grant evicts an organization hint and never fails on them", async (t) => {
  const w = await world(t, { kilo: { owner: [acme], member: [acme] } });
  const filled = await fillHints(w, 500);
  const { project_id } = await w.createProject("Direct");
  const granted = await manage(w, "owner", {
    project_id,
    action: "set_role",
    principal: w.member,
    role: "viewer",
    expected_revision: 0,
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  const hints = await hintIds(w);
  assert.equal(hints.length, 500);
  assert.ok(hints.includes(project_id));
  assert.ok(!hints.includes(filled[0]));
});

test("a member's hint is never evicted for an organization hint", async (t) => {
  const w = await world(t, { kilo: { owner: [acme], member: [acme] } });
  const members = await fillHints(w, 499, { member: true });
  const [organization] = await fillHints(w, 1, { from: 1000 });
  const first = await w.createProject("First");
  assert.equal((await share(w, first.project_id, acme.id, "viewer", 0)).status, 200);
  assert.equal((await w.call("member", "get_project", { project_id: first.project_id })).status, 200);
  let hints = await hintIds(w);
  assert.ok(hints.includes(first.project_id));
  assert.ok(!hints.includes(organization), "the one organization hint made room");
  assert.ok(members.every((id) => hints.includes(id)));
  // The Catalog now holds 499 member hints and the newest organization hint.
  // Another organization open evicts that one, never a member's.
  const second = await w.createProject("Second");
  assert.equal((await share(w, second.project_id, acme.id, "viewer", 0)).status, 200);
  assert.equal((await w.call("member", "get_project", { project_id: second.project_id })).status, 200);
  hints = await hintIds(w);
  assert.ok(hints.includes(second.project_id));
  assert.ok(!hints.includes(first.project_id));
  assert.ok(members.every((id) => hints.includes(id)));
  // With only member hints, an organization open still reads the Project; it
  // records no hint.
  const third = await w.createProject("Third");
  assert.equal((await share(w, third.project_id, acme.id, "viewer", 0)).status, 200);
  await w.catalogStorage(w.member).delete(`project-discovery/${second.project_id}`);
  members.push(...(await fillHints(w, 1, { member: true, from: 3000 })));
  assert.equal((await hintIds(w)).length, 500);
  assert.equal((await w.call("member", "get_project", { project_id: third.project_id })).status, 200);
  hints = await hintIds(w);
  assert.equal(hints.length, 500);
  assert.ok(!hints.includes(third.project_id));
  assert.ok(members.every((id) => hints.includes(id)));
});

test("a Project shared only with an organization is a shared Project boundary for moves", async (t) => {
  const w = await world(t, { kilo: { owner: [acme] } });
  const { project_id } = await w.createProject("Guild");
  const child = (await w.createPage({ title: "Child", project_id })).body;
  assert.equal((await share(w, project_id, acme.id, "viewer", 0)).status, 200);
  const moved = await w.call("owner", "move_page", {
    page_id: child.page_id,
    project_id: null,
    nonce: crypto.randomUUID(),
  });
  assert.equal(moved.body.code, "shared_project_move_unsupported", JSON.stringify(moved.body));
});
