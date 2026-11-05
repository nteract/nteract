import assert from "node:assert/strict";
import { test } from "node:test";
import { world } from "./projects-fixture.mjs";
import { invitedProjects } from "./project-invitations.mjs";
import { publicProjectAccess, homePageMarkdown } from "./spaces.mjs";

test("membership discovery, inherited Pages, revocation, and owner-only structure", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Shared");
  const child = (await w.createPage({ title: "Child", project_id: project.project_id })).body;
  const args = {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role: "editor",
    expected_revision: 0,
    idempotency_key: w.key(),
  };
  const granted = await w.call("owner", "manage_project_access", args);
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual((await w.call("owner", "manage_project_access", args)).body, granted.body);
  assert.equal(
    (await w.call("member", "get_project", { project_id: project.project_id })).body.role,
    "editor",
  );
  assert.equal((await w.call("member", "list_projects")).body.projects.length, 1);
  const pages = await w.call("member", "list_pages", { project_id: project.project_id });
  assert.equal(pages.status, 200, JSON.stringify(pages.body));
  assert.ok(pages.body.pages.some((page) => page.page_id === child.page_id));
  assert.equal((await w.call("member", "read_page", { page_id: child.page_id })).status, 200);
  const nested = (await w.createPage({ title: "Nested", parent_id: child.page_id })).body;
  assert.equal((await w.call("member", "read_page", { page_id: nested.page_id })).status, 200);
  const memberStructure = await w.createPage(
    { title: "Denied", project_id: project.project_id },
    "member",
  );
  assert.equal(memberStructure.status, 404);
  assert.equal(
    (
      await w.call("member", "manage_project_access", {
        ...args,
        idempotency_key: w.key(),
        expected_revision: 1,
      })
    ).status,
    403,
  );
  const retry = (await w.call("owner", "list_pages")).body;
  const deniedMove = await w.call("owner", "move_page", {
    page_id: child.page_id,
    project_id: null,
    idempotency_key: retry.retry_key_prefix + crypto.randomUUID(),
    retry_token: retry.retry_token,
  });
  assert.equal(deniedMove.body.code, "shared_project_move_unsupported");
  const within = await w.call("owner", "move_page", {
    page_id: nested.page_id,
    project_id: project.project_id,
    idempotency_key: retry.retry_key_prefix + crypto.randomUUID(),
    retry_token: retry.retry_token,
  });
  assert.equal(within.status, 200, JSON.stringify(within.body));
  const revoked = await w.call("owner", "manage_project_access", {
    ...args,
    role: null,
    expected_revision: 1,
    idempotency_key: w.key(),
  });
  assert.equal(revoked.status, 200);
  assert.equal((await w.call("member", "read_page", { page_id: child.page_id })).status, 403);
  assert.deepEqual((await w.call("member", "list_projects")).body.projects, []);
  assert.equal((await w.catalogStorage(w.member).list({ prefix: "project-discovery/" })).size, 0);
});

test("failed membership durability is rechecked before policy reads and exact replay", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Durability");
  const host = w.projects.get(project.project_id);
  const storage = host.ctx.storage;
  let writes = false;
  const put = storage.put.bind(storage);
  storage.put = async (...args) => {
    await put(...args);
    writes = true;
  };
  storage.sync = async () => {
    if (writes) throw new Error("barrier unavailable");
  };
  const args = {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role: "editor",
    expected_revision: 0,
    idempotency_key: w.key(),
  };
  assert.equal((await w.call("owner", "manage_project_access", args)).status, 500);
  assert.equal((await w.call("owner", "manage_project_access", args)).status, 500);
  assert.equal(
    (await w.call("member", "get_project", { project_id: project.project_id })).status,
    500,
  );
  storage.sync = async () => {};
  assert.equal((await w.call("owner", "manage_project_access", args)).status, 200);
});

test("stale discovery capacity is reclaimed before a new legitimate grant", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Discoverable");
  const storage = w.catalogStorage(w.member);
  for (let i = 0; i < 500; i++) {
    const id = `prj_${crypto.randomUUID()}`;
    await storage.put(`project-discovery/${id}`, { space_id: id, owner: w.owner });
  }
  const grant = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role: "viewer",
    expected_revision: 0,
    idempotency_key: w.key(),
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal((await storage.list({ prefix: "project-discovery/" })).size, 1);
});

test("exact-email Project invites discover and claim verified recipients without lookup or mail", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Email Project");
  const child = (await w.createPage({ title: "Child", project_id: project.project_id })).body;
  const args = {
    project_id: project.project_id,
    action: "invite",
    email: "fixture@example.invalid",
    role: "commenter",
    expected_revision: 0,
    idempotency_key: w.key(),
  };
  const invited = await w.call("owner", "manage_project_access", args);
  assert.equal(invited.status, 200, JSON.stringify(invited.body));
  assert.equal(invited.body.invites.length, 1);
  assert.equal(invited.body.members[w.member], undefined);
  assert.deepEqual(
    await invitedProjects(w.env, { principal: w.member, namespace: "user:anaconda-fixture" }),
    [],
  );
  assert.deepEqual(
    await invitedProjects(w.env, {
      principal: w.member,
      namespace: "other",
      verifiedEmail: args.email,
    }),
    [],
  );
  assert.deepEqual((await w.call("owner", "manage_project_access", args)).body, invited.body);
  const listed = await w.call("member", "list_projects");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.projects[0]?.project_id, project.project_id);
  assert.equal(listed.body.projects[0]?.role, "commenter");
  assert.equal((await w.call("member", "read_page", { page_id: child.page_id })).status, 200);
  const roster = (await w.call("owner", "get_project_access", { project_id: project.project_id }))
    .body;
  assert.equal(roster.invites.length, 0);
  assert.equal(roster.members[w.member].email, args.email);
  const changed = await w.call("owner", "manage_project_access", {
    ...args,
    role: "viewer",
    expected_revision: roster.revision,
    idempotency_key: w.key(),
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.members[w.member].role, "viewer");
  assert.equal(changed.body.invites.length, 0);
  const removed = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role: null,
    expected_revision: changed.body.revision,
    idempotency_key: w.key(),
  });
  assert.equal(removed.status, 200);
  assert.deepEqual((await w.call("member", "list_projects")).body.projects, []);
});

test("revoked and nonmatching exact-email invites never discover or authorize Projects", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Pending");
  const args = {
    project_id: project.project_id,
    action: "invite",
    email: "someone-else@example.invalid",
    role: "editor",
    expected_revision: 0,
    idempotency_key: w.key(),
  };
  const invited = await w.call("owner", "manage_project_access", args);
  assert.equal(invited.status, 200);
  assert.deepEqual((await w.call("member", "list_projects")).body.projects, []);
  assert.equal(
    (await w.call("member", "get_project", { project_id: project.project_id })).status,
    404,
  );
  const pending = await w.call("owner", "manage_project_access", {
    ...args,
    email: "fixture@example.invalid",
    expected_revision: 1,
    idempotency_key: w.key(),
  });
  const invite = pending.body.invites.find((row) => row.email === "fixture@example.invalid");
  const revoked = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "revoke_invite",
    invite_id: invite.id,
    expected_revision: pending.body.revision,
    idempotency_key: w.key(),
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual((await w.call("member", "list_projects")).body.projects, []);
});

test("expired Project invitations cannot be claimed from a known Project link", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Expired");
  const invited = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "invite",
    email: "fixture@example.invalid",
    role: "editor",
    expected_revision: 0,
    idempotency_key: w.key(),
  });
  assert.equal(invited.status, 200);
  const storage = w.projects.get(project.project_id).ctx.storage;
  const record = await storage.get("space/record");
  for (const invite of Object.values(record.acl.invites)) invite.expiresAt = Date.now() - 1;
  await storage.put("space/record", record);
  assert.equal(
    (await w.call("member", "get_project", { project_id: project.project_id })).status,
    404,
  );
  assert.deepEqual((await w.call("member", "list_projects")).body.projects, []);
});

test("pending email invitations fence boundary moves before they are claimed", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Pending move");
  const child = (await w.createPage({ title: "Child", project_id: project.project_id })).body;
  const invited = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "invite",
    email: "someone-else@example.invalid",
    role: "editor",
    expected_revision: 0,
    idempotency_key: w.key(),
  });
  assert.equal(invited.status, 200);
  const retry = (await w.call("owner", "list_pages")).body;
  const moved = await w.call("owner", "move_page", {
    page_id: child.page_id,
    project_id: null,
    idempotency_key: retry.retry_key_prefix + crypto.randomUUID(),
    retry_token: retry.retry_token,
  });
  assert.equal(moved.body.code, "shared_project_move_unsupported");
});

test("a full Project invitation cannot block unrelated Project discovery or leak metadata", async (t) => {
  const w = await world(t);
  const full = await w.createProject("Attacker private title");
  const valid = await w.createProject("Legitimate");
  const storage = w.projects.get(full.project_id).ctx.storage;
  const record = await storage.get("space/record");
  for (let i = 0; i < 100; i++)
    record.acl.members[`user:full-${i}`] = { role: "viewer", generation: 1 };
  await storage.put("space/record", record);
  for (const project of [full, valid]) {
    const response = await w.call("owner", "manage_project_access", {
      project_id: project.project_id,
      action: "invite",
      email: "fixture@example.invalid",
      role: "viewer",
      expected_revision: 0,
      idempotency_key: w.key(),
    });
    assert.equal(response.status, 200);
  }
  assert.equal(
    (await w.call("member", "get_project", { project_id: full.project_id })).status,
    409,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const listed = await w.call("member", "list_projects");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(
      listed.body.projects.map((project) => project.project_id),
      [valid.project_id],
    );
    assert.equal(JSON.stringify(listed.body).includes(full.project_id), false);
    assert.equal(JSON.stringify(listed.body).includes(full.title), false);
  }
});

test("Project sharing output hides tombstones and internal ACL fields including old receipts", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Roster");
  const args = {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role: "viewer",
    expected_revision: 0,
    idempotency_key: w.key(),
  };
  const added = await w.call("owner", "manage_project_access", args);
  assert.deepEqual(added.body.members[w.member], { role: "viewer" });
  const removal = {
    ...args,
    role: null,
    expected_revision: added.body.revision,
    idempotency_key: w.key(),
  };
  const removed = await w.call("owner", "manage_project_access", removal);
  assert.deepEqual(removed.body.members, {});
  assert.deepEqual((await w.call("owner", "manage_project_access", removal)).body.members, {});
  assert.deepEqual(
    (await w.call("owner", "get_project_access", { project_id: project.project_id })).body.members,
    {},
  );
  const stored = await w.projects.get(project.project_id).ctx.storage.get("space/record");
  assert.equal(stored.acl.members[w.member].role, "none");
  assert.ok(stored.acl.members[w.member].generation > 0);
  const projected = publicProjectAccess({
    space_id: project.project_id,
    revision: 1,
    members: { removed: { role: "none", generation: 2 } },
    invites: [
      {
        id: "invite",
        email: "known@example.invalid",
        role: "editor",
        expiresAt: 123,
        namespace: "private",
        issuedRevision: 7,
      },
    ],
  });
  assert.deepEqual(projected.members, {});
  assert.deepEqual(Object.keys(projected.invites[0]).sort(), ["email", "expiresAt", "id", "role"]);
  assert.doesNotMatch(homePageMarkdown(), /home Page/);
});
