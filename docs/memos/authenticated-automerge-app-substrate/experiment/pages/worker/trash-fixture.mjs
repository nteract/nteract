// Page and Catalog hosts over in-memory storage, for the Trash and Page
// lifecycle tests. Node tests only.

import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { applyComment } from "../model/comments.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { BUILD_FEATURES, documentFeatures } from "../model/schema-features.mjs";
import { Catalog, Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { proposeAccessUpdate } from "./access.mjs";

/** Durable Object storage in memory. `sync()` records what a crash would keep
 * under the strictest reading: writes after the last successful sync may be
 * lost. `durable()` returns that snapshot. */
export class Storage {
  values = new Map();
  synced = new Map();
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
  async sync() {
    this.synced = structuredClone(this.values);
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
        .slice(0, limit),
    );
  }
  /** The values written up to the last successful sync. */
  durable() {
    return structuredClone(this.synced);
  }
}

export const pageId = "33333333-3333-4333-8333-333333333333";
export const serverKey = "f".repeat(64);
export const ownerKey = "1".repeat(64);
export const memberKey = "2".repeat(64);
export const readerKey = "3".repeat(64);
export const commentsUuid = "c0000000-0000-4000-8000-000000000001";

/** An owner's Page with one member (an editor, or `memberRole`) and one
 * comment by that member in its comments document, its owner's and member's Catalogs, and helpers to call both.
 * `env` adds Worker bindings. `auth` shares an auth fixture whose fetch the
 * caller has mocked, and `docBytes` loads that document instead of building
 * a new one, with an empty comments document. */
export async function fixture(
  t,
  { env: extraEnv = {}, auth: shared, docBytes, memberRole = "editor" } = {},
) {
  const auth = shared ?? (await createAuthFixture());
  if (!shared) t.mock.method(globalThis, "fetch", auth.fetch);
  const owner = `user:anaconda-fixture:${auth.subject}`;
  const member = "user:anaconda-fixture:member-user";
  const tokens = {
    owner: auth.apiKey(),
    member: auth.apiKey({ userId: "member-user" }),
    stranger: auth.apiKey({ userId: "stranger-user" }),
  };
  let doc;
  let commentsDoc = A.clone(commentsGenesis(commentsUuid));
  if (docBytes) doc = A.load(docBytes);
  else {
    doc = A.change(A.from(createPageData({ pageId, title: "Launch plan" })), (draft) =>
      initializePage(draft, "We ship on Friday."),
    );
    const firstBlock = Object.keys(doc.blocks)[0];
    commentsDoc = A.change(commentsDoc, (draft) =>
      applyComment(
        draft,
        { action: "add", block_id: firstBlock, body: "Looks good" },
        { principal: member, displayName: "Member", driver: "Browser" },
        undefined,
        { page: doc, role: "editor" },
      ),
    );
  }
  const blockId = Object.keys(doc.blocks)[0];
  t.after(() => A.free(doc));
  const base = {
    pageId,
    owner,
    documentId: "fixture-document",
    tree: "a".repeat(32),
    comments_doc: commentsUuid,
  };
  const ownerIdentity = { principal: owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  const acl = proposeAccessUpdate(base, ownerIdentity, {
    principal: member,
    role: memberRole,
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
    ...extraEnv,
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
  // The document as durable storage holds it: written by the repo flush, the
  // only place the host persists document bytes. `hooks.flush` runs first and
  // may throw, to cut a run before the bytes are written.
  let persisted = A.save(doc);
  let persistedComments = A.save(commentsDoc);
  const hooks = {};
  const build = (metadata) => {
    const handle = {
      doc: () => doc,
      async update(fn) {
        doc = fn(doc);
      },
      broadcast() {},
      on() {},
      off() {},
    };
    const commentsHandle = {
      doc: () => commentsDoc,
      async update(fn) {
        commentsDoc = fn(commentsDoc);
      },
      broadcast() {},
      on() {},
      off() {},
    };
    const instance = Object.assign(Object.create(Page.prototype), {
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      env,
      ctx: { storage, waitUntil: (promise) => tasks.push(promise) },
      metadata,
      handle,
      wires: new Set(),
      wirePrincipals: new Map(),
      serverKey,
      serverSenderId: "server-sender",
      commentsUuid,
      commentsHandle,
      repo: {
        async delete(id) {
          if (id === "fixture-document") removed++;
        },
        async find() {
          return handle;
        },
        async import(bytes) {
          commentsDoc = A.merge(commentsDoc, A.load(bytes));
          return commentsHandle;
        },
        async flush() {
          await hooks.flush?.();
          persisted = A.save(doc);
          persistedComments = A.save(commentsDoc);
        },
      },
      backend: { async flush() {} },
    });
    instance.policy = new DocumentPolicy({
      storage,
      metadata: () => instance.metadata,
      serverKey,
      writeFence: () => instance.conversionWriteFence(),
      commentsTree: () => "c".repeat(32),
      // As the Page host wires it: each document's own stamp.
      schemaFeatures: (scope) =>
        documentFeatures((scope === "comments" ? instance.commentsHandle : instance.handle).doc()),
    });
    return instance;
  };
  const initial = { ...base, ownerName: "Owner", deleted: false, acl };
  let page = build(structuredClone(initial));
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
  const disconnectErrors = [];
  /** Admit native key `key` for `principal`. `features` are the schema
   * features its build declares; this build's by default. */
  const bind = (key, principal, features = BUILD_FEATURES) =>
    page.policy.bind(key, key, identity(principal), {
      reauthenticate: async () => identity(principal),
      disconnect: async (error) => {
        disconnected.push(key);
        disconnectErrors.push(error);
      },
      features,
    });
  return {
    auth,
    owner,
    member,
    tokens,
    storage,
    network,
    env,
    initial,
    build,
    request,
    identity,
    get page() {
      return page;
    },
    setPage(next) {
      page = next;
    },
    /** A new Page object over the same durable storage, as after eviction. */
    async restart() {
      page = build((await storage.get("host/document")) ?? structuredClone(page.metadata));
      await page.policy.load();
      return page;
    },
    /** A new Page object loaded from durable storage alone, as after a crash:
     * the document is the bytes the last flush wrote, and the load path runs
     * (journal recovery, then preserved-block conversion). */
    async crashRestart() {
      doc = A.load(persisted);
      commentsDoc = A.load(persistedComments);
      // The fixture installs its first record in memory only.
      page = build((await storage.get("host/document")) ?? structuredClone(page.metadata));
      await page.policy.load();
      // The load path opens the comments document itself.
      page.commentsHandle = undefined;
      await page.loadDocument();
      return page;
    },
    hooks,
    tasks,
    blockId,
    catalogOf,
    catalogCall,
    pageCall,
    tool,
    bind,
    disconnected,
    disconnectErrors,
    removed: () => removed,
    doc: () => doc,
    commentsDoc: () => commentsDoc,
    commentHeads: () => A.getHeads(commentsDoc),
    edit(text) {
      doc = A.change(doc, (draft) => {
        draft.title = text;
      });
    },
    heads: () => A.getHeads(doc),
  };
}

export const trashArgs = (f, key = "trash-request") => ({
  page_id: pageId,
  base_heads: f.heads(),
  idempotency_key: key,
});

/** A Page built by the real constructor over storage, as on a cold start. */
export function coldPage(f, t) {
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
      import: async () => ({
        doc: () => f.commentsDoc(),
        broadcast() {},
        on() {},
        off() {},
      }),
      async delete() {},
      async flush() {},
    };
    this.commentsUuid = commentsUuid;
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
