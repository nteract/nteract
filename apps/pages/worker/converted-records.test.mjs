// Permanent deletion of a Page converted from Subduction deletes the records
// the conversion left in the Page's own storage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pageState } from "./access.mjs";
import { fixture, pageId, trashArgs } from "./trash-fixture.mjs";

/** One key of each kind a Subduction Page wrote to its own storage. */
const LEFTOVER_KEYS = [
  "repo/subduction-v1/aa/commits/bb",
  "host/actor/actor-1",
  "host/binding/key-1",
  "host/signer",
];

/** Trash the fixture's Page, then permanently delete it. */
async function purge(f) {
  assert.equal((await f.catalogCall("owner", "delete_page", trashArgs(f))).status, 200);
  const preview = await f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "preview",
  });
  assert.equal(preview.status, 200);
  const purged = await f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.body.preview_token,
    nonce: "purge-request",
  });
  assert.equal(purged.status, 200);
  assert.equal(pageState(f.page.metadata), "deleted");
}

/** A fixture Page whose record adds `record` and whose storage holds one
 * leftover key of each kind. */
async function seeded(t, record) {
  const f = await fixture(t);
  Object.assign(f.page.metadata, record);
  for (const key of LEFTOVER_KEYS) await f.storage.put(key, new Uint8Array(8));
  return f;
}

const present = async (f) =>
  (await Promise.all(LEFTOVER_KEYS.map((key) => f.storage.get(key)))).filter(Boolean).length;

test("purging a converted Page deletes its leftover Subduction records", async (t) => {
  for (const from of ["buffered", "local"]) {
    const f = await seeded(t, { recordStorageMigratedFrom: from });
    await purge(f);
    assert.equal(await present(f), 0, from);
  }
});

test("purging a Page that was never converted leaves those keys alone", async (t) => {
  const f = await seeded(t, {});
  await purge(f);
  assert.equal(await present(f), LEFTOVER_KEYS.length);
});
