import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  REVOKED_GRANT_GRACE_SECONDS,
  authSweepMachine,
  runAuthMaintenance,
} from "./auth-maintenance.mjs";
import { runTable } from "../shared/machine-test.mjs";
import { runScheduled } from "./scheduled.mjs";
import { AUTH_CRON, USAGE_CRON, scheduledTasks } from "../shared/schedule.mjs";

// Actual SQLite behind the D1 surface the sweep uses; batches are transactions.
class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
  }
  prepare(sql) {
    const connection = this.sqlite;
    const build = (values = []) => ({
      bind: (...next) => build(next),
      first: async () => connection.prepare(sql).get(...values) ?? null,
      all: async () => ({ success: true, results: connection.prepare(sql).all(...values) }),
      run: async () => {
        const result = connection.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      execute: () => {
        const result = connection.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    });
    return build();
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  exec(sql, ...values) {
    this.sqlite.prepare(sql).run(...values);
  }
  count(table, where = "1") {
    return Number(this.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n);
  }
  ids(table, key) {
    return this.sqlite
      .prepare(`SELECT ${key} AS id FROM ${table} ORDER BY ${key}`)
      .all()
      .map((row) => row.id);
  }
}

const NOW = 1_800_000_000; // seconds
const NOW_MS = NOW * 1000;
const quiet = () => {};

async function fixture() {
  const db = new SqliteD1();
  const env = { DB: db };
  // An empty run creates every schema the sweep touches.
  await runAuthMaintenance(env, { now: NOW_MS, log: quiet });
  return { db, env };
}
function login(db, id, expiresAt) {
  db.exec(
    `INSERT INTO oidc_login_transactions (state_hash, binding_hash, context, sealed, expires_at)
    VALUES (?, 'b', 'c', 's', ?)`,
    id,
    expiresAt,
  );
}
function session(db, id, idle, absolute) {
  db.exec(
    `INSERT INTO oidc_server_sessions (id, context, session_json, sealed, access_expires_at,
    idle_expires_at, absolute_expires_at) VALUES (?, 'c', '{}', 's', ?, ?, ?)`,
    id,
    idle,
    idle,
    absolute,
  );
}
function grant(db, id, expiresAt, revokedAt = null) {
  db.exec(
    `INSERT INTO pages_oauth_grants (id, context, client_id, resource, scope, identity_json,
    expires_at, revoked_at) VALUES (?, 'c', 'client', 'r', 'pages:read', '{}', ?, ?)`,
    id,
    expiresAt,
    revokedAt,
  );
}
function access(db, hash, grantId, expiresAt) {
  db.exec(
    `INSERT INTO pages_oauth_access_tokens (token_hash, grant_id, scope, expires_at)
    VALUES (?, ?, 'pages:read', ?)`,
    hash,
    grantId,
    expiresAt,
  );
}
function refresh(db, hash, grantId, expiresAt, consumedBy = null) {
  db.exec(
    `INSERT INTO pages_oauth_refresh_tokens (token_hash, grant_id, scope, expires_at, consumed_by)
    VALUES (?, ?, 'pages:read', ?, ?)`,
    hash,
    grantId,
    expiresAt,
    consumedBy,
  );
}
function code(db, hash, expiresAt, consumedBy = null) {
  db.exec(
    `INSERT INTO pages_oauth_codes (code_hash, context, client_id, redirect_uri, resource, scope,
    challenge, identity_json, expires_at, consumed_by) VALUES (?, 'c', 'client', 'u', 'r',
    'pages:read', 'x', '{}', ?, ?)`,
    hash,
    expiresAt,
    consumedBy,
  );
}
function consent(db, hash, expiresAt) {
  db.exec(
    `INSERT INTO pages_oauth_consents (id_hash, context, session_id, principal, csrf_hash,
    request_json, expires_at) VALUES (?, 'c', 's', 'p', 'h', '{}', ?)`,
    hash,
    expiresAt,
  );
}
function invitation(db, inviteId, expiresAtMs, email = "invitee@example.com") {
  db.exec(
    `INSERT INTO pages_project_invitations (project_id, invite_id, email, namespace, expires_at)
    VALUES ('prj_1', ?, ?, 'user:anaconda', ?)`,
    inviteId,
    email,
    expiresAtMs,
  );
}

test("expired auth rows go and live rows stay", async () => {
  const { db, env } = await fixture();
  login(db, "login-expired", NOW);
  login(db, "login-live", NOW + 60);
  session(db, "session-idle", NOW - 1, NOW + 1000);
  session(db, "session-absolute", NOW + 1000, NOW);
  session(db, "session-live", NOW + 60, NOW + 1000);
  consent(db, "consent-expired", NOW - 1);
  consent(db, "consent-live", NOW + 60);
  grant(db, "grant-expired", NOW - 1);
  grant(db, "grant-live", NOW + 3600);
  access(db, "access-expired", "grant-live", NOW - 1);
  access(db, "access-live", "grant-live", NOW + 60);
  refresh(db, "refresh-expired", "grant-expired", NOW - 1);
  refresh(db, "refresh-live", "grant-live", NOW + 3600);
  code(db, "code-expired", NOW - 1);
  code(db, "code-of-expired-grant", NOW - 1, "grant-expired");
  // Replay evidence: an exchanged code stays while its grant is live.
  code(db, "code-of-live-grant", NOW - 1, "grant-live");
  code(db, "code-live", NOW + 60);
  invitation(db, "invite-expired", NOW_MS);
  invitation(db, "invite-live", NOW_MS + 1);

  const logs = [];
  const state = await runAuthMaintenance(env, { now: NOW_MS, log: (r) => logs.push(r) });

  assert.equal(state.outcome, "complete");
  assert.deepEqual(db.ids("oidc_login_transactions", "state_hash"), ["login-live"]);
  assert.deepEqual(db.ids("oidc_server_sessions", "id"), ["session-live"]);
  assert.deepEqual(db.ids("pages_oauth_consents", "id_hash"), ["consent-live"]);
  assert.deepEqual(db.ids("pages_oauth_grants", "id"), ["grant-live"]);
  assert.deepEqual(db.ids("pages_oauth_access_tokens", "token_hash"), ["access-live"]);
  assert.deepEqual(db.ids("pages_oauth_refresh_tokens", "token_hash"), ["refresh-live"]);
  assert.deepEqual(db.ids("pages_oauth_codes", "code_hash"), ["code-live", "code-of-live-grant"]);
  assert.deepEqual(db.ids("pages_project_invitations", "invite_id"), ["invite-live"]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].rows, 10);
  assert.equal(logs[0].counts.pages_project_invitations, 1);
  assert.equal(logs[0].counts.oidc_server_sessions, 2);
  // Counts and enums only: no row ids, hashes or emails.
  const text = JSON.stringify(logs);
  for (const secret of ["login-expired", "session-idle", "code-expired", "invitee@", "grant-"])
    assert.equal(text.includes(secret), false, secret);
});

test("revoked grants wait out the grace period, then go with their tokens and codes", async () => {
  const { db, env } = await fixture();
  const recent = NOW - REVOKED_GRANT_GRACE_SECONDS + 1;
  const old = NOW - REVOKED_GRANT_GRACE_SECONDS;
  for (const [id, revokedAt] of [
    ["recent", recent],
    ["old", old],
    ["active", null],
  ]) {
    grant(db, id, NOW + 30 * 86400, revokedAt);
    access(db, `${id}-access`, id, NOW + 600);
    refresh(db, `${id}-refresh`, id, NOW + 30 * 86400);
    refresh(db, `${id}-refresh-consumed`, id, NOW + 30 * 86400, "claim");
    code(db, `${id}-code`, NOW - 1, id);
  }

  const state = await runAuthMaintenance(env, { now: NOW_MS, log: quiet });

  assert.equal(state.outcome, "complete");
  assert.deepEqual(db.ids("pages_oauth_grants", "id"), ["active", "recent"]);
  assert.equal(db.count("pages_oauth_access_tokens", "grant_id = 'old'"), 0);
  assert.equal(db.count("pages_oauth_refresh_tokens", "grant_id = 'old'"), 0);
  assert.equal(db.count("pages_oauth_codes", "consumed_by = 'old'"), 0);
  for (const id of ["recent", "active"]) {
    assert.equal(db.count("pages_oauth_access_tokens", `grant_id = '${id}'`), 1);
    assert.equal(db.count("pages_oauth_refresh_tokens", `grant_id = '${id}'`), 2);
    assert.equal(db.count("pages_oauth_codes", `consumed_by = '${id}'`), 1);
  }
  assert.equal(state.counts["revoked:pages_oauth_grants"], 1);
  assert.equal(state.counts["revoked:pages_oauth_refresh_tokens"], 2);
});

test("a revoked grant outlives a run that could not clear all of its tokens", async () => {
  const { db, env } = await fixture();
  grant(db, "old", NOW + 86400, NOW - 2 * REVOKED_GRANT_GRACE_SECONDS);
  for (let i = 0; i < 5; i++) refresh(db, `r${i}`, "old", NOW + 86400, "claim");
  const options = { now: NOW_MS, log: quiet, rowBudget: 3, batchLimit: 3 };

  const first = await runAuthMaintenance(env, options);
  assert.equal(first.outcome, "row_budget");
  assert.equal(db.count("pages_oauth_refresh_tokens"), 2);
  assert.equal(db.count("pages_oauth_grants"), 1, "never orphans the remaining tokens");

  // The grant's turn comes before the refresh tokens' in the second run, so
  // the third run removes the grant once its last tokens are gone.
  await runAuthMaintenance(env, options);
  assert.equal(db.count("pages_oauth_refresh_tokens"), 0);
  assert.equal(db.count("pages_oauth_grants"), 1);
  const third = await runAuthMaintenance(env, options);
  assert.equal(db.count("pages_oauth_grants"), 0);
  assert.deepEqual(third.counts, { "revoked:pages_oauth_grants": 1 });
});

test("the row budget bounds each run and the next run resumes where it stopped", async () => {
  const { db, env } = await fixture();
  for (let i = 0; i < 7; i++) login(db, `login-${i}`, NOW - i);
  for (let i = 0; i < 4; i++) session(db, `session-${i}`, NOW - 1, NOW + 100);
  for (let i = 0; i < 3; i++) invitation(db, `invite-${i}`, NOW_MS - i);
  const logs = [];
  const options = { now: NOW_MS, rowBudget: 5, batchLimit: 2, log: (r) => logs.push(r) };

  const runs = [];
  for (let i = 0; i < 6 && runs.at(-1)?.outcome !== "complete"; i++)
    runs.push(await runAuthMaintenance(env, options));

  assert.deepEqual(
    runs.map((run) => run.outcome),
    ["row_budget", "row_budget", "complete"],
  );
  for (const log of logs) assert.ok(log.rows <= 5, `run deleted ${log.rows}`);
  // Phases take one batch per turn, so the first run reaches the last phase.
  assert.deepEqual(logs[0].counts, {
    oidc_login_transactions: 2,
    oidc_server_sessions: 2,
    pages_project_invitations: 1,
  });
  // It stopped in the invitation phase; the next turn belongs to logins.
  assert.equal(logs[0].next_phase, "oidc_login_transactions");
  assert.equal(db.count("oidc_login_transactions"), 0);
  assert.equal(db.count("oidc_server_sessions"), 0);
  assert.equal(db.count("pages_project_invitations"), 0);
  assert.equal(
    logs.reduce((total, log) => total + log.rows, 0),
    14,
  );
  assert.ok(logs.every((log) => log.cursor === "written"));
});

test("a table with a standing backlog does not starve the phases after it", async () => {
  const db = new SqliteD1();
  const ran = [];
  const phases = [
    { name: "backlog", run: async (_env, { limit }) => (ran.push("backlog"), limit) },
    { name: "small", run: async () => (ran.push("small"), 0) },
  ];
  const state = await runAuthMaintenance(
    { DB: db },
    { now: NOW_MS, phases, rowBudget: 4, batchLimit: 2, log: quiet },
  );
  assert.equal(state.outcome, "row_budget");
  assert.deepEqual(ran, ["backlog", "small", "backlog"]);
});

test("the time budget stops between statements and the next run resumes there", async () => {
  const { db, env } = await fixture();
  for (let i = 0; i < 4; i++) login(db, `login-${i}`, NOW - 1);
  let time = 0;
  const clock = () => (time += 10);
  const first = await runAuthMaintenance(env, {
    now: NOW_MS,
    clock,
    timeBudgetMs: 25,
    batchLimit: 2,
    log: quiet,
  });
  // Deadline 35: logins at t=20, sessions at t=30, stop at t=40.
  assert.equal(first.outcome, "time_budget");
  assert.deepEqual(first.counts, { oidc_login_transactions: 2 });
  assert.equal(first.nextPhase, "revoked:pages_oauth_access_tokens");
  const second = await runAuthMaintenance(env, { now: NOW_MS, batchLimit: 2, log: quiet });
  assert.equal(second.outcome, "complete");
  assert.deepEqual(second.counts, { oidc_login_transactions: 2 });
  assert.equal(db.count("oidc_login_transactions"), 0);
});

test("a failing phase does not stop the others, and the run rejects after logging", async () => {
  const db = new SqliteD1();
  const env = { DB: db };
  const ran = [];
  const phases = ["a", "b", "c"].map((name) => ({
    name,
    run: async () => {
      ran.push(name);
      if (name === "b") throw new Error("D1 said token_hash = 'secret'");
      return name === "c" ? 1 : 0;
    },
  }));
  const logs = [];
  await assert.rejects(
    runAuthMaintenance(env, { now: NOW_MS, phases, log: (r) => logs.push(r) }),
    (error) => error.message === "Auth maintenance failed",
  );
  assert.deepEqual(ran, ["a", "b", "c"]);
  assert.equal(logs[0].outcome, "complete");
  assert.deepEqual(logs[0].failed, { b: "Error" });
  assert.deepEqual(logs[0].counts, { c: 1 });
  assert.equal(JSON.stringify(logs).includes("secret"), false);
});

test("a stale run cannot rewind the cursor", async () => {
  const db = new SqliteD1();
  const env = { DB: db };
  const phases = ["a", "b"].map((name) => ({ name, run: async () => 0 }));
  const logs = [];
  // Another run moves the cursor while this one sweeps.
  phases[0].run = async () => {
    db.exec("UPDATE pages_auth_maintenance SET next_phase = 'b', generation = generation + 1");
    return 0;
  };
  await runAuthMaintenance(env, { now: NOW_MS, phases, log: (r) => logs.push(r) });
  assert.equal(logs[0].cursor, "superseded");
  assert.equal(
    db.sqlite.prepare("SELECT next_phase FROM pages_auth_maintenance").get().next_phase,
    "b",
  );
});

test("the auth sweep machine covers every state and event", async () => {
  const phases = ["a", "b", "c"];
  const run = { phases, batchLimit: 5, settled: [], rowsLeft: 10, counts: {}, failed: {} };
  const deleting = (phase, overrides = {}) => ({
    name: "deleting",
    ...run,
    phase,
    limit: 5,
    ...overrides,
  });
  const del = (phase, limit = 5) => ({ type: "delete", phase, limit });
  const persisting = (outcome, nextPhase, counts = {}, failed = {}) => ({
    name: "persisting",
    outcome,
    nextPhase,
    counts,
    failed,
  });
  const persist = (nextPhase) => ({ type: "persist", nextPhase });
  const start = (phase, rowBudget = 10) => ({
    type: "start",
    phases,
    phase,
    rowBudget,
    batchLimit: 5,
  });
  await runTable(authSweepMachine, [
    {
      case: "sweep",
      label: "a run starts at the cursor's phase with one batch",
      state: { name: "idle" },
      event: start(1),
      expect: { state: deleting(1), effects: [del("b")] },
    },
    {
      case: "no-budget",
      label: "a run without a row budget only writes the cursor back",
      state: { name: "idle" },
      event: start(2, 0),
      expect: { state: persisting("row_budget", "c"), effects: [persist("c")] },
    },
    {
      case: "full-batch",
      label: "a full batch keeps the phase in rotation and passes the turn",
      state: deleting(1),
      event: { type: "deleted", changes: 5 },
      expect: {
        state: deleting(2, { rowsLeft: 5, counts: { b: 5 } }),
        effects: [del("c")],
      },
    },
    {
      case: "drained",
      label: "a short batch settles the phase, and settled phases lose their turn",
      state: deleting(1, { settled: [2] }),
      event: { type: "deleted", changes: 0 },
      expect: {
        state: deleting(0, { settled: [2, 1] }),
        effects: [del("a")],
      },
    },
    {
      case: "all-settled",
      label: "when every phase has drained, the run is complete",
      state: deleting(0, { settled: [1, 2], counts: { b: 3 } }),
      event: { type: "deleted", changes: 2 },
      expect: {
        state: persisting("complete", "a", { a: 2, b: 3 }),
        effects: [persist("a")],
      },
    },
    {
      case: "budget-spent",
      label: "the row budget stops the run and the next turn's phase is saved",
      state: deleting(1, { rowsLeft: 5 }),
      event: { type: "deleted", changes: 5 },
      expect: { state: persisting("row_budget", "c", { b: 5 }), effects: [persist("c")] },
    },
    {
      label: "the time budget stops the run before the due batch",
      state: deleting(1, { counts: { a: 1 } }),
      event: { type: "deadline" },
      expect: { state: persisting("time_budget", "b", { a: 1 }), effects: [persist("b")] },
    },
    {
      case: "others-left",
      label: "a failed batch settles its phase by error name and the others carry on",
      state: deleting(1),
      event: { type: "failed", error: "TypeError" },
      expect: {
        state: deleting(2, { settled: [1], failed: { b: "TypeError" } }),
        effects: [del("c")],
      },
    },
    {
      case: "all-settled",
      label: "a failure in the last open phase completes the run",
      state: deleting(1, { settled: [0, 2] }),
      event: { type: "failed", error: "Error" },
      expect: {
        state: persisting("complete", "a", {}, { b: "Error" }),
        effects: [persist("a")],
      },
    },
    {
      case: "written",
      label: "the cursor write lands",
      state: persisting("complete", "a", { a: 1 }),
      event: { type: "persisted", written: true },
      expect: {
        state: {
          name: "done",
          outcome: "complete",
          nextPhase: "a",
          counts: { a: 1 },
          failed: {},
          cursor: "written",
        },
        effects: [{ type: "report" }],
      },
    },
    {
      case: "superseded",
      label: "a newer run moved the cursor first",
      state: persisting("row_budget", "b"),
      event: { type: "persisted", written: false },
      expect: {
        state: {
          name: "done",
          outcome: "row_budget",
          nextPhase: "b",
          counts: {},
          failed: {},
          cursor: "superseded",
        },
        effects: [{ type: "report" }],
      },
    },
    {
      label: "a failed cursor write is reported",
      state: persisting("time_budget", "b"),
      event: { type: "persistFailed" },
      expect: {
        state: {
          name: "done",
          outcome: "time_budget",
          nextPhase: "b",
          counts: {},
          failed: {},
          cursor: "failed",
        },
        effects: [{ type: "report" }],
      },
    },
  ]);
});

test("scheduled tasks run independently and the handler still reports failure", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(JSON.parse(line)));
  const ran = [];
  const tasks = {
    usage: async () => {
      ran.push("usage");
      throw new Error("usage table missing for user@example.com");
    },
    auth: async () => ran.push("auth"),
  };
  await assert.rejects(
    runScheduled({ cron: USAGE_CRON }, {}, tasks),
    /Scheduled maintenance failed: usage/,
  );
  assert.deepEqual(ran, ["usage", "auth"]);
  assert.deepEqual(warnings, [
    { event: "pages.scheduled_task_failed", task: "usage", error: "Error" },
  ]);

  ran.length = 0;
  tasks.usage = async () => ran.push("usage");
  tasks.auth = async () => {
    ran.push("auth");
    throw new Error("auth");
  };
  await assert.rejects(runScheduled({ cron: USAGE_CRON }, {}, tasks), /failed: auth/);
  assert.deepEqual(ran, ["usage", "auth"]);

  ran.length = 0;
  tasks.auth = async () => ran.push("auth");
  await runScheduled({ cron: AUTH_CRON }, {}, tasks);
  assert.deepEqual(ran, ["auth"], "the hourly cron skips the daily usage rollup");
});

test("cron selection keeps the daily usage rollup on any non-auth trigger", () => {
  assert.deepEqual(scheduledTasks(USAGE_CRON), { usage: true, auth: true });
  assert.deepEqual(scheduledTasks(AUTH_CRON), { usage: false, auth: true });
  assert.deepEqual(scheduledTasks(undefined), { usage: true, auth: true });
});

test("a Worker without the auth database skips the sweep", async () => {
  const state = await runAuthMaintenance({}, { log: quiet });
  assert.equal(state.outcome, "unavailable");
});
