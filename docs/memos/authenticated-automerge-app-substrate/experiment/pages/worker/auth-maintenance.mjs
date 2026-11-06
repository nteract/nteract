// Scheduled sweep of expired and revoked auth rows in the auth D1 (env.DB).
//
// Request paths clean up only opportunistically: OAuth expiry runs when a
// consent or code is issued, and sign-in rows when a login starts. This sweep
// covers the rest on the cron. Each run has a row and a time budget. A
// persisted cursor names the phase the last run stopped in, so the next run
// starts there and a backlog in one table never starves the others.
//
// Every row deleted here is one that the request paths already refuse:
// expired sign-in rows, expired OAuth rows (with the replay-evidence rule of
// cleanupOAuthStore), rows of grants revoked more than REVOKED_GRANT_GRACE_SECONDS
// ago, and invitation index rows past their expiry.
import { deleteExpiredOidcRows } from "@cloud/oidc-session-store.ts";
import {
  cleanupOAuthTable,
  deleteRevokedGrantRows,
  OAUTH_EXPIRY_TABLES,
  OAUTH_REVOKED_TABLES,
} from "./oauth-store.mjs";
import { deleteExpiredProjectInvitations } from "./project-invitations.mjs";
import { defineMachine } from "../shared/machine.mjs";

/** Revoked grants and their tokens and codes stay this long before deletion. */
export const REVOKED_GRANT_GRACE_SECONDS = 60 * 60;
/** Rows deleted per run, across all phases. */
export const AUTH_SWEEP_ROW_BUDGET = 5000;
/** Rows one statement may delete. */
export const AUTH_SWEEP_BATCH_LIMIT = 500;
/** Wall time per run. Checked between statements; one statement is not interrupted. */
export const AUTH_SWEEP_TIME_BUDGET_MS = 15_000;

const seconds = (ms) => Math.floor(ms / 1000);

/** Each phase deletes up to `limit` rows from one table and returns the count. */
export const AUTH_SWEEP_PHASES = Object.freeze([
  {
    name: "oidc_login_transactions",
    run: (env, { now, limit }) =>
      deleteExpiredOidcRows(env, "oidc_login_transactions", seconds(now), limit),
  },
  {
    name: "oidc_server_sessions",
    run: (env, { now, limit }) =>
      deleteExpiredOidcRows(env, "oidc_server_sessions", seconds(now), limit),
  },
  ...OAUTH_REVOKED_TABLES.map((table) => ({
    name: `revoked:${table}`,
    run: (env, { now, limit }) =>
      deleteRevokedGrantRows(env, table, {
        revokedBefore: Math.max(0, seconds(now) - REVOKED_GRANT_GRACE_SECONDS),
        limit,
      }),
  })),
  ...OAUTH_EXPIRY_TABLES.map((table) => ({
    name: `expired:${table}`,
    run: (env, { now, limit }) => cleanupOAuthTable(env, table, { now: seconds(now), limit }),
  })),
  {
    name: "pages_project_invitations",
    run: (env, { now, limit }) => deleteExpiredProjectInvitations(env, { now, limit }),
  },
]);

/**
 * One sweep run.
 *
 * States:
 * - idle: not started.
 * - deleting: one batch of `phase` (up to `limit` rows) is due or running.
 * - persisting: the cursor write for `nextPhase` is running.
 * - done: terminal. `outcome` is "complete" (every phase settled),
 *   "row_budget" or "time_budget"; `cursor` is "written", "superseded" or
 *   "failed".
 *
 * Phases take turns. Each turn deletes at most one batch, then passes to the
 * next phase that is not settled. A phase settles when a batch comes back
 * short (drained) or fails; a failure is recorded by error name and the other
 * phases carry on. `nextPhase` is where the following run starts, so a table
 * with a standing backlog never starves the others.
 *
 * Events: `start`, `deleted` (the batch's row count), `failed` (the batch's
 * error name), `deadline` (the time budget ran out before the batch started),
 * `persisted` (the fenced cursor write applied or lost to a newer run),
 * `persistFailed`.
 *
 * Effects: `delete` a batch, `persist` the cursor, `report` the finished run.
 */
export const authSweepMachine = defineMachine({
  name: "auth-sweep",
  states: ["idle", "deleting", "persisting", "done"],
  events: ["start", "deleted", "failed", "deadline", "persisted", "persistFailed"],
  initial: { name: "idle" },
  unreachable: [
    ...["deleted", "failed", "deadline", "persisted", "persistFailed"].map((event) => [
      "idle",
      event,
      "nothing runs before the sweep starts",
    ]),
    ["deleting", "start", "a run starts once"],
    ["deleting", "persisted", "the cursor is written only after deleting stops"],
    ["deleting", "persistFailed", "the cursor is written only after deleting stops"],
    ...["start", "deleted", "failed", "deadline"].map((event) => [
      "persisting",
      event,
      "no batch runs while the cursor is written",
    ]),
    ...["start", "deleted", "failed", "deadline", "persisted", "persistFailed"].map((event) => [
      "done",
      event,
      "a finished run takes no events",
    ]),
  ],
  cases: {
    "idle/start": ["sweep", "no-budget"],
    "deleting/deleted": ["full-batch", "drained", "all-settled", "budget-spent"],
    "deleting/failed": ["others-left", "all-settled"],
    "persisting/persisted": ["written", "superseded"],
  },
  validate: {
    events: {
      start: (event) => {
        names(event.phases);
        if (!(event.phase >= 0 && event.phase < event.phases.length)) throw Error("bad phase");
        if (!Number.isSafeInteger(event.rowBudget)) throw Error("bad rowBudget");
        if (!(Number.isSafeInteger(event.batchLimit) && event.batchLimit >= 1))
          throw Error("bad batchLimit");
      },
      deleted: (event) => {
        if (!(Number.isSafeInteger(event.changes) && event.changes >= 0))
          throw Error("bad changes");
      },
      failed: (event) => {
        if (typeof event.error !== "string") throw Error("an error name is required");
      },
      persisted: (event) => {
        if (typeof event.written !== "boolean") throw Error("written is required");
      },
    },
  },
  transition(state, event) {
    switch (state.name) {
      case "idle": {
        const run = {
          phases: event.phases,
          batchLimit: event.batchLimit,
          settled: [],
          rowsLeft: event.rowBudget,
          counts: {},
          failed: {},
        };
        if (event.rowBudget < 1)
          return persist({ ...run, phase: event.phase }, "row_budget", event.phase);
        return turn(run, event.phase);
      }
      case "deleting": {
        if (event.type === "deadline") return persist(state, "time_budget", state.phase);
        const name = state.phases[state.phase];
        const run =
          event.type === "deleted"
            ? {
                ...state,
                rowsLeft: state.rowsLeft - event.changes,
                counts: event.changes
                  ? { ...state.counts, [name]: (state.counts[name] ?? 0) + event.changes }
                  : state.counts,
                settled:
                  event.changes < state.limit ? [...state.settled, state.phase] : state.settled,
              }
            : {
                ...state,
                settled: [...state.settled, state.phase],
                failed: { ...state.failed, [name]: event.error },
              };
        if (run.settled.length >= run.phases.length) return persist(run, "complete", 0);
        let phase = state.phase;
        do phase = (phase + 1) % run.phases.length;
        while (run.settled.includes(phase));
        if (run.rowsLeft <= 0) return persist(run, "row_budget", phase);
        return turn(run, phase);
      }
      case "persisting": {
        const cursor =
          event.type === "persistFailed" ? "failed" : event.written ? "written" : "superseded";
        const { outcome, nextPhase, counts, failed } = state;
        return {
          state: { name: "done", outcome, nextPhase, counts, failed, cursor },
          effects: [{ type: "report" }],
        };
      }
    }
  },
});
function names(phases) {
  if (!Array.isArray(phases) || !phases.length || phases.some((p) => typeof p !== "string"))
    throw Error("phases must be non-empty names");
}
function turn(run, phase) {
  const limit = Math.min(run.batchLimit, run.rowsLeft);
  const { phases, batchLimit, settled, rowsLeft, counts, failed } = run;
  return {
    state: {
      name: "deleting",
      phases,
      batchLimit,
      phase,
      limit,
      settled,
      rowsLeft,
      counts,
      failed,
    },
    effects: [{ type: "delete", phase: phases[phase], limit }],
  };
}
function persist(run, outcome, phase) {
  const nextPhase = run.phases[phase];
  return {
    state: { name: "persisting", outcome, nextPhase, counts: run.counts, failed: run.failed },
    effects: [{ type: "persist", nextPhase }],
  };
}
// Error names only: D1 messages can quote statement text.
const errorKind = (error) => (error instanceof Error ? error.name : "unknown");

// The cursor row is fenced by generation, so a stale run cannot rewind a
// newer run's position. celld serializes one script's cron handlers, but a
// manual or overlapping invocation stays safe.
async function cursorDatabase(env) {
  const db = env.DB;
  if (!db?.prepare || !db.batch) return null;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS pages_auth_maintenance (
      id INTEGER PRIMARY KEY CHECK (id = 1), next_phase TEXT NOT NULL,
      generation INTEGER NOT NULL)`),
    db.prepare(
      `INSERT OR IGNORE INTO pages_auth_maintenance (id, next_phase, generation) VALUES (1, '', 0)`,
    ),
  ]);
  return db;
}
async function readCursor(db, phases) {
  const row = await db
    .prepare("SELECT next_phase, generation FROM pages_auth_maintenance WHERE id = 1")
    .first();
  // An unknown name (a renamed or removed phase) starts from the beginning.
  const index = phases.findIndex((phase) => phase.name === row?.next_phase);
  return { phase: Math.max(0, index), generation: row?.generation ?? 0 };
}
async function writeCursor(db, nextPhase, generation) {
  const result = await db
    .prepare(
      `UPDATE pages_auth_maintenance SET next_phase = ?, generation = generation + 1
      WHERE id = 1 AND generation = ?`,
    )
    .bind(nextPhase, generation)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * Runs one bounded sweep: the interpreter for authSweepMachine. Logs counts,
 * phase names and outcome enums only, and resolves with the done state. When
 * a phase or the cursor write failed, it rejects after the log is written, so
 * the cron's retry sees the failure.
 */
export async function runAuthMaintenance(
  env,
  {
    now = Date.now(),
    clock = Date.now,
    phases = AUTH_SWEEP_PHASES,
    rowBudget = AUTH_SWEEP_ROW_BUDGET,
    batchLimit = AUTH_SWEEP_BATCH_LIMIT,
    timeBudgetMs = AUTH_SWEEP_TIME_BUDGET_MS,
    log = (record) => console.log(JSON.stringify(record)),
  } = {},
) {
  const db = await cursorDatabase(env);
  if (!db) return { name: "done", outcome: "unavailable", counts: {}, failed: {} };
  const cursor = await readCursor(db, phases);
  const byName = new Map(phases.map((phase) => [phase.name, phase]));
  const deadline = clock() + timeBudgetMs;
  let state = authSweepMachine.initial;
  let pending = [
    {
      type: "start",
      phases: phases.map((phase) => phase.name),
      phase: cursor.phase,
      rowBudget,
      batchLimit,
    },
  ];
  while (pending.length) {
    const result = authSweepMachine.step(state, pending.shift());
    state = result.state;
    for (const effect of result.effects) pending.push(await perform(effect));
    pending = pending.filter(Boolean);
  }
  return state;

  async function perform(effect) {
    switch (effect.type) {
      case "delete":
        if (clock() >= deadline) return { type: "deadline" };
        try {
          const changes = await byName.get(effect.phase).run(env, { now, limit: effect.limit });
          return { type: "deleted", changes };
        } catch (error) {
          return { type: "failed", error: errorKind(error) };
        }
      case "persist":
        try {
          return {
            type: "persisted",
            written: await writeCursor(db, effect.nextPhase, cursor.generation),
          };
        } catch {
          return { type: "persistFailed" };
        }
      case "report": {
        const rows = Object.values(state.counts).reduce((total, count) => total + count, 0);
        log({
          event: "pages.auth_maintenance",
          outcome: state.outcome,
          rows,
          counts: state.counts,
          next_phase: state.nextPhase,
          cursor: state.cursor,
          failed: state.failed,
        });
        if (Object.keys(state.failed).length || state.cursor === "failed")
          throw new Error("Auth maintenance failed");
        return null;
      }
    }
  }
}
