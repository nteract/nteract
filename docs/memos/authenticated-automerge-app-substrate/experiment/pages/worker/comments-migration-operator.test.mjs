// ONE-SHOT MIGRATION tests: delete with comments-migration.mjs and operator-gate.mjs.
// The Page write itself is covered by comments-migration.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import { world } from "./projects-fixture.mjs";
import { OPERATOR_SECRET_HEADER, operatorAuthorized } from "./comments-migration.mjs";

const SECRET = "s".repeat(48);

const operatorRequest = (body, headers = {}) =>
  new Request("https://pages.invalid/api/operator/comments-migration", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("the operator gate needs the configured secret and a request that skipped Cloudflare", async () => {
  const env = { PAGES_OPERATOR_SECRET: SECRET };
  const ok = { [OPERATOR_SECRET_HEADER]: SECRET };
  assert.equal(await operatorAuthorized(operatorRequest({}, ok), env), true);
  // No secret configured (a Cloudflare deployment, any profile without it).
  assert.equal(await operatorAuthorized(operatorRequest({}, ok), {}), false);
  assert.equal(
    await operatorAuthorized(operatorRequest({}, ok), { PAGES_OPERATOR_SECRET: "short" }),
    false,
  );
  // Wrong or missing secret.
  assert.equal(await operatorAuthorized(operatorRequest({}), env), false);
  assert.equal(
    await operatorAuthorized(operatorRequest({}, { [OPERATOR_SECRET_HEADER]: `${SECRET}x` }), env),
    false,
  );
  // Anything the Cloudflare edge forwarded carries headers the edge sets.
  for (const header of ["cf-ray", "cf-connecting-ip", "cf-visitor", "cdn-loop"])
    assert.equal(
      await operatorAuthorized(operatorRequest({}, { ...ok, [header]: "x" }), env),
      false,
      header,
    );
});

test("the public route answers 404 like any unknown path unless the gate opens", async () => {
  const unknown = await worker.fetch(
    new Request("https://pages.invalid/api/nothing-here", { method: "POST" }),
    {},
  );
  for (const [env, headers] of [
    [{}, { [OPERATOR_SECRET_HEADER]: SECRET }],
    [{ PAGES_OPERATOR_SECRET: SECRET }, {}],
    [{ PAGES_OPERATOR_SECRET: SECRET }, { [OPERATOR_SECRET_HEADER]: SECRET, "cf-ray": "1" }],
  ]) {
    const response = await worker.fetch(operatorRequest({ action: "accounts" }, headers), env);
    assert.equal(response.status, unknown.status);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
});

test("end to end: the operator lists every account and runs each one's Catalog", async (t) => {
  const w = await world(t);
  const mine = (await w.createPage({ title: "Mine" })).body.page_id;
  const theirs = (await w.createPage({ title: "Theirs" }, "member")).body.page_id;
  await w.settle();
  const env = { ...w.env, PAGES_OPERATOR_SECRET: SECRET };
  const operator = async (body) => {
    const response = await worker.fetch(
      operatorRequest(body, { [OPERATOR_SECRET_HEADER]: SECRET }),
      env,
    );
    return { status: response.status, body: await response.json() };
  };
  const accounts = await operator({ action: "accounts" });
  assert.equal(accounts.status, 200);
  assert.deepEqual(accounts.body.principals, [w.member, w.owner].sort());
  assert.equal(accounts.body.source, "d1_projection");

  const ownerRun = await operator({ action: "run", principal: w.owner, mode: "dry_run" });
  assert.equal(ownerRun.status, 200, JSON.stringify(ownerRun.body));
  assert.deepEqual(ownerRun.body.visited, [mine]);
  // This fixture's Page hosts open no comments document; the Page still
  // answered for its owner (not `not_owner`), which is what this checks.
  assert.equal(
    ownerRun.body.pages[0].status,
    "unavailable",
    JSON.stringify(ownerRun.body.pages[0]),
  );
  const memberRun = await operator({ action: "run", principal: w.member, mode: "dry_run" });
  assert.deepEqual(memberRun.body.visited, [theirs]);
  // The operator picks the Catalog; the Page still checks its record's owner.
  const crossed = await operator({
    action: "run",
    principal: w.member,
    mode: "dry_run",
    page_ids: [mine],
  });
  assert.equal(crossed.body.pages.find((page) => page.page_id === mine).status, "not_owner");
  // Apply writes the run state into that account's Catalog only.
  const applied = await operator({ action: "run", principal: w.owner, mode: "apply" });
  assert.equal(applied.body.progress.phase, "incomplete");
  assert.ok(await w.catalogStorage(w.owner).get("host/comments-migration/state"));
  assert.equal(await w.catalogStorage(w.member).get("host/comments-migration/state"), undefined);
  // A request through the public gateway as a user can't reach it.
  const asUser = await worker.fetch(
    new Request("https://pages.invalid/api/operator/comments-migration", {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey()}` },
      body: JSON.stringify({ action: "accounts" }),
    }),
    env,
  );
  assert.equal(asUser.status, 404);
});

test("end to end: the Catalog's operator route is host-only", async (t) => {
  const w = await world(t);
  const response = await w.env.CATALOGS.getByName(w.owner).fetch(
    new Request("https://pages.internal/internal/operator-comments-migration", {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey()}` },
      body: JSON.stringify({ principal: w.owner, mode: "dry_run" }),
    }),
  );
  assert.equal(response.status, 404);
});

test("end to end: a probe names the Page and owner behind a cell id", async (t) => {
  const w = await world(t);
  const page = (await w.createPage({ title: "Orphan?" }, "member")).body.page_id;
  const cell = "ab".repeat(32);
  const missing = "cd".repeat(32);
  const names = { [cell]: page, [missing]: "33333333-3333-4333-8333-333333333333" };
  const env = {
    ...w.env,
    PAGES_OPERATOR_SECRET: SECRET,
    PAGES: {
      ...w.env.PAGES,
      idFromString: (id) => id,
      get: (id) => w.env.PAGES.getByName(names[id]),
    },
  };
  const response = await worker.fetch(
    operatorRequest(
      { action: "probe", cell_ids: [cell, missing] },
      { [OPERATOR_SECRET_HEADER]: SECRET },
    ),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).cells, [
    { cell_id: cell, page_id: page, owner: w.member, state: "active" },
    { cell_id: missing, page_id: null, owner: null, state: "missing" },
  ]);
});
