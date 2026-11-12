// update_page_tags: the Page host's side (access, validation, limits, Trash)
// and the public gateway's side (routing and arguments).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { migrateCatalogIndex } from "./catalog-index.mjs";
import worker from "./index.mjs";
import { fixture, pageId } from "./trash-fixture.mjs";

async function tagged(t, options = {}) {
  const db = sqliteD1(t).open();
  await migrateCatalogIndex(db);
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
