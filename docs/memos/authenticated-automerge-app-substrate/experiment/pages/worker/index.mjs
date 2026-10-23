import * as N from "@automerge/subduction";
import * as A from "@automerge/automerge";
import {
  Repo,
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { SubductionBackend } from "@automerge/automerge-repo-subduction";
import {
  beginServerOidcLogin,
  completeServerOidcLogin,
  deleteServerOidcSession,
  serverOidcSessionStatus,
} from "@cloud/server-oidc.ts";
import { handleLocalOidcRequest } from "@cloud/dev-oidc.ts";
import { createPageData, initializePage, projectPage, applyPageOperation } from "../model/page.mjs";
import { BACKEND_LIMITS, assertDocumentLimits, assertIntentSize } from "../model/limits.mjs";
import { handleMcp } from "../mcp.mjs";
import { agentGuideResponse } from "../agent-guide.mjs";
import { WebSocketByteTransport } from "../shared/byte-transport.mjs";
import { MISSING_EDITS_MESSAGE } from "../shared/receipts.mjs";
import {
  authenticate,
  driverLabel,
  requireSameOrigin,
  requireWrite,
  HttpError,
  errorResponse,
  logFailure,
  json,
  readJson,
} from "./auth.mjs";
import { DurableByteStore, persistentSeed } from "./storage.mjs";
import { BufferedRecordStore, RemoteRecordSink } from "./record-persistence.mjs";
export { PageRecords } from "./record-persistence.mjs";
import { DocumentPolicy, hex, logicalId } from "./policy.mjs";
import {
  documentMutation,
  recoverDocumentMutations,
  mutationKey,
  fingerprint,
  existingIntent,
  reserveCapacity,
  requireHeads,
} from "./mutations.mjs";

import { catalogTitle, listCatalog, refreshCatalogTitle } from "./catalog.mjs";
import { readRegistration, requireRegistrationAccount, validPageId } from "./registration.mjs";

const operations = new Set([
  "list_pages",
  "create_page",
  "read_page",
  "edit_page",
  "patch_page",
  "manage_page_comment",
  "reply_page_comment",
  "delete_page",
]);
const noop = async () => {};
const publicIdentity = ({ principal, displayName, driver }) => ({ principal, displayName, driver });

function validateCreateInput(args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new HttpError(400, "Invalid create arguments");
  if (args.title !== undefined && (typeof args.title !== "string" || args.title.length > 500))
    throw new HttpError(400, "Invalid title");
  if (args.markdown !== undefined && typeof args.markdown !== "string")
    throw new HttpError(400, "Invalid markdown");
}

function forwarded(request, path, body) {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const headers = new Headers();
  for (const name of ["authorization", "cookie", "origin", "sec-fetch-site", "x-pages-driver"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-pages-driver", driverLabel(request));
  headers.set("content-type", "application/json");
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function invoke(request, env, operation, args = {}) {
  if (!operations.has(operation) || !args || typeof args !== "object" || Array.isArray(args))
    throw new HttpError(400, "Unknown operation or invalid arguments");
  const identity = await authenticate(request, env);
  if (!["list_pages", "read_page"].includes(operation)) requireWrite(identity);
  if (["list_pages", "create_page", "delete_page"].includes(operation)) {
    return env.CATALOGS.getByName(identity.principal).fetch(
      forwarded(request, "/internal/catalog", { operation, arguments: args }),
    );
  }
  if (!validPageId(args.page_id)) throw new HttpError(400, "Invalid page_id");
  return env.PAGES.getByName(args.page_id).fetch(
    forwarded(request, "/internal/tool", { operation, arguments: args }),
  );
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      // The test issuer is never mounted on a public hostname, even if a local
      // environment flag is accidentally copied into deployment configuration.
      if (
        env.NOTEBOOK_CLOUD_LOCAL_OIDC === "true" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ) {
        const local = await handleLocalOidcRequest(request, env);
        if (local) return local;
      }
      if (url.pathname === "/llms.txt") return agentGuideResponse(request, env);
      if (url.pathname === "/health") return json({ ok: true, prototype: "pages-celld-native" });
      if (url.pathname === "/api/auth/login" && request.method === "GET")
        return beginServerOidcLogin(request, env);
      if (url.pathname === "/oidc") return completeServerOidcLogin(request, env, noop);
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        requireSameOrigin(request, env);
        return deleteServerOidcSession(request, env);
      }
      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        let refreshed;
        if (!request.headers.has("authorization")) {
          refreshed = await serverOidcSessionStatus(request, env, noop);
          if (!refreshed.ok) return refreshed;
        }
        let identity = null;
        try {
          identity = await authenticate(request, env);
        } catch (error) {
          if (error.status !== 401) throw error;
        }
        const response = json(
          identity
            ? {
                identity: publicIdentity(identity),
                editor: env.PAGES_EDITOR === "wordgard" ? "wordgard" : "prosemirror",
                canWrite: identity.canWrite,
                expiresAt: identity.expiresAt,
              }
            : { identity: null, canWrite: false },
        );
        const cookie = refreshed?.headers.get("set-cookie");
        if (cookie) response.headers.set("set-cookie", cookie);
        return response;
      }
      if (url.pathname === "/mcp") {
        await authenticate(request, env);
        return handleMcp(request, async (operation, args) => {
          try {
            return await invoke(request, env, operation, args);
          } catch (error) {
            return errorResponse(error, "mcp-operation");
          }
        });
      }
      if (url.pathname === "/api/pages/register" && request.method === "POST") {
        const identity = await authenticate(request, env);
        requireWrite(identity);
        const args = await readJson(request);
        return env.CATALOGS.getByName(identity.principal).fetch(
          forwarded(request, "/internal/catalog", { operation: "register_page", arguments: args }),
        );
      }
      if (url.pathname === "/api/tools" && request.method === "POST") {
        const body = await readJson(request);
        return await invoke(request, env, body.operation, body.arguments);
      }
      if (["/api/connect", "/api/sync", "/api/saved"].includes(url.pathname)) {
        await authenticate(request, env);
        const id = url.searchParams.get("page");
        if (!validPageId(id)) throw new HttpError(400, "Invalid page");
        return env.PAGES.getByName(id).fetch(request);
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/"))
        return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error, "gateway");
    }
  },
};

/** Small, private per-account index. Document ownership stays in each Page DO. */
export class Catalog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.tail = Promise.resolve();
  }
  fetch(request) {
    const next = this.tail.then(() => this.run(request));
    this.tail = next.catch(() => {});
    return next;
  }
  async run(request) {
    try {
      const identity = await authenticate(request, this.env);
      if (this.ctx.id.name && this.ctx.id.name !== identity.principal)
        throw new HttpError(403, "Account access denied");
      const body = await readJson(request);
      if (new URL(request.url).pathname === "/internal/title") {
        if (
          !validPageId(body.page_id) ||
          typeof body.title !== "string" ||
          body.title.length > 500 ||
          typeof body.observed_at !== "string" ||
          !Number.isFinite(Date.parse(body.observed_at))
        )
          throw new HttpError(400, "Invalid title projection");
        await refreshCatalogTitle(this.ctx.storage, body);
        return json({ ok: true });
      }
      const args = body.arguments ?? {};
      if (body.operation === "list_pages") {
        return json({ pages: await listCatalog(this.ctx.storage), limit: 100 });
      }
      requireWrite(identity);
      if (!["create_page", "register_page", "delete_page"].includes(body.operation))
        throw new HttpError(400, "Unknown catalog operation");
      // Reject deterministic input errors before reserving an intent or page.
      const creating = ["create_page", "register_page"].includes(body.operation);
      const registering = body.operation === "register_page";
      if (
        body.operation === "delete_page" &&
        args.expected_principal !== undefined &&
        args.expected_principal !== identity.principal
      )
        throw new HttpError(403, "Sign in with this Page's original account to delete it");
      if (body.operation === "create_page") validateCreateInput(args);
      if (registering) {
        requireRegistrationAccount(args, identity);
        A.free(readRegistration(args).doc);
        // The browser knows its UUID before the Page host has an intent. A
        // successful deletion must also cancel retries of that local creation.
        if (await this.ctx.storage.get(`host/deleted/${args.page_id}`))
          throw new HttpError(409, "Page was deleted");
      }
      const key = mutationKey(args);
      const digest = await fingerprint(body.operation, args, identity);
      let intent = await existingIntent(this.ctx.storage, key, digest);
      if (intent && !intent.pending) {
        if (body.operation === "delete_page")
          await this.ctx.storage.put(`host/deleted/${intent.pageId}`, true);
        // A previous attempt may have stored its receipt before sync failed.
        await this.ctx.storage.sync();
        return json(intent.receipt);
      }
      if (!intent) {
        await reserveCapacity(this.ctx.storage);
        if (body.operation === "delete_page" && !validPageId(args.page_id))
          throw new HttpError(400, "Invalid page_id");
        if (creating && (await this.ctx.storage.list({ prefix: "page/", limit: 100 })).size >= 100)
          throw new HttpError(409, "This prototype permits 100 pages per account");
        if (registering && (await this.ctx.storage.get(`page/${args.page_id}`)))
          throw new HttpError(409, "Page already has another creation request");
        intent = {
          fingerprint: digest,
          pending: true,
          pageId: body.operation === "create_page" ? crypto.randomUUID() : args.page_id,
          createdAt: new Date().toISOString(),
        };
        await this.ctx.storage.put(key, intent);
      }
      const pageId = intent.pageId;
      if (creating) {
        await this.ctx.storage.put(`page/${pageId}`, {
          page_id: pageId,
          title: catalogTitle(args.title),
          created_at: intent.createdAt,
          updated_at: intent.createdAt,
          pending: true,
        });
        const response = await this.env.PAGES.getByName(pageId).fetch(
          forwarded(request, registering ? "/internal/register" : "/internal/create", {
            ...args,
            page_id: pageId,
          }),
        );
        if (!response.ok && response.headers.get("x-pages-create-rejected") === "before-intent") {
          // Only this explicit pre-intent rejection proves there is no Page
          // creation to recover. Ambiguous failures retain their reservation.
          await this.ctx.storage.delete(`page/${pageId}`);
          await this.ctx.storage.delete(key);
          await this.ctx.storage.sync();
        }
        if (!response.ok) return response;
        intent.receipt = await response.json();
        await this.ctx.storage.put(`page/${pageId}`, {
          page_id: pageId,
          title: catalogTitle(intent.receipt.title),
          created_at: intent.createdAt,
          updated_at: intent.createdAt,
        });
      } else {
        const response = await this.env.PAGES.getByName(pageId).fetch(
          forwarded(request, "/internal/delete", { ...args, page_id: pageId }),
        );
        // A missing Page is already absent; clean up this account's stale index.
        if (!response.ok && response.status !== 404) return response;
        await this.ctx.storage.put(`host/deleted/${pageId}`, true);
        await this.ctx.storage.delete(`page/${pageId}`);
        intent.receipt = { page_id: pageId, deleted: true };
      }
      intent.pending = false;
      await this.ctx.storage.put(key, intent);
      await this.ctx.storage.sync();
      return json(intent.receipt);
    } catch (error) {
      return errorResponse(error, "catalog");
    }
  }
}

export class Page {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.wires = new Set();
    this.tail = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.metadata = await ctx.storage.get("host/document");
      const creation = await ctx.storage.get("host/creation");
      // Looking up an unknown page must not create a persisted signer or repo.
      if (!this.metadata && !creation) return;
      await this.initializeRepo(this.metadata ?? creation?.metadata);
      // A completed deletion wins over an earlier interrupted creation.
      if (creation && !this.metadata?.deleted) await this.finishCreation(creation);
      if (!this.handle && this.metadata?.documentId && !this.metadata.deleted) {
        this.handle = await this.repo.find(this.metadata.documentId);
        await recoverDocumentMutations(ctx.storage, this.handle, () => this.flush());
      }
    });
  }

  initializeRepo(metadata = this.metadata) {
    if (this.repo) return Promise.resolve();
    if (this.initializing) return this.initializing;
    // Keep partial native resources private until the complete host is ready.
    const attempt = (async () => {
      const ctx = this.ctx;
      let signer, backend;
      try {
        if (![undefined, "local", "buffered"].includes(metadata?.recordStorage))
          throw Error("Unsupported Page record storage mode");
        signer = N.MemorySigner.fromBytes(await persistentSeed(ctx.storage));
        const serverKey = hex(signer.verifyingKey());
        const peer = signer.peerId();
        let serverSenderId;
        try {
          serverSenderId = peer.toString();
        } finally {
          peer.free();
        }
        const policy = new DocumentPolicy({
          storage: ctx.storage,
          metadata: () => this.metadata,
          serverKey,
        });
        await policy.load();
        const recordStore =
          metadata?.recordStorage === "buffered"
            ? new BufferedRecordStore(
                new RemoteRecordSink(this.env.PAGE_RECORDS.getByName(metadata.pageId)),
                { onDirty: () => this.schedulePersistence() },
              )
            : new DurableByteStore(ctx.storage);
        if (recordStore.ready) await recordStore.ready;
        backend = new SubductionBackend({
          signer,
          storage: recordStore,
          policy: policy.native(),
          ephemeralPolicy: policy.ephemeral(),
          ...BACKEND_LIMITS,
        });
        const repo = new Repo({ backend });
        Object.assign(this, {
          signer,
          serverKey,
          serverSenderId,
          policy,
          backend,
          repo,
          recordStore,
        });
      } catch (error) {
        const failures = [error];
        // The backend borrows its signer until close finishes, even on failure.
        try {
          await backend?.close();
        } catch (cleanup) {
          failures.push(cleanup);
        }
        try {
          signer?.free();
        } catch (cleanup) {
          failures.push(cleanup);
        }
        if (failures.length > 1) throw new AggregateError(failures, "Page initialization failed");
        throw error;
      }
    })();
    this.initializing = attempt;
    const clear = () => {
      if (this.initializing === attempt) this.initializing = undefined;
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  async finishCreation(intent) {
    this.handle = await this.repo.import(intent.bytes, { docId: intent.metadata.documentId });
    this.metadata = intent.metadata;
    await this.ctx.storage.put("host/document", this.metadata);
    await this.flush();
    await this.ctx.storage.delete("host/creation");
    await this.ctx.storage.sync();
  }

  profiles() {
    return {
      ...this.policy.profiles(),
      [this.serverSenderId]: {
        principal: this.metadata.owner,
        displayName: this.metadata.ownerName,
        driver: "Pages API",
      },
    };
  }

  cacheTitle(request) {
    const title = catalogTitle(this.handle.doc().title);
    if (this.cachedTitle === title) return;
    this.cachedTitle = title;
    // Best effort after a real read or save, never part of the content receipt.
    // Reuse the verified caller credential; no internal identity headers.
    const projection = forwarded(request, "/internal/title", {
      page_id: this.metadata.pageId,
      title,
      observed_at: new Date().toISOString(),
    });
    // An authenticated GET may not carry Origin. This is a host-created POST,
    // after the original request passed the browser origin and account gates.
    if (!projection.headers.has("origin"))
      projection.headers.set("origin", new URL(request.url).origin);
    this.ctx.waitUntil(
      this.env.CATALOGS.getByName(this.metadata.owner)
        .fetch(projection)
        .then((response) => {
          if (!response.ok && this.cachedTitle === title) this.cachedTitle = undefined;
        })
        .catch(() => {
          if (this.cachedTitle === title) this.cachedTitle = undefined;
        }),
    );
  }

  schedulePersistence() {
    if (this.persistenceScheduled) return;
    this.persistenceScheduled = true;
    this.ctx.waitUntil(
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, this.persistenceDelay ?? 1000));
        try {
          await this.recordStore.flush();
          this.persistenceDelay = 1000;
        } catch (error) {
          logFailure(error, "record-persistence");
          this.persistenceDelay = Math.min((this.persistenceDelay ?? 1000) * 2, 30_000);
        } finally {
          this.persistenceScheduled = false;
          if (this.recordStore.dirty) this.schedulePersistence();
        }
      })(),
    );
  }

  async flush() {
    await this.repo.flush([this.metadata.documentId]);
    await this.backend.flush();
    await this.recordStore?.flush?.();
    await this.ctx.storage.sync();
  }

  fetch(request) {
    if (!new URL(request.url).pathname.startsWith("/internal/")) return this.run(request);
    const next = this.tail.then(() => this.run(request));
    this.tail = next.catch(() => {});
    return next;
  }

  async run(request) {
    try {
      await this.ready;
      const identity = await authenticate(request, this.env);
      const url = new URL(request.url);
      if (url.pathname === "/internal/register") return await this.register(request, identity);
      if (url.pathname === "/internal/create") {
        requireWrite(identity);
        if (this.metadata) {
          this.policy.account(identity);
          // Metadata can be installed before creation persistence succeeds.
          // Replaying the recorded import preserves its exact history.
          const creation = await this.ctx.storage.get("host/creation");
          if (creation) await this.finishCreation(creation);
          else await this.flush();
          return json(
            this.metadata.createdReceipt ?? {
              page_id: this.metadata.pageId,
              title: this.handle.doc().title,
              heads: A.getHeads(this.handle.doc()),
            },
          );
        }
        const args = await readJson(request);
        if (!validPageId(args?.page_id) || (this.ctx.id.name && args.page_id !== this.ctx.id.name))
          throw new HttpError(400, "Invalid page_id");
        validateCreateInput(args);
        let intent = await this.ctx.storage.get("host/creation");
        if (intent) {
          // Catalog handles argument replay; this DO independently pins ownership.
          if (intent.metadata.owner !== identity.principal)
            throw new HttpError(403, "Document access denied");
        } else {
          try {
            const doc = A.change(
              A.from(createPageData({ pageId: args.page_id, title: args.title })),
              (draft) => initializePage(draft, args.markdown ?? ""),
            );
            assertDocumentLimits(doc);
            const documentId = interpretAsDocumentId(generateAutomergeUrl());
            const metadata = {
              recordStorage: this.env.PAGES_ASYNC_PERSISTENCE === "true" ? "buffered" : "local",
              pageId: args.page_id,
              owner: identity.principal,
              ownerName: identity.displayName,
              documentId,
              tree: logicalId(documentIdToBinary(documentId)),
              deleted: false,
              createdReceipt: { page_id: args.page_id, title: doc.title, heads: A.getHeads(doc) },
            };
            intent = { metadata, bytes: A.save(doc) };
            assertIntentSize("host/creation", [intent.bytes], { metadata });
          } catch (error) {
            if (error.status !== 413) throw error;
            const response = json({ error: error.message }, 413);
            response.headers.set("x-pages-create-rejected", "before-intent");
            return response;
          }
          await this.ctx.storage.put("host/creation", intent);
        }
        await this.initializeRepo(intent.metadata);
        await this.finishCreation(intent);
        return json(intent.metadata.createdReceipt, 201);
      }
      if (!this.metadata) throw new HttpError(404, "Page not found");
      if (url.pathname === "/internal/delete") {
        requireWrite(identity);
        if (this.metadata.owner !== identity.principal)
          throw new HttpError(403, "Document access denied");
        const args = await readJson(request);
        if (args.page_id !== this.metadata.pageId) throw new HttpError(400, "Invalid page_id");
        const key = mutationKey(args);
        const digest = await fingerprint("delete_page", args, identity);
        if (this.metadata.deleted) {
          // A new retry key still completes the original deletion barriers.
          if (this.metadata.deletion?.key === key && this.metadata.deletion.fingerprint !== digest)
            throw new HttpError(409, "idempotency_key was used for a different request");
        } else {
          requireHeads(this.handle.doc(), args.base_heads);
          // No await between the head guard and the policy-visible tombstone.
          // The tombstone also records the exact request for crash-safe retries.
          this.metadata = {
            ...this.metadata,
            deleted: true,
            deletion: {
              key,
              fingerprint: digest,
              receipt: { page_id: this.metadata.pageId, deleted: true },
            },
          };
        }
        // Persist again on retry: a previous storage failure may have occurred
        // after admission stopped, but before the tombstone reached storage.
        await this.ctx.storage.put("host/document", this.metadata);
        await this.policy.close();
        for (const wire of this.wires) await wire.disconnect();
        await this.repo.delete(this.metadata.documentId);
        await this.backend.flush();
        await this.recordStore?.flush?.();
        await this.ctx.storage.sync();
        return json(this.metadata.deletion.receipt);
      }
      if (this.metadata.deleted) throw new HttpError(404, "Page not found");
      this.policy.account(identity);
      if (url.pathname === "/api/connect" && request.method === "GET") {
        this.cacheTitle(request);
        return json({
          page_id: this.metadata.pageId,
          documentId: this.metadata.documentId,
          serverPeerId: this.serverKey,
          serverSenderId: this.serverSenderId,
          identity: publicIdentity(identity),
          canWrite: identity.canWrite,
          peerProfiles: this.profiles(),
        });
      }
      if (url.pathname === "/api/sync" && request.method === "GET")
        return this.connect(request, identity);
      if (url.pathname === "/api/saved" && request.method === "POST") {
        const { heads } = await readJson(request);
        await this.waitForHeads(heads);
        this.policy.account(await authenticate(request, this.env));
        const durableHeads = A.getHeads(this.handle.doc());
        await this.flush();
        this.cacheTitle(request);
        return json({ durableHeads });
      }
      if (url.pathname === "/internal/tool") {
        const body = await readJson(request);
        if (body.operation === "read_page") {
          this.cacheTitle(request);
          return json({ ...projectPage(this.handle.doc()), heads: A.getHeads(this.handle.doc()) });
        }
        requireWrite(identity);
        if (
          !["edit_page", "patch_page", "manage_page_comment", "reply_page_comment"].includes(
            body.operation,
          )
        )
          throw new HttpError(400, "Unknown document operation");
        const receipt = await documentMutation({
          storage: this.ctx.storage,
          handle: this.handle,
          operation: body.operation,
          args: body.arguments,
          identity,
          apply: (doc) => {
            try {
              return applyPageOperation(doc, {
                operation: body.operation,
                arguments: body.arguments,
                identity: publicIdentity(identity),
              });
            } catch (error) {
              throw new HttpError(400, error.message);
            }
          },
          flush: () => this.flush(),
        });
        this.cacheTitle(request);
        this.handle.broadcast({
          kind: "tool-edit",
          identity: publicIdentity(identity),
          heads: receipt.heads,
        });
        return json(receipt);
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      return errorResponse(error, "page");
    }
  }

  async register(request, identity) {
    requireWrite(identity);
    let intent;
    // Only rejections before recording a creation may release the Catalog slot.
    // An interrupted import keeps its immutable bytes and exact request digest.
    try {
      const args = await readJson(request);
      requireRegistrationAccount(args, identity);
      if (!validPageId(args.page_id) || (this.ctx.id.name && args.page_id !== this.ctx.id.name))
        throw new HttpError(400, "Invalid page_id");
      mutationKey(args);
      const digest = await fingerprint("register_page", args, identity);
      intent = await this.ctx.storage.get("host/creation");
      const metadata = this.metadata ?? intent?.metadata;
      if (metadata) {
        if (metadata.owner !== identity.principal)
          throw new HttpError(403, "Document access denied");
        if (metadata.deleted) throw new HttpError(409, "Page was deleted");
        if (metadata.registration !== digest)
          throw new HttpError(409, "Page already has another creation request");
      } else {
        const { doc, bytes } = readRegistration(args);
        try {
          const metadata = {
            recordStorage: this.env.PAGES_ASYNC_PERSISTENCE === "true" ? "buffered" : "local",
            pageId: args.page_id,
            owner: identity.principal,
            ownerName: identity.displayName,
            documentId: args.document_id,
            tree: logicalId(documentIdToBinary(args.document_id)),
            deleted: false,
            registration: digest,
            createdReceipt: {
              page_id: args.page_id,
              document_id: args.document_id,
              title: doc.title,
              heads: A.getHeads(doc),
            },
          };
          intent = { metadata, bytes };
          assertIntentSize("host/creation", [bytes], { metadata });
        } finally {
          A.free(doc);
        }
      }
    } catch (error) {
      if (![400, 403, 409, 413].includes(error.status)) throw error;
      const response = errorResponse(error, "page-registration");
      response.headers.set("x-pages-create-rejected", "before-intent");
      return response;
    }
    if (intent) {
      // Put again on replay in case the prior barrier failed ambiguously.
      await this.ctx.storage.put("host/creation", intent);
      await this.initializeRepo(intent.metadata);
      await this.finishCreation(intent);
    } else await this.flush();
    return json(this.metadata.createdReceipt, 201);
  }

  async waitForHeads(heads) {
    if (
      !Array.isArray(heads) ||
      heads.length < 1 ||
      heads.length > 128 ||
      heads.some((head) => typeof head !== "string" || !/^[0-9a-f]{64}$/.test(head))
    )
      throw new HttpError(400, "Invalid heads");
    if (A.hasHeads(this.handle.doc(), heads)) return;
    await new Promise((resolve, reject) => {
      const changed = () => {
        if (A.hasHeads(this.handle.doc(), heads)) {
          clearTimeout(timer);
          this.handle.off("heads-changed", changed);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.handle.off("heads-changed", changed);
        reject(new HttpError(409, MISSING_EDITS_MESSAGE));
      }, 10_000);
      this.handle.on("heads-changed", changed);
      changed();
    });
  }

  connect(request, identity) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      throw new HttpError(426, "WebSocket upgrade required");
    if (this.wires.size >= 24) throw new HttpError(429, "Too many connected peers");
    const pair = new WebSocketPair();
    const client = pair[0],
      socket = pair[1];
    socket.accept(); // Resident connection; reconnect reconstructs native state.
    const wire = new WebSocketByteTransport(socket);
    const disconnected = new Promise((resolve) => wire.onDisconnect(resolve));
    this.wires.add(wire);
    let release = noop;
    let leaseTimer;
    let expiryTimer;
    const handshakeTimer = setTimeout(() => {
      void wire.disconnect();
    }, 10_000);
    wire.onDisconnect(() => {
      clearTimeout(handshakeTimer);
      clearInterval(leaseTimer);
      clearTimeout(expiryTimer);
      release();
      this.wires.delete(wire);
    });
    this.ctx.waitUntil(
      (async () => {
        const transport = await N.AuthenticatedTransport.accept(wire, this.signer);
        try {
          const peer = transport.peerId;
          let key, senderId;
          try {
            key = hex(peer.toBytes());
            senderId = peer.toString();
          } finally {
            peer.free();
          }
          // Only the native verified peer and the credential verified on this
          // upgrade may establish this durable binding, before backend admission.
          release = await this.policy.bind(key, senderId, identity, {
            reauthenticate: () => authenticate(request, this.env),
            disconnect: () => wire.disconnect(),
          });
          wire.onDisconnect(release);
          clearTimeout(handshakeTimer);
          expiryTimer = setTimeout(
            () => {
              void wire.disconnect();
            },
            Math.max(1, identity.expiresAt - Date.now()),
          );
          leaseTimer = setInterval(
            () => {
              void this.policy.active(key).catch(() => wire.disconnect());
            },
            Math.min(15_000, Math.max(1, identity.expiresAt - Date.now())),
          );
          wire.onDisconnect(() => {
            clearInterval(leaseTimer);
            clearTimeout(expiryTimer);
          });
          await this.backend.addConnection(transport);
          this.handle.broadcast({ kind: "identity-profiles", peerProfiles: this.profiles() });
        } finally {
          transport.free();
        }
        // Native callbacks retain this request's I/O context. Keep it alive
        // while the resident socket can trigger authorization and storage work.
        await disconnected;
      })().catch((error) => {
        logFailure(error, "native-admission");
        void wire.disconnect();
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }
}
