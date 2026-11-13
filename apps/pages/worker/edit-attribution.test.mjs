import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { Repo, generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { blockAddress } from "../model/addresses.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { BUILD_FEATURES } from "../model/schema-features.mjs";
import { AutomergeSyncBackend } from "../sync/backend.mjs";
import { DocStore, MemoryByteStore } from "../sync/doc-store.mjs";
import { decodeFrame, encodeFrame, framePipe } from "../sync/wire.mjs";
import { proposeAccessUpdate } from "./access.mjs";
import { WRITER_PREFIX, actorWriterId } from "./host-writers.mjs";
import { Page } from "./index.mjs";
import { documentMutation, operationKey } from "./mutations.mjs";
import { readRevision } from "./operation-journal.mjs";
import { HOST_SENDER_ID, treeOf } from "./plain-sync.mjs";

// Who wrote each change read_page_changes reports, on a Page host with real
// plain sync: agent edits through their writer records, browser edits
// through their actor claims, and everything else as unrecorded.

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key))
        this.values.set(name, structuredClone(entry));
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    for (const name of Array.isArray(key) ? key : [key]) this.values.delete(name);
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort()
      .slice(0, limit);
    return new Map(keys.map((key) => [key, structuredClone(this.values.get(key))]));
  }
  async sync() {}
}

const pageId = "55555555-5555-4555-8555-555555555555";
const owner = "user:anaconda-fixture:fixture-user";
const member = "user:anaconda-fixture:member-user";

async function fixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  const env = {
    ...auth.env,
    CATALOGS: { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) },
  };
  const tokens = { owner: auth.apiKey(), member: auth.apiKey({ userId: "member-user" }) };
  const pages = [];
  t.after(async () => {
    for (const p of pages) await p.plain?.close();
  });
  const page = () => {
    const p = new Page(
      { id: { name: pageId }, storage, blockConcurrencyWhile: (fn) => fn(), waitUntil() {} },
      env,
    );
    pages.push(p);
    return p;
  };
  const doc = A.change(A.from(createPageData({ pageId, title: "Attributed" })), (draft) =>
    initializePage(draft, "Original text"),
  );
  t.after(() => A.free(doc));
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  const host = page();
  const registered = await host.fetch(
    new Request("https://pages.invalid/internal/register", {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.owner}`, "x-pages-driver": "Browser" },
      body: JSON.stringify({
        page_id: pageId,
        expected_principal: owner,
        document_id: documentId,
        initial_snapshot_base64: Buffer.from(A.save(doc)).toString("base64"),
        title: "Attributed",
        nonce: "register-attributed",
        record_storage: "automerge",
      }),
    }),
  );
  assert.ok(registered.ok, await registered.clone().text());
  await host.flush();
  return { auth, storage, env, tokens, page, host, documentId };
}

/** One /internal/tool call. `agent` is what the gateway forwards as the
 * client's `{ name?, model? }`. */
async function tool(f, operation, args, { who = "owner", agent, host = f.host } = {}) {
  const response = await host.fetch(
    new Request("https://pages.invalid/internal/tool", {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.tokens[who]}`,
        "x-pages-driver": "Kilo",
        ...(agent && {
          "x-pages-internal-request-agent": encodeURIComponent(JSON.stringify(agent)),
        }),
      },
      body: JSON.stringify({ operation, arguments: { page_id: pageId, ...args } }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

const revision = (f, host = f.host) =>
  readRevision(f.storage, "page", A.getHeads(host.handle.doc()));
const block = (host) => blockAddress(host.handle.doc(), Object.keys(host.handle.doc().blocks)[0]);
const replace = (host, from, to) => ({
  op: "replace_match",
  node_id: block(host),
  match_text: from,
  replacement: to,
});
const changesSince = async (f, since, options) => {
  const read = await tool(
    f,
    "read_page_changes",
    { since_revision: since, comments: "none" },
    options,
  );
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return read.body;
};
/** The writers a change names, from the read's writers table. */
const writersOf = (read, indexes) => indexes.map((index) => read.writers[index]);

async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

const socketFor = (page, identity, senderId) => {
  const link = framePipe();
  const socket = new EventTarget();
  socket.send = (bytes) => link.host.send(decodeFrame(bytes));
  socket.close = (code, reason) => link.host.close(code, reason);
  link.host.onMessage((frame) =>
    socket.dispatchEvent(Object.assign(new Event("message"), { data: encodeFrame(frame).buffer })),
  );
  link.host.onClose(() => socket.dispatchEvent(new Event("close")));
  page.plain.accept(socket, identity, { features: [...BUILD_FEATURES], senderId });
  return link;
};

/** A browser replica syncing `f.host` as `identity`. */
async function browser(t, f, identity, senderId) {
  const link = socketFor(f.host, identity, senderId);
  const backend = await AutomergeSyncBackend.load({ store: new DocStore(new MemoryByteStore()) });
  const repo = new Repo({ backend });
  t.after(() => repo.shutdown());
  backend.addConnection(link.client, { hostId: HOST_SENDER_ID });
  return { link, handle: await repo.find(f.documentId) };
}

const browserIdentity = (principal, displayName) => ({
  principal,
  displayName,
  driver: "Browser",
  canWrite: true,
  expiresAt: Date.now() + 3_600_000,
});

const setRole = (f, principal, role) => {
  const ownerIdentity = { principal: owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  const { acl } = proposeAccessUpdate(f.host.metadata, ownerIdentity, {
    principal,
    role,
    expected_revision: f.host.metadata.acl?.revision ?? 0,
  });
  f.host.metadata = { ...f.host.metadata, acl };
  f.host.plain.refresh();
};

test("an agent edit reads back with its writer: name and model, name only, or no assertion", async (t) => {
  const f = await fixture(t);
  const r0 = await revision(f);
  const edit = async (agent, operations, nonce) => {
    const response = await tool(
      f,
      "edit_page",
      { revision: await revision(f), nonce, operations },
      { agent },
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.revision;
  };
  const r1 = await edit(
    { name: "Rel", model: "m-1" },
    [replace(f.host, "Original", "First")],
    "edit-1",
  );
  let read = await changesSince(f, r0);
  assert.equal(read.attribution, "block");
  const writer = (agent) => ({
    principal: owner,
    displayName: read.writers[0].displayName,
    driver: "Kilo",
    ...(agent && { agent }),
    via: "tool",
  });
  assert.equal(typeof read.writers[0].displayName, "string");
  assert.deepEqual(read.writers, [writer({ name: "Rel", model: "m-1" })]);
  assert.ok(read.changes.length > 0);
  for (const change of read.changes) assert.deepEqual(change.written_by, [0]);

  const r2 = await edit({ name: "Rel" }, [{ op: "set_title", title: "Renamed" }], "edit-2");
  read = await changesSince(f, r1);
  assert.equal(read.title_changed, true);
  assert.deepEqual(writersOf(read, read.title_written_by), [writer({ name: "Rel" })]);
  assert.deepEqual(read.changes, []);

  await edit(undefined, [replace(f.host, "First", "Third")], "edit-3");
  read = await changesSince(f, r2);
  assert.deepEqual(read.writers, [writer()]);
  assert.ok(!("agent" in read.writers[0]));
  for (const change of read.changes) assert.deepEqual(change.written_by, [0]);

  // Over the three edits a block names both of its writers, the title its own.
  read = await changesSince(f, r0);
  t.diagnostic(JSON.stringify(read));
  assert.equal(read.writers.length, 3);
  for (const change of read.changes)
    assert.deepEqual(writersOf(read, change.written_by), [
      writer({ name: "Rel", model: "m-1" }),
      writer(),
    ]);
  assert.deepEqual(writersOf(read, read.title_written_by), [writer({ name: "Rel" })]);
  // One record per distinct writer, under plain/ so a purge removes them.
  assert.equal((await f.storage.list({ prefix: WRITER_PREFIX })).size, 3);
});

test("a browser edit reads back with the principal its actor claim names", async (t) => {
  const f = await fixture(t);
  const r0 = await revision(f);
  const replica = await browser(t, f, browserIdentity(owner, "Fixture Person"), "b-attributed");
  replica.handle.change((d) => A.updateText(d, ["title"], "From the browser"));
  await until(() => f.host.handle.doc().title === "From the browser");
  const read = await changesSince(f, r0);
  assert.deepEqual(writersOf(read, read.title_written_by), [
    { principal: owner, displayName: "Fixture Person", driver: "Browser", via: "sync" },
  ]);
});

test("a change from before writers were recorded reads as unrecorded, never guessed", async (t) => {
  const f = await fixture(t);
  const r0 = await revision(f);
  // A host edit in the layout every host edit had before this change: the
  // prefix and a nonce, with no writer between them.
  await f.host.handle.change((d) => A.updateText(d, ["title"], "Old host edit"));
  await f.host.flush();
  const actor = A.decodeChange(
    A.getChangesSince(f.host.handle.doc(), await f.host.revisionTable().heads("page", r0, "r0"))[0],
  ).actor;
  assert.equal(actor.length, 32);
  assert.equal(actorWriterId(f.host.plain.hostActorPrefix, actor), null);
  const r1 = await revision(f);
  await tool(
    f,
    "edit_page",
    {
      revision: r1,
      nonce: "after-old",
      operations: [{ op: "set_title", title: "New agent edit" }],
    },
    { agent: { name: "Rel" } },
  );
  const read = await changesSince(f, r0);
  assert.deepEqual(read.writers[0], { recorded: false });
  assert.equal(read.writers[1].agent.name, "Rel");
  assert.deepEqual(read.title_written_by, [0, 1]);
});

test("nothing a browser sends sets or overrides a host edit's writer", async (t) => {
  const f = await fixture(t);
  const r0 = await revision(f);
  const agentEdit = await tool(
    f,
    "edit_page",
    { revision: r0, nonce: "victim", operations: [{ op: "set_title", title: "By the agent" }] },
    { agent: { name: "Rel", model: "m-1" } },
  );
  assert.equal(agentEdit.status, 200);
  const victimActor = A.decodeChange(
    A.getChangesSince(f.host.handle.doc(), await f.host.revisionTable().heads("page", r0, "r0"))[0],
  ).actor;
  const writer = actorWriterId(f.host.plain.hostActorPrefix, victimActor);
  assert.ok(writer);
  const before = structuredClone(f.storage.values);

  // A browser authors under the victim's writer id, with a message that
  // names the agent: refused as the host's actor, and nothing is stored.
  const forgedActor = victimActor.slice(0, 32) + "ab".repeat(8);
  const forged = A.change(
    A.clone(f.host.handle.doc(), { actor: forgedActor }),
    { message: JSON.stringify({ principal: owner, agent: { name: "Rel" } }) },
    (d) => A.updateText(d, ["title"], "Forged"),
  );
  const link = socketFor(f.host, browserIdentity(owner, "Forger"), "b-forger");
  const frames = [];
  link.client.onMessage((frame) => frames.push(frame));
  const hello = (changes) => {
    const m = A.decodeSyncMessage(A.generateSyncMessage(A.init(), A.initSyncState())[1]);
    m.changes = changes;
    return A.encodeSyncMessage(m);
  };
  link.client.send({
    t: "sync",
    doc: treeOf(f.documentId),
    m: hello([A.getLastLocalChange(forged)]),
    r: 1,
  });
  await until(() => frames.some((frame) => frame.t === "refused"));
  assert.equal(frames.find((frame) => frame.t === "refused").code, "actor_claimed");
  assert.deepEqual(f.storage.values, before);
  A.free(forged);

  // The same layout under another prefix is the browser's own actor: its
  // claim names the browser's principal, and its message is never read.
  setRole(f, member, "editor");
  const lookalike = "fe".repeat(8) + writer + "cd".repeat(8);
  const second = socketFor(f.host, browserIdentity(member, "Member"), "b-lookalike");
  const own = A.change(
    A.clone(f.host.handle.doc(), { actor: lookalike }),
    { message: JSON.stringify({ principal: owner, agent: { name: "Rel" } }) },
    (d) => A.updateText(d, ["title"], "Lookalike"),
  );
  const r1 = await revision(f);
  second.client.send({
    t: "sync",
    doc: treeOf(f.documentId),
    m: hello([A.getLastLocalChange(own)]),
    r: 1,
  });
  await until(() => f.host.handle.doc().title === "Lookalike");
  A.free(own);
  const read = await changesSince(f, r1);
  assert.deepEqual(writersOf(read, read.title_written_by), [
    { principal: member, displayName: "Member", driver: "Browser", via: "sync" },
  ]);
  // And the agent's edit keeps its writer.
  const all = await changesSince(f, r0);
  assert.deepEqual(
    writersOf(all, all.title_written_by).map((w) => w.agent?.name ?? w.principal),
    ["Rel", member],
  );
});

test("a retry keeps its first attempt's writer; another assertion under its nonce conflicts", async (t) => {
  const f = await fixture(t);
  const r0 = await revision(f);
  const args = { revision: r0, nonce: "retry-1", operations: [{ op: "set_title", title: "Once" }] };
  const first = await tool(f, "edit_page", args, { agent: { name: "Rel", model: "m-1" } });
  assert.equal(first.status, 200);
  const heads = A.getHeads(f.host.handle.doc());
  const replay = await tool(f, "edit_page", args, { agent: { name: "Rel", model: "m-1" } });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.deepEqual(A.getHeads(f.host.handle.doc()), heads, "nothing new was written");
  for (const agent of [{ name: "Other", model: "m-1" }, { name: "Rel" }, undefined]) {
    const conflict = await tool(f, "edit_page", args, { agent });
    assert.equal(conflict.status, 409, JSON.stringify(agent));
    assert.equal(conflict.body.code, "nonce_conflict");
  }
  const read = await changesSince(f, r0);
  assert.deepEqual(
    read.writers.map((w) => w.agent),
    [{ name: "Rel", model: "m-1" }],
  );

  // An entry journaled before the fingerprint covered the agent (it records
  // no writer) still replays when its client retries with its assertion.
  const r1 = await revision(f);
  const legacyArgs = {
    revision: r1,
    nonce: "legacy",
    operations: [{ op: "set_title", title: "Old" }],
  };
  assert.equal((await tool(f, "edit_page", legacyArgs)).status, 200);
  const key = await operationKey({ nonce: "legacy" }, { principal: owner }, "page");
  const entry = await f.storage.get(key);
  assert.match(entry.writer, /^[0-9a-f]{16}$/);
  assert.equal((await tool(f, "edit_page", legacyArgs, { agent: { name: "Rel" } })).status, 409);
  delete entry.writer;
  await f.storage.put(key, entry);
  const legacy = await tool(f, "edit_page", legacyArgs, { agent: { name: "Rel" } });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
});

test("an edit whose history append failed keeps its writer when its retry replays it", async (t) => {
  const f = await fixture(t);
  const r0 = await revision(f);
  const args = {
    revision: r0,
    nonce: "pending",
    operations: [{ op: "set_title", title: "Pending" }],
  };
  let failures = 2;
  const put = f.storage.put.bind(f.storage);
  t.mock.method(f.storage, "put", async (key, value) => {
    if (
      failures > 0 &&
      typeof key === "object" &&
      Object.keys(key).some((k) => k.startsWith("plain/sync/"))
    ) {
      failures--;
      throw Error("history append failed");
    }
    return put(key, value);
  });
  const first = await tool(f, "edit_page", args, { agent: { name: "Rel", model: "m-1" } });
  assert.equal(first.status, 500);
  const entry = await f.storage.get(
    await operationKey({ nonce: "pending" }, { principal: owner }, "page"),
  );
  assert.equal(entry.pending, true);
  // The record was stored with the entry that holds the change bytes.
  assert.ok(await f.storage.get(WRITER_PREFIX + entry.writer));
  const retry = await tool(f, "edit_page", args, { agent: { name: "Rel", model: "m-1" } });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  // A restarted host reads the same writer.
  await f.host.plain.close();
  f.host = f.page();
  await f.host.ready;
  await f.host.documentReady();
  const read = await changesSince(f, r0);
  assert.deepEqual(writersOf(read, read.title_written_by)[0].agent, { name: "Rel", model: "m-1" });
});

test("concurrent mutations by one writer from the same heads get distinct actors naming that writer", async (t) => {
  const f = await fixture(t);
  const host = f.host;
  const heads = A.getHeads(host.handle.doc());
  const base = await revision(f);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const built = [];
  const identity = { principal: owner, displayName: "Fixture", driver: "API" };
  const mutate = (field) =>
    documentMutation({
      storage: f.storage,
      handle: host.handle,
      hostActorPrefix: host.plain.hostActorPrefix,
      operation: "edit_page",
      args: { revision: base, nonce: `concurrent-${field}` },
      identity,
      agent: { name: "Rel" },
      apply: (doc) => {
        built.push(field);
        doc[field] = true;
      },
      flush: async () => {
        await gate;
        await host.flush();
      },
    });
  const runs = ["a", "b", "c", "d"].map(mutate);
  await until(() => built.length === 4);
  release();
  await Promise.all(runs);
  const changes = A.getChangesSince(host.handle.doc(), heads).map(A.decodeChange);
  assert.equal(changes.length, 4);
  assert.equal(new Set(changes.map((c) => c.actor)).size, 4);
  const ids = changes.map((c) => actorWriterId(host.plain.hostActorPrefix, c.actor));
  assert.equal(new Set(ids).size, 1);
  assert.ok(ids[0]);
  assert.ok(changes.every((c) => c.seq === 1));
  for (const field of ["a", "b", "c", "d"]) assert.equal(host.handle.doc()[field], true);
});

test("a removed member's past edits stay attributed to them", async (t) => {
  const f = await fixture(t);
  const r0 = await revision(f);
  setRole(f, member, "editor");
  const edit = await tool(
    f,
    "edit_page",
    { revision: r0, nonce: "member-edit", operations: [replace(f.host, "Original", "Member")] },
    { who: "member", agent: { name: "Helper" } },
  );
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const replica = await browser(t, f, browserIdentity(member, "Member"), "b-removed");
  replica.handle.change((d) => A.updateText(d, ["title"], "Member title"));
  await until(() => f.host.handle.doc().title === "Member title");
  setRole(f, member, null);
  await until(() => replica.link.client.closed);
  const read = await changesSince(f, r0);
  assert.deepEqual(
    read.changes.flatMap((change) => writersOf(read, change.written_by)).map((w) => w.principal),
    read.changes.map(() => member),
  );
  assert.equal(writersOf(read, read.changes[0].written_by)[0].agent.name, "Helper");
  assert.deepEqual(writersOf(read, read.title_written_by), [
    { principal: member, displayName: "Member", driver: "Browser", via: "sync" },
  ]);
});

test("the writers table counts toward max_bytes, and a delta that doesn't fit is refused whole", async (t) => {
  const f = await fixture(t);
  const r0 = await revision(f);
  for (let n = 0; n < 20; n++) {
    const response = await tool(
      f,
      "edit_page",
      {
        revision: await revision(f),
        nonce: `many-${n}`,
        operations: [{ op: "set_title", title: `T${n}` }],
      },
      { agent: { name: `Agent ${n}`, model: "m".repeat(120) } },
    );
    assert.equal(response.status, 200);
  }
  const fits = await changesSince(f, r0);
  assert.equal(fits.writers.length, 20);
  const tight = await tool(f, "read_page_changes", {
    since_revision: r0,
    comments: "none",
    max_bytes: 4096,
  });
  assert.equal(tight.status, 413);
  assert.equal(tight.body.code, "changes_budget_exceeded");
  assert.equal(tight.body.writers, undefined);
});
