// ONE-SHOT MIGRATION tests: delete with worker/record-storage-operator.mjs.
//
// An operator converts Subduction Pages to plain Automerge sync without
// waiting for a browser to leave: through the real Page host, its migration
// machine and conversion, with a real native Subduction peer connected.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { Repo } from "@automerge/automerge-repo";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { createPeer } from "../../backend.mjs";
import * as N from "@automerge/subduction";
import { BUILD_FEATURES } from "../model/schema-features.mjs";
import { WebSocketByteTransport } from "../shared/byte-transport.mjs";
import { AutomergeSyncBackend } from "../sync/backend.mjs";
import { DocStore, MemoryByteStore } from "../sync/doc-store.mjs";
import { decodeFrame, encodeFrame, framePipe } from "../sync/wire.mjs";
import worker, { Page, PageRecords } from "./index.mjs";
import { world } from "./projects-fixture.mjs";
import { OPERATOR_SECRET_HEADER } from "./operator-gate.mjs";
import { HOST_SENDER_ID } from "./plain-sync.mjs";
import { OPERATOR_ROUTE, operatorRecordStorage } from "./record-storage-operator.mjs";

const pageId = "66666666-6666-4666-8666-666666666666";
const SECRET = "s".repeat(48);

class Storage {
  values = new Map();
  /** Called with the keys of each put, before it lands. */
  onPut = null;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    await this.onPut?.(typeof key === "string" ? [key] : Object.keys(key));
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key))
        this.values.set(name, structuredClone(entry));
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    const keys = Array.isArray(key) ? key : [key];
    for (const name of keys) this.values.delete(name);
    return keys.length;
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort()
      .slice(0, limit);
    return new Map(keys.map((key) => [key, structuredClone(this.values.get(key))]));
  }
  async sync() {}
  keys(prefix) {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
}

const authed = (token, path, body) =>
  new Request(`https://pages.invalid${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
    body: JSON.stringify(body),
  });
const hostOnly = (body, headers = {}) =>
  new Request(`https://pages.internal${OPERATOR_ROUTE}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

const until = async (check, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await check()) return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function fixture(t, { buffered = true } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  const records = new Storage();
  const native = {
    ...auth.env,
    CATALOGS: { getByName: () => ({ fetch: async () => Response.json({}) }) },
    ...(buffered && {
      PAGES_ASYNC_PERSISTENCE: "true",
      PAGE_RECORDS: { getByName: () => new PageRecords({ storage: records }) },
    }),
  };
  // The switch: a target whose profile creates plain Pages.
  const plain = { ...native, PAGES_RECORD_STORAGE: "automerge" };
  const pages = [];
  const open = async (env) => {
    const page = new Page(
      {
        id: { name: pageId },
        storage,
        blockConcurrencyWhile: (fn) => fn(),
        waitUntil() {},
      },
      env,
    );
    pages.push(page);
    await page.ready;
    return page;
  };
  const close = async (page) => {
    page.disarmMigration();
    for (const wire of page.wires) await wire.disconnect?.();
    await page.plain?.close().catch(() => {});
    await page.policy?.close?.().catch?.(() => {});
    await page.repo?.shutdown().catch(() => {});
    await page.backend?.close?.().catch(() => {});
    try {
      page.signer?.free();
    } catch {}
  };
  t.after(async () => {
    for (const page of pages) await close(page);
  });
  const owner = auth.apiKey();
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  const migrationLines = () =>
    lines
      .filter((line) => line.includes("record_storage.migration"))
      .map((line) => JSON.parse(line));
  /** A Subduction Page with an edit and a comment thread. */
  const nativePage = async () => {
    const first = await open(native);
    const created = await first.fetch(
      authed(owner, "/internal/create", { page_id: pageId, title: "Kept", markdown: "Body" }),
    );
    assert.equal(created.status, 201, await created.clone().text());
    await first.handle.change((d) => (d.edited = "before migration"));
    await first.commentsHandle.change((d) => {
      d.threads.t1 = { target: "page", messages: {} };
    });
    await first.flush();
    const metadata = first.metadata;
    await close(first);
    return metadata;
  };
  const operate = async (page, body, headers) => {
    const response = await page.fetch(hostOnly(body, headers));
    return { status: response.status, body: await response.json() };
  };
  return {
    storage,
    records,
    native,
    plain,
    open,
    close,
    owner,
    nativePage,
    operate,
    migrationLines,
  };
}

test("an operator converts an idle Subduction Page no browser has opened", async (t) => {
  const f = await fixture(t);
  const { owner } = await f.nativePage();
  const host = await f.open(f.plain);
  const before = await f.operate(host, { mode: "status" });
  assert.equal(before.status, 200);
  assert.deepEqual(
    (({ page_id, owner: o, state, record_storage, refusal }) => ({
      page_id,
      owner: o,
      state,
      record_storage,
      refusal,
    }))(before.body),
    { page_id: pageId, owner, state: "active", record_storage: "buffered", refusal: null },
  );
  // Status reads the record; it boots nothing.
  assert.equal(host.handle, undefined);

  const converted = await f.operate(host, { mode: "convert", page_id: pageId, owner });
  assert.equal(converted.status, 200, JSON.stringify(converted.body));
  assert.equal(converted.body.result, "converted");
  const stored = await f.storage.get("host/document");
  assert.equal(stored.recordStorage, "automerge");
  assert.equal(stored.recordStorageMigratedFrom, "buffered");
  assert.ok(stored.recordStorageMigratedAt);
  assert.deepEqual(
    f.migrationLines().map(({ outcome, trigger, page_id }) => ({ outcome, trigger, page_id })),
    [{ outcome: "converted", trigger: "operator", page_id: pageId }],
  );

  // The next object boots plain with everything, and says so.
  const next = await f.open(f.plain);
  const after = await f.operate(next, { mode: "status" });
  assert.equal(after.body.record_storage, "automerge");
  assert.equal(after.body.migrated_from, "buffered");
  assert.equal(after.body.migrated_at, stored.recordStorageMigratedAt);
  assert.equal(after.body.refusal, "plain");
  await next.documentReady();
  assert.ok(next.plain);
  assert.equal(next.handle.doc().edited, "before migration");
  assert.ok(next.commentsHandle.doc().threads.t1);
  // Asking again is a no-op.
  assert.equal(
    (await f.operate(next, { mode: "convert", page_id: pageId, owner })).body.result,
    "plain",
  );
});

test("a trashed Page converts too", async (t) => {
  const f = await fixture(t, { buffered: false });
  const metadata = await f.nativePage();
  // Trash as the record says it: the conversion reads only pageState.
  await f.storage.put("host/document", {
    ...metadata,
    deleted: true,
    trash: { at: new Date().toISOString(), by: metadata.owner },
  });
  const host = await f.open(f.plain);
  assert.equal((await f.operate(host, { mode: "status" })).body.state, "trashed");
  const converted = await f.operate(host, { mode: "convert", page_id: pageId });
  assert.equal(converted.body.result, "converted", JSON.stringify(converted.body));
  const stored = await f.storage.get("host/document");
  assert.equal(stored.recordStorage, "automerge");
  assert.equal(stored.recordStorageMigratedFrom, "local");
  assert.ok(stored.trash);
});

test("the operator route refuses what it must not convert, and writes nothing", async (t) => {
  const f = await fixture(t);
  const { owner } = await f.nativePage();
  // A host without the plain switch: the target hasn't declared plain Pages.
  const off = await f.open(f.native);
  assert.equal((await f.operate(off, { mode: "status" })).body.refusal, "switch_off");
  assert.deepEqual((await f.operate(off, { mode: "convert", page_id: pageId })).body, {
    result: "refused",
    reason: "switch_off",
  });
  await f.close(off);
  const host = await f.open(f.plain);
  // Credentials mean the request didn't come from the gateway's operator route.
  const credentialed = await f.operate(
    host,
    { mode: "convert", page_id: pageId },
    { authorization: "Bearer x" },
  );
  assert.equal(credentialed.status, 404);
  assert.equal(
    (await f.operate(host, { mode: "convert", page_id: pageId, owner: "user:someone-else" })).body
      .result,
    "not_owner",
  );
  assert.equal(
    (await f.operate(host, { mode: "convert", page_id: crypto.randomUUID(), owner })).body.result,
    "missing",
  );
  assert.equal((await f.operate(host, { mode: "convert" })).status, 400);
  assert.equal((await f.operate(host, { mode: "nope" })).status, 400);
  assert.notEqual((await f.storage.get("host/document")).recordStorage, "automerge");
  assert.deepEqual(f.storage.keys("plain/"), []);
});

test("a requested run that skips arms no retry, and the next request converts", async (t) => {
  const f = await fixture(t);
  const { owner } = await f.nativePage();
  const host = await f.open(f.plain);
  await host.documentReady();
  assert.equal(host.migration.name, "off");
  await f.storage.put("host/operation/pending-test", {
    pending: true,
    doc: "page",
    changes: [],
  });
  const skipped = await f.operate(host, { mode: "convert", page_id: pageId, owner });
  assert.deepEqual(skipped.body, { result: "skipped", reason: "journal_pending" });
  assert.deepEqual(host.migration, { name: "off" });
  assert.equal(host.migrationTimer, undefined);
  await f.storage.delete("host/operation/pending-test");
  const converted = await f.operate(host, { mode: "convert", page_id: pageId, owner });
  assert.equal(converted.body.result, "converted");
});

test("a Page that changes while its history is written skips with heads_moved, then converts", async (t) => {
  const f = await fixture(t);
  const { owner } = await f.nativePage();
  const host = await f.open(f.plain);
  await host.documentReady();
  // An edit lands on the live document while the plain snapshot is written.
  let moved = false;
  f.storage.onPut = async (keys) => {
    if (moved || !keys.some((key) => key.startsWith("plain/"))) return;
    moved = true;
    await host.handle.change((d) => (d.during = "the snapshot write"));
  };
  const skipped = await f.operate(host, { mode: "convert", page_id: pageId, owner });
  assert.equal(moved, true, "the history write ran");
  assert.deepEqual(skipped.body, { result: "skipped", reason: "heads_moved" });
  assert.equal((await f.storage.get("host/document")).recordStorage, "buffered");
  assert.deepEqual(host.migration, { name: "off" });
  assert.equal(host.handle.doc().during, "the snapshot write");
  // Nothing moves it now: the next request converts, edit included.
  f.storage.onPut = null;
  const converted = await f.operate(host, { mode: "convert", page_id: pageId, owner });
  assert.equal(converted.body.result, "converted");
  assert.equal((await f.storage.get("host/document")).recordStorage, "automerge");
  const next = await f.open(f.plain);
  await next.documentReady();
  assert.equal(next.handle.doc().during, "the snapshot write");
});

/** A WebSocketPair whose ends deliver binary frames to each other, as
 * workerd's do, closed from either end. */
function socketPair() {
  class Socket extends EventTarget {
    binaryType = "arraybuffer";
    accept() {}
    send(bytes) {
      if (this.closed) throw Error("closed");
      const copy = new Uint8Array(bytes).slice().buffer;
      setImmediate(() => {
        if (!this.peer.closed)
          this.peer.dispatchEvent(Object.assign(new Event("message"), { data: copy }));
      });
    }
    close(code, reason) {
      if (this.closed) return;
      this.closed = { code, reason };
      this.peer.closed ??= { code, reason };
      this.dispatchEvent(new Event("close"));
      this.peer.dispatchEvent(new Event("close"));
    }
  }
  const client = new Socket(),
    server = new Socket();
  client.peer = server;
  server.peer = client;
  return { 0: client, 1: server };
}

/** Run `connect` with WebSocketPair and a 101-capable Response in place. */
function withSocketGlobals(t, run) {
  let pair;
  const globals = {
    WebSocketPair: class {
      constructor() {
        pair = socketPair();
        this[0] = pair[0];
        this[1] = pair[1];
      }
    },
    Response: class {
      constructor(_body, options) {
        Object.assign(this, options);
      }
    },
  };
  const saved = Object.fromEntries(
    Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  try {
    const response = run();
    return { response, client: pair[0], server: pair[1] };
  } finally {
    for (const [name, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  }
}

test("a connected Subduction peer is closed, its acknowledged edit converts, and it catches up over plain sync", async (t) => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const f = await fixture(t);
  const metadata = await f.nativePage();
  const host = await f.open(f.plain);
  await host.documentReady();
  const identity = {
    principal: metadata.owner,
    displayName: "Owner",
    driver: "Browser",
    credentialKind: "api-key",
    canWrite: true,
    expiresAt: Date.now() + 3_600_000,
  };

  // A real native peer, connected through the host's own socket admission.
  const peer = createPeer();
  t.after(async () => {
    await peer.repo.shutdown().catch(() => {});
    await peer.backend.close().catch(() => {});
    peer.signer.free();
  });
  const url = new URL("https://pages.invalid/api/sync");
  url.searchParams.set("schema_features", [...BUILD_FEATURES].join(","));
  const { response, client, server } = withSocketGlobals(t, () =>
    host.connect(new Request(url, { headers: { upgrade: "websocket" } }), identity),
  );
  assert.equal(response.status, 101);
  const wire = new WebSocketByteTransport(client);
  const expected = new N.PeerId(Uint8Array.from(Buffer.from(host.serverKey, "hex")));
  const transport = await N.AuthenticatedTransport.setup(wire, peer.signer, expected);
  expected.free();
  try {
    await peer.backend.addConnection(transport);
  } finally {
    transport.free();
  }
  const handle = await peer.repo.find(metadata.documentId);
  await until(() => handle.doc()?.edited === "before migration");
  assert.equal(host.wires.size, 1);
  // The peer's edit reaches the host, which holds it before the operator runs.
  handle.change((d) => (d.fromPeer = "acknowledged"));
  await until(() => host.handle.doc().fromPeer === "acknowledged");

  const converted = await f.operate(host, {
    mode: "convert",
    page_id: pageId,
    owner: metadata.owner,
  });
  assert.equal(converted.body.result, "converted", JSON.stringify(converted.body));
  // The peer was told to reconnect: a transient admission close.
  assert.deepEqual(server.closed, { code: 4503, reason: "temporarily_unavailable" });
  assert.equal(host.wires.size, 0);
  assert.equal(host.migration.name, "retired");

  // Offline now, the tab types; its checkpoint holds the edit.
  handle.change((d) => (d.offline = "typed after the close"));
  const checkpoint = handle.doc();

  // The next object boots plain with the acknowledged edit.
  const next = await f.open(f.plain);
  await next.documentReady();
  assert.ok(next.plain);
  assert.equal(next.handle.doc().fromPeer, "acknowledged");
  assert.equal(next.handle.doc().offline, undefined);

  // The reloaded tab opens a plain replica from its checkpoint and sends
  // what the host lacks, under the actor the native host already attributed.
  const link = framePipe();
  const socket = new EventTarget();
  socket.send = (bytes) => link.host.send(decodeFrame(bytes));
  socket.close = (code, reason) => link.host.close(code, reason);
  link.host.onMessage((frame) =>
    socket.dispatchEvent(Object.assign(new Event("message"), { data: encodeFrame(frame).buffer })),
  );
  link.host.onClose(() => socket.dispatchEvent(new Event("close")));
  next.plain.accept(socket, identity, { features: [...BUILD_FEATURES], senderId: "b-reloaded" });
  const backend = await AutomergeSyncBackend.load({ store: new DocStore(new MemoryByteStore()) });
  const repo = new Repo({ backend });
  t.after(() => repo.shutdown());
  backend.addConnection(link.client, { hostId: HOST_SENDER_ID });
  const plainHandle = await repo.find(metadata.documentId);
  plainHandle.update((doc) => A.merge(doc, checkpoint));
  await until(() => next.handle.doc().offline === "typed after the close");
  assert.equal(next.handle.doc().fromPeer, "acknowledged");
});

test("the gateway route lives only behind the operator secret", async () => {
  const env = { PAGES_OPERATOR_SECRET: SECRET };
  const request = (body, headers = {}) =>
    new Request("https://pages.invalid/api/operator/record-storage", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  for (const [vars, headers] of [
    [env, {}],
    [{}, { [OPERATOR_SECRET_HEADER]: SECRET }],
    [env, { [OPERATOR_SECRET_HEADER]: `${SECRET}x` }],
    [env, { [OPERATOR_SECRET_HEADER]: SECRET, "cf-ray": "1" }],
  ])
    assert.equal(await operatorRecordStorage(request({ action: "status" }, headers), vars), null);
});

test("the gateway converts by page or cell, then reads the status from a fresh object", async () => {
  const calls = [];
  const cellOf = (id) => `${"c".repeat(32)}${id.replaceAll("-", "")}`;
  let converted = false;
  const stub = (cell) => ({
    async fetch(request) {
      const body = await request.json();
      calls.push({ cell, path: new URL(request.url).pathname, ...body });
      if (body.mode === "convert") {
        converted = true;
        // The object resets under the conversion: no answer comes back.
        throw Error("Durable Object reset");
      }
      return Response.json({
        page_id: pageId,
        owner: "user:o",
        state: "active",
        record_storage: converted ? "automerge" : "buffered",
      });
    },
  });
  const env = {
    PAGES_OPERATOR_SECRET: SECRET,
    PAGES: {
      idFromName: (name) => ({ toString: () => cellOf(name) }),
      idFromString: (id) => ({ toString: () => id }),
      get: (id) => stub(String(id)),
      getByName: (name) => stub(cellOf(name)),
    },
  };
  const call = async (body) => {
    const response = await operatorRecordStorage(
      new Request("https://pages.invalid/api/operator/record-storage", {
        method: "POST",
        headers: { [OPERATOR_SECRET_HEADER]: SECRET },
        body: JSON.stringify(body),
      }),
      env,
    );
    return { status: response.status, body: await response.json() };
  };
  const result = await call({ action: "convert", page_id: pageId, owner: "user:o" });
  assert.equal(result.status, 200);
  assert.equal(result.body.cell_id, cellOf(pageId));
  assert.equal(result.body.outcome.error, "Durable Object reset");
  assert.equal(result.body.status.record_storage, "automerge");
  assert.deepEqual(
    calls.map(({ cell, path, mode, page_id, owner }) => ({ cell, path, mode, page_id, owner })),
    [
      {
        cell: cellOf(pageId),
        path: OPERATOR_ROUTE,
        mode: "convert",
        page_id: pageId,
        owner: "user:o",
      },
      {
        cell: cellOf(pageId),
        path: OPERATOR_ROUTE,
        mode: "status",
        page_id: undefined,
        owner: undefined,
      },
    ],
  );
  // By cell: the status names the Page, and the conversion goes to it.
  calls.length = 0;
  const byCell = await call({ action: "convert", cell_id: cellOf(pageId) });
  assert.equal(byCell.body.page_id, pageId);
  assert.deepEqual(
    calls.map(({ mode }) => mode),
    ["status", "convert", "status"],
  );
  // Status for many cells at once.
  const statuses = await call({ action: "status", cell_ids: [cellOf(pageId), "d".repeat(64)] });
  assert.equal(statuses.body.cells.length, 2);
  assert.equal(statuses.body.cells[0].cell_id, cellOf(pageId));
  // Malformed requests are refused.
  assert.equal((await call({ action: "convert" })).status, 400);
  assert.equal((await call({ action: "convert", page_id: "nope" })).status, 400);
  assert.equal((await call({ action: "status", cell_ids: ["x"] })).status, 400);
  assert.equal((await call({ action: "nope" })).status, 400);
});

test("end to end: the operator lists accounts, each Catalog's Pages and their storage", async (t) => {
  const w = await world(t);
  const mine = (await w.createPage({ title: "Mine" })).body.page_id;
  const theirs = (await w.createPage({ title: "Theirs" }, "member")).body.page_id;
  await w.settle();
  const trashed = "44444444-4444-4444-8444-444444444444";
  await w.catalogStorage(w.owner).put(`trash/${trashed}`, { page_id: trashed });
  const env = { ...w.env, PAGES_OPERATOR_SECRET: SECRET, PAGES_RECORD_STORAGE: "automerge" };
  const operator = async (body, headers = { [OPERATOR_SECRET_HEADER]: SECRET }) => {
    const response = await worker.fetch(
      new Request("https://pages.invalid/api/operator/record-storage", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      env,
    );
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(
    (await operator({ action: "accounts" })).body.principals,
    [w.member, w.owner].sort(),
  );
  assert.deepEqual(
    (await operator({ action: "targets", principal: w.owner })).body.pages,
    [
      { page_id: trashed, kind: "trash" },
      { page_id: mine, kind: "page" },
    ].sort((a, b) => (a.page_id < b.page_id ? -1 : 1)),
  );
  assert.deepEqual((await operator({ action: "targets", principal: w.member })).body.pages, [
    { page_id: theirs, kind: "page" },
  ]);
  const env2 = {
    ...env,
    PAGES: { ...env.PAGES, idFromName: (id) => `${"e".repeat(32)}${id.replaceAll("-", "")}` },
  };
  const status = await worker.fetch(
    new Request("https://pages.invalid/api/operator/record-storage", {
      method: "POST",
      headers: { [OPERATOR_SECRET_HEADER]: SECRET },
      body: JSON.stringify({ action: "status", page_ids: [mine] }),
    }),
    env2,
  );
  const [cell] = (await status.json()).cells;
  assert.equal(cell.page_id, mine);
  assert.equal(cell.owner, w.owner);
  assert.equal(cell.state, "active");
  // The Page host's own switch decides; this fixture's hosts don't set it.
  assert.equal(cell.refusal, "switch_off");
  // Without the secret, and through the Catalog with a credential, nothing.
  assert.equal((await operator({ action: "accounts" }, {})).status, 404);
  const direct = await w.env.CATALOGS.getByName(w.owner).fetch(
    new Request("https://pages.internal/internal/operator-record-storage-targets", {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey()}` },
      body: JSON.stringify({ principal: w.owner }),
    }),
  );
  assert.equal(direct.status, 404);
});
