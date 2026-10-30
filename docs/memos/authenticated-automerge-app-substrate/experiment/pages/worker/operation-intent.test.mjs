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

class Storage {
  values = new Map();
  constructor(onMutation) {
    this.onMutation = onMutation;
  }
  async get(name) {
    return structuredClone(this.values.get(name));
  }
  // One put is one write, as a Durable Object's multi-key put is.
  async put(name, value) {
    const entries = typeof name === "object" ? name : { [name]: value };
    this.onMutation({ op: "put", entries });
    for (const [entry, item] of Object.entries(entries))
      this.values.set(entry, structuredClone(item));
  }
  async delete(name) {
    this.onMutation({ op: "delete", key: name });
    return this.values.delete(name);
  }
  async sync() {
    this.onMutation({ op: "sync" });
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(
          ([name]) => name.startsWith(prefix) && (startAfter === undefined || name > startAfter),
        )
        .slice(0, limit)
        .map(([name, item]) => [name, structuredClone(item)]),
    );
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
    retarget: false,
    ...(row.forwarded && { replayOnly: false }),
  };
}

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
  constructor(state, event, { failAt, page } = {}) {
    this.state = state;
    this.event = event;
    this.failAt = failAt;
    this.hadIntent = ["reserved", "forwarded"].includes(state.name);
    this.operation = state.operation ?? event.operation ?? "restore_page";
    this.mode =
      event.type === "page_reply"
        ? "reply"
        : ["count", "settle", "lifecycle", "tombstone"].includes(event.type)
          ? event.type
          : "request";
    // Lifecycle reads reconcile on behalf of capacity counting or a
    // placement check; the row's state says which.
    this.reader = event.type === "lifecycle" ? state.check : this.mode;
    this.fresh =
      ["request", "tombstone"].includes(event.type) && state.name === "absent"
        ? event.type === "request"
        : state.retarget === true;
    this.page = page;
    this.mutations = 0;
    this.effects = [];
    this.before = [];
    this.forwards = 0;
    this.replayOnly = false;
    this.inProject = false;
    this.recording = !(this.mode === "reply" || this.mode === "lifecycle" || this.continuesFresh);
    this.storage = new Storage((mutation) => this.mutate(mutation));
    this.catalog = new Catalog(
      { id: { name: owner }, storage: this.storage },
      {
        ...auth.env,
        PAGES: { getByName: () => ({ fetch: (request) => this.respond(request) }) },
      },
    );
  }

  /** A row whose state is a request this run reserved starts after that
   * reservation. */
  get continuesFresh() {
    return this.state.name !== "absent" && this.fresh && this.mode === "request";
  }

  get slotKey() {
    return lifecycleSlotKey(this.operation, pageId);
  }

  seed(values = this.storage.values) {
    const { state, event, operation } = this;
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
    if (event.leaf === "refused")
      set(`page/${childId}`, {
        page_id: childId,
        title: "Child",
        created_at: CREATED,
        updated_at: CREATED,
        space_id: null,
        parent_id: pageId,
        position: "a1",
        placement_epoch: 0,
      });
  }

  record(effect, first) {
    if (this.recording) this.effects.push({ effect, first });
  }

  mutate(mutation) {
    const index = this.mutations++;
    // A retry after a crash runs freely: no boundaries, nothing recorded.
    if (this.page) return;
    this.before[index] = persisted(this.storage.values, this.operation);
    if (index === this.failAt) throw new Error("injected storage failure");
    if (this.stopAtNext) {
      this.paused = true;
      throw new Pause();
    }
    const effect = this.classify(mutation);
    if (effect) this.record(effect, index);
    if (effect?.type === "persist") this.hadIntent = true;
    // A fresh request's reservation is the boundary of absent × request.
    if (effect?.type === "persist" && effect.state === "reserved") {
      if (this.state.name === "absent") this.stopAtNext = true;
      else if (this.continuesFresh) this.recording = true;
    }
  }

  classify(mutation) {
    const projection = new Set([`page/${pageId}`, `trash/${pageId}`, `host/deleted/${pageId}`]);
    if (mutation.op === "sync") {
      this.inProject = false;
      return { type: "sync" };
    }
    if (mutation.op === "delete") {
      if (this.inProject && projection.has(mutation.key)) return undefined;
      this.inProject = false;
      if (mutation.key === key) return { type: "delete_intent" };
      if (this.mode === "tombstone" && mutation.key === `trash/${pageId}`)
        return { type: "forget_trash" };
      if (mutation.key === this.slotKey) return { type: "release_slot" };
      return { type: "unexpected", op: "delete", key: mutation.key };
    }
    const names = Object.keys(mutation.entries);
    if (names.length === 1 && names[0] === "host/index/dirty") {
      this.inProject = true;
      return { type: "project", current: this.projected };
    }
    if (
      this.inProject &&
      names.every((name) => projection.has(name)) &&
      !names.some((name) => mutation.entries[name]?.reservation)
    )
      return undefined;
    this.inProject = false;
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

  async respond(request) {
    const path = new URL(request.url).pathname;
    if (this.page) return this.page(request, this);
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
    const state = persisted(this.snapshot ?? this.storage.values, this.operation);
    if (state.name === "absent" && this.hadIntent)
      return this.wrap({ name: "released", operation: this.operation }, response);
    if (["reserved", "forwarded"].includes(state.name)) {
      state.retarget = this.fresh && !this.replayOnly && this.forwards <= 1;
      if (state.name === "forwarded") state.replayOnly = this.replayOnly;
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

const SUMMARY = { rows: 65, pairs: 21, unreachable: 15, cases: 42 };

test("the operation-intent machine gives every row's result", async () => {
  assert.deepEqual(await runTable(operationIntent, loadTable(TABLE)), SUMMARY);
});

test("the Catalog interprets every row as the machine does", async (t) => {
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  assert.deepEqual(await runTable(operationIntent, loadTable(TABLE), { drive }), SUMMARY);
});

/** A Page that applies whatever reaches it, for resuming after a crash. */
function cooperativePage(operation) {
  return async (request, run) => {
    const path = new URL(request.url).pathname;
    const intent = run.storage.values.get(key);
    const revision = intent?.expectedRevision ?? baseRevision[operation];
    if (path === "/internal/lifecycle-state")
      return Response.json({
        page_id: pageId,
        state: operation === "delete_page" ? "active" : "trashed",
        revision,
      });
    if (path === "/internal/tombstone") return Response.json({ state: "deleted" });
    if (run.storage.values.get(`host/deleted/${pageId}`))
      return Response.json(pageErrors[404], { status: 404 });
    const next = revision + 1;
    const outcome = {
      delete_page: {
        receipt: { page_id: pageId, state: "trashed", trashed: true },
        current: { page_id: pageId, state: "trashed", revision: next },
      },
      restore_page: {
        receipt: { page_id: pageId, state: "active", restored: true },
        current: { page_id: pageId, state: "active", revision: next },
      },
      purge_page: {
        receipt: { page_id: pageId, deleted: true, purged: true },
        current: { page_id: pageId, state: "deleted", revision: next },
      },
    }[operation];
    return Response.json(outcome);
  };
}

test("a crash after any effect leaves the state before it, and a retry resumes from there", async (t) => {
  t.mock.method(globalThis, "fetch", auth.fetch);
  t.mock.method(console, "error", () => {});
  let points = 0;
  for (const row of loadTable(TABLE).rows) {
    const first = new Drive(row.state, row.event);
    await first.run();
    for (const { effect, first: index } of first.effects) {
      if (index === undefined) continue;
      points++;
      const where = `${row.label}: crash at ${effect.type} (write ${index})`;
      const crashed = new Drive(row.state, row.event, { failAt: index });
      const outcome = await crashed.run();
      // No success is reported for work that did not finish.
      if (outcome.response?.status !== undefined)
        assert.ok(outcome.response.status >= 500, `${where}: replied ${outcome.response.status}`);
      else assert.ok(outcome.failure, `${where}: the crash surfaced`);
      const state = persisted(crashed.storage.values, crashed.operation);
      assert.deepEqual(state, first.before[index], `${where}: storage holds the prior state`);
      operationIntentAlphabet.assertState(state);
      // A retry from the persisted state finishes.
      const retry = new Drive(row.state, row.event, { page: cooperativePage(crashed.operation) });
      retry.storage.values = structuredClone(crashed.storage.values);
      const resumed = await retry.deliver().catch((error) => error);
      if (resumed instanceof Error)
        assert.equal(resumed.code, "lifecycle_unsettled", `${where}: ${resumed.message}`);
      else if (resumed?.status !== undefined)
        assert.ok(resumed.status < 500, `${where}: retry replied ${resumed.status}`);
      const after = persisted(retry.storage.values, retry.operation);
      if (!["count", "settle"].includes(retry.reader))
        assert.ok(
          ["completed", "superseded", "absent"].includes(after.name),
          `${where}: retry ended ${after.name}`,
        );
    }
  }
  assert.equal(points, 70, "crash points");
});
