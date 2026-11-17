import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECT_READ_TTL_MS,
  accessBasis,
  emptyProjectReads,
  projectReadMemo,
  projectReads,
} from "./project-read-memo.mjs";
import { invitedProjects } from "./project-invitations.mjs";
import { world } from "./projects-fixture.mjs";

test("projectReadMemo: every state and event", () => {
  const answered = projectReadMemo(emptyProjectReads, {
    type: "answered",
    generation: 0,
    basis: "b",
    body: { title: "T" },
    now: 1000,
  });
  assert.equal(answered.kept, true);
  assert.deepEqual(answered.project.answers.get("b"), {
    body: { title: "T" },
    until: 1000 + PROJECT_READ_TTL_MS,
  });
  // A read that started before an eviction isn't kept.
  const evicted = projectReadMemo(answered.project, { type: "evicted" });
  assert.equal(evicted.project.generation, 1);
  assert.equal(evicted.project.answers.size, 0);
  const late = projectReadMemo(evicted.project, {
    type: "answered",
    generation: 0,
    basis: "b",
    body: {},
    now: 1001,
  });
  assert.equal(late.kept, false);
  assert.equal(late.project, evicted.project);
  // Expiry drops answers at `until`, and leaves younger ones.
  const two = projectReadMemo(answered.project, {
    type: "answered",
    generation: 0,
    basis: "c",
    body: {},
    now: 5000,
  }).project;
  const at = (now) => projectReadMemo(two, { type: "expired", now }).project;
  assert.equal(at(1000 + PROJECT_READ_TTL_MS - 1), two);
  assert.deepEqual([...at(1000 + PROJECT_READ_TTL_MS).answers.keys()], ["c"]);
  assert.equal(at(5000 + PROJECT_READ_TTL_MS).answers.size, 0);
  assert.equal(projectReadMemo(two, { type: "nonsense" }).rejected, "unknown event");
});

test("accessBasis separates credentials that can read differently", () => {
  const base = { principal: "p", namespace: "n", canWrite: true };
  assert.equal(accessBasis(base), accessBasis({ ...base, expiresAt: 5 }));
  assert.notEqual(accessBasis(base), accessBasis({ ...base, canWrite: false }));
  assert.notEqual(
    accessBasis(base),
    accessBasis({ ...base, organizations: [{ namespace: "n", id: "org", expiresAt: 9 }] }),
  );
  assert.notEqual(
    accessBasis(base),
    accessBasis({ ...base, domainAccess: { namespace: "n", domain: "example.com" } }),
  );
  assert.equal(
    accessBasis({
      ...base,
      organizations: [
        { namespace: "n", id: "a" },
        { namespace: "n", id: "b" },
      ],
    }),
    accessBasis({
      ...base,
      organizations: [
        { namespace: "n", id: "b" },
        { namespace: "n", id: "a" },
      ],
    }),
  );
});

test("kept answers are copies", () => {
  const memo = projectReads();
  const body = { title: "T" };
  memo.answered("s", memo.begin("s"), "b", body, 0);
  body.title = "changed";
  const first = memo.lookup("s", "b", 1);
  first.title = "also changed";
  assert.equal(memo.lookup("s", "b", 1).title, "T");
  assert.equal(memo.lookup("s", "other", 1), null);
});

/**
 * The member holds a hint for the owner's Project, so the member's listing
 * reads it from its host. `reads` records each Project host read by ID.
 */
async function memberWorld(t) {
  const w = await world(t);
  const project = await w.createProject("Shared");
  const granted = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role: "viewer",
    expected_revision: 0,
    nonce: w.key(),
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  const reads = [];
  const getByName = w.env.PROJECTS.getByName;
  w.env.PROJECTS.getByName = (id) => {
    const stub = getByName(id);
    return {
      fetch(request, init) {
        if (new URL(request.url).pathname === "/internal/space/read") reads.push(id);
        return stub.fetch(request, init);
      },
    };
  };
  const list = async (who = "member") => {
    reads.length = 0;
    const listed = await w.call(who, "list_projects");
    return { ...listed, reads: [...reads] };
  };
  return { w, project, reads, list };
}

test("two listings inside 30 s read a Project once, and the invitation loop still runs both times", async (t) => {
  const { w, project, list } = await memberWorld(t);
  // A stale invitation row for the same Project: the invitation loop reads
  // its host on every listing (a read that may claim), and finds nothing to
  // claim. (A lookup creates the invitation table.)
  await invitedProjects(w.env, { namespace: "none", verifiedEmail: "none@example.invalid" });
  await w.db
    .prepare(
      `INSERT INTO pages_project_invitations
      (project_id, invite_id, email, namespace, expires_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      project.project_id,
      "000000000000",
      "fixture@example.invalid",
      "user:anaconda-fixture",
      Date.now() + 3_600_000,
    )
    .run();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const first = await list();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(
    first.body.projects.map((entry) => entry.project_id),
    [project.project_id],
  );
  assert.deepEqual(first.reads, [project.project_id, project.project_id], "invitation + list");
  t.mock.timers.tick(PROJECT_READ_TTL_MS - 1);
  const second = await list();
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(second.reads, [project.project_id], "the invitation read only");
  t.mock.timers.tick(1);
  const third = await list();
  assert.deepEqual(third.reads, [project.project_id, project.project_id], "expired: read again");
});

test("without invitations, a second listing reads no Project host", async (t) => {
  const { project, list } = await memberWorld(t);
  assert.deepEqual((await list()).reads, [project.project_id]);
  assert.deepEqual((await list()).reads, []);
});

test("a discovery message for a Project, added or removed, drops its answer", async (t) => {
  const { w, project, list } = await memberWorld(t);
  const discovery = (body) =>
    w.catalog(w.member).fetch(
      new Request("https://pages.internal/internal/project-discovery", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  await list();
  assert.ok(w.catalog(w.member).projectReads.holds(project.project_id));
  // An opened-hint refresh changes no one's access; its answer stays.
  await discovery({ space_id: project.project_id, owner: w.owner, opened: true });
  assert.deepEqual((await list()).reads, []);
  await discovery({ space_id: project.project_id, owner: w.owner });
  assert.deepEqual((await list()).reads, [project.project_id], "added");
  // The owner removes the member: their own Catalog hears of it.
  const removed = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role: null,
    expected_revision: 1,
    nonce: w.key(),
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(w.catalog(w.member).projectReads.holds(project.project_id), false, "removed");
  assert.deepEqual((await list()).body.projects, []);
});

test("get_project and access changes this Catalog handles drop the Project's answer", async (t) => {
  const { w, project, list } = await memberWorld(t);
  const catalog = w.catalog(w.member);
  await list();
  assert.ok(catalog.projectReads.holds(project.project_id));
  assert.equal(
    (await w.call("member", "get_project", { project_id: project.project_id })).status,
    200,
  );
  assert.equal(catalog.projectReads.holds(project.project_id), false, "get_project (join)");
  await list();
  assert.ok(catalog.projectReads.holds(project.project_id));
  // The member leaving goes through their own Catalog; the host decides.
  await w.call("member", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role: null,
    expected_revision: 1,
    nonce: w.key(),
  });
  assert.equal(catalog.projectReads.holds(project.project_id), false, "access change (leave)");
});

test("create, update and delete in this Catalog drop the Project's answer", async (t) => {
  const { w, project: shared, list } = await memberWorld(t);
  // The member owns a Project too; their listing reads it from its host.
  const created = await w.call("member", "create_project", { title: "Mine", nonce: w.key() });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const own = created.body.project_id;
  const catalog = w.catalog(w.member);
  const first = await list();
  assert.deepEqual(first.reads.sort(), [own, shared.project_id].sort());
  assert.deepEqual((await list()).reads, []);
  const updated = await w.call("member", "update_project", {
    project_id: own,
    title: "Mine v2",
    expected_revision: 0,
    nonce: w.key(),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const afterUpdate = await list();
  assert.deepEqual(afterUpdate.reads, [own], "update");
  assert.ok(afterUpdate.body.projects.some((entry) => entry.title === "Mine v2"));
  const preview = await w.call("member", "delete_project", { project_id: own, action: "preview" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const deleted = await w.call("member", "delete_project", {
    project_id: own,
    action: "confirm",
    preview_token: preview.body.preview_token,
    nonce: w.key(),
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(catalog.projectReads.holds(own), false, "delete");
  const afterDelete = await list();
  assert.deepEqual(
    afterDelete.body.projects.map((entry) => entry.project_id),
    [shared.project_id],
  );
  const again = await w.call("member", "create_project", { title: "Again", nonce: w.key() });
  assert.equal(again.status, 200);
  assert.equal(catalog.projectReads.holds(again.body.project_id), false, "create");
  assert.deepEqual((await list()).reads, [again.body.project_id]);
});

test("a refused or failed read is not remembered", async (t) => {
  const { w, project, list } = await memberWorld(t);
  const other = await w.createProject("Not shared");
  // A hint for a Project the member can't read: the host refuses it.
  await w.catalogStorage(w.member).put(`project-discovery/${other.project_id}`, {
    space_id: other.project_id,
    owner: w.owner,
  });
  const first = await list();
  assert.deepEqual(first.reads.sort(), [project.project_id, other.project_id].sort());
  assert.deepEqual(
    first.body.projects.map((entry) => entry.project_id),
    [project.project_id],
  );
  assert.deepEqual((await list()).reads, [other.project_id], "the refusal is read again");
  // A server error fails the listing and is not kept either.
  w.catalog(w.member).projectReads.evict(project.project_id);
  w.faults.set(project.project_id, "before");
  assert.equal((await list()).status, 503);
  assert.equal(w.catalog(w.member).projectReads.holds(project.project_id), false);
  assert.ok((await list()).reads.includes(project.project_id));
});
