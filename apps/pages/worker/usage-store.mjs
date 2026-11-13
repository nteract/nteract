import { asyncScheduler, timer } from "rxjs";
import { validPageId } from "./registration.mjs";

const DAY = 86_400_000;
const isoDay = (now) => new Date(now).toISOString().slice(0, 10);
const actions = new Set([
  "mcp.initialize",
  "tool.call",
  "page.create",
  "page.write",
  "comment.write",
  "page.read",
  "page.visit",
  "sync.open",
  "sync.close",
]);
const surfaces = new Set(["mcp", "http-tools", "http-rest", "browser-sync"]);
const drivers = new Set([
  "Browser",
  "API",
  "Kilo",
  "Codex",
  "Claude Code",
  "Claude Desktop",
  "ChatGPT",
  "Cursor",
  "Gemini",
]);
const visits = "'page.read', 'page.visit', 'page.write', 'comment.write', 'page.create'";

/** Append-only schema in a database that holds no Page content or profile text.
 * Every statement is idempotent, including when an older build runs again. */
export const USAGE_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS pages_usage_events (
    id INTEGER PRIMARY KEY,
    day TEXT NOT NULL, ts TEXT NOT NULL, principal TEXT NOT NULL,
    driver TEXT NOT NULL, surface TEXT NOT NULL, action TEXT NOT NULL,
    page_id TEXT, outcome TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS pages_usage_events_day ON pages_usage_events(day)`,
  `CREATE TABLE IF NOT EXISTS pages_usage_daily (
    day TEXT NOT NULL, principal TEXT NOT NULL, surface TEXT NOT NULL,
    driver TEXT NOT NULL, action TEXT NOT NULL, count INTEGER NOT NULL,
    distinct_pages INTEGER NOT NULL,
    PRIMARY KEY (day, principal, surface, driver, action)
  )`,
  `CREATE TABLE IF NOT EXISTS pages_usage_weekly (
    week TEXT PRIMARY KEY, through_day TEXT NOT NULL,
    active_people INTEGER NOT NULL, readers INTEGER NOT NULL,
    writers INTEGER NOT NULL, agent_people INTEGER NOT NULL,
    agent_actions INTEGER NOT NULL, collaborative_pages INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pages_usage_maintenance (
    id INTEGER PRIMARY KEY CHECK (id = 1), day TEXT NOT NULL,
    purged_before TEXT NOT NULL
  )`,
  `INSERT OR IGNORE INTO pages_usage_maintenance (id, day, purged_before) VALUES (1, '', '')`,
]);

/** Allowlist, not a serialized event. No free-form profile/client fields survive. */
export function storedUsage(record) {
  if (
    record?.event !== "pages.usage.v1" ||
    !actions.has(record.action) ||
    !surfaces.has(record.surface)
  )
    return null;
  const { principal, driver, timestamp, page_id } = record;
  if (
    typeof principal !== "string" ||
    !principal ||
    principal.length > 512 ||
    principal.startsWith("service:")
  )
    return null;
  try {
    if (/[@\p{Cc}\p{Cf}]/u.test(decodeURIComponent(principal))) return null;
  } catch {
    return null;
  }
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  )
    return null;
  if (page_id !== undefined && !validPageId(page_id)) return null;
  if (record.action.startsWith("page.") || record.action === "comment.write") {
    if (!page_id) return null;
  }
  return {
    day: timestamp.slice(0, 10),
    ts: timestamp,
    principal,
    driver: drivers.has(driver) ? driver : "other",
    surface: record.surface,
    action: record.action,
    page_id: page_id ?? null,
    outcome:
      typeof record.outcome === "string" && /^[a-z0-9_]{1,64}$/.test(record.outcome)
        ? record.outcome
        : "unknown",
  };
}

export async function migrateUsageStore(db) {
  await db.batch(USAGE_SCHEMA.map((sql) => db.prepare(sql)));
}

/** One dispatch, including idempotent schema setup. Ambiguous writes are not retried.
 * The durable purge floor also fences a delayed batch started before collection. */
export async function writeUsageBatch(db, records, now = Date.now()) {
  const cutoff = isoDay(now - 90 * DAY);
  await db.batch([
    ...USAGE_SCHEMA.map((sql) => db.prepare(sql)),
    ...records.map((row) =>
      db
        .prepare(`INSERT INTO pages_usage_events
      (day, ts, principal, driver, surface, action, page_id, outcome)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ? >= MAX(?,
        (SELECT purged_before FROM pages_usage_maintenance WHERE id = 1)) AND ? <= ?`)
        .bind(
          row.day,
          row.ts,
          row.principal,
          row.driver,
          row.surface,
          row.action,
          row.page_id,
          row.outcome,
          row.day,
          cutoff,
          row.ts,
          new Date(now).toISOString(),
        ),
    ),
  ]);
}

/** Pure bounded queue lifecycle. A stalled permit is abandoned after a grace
 * period. Permit identity fences completions from abandoned request contexts. */
export function usageQueueStep(state, event, { capacity = 512, batchSize = 64 } = {}) {
  switch (event.type) {
    case "enqueue":
      if (state.name === "stalled" || state.queue.length + (state.batch?.length ?? 0) >= capacity)
        return { state, dropped: 1 };
      return { state: { ...state, queue: [...state.queue, event.row] } };
    case "schedule":
      return state.name === "idle" && state.queue.length
        ? { state: { ...state, name: "scheduled", permit: event.permit } }
        : { state };
    case "start":
      return state.name === "scheduled"
        ? {
            state: {
              name: "writing",
              permit: state.permit,
              batch: state.queue.slice(0, batchSize),
              queue: state.queue.slice(batchSize),
            },
          }
        : { state };
    case "settled":
      if (!["writing", "stalled"].includes(state.name) || event.permit !== state.permit)
        return { state };
      return {
        state: { name: "idle", queue: state.queue },
        dropped: event.failed ? (state.batch?.length ?? 0) : 0,
      };
    case "timeout":
      if (event.permit !== state.permit) return { state };
      if (state.name === "writing")
        return {
          state: {
            name: "stalled",
            queue: [],
            batch: [],
            permit: state.permit,
            recoverAt: event.recoverAt,
          },
          dropped: state.queue.length + state.batch.length,
        };
      if (state.name !== "scheduled") return { state };
      return { state: { name: "idle", queue: [] }, dropped: state.queue.length };
    case "flush":
      return state.name === "stalled"
        ? {
            state: event.now >= state.recoverAt ? { name: "idle", queue: [] } : state,
            report: true,
          }
        : { state };
    case "drop":
      if (state.name !== "idle" && state.name !== "scheduled") return { state };
      return { state: { name: "idle", queue: [] }, dropped: state.queue.length };
    default:
      return { state };
  }
}

/** Enqueue never starts work. flush must be called in a live request's context.
 * Only a bounded hold waits for D1, never the response or a document save. */
export function createUsageSink(
  db,
  {
    now = Date.now,
    scheduler = asyncScheduler,
    capacity = 512,
    batchSize = 64,
    delayMs = 25,
    timeoutMs = 5_000,
    graceMs = 60_000,
    write = writeUsageBatch,
    warn = (record) => console.warn(JSON.stringify(record)),
  } = {},
) {
  let state = { name: "idle", queue: [] };
  let lost = 0;
  const step = (event) => {
    const result = usageQueueStep(state, event, { capacity, batchSize });
    state = result.state;
    lost += result.dropped ?? 0;
    return result;
  };
  const report = () => {
    if (!lost) return;
    try {
      warn({ event: "pages.usage.dropped", count: lost });
    } catch {
      /* Telemetry is optional. */
    }
    lost = 0;
  };
  return {
    get state() {
      return state;
    },
    enqueue(record) {
      try {
        const row = storedUsage(record);
        if (row) step({ type: "enqueue", row });
      } catch {
        lost++;
      }
    },
    flush(ctx) {
      try {
        if (step({ type: "flush", now: now() }).report) report();
        if (state.name !== "idle") return;
        if (typeof ctx?.waitUntil !== "function") {
          step({ type: "drop" });
          report();
          return;
        }
        if (!state.queue.length) {
          report();
          return;
        }
        const permit = {};
        step({ type: "schedule", permit });
        let finish;
        const held = new Promise((resolve) => {
          finish = resolve;
        });
        // Register before even scheduling work: a failed hold starts no D1 I/O.
        ctx.waitUntil(held);
        let expired = false;
        const deadline = timer(timeoutMs, scheduler).subscribe(() => {
          expired = true;
          step({ type: "timeout", permit, recoverAt: now() + graceMs });
          report();
          finish();
        });
        timer(delayMs, scheduler).subscribe(() => {
          void (async () => {
            while (!expired && state.name === "scheduled" && state.permit === permit) {
              step({ type: "start" });
              let failed = false;
              try {
                await write(db, state.batch, now());
              } catch {
                failed = true;
              }
              step({ type: "settled", permit, failed });
              report();
              if (expired) break;
              step({ type: "schedule", permit });
            }
          })().finally(() => {
            deadline.unsubscribe();
            finish();
          });
        });
      } catch {
        step({ type: "drop" });
        report();
      }
    },
  };
}

const sinks = new WeakMap();
function sink(env) {
  const db = env?.PAGES_USAGE;
  if (!db) return undefined;
  let value = sinks.get(db);
  if (!value) {
    value = createUsageSink(db);
    sinks.set(db, value);
  }
  return value;
}
export function enqueueUsage(record, env) {
  try {
    sink(env)?.enqueue(record);
  } catch {
    /* Missing telemetry must not affect requests. */
  }
}
export function flushUsage(env, ctx) {
  try {
    sink(env)?.flush(ctx);
  } catch {
    /* Missing telemetry must not affect requests. */
  }
}

/** Cron catches up every available completed day before collecting identities.
 * All replacements, the monotonic day fence, and purge share one D1 transaction.
 * Weekly unions are frozen once any day in their source interval was purged. */
export async function runUsageMaintenance(env, now = Date.now()) {
  const db = env?.PAGES_USAGE;
  if (!db) return;
  await migrateUsageStore(db);
  const today = isoDay(now);
  const yesterday = isoDay(now - DAY);
  const cutoff = isoDay(now - 90 * DAY);
  const guard = "(SELECT day FROM pages_usage_maintenance WHERE id = 1) <= ?";
  // Monday as an ISO date, independent of SQLite's locale and the host timezone.
  const week = "date(day, '-' || ((CAST(strftime('%w', day) AS INTEGER) + 6) % 7) || ' days')";
  await db.batch([
    db.prepare(`DELETE FROM pages_usage_daily WHERE day < ? AND ${guard}`).bind(today, today),
    db
      .prepare(`INSERT INTO pages_usage_daily
      (day, principal, surface, driver, action, count, distinct_pages)
      SELECT day, principal, surface, driver, action,
        CASE WHEN action IN (${visits}) THEN COUNT(DISTINCT page_id) ELSE COUNT(*) END,
        COUNT(DISTINCT page_id)
      FROM pages_usage_events WHERE day < ? AND ${guard}
        AND action NOT IN ('sync.open', 'sync.close', 'mcp.initialize')
      GROUP BY day, principal, surface, driver, action`)
      .bind(today, today),
    db
      .prepare(`INSERT INTO pages_usage_weekly
      (week, through_day, active_people, readers, writers, agent_people, agent_actions, collaborative_pages)
      WITH events AS (
        SELECT *, ${week} AS week FROM pages_usage_events
        WHERE day < ? AND action IN (${visits}, 'tool.call')
      ), eligible AS (
        SELECT * FROM events WHERE week >=
          (SELECT purged_before FROM pages_usage_maintenance WHERE id = 1)
      ), collaborators AS (
        SELECT week, page_id FROM eligible WHERE outcome = 'ok' AND page_id IS NOT NULL
        GROUP BY week, page_id HAVING COUNT(DISTINCT principal) >= 2
      )
      SELECT week, ?,
        COUNT(DISTINCT CASE WHEN outcome = 'ok' THEN principal END),
        COUNT(DISTINCT CASE WHEN outcome = 'ok' AND driver = 'Browser' AND action = 'page.read' THEN principal END),
        COUNT(DISTINCT CASE WHEN outcome = 'ok' AND driver = 'Browser' AND action IN ('page.create', 'page.write') THEN principal END),
        COUNT(DISTINCT CASE WHEN outcome = 'ok' AND driver <> 'Browser' AND action = 'tool.call' THEN principal END),
        SUM(CASE WHEN driver <> 'Browser' AND action = 'tool.call' THEN 1 ELSE 0 END),
        (SELECT COUNT(*) FROM collaborators c WHERE c.week = eligible.week)
      FROM eligible WHERE ${guard} GROUP BY week
      ON CONFLICT(week) DO UPDATE SET through_day = excluded.through_day,
        active_people = excluded.active_people, readers = excluded.readers,
        writers = excluded.writers, agent_people = excluded.agent_people,
        agent_actions = excluded.agent_actions, collaborative_pages = excluded.collaborative_pages`)
      .bind(today, yesterday, today),
    db.prepare(`DELETE FROM pages_usage_events WHERE day < ? AND ${guard}`).bind(cutoff, today),
    db.prepare(`DELETE FROM pages_usage_daily WHERE day < ? AND ${guard}`).bind(cutoff, today),
    db
      .prepare(
        `UPDATE pages_usage_maintenance SET day = ?, purged_before = MAX(purged_before, ?) WHERE id = 1 AND day <= ?`,
      )
      .bind(today, cutoff, today),
  ]);
}
