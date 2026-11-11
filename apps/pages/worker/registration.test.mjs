import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { setRichMarkdown } from "../model/richtext-page.mjs";
import {
  MISSING_ANCESTOR_CASES,
  addInside,
  deleteContainer,
} from "../model/richtext-test-support.mjs";
import worker, { Catalog, Page } from "./index.mjs";
import { readRegistration } from "./registration.mjs";
import { DEFAULT_PAGE_QUOTA } from "./page-quota.mjs";
import { REPLAYED_RECEIPT_HEADER } from "./usage.mjs";
import { fingerprint, operationKey } from "./mutations.mjs";
import { plainStub } from "./plain-stub.mjs";

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
    nonce: "register-fixture",
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
            on() {},
            off() {},
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
            get plain() {
              return plainStub(this.repo);
            },
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
    /** The fixture caller's Catalog receipt key for `nonce`. */
    receiptKey: (nonce) =>
      operationKey({ nonce }, { principal: `user:anaconda-fixture:${auth.subject}` }, "catalog"),
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
  assert.equal(
    (await f.catalog().storage.get(await f.receiptKey("register-fixture"))).pending,
    false,
  );
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
    { nonce: "different-request" },
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
    ...[
      // A stored block holds exactly `position` and `richText`.
      (block) => (block.metadata = {}),
      (block) => (block.extension = "kept"),
      (block) => (block.id = "id"),
      (block) => (block.markdown = ""),
      (block) => delete block.position,
      (block) => delete block.richText,
      // A position the index can order: base-62 digits after the head.
      (block) => (block.position = new A.RawString("a!")),
      (block) => (block.position = new A.RawString("a0!")),
    ].map((edit) => ({
      initial_snapshot_base64: Buffer.from(
        A.save(A.change(A.clone(doc), (draft) => edit(draft.blocks[Object.keys(draft.blocks)[0]]))),
      ).toString("base64"),
    })),
    {
      initial_snapshot_base64: Buffer.from(
        A.save(
          A.change(A.clone(doc), (draft) => {
            // Comments never arrive in a bootstrap snapshot.
            draft.comments = { fake: { author: "someone else" } };
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

test("a draft two tabs merged into unmarked text or a container with no marker registers", async (t) => {
  const f = await fixture(t),
    { args, doc } = registration();
  const path = ["blocks", Object.keys(doc.blocks)[0], "richText"];
  // One tab deletes the paragraph, marker and all, while the other types into it.
  const deleted = A.change(A.clone(doc, { actor: "0a".repeat(16) }), (draft) =>
    A.splice(draft, path, 0, draft.blocks[path[1]].richText.length),
  );
  const typed = A.change(A.clone(doc, { actor: "0b".repeat(16) }), (draft) =>
    A.splice(draft, path, draft.blocks[path[1]].richText.length, 0, " typed"),
  );
  const draft = A.merge(deleted, typed);
  assert.deepEqual(A.spans(draft, path), [{ type: "text", value: " typed" }]);
  const request = {
    ...args,
    initial_snapshot_base64: Buffer.from(A.save(draft)).toString("base64"),
  };
  A.free(readRegistration(request).doc);
  assert.equal((await f.send(request)).status, 200);
  // A container one tab deleted while the other added a node inside it.
  for (const [name, { markdown, markers }] of Object.entries(MISSING_ANCESTOR_CASES)) {
    const seeded = A.change(A.clone(doc), (d) => setRichMarkdown(d, path[1], markdown));
    const merged = A.merge(
      A.change(A.clone(seeded, { actor: "0c".repeat(16) }), (d) => deleteContainer(d, path)),
      A.change(A.clone(seeded, { actor: "0d".repeat(16) }), (d) => addInside(d, path, markers)),
    );
    const read = readRegistration({
      ...args,
      initial_snapshot_base64: Buffer.from(A.save(merged)).toString("base64"),
    });
    assert.match(String(read.doc.blocks[path[1]].richText), /new/, name);
    A.free(read.doc);
  }
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
  // Entries a Catalog wrote before it stored key counts: the first capacity
  // check counts them.
  for (let i = 0; i < DEFAULT_PAGE_QUOTA; i++) await f.catalog().storage.put(`page/${i}`, {});
  const refused = await f.send(args);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: "This alpha release allows 250 Pages per account.",
    code: "page_quota_exceeded",
    limit: DEFAULT_PAGE_QUOTA,
    count: DEFAULT_PAGE_QUOTA,
  });
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
    arguments: { title: "API Page", markdown: "API text", nonce: "ordinary-create" },
  };
  const response = await f.send(body, { path: "/api/tools" });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.title, "API Page");
  assert.notEqual(receipt.page_id, pageId);
  assert.deepEqual(await (await f.send(body, { path: "/api/tools" })).json(), receipt);
});

test("a restart replays registration without replacing later persisted history", async (t) => {
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
  const close = (page) => page.plain?.close();
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
  assert.equal(
    (await f.catalog().storage.get(await f.receiptKey("register-fixture"))).pending,
    true,
  );
  const removal = {
    operation: "delete_page",
    arguments: {
      page_id: pageId,
      nonce: "cancel-local-create",
    },
  };
  assert.equal((await f.send(removal, { path: "/api/tools" })).status, 200);
  p.storage.fault = undefined;
  assert.equal((await f.send(args)).status, 409);
  assert.equal((await f.send({ ...args, nonce: "new-register-key" })).status, 409);
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
      nonce: "delete-registered",
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
  assert.equal((await f.send({ ...args, nonce: "new-register-key" })).status, 409);
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
        nonce: "purge-registered",
      },
    },
    { path: "/api/tools" },
  );
  assert.equal(purged.status, 200);
  assert.equal((await f.send({ ...args, nonce: "after-purge" })).status, 409);
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
      nonce: "delete-original-account",
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

test("a registration replays from the Catalog's receipt, or from the Page's", async (t) => {
  const f = await fixture(t),
    { args } = registration({ record_storage: "automerge" });
  const first = await f.send(args);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(f.page().page.metadata.recordStorage, "automerge");
  // The Catalog answers from its receipt.
  const replayed = await f.send(args);
  assert.equal(replayed.status, 200, await replayed.clone().text());
  assert.equal(replayed.headers.get(REPLAYED_RECEIPT_HEADER), null, "the marker stays internal");
  assert.deepEqual(await replayed.json(), await first.json());
  // A Catalog that lost its receipt reaches the Page, which replays its own.
  await f.catalog().storage.delete(await f.receiptKey("register-fixture"));
  await f.catalog().storage.delete(`page/${pageId}`);
  const fromPage = await f.send(args);
  assert.equal(fromPage.status, 200, await fromPage.clone().text());
  assert.equal((await fromPage.json()).document_id, args.document_id);
  assert.equal(f.page().page.metadata.recordStorage, "automerge");
});

test("a second creation request for a registered Page answers creation_conflict, at the Catalog and at the Page", async (t) => {
  const f = await fixture(t),
    { args } = registration();
  assert.equal((await f.send(args)).status, 200);
  // The Catalog holds the Page: another nonce is another creation request.
  const atCatalog = await f.send({ ...args, nonce: "another-request" });
  assert.equal(atCatalog.status, 409);
  assert.equal((await atCatalog.json()).code, "creation_conflict");
  // A Catalog that lost its record reaches the Page, which says the same.
  await f.catalog().storage.delete(`page/${pageId}`);
  const atPage = await f.send({ ...args, nonce: "a-third-request" });
  assert.equal(atPage.status, 409);
  assert.equal((await atPage.json()).code, "creation_conflict");
});

/** Usage lines written while `run` executes. */
async function usageLines(t, run) {
  const lines = [];
  t.mock.method(console, "info", (line) => {
    const parsed = JSON.parse(line);
    if (parsed.event === "pages.usage.v1") lines.push(parsed);
  });
  await run();
  return lines;
}

test("browser registration records page.create once; a replayed receipt records none", async (t) => {
  const f = await fixture(t),
    { args } = registration();
  let first, replay;
  const lines = await usageLines(t, async () => {
    first = await f.send(args);
    replay = await f.send(args);
  });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), await first.json());
  // The Catalog's replay marker is internal and never leaves the gateway.
  assert.equal(replay.headers.has(REPLAYED_RECEIPT_HEADER), false);
  const creates = lines.filter((line) => line.action === "page.create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].surface, "browser-sync");
  assert.equal(creates[0].operation, "register_page");
  assert.equal(creates[0].page_id, pageId);
  assert.equal(creates[0].principal, `user:anaconda-fixture:${f.auth.subject}`);
  // The fixture registers with an API key, so bearerDriver() reports "API".
  assert.equal(creates[0].driver, "API");
  assert.equal(creates[0].credential, "api-key");
  assert.doesNotMatch(JSON.stringify(lines), /Local Page|Original text/);
});

test("a replayed create_page on http-tools records the call but not a second page.create", async (t) => {
  const f = await fixture(t);
  const body = {
    operation: "create_page",
    arguments: { title: "Agent Page", markdown: "Body text", nonce: "usage-create" },
  };
  let first, replay;
  const lines = await usageLines(t, async () => {
    first = await f.send(body, { path: "/api/tools", headers: { "x-pages-driver": "Codex" } });
    replay = await f.send(body, { path: "/api/tools", headers: { "x-pages-driver": "Codex" } });
  });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  const created = await first.json();
  assert.equal((await replay.json()).page_id, created.page_id);
  assert.equal(replay.headers.has(REPLAYED_RECEIPT_HEADER), false);
  const calls = lines.filter((line) => line.action === "tool.call");
  assert.deepEqual(
    calls.map(({ surface, operation, kind, outcome }) => ({ surface, operation, kind, outcome })),
    [
      { surface: "http-tools", operation: "create_page", kind: "tool", outcome: "ok" },
      { surface: "http-tools", operation: "create_page", kind: "tool", outcome: "ok" },
    ],
  );
  const creates = lines.filter((line) => line.action === "page.create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].surface, "http-tools");
  assert.equal(creates[0].page_id, created.page_id);
  assert.equal(creates[0].driver, "Codex");
  assert.doesNotMatch(JSON.stringify(lines), /Agent Page|Body text/);
});

test("an unknown http-tools operation is recorded as unknown, never as sent", async (t) => {
  const f = await fixture(t);
  let response;
  const lines = await usageLines(t, async () => {
    response = await f.send(
      { operation: "summarize_secret_plans", arguments: {} },
      { path: "/api/tools" },
    );
  });
  assert.equal(response.status, 400);
  const [call] = lines;
  assert.equal(lines.length, 1);
  assert.equal(call.action, "tool.call");
  assert.equal(call.surface, "http-tools");
  assert.equal(call.operation, "unknown");
  assert.equal(call.outcome, "http_400");
  assert.doesNotMatch(JSON.stringify(lines), /secret_plans/);
});

test("a draft from before the comments stamp replays once registered, and is refused fresh", async (t) => {
  const f = await fixture(t),
    { args, doc } = registration();
  // The same draft as a build before the `comments-doc` stamp saved it.
  const unstamped = A.change(A.clone(doc), (draft) => {
    draft.schema.features = draft.schema.features.filter((id) => id !== "comments-doc");
  });
  const old = {
    ...args,
    initial_snapshot_base64: Buffer.from(A.save(unstamped)).toString("base64"),
  };
  // A fresh one reserves nothing.
  const fresh = await f.send(old);
  assert.equal(fresh.status, 409);
  assert.equal((await fresh.json()).code, "stored_form_unsupported");
  assert.equal(f.catalog().storage.values.size, 0);
  // An earlier build accepted it: register the current draft, then rewrite
  // the stored request digests as the unstamped draft's.
  const seen = [];
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, "digest", (algorithm, bytes) => {
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (value?.operation === "register_page") seen.push(value);
    } catch {}
    return digest(algorithm, bytes);
  });
  const first = await f.send(args);
  assert.equal(first.status, 200, await first.clone().text());
  const receipt = await first.json();
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", f.auth.fetch);
  const rewrite = async (value) =>
    fingerprint(
      value.operation,
      { ...value.args, initial_snapshot_base64: old.initial_snapshot_base64 },
      { principal: value.principal, driver: value.driver },
    );
  const [catalogDigest, pageDigest] = await Promise.all(seen.slice(0, 2).map(rewrite));
  const key = await f.receiptKey("register-fixture");
  const entry = await f.catalog().storage.get(key);
  await f.catalog().storage.put(key, { ...entry, fingerprint: catalogDigest });
  const record = await f.page().storage.get("host/document");
  const registered = { ...record, registration: pageDigest };
  await f.page().storage.put("host/document", registered);
  f.page().page.metadata = registered;
  // Its response was lost; the browser resends the bytes it saved.
  const replayed = await f.send(old);
  assert.equal(replayed.status, 200, await replayed.clone().text());
  assert.deepEqual(await replayed.json(), receipt);
  // A reservation still pending (the Page host accepted it, the response
  // was lost) reaches the Page, which replays from its record.
  const { receipt: _receipt, ...reserved } = await f.catalog().storage.get(key);
  await f.catalog().storage.put(key, { ...reserved, pending: true });
  await f.catalog().storage.put(`page/${pageId}`, {
    ...(await f.catalog().storage.get(`page/${pageId}`)),
    pending: true,
  });
  const fromPage = await f.send(old);
  assert.equal(fromPage.status, 200, await fromPage.clone().text());
  assert.equal((await fromPage.json()).document_id, args.document_id);
});
