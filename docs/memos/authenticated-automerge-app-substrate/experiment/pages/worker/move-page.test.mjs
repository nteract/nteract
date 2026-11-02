// move_page: the move-page machine's table, and the Catalog interpreter over
// real Catalog, Project and Page hosts (projects-fixture.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import {
  MAX_DEPTH,
  REBALANCE_KEY_LENGTH,
  checkInvariants,
  deriveLocation,
  planMove,
  siblingsOf,
} from "../model/location.mjs";
import { Catalog } from "./index.mjs";
import { locationEntries } from "./catalog-location.mjs";
import { projectLifecycle } from "./catalog.mjs";
import { STORAGE_KEYS_PER_CALL } from "./actor-authorship.mjs";
import { LOCATION_REVISION_KEY, MOVE_STATUS, movePage, movePageSpec } from "./move-page.mjs";
import { CrashStorage } from "./operation-intent-fixture.mjs";
import { Storage, ids, shapeOf, unmigrate, world } from "./projects-fixture.mjs";
import { tools } from "../mcp.mjs";

const TABLE = new URL("../test/fixtures/machines/move-page.json", import.meta.url);

test("move-page: the table covers every state and event, and the machine agrees", async () => {
  const table = loadTable(TABLE);
  const run = await runTable(movePage, table);
  assert.equal(
    run.pairs + run.unreachable,
    movePageSpec.states.length * movePageSpec.events.length,
  );
  assert.equal(run.rows, 10);
  // Every code a plan or the interpreter can end with has a status.
  for (const code of Object.keys(MOVE_STATUS)) assert.ok(MOVE_STATUS[code] >= 400, code);
});

test("the move_page tool declares its keys, positions and refusals", () => {
  const tool = tools.find((entry) => entry.name === "move_page");
  assert.deepEqual(tool.inputSchema.required, [
    "page_id",
    "parent_id",
    "idempotency_key",
    "retry_token",
  ]);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [
    "idempotency_key",
    "page_id",
    "parent_id",
    "position",
    "retry_token",
  ]);
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  for (const word of [
    "home_page_protected",
    "page_trashed",
    "parent_unavailable",
    "placement_cycle",
    "move_destination_required",
    "nesting_depth_exceeded",
    "position_sibling_unknown",
    "heads",
    "trashed_descendants",
  ])
    assert.match(tool.description, new RegExp(word), word);
});

/** Storage whose writes become durable only at sync. A sync the test fails
 * throws and drops every write since the last sync, as a Durable Object that
 * loses its output gate does. */
class VolatileStorage extends Storage {
  pending = [];
  failNext = null;
  async put(key, value) {
    const entries = typeof key === "object" ? key : { [key]: value };
    for (const name of Object.keys(entries))
      this.pending.push([name, structuredClone(this.values.get(name))]);
    return super.put(key, value);
  }
  async delete(key) {
    this.pending.push([key, structuredClone(this.values.get(key))]);
    return super.delete(key);
  }
  async sync() {
    const fail = this.failNext;
    if (fail && this.pending.some(([name]) => fail(name))) {
      this.failNext = null;
      for (const [name, before] of this.pending.reverse())
        if (before === undefined) this.values.delete(name);
        else this.values.set(name, before);
      this.pending = [];
      throw new Error("injected barrier failure");
    }
    this.pending = [];
  }
}

/** A Project with a home Page and the authority to move its Pages. */
async function stage(w, title = "Moves") {
  const project = await w.createProject(title);
  const page = async (args) => {
    const created = await w.createPage(args);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    return created.body.page_id;
  };
  const authority = (await w.call("owner", "list_pages")).body;
  const moveArgs = (pageId, parentId, position, extra = {}) => ({
    page_id: pageId,
    parent_id: parentId,
    ...(position !== undefined && { position }),
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
    ...extra,
  });
  const move = (pageId, parentId, position, extra) =>
    w.call("owner", "move_page", moveArgs(pageId, parentId, position, extra));
  const entries = () => locationEntries(w.catalogStorage());
  const invariants = async () =>
    assert.deepEqual(checkInvariants({ revision: 0, entries: await entries() }), []);
  const trash = async (pageId) => {
    const trashed = await w.call("owner", "delete_page", {
      page_id: pageId,
      base_heads: w.heads(pageId),
      idempotency_key: w.key(),
    });
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
    return trashed;
  };
  return {
    project,
    home: project.home_page_id,
    page,
    authority,
    moveArgs,
    move,
    entries,
    invariants,
    trash,
  };
}

/** The effects the Catalog ran for each move_page request, in order. */
function traceEffects(t) {
  const traces = [];
  const original = Catalog.prototype.runMoveEffect;
  t.mock.method(Catalog.prototype, "runMoveEffect", function (run, effect) {
    if (!run.trace) traces.push((run.trace = []));
    run.trace.push(effect.type);
    return original.call(this, run, effect);
  });
  return traces;
}

test("move_page reparents a Page with its subtree, reorders siblings, and changes no Page heads", async (t) => {
  const w = await world(t);
  const s = await stage(w);
  const traces = traceEffects(t);
  const a = await s.page({ title: "A", project_id: s.project.project_id });
  const b = await s.page({ title: "B", project_id: s.project.project_id });
  const c = await s.page({ title: "C", parent_id: a });
  const d = await s.page({ title: "D", parent_id: c });
  const trashedUnderC = await s.page({ title: "Gone", parent_id: c });
  await s.trash(trashedUnderC);
  const headsBefore = Object.fromEntries([a, b, c, d].map((id) => [id, w.heads(id)]));
  const storage = w.catalogStorage();
  assert.equal(await storage.get(LOCATION_REVISION_KEY), undefined, "no move yet");

  // A under B: C, D and the trashed Page follow.
  const moved = await s.move(a, b);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body, {
    page_id: a,
    project_id: s.project.project_id,
    parent_id: b,
    position: moved.body.position,
    location_revision: 1,
    descendants: 2,
    trashed_descendants: 1,
  });
  assert.deepEqual(traces.at(-1), ["settle", "plan", "write", "sync"]);
  assert.equal(await storage.get(LOCATION_REVISION_KEY), 1);
  let entries = await s.entries();
  assert.equal(entries.get(a).parent_id, b);
  assert.equal(entries.get(a).position, moved.body.position);
  assert.equal(entries.get(c).parent_id, a, "descendants keep their parent");
  assert.equal(entries.get(trashedUnderC).parent_id, c);
  assert.equal(deriveLocation(entries, d).space_id, s.project.project_id);
  await s.invariants();
  for (const id of [a, b, c, d]) assert.deepEqual(w.heads(id), headsBefore[id], "heads unchanged");
  assert.equal(w.page(a).metadata.placement, undefined, "the Page records no location");
  const children = await w.call("owner", "list_pages", { parent_id: b });
  assert.deepEqual(ids(children), [a]);
  assert.equal(children.body.pages[0].parent_id, b);
  assert.equal(children.body.pages[0].position, moved.body.position);
  const read = await w.call("owner", "read_page", { page_id: d, include_content: false });
  assert.deepEqual(
    read.body.breadcrumbs.map((crumb) => crumb.page_id ?? crumb.project_id),
    [s.project.project_id, s.home, b, a, c],
  );

  // Back to the top level by naming the home Page, first among its siblings.
  const top = await s.move(a, s.home, "first");
  assert.equal(top.status, 200, JSON.stringify(top.body));
  assert.equal(top.body.parent_id, s.home);
  assert.equal(top.body.location_revision, 2);
  entries = await s.entries();
  assert.deepEqual(
    siblingsOf(entries, s.home).map((entry) => entry.page_id),
    [a, b],
  );
  const topLevel = await w.call("owner", "list_pages", {
    project_id: s.project.project_id,
    parent_id: null,
  });
  assert.deepEqual(ids(topLevel), [s.home, a, b].sort());

  // Reorder: after B, then before B.
  const after = await s.move(a, s.home, { after: b });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.deepEqual(
    siblingsOf(await s.entries(), s.home).map((entry) => entry.page_id),
    [b, a],
  );
  const before = await s.move(a, s.home, { before: b });
  assert.equal(before.status, 200);
  assert.deepEqual(
    siblingsOf(await s.entries(), s.home).map((entry) => entry.page_id),
    [a, b],
  );
  assert.equal(before.body.location_revision, 4);
  await s.invariants();
  // The index reconciles from the entries: every move marks it dirty.
  assert.ok(await storage.get("host/index/dirty"));
  // Pages in Your items move among themselves too.
  const loose = await s.page({ title: "Loose" });
  const otherLoose = await s.page({ title: "Other loose" });
  const nested = await s.move(loose, otherLoose);
  assert.equal(nested.status, 200, JSON.stringify(nested.body));
  assert.equal(nested.body.project_id, null);
  assert.equal((await s.entries()).get(loose).parent_id, otherLoose);
});

test("move_page over MCP returns the receipt with its URL as structured content", async (t) => {
  const w = await world(t);
  const s = await stage(w);
  const a = await s.page({ title: "A", project_id: s.project.project_id });
  const b = await s.page({ title: "B", project_id: s.project.project_id });
  const result = await w.mcp("owner", "move_page", s.moveArgs(a, b, "first"));
  assert.equal(result.isError, false, JSON.stringify(result.body));
  assert.deepEqual(result.structured, result.body);
  assert.equal(result.body.page_id, a);
  assert.equal(result.body.parent_id, b);
  assert.equal(result.body.project_id, s.project.project_id);
  assert.equal(result.body.url, `https://pages.invalid/p/${a}`);
  assert.equal(result.body.space_id, undefined, "the API speaks Projects");
});

test("each refusal carries its code and status, over HTTP and as MCP structured content", async (t) => {
  const w = await world(t);
  const s = await stage(w);
  const traces = traceEffects(t);
  const a = await s.page({ title: "A", project_id: s.project.project_id });
  const b = await s.page({ title: "B", parent_id: a });
  const c = await s.page({ title: "C", parent_id: b });
  const loose = await s.page({ title: "Loose" });
  const other = await w.createProject("Other");
  const trashed = await s.page({ title: "Trashed", project_id: s.project.project_id });
  await s.trash(trashed);
  const sharedId = crypto.randomUUID();
  await w.catalogStorage().put(`shared/${sharedId}`, {
    page_id: sharedId,
    title: "Theirs",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    shared: true,
  });
  const shallow = await s.page({ title: "Shallow", project_id: s.project.project_id });
  let deepest = c;
  for (let depth = 5; depth <= MAX_DEPTH; depth++)
    deepest = await s.page({ title: `Depth ${depth}`, parent_id: deepest });
  const before = await s.entries();
  const revision = await w.catalogStorage().get(LOCATION_REVISION_KEY);

  const cases = [
    ["page_not_found", 404, s.moveArgs(crypto.randomUUID(), a)],
    ["page_trashed", 409, s.moveArgs(trashed, a)],
    ["not_page_owner", 403, s.moveArgs(sharedId, a)],
    ["home_page_protected", 409, s.moveArgs(s.home, a)],
    ["parent_unavailable", 409, s.moveArgs(loose, crypto.randomUUID())],
    ["parent_unavailable", 409, s.moveArgs(a, trashed)],
    ["placement_cycle", 409, s.moveArgs(a, c)],
    ["placement_cycle", 409, s.moveArgs(a, a)],
    // A, at depth 2, holds a chain down to MAX_DEPTH; one level lower is too
    // deep for its deepest sub-page.
    ["nesting_depth_exceeded", 400, s.moveArgs(a, shallow)],
    ["move_destination_required", 400, s.moveArgs(loose, b)],
    ["move_destination_required", 400, s.moveArgs(a, other.home_page_id)],
    ["move_destination_required", 400, { ...s.moveArgs(a, s.home), project_id: other.project_id }],
    ["move_destination_required", 400, { ...s.moveArgs(a, s.home), parent_id: undefined }],
    ["move_destination_required", 400, { ...s.moveArgs(a, s.home), parent_id: null }],
    ["project_id_as_page_id", 400, s.moveArgs(a, s.project.project_id)],
    ["invalid_position", 400, s.moveArgs(a, s.home, "middle")],
    ["invalid_position", 400, s.moveArgs(a, s.home, { before: a, after: a })],
    ["invalid_position", 400, s.moveArgs(a, s.home, { before: a })],
    ["position_sibling_unknown", 400, s.moveArgs(a, s.home, { after: c })],
    ["position_sibling_unknown", 400, s.moveArgs(a, s.home, { before: trashed })],
    ["invalid_retry_token", 400, { ...s.moveArgs(a, s.home), retry_token: undefined }],
  ];
  for (const [code, status, args] of cases) {
    const label = `${code}: ${JSON.stringify(args)}`;
    if (Object.hasOwn(MOVE_STATUS, code)) assert.equal(MOVE_STATUS[code], status, label);
    const http = await w.call("owner", "move_page", args);
    assert.equal(http.status, status, `${label} → ${JSON.stringify(http.body)}`);
    assert.equal(http.body.code, code, label);
    assert.equal(typeof http.body.error, "string", label);
    const mcp = await w.mcp("owner", "move_page", args);
    assert.equal(mcp.isError, true, label);
    assert.equal(mcp.structured.code, code, label);
    assert.equal(mcp.structured.error, http.body.error, label);
    assert.deepEqual(mcp.body, mcp.structured, label);
  }
  // Nothing moved, no revision was spent, and no refusal reached the write.
  assert.deepEqual(await s.entries(), before);
  assert.equal(await w.catalogStorage().get(LOCATION_REVISION_KEY), revision);
  for (const trace of traces) assert.ok(!trace.includes("write"), trace.join(","));
  await s.invariants();
  // Input refusals consume no key: the same key then moves.
  const key = s.authority.retry_key_prefix + crypto.randomUUID();
  const refused = await s.move(a, s.home, "middle", { idempotency_key: key });
  assert.equal(refused.body.code, "invalid_position");
  const applied = await s.move(a, s.home, "first", { idempotency_key: key });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  // A plan refusal consumes none either.
  const cycleKey = s.authority.retry_key_prefix + crypto.randomUUID();
  assert.equal(
    (await s.move(a, c, undefined, { idempotency_key: cycleKey })).body.code,
    "placement_cycle",
  );
  assert.equal((await s.move(b, s.home, "last", { idempotency_key: cycleKey })).status, 200);
});

test("a retry replays the receipt; a key reused for another move is a conflict", async (t) => {
  const w = await world(t);
  const s = await stage(w);
  const traces = traceEffects(t);
  const a = await s.page({ title: "A", project_id: s.project.project_id });
  const b = await s.page({ title: "B", project_id: s.project.project_id });
  const args = s.moveArgs(a, b, "last");
  const first = await w.call("owner", "move_page", args);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // Something else moves meanwhile; the replay still answers the first move.
  assert.equal((await s.move(b, s.home, "first")).status, 200);
  const replay = await w.call("owner", "move_page", args);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.deepEqual(traces.at(-1), ["sync"], "a replay runs the barrier alone");
  assert.equal(await w.catalogStorage().get(LOCATION_REVISION_KEY), 2);
  const conflict = await w.call("owner", "move_page", { ...args, position: "first" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "idempotency_conflict");
  const tokenless = await w.call("owner", "move_page", { ...args, retry_token: undefined });
  assert.equal(tokenless.status, 400);
  assert.equal(tokenless.body.code, "invalid_retry_token");
  // The fingerprint covers the caller's driver label, as every write's does:
  // the MCP client's own key replays over MCP.
  const viaMcp = s.moveArgs(b, s.home, "last");
  const mcpFirst = await w.mcp("owner", "move_page", viaMcp);
  assert.equal(mcpFirst.isError, false, JSON.stringify(mcpFirst.body));
  const mcpReplay = await w.mcp("owner", "move_page", viaMcp);
  assert.equal(mcpReplay.isError, false, JSON.stringify(mcpReplay.body));
  assert.deepEqual(mcpReplay.structured, mcpFirst.structured);
  assert.deepEqual(traces.at(-1), ["sync"]);
});

test("a failed barrier is 503; the retry plans again over what is stored and reports where it landed", async (t) => {
  const storages = new Map();
  const w = await world(t, {
    storage: (principal) => {
      storages.set(principal, new VolatileStorage());
      return storages.get(principal);
    },
  });
  const s = await stage(w);
  const traces = traceEffects(t);
  const a = await s.page({ title: "A", project_id: s.project.project_id });
  const b = await s.page({ title: "B", project_id: s.project.project_id });
  const c = await s.page({ title: "C", project_id: s.project.project_id });
  const storage = storages.get(w.owner);
  const args = s.moveArgs(a, s.home, { after: c });
  // The barrier after the move's put fails, and the put is lost with it.
  storage.failNext = (key) => key === LOCATION_REVISION_KEY;
  const failed = await w.call("owner", "move_page", args);
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.deepEqual(failed.body.code, "move_unconfirmed");
  assert.equal(failed.body.retryable, true);
  assert.deepEqual(traces.at(-1), ["settle", "plan", "write", "sync"]);
  assert.equal(await storage.get(LOCATION_REVISION_KEY), undefined, "nothing durable");
  assert.equal(await storage.get(`host/operation/${args.idempotency_key}`), undefined);
  assert.deepEqual(
    siblingsOf(await s.entries(), s.home).map((entry) => entry.page_id),
    [a, b, c],
  );
  // B moves first, so the retry plans against a different sibling set.
  assert.equal((await s.move(b, s.home, "first")).status, 200);
  const retried = await w.call("owner", "move_page", args);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.deepEqual(traces.at(-1), ["settle", "plan", "write", "sync"], "re-planned, not replayed");
  const entries = await s.entries();
  assert.deepEqual(
    siblingsOf(entries, s.home).map((entry) => entry.page_id),
    [b, c, a],
  );
  assert.equal(retried.body.position, entries.get(a).position, "the position it landed on");
  assert.equal(retried.body.location_revision, 2);
  assert.equal(await storage.get(LOCATION_REVISION_KEY), 2);
  await s.invariants();
  // Now durable: the next retry replays.
  const replay = await w.call("owner", "move_page", args);
  assert.deepEqual(replay.body, retried.body);
  assert.deepEqual(traces.at(-1), ["sync"]);

  // A barrier that fails after a durable put: the retry replays the stored
  // receipt once the barrier holds.
  const again = s.moveArgs(c, s.home, "first");
  const sync = storage.sync.bind(storage);
  let fail = true;
  storage.sync = async () => {
    if (fail && storage.pending.some(([key]) => key === LOCATION_REVISION_KEY)) {
      fail = false;
      storage.pending = [];
      throw new Error("barrier failed after the put was durable");
    }
    return sync();
  };
  const unconfirmed = await w.call("owner", "move_page", again);
  assert.equal(unconfirmed.status, 503);
  assert.equal(await storage.get(LOCATION_REVISION_KEY), 3, "the put held");
  const confirmed = await w.call("owner", "move_page", again);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(traces.at(-1), ["sync"]);
  assert.equal(confirmed.body.location_revision, 3);
  assert.deepEqual(
    siblingsOf(await s.entries(), s.home).map((entry) => entry.page_id),
    [c, b, a],
  );
});

/** Make the next lifecycle request to a Page fail before it arrives, or
 * apply but lose its response. */
const interrupt = (w, pageId, variant) => w.faults.set(pageId, variant);

test("a parent leaving for Trash is unavailable, and a Page's own reservation settles first", async (t) => {
  const w = await world(t);
  const s = await stage(w);
  const traces = traceEffects(t);
  const parent = await s.page({ title: "Parent", project_id: s.project.project_id });
  const child = await s.page({ title: "Child", project_id: s.project.project_id });
  const storage = w.catalogStorage();
  // The parent's Trash never reached its Page: its reservation stands,
  // unapplied. The location entries skip reservations, so the model alone
  // would place the child under it.
  interrupt(w, parent, "before");
  const lost = await w.call("owner", "delete_page", {
    page_id: parent,
    base_heads: w.heads(parent),
    idempotency_key: "parent-trash-lost",
  });
  assert.ok(lost.status >= 500);
  assert.equal((await storage.get(`trash/${parent}`)).reservation, "delete_page");
  const entries = await s.entries();
  assert.equal(planMove({ revision: 0, entries }, child, { parent_id: parent }).ok, true);
  const refused = await s.move(child, parent);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "parent_unavailable");
  assert.deepEqual(traces.at(-1), ["settle", "plan"]);
  assert.equal((await s.entries()).get(child).parent_id, s.home);
  // The Page can't answer: the settle is out of budget and refuses as retryable.
  interrupt(w, parent, "before");
  const unsettled = await s.move(child, parent);
  assert.equal(unsettled.status, 409);
  assert.equal(unsettled.body.code, "lifecycle_unsettled");
  assert.deepEqual(traces.at(-1), ["settle"]);
  // Once the Trash applies, the parent is in Trash: still unavailable.
  const finished = await w.call("owner", "delete_page", {
    page_id: parent,
    base_heads: w.heads(parent),
    idempotency_key: "parent-trash-lost",
  });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.equal((await s.move(child, parent)).body.code, "parent_unavailable");

  // The Page's own Trash applied, but the answer was lost: the settle
  // projects it into Trash before the plan, which then refuses it.
  const mover = await s.page({ title: "Mover", project_id: s.project.project_id });
  const target = await s.page({ title: "Target", project_id: s.project.project_id });
  interrupt(w, mover, "lost");
  const lostTrash = await w.call("owner", "delete_page", {
    page_id: mover,
    base_heads: w.heads(mover),
    idempotency_key: "mover-trash-lost",
  });
  assert.ok(lostTrash.status >= 500);
  assert.equal((await storage.get(`trash/${mover}`)).reservation, "delete_page");
  assert.ok(await storage.get(`page/${mover}`), "the Catalog still lists it");
  const trashedMove = await s.move(mover, target);
  assert.equal(trashedMove.status, 409, JSON.stringify(trashedMove.body));
  assert.equal(trashedMove.body.code, "page_trashed");
  assert.equal((await storage.get(`trash/${mover}`)).reservation, undefined, "settled");
  assert.equal(await storage.get(`page/${mover}`), undefined);
  // An unapplied Trash on the Page leaves it active: it moves, and the
  // Trash, when it applies, records the new parent as its restore hint.
  const second = await s.page({ title: "Second", project_id: s.project.project_id });
  interrupt(w, second, "before");
  const never = await w.call("owner", "delete_page", {
    page_id: second,
    base_heads: w.heads(second),
    idempotency_key: "second-trash-before",
  });
  assert.ok(never.status >= 500);
  const movedAnyway = await s.move(second, target);
  assert.equal(movedAnyway.status, 200, JSON.stringify(movedAnyway.body));
  assert.equal((await storage.get(`page/${second}`)).parent_id, target);
  const applied = await w.call("owner", "delete_page", {
    page_id: second,
    base_heads: w.heads(second),
    idempotency_key: "second-trash-before",
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal((await storage.get(`trash/${second}`)).parent_id, target);
  await s.invariants();
});

test("300 tied siblings: the repair crosses 128 keys and lands in one transaction", async (t) => {
  const mutations = [];
  let catalog;
  const w = await world(t, {
    storage: () => {
      // The first Catalog built is the owner's: every other account's
      // Catalog here is the member's, which this test never writes.
      const storage = new CrashStorage((mutation, target) => {
        if (target === catalog) mutations.push({ ...mutation, depth: target.depth });
      });
      catalog ??= storage;
      return storage;
    },
  });
  const s = await stage(w);
  const parent = await s.page({ title: "Parent", project_id: s.project.project_id });
  const mover = await s.page({ title: "Mover", project_id: s.project.project_id });
  const now = new Date().toISOString();
  const seed = async (parentId, positions) => {
    const siblings = [];
    for (const [index, position] of positions.entries()) {
      const id = crypto.randomUUID();
      siblings.push(id);
      await catalog.put(`page/${id}`, {
        page_id: id,
        title: `Sibling ${index}`,
        created_at: now,
        updated_at: now,
        parent_id: parentId,
        position,
      });
    }
    return siblings;
  };
  // Every sibling holds "a0", as concurrent writers in older data could leave
  // them. The move repairs the whole run: 299 siblings and the moved Page.
  const tied = await seed(
    parent,
    Array.from({ length: 300 }, () => "a0"),
  );
  let from = mutations.length;
  const moved = await s.move(mover, parent, "last");
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const movePuts = mutations
    .slice(from)
    .filter((mutation) => mutation.op === "put" && mutation.depth > 0);
  const keys = movePuts.flatMap((mutation) => Object.keys(mutation.entries));
  assert.ok(keys.length > STORAGE_KEYS_PER_CALL, `${keys.length} keys`);
  assert.ok(movePuts.length >= 3, `${movePuts.length} puts`);
  for (const put of movePuts) assert.ok(Object.keys(put.entries).length <= STORAGE_KEYS_PER_CALL);
  assert.ok(keys.includes(`page/${mover}`));
  assert.ok(keys.includes(LOCATION_REVISION_KEY));
  assert.ok(keys.includes("host/index/dirty"));
  assert.ok(keys.some((key) => key.startsWith("host/operation/v1_")));
  assert.equal(
    keys.filter((key) => key.startsWith("page/")).length,
    300,
    "299 siblings and the mover",
  );
  // One transaction: no sync and no shallow put between the first and last.
  const during = mutations.slice(
    mutations.indexOf(movePuts[0]),
    mutations.indexOf(movePuts.at(-1)) + 1,
  );
  assert.ok(
    during.every((mutation) => mutation.op === "put" && mutation.depth > 0),
    "one transaction",
  );
  let entries = await s.entries();
  const ordered = siblingsOf(entries, parent).map((entry) => entry.page_id);
  assert.equal(ordered.length, 301);
  assert.equal(ordered.at(-1), mover);
  assert.deepEqual(ordered.slice(0, 300), [...tied].sort(), "ties keep (position, page_id) order");
  assert.deepEqual(checkInvariants({ revision: 0, entries }), []);
  assert.equal(entries.get(ordered[0]).position, "a0", "the first holder keeps its key");

  // Long keys: siblings whose keys already run past the rebalance length.
  // Placing before the last one would need a longer key, so every sibling
  // gets a fresh short key instead, in the same order.
  const second = await s.page({ title: "Second parent", project_id: s.project.project_id });
  const long = await seed(
    second,
    Array.from({ length: 300 }, (_, index) => "a0" + "V".repeat(index + 1)),
  );
  from = mutations.length;
  const rebalanced = await s.move(mover, second, { before: long.at(-1) });
  assert.equal(rebalanced.status, 200, JSON.stringify(rebalanced.body));
  const rebalancePuts = mutations
    .slice(from)
    .filter((mutation) => mutation.op === "put" && mutation.depth > 0);
  const rebalanceKeys = rebalancePuts.flatMap((mutation) => Object.keys(mutation.entries));
  assert.equal(rebalanceKeys.filter((key) => key.startsWith("page/")).length, 301);
  assert.ok(rebalancePuts.length >= 3);
  entries = await s.entries();
  const order = siblingsOf(entries, second).map((entry) => entry.page_id);
  assert.deepEqual(order, [...long.slice(0, -1), mover, long.at(-1)]);
  for (const id of order)
    assert.ok(entries.get(id).position.length <= REBALANCE_KEY_LENGTH, entries.get(id).position);
  assert.deepEqual(checkInvariants({ revision: 0, entries }), []);
  assert.equal(await catalog.get(LOCATION_REVISION_KEY), 2);
});

test("projectLifecycle after a move keeps the new parent: Trash and restore return the Page there", async (t) => {
  const w = await world(t);
  const s = await stage(w);
  const a = await s.page({ title: "A", project_id: s.project.project_id });
  const b = await s.page({ title: "B", project_id: s.project.project_id });
  const c = await s.page({ title: "C", parent_id: a });
  assert.equal((await s.move(c, b)).status, 200);
  const storage = w.catalogStorage();
  // A projection of the Page's current state keeps the entry's location.
  await projectLifecycle(storage, c, { state: "active", revision: 0, title: "C" });
  assert.equal((await storage.get(`page/${c}`)).parent_id, b);
  await s.trash(c);
  const trashed = await storage.get(`trash/${c}`);
  assert.equal(trashed.parent_id, b, "the Trash entry records the new parent");
  assert.equal(trashed.restore_space_id, s.project.project_id);
  const restored = await w.call("owner", "restore_page", { page_id: c, idempotency_key: w.key() });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.parent_id, b);
  assert.equal((await storage.get(`page/${c}`)).parent_id, b);
  assert.deepEqual(ids(await w.call("owner", "list_pages", { parent_id: b })), [c]);
  assert.deepEqual(ids(await w.call("owner", "list_pages", { parent_id: a })), []);
  // A trashed descendant that moved with its parent restores under it.
  const d = await s.page({ title: "D", parent_id: c });
  await s.trash(d);
  const back = await s.move(c, a);
  assert.equal(back.status, 200);
  assert.equal(back.body.trashed_descendants, 1);
  const dBack = await w.call("owner", "restore_page", { page_id: d, idempotency_key: w.key() });
  assert.equal(dBack.status, 200, JSON.stringify(dBack.body));
  assert.equal(dBack.body.parent_id, c);
  assert.equal(deriveLocation(await s.entries(), d).ancestors.at(-1), s.home);
  await s.invariants();
});

test("a Catalog in the older shape migrates on its first move_page, then moves", async (t) => {
  const w = await world(t);
  const s = await stage(w, "Legacy");
  const a = await s.page({ title: "A", project_id: s.project.project_id });
  const b = await s.page({ title: "B", project_id: s.project.project_id });
  const c = await s.page({ title: "C", parent_id: b });
  const storage = w.catalogStorage();
  await unmigrate(storage);
  assert.deepEqual(await shapeOf(storage), { name: "unmigrated" });
  assert.equal((await storage.get(`page/${a}`)).parent_id, null, "a root with space_id");
  const moved = await s.move(c, a, "first");
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(await shapeOf(storage), { name: "migrated" });
  const entries = await s.entries();
  assert.equal(entries.get(a).parent_id, s.home, "the pass ran first");
  assert.equal(entries.get(a).space_id, undefined);
  assert.equal(entries.get(c).parent_id, a);
  assert.equal(moved.body.project_id, s.project.project_id);
  assert.equal(moved.body.location_revision, 1);
  await s.invariants();
  // Moving to the top level names the home Page, in the migrated shape.
  const top = await s.move(c, s.home, "last");
  assert.equal(top.status, 200);
  assert.deepEqual(
    siblingsOf(await s.entries(), s.home).map((entry) => entry.page_id),
    [a, b, c],
  );
});

/** A small deterministic generator, so a failing run can be replayed. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("property: checkInvariants holds after every move in a random run, and refusals change nothing", async (t) => {
  const w = await world(t);
  const s = await stage(w, "Property");
  const next = random(20261101);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const pages = [];
  for (let index = 0; index < 10; index++)
    pages.push(
      await s.page(
        index < 3 || next() < 0.3
          ? { title: `P${index}`, project_id: s.project.project_id }
          : { title: `P${index}`, parent_id: pick(pages) },
      ),
    );
  // A trashed Page stays in the tree as a restore hint under its parent.
  const trashed = await s.page({ title: "Trashed", parent_id: pick(pages) });
  await s.trash(trashed);
  const loose = [await s.page({ title: "Loose A" }), await s.page({ title: "Loose B" })];
  const everything = [...pages, ...loose, s.home];
  const storage = w.catalogStorage();
  let revision = 0;
  let applied = 0;
  const refusals = new Set();
  for (let step = 0; step < 60; step++) {
    const pageId = pick(everything);
    const parentId = pick(everything);
    const roll = next();
    const position =
      roll < 0.25
        ? "first"
        : roll < 0.5
          ? "last"
          : roll < 0.75
            ? { before: pick(everything) }
            : { after: pick(everything) };
    const before = await s.entries();
    const result = await s.move(pageId, parentId, position);
    const entries = await s.entries();
    assert.deepEqual(
      checkInvariants({ revision: 0, entries }, { projects: { [s.project.project_id]: s.home } }),
      [],
      `step ${step}: ${JSON.stringify(result.body)}`,
    );
    if (result.status === 200) {
      applied++;
      revision++;
      assert.equal(result.body.location_revision, revision);
      assert.equal(entries.get(pageId).parent_id, parentId);
      assert.equal(entries.get(pageId).position, result.body.position);
      assert.equal(deriveLocation(entries, pageId).space_id, result.body.project_id);
      // Only the moved entry and rekeyed destination siblings changed, and
      // every changed sibling is under the destination.
      for (const [id, entry] of entries) {
        if (id === pageId) continue;
        const was = before.get(id);
        if (entry.position !== was.position)
          assert.equal(entry.parent_id, parentId, `${id} rekeyed outside the destination`);
        assert.equal(entry.parent_id, was.parent_id, `${id} changed parent`);
        assert.equal(entry.state, was.state);
      }
    } else {
      refusals.add(result.body.code);
      assert.deepEqual(entries, before, `a ${result.body.code} refusal wrote nothing`);
      assert.ok(result.status >= 400 && result.status < 500, result.body.code);
      assert.equal(result.status, MOVE_STATUS[result.body.code], result.body.code);
    }
    assert.equal((await storage.get(LOCATION_REVISION_KEY)) ?? 0, revision);
  }
  assert.ok(applied >= 10, `${applied} moves applied`);
  assert.ok(refusals.has("placement_cycle") || refusals.has("home_page_protected"), [...refusals]);
  // The trashed Page stays trashed, and its restore hint followed its parent.
  assert.equal((await s.entries()).get(trashed).state, "trashed");
  const restored = await w.call("owner", "restore_page", {
    page_id: trashed,
    idempotency_key: w.key(),
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  await s.invariants();
});
