import assert from "node:assert/strict";
import { readRevision } from "./operation-journal.mjs";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { Repo, cbor, generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { BUILD_FORMATS } from "../model/document-types.mjs";
import { BUILD_FEATURES } from "../model/schema-features.mjs";
import { AutomergeSyncBackend } from "../sync/backend.mjs";
import { DocStore, MemoryByteStore } from "../sync/doc-store.mjs";
import { framePipe } from "../sync/wire.mjs";
import { Page } from "./index.mjs";
import { HOST_SENDER_ID, PlainByteStore } from "./plain-sync.mjs";
import { documentMutation, operationKey } from "./mutations.mjs";
import { headsFor } from "./revisions.mjs";
import { applyComment } from "../model/comments.mjs";
import { blockAddress } from "../model/addresses.mjs";

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
// The revision handle the Page host names `heads` by, minted in its storage.
const revisionOf = (f, heads) => readRevision(f.storage, "page", heads);
const headsOf = (f, revision, doc = "page") => headsFor(f.storage, doc, revision);
// The fixture caller's edit receipt key for `nonce`.
const receiptKeyOf = (nonce) =>
  operationKey({ nonce }, { principal: "user:anaconda-fixture:fixture-user" }, "page");
// The journal entry for `key` in a put, alone or in a multi-key put.
const entryIn = (target, key, value) =>
  typeof key === "object" ? key[target] : key === target ? value : undefined;

async function fixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  const env = { ...auth.env };
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
    nonce: "register-plain",
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

const tool = (f, page, operation, args) =>
  page.fetch(
    new Request("https://pages.invalid/internal/tool", {
      method: "POST",
      headers: { authorization: `Bearer ${f.token}`, "x-pages-driver": "ChatGPT" },
      body: JSON.stringify({ operation, arguments: { page_id: pageId, ...args } }),
    }),
  );

function countWrites(t, storage) {
  const stats = { puts: 0, keys: 0, bytes: 0, deletes: 0, deletedKeys: 0, plainBytes: 0 };
  const put = storage.put.bind(storage);
  const del = storage.delete.bind(storage);
  t.mock.method(storage, "put", async (key, value) => {
    stats.puts++;
    for (const [k, v] of typeof key === "string" ? [[key, value]] : Object.entries(key)) {
      stats.keys++;
      // Binary values are charged verbatim; CBOR is a reproducible proxy for
      // structured values. Include UTF-8 key bytes, but not SQLite/LTX framing.
      const bytes =
        Buffer.byteLength(k) + (v instanceof Uint8Array ? v.byteLength : cbor.encode(v).byteLength);
      stats.bytes += bytes;
      if (k.startsWith("plain/")) stats.plainBytes += bytes;
    }
    return put(key, value);
  });
  t.mock.method(storage, "delete", async (keys) => {
    stats.deletes++;
    stats.deletedKeys += Array.isArray(keys) ? keys.length : 1;
    return del(keys);
  });
  return stats;
}

test("plain API edit write costs at 1, 10 and 100 consecutive edits", async (t) => {
  const f = await fixture(t);
  f.env.CATALOGS = { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  assert.equal((await tool(f, host, "read_page", { comments: "none" })).status, 200);
  await host.flush();
  const initialClaims = (await f.storage.list({ prefix: "plain/actor/" })).size;
  const block = blockAddress(host.handle.doc(), Object.keys(host.handle.doc().blocks)[0]);
  const stats = countWrites(t, f.storage);
  const actors = new Set();
  let changeBytes = 0;
  for (let n = 1; n <= 100; n++) {
    const heads = A.getHeads(host.handle.doc());
    const response = await tool(f, host, "edit_page", {
      revision: await revisionOf(f, heads),
      nonce: `write-cost-${String(n).padStart(3, "0")}`,
      operations: [
        {
          op: "replace_match",
          node_id: block,
          match_text: n % 2 ? "Original" : "Modified",
          replacement: n % 2 ? "Modified" : "Original",
        },
      ],
    });
    assert.equal(response.status, 200, await response.clone().text());
    await host.flush();
    for (const change of A.getChangesSince(host.handle.doc(), heads)) {
      actors.add(A.decodeChange(change).actor);
      changeBytes += change.byteLength;
    }
    if ([1, 10, 100].includes(n))
      t.diagnostic(
        JSON.stringify({
          edits: n,
          ...stats,
          changeBytes,
          actors: actors.size,
          newClaims: (await f.storage.list({ prefix: "plain/actor/" })).size - initialClaims,
        }),
      );
  }
  assert.equal(actors.size, 100);
  assert.ok(
    [...actors].every(
      (actor) => actor.startsWith(host.plain.hostActorPrefix) && /^[a-f0-9]{32}$/.test(actor),
    ),
  );
  assert.equal((await f.storage.list({ prefix: "plain/actor/" })).size, initialClaims);
  assert.ok(stats.plainBytes < 60_000, JSON.stringify(stats));
  assert.ok(stats.puts <= 301, JSON.stringify(stats));
  assert.equal(stats.deletes, 0);
});

test("the host prefix survives restart and rejects unseen browser actors without storing anything", async (t) => {
  const f = await fixture(t);
  f.env.CATALOGS = { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  let host = f.page();
  assert.ok((await f.register(host)).ok);
  const prefix = host.plain.hostActorPrefix;
  assert.match(prefix, /^[a-f0-9]{16}$/);
  for (let n = 1; n <= 2; n++) {
    const initialClaims = new Set((await f.storage.list({ prefix: "plain/actor/" })).keys());
    const response = await tool(f, host, "edit_page", {
      revision: await revisionOf(f, A.getHeads(host.handle.doc())),
      nonce: `actor-restart-${n}`,
      operations: [{ op: "set_title", title: `Title ${n}` }],
    });
    assert.equal(response.status, 200, await response.clone().text());
    const changes = A.getAllChanges(host.handle.doc())
      .map(A.decodeChange)
      .filter((c) => c.actor.startsWith(prefix));
    // Both API edits and the preceding direct handle changes use host actors.
    assert.equal(changes.length, 2 * n - 1);
    assert.ok(changes.every((c) => c.seq === 1));
    assert.ok(changes.every((c) => host.plain.host.actor(c.actor) === undefined));
    assert.deepEqual(
      new Set((await f.storage.list({ prefix: "plain/actor/" })).keys()),
      initialClaims,
    );
    const comment = await tool(f, host, "manage_page_comment", {
      nonce: `actor-comment-${n}`,
      action: "add",
      node_id: blockAddress(host.handle.doc(), Object.keys(host.handle.doc().blocks)[0]),
      body: `Comment ${n}`,
    });
    assert.equal(comment.status, 200, await comment.clone().text());
    assert.equal(
      A.getAllChanges(host.commentsHandle.doc())
        .map(A.decodeChange)
        .filter((c) => c.actor.startsWith(prefix)).length,
      n,
    );
    await host.handle.change((d) => {
      d.direct = n;
    });
    await host.flush();
    await host.plain.close();
    host = f.page();
    await host.ready;
    await host.documentReady();
    assert.equal(host.plain.hostActorPrefix, prefix);
    assert.equal(host.handle.doc().title, `Title ${n}`);
  }
  const actor = prefix + crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  assert.ok(!A.getAllChanges(host.handle.doc()).some((c) => A.decodeChange(c).actor === actor));
  const before = structuredClone(f.storage.values);
  const forged = A.change(A.clone(host.handle.doc(), { actor }), (d) => {
    d.title = "Forged";
  });
  const browser = rawSocket(
    host,
    {
      principal: "user:anaconda-fixture:fixture-user",
      driver: "Browser",
      canWrite: true,
      expiresAt: Date.now() + 3_600_000,
    },
    { senderId: "b-forger" },
  );
  browser.client.send({
    t: "sync",
    doc: treeHex(f.args.document_id),
    m: helloWith([A.getLastLocalChange(forged)]),
    r: 1,
  });
  await until(() => browser.frames.some((f) => f.t === "refused"));
  assert.equal(browser.frames.find((f) => f.t === "refused").code, "actor_claimed");
  assert.equal(browser.frames.find((f) => f.t === "refused").fatal, true);
  await until(() => browser.client.closed);
  assert.equal(host.handle.doc().title, "Title 2");
  assert.deepEqual(f.storage.values, before);
  A.free(forged);
});

for (const ambiguous of [false, true])
  test(`API-only append recovery keeps reads and identical retries live (ambiguous: ${ambiguous})`, async (t) => {
    const f = await fixture(t);
    f.env.CATALOGS = { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) };
    const host = f.page();
    assert.ok((await f.register(host)).ok);
    await host.flush();
    const before = host.handle.doc();
    const args = {
      revision: await revisionOf(f, A.getHeads(before)),
      nonce: "append-recovery",
      operations: [{ op: "set_title", title: "API recovered" }],
    };
    let failures = 2;
    const put = f.storage.put.bind(f.storage);
    t.mock.method(f.storage, "put", async (key, value) => {
      if (
        failures > 0 &&
        typeof key === "object" &&
        Object.keys(key).some((k) => k.startsWith("plain/sync/") && k.endsWith("/m2"))
      ) {
        failures--;
        if (ambiguous) await put(key, value);
        throw Error("history append failed");
      }
      return put(key, value);
    });
    const events = [];
    host.handle.on("heads-changed", (event) => events.push(event));
    const first = await tool(f, host, "edit_page", args);
    assert.equal(first.status, ambiguous ? 200 : 500, await first.clone().text());
    assert.equal(failures, ambiguous ? 1 : 0);
    if (!ambiguous) assert.deepEqual(host.handle.doc(), before);
    assert.equal(host.handle.doc().title, ambiguous ? "API recovered" : "Plain Page");
    assert.equal(events.length, ambiguous ? 1 : 0);
    const pending = await f.storage.get(await receiptKeyOf("append-recovery"));
    assert.equal(pending.pending, !ambiguous);
    const read = await tool(f, host, "read_page", { comments: "none" });
    assert.equal(read.status, 200, await read.clone().text());
    assert.equal((await read.json()).title, ambiguous ? "API recovered" : "Plain Page");
    const retry = await tool(f, host, "edit_page", args);
    assert.equal(retry.status, 200, await retry.clone().text());
    const receipt = await retry.json();
    for (const [key, value] of Object.entries(pending.receipt))
      assert.deepEqual(receipt[key], value);
    assert.equal(host.handle.doc().title, "API recovered");
    assert.equal(events.length, 1);
    const saved = await host.fetch(
      new Request("https://pages.invalid/api/saved", {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({
          heads: await headsOf(f, receipt.revision),
          schema_features: BUILD_FEATURES,
        }),
      }),
    );
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual((await saved.json()).durableHeads, await headsOf(f, receipt.revision));
    assert.equal((await tool(f, host, "edit_page", args)).status, 200);
    assert.equal(A.getChanges(before, host.handle.doc()).length, 1);
    assert.equal(events.length, 1);
    assert.equal(host.plain.host.connections().length, 0);
  });

for (const gate of ["capacity", "schema"])
  test(`trusted host admission refuses ${gate} before storing history`, async (t) => {
    const f = await fixture(t);
    const page = f.page();
    assert.ok((await f.register(page)).ok);
    await page.flush();
    const before = structuredClone(f.storage.values);
    const heads = A.getHeads(page.handle.doc());
    if (gate === "schema") page.plain.pageFeatures = () => ["future-schema"];
    const manifest = page.plain.host.store.manifest(treeHex(f.args.document_id));
    const original = structuredClone(manifest);
    if (gate === "capacity") manifest.snapshot = { bytes: 16 * 1024 * 1024 };
    await assert.rejects(
      page.handle.change((doc) => {
        doc.refused = true;
      }),
      {
        code: gate === "capacity" ? "history_capacity" : "schema_unsupported",
      },
    );
    assert.deepEqual(f.storage.values, before);
    assert.deepEqual(A.getHeads(page.handle.doc()), heads);
    await assert.rejects(
      page.handle.update(
        (doc) =>
          A.change(doc, (d) => {
            d.refused = true;
          }),
        { internal: true },
      ),
      {
        code: gate === "capacity" ? "history_capacity" : "schema_unsupported",
      },
    );
    page.plain.pageFeatures = () => [];
    Object.assign(manifest, original);
    await page.flush();
    assert.equal(page.handle.doc().refused, undefined);
  });

test("plain capacity refusal on restart preserves committed reads and the pending ordinary journal", async (t) => {
  const f = await fixture(t);
  f.env.CATALOGS = { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  await host.flush();
  const tree = treeHex(f.args.document_id);
  const key = await receiptKeyOf("capacity-recovery");
  const args = {
    revision: await revisionOf(f, A.getHeads(host.handle.doc())),
    nonce: "capacity-recovery",
    operations: [{ op: "set_title", title: "Pending title " + "long ".repeat(100) }],
  };
  const browser = rawSocket(
    host,
    {
      principal: f.args.expected_principal,
      driver: "Browser",
      canWrite: true,
      expiresAt: Date.now() + 3_600_000,
    },
    { senderId: "b-capacity" },
  );
  t.after(() => browser.client.close());
  const candidate = A.change(A.clone(host.handle.doc()), (d) => {
    d.browser = true;
  });
  const changes = A.getChanges(host.handle.doc(), candidate);
  A.free(candidate);
  // Scale byte accounting near the limit without allocating 16 MiB of history.
  // The real browser append consumes the space the journaled edit needed.
  let offset = 0;
  const manifest = DocStore.prototype.manifest;
  t.mock.method(DocStore.prototype, "manifest", function (id) {
    const value = manifest.call(this, id);
    return id === tree && value && offset
      ? { ...value, snapshot: { ...value.snapshot, bytes: (value.snapshot?.bytes ?? 0) + offset } }
      : value;
  });
  const put = f.storage.put.bind(f.storage);
  t.mock.method(f.storage, "put", async (name, value) => {
    await put(name, value);
    const entry = entryIn(key, name, value);
    if (!entry?.pending || offset) return;
    const stored = manifest.call(host.plain.host.store, tree);
    const pendingBytes = entry.changes.reduce((n, bytes) => n + bytes.byteLength, 0);
    assert.ok(changes.reduce((n, bytes) => n + bytes.byteLength, 0) < pendingBytes);
    offset =
      16 * 1024 * 1024 -
      pendingBytes -
      (stored.snapshot?.bytes ?? 0) -
      stored.chunks.reduce((n, chunk) => n + chunk.bytes, 0);
    browser.client.send({ t: "sync", doc: tree, m: helloWith(changes), r: 1 });
    await until(() => host.handle.doc().browser === true);
  });
  const refusals = [];
  const admit = host.plain.host.policy.admitTrusted;
  t.mock.method(host.plain.host.policy, "admitTrusted", (...args) => {
    try {
      return admit(...args);
    } catch (error) {
      refusals.push(error.code);
      throw error;
    }
  });
  const refused = await tool(f, host, "edit_page", args);
  assert.equal(refused.status, 500);
  assert.deepEqual(refusals, ["history_capacity"]);
  const pending = await f.storage.get(key);
  assert.equal(pending.pending, true);
  assert.ok(pending.changes.length);
  const committed = A.getHeads(host.handle.doc());
  assert.equal(host.handle.doc().title, "Plain Page");
  browser.client.close();
  await host.plain.close();

  const restarted = f.page();
  const read = await tool(f, restarted, "read_page", { comments: "none" });
  assert.equal(read.status, 200, await read.clone().text());
  const content = await read.json();
  assert.equal(content.title, "Plain Page");
  assert.deepEqual(await headsOf(f, content.revision), committed);
  assert.equal(content.recovery.code, "page_recovery_blocked");
  assert.equal(content.recovery.pending, true);
  assert.equal(restarted.handle.doc().browser, true);
  assert.deepEqual(await f.storage.get(key), pending);
  const edit = await tool(f, restarted, "edit_page", {
    ...args,
    revision: await revisionOf(f, committed),
  });
  assert.equal(edit.status, 409);
  assert.equal((await edit.json()).code, "page_recovery_blocked");
  assert.deepEqual(await f.storage.get(key), pending);
});

test("an abandoned pending intent does not block another principal and replays on restart", async (t) => {
  const f = await fixture(t);
  f.env.CATALOGS = { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const put = f.storage.put.bind(f.storage);
  const args = {
    revision: await revisionOf(f, A.getHeads(host.handle.doc())),
    nonce: "pending-actor-1",
    operations: [{ op: "set_title", title: "Recovered" }],
  };
  let fail = true;
  t.mock.method(f.storage, "put", async (key, value) => {
    await put(key, value);
    if (entryIn(await receiptKeyOf("pending-actor-1"), key, value)?.pending && fail) {
      fail = false;
      throw Error("ambiguous intent put");
    }
  });
  assert.equal((await tool(f, host, "edit_page", args)).status, 500);
  const pending = await f.storage.get(await receiptKeyOf("pending-actor-1"));
  await documentMutation({
    storage: f.storage,
    handle: host.handle,
    hostActorPrefix: host.plain.hostActorPrefix,
    operation: "edit_page",
    args: { ...args, nonce: "pending-actor-2" },
    identity: { principal: "user:other-editor", driver: "API" },
    apply: (d) => {
      d.otherEditor = true;
    },
    flush: () => host.flush(),
  });
  assert.equal(host.handle.doc().otherEditor, true);
  const retry = await tool(f, host, "edit_page", args);
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.deepEqual((await retry.json()).revision, pending.receipt.revision);
  // Leave a second intent pending across a restart.
  const args2 = {
    ...args,
    revision: await revisionOf(f, A.getHeads(host.handle.doc())),
    nonce: "pending-actor-3",
    operations: [{ op: "set_title", title: "Restart recovered" }],
  };
  t.mock.method(f.storage, "put", async (key, value) => {
    await put(key, value);
    if (entryIn(await receiptKeyOf("pending-actor-3"), key, value)?.pending)
      throw Error("crash after intent");
  });
  assert.equal((await tool(f, host, "edit_page", args2)).status, 500);
  t.mock.method(f.storage, "put", put);
  await host.plain.close();
  const restarted = f.page();
  await restarted.ready;
  await restarted.documentReady();
  assert.equal(restarted.handle.doc().title, "Restart recovered");
  assert.equal((await f.storage.get(await receiptKeyOf("pending-actor-3"))).pending, false);
  const next = await tool(f, restarted, "edit_page", {
    ...args2,
    revision: await revisionOf(f, A.getHeads(restarted.handle.doc())),
    nonce: "pending-actor-4",
    operations: [{ op: "set_title", title: "After recovery" }],
  });
  assert.equal(next.status, 200, await next.clone().text());
  assert.deepEqual(
    A.getAllChanges(restarted.handle.doc())
      .map(A.decodeChange)
      .filter((c) => c.actor.startsWith(host.plain.hostActorPrefix))
      .map((c) => c.seq),
    [1, 1, 1, 1],
  );
});

test("concurrent plain mutation candidates from the same heads use different actors and both apply", async (t) => {
  const f = await fixture(t);
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const heads = A.getHeads(host.handle.doc());
  const revision = await revisionOf(f, heads);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const built = [];
  const mutate = (field) =>
    documentMutation({
      storage: f.storage,
      handle: host.handle,
      hostActorPrefix: host.plain.hostActorPrefix,
      operation: "edit_page",
      args: { revision, nonce: `concurrent-${field}` },
      identity: { principal: `service:${field}`, driver: "API" },
      apply: (doc) => {
        built.push(field);
        doc[field] = true;
      },
      flush: async () => {
        await gate;
        await host.flush();
      },
    });
  const first = mutate("api");
  await until(() => built.length === 1);
  const second = mutate("conversion");
  await until(() => built.length === 2);
  assert.deepEqual(
    A.getHeads(host.handle.doc()),
    heads,
    "both candidates precede journaling and application",
  );
  release();
  await Promise.all([first, second]);
  assert.equal(host.handle.doc().api, true);
  assert.equal(host.handle.doc().conversion, true);
  const changes = A.getChangesSince(host.handle.doc(), heads).map(A.decodeChange);
  assert.equal(changes.length, 2);
  assert.equal(new Set(changes.map((c) => c.actor)).size, 2);
  assert.ok(changes.every((c) => c.actor.startsWith(host.plain.hostActorPrefix) && c.seq === 1));
  await host.plain.close();
  const restarted = f.page();
  await restarted.ready;
  await restarted.documentReady();
  assert.equal(restarted.handle.doc().api, true);
  assert.equal(restarted.handle.doc().conversion, true);
});

test("a split DO put never publishes a manifest before its chunk, descriptor and claims", async () => {
  const storage = new Storage();
  const bytes = new PlainByteStore(storage);
  const store = new DocStore(bytes);
  await store.append("d", Uint8Array.of(1), ["old"]);
  const put = storage.put.bind(storage);
  let puts = 0;
  storage.put = async (...args) => {
    if (++puts === 2) throw Error("crash between batches");
    return put(...args);
  };
  const claims = Array.from({ length: 128 }, (_, i) => [`actor/${i}`, cbor.encode({ host: true })]);
  await assert.rejects(store.append("d", Uint8Array.of(2), ["new"], claims), /crash/);
  assert.deepEqual((await new DocStore(bytes).read("d")).manifest.heads, ["old"]);
  storage.put = put;
  await new DocStore(bytes).append("d", Uint8Array.of(3), ["retry"], claims);
  assert.deepEqual(
    (await new DocStore(bytes).read("d")).chunks.map((c) => c[0]),
    [1, 3],
  );
  assert.equal((await storage.list({ prefix: "plain/actor/" })).size, 128);
});

test("a draft registers on plain sync whatever record storage it names", async (t) => {
  for (const recordStorage of [undefined, "native", "automerge"]) {
    const f = await fixture(t);
    if (recordStorage === undefined) delete f.args.record_storage;
    else f.args.record_storage = recordStorage;
    const page = f.page();
    const response = await f.register(page);
    assert.ok(response.ok, await response.clone().text());
    assert.equal(page.metadata.recordStorage, "automerge");
    assert.ok(page.plain, "the host runs PlainSync");
  }
});

test("a Page record that names Subduction storage is refused unless deleted", async (t) => {
  const f = await fixture(t);
  const first = f.page();
  assert.ok((await f.register(first)).ok);
  await first.plain.close();
  const record = await f.storage.get("host/document");
  await f.storage.put("host/document", { ...record, recordStorage: "buffered" });
  const native = f.page();
  await assert.rejects(
    native.ready.then(() => native.documentReady()),
    /Unsupported Page record storage mode/,
  );
  // A deleted one boots with nothing to serve and answers as deleted.
  await f.storage.put("host/document", { ...record, recordStorage: "buffered", deleted: true });
  const deleted = f.page();
  await deleted.ready;
  await deleted.initializeRepo();
  assert.ok(deleted.plain);
  await deleted.plain.close();
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
  await restarted.documentReady();
  assert.equal(restarted.handle.documentId, f.args.document_id);
  assert.ok(A.hasHeads(restarted.handle.doc(), A.getHeads(f.doc)));
  assert.equal(restarted.handle.doc().afterRegistration, "Persisted before restart");
  // The host's own edits are claimed by the host, never by a person.
  const claims = await new PlainByteStore(f.storage).list("actor/");
  assert.ok(claims.length >= 1);
});

test("a restarted automerge Page answers a shared-Page check from its record, then boots for a read", async (t) => {
  const f = await fixture(t);
  f.env.CATALOGS = { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const call = (p, path, body) =>
    p.fetch(
      new Request(`https://pages.invalid${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify(body),
      }),
    );
  const first = f.page();
  assert.ok((await f.register(first)).ok);
  // A read projects the title, which stores it for the next restart.
  const read = { operation: "read_page", arguments: { page_id: pageId, comments: "none" } };
  assert.equal((await call(first, "/internal/tool", read)).status, 200);
  assert.equal((await f.storage.get("host/title-projection")).title, "Plain Page");
  await first.flush();
  await first.plain.close();

  const restarted = f.page();
  await restarted.ready;
  assert.equal(restarted.startup.name, "metadata");
  const check = await call(restarted, "/internal/catalog", {});
  assert.equal(check.status, 200);
  assert.equal((await check.json()).title, "Plain Page");
  assert.equal(restarted.plain, undefined, "the check started no PlainSync");
  const again = await call(restarted, "/internal/tool", read);
  assert.equal(again.status, 200);
  assert.ok(restarted.plain, "the read booted the host");
  assert.equal(restarted.startup.name, "ready");
  await restarted.flush();
  await restarted.plain.close();

  // The same check, answered from the record and by a booted host over the
  // same storage, is the same answer.
  const before = structuredClone(f.storage.values);
  const lazy = f.page();
  await lazy.ready;
  const fromRecord = await (await call(lazy, "/internal/catalog", {})).json();
  assert.equal(lazy.plain, undefined);
  f.storage.values = structuredClone(before);
  const booted = f.page();
  await booted.ready;
  await booted.documentReady();
  const fromDocument = await (await call(booted, "/internal/catalog", {})).json();
  assert.deepEqual(fromRecord, fromDocument);
  assert.equal(fromRecord.role, "owner");
  assert.equal(fromRecord.title, "Plain Page");
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

test("browser usage writes follow durable admission, not read-only sync, retries or host tools", async (t) => {
  const f = await fixture(t);
  f.env.CATALOGS = { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const events = [];
  t.mock.method(console, "info", (line) => {
    const event = JSON.parse(line);
    if (["page.write", "comment.write"].includes(event.action)) events.push(event);
  });
  const identity = {
    principal: f.args.expected_principal,
    driver: "Browser",
    canWrite: true,
    expiresAt: Date.now() + 3_600_000,
  };
  const browser = await connectBrowser(host, identity, "b-usage");
  t.after(() => browser.repo.shutdown());
  const handle = await browser.repo.find(f.args.document_id);
  await browser.backend.synchronizeTree(treeOf(f.args.document_id));
  assert.deepEqual(events, [], "an idle read of the Page writes nothing");
  const block = Object.keys(handle.doc().blocks)[0];
  handle.change((draft) => {
    draft.title = "Browser edit";
  });
  await until(() => host.handle.doc().title === "Browser edit");
  assert.deepEqual(
    events.map((event) => event.action),
    ["page.write"],
  );
  assert.equal(events[0].principal, identity.principal);
  handle.change((draft) => {
    draft.title = "Second edit";
  });
  await until(() => host.handle.doc().title === "Second edit");
  assert.equal(events.length, 1);
  const edited = await tool(f, host, "edit_page", {
    revision: await revisionOf(f, A.getHeads(host.handle.doc())),
    nonce: "usage-agent-edit",
    operations: [
      {
        op: "replace_match",
        node_id: blockAddress(host.handle.doc(), block),
        match_text: "Original",
        replacement: "Agent",
      },
    ],
  });
  assert.ok(edited.ok, await edited.clone().text());
  assert.equal(events.length, 1, "host API edits do not count as browser writes");
  const reader = await connectBrowser(host, { ...identity, canWrite: false }, "b-read-only-usage");
  t.after(() => reader.repo.shutdown());
  const read = await reader.repo.find(f.args.document_id);
  assert.equal(read.doc().title, "Second edit");
  read.change((draft) => {
    draft.title = "Refused edit";
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(host.handle.doc().title, "Second edit");
  assert.equal(events.length, 1, "refused edits do not count");
  const comments = await browser.repo.find(host.commentsHandle.documentId);
  let thread;
  comments.change((draft) => {
    thread = applyComment(
      draft,
      { action: "add", block_id: block, body: "Browser comment" },
      identity,
      undefined,
      { page: handle.doc(), role: "owner", literal: true },
    ).thread_id;
  });
  await until(() => !!host.commentsHandle.doc().threads[thread]);
  assert.deepEqual(
    events.map((event) => event.action),
    ["page.write", "comment.write"],
  );
  comments.change((draft) => {
    applyComment(
      draft,
      { action: "reply", thread_id: thread, body: "Another comment" },
      identity,
      undefined,
      { page: handle.doc(), role: "owner", literal: true },
    );
  });
  await until(() => Object.keys(host.commentsHandle.doc().threads[thread].messages).length === 2);
  assert.equal(events.length, 2, "comments share the per-session/day dedupe");
  // The refused writer above can be disconnected; use a healthy observer to
  // verify that a telemetry exception does not interrupt live publication.
  const observer = await connectBrowser(host, { ...identity, canWrite: false }, "b-usage-observer");
  t.after(() => observer.repo.shutdown());
  const observed = await observer.repo.find(f.args.document_id);
  const writeHook = t.mock.method(host.plain, "onWrite", () => {
    throw Error("usage unavailable");
  });
  const profiles = [];
  const publish = host.plain.publish.bind(host.plain);
  t.mock.method(host.plain, "publish", (doc, message) => {
    profiles.push(message);
    publish(doc, message);
  });
  const actors = t.mock.method(host.plain, "onActors", () => {});
  handle.change((draft) => {
    draft.title = "Edit with broken telemetry";
  });
  const hash = A.getHeads(handle.doc())[0];
  await until(() => host.handle.doc().title === "Edit with broken telemetry");
  await until(() => observed.doc().title === "Edit with broken telemetry");
  assert.equal(writeHook.mock.callCount(), 1);
  assert.ok(
    host.plain.actorSnapshot().attestedChanges[hash],
    "attestation survives a usage exception",
  );
  assert.ok(
    profiles.some((message) => message.attestedChanges[hash]),
    "publication survives a usage exception",
  );
  assert.equal(actors.mock.callCount(), 1);
});

test("API edits on plain Pages name their principal independently of the host actor", async (t) => {
  const f = await fixture(t);
  f.env.CATALOGS = { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const principal = f.args.expected_principal;
  const browser = await connectBrowser(
    host,
    { principal, driver: "Browser", canWrite: true, expiresAt: Date.now() + 3_600_000 },
    "b-tool-edit",
  );
  try {
    const handle = await browser.repo.find(f.args.document_id);
    const messages = [];
    handle.on("ephemeral-message", (event) => messages.push(event));
    const response = await tool(f, host, "edit_page", {
      revision: await revisionOf(f, A.getHeads(handle.doc())),
      nonce: "principal-edit",
      operations: [{ op: "set_title", title: "Named API edit" }],
    });
    assert.equal(response.status, 200, await response.clone().text());
    const receipt = await response.json();
    const receiptHeads = await headsOf(f, receipt.revision);
    await until(() => messages.some((event) => event.message?.kind === "tool-edit"));
    const edit = messages.find((event) => event.message?.kind === "tool-edit");
    assert.equal(edit.senderId, HOST_SENDER_ID);
    assert.equal(edit.message.identity.principal, principal);
    assert.equal(edit.message.identity.driver, "ChatGPT");
    assert.deepEqual(edit.message.heads, receiptHeads);
    await until(() => A.hasHeads(handle.doc(), receiptHeads));
    assert.equal(handle.doc().title, "Named API edit");
    assert.equal(receiptHeads.length, 1);
    const change = A.getAllChanges(handle.doc())
      .map(A.decodeChange)
      .find((change) => change.hash === receiptHeads[0]);
    assert.ok(change);
    assert.ok(change.actor.startsWith(host.plain.hostActorPrefix));
    assert.equal(host.plain.host.actor(change.actor), undefined);

    const comments = await browser.repo.find(host.commentsHandle.documentId);
    const commentMessages = [];
    comments.on("ephemeral-message", (event) => commentMessages.push(event));
    const commentResponse = await tool(f, host, "manage_page_comment", {
      nonce: "principal-comment",
      action: "add",
      node_id: blockAddress(handle.doc(), Object.keys(handle.doc().blocks)[0]),
      body: "Named API comment",
    });
    assert.equal(commentResponse.status, 200, await commentResponse.clone().text());
    const commentReceipt = await commentResponse.json();
    const commentHeads = await headsOf(f, commentReceipt.comment_revision, "comments");
    await until(() => commentMessages.some((event) => event.message?.kind === "tool-edit"));
    const comment = commentMessages.find((event) => event.message?.kind === "tool-edit");
    assert.equal(comment.senderId, HOST_SENDER_ID);
    assert.equal(comment.message.identity.principal, principal);
    assert.equal(comment.message.comments, true);
    assert.deepEqual(comment.message.heads, commentHeads);
    await until(() => A.hasHeads(comments.doc(), commentHeads));
  } finally {
    await browser.repo.shutdown();
  }
});

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
  await restarted.documentReady();
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
  await host.plain.close();
  const metadata = { ...host.metadata, deleted: true, purged: true };
  await f.storage.put("host/document", metadata);
  const restarted = f.page();
  await restarted.ready;
  await restarted.initializeRepo(metadata);
  assert.equal(await f.storage.get("plain/host-actor-prefix"), undefined);
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
    url.searchParams.set("formats", BUILD_FORMATS);
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

  // A full history refuses each write, non-fatally: one line now, the
  // repeats when the socket closes.
  host.plain.host.store.manifest(doc).snapshot = { bytes: 16 * 1024 * 1024 };
  const fenced = rawSocket(host, identity, { senderId: "b-fenced" });
  for (let r = 1; r <= 3; r++) fenced.client.send({ t: "sync", doc, m: helloWith([edit(r)]), r });
  await until(() => fenced.frames.filter((frame) => frame.t === "refused").length === 3);
  assert.equal(refusedLines().length, 2);
  assert.deepEqual(
    (({ reason, fatal, repeats }) => ({ reason, fatal, repeats }))(refusedLines()[1]),
    { reason: "history_capacity", fatal: false, repeats: undefined },
  );
  fenced.client.close();
  await until(() => refusedLines().length === 3);
  assert.deepEqual((({ reason, repeats }) => ({ reason, repeats }))(refusedLines()[2]), {
    reason: "history_capacity",
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

test("a browser change that leaves a block out of shape is refused, non-fatally, and nothing is stored", async (t) => {
  const f = await fixture(t);
  f.env.CATALOGS = { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) };
  const host = f.page();
  assert.ok((await f.register(host)).ok);
  const identity = {
    principal: "user:anaconda-fixture:fixture-user",
    displayName: "Fixture",
    driver: "Browser",
    canWrite: true,
    expiresAt: Date.now() + 3_600_000,
  };
  const doc = treeHex(f.args.document_id);
  const writer = rawSocket(host, identity, { senderId: "b-writer" });
  // The reader is a sync peer: it applies each host frame and answers it.
  const reader = rawSocket(host, identity, { senderId: "b-reader" });
  let readerDoc = A.init();
  let readerState = A.initSyncState();
  let readerRound = 0;
  const answer = () => {
    let message;
    [readerState, message] = A.generateSyncMessage(readerDoc, readerState);
    if (message) reader.client.send({ t: "sync", doc, m: message, r: ++readerRound });
  };
  reader.client.onMessage((frame) => {
    if (frame.t !== "sync" || !frame.m) return;
    [readerDoc, readerState] = A.receiveSyncMessage(readerDoc, readerState, frame.m);
    answer();
  });
  answer();
  await until(() => A.hasHeads(readerDoc, A.getHeads(host.handle.doc())));
  const before = A.getHeads(host.handle.doc());
  const durable = await host.plain.durableHeads(f.args.document_id);
  const peer = (n) => A.clone(host.handle.doc(), { actor: n.toString(16).padStart(32, "0") });
  const newBlock = "55555555-5555-4555-8555-555555555555";

  const bad = A.change(peer(0xb1), (d) => {
    d.blocks[newBlock] = { position: new A.RawString("a5") };
  });
  writer.client.send({ t: "sync", doc, m: helloWith(A.getChanges(host.handle.doc(), bad)), r: 1 });
  await until(() => writer.frames.some((frame) => frame.t === "refused"));
  const refused = writer.frames.find((frame) => frame.t === "refused");
  assert.equal(refused.code, "invalid_block");
  assert.equal(refused.fatal, false);
  assert.equal(writer.client.closed, false);
  assert.deepEqual(A.getHeads(host.handle.doc()), before);
  assert.deepEqual(await host.plain.durableHeads(f.args.document_id), durable);
  const read = await tool(f, host, "read_page", { comments: "none" });
  assert.equal(read.status, 200, await read.clone().text());

  // The same socket's next change in shape is admitted and reaches the reader.
  const blockId = Object.keys(host.handle.doc().blocks)[0];
  const good = A.change(peer(0xb2), (d) =>
    A.splice(d, ["blocks", blockId, "richText"], 0, 0, "Hi "),
  );
  writer.client.send({ t: "sync", doc, m: helloWith(A.getChanges(host.handle.doc(), good)), r: 2 });
  await until(() => writer.frames.some((frame) => frame.t === "sync" && frame.r === 2));
  assert.equal(host.handle.doc().blocks[newBlock], undefined);
  assert.ok(A.hasHeads(host.handle.doc(), A.getHeads(good)));
  await until(() => A.hasHeads(readerDoc, A.getHeads(good)));
  assert.equal(readerDoc.blocks[newBlock], undefined);
  assert.ok(readerDoc.blocks[blockId].richText.startsWith("Hi "));
  assert.ok(!reader.frames.some((frame) => frame.t === "refused"));
});
