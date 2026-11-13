// The REST routes: GET /api/pages is list_pages with its query string as its
// arguments, and PUT|DELETE /api/pages/<id>/tags/<tag> change one tag. Both
// run the operations the gateway already has, so these tests pin the wrapper:
// the same answers as the operation, and the refusals the wrapper adds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listArguments, tagFromSegment } from "./rest-api.mjs";
import { world } from "./projects-fixture.mjs";

const query = (text) => listArguments(new URLSearchParams(text));

test("a query string becomes list_pages arguments, restoring only the typing it loses", () => {
  assert.deepEqual(query(""), {});
  assert.deepEqual(
    query(
      "limit=25&in_trash=false&include_tags=true&parent_id=null&query=road%20map&sort=title&tags=a+AND+NOT+b",
    ),
    {
      limit: 25,
      in_trash: false,
      include_tags: true,
      parent_id: null,
      query: "road map",
      sort: "title",
      tags: "a AND NOT b",
    },
  );
  // What doesn't coerce stays the string it is, for list_pages to refuse.
  assert.deepEqual(query("limit=ten&in_trash=yes&include_tags=1&parent_id=nothing"), {
    limit: "ten",
    in_trash: "yes",
    include_tags: "1",
    parent_id: "nothing",
  });
  assert.deepEqual(query("limit=-1&limit2=3"), { limit: "-1", limit2: "3" });
  // A repeated parameter has no single meaning.
  for (const text of ["limit=1&limit=2", "tags=a&tags=b"])
    assert.throws(() => query(text), { status: 400, code: "invalid_arguments" }, text);
});

test("a tag path segment is percent-decoded once, and a bad encoding is invalid_tag", () => {
  assert.equal(tagFromSegment("repo%3Aorg%2Fname"), "repo:org/name");
  assert.equal(tagFromSegment("status:done"), "status:done");
  assert.equal(tagFromSegment("a%2520b"), "a%20b");
  assert.throws(() => tagFromSegment("%E0%A4%A"), { status: 400, code: "invalid_tag" });
});

/** Pages the owner can list, with a tag or two each, through the REST route. */
async function tagged(t) {
  const w = await world(t);
  const made = [];
  for (const title of ["Plan", "Review", "Notes"]) {
    const created = await w.createPage({ title });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    made.push(created.body.page_id);
  }
  await w.settle();
  const tag = (id, name, who = "owner") =>
    w.rest(who, "PUT", `/api/pages/${id}/tags/${encodeURIComponent(name)}`);
  return { w, made, tag };
}

test("PUT and DELETE change one tag of one Page, and GET /api/pages finds it", async (t) => {
  const { w, made, tag } = await tagged(t);
  const [plan, review] = made;
  const put = await tag(plan, "Repo:Nteract/Pages");
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body, {
    page_id: plan,
    tag: "repo:nteract/pages",
    tags: ["repo:nteract/pages"],
    added: true,
  });
  // A repeat is the same request: 200, nothing changed.
  const again = await tag(plan, "repo:nteract/pages");
  assert.equal(again.status, 200);
  assert.equal(again.body.added, false);
  assert.equal((await tag(review, "status:blocked")).status, 200);
  assert.equal((await tag(plan, "status:blocked")).status, 200);

  const found = await w.rest(
    "owner",
    "GET",
    "/api/pages?tags=status:blocked+AND+NOT+repo:nteract/pages",
  );
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(
    found.body.pages.map((page) => page.page_id),
    [review],
  );
  assert.equal(found.body.tag_filter, "status:blocked AND NOT repo:nteract/pages");
  assert.deepEqual(found.body.pages[0].tags, ["status:blocked"]);

  const gone = await w.rest("owner", "DELETE", `/api/pages/${plan}/tags/status%3Ablocked`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.deepEqual(gone.body, {
    page_id: plan,
    tag: "status:blocked",
    tags: ["repo:nteract/pages"],
    removed: true,
  });
  const missing = await w.rest("owner", "DELETE", `/api/pages/${plan}/tags/status%3Ablocked`);
  assert.equal(missing.status, 200);
  assert.equal(missing.body.removed, false);
});

test("a tag route answers like the Page host: refusals, access and codes", async (t) => {
  const { w, made, tag } = await tagged(t);
  const [plan] = made;
  const invalid = await tag(plan, "has space");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "invalid_tag");
  // A stranger and a read-only key are both refused.
  assert.equal((await tag(plan, "code", "stranger")).status, 403);
  assert.equal((await tag(plan, "code", "reader")).status, 403);
  // Nothing under the route but PUT and DELETE.
  for (const method of ["GET", "POST"])
    assert.equal((await w.rest("owner", method, `/api/pages/${plan}/tags/code`)).status, 405);
  assert.equal((await w.rest("owner", "PUT", "/api/pages/not-a-page/tags/code")).status, 400);
  const limit = Array.from({ length: 32 }, (_, index) => `t${index}`);
  for (const name of limit) assert.equal((await tag(plan, name)).status, 200, name);
  const over = await tag(plan, "one-too-many");
  assert.equal(over.status, 409);
  assert.equal(over.body.code, "tag_limit_exceeded");
});

test("GET /api/pages answers what list_pages answers, for the same arguments", async (t) => {
  const { w, made, tag } = await tagged(t);
  await tag(made[0], "code");
  await tag(made[1], "code");
  await w.settle();
  const trashed = await w.call("owner", "delete_page", { page_id: made[2], nonce: w.key() });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  const cases = [
    [{}, ""],
    [{ limit: 2 }, "limit=2"],
    [{ query: "rev" }, "query=rev"],
    [{ include_tags: true }, "include_tags=true"],
    [{ tags: "code" }, "tags=code"],
    [{ tags: "NOT code", include_tags: true }, "tags=NOT+code&include_tags=true"],
    [{ in_trash: true }, "in_trash=true"],
    [{ sort: "title", kind: "page" }, "sort=title&kind=page"],
    [{ access: "owned", limit: 1 }, "access=owned&limit=1"],
  ];
  for (const [args, text] of cases) {
    const viaTool = await w.call("owner", "list_pages", args);
    const viaRest = await w.rest("owner", "GET", `/api/pages${text && `?${text}`}`);
    assert.equal(viaRest.status, viaTool.status, text);
    // A sealed cursor differs on every call; the last check opens one on both routes.
    const plain = ({ next_cursor, ...body }) => ({ ...body, has_next: Boolean(next_cursor) });
    assert.deepEqual(plain(viaRest.body), plain(viaTool.body), text || "(no arguments)");
  }
  // A cursor from one route opens on the other.
  const first = await w.rest("owner", "GET", "/api/pages?limit=1");
  assert.ok(first.body.next_cursor);
  const second = await w.rest(
    "owner",
    "GET",
    `/api/pages?limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`,
  );
  const viaTool = await w.call("owner", "list_pages", { limit: 1, cursor: first.body.next_cursor });
  assert.deepEqual(second.body, viaTool.body);
});

test("GET /api/pages refuses what list_pages refuses, and names what the route can't read", async (t) => {
  const { w } = await tagged(t);
  const refused = async (text, status, code) => {
    const response = await w.rest("owner", "GET", `/api/pages?${text}`);
    assert.equal(response.status, status, `${text}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, code, text);
    return response;
  };
  await refused("limit=0", 400, "invalid_list_arguments");
  await refused("limit=ten", 400, "invalid_list_arguments");
  await refused("in_trash=maybe", 400, "invalid_list_arguments");
  await refused("tags=a+AND+b+OR+c", 400, "invalid_list_arguments");
  await refused("sort=random", 400, "invalid_list_arguments");
  await refused("cursor=not-a-cursor", 400, "invalid_cursor");
  // The arguments are list_pages' own: anything else is named and refused.
  await refused("page_id=x", 400, "invalid_arguments");
  await refused("nonce=abcdef", 400, "invalid_arguments");
  await refused("limit=1&limit=2", 400, "invalid_arguments");
  await refused("space_id=sp_x", 400, "argument_renamed");
  assert.equal((await w.rest("owner", "POST", "/api/pages")).status, 405);
  assert.equal((await w.rest("owner", "PUT", "/api/pages")).status, 405);
});

test("GET /api/pages is a read: a read-only key lists, and nobody unauthenticated does", async (t) => {
  const { w } = await tagged(t);
  assert.equal((await w.rest("reader", "GET", "/api/pages")).status, 200);
  const anonymous = await (
    await import("./index.mjs")
  ).default.fetch(new Request("https://pages.invalid/api/pages"), w.env);
  assert.equal(anonymous.status, 401);
});

test("REST calls are logged on their own surface, with the operation and never the tag", async (t) => {
  const { w, made, tag } = await tagged(t);
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(line));
  assert.equal((await tag(made[0], "secret-project")).status, 200);
  assert.equal(
    (await w.rest("owner", "DELETE", `/api/pages/${made[0]}/tags/secret-project`)).status,
    200,
  );
  assert.equal((await w.rest("owner", "GET", "/api/pages?tags=secret-project")).status, 200);
  assert.equal((await w.rest("owner", "POST", "/api/pages")).status, 405);
  const events = lines
    .map((line) => (typeof line === "string" ? JSON.parse(line) : line))
    .filter((event) => event.event === "pages.usage.v1" && event.action === "tool.call");
  assert.deepEqual(
    events.map(({ surface, operation, outcome }) => ({ surface, operation, outcome })),
    [
      { surface: "http-rest", operation: "put_page_tag", outcome: "ok" },
      { surface: "http-rest", operation: "delete_page_tag", outcome: "ok" },
      { surface: "http-rest", operation: "list_pages", outcome: "ok" },
      { surface: "http-rest", operation: "unknown", outcome: "http_405" },
    ],
  );
  assert.equal(events[0].page_id, made[0]);
  assert.doesNotMatch(JSON.stringify(events), /secret-project/);
});
