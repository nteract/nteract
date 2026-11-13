// update_page_tags: the Page host's side (access, validation, limits, Trash)
// and the public gateway's side (routing and arguments).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { catalogIndexTimeouts, migrateCatalogIndex, reportPageIndex } from "./catalog-index.mjs";
import worker from "./index.mjs";
import { migratePageTags } from "./page-tags-store.mjs";
import { fixture, pageId } from "./trash-fixture.mjs";
import { pageState } from "./access.mjs";
import { projectObject } from "./authz.mjs";
import { DocumentPolicy } from "./policy.mjs";

async function tagged(t, options = {}) {
  const db = sqliteD1(t).open();
  await migrateCatalogIndex(db);
  await migratePageTags(db);
  const f = await fixture(t, { env: { DB: db, PAGES_CATALOG_INDEX: "1" }, ...options });
  const rows = () =>
    db
      .rows("SELECT tag, added_by FROM page_tags WHERE page_id = ? ORDER BY tag", pageId)
      .map((row) => ({ ...row }));
  return { f, db, rows };
}

const update = (f, who, args) => f.tool(who, "update_page_tags", args);

test("an owner or editor adds and removes tags, which stay out of the document", async (t) => {
  const { f, rows } = await tagged(t);
  const revision = (await f.tool("owner", "read_page", { comments: "none" })).body.revision;
  const added = await update(f, "owner", { add: ["Code", "status:reviewing", "code"] });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body, { page_id: pageId, tags: ["code", "status:reviewing"] });
  // An editor adds and removes too; the principal that added a tag is kept.
  const edited = await update(f, "member", { add: ["repo:nteract"], remove: ["status:reviewing"] });
  assert.deepEqual(edited.body.tags, ["code", "repo:nteract"]);
  assert.deepEqual(rows(), [
    { tag: "code", added_by: f.owner },
    { tag: "repo:nteract", added_by: f.member },
  ]);
  // Repeating a change, or removing a tag the Page lacks, changes nothing.
  const again = await update(f, "member", { add: ["repo:nteract"], remove: ["status:reviewing"] });
  assert.deepEqual(again.body.tags, ["code", "repo:nteract"]);
  assert.equal(rows().find((row) => row.tag === "code").added_by, f.owner);
  assert.deepEqual((await update(f, "owner", { remove: ["nope"] })).body.tags, [
    "code",
    "repo:nteract",
  ]);
  // The Page's content revision never moves.
  assert.equal((await f.tool("owner", "read_page", { comments: "none" })).body.revision, revision);
});

test("viewers, commenters and strangers can't change tags", async (t) => {
  for (const [options, who] of [
    [{ memberRole: "viewer" }, "member"],
    [{ memberRole: "commenter" }, "member"],
    [{}, "stranger"],
  ]) {
    const { f, rows } = await tagged(t, options);
    const refused = await update(f, who, { add: ["code"] });
    assert.equal(refused.status, 403, JSON.stringify([options, who, refused.body]));
    assert.deepEqual(rows(), []);
  }
});

test("a malformed tag, an empty change and an oversized one are refused", async (t) => {
  const { f, rows } = await tagged(t);
  for (const [args, status, code] of [
    [{ add: ["has space"] }, 400, "invalid_tag"],
    [{ add: ["AND"] }, 400, "invalid_tag"],
    [{ add: ["not"] }, 400, "invalid_tag"],
    [{ remove: ["-lead"] }, 400, "invalid_tag"],
    [{ add: ["café"] }, 400, "invalid_tag"],
    [{ add: [7] }, 400, "invalid_tag"],
    [{ add: "code" }, 400, "invalid_arguments"],
    [{}, 400, "invalid_arguments"],
    [{ add: [] }, 400, "invalid_arguments"],
    [{ add: ["a"], remove: ["A"] }, 400, "invalid_arguments"],
    [{ add: Array.from({ length: 33 }, (_, index) => `t${index}`) }, 400, "invalid_arguments"],
  ]) {
    const refused = await update(f, "owner", args);
    assert.equal(refused.status, status, JSON.stringify(args));
    assert.equal(refused.body.code, code, JSON.stringify(args));
  }
  assert.deepEqual(rows(), []);
});

test("a Page holds at most 32 tags", async (t) => {
  const { f, rows } = await tagged(t);
  const names = (count, start = 0) => Array.from({ length: count }, (_, i) => `t${start + i}`);
  assert.equal((await update(f, "owner", { add: names(32) })).body.tags.length, 32);
  const over = await update(f, "owner", { add: ["one-too-many"] });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, "tag_limit_exceeded");
  assert.equal(rows().length, 32);
  // A tag it has, or a swap that nets out, still fits.
  assert.equal((await update(f, "owner", { add: ["t0"] })).status, 200);
  const swap = await update(f, "owner", { add: ["fresh"], remove: ["t0"] });
  assert.equal(swap.status, 200, JSON.stringify(swap.body));
  assert.equal(swap.body.tags.length, 32);
  assert.ok(swap.body.tags.includes("fresh") && !swap.body.tags.includes("t0"));
});

test("a write whose tag another writer removes before its answer arrives still reports its own change", async (t) => {
  const { f, db, rows } = await tagged(t);
  const release = holdAnswer(db);
  // A adds x; its batch commits and its answer is in flight.
  const adding = update(f, "owner", { add: ["x"] });
  await untilAnswerHeld(db);
  // B removes x before A hears back.
  const removed = await update(f, "member", { remove: ["x"] });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body.tags, []);
  release();
  const added = await adding;
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body.tags, ["x"], "A reports the set its own batch left");
  assert.deepEqual(rows(), []);
});

test("an over-limit change applies none of its removals", async (t) => {
  const { f, rows } = await tagged(t);
  const names = Array.from({ length: 32 }, (_, i) => `t${i}`);
  assert.equal((await update(f, "owner", { add: names })).status, 200);
  const over = await update(f, "owner", { add: ["a", "b"], remove: ["t0"] });
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.equal(over.body.code, "tag_limit_exceeded");
  assert.match(over.body.error, /would leave 33/);
  assert.equal(rows().length, 32);
  assert.ok(rows().some((row) => row.tag === "t0"));
});

test("a Page in Trash takes no tag changes, and its tags return with it", async (t) => {
  const { f, rows } = await tagged(t);
  await update(f, "owner", { add: ["code"] });
  const trashed = await f.catalogCall("owner", "delete_page", {
    page_id: pageId,
    nonce: "tags-trash-0001",
  });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  const refused = await update(f, "owner", { add: ["more"] });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "page_trashed");
  assert.deepEqual(
    rows().map((row) => row.tag),
    ["code"],
  );
  const restored = await f.catalogCall("owner", "restore_page", {
    page_id: pageId,
    nonce: "tags-restore-0001",
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual((await update(f, "owner", { add: ["more"] })).body.tags, ["code", "more"]);
});

// Edit access reaches update_page_tags through more than the Page's own member
// rows. These tests give the Page host the identity and the Page record a
// request would carry, so each grant is the one decide() reads in production.
const namespace = "user:anaconda-fixture";
const acme = Object.freeze({ id: "org-acme", name: "Acme Research" });
const guild = Object.freeze({ id: "org-guild", name: "Other Guild" });
const future = () => Date.now() + 60_000;

function actingAs(f, principal, extra = {}) {
  const identity = {
    principal,
    displayName: principal,
    namespace,
    canWrite: true,
    credentialKind: "oidc",
    expiresAt: future(),
    ...extra,
  };
  f.page.identify = async () => identity;
  return identity;
}

const organizationLease = (organization = acme, expiresAt = future()) => ({
  ...organization,
  namespace,
  expiresAt,
});

const projectSnapshot = (f, role, { principal, validUntil = future() } = {}) => {
  const members = { [principal]: { role, generation: 1 } };
  return {
    ...projectObject({
      space_id: "prj_00000000-0000-4000-8000-000000000001",
      owner: f.owner,
      acl: { revision: 1, members },
    }),
    members,
    valid_until: validUntil,
  };
};

function inProject(f, snapshot) {
  // The fixture's policy reads the bare record; the host's own adds the
  // Project snapshot (initializePlain).
  f.page.policy = new DocumentPolicy({
    metadata: () => ({ ...f.page.metadata, projectAccess: f.page.projectAccess }),
  });
  f.page.projectAccessState = {
    name: "available",
    snapshot,
    fence: { owner: f.owner, id: snapshot.id, location: "fixture", revision: snapshot.revision },
  };
}

test("a Project editor changes tags on a Page in the Project; a viewer or commenter does not", async (t) => {
  const principal = `${namespace}:project-editor`;
  for (const [role, status] of [
    ["editor", 200],
    ["commenter", 403],
    ["viewer", 403],
  ]) {
    const { f, rows } = await tagged(t);
    actingAs(f, principal);
    inProject(f, projectSnapshot(f, role, { principal }));
    const changed = await update(f, "stranger", { add: ["Plan"] });
    assert.equal(changed.status, status, `${role}: ${JSON.stringify(changed.body)}`);
    if (status === 200) {
      assert.deepEqual(changed.body.tags, ["plan"]);
      assert.deepEqual(rows(), [{ tag: "plan", added_by: principal }]);
    } else assert.deepEqual(rows(), []);
  }
});

test("a Project grant that has lapsed, or never named the caller, gives no tag access", async (t) => {
  const principal = `${namespace}:project-editor`;
  const stale = await tagged(t);
  actingAs(stale.f, principal);
  inProject(stale.f, projectSnapshot(stale.f, "editor", { principal, validUntil: Date.now() - 1 }));
  const lapsed = await update(stale.f, "stranger", { add: ["plan"] });
  assert.equal(lapsed.status, 403, JSON.stringify(lapsed));
  assert.deepEqual(stale.rows(), []);
  const other = await tagged(t);
  actingAs(other.f, principal);
  inProject(other.f, projectSnapshot(other.f, "editor", { principal: `${namespace}:someone` }));
  const unnamed = await update(other.f, "stranger", { add: ["plan"] });
  assert.equal(unnamed.status, 403, JSON.stringify(unnamed));
  assert.deepEqual(other.rows(), []);
});

test("a Project editor can't change the tags of a Page in Trash", async (t) => {
  const principal = `${namespace}:project-editor`;
  const { f, rows } = await tagged(t);
  actingAs(f, principal);
  inProject(f, projectSnapshot(f, "editor", { principal }));
  assert.equal((await update(f, "stranger", { add: ["plan"] })).status, 200);
  // The owner trashes it through the real credential check.
  const stub = f.page.identify;
  delete f.page.identify;
  assert.equal((await trash(f, "tags-project-trash")).status, 200);
  f.page.identify = stub;
  const refused = await update(f, "stranger", { add: ["more"] });
  // A trashed Page is hidden from everyone but those who may restore it.
  assert.equal(refused.status, 404, JSON.stringify(refused));
  assert.deepEqual(
    rows().map((row) => row.tag),
    ["plan"],
  );
});

test("an organization link grants tag changes by its role, only to that organization's members", async (t) => {
  const principal = `${namespace}:org-member`;
  const grant = (role, organization = acme) => ({
    id: organization.id,
    name: organization.name,
    namespace,
    role,
  });
  for (const [role, status] of [
    ["editor", 200],
    ["commenter", 403],
    ["viewer", 403],
  ]) {
    const { f, rows } = await tagged(t);
    f.page.metadata.acl.organizationAccess = grant(role);
    actingAs(f, principal, { organizations: [organizationLease()] });
    const changed = await update(f, "stranger", { add: ["Shared"] });
    assert.equal(changed.status, status, `${role}: ${JSON.stringify(changed.body)}`);
    assert.deepEqual(rows(), status === 200 ? [{ tag: "shared", added_by: principal }] : []);
  }
  // An editor link names one organization: another's member, a member whose
  // lease has lapsed, and a caller with no lease get nothing.
  for (const identity of [
    { organizations: [organizationLease(guild)] },
    { organizations: [organizationLease(acme, Date.now() - 1)] },
    {},
  ]) {
    const { f, rows } = await tagged(t);
    f.page.metadata.acl.organizationAccess = grant("editor");
    actingAs(f, principal, identity);
    const refused = await update(f, "stranger", { add: ["shared"] });
    assert.equal(refused.status, 403, JSON.stringify([identity, refused]));
    assert.deepEqual(rows(), []);
  }
  // An organization editor's link is withdrawn: the next write is refused.
  const { f, rows } = await tagged(t);
  f.page.metadata.acl.organizationAccess = grant("editor");
  actingAs(f, principal, { organizations: [organizationLease()] });
  assert.equal((await update(f, "stranger", { add: ["shared"] })).status, 200);
  f.page.metadata.acl.organizationAccess = null;
  const withdrawn = await update(f, "stranger", { add: ["more"] });
  assert.equal(withdrawn.status, 403, JSON.stringify(withdrawn));
  assert.deepEqual(
    rows().map((row) => row.tag),
    ["shared"],
  );
});

test("a company-domain link grants tag changes by its role; one stored without a role only views", async (t) => {
  const principal = `${namespace}:employee`;
  const lease = { domainAccess: { domain: "anaconda.com", namespace, expiresAt: future() } };
  for (const [role, status] of [
    ["editor", 200],
    ["commenter", 403],
    ["viewer", 403],
    [undefined, 403],
  ]) {
    const { f, rows } = await tagged(t);
    f.page.metadata.acl.domainView = {
      domain: "anaconda.com",
      namespace,
      ...(role && { role }),
    };
    actingAs(f, principal, lease);
    // The link opens the Page to every role: they can read it.
    const read = await f.tool("stranger", "read_page", { comments: "none" });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const changed = await update(f, "stranger", { add: ["Plan"] });
    assert.equal(changed.status, status, `${role}: ${JSON.stringify(changed.body)}`);
    assert.deepEqual(rows(), status === 200 ? [{ tag: "plan", added_by: principal }] : []);
  }
  // Another domain's lease, a lapsed lease and no lease get nothing from an
  // editor link, and a removal tombstone beats it.
  for (const [label, identity, members] of [
    ["other domain", { domainAccess: { ...lease.domainAccess, domain: "example.com" } }, {}],
    ["lapsed", { domainAccess: { ...lease.domainAccess, expiresAt: Date.now() - 1 } }, {}],
    ["no lease", {}, {}],
    ["removed", lease, { [principal]: { role: "none", generation: 2 } }],
  ]) {
    const { f, rows } = await tagged(t);
    f.page.metadata.acl.domainView = { domain: "anaconda.com", namespace, role: "editor" };
    f.page.metadata.acl.members = { ...f.page.metadata.acl.members, ...members };
    actingAs(f, principal, identity);
    const refused = await update(f, "stranger", { add: ["shared"] });
    assert.equal(refused.status, 403, `${label}: ${JSON.stringify(refused.body)}`);
    assert.deepEqual(rows(), []);
  }
});

test("without the catalog index flag (no D1 binding), a tag change is refused and nothing is written", async (t) => {
  const off = await fixture(t);
  const refused = await update(off, "owner", { add: ["code"] });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, "tags_unavailable");
  const { f, rows } = await tagged(t);
  f.env.DB.mode = "fail";
  const failed = await update(f, "owner", { add: ["code"] });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "tags_unavailable");
  f.env.DB.mode = "ok";
  assert.deepEqual(rows(), []);
});

test("the gateway routes update_page_tags to the Page and refuses other arguments", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const calls = [];
  const namespace = {
    getByName: () => ({
      async fetch(request) {
        const { operation, arguments: args } = await request.json();
        calls.push({ path: new URL(request.url).pathname, operation, args });
        return Response.json({ page_id: pageId, tags: ["code"] });
      },
    }),
  };
  const env = {
    ...auth.env,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://page10.runtimed.run",
    CATALOGS: namespace,
    PAGES: namespace,
  };
  const call = (args, token = auth.apiKey()) =>
    worker.fetch(
      new Request("http://127.0.0.1:9477/api/tools", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ operation: "update_page_tags", arguments: args }),
      }),
      env,
    );
  const ok = await call({ page_id: pageId, add: ["code"] });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual(calls, [
    {
      path: "/internal/tool",
      operation: "update_page_tags",
      args: { page_id: pageId, add: ["code"] },
    },
  ]);
  // No nonce is needed, and an unknown argument is named and refused.
  const unknown = await call({ page_id: pageId, add: ["code"], retry_token: "old" });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).code, "invalid_arguments");
  const project = await call({ project_id: "prj_x", add: ["code"] });
  assert.equal(project.status, 400);
  // A read-only credential can't write tags.
  const readOnly = await call(
    { page_id: pageId, add: ["code"] },
    auth.apiKey({ scopes: ["cloud:read"] }),
  );
  assert.equal(readOnly.status, 403);
  assert.equal(calls.length, 1);
});

const settled = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until D1 has taken the batch `db.holdNext` holds back. */
async function untilBatchHeld(db) {
  for (let spin = 0; db.holdNext && spin < 400; spin++) await settled(5);
  assert.equal(db.holdNext, undefined, "the tag write never reached its batch");
}

/** Hold the next D1 batch, as a stalled request in flight. */
function holdBatch(db) {
  let release;
  db.holdNext = new Promise((resolve) => (release = resolve));
  return release;
}

/** Let the next D1 batch commit and hold its answer, as a response still in
 * flight. */
function holdAnswer(db) {
  let release;
  db.holdAnswer = new Promise((resolve) => (release = resolve));
  return release;
}

/** Wait until D1 has committed the batch whose answer `db.holdAnswer` holds. */
async function untilAnswerHeld(db) {
  for (let spin = 0; db.holdAnswer && spin < 400; spin++) await settled(5);
  assert.equal(db.holdAnswer, undefined, "the tag write never reached its batch");
}

/** The Page's projection row, which the Page host writes when it first reports
 * the Page. Trash and deletion mark it, and a tag write is fenced on that mark. */
async function project(f) {
  await reportPageIndex(f.env, f.page.ctx, {
    metadata: f.page.metadata,
    title: "Launch plan",
    observedAt: "2026-10-01T00:00:00.000Z",
  });
}

const trash = (f, nonce = "tags-trash-0002") =>
  f.catalogCall("owner", "delete_page", { page_id: pageId, nonce });

async function purge(f, key = "tags-purge") {
  const trashed = await trash(f, `${key}-trash`);
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  const preview = await f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "preview",
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  return f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.body.preview_token,
    nonce: `${key}-confirm`,
  });
}

test("a tag write waits on D1 outside the Page's queue", async (t) => {
  const { f, db, rows } = await tagged(t);
  const release = holdBatch(db);
  const writing = update(f, "owner", { add: ["code"] });
  await untilBatchHeld(db);
  // D1 is stalled mid-write. Every other request to the Page still runs.
  const state = await Promise.race([
    f.tool("owner", "read_page", { comments: "none" }),
    settled(2000).then(() => "queued behind the tag write"),
  ]);
  assert.equal(state.status, 200, JSON.stringify(state));
  const edit = await Promise.race([
    f.tool("owner", "edit_page", {
      operations: [{ op: "insert_markdown", markdown: "Written while D1 stalls." }],
      revision: state.body.revision,
      nonce: "tags-queue-edit",
    }),
    settled(2000).then(() => "queued behind the tag write"),
  ]);
  assert.equal(edit.status, 200, JSON.stringify(edit));
  const after = await f.tool("owner", "read_page", { comments: "none" });
  assert.notEqual(after.body.revision, state.body.revision);
  assert.match(JSON.stringify(after.body), /Written while D1 stalls\./);
  assert.deepEqual(rows(), [], "the tag batch is still held");
  release();
  const written = await writing;
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(written.body.tags, ["code"]);
  assert.deepEqual(
    rows().map((row) => row.tag),
    ["code"],
  );
});

// CONTROL. This passes with or without the D1 fence on Trash: the refusal
// comes from the Page host's admission queue, ahead of every D1 call, and the
// fence is not consulted. It pins the behavior the fence must not replace, not
// the fence itself; "a write held in D1 and refused by Trash" and the timed-out
// batch test below are the ones that fail without it.
test("control: a Page that is already in Trash is refused in the queue, before any D1 work", async (t) => {
  const { f, db, rows } = await tagged(t);
  await trash(f);
  const before = db.calls;
  const refused = await update(f, "owner", { add: ["code"] });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "page_trashed");
  assert.equal(db.calls, before, "the refusal read nothing from D1");
  assert.deepEqual(rows(), []);
  // So is a caller who can't see the Page.
  assert.equal((await update(f, "stranger", { add: ["code"] })).status, 404);
  assert.equal(db.calls, before);
});

test("a write held in D1 and refused by Trash lands nothing and says why", async (t) => {
  const { f, db, rows } = await tagged(t);
  await project(f);
  await update(f, "owner", { add: ["keep"] });
  const release = holdBatch(db);
  const writing = update(f, "owner", { add: ["late"], remove: ["keep"] });
  await untilBatchHeld(db);
  // The Page is trashed while the write is in flight, then the write runs.
  assert.equal((await trash(f)).status, 200);
  assert.equal(pageState(f.page.metadata), "trashed");
  release();
  const refused = await writing;
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "page_trashed");
  // Neither the add nor the removal landed: a Page in Trash takes no tag change.
  assert.deepEqual(
    rows().map((row) => row.tag),
    ["keep"],
  );
});

test("a held no-op write on a Page trashed meanwhile still answers page_trashed", async (t) => {
  const { f, db, rows } = await tagged(t);
  await project(f);
  await update(f, "owner", { add: ["keep"] });
  const release = holdBatch(db);
  const writing = update(f, "owner", { add: ["keep"] });
  await untilBatchHeld(db);
  assert.equal((await trash(f)).status, 200);
  release();
  const refused = await writing;
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "page_trashed");
  assert.deepEqual(
    rows().map((row) => row.tag),
    ["keep"],
  );
});

test("a held no-op write on a Page deleted meanwhile answers not found", async (t) => {
  const { f, db, rows } = await tagged(t);
  await project(f);
  const release = holdBatch(db);
  const writing = update(f, "owner", { remove: ["absent"] });
  await untilBatchHeld(db);
  assert.equal((await purge(f, "tags-noop-purge")).status, 200);
  release();
  const refused = await writing;
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "page_not_found");
  assert.deepEqual(rows(), []);
});

test("a batch that timed out can't land on a Page trashed after the timeout", async (t) => {
  const { f, db, rows } = await tagged(t);
  await project(f);
  const write = catalogIndexTimeouts.write;
  catalogIndexTimeouts.write = 40;
  t.after(() => (catalogIndexTimeouts.write = write));
  const release = holdBatch(db);
  const writing = await Promise.all([
    update(f, "owner", { add: ["late"] }),
    untilBatchHeld(db),
  ]).then(([response]) => response);
  // The caller is told D1 did not answer, which doesn't say whether it wrote.
  assert.equal(writing.status, 503);
  assert.equal(writing.body.code, "tags_unavailable");
  // The queue was free at the timeout, so Trash runs, and only then does the
  // stalled batch reach D1.
  assert.equal((await trash(f)).status, 200);
  release();
  await settled(50);
  assert.deepEqual(rows(), [], "the late batch inserted a row on a Page in Trash");
  // The Page's tags still work once restored.
  const restored = await f.catalogCall("owner", "restore_page", {
    page_id: pageId,
    nonce: "tags-restore-0002",
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual((await update(f, "owner", { add: ["late"] })).body.tags, ["late"]);
});

// CONTROL. No Trash happens here, so this passes with or without the fence:
// a batch that timed out and lands later is an ordinary write, and the retry
// the 503 tells the caller to make changes nothing. It pins that the fence
// doesn't reject a write on a Page that was never trashed.
test("control: a timed-out batch that lands before any Trash is the write the caller retries", async (t) => {
  const { f, db, rows } = await tagged(t);
  await project(f);
  const write = catalogIndexTimeouts.write;
  catalogIndexTimeouts.write = 40;
  t.after(() => (catalogIndexTimeouts.write = write));
  const release = holdBatch(db);
  const [timedOut] = await Promise.all([update(f, "owner", { add: ["code"] }), untilBatchHeld(db)]);
  assert.equal(timedOut.status, 503);
  release();
  await settled(50);
  assert.deepEqual(
    rows().map((row) => row.tag),
    ["code"],
  );
  const landed = db
    .rows("SELECT tag, added_by, added_at FROM page_tags")
    .map((row) => ({ ...row }));
  const retried = await update(f, "owner", { add: ["code"] });
  assert.deepEqual(retried.body.tags, ["code"]);
  assert.deepEqual(
    db.rows("SELECT tag, added_by, added_at FROM page_tags").map((row) => ({ ...row })),
    landed,
    "the retry rewrote no row",
  );
});

test("a Page's deleted mark answers a held write as not found", async (t) => {
  const { f, db, rows } = await tagged(t);
  await project(f);
  const release = holdBatch(db);
  const writing = update(f, "owner", { add: ["late"] });
  await untilBatchHeld(db);
  const purged = await purge(f);
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  release();
  const refused = await writing;
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "page_not_found");
  assert.deepEqual(rows(), []);
});

test("a purge deletes the Page's tag rows itself, and only that Page's", async (t) => {
  const { f, db, rows } = await tagged(t);
  await update(f, "owner", { add: ["code", "repo:nteract"] });
  const other = "44444444-4444-4444-8444-444444444444";
  db.sqlite.prepare("INSERT INTO page_tags VALUES (?, 'keep', ?, ?)").run(other, f.owner, "x");
  // Trash keeps the tags.
  assert.equal((await trash(f, "tags-keeps-trash")).status, 200);
  assert.equal(rows().length, 2);
  const preview = await f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "preview",
  });
  const purged = await f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.body.preview_token,
    nonce: "tags-purge-0001",
  });
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  assert.deepEqual(rows(), []);
  assert.deepEqual(
    db.rows("SELECT page_id FROM page_tags").map((row) => row.page_id),
    [other],
  );
});

test("a purge deletes the tag rows with the catalog index off, and with nothing to delete", async (t) => {
  // Rows written while the index was on, a purge after it was turned off.
  const db = sqliteD1(t).open();
  await migrateCatalogIndex(db);
  await migratePageTags(db);
  const f = await fixture(t, { env: { DB: db } });
  db.sqlite.prepare("INSERT INTO page_tags VALUES (?, 'old', ?, ?)").run(pageId, f.owner, "x");
  const purged = await purge(f);
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  assert.equal(pageState(f.page.metadata), "deleted");
  assert.deepEqual(db.rows("SELECT * FROM page_tags"), []);
  // An index that never ran has no tag table: the purge still completes.
  const bare = sqliteD1(t).open();
  const g = await fixture(t, { env: { DB: bare } });
  assert.equal((await purge(g)).status, 200);
  assert.equal(pageState(g.page.metadata), "deleted");
  // No database at all.
  const none = await fixture(t);
  assert.equal((await purge(none)).status, 200);
});

test("a purge whose tag delete fails repeats it until it lands", async (t) => {
  const { f, db, rows } = await tagged(t);
  await update(f, "owner", { add: ["code"] });
  assert.equal((await trash(f, "retry-trash")).status, 200);
  const preview = await f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "preview",
  });
  const confirm = () =>
    f.catalogCall("owner", "purge_page", {
      page_id: pageId,
      action: "confirm",
      preview_token: preview.body.preview_token,
      nonce: "tags-purge-retry",
    });
  db.mode = "fail";
  const failed = await confirm();
  assert.ok(failed.status >= 500, JSON.stringify(failed));
  assert.deepEqual(
    rows().map((row) => row.tag),
    ["code"],
  );
  db.mode = "ok";
  const retried = await confirm();
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.deepEqual(rows(), []);
  assert.equal(pageState(f.page.metadata), "deleted");
});
