import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { RETRY_LIFETIME_MS } from "./operation-journal.mjs";
import { world } from "./projects-fixture.mjs";

/**
 * A tokened write crosses the Catalog into a Space or a Page, and each object
 * keys its own receipt by token and nonce. These tests compute that key here,
 * from the token's SHA-256 and the caller's nonce, and look for it at each
 * object.
 */
const scoped = (token, nonce) => `v1_${createHash("sha256").update(token).digest("hex")}_${nonce}`;

/** A catalog token that differs from `previous`: tokens issued in the same
 * millisecond are identical. */
async function freshToken(w, operation, previous) {
  for (;;) {
    const { retry_token } = (await w.call("owner", operation)).body;
    if (retry_token !== previous) return retry_token;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("an interrupted tokened update_project replays at the Space under the derived key", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  const space = () => w.projects.get(project.project_id).ctx.storage;
  const token = (await w.call("owner", "list_projects")).body.retry_token;
  const nonce = crypto.randomUUID();
  const update = {
    project_id: project.project_id,
    title: "Launch v2",
    expected_revision: 0,
    retry_token: token,
    idempotency_key: nonce,
  };
  // The Space applies it, and its answer is lost on the way back.
  w.faults.set(project.project_id, "lost");
  const lost = await w.call("owner", "update_project", update);
  assert.notEqual(lost.status, 200);
  const key = scoped(token, nonce);
  assert.equal((await w.catalogStorage().get(`host/operation/${key}`)).pending, true);
  assert.ok(await space().get(`host/receipt/${key}`), "the Space keyed its receipt");
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
  assert.equal((await w.catalogStorage().get(`host/operation/${key}`)).pending, false);

  // The same nonce under another token is another request, at both objects.
  const next = await freshToken(w, "list_projects", token);
  const again = await w.call("owner", "update_project", {
    ...update,
    title: "Launch v3",
    expected_revision: 1,
    retry_token: next,
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.revision, 2);
  const nextKey = scoped(next, nonce);
  assert.notEqual(nextKey, key);
  assert.ok(await w.catalogStorage().get(`host/operation/${nextKey}`));
  assert.ok(await space().get(`host/receipt/${nextKey}`));
  assert.ok(await space().get(`host/receipt/${key}`), "the first receipt stays");
});

test("a tokened Trash whose answer was lost reaches the Page again, keyed by token and nonce", async (t) => {
  const w = await world(t);
  const { page_id } = (await w.createPage({ title: "Plan" })).body;
  const token = (await w.call("owner", "list_pages")).body.retry_token;
  const nonce = crypto.randomUUID();
  const trash = { page_id, retry_token: token, idempotency_key: nonce };
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
  const key = scoped(token, nonce);
  assert.equal((await w.catalogStorage().get(`host/operation/${key}`)).pending, true);
  assert.ok(await page.ctx.storage.get(`host/lifecycle/${key}`), "the Page keyed its receipt");
  assert.equal(await page.ctx.storage.get(`host/lifecycle/${nonce}`), undefined);
  // The Catalog holds no finished receipt, so the retry goes to the Page,
  // which answers from its own receipt.
  const retry = await w.call("owner", "delete_page", trash);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.state, "trashed");
  assert.equal(trashCalls(), 2);
  assert.equal((await w.catalogStorage().get(`host/operation/${key}`)).pending, false);

  // The same nonce under another token is another request at both objects.
  const next = await freshToken(w, "list_pages", token);
  const restored = await w.call("owner", "restore_page", {
    page_id,
    retry_token: next,
    idempotency_key: nonce,
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const nextKey = scoped(next, nonce);
  assert.ok(await w.catalogStorage().get(`host/operation/${nextKey}`));
  assert.ok(await page.ctx.storage.get(`host/lifecycle/${nextKey}`));
  assert.ok(await page.ctx.storage.get(`host/lifecycle/${key}`), "the Trash receipt stays");
});

test("move_page after its receipt was collected answers retry_expired", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const w = await world(t);
  const project = await w.createProject();
  const a = (await w.createPage({ title: "A", project_id: project.project_id })).body.page_id;
  const b = (await w.createPage({ title: "B", project_id: project.project_id })).body.page_id;
  const token = (await w.call("owner", "list_pages")).body.retry_token;
  const move = {
    page_id: a,
    parent_id: b,
    retry_token: token,
    idempotency_key: crypto.randomUUID(),
  };
  const moved = await w.call("owner", "move_page", move);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const key = `host/operation/${scoped(token, move.idempotency_key)}`;
  assert.ok(await w.catalogStorage().get(key));
  // Past the window, a new tokened write collects the old receipt.
  now += RETRY_LIFETIME_MS + 1000;
  const renewed = (await w.call("owner", "list_pages")).body.retry_token;
  const back = await w.call("owner", "move_page", {
    page_id: a,
    project_id: project.project_id,
    retry_token: renewed,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(await w.catalogStorage().get(key), undefined, "collected");
  const expired = await w.call("owner", "move_page", move);
  assert.equal(expired.status, 410, JSON.stringify(expired.body));
  assert.equal(expired.body.code, "retry_expired");
  // Nothing moved again: A stays at the top level where the second move put it.
  const listed = await w.call("owner", "list_pages", { project_id: project.project_id });
  assert.equal(listed.body.pages.find((page) => page.page_id === a).parent_id, null);
});
