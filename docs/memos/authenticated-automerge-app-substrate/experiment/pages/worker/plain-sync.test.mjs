import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { Repo, generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { BUILD_FEATURES } from "../model/schema-features.mjs";
import { AutomergeSyncBackend } from "../sync/backend.mjs";
import { DocStore, MemoryByteStore } from "../sync/doc-store.mjs";
import { framePipe } from "../sync/wire.mjs";
import { Page, recordStorageFor, registeredRecordStorage } from "./index.mjs";
import { HOST_SENDER_ID, PlainByteStore } from "./plain-sync.mjs";

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

const pageId = "44444444-4444-4444-8444-444444444444";

async function fixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  const env = { ...auth.env, PAGES_RECORD_STORAGE: "automerge" };
  const token = auth.apiKey();
  const pages = [];
  const page = () => {
    const p = new Page(
      {
        id: { name: pageId },
        storage,
        blockConcurrencyWhile: (fn) => fn(),
        waitUntil() {},
      },
      env,
    );
    pages.push(p);
    return p;
  };
  t.after(async () => {
    for (const p of pages) await p.plain?.close();
  });
  const doc = A.change(A.from(createPageData({ pageId, title: "Plain Page" })), (draft) =>
    initializePage(draft, "Original text"),
  );
  const args = {
    page_id: pageId,
    expected_principal: "user:anaconda-fixture:fixture-user",
    document_id: interpretAsDocumentId(generateAutomergeUrl()),
    initial_snapshot_base64: Buffer.from(A.save(doc)).toString("base64"),
    title: "Plain Page",
    idempotency_key: "register-plain",
    record_storage: "automerge",
  };
  const register = (p) =>
    p.fetch(
      new Request("https://pages.invalid/internal/register", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-pages-driver": "Browser",
        },
        body: JSON.stringify(args),
      }),
    );
  return { auth, storage, env, token, page, register, args, doc };
}

test("PAGES_RECORD_STORAGE=automerge selects plain sync for new Pages only", () => {
  assert.equal(recordStorageFor({ PAGES_RECORD_STORAGE: "automerge" }), "automerge");
  assert.equal(recordStorageFor({ PAGES_ASYNC_PERSISTENCE: "true" }), "buffered");
  assert.equal(recordStorageFor({}), "local");
  // A registered draft keeps its replica's storage; older builds send none.
  assert.equal(registeredRecordStorage({ PAGES_RECORD_STORAGE: "automerge" }, {}), "local");
  assert.equal(
    registeredRecordStorage({ PAGES_RECORD_STORAGE: "automerge" }, { record_storage: "automerge" }),
    "automerge",
  );
  assert.equal(registeredRecordStorage({}, { record_storage: "native" }), "local");
  // Without the flag, a plain draft is refused: an older build can't boot it.
  for (const env of [{}, { PAGES_ASYNC_PERSISTENCE: "true" }])
    assert.throws(() => registeredRecordStorage(env, { record_storage: "automerge" }), {
      status: 409,
      code: "record_storage_unsupported",
    });
});

test("a host without PAGES_RECORD_STORAGE refuses a plain draft before recording it", async (t) => {
  const f = await fixture(t);
  delete f.env.PAGES_RECORD_STORAGE;
  const first = f.page();
  const refused = await f.register(first);
  assert.equal(refused.status, 409);
  assert.equal(refused.headers.get("x-pages-create-rejected"), "before-intent");
  assert.equal((await refused.json()).code, "record_storage_unsupported");
  assert.equal(first.metadata, undefined);
  assert.equal(await f.storage.get("host/creation"), undefined);
  // The same draft registers natively once it drops record_storage.
  delete f.args.record_storage;
  const accepted = await f.register(first);
  assert.ok(accepted.ok, await accepted.clone().text());
  assert.equal(first.metadata.recordStorage, "local");
  assert.equal(first.plain, undefined);
});

test("a plain registration recorded before the flag went off still replays and resumes", async (t) => {
  // Completed: the receipt replays with its plain metadata.
  const completed = await fixture(t);
  const first = completed.page();
  assert.ok((await completed.register(first)).ok);
  delete completed.env.PAGES_RECORD_STORAGE;
  const replayed = await completed.register(completed.page());
  assert.equal(replayed.status, 201, await replayed.clone().text());
  assert.equal((await replayed.json()).document_id, completed.args.document_id);
  // Interrupted after the intent: a restart resumes it as recorded.
  const interrupted = await fixture(t);
  const crashed = interrupted.page();
  t.mock.method(crashed, "initializeRepo", async () => {
    throw Error("simulated crash after the creation intent");
  });
  await interrupted.register(crashed).catch(() => {});
  assert.equal(
    (await interrupted.storage.get("host/creation")).metadata.recordStorage,
    "automerge",
  );
  delete interrupted.env.PAGES_RECORD_STORAGE;
  const restarted = interrupted.page();
  const resumed = await interrupted.register(restarted);
  assert.equal(resumed.status, 201, await resumed.clone().text());
  assert.equal(restarted.metadata.recordStorage, "automerge");
  assert.ok(restarted.plain, "the resumed Page runs PlainSync");
});

test("a registered automerge Page stores plain history and survives a restart", async (t) => {
  const f = await fixture(t);
  const first = f.page();
  const response = await f.register(first);
  assert.ok(response.ok, await response.clone().text());
  assert.equal(first.metadata.recordStorage, "automerge");
  assert.ok(first.plain, "the host runs PlainSync");
  assert.equal(first.serverSenderId, HOST_SENDER_ID);
  // No Subduction state: no signer seed, no native records.
  assert.equal(await f.storage.get("host/signer"), undefined);
  assert.equal([...f.storage.values.keys()].filter((k) => k.startsWith("repo/")).length, 0);
  assert.ok([...f.storage.values.keys()].some((k) => k.startsWith("plain/sync/")));

  await first.handle.change((draft) => {
    draft.afterRegistration = "Persisted before restart";
  });
  await first.flush();
  await first.plain.close();

  const restarted = f.page();
  await restarted.ready;
  assert.equal(restarted.handle.documentId, f.args.document_id);
  assert.ok(A.hasHeads(restarted.handle.doc(), A.getHeads(f.doc)));
  assert.equal(restarted.handle.doc().afterRegistration, "Persisted before restart");
  // The host's own edits are claimed by the host, never by a person.
  const claims = await new PlainByteStore(f.storage).list("actor/");
  assert.ok(claims.length >= 1);
});

test("a browser syncs an automerge Page through connect, and its actor is attributed", async (t) => {
  const f = await fixture(t);
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const identity = {
    principal: "user:anaconda-fixture:fixture-user",
    displayName: "Fixture",
    driver: "Browser",
    canWrite: true,
    expiresAt: Date.now() + 3_600_000,
  };

  // Stand in for the WebSocket: the host side of a frame pipe, wrapped the way
  // workerd delivers socket events.
  const link = framePipe();
  const socket = new EventTarget();
  socket.send = (bytes) => link.host.send(decodeForTest(bytes));
  socket.close = (code, reason) => link.host.close(code, reason);
  link.host.onMessage((frame) =>
    socket.dispatchEvent(Object.assign(new Event("message"), { data: encodeForTest(frame) })),
  );
  link.host.onClose(() => socket.dispatchEvent(new Event("close")));
  const conn = host.plain.accept(socket, identity, {
    features: [...BUILD_FEATURES],
    senderId: "s-browser",
  });
  assert.equal(conn.role, "owner");

  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(new MemoryByteStore()),
  });
  const repo = new Repo({ backend });
  try {
    backend.addConnection(link.client, { hostId: HOST_SENDER_ID });
    const handle = await repo.find(f.args.document_id);
    // A build that lacks the Page's schema features may read but not write.
    const stale = framePipe();
    const staleSocket = new EventTarget();
    staleSocket.send = (bytes) => stale.host.send(decodeForTest(bytes));
    staleSocket.close = (code, reason) => stale.host.close(code, reason);
    stale.host.onMessage((frame) =>
      staleSocket.dispatchEvent(
        Object.assign(new Event("message"), { data: encodeForTest(frame) }),
      ),
    );
    host.plain.accept(staleSocket, identity, {
      features: [],
      senderId: "s-stale",
    });
    const staleFrames = [];
    stale.client.onMessage((frame) => staleFrames.push(frame));
    const staleEdit = A.change(A.clone(handle.doc()), (d) => (d.stale = true));
    const m = A.decodeSyncMessage(A.generateSyncMessage(A.init(), A.initSyncState())[1]);
    m.changes = A.getChanges(handle.doc(), staleEdit);
    stale.client.send({
      t: "sync",
      doc: treeHex(f.args.document_id),
      m: A.encodeSyncMessage(m),
      r: 1,
    });
    await until(() => staleFrames.some((frame) => frame.t === "refused"));
    assert.equal(staleFrames.find((frame) => frame.t === "refused").code, "schema_unsupported");
    assert.equal(stale.client.closeCode, 4426);
    assert.equal(handle.doc().title, "Plain Page");
    handle.change((d) => (d.fromBrowser = true));
    await until(() => host.handle.doc().fromBrowser === true);
    const actor = A.getActorId(handle.doc());
    assert.equal(host.plain.actorSnapshot().actorProfiles[actor]?.principal, identity.principal);
    // The host's actor-profiles message reaches the browser from the host's
    // sender id, naming the actor and the hash of the change just made.
    const hostMessages = [];
    handle.on("ephemeral-message", (e) => hostMessages.push(e));
    handle.change((d) => (d.second = true));
    const hash = A.decodeChange(A.getLastLocalChange(handle.doc())).hash;
    await until(() =>
      hostMessages.some(
        (e) => e.message?.kind === "actor-profiles" && e.message.attestedChanges?.[hash],
      ),
    );
    const delta = hostMessages.find((e) => e.message.attestedChanges?.[hash]);
    assert.equal(delta.senderId, HOST_SENDER_ID);
    assert.equal(delta.message.attestedChanges[hash], actor);
    assert.equal(delta.message.actorProfiles[actor].principal, identity.principal);
    assert.deepEqual(Object.keys(host.profiles()).sort(), [HOST_SENDER_ID, "s-browser"].sort());
    // The host's edit reaches the browser.
    await host.handle.change((d) => (d.fromHost = true));
    await host.flush();
    await until(() => handle.doc().fromHost === true);
  } finally {
    await repo.shutdown();
  }
});

import { decodeFrame, encodeFrame } from "../sync/wire.mjs";
import { treeOf } from "./plain-sync.mjs";
const treeHex = (documentId) => treeOf(documentId);
const encodeForTest = (frame) => encodeFrame(frame).buffer;
const decodeForTest = (bytes) => decodeFrame(bytes);

/** A browser connected to `page` through PlainSync.accept, as the socket. */
async function connectBrowser(page, identity, senderId) {
  const link = framePipe();
  const socket = new EventTarget();
  socket.send = (bytes) => link.host.send(decodeForTest(bytes));
  socket.close = (code, reason) => link.host.close(code, reason);
  link.host.onMessage((frame) =>
    socket.dispatchEvent(Object.assign(new Event("message"), { data: encodeForTest(frame) })),
  );
  link.host.onClose(() => socket.dispatchEvent(new Event("close")));
  page.plain.accept(socket, identity, {
    features: [...BUILD_FEATURES],
    senderId,
  });
  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(new MemoryByteStore()),
  });
  const repo = new Repo({ backend });
  backend.addConnection(link.client, { hostId: HOST_SENDER_ID });
  return { repo, backend, link };
}

async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("a second browser learns who wrote the first browser's change", async (t) => {
  const f = await fixture(t);
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const identity = {
    principal: "user:anaconda-fixture:fixture-user",
    displayName: "Fixture",
    driver: "Browser",
    canWrite: true,
    expiresAt: Date.now() + 3_600_000,
  };
  const a = await connectBrowser(host, identity, "b-a");
  const b = await connectBrowser(host, identity, "b-b");
  try {
    const ha = await a.repo.find(f.args.document_id);
    const hb = await b.repo.find(f.args.document_id);
    const seen = [];
    hb.on("ephemeral-message", (e) => seen.push(e));
    ha.change((d) => (d.fromA = true));
    const hash = A.decodeChange(A.getLastLocalChange(ha.doc())).hash;
    await until(() => hb.doc().fromA === true);
    await until(() => seen.some((e) => e.message?.attestedChanges?.[hash]));
    const delta = seen.find((e) => e.message?.attestedChanges?.[hash]);
    assert.equal(delta.senderId, HOST_SENDER_ID);
    assert.equal(delta.message.actorProfiles[A.getActorId(ha.doc())].displayName, "Fixture");
  } finally {
    await a.repo.shutdown();
    await b.repo.shutdown();
  }
});

test("a restarted automerge Page has its stored comments before the comments handle is ready", async (t) => {
  const f = await fixture(t);
  const first = f.page();
  assert.ok((await f.register(first)).ok);
  assert.ok(first.commentsHandle, "comments are open");
  await first.commentsHandle.change((d) => {
    d.threads.t1 = { target: "page", messages: {} };
  });
  await first.flush();
  await first.plain.close();
  const restarted = f.page();
  await restarted.ready;
  assert.ok(restarted.commentsHandle.doc().threads.t1, "stored thread present at once");
});

test("purge deletes every plain key, from metadata, and a retry is harmless", async (t) => {
  const f = await fixture(t);
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  await host.handle.change((d) => (d.x = 1));
  await host.flush();
  const ids = [host.metadata.documentId, host.commentsHandle.documentId];
  assert.ok([...f.storage.values.keys()].some((k) => k.startsWith("plain/actor/")));
  await host.plain.forget(ids);
  assert.deepEqual(
    [...f.storage.values.keys()].filter((k) => k.startsWith("plain/")),
    [],
  );
  await host.plain.forget(ids);
});

test("an API key's renewal moves a plain connection's lease; OIDC keeps its deadline", async (t) => {
  const f = await fixture(t);
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const base = {
    principal: "user:anaconda-fixture:fixture-user",
    displayName: "Fixture",
    driver: "API",
    canWrite: true,
  };
  const socket = () => Object.assign(new EventTarget(), { send() {}, close() {} });
  const now = Date.now();
  const key = host.plain.accept(
    socket(),
    { ...base, credentialKind: "api-key", expiresAt: now + 60_000 },
    { senderId: "b-k" },
  );
  host.plain.renew(key, {
    ...base,
    credentialKind: "api-key",
    expiresAt: now + 120_000,
  });
  assert.equal(key.expiresAt, now + 120_000);
  const oidc = host.plain.accept(
    socket(),
    { ...base, credentialKind: "oidc", expiresAt: now + 60_000 },
    { senderId: "b-o" },
  );
  host.plain.renew(oidc, {
    ...base,
    credentialKind: "oidc",
    expiresAt: now + 120_000,
  });
  assert.equal(oidc.expiresAt, now + 60_000);
});

import { plainSender } from "./plain-sync.mjs";

test("plainSender keeps a tab's id, replaces only the same principal and driver, and mints otherwise", () => {
  const tab = `b-${crypto.randomUUID()}`;
  const mint = () => "b-minted";
  const me = { principal: "user:a", driver: "Browser" };
  const held = { senderId: tab, principal: "user:a", driver: "Browser" };
  const cases = [
    ["no id", [], undefined, { senderId: "b-minted", replaces: null }],
    ["malformed id", [], "b-not-a-uuid", { senderId: "b-minted", replaces: null }],
    ["free id", [], tab, { senderId: tab, replaces: null }],
    ["held by this tab", [held], tab, { senderId: tab, replaces: held }],
    [
      "held by another principal",
      [{ ...held, principal: "user:b" }],
      tab,
      { senderId: "b-minted", replaces: null },
    ],
    [
      "held by another driver",
      [{ ...held, driver: "API" }],
      tab,
      { senderId: "b-minted", replaces: null },
    ],
    [
      "held by a closed socket",
      [{ ...held, closed: true }],
      tab,
      { senderId: tab, replaces: null },
    ],
    ["held by the host", [{ ...held, trusted: true }], tab, { senderId: tab, replaces: null }],
  ];
  for (const [label, connections, requested, expected] of cases)
    assert.deepEqual(plainSender(connections, me, requested, mint), expected, label);
});

test("a tab's new plain socket replaces its stale one and takes its connection slot", async (t) => {
  const f = await fixture(t);
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const sockets = [];
  class Socket extends EventTarget {
    accept() {}
    send() {}
    close(code, reason) {
      if (this.closed) return;
      this.closed = { code, reason };
      this.dispatchEvent(new Event("close"));
    }
  }
  const globals = {
    WebSocketPair: class {
      constructor() {
        this[0] = new Socket();
        this[1] = new Socket();
        sockets.push(this[1]);
      }
    },
    Response: class {
      constructor(_body, options) {
        Object.assign(this, options);
      }
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  const denials = [];
  t.mock.method(console, "warn", (line) => denials.push(JSON.parse(line)));
  t.mock.method(console, "info", () => {});
  const identity = {
    principal: "user:anaconda-fixture:fixture-user",
    displayName: "Fixture",
    driver: "Browser",
    credentialKind: "api-key",
    canWrite: true,
    expiresAt: Date.now() + 3_600_000,
  };
  const open = (sender, who = identity) => {
    const url = new URL("https://pages.invalid/api/sync");
    url.searchParams.set("sync", "automerge");
    url.searchParams.set("sender", sender);
    const response = host.connect(new Request(url, { headers: { upgrade: "websocket" } }), who);
    assert.equal(response.status, 101);
    return sockets.at(-1);
  };
  const browsers = () =>
    host.plain.host
      .connections()
      .filter((conn) => !conn.trusted)
      .map((conn) => conn.senderId)
      .sort();
  const tabs = [1, 2, 3, 4].map(() => `b-${crypto.randomUUID()}`);
  const first = tabs.map((tab) => open(tab));
  assert.equal(host.wires.size, 4);
  // A fifth tab is over the account's four sockets.
  assert.deepEqual(open(`b-${crypto.randomUUID()}`).closed, {
    code: 4503,
    reason: "temporarily_unavailable",
  });
  // The same account through another driver can't take a tab's id.
  assert.deepEqual(open(tabs[1], { ...identity, driver: "API" }).closed, {
    code: 4503,
    reason: "temporarily_unavailable",
  });
  assert.equal(first[1].closed, undefined);
  // Tab 1 reconnects while its old socket still looks open.
  const before = denials.length;
  const again = open(tabs[0]);
  assert.equal(again.closed, undefined);
  assert.deepEqual(first[0].closed, { code: 4409, reason: "access_changed" });
  assert.equal(host.wires.size, 4);
  assert.equal(host.wirePrincipals.size, 4);
  assert.deepEqual(browsers(), [...tabs].sort());
  assert.deepEqual(
    denials.slice(before).map(({ stage, reason, code }) => ({ stage, reason, code })),
    [{ stage: "native", reason: "plain_session_replaced", code: "access_changed" }],
  );
});

/** A frame-level browser socket on `page`, without a Repo. */
function rawSocket(page, identity, { features = [...BUILD_FEATURES], senderId }) {
  const link = framePipe();
  const socket = new EventTarget();
  socket.send = (bytes) => link.host.send(decodeForTest(bytes));
  socket.close = (code, reason) => link.host.close(code, reason);
  link.host.onMessage((frame) =>
    socket.dispatchEvent(Object.assign(new Event("message"), { data: encodeForTest(frame) })),
  );
  link.host.onClose(() => socket.dispatchEvent(new Event("close")));
  page.plain.accept(socket, identity, { features, senderId });
  const frames = [];
  link.client.onMessage((frame) => frames.push(frame));
  return { client: link.client, frames };
}

const helloWith = (changes) => {
  const m = A.decodeSyncMessage(A.generateSyncMessage(A.init(), A.initSyncState())[1]);
  m.changes = changes;
  return A.encodeSyncMessage(m);
};

test("every plain refusal logs page.sync_refused once, and its repeats once at close", async (t) => {
  const f = await fixture(t);
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const lines = [];
  t.mock.method(console, "warn", (line) => lines.push(JSON.parse(line)));
  const refusedLines = () => lines.filter((line) => line.event === "page.sync_refused");
  const identity = {
    principal: "user:anaconda-fixture:fixture-user",
    displayName: "Fixture",
    driver: "Browser",
    credentialKind: "api-key",
    canWrite: true,
    expiresAt: Date.now() + 3_600_000,
  };
  const doc = treeHex(f.args.document_id);
  const edit = (n) => A.getLastLocalChange(A.change(A.clone(host.handle.doc()), (d) => (d.n = n)));

  // A build without the Page's schema features: fatal, closes the socket.
  const stale = rawSocket(host, identity, { features: [], senderId: "b-stale" });
  stale.client.send({ t: "sync", doc, m: helloWith([edit(1)]), r: 1 });
  await until(() => stale.client.closed);
  assert.deepEqual(refusedLines(), [
    {
      service: "nteract-pages-native",
      event: "page.sync_refused",
      page_id: pageId,
      doc: "page",
      reason: "schema_unsupported",
      fatal: true,
      code: "schema_unsupported",
      status: 409,
      close: 4426,
      credential: "api-key",
      timestamp: refusedLines()[0].timestamp,
    },
  ]);

  // The conversion fence refuses each write, non-fatally: one line now, the
  // repeats when the socket closes.
  t.mock.method(host, "conversionWriteFence", () =>
    Object.assign(new Error("Converting"), { reason: "preserved_markdown_converting" }),
  );
  const fenced = rawSocket(host, identity, { senderId: "b-fenced" });
  for (let r = 1; r <= 3; r++) fenced.client.send({ t: "sync", doc, m: helloWith([edit(r)]), r });
  await until(() => fenced.frames.filter((frame) => frame.t === "refused").length === 3);
  assert.equal(refusedLines().length, 2);
  assert.deepEqual(
    (({ reason, fatal, repeats }) => ({ reason, fatal, repeats }))(refusedLines()[1]),
    { reason: "temporarily_unavailable", fatal: false, repeats: undefined },
  );
  fenced.client.close();
  await until(() => refusedLines().length === 3);
  assert.deepEqual((({ reason, repeats }) => ({ reason, repeats }))(refusedLines()[2]), {
    reason: "temporarily_unavailable",
    repeats: 2,
  });
  for (const line of refusedLines()) assert.ok(!JSON.stringify(line).includes(identity.principal));
});

test("a browser connection logs its sync-round latency when it closes", async (t) => {
  const f = await fixture(t);
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const lines = [];
  t.mock.method(console, "info", (line) => {
    try {
      lines.push(JSON.parse(line));
    } catch {
      /* Not a structured line. */
    }
  });
  const identity = {
    principal: "user:anaconda-fixture:fixture-user",
    displayName: "Fixture",
    driver: "Browser",
    credentialKind: "oidc",
    canWrite: true,
    expiresAt: Date.now() + 3_600_000,
  };
  const browser = await connectBrowser(host, identity, "b-rounds");
  try {
    const handle = await browser.repo.find(f.args.document_id);
    for (let n = 1; n <= 3; n++) {
      handle.change((d) => (d.n = n));
      await until(() => host.handle.doc().n === n);
    }
    assert.equal(lines.filter((line) => line.event === "page.sync_rounds").length, 0);
  } finally {
    await browser.repo.shutdown();
  }
  browser.link.client.close();
  await until(() => lines.some((line) => line.event === "page.sync_rounds"));
  const [record] = lines.filter((line) => line.event === "page.sync_rounds");
  assert.equal(record.page_id, pageId);
  assert.equal(record.credential, "oidc");
  assert.ok(record.rounds >= 1 && record.rounds <= 3, `rounds ${record.rounds}`);
  assert.ok(record.changes >= 3);
  assert.equal(
    Object.values(record.latency_ms_buckets).reduce((a, b) => a + b, 0),
    record.rounds,
  );
  assert.ok(!JSON.stringify(record).includes(identity.principal));
});

test("a refusal that lands after close counts into the connection's line, logged at release", async (t) => {
  const f = await fixture(t);
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const lines = [];
  t.mock.method(console, "warn", (line) => lines.push(JSON.parse(line)));
  const refused = () =>
    lines
      .filter((line) => line.event === "page.sync_refused")
      .map(({ reason, repeats }) => ({ reason, ...(repeats && { repeats }) }));
  const socket = Object.assign(new EventTarget(), { send() {}, close() {} });
  const conn = host.plain.accept(
    socket,
    {
      principal: "user:anaconda-fixture:fixture-user",
      displayName: "Fixture",
      driver: "Browser",
      credentialKind: "oidc",
      canWrite: true,
      expiresAt: Date.now() + 3_600_000,
    },
    { senderId: "b-late" },
  );
  const doc = { kind: "page" };
  const policy = host.plain.host.policy;
  const fence = { code: "temporarily_unavailable", fatal: false };
  policy.refused(conn, doc, fence);
  conn.closed = true;
  // Frames still running at close refuse after it, before the release.
  policy.refused(conn, doc, fence);
  policy.refused(conn, doc, { code: "closed", fatal: false });
  policy.refused(conn, doc, { code: "closed", fatal: false });
  assert.deepEqual(refused(), [{ reason: "temporarily_unavailable" }, { reason: "closed" }]);
  policy.released(conn);
  assert.deepEqual(refused(), [
    { reason: "temporarily_unavailable" },
    { reason: "closed" },
    { reason: "temporarily_unavailable", repeats: 1 },
    { reason: "closed", repeats: 1 },
  ]);
});
