import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaNotice } from "./quota.mjs";

test("Home shows usage only from 90% of the limit", () => {
  assert.equal(quotaNotice({ limit: 250, count: 224 }), null);
  assert.equal(
    quotaNotice({ limit: 250, count: 225 }),
    "You're using 225 Pages of 250 Pages in this alpha release.",
  );
  assert.equal(
    quotaNotice({ limit: 1000, count: 1000 }),
    "You're using 1,000 Pages of 1,000 Pages, the limit for this alpha release. Move Pages to Trash to make room for new ones.",
  );
  assert.equal(
    quotaNotice({ limit: 0, count: 4 }),
    "Creating Pages is turned off for this account.",
  );
});

test("a missing or malformed quota shows nothing", () => {
  for (const quota of [
    undefined,
    null,
    {},
    { limit: "250", count: 249 },
    { limit: 250 },
    { limit: -1, count: 0 },
    { limit: 250, count: 1.5 },
  ])
    assert.equal(quotaNotice(quota), null, JSON.stringify(quota));
});
