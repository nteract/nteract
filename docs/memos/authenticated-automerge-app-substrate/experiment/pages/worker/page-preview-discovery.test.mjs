import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, pageId } from "./trash-fixture.mjs";

const admission = { "x-pages-admission": "1" };

test("discovery carries the Page's read-only preview only when asked", async (t) => {
  const f = await fixture(t);
  const plain = await f.pageCall(
    "owner",
    `/api/connect?page=${pageId}`,
    undefined,
    "GET",
    admission,
  );
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal("preview" in plain.body, false);

  const asked = await f.pageCall(
    "owner",
    `/api/connect?page=${pageId}&preview=1`,
    undefined,
    "GET",
    admission,
  );
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.deepEqual(asked.body.preview, {
    title: "Launch plan",
    blocks: [{ id: f.blockId, content: [["p", {}, "We ship on Friday."]] }],
    truncated: false,
  });
  // The preview adds to discovery; the rest of the answer is unchanged.
  const { preview: _preview, activity: _a, ...rest } = asked.body;
  const { activity: _b, ...before } = plain.body;
  assert.deepEqual(rest, before);
});

test("a reader without access gets the usual refusal and no preview", async (t) => {
  const f = await fixture(t);
  const refused = await f.pageCall(
    "stranger",
    `/api/connect?page=${pageId}&preview=1`,
    undefined,
    "GET",
    admission,
  );
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "page_access_denied");
  assert.equal("preview" in refused.body, false);
});
