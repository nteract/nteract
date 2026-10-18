import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as A from "@automerge/automerge/slim";
import { SqliteD1 } from "./sqlite.ts";
import {
  oidcDatabase,
  serverSessionContext,
  serverSessionId,
  SERVER_SESSION_COOKIE,
} from "../../notebook-cloud/src/oidc-session-store.ts";
import worker, { type Env } from "../src/worker.ts";
import { PagesWorkspace, type Storage } from "../src/workspace.ts";
import { hash, type Page, type Snapshot } from "../src/document.ts";
import { readAgentGrant } from "../src/agent-access.ts";
import { actorPrefix, newActor } from "../src/sync.ts";
await A.initializeWasm(
  await readFile(new URL(import.meta.resolve("@automerge/automerge/automerge.wasm"))),
);
const origin = "https://pages.example",
  issuer = "https://issuer.example",
  principal = JSON.stringify([issuer, "kyle"]);
class Memory implements Storage {
  values = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(values: Record<string, unknown>) {
    for (const [k, v] of Object.entries(values)) this.values.set(k, structuredClone(v));
  }
}
async function fixture() {
  const db = new SqliteD1(),
    storage = new Memory();
  let room: PagesWorkspace;
  const env: Env = {
    DB: db,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_OIDC_ISSUER: issuer,
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages",
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "x".repeat(40),
    PAGES_WORKSPACES: {
      idFromName: (name) => ({ toString: () => name }),
      get: (id) => ({
        fetch: (request) => {
          assert.equal(id.toString(), request.headers.get("x-pages-principal"));
          return room.fetch(request);
        },
      }),
    },
  };
  room = new PagesWorkspace({ storage }, env);
  await oidcDatabase(env);
  const cookieToken = "s".repeat(43),
    now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO oidc_server_sessions (id,context,session_json,sealed,access_expires_at,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      await serverSessionId(env, cookieToken),
      serverSessionContext(env, origin),
      JSON.stringify({ principal: "kyle", displayName: "Kyle Kelley", expiresAt: now + 3600 }),
      "",
      now + 3600,
      now + 3600,
      now + 3600,
    )
    .run();
  const cookie = `${SERVER_SESSION_COOKIE}=${cookieToken}`;
  const created = (await room.call(principal, {
    operation: "create_page",
    arguments: {
      title: "Agent page",
      markdown: "Hello human",
      idempotency_key: crypto.randomUUID(),
    },
  })) as { page_id: string; content: Snapshot };
  const token = `pages_${"a".repeat(64)}`;
  const approve = async (permissions = ["read", "edit", "comment"], extra = {}) =>
    worker.fetch(
      new Request(origin + "/api/agent-connections", {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          token_hash: await hash(token),
          driver: "ChatGPT",
          page_id: created.page_id,
          permissions,
          ...extra,
        }),
      }),
      env,
    );
  const tool = (operation: string, args: Record<string, unknown>, auth = token) =>
    worker.fetch(
      new Request(origin + "/api/tools", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth}`,
          "Content-Type": "application/json",
          "x-pages-principal": "forged",
          "x-pages-driver": "Forged",
        },
        body: JSON.stringify({ operation, arguments: args }),
      }),
      env,
    );
  return { db, env, room, storage, cookie, created, token, approve, tool };
}
test("agent approval binds account, Page, permissions and expiry; raw tokens and spoofed headers cannot expand access", async (t) => {
  const f = await fixture();
  t.after(() => f.db.sqlite.close());
  assert.equal((await f.tool("read_page", { page_id: f.created.page_id })).status, 401);
  const approved = await f.approve(["read"]);
  assert.equal(approved.status, 201);
  const { connection } = (await approved.json()) as {
    connection: { id: string; expires_at: number };
  };
  assert.equal((await f.tool("read_page", { page_id: f.created.page_id })).status, 200);
  for (const [op, args] of [
    ["list_pages", {}],
    ["list_pages", { page_id: f.created.page_id }],
    ["create_page", { page_id: f.created.page_id }],
    ["read_page", { page_id: "page_" + "b".repeat(32) }],
    ["patch_page", { page_id: f.created.page_id }],
    ["manage_page_comment", { page_id: f.created.page_id }],
  ] as const)
    assert.equal((await f.tool(op, args)).status, 403);
  assert.equal(
    (await f.approve()).status,
    409,
    "token binding cannot be replaced with expanded scope",
  );
  const request = new Request(origin + "/api/agent", {
    headers: { Authorization: `Bearer ${f.token}` },
  });
  assert.equal((await readAgentGrant(f.env, request))?.driver, "ChatGPT");
  assert.equal(await readAgentGrant(f.env, request, connection.expires_at), null);
  assert.equal(
    await readAgentGrant(
      { ...f.env, NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://elsewhere.example" },
      request,
    ),
    null,
  );
  const evil = await worker.fetch(
    new Request(origin + "/api/agent-connections", {
      method: "DELETE",
      headers: {
        Cookie: f.cookie,
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: connection.id }),
    }),
    f.env,
  );
  assert.equal(evil.status, 403);
  const revoked = await worker.fetch(
    new Request(origin + "/api/agent-connections", {
      method: "DELETE",
      headers: { Cookie: f.cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ id: connection.id }),
    }),
    f.env,
  );
  assert.equal(revoked.status, 200);
  assert.equal((await f.tool("read_page", { page_id: f.created.page_id })).status, 401);
});
test("agent edits persist operation attribution, retry once, and prevent raw replicas impersonating the agent actor", async (t) => {
  const f = await fixture();
  t.after(() => f.db.sqlite.close());
  assert.equal((await f.approve()).status, 201);
  const input = {
    page_id: f.created.page_id,
    base_sequence: 1,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "patch_block_markdown",
        block_id: f.created.content.blocks[0].id,
        expected_hash: f.created.content.blocks[0].hash,
        replacements: [{ old: "human", new: "collaborator" }],
      },
    ],
  };
  const result = await f.tool("patch_page", input);
  assert.equal(result.status, 200);
  const receipt = (await result.json()) as {
    attribution: { driver: string; display_name: string };
    operation_id: string;
  };
  assert.deepEqual(receipt, await (await f.tool("patch_page", input)).json());
  assert.equal(receipt.attribution.driver, "ChatGPT");
  assert.equal(receipt.attribution.display_name, "Kyle Kelley");
  const snapshot = (await (await f.tool("read_page", { page_id: f.created.page_id })).json()) as {
    content: Snapshot;
  };
  assert.equal(snapshot.content.through_sequence, 2);
  assert.equal(snapshot.content.blocks[0].markdown, "Hello collaborator");
  const changes = (await (
    await f.tool("read_page_changes", { page_id: f.created.page_id, since_sequence: 1 })
  ).json()) as { changes: { operation_id: string }[]; authors: Record<string, unknown> };
  assert.equal(changes.changes[0].operation_id, receipt.operation_id);
  const actor = Object.keys(changes.authors)[0];
  assert.ok(actor);
  const saved = await f.storage.get<{ bytes: Uint8Array }>(f.created.page_id);
  let attacker = A.load<Page>(saved!.bytes, { actor }),
    server = A.initSyncState(),
    client = A.initSyncState();
  // Establish a real peer sync state, then send a novel change under the reserved actor.
  for (let i = 0; i < 5; i++) {
    const out = await f.room.generateSync(f.created.page_id, server);
    server = out.state;
    if (out.message) [attacker, client] = A.receiveSyncMessage(attacker, client, out.message);
    const [next, message] = A.generateSyncMessage(attacker, client);
    client = next;
    if (message) server = await f.room.receiveSync(principal, f.created.page_id, server, message);
  }
  attacker = A.change(attacker, (d) =>
    A.updateText(d, ["blocks", d.order[0], "markdown"], "forged agent edit"),
  );
  const [nextClient, message] = A.generateSyncMessage(attacker, client);
  client = nextClient;
  assert.ok(message);
  const before = structuredClone(f.storage.values);
  await assert.rejects(
    (async () => {
      server = await f.room.receiveSync(principal, f.created.page_id, server, message!);
      // The sync protocol can defer the novel change to a later
      // round. Drive the protocol until it actually attempts the forged write.
      for (let i = 0; i < 10; i++) {
        const out = await f.room.generateSync(f.created.page_id, server);
        server = out.state;
        if (out.message) [attacker, client] = A.receiveSyncMessage(attacker, client, out.message);
        const [next, pending] = A.generateSyncMessage(attacker, client);
        client = next;
        if (pending)
          server = await f.room.receiveSync(principal, f.created.page_id, server, pending);
      }
      throw Error("Forged write was never rejected");
    })(),
    /agent actors|Agent actors/,
  );
  assert.deepEqual(f.storage.values, before);
  A.free(attacker);
  // Ordinary browser actor IDs still work after the agent registry exists.
  const browser = A.load<Page>(saved!.bytes, { actor: newActor(await actorPrefix(principal)) });
  A.free(browser);
});

test("server actor namespace cannot be preclaimed before the first agent operation", async (t) => {
  const f = await fixture();
  t.after(() => f.db.sqlite.close());
  const approved = (await (await f.approve()).json()) as { connection: { id: string } };
  const { agentActorId } = await import("../src/agent-access.ts");
  const actor = await agentActorId(await actorPrefix(principal), approved.connection.id);
  const saved = await f.storage.get<{ bytes: Uint8Array }>(f.created.page_id);
  let attacker = A.load<Page>(saved!.bytes, { actor }),
    server = A.initSyncState(),
    client = A.initSyncState();
  for (let i = 0; i < 5; i++) {
    const out = await f.room.generateSync(f.created.page_id, server);
    server = out.state;
    if (out.message) [attacker, client] = A.receiveSyncMessage(attacker, client, out.message);
    const [next, message] = A.generateSyncMessage(attacker, client);
    client = next;
    if (message) server = await f.room.receiveSync(principal, f.created.page_id, server, message);
  }
  attacker = A.change(attacker, (d) => A.updateText(d, ["title"], "Preclaimed ChatGPT edit"));
  const [, message] = A.generateSyncMessage(attacker, client);
  assert.ok(message);
  const before = structuredClone(f.storage.values);
  await assert.rejects(
    f.room.receiveSync(principal, f.created.page_id, server, message!),
    /server-only/,
  );
  assert.deepEqual(f.storage.values, before);
  A.free(attacker);
});
