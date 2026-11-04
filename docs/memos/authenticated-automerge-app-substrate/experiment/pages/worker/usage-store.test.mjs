import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualTimeScheduler } from "rxjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import {
  createUsageSink,
  migrateUsageStore,
  runUsageMaintenance,
  storedUsage,
  usageQueueStep,
  writeUsageBatch,
} from "./usage-store.mjs";

const DAY = 86_400_000;
const page = "44444444-4444-4444-8444-444444444444";
const other = "55555555-5555-4555-8555-555555555555";
const at = Date.parse("2026-11-04T12:00:00Z");
const event = (overrides = {}) => ({
  event: "pages.usage.v1",
  timestamp: new Date(at).toISOString(),
  principal: "user:one",
  driver: "Browser",
  surface: "browser-sync",
  action: "page.read",
  page_id: page,
  outcome: "ok",
  ...overrides,
});
const insert = (db, events, now = at) => writeUsageBatch(db, events.map(storedUsage), now);
const tick = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
const advance = async (scheduler, frame) => {
  scheduler.maxFrames = frame;
  scheduler.flush();
  await tick();
};

test("privacy projection has only SQL columns; migrations repeat and tolerate additive future schema", async (t) => {
  const db = sqliteD1(t).open();
  await migrateUsageStore(db);
  db.sqlite.exec("ALTER TABLE pages_usage_events ADD COLUMN future TEXT");
  await migrateUsageStore(db);
  const row = storedUsage(
    event({
      display_name: "Private Name",
      email: "a@example.com",
      client: "secret",
      session: "secret",
      title: "secret",
      content: "secret",
    }),
  );
  assert.deepEqual(Object.keys(row), [
    "day",
    "ts",
    "principal",
    "driver",
    "surface",
    "action",
    "page_id",
    "outcome",
  ]);
  assert.doesNotMatch(JSON.stringify(row), /secret|Private|example/);
  for (const extra of [
    { principal: "service:pages" },
    { principal: "a@example.com" },
    { principal: undefined },
    { driver: "a@example.com" },
    { page_id: "secret" },
    { timestamp: "2026-02-30T12:00:00.000Z" },
    { timestamp: "2026-11-04T07:00:00-05:00" },
  ])
    assert.equal(storedUsage(event(extra)), null);
  const columns = db.rows("PRAGMA table_info(pages_usage_weekly)").map((c) => c.name);
  assert.deepEqual(columns, [
    "week",
    "through_day",
    "active_people",
    "readers",
    "writers",
    "agent_people",
    "agent_actions",
    "collaborative_pages",
  ]);
  for (const table of ["pages_usage_daily", "pages_usage_weekly", "pages_usage_maintenance"])
    db.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN future TEXT`);
  await insert(db, [event()]);
  await runUsageMaintenance({ PAGES_USAGE: db }, at + DAY);
  assert.equal(db.rows("SELECT readers FROM pages_usage_weekly")[0].readers, 1);
});

test("queue transitions bound every state/event pair and preserve the stalled physical permit", () => {
  const row = storedUsage(event());
  const states = [
    { name: "idle", queue: [row] },
    { name: "scheduled", queue: [row] },
    { name: "writing", queue: [row], batch: [row] },
    { name: "stalled", queue: [], batch: [] },
  ];
  const expected = {
    idle: ["idle", "scheduled", "idle", "idle", "idle", "idle"],
    scheduled: ["scheduled", "scheduled", "writing", "scheduled", "idle", "idle"],
    writing: ["writing", "writing", "writing", "idle", "stalled", "writing"],
    stalled: ["stalled", "stalled", "stalled", "idle", "stalled", "stalled"],
  };
  for (const state of states)
    for (const [i, type] of [
      "enqueue",
      "schedule",
      "start",
      "settled",
      "timeout",
      "drop",
    ].entries()) {
      const result = usageQueueStep(state, { type, row }, { capacity: 2, batchSize: 1 });
      assert.equal(result.state.name, expected[state.name][i], `${state.name}/${type}`);
      assert.ok(result.state.queue.length + (result.state.batch?.length ?? 0) <= 2);
    }
});

test("sink batches outside critical path, bounds queue, isolates failures, and holds work", async () => {
  const scheduler = new VirtualTimeScheduler();
  const batches = [],
    warnings = [],
    holds = [];
  const sink = createUsageSink(
    {},
    {
      scheduler,
      now: () => at,
      capacity: 5,
      batchSize: 2,
      delayMs: 10,
      timeoutMs: 100,
      write: async (_db, batch) => {
        batches.push(batch);
        if (batches.length === 1) throw Error("private database error");
      },
      warn: (record) => warnings.push(record),
    },
  );
  for (let n = 0; n < 8; n++) sink.enqueue(event());
  assert.equal(sink.state.queue.length, 5);
  sink.flush({ waitUntil: (work) => holds.push(work) });
  assert.equal(batches.length, 0, "not even a DB prepare happens on the response path");
  await advance(scheduler, 9);
  assert.equal(batches.length, 0);
  await advance(scheduler, 10);
  await Promise.all(holds);
  assert.deepEqual(
    batches.map((b) => b.length),
    [2, 2, 1],
  );
  assert.equal(sink.state.name, "idle");
  assert.equal(
    warnings.reduce((n, w) => n + w.count, 0),
    5,
  );
  assert.doesNotMatch(JSON.stringify(warnings), /private|user:one/);
});

test("hung writes release the hold but not capacity; a late settlement cannot replay them", async () => {
  const scheduler = new VirtualTimeScheduler();
  let release,
    calls = 0;
  const held = [];
  const sink = createUsageSink(
    {},
    {
      scheduler,
      delayMs: 1,
      timeoutMs: 10,
      warn() {},
      write: () => {
        calls++;
        return calls === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve();
      },
    },
  );
  sink.enqueue(event());
  sink.flush({ waitUntil: (work) => held.push(work) });
  await advance(scheduler, 1);
  await advance(scheduler, 10);
  await held[0];
  assert.equal(sink.state.name, "stalled");
  for (let n = 0; n < 100; n++) {
    sink.enqueue(event());
    sink.flush({ waitUntil() {} });
  }
  assert.equal(calls, 1);
  assert.equal(sink.state.queue.length, 0);
  release();
  await tick();
  assert.equal(sink.state.name, "idle");
  sink.enqueue(event());
  sink.flush({ waitUntil: (work) => held.push(work) });
  await advance(scheduler, 11);
  await held[1];
  assert.equal(calls, 2);
});

test("missing or throwing request holds and diagnostic sinks never start D1 work", async () => {
  const scheduler = new VirtualTimeScheduler();
  let calls = 0;
  const sink = createUsageSink(
    {},
    {
      scheduler,
      write: () => {
        calls++;
      },
      warn() {
        throw Error("logger unavailable");
      },
    },
  );
  for (const ctx of [
    undefined,
    {},
    {
      waitUntil() {
        throw Error("hold unavailable");
      },
    },
  ]) {
    sink.enqueue(event());
    assert.doesNotThrow(() => sink.flush(ctx));
    assert.equal(sink.state.name, "idle");
  }
  scheduler.flush();
  assert.equal(calls, 0);
});

test("daily visits union 281 reconnects; weekly readers/writers/agents and collaboration union people", async (t) => {
  const db = sqliteD1(t).open();
  const events = [];
  for (let n = 0; n < 281; n++)
    events.push(event(), event({ action: "sync.open" }), event({ action: "sync.close" }));
  events.push(
    event({ page_id: other }),
    event({ action: "page.write" }),
    event({ action: "page.write" }),
    event({ principal: "user:two", action: "page.visit" }),
    event({ principal: "user:two", action: "comment.write" }),
    event({ principal: "user:agent-only", driver: "Kilo", surface: "mcp", action: "tool.call" }),
    event({
      principal: "user:agent-only",
      driver: "Kilo",
      surface: "mcp",
      action: "tool.call",
      outcome: "http_400",
    }),
    event({ principal: "user:agent-only", driver: "Kilo", surface: "mcp", action: "page.create" }),
    event({ principal: "user:refused", action: "tool.call", outcome: "http_403" }),
  );
  for (let i = 0; i < events.length; i += 64) await insert(db, events.slice(i, i + 64));
  await insert(db, [event({ timestamp: "2026-11-05T12:00:00.000Z" })], at + DAY);
  await runUsageMaintenance({ PAGES_USAGE: db }, at + 2 * DAY);
  const read = db.rows(
    "SELECT * FROM pages_usage_daily WHERE day = '2026-11-04' AND action = 'page.read'",
  )[0];
  assert.equal(read.count, 2);
  assert.equal(read.distinct_pages, 2);
  assert.equal(db.rows("SELECT * FROM pages_usage_daily WHERE action LIKE 'sync.%'").length, 0);
  assert.equal(
    db.rows("SELECT count FROM pages_usage_daily WHERE action = 'page.write'")[0].count,
    1,
  );
  assert.equal(
    db.rows(
      "SELECT count FROM pages_usage_daily WHERE principal = 'user:agent-only' AND action = 'tool.call'",
    )[0].count,
    2,
  );
  assert.deepEqual(db.rows("SELECT * FROM pages_usage_weekly"), [
    {
      week: "2026-11-02",
      through_day: "2026-11-05",
      active_people: 3,
      readers: 1,
      writers: 1,
      agent_people: 1,
      agent_actions: 2,
      collaborative_pages: 1,
    },
  ]);
  const snapshot = db.rows("SELECT * FROM pages_usage_daily ORDER BY day, principal, action");
  await runUsageMaintenance({ PAGES_USAGE: db }, at + 2 * DAY);
  assert.deepEqual(
    db.rows("SELECT * FROM pages_usage_daily ORDER BY day, principal, action"),
    snapshot,
  );
  await insert(db, [event({ principal: "user:late" })], at + 2 * DAY);
  await runUsageMaintenance({ PAGES_USAGE: db }, at + 2 * DAY);
  assert.equal(db.rows("SELECT active_people FROM pages_usage_weekly")[0].active_people, 4);
});

test("UTC retention is strict before day minus 90; weekly totals survive partial-week purges and downtime", async (t) => {
  const db = sqliteD1(t).open();
  const now = Date.parse("2026-11-04T00:00:00.000Z");
  const cutoff = new Date(now - 90 * DAY).toISOString().slice(0, 10);
  const older = new Date(now - 91 * DAY).toISOString().slice(0, 10);
  await insert(
    db,
    [
      event({ timestamp: `${older}T23:59:59.999Z` }),
      event({ timestamp: `${cutoff}T00:00:00.000Z`, principal: "user:two" }),
    ],
    now - 89 * DAY,
  );
  await runUsageMaintenance({ PAGES_USAGE: db }, now - 1);
  assert.equal(db.rows("SELECT * FROM pages_usage_events").length, 2);
  await runUsageMaintenance({ PAGES_USAGE: db }, now);
  assert.deepEqual(db.rows("SELECT day FROM pages_usage_events"), [{ day: cutoff }]);
  assert.deepEqual(db.rows("SELECT day FROM pages_usage_daily"), [{ day: cutoff }]);
  assert.equal(db.rows("SELECT active_people FROM pages_usage_weekly")[0].active_people, 2);
  const weekly = db.rows("SELECT * FROM pages_usage_weekly");
  await runUsageMaintenance({ PAGES_USAGE: db }, now + 200 * DAY);
  assert.deepEqual(db.rows("SELECT * FROM pages_usage_events"), []);
  assert.deepEqual(db.rows("SELECT * FROM pages_usage_daily"), []);
  assert.deepEqual(db.rows("SELECT * FROM pages_usage_weekly"), weekly);
  // A late call bound under an old clock cannot reinsert expired identities.
  await insert(db, [event({ timestamp: `${cutoff}T00:00:00.000Z` })], now);
  assert.deepEqual(db.rows("SELECT * FROM pages_usage_events"), []);
});

test("rollup/purge are atomic, and an older invocation cannot undo a newer job", async (t) => {
  const db = sqliteD1(t).open();
  await insert(db, [event()]);
  await runUsageMaintenance({ PAGES_USAGE: db }, at + DAY);
  const before = db.rows("SELECT * FROM pages_usage_weekly");
  const batch = db.batch.bind(db);
  let calls = 0;
  t.mock.method(db, "batch", async (statements) => {
    if (++calls === 2) db.failAt = 4;
    return batch(statements);
  });
  await assert.rejects(runUsageMaintenance({ PAGES_USAGE: db }, at + 100 * DAY));
  assert.deepEqual(db.rows("SELECT * FROM pages_usage_weekly"), before);
  assert.equal(db.rows("SELECT * FROM pages_usage_events").length, 1);
  t.mock.restoreAll();
  let release;
  // Hold the older job's transactional batch after its migration.
  let batches = 0;
  t.mock.method(db, "batch", async (statements) => {
    if (++batches === 2)
      await new Promise((resolve) => {
        release = resolve;
      });
    return batch(statements);
  });
  const old = runUsageMaintenance({ PAGES_USAGE: db }, at + 2 * DAY);
  await tick();
  await runUsageMaintenance({ PAGES_USAGE: db }, at + 101 * DAY);
  const after = db.rows("SELECT * FROM pages_usage_weekly");
  release();
  await old;
  assert.deepEqual(db.rows("SELECT * FROM pages_usage_weekly"), after);
  assert.deepEqual(db.rows("SELECT * FROM pages_usage_daily"), []);
  assert.equal(
    db.rows("SELECT day FROM pages_usage_maintenance")[0].day,
    new Date(at + 101 * DAY).toISOString().slice(0, 10),
  );
});
