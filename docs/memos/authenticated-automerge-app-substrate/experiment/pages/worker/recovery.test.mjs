import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Catalog, Page, PageRecords } from "./index.mjs";
import { documentMutation, recoverDocumentMutations } from "./mutations.mjs";

class Storage {
  values = new Map();
  writes = [];
  syncs = 0;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) await this.put(name, entry);
      return;
    }
    this.writes.push(key);
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async list({ prefix = "", startAfter = "", limit = 1000 } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .slice(0, limit),
    );
  }
  async sync() {
    this.syncs++;
  }
}
const pageId = "33333333-3333-4333-8333-333333333333";
const requestFor = (token, path, body) =>
  new Request(`https://pages.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const contextFor = (storage) => ({
  id: { name: pageId },
  storage,
  blockConcurrencyWhile: (fn) => fn(),
  waitUntil() {},
});
function mutationContext(storage, handle, flush) {
  return {
    storage,
    handle,
    flush,
    operation: "edit_page",
    args: { idempotency_key: "recoverable-edit", base_heads: A.getHeads(handle.doc()) },
    identity: { principal: "user:owner", driver: "ChatGPT" },
    apply: (draft) => {
      draft.toolNote = "survives restart";
    },
  };
}

// The intent survives a crash before application. Actual Automerge bytes
// exercise the dependency recovery in the Page constructor.
test("Page restart recovers an intent based on an unflushed WebSocket edit", async (t) => {
  const storage = new Storage();
  let doc = A.from({ page_id: pageId, text: "original" });
  await storage.put("fixture/document", A.save(doc));
  await storage.put("host/document", { pageId, documentId: "fixture", deleted: false });
  doc = A.change(doc, (draft) => {
    draft.humanNote = "received over WebSocket";
  });
  const base = A.getHeads(doc);
  const handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
  };
  const put = storage.put.bind(storage);
  storage.put = async (key, value) => {
    await put(key, value);
    if (key === "host/operation/recoverable-edit") throw Error("crash after intent write");
  };
  await assert.rejects(
    documentMutation(
      mutationContext(storage, handle, async () => {
        await storage.put("fixture/document", A.save(doc));
        await storage.sync();
      }),
    ),
    /crash after intent write/,
  );
  assert.equal(doc.toolNote, undefined);
  assert.equal((await storage.get("host/operation/recoverable-edit")).pending, true);
  assert.ok(A.hasHeads(A.load(await storage.get("fixture/document")), base));
  storage.put = put;
  t.mock.method(Page.prototype, "initializeRepo", async function () {
    let restored = A.load(await storage.get("fixture/document"));
    const recoveredHandle = {
      doc: () => restored,
      async update(fn) {
        restored = fn(restored);
      },
    };
    this.repo = {
      async find() {
        return recoveredHandle;
      },
      async flush() {
        await storage.put("fixture/document", A.save(restored));
      },
    };
    this.backend = { async flush() {} };
  });
  const restarted = new Page(contextFor(storage), {});
  await restarted.ready;
  assert.equal(restarted.handle.doc().humanNote, "received over WebSocket");
  assert.equal(restarted.handle.doc().toolNote, "survives restart");
  const receipt = await storage.get("host/operation/recoverable-edit");
  assert.equal(receipt.pending, false);
  assert.ok(A.hasHeads(A.load(await storage.get("fixture/document")), receipt.receipt.heads));
});

test("a failed base durability barrier records no mutation intent or tool changes", async () => {
  const storage = new Storage();
  let doc = A.from({ page_id: pageId, text: "unflushed" });
  const handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
  };
  const before = A.getHeads(doc);
  await assert.rejects(
    documentMutation(
      mutationContext(storage, handle, async () => {
        throw Error("base durability failed");
      }),
    ),
    /base durability failed/,
  );
  assert.equal(storage.values.size, 0);
  assert.deepEqual(A.getHeads(doc), before);
  assert.equal(doc.toolNote, undefined);
});

test("the base barrier precedes intent storage without dropping a concurrent edit", async () => {
  const storage = new Storage();
  let doc = A.from({ page_id: pageId, text: "base" });
  const handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
  };
  const events = [];
  const put = storage.put.bind(storage);
  storage.put = async (key, value) => {
    events.push(value.pending ? "intent" : "receipt");
    await put(key, value);
  };
  let flushes = 0;
  let persisted;
  const receipt = await documentMutation(
    mutationContext(storage, handle, async () => {
      events.push("flush");
      persisted = A.save(doc);
      if (++flushes === 1) {
        assert.equal(doc.toolNote, undefined);
        assert.equal(storage.values.size, 0);
        doc = A.change(doc, (draft) => {
          draft.laterHumanNote = "arrived during base flush";
        });
      }
    }),
  );
  assert.deepEqual(events, ["flush", "intent", "flush", "receipt"]);
  assert.equal(doc.laterHumanNote, "arrived during base flush");
  assert.ok(A.hasHeads(A.load(persisted), receipt.heads));
});

test("unknown Page lookups write no signer, repository, or host state", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const token = auth.apiKey();
  for (const [path, body, capable, status] of [
    // Admission routes answer a missing Page exactly as an unreadable one for
    // clients that declare the capability; others keep the legacy 404.
    ["/api/connect", undefined, true, 403],
    ["/api/sync", undefined, true, 403],
    ["/api/saved", { heads: ["a".repeat(64)] }, true, 403],
    ["/api/connect", undefined, false, 404],
    ["/api/saved", { heads: ["a".repeat(64)] }, false, 404],
    ["/internal/tool", { operation: "read_page", arguments: { page_id: pageId } }, true, 404],
  ]) {
    const storage = new Storage();
    const page = new Page(contextFor(storage), auth.env);
    await page.ready;
    const request = requestFor(token, path, body);
    if (capable) request.headers.set("x-pages-admission", "1");
    const response = await page.fetch(request);
    assert.equal(response.status, status, `${path} capable=${capable}`);
    if (status === 403)
      assert.deepEqual(await response.json(), {
        error: "Document access denied",
        code: "page_access_denied",
      });
    assert.equal(storage.values.size, 0);
    assert.deepEqual(storage.writes, []);
    assert.equal(page.signer, undefined);
    assert.equal(page.repo, undefined);
  }
});

test("valid creation and concurrent initialization share one persisted signer", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  const page = new Page(contextFor(storage), auth.env);
  await page.ready;
  t.after(async () => {
    await page.repo?.shutdown();
    await page.backend?.close();
    page.signer?.free();
  });
  const get = storage.get.bind(storage);
  let release, started;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  storage.get = async (key) => {
    if (key === "host/signer") {
      started();
      await waiting;
    }
    return get(key);
  };
  const creating = page.fetch(
    requestFor(auth.apiKey(), "/internal/create", {
      page_id: pageId,
      title: "Created lazily",
      markdown: "Content",
    }),
  );
  await entered;
  const initialization = [page.initializeRepo(), page.initializeRepo()];
  assert.equal(initialization[0], initialization[1]);
  release();
  assert.equal((await creating).status, 201);
  await Promise.all(initialization);
  assert.equal(storage.writes.filter((key) => key === "host/signer").length, 1);
  assert.equal(page.handle.doc().title, "Created lazily");
  assert.ok(await storage.get("host/document"));
  assert.equal(await storage.get("host/creation"), undefined);
});

test("a new purge key completes failed deletion barriers before clearing its catalog row", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const token = auth.apiKey();
  const storage = new Storage();
  let failing = false;
  storage.sync = async () => {
    storage.syncs++;
    if (failing) throw Error("deletion sync failed");
  };
  const doc = A.from({ page_id: pageId, text: "Delete me" });
  let deletions = 0;
  const page = Object.assign(Object.create(Page.prototype), {
    ready: Promise.resolve(),
    env: auth.env,
    ctx: contextFor(storage),
    metadata: {
      pageId,
      documentId: "fixture",
      owner: `user:anaconda-fixture:${auth.subject}`,
      deleted: false,
    },
    handle: { doc: () => doc },
    wires: new Set(),
    policy: { async close() {}, async refreshAccess() {} },
    repo: {
      async delete() {
        deletions++;
      },
    },
    backend: { async flush() {} },
  });
  const catalogStorage = new Storage();
  await catalogStorage.put(`page/${pageId}`, { page_id: pageId, title: "Delete me" });
  const catalog = new Catalog(
    { id: { name: page.metadata.owner }, storage: catalogStorage },
    {
      ...auth.env,
      PAGES: { getByName: () => ({ fetch: (request) => page.run(request) }) },
    },
  );
  const call = (operation, args) =>
    catalog.fetch(requestFor(token, "/internal/catalog", { operation, arguments: args }));
  const trashed = await call("delete_page", {
    page_id: pageId,
    base_heads: A.getHeads(doc),
    idempotency_key: "trash-first",
  });
  assert.equal(trashed.status, 200);
  assert.equal(deletions, 0);
  const preview = await (await call("purge_page", { page_id: pageId, action: "preview" })).json();
  const args = { page_id: pageId, action: "confirm", preview_token: preview.preview_token };
  const purge = (key, extra = {}) =>
    call("purge_page", { ...args, idempotency_key: key, ...extra });
  failing = true;
  const syncs = storage.syncs;
  assert.equal((await purge("original-purge")).status, 500);
  assert.equal((await purge("replacement-purge")).status, 500);
  assert.ok(await catalogStorage.get(`trash/${pageId}`));
  assert.equal((await catalogStorage.get("host/operation/replacement-purge")).pending, true);
  // The purged record must be durable before document storage is deleted.
  assert.equal(deletions, 0);
  failing = false;
  const response = await purge("replacement-purge");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { page_id: pageId, deleted: true, purged: true });
  assert.equal(await catalogStorage.get(`trash/${pageId}`), undefined);
  assert.equal(await catalogStorage.get(`host/deleted/${pageId}`), true);
  assert.equal(deletions, 1);
  assert.equal(storage.syncs - syncs, 4);
  assert.equal((await purge("original-purge", { extra: true })).status, 409);
  assert.equal(
    (
      await page.run(
        requestFor(token, "/internal/purge", {
          ...args,
          idempotency_key: "original-purge",
          extra: true,
        }),
      )
    ).status,
    409,
  );
});

test("deleting a missing Page durably removes only the caller's stale catalog entry", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  await storage.put(`page/${pageId}`, { page_id: pageId, title: "Stale" });
  await storage.put("page/other", { page_id: "other", title: "Retained" });
  const catalog = new Catalog(
    { id: { name: `user:anaconda-fixture:${auth.subject}` }, storage },
    {
      ...auth.env,
      PAGES: {
        getByName: () => ({
          fetch: async () => Response.json({ error: "Page not found" }, { status: 404 }),
        }),
      },
    },
  );
  const response = await catalog.fetch(
    requestFor(auth.apiKey(), "/internal/catalog", {
      operation: "delete_page",
      arguments: { page_id: pageId, idempotency_key: "missing-delete" },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(await storage.get(`page/${pageId}`), undefined);
  assert.ok(await storage.get("page/other"));
  assert.equal((await storage.get("host/operation/missing-delete")).pending, false);
  assert.equal(storage.syncs, 1);
});

test("cached tool receipts retry a failed final durability barrier", async () => {
  const storage = new Storage();
  let doc = A.from({ page_id: pageId, text: "original" });
  let updates = 0;
  const handle = {
    doc: () => doc,
    async update(fn) {
      updates++;
      doc = fn(doc);
    },
  };
  let failing = true;
  let durableReceipt;
  let terminalSyncs = 0;
  storage.sync = async () => {
    storage.syncs++;
    const entry = await storage.get("host/operation/recoverable-edit");
    if (entry?.pending === false) {
      terminalSyncs++;
      if (failing) throw Error("receipt sync failed");
      durableReceipt = entry;
    }
  };
  const context = mutationContext(storage, handle, async () => {});
  await assert.rejects(documentMutation(context), /receipt sync failed/);
  const recorded = await storage.get("host/operation/recoverable-edit");
  assert.equal(recorded.pending, false);
  await assert.rejects(documentMutation(context), /receipt sync failed/);
  assert.equal(terminalSyncs, 2);
  assert.equal(durableReceipt, undefined);
  failing = false;
  assert.deepEqual(await documentMutation(context), recorded.receipt);
  assert.equal(terminalSyncs, 3);
  assert.equal(updates, 1);
  assert.deepEqual(durableReceipt, recorded);
});

for (const fault of ["signer-read", "signer-write", "policy-load"]) {
  test(`create retries ${fault} initialization failure with its exact recorded history`, async (t) => {
    const auth = await createAuthFixture();
    t.mock.method(globalThis, "fetch", auth.fetch);
    const storage = new Storage();
    const page = new Page(contextFor(storage), auth.env);
    await page.ready;
    t.after(async () => {
      await page.repo?.shutdown();
      await page.backend?.close();
      page.signer?.free();
    });
    let freed = 0;
    const free = N.MemorySigner.prototype.free;
    t.mock.method(N.MemorySigner.prototype, "free", function () {
      freed++;
      return free.call(this);
    });
    let failing = true;
    let attempts = 0;
    for (const [method, matches] of [
      ["get", (key) => key === "host/signer" && fault === "signer-read"],
      ["put", (key) => key === "host/signer" && fault === "signer-write"],
      ["list", (options) => options.prefix === "host/binding/" && fault === "policy-load"],
    ]) {
      const original = storage[method].bind(storage);
      storage[method] = async (...args) => {
        if (matches(args[0])) {
          attempts++;
          if (failing) throw Error(`transient ${fault}`);
        }
        return original(...args);
      };
    }
    const owner = auth.apiKey();
    const args = { page_id: pageId, title: "Original title", markdown: "Original content" };
    assert.equal((await page.fetch(requestFor(owner, "/internal/create", args))).status, 500);
    const intent = await storage.get("host/creation");
    assert.ok(intent);
    assert.equal(page.metadata, undefined);
    assert.equal(page.initializing, undefined);
    assert.equal(page.signer, undefined);
    assert.equal(page.repo, undefined);
    assert.equal(freed, fault === "policy-load" ? 1 : 0);
    failing = false;
    const attacker = auth.apiKey({ userId: "another-account" });
    assert.equal((await page.fetch(requestFor(attacker, "/internal/create", args))).status, 403);
    assert.equal(attempts, 1);
    assert.deepEqual(await storage.get("host/creation"), intent);
    const retry = await page.fetch(
      requestFor(owner, "/internal/create", {
        ...args,
        title: "Do not recreate",
        markdown: "Do not replace history",
      }),
    );
    assert.equal(retry.status, 201);
    assert.deepEqual(await retry.json(), intent.metadata.createdReceipt);
    assert.equal(page.metadata.documentId, intent.metadata.documentId);
    assert.deepEqual(A.getHeads(page.handle.doc()), intent.metadata.createdReceipt.heads);
    assert.deepEqual(A.getAllChanges(page.handle.doc()), A.getAllChanges(A.load(intent.bytes)));
    assert.equal(page.handle.doc().title, "Original title");
    assert.equal(await storage.get("host/creation"), undefined);
    assert.equal(storage.writes.filter((key) => key === "host/creation").length, 1);
    assert.equal(attempts, 2);
    assert.equal(page.initializing, undefined);
  });
}

/** PageRecords storage: multi-key put and delete, like Durable Object storage. */
class RecordStorage {
  values = new Map();
  async get(key) {
    return this.values.get(key);
  }
  async put(values) {
    for (const [key, value] of Object.entries(values))
      this.values.set(key, typeof value === "string" ? value : value.slice());
  }
  async delete(keys) {
    for (const key of keys) this.values.delete(key);
  }
  async sync() {}
  async list({ prefix, startAfter = "", limit }) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .slice(0, limit),
    );
  }
}

/** Apply one change as a loose commit: a hash with a leading zero byte would
 * head a fragment instead, so search fixed timestamps for the shape. */
async function looseChange(page, actor, change) {
  for (let time = 1_790_000_000; time < 1_790_004_096; time++) {
    const next = A.change(A.clone(page.handle.doc(), { actor }), { time }, change);
    const [head] = A.getHeads(next);
    const bytes = A.getLastLocalChange(next);
    A.free(next);
    if (head.startsWith("00")) continue;
    await page.handle.update((doc) => A.applyChanges(doc, [bytes])[0]);
    return { hash: head, bytes };
  }
  throw Error("No loose-commit change within the timestamp search bound");
}

const ACTORS = { left: "1a".repeat(16), right: "1b".repeat(16), merge: "1c".repeat(16) };

// Each shape names the stored change it loses and the frontier the Page must
// start on. A lost root leaves nothing buildable: startup fails, bounded.
const SHAPES = {
  "missing branch of a merge": async (page) => {
    const left = await looseChange(page, ACTORS.left, (doc) => {
      doc.left = "left";
    });
    const right = await looseChange(page, ACTORS.right, (doc) => {
      doc.right = "right";
    });
    await looseChange(page, ACTORS.merge, (doc) => {
      doc.merged = "merged";
    });
    return { lost: right, frontier: [left.hash] };
  },
  "missing middle of a chain": async (page) => {
    const first = await looseChange(page, ACTORS.left, (doc) => {
      doc.one = "one";
    });
    const middle = await looseChange(page, ACTORS.left, (doc) => {
      doc.two = "two";
    });
    await looseChange(page, ACTORS.left, (doc) => {
      doc.three = "three";
    });
    return { lost: middle, frontier: [first.hash] };
  },
  "missing root": async (page) => {
    await looseChange(page, ACTORS.left, (doc) => {
      doc.one = "one";
    });
    const [root] = A.getAllChanges(page.handle.doc()).map((change) => A.decodeChange(change));
    return { lost: { hash: root.hash, root: true }, frontier: [] };
  },
};

async function bufferedPages(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const warnings = [];
  t.mock.method(console, "warn", (line) => warnings.push(line));
  const storage = new Storage();
  const records = new RecordStorage();
  const env = {
    ...auth.env,
    PAGES_ASYNC_PERSISTENCE: "true",
    PAGE_RECORDS: { getByName: () => new PageRecords({ storage: records }) },
    CATALOGS: { getByName: () => ({ fetch: async () => Response.json({}) }) },
  };
  const pages = [];
  t.after(async () => {
    for (const page of pages) {
      await page.repo?.shutdown();
      await page.backend?.close();
      page.signer?.free();
    }
  });
  const open = () => {
    const page = new Page(contextFor(storage), env);
    pages.push(page);
    return page;
  };
  return { owner: auth.apiKey(), storage, records, warnings, open };
}

const within = (promise, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`${label} did not settle`)), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
};

for (const [shape, build] of Object.entries(SHAPES))
  for (const journal of [false, true]) {
    if (shape === "missing root" && journal) continue;
    test(`a buffered Page restarts with a ${shape}${journal ? " and replays the intent that holds it" : ""}`, async (t) => {
      const f = await bufferedPages(t);
      const first = f.open();
      await first.ready;
      const created = await first.fetch(
        requestFor(f.owner, "/internal/create", {
          page_id: pageId,
          title: "Kept",
          markdown: "Body",
        }),
      );
      assert.equal(created.status, 201);
      const { lost, frontier } = await build(first);
      const complete = A.getHeads(first.handle.doc());
      await first.flush();
      // Records stored without causal ordering can hold a child without its
      // parent. Drop the stored record that holds the lost change.
      const keys = [...f.records.values.keys()];
      const removed = lost.root
        ? keys.filter((key) => key.endsWith(`/commits/${lost.hash}`) || key.includes("/fragments/"))
        : keys.filter((key) => key.endsWith(`/commits/${lost.hash}`));
      assert.ok(removed.length, "the lost change is stored");
      for (const key of removed) f.records.values.delete(key);
      if (journal)
        // An interrupted API edit whose receipt was never written holds it.
        await f.storage.put("host/operation/lost-edit", {
          fingerprint: "fixture",
          pending: true,
          changes: [lost.bytes],
          receipt: { page_id: pageId, heads: [lost.hash] },
        });

      const restarted = f.open();
      if (!frontier.length) {
        await assert.rejects(within(restarted.ready, "Page startup"), /unavailable/);
        return;
      }
      await within(restarted.ready, "Page startup");
      const read = async () => {
        const response = await restarted.fetch(
          requestFor(f.owner, "/internal/tool", {
            operation: "read_page",
            arguments: { page_id: pageId, include_content: false },
          }),
        );
        assert.equal(response.status, 200);
        return response.json();
      };
      const connect = async () =>
        (await restarted.fetch(requestFor(f.owner, "/api/connect"))).json();
      const logged = f.warnings.map((line) => JSON.parse(line));
      assert.deepEqual(
        logged.map(({ event }) => event),
        ["page.history_incomplete"],
        "startup logs the incomplete history once",
      );
      if (journal) {
        assert.deepEqual(A.getHeads(restarted.handle.doc()).sort(), [...complete].sort());
        assert.equal((await f.storage.get("host/operation/lost-edit")).pending, false);
        assert.equal((await read()).history_incomplete, undefined);
        assert.equal((await connect()).historyIncomplete, undefined);
      } else {
        assert.deepEqual(A.getHeads(restarted.handle.doc()), frontier);
        assert.equal(restarted.handle.doc().title, "Kept");
        const body = await read();
        assert.equal(body.history_incomplete.code, "page_history_incomplete");
        assert.equal(body.history_incomplete.missing_dependencies, 1);
        assert.equal((await connect()).historyIncomplete.missing_dependencies, 1);
      }
    });
  }

test("startup recovery finds pending edits beyond a full default storage page", async () => {
  const storage = new Storage();
  for (let i = 0; i < 1001; i++)
    await storage.put(`host/operation/a-${i}`, {
      fingerprint: `done-${i}`,
      pending: false,
      receipt: { result: i },
    });
  let doc = A.from({ page_id: pageId, text: "accepted", stable: { name: "same object" } });
  const object = A.getObjectId(doc.stable);
  const edited = A.change(A.clone(doc), (draft) => {
    draft.text = "recovered";
  });
  const pending = {
    fingerprint: "pending",
    pending: true,
    changes: A.getChanges(doc, edited),
    receipt: { page_id: pageId, heads: A.getHeads(edited) },
  };
  await storage.put("host/operation/z-pending", pending);
  await recoverDocumentMutations(
    storage,
    {
      doc: () => doc,
      async update(fn) {
        doc = fn(doc);
      },
    },
    async () => {},
  );
  assert.equal(doc.text, "recovered");
  assert.equal(A.getObjectId(doc.stable), object);
  assert.equal((await storage.get("host/operation/z-pending")).pending, false);
  assert.deepEqual(A.getHeads(doc), pending.receipt.heads);
});
