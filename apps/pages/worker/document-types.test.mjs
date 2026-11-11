import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { Storage, fixture, pageId, commentsUuid } from "./trash-fixture.mjs";
import { world } from "./projects-fixture.mjs";
import { commentsDocumentId } from "./comments-store.mjs";
import {
  BUILD_FORMATS,
  WRITTEN_FORMATS,
  parseDocumentDescriptor,
} from "../model/document-types.mjs";
import { PageSession } from "../viewer/session.mjs";
import { previewAnswer } from "../viewer/early-session.mjs";
import { Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { plainStub } from "./plain-stub.mjs";
import { pageState } from "./access.mjs";
import { ASSET_AUTHORIZE_PATH, ASSET_UPLOAD_OPERATION } from "./asset-uploads.mjs";

test("connect describes host-owned IDs without changing document bytes or host metadata", async (t) => {
  const f = await fixture(t);
  const metadata = structuredClone(f.page.metadata);
  const bytes = A.save(f.doc());
  const commentsBytes = A.save(f.commentsDoc());
  const { status, body } = await f.pageCall("owner", `/api/connect?page=${pageId}`);
  assert.equal(status, 200);
  assert.deepEqual(body.documents, {
    page: { id: metadata.documentId, type: "pages.page", format: 2 },
    comments: { id: commentsDocumentId(commentsUuid), type: "pages.comments", format: 1 },
  });
  assert.equal(body.documentId, body.documents.page.id);
  assert.equal(body.commentsDocumentId, body.documents.comments.id);
  assert.equal(body.recordStorage, "automerge");
  assert.equal(body.page_id, pageId);
  assert.equal(body.serverSenderId, f.page.serverSenderId);
  assert.equal(body.identity.principal, f.owner);
  assert.equal(body.canWrite, true);
  assert.equal(body.access.canWrite, true);
  assert.deepEqual(f.page.metadata, metadata);
  assert.deepEqual(A.save(f.doc()), bytes);
  assert.deepEqual(A.save(f.commentsDoc()), commentsBytes);
  for (const descriptor of Object.values(body.documents))
    assert.deepEqual(parseDocumentDescriptor(descriptor), descriptor);
});

test("comments descriptors follow handle availability, not document content or UUID presence", async (t) => {
  const f = await fixture(t);
  assert.ok(f.page.commentsUuid);
  f.page.commentsHandle = undefined;
  const { status, body } = await f.pageCall("owner", `/api/connect?page=${pageId}`);
  assert.equal(status, 200);
  assert.equal(Object.hasOwn(body, "commentsDocumentId"), false);
  assert.deepEqual(body.documents, {
    page: { id: f.page.metadata.documentId, type: "pages.page", format: 2 },
  });
  assert.equal(f.page.commentsHandle, undefined);
});

test("Project content discovery describes pages.page, not a separate document type", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  const host = w.page(project.document_id);
  const response = await host.fetch(
    new Request(`https://pages.invalid/api/connect?page=${project.document_id}`, {
      headers: { authorization: `Bearer ${w.auth.apiKey()}` },
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.documents.page, {
    id: host.metadata.documentId,
    type: "pages.page",
    format: 2,
  });
});

test("connect still refuses unreadable Pages without disclosing descriptors", async (t) => {
  const f = await fixture(t);
  const { status, body } = await f.pageCall("stranger", `/api/connect?page=${pageId}`);
  assert.equal(status, 403);
  assert.equal(body.code, "page_access_denied");
  assert.equal(Object.hasOwn(body, "documents"), false);
});

test("existing discovery consumers ignore known and unknown additive documents metadata", async (t) => {
  const f = await fixture(t);
  const { body } = await f.pageCall("owner", `/api/connect?page=${pageId}&preview=1`);
  const { documents: _documents, ...legacy } = body;
  const discoveries = [
    ["legacy", legacy],
    ["known descriptors", body],
    [
      "unknown types",
      {
        ...body,
        documents: {
          page: { id: "unused-page-id", type: "pages.future-page", format: 1 },
          comments: { id: "unused-comments-id", type: "pages.future-comments", format: 1 },
        },
      },
    ],
    [
      "unknown formats",
      {
        ...body,
        documents: {
          page: { ...body.documents.page, format: 99 },
          comments: { ...body.documents.comments, format: 99 },
        },
      },
    ],
  ];

  const outcomes = [];
  for (const [label, discovery] of discoveries) {
    assert.deepEqual(previewAnswer(discovery), previewAnswer(legacy), label);
    const session = new PageSession(pageId);
    session.acceptAuthentication({ identity: body.identity, canWrite: true });
    t.after(() => session.close());
    t.mock.method(session, "initializeLocal", async (key) => {
      session.replicaKey = key;
    });
    const sockets = [];
    // Exercise requestConnect, authentication, access, profiles and activity.
    // Replace local storage and the socket-opening boundary.
    t.mock.method(session, "openPlainConnection", async () => {
      sockets.push(session.connection.serverSenderId);
    });
    const fetch = t.mock.method(globalThis, "fetch", async (url) => {
      assert.equal(url, `/api/connect?page=${pageId}&sync=automerge`);
      return Response.json(discovery);
    });
    await assert.doesNotReject(session.openConnection(false), label);
    fetch.mock.restore();
    assert.equal(session.canWrite, true, label);
    assert.equal(!!session.accessReloadRequired, false, label);
    assert.equal(!!session.accessDenied, false, label);
    const comments = [];
    session.repo = { async flush() {} };
    t.mock.method(session, "commentsOpen", (event) => comments.push(event));
    session.openComments();
    outcomes.push({
      documentId: session.connection.documentId,
      comments,
      sockets,
      canWrite: session.canWrite,
      access: session.access,
      generation: session.connectionGeneration,
      profiles: session.profiles,
      activityEpoch: session.activityEpoch,
    });
  }
  for (let i = 1; i < outcomes.length; i++)
    assert.deepEqual(outcomes[i], outcomes[0], discoveries[i][0]);
  assert.equal(outcomes[1].documentId, body.documentId);
  assert.deepEqual(outcomes[1].comments, [{ type: "open", id: body.commentsDocumentId }]);
  assert.deepEqual(outcomes[1].sockets, [body.serverSenderId]);
});

/** Install a WebSocketPair and Response that record each refusal's close, and
 * stand in for the Page's accepted socket. Returns what each connect did. */
function fakeSockets(t, host) {
  const sockets = [];
  class Socket extends EventTarget {
    accept() {}
    send() {}
    close(code, reason) {
      this.closed = { code, reason };
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
  t.mock.method(console, "warn", () => {});
  const accepted = t.mock.method(host, "connectPlain", () => ({ status: 101, accepted: true }));
  return { sockets, accepted };
}

/** Open a socket on the fixture's Page, declaring `formats` (a query value, or
 * nothing). Returns the connect response and, for a refusal, its closed socket. */
function openSocket(f, sockets, formats) {
  const url = new URL("https://pages.invalid/api/sync");
  url.searchParams.set("sync", "automerge");
  url.searchParams.set("sender", `b-${crypto.randomUUID()}`);
  if (formats !== undefined) url.searchParams.set("formats", formats);
  const identity = {
    principal: f.owner,
    displayName: "Owner",
    driver: "Browser",
    credentialKind: "api-key",
    canWrite: true,
    expiresAt: Date.now() + 3_600_000,
  };
  const response = f.page.connect(
    new Request(url, { headers: { upgrade: "websocket" } }),
    identity,
  );
  return { response, closed: response.accepted ? undefined : sockets.at(-1).closed };
}

test("a socket declaring the current formats is accepted", async (t) => {
  const f = await fixture(t);
  const { sockets, accepted } = fakeSockets(t, f.page);
  const { closed } = openSocket(f, sockets, BUILD_FORMATS);
  assert.equal(accepted.mock.callCount(), 1);
  assert.equal(closed, undefined);
});

test("a socket declaring no formats is a 400", async (t) => {
  const f = await fixture(t);
  const { sockets, accepted } = fakeSockets(t, f.page);
  assert.throws(
    () => openSocket(f, sockets, undefined),
    (error) => error.status === 400 && error.message === "Invalid formats",
  );
  assert.equal(accepted.mock.callCount(), 0);
});

test("a socket lacking the current format of a document the Page holds is closed", async (t) => {
  const f = await fixture(t);
  const { sockets, accepted } = fakeSockets(t, f.page);
  for (const formats of [
    "pages.comments:1",
    "pages.page:2",
    "pages.page:1,pages.comments:1",
    "pages.future:1",
  ])
    assert.equal(openSocket(f, sockets, formats).closed?.reason, "schema_unsupported", formats);
  assert.equal(accepted.mock.callCount(), 0);
});

test("a socket may declare formats beyond the current ones", async (t) => {
  const f = await fixture(t);
  const { sockets, accepted } = fakeSockets(t, f.page);
  const { closed } = openSocket(f, sockets, "pages.comments:1,pages.future:3,pages.page:2");
  assert.equal(closed, undefined);
  assert.equal(accepted.mock.callCount(), 1);
});

test("a Page with no comments document yet still requires pages.comments", async (t) => {
  const f = await fixture(t);
  f.page.commentsHandle = undefined;
  const { sockets, accepted } = fakeSockets(t, f.page);
  const { response, closed } = openSocket(f, sockets, "pages.page:2");
  assert.equal(response.status, 101);
  assert.equal(closed.reason, "schema_unsupported");
  assert.equal(accepted.mock.callCount(), 0);
});

test("a malformed or repeated formats parameter is a 400", async (t) => {
  const f = await fixture(t);
  const { sockets } = fakeSockets(t, f.page);
  for (const formats of ["", "pages.page", "pages.page:x", "pages.page:2,pages.page:2"])
    assert.throws(
      () => openSocket(f, sockets, formats),
      (error) => error.status === 400 && error.message === "Invalid formats",
      formats,
    );
  const url = new URL("https://pages.invalid/api/sync?sync=automerge");
  url.searchParams.append("formats", "pages.page:2,pages.comments:1");
  url.searchParams.append("formats", "pages.page:2,pages.comments:1");
  assert.throws(
    () => f.page.connect(new Request(url, { headers: { upgrade: "websocket" } }), {}),
    (error) => error.status === 400 && error.message === "Invalid formats",
  );
});

// A Page host record stores the format of each document type it holds
// (`documentFormats`), and the host acts on the record, not on the build.

/** A format this build doesn't write. */
const UNOPENED = { "pages.page": 99, "pages.comments": 1 };

test("connect reports the record's formats; an unstamped record reads as this build's", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.page.metadata.documentFormats, WRITTEN_FORMATS);
  const stamped = await f.pageCall("owner", `/api/connect?page=${pageId}`);
  const { documentFormats: _stamp, ...unstamped } = f.page.metadata;
  f.page.metadata = unstamped;
  const connected = await f.pageCall("owner", `/api/connect?page=${pageId}`);
  assert.equal(connected.status, 200);
  assert.deepEqual(connected.body.documents, stamped.body.documents);
  assert.equal(connected.body.documents.page.format, 2);
  assert.equal(connected.body.documents.comments.format, 1);
  const { sockets, accepted } = fakeSockets(t, f.page);
  assert.equal(openSocket(f, sockets, BUILD_FORMATS).closed, undefined);
  assert.equal(accepted.mock.callCount(), 1);
});

/** The fixture's Page with its record stamped `documentFormats` (UNOPENED by
 * default) and its last projected title in storage, started cold over that
 * storage as after a deploy. `loads()` counts every document the host
 * tries to open. */
async function storedPage(t, documentFormats = UNOPENED) {
  const f = await fixture(t);
  await f.storage.put("host/document", { ...f.initial, documentFormats });
  await f.storage.put("host/title-projection", {
    title: "Launch plan",
    observed_at: "2026-10-20T10:00:00.000Z",
    keep: true,
  });
  let loads = 0;
  const open = async () => {
    loads++;
    return { doc: () => f.doc(), broadcast() {}, on() {}, off() {} };
  };
  t.mock.method(Page.prototype, "initializeRepo", async function () {
    this.policy = new DocumentPolicy({ metadata: () => this.metadata });
    this.serverSenderId = "server-sender";
    this.repo = { find: open, import: open, async delete() {}, async flush() {} };
    this.plain = plainStub(this.repo);
    this.commentsUuid = commentsUuid;
  });
  const page = new Page(
    {
      id: { name: pageId },
      storage: f.storage,
      blockConcurrencyWhile: (fn) => fn(),
      waitUntil: (promise) => f.tasks.push(promise),
    },
    f.env,
  );
  await page.ready;
  f.setPage(page);
  return { f, page, loads: () => loads };
}

test("a record in a format this build writes opens its documents", async (t) => {
  const { f, loads } = await storedPage(t, { ...WRITTEN_FORMATS });
  const connected = await f.pageCall("owner", `/api/connect?page=${pageId}`);
  assert.equal(connected.status, 200);
  assert.equal(loads(), 2);
});

test("every route that opens a record's documents refuses a format this build doesn't write", async (t) => {
  const { f, page, loads } = await storedPage(t);
  const refused = (response, label) => {
    assert.equal(response.status, 409, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, "stored_form_unsupported", label);
    assert.doesNotMatch(response.body.error, /reload/i, label);
  };
  refused(await f.pageCall("owner", `/api/connect?page=${pageId}`), "connect");
  refused(await f.pageCall("owner", `/api/connect?page=${pageId}&preview=1`), "preview");
  refused(await f.pageCall("owner", "/api/saved", { heads: [] }), "saved");
  const edit = { base_heads: [], idempotency_key: "unopened-edit" };
  for (const [operation, args] of [
    ["read_page", {}],
    ["read_page_changes", {}],
    ["list_page_comments", {}],
    ["read_page_presence", {}],
    ["report_page_progress", { status: "working" }],
    ["edit_page", { ...edit, operations: [{ op: "set_title", title: "New" }] }],
    ["patch_page", { ...edit, operations: [{ op: "set_title", title: "New" }] }],
    ["manage_page_comment", { action: "add", block_id: "block-id", body: "Hi" }],
    ["reply_page_comment", { thread_id: "thread", body: "Hi" }],
    [ASSET_UPLOAD_OPERATION, { kind: "image", media_type: "image/png", byte_length: 1 }],
  ])
    refused(await f.tool("owner", operation, args), operation);
  refused(
    await f.pageCall("owner", ASSET_AUTHORIZE_PATH, { page_id: pageId, write: false }),
    "asset",
  );
  refused(
    await f.pageCall("owner", "/internal/card-image/authorize", { page_id: pageId }),
    "card image",
  );
  // A member is refused the same way; a stranger can't learn the Page exists.
  refused(await f.tool("member", "read_page"), "member read");
  assert.equal((await f.tool("stranger", "read_page")).status, 403);
  // The socket closes with the refusal, whatever formats the client declares.
  const { sockets, accepted } = fakeSockets(t, page);
  for (const formats of [BUILD_FORMATS, "pages.comments:1,pages.page:99"])
    assert.deepEqual(
      openSocket(f, sockets, formats).closed,
      { code: 4427, reason: "stored_form_unsupported" },
      formats,
    );
  assert.equal(accepted.mock.callCount(), 0);
  // Nothing opened either document, and the record is as it was.
  assert.equal(loads(), 0);
  assert.equal(page.handle, undefined);
  assert.equal(page.commentsHandle, undefined);
  assert.deepEqual((await f.storage.get("host/document")).documentFormats, UNOPENED);
});

test("the owner lists, trashes, restores and permanently deletes a Page in a format this build doesn't write", async (t) => {
  const { f, page, loads } = await storedPage(t);
  const listed = await f.catalogCall("owner", "list_pages");
  assert.deepEqual(
    listed.body.pages.map((entry) => [entry.page_id, entry.title]),
    [[pageId, "Launch plan"]],
  );
  // A member's list answers from the record too.
  assert.equal((await f.catalogCall("member", "list_pages")).status, 200);
  // Only the owner trashes it.
  const memberTrash = await f.catalogCall("member", "delete_page", {
    page_id: pageId,
    idempotency_key: "member-trash",
  });
  assert.notEqual(memberTrash.status, 200);
  assert.equal(pageState(page.metadata), "active");
  // A trash sent with heads can't be checked against an unopened document.
  const withHeads = await f.catalogCall("owner", "delete_page", {
    page_id: pageId,
    base_heads: f.heads(),
    idempotency_key: "trash-with-heads",
  });
  assert.equal(withHeads.status, 400);
  const trash = (key) =>
    f.catalogCall("owner", "delete_page", { page_id: pageId, idempotency_key: key });
  const trashed = await trash("trash-unopened");
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  assert.equal(trashed.body.state, "trashed");
  assert.equal(trashed.body.title, "Launch plan");
  const inTrash = await f.catalogCall("owner", "list_pages", { in_trash: true });
  assert.deepEqual(
    inTrash.body.pages.map((entry) => entry.page_id),
    [pageId],
  );
  const restored = await f.catalogCall("owner", "restore_page", {
    page_id: pageId,
    idempotency_key: "restore-unopened",
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.restored, true);
  assert.equal(restored.body.title, "Launch plan");
  assert.equal(pageState(page.metadata), "active");
  assert.equal((await trash("trash-again")).status, 200);
  // The preview describes the Page from its record and its last title.
  const preview = await f.catalogCall("owner", "purge_page", {
    page_id: pageId,
    action: "preview",
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.title, "Launch plan");
  assert.equal(preview.body.comment_count, null);
  assert.equal(preview.body.comment_threads, null);
  assert.equal(preview.body.heads, null);
  assert.deepEqual(preview.body.collaborators, [{ principal: f.member, role: "editor" }]);
  const confirm = (who, key) =>
    f.catalogCall(who, "purge_page", {
      page_id: pageId,
      action: "confirm",
      preview_token: preview.body.preview_token,
      idempotency_key: key,
    });
  assert.notEqual((await confirm("member", "member-purge")).status, 200);
  const purged = await confirm("owner", "purge-unopened");
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  assert.equal(pageState(page.metadata), "deleted");
  assert.equal(await f.storage.get("host/title-projection"), undefined);
  assert.equal(loads(), 0);
});

// Durable Object storage in memory that deletes key lists, as plain sync's
// purge does.
class PlainStorage extends Storage {
  async delete(key) {
    for (const name of Array.isArray(key) ? key : [key]) this.values.delete(name);
  }
}

/** A Page host over real plain sync and in-memory storage, built by the
 * real constructor. `page()` starts a new object over the same storage. */
async function plainHost(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new PlainStorage();
  const env = {
    ...auth.env,
    CATALOGS: { getByName: () => ({ fetch: async () => Response.json({ ok: true }) }) },
  };
  const token = auth.apiKey();
  const hosts = [];
  t.after(async () => {
    for (const host of hosts) await host.plain?.close();
  });
  const page = () => {
    const host = new Page(
      { id: { name: pageId }, storage, blockConcurrencyWhile: (fn) => fn(), waitUntil() {} },
      env,
    );
    hosts.push(host);
    return host;
  };
  const call = (host, path, body) =>
    host.fetch(
      new Request(`https://pages.invalid${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
  return { auth, storage, page, call };
}

test("a new Page's host record stores the format of each of its documents", async (t) => {
  const h = await plainHost(t);
  const response = await h.call(h.page(), "/internal/create", {
    page_id: pageId,
    title: "New Page",
    markdown: "Some text",
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual((await h.storage.get("host/document")).documentFormats, {
    "pages.page": 2,
    "pages.comments": 1,
  });
});

test("a Project's content record stores the format of each of its documents", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  assert.deepEqual(w.page(project.document_id).metadata.documentFormats, {
    "pages.page": 2,
    "pages.comments": 1,
  });
});

test("a registered draft's record is stamped, and in a format this build doesn't write its storage still purges", async (t) => {
  const h = await plainHost(t);
  const doc = A.change(A.from(createPageData({ pageId, title: "Draft" })), (draft) =>
    initializePage(draft, "Draft text"),
  );
  t.after(() => A.free(doc));
  const registered = await h.call(h.page(), "/internal/register", {
    page_id: pageId,
    expected_principal: `user:anaconda-fixture:${h.auth.subject}`,
    document_id: interpretAsDocumentId(generateAutomergeUrl()),
    initial_snapshot_base64: Buffer.from(A.save(doc)).toString("base64"),
    title: "Draft",
    idempotency_key: "register-draft",
    record_storage: "automerge",
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  const record = await h.storage.get("host/document");
  assert.deepEqual(record.documentFormats, WRITTEN_FORMATS);
  const plainKeys = async () => (await h.storage.list({ prefix: "plain/" })).size;
  assert.ok((await plainKeys()) > 0);
  // The record now names a format this build doesn't write: a new host opens
  // nothing, and the owner deletes the Page from its record.
  await h.storage.put("host/document", { ...record, documentFormats: UNOPENED });
  const host = h.page();
  const read = await h.call(host, "/internal/tool", {
    operation: "read_page",
    arguments: { page_id: pageId },
  });
  assert.equal(read.status, 409);
  assert.equal((await read.json()).code, "stored_form_unsupported");
  assert.equal(host.handle, undefined);
  const trashed = await h.call(host, "/internal/trash", {
    page_id: pageId,
    idempotency_key: "trash-draft",
  });
  assert.equal(trashed.status, 200, await trashed.clone().text());
  const preview = await h.call(host, "/internal/purge", { page_id: pageId, action: "preview" });
  assert.equal(preview.status, 200, await preview.clone().text());
  const { preview_token } = await preview.json();
  const purged = await h.call(host, "/internal/purge", {
    page_id: pageId,
    action: "confirm",
    preview_token,
    idempotency_key: "purge-draft",
  });
  assert.equal(purged.status, 200, await purged.clone().text());
  assert.equal(pageState(await h.storage.get("host/document")), "deleted");
  assert.equal(await plainKeys(), 0);
  assert.equal(host.handle, undefined);
});
