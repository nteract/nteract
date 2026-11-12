// create_page's `tags`: validated and reachable before anything is reserved,
// written to `page_tags` as the caller once the receipt exists, and repeated
// by a retry of the same call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { migratePageTags } from "./page-tags-store.mjs";
import { world } from "./projects-fixture.mjs";

const tagRows = (w, pageId) =>
  w.db
    .rows("SELECT tag, added_by FROM page_tags WHERE page_id = ? ORDER BY tag", pageId)
    .map((row) => ({ ...row }));
const catalogPages = async (w, principal = w.owner) => [
  ...(await w.catalogStorage(principal).list({ prefix: "page/" })).keys(),
];

test("create_page tags the new Page as its caller, and list_pages finds it by them", async (t) => {
  const w = await world(t);
  const created = await w.createPage({
    title: "Tagged",
    tags: ["Code", "session:ses_AbC", "code"],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(created.body.tags, ["code", "session:ses_abc"]);
  assert.equal(created.body.tags_applied, undefined);
  assert.deepEqual(tagRows(w, created.body.page_id), [
    { tag: "code", added_by: w.owner },
    { tag: "session:ses_abc", added_by: w.owner },
  ]);
  await w.settle();
  const found = await w.call("owner", "list_pages", { tags: "session:ses_ABC" });
  assert.deepEqual(
    found.body.pages.map((page) => page.page_id),
    [created.body.page_id],
  );
  // A Page created without tags has no rows, and `tags: []` is no tags.
  const bare = await w.createPage({ title: "Bare" });
  const empty = await w.createPage({ title: "Empty", tags: [] });
  for (const result of [bare, empty]) {
    assert.equal(result.status, 200);
    assert.equal("tags" in result.body, false);
    assert.deepEqual(tagRows(w, result.body.page_id), []);
  }
});

test("a bad tag refuses the call before a Page is reserved", async (t) => {
  const w = await world(t);
  for (const [tags, code] of [
    [["has space"], "invalid_tag"],
    [["and"], "invalid_tag"],
    [["ok", "Café"], "invalid_tag"],
    ["code", "invalid_arguments"],
    [Array.from({ length: 33 }, (_, index) => `t${index}`), "invalid_arguments"],
    [null, "invalid_arguments"],
  ]) {
    const refused = await w.createPage({ title: "Refused", tags });
    assert.equal(refused.status, 400, JSON.stringify([tags, refused.body]));
    assert.equal(refused.body.code, code, JSON.stringify(tags));
  }
  assert.deepEqual(await catalogPages(w), [], "no Catalog entry was reserved");
  await migratePageTags(w.db);
  assert.equal(w.db.rows("SELECT count(*) AS n FROM page_tags")[0].n, 0);
});

test("with no tag database, a tagged create creates nothing and an untagged one still works", async (t) => {
  const w = await world(t, { index: "" });
  const refused = await w.createPage({ title: "Needs tags", tags: ["code"] });
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "tags_unavailable");
  assert.deepEqual(await catalogPages(w), []);
  const plain = await w.createPage({ title: "Plain" });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal((await catalogPages(w)).length, 1);
});

test("a tag write that fails after the Page exists says so, and the same call retries it", async (t) => {
  const w = await world(t);
  // Warm the tag schema, so the pre-check passes and the write is what fails.
  await w.createPage({ title: "Warm", tags: ["warm"] });
  await w.settle();
  const args = { title: "Half", tags: ["code"], nonce: w.key() };
  w.db.mode = "fail";
  const half = await w.createPage(args);
  w.db.mode = "ok";
  assert.equal(half.status, 200, JSON.stringify(half.body));
  assert.equal(half.body.tags_applied, false);
  assert.equal(half.body.tags_error.code, "tags_unavailable");
  assert.equal("tags" in half.body, false);
  assert.match(half.body.tags_error.message, /same create_page/);
  const pageId = half.body.page_id;
  assert.deepEqual(tagRows(w, pageId), []);
  // The same call replays the receipt and writes the tags: one Page, not two.
  const retried = await w.createPage(args);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.page_id, pageId);
  assert.deepEqual(retried.body.tags, ["code"]);
  assert.deepEqual(tagRows(w, pageId), [{ tag: "code", added_by: w.owner }]);
  assert.equal((await catalogPages(w)).length, 2, "the warm-up Page and this one");
  // Repeating it again changes nothing.
  assert.deepEqual((await w.createPage(args)).body.tags, ["code"]);
  assert.deepEqual(tagRows(w, pageId), [{ tag: "code", added_by: w.owner }]);
});

test("a retry that changes the tags is not the same request", async (t) => {
  const w = await world(t);
  const nonce = w.key();
  const first = await w.createPage({ title: "Same", tags: ["one"], nonce });
  assert.equal(first.status, 200);
  const changed = await w.createPage({ title: "Same", tags: ["two"], nonce });
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.deepEqual(tagRows(w, first.body.page_id), [{ tag: "one", added_by: w.owner }]);
});

test("a Project editor's tags on a Page in someone else's Project are theirs (added_by)", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Shared");
  const granted = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "set_role",
    principal: w.member,
    role: "editor",
    expected_revision: 0,
    nonce: w.key(),
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  const created = await w.createPage(
    { title: "By member", project_id: project.project_id, tags: ["Review"] },
    "member",
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(created.body.tags, ["review"]);
  assert.deepEqual(tagRows(w, created.body.page_id), [{ tag: "review", added_by: w.member }]);
});
