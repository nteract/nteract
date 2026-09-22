import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, beforeEach, afterEach, describe, it } from "node:test";
import type { Env } from "../src/cloudflare-types.ts";
import type { AuthenticatedConnection } from "../src/identity.ts";
import { ensureCatalogSchema } from "../src/storage.ts";
import {
  hideCollaborator,
  listHiddenCollaborators,
  recordPrivateNotebookParticipation,
  resolveCollaborator,
  searchCollaborators,
  unhideCollaborator,
} from "../src/collaborator-suggestions.ts";
import { SqliteD1 } from "./sqlite-d1.ts";
import worker from "../src/index.ts";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";

const db = new SqliteD1();
const env: Env = {
  DB: db,
  NOTEBOOK_ROOMS: {
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: async () => new Response() }),
  },
};
function person(name: string, namespace = "example"): AuthenticatedConnection {
  const principal = `user:${namespace}:${name}`;
  return {
    principal,
    actorLabel: `${principal}/browser:test`,
    operator: "browser:test",
    scope: "viewer",
    metadata: {
      provider: "oidc",
      principalNamespace: `user:${namespace}`,
      transport: "oidc-bearer",
      displayName: name,
    },
  };
}
const alice = person("alice");
const bob = person("bob");
async function seed(notebookId = "private", a = alice, b = bob) {
  await db
    .prepare("INSERT INTO notebooks (id, owner_principal) VALUES (?, ?)")
    .bind(notebookId, a.principal)
    .run();
  for (const p of [a, b]) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO principal_profiles (principal, provider, display_name) VALUES (?, 'oidc', ?)",
      )
      .bind(p.principal, p.metadata.displayName ?? "Person")
      .run();
    await db
      .prepare(
        "INSERT INTO notebook_acl (notebook_id, subject_kind, subject, scope, created_by_actor_label) VALUES (?, 'principal', ?, ?, 'test')",
      )
      .bind(notebookId, p.principal, p === a ? "owner" : "editor")
      .run();
  }
}
async function joinBoth(notebookId = "private", a = alice, b = bob) {
  await recordPrivateNotebookParticipation(env, a, notebookId);
  await recordPrivateNotebookParticipation(env, b, notebookId);
}
async function publicNotebook(notebookId: string) {
  await db
    .prepare(
      "INSERT INTO notebook_acl (notebook_id, subject_kind, subject, scope, created_by_actor_label) VALUES (?, 'public', 'anonymous', 'viewer', 'test')",
    )
    .bind(notebookId)
    .run();
}
before(async () => {
  await initializeTestRuntimedWasm();
  await ensureCatalogSchema(env);
});
beforeEach(async () => {
  await db.exec("SAVEPOINT test");
});
afterEach(async () => {
  await db.exec("ROLLBACK TO test; RELEASE test");
});

describe("accepted private collaboration discovery", () => {
  it("applies the portable migration idempotently", async () => {
    const isolated = new SqliteD1();
    await isolated.exec("CREATE TABLE notebooks (id TEXT PRIMARY KEY)");
    const sql = await readFile(
      new URL("../migrations/0009_people_discovery.sql", import.meta.url),
      "utf8",
    );
    await isolated.exec(sql);
    await isolated.exec(sql);
    const rows = await isolated
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    assert.deepEqual(
      rows.results?.map((row) => row.name),
      [
        "notebooks",
        "people_discovery_people",
        "people_suggestion_suppressions",
        "private_notebook_participants",
      ],
    );
  });
  it("requires both successful private participants with current explicit ACLs and returns only opaque name data", async () => {
    await seed();
    assert.deepEqual(await searchCollaborators(env, alice, ""), []);
    await recordPrivateNotebookParticipation(env, bob, "private");
    assert.deepEqual(await searchCollaborators(env, alice, ""), []);
    db.statements = 0;
    await recordPrivateNotebookParticipation(env, alice, "private");
    assert.equal(db.statements, 2, "join writes exactly two statements, independent of peer count");
    const results = await searchCollaborators(env, alice, "bo");
    assert.equal(results.length, 1);
    assert.deepEqual(Object.keys(results[0]).sort(), ["avatarUrl", "displayName", "id", "source"]);
    assert.equal(results[0].displayName, "bob");
    assert.equal(await resolveCollaborator(env, alice, results[0].id), bob.principal);
    assert.deepEqual(await searchCollaborators(env, alice, "%"), []);
    await db.prepare("DELETE FROM notebook_acl WHERE subject = ?").bind(bob.principal).run();
    assert.deepEqual(await searchCollaborators(env, alice, ""), []);
    assert.equal(await resolveCollaborator(env, alice, results[0].id), null);
  });

  it("does not count public co-visits, runtime peers, invite-only users, or revoked callers", async () => {
    await seed();
    await publicNotebook("private");
    await joinBoth();
    await db.prepare("DELETE FROM notebook_acl WHERE subject_kind = 'public'").run();
    assert.deepEqual(await searchCollaborators(env, alice, ""), []);
    await recordPrivateNotebookParticipation(env, { ...alice, scope: "runtime_peer" }, "private");
    await recordPrivateNotebookParticipation(env, bob, "private");
    assert.deepEqual(await searchCollaborators(env, alice, ""), []);
    await recordPrivateNotebookParticipation(env, alice, "private");
    const [target] = await searchCollaborators(env, alice, "");
    assert.ok(target);
    await publicNotebook("private");
    assert.equal(await resolveCollaborator(env, alice, target.id), null);
    await db
      .prepare("DELETE FROM notebook_acl WHERE subject_kind = 'public' OR subject = ?")
      .bind(alice.principal)
      .run();
    assert.deepEqual(await searchCollaborators(env, alice, ""), []);
  });

  it("persists bilateral suppression, only undoes owned rows, and redacts hidden people after access removal", async () => {
    await seed();
    await joinBoth();
    const [bobResult] = await searchCollaborators(env, alice, "");
    const [aliceResult] = await searchCollaborators(env, bob, "");
    const hidden = await hideCollaborator(env, alice, bobResult.id);
    assert.ok(hidden);
    assert.equal(await hideCollaborator(env, alice, bobResult.id), hidden);
    assert.deepEqual(await searchCollaborators(env, alice, ""), []);
    assert.deepEqual(await searchCollaborators(env, bob, ""), []);
    assert.equal(await resolveCollaborator(env, alice, bobResult.id), null);
    await joinBoth();
    assert.deepEqual(await searchCollaborators(env, alice, ""), []);
    const peerHidden = await hideCollaborator(env, bob, aliceResult.id);
    assert.ok(peerHidden);
    await unhideCollaborator(env, bob, hidden);
    assert.equal((await listHiddenCollaborators(env, alice, null)).hidden.length, 1);
    await unhideCollaborator(env, alice, hidden);
    assert.deepEqual(await searchCollaborators(env, alice, ""), []);
    await db.prepare("DELETE FROM notebook_acl WHERE subject = ?").bind(alice.principal).run();
    assert.equal(
      (await listHiddenCollaborators(env, bob, null)).hidden[0].displayName,
      "Hidden person",
    );
    await unhideCollaborator(env, bob, peerHidden);
    assert.deepEqual(await listHiddenCollaborators(env, bob, null), {
      hidden: [],
      nextCursor: null,
    });
  });

  it("follows explicit canonical account aliases without joining equal emails across namespaces", async () => {
    await seed();
    await joinBoth();
    const [target] = await searchCollaborators(env, alice, "");
    const hidden = await hideCollaborator(env, alice, target.id);
    assert.ok(hidden);
    const alternate = person("alice", "other");
    await db
      .prepare(
        "UPDATE principal_profiles SET email_normalized = 'same@example.com', email_verified = 1",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO principal_profiles (principal, provider, email_normalized, email_verified) VALUES (?, 'oidc', 'same@example.com', 1)",
      )
      .bind(alternate.principal)
      .run();
    assert.deepEqual(await listHiddenCollaborators(env, alternate, null), {
      hidden: [],
      nextCursor: null,
    });
    for (const p of [alice, alternate])
      await db
        .prepare(
          "INSERT INTO principal_account_links (transport_principal, canonical_principal, provider) VALUES (?, 'account:alice', 'oidc')",
        )
        .bind(p.principal)
        .run();
    await db
      .prepare("UPDATE notebook_acl SET subject = 'account:alice' WHERE subject = ?")
      .bind(alice.principal)
      .run();
    assert.equal((await listHiddenCollaborators(env, alternate, null)).hidden[0].id, hidden);
    assert.deepEqual(await searchCollaborators(env, alternate, ""), []);
    await unhideCollaborator(env, alternate, hidden);
    assert.equal((await searchCollaborators(env, alternate, ""))[0].id, target.id);
    await db
      .prepare(
        "INSERT INTO principal_account_links (transport_principal, canonical_principal, provider) VALUES (?, 'account:bob', 'oidc')",
      )
      .bind(bob.principal)
      .run();
    await db
      .prepare("UPDATE notebook_acl SET subject = 'account:bob' WHERE subject = ?")
      .bind(bob.principal)
      .run();
    assert.equal(await resolveCollaborator(env, alternate, target.id), "account:bob");
  });

  it("bounds searches and paginates only the caller's hidden suggestions", async () => {
    const targets = [];
    for (let index = 0; index < 23; index++) {
      const peer = person(`peer${String(index).padStart(2, "0")}`);
      await seed(`shared-${index}`, alice, peer);
      await joinBoth(`shared-${index}`, alice, peer);
      targets.push(peer);
    }
    assert.equal((await searchCollaborators(env, alice, "")).length, 10);
    for (const peer of targets) {
      const [row] = await searchCollaborators(env, alice, peer.metadata.displayName!);
      assert.ok(await hideCollaborator(env, alice, row.id));
    }
    const first = await listHiddenCollaborators(env, alice, null);
    assert.equal(first.hidden.length, 20);
    assert.ok(first.nextCursor);
    const last = await listHiddenCollaborators(env, alice, first.nextCursor);
    assert.equal(last.hidden.length, 3);
    assert.equal(last.nextCursor, null);
    assert.equal(new Set([...first.hidden, ...last.hidden].map((row) => row.id)).size, 23);
    assert.deepEqual(await listHiddenCollaborators(env, targets[0], null), {
      hidden: [],
      nextCursor: null,
    });
  });

  it("records only successful authorized WebSocket upgrades and reauthorizes opaque ACL selections", async () => {
    const a = person("alice", "dev");
    const b = person("bob", "dev");
    const c = person("carol", "dev");
    await seed("prior", a, b);
    await seed("target", a, c);
    let roomStatus = 200;
    const routeEnv: Env = {
      ...env,
      NOTEBOOK_ROOMS: {
        idFromName: (name) => ({ toString: () => name }),
        get: () => ({
          fetch: async () =>
            Object.defineProperty(new Response("room"), "status", { value: roomStatus }),
        }),
      },
    };
    const emptyContext = { waitUntil() {}, passThroughOnException() {} };
    assert.equal(
      (
        await worker.fetch(
          new Request("https://cloud.test/api/people/hidden"),
          routeEnv,
          emptyContext,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await worker.fetch(
          new Request("http://localhost/api/people/hidden", {
            method: "POST",
            headers: { Origin: "https://foreign.example", "X-User": "alice" },
            body: "{}",
          }),
          routeEnv,
          emptyContext,
        )
      ).status,
      403,
    );
    const route = async (
      path: string,
      user: string,
      method = "GET",
      body?: unknown,
      upgrade = false,
    ) => {
      const promises: Promise<unknown>[] = [];
      const response = await worker.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            "X-User": user,
            "X-Operator": "browser:test",
            "X-Scope": "viewer",
            Origin: "http://localhost",
            ...(upgrade ? { Upgrade: "websocket" } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        routeEnv,
        {
          waitUntil: (promise) => {
            promises.push(promise);
          },
          passThroughOnException() {},
        },
      );
      await Promise.all(promises);
      return response;
    };
    assert.equal((await route("/n/prior/sync", "alice", "GET", undefined, true)).status, 200);
    roomStatus = 101;
    assert.equal((await route("/n/prior/sync", "bob", "GET", undefined, true)).status, 101);
    assert.deepEqual(await searchCollaborators(env, a, ""), []);
    assert.equal((await route("/n/prior/sync", "carol", "GET", undefined, true)).status, 403);
    assert.equal((await route("/n/prior/sync", "alice", "GET", undefined, true)).status, 101);
    const response = await route("/api/people", "alice");
    const result = (await response.json()) as {
      collaboratorsEnabled: boolean;
      people: Array<{ id: string }>;
    };
    assert.equal(result.collaboratorsEnabled, true);
    const target = result.people[0];
    assert.ok(target);
    assert.equal(
      (
        await route("/api/n/target/acl", "carol", "POST", {
          collaboratorPersonId: target.id,
          scope: "viewer",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await route("/api/n/target/acl", "alice", "POST", {
          collaboratorPersonId: target.id,
          scope: "owner",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await route("/api/n/target/acl", "alice", "POST", {
          collaboratorPersonId: target.id,
          scope: "editor",
        })
      ).status,
      201,
    );
    assert.ok(
      await db
        .prepare(
          "SELECT 1 FROM notebook_acl WHERE notebook_id = 'target' AND subject = ? AND scope = 'editor'",
        )
        .bind(b.principal)
        .first(),
    );
    const hidden = await route("/api/people/hidden", "alice", "POST", { personId: target.id });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.headers.get("cache-control"), "no-store");
    assert.equal(
      (
        await route("/api/n/target/acl", "alice", "POST", {
          collaboratorPersonId: target.id,
          scope: "viewer",
        })
      ).status,
      404,
    );
    const id = ((await hidden.json()) as { id: string }).id;
    assert.equal((await route(`/api/people/hidden/${id}`, "alice", "DELETE")).status, 204);
    await db
      .prepare("DELETE FROM notebook_acl WHERE notebook_id = 'prior' AND subject = ?")
      .bind(b.principal)
      .run();
    assert.equal(
      (
        await route("/api/n/target/acl", "alice", "POST", {
          collaboratorPersonId: target.id,
          scope: "viewer",
        })
      ).status,
      404,
    );
  });
});
