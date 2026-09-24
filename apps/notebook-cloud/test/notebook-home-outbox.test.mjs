import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { before, beforeEach, test } from "node:test";
import { NOTEBOOK_HOME_SCHEMA } from "../src/notebook-home-schema.ts";
import { drainNotebookHomeOutbox } from "../src/notebook-home-outbox.ts";
import {
  createNotebookWithOwnerAcl,
  ensureCatalogSchema,
  grantNotebookAclRow,
  revokeNotebookAclRow,
  updateNotebookTitle,
} from "../src/storage.ts";

// Run the actual SQL and transactions. A query-string fake cannot establish
// that a mutation and its notification commit or roll back together.
const sqlite = new DatabaseSync(":memory:");
function statement(sql, values = []) {
  return {
    bind: (...args) => statement(sql, args),
    async run() {
      return { success: true, meta: sqlite.prepare(sql).run(...values) };
    },
    async all() {
      return { success: true, meta: {}, results: sqlite.prepare(sql).all(...values) };
    },
    async first(column) {
      const row = sqlite.prepare(sql).get(...values);
      return column ? (row?.[column] ?? null) : (row ?? null);
    },
  };
}
const env = {
  DB: {
    prepare: statement,
    async exec(sql) {
      sqlite.exec(sql);
      return { success: true, meta: {} };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const entry of statements) results.push(await entry.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  },
};
const owner = { principal: "alice", actorLabel: "alice/browser" };
const grant = (subject, scope = "viewer") => ({
  notebookId: "nb",
  subjectKind: "principal",
  subject,
  scope,
  actorLabel: "alice/browser",
});
const pending = () =>
  sqlite.prepare("SELECT principal, change_id FROM notebook_home_outbox ORDER BY principal").all();
const clear = () => sqlite.exec("DELETE FROM notebook_home_outbox");
before(() => ensureCatalogSchema(env));
beforeEach(() => {
  sqlite.exec(
    "DELETE FROM notebook_acl; DELETE FROM notebooks; DELETE FROM principal_account_links;",
  );
  clear();
  delete env.NOTEBOOK_HOME;
});

test("migration and lazy schema initialization install the same triggers", async () => {
  const migration = await readFile(
    new URL("../migrations/0009_notebook_home.sql", import.meta.url),
    "utf8",
  );
  assert.equal(
    migration.slice(migration.indexOf("\n") + 1),
    NOTEBOOK_HOME_SCHEMA.join(";\n\n") + ";\n",
  );
});

test("create, grant, rename, and revoke enqueue the affected principals", async () => {
  await createNotebookWithOwnerAcl(env, "nb", owner, { title: "First" });
  assert.deepEqual(
    pending().map((row) => row.principal),
    ["alice"],
  );
  clear();
  await grantNotebookAclRow(env, grant("bob"));
  assert.deepEqual(
    pending().map((row) => row.principal),
    ["bob"],
  );
  clear();
  await updateNotebookTitle(env, "nb", "Second");
  assert.deepEqual(
    pending().map((row) => row.principal),
    ["alice", "bob"],
  );
  const versions = pending();
  await updateNotebookTitle(env, "nb", "Second");
  assert.deepEqual(pending(), versions, "no-op writes should not wake dashboards");
  clear();
  await revokeNotebookAclRow(env, grant("bob"));
  assert.deepEqual(
    pending().map((row) => row.principal),
    ["bob"],
  );
  clear();
  await updateNotebookTitle(env, "nb", "Third");
  assert.deepEqual(
    pending().map((row) => row.principal),
    ["alice"],
    "revoked users receive no later notifications",
  );
});

test("linked transport principals receive canonical-account changes and unlinking", async () => {
  await createNotebookWithOwnerAcl(env, "nb", owner);
  sqlite.exec(
    "INSERT INTO principal_account_links (transport_principal, canonical_principal, provider) VALUES ('transport-alice', 'alice', 'oidc')",
  );
  assert.ok(pending().some((row) => row.principal === "transport-alice"));
  clear();
  await updateNotebookTitle(env, "nb", "Linked");
  assert.deepEqual(
    pending().map((row) => row.principal),
    ["alice", "transport-alice"],
  );
  clear();
  sqlite.exec("DELETE FROM principal_account_links WHERE transport_principal='transport-alice'");
  assert.deepEqual(
    pending().map((row) => row.principal),
    ["transport-alice"],
  );
});

test("rollback removes the invalidation along with the catalog change", async () => {
  await createNotebookWithOwnerAcl(env, "nb", owner, { title: "Before" });
  clear();
  await assert.rejects(
    env.DB.batch([
      statement("UPDATE notebooks SET title='After' WHERE id='nb'"),
      statement("INSERT INTO missing_table VALUES (1)"),
    ]),
  );
  assert.equal(sqlite.prepare("SELECT title FROM notebooks").get().title, "Before");
  assert.deepEqual(pending(), []);
});

test("failed delivery remains pending and a successful retry acknowledges it", async () => {
  await createNotebookWithOwnerAcl(env, "nb", owner);
  let fail = true;
  const recipients = [];
  env.NOTEBOOK_HOME = {
    idFromName: (name) => name,
    get: (name) => ({
      fetch: async () => {
        recipients.push(name);
        return new Response(null, { status: fail ? 503 : 200 });
      },
    }),
  };
  await drainNotebookHomeOutbox(env);
  assert.equal(pending().length, 1);
  fail = false;
  sqlite.exec("UPDATE notebook_home_outbox SET queued_at = 0");
  await drainNotebookHomeOutbox(env);
  assert.deepEqual(pending(), []);
  assert.deepEqual(recipients, ["alice", "alice"]);
});

test("acknowledging an older delivery cannot erase a concurrent change", async () => {
  await createNotebookWithOwnerAcl(env, "nb", owner);
  const before = pending()[0].change_id;
  env.NOTEBOOK_HOME = {
    idFromName: (name) => name,
    get: () => ({
      fetch: async () => {
        await updateNotebookTitle(env, "nb", "Concurrent");
        return new Response();
      },
    }),
  };
  await drainNotebookHomeOutbox(env);
  assert.equal(pending().length, 1);
  assert.notEqual(pending()[0].change_id, before);
});
