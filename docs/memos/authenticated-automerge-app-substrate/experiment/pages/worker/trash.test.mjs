import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { applyPageOperation, createPageData, initializePage } from "../model/page.mjs";
import { Catalog, Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { pageAccess, pageGrant, pageState, proposeAccessUpdate } from "./access.mjs";
import { fingerprint } from "./mutations.mjs";
import { inspectOperation } from "./operation-journal.mjs";
import { countCapacity, lifecycleSlot } from "./catalog.mjs";
import { PURGE_PREVIEW_TTL_MS } from "./trash.mjs";

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) await this.put(name, entry);
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async sync() {}
  async list({ prefix = "", limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix))
        .slice(0, limit),
    );
  }
}

const pageId = "33333333-3333-4333-8333-333333333333";
const serverKey = "f".repeat(64);
const ownerKey = "1".repeat(64);
const memberKey = "2".repeat(64);
const readerKey = "3".repeat(64);

async function fixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const owner = `user:anaconda-fixture:${auth.subject}`;
  const member = "user:anaconda-fixture:member-user";
  const tokens = {
    owner: auth.apiKey(),
    member: auth.apiKey({ userId: "member-user" }),
    stranger: auth.apiKey({ userId: "stranger-user" }),
  };
  let doc = A.change(A.from(createPageData({ pageId, title: "Launch plan" })), (draft) =>
    initializePage(draft, "We ship on Friday."),
  );
  const blockId = Object.keys(doc.blocks)[0];
  doc = A.change(doc, (draft) =>
    applyPageOperation(draft, {
      operation: "manage_page_comment",
      arguments: { action: "add", block_id: blockId, body: "Looks good" },
      identity: { principal: member, displayName: "Member", driver: "Browser" },
    }),
  );
  t.after(() => A.free(doc));
  const base = { pageId, owner, documentId: "fixture-document", tree: "a".repeat(32) };
  const ownerIdentity = { principal: owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  const acl = proposeAccessUpdate(base, ownerIdentity, {
    principal: member,
    role: "editor",
    expected_revision: 0,
  }).acl;
  const storage = new Storage();
  const tasks = [];
  const catalogs = new Map();
  let removed = 0;
  // `lost` drops that many Page responses after the Page has handled them.
  const network = { lost: 0 };
  const env = {
    ...auth.env,
    PAGES: {
      getByName: () => ({
        fetch: async (request) => {
          const response = await page.fetch(request);
          if (network.lost > 0) {
            network.lost--;
            return Response.json({ error: "Lost response" }, { status: 500 });
          }
          return response;
        },
      }),
    },
    CATALOGS: {
      getByName(principal) {
        if (!catalogs.has(principal)) {
          const catalogStorage = new Storage();
          catalogs.set(principal, {
            storage: catalogStorage,
            catalog: new Catalog({ id: { name: principal }, storage: catalogStorage }, env),
          });
        }
        const entry = catalogs.get(principal);
        return { fetch: (request) => entry.catalog.fetch(request) };
      },
    },
  };
  const build = (metadata) => {
    const instance = Object.assign(Object.create(Page.prototype), {
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      env,
      ctx: { storage, waitUntil: (promise) => tasks.push(promise) },
      metadata,
      handle: {
        doc: () => doc,
        broadcast() {},
        on() {},
        off() {},
      },
      wires: new Set(),
      serverKey,
      serverSenderId: "server-sender",
      repo: {
        async delete() {
          removed++;
        },
      },
      backend: { async flush() {} },
    });
    instance.policy = new DocumentPolicy({
      storage,
      metadata: () => instance.metadata,
      serverKey,
    });
    return instance;
  };
  let page = build({ ...base, ownerName: "Owner", deleted: false, acl });
  const catalogOf = (principal) => {
    env.CATALOGS.getByName(principal);
    return catalogs.get(principal);
  };
  await catalogOf(owner).storage.put(`page/${pageId}`, {
    page_id: pageId,
    title: "Launch plan",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
  await catalogOf(member).storage.put(`shared/${pageId}`, {
    page_id: pageId,
    title: "Launch plan",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    shared: true,
  });
  const request = (token, path, body, method = body === undefined ? "GET" : "POST", extra = {}) =>
    new Request(`https://pages.invalid${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT", ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const catalogCall = async (who, operation, args = {}) => {
    const response = await catalogOf(who === "member" ? member : owner).catalog.fetch(
      request(tokens[who], "/internal/catalog", { operation, arguments: args }),
    );
    return { status: response.status, body: await response.json() };
  };
  const pageCall = async (who, path, body, method, headers) => {
    const response = await page.fetch(request(tokens[who], path, body, method, headers));
    return { status: response.status, body: await response.json() };
  };
  const tool = (who, operation, args = {}) =>
    pageCall(who, "/internal/tool", { operation, arguments: { page_id: pageId, ...args } });
  const identity = (principal, canWrite = true) => ({
    principal,
    displayName: principal,
    driver: "Browser",
    canWrite,
    expiresAt: Date.now() + 60_000,
  });
  const disconnected = [];
  const bind = (key, principal) =>
    page.policy.bind(key, key, identity(principal), {
      reauthenticate: async () => identity(principal),
      disconnect: async () => {
        disconnected.push(key);
      },
    });
  return {
    auth,
    owner,
    member,
    storage,
    network,
    env,
    get page() {
      return page;
    },
    setPage(next) {
      page = next;
    },
    /** A new Page object over the same durable storage, as after eviction. */
    async restart() {
      page = build(await storage.get("host/document"));
      await page.policy.load();
      return page;
    },
    tasks,
    blockId,
    catalogOf,
    catalogCall,
    pageCall,
    tool,
    bind,
    disconnected,
    removed: () => removed,
    doc: () => doc,
    edit(text) {
      doc = A.change(doc, (draft) => {
        draft.title = text;
      });
    },
    heads: () => A.getHeads(doc),
  };
}

const trashArgs = (f, key = "trash-request") => ({
  page_id: pageId,
  base_heads: f.heads(),
  idempotency_key: key,
});

test("delete_page moves a Page to Trash and keeps its document, comments and ACL", async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.page.metadata);
  const comments = structuredClone(f.doc().comments);
  const trashed = await f.catalogCall("owner", "delete_page", trashArgs(f));
  assert.equal(trashed.status, 200);
  assert.equal(trashed.body.state, "trashed");
  assert.equal(trashed.body.trashed_by, f.owner);
  assert.equal(trashed.body.trash_root_id, pageId);

  assert.equal(pageState(f.page.metadata), "trashed");
  assert.deepEqual(f.page.metadata.acl, before.acl);
  assert.equal(f.page.metadata.trash.reason, "page");
  assert.equal(f.page.metadata.trash.root_page_id, pageId);
  assert.deepEqual(await f.storage.get("host/document"), f.page.metadata);
  assert.equal(f.removed(), 0);
  assert.deepEqual(f.doc().comments, comments);

  const owned = f.catalogOf(f.owner).storage;
  assert.equal(await owned.get(`page/${pageId}`), undefined);
  assert.equal(await owned.get(`host/deleted/${pageId}`), undefined);
  assert.equal((await f.catalogCall("owner", "list_pages")).body.pages.length, 0);
  const listed = await f.catalogCall("owner", "list_pages", { in_trash: true });
  assert.deepEqual(
    listed.body.pages.map(({ page_id, title, state, trashed_by }) => ({
      page_id,
      title,
      state,
      trashed_by,
    })),
    [{ page_id: pageId, title: "Launch plan", state: "trashed", trashed_by: f.owner }],
  );
  assert.equal(typeof listed.body.retry_token, "string");
  assert.equal((await f.catalogCall("owner", "list_pages", { in_trash: "yes" })).status, 400);

  // A projection observed before trashing cannot relist the Page.
  const projection = await f.catalogOf(f.owner).catalog.fetch(
    new Request("https://pages.internal/internal/projection", {
      method: "POST",
      body: JSON.stringify({
        page_id: pageId,
        title: "Late title",
        observed_at: new Date(Date.now() + 1000).toISOString(),
        shared: false,
      }),
    }),
  );
  assert.equal(projection.status, 200);
  assert.equal(await owned.get(`page/${pageId}`), undefined);
});

test("trash rejects stale heads and releases the catalog reservation", async (t) => {
  const f = await fixture(t);
  const stale = trashArgs(f);
  f.edit("Newer title");
  const rejected = await f.catalogCall("owner", "delete_page", stale);
  assert.equal(rejected.status, 409);
  assert.equal(pageState(f.page.metadata), "active");
  assert.ok(await f.catalogOf(f.owner).storage.get(`page/${pageId}`));
  assert.equal(await f.catalogOf(f.owner).storage.get("host/operation/trash-request"), undefined);
  assert.equal((await f.catalogCall("owner", "delete_page", trashArgs(f))).status, 200);
});

test("trash retries return the original receipt and reject a reused key", async (t) => {
  const f = await fixture(t);
  const args = trashArgs(f);
  const first = await f.pageCall("owner", "/internal/trash", args);
  assert.equal(first.status, 200);
  const again = await f.pageCall("owner", "/internal/trash", args);
  assert.deepEqual(again.body, first.body);
  const fresh = await f.pageCall("owner", "/internal/trash", {
    ...args,
    idempotency_key: "another-trash-key",
  });
  assert.deepEqual(fresh.body, first.body);
  const changed = await f.pageCall("owner", "/internal/trash", { ...args, extra: true });
  assert.equal(changed.status, 409);
  // Catalog replay returns the receipt without forwarding again.
  const viaCatalog = await f.catalogCall("owner", "delete_page", {
    ...args,
    idempotency_key: "catalog-trash",
  });
  assert.equal(viaCatalog.status, 200);
  const replay = await f.catalogCall("owner", "delete_page", {
    ...args,
    idempotency_key: "catalog-trash",
  });
  assert.deepEqual(replay.body, viaCatalog.body);
});

test("the owner reads a trashed Page but cannot edit, comment, share or report progress", async (t) => {
  const f = await fixture(t);
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  const read = await f.tool("owner", "read_page", { comments: "all" });
  assert.equal(read.status, 200);
  assert.equal(read.body.title, "Launch plan");
  assert.equal(read.body.trash.state, "trashed");
  assert.equal(read.body.retry_token, undefined);
  assert.equal((await f.tool("owner", "list_page_comments")).status, 200);
  for (const [operation, args] of [
    ["edit_page", { operations: [{ op: "set_title", title: "Changed" }] }],
    ["manage_page_comment", { action: "add", block_id: f.blockId, body: "More" }],
    ["report_page_progress", { message: "Working" }],
  ]) {
    const denied = await f.tool("owner", operation, {
      ...args,
      base_heads: f.heads(),
      idempotency_key: `denied-${operation}`,
    });
    assert.equal(denied.status, 409, operation);
    assert.equal(denied.body.code, "page_trashed", operation);
  }
  const sharing = await f.pageCall("owner", "/internal/access", {
    principal: "user:anaconda-fixture:new",
    role: "viewer",
    expected_revision: 1,
  });
  assert.equal(sharing.status, 409);
  assert.equal(sharing.body.code, "page_trashed");
  assert.equal((await f.pageCall("owner", "/internal/access", { read: true })).status, 200);
  const connect = await f.pageCall("owner", "/api/connect?page=" + pageId);
  assert.equal(connect.status, 200);
  assert.equal(connect.body.canWrite, false);
  assert.deepEqual(
    {
      role: connect.body.access.role,
      canRead: connect.body.access.canRead,
      canWrite: connect.body.access.canWrite,
      canComment: connect.body.access.canComment,
      canManageAccess: connect.body.access.canManageAccess,
      canRestore: connect.body.access.canRestore,
    },
    {
      role: "owner",
      canRead: true,
      canWrite: false,
      canComment: false,
      canManageAccess: false,
      canRestore: true,
    },
  );
  assert.equal(connect.body.trash.trashed_by, f.owner);
  const authorize = (write) =>
    f.pageCall("owner", "/internal/assets/authorize", { page_id: pageId, write });
  assert.equal((await authorize(false)).status, 200);
  assert.equal((await authorize(true)).status, 409);
  assert.equal(f.doc().title, "Launch plan");
});

test("members and strangers lose access and listings while trashed", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.catalogCall("member", "list_pages")).body.pages.length, 1);
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  const memberRead = await f.tool("member", "read_page");
  assert.equal(memberRead.status, 403);
  assert.equal(memberRead.body.code, "page_trashed");
  const memberConnect = await f.pageCall("member", "/api/connect?page=" + pageId);
  assert.equal(memberConnect.status, 403);
  assert.equal(memberConnect.body.code, "page_trashed");
  // Without a current grant, a trashed Page is indistinguishable from a
  // missing one.
  // Admission answers it exactly like a missing Page: the legacy 404, or the
  // unified 403 for clients that send X-Pages-Admission.
  const stranger = await f.pageCall("stranger", "/api/connect?page=" + pageId);
  assert.equal(stranger.status, 404);
  assert.deepEqual(stranger.body, { error: "Page not found", code: "page_deleted" });
  const unified = await f.pageCall("stranger", "/api/connect?page=" + pageId, undefined, "GET", {
    "x-pages-admission": "1",
  });
  assert.equal(unified.status, 403);
  assert.equal(unified.body.code, "page_access_denied");
  const memberUnified = await f.pageCall(
    "member",
    "/api/connect?page=" + pageId,
    undefined,
    "GET",
    {
      "x-pages-admission": "1",
    },
  );
  assert.equal(memberUnified.body.code, "page_trashed");
  assert.deepEqual((await f.tool("stranger", "read_page")).body, { error: "Page not found" });
  assert.equal((await f.catalogCall("member", "list_pages")).body.pages.length, 0);
  assert.equal(await f.catalogOf(f.member).storage.get(`shared/${pageId}`), undefined);
  assert.equal(
    (await f.catalogCall("member", "list_pages", { in_trash: true })).body.pages.length,
    0,
  );
});

test("sync stops for members and is read-only for the owner while trashed", async (t) => {
  const f = await fixture(t);
  const tree = f.page.metadata.tree;
  await f.bind(ownerKey, f.owner);
  await f.bind(memberKey, f.member);
  await f.page.policy.put(memberKey, memberKey, tree);
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  // Members lose read access; the owner's writer session loses write access.
  assert.deepEqual(f.disconnected.sort(), [ownerKey, memberKey].sort());
  await assert.rejects(f.page.policy.access(memberKey, tree), /Unknown peer/);
  await assert.rejects(f.bind(memberKey, f.member), /owner's Trash/);
  // Grants and binding generations survive Trash, so no key is retired.
  assert.equal(f.page.policy.bindings.get(memberKey).retired, false);
  assert.equal(pageGrant(f.page.metadata, f.member).role, "editor");
  // A fresh owner key reads, but cannot publish changes.
  await f.bind(readerKey, f.owner);
  await f.page.policy.access(readerKey, tree);
  await assert.rejects(f.page.policy.put(readerKey, readerKey, tree), /Trash/);
  await f.bind(ownerKey, f.owner);
  await assert.rejects(f.page.policy.put(ownerKey, ownerKey, tree), /Trash/);

  const restored = await f.catalogCall("owner", "restore_page", {
    page_id: pageId,
    idempotency_key: "restore-request",
  });
  assert.equal(restored.status, 200);
  await f.bind(memberKey, f.member);
  await f.page.policy.put(memberKey, memberKey, tree);
  await f.bind(ownerKey, f.owner);
  await f.page.policy.put(ownerKey, ownerKey, tree);
  // The key first admitted while trashed stays a reader key.
  assert.equal(f.page.policy.bindings.get(readerKey).writer, false);
});

test("restore brings back the same Page, comments, ACL and member listings", async (t) => {
  const f = await fixture(t);
  const heads = f.heads();
  const acl = structuredClone(f.page.metadata.acl);
  const comments = structuredClone(f.doc().comments);
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  await f.catalogCall("member", "list_pages");
  assert.equal(await f.catalogOf(f.member).storage.get(`shared/${pageId}`), undefined);
  const args = { page_id: pageId, idempotency_key: "restore-request" };
  const restored = await f.catalogCall("owner", "restore_page", args);
  assert.equal(restored.status, 200);
  assert.deepEqual(
    {
      page_id: restored.body.page_id,
      state: restored.body.state,
      restored: restored.body.restored,
    },
    { page_id: pageId, state: "active", restored: true },
  );
  await Promise.all(f.tasks);
  assert.equal(pageState(f.page.metadata), "active");
  assert.equal(f.page.metadata.trash, undefined);
  assert.equal(f.page.metadata.deletion, undefined);
  assert.deepEqual(f.page.metadata.acl, acl);
  assert.deepEqual(f.heads(), heads);
  assert.deepEqual(f.doc().comments, comments);
  assert.deepEqual(await f.storage.get("host/document"), f.page.metadata);

  const owned = f.catalogOf(f.owner).storage;
  assert.equal((await owned.get(`page/${pageId}`)).title, "Launch plan");
  assert.equal(await owned.get(`trash/${pageId}`), undefined);
  assert.equal((await f.catalogCall("owner", "list_pages")).body.pages.length, 1);
  assert.equal(
    (await f.catalogCall("owner", "list_pages", { in_trash: true })).body.pages.length,
    0,
  );
  const memberListing = await f.catalogCall("member", "list_pages");
  assert.deepEqual(
    memberListing.body.pages.map(({ page_id, shared }) => ({ page_id, shared })),
    [{ page_id: pageId, shared: true }],
  );
  assert.equal((await f.tool("member", "read_page")).status, 200);
  const edit = await f.tool("owner", "read_page", { comments: "none" });
  assert.equal(typeof edit.body.retry_token, "string");

  // Retries return the original receipt; a fresh key on an active Page is a no-op.
  assert.deepEqual((await f.catalogCall("owner", "restore_page", args)).body, restored.body);
  assert.deepEqual(
    (await f.pageCall("owner", "/internal/restore", args)).body.receipt,
    restored.body,
  );
  const noop = await f.catalogCall("owner", "restore_page", {
    ...args,
    idempotency_key: "restore-again",
  });
  assert.equal(noop.body.restored, false);
  // Replaying the earlier trash receipt does not move the restored Page.
  const replay = await f.catalogCall("owner", "delete_page", {
    ...trashArgs(f),
    base_heads: heads,
  });
  assert.equal(replay.body.state, "trashed");
  assert.equal(pageState(f.page.metadata), "active");
  assert.ok(await owned.get(`page/${pageId}`));
});

test("permanent deletion needs a current preview token and reuses the deletion barriers", async (t) => {
  const f = await fixture(t);
  const notTrashed = await f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "preview",
  });
  assert.equal(notTrashed.status, 409);
  assert.equal(notTrashed.body.code, "page_not_in_trash");
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  const preview = await f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "preview",
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.title, "Launch plan");
  assert.equal(preview.body.comment_count, 1);
  assert.equal(preview.body.comment_threads, 1);
  assert.deepEqual(preview.body.collaborators, [{ principal: f.member, role: "editor" }]);
  assert.match(preview.body.preview_token, /^pp1\./);
  assert.equal(
    Date.parse(preview.body.preview_expires_at) - Date.now() <= PURGE_PREVIEW_TTL_MS,
    true,
  );
  const confirm = (token, key) =>
    f.catalogCall("owner", "purge_page", {
      page_id: pageId,
      action: "confirm",
      preview_token: token,
      idempotency_key: key,
    });
  assert.equal(
    (
      await f.catalogCall("owner", "purge_page", {
        page_id: pageId,
        action: "confirm",
        idempotency_key: "no-token",
      })
    ).body.code,
    "purge_preview_required",
  );
  // Change a whole signature byte: the final base64url character can carry
  // only padding bits.
  const [prefix, body, signature] = preview.body.preview_token.split(".");
  const forged = `${prefix}.${body}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  const invalid = await confirm(forged, "forged-token");
  assert.equal(invalid.status, 409);
  assert.equal(invalid.body.code, "purge_preview_invalid");
  assert.equal(await f.catalogOf(f.owner).storage.get("host/operation/forged-token"), undefined);

  // Content, ACL, and time each invalidate the token.
  f.edit("Changed by an in-flight sync");
  assert.equal(
    (await confirm(preview.body.preview_token, "after-edit")).body.code,
    "purge_preview_invalid",
  );
  const second = (
    await f.catalogCall("owner", "purge_page", { page_id: pageId, action: "preview" })
  ).body;
  f.page.metadata = {
    ...f.page.metadata,
    acl: { ...f.page.metadata.acl, revision: f.page.metadata.acl.revision + 1 },
  };
  assert.equal(
    (await confirm(second.preview_token, "after-acl")).body.code,
    "purge_preview_invalid",
  );
  const third = (await f.catalogCall("owner", "purge_page", { page_id: pageId, action: "preview" }))
    .body;
  const now = Date.now();
  t.mock.method(Date, "now", () => now + PURGE_PREVIEW_TTL_MS + 1);
  assert.equal(
    (await confirm(third.preview_token, "after-expiry")).body.code,
    "purge_preview_invalid",
  );
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", f.auth.fetch);
  assert.equal(pageState(f.page.metadata), "trashed");
  assert.equal(f.removed(), 0);

  // Members cannot preview or confirm.
  const memberPreview = await f.pageCall("member", "/internal/purge", {
    page_id: pageId,
    action: "preview",
  });
  assert.equal(memberPreview.status, 403);

  const fresh = (await f.catalogCall("owner", "purge_page", { page_id: pageId, action: "preview" }))
    .body;
  const purged = await confirm(fresh.preview_token, "purge-request");
  assert.equal(purged.status, 200);
  assert.deepEqual(purged.body, { page_id: pageId, deleted: true, purged: true });
  assert.equal(pageState(f.page.metadata), "deleted");
  assert.equal(f.removed(), 1);
  const owned = f.catalogOf(f.owner).storage;
  assert.equal(await owned.get(`trash/${pageId}`), undefined);
  assert.equal(await owned.get(`host/deleted/${pageId}`), true);
  assert.deepEqual((await confirm(fresh.preview_token, "purge-request")).body, purged.body);
  assert.equal(f.removed(), 1);
  assert.equal((await f.tool("owner", "read_page")).status, 404);
  assert.equal(
    (await f.catalogCall("owner", "restore_page", { page_id: pageId, idempotency_key: "too-late" }))
      .status,
    404,
  );
});

test("only the owner can trash, restore or purge", async (t) => {
  const f = await fixture(t);
  const memberTrash = await f.catalogCall("member", "delete_page", trashArgs(f));
  assert.equal(memberTrash.status, 403);
  assert.equal(pageState(f.page.metadata), "active");
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  const memberRestore = await f.catalogCall("member", "restore_page", {
    page_id: pageId,
    idempotency_key: "member-restore",
  });
  assert.equal(memberRestore.status, 403);
  const memberPurge = await f.catalogCall("member", "purge_page", {
    page_id: pageId,
    action: "preview",
  });
  assert.equal(memberPurge.status, 403);
  assert.equal(pageState(f.page.metadata), "trashed");
  assert.equal(
    (await f.catalogCall("owner", "delete_page", { ...trashArgs(f), expected_principal: f.member }))
      .status,
    403,
  );
});

test("trashed records stay unavailable to builds that predate Trash", async (t) => {
  const f = await fixture(t);
  const args = trashArgs(f, "legacy-compat");
  await f.catalogCall("owner", "delete_page", args);
  const record = await f.storage.get("host/document");
  const ownerIdentity = { principal: f.owner, driver: "ChatGPT" };
  // Older Page.run returns 404 for every route on `deleted`, older pageGrant
  // and DocumentPolicy.access deny every caller, and the older constructor
  // never loads a deleted document.
  assert.equal(record.deleted, true);
  // Older /internal/delete reads only `deletion`. Its own fingerprint differs,
  // so a retry of this key conflicts; a fresh key returns its usual receipt.
  const legacyDigest = await fingerprint("delete_page", args, ownerIdentity);
  assert.notEqual(record.deletion.fingerprint, legacyDigest);
  assert.equal(record.deletion.key, "host/operation/legacy-compat");
  assert.deepEqual(record.deletion.receipt, { page_id: pageId, deleted: true });
  // An older Catalog replaying this key computes the legacy digest and
  // conflicts instead of writing a permanent host/deleted tombstone.
  const catalog = f.catalogOf(f.owner).storage;
  await assert.rejects(
    inspectOperation(catalog, {
      key: "host/operation/legacy-compat",
      digest: legacyDigest,
      scope: `catalog:${f.owner}`,
      principal: f.owner,
    }),
    (error) => error.status === 409,
  );
  // Older listings read only `page/` and `shared/`.
  assert.equal((await catalog.list({ prefix: "page/" })).size, 0);
  // Records deleted before Trash remain permanently deleted.
  const legacy = { pageId, owner: f.owner, deleted: true, deletion: { key: "k" } };
  assert.equal(pageState(legacy), "deleted");
  assert.equal(
    pageAccess(legacy, { principal: f.owner, canWrite: true, expiresAt: Date.now() + 1000 })
      .canRead,
    false,
  );
});

test("Trash and restore respect their capacity limits", async (t) => {
  const f = await fixture(t);
  const owned = f.catalogOf(f.owner).storage;
  for (let index = 0; index < 100; index++)
    await owned.put(`trash/fill-${String(index).padStart(3, "0")}`, { page_id: `fill-${index}` });
  const full = await f.catalogCall("owner", "delete_page", trashArgs(f));
  assert.equal(full.status, 409);
  assert.equal(full.body.code, "trash_capacity");
  await owned.delete("trash/fill-000");
  assert.equal((await f.catalogCall("owner", "delete_page", trashArgs(f))).status, 200);
  for (let index = 0; index < 100; index++)
    await owned.put(`page/fill-${String(index).padStart(3, "0")}`, { page_id: `fill-${index}` });
  const quota = await f.catalogCall("owner", "restore_page", {
    page_id: pageId,
    idempotency_key: "restore-full",
  });
  assert.equal(quota.status, 409);
  assert.equal(pageState(f.page.metadata), "trashed");
});

test("a restarted host loads trashed documents but not permanently deleted ones", async (t) => {
  const finds = [];
  t.mock.method(Page.prototype, "initializeRepo", async function () {
    this.repo = {
      async find(id) {
        finds.push(id);
        return { doc: () => A.from({ page_id: pageId }), on() {}, off() {} };
      },
    };
  });
  const restart = async (metadata) => {
    const storage = new Storage();
    await storage.put("host/document", metadata);
    const page = new Page(
      { id: { name: pageId }, storage, blockConcurrencyWhile: (fn) => fn(), waitUntil() {} },
      {},
    );
    page.policy = { account() {}, profiles: () => ({}) };
    await page.ready;
    return page;
  };
  const base = { pageId, owner: "user:owner", documentId: "trashed-document", deleted: true };
  const trashed = await restart({ ...base, trash: { trashed_at: "2026-10-29T00:00:00.000Z" } });
  assert.ok(trashed.handle);
  assert.deepEqual(finds, ["trashed-document"]);
  const purged = await restart({
    ...base,
    documentId: "purged-document",
    trash: { trashed_at: "2026-10-29T00:00:00.000Z" },
    purged: { purged_at: "2026-10-29T01:00:00.000Z" },
  });
  assert.equal(purged.handle, undefined);
  const legacy = await restart({ ...base, documentId: "legacy-document", deletion: {} });
  assert.equal(legacy.handle, undefined);
  assert.deepEqual(finds, ["trashed-document"]);
});

test("an interrupted trash retried after a restore returns its receipt without trashing again", async (t) => {
  const f = await fixture(t);
  const owned = f.catalogOf(f.owner).storage;
  const trash = trashArgs(f, "lost-trash");
  f.network.lost = 1;
  assert.equal((await f.catalogCall("owner", "delete_page", trash)).status, 500);
  assert.equal(pageState(f.page.metadata), "trashed");
  assert.equal((await owned.get("host/operation/lost-trash")).pending, true);
  const restored = await f.catalogCall("owner", "restore_page", {
    page_id: pageId,
    idempotency_key: "later-restore",
  });
  assert.equal(restored.body.restored, true);
  await f.restart();
  const retry = await f.catalogCall("owner", "delete_page", trash);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.state, "trashed");
  // The receipt is the original outcome; the Page and index keep the restore.
  assert.equal(pageState(f.page.metadata), "active");
  assert.ok(await owned.get(`page/${pageId}`));
  assert.equal(await owned.get(`trash/${pageId}`), undefined);
  assert.equal((await owned.get("host/operation/lost-trash")).pending, false);
  assert.equal((await f.tool("member", "read_page")).status, 200);
});

test("an interrupted restore retried after a later trash returns its receipt without restoring", async (t) => {
  const f = await fixture(t);
  const owned = f.catalogOf(f.owner).storage;
  await f.catalogCall("owner", "delete_page", trashArgs(f, "first-trash"));
  const restore = { page_id: pageId, idempotency_key: "lost-restore" };
  f.network.lost = 1;
  assert.equal((await f.catalogCall("owner", "restore_page", restore)).status, 500);
  assert.equal(pageState(f.page.metadata), "active");
  await f.catalogCall("owner", "delete_page", trashArgs(f, "second-trash"));
  await f.restart();
  const retry = await f.catalogCall("owner", "restore_page", restore);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.restored, true);
  assert.equal(pageState(f.page.metadata), "trashed");
  assert.ok(await owned.get(`trash/${pageId}`));
  assert.equal(await owned.get(`page/${pageId}`), undefined);
  assert.equal((await f.tool("member", "read_page")).status, 403);
  // Page-level retries of either request also replay without a transition.
  const direct = await f.pageCall("owner", "/internal/restore", restore);
  assert.equal(direct.body.receipt.restored, true);
  assert.equal(direct.body.current.state, "trashed");
  assert.equal(direct.body.current.revision, 3);
});

test("purge rechecks the live document after verifying its preview", async (t) => {
  const f = await fixture(t);
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  const preview = await f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "preview",
  });
  // A change accepted before Trash lands while verification awaits storage.
  const get = f.storage.get.bind(f.storage);
  let landed = false;
  f.storage.get = async (key) => {
    const value = await get(key);
    if (key === "host/purge-preview-secret" && !landed) {
      landed = true;
      f.edit("Late native change");
    }
    return value;
  };
  const confirm = await f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.body.preview_token,
    idempotency_key: "late-write-purge",
  });
  assert.equal(landed, true);
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.code, "purge_preview_invalid");
  assert.equal(pageState(f.page.metadata), "trashed");
  assert.equal(f.removed(), 0);
  // While trashed the policy refuses native writes from every key.
  const tree = f.page.metadata.tree;
  await f.bind(ownerKey, f.owner);
  await assert.rejects(f.page.policy.put(ownerKey, ownerKey, tree), /Trash/);
});

test("pending trash and restore requests hold their destination slot", async (t) => {
  const f = await fixture(t);
  const owned = f.catalogOf(f.owner).storage;
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  for (let index = 0; index < 99; index++)
    await owned.put(`page/fill-${String(index).padStart(3, "0")}`, { page_id: `fill-${index}` });
  const restore = { page_id: pageId, idempotency_key: "reserved-restore" };
  const original = f.page.fetch.bind(f.page);
  f.page.fetch = async () => Response.json({ error: "Page unavailable" }, { status: 503 });
  assert.equal((await f.catalogCall("owner", "restore_page", restore)).status, 503);
  assert.equal((await owned.get(`page/${pageId}`)).reservation, "restore_page");
  // The reservation is hidden from listings but counts toward the quota.
  assert.equal((await owned.get(`page/${pageId}`)).pending, true);
  assert.equal(await countCapacity(owned, "page/"), 100);
  const competing = await f.catalogCall("owner", "create_page", {
    title: "Competing",
    idempotency_key: "competing-create",
  });
  assert.equal(competing.status, 409);
  f.page.fetch = original;
  assert.equal((await f.catalogCall("owner", "restore_page", restore)).status, 200);
  assert.equal((await owned.list({ prefix: "page/" })).size, 100);
  assert.equal((await owned.get(`page/${pageId}`)).reservation, undefined);
});

test("a permanent delete by a build without Trash leaves no phantom Trash entry", async (t) => {
  const f = await fixture(t);
  const owned = f.catalogOf(f.owner).storage;
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  // Older /internal/delete with a fresh key: deletes the document and leaves
  // the record unchanged; the older Catalog tombstones and drops only page/.
  const before = await f.storage.get("host/document");
  await f.page.repo.delete(before.documentId);
  await owned.put(`host/deleted/${pageId}`, true);
  await owned.delete(`page/${pageId}`);
  assert.ok(await owned.get(`trash/${pageId}`));
  assert.equal(
    (await f.catalogCall("owner", "list_pages", { in_trash: true })).body.pages.length,
    0,
  );
  assert.equal(await owned.get(`trash/${pageId}`), undefined);
  assert.equal(
    (
      await f.catalogCall("owner", "restore_page", {
        page_id: pageId,
        idempotency_key: "phantom-restore",
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.catalogCall("owner", "purge_page", { page_id: pageId, action: "preview" })).status,
    404,
  );
  assert.equal(
    (await f.catalogCall("owner", "delete_page", trashArgs(f, "phantom-trash"))).status,
    404,
  );
  // The Catalog told the Page about its tombstone, so the record is terminal
  // and a cold start answers like a missing Page. It never calls back into
  // its owner's Catalog.
  assert.equal((await f.storage.get("host/document")).purged.reason, "deleted_by_earlier_build");
  t.mock.method(Page.prototype, "initializeRepo", async function () {
    this.repo = {
      async find() {
        throw Error("document was deleted");
      },
    };
  });
  const catalogFetch = f.env.CATALOGS.getByName;
  f.env.CATALOGS.getByName = () => assert.fail("a Page must not call its owner's Catalog");
  const cold = new Page(
    {
      id: { name: pageId },
      storage: f.storage,
      blockConcurrencyWhile: (fn) => fn(),
      waitUntil() {},
    },
    f.env,
  );
  await cold.ready;
  assert.equal(cold.handle, undefined);
  assert.equal(pageState(cold.metadata), "deleted");
  const read = await cold.fetch(
    new Request("https://pages.invalid/internal/tool", {
      method: "POST",
      headers: { authorization: `Bearer ${f.auth.apiKey()}`, "x-pages-driver": "ChatGPT" },
      body: JSON.stringify({ operation: "read_page", arguments: { page_id: pageId } }),
    }),
  );
  assert.equal(read.status, 404);
  f.env.CATALOGS.getByName = catalogFetch;
});

/** A Page built by the real constructor over storage, as on a cold start. */
function coldPage(f, t) {
  t.mock.method(Page.prototype, "initializeRepo", async function () {
    this.policy = new DocumentPolicy({
      storage: this.ctx.storage,
      metadata: () => this.metadata,
      serverKey,
    });
    await this.policy.load();
    this.serverKey = serverKey;
    this.serverSenderId = "server-sender";
    this.backend = { async flush() {} };
    this.repo = {
      find: async () => ({ doc: () => f.doc(), broadcast() {}, on() {}, off() {} }),
      async delete() {},
      async flush() {},
    };
  });
  return new Page(
    {
      id: { name: pageId },
      storage: f.storage,
      blockConcurrencyWhile: (fn) => fn(),
      waitUntil: (promise) => f.tasks.push(promise),
    },
    f.env,
  );
}

test("a cold-started trashed Page serves Catalog lifecycle requests without a callback", async (t) => {
  const f = await fixture(t);
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  // Evict the Page; the next Catalog request constructs it from storage
  // while the owner's serialized Catalog waits on it.
  const cold = coldPage(f, t);
  f.setPage(cold);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(Error("cold start deadlocked")), 5000).unref(),
  );
  const preview = await Promise.race([
    f.catalogCall("owner", "purge_page", { page_id: pageId, action: "preview" }),
    timeout,
  ]);
  assert.equal(preview.status, 200);
  const restored = await Promise.race([
    f.catalogCall("owner", "restore_page", { page_id: pageId, idempotency_key: "cold-restore" }),
    timeout,
  ]);
  assert.equal(restored.body.restored, true);
  assert.equal(pageState(cold.metadata), "active");
});

test("a retried trash superseded by a restore never applies, even after its receipt is evicted", async (t) => {
  const f = await fixture(t);
  const owned = f.catalogOf(f.owner).storage;
  const trash = trashArgs(f, "evicted-trash");
  f.network.lost = 1;
  assert.equal((await f.catalogCall("owner", "delete_page", trash)).status, 500);
  assert.equal(
    (
      await f.catalogCall("owner", "restore_page", {
        page_id: pageId,
        idempotency_key: "restore-after-loss",
      })
    ).body.restored,
    true,
  );
  // More lifecycle requests than the Page retains receipts for.
  for (let index = 0; index < 130; index++) {
    const heads = f.heads();
    assert.equal(
      (
        await f.pageCall("owner", "/internal/trash", {
          page_id: pageId,
          base_heads: heads,
          idempotency_key: `cycle-trash-${index}`,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.pageCall("owner", "/internal/restore", {
          page_id: pageId,
          idempotency_key: `cycle-restore-${index}`,
        })
      ).status,
      200,
    );
  }
  assert.equal(await f.storage.get("host/lifecycle/evicted-trash"), undefined);
  assert.ok((await f.storage.list({ prefix: "host/lifecycle/" })).size <= 256);
  const retry = await f.catalogCall("owner", "delete_page", trash);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, {
    page_id: pageId,
    superseded: true,
    applied: false,
    state: "active",
  });
  assert.equal(pageState(f.page.metadata), "active");
  assert.ok(await owned.get(`page/${pageId}`));
  assert.equal(await owned.get(`trash/${pageId}`), undefined);
});

test("a forwarded restore keeps its slot past expiry until the Page state reconciles it", async (t) => {
  const f = await fixture(t);
  const owned = f.catalogOf(f.owner).storage;
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  for (let index = 0; index < 99; index++)
    await owned.put(`page/fill-${String(index).padStart(3, "0")}`, { page_id: `fill-${index}` });
  const restore = { page_id: pageId, idempotency_key: "applied-restore" };
  f.network.lost = 1;
  assert.equal((await f.catalogCall("owner", "restore_page", restore)).status, 500);
  assert.equal(pageState(f.page.metadata), "active");
  const intent = await owned.get("host/operation/applied-restore");
  assert.deepEqual([intent.pending, intent.forwarded], [true, true]);
  // Past the retry lifetime the forwarded slot does not expire on its own.
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 8 * 24 * 60 * 60 * 1000);
  assert.equal(await countCapacity(owned, "page/"), 100);
  // Counting through the Catalog asks the Page, which already restored: the
  // slot becomes the real entry and a competing create is refused.
  const competing = await f.catalogCall("owner", "create_page", {
    title: "Competing",
    idempotency_key: "competing-after-expiry",
  });
  assert.equal(competing.status, 409);
  assert.equal((await owned.get(`page/${pageId}`)).reservation, undefined);
  const retry = await f.catalogCall("owner", "restore_page", restore);
  assert.equal(retry.body.restored, true);
  assert.equal((await owned.get("host/operation/applied-restore")).pending, false);
  assert.equal((await owned.list({ prefix: "page/" })).size, 100);
});

test("only never-forwarded slots expire, and a resume without room only replays", async (t) => {
  const f = await fixture(t);
  const owned = f.catalogOf(f.owner).storage;
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  for (let index = 0; index < 99; index++)
    await owned.put(`page/fill-${String(index).padStart(3, "0")}`, { page_id: `fill-${index}` });
  // A crash after the intent and slot commit, before the forwarded mark.
  const key = "host/operation/stranded-restore";
  await owned.put({
    [key]: {
      fingerprint: await fingerprint(
        "restore_page",
        { page_id: pageId, idempotency_key: "stranded-restore" },
        { principal: f.owner, driver: "ChatGPT" },
      ),
      pending: true,
      pageId,
      createdAt: new Date().toISOString(),
      expectedRevision: 1,
    },
    ...lifecycleSlot("restore_page", pageId, key),
  });
  assert.equal(await countCapacity(owned, "page/"), 100);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 8 * 24 * 60 * 60 * 1000);
  assert.equal(await countCapacity(owned, "page/"), 99);
  assert.equal(await owned.get(`page/${pageId}`), undefined);
  await owned.put("page/fill-099", { page_id: "fill-099" });
  const resumed = await f.catalogCall("owner", "restore_page", {
    page_id: pageId,
    idempotency_key: "stranded-restore",
  });
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body, {
    page_id: pageId,
    superseded: true,
    applied: false,
    state: "trashed",
  });
  assert.equal(pageState(f.page.metadata), "trashed");
  assert.equal((await owned.list({ prefix: "page/" })).size, 100);
});

test("a restore whose durability barrier failed completes before its receipt replays", async (t) => {
  const f = await fixture(t);
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  const sync = f.storage.sync.bind(f.storage);
  let failures = 1;
  f.storage.sync = async () => {
    if (failures-- > 0) throw Error("restore sync failed");
    return sync();
  };
  const restore = { page_id: pageId, idempotency_key: "barrier-restore" };
  assert.equal((await f.catalogCall("owner", "restore_page", restore)).status, 500);
  // Nothing was granted: memory still says trashed while the write is pending.
  assert.equal(pageState(f.page.metadata), "trashed");
  assert.equal(f.page.pendingLifecycle.operation, "restore_page");
  // The retry finishes the durable restore and installs it before replaying.
  const retry = await f.catalogCall("owner", "restore_page", restore);
  assert.equal(retry.body.restored, true);
  assert.equal(pageState(f.page.metadata), "active");
  assert.ok(await f.catalogOf(f.owner).storage.get(`page/${pageId}`));
  assert.equal((await f.tool("member", "read_page")).status, 200);
});

test("a trashed document that fails to load is retried, not treated as gone", async (t) => {
  const f = await fixture(t);
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  let failures = 1;
  t.mock.method(Page.prototype, "initializeRepo", async function () {
    this.policy = new DocumentPolicy({
      storage: this.ctx.storage,
      metadata: () => this.metadata,
      serverKey,
    });
    this.serverKey = serverKey;
    this.serverSenderId = "server-sender";
    this.backend = { async flush() {} };
    this.repo = {
      find: async () => {
        if (failures-- > 0) throw Error("storage briefly unavailable");
        return { doc: () => f.doc(), broadcast() {}, on() {}, off() {} };
      },
    };
  });
  const cold = new Page(
    {
      id: { name: pageId },
      storage: f.storage,
      blockConcurrencyWhile: (fn) => fn(),
      waitUntil() {},
    },
    f.env,
  );
  await cold.ready;
  f.setPage(cold);
  assert.equal(cold.handle, undefined);
  assert.equal(pageState(cold.metadata), "trashed");
  assert.equal((await f.tool("owner", "read_page")).status, 200);
  assert.ok(cold.handle);
});

test("a resumed lifecycle request checks the tombstone and completes as deleted", async (t) => {
  const f = await fixture(t);
  const owned = f.catalogOf(f.owner).storage;
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  const original = f.page.fetch.bind(f.page);
  f.page.fetch = async () => Response.json({ error: "Page unavailable" }, { status: 503 });
  const restore = { page_id: pageId, idempotency_key: "tombstoned-restore" };
  assert.equal((await f.catalogCall("owner", "restore_page", restore)).status, 503);
  f.page.fetch = original;
  // A build without Trash deletes the Page permanently in the meantime.
  await owned.put(`host/deleted/${pageId}`, true);
  const resumed = await f.catalogCall("owner", "restore_page", restore);
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body, { page_id: pageId, deleted: true });
  assert.equal(pageState(f.page.metadata), "deleted");
  assert.equal(await owned.get(`page/${pageId}`), undefined);
  assert.equal(await owned.get(`trash/${pageId}`), undefined);
  assert.equal((await f.tool("owner", "read_page")).status, 404);
});

test("an expired slot for a restore whose barrier failed never lets the quota pass 100", async (t) => {
  const f = await fixture(t);
  const owned = f.catalogOf(f.owner).storage;
  await f.catalogCall("owner", "delete_page", trashArgs(f));
  for (let index = 0; index < 99; index++)
    await owned.put(`page/fill-${String(index).padStart(3, "0")}`, { page_id: `fill-${index}` });
  const sync = f.storage.sync.bind(f.storage);
  let failures = 2;
  f.storage.sync = async () => {
    if (failures-- > 0) throw Error("restore sync failed");
    return sync();
  };
  const restore = { page_id: pageId, idempotency_key: "failed-barrier-restore" };
  assert.equal((await f.catalogCall("owner", "restore_page", restore)).status, 500);
  assert.equal(f.page.pendingLifecycle.operation, "restore_page");
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 8 * 24 * 60 * 60 * 1000);
  const create = (key) =>
    f.catalogCall("owner", "create_page", { title: "Competing", idempotency_key: key });
  // The Page cannot settle yet, so it reports nothing and the slot counts.
  assert.equal((await create("competing-while-settling")).status, 409);
  assert.equal((await owned.get(`page/${pageId}`)).reservation, "restore_page");
  // Next time the Page finishes the restore before answering: the slot
  // becomes the real entry and the quota stays full.
  assert.equal((await create("competing-after-settling")).status, 409);
  assert.equal(pageState(f.page.metadata), "active");
  assert.equal((await owned.get(`page/${pageId}`)).reservation, undefined);
  assert.equal((await owned.list({ prefix: "page/" })).size, 100);
  const retry = await f.catalogCall("owner", "restore_page", restore);
  assert.equal(retry.body.restored, true);
  assert.equal((await owned.list({ prefix: "page/" })).size, 100);
});
