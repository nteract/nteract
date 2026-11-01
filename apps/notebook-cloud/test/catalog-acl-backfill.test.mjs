// The owner and public ACL backfills run once per database, recorded in
// catalog_backfills, so schema initialization never re-grants access an owner
// revoked. Runs the real catalog SQL on SQLite: a query-string fake cannot show
// that the decision and the inserts commit together.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  CATALOG_SCHEMA_ATTEMPT_MS,
  ensureCatalogSchema,
  NOTEBOOK_ACL_PUBLIC_BACKFILL,
  revokeNotebookAclRow,
} from "../src/storage.ts";
import { deferred, turns, virtualTime } from "./settled-lookup-helpers.ts";

/**
 * A D1 binding over one SQLite database. Each binding is a distinct object, so
 * a new binding over the same database stands in for a cold isolate: the
 * schema cache is keyed by binding. While `gate` is set, each statement waits
 * for it before it runs.
 */
function binding(sqlite) {
  const control = { gate: undefined, batches: 0 };
  const statement = (sql, values = []) => ({
    bind: (...args) => statement(sql, args),
    async run() {
      const gate = control.gate;
      if (gate) await gate;
      return { success: true, meta: sqlite.prepare(sql).run(...values) };
    },
    async all() {
      const gate = control.gate;
      if (gate) await gate;
      return { success: true, meta: {}, results: sqlite.prepare(sql).all(...values) };
    },
    async first(column) {
      const row = sqlite.prepare(sql).get(...values);
      return column ? (row?.[column] ?? null) : (row ?? null);
    },
  });
  const db = {
    prepare: (sql) => statement(sql),
    async exec(sql) {
      sqlite.exec(sql);
      return { success: true, meta: {} };
    },
    async batch(statements) {
      const gate = control.gate;
      if (gate) await gate;
      control.batches++;
      sqlite.exec("BEGIN");
      try {
        const results = [];
        // Statements were prepared ungated; run them inside this transaction.
        for (const entry of statements) results.push(await entry.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { env: { DB: db }, control };
}

const PUBLIC_VIEWER = {
  notebookId: "published",
  subjectKind: "public",
  subject: "anonymous",
  scope: "viewer",
};

function publicRows(sqlite, notebookId = "published") {
  return sqlite
    .prepare(
      `SELECT COUNT(*) AS count FROM notebook_acl
        WHERE notebook_id = ? AND subject_kind = 'public'`,
    )
    .get(notebookId).count;
}

function owners(sqlite, notebookId = "published") {
  return sqlite
    .prepare(
      `SELECT subject FROM notebook_acl
        WHERE notebook_id = ? AND subject_kind = 'principal' AND scope = 'owner'
        ORDER BY subject`,
    )
    .all(notebookId)
    .map((row) => row.subject);
}

function outcomes(sqlite) {
  const rows = sqlite.prepare(`SELECT id, outcome FROM catalog_backfills`).all();
  return Object.fromEntries(rows.map((row) => [row.id, row.outcome]));
}

/** A published notebook, as a fresh deployment's create and publish write it. */
async function currentDeployment() {
  const sqlite = new DatabaseSync(":memory:");
  await ensureCatalogSchema(binding(sqlite).env);
  sqlite.exec(`
    INSERT INTO notebooks (id, owner_principal, latest_revision_id) VALUES ('published', 'user:alice', 'rev-1');
    INSERT INTO notebook_acl (notebook_id, subject_kind, subject, scope, created_by_actor_label)
      VALUES ('published', 'principal', 'user:alice', 'owner', 'user:alice/browser'),
             ('published', 'public', 'anonymous', 'viewer', 'user:alice/browser');
  `);
  return sqlite;
}

/** A published notebook from before notebook_acl: no ACL rows, no markers. */
async function legacyDeployment() {
  const sqlite = new DatabaseSync(":memory:");
  await ensureCatalogSchema(binding(sqlite).env);
  sqlite.exec(`
    DELETE FROM catalog_backfills;
    INSERT INTO notebooks (id, owner_principal, latest_revision_id) VALUES ('published', 'user:alice', 'rev-1');
  `);
  return sqlite;
}

describe("notebook ACL backfill", () => {
  it("records the public backfill once on a new database", async () => {
    const sqlite = new DatabaseSync(":memory:");
    await ensureCatalogSchema(binding(sqlite).env);
    assert.deepEqual(outcomes(sqlite), { [NOTEBOOK_ACL_PUBLIC_BACKFILL]: "applied" });
  });

  it("keeps revoked public access revoked when a new isolate initializes the schema", async () => {
    const sqlite = await currentDeployment();
    const first = binding(sqlite);
    assert.equal(await revokeNotebookAclRow(first.env, PUBLIC_VIEWER), true);
    assert.equal(publicRows(sqlite), 0);

    await ensureCatalogSchema(binding(sqlite).env);
    assert.equal(publicRows(sqlite), 0, "a cold isolate does not re-grant public access");
  });

  it("backfills a legacy database once, then never again", async () => {
    const sqlite = await legacyDeployment();
    const first = binding(sqlite);
    await ensureCatalogSchema(first.env);
    assert.deepEqual(owners(sqlite), ["user:alice"]);
    assert.equal(publicRows(sqlite), 1);
    assert.deepEqual(outcomes(sqlite), { [NOTEBOOK_ACL_PUBLIC_BACKFILL]: "applied" });

    await revokeNotebookAclRow(first.env, PUBLIC_VIEWER);
    await ensureCatalogSchema(binding(sqlite).env);
    assert.equal(publicRows(sqlite), 0);
  });

  it("records the public backfill as skipped on a database that ran it before markers existed", async () => {
    const sqlite = await currentDeployment();
    const first = binding(sqlite);
    await revokeNotebookAclRow(first.env, PUBLIC_VIEWER);
    // A deployment from before catalog_backfills: ACL rows, no markers.
    sqlite.exec(`DELETE FROM catalog_backfills`);

    await ensureCatalogSchema(binding(sqlite).env);
    assert.equal(publicRows(sqlite), 0, "existing ACL rows mean the public backfill already ran");
    assert.deepEqual(owners(sqlite), ["user:alice"]);
    assert.deepEqual(outcomes(sqlite), { [NOTEBOOK_ACL_PUBLIC_BACKFILL]: "skipped" });
  });

  it("repairs a missing owner row in a mixed catalog without re-granting revoked access", async () => {
    const sqlite = await currentDeployment();
    const first = binding(sqlite);
    await revokeNotebookAclRow(first.env, PUBLIC_VIEWER);
    // Notebook B has an owner_principal but no ACL rows at all, beside A's.
    sqlite.exec(`
      DELETE FROM catalog_backfills;
      INSERT INTO notebooks (id, owner_principal, latest_revision_id) VALUES ('legacy', 'user:bob', 'rev-2');
    `);

    await ensureCatalogSchema(binding(sqlite).env);
    assert.deepEqual(owners(sqlite, "legacy"), ["user:bob"], "B gets its owner row");
    assert.equal(publicRows(sqlite), 0, "A's revoked public row stays revoked");
    assert.equal(publicRows(sqlite, "legacy"), 0, "the public backfill stays skipped");
    assert.deepEqual(owners(sqlite), ["user:alice"]);

    // The repair runs on every setup and stays idempotent.
    await ensureCatalogSchema(binding(sqlite).env);
    assert.deepEqual(owners(sqlite, "legacy"), ["user:bob"]);
  });

  it("does not re-grant an owner removed after a transfer", async () => {
    const sqlite = await currentDeployment();
    const first = binding(sqlite);
    sqlite.exec(`
      INSERT INTO notebook_acl (notebook_id, subject_kind, subject, scope, created_by_actor_label)
        VALUES ('published', 'principal', 'user:yan', 'owner', 'user:alice/browser');
    `);
    const removeAlice = {
      notebookId: "published",
      subjectKind: "principal",
      subject: "user:alice",
      scope: "owner",
    };
    assert.equal(await revokeNotebookAclRow(first.env, removeAlice), true);
    // owner_principal still names alice, the owner before the transfer.

    await ensureCatalogSchema(binding(sqlite).env);
    assert.deepEqual(owners(sqlite), ["user:yan"]);
  });

  it("an abandoned attempt that resumes after a revoke does not re-grant access", async (t) => {
    const sqlite = await legacyDeployment();
    virtualTime(t);
    const { env, control } = binding(sqlite);

    // Attempt A stalls on its first statement.
    const stall = deferred();
    control.gate = stall.promise;
    const attemptA = ensureCatalogSchema(env);
    await turns();
    control.gate = undefined;

    // A passes its deadline; attempt B runs the schema and the backfill.
    t.mock.timers.tick(CATALOG_SCHEMA_ATTEMPT_MS);
    await assert.rejects(attemptA, /timed out/);
    await ensureCatalogSchema(env);
    assert.equal(publicRows(sqlite), 1);

    // The owner revokes public access, then A resumes and runs to the end.
    assert.equal(await revokeNotebookAclRow(env, PUBLIC_VIEWER), true);
    stall.resolve();
    await turns(200);
    assert.equal(control.batches, 2, "A ran its backfill batch after resuming");
    assert.equal(publicRows(sqlite), 0, "the resumed attempt does not re-grant public access");
    assert.deepEqual(outcomes(sqlite), { [NOTEBOOK_ACL_PUBLIC_BACKFILL]: "applied" });
  });
});
