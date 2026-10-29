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
import {
  createPageData,
  initializePage,
  applyPageOperation,
  validateImageInsertion,
} from "../model/page.mjs";
import { BACKEND_LIMITS, assertDocumentLimits, assertIntentSize } from "../model/limits.mjs";
import { handleMcp } from "../mcp.mjs";
import { agentGuideResponse } from "../agent-guide.mjs";
import { connectAgentResponse } from "../connect-agent.mjs";
import { handleOAuth, mcpAuthChallenge } from "./oauth.mjs";
import { WebSocketByteTransport } from "../shared/byte-transport.mjs";
import { MISSING_EDITS_MESSAGE } from "../shared/receipts.mjs";
import { openingTitleWarning } from "../model/title-warning.mjs";
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
import { DocumentAdmission, isHistoryCapacityError } from "./history-admission.mjs";
import { issueRetryToken, inspectOperation, reserveOperation } from "./operation-journal.mjs";
import { BufferedRecordStore, RemoteRecordSink } from "./record-persistence.mjs";
import { RecordMaintenance } from "./record-maintenance.mjs";
export { PageRecords } from "./record-persistence.mjs";
import {
  DocumentPolicy,
  PermissionDenied,
  admissionCancelled,
  credentialExpired,
  hex,
  logicalId,
} from "./policy.mjs";
import {
  ADMISSION_ROUTES,
  admissionCloseCode,
  admissionCode,
  admissionErrorResponse,
  admissionReason,
  logAdmissionDenied,
  transportRefusal,
  withAdmissionReason,
} from "./admission-reasons.mjs";
import { ADMISSION_CAPABILITY } from "../shared/admission.mjs";

const unifiedMissing = (request) =>
  request.headers.get(ADMISSION_CAPABILITY.header) === ADMISSION_CAPABILITY.value;
import {
  documentMutation,
  recoverDocumentMutations,
  mutationKey,
  fingerprint,
  requireHeads,
} from "./mutations.mjs";

import { claimInvitation, proposeSharingMutation, sharingProjection } from "./sharing.mjs";
import { pageAccess, restrictAccessDuringCommit } from "./access.mjs";

import { catalogTitle, refreshCatalogTitle } from "./catalog.mjs";
import {
  CatalogIndexUnavailable,
  catalogIndexDatabase,
  catalogIndexEpoch,
  catalogIndexTimeouts,
  catalogSource,
  indexSource,
  indexedState,
  listingRestricted,
  markCatalogIndexDirty,
  openCursor,
  parseListArguments,
  pruneIndexRows,
  reconcileAccountIndex,
  reportPageIndex,
  restrictPageIndex,
  retirePageIndex,
  sealCursor,
  titleMatches,
  withTimeout,
} from "./catalog-index.mjs";
import { readRegistration, requireRegistrationAccount, validPageId } from "./registration.mjs";
import { handleImageAssets, requireStoredImageAsset } from "./image-assets.mjs";
import { handleImportPageImage } from "./import-image.mjs";
import { readTool } from "./tool-reads.mjs";
import { readChangesTool } from "./tool-changes.mjs";
import { PageActivity } from "./page-activity.mjs";

const operations = new Set([
  "list_pages",
  "create_page",
  "read_page",
  "read_page_changes",
  "list_page_comments",
  "read_page_presence",
  "report_page_progress",
  "import_page_image",
  "edit_page",
  "patch_page",
  "manage_page_comment",
  "reply_page_comment",
  "delete_page",
]);
const noop = async () => {};
const INDEX_REPORT_PENDING = "host/index/report-pending";
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
  if (request.headers.has("x-pages-driver") || new URL(request.url).searchParams.has("driver"))
    headers.set("x-pages-driver", driverLabel(request));
  headers.set("content-type", "application/json");
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function authorizeImage(request, env, pageId, write) {
  const internal = forwarded(request, "/internal/assets/authorize", { page_id: pageId, write });
  // Only the host creates this request. Reauthenticate on every call so a grant
  // or Page permission revoked during a transfer cannot authorize its result.
  if (!internal.headers.has("origin"))
    internal.headers.set("origin", new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin);
  return env.PAGES.getByName(pageId).fetch(internal);
}

async function invoke(request, env, operation, args = {}) {
  if (!operations.has(operation) || !args || typeof args !== "object" || Array.isArray(args))
    throw new HttpError(400, "Unknown operation or invalid arguments");
  const identity = await authenticate(request, env);
  if (
    ![
      "list_pages",
      "read_page",
      "read_page_changes",
      "list_page_comments",
      "read_page_presence",
    ].includes(operation)
  )
    requireWrite(identity);
  if (["list_pages", "create_page", "delete_page"].includes(operation)) {
    return env.CATALOGS.getByName(identity.principal).fetch(
      forwarded(request, "/internal/catalog", { operation, arguments: args }),
    );
  }
  if (!validPageId(args.page_id)) throw new HttpError(400, "Invalid page_id");
  if (operation === "import_page_image") {
    if (Object.keys(args).some((key) => !["page_id", "file"].includes(key)))
      throw new HttpError(400, "Invalid image import arguments");
    // Transfer bytes at the Worker edge; only short access checks enter the DO.
    return handleImportPageImage(request, env, {
      pageId: args.page_id,
      file: args.file,
      authorize: (write) => authorizeImage(request, env, args.page_id, write),
    });
  }
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
      if (url.pathname === "/connect") return connectAgentResponse(request, env);
      if (url.pathname === "/llms.txt") return agentGuideResponse(request, env);
      if (url.pathname === "/health") return json({ ok: true, prototype: "pages-celld-native" });
      const oauth = await handleOAuth(request, env);
      if (oauth) return oauth;
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
                editor: "wordgard",
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
        return await handleMcp(
          request,
          async (operation, args) => {
            try {
              return await invoke(request, env, operation, args);
            } catch (error) {
              return errorResponse(error, "mcp-operation");
            }
          },
          env,
        );
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
      const imageRoute = url.pathname.match(/^\/api\/pages\/([^/]+)\/assets(?:\/([^/]+))?$/);
      if (imageRoute) {
        const [, pageId, assetId] = imageRoute;
        return handleImageAssets(request, env, {
          pageId,
          assetId,
          authorize: (write) => authorizeImage(request, env, pageId, write),
        });
      }
      if (url.pathname === "/api/access") {
        await authenticate(request, env);
        const pageId = url.searchParams.get("page");
        if (!validPageId(pageId)) throw new HttpError(400, "Invalid page_id");
        if (!["GET", "POST"].includes(request.method)) throw new HttpError(405, "Use GET or POST");
        const internal = forwarded(request, "/internal/access", {
          ...(request.method === "POST" ? await readJson(request) : {}),
          read: request.method === "GET",
        });
        // The original request already passed authentication/origin checks.
        // This host-created POST uses the configured public origin: a tunnel
        // can give the inbound URL a private HTTP origin instead.
        if (!internal.headers.has("origin"))
          internal.headers.set(
            "origin",
            new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin,
          );
        return env.PAGES.getByName(pageId).fetch(internal);
      }
      if (ADMISSION_ROUTES.includes(url.pathname)) {
        let identity;
        try {
          identity = await authenticate(request, env);
          const id = url.searchParams.get("page");
          if (!validPageId(id)) throw new HttpError(400, "Invalid page");
          return await env.PAGES.getByName(id).fetch(request);
        } catch (error) {
          if ((error.status ?? 500) >= 500) logFailure(error, "gateway");
          return admissionErrorResponse(error, { stage: "gateway", identity });
        }
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/"))
        return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      const response = errorResponse(error, "gateway");
      return new URL(request.url).pathname === "/mcp" && response.status === 401
        ? mcpAuthChallenge(env, response)
        : response;
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
      if (new URL(request.url).pathname === "/internal/projection") {
        // Reachable only through the host's CATALOGS namespace, never the gateway.
        const value = await readJson(request);
        if (!validPageId(value.page_id)) throw new HttpError(400, "Invalid page_id");
        const key = `${value.shared ? "shared/" : "page/"}${value.page_id}`;
        const previous = await this.ctx.storage.get(key);
        if (value.remove) await this.ctx.storage.delete(key);
        else if (
          !previous?.pending &&
          !(await this.ctx.storage.get(`host/deleted/${value.page_id}`)) &&
          (!previous?.updated_at || previous.updated_at <= value.observed_at)
        ) {
          // A new discovery entry may not have reached D1; reconcile on next listing.
          if (!previous) await markCatalogIndexDirty(this.ctx.storage);
          await this.ctx.storage.put(key, {
            ...previous,
            page_id: value.page_id,
            title: catalogTitle(value.title),
            created_at: previous?.created_at ?? value.observed_at,
            updated_at: value.observed_at,
            shared: value.shared === true,
          });
        }
        return json({ ok: true });
      }
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
      if (body.operation === "list_pages") return await this.listPages(request, identity, args);
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
      const inspected = await inspectOperation(this.ctx.storage, {
        key,
        digest,
        retryToken: args.retry_token,
        scope: `catalog:${identity.principal}`,
        principal: identity.principal,
      });
      let intent = inspected.entry;
      if (intent && !intent.pending) {
        if (body.operation === "delete_page")
          await this.ctx.storage.put(`host/deleted/${intent.pageId}`, true);
        // A previous attempt may have stored its receipt before sync failed.
        await this.ctx.storage.sync();
        return json(intent.receipt);
      }
      if (!intent) {
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
        intent = await reserveOperation(this.ctx.storage, {
          key,
          entry: intent,
          retry: inspected.retry,
        });
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
        await markCatalogIndexDirty(this.ctx.storage);
      } else {
        const response = await this.env.PAGES.getByName(pageId).fetch(
          forwarded(request, "/internal/delete", { ...args, page_id: pageId }),
        );
        // A missing Page is already absent; clean up this account's stale index.
        if (!response.ok && response.status !== 404) return response;
        await this.ctx.storage.put(`host/deleted/${pageId}`, true);
        await this.ctx.storage.delete(`page/${pageId}`);
        await markCatalogIndexDirty(this.ctx.storage);
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

  /** Ask the Page host, with the caller's own credentials, for one shared
   * title. A host that does not answer within the deadline counts as
   * unavailable, never as denied. */
  async verifyShared(request, pageId) {
    try {
      const response = await withTimeout(
        this.env.PAGES.getByName(pageId).fetch(forwarded(request, "/internal/catalog", {})),
        catalogIndexTimeouts.verify,
        "Shared Page check timed out",
      );
      if (response.ok) return { status: "ok", page: await response.json() };
      if ([403, 404].includes(response.status)) return { status: "denied" };
    } catch (error) {
      logFailure(error, "catalog-verify");
    }
    return { status: "unavailable" };
  }

  /**
   * D1 or this Catalog's entries supply candidates; neither is authority for a
   * title. Owner rows must match this account's own `page/` (or `trash/`)
   * entry, and every other row is checked by its Page host. Titles shown come
   * from those checks; search matches the caller's own authorized snapshots.
   * The scan looks ahead for one verified row past the page, so rejected rows
   * set next_cursor only when the scan stops at its bound, and then only over
   * stale rows whose snapshots the caller was previously authorized to see.
   * The cursor is sealed to the caller, query and in_trash, and rejected rows
   * are pruned on encounter.
   */
  async listPages(request, identity, args) {
    const options = parseListArguments(args);
    const storage = this.ctx.storage;
    const context = {
      principal: identity.principal,
      needle: options.needle,
      inTrash: options.inTrash,
    };
    const after = options.cursor ? await openCursor(this.env, context, options.cursor) : null;
    const epoch = catalogIndexEpoch(this.env);
    let db;
    let source;
    if (epoch) {
      try {
        db = await withTimeout(catalogIndexDatabase(this.env), catalogIndexTimeouts.read);
        const ready = await reconcileAccountIndex({
          db,
          storage,
          principal: identity.principal,
          epoch,
          verify: (pageId) => this.verifyShared(request, pageId),
        });
        const evidence = identity.domainAccess;
        // Until an account's first reconcile completes, its D1 rows may be
        // missing; the Catalog entries serve while the pass advances.
        if (ready)
          source = indexSource(db, {
            principal: identity.principal,
            domain: evidence?.expiresAt > Date.now() ? evidence.domain : null,
            inTrash: options.inTrash,
            needle: options.needle,
          });
      } catch (error) {
        // Listing degrades to the Catalog entries; editing never waits on D1.
        logFailure(error, "catalog-index");
      }
    }
    let result;
    if (source) {
      try {
        result = await this.scanCandidates(request, identity, source, options, after, db);
        result.source = "index";
      } catch (error) {
        if (!(error instanceof CatalogIndexUnavailable)) throw error;
        logFailure(error, "catalog-index");
      }
    }
    result ??= {
      ...(await this.scanCandidates(
        request,
        identity,
        await catalogSource(storage, options),
        options,
        after,
        null,
      )),
      source: "catalog",
    };
    const response = json({
      pages: result.pages,
      limit: options.limit,
      next_cursor: result.next ? await sealCursor(this.env, context, result.next) : null,
      ...(await issueRetryToken(storage, {
        scope: `catalog:${identity.principal}`,
        principal: identity.principal,
      })),
    });
    response.headers.set("x-pages-catalog-source", result.source);
    return response;
  }

  async scanCandidates(request, identity, source, options, after, db) {
    const storage = this.ctx.storage;
    const pruned = [];
    let stale = false;
    const check = async (row) => {
      if (row.owned) {
        const entry = await storage.get(`${options.inTrash ? "trash/" : "page/"}${row.page_id}`);
        if (!entry) {
          stale = true;
          pruned.push({
            page_id: row.page_id,
            principal: identity.principal,
            revision: row.revision,
          });
        }
        if (!entry || entry.pending) return null;
        const title = catalogTitle(entry.title);
        if (!titleMatches(title, options.needle)) return null;
        return {
          page_id: row.page_id,
          title,
          created_at: entry.created_at ?? row.created_at,
          updated_at: row.updated_at,
          ...(entry.trashed_at ? { trashed_at: entry.trashed_at } : {}),
        };
      }
      if (options.inTrash) return null;
      const result = await this.verifyShared(request, row.page_id);
      if (result.status === "unavailable")
        throw new HttpError(503, "Shared Pages are temporarily unavailable");
      if (result.status === "denied" || (result.page.state && result.page.state !== "active")) {
        pruned.push({
          page_id: row.page_id,
          principal: identity.principal,
          revision: row.revision,
        });
        await storage.delete(`shared/${row.page_id}`);
        return null;
      }
      const title = catalogTitle(result.page.title);
      if (!titleMatches(title, options.needle)) return null;
      return {
        page_id: row.page_id,
        title,
        created_at: row.created_at,
        updated_at: row.updated_at,
        shared: true,
      };
    };
    const limit = options.limit;
    const scanBound = limit * 2 + 16;
    const verified = [];
    let position = after;
    let scanned = 0;
    let exhausted = false;
    while (verified.length <= limit && scanned < scanBound) {
      const want = Math.min(limit + 1 - verified.length, scanBound - scanned);
      const rows = await source.next(position, want);
      for (let index = 0; index < rows.length; index += 8) {
        const group = rows.slice(index, index + 8);
        for (const [offset, page] of (await Promise.all(group.map(check))).entries())
          if (page) verified.push({ page, row: group[offset] });
      }
      scanned += rows.length;
      if (rows.length) position = rows.at(-1);
      if (rows.length < want) {
        exhausted = true;
        break;
      }
    }
    if (db) {
      // A rejected owner row means D1 missed a lifecycle change; reconcile it.
      if (stale) await markCatalogIndexDirty(storage);
      await pruneIndexRows(db, pruned).catch((error) => logFailure(error, "catalog-index-prune"));
    }
    if (verified.length > limit)
      return {
        pages: verified.slice(0, limit).map(({ page }) => page),
        next: verified[limit - 1].row,
      };
    // Only a scan stopped by its bound, not by the end of the candidates,
    // continues from the last scanned row.
    return { pages: verified.map(({ page }) => page), next: exhausted ? null : position };
  }
}

export class Page {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.wires = new Set();
    this.wirePrincipals = new Map();
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
        this.observeActivity();
        try {
          await recoverDocumentMutations(
            ctx.storage,
            this.handle,
            () => this.flush(),
            this.admission,
          );
        } catch (error) {
          if (!isHistoryCapacityError(error)) throw error;
          // Capacity is checked on a clone before any pending edit reaches the
          // serving handle. Preserve accepted history and the unresolved intent.
          this.recoveryBlocked = {
            code: "page_recovery_blocked",
            pending: true,
            message:
              "A pending edit exceeds this Page's history capacity. Accepted content is available read-only.",
          };
        }
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
          metadata: () =>
            this.recoveryBlocked
              ? { ...(this.policyMetadata ?? this.metadata), recoveryBlocked: true }
              : (this.policyMetadata ?? this.metadata),
          serverKey,
        });
        await policy.load();
        const recordStore =
          metadata?.recordStorage === "buffered"
            ? new BufferedRecordStore(
                new RemoteRecordSink(this.env.PAGE_RECORDS.getByName(metadata.pageId)),
                {
                  onDirty: (record) => {
                    this.recordMaintenance?.recordWrite(record);
                    this.schedulePersistence();
                  },
                },
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
          ...(metadata?.documentId && {
            admission: new DocumentAdmission(backend, documentIdToBinary(metadata.documentId)),
          }),
          repo,
          recordStore,
        });
        this.recordMaintenance = new RecordMaintenance({
          enabled:
            this.env.PAGES_COMPACT_RECORDS === "true" && metadata?.recordStorage === "buffered",
          compact: () => {
            if (!this.metadata?.documentId || this.metadata.deleted || this.recoveryBlocked)
              return { skipped: "unavailable" };
            return backend.compact(documentIdToBinary(this.metadata.documentId), {
              // Both compaction barriers drain the remote record sink. Calling
              // repo/backend.flush here would recurse into its held owner queue.
              durable: () => recordStore.flush(),
            });
          },
          waitUntil: (work) => ctx.waitUntil(work),
          onError: (error) => logFailure(error, "record-maintenance"),
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
    this.observeActivity();
    this.admission ??= new DocumentAdmission(
      this.backend,
      documentIdToBinary(this.metadata.documentId),
    );
    await this.ctx.storage.put("host/document", this.metadata);
    await this.flush();
    await this.ctx.storage.delete("host/creation");
    await this.ctx.storage.sync();
  }

  profiles() {
    return {
      ...this.policy.profiles(),
      [this.serverSenderId]: {
        principal: "service:pages",
        displayName: "Pages",
        driver: "API",
      },
    };
  }

  activityState() {
    this.activity ??= new PageActivity({
      pageId: this.metadata.pageId,
      access: (identity) => this.policy.account(identity, true),
      profiles: () => this.policy.profiles(),
      onChange: (snapshot) => this.broadcastActivity(snapshot),
    });
    return this.activity;
  }

  observeActivity() {
    const activity = this.activityState();
    if (this.activityHandle === this.handle) return;
    if (this.activityHandle) this.activityHandle.off?.("ephemeral-message", this.activityListener);
    this.activityHandle = this.handle;
    this.activityListener = (event) => activity.receive(event);
    this.handle.on?.("ephemeral-message", this.activityListener);
  }

  broadcastActivity(snapshot = this.activity?.snapshot()) {
    if (!this.handle || !snapshot) return;
    try {
      this.handle.broadcast(snapshot);
    } catch (error) {
      logFailure(error, "page-activity");
    }
  }

  broadcastProfiles() {
    if (!this.handle) return;
    try {
      this.handle.broadcast({ kind: "identity-profiles", peerProfiles: this.profiles() });
    } catch (error) {
      // Cleanup must still release socket capacity if the document is closing.
      logFailure(error, "presence-profiles");
    }
  }

  cacheTitle(identity) {
    const title = catalogTitle(this.handle.doc().title);
    const observedReader =
      identity && pageAccess(this.metadata, identity).source === "domain"
        ? identity.principal
        : null;
    if (this.cachedTitle === title && !observedReader) return;
    const titleChanged = this.cachedTitle !== title;
    const recipients = !titleChanged
      ? [observedReader]
      : [
          this.metadata.owner,
          ...Object.entries(this.metadata.acl?.members ?? {})
            .filter(([, value]) => ["viewer", "editor"].includes(value.role))
            .map(([principal]) => principal),
          ...(observedReader ? [observedReader] : []),
        ];
    this.cachedTitle = title;
    const observedAt = new Date().toISOString();
    if (titleChanged) this.titleObservedAt = observedAt;
    const tasks = recipients.map((principal) =>
      this.env.CATALOGS.getByName(principal).fetch(
        new Request("https://pages.internal/internal/projection", {
          method: "POST",
          body: JSON.stringify({
            page_id: this.metadata.pageId,
            title,
            observed_at: observedAt,
            shared: principal !== this.metadata.owner,
          }),
        }),
      ),
    );
    if (catalogIndexEpoch(this.env)) {
      if (titleChanged) this.indexedReaders = new Set();
      this.indexedReaders ??= new Set();
      const reader =
        observedReader && identity.domainAccess && !this.indexedReaders.has(observedReader)
          ? { principal: observedReader, domain: identity.domainAccess.domain }
          : undefined;
      if (titleChanged || reader) {
        if (reader) this.indexedReaders.add(reader.principal);
        tasks.push(
          this.reportIndex({ title, observedAt, reader, readerOnly: !titleChanged }).then(
            () => ({ ok: true }),
            (error) => {
              logFailure(error, "catalog-index-report");
              if (reader) this.indexedReaders?.delete(reader.principal);
              return { ok: false };
            },
          ),
        );
      }
    }
    this.ctx.waitUntil(
      Promise.all(tasks)
        .then((results) => {
          if (results.some((response) => !response.ok) && this.cachedTitle === title)
            this.cachedTitle = undefined;
        })
        .catch(() => {
          if (this.cachedTitle === title) this.cachedTitle = undefined;
        }),
    );
  }

  /** Post-commit catalog index reconcile. Writes start in order per Page; one
   * that outlives its timeout carries an older ACL revision, which the index
   * ignores once a newer report has landed. A failed report leaves a durable
   * marker, and the next request to this Page repeats it. */
  reportIndex(details) {
    const run = async () => {
      try {
        await withTimeout(
          reportPageIndex(this.env, { metadata: this.metadata, ...details }),
          catalogIndexTimeouts.write,
        );
      } catch (error) {
        this.indexReportPending = true;
        await this.ctx.storage.put(INDEX_REPORT_PENDING, true);
        throw error;
      }
      if (this.indexReportPending !== false) {
        this.indexReportPending = false;
        await this.ctx.storage.delete(INDEX_REPORT_PENDING);
      }
    };
    const next = (this.indexTail ?? Promise.resolve()).then(run, run);
    this.indexTail = next.catch(() => {});
    return next;
  }

  /** Repeat a report that failed earlier, possibly before a restart. */
  async repairIndex() {
    if (!catalogIndexEpoch(this.env) || !this.handle || this.metadata?.deleted) return;
    this.indexReportPending ??= (await this.ctx.storage.get(INDEX_REPORT_PENDING)) === true;
    if (!this.indexReportPending || this.indexRepairing) return;
    this.indexRepairing = true;
    this.ctx.waitUntil(
      this.reportIndex({
        title: catalogTitle(this.handle.doc().title),
        observedAt: new Date().toISOString(),
      })
        .catch((error) => logFailure(error, "catalog-index-repair"))
        .finally(() => {
          this.indexRepairing = false;
        }),
    );
  }

  /** Pre-commit removal of listing rows. Best-effort: revocation and deletion
   * never wait on D1 beyond a short bound, and listings verify every
   * non-owner title with this host, so a row left behind cannot leak one. */
  async restrictIndex(metadata, revision) {
    try {
      await withTimeout(
        restrictPageIndex(this.env, metadata, revision),
        catalogIndexTimeouts.write,
      );
    } catch (error) {
      logFailure(error, "catalog-index-restrict");
    }
  }

  /** Lifecycle state for the index, after the host record is durable. */
  async retireIndex() {
    if (!catalogIndexEpoch(this.env)) return;
    try {
      await withTimeout(retirePageIndex(this.env, this.metadata), catalogIndexTimeouts.write);
    } catch (error) {
      // Owner rows are confirmed against the Catalog and non-owner rows were
      // removed before commit, so a missed retirement cannot list the Page.
      logFailure(error, "catalog-index-retire");
    }
  }

  async installAccess(metadata) {
    // Restrict immediately, but make no new grant visible before the single
    // host record containing the ACL and receipt has crossed durability.
    this.pendingAccess = metadata;
    const previous = this.policyMetadata ?? this.metadata;
    const restricted = restrictAccessDuringCommit(previous, metadata);
    this.policyMetadata = { ...restricted, aclCommitting: true };
    this.activity?.prune();
    // Do not persist retired signer rows ahead of their grant generation. If
    // this host record never commits, restart may legitimately retain old access.
    await this.policy.refreshAccess({ persist: false });
    if (catalogIndexEpoch(this.env) && listingRestricted(previous, restricted, this.env))
      await this.restrictIndex(restricted, metadata.acl?.revision ?? 0);
    await this.ctx.storage.put("host/document", metadata);
    await this.ctx.storage.sync();
    this.metadata = metadata;
    this.policyMetadata = undefined;
    await this.policy.refreshAccess();
    this.activity?.prune();
    this.pendingAccess = undefined;
    this.cachedTitle = undefined;
    this.cacheTitle();
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
          this.recordMaintenance?.flushed();
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
    // Permission changes/claims and HTTP mutations share one admission order.
    // Native frames still run directly through the current DocumentPolicy.
    if (["/api/sync", "/api/saved"].includes(new URL(request.url).pathname))
      return this.run(request);
    const next = this.tail.then(() => this.run(request));
    this.tail = next.catch(() => {});
    return next;
  }

  async run(request) {
    const url = new URL(request.url);
    const admissionRoute = ADMISSION_ROUTES.includes(url.pathname);
    let identity;
    try {
      await this.ready;
      identity = await authenticate(request, this.env);
      // An ambiguous storage failure retains the exact proposed ACL/receipt.
      // Normal HTTP work retries that barrier before reading or changing it.
      if (this.pendingAccess && !["/api/sync", "/api/saved"].includes(url.pathname))
        await this.installAccess(this.pendingAccess);
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
            const warning = openingTitleWarning(doc);
            const documentId = interpretAsDocumentId(generateAutomergeUrl());
            const metadata = {
              recordStorage: this.env.PAGES_ASYNC_PERSISTENCE === "true" ? "buffered" : "local",
              pageId: args.page_id,
              owner: identity.principal,
              ownerName: identity.displayName,
              documentId,
              tree: logicalId(documentIdToBinary(documentId)),
              deleted: false,
              createdReceipt: {
                page_id: args.page_id,
                title: doc.title,
                heads: A.getHeads(doc),
                ...(warning ? { warnings: [warning] } : {}),
              },
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
      if (!this.metadata) {
        // Admission routes answer a missing Page exactly as an unreadable one,
        // for clients that declare it. The deployed viewer renews an expired
        // draft registration only on this 404, so other clients keep it.
        // Remove the legacy branch once older viewers must reload before
        // reconnecting and every supported viewer handles the unified 403.
        if (admissionRoute && unifiedMissing(request))
          throw withAdmissionReason(new PermissionDenied(), "page_not_found");
        if (admissionRoute)
          throw withAdmissionReason(new HttpError(404, "Page not found"), "page_not_found_legacy");
        throw new HttpError(404, "Page not found");
      }
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
        this.recordMaintenance?.stop();
        this.activity?.close();
        if (catalogIndexEpoch(this.env)) await this.restrictIndex(this.metadata);
        // Persist again on retry: a previous storage failure may have occurred
        // after admission stopped, but before the tombstone reached storage.
        await this.ctx.storage.put("host/document", this.metadata);
        await this.policy.close();
        for (const wire of this.wires) await wire.disconnect();
        await this.repo.delete(this.metadata.documentId);
        await this.backend.flush();
        await this.recordStore?.flush?.();
        await this.ctx.storage.sync();
        await this.retireIndex();
        return json(this.metadata.deletion.receipt);
      }
      if (this.metadata.deleted) {
        // Only the owner and current grant holders learn that it was deleted.
        if (admissionRoute && !this.disclosesDeletion(identity.principal))
          throw withAdmissionReason(new PermissionDenied(), "page_deleted", "page_access_denied");
        throw withAdmissionReason(new HttpError(404, "Page not found"), "page_deleted");
      }
      if (!["/api/sync", "/api/saved"].includes(url.pathname)) {
        await this.repairIndex();
        const claimed = await claimInvitation(this.metadata, identity, this.env);
        if (claimed) await this.installAccess(claimed);
      }
      this.policy.account(identity);
      if (url.pathname === "/internal/assets/authorize") {
        const args = await readJson(request);
        if (args.page_id !== this.metadata.pageId || typeof args.write !== "boolean")
          throw new HttpError(400, "Invalid image access request");
        this.policy.account(identity, args.write);
        return json({ page_id: this.metadata.pageId });
      }
      if (url.pathname === "/internal/catalog") {
        // The first check after a restart reports this Page's current row and
        // fixes the time its title was observed.
        this.cacheTitle();
        // Fields after title let the caller's Catalog index this grant; the
        // listing returns only page_id and title from this response.
        const access = pageAccess(this.metadata, identity);
        const domain = access.source === "domain";
        return json({
          page_id: this.metadata.pageId,
          title: catalogTitle(this.handle.doc().title),
          shared: true,
          owner: this.metadata.owner,
          role: access.role,
          source: domain ? "domain_opened" : "member",
          ...(domain && { domain: identity.domainAccess?.domain }),
          revision: this.metadata.acl?.revision ?? 0,
          state: indexedState(this.metadata),
          title_observed_at: this.titleObservedAt,
        });
      }
      if (url.pathname === "/internal/access") {
        const args = await readJson(request);
        if (args.read) return json(sharingProjection(this.metadata, identity, this.env));
        const result = await proposeSharingMutation(
          this.metadata,
          identity,
          args,
          Date.now(),
          this.env,
        );
        // Replays repeat persistence: an earlier barrier may have failed after
        // installing the in-memory ACL and receipt.
        await this.installAccess(result.metadata);
        return json({
          ...sharingProjection(this.metadata, identity, this.env),
          receipt: result.receipt,
        });
      }
      if (url.pathname === "/api/connect" && request.method === "GET") {
        this.cacheTitle(identity);
        return json({
          page_id: this.metadata.pageId,
          documentId: this.metadata.documentId,
          serverPeerId: this.serverKey,
          serverSenderId: this.serverSenderId,
          identity: publicIdentity(identity),
          canWrite: !this.recoveryBlocked && pageAccess(this.metadata, identity).canWrite,
          access: {
            ...pageAccess(this.metadata, identity),
            ...(this.recoveryBlocked && { canWrite: false, canComment: false }),
          },
          ...(this.recoveryBlocked && { recovery: this.recoveryBlocked }),
          peerProfiles: this.profiles(),
          activity: this.activityState().snapshot(),
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
        this.cacheTitle();
        return json({ durableHeads });
      }
      if (url.pathname === "/internal/tool") {
        const body = await readJson(request);
        if (body.operation === "read_page_presence") {
          const args = body.arguments;
          if (
            !args ||
            typeof args !== "object" ||
            Array.isArray(args) ||
            args.page_id !== this.metadata.pageId ||
            Object.keys(args).some((key) => key !== "page_id")
          )
            throw new HttpError(400, "Invalid presence arguments");
          return json(this.activityState().read(this.handle.doc()));
        }
        if (["read_page", "read_page_changes", "list_page_comments"].includes(body.operation)) {
          this.cacheTitle(identity);
          const options = {
            recovery: this.recoveryBlocked,
            getPresence: (doc) => this.activityState().read(doc),
            issueAuthority: () =>
              issueRetryToken(this.ctx.storage, {
                scope: `page:${this.metadata.pageId}`,
                principal: identity.principal,
              }),
          };
          const result =
            body.operation === "read_page_changes"
              ? await readChangesTool(this.handle.doc(), body.arguments ?? {}, options)
              : await readTool(this.handle.doc(), body.operation, body.arguments ?? {}, options);
          return json(result.body, result.status);
        }
        this.policy.account(identity, true);
        if (body.operation === "report_page_progress")
          return json(this.activityState().report(this.handle.doc(), identity, body.arguments));
        if (
          !["edit_page", "patch_page", "manage_page_comment", "reply_page_comment"].includes(
            body.operation,
          )
        )
          throw new HttpError(400, "Unknown document operation");
        const images = Array.isArray(body.arguments?.operations)
          ? body.arguments.operations.filter((op) => (op?.op ?? op?.type) === "insert_image")
          : [];
        const receipt = await documentMutation({
          storage: this.ctx.storage,
          admission: this.admission,
          handle: this.handle,
          operation: body.operation,
          args: body.arguments,
          identity,
          prepare: images.length
            ? async () => {
                if (images.length > 100) throw new HttpError(400, "Provide up to 100 operations");
                for (const image of images) {
                  try {
                    validateImageInsertion(image);
                  } catch (error) {
                    throw new HttpError(400, error.message);
                  }
                }
                for (const assetId of new Set(images.map((image) => image.asset_id))) {
                  await requireStoredImageAsset(this.env.PAGES_ASSETS, {
                    pageId: this.metadata.pageId,
                    assetId,
                  });
                }
                // The Page queue orders ACL changes; OAuth/key expiry and revocation
                // can still happen while immutable object metadata is being read.
                this.policy.account(await authenticate(request, this.env), true);
              }
            : undefined,
          apply: (doc, effectiveArgs) => {
            try {
              return applyPageOperation(doc, {
                operation: body.operation,
                arguments: effectiveArgs,
                identity: publicIdentity(identity),
              });
            } catch (error) {
              throw new HttpError(400, error.message);
            }
          },
          flush: () => this.flush(),
        });
        this.cacheTitle();
        this.handle.broadcast({
          kind: "tool-edit",
          identity: publicIdentity(identity),
          heads: receipt.heads,
        });
        return json(receipt);
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (!admissionRoute) return errorResponse(error, "page");
      if ((error.status ?? 500) >= 500) logFailure(error, "page");
      return admissionErrorResponse(error, { stage: "page", identity });
    }
  }

  /** Owner or a valid viewer/editor grant on the deleted metadata. A role
   * "none" row is a deny tombstone, which an owner can create for a principal
   * who never had access, so it discloses nothing. */
  disclosesDeletion(principal) {
    if (principal === this.metadata?.owner) return true;
    const members = this.metadata?.acl?.members;
    const member = members && Object.hasOwn(members, principal) ? members[principal] : undefined;
    return (
      ["viewer", "editor"].includes(member?.role) &&
      Number.isSafeInteger(member.generation) &&
      member.generation >= 1
    );
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
        reject(
          withAdmissionReason(new HttpError(409, MISSING_EDITS_MESSAGE), "receipt_heads_missing"),
        );
      }, 10_000);
      this.handle.on("heads-changed", changed);
      changed();
    });
  }

  connect(request, identity) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      throw new HttpError(426, "WebSocket upgrade required");
    const epochs = new URL(request.url).searchParams.getAll("activity_epoch");
    if (epochs.length) {
      if (
        epochs.length !== 1 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(epochs[0])
      )
        throw new HttpError(400, "Invalid activity_epoch");
      // Discovery and native admission must refer to the same resident host.
      // Reject before allocating a socket so the browser rediscovers after a
      // restart instead of permanently rejecting the new host's snapshots.
      if (epochs[0] !== this.activityState().epoch)
        throw withAdmissionReason(
          new HttpError(409, "Page activity session changed; reconnect"),
          "activity_epoch_changed",
        );
    }
    if (this.wires.size >= 24) throw new HttpError(429, "Too many connected peers");
    const principals = [...this.wirePrincipals.values()];
    if (principals.filter((principal) => principal === identity.principal).length >= 4)
      throw new HttpError(429, "Too many connections for this account");
    if (
      identity.principal !== this.metadata.owner &&
      principals.filter((principal) => principal !== this.metadata.owner).length >= 20
    )
      throw new HttpError(429, "Member connection capacity reached");
    const pair = new WebSocketPair();
    const client = pair[0],
      socket = pair[1];
    socket.accept(); // Resident connection; reconnect reconstructs native state.
    // A transport refusal is logged once here, before the disconnect callback
    // records a generic cancellation.
    let refusal;
    const wire = new WebSocketByteTransport(socket, {
      onRefusal: (category) => {
        refusal = transportRefusal(category);
        logAdmissionDenied(refusal, { stage: "native", identity });
        admission.abort(refusal);
        return close(refusal);
      },
    });
    const disconnected = new Promise((resolve) => wire.onDisconnect(resolve));
    this.wires.add(wire);
    // HTTP authentication already established this principal. Reserve before
    // waiting on the native handshake, so idle handshakes cannot bypass quotas.
    this.wirePrincipals.set(wire, identity.principal);
    let release = noop;
    const admission = new AbortController();
    let leaseTimer;
    let expiryTimer;
    const close = (error) => wire.disconnect(admissionCloseCode(error), admissionCode(error));
    const armExpiry = (expiresAt) => {
      clearTimeout(expiryTimer);
      if (this.wires.has(wire))
        expiryTimer = setTimeout(
          () => void close(credentialExpired()),
          Math.max(1, expiresAt - Date.now()),
        );
    };
    const handshakeTimer = setTimeout(() => {
      admission.abort(admissionCancelled("native_admission_timeout"));
      void close(admission.signal.reason);
    }, 10_000);
    wire.onDisconnect(() => {
      clearTimeout(handshakeTimer);
      clearInterval(leaseTimer);
      clearTimeout(expiryTimer);
      admission.abort(admissionCancelled());
      release();
      this.wires.delete(wire);
      this.wirePrincipals.delete(wire);
      this.activity?.prune();
      this.broadcastProfiles();
    });
    this.ctx.waitUntil(
      (async () => {
        let transport;
        try {
          transport = await N.AuthenticatedTransport.accept(wire, this.signer);
        } catch (cause) {
          throw admission.signal.aborted
            ? admission.signal.reason
            : withAdmissionReason(
                Object.assign(new Error("Native handshake failed", { cause }), { status: 400 }),
                "native_handshake_failed",
              );
        }
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
            signal: admission.signal,
            waitUntil: (promise) => this.ctx.waitUntil(promise),
            reauthenticate: () => authenticate(request, this.env),
            disconnect: (error) => close(error ?? admissionCancelled()),
            onRenewal: (expiresAt) => {
              if (identity.credentialKind === "api-key") armExpiry(expiresAt);
            },
          });
          wire.onDisconnect(release);
          if (!this.wires.has(wire)) return;
          clearTimeout(handshakeTimer);
          const leaseExpiresAt = this.policy.leaseExpiresAt(identity);
          armExpiry(leaseExpiresAt);
          leaseTimer = setInterval(
            () => {
              void this.policy.active(key).catch((error) => close(error));
            },
            Math.min(15_000, Math.max(1, leaseExpiresAt - Date.now())),
          );
          wire.onDisconnect(() => {
            clearInterval(leaseTimer);
            clearTimeout(expiryTimer);
          });
          try {
            await this.backend.addConnection(transport);
          } catch (cause) {
            throw withAdmissionReason(
              Object.assign(new Error("Native connection failed", { cause }), { status: 503 }),
              "native_connection_failed",
            );
          }
          this.broadcastProfiles();
          this.broadcastActivity();
        } finally {
          transport.free();
        }
        // Native callbacks retain this request's I/O context. Keep it alive
        // while the resident socket can trigger authorization and storage work.
        await disconnected;
      })().catch((error) => {
        if (error !== refusal) logAdmissionDenied(error, { stage: "native", identity });
        if (admissionReason(error) === "server_error") logFailure(error, "native-admission");
        void close(error);
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }
}
