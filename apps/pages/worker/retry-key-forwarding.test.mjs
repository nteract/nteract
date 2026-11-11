import assert from "node:assert/strict";
import { test } from "node:test";
import { RECEIPT_LIFETIME_MS } from "./operation-journal.mjs";
import { world } from "./projects-fixture.mjs";

/**
 * A write crosses the Catalog into a Space or a Page, and each object keys
 * its own receipt by the caller's account, the receipt lane and the nonce.
 * These tests compute those keys and look for them at each object.
 */
const stored = (prefix, key) => `${prefix}${key.slice("host/operation/".length)}`;

test("an interrupted update_project replays at the Space under the account's key", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  const space = () => w.projects.get(project.project_id).ctx.storage;
  const nonce = crypto.randomUUID();
  const update = {
    project_id: project.project_id,
    title: "Launch v2",
    expected_revision: 0,
    nonce,
  };
  // The Space applies it, and its answer is lost on the way back.
  w.faults.set(project.project_id, "lost");
  const lost = await w.call("owner", "update_project", update);
  assert.notEqual(lost.status, 200);
  assert.equal((await w.receipt(nonce)).pending, true);
  const spaceKey = stored("host/receipt/", await w.receiptKey(nonce, w.owner, "project"));
  assert.ok(await space().get(spaceKey), "the Space keyed its receipt");
  assert.equal(await space().get(`host/receipt/${nonce}`), undefined);
  // The retry reaches the Space, which replays: the revision moves once.
  const retry = await w.call("owner", "update_project", update);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.revision, 1);
  assert.equal(retry.body.title, "Launch v2");
  assert.equal(
    (await w.call("owner", "get_project", { project_id: project.project_id })).body.revision,
    1,
  );
  assert.equal((await w.receipt(nonce)).pending, false);
  // The same nonce for another update is a conflict, not a second request.
  const again = await w.call("owner", "update_project", {
    ...update,
    title: "Launch v3",
    expected_revision: 1,
  });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, "nonce_conflict");
});

test("a Trash whose answer was lost reaches the Page again, keyed by account and nonce", async (t) => {
  const w = await world(t);
  const { page_id } = (await w.createPage({ title: "Plan" })).body;
  const nonce = crypto.randomUUID();
  const trash = { page_id, nonce };
  const page = w.page(page_id);
  const trashCalls = () =>
    page.fetch.mock.calls.filter(
      ({ arguments: [request] }) => new URL(request.url).pathname === "/internal/trash",
    ).length;
  t.mock.method(page, "fetch");
  w.faults.set(page_id, "lost");
  const lost = await w.call("owner", "delete_page", trash);
  assert.notEqual(lost.status, 200);
  assert.equal(trashCalls(), 1);
  assert.equal((await w.receipt(nonce)).pending, true);
  const pageKey = stored("host/lifecycle/", await w.receiptKey(nonce, w.owner, "lifecycle"));
  assert.ok(await page.ctx.storage.get(pageKey), "the Page keyed its receipt");
  assert.equal(await page.ctx.storage.get(`host/lifecycle/${nonce}`), undefined);
  // The Catalog holds no finished receipt, so the retry goes to the Page,
  // which answers from its own receipt.
  const retry = await w.call("owner", "delete_page", trash);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.state, "trashed");
  assert.equal(trashCalls(), 2);
  assert.equal((await w.receipt(nonce)).pending, false);
  // The same nonce for a restore is a conflict in the Catalog's lane, and
  // the Page never sees it.
  const restored = await w.call("owner", "restore_page", { page_id, nonce });
  assert.equal(restored.status, 409, JSON.stringify(restored.body));
  assert.equal(restored.body.code, "nonce_conflict");
  assert.equal(trashCalls(), 2);
});

test("move_page after its receipt was collected is a new request", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const w = await world(t);
  const project = await w.createProject();
  const a = (await w.createPage({ title: "A", project_id: project.project_id })).body.page_id;
  const b = (await w.createPage({ title: "B", project_id: project.project_id })).body.page_id;
  const move = { page_id: a, parent_id: b, nonce: crypto.randomUUID() };
  const moved = await w.call("owner", "move_page", move);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.ok(await w.receipt(move.nonce));
  // Past the receipt lifetime, a new write collects the old receipt.
  now += RECEIPT_LIFETIME_MS + 1000;
  const back = await w.call("owner", "move_page", {
    page_id: a,
    project_id: project.project_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(await w.receipt(move.nonce), undefined, "collected");
  // move_page names no revision, so nothing fences it: the old request runs
  // again and moves A back under B.
  const repeated = await w.call("owner", "move_page", move);
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  const listed = await w.call("owner", "list_pages", { project_id: project.project_id });
  assert.equal(listed.body.pages.find((page) => page.page_id === a).parent_id, b);
});
