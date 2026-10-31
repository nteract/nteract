import assert from "node:assert/strict";
import { test } from "node:test";
import { pageState, proposeAccessUpdate } from "./access.mjs";
import { MAX_DEPTH } from "./spaces.mjs";
import {
  PAGE_MOVE_EVENTS,
  PAGE_MOVE_STATES,
  pageMoveEffect,
  pageMoveStart,
  pageMoveTransition,
} from "./page-move.mjs";
import { reportPageIndex } from "./catalog-index.mjs";
import { testCtx, world } from "./projects-fixture.mjs";
import { tools } from "../mcp.mjs";

const ids = (listing) => listing.body.pages.map((page) => page.page_id).sort();

test("move machine: every state and event has exactly one outcome", () => {
  const states = {
    first: { name: "placing", cursor: 0, total: 3 },
    middle: { name: "placing", cursor: 1, total: 3 },
    last: { name: "placing", cursor: 2, total: 3 },
    placed: { name: "placed", total: 3 },
    ready: { name: "ready", total: 3 },
    released: { name: "released", total: 3 },
  };
  const expected = {
    first: {
      placed: [{ name: "placing", cursor: 1, total: 3 }, { type: "place_page", index: 1 }],
      refused: [{ name: "released", total: 3 }, { type: "release_intent" }],
    },
    middle: {
      placed: [{ name: "placing", cursor: 2, total: 3 }, { type: "place_page", index: 2 }],
      // A descendant's refusal skips it: the root has already moved.
      refused: [{ name: "placing", cursor: 2, total: 3 }, { type: "place_page", index: 2 }],
    },
    last: {
      placed: [{ name: "placed", total: 3 }, { type: "commit_catalog" }],
      refused: [{ name: "placed", total: 3 }, { type: "commit_catalog" }],
    },
    placed: { committed: [{ name: "ready", total: 3 }, null] },
    ready: {},
    released: {},
  };
  for (const [label, state] of Object.entries(states))
    for (const type of PAGE_MOVE_EVENTS) {
      const outcome = expected[label][type];
      if (outcome)
        assert.deepEqual(
          pageMoveTransition(state, { type }),
          { state: outcome[0], effect: outcome[1] },
          `${label} × ${type}`,
        );
      else
        assert.throws(() => pageMoveTransition(state, { type }), /cannot take/, `${label} × ${type}`);
    }
  assert.deepEqual(PAGE_MOVE_STATES, ["placing", "placed", "ready", "released"]);
  assert.deepEqual(pageMoveEffect(states.middle), { type: "place_page", index: 1 });
  assert.deepEqual(pageMoveEffect(states.placed), { type: "commit_catalog" });
  assert.equal(pageMoveEffect(states.ready), null);
  assert.equal(pageMoveEffect(states.released), null);
  assert.throws(() => pageMoveTransition(states.first, { type: "moved" }), /Unknown move event/);
  assert.throws(() => pageMoveEffect({ name: "placing", cursor: 3, total: 3 }), /plan step/);
  assert.throws(() => pageMoveStart(0), /at least one Page/);
});

test("move machine: a single-Page plan and a resumed plan both reach ready", () => {
  for (const total of [1, 4])
    for (let resumeAt = 0; resumeAt < total; resumeAt++) {
      let state = { name: "placing", cursor: resumeAt, total };
      const placed = [];
      for (let effect = pageMoveEffect(state); effect; ) {
        if (effect.type === "place_page") placed.push(effect.index);
        ({ state, effect } = pageMoveTransition(state, {
          type: effect.type === "commit_catalog" ? "committed" : "placed",
        }));
      }
      assert.equal(state.name, "ready");
      assert.deepEqual(
        placed,
        Array.from({ length: total - resumeAt }, (_, index) => resumeAt + index),
      );
    }
});

/** move_page through the public tool route. */
const mover = (w) => (args, idempotency_key = w.key(), who = "owner") =>
  w.call(who, "move_page", { idempotency_key, ...args });

test("a loose Page moves into a Project and back out, keeping its id and content", async (t) => {
  const w = await world(t);
  const move = mover(w);
  const project = await w.createProject("Launch");
  const loose = (await w.createPage({ title: "Draft", markdown: "Notes first." })).body.page_id;
  const heads = w.heads(loose);

  const into = await move({ page_id: loose, project_id: project.project_id });
  assert.equal(into.status, 200, JSON.stringify(into.body));
  assert.deepEqual(
    { ...into.body, position: typeof into.body.position },
    {
      page_id: loose,
      moved: true,
      title: "Draft",
      project_id: project.project_id,
      parent_id: null,
      position: "string",
      descendants: 0,
    },
  );
  assert.equal(into.body.space_id, undefined, "the API speaks Projects");
  const placement = w.page(loose).metadata.placement;
  assert.equal(placement.space_id, project.project_id);
  assert.equal(placement.placement_epoch, 1);
  assert.deepEqual(w.heads(loose), heads, "content is untouched");
  const read = await w.call("owner", "read_page", { page_id: loose, include_content: false });
  assert.equal(read.body.project_id, project.project_id);
  assert.deepEqual(read.body.breadcrumbs, [
    { kind: "project", project_id: project.project_id, title: "Launch" },
  ]);
  assert.deepEqual(
    ids(await w.call("owner", "list_pages", { project_id: project.project_id, parent_id: null })),
    [project.home_page_id, loose].sort(),
  );
  // New siblings sort after existing ones by default.
  const positions = (
    await w.call("owner", "list_pages", { project_id: project.project_id, parent_id: null })
  ).body.pages.map((page) => page.position);
  assert.ok(positions.includes(into.body.position));

  // Nest it under the home Page, then take it back to Your items.
  const nested = await move({ page_id: loose, parent_id: project.home_page_id });
  assert.equal(nested.status, 200, JSON.stringify(nested.body));
  assert.equal(nested.body.project_id, project.project_id, "a parent implies its Project");
  assert.equal(nested.body.parent_id, project.home_page_id);
  const nestedRead = await w.call("owner", "read_page", { page_id: loose, include_content: false });
  assert.deepEqual(nestedRead.body.breadcrumbs, [
    { kind: "project", project_id: project.project_id, title: "Launch" },
    { kind: "page", page_id: project.home_page_id, title: "Launch", home: true },
  ]);

  const out = await move({ page_id: loose, project_id: null });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.project_id, null);
  assert.equal(out.body.parent_id, null);
  const outRead = await w.call("owner", "read_page", { page_id: loose, include_content: false });
  assert.equal(outRead.body.project_id, null);
  assert.deepEqual(outRead.body.breadcrumbs, []);
  assert.ok(
    !ids(await w.call("owner", "list_pages", { project_id: project.project_id })).includes(loose),
  );
  const all = await w.call("owner", "list_pages");
  const row = all.body.pages.find((page) => page.page_id === loose);
  assert.equal(row.project_id, undefined, "a top-level Your items row keeps its shape");
  assert.equal(w.page(loose).metadata.placement.placement_epoch, 3);
});

test("a move carries the whole subtree into the new Project, including sub-pages in Trash", async (t) => {
  const w = await world(t);
  const move = mover(w);
  const from = await w.createProject("From");
  const to = await w.createProject("To");
  const a = (await w.createPage({ title: "A", project_id: from.project_id })).body.page_id;
  const b = (await w.createPage({ title: "B", parent_id: a })).body.page_id;
  const c = (await w.createPage({ title: "C", parent_id: b })).body.page_id;
  const d = (await w.createPage({ title: "D", parent_id: b })).body.page_id;
  const target = (await w.createPage({ title: "Target", project_id: to.project_id })).body.page_id;
  const trashed = await w.call("owner", "delete_page", {
    page_id: d,
    base_heads: w.heads(d),
    idempotency_key: w.key(),
  });
  assert.equal(trashed.status, 200);
  const positionsBefore = Object.fromEntries(
    [b, c, d].map((id) => [id, w.page(id).metadata.placement.position]),
  );

  const moved = await move({ page_id: a, parent_id: target });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.descendants, 3);
  assert.equal(moved.body.project_id, to.project_id);
  for (const [id, parent] of [
    [a, target],
    [b, a],
    [c, b],
    [d, b],
  ]) {
    const placement = w.page(id).metadata.placement;
    assert.equal(placement.space_id, to.project_id, id);
    assert.equal(placement.parent_id, parent, id);
    if (id !== a) assert.equal(placement.position, positionsBefore[id], "sub-pages keep their order");
  }
  const storage = w.catalogStorage();
  assert.equal((await storage.get(`trash/${d}`)).space_id, to.project_id, "Trash entry follows");
  assert.equal((await storage.get(`page/${c}`)).space_id, to.project_id);
  assert.deepEqual(
    [...(await storage.list({ prefix: "host/move/pending/" })).keys()],
    [],
    "no move is left pending",
  );
  assert.deepEqual(
    ids(await w.call("owner", "list_pages", { project_id: to.project_id })),
    [to.home_page_id, target, a, b, c].sort(),
  );
  assert.deepEqual(ids(await w.call("owner", "list_pages", { project_id: from.project_id })), [
    from.home_page_id,
  ]);
  const deep = await w.call("owner", "read_page", { page_id: c, include_content: false });
  assert.deepEqual(deep.body.breadcrumbs, [
    { kind: "project", project_id: to.project_id, title: "To" },
    { kind: "page", page_id: target, title: "Target" },
    { kind: "page", page_id: a, title: "A" },
    { kind: "page", page_id: b, title: "B" },
  ]);

  // The trashed sub-page restores under its parent, in the new Project.
  const restored = await w.call("owner", "restore_page", { page_id: d, idempotency_key: w.key() });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.project_id, to.project_id);
  assert.equal(restored.body.parent_id, b);

  // Within one Project only the root changes.
  const epochs = Object.fromEntries(
    [b, c, d].map((id) => [id, w.page(id).metadata.placement.placement_epoch]),
  );
  const within = await move({ page_id: a, project_id: to.project_id });
  assert.equal(within.status, 200);
  assert.equal(within.body.parent_id, null);
  for (const id of [b, c, d])
    assert.equal(w.page(id).metadata.placement.placement_epoch, epochs[id], id);
});

test("position orders a moved Page among its new siblings", async (t) => {
  const w = await world(t);
  const move = mover(w);
  const project = await w.createProject("Order");
  const parent = (await w.createPage({ title: "P", project_id: project.project_id })).body.page_id;
  const one = (await w.createPage({ title: "1", parent_id: parent })).body.page_id;
  const two = (await w.createPage({ title: "2", parent_id: parent })).body.page_id;
  const loose = (await w.createPage({ title: "L" })).body.page_id;
  const order = async () =>
    (await w.call("owner", "list_pages", { parent_id: parent })).body.pages
      .sort((a, b) => (a.position < b.position ? -1 : 1))
      .map((page) => page.page_id);

  assert.equal((await move({ page_id: loose, parent_id: parent, position: "first" })).status, 200);
  assert.deepEqual(await order(), [loose, one, two]);
  assert.equal(
    (await move({ page_id: loose, parent_id: parent, position: { after: one } })).status,
    200,
  );
  assert.deepEqual(await order(), [one, loose, two]);
  assert.equal(
    (await move({ page_id: loose, parent_id: parent, position: { before: one } })).status,
    200,
  );
  assert.deepEqual(await order(), [loose, one, two]);
  assert.equal((await move({ page_id: loose, parent_id: parent })).status, 200);
  assert.deepEqual(await order(), [one, two, loose], "last is the default");

  const unknown = await move({ page_id: loose, parent_id: parent, position: { before: parent } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, "position_sibling_unknown");
  for (const position of ["middle", { before: one, after: two }, { before: "nope" }, 3]) {
    const invalid = await move({ page_id: loose, parent_id: parent, position });
    assert.equal(invalid.status, 400, JSON.stringify(position));
    assert.equal(invalid.body.code, "invalid_position");
  }
  const self = await move({ page_id: one, parent_id: parent, position: { after: one } });
  assert.equal(self.body.code, "invalid_position");
});

test("move_page refuses what it can't move, before changing anything", async (t) => {
  const w = await world(t);
  const move = mover(w);
  const project = await w.createProject("Rules");
  const other = await w.createProject("Other");
  const a = (await w.createPage({ title: "A", project_id: project.project_id })).body.page_id;
  const b = (await w.createPage({ title: "B", parent_id: a })).body.page_id;
  const c = (await w.createPage({ title: "C", parent_id: b })).body.page_id;
  const elsewhere = (await w.createPage({ title: "E", project_id: other.project_id })).body.page_id;
  const doomed = (await w.createPage({ title: "Trash me" })).body.page_id;
  await w.call("owner", "delete_page", {
    page_id: doomed,
    base_heads: w.heads(doomed),
    idempotency_key: w.key(),
  });
  const epochs = () =>
    [a, b, c, elsewhere, project.home_page_id].map(
      (id) => w.page(id).metadata.placement.placement_epoch,
    );
  const before = epochs();
  const cases = [
    [{ page_id: project.home_page_id, project_id: other.project_id }, 409, "home_page_protected"],
    [{ page_id: a, parent_id: a }, 409, "placement_cycle"],
    [{ page_id: a, parent_id: c }, 409, "placement_cycle"],
    [{ page_id: b, project_id: project.project_id, parent_id: elsewhere }, 400, "placement_mismatch"],
    [{ page_id: doomed, project_id: project.project_id }, 409, "page_trashed"],
    [{ page_id: a, project_id: `prj_${crypto.randomUUID()}` }, 404, "project_not_found"],
    [{ page_id: crypto.randomUUID(), project_id: null }, 404, undefined],
    [{ page_id: a }, 400, "move_destination_required"],
    [{ page_id: a, parent_id: null }, 400, "move_destination_required"],
    [{ page_id: a, project_id: a }, 400, "page_id_as_project_id"],
    [{ page_id: a, parent_id: project.project_id }, 400, "project_id_as_page_id"],
    [{ page_id: a, project_id: null, placement: { space_id: null } }, 400, undefined],
  ];
  for (const [args, status, code] of cases) {
    const result = await move(args);
    assert.equal(result.status, status, `${JSON.stringify(args)} ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, code, JSON.stringify(args));
  }
  const parentTrash = await move({ page_id: c, parent_id: doomed });
  assert.equal(parentTrash.status, 409);
  assert.equal(parentTrash.body.code, "parent_unavailable");
  assert.deepEqual(epochs(), before, "no refusal changed a placement");
  const storage = w.catalogStorage();
  assert.deepEqual([...(await storage.list({ prefix: "host/move/" })).keys()], []);

  // Depth: B's subtree is two levels, so it fits only where its leaf stays
  // at or above MAX_DEPTH.
  let parent = elsewhere;
  const chain = [];
  for (let depth = 2; depth <= MAX_DEPTH - 1; depth++) {
    parent = (await w.createPage({ title: `D${depth}`, parent_id: parent })).body.page_id;
    chain.push(parent);
  }
  const tooDeep = await move({ page_id: b, parent_id: chain.at(-1) });
  assert.equal(tooDeep.status, 400);
  assert.equal(tooDeep.body.code, "nesting_depth_exceeded");
  const fits = await move({ page_id: b, parent_id: chain.at(-2) });
  assert.equal(fits.status, 200, JSON.stringify(fits.body));
  assert.equal(w.page(c).metadata.placement.space_id, other.project_id);
});

test("only the Page's owner moves it, and only into a Project they own", async (t) => {
  const w = await world(t);
  const move = mover(w);
  const project = await w.createProject("Owned");
  const page = (await w.createPage({ title: "Shared" })).body.page_id;
  // Give the member a direct editor grant and a Catalog entry for it.
  const host = w.page(page);
  const ownerIdentity = { principal: w.owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  const acl = proposeAccessUpdate(host.metadata, ownerIdentity, {
    principal: w.member,
    role: "editor",
    expected_revision: 0,
  }).acl;
  host.metadata = { ...host.metadata, acl };
  await host.ctx.storage.put("host/document", host.metadata);
  await w.catalogStorage(w.member).put(`shared/${page}`, {
    page_id: page,
    title: "Shared",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    shared: true,
  });
  const memberProject = (
    await w.call("member", "create_project", { title: "Mine", idempotency_key: w.key() })
  ).body;
  const byMember = await move(
    { page_id: page, project_id: memberProject.project_id },
    w.key(),
    "member",
  );
  assert.equal(byMember.status, 403);
  assert.equal(byMember.body.code, "not_page_owner");
  const intoForeign = await move({ page_id: page, project_id: memberProject.project_id });
  assert.equal(intoForeign.status, 404);
  assert.equal(intoForeign.body.code, "project_not_found");
  const readOnly = await move({ page_id: page, project_id: project.project_id }, w.key(), "reader");
  assert.equal(readOnly.status, 403);
  assert.equal(host.metadata.placement, undefined, "nothing moved");

  // The Page itself refuses a non-owner even if a Catalog asked.
  const direct = await w.env.PAGES.getByName(page).fetch(
    new Request("https://pages.invalid/internal/place", {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey({ userId: "member-user" })}` },
      body: JSON.stringify({
        page_id: page,
        idempotency_key: "forged-move-1",
        expected_epoch: 0,
        placement: { space_id: null, parent_id: null, position: "a0" },
        root: true,
      }),
    }),
  );
  assert.equal(direct.status, 403);
  assert.equal(direct.headers.get("x-pages-placement-rejected"), "before-change");
});

test("a retry replays the same receipt; a changed payload under the same key conflicts", async (t) => {
  const w = await world(t);
  const move = mover(w);
  const project = await w.createProject("Retry");
  const page = (await w.createPage({ title: "Retry me" })).body.page_id;
  const args = { page_id: page, project_id: project.project_id };
  const first = await move(args, "move-retry-key");
  assert.equal(first.status, 200);
  const again = await move(args, "move-retry-key");
  assert.deepEqual(again.body, first.body);
  assert.equal(w.page(page).metadata.placement.placement_epoch, 1, "applied once");
  const changed = await move({ ...args, project_id: null }, "move-retry-key");
  assert.equal(changed.status, 409);
  assert.equal(w.page(page).metadata.placement.space_id, project.project_id);
});

test("a lost Page reply mid-move resumes on retry and replays each applied step", async (t) => {
  const w = await world(t);
  const move = mover(w);
  const to = await w.createProject("To");
  const root = (await w.createPage({ title: "Root" })).body.page_id;
  const child = (await w.createPage({ title: "Child", parent_id: root })).body.page_id;
  const grandchild = (await w.createPage({ title: "Grandchild", parent_id: child })).body.page_id;
  const storage = w.catalogStorage();
  const args = { page_id: root, project_id: to.project_id };

  // The root applies, then the child applies but its reply is lost.
  w.faults.set(child, "lost");
  const first = await move(args, "move-crash-key");
  assert.equal(first.status, 500);
  const intent = await storage.get("host/operation/move-crash-key");
  assert.equal(intent.pending, true);
  assert.deepEqual(intent.move, { name: "placing", cursor: 1, total: 3 });
  assert.ok(await storage.get("host/move/pending/move-crash-key"));
  assert.equal(w.page(child).metadata.placement.space_id, to.project_id, "the child applied");
  assert.equal(w.page(grandchild).metadata.placement.space_id, null, "the grandchild did not");
  assert.equal((await storage.get(`page/${root}`)).space_id, to.project_id, "root projected");

  // Another move waits for this one: the Catalog finishes it first.
  w.faults.set(grandchild, "before");
  const blocked = await move({ page_id: root, project_id: null });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "move_unsettled");
  const create = await w.createPage({ title: "Under child", parent_id: child });
  assert.equal(create.status, 200, "a create finishes the pending move first");
  assert.equal(create.body.project_id, to.project_id, "and lands in the moved Project");
  assert.equal(w.page(grandchild).metadata.placement.space_id, to.project_id);
  assert.equal(w.page(child).metadata.placement.placement_epoch, 1, "the replay applied once");
  assert.equal(await storage.get("host/move/pending/move-crash-key"), undefined);

  const retry = await move(args, "move-crash-key");
  assert.equal(retry.status, 200);
  assert.equal(retry.body.descendants, 2);
  assert.equal(retry.body.project_id, to.project_id);
  assert.deepEqual(await move(args, "move-crash-key"), retry);
});

test("a root that refuses releases the move; a lost root reply replays on retry", async (t) => {
  const w = await world(t);
  const move = mover(w);
  const to = await w.createProject("To");
  const page = (await w.createPage({ title: "Page" })).body.page_id;
  const storage = w.catalogStorage();

  // The Catalog's entry is stale: the Page is in Trash but the Catalog
  // didn't hear. The Page refuses before changing, and the move is released.
  const host = w.page(page);
  host.metadata = { ...host.metadata, deleted: true, trash: { trashed_at: "x", root_page_id: page } };
  const refused = await move({ page_id: page, project_id: to.project_id }, "move-refused-key");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "page_trashed");
  assert.equal(await storage.get("host/operation/move-refused-key"), undefined);
  assert.equal(await storage.get("host/move/pending/move-refused-key"), undefined);
  const { deleted: _deleted, trash: _trash, ...active } = host.metadata;
  host.metadata = active;

  w.faults.set(page, "lost");
  const lost = await move({ page_id: page, project_id: to.project_id }, "move-lost-key");
  assert.equal(lost.status, 500);
  assert.equal(host.metadata.placement.placement_epoch, 1);
  const retry = await move({ page_id: page, project_id: to.project_id }, "move-lost-key");
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(host.metadata.placement.placement_epoch, 1, "the Page replayed, not reapplied");
  assert.equal(host.metadata.placementMove.key, "host/operation/move-lost-key");

  // A Page whose epoch moved past the plan answers superseded.
  const stale = await w.env.PAGES.getByName(page).fetch(
    new Request("https://pages.invalid/internal/place", {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey()}` },
      body: JSON.stringify({
        page_id: page,
        idempotency_key: "stale-move-key",
        expected_epoch: 0,
        placement: { space_id: null, parent_id: null, position: "a0" },
        root: true,
      }),
    }),
  );
  const body = await stale.json();
  assert.equal(body.applied, false);
  assert.equal(body.superseded, true);
  assert.equal(body.current.placement_epoch, 1);
});

test("the catalog index follows a move and never regresses to an older placement", async (t) => {
  const w = await world(t);
  const move = mover(w);
  const project = await w.createProject("Indexed");
  const page = (await w.createPage({ title: "Indexed page" })).body.page_id;
  const child = (await w.createPage({ title: "Indexed child", parent_id: page })).body.page_id;
  // Listing reconciles the index once so the rows exist before the move.
  await w.call("owner", "list_pages");
  const row = async (id) => ({
    ...(await w.db
      .prepare(
        "SELECT space_id, parent_id, placement_epoch FROM pages_catalog_pages WHERE page_id = ?",
      )
      .bind(id)
      .first()),
  });
  assert.equal((await row(page)).space_id, null);

  assert.equal((await move({ page_id: page, project_id: project.project_id })).status, 200);
  const listed = await w.call("owner", "list_pages", { project_id: project.project_id });
  assert.deepEqual(ids(listed), [project.home_page_id, page, child].sort());
  assert.deepEqual(await row(page), {
    space_id: project.project_id,
    parent_id: null,
    placement_epoch: 1,
  });
  assert.deepEqual(await row(child), {
    space_id: project.project_id,
    parent_id: page,
    placement_epoch: 1,
  });

  // A late report from before the move leaves the newer placement alone.
  const { placement: _placement, ...before } = w.page(page).metadata;
  await reportPageIndex(w.env, testCtx, {
    metadata: before,
    title: "Indexed page",
    observedAt: new Date().toISOString(),
  });
  assert.deepEqual(await row(page), {
    space_id: project.project_id,
    parent_id: null,
    placement_epoch: 1,
  });
  // A stale row can only hide a Page: the owner's entry decides the listing.
  await w.db
    .prepare("UPDATE pages_catalog_pages SET space_id = NULL WHERE page_id = ?")
    .bind(child)
    .run();
  const moveOut = await move({ page_id: page, project_id: null });
  assert.equal(moveOut.status, 200);
  const listing = await w.call("owner", "list_pages", { project_id: project.project_id });
  assert.deepEqual(ids(listing), [project.home_page_id]);
  assert.deepEqual(await row(child), { space_id: null, parent_id: page, placement_epoch: 2 });

  // With the index off, the Catalog entries answer the same listings.
  delete w.env.PAGES_CATALOG_INDEX;
  assert.deepEqual(ids(await w.call("owner", "list_pages", { parent_id: page })), [child]);
});

test("move_page is an MCP tool with a clear description", async (t) => {
  const descriptor = tools.find((tool) => tool.name === "move_page");
  assert.ok(descriptor);
  assert.deepEqual(descriptor.inputSchema.required, ["page_id", "idempotency_key"]);
  for (const name of ["project_id", "parent_id", "position", "retry_token"])
    assert.ok(descriptor.inputSchema.properties[name], name);
  assert.match(descriptor.description, /sub-pages/);
  assert.match(descriptor.description, /home Page/);
  assert.ok(descriptor.description.length < 900);

  const w = await world(t);
  const project = await w.createProject("Agents");
  const page = (await w.createPage({ title: "Agent page" })).body.page_id;
  const moved = await w.mcp("owner", "move_page", {
    page_id: page,
    project_id: project.project_id,
    idempotency_key: w.key(),
  });
  assert.equal(moved.isError, false, JSON.stringify(moved.body));
  assert.equal(moved.body.project_id, project.project_id);
  assert.equal(moved.body.url, `https://pages.invalid/p/${page}`);
  assert.equal(pageState(w.page(page).metadata), "active");
});
