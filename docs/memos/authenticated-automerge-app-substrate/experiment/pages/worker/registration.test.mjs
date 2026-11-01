import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import * as A from "@automerge/automerge";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import worker, { Catalog, Page } from "./index.mjs";
import { readRegistration } from "./registration.mjs";

class Storage {
  values = new Map();
  fault;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) await this.put(name, entry);
      return;
    }
    if (this.fault === key) throw Error("simulated storage failure");
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
  async list({ prefix = "", limit = Infinity } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }
  async sync() {
    if (this.fault === "sync") throw Error("simulated sync failure");
  }
}
const pageId = "33333333-3333-4333-8333-333333333333";
function registration(overrides = {}) {
  const doc = A.change(A.from(createPageData({ pageId, title: "Local Page" })), (draft) =>
    initializePage(draft, "Original text"),
  );
  const args = {
    page_id: pageId,
    expected_principal: "user:anaconda-fixture:fixture-user",
    document_id: interpretAsDocumentId(generateAutomergeUrl()),
    initial_snapshot_base64: Buffer.from(A.save(doc)).toString("base64"),
    title: "Local Page",
    idempotency_key: "register-fixture",
    ...overrides,
  };
  return { args, doc };
}
async function fixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const catalogs = new Map(),
    pages = new Map();
  const env = {
    ...auth.env,
    PAGES: {
      getByName(id) {
        if (!pages.has(id)) {
          const storage = new Storage();
          let doc;
          const handle = {
            doc: () => doc,
            update: async (update) => {
              doc = update(doc);
            },
          };
          const imports = [];
          const page = Object.assign(Object.create(Page.prototype), {
            ready: Promise.resolve(),
            env,
            ctx: { id: { name: id }, storage },
            tail: Promise.resolve(),
            policy: { async close() {}, async refreshAccess() {}, profiles: () => ({}) },
            wires: new Set(),
            repo: {
              async delete() {
                doc = undefined;
              },
              async import(bytes, options) {
                imports.push(options.docId);
                const original = A.load(bytes);
                doc = doc ? A.merge(doc, original) : original;
                return handle;
              },
              async flush() {
                if (storage.fault === "flush") throw Error("simulated flush failure");
              },
            },
            backend: { async flush() {} },
          });
          const entry = {
            page,
            storage,
            imports,
            handle,
            async fetch(request) {
              const response = await page.fetch(request);
              if (entry.loseResponse && response.ok) throw Error("simulated lost response");
              return response;
            },
          };
          pages.set(id, entry);
        }
        return pages.get(id);
      },
    },
    CATALOGS: {
      getByName(principal) {
        if (!catalogs.has(principal)) {
          const storage = new Storage();
          const catalog = new Catalog({ id: { name: principal }, storage }, env);
          catalogs.set(principal, { storage, fetch: (request) => catalog.fetch(request) });
        }
        return catalogs.get(principal);
      },
    },
  };
  const token = auth.apiKey();
  const send = (args, { key = token, path = "/api/pages/register", headers = {} } = {}) =>
    worker.fetch(
      new Request(`https://pages.invalid${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "x-pages-driver": "Browser", ...headers },
        body: JSON.stringify(args),
      }),
      env,
    );
  return {
    auth,
    send,
    pages,
    env,
    catalog: (user = auth.subject) => env.CATALOGS.getByName(`user:anaconda-fixture:${user}`),
    page: () => env.PAGES.getByName(pageId),
  };
}

test("registration imports the original history and native ID with host-owned identity", async (t) => {
  const f = await fixture(t),
    { args, doc } = registration();
  const response = await f.send({ ...args, owner: "user:forged", ownerName: "Imposter" });
  assert.equal(response.status, 200);
  const receipt = await response.json(),
    p = f.page();
  assert.deepEqual(receipt, {
    page_id: pageId,
    document_id: args.document_id,
    title: args.title,
    heads: A.getHeads(doc),
  });
  assert.equal(p.page.metadata.owner, `user:anaconda-fixture:${f.auth.subject}`);
  assert.equal(p.page.metadata.ownerName, "Fixture Person");
  assert.deepEqual(p.imports, [args.document_id]);
  assert.deepEqual(A.getHeads(p.handle.doc()), A.getHeads(doc));
  assert.equal(await p.storage.get("host/creation"), undefined);
  assert.equal((await f.catalog().storage.get(`page/${pageId}`)).pending, undefined);
});

test("ambiguous registration retry keeps one Page and preserves subsequent local edits", async (t) => {
  const f = await fixture(t),
    { args } = registration(),
    p = f.page();
  p.loseResponse = true;
  assert.equal((await f.send(args)).status, 500);
  const receipt = p.page.metadata.createdReceipt;
  await p.handle.update((doc) =>
    A.change(doc, (draft) => {
      draft.laterEdit = "Keep me";
    }),
  );
  p.loseResponse = false;
  assert.deepEqual(await (await f.send(args)).json(), receipt);
  assert.deepEqual(await (await f.send(args)).json(), receipt);
  assert.equal(p.handle.doc().laterEdit, "Keep me");
  assert.equal(p.imports.length, 1);
  assert.equal((await f.catalog().storage.list({ prefix: "page/" })).size, 1);
  assert.equal((await f.catalog().storage.get("host/operation/register-fixture")).pending, false);
});

for (const fault of ["host/document", "flush", "sync"]) {
  test(`registration recovers the immutable creation after ${fault} failure`, async (t) => {
    const f = await fixture(t),
      { args, doc } = registration(),
      p = f.page();
    p.storage.fault = fault;
    assert.equal((await f.send(args)).status, 500);
    p.storage.fault = undefined;
    const response = await f.send(args);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).heads, A.getHeads(doc));
    assert.deepEqual(A.getHeads(p.handle.doc()), A.getHeads(doc));
    assert.equal(await p.storage.get("host/creation"), undefined);
  });
}

test("foreign account registration cannot claim a Page or consume its own catalog slot", async (t) => {
  const f = await fixture(t),
    { args } = registration();
  assert.equal((await f.send(args)).status, 200);
  const before = f.page().page.metadata;
  const response = await f.send(
    { ...args, expected_principal: "user:anaconda-fixture:another-user" },
    { key: f.auth.apiKey({ userId: "another-user" }) },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(f.page().page.metadata, before);
  assert.equal((await f.catalog("another-user").storage.list({ prefix: "page/" })).size, 0);
  assert.equal(
    (await f.catalog("another-user").storage.list({ prefix: "host/operation/" })).size,
    0,
  );
});

test("altered ID, snapshot, title, or request key cannot overwrite an already registered Page", async (t) => {
  const f = await fixture(t),
    { args } = registration();
  assert.equal((await f.send(args)).status, 200);
  const before = A.getHeads(f.page().handle.doc());
  for (const changes of [
    { document_id: interpretAsDocumentId(generateAutomergeUrl()) },
    { initial_snapshot_base64: registration().args.initial_snapshot_base64 },
    { idempotency_key: "different-request" },
  ])
    assert.equal((await f.send({ ...args, ...changes })).status, 409);
  assert.equal((await f.send({ ...args, title: "Wrong title" })).status, 400);
  assert.deepEqual(A.getHeads(f.page().handle.doc()), before);
  assert.equal((await f.catalog().storage.list({ prefix: "page/" })).size, 1);
});

test("malformed and mismatched snapshots reserve no capacity and leave the key reusable", async (t) => {
  const f = await fixture(t),
    { args, doc } = registration();
  for (const changes of [
    { expected_principal: undefined },
    { expected_principal: null },
    { page_id: "not-a-uuid" },
    { page_id: crypto.randomUUID() },
    { document_id: "not-a-document-id" },
    { document_id: null },
    { document_id: "z".repeat(10000) },
    { document_id: interpretAsDocumentId(new Uint8Array(17)) },
    { title: "Wrong title" },
    { initial_snapshot_base64: "%%%invalid%%%" },
    { initial_snapshot_base64: Buffer.from("not Automerge").toString("base64") },
    {
      initial_snapshot_base64: Buffer.from(
        A.save(
          A.change(A.clone(doc), (draft) => {
            draft.blocks = [];
          }),
        ),
      ).toString("base64"),
    },
    {
      initial_snapshot_base64: Buffer.from(
        A.save(
          A.change(A.clone(doc), (draft) => {
            draft.comments.fake = { author: "someone else" };
          }),
        ),
      ).toString("base64"),
    },
  ]) {
    assert.equal((await f.send({ ...args, ...changes })).status, 400);
    assert.equal(f.catalog().storage.values.size, 0);
  }
  assert.equal((await f.send(args)).status, 200);
});

test("registration rejects oversized transport and native history before creating a Page", async (t) => {
  const f = await fixture(t),
    { args, doc } = registration();
  assert.equal(
    (await f.send({ ...args, initial_snapshot_base64: "AAAA".repeat(300_000) })).status,
    413,
  );
  const huge = A.change(A.clone(doc), (draft) => {
    draft.extra = new Uint8Array(randomBytes(950 * 1024));
  });
  assert.throws(
    () =>
      readRegistration({
        ...args,
        initial_snapshot_base64: Buffer.from(A.save(huge)).toString("base64"),
      }),
    { status: 413 },
  );
  assert.equal(f.catalog().storage.values.size, 0);
});

test("registration obeys account quota, same-origin and credential write gates", async (t) => {
  const f = await fixture(t),
    { args } = registration();
  assert.equal(
    (await f.send(args, { key: f.auth.apiKey({ scopes: ["cloud:read"] }) })).status,
    403,
  );
  assert.equal(
    (await f.send(args, { headers: { origin: "https://foreign.invalid" } })).status,
    403,
  );
  for (let i = 0; i < 100; i++) await f.catalog().storage.put(`page/${i}`, {});
  assert.equal((await f.send(args)).status, 409);
  assert.equal(f.pages.size, 0);
  assert.equal((await f.catalog().storage.list({ prefix: "host/operation/" })).size, 0);
});

test("ordinary create_page is unchanged and registration is not exposed as an operation", async (t) => {
  const f = await fixture(t),
    { args } = registration();
  assert.equal(
    (await f.send({ operation: "register_page", arguments: args }, { path: "/api/tools" })).status,
    400,
  );
  const body = {
    operation: "create_page",
    arguments: { title: "API Page", markdown: "API text", idempotency_key: "ordinary-create" },
  };
  const response = await f.send(body, { path: "/api/tools" });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.title, "API Page");
  assert.notEqual(receipt.page_id, pageId);
  assert.deepEqual(await (await f.send(body, { path: "/api/tools" })).json(), receipt);
});

test("native backend restart replays registration without replacing later persisted history", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage(),
    { args, doc } = registration();
  const token = auth.apiKey();
  const ctx = () => ({
    id: { name: pageId },
    storage,
    blockConcurrencyWhile: (fn) => fn(),
    waitUntil() {},
  });
  const send = (page) =>
    page.fetch(
      new Request("https://pages.invalid/internal/register", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "Browser" },
        body: JSON.stringify(args),
      }),
    );
  const close = async (page) => {
    await page.repo?.shutdown();
    await page.backend?.close();
    page.signer?.free();
  };
  // Use the actual native backend allocation rather than assuming the legacy
  // 16-byte generateAutomergeUrl format matches client-created documents.
  const source = new Page({ ...ctx(), storage: new Storage() }, auth.env);
  try {
    await source.ready;
    await source.initializeRepo();
    args.document_id = (await source.repo.import(A.save(doc))).documentId;
    assert.equal(documentIdToBinary(args.document_id).byteLength, 32);
  } finally {
    await close(source);
  }
  const first = new Page(ctx(), auth.env);
  storage.fault = "host/document";
  try {
    assert.equal((await send(first)).status, 500);
    await first.handle.change((draft) => {
      draft.afterRegistration = "Persisted before restart";
    });
    await first.flush();
  } finally {
    await close(first);
  }
  storage.fault = undefined;
  const restarted = new Page(ctx(), auth.env);
  try {
    await restarted.ready;
    assert.equal(restarted.handle.documentId, args.document_id);
    assert.ok(A.hasHeads(restarted.handle.doc(), A.getHeads(doc)));
    assert.equal(restarted.handle.doc().afterRegistration, "Persisted before restart");
    assert.deepEqual((await (await send(restarted)).json()).heads, A.getHeads(doc));
    assert.equal(await storage.get("host/creation"), undefined);
  } finally {
    await close(restarted);
  }
});

test("deletion cancels a reserved registration that never reached its Page intent", async (t) => {
  const f = await fixture(t),
    { args, doc } = registration(),
    p = f.page();
  p.storage.fault = "host/creation";
  assert.equal((await f.send(args)).status, 500);
  assert.equal(await p.storage.get("host/creation"), undefined);
  assert.equal((await f.catalog().storage.get("host/operation/register-fixture")).pending, true);
  const removal = {
    operation: "delete_page",
    arguments: {
      page_id: pageId,
      base_heads: A.getHeads(doc),
      idempotency_key: "cancel-local-create",
    },
  };
  assert.equal((await f.send(removal, { path: "/api/tools" })).status, 200);
  p.storage.fault = undefined;
  assert.equal((await f.send(args)).status, 409);
  assert.equal((await f.send({ ...args, idempotency_key: "new-register-key" })).status, 409);
  assert.equal(await f.catalog().storage.get(`page/${pageId}`), undefined);
  assert.equal(await f.catalog().storage.get(`host/deleted/${pageId}`), true);
  assert.equal(p.page.metadata, undefined);
});

test("Trash keeps completed registrations replayable and purge prevents revival", async (t) => {
  const f = await fixture(t),
    { args } = registration();
  const receipt = await (await f.send(args)).json();
  const removal = {
    operation: "delete_page",
    arguments: {
      page_id: pageId,
      base_heads: receipt.heads,
      idempotency_key: "delete-registered",
    },
  };
  const trashed = await f.send(removal, { path: "/api/tools" });
  assert.equal(trashed.status, 200);
  assert.equal((await trashed.json()).state, "trashed");
  // The browser forgets its local copy on "Page was deleted", so a trashed
  // Page must still replay its completed registration.
  const replay = await f.send(args);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), receipt);
  assert.equal((await f.send({ ...args, idempotency_key: "new-register-key" })).status, 409);
  assert.equal((await f.send(removal, { path: "/api/tools" })).status, 200);
  assert.equal(await f.catalog().storage.get(`page/${pageId}`), undefined);
  assert.ok(await f.catalog().storage.get(`trash/${pageId}`));
  assert.equal(f.page().page.metadata.deleted, true);
  assert.ok(f.page().page.metadata.trash);

  const preview = await (
    await f.send(
      { operation: "purge_page", arguments: { page_id: pageId, action: "preview" } },
      { path: "/api/tools" },
    )
  ).json();
  const purged = await f.send(
    {
      operation: "purge_page",
      arguments: {
        page_id: pageId,
        action: "confirm",
        preview_token: preview.preview_token,
        idempotency_key: "purge-registered",
      },
    },
    { path: "/api/tools" },
  );
  assert.equal(purged.status, 200);
  assert.equal((await f.send({ ...args, idempotency_key: "after-purge" })).status, 409);
  assert.equal(await f.catalog().storage.get(`trash/${pageId}`), undefined);
  assert.equal(await f.catalog().storage.get(`host/deleted/${pageId}`), true);
});

test("an account changed after local creation cannot register the draft under the new cookie", async (t) => {
  const f = await fixture(t),
    { args } = registration();
  // The local draft retains A's assertion while the browser now sends B's
  // verified credential, as when another tab signs into a different account.
  const changed = await f.send(args, { key: f.auth.apiKey({ userId: "another-user" }) });
  assert.equal(changed.status, 403);
  assert.equal((await f.catalog("another-user").storage.list({ prefix: "page/" })).size, 0);
  assert.equal(
    (await f.catalog("another-user").storage.list({ prefix: "host/operation/" })).size,
    0,
  );
  assert.equal(f.pages.size, 0);
  assert.equal((await f.send(args)).status, 200);
  assert.equal(f.page().page.metadata.owner, args.expected_principal);
});

test("Page independently rejects a mismatched account assertion before its creation intent", async (t) => {
  const f = await fixture(t),
    { args } = registration(),
    p = f.page();
  const response = await p.page.fetch(
    new Request("https://pages.invalid/internal/register", {
      method: "POST",
      headers: { authorization: `Bearer ${f.auth.apiKey({ userId: "another-user" })}` },
      body: JSON.stringify(args),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(p.storage.values.size, 0);
  assert.equal(p.imports.length, 0);
  assert.equal(p.page.metadata, undefined);
});

test("a changed account cannot cancel an unknown local draft in the wrong catalog", async (t) => {
  const f = await fixture(t),
    { args, doc } = registration();
  const removal = {
    operation: "delete_page",
    arguments: {
      page_id: pageId,
      base_heads: A.getHeads(doc),
      idempotency_key: "delete-original-account",
      expected_principal: args.expected_principal,
    },
  };
  const changed = await f.send(removal, {
    path: "/api/tools",
    key: f.auth.apiKey({ userId: "another-user" }),
  });
  assert.equal(changed.status, 403);
  assert.equal((await f.catalog("another-user").storage.list({ prefix: "page/" })).size, 0);
  assert.equal(
    (await f.catalog("another-user").storage.list({ prefix: "host/operation/" })).size,
    0,
  );
  assert.equal(f.pages.size, 0);
  assert.equal((await f.send(removal, { path: "/api/tools" })).status, 200);
  assert.equal(await f.catalog().storage.get(`host/deleted/${pageId}`), true);
  assert.equal((await f.catalog("another-user").storage.list({ prefix: "page/" })).size, 0);
  assert.equal(
    (await f.catalog("another-user").storage.list({ prefix: "host/operation/" })).size,
    0,
  );
});

test("registration refuses a draft stamped with a schema feature this host lacks", async (t) => {
  const f = await fixture(t),
    { args, doc } = registration();
  // A newer build's draft: a mark this host's registry doesn't know, and the
  // stamp for it. The stamp decides before content validation would reject it.
  const stamped = A.change(A.clone(doc), (draft) => {
    const id = Object.keys(draft.blocks)[0];
    A.mark(draft, ["blocks", id, "richText"], { start: 0, end: 4, expand: "none" }, "future", true);
    draft.schema = { features: ["future-feature"] };
  });
  const unstamped = A.change(A.clone(doc), (draft) => {
    const id = Object.keys(draft.blocks)[0];
    A.mark(draft, ["blocks", id, "richText"], { start: 0, end: 4, expand: "none" }, "future", true);
  });
  assert.throws(
    () =>
      readRegistration({
        ...args,
        initial_snapshot_base64: Buffer.from(A.save(unstamped)).toString("base64"),
      }),
    { status: 400, message: "Invalid initial Page snapshot" },
    "without a stamp, an unknown mark is a malformed draft",
  );
  const request = {
    ...args,
    initial_snapshot_base64: Buffer.from(A.save(stamped)).toString("base64"),
  };
  assert.throws(() => readRegistration(request), {
    status: 409,
    code: "unsupported_schema_feature",
  });
  const refused = await f.send(request);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "unsupported_schema_feature");
  assert.equal(f.catalog().storage.values.size, 0);
  assert.equal(f.pages.size, 0);
  // The same draft without the stamp registers.
  assert.equal((await f.send(args)).status, 200);
});
