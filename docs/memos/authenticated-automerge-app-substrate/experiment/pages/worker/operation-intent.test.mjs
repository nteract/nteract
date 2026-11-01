// One operation-intent table runs twice: against the pure transition, and
// through the owner's Catalog at its HTTP and capacity entry points. For the
// Catalog, each row seeds storage in the row's state, delivers the row's event
// against a scripted Page, and reads back the storage writes, Page requests
// and HTTP reply as machine effects.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { Catalog } from "./index.mjs";
import { lifecycleSlot, lifecycleSlotKey } from "./catalog.mjs";
import { fingerprint } from "./mutations.mjs";
import { RETRY_LIFETIME_MS } from "./operation-journal.mjs";
import { operationIntent, operationIntentAlphabet } from "./operation-intent.mjs";
import { CrashStorage, assertProjected, describe, normalize } from "./operation-intent-fixture.mjs";

const TABLE = new URL("../test/fixtures/machines/operation-intent.json", import.meta.url);
const auth = await createAuthFixture();
const owner = `user:anaconda-fixture:${auth.subject}`;
const token = auth.apiKey();
const identity = { principal: owner, driver: "ChatGPT" };
const pageId = "33333333-3333-4333-8333-333333333333";
const childId = "44444444-4444-4444-8444-444444444444";
const idempotencyKey = "intent-key-0001";
const key = `host/operation/${idempotencyKey}`;
const otherKey = "host/operation/other-intent-0001";
const CREATED = "2026-10-01T00:00:00.000Z";
const TRASHED_AT = "2026-10-29T12:00:00.000Z";
const LIMIT = 100;

const routes = {
  delete_page: "/internal/trash",
  restore_page: "/internal/restore",
  purge_page: "/internal/purge",
};
const journalName = {
  delete_page: "trash_page",
  restore_page: "restore_page",
  purge_page: "purge_page",
};
const baseRevision = { delete_page: 0, restore_page: 1, purge_page: 1 };
const destinationPrefix = { delete_page: "trash/", restore_page: "page/" };
const sourcePrefix = { delete_page: "page/", restore_page: "trash/", purge_page: "trash/" };
const argsFor = {
  delete_page: { page_id: pageId, base_heads: ["a".repeat(64)], idempotency_key: idempotencyKey },
  restore_page: { page_id: pageId, idempotency_key: idempotencyKey },
  purge_page: {
    page_id: pageId,
    action: "confirm",
    preview_token: "preview-token",
    idempotency_key: idempotencyKey,
  },
};
const digests = Object.fromEntries(
  await Promise.all(
    Object.keys(argsFor).map(async (operation) => [
      operation,
      await fingerprint(journalName[operation], argsFor[operation], identity),
    ]),
  ),
);
const pageErrors = {
  404: { error: "Page not found" },
  409: { error: "The Page changed since base_heads", code: "edit_conflict" },
  503: { error: "Page is temporarily unavailable" },
};

/** Ends a row at its boundary. The status keeps errorResponse quiet. */
class Pause extends Error {
  constructor() {
    super("paused by the table driver");
    this.status = 418;
  }
}

/** The intent and slot as a restarted Catalog would load them from storage. */
function persisted(values, operation) {
  const row = values.get(key);
  if (!row) return { name: "absent" };
  if (!row.pending)
    return {
      name: row.receipt?.superseded ? "superseded" : "completed",
      operation,
      receipt: row.receipt,
    };
  const slotKey = lifecycleSlotKey(operation, row.pageId);
  const entry = slotKey && values.get(slotKey);
  const slot = !slotKey
    ? "none"
    : !entry
      ? "lapsed"
      : entry.reservation
        ? entry.intent === key
          ? "live"
          : "lapsed"
        : "entry";
  return {
    name: row.forwarded ? "forwarded" : "reserved",
    operation,
    pageId: row.pageId,
    ...(row.expectedRevision !== undefined && { expectedRevision: row.expectedRevision }),
    slot,
    ...(row.forwarded && { retarget: false, replayOnly: false }),
  };
}

const childKey = "host/operation/child-restore-0001";
const childEntry = {
  page_id: childId,
  title: "Child",
  created_at: CREATED,
  updated_at: CREATED,
  parent_id: pageId,
  position: "a1",
};

const catalogEntry = (prefix, revision) => ({
  page_id: pageId,
  title: "Launch plan",
  created_at: CREATED,
  updated_at: CREATED,
  lifecycle_revision: revision,
  ...(prefix === "trash/" && {
    state: "trashed",
    trashed_at: TRASHED_AT,
    trashed_by: owner,
    trash_root_id: pageId,
  }),
});

/**
 * One row through the Catalog. `failAt` fails that storage write (counted
 * from the first write the Catalog makes), as a crash would.
 */
class Drive {
  constructor(state, event, { failAt } = {}) {
    this.state = state;
    this.event = event;
    this.failAt = failAt;
    this.hadIntent = ["reserved", "forwarded"].includes(state.name);
    this.operation = state.operation ?? event.operation ?? "restore_page";
    this.mode =
      event.type === "page_reply"
        ? "reply"
        : ["count", "settle", "lifecycle", "tombstone", "leaf"].includes(event.type)
          ? event.type
          : "request";
    // Lifecycle reads reconcile on behalf of capacity counting or a
    // placement check; the row's state says which.
    this.reader = event.type === "lifecycle" ? state.check : this.mode;
    // A forwarded row whose request may still retarget starts as a new
    // request, which is the only way to reach that in-memory state. A Trash
    // waiting on its leaf guard starts as a reserved request a restarted
    // Catalog resumes, the interleaving the guard is for (seedWaiting).
    this.fresh =
      ["request", "tombstone"].includes(event.type) && state.name === "absent"
        ? event.type === "request"
        : state.name === "forwarded" && state.retarget === true && event.type !== "leaf";
    // Neither the Page nor this Catalog had forwarded the request yet.
    this.unforwarded = this.fresh || state.name === "reserved";
    this.mutations = 0;
    this.effects = [];
    this.writes = [];
    this.projections = 0;
    this.problems = [];
    this.forwards = 0;
    this.replayOnly = false;
    this.inProject = false;
    this.recording = !["reply", "lifecycle", "leaf"].includes(this.mode);
    this.storage = new CrashStorage((mutation) => this.mutate(mutation));
    this.catalog = new Catalog(
      { id: { name: owner }, storage: this.storage },
      {
        ...auth.env,
        PAGES: { getByName: (id) => ({ fetch: (request) => this.respond(request, id) }) },
      },
    );
    // The leaf guard is an effect where the machine asks for it. A row that
    // starts at the guard's answer begins recording there.
    const checkLeaf = this.catalog.checkLeaf.bind(this.catalog);
    this.catalog.checkLeaf = async (id) => {
      if (this.mode === "leaf" && !this.recording) {
        this.endProjection();
        this.recording = true;
        return checkLeaf(id);
      }
      this.record({ type: "check_leaf" });
      this.paused = true;
      this.leafPaused = true;
      throw new Pause();
    };
  }

  get slotKey() {
    return lifecycleSlotKey(this.operation, pageId);
  }

  /** A Trash reserved at the row's revision, resumed by a restarted Catalog
   * while it still holds its slot. The Page has since moved to the row's
   * `target`, and the guard finds a child (refused) or a child whose restore
   * can't settle (unavailable). */
  seedWaiting(values) {
    const { state, event } = this;
    const set = (name, value) => values.set(name, structuredClone(value));
    const slots = (...args) => {
      for (const [name, value] of Object.entries(lifecycleSlot(...args))) set(name, value);
    };
    set(`page/${pageId}`, catalogEntry("page/", state.expectedRevision));
    set(key, {
      fingerprint: digests.delete_page,
      pending: true,
      pageId,
      createdAt: CREATED,
      expectedRevision: state.expectedRevision,
    });
    slots("delete_page", pageId, key, Date.now());
    if (event.refusal) set(`page/${childId}`, childEntry);
    if (event.unavailable) {
      set(childKey, {
        fingerprint: "child-restore",
        pending: true,
        forwarded: true,
        pageId: childId,
        createdAt: CREATED,
        expectedRevision: 1,
      });
      set(`trash/${childId}`, {
        ...childEntry,
        lifecycle_revision: 1,
        state: "trashed",
        trashed_at: TRASHED_AT,
        trashed_by: owner,
        trash_root_id: childId,
      });
      slots("restore_page", childId, childKey, Date.now(), { space_id: null, parent_id: pageId });
    }
  }

  /** What the Page reports when it supersedes a waiting row's first forward. */
  waitingCurrent() {
    const revision = this.state.target;
    return this.state.slot === "entry"
      ? {
          page_id: pageId,
          state: "trashed",
          revision,
          title: "Launch plan",
          trashed_at: TRASHED_AT,
          trashed_by: owner,
          trash_root_id: pageId,
        }
      : { page_id: pageId, state: "active", revision, title: "Launch plan" };
  }

  seed(values = this.storage.values) {
    const { state, event, operation } = this;
    if (this.mode === "leaf") return this.seedWaiting(values);
    const set = (name, value) => values.set(name, structuredClone(value));
    const revision =
      event.known ??
      (event.type === "request" && "revision" in event ? event.revision : undefined) ??
      state.expectedRevision ??
      baseRevision[operation];
    const destination =
      event.destination ??
      (this.fresh
        ? { live: "room", lapsed: "taken", entry: "entry", none: "none" }[state.slot]
        : undefined);
    const slot = this.fresh ? undefined : state.slot;
    if (destination === "entry" || slot === "entry") {
      const prefix = destinationPrefix[operation];
      set(`${prefix}${pageId}`, catalogEntry(prefix, revision));
    } else {
      const prefix = sourcePrefix[operation];
      set(`${prefix}${pageId}`, catalogEntry(prefix, revision));
    }
    const intent = {
      fingerprint: digests[operation],
      pending: true,
      pageId,
      createdAt: CREATED,
      ...(state.expectedRevision !== undefined && { expectedRevision: state.expectedRevision }),
    };
    if (!this.fresh && state.name === "reserved") set(key, intent);
    if (!this.fresh && state.name === "forwarded") set(key, { ...intent, forwarded: true });
    if (["completed", "superseded"].includes(state.name))
      set(key, {
        ...intent,
        expectedRevision: baseRevision[operation],
        forwarded: true,
        pending: false,
        receipt: state.receipt,
      });
    const stale = ["absent", "completed", "superseded"].includes(state.name);
    const expired =
      (event.type === "count" || event.type === "request") && event.expired === true
        ? true
        : state.check === "count";
    if (
      ((slot === "live" || slot === "reconciling") && !this.fresh) ||
      (stale && ["count", "settle"].includes(event.type))
    ) {
      const now = expired ? Date.now() - RETRY_LIFETIME_MS - 60_000 : Date.now();
      for (const [name, value] of Object.entries(lifecycleSlot(operation, pageId, key, now)))
        set(name, value);
    }
    const fill = () => {
      for (let index = 0; index < LIMIT; index++) {
        const id = `fill-${String(index).padStart(3, "0")}`;
        set(`${destinationPrefix[operation]}${id}`, { page_id: id, title: id });
      }
    };
    if (event.type === "tombstone") set(`host/deleted/${pageId}`, true);
    if (destination === "full" || event.capacity === false || state.replayOnly) fill();
    if (destination === "taken") {
      set(otherKey, { ...intent, fingerprint: "other", forwarded: true });
      for (const [name, value] of Object.entries(
        lifecycleSlot(operation, pageId, otherKey, Date.now()),
      ))
        set(name, value);
    }
    if (event.leaf === "refused") set(`page/${childId}`, childEntry);
  }

  record(effect, first) {
    if (this.recording) this.effects.push({ effect, first });
  }

  mutate(mutation) {
    const index = this.mutations++;
    // What a crash at this write leaves, for the crash sweep.
    if (this.recording)
      this.writes.push({
        index,
        label: describe(mutation, pageId),
        before: normalize(this.storage.committed),
      });
    if (index === this.failAt) throw new Error("injected storage failure");
    if (this.stopAtNext) {
      this.paused = true;
      throw new Pause();
    }
    const effect = this.classify(mutation);
    if (effect) this.record(effect, index);
    if (effect?.type === "persist") this.hadIntent = true;
    // A fresh request's reservation is the boundary of absent × request.
    if (effect?.type === "persist" && effect.state === "reserved" && this.state.name === "absent")
      this.stopAtNext = true;
  }

  /** A projection's writes are one `project` effect. When it ends, the
   * Page's entries must be the projection of what the Page reported. */
  endProjection() {
    if (!this.inProject) return;
    this.inProject = false;
    this.projections++;
    // The check runs inside a storage call, where the Catalog would turn a
    // throw into a reply; keep it for the row's result.
    try {
      assertProjected(this.storage.values, pageId, this.projected, this.projectedOver);
    } catch (error) {
      this.problems.push(error);
    }
  }

  classify(mutation) {
    const projection = new Set([`page/${pageId}`, `trash/${pageId}`, `host/deleted/${pageId}`]);
    if (mutation.op === "sync") {
      this.endProjection();
      return { type: "sync" };
    }
    if (mutation.op === "delete") {
      if (this.inProject && projection.has(mutation.key)) return undefined;
      this.endProjection();
      if (mutation.key === key) return { type: "delete_intent" };
      if (this.mode === "tombstone" && mutation.key === `trash/${pageId}`)
        return { type: "forget_trash" };
      if (mutation.key === this.slotKey) return { type: "release_slot" };
      return { type: "unexpected", op: "delete", key: mutation.key };
    }
    const names = Object.keys(mutation.entries);
    if (names.includes("host/index/dirty")) {
      this.endProjection();
      this.inProject = true;
      this.projectedOver = {
        page: structuredClone(this.storage.values.get(`page/${pageId}`)),
        trash: structuredClone(this.storage.values.get(`trash/${pageId}`)),
      };
      if (names.some((name) => name !== "host/index/dirty" && !projection.has(name)))
        return { type: "unexpected", op: "put", keys: names };
      return { type: "project", current: this.projected };
    }
    if (
      this.inProject &&
      names.every((name) => projection.has(name)) &&
      !names.some((name) => mutation.entries[name]?.reservation)
    )
      return undefined;
    this.endProjection();
    if (names.includes(key)) {
      const before = this.storage.values.get(key);
      const after = mutation.entries[key];
      const state = after.pending
        ? after.forwarded
          ? "forwarded"
          : "reserved"
        : after.receipt?.superseded
          ? "superseded"
          : "completed";
      const effect = { type: "persist", state };
      if (state === "reserved" && after.expectedRevision !== undefined)
        effect.expectedRevision = after.expectedRevision;
      if (state === "forwarded" && before && after.expectedRevision !== before.expectedRevision)
        effect.expectedRevision = after.expectedRevision;
      if (state === "reserved" && names.includes(this.slotKey)) effect.slot = true;
      if (!after.pending) effect.receipt = after.receipt;
      if (names.some((name) => name !== key && name !== this.slotKey))
        return { type: "unexpected", op: "put", keys: names };
      return effect;
    }
    if (
      names.length === 1 &&
      names[0] === this.slotKey &&
      mutation.entries[this.slotKey].intent === key
    )
      return { type: "reserve_slot" };
    return { type: "unexpected", op: "put", keys: names };
  }

  async respond(request, id) {
    const path = new URL(request.url).pathname;
    // A child's restore can't settle: its Page doesn't answer.
    if (id === childId && path === "/internal/lifecycle-state")
      return Response.json({ error: "settling" }, { status: 503 });
    if (path === "/internal/lifecycle-state") return this.lifecycleRead();
    if (path === "/internal/tombstone") {
      this.record({ type: "notify_tombstone" });
      if (this.mode === "tombstone") {
        this.snapshot = structuredClone(this.storage.values);
        this.recording = false;
      }
      return Response.json({ state: "deleted" });
    }
    if (path === routes[this.operation]) return this.forward(await request.json());
    throw new Error(`Unexpected Page request ${path}`);
  }

  forward(body) {
    this.forwards++;
    this.replayOnly = body.replay_only === true;
    for (const [name, value] of Object.entries(argsFor[this.operation]))
      assert.deepEqual(body[name], value, `forwarded ${name}`);
    const effect = {
      type: "forward",
      ...(body.expected_revision !== undefined && { expectedRevision: body.expected_revision }),
      ...(body.replay_only && { replayOnly: true }),
    };
    if (this.recording) {
      this.record(effect);
      this.paused = true;
      throw new Pause();
    }
    if (this.mode === "leaf" && this.forwards === 1) {
      // The Page moved on to the row's target, so it supersedes the resumed
      // request without recording it.
      this.projected = this.waitingCurrent();
      return Response.json({
        receipt: { page_id: pageId, superseded: true, applied: false, state: this.projected.state },
        current: this.projected,
      });
    }
    if (this.mode !== "reply" || this.forwards !== 1) {
      this.paused = true;
      throw new Pause();
    }
    // The first forward is the boundary: the row starts at the Page's reply.
    this.recording = true;
    const { event } = this;
    if (event.unavailable) throw new Error("Page unreachable");
    if (event.status >= 200 && event.status < 300) {
      this.projected = event.current;
      return Response.json(
        { receipt: event.receipt, current: event.current },
        { status: event.status },
      );
    }
    if (event.status === 404) this.projected = { state: "deleted" };
    return Response.json(pageErrors[event.status], {
      status: event.status,
      headers: event.rejected ? { "x-pages-lifecycle-rejected": event.rejected } : {},
    });
  }

  lifecycleRead() {
    // A resumed Trash request reads the Page for its leaf guard; that read is
    // a fact gathered before the request event, not a row effect.
    if (!["count", "settle", "lifecycle"].includes(this.mode))
      return Response.json({
        page_id: pageId,
        state: "active",
        revision: this.state.expectedRevision ?? baseRevision[this.operation],
      });
    if (this.mode !== "lifecycle" || this.recording) {
      this.record({ type: "read_lifecycle" });
      this.paused = true;
      this.readPaused = true;
      throw new Pause();
    }
    this.recording = true;
    const { event } = this;
    if (event.unavailable) return Response.json({ error: "settling" }, { status: 503 });
    this.projected = event.current.state === "missing" ? { state: "deleted" } : event.current;
    return Response.json(event.current);
  }

  /** Deliver the row's event and return the Catalog's reply, if any. */
  async deliver() {
    if (this.state.name === "completed" && this.state.receipt.deleted)
      this.projected = { state: "deleted" };
    const reader = this.reader;
    if (reader === "count") {
      const counted = await this.catalog.countEntries(destinationPrefix[this.operation]);
      return { counted: counted === 1 };
    }
    if (reader === "settle") {
      await this.catalog.settleReservation(pageId);
      return undefined;
    }
    const response = await this.catalog.fetch(
      new Request("https://pages.invalid/internal/catalog", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({ operation: this.operation, arguments: argsFor[this.operation] }),
      }),
    );
    const body = await response.json();
    if (
      this.mode === "reply" &&
      !this.event.unavailable &&
      pageErrors[this.event.status] &&
      response.status === this.event.status
    ) {
      assert.deepEqual(body, pageErrors[response.status], "the Page's reply passes through");
      return { source: "page", status: response.status };
    }
    return { status: response.status, body };
  }

  async run() {
    this.seed();
    let response;
    let failure;
    try {
      response = await this.deliver();
    } catch (error) {
      if (error.status === 409 && error.code === "lifecycle_unsettled" && !this.paused)
        response = { status: 409, body: { error: error.message, code: error.code } };
      else failure = error;
    }
    return { response, failure };
  }

  /** The row's result: storage read back, plus what lives in memory. */
  result({ response, failure }) {
    if (failure && !this.paused) throw failure;
    this.endProjection();
    if (this.problems.length) throw this.problems[0];
    const state = persisted(this.snapshot ?? this.storage.values, this.operation);
    if (state.name === "absent" && this.hadIntent)
      return this.wrap({ name: "released", operation: this.operation }, response);
    if (["reserved", "forwarded"].includes(state.name)) {
      if (state.name === "forwarded") {
        state.retarget = this.unforwarded && !this.replayOnly && this.forwards <= 1;
        state.replayOnly = this.replayOnly;
        if (this.leafPaused) state.target = this.event.current.revision;
      }
      if (this.readPaused) {
        state.slot = "reconciling";
        state.check = this.reader;
      }
    }
    return this.wrap(state, response);
  }

  wrap(state, response) {
    const effects = this.effects.map(({ effect }) => effect);
    const paused = this.paused || (this.mode === "tombstone" && this.state.name !== "absent");
    return { state, effects, ...(!paused && response !== undefined && { response }) };
  }
}

/** Drive one row through the current Catalog. */
async function drive(state, event) {
  const run = new Drive(state, event);
  const outcome = await run.run();
  const result = run.result(outcome);
  // A refusal before anything changed is the machine's rejection.
  if (state.name === "absent" && event.type === "request" && event.destination === "full")
    return { ...result, rejected: "full" };
  return result;
}

const SUMMARY = { rows: 70, pairs: 22, unreachable: 20, cases: 46 };
/** Every storage write the table's rows make, and the projections among them. */
const SWEEP = { points: 126, projections: 24 };

test("the operation-intent machine gives every row's result", async () => {
  assert.deepEqual(await runTable(operationIntent, loadTable(TABLE)), SUMMARY);
});

test("the Catalog interprets every row as the machine does", async (t) => {
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  assert.deepEqual(await runTable(operationIntent, loadTable(TABLE), { drive }), SUMMARY);
});

test("a crash at any Catalog write leaves exactly the storage before it", async (t) => {
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  let points = 0;
  let projections = 0;
  for (const row of loadTable(TABLE).rows) {
    const first = new Drive(row.state, row.event);
    first.result(await first.run());
    projections += first.projections;
    for (const write of first.writes) {
      points++;
      const where = `${row.label}: crash at ${write.label} (write ${write.index})`;
      const crashed = new Drive(row.state, row.event, { failAt: write.index });
      const outcome = await crashed.run();
      // No success is reported for work that did not finish.
      if (outcome.response?.status !== undefined)
        assert.ok(outcome.response.status >= 500, `${where}: replied ${outcome.response.status}`);
      else assert.ok(outcome.failure, `${where}: the crash surfaced`);
      assert.equal(crashed.storage.depth, 0, `${where}: no transaction is left open`);
      assert.deepEqual(normalize(crashed.storage.values), write.before, where);
      operationIntentAlphabet.assertState(persisted(crashed.storage.values, crashed.operation));
    }
  }
  assert.deepEqual(
    { points, projections },
    { points: SWEEP.points, projections: SWEEP.projections },
  );
});

test("a retargeted Trash keeps its slot, so its lost reply can't overfill Trash", async (t) => {
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  const otherId = "55555555-5555-4555-8555-555555555555";
  const storage = new CrashStorage();
  // Trash holds 99 Pages. The Catalog last saw this Page active at revision
  // 0; the Page has since been trashed and restored without it.
  for (let index = 0; index < LIMIT - 1; index++) {
    const id = `fill-${String(index).padStart(3, "0")}`;
    storage.values.set(`trash/${id}`, { page_id: id, title: id });
  }
  storage.values.set(`page/${pageId}`, catalogEntry("page/", 0));
  storage.values.set(`page/${otherId}`, { ...catalogEntry("page/", 0), page_id: otherId });
  const trashed = (id, revision) => ({
    receipt: { page_id: id, state: "trashed", trashed: true },
    current: { page_id: id, state: "trashed", revision, title: "Launch plan" },
  });
  let applied = false;
  const replies = [
    () =>
      Response.json({
        receipt: { page_id: pageId, superseded: true, applied: false, state: "active" },
        current: { page_id: pageId, state: "active", revision: 2, title: "Launch plan" },
      }),
    // The retarget applies at revision 2; its reply is lost.
    () => {
      applied = true;
      throw new Error("connection reset");
    },
  ];
  const catalog = new Catalog(
    { id: { name: owner }, storage },
    {
      ...auth.env,
      PAGES: {
        getByName: (id) => ({
          fetch: async (request) => {
            assert.equal(new URL(request.url).pathname, "/internal/trash");
            return id === pageId ? replies.shift()() : Response.json(trashed(id, 1));
          },
        }),
      },
    },
  );
  const trash = (id, idempotency) =>
    catalog.fetch(
      new Request("https://pages.invalid/internal/catalog", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({
          operation: "delete_page",
          arguments: { page_id: id, base_heads: ["a".repeat(64)], idempotency_key: idempotency },
        }),
      }),
    );
  assert.equal((await trash(pageId, idempotencyKey)).status, 500);
  assert.ok(applied);
  assert.equal(storage.values.get(`trash/${pageId}`)?.intent, key, "the retry holds its slot");
  // Trash is full while that request may have applied.
  const other = await trash(otherId, "other-trash-0001");
  assert.equal(other.status, 409);
  assert.equal((await other.json()).code, "trash_capacity");
});
