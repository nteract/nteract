import assert from "node:assert/strict";
import { test } from "node:test";
import { world } from "./projects-fixture.mjs";
import { invitedProjects } from "./project-invitations.mjs";
import { publicProjectAccess, projectContentMarkdown } from "./spaces.mjs";
import { captureConsole, secretLines } from "./auth-events-fixture.mjs";

for (const cleared of [false, true]) {
  test(`an older Project resolution cannot undo a real owner revocation${cleared ? " after access clears" : ""}`, async (t) => {
    const w = await world(t);
    const project = await w.createProject("Fenced");
    const child = (await w.createPage({ title: "Child", project_id: project.project_id })).body;
    const change = (role, expected_revision) =>
      w.call("owner", "manage_project_access", {
        project_id: project.project_id,
        action: "set_role",
        principal: w.member,
        role,
        expected_revision,
        idempotency_key: w.key(),
      });
    assert.equal((await change("editor", 0)).status, 200);
    assert.equal((await w.call("member", "read_page", { page_id: child.page_id })).status, 200);
    const page = w.page(child.page_id);
    let release, reached;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise((resolve) => {
      reached = resolve;
    });
    const get = w.env.PROJECTS.getByName.bind(w.env.PROJECTS);
    let delay = true;
    t.mock.method(w.env.PROJECTS, "getByName", (id) => ({
      fetch: async (request) => {
        const response = await get(id).fetch(request);
        if (delay && new URL(request.url).pathname === "/internal/space/policy") {
          delay = false;
          reached();
          await gate;
        }
        return response;
      },
    }));
    const request = new Request("https://pages.invalid/api/sync", {
      headers: { authorization: `Bearer ${w.auth.apiKey({ userId: "member-user" })}` },
    });
    const old = page.identify(request);
    await entered;
    assert.equal((await change(null, 1)).status, 200);
    const identity = await page.identify(request);
    assert.equal(page.projectAccess.revision, 2, "actual Project owner ACL revision");
    assert.throws(() => page.policy.account(identity));
    if (cleared) {
      t.mock.method(w.env.PROJECTS, "getByName", () => ({ fetch: async () => Response.error() }));
      await page.identify(request);
      assert.equal(page.projectAccess, null);
    }
    release();
    await old;
    assert.throws(() => page.policy.account(identity), "stale editor must not revive");
    if (!cleared) assert.equal(page.projectAccess.revision, 2);
  });
}

test("a lower revision in a newly resolved Project replaces the old placement", async (t) => {
  const w = await world(t);
  const older = await w.createProject("Old placement");
  const newer = await w.createProject("New placement");
  const child = (await w.createPage({ title: "Moving", project_id: older.project_id })).body;
  const page = w.page(child.page_id);
  const request = new Request("https://pages.invalid/api/sync", {
    headers: { authorization: `Bearer ${w.auth.apiKey({ userId: "member-user" })}` },
  });
  // These revisions are emitted by real Project owners, not Page ACL counters.
  const oldStorage = w.projects.get(older.project_id).ctx.storage;
  const old = await oldStorage.get("space/record");
  await oldStorage.put("space/record", { ...old, acl: { ...old.acl, revision: 20 } });
  await page.identify(request);
  assert.equal(page.projectAccess.revision, 20);
  const retry = (await w.call("owner", "list_pages")).body;
  const moved = await w.call("owner", "move_page", {
    page_id: child.page_id,
    project_id: newer.project_id,
    idempotency_key: crypto.randomUUID(),
    retry_token: retry.retry_token,
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  await page.identify(request);
  assert.equal(page.projectAccess.id, newer.project_id);
  assert.equal(page.projectAccess.revision, 0);
});

test("membership discovery, inherited Pages, revocation, and owner-only sharing and moves", async (t) => {
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
  // An editor adds Pages (project-editor-create.test.mjs); the owner owns them.
  const added = await w.createPage({ title: "Added", project_id: project.project_id }, "member");
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(w.page(added.body.page_id).metadata.owner, w.owner);
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
    idempotency_key: crypto.randomUUID(),
    retry_token: retry.retry_token,
  });
  assert.equal(deniedMove.body.code, "shared_project_move_unsupported");
  const within = await w.call("owner", "move_page", {
    page_id: nested.page_id,
    project_id: project.project_id,
    idempotency_key: crypto.randomUUID(),
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

for (const role of ["editor", "commenter", "viewer"])
  test(`exact-email Project ${role} invites discover and claim verified recipients without lookup or mail`, async (t) => {
    const w = await world(t);
    const project = await w.createProject("Email Project");
    const child = (await w.createPage({ title: "Child", project_id: project.project_id })).body;
    const capture = captureConsole(t);
    const args = {
      project_id: project.project_id,
      action: "invite",
      email: "fixture@example.invalid",
      role,
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
    assert.equal(listed.body.projects[0]?.role, role);
    assert.equal((await w.call("member", "read_page", { page_id: child.page_id })).status, 200);
    const roster = (await w.call("owner", "get_project_access", { project_id: project.project_id }))
      .body;
    assert.equal(roster.invites.length, 0);
    assert.equal(roster.members[w.member].email, args.email);
    // One created and one accepted line, joined by the invitation reference.
    // An exact retry of the invite records nothing more.
    const [created, ...moreCreated] = capture.find("invitation.created");
    const [accepted, ...moreAccepted] = capture.find("invitation.accepted");
    assert.deepEqual([moreCreated, moreAccepted], [[], []]);
    assert.match(created.invite, /^[0-9a-f]{12}$/);
    assert.deepEqual(
      [created, accepted].map(({ principal, project_id, invite, role: granted }) => ({
        principal,
        project_id,
        invite,
        role: granted,
      })),
      [
        { principal: w.owner, project_id: project.project_id, invite: created.invite, role },
        { principal: w.member, project_id: project.project_id, invite: created.invite, role },
      ],
    );
    assert.deepEqual(secretLines(capture.events.map((event) => JSON.stringify(event))), []);
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
  const capture = captureConsole(t);
  const revoked = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "revoke_invite",
    invite_id: invite.id,
    expected_revision: pending.body.revision,
    idempotency_key: w.key(),
  });
  assert.equal(revoked.status, 200);
  const [line] = capture.find("invitation.revoked");
  assert.deepEqual(
    { ...line, timestamp: undefined },
    {
      service: "nteract-pages-native",
      event: "pages.auth.v1",
      action: "invitation.revoked",
      principal: w.owner,
      project_id: project.project_id,
      invite: line.invite,
      timestamp: undefined,
    },
  );
  assert.match(line.invite, /^[0-9a-f]{12}$/);
  assert.equal(JSON.stringify(capture.events).includes(invite.id), false);
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
    idempotency_key: crypto.randomUUID(),
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
  assert.doesNotMatch(projectContentMarkdown(), /home Page/);
});

const indexRows = async (w) =>
  (
    await w.env.DB.prepare(
      "SELECT project_id, invite_id, email FROM pages_project_invitations ORDER BY project_id, email",
    ).all()
  ).results.map((row) => ({ ...row }));
const inviteTo = (w, projectId, email, expected_revision) =>
  w.call("owner", "manage_project_access", {
    project_id: projectId,
    action: "invite",
    email,
    role: "editor",
    expected_revision,
    idempotency_key: w.key(),
  });

test("revoking an invitation drops its index row and leaves other invitations", async (t) => {
  const w = await world(t);
  const first = await w.createProject("Revoked here");
  const second = await w.createProject("Kept there");
  await inviteTo(w, first.project_id, "fixture@example.invalid", 0);
  const pending = await inviteTo(w, first.project_id, "other@example.invalid", 1);
  await inviteTo(w, second.project_id, "fixture@example.invalid", 0);
  assert.equal((await indexRows(w)).length, 3);
  const invite = pending.body.invites.find((row) => row.email === "fixture@example.invalid");
  const capture = captureConsole(t);
  const args = {
    project_id: first.project_id,
    action: "revoke_invite",
    invite_id: invite.id,
    expected_revision: pending.body.revision,
    idempotency_key: w.key(),
  };
  assert.equal((await w.call("owner", "manage_project_access", args)).status, 200);
  const remaining = pending.body.invites.find((row) => row.email === "other@example.invalid");
  const expected = [
    { project_id: first.project_id, invite_id: remaining.id, email: "other@example.invalid" },
    {
      project_id: second.project_id,
      invite_id: (await w.call("owner", "get_project_access", { project_id: second.project_id }))
        .body.invites[0].id,
      email: "fixture@example.invalid",
    },
  ].sort((a, b) => a.project_id.localeCompare(b.project_id));
  assert.deepEqual(await indexRows(w), expected);
  // An exact retry replays the receipt and repeats the removal harmlessly.
  assert.equal((await w.call("owner", "manage_project_access", args)).status, 200);
  assert.deepEqual(await indexRows(w), expected);
  assert.equal(capture.find("invitation.revoked").length, 1);
  // The recipient still discovers the other Project's pending invitation.
  assert.deepEqual(
    await invitedProjects(w.env, {
      principal: w.member,
      namespace: "user:anaconda-fixture",
      verifiedEmail: "fixture@example.invalid",
    }),
    [second.project_id],
  );
});

test("a revocation whose index removal fails finishes the removal on retry", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Retried");
  const pending = await inviteTo(w, project.project_id, "fixture@example.invalid", 0);
  const prepare = w.env.DB.prepare.bind(w.env.DB);
  let fail = true;
  t.mock.method(w.env.DB, "prepare", (sql) => {
    if (fail && sql.includes("json_each")) {
      fail = false;
      throw new Error("injected D1 outage");
    }
    return prepare(sql);
  });
  const capture = captureConsole(t);
  const args = {
    project_id: project.project_id,
    action: "revoke_invite",
    invite_id: pending.body.invites[0].id,
    expected_revision: pending.body.revision,
    idempotency_key: w.key(),
  };
  assert.equal((await w.call("owner", "manage_project_access", args)).status, 500);
  // The ACL committed; only the hint is left behind.
  assert.equal((await indexRows(w)).length, 1);
  const retried = await w.call("owner", "manage_project_access", args);
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.body.invites, []);
  assert.deepEqual(await indexRows(w), []);
  assert.equal(capture.find("invitation.revoked").length, 1);
});

test("accepting an invitation drops its index row and leaves other invitations", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Accepted");
  await inviteTo(w, project.project_id, "fixture@example.invalid", 0);
  const pending = await inviteTo(w, project.project_id, "other@example.invalid", 1);
  const capture = captureConsole(t);
  const listed = await w.call("member", "list_projects");
  assert.equal(listed.body.projects[0]?.project_id, project.project_id);
  const other = pending.body.invites.find((row) => row.email === "other@example.invalid");
  assert.deepEqual(await indexRows(w), [
    { project_id: project.project_id, invite_id: other.id, email: "other@example.invalid" },
  ]);
  assert.equal(capture.find("invitation.accepted").length, 1);
  // Membership no longer depends on the index row.
  assert.equal((await w.call("member", "list_projects")).body.projects.length, 1);
  assert.equal(capture.find("invitation.accepted").length, 1);
});
