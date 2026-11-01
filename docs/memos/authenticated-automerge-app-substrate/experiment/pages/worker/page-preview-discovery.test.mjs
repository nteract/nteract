import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, pageId, trashArgs } from "./trash-fixture.mjs";

const admission = { "x-pages-admission": "1" };
const discover = (f, who, query = "&preview=1") =>
  f.pageCall(who, `/api/connect?page=${pageId}${query}`, undefined, "GET", admission);
const expected = (f) => ({
  title: "Launch plan",
  blocks: [{ id: f.blockId, content: [["p", {}, "We ship on Friday."]] }],
  truncated: false,
});

test("discovery carries the Page's read-only preview only when asked", async (t) => {
  const f = await fixture(t);
  const plain = await discover(f, "owner", "");
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal("preview" in plain.body, false);

  const asked = await discover(f, "owner");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.deepEqual(asked.body.preview, expected(f));
  // The viewer keys the preview by the principal the host authenticated.
  assert.equal(asked.body.identity.principal, f.owner);
  // The preview adds to discovery; the rest of the answer is unchanged.
  const { preview: _preview, activity: _a, ...rest } = asked.body;
  const { activity: _b, ...before } = plain.body;
  assert.deepEqual(rest, before);
});

test("the preview follows the reader's access: granted, revoked, never granted", async (t) => {
  const f = await fixture(t);
  // The member's grant shows the same preview, under the member's principal.
  const granted = await discover(f, "member");
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.identity.principal, f.member);
  assert.deepEqual(granted.body.preview, expected(f));

  const revoke = await f.pageCall("owner", "/internal/access", {
    action: "set_role",
    principal: f.member,
    role: null,
    expected_revision: 1,
    idempotency_key: "revoke-member-preview",
  });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
  const revoked = await discover(f, "member");
  assert.equal(revoked.status, 403);
  assert.equal(revoked.body.code, "page_access_denied");
  assert.equal("preview" in revoked.body, false);
  assert.equal(JSON.stringify(revoked.body).includes("We ship on Friday."), false);

  const stranger = await discover(f, "stranger");
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.code, "page_access_denied");
  assert.equal(JSON.stringify(stranger.body).includes("We ship on Friday."), false);

  // The owner still reads it, so the refusals above are about access.
  assert.deepEqual((await discover(f, "owner")).body.preview, expected(f));
});

test("a Page in Trash gets no preview, even for the owner who can read it", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await discover(f, "owner")).body.preview, expected(f));
  assert.equal((await f.catalogCall("owner", "delete_page", trashArgs(f))).status, 200);
  const owner = await discover(f, "owner");
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.ok(owner.body.trash, "the owner's discovery says the Page is in Trash");
  assert.equal("preview" in owner.body, false);
  const member = await discover(f, "member");
  assert.equal(member.status, 403);
  assert.equal(member.body.code, "page_trashed");
  assert.equal("preview" in member.body, false);
});
