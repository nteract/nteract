import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as A from "@automerge/automerge/slim";
import { PagesWorkspace, type Storage } from "../src/workspace.ts";
import { actorPrefix, newActor } from "../src/sync.ts";
import type { Page, Snapshot } from "../src/document.ts";
await A.initializeWasm(
  await readFile(new URL(import.meta.resolve("@automerge/automerge/automerge.wasm"))),
);
const principal = '["https://issuer.example","alice"]';
class Memory implements Storage {
  values = new Map<string, unknown>();
  fail: "before" | "after" | null = null;
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(values: Record<string, unknown>) {
    if (this.fail === "before") throw Error("storage unavailable");
    for (const [key, value] of Object.entries(values)) this.values.set(key, structuredClone(value));
    if (this.fail === "after") throw Error("ack lost");
  }
}
async function setup() {
  const storage = new Memory(),
    room = new PagesWorkspace({ storage });
  const created = (await room.call(principal, {
    operation: "create_page",
    arguments: { idempotency_key: "sync-fixture", title: "Document", markdown: "middle" },
  })) as { page_id: string; content: Snapshot };
  return { storage, room, id: created.page_id, block: created.content.blocks[0].id };
}
async function peer() {
  return {
    doc: A.init<Page>({ actor: newActor(await actorPrefix(principal)) }),
    local: A.initSyncState(),
    remote: A.initSyncState(),
  };
}
type Peer = Awaited<ReturnType<typeof peer>>;
async function sync(room: PagesWorkspace, id: string, p: Peer) {
  for (let i = 0; i < 20; i++) {
    const out = await room.generateSync(id, p.remote);
    p.remote = out.state;
    if (out.message) [p.doc, p.local] = A.receiveSyncMessage(p.doc, p.local, out.message);
    const [state, message] = A.generateSyncMessage(p.doc, p.local);
    p.local = state;
    if (message) p.remote = await room.receiveSync(principal, id, p.remote, message);
    if (!out.message && !message) return;
  }
  throw Error("sync did not settle");
}
test("real sync merges concurrent same-block edits, HTTP edits, and reconnects", async () => {
  const { room, id, block } = await setup(),
    a = await peer(),
    b = await peer();
  await sync(room, id, a);
  await sync(room, id, b);
  a.doc = A.change(a.doc, (d) => A.splice(d, ["blocks", block, "markdown"], 0, 0, "left "));
  b.doc = A.change(b.doc, (d) => A.splice(d, ["blocks", block, "markdown"], 6, 0, " right"));
  await sync(room, id, a);
  await sync(room, id, b);
  await sync(room, id, a);
  assert.equal(a.doc.blocks[block].markdown, "left middle right");
  assert.deepEqual(A.getHeads(a.doc), A.getHeads(b.doc));
  const full = (await room.call(principal, {
    operation: "read_page",
    arguments: { page_id: id },
  })) as { content: Snapshot };
  await room.call(principal, {
    operation: "edit_page",
    arguments: {
      page_id: id,
      base_sequence: full.content.through_sequence,
      idempotency_key: "http-title",
      operations: [
        { op: "set_title", title: "From a tool", expected_title_hash: full.content.title_hash },
      ],
    },
  });
  a.doc = A.change(a.doc, (d) =>
    A.updateText(d, ["blocks", block, "markdown"], "left middle right offline"),
  );
  a.local = A.initSyncState();
  a.remote = A.initSyncState();
  await sync(room, id, a);
  await sync(room, id, b);
  assert.equal(a.doc.title, "From a tool");
  assert.equal(b.doc.blocks[block].markdown, "left middle right offline");
  A.free(a.doc);
  A.free(b.doc);
});
test("storage failure and lost acknowledgement recover without duplicate operations", async () => {
  for (const mode of ["before", "after"] as const) {
    const { room, id, block, storage } = await setup(),
      p = await peer();
    await sync(room, id, p);
    p.doc = A.change(p.doc, (d) => A.splice(d, ["blocks", block, "markdown"], 6, 0, " once"));
    storage.fail = mode;
    await assert.rejects(sync(room, id, p), mode === "before" ? /storage unavailable/ : /ack lost/);
    storage.fail = null;
    const restarted = new PagesWorkspace({ storage });
    p.local = A.initSyncState();
    p.remote = A.initSyncState();
    await sync(restarted, id, p);
    const result = (await restarted.call(principal, {
      operation: "read_page",
      arguments: { page_id: id },
    })) as { content: Snapshot };
    assert.equal(result.content.blocks[0].markdown, "middle once");
    assert.equal(result.content.through_sequence, 2);
    A.free(p.doc);
  }
});
test("raw sync rejects forged authors and identity/schema mutations without changing storage", async () => {
  for (const attack of ["actor", "identity", "schema"]) {
    const { room, id, block, storage } = await setup(),
      p = await peer();
    await sync(room, id, p);
    const before = structuredClone(storage.values);
    if (attack === "actor") p.doc = A.clone(p.doc, { actor: newActor(await actorPrefix("bob")) });
    p.doc = A.change(p.doc, (d) => {
      if (attack === "identity") d.page_id = "page_" + "f".repeat(32);
      else if (attack === "schema") d.order.push("missing");
      else A.updateText(d, ["blocks", block, "markdown"], "forged");
    });
    await assert.rejects(sync(room, id, p), /actor|identity|missing block/);
    assert.deepEqual(storage.values, before);
    A.free(p.doc);
  }
});

test("concurrent Unicode edits and block insertions converge without replacing identities", async () => {
  const { room, id, block } = await setup(),
    a = await peer(),
    b = await peer();
  await sync(room, id, a);
  await sync(room, id, b);
  const x = crypto.randomUUID(),
    y = crypto.randomUUID();
  a.doc = A.change(a.doc, (d) => {
    A.splice(d, ["blocks", block, "markdown"], 0, 0, "🌍 ");
    d.blocks[x] = { id: x, kind: "markdown", markdown: "left", metadata: {} };
    d.order.push(x);
  });
  b.doc = A.change(b.doc, (d) => {
    A.splice(d, ["blocks", block, "markdown"], 6, 0, " café");
    d.blocks[y] = { id: y, kind: "markdown", markdown: "right", metadata: {} };
    d.order.push(y);
  });
  await sync(room, id, a);
  await sync(room, id, b);
  await sync(room, id, a);
  assert.equal(a.doc.blocks[block].markdown, "🌍 middle café");
  assert.deepEqual(A.getHeads(a.doc), A.getHeads(b.doc));
  assert.equal(a.doc.order.length, 3);
  b.doc = A.change(b.doc, (d) => {
    d.order.splice(d.order.indexOf(x), 1);
    delete d.blocks[x];
  });
  a.doc = A.change(a.doc, (d) =>
    A.updateText(d, ["blocks", x, "markdown"], "edit before delete arrives"),
  );
  await sync(room, id, b);
  await sync(room, id, a);
  await sync(room, id, b);
  assert.deepEqual(A.getHeads(a.doc), A.getHeads(b.doc));
  assert.equal(a.doc.blocks[x], undefined);
  A.free(a.doc);
  A.free(b.doc);
});

test("unreadable recovery records are retained while valid replicas merge", async () => {
  const { restorePending } = await import("../viewer/replica.ts");
  const { validatePage } = await import("../src/sync.ts");
  const { room, id, block } = await setup(),
    a = await peer(),
    b = await peer();
  await sync(room, id, a);
  await sync(room, id, b);
  a.doc = A.change(a.doc, (d) => A.splice(d, ["blocks", block, "markdown"], 0, 0, "left "));
  b.doc = A.change(b.doc, (d) => A.splice(d, ["blocks", block, "markdown"], 6, 0, " right"));
  const records = [
    { key: "broken", scope: "scope", revision: 1, bytes: new Uint8Array([1, 2, 3]) },
    { key: "a", scope: "scope", revision: 2, bytes: A.save(a.doc) },
    { key: "b", scope: "scope", revision: 3, bytes: A.save(b.doc) },
  ];
  const base = A.init<Page>(),
    restored = restorePending(base, id, records);
  assert.equal(restored.doc.blocks[block].markdown, "left middle right");
  assert.deepEqual(restored.unreadable, [records[0]]);
  assert.deepEqual(restored.recovered, records.slice(1));
  assert.equal(A.getHeads(base).length, 0, "caller retains its original document");
  A.free(base);
  validatePage(restored.doc, id);
  A.free(restored.doc);
  A.free(a.doc);
  A.free(b.doc);
});

test("browser splices and cursor positions use UTF-16 offsets around emoji", async () => {
  const { room, id, block } = await setup(),
    a = await peer();
  await sync(room, id, a);
  a.doc = A.change(a.doc, (d) => A.updateText(d, ["blocks", block, "markdown"], "a🌍z"));
  const cursor = A.getCursor(a.doc, ["blocks", block, "markdown"], 3);
  a.doc = A.change(a.doc, (d) => A.splice(d, ["blocks", block, "markdown"], 3, 0, "X"));
  assert.equal(a.doc.blocks[block].markdown, "a🌍Xz");
  assert.equal(A.getCursorPosition(a.doc, ["blocks", block, "markdown"], cursor), 4);
  await sync(room, id, a);
  assert.equal(a.doc.blocks[block].markdown, "a🌍Xz");
  A.free(a.doc);
});

test("raw sync metadata obeys the same JSON contract as HTTP tools", async () => {
  for (const value of [new Date(), new Uint8Array([1, 2]), new A.Counter(1)]) {
    const { room, id, block, storage } = await setup(),
      p = await peer();
    await sync(room, id, p);
    const before = structuredClone(storage.values);
    p.doc = A.change(p.doc, (d) => {
      (d.blocks[block].metadata as Record<string, unknown>).value = value;
    });
    await assert.rejects(sync(room, id, p), /plain JSON/);
    assert.deepEqual(storage.values, before);
    A.free(p.doc);
  }
});

test("browser title edits retain usable nested Automerge objects through sync", async () => {
  const { PageReplica } = await import("../viewer/replica.ts");
  const { validatePage } = await import("../src/sync.ts");
  const { room, id, block } = await setup(),
    p = await peer();
  await sync(room, id, p);
  const replica = new PageReplica(
    principal,
    id,
    () => {},
    () => {},
    async () => true,
  );
  replica.doc = p.doc;
  try {
    replica.text(null, "Renamed");
    validatePage(replica.doc!, id);
    replica.text(null, "Renamed again");
    replica.text(block, "Still editable");
    p.doc = replica.doc!;
    await sync(room, id, p);
    replica.doc = p.doc;
    validatePage(replica.doc, id);
    assert.equal(replica.doc.blocks[block].markdown, "Still editable");
  } finally {
    replica.dispose();
  }
});

test("browser coalesces typing until its own durable receipt, not another peer's update", async (t) => {
  const { PageReplica } = await import("../viewer/replica.ts");
  const { room, id, block } = await setup(),
    p = await peer();
  await sync(room, id, p);
  const frames: Uint8Array[] = [];
  const replica = new PageReplica(
    principal,
    id,
    () => {},
    () => {},
    async () => true,
  );
  replica.doc = p.doc;
  replica["sync"] = p.local;
  replica["socket"] = {
    readyState: WebSocket.OPEN,
    send: (frame: Uint8Array) => frames.push(frame),
    close() {},
  } as unknown as WebSocket;
  t.after(() => replica.dispose());
  await replica["control"]({
    type: "hello",
    protocol: "nteract-pages-automerge-v2",
    flow_control: "durable-received",
    page_id: id,
    actor_prefix: await actorPrefix(principal),
  });
  replica.text(block, "first");
  replica["send"]();
  assert.equal(frames.length, 1);
  for (let i = 0; i < 40; i++) {
    replica.text(block, `typing ${i}`);
    replica["send"]();
  }
  assert.equal(frames.length, 1, "typing does not grow the network queue");
  p.remote = await room.receiveSync(principal, id, p.remote, frames[0]);
  const reply = await room.generateSync(id, p.remote);
  p.remote = reply.state;
  if (reply.message)
    [replica.doc, replica["sync"]] = A.receiveSyncMessage(
      replica.doc!,
      replica["sync"],
      reply.message,
    );
  await replica["control"]({
    type: "durable",
    heads: reply.heads,
    sequence: reply.sequence,
    received: false,
  });
  replica["send"]();
  assert.equal(frames.length, 1, "an unsolicited broadcast is not our receipt");
  await replica["control"]({
    type: "durable",
    heads: reply.heads,
    sequence: reply.sequence,
    received: true,
  });
  replica["send"]();
  assert.equal(frames.length, 2);
  p.remote = await room.receiveSync(principal, id, p.remote, frames[1]);
  const saved = (await room.call(principal, {
    operation: "read_page",
    arguments: { page_id: id },
  })) as { content: Snapshot };
  assert.equal(saved.content.blocks[0].markdown, "typing 39");
});
