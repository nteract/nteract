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
import {
  DocumentAdmission,
  incompleteHistory,
  isHistoryCapacityError,
  logIncompleteHistory,
} from "./history-admission.mjs";
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
import { buildAdvertisement } from "../shared/build-identity.mjs";
import { advertiseBuild } from "./build-advertisement.mjs";

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
import { pageAccess, pageState, restrictAccessDuringCommit } from "./access.mjs";

import {
  CATALOG_LIMIT,
  TRASH_LIMIT,
  catalogTitle,
  catalogEntries,
  countCapacity,
  holdsLifecycleSlot,
  lifecycleSlot,
  lifecycleSlotKey,
  observedLifecycleRevision,
  projectLifecycle,
  pruneTombstonedTrash,
  refreshCatalogTitle,
  releaseLifecycleSlot,
  trashFields,
} from "./catalog.mjs";
import {
  CatalogIndexUnavailable,
  catalogIndexDatabase,
  catalogIndexEpoch,
  catalogIndexTimeouts,
  catalogSource,
  indexSource,
  indexedState,
  listScope,
  listingRestricted,
  markCatalogIndexDirty,
  markSpaceIndexDirty,
  openCursor,
  parseListArguments,
  placementMatches,
  reconcileSpaceIndex,
  spaceCatalogSource,
  spaceIndexSource,
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
import { generateKeyBetween } from "fractional-indexing";
import { handleImageAssets, requireStoredImageAsset } from "./image-assets.mjs";
import {
  MAX_DEPTH,
  SPACE_LIMIT,
  entryPlacement,
  homePageMarkdown,
  newSpaceId,
  pagePlacement,
  placementEntry,
  requirePageIdArgument,
  requireSpaceIdArgument,
  spaceNotFound,
  validatePlacement,
  validateSpaceInput,
} from "./spaces.mjs";
export { Space } from "./spaces.mjs";
import { spaceCreationEffect, spaceCreationTransition } from "./space-lifecycle.mjs";
import { handleImportPageImage } from "./import-image.mjs";
import { readTool } from "./tool-reads.mjs";
import { readChangesTool } from "./tool-changes.mjs";
import { PageActivity } from "./page-activity.mjs";
import {
  issuePurgePreview,
  publicTrash,
  purgeImpact,
  trashRecord,
  verifyPurgePreview,
} from "./trash.mjs";

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
  "restore_page",
  "purge_page",
  "create_space",
  "list_spaces",
  "get_space",
  "update_space",
]);
/** Space operations. Each goes through the caller's own Catalog, which calls
 * the Space with the caller's credentials. */
const spaceOperations = ["create_space", "list_spaces", "get_space", "update_space"];
/** Catalog-owned Page lifecycle operations and the Page route each one uses. */
const lifecycleRoutes = {
  delete_page: "/internal/trash",
  restore_page: "/internal/restore",
  purge_page: "/internal/purge",
};
/** delete_page moves a Page to Trash. Its journal fingerprint uses a distinct
 * name so a build that predates Trash cannot replay the receipt as a
 * permanent deletion: it reports an idempotency conflict instead.
 */
const lifecycleFingerprint = {
  delete_page: "trash_page",
  restore_page: "restore_page",
  purge_page: "purge_page",
};
const noop = async () => {};
/** A home Page sits first at its Space's top level. */
const homePlacement = (spaceId) => ({
  space_id: spaceId,
  parent_id: null,
  position: "a0",
  placement_epoch: 0,
  home: true,
});
const INDEX_REPORT_PENDING = "host/index/report-pending";
/** Lifecycle receipts kept per Page for retries; older ones are pruned. */
const LIFECYCLE_RECEIPT_LIMIT = 256;
const lifecycleReceiptKey = (operationKey) =>
  `host/lifecycle/${operationKey.slice("host/operation/".length)}`;
const sameHeads = (left, right) =>
  left.length === right.length && [...left].sort().join() === [...right].sort().join();
const publicIdentity = ({ principal, displayName, driver }) => ({ principal, displayName, driver });
/** Lifecycle arguments as the caller sent them. The Catalog alone sets the
 * compare-and-set and placement controls it forwards to a Page. */
const callerLifecycleArguments = ({
  expected_revision: _expected,
  replay_only: _replay,
  restore_position: _position,
  placement: _placement,
  ...requested
}) => requested;

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

const ANONYMOUS_MCP_METHODS = new Set(["tools/list", "ping"]);
const ANONYMOUS_MCP_BYTES = 4096;

/** True for a credential-free POST carrying one tools/list or ping message.
 * Any presented credential, bearer or cookie, takes the authenticated path so
 * a failing one still gets its challenge. `initialize` stays behind the 401:
 * MCP clients start OAuth from it. Only a declared small body is read. */
async function anonymousToolList(request) {
  if (
    request.method !== "POST" ||
    request.headers.has("authorization") ||
    request.headers.has("cookie")
  )
    return false;
  const declared = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > ANONYMOUS_MCP_BYTES)
    return false;
  const reader = request.clone().body?.getReader();
  if (!reader) return false;
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ANONYMOUS_MCP_BYTES) {
      // A cloned body is a tee branch: its cancel settles only when the other
      // branch is also cancelled, so don't wait on it.
      reader.cancel().catch(() => {});
      return false;
    }
    chunks.push(value);
  }
  try {
    const message = JSON.parse(new TextDecoder().decode(concatBytes(chunks, size)));
    return message?.jsonrpc === "2.0" && ANONYMOUS_MCP_METHODS.has(message.method);
  } catch {
    return false;
  }
}

function concatBytes(chunks, size) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
      "list_spaces",
      "get_space",
    ].includes(operation)
  )
    requireWrite(identity);
  if (["get_space", "update_space"].includes(operation)) requireSpaceIdArgument(args.space_id);
  if (
    ["list_pages", "create_page", ...Object.keys(lifecycleRoutes), ...spaceOperations].includes(
      operation,
    )
  ) {
    return env.CATALOGS.getByName(identity.principal).fetch(
      forwarded(request, "/internal/catalog", { operation, arguments: args }),
    );
  }
  requirePageIdArgument(args.page_id);
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
  const response = await env.PAGES.getByName(args.page_id).fetch(
    forwarded(request, "/internal/tool", { operation, arguments: args }),
  );
  if (operation !== "read_page" || !response.ok) return response;
  const body = await response.json();
  await placementView(request, env, body);
  return json(body, response.status);
}

/**
 * Replace a read_page result's private placement with what the caller can
 * see. Each ancestor and the Space answer with the caller's own credentials,
 * so a breadcrumb or ID appears only when the caller could open it: the walk
 * stops at the first Page the caller cannot read, and space_id appears only
 * when the Space is readable. Direct access to a Page never reveals its Space.
 * This runs in the stateless gateway, so a Page never calls another object.
 */
async function placementView(request, env, body) {
  const placement = body._placement;
  delete body._placement;
  body.kind = "page";
  body.breadcrumbs = [];
  // Top-level Pages in Your items.
  if (!placement?.space_id && !placement?.parent_id) {
    body.space_id = null;
    body.parent_id = null;
    return;
  }
  const readable = async (stub, path, payload) => {
    try {
      const response = await withTimeout(
        stub.fetch(forwarded(request, path, payload)),
        catalogIndexTimeouts.verify,
      );
      return response.ok ? await response.json() : null;
    } catch (error) {
      logFailure(error, "breadcrumbs");
      return null;
    }
  };
  const chain = [];
  const seen = new Set([body.page_id]);
  let next = placement.parent_id;
  while (next && chain.length < MAX_DEPTH && !seen.has(next)) {
    seen.add(next);
    const parent = await readable(env.PAGES.getByName(next), "/internal/catalog", {});
    if (!parent || (parent.state && parent.state !== "active")) break;
    chain.unshift({ kind: "page", page_id: next, title: catalogTitle(parent.title) });
    next = parent.parent_id ?? null;
  }
  if (placement.parent_id && chain.at(-1)?.page_id === placement.parent_id)
    body.parent_id = placement.parent_id;
  const space = placement.space_id
    ? await readable(env.SPACES.getByName(placement.space_id), "/internal/space/read", {
        space_id: placement.space_id,
      })
    : null;
  if (space) {
    body.space_id = placement.space_id;
    if (!placement.parent_id) body.parent_id = null;
    if (placement.home) body.home = true;
    // The whole chain is visible to whoever can read the Space in this build.
    if (!next) chain.unshift({ kind: "space", space_id: space.space_id, title: space.title });
  }
  body.breadcrumbs = chain;
}

export default {
  async fetch(request, env) {
    return advertiseBuild(request, await gateway.fetch(request, env));
  },
};

const gateway = {
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
      if (url.pathname === "/health")
        return json({ ok: true, prototype: "pages-celld-native", ...buildAdvertisement() });
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
        requireSameOrigin(request, env);
        if (await anonymousToolList(request)) {
          // Tool definitions are static and carry no account data. Every other
          // method needs a credential.
          return await handleMcp(
            request,
            async () => {
              throw new HttpError(401, "Sign in to call Pages tools");
            },
            env,
          );
        }
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
  async countEntries(prefix) {
    return countCapacity(this.ctx.storage, prefix, {
      current: (pageId) => this.pageLifecycle(pageId),
    });
  }
  /** Read a Page's current lifecycle state. The Catalog may call its Pages;
   * a Page never calls its owner's Catalog.
   */
  async pageLifecycle(pageId) {
    const response = await this.env.PAGES.getByName(pageId).fetch(
      new Request("https://pages.internal/internal/lifecycle-state"),
    );
    if (!response.ok) throw Error(`Page lifecycle state unavailable: ${response.status}`);
    return response.json();
  }
  /** Tell a trashed Page that this account recorded its permanent deletion. */
  async notifyTombstone(pageId) {
    try {
      await this.env.PAGES.getByName(pageId).fetch(
        new Request("https://pages.internal/internal/tombstone", { method: "POST" }),
      );
    } catch (error) {
      logFailure(error, "catalog-tombstone");
    }
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
          // A projection observed before trashing must not relist the Page.
          (value.shared || !(await this.ctx.storage.get(`trash/${value.page_id}`))) &&
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
      if (body.operation === "list_spaces") return await this.listSpaces(request, identity, args);
      if (body.operation === "get_space") return await this.getSpace(request, args);
      requireWrite(identity);
      if (body.operation === "create_space") return await this.createSpace(request, identity, args);
      if (body.operation === "update_space") return await this.updateSpace(request, identity, args);
      const lifecycle = lifecycleRoutes[body.operation];
      if (!["create_page", "register_page"].includes(body.operation) && !lifecycle)
        throw new HttpError(400, "Unknown catalog operation");
      // Reject deterministic input errors before reserving an intent or page.
      const creating = ["create_page", "register_page"].includes(body.operation);
      const registering = body.operation === "register_page";
      if (
        lifecycle &&
        args.expected_principal !== undefined &&
        args.expected_principal !== identity.principal
      )
        throw new HttpError(403, "Sign in with this Page's original account to change it");
      if (lifecycle) requirePageIdArgument(args.page_id);
      const tombstoned = async () => {
        if (!(await this.ctx.storage.get(`host/deleted/${args.page_id}`))) return false;
        await this.ctx.storage.delete(`trash/${args.page_id}`);
        await this.notifyTombstone(args.page_id);
        return true;
      };
      if (body.operation === "purge_page") {
        if (!["preview", "confirm"].includes(args.action))
          throw new HttpError(400, "action must be preview or confirm");
        if (args.action === "preview" && (await tombstoned()))
          throw new HttpError(404, "Page not found");
        // A preview is an owner read of the trashed Page; it reserves nothing.
        if (args.action === "preview")
          return this.env.PAGES.getByName(args.page_id).fetch(forwarded(request, lifecycle, args));
        if (typeof args.preview_token !== "string")
          throw new HttpError(
            400,
            "Call purge_page with action preview, then confirm with its unchanged preview_token",
            "purge_preview_required",
          );
      }
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
      const digest = await fingerprint(
        lifecycleFingerprint[body.operation] ?? body.operation,
        args,
        identity,
      );
      const inspected = await inspectOperation(this.ctx.storage, {
        key,
        digest,
        retryToken: args.retry_token,
        scope: `catalog:${identity.principal}`,
        principal: identity.principal,
      });
      let intent = inspected.entry;
      if (intent && !intent.pending) {
        // A previous attempt may have stored its receipt before sync failed.
        // Only terminal deletion is reapplied: replaying an old trash or
        // restore receipt must not undo a later transition.
        if (intent.receipt?.deleted)
          await projectLifecycle(this.ctx.storage, intent.pageId, { state: "deleted" });
        await this.ctx.storage.sync();
        return json(intent.receipt);
      }
      if (!intent) {
        // A permanent deletion this account observed is terminal, even when a
        // build without Trash wrote the tombstone. The Catalog refuses here,
        // so a Page never has to ask its owner's Catalog.
        if (lifecycle && (await tombstoned())) throw new HttpError(404, "Page not found");
        if (creating && (await this.countEntries("page/")) >= CATALOG_LIMIT)
          throw new HttpError(409, "This prototype permits 100 pages per account");
        if (body.operation === "delete_page") await this.requireLeafPage(args.page_id);
        if (
          body.operation === "delete_page" &&
          // Counting first removes stale reservations, including this Page's.
          (await this.countEntries("trash/")) >= TRASH_LIMIT &&
          !(await this.ctx.storage.get(`trash/${args.page_id}`))
        )
          throw new HttpError(
            409,
            "Trash is full. Permanently delete Pages from Trash before moving more Pages there.",
            "trash_capacity",
          );
        if (
          body.operation === "restore_page" &&
          (await this.countEntries("page/")) >= CATALOG_LIMIT &&
          !(await this.ctx.storage.get(`page/${args.page_id}`))
        )
          throw new HttpError(409, "This prototype permits 100 pages per account");
        if (
          registering &&
          ((await this.ctx.storage.get(`page/${args.page_id}`)) ||
            (await this.ctx.storage.get(`trash/${args.page_id}`)))
        )
          throw new HttpError(409, "Page already has another creation request");
        const placement =
          body.operation === "create_page" ? await this.resolvePlacement(request, args) : undefined;
        intent = {
          fingerprint: digest,
          pending: true,
          pageId: body.operation === "create_page" ? crypto.randomUUID() : args.page_id,
          createdAt: new Date().toISOString(),
          // The Page applies a lifecycle request only at this revision.
          ...(lifecycle && {
            expectedRevision: await observedLifecycleRevision(this.ctx.storage, args.page_id),
          }),
          ...(placement && { placement }),
        };
        intent = await reserveOperation(this.ctx.storage, {
          key,
          entry: intent,
          retry: inspected.retry,
        });
        // The capacity check above holds while the slot stays reserved. The
        // intent and its slot commit in one write.
        const slotKey = lifecycleSlotKey(body.operation, intent.pageId);
        if (slotKey && !(await this.ctx.storage.get(slotKey)))
          await this.ctx.storage.put({
            [key]: intent,
            ...lifecycleSlot(
              body.operation,
              intent.pageId,
              key,
              undefined,
              await this.slotPlacement(body.operation, intent.pageId),
            ),
          });
        else await this.ctx.storage.put(key, intent);
      }
      const pageId = intent.pageId;
      if (creating) {
        // A resumed creation checks its parent again: the parent may have
        // moved to Trash since the intent was reserved. The intent stays
        // pending; restoring the parent and retrying finishes it.
        if (inspected.entry && intent.placement?.parent_id)
          await this.activeParent(intent.placement.parent_id);
        await this.ctx.storage.put(`page/${pageId}`, {
          page_id: pageId,
          title: catalogTitle(args.title),
          created_at: intent.createdAt,
          updated_at: intent.createdAt,
          pending: true,
          ...placementEntry(intent.placement),
        });
        // Placement comes only from the resolved intent, never the caller.
        const { placement: _placement, ...requested } = args;
        const response = await this.env.PAGES.getByName(pageId).fetch(
          forwarded(request, registering ? "/internal/register" : "/internal/create", {
            ...requested,
            page_id: pageId,
            ...(intent.placement && { placement: intent.placement }),
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
          ...placementEntry(intent.placement),
        });
        await markCatalogIndexDirty(this.ctx.storage);
      } else {
        // A resumed request checks the tombstone too; the Page then answers
        // as permanently deleted and this intent completes as deleted.
        if (inspected.entry) await tombstoned();
        // A resumed request that lost its slot may not apply: it only replays
        // what the Page already did, unless capacity is still available.
        let replayOnly = false;
        if (!(await holdsLifecycleSlot(this.ctx.storage, body.operation, pageId, key))) {
          const limit = body.operation === "delete_page" ? TRASH_LIMIT : CATALOG_LIMIT;
          const prefix = body.operation === "delete_page" ? "trash/" : "page/";
          if ((await this.countEntries(prefix)) < limit)
            await this.ctx.storage.put(
              lifecycleSlot(
                body.operation,
                pageId,
                key,
                undefined,
                await this.slotPlacement(body.operation, pageId),
              ),
            );
          else replayOnly = true;
        }
        const fresh = !inspected.entry;
        // Once forwarded, the Page may apply the request, so its slot can no
        // longer simply expire. The output gate holds the Page request until
        // this write is durable.
        if (!intent.forwarded) {
          intent.forwarded = true;
          await this.ctx.storage.put(key, intent);
        }
        for (let attempt = 0; ; attempt++) {
          const requested = callerLifecycleArguments(args);
          const restorePosition =
            body.operation === "restore_page" ? await this.restorePosition(pageId) : undefined;
          const response = await this.env.PAGES.getByName(pageId).fetch(
            forwarded(request, lifecycle, {
              ...requested,
              page_id: pageId,
              ...(intent.expectedRevision !== undefined && {
                expected_revision: intent.expectedRevision,
              }),
              ...(replayOnly && { replay_only: true }),
              ...(restorePosition && { restore_position: restorePosition }),
            }),
          );
          if (response.headers.get("x-pages-lifecycle-rejected") === "before-change") {
            await releaseLifecycleSlot(this.ctx.storage, body.operation, pageId, key);
            await this.ctx.storage.delete(key);
            await this.ctx.storage.sync();
            return response;
          }
          // A missing Page is already permanently absent; clean up this
          // account's stale index and report that terminal outcome.
          if (!response.ok && response.status !== 404) return response;
          const outcome = response.ok
            ? await response.json()
            : { receipt: { page_id: pageId, deleted: true }, current: { state: "deleted" } };
          // A replayed receipt may be older than the Page's current state.
          await projectLifecycle(this.ctx.storage, pageId, outcome.current);
          // This index was stale when a new request was reserved. The Page has
          // never seen this key, so retarget it once at the current revision.
          if (outcome.receipt.superseded && fresh && !replayOnly && attempt === 0) {
            intent.expectedRevision = outcome.current.revision;
            await this.ctx.storage.put(key, intent);
            continue;
          }
          intent.receipt = outcome.receipt;
          break;
        }
      }
      intent.pending = false;
      await this.ctx.storage.put(key, intent);
      await this.ctx.storage.sync();
      return json(intent.receipt);
    } catch (error) {
      return errorResponse(error, "catalog");
    }
  }

  /** Placement for a new Page from create_page's space_id and parent_id.
   * A parent implies its Space; naming a different Space is an error. Only
   * Pages and Spaces this account owns can hold new Pages in this build, so
   * this account's own entries settle parent, depth and sibling order, and
   * the Space record confirms the Space.
   */
  async resolvePlacement(request, args) {
    const storage = this.ctx.storage;
    const spaceArg =
      args.space_id === undefined || args.space_id === null
        ? null
        : requireSpaceIdArgument(args.space_id);
    const parentId =
      args.parent_id === undefined || args.parent_id === null
        ? null
        : requirePageIdArgument(args.parent_id, "parent_id");
    if (!spaceArg && !parentId) return undefined;
    let spaceId = spaceArg;
    if (parentId) {
      const parent = await this.activeParent(parentId);
      const placement = entryPlacement(parent);
      if (spaceArg && placement.space_id !== spaceArg)
        throw new HttpError(
          400,
          "parent_id is not in that Space. Omit space_id: a parent implies its Space.",
          "placement_mismatch",
        );
      spaceId = placement.space_id;
      // A top-level Page is at depth 1; the new Page sits one below its parent.
      let depth = 2;
      for (let cursor = placement.parent_id; cursor; depth++) {
        if (depth > MAX_DEPTH) break;
        const ancestor =
          (await storage.get(`page/${cursor}`)) ?? (await storage.get(`trash/${cursor}`));
        cursor = ancestor ? entryPlacement(ancestor).parent_id : null;
      }
      if (depth > MAX_DEPTH)
        throw new HttpError(
          400,
          `Pages nest at most ${MAX_DEPTH} levels deep`,
          "nesting_depth_exceeded",
        );
    }
    if (spaceId) {
      const entry = await storage.get(`space/${spaceId}`);
      if (!entry || entry.pending) throw spaceNotFound();
      const response = await this.env.SPACES.getByName(spaceId).fetch(
        forwarded(request, "/internal/space/read", { space_id: spaceId }),
      );
      if (response.status === 404) throw spaceNotFound();
      if (!response.ok) throw new HttpError(503, "Space is temporarily unavailable");
    }
    return {
      space_id: spaceId,
      parent_id: parentId,
      position: await this.nextPosition(spaceId, parentId),
      placement_epoch: 0,
    };
  }

  /** The parent's Catalog entry when it can take a new child: owned, created
   * and not in Trash. A trash slot (even one still being reserved) counts as
   * Trash, so a child is never created under a Page that is leaving. */
  async activeParent(parentId) {
    const storage = this.ctx.storage;
    if (await storage.get(`trash/${parentId}`))
      throw new HttpError(
        409,
        "The parent Page is in Trash; restore it before adding Pages under it",
        "parent_unavailable",
      );
    const parent = await storage.get(`page/${parentId}`);
    if (!parent || parent.pending || parent.reservation)
      throw new HttpError(
        404,
        "Parent Page not found. In this build, only Pages you own can have sub-pages.",
        "parent_unavailable",
      );
    return parent;
  }

  /** A position after every current sibling. */
  async nextPosition(spaceId, parentId) {
    let last = null;
    for (const entry of (await catalogEntries(this.ctx.storage, "page/")).values()) {
      const placement = entryPlacement(entry);
      if (
        placement.space_id === spaceId &&
        placement.parent_id === parentId &&
        typeof placement.position === "string" &&
        (last === null || placement.position > last)
      )
        last = placement.position;
    }
    try {
      return generateKeyBetween(last, null);
    } catch {
      return generateKeyBetween(null, null);
    }
  }

  /** Trash moves one Page at a time in this build. A Page with active
   * children, or children still being created, stays put until they move,
   * so no Page is ever active under a trashed parent. A Space's home Page
   * stays with its Space. Both checks run before anything is reserved.
   *
   * A child with an unsettled Trash or restore reservation is settled against
   * its Page first: a lost response can hide a transition that already
   * applied. A restore reservation counts through the parent it records. One
   * still unapplied afterwards is not a child: once this Page is in Trash,
   * that restore returns to the top level. */
  async requireLeafPage(pageId) {
    const storage = this.ctx.storage;
    const entry = await storage.get(`page/${pageId}`);
    if (!entry) return;
    if (entryPlacement(entry).home)
      throw new HttpError(
        409,
        "A Space's home Page stays with its Space; it can't move to Trash on its own",
        "home_page_protected",
      );
    for (let child of (await storage.list({ prefix: "page/", limit: 1000 })).values()) {
      if (!child?.page_id || child.page_id === pageId) continue;
      const trashed = await storage.get(`trash/${child.page_id}`);
      const parent =
        entryPlacement(child).parent_id ??
        (child.reservation && trashed ? entryPlacement(trashed).parent_id : null);
      if (parent !== pageId) continue;
      if (child.reservation || trashed?.reservation) {
        await this.settleReservation(child.page_id);
        child = await storage.get(`page/${child.page_id}`);
      }
      if (child && !child.reservation)
        throw new HttpError(
          409,
          "This Page has sub-pages. Trash its sub-pages first; subtree Trash is not available yet.",
          "page_has_children",
        );
    }
  }

  /** Reconcile a Page's pending Trash or restore reservation with the Page,
   * the authority for its lifecycle. A transition the Page already applied is
   * projected into this account's entries; an unapplied one keeps its
   * reservation, since its intent may still apply on retry. A reservation
   * whose intent is no longer pending is stale and removed. When the Page
   * can't answer, the caller is refused rather than left to guess. */
  async settleReservation(pageId) {
    const storage = this.ctx.storage;
    for (const key of [`page/${pageId}`, `trash/${pageId}`]) {
      const entry = await storage.get(key);
      if (!entry?.reservation) continue;
      const intent = await storage.get(entry.intent);
      if (intent?.pending !== true) {
        await storage.delete(key);
        continue;
      }
      let state;
      try {
        state = await this.pageLifecycle(pageId);
      } catch (error) {
        logFailure(error, "lifecycle-state");
        throw new HttpError(
          409,
          "A Page's Trash or restore is still settling. Retry shortly.",
          "lifecycle_unsettled",
        );
      }
      if (state.state === "missing") await projectLifecycle(storage, pageId, { state: "deleted" });
      else if ((state.revision ?? 0) !== intent.expectedRevision)
        await projectLifecycle(storage, pageId, state);
    }
  }

  /** Where a pending restore returns its Page: the Space and parent its
   * Trash entry records. */
  async slotPlacement(operation, pageId) {
    if (operation !== "restore_page") return undefined;
    const entry = await this.ctx.storage.get(`trash/${pageId}`);
    return entry && !entry.reservation ? entryPlacement(entry) : undefined;
  }

  /** Whether a parent is active and staying so. Any Trash entry, or a live
   * Trash reservation, makes it unavailable: a pending trash may still apply
   * on retry even when the Page has not applied it yet. A reservation is
   * settled first so an applied trash is projected. */
  async parentAvailable(parentId) {
    const storage = this.ctx.storage;
    if ((await storage.get(`trash/${parentId}`))?.reservation)
      await this.settleReservation(parentId);
    if (await storage.get(`trash/${parentId}`)) return false;
    const parent = await storage.get(`page/${parentId}`);
    return !!parent && !parent.pending && !parent.reservation;
  }

  /** Where a restored Page goes when its parent is in Trash, leaving it, or
   * gone: the top level of its Space, or of Your items. Undefined keeps its
   * place. */
  async restorePosition(pageId) {
    const entry = await this.ctx.storage.get(`trash/${pageId}`);
    const placement = entry && !entry.reservation && entryPlacement(entry);
    if (!placement?.parent_id) return undefined;
    if (await this.parentAvailable(placement.parent_id)) return undefined;
    return this.nextPosition(placement.space_id, null);
  }

  async createSpace(request, identity, args) {
    const storage = this.ctx.storage;
    const { title, description } = validateSpaceInput(args, { creating: true });
    const key = mutationKey(args);
    const digest = await fingerprint("create_space", args, identity);
    const inspected = await inspectOperation(storage, {
      key,
      digest,
      retryToken: args.retry_token,
      scope: `catalog:${identity.principal}`,
      principal: identity.principal,
    });
    let intent = inspected.entry;
    if (intent && !intent.pending) {
      await storage.sync();
      return json(intent.receipt);
    }
    if (!intent) {
      const spaces = await storage.list({ prefix: "space/", limit: SPACE_LIMIT + 1 });
      if (spaces.size >= SPACE_LIMIT)
        throw new HttpError(
          409,
          `This prototype permits ${SPACE_LIMIT} Spaces per account`,
          "space_capacity",
        );
      if ((await this.countEntries("page/")) >= CATALOG_LIMIT)
        throw new HttpError(409, "This prototype permits 100 pages per account");
      const createdAt = new Date().toISOString();
      intent = await reserveOperation(storage, {
        key,
        retry: inspected.retry,
        entry: {
          fingerprint: digest,
          pending: true,
          spaceId: newSpaceId(),
          pageId: crypto.randomUUID(),
          phase: "reserved",
          createdAt,
          title,
          description: description ?? "",
        },
      });
      // The intent, the Space entry and the home Page's quota slot commit
      // together. A crash after this resumes from the same IDs on retry.
      await storage.put({
        [key]: intent,
        [`space/${intent.spaceId}`]: {
          space_id: intent.spaceId,
          title,
          description: intent.description,
          home_page_id: intent.pageId,
          created_at: createdAt,
          updated_at: createdAt,
          pending: true,
        },
        [`page/${intent.pageId}`]: {
          page_id: intent.pageId,
          title: catalogTitle(title),
          created_at: createdAt,
          updated_at: createdAt,
          pending: true,
          ...placementEntry(homePlacement(intent.spaceId)),
        },
      });
    }
    return this.completeSpaceCreation(request, key, intent);
  }

  /** Run the creation lifecycle from its persisted state. Each effect is
   * idempotent; its outcome is persisted with the next state before the
   * following effect starts, so a retry resumes where the last one stopped. */
  async completeSpaceCreation(request, key, intent) {
    const storage = this.ctx.storage;
    intent.phase ??= "reserved";
    for (let effect = spaceCreationEffect(intent.phase); effect; ) {
      let event;
      if (effect === "create_space_record") {
        const response = await this.env.SPACES.getByName(intent.spaceId).fetch(
          forwarded(request, "/internal/space/create", {
            space_id: intent.spaceId,
            title: intent.title,
            description: intent.description,
            home_page_id: intent.pageId,
          }),
        );
        if (!response.ok) return response;
        intent.space = await response.json();
        event = "space_recorded";
      } else if (effect === "create_home_page") {
        const response = await this.env.PAGES.getByName(intent.pageId).fetch(
          forwarded(request, "/internal/create", {
            page_id: intent.pageId,
            title: intent.title,
            markdown: homePageMarkdown(intent.description),
            placement: homePlacement(intent.spaceId),
          }),
        );
        if (!response.ok) return response;
        intent.homeTitle = (await response.json()).title;
        event = "home_created";
      } else {
        const space = intent.space;
        intent.receipt = { ...space, home_page_title: intent.homeTitle };
        await storage.put({
          [`space/${intent.spaceId}`]: {
            space_id: intent.spaceId,
            title: space.title,
            description: space.description,
            home_page_id: intent.pageId,
            created_at: space.created_at,
            updated_at: space.updated_at,
          },
          [`page/${intent.pageId}`]: {
            page_id: intent.pageId,
            title: catalogTitle(intent.homeTitle),
            created_at: intent.createdAt,
            updated_at: intent.createdAt,
            ...placementEntry(homePlacement(intent.spaceId)),
          },
        });
        await markCatalogIndexDirty(storage);
        await markSpaceIndexDirty(storage);
        intent.pending = false;
        event = "committed";
      }
      ({ state: intent.phase, effect } = spaceCreationTransition(intent.phase, event));
      await storage.put(key, intent);
    }
    await storage.sync();
    return json(intent.receipt);
  }

  async updateSpace(request, identity, args) {
    const storage = this.ctx.storage;
    validateSpaceInput(args, { creating: false });
    const key = mutationKey(args);
    const digest = await fingerprint("update_space", args, identity);
    const inspected = await inspectOperation(storage, {
      key,
      digest,
      retryToken: args.retry_token,
      scope: `catalog:${identity.principal}`,
      principal: identity.principal,
    });
    let intent = inspected.entry;
    if (intent && !intent.pending) {
      await storage.sync();
      return json(intent.receipt);
    }
    // The intent records its revision fence before the Space sees the
    // request. Every attempt carries that fence, so once the Space moves past
    // it the request can never apply again, even after the Space has evicted
    // this key's receipt.
    if (!intent) {
      intent = await reserveOperation(storage, {
        key,
        retry: inspected.retry,
        entry: {
          fingerprint: digest,
          pending: true,
          spaceId: args.space_id,
          expectedRevision: args.expected_revision,
        },
      });
      await storage.put(key, intent);
    }
    const response = await this.env.SPACES.getByName(intent.spaceId).fetch(
      forwarded(request, "/internal/space/update", {
        space_id: intent.spaceId,
        idempotency_key: args.idempotency_key,
        expected_revision: intent.expectedRevision,
        ...(args.title !== undefined && { title: args.title }),
        ...(args.description !== undefined && { description: args.description }),
      }),
    );
    if (response.status >= 400 && response.status < 500) {
      const failure = await response.json();
      // A retry past its fence may already have applied before its receipt
      // was evicted, or lost to a newer change. Either way it must not apply
      // now; the outcome is the Space as it is.
      if (inspected.entry && failure.code === "space_revision_conflict") {
        const current = await this.env.SPACES.getByName(intent.spaceId).fetch(
          forwarded(request, "/internal/space/read", { space_id: intent.spaceId }),
        );
        if (!current.ok) return current;
        intent.receipt = { superseded: true, applied: false, space: await current.json() };
        intent.pending = false;
        await storage.put(key, intent);
        await storage.sync();
        return json(intent.receipt);
      }
      // Otherwise the Space rejected input, access or a stale fence before
      // changing anything; the key is free for a corrected request.
      await storage.delete(key);
      await storage.sync();
      return json(failure, response.status);
    }
    if (!response.ok) return response;
    intent.receipt = await response.json();
    const entry = await storage.get(`space/${intent.spaceId}`);
    if (entry && !entry.pending && entry.updated_at <= intent.receipt.updated_at) {
      await storage.put(`space/${intent.spaceId}`, {
        ...entry,
        title: intent.receipt.title,
        description: intent.receipt.description,
        updated_at: intent.receipt.updated_at,
      });
      await markSpaceIndexDirty(storage);
    }
    intent.pending = false;
    await storage.put(key, intent);
    await storage.sync();
    return json(intent.receipt);
  }

  /** The Space record answers with the caller's credentials. This account's
   * own entry only says whether its creation finished. */
  async getSpace(request, args) {
    const spaceId = requireSpaceIdArgument(args.space_id);
    if (Object.keys(args).some((name) => name !== "space_id"))
      throw new HttpError(400, "get_space takes only space_id");
    const entry = await this.ctx.storage.get(`space/${spaceId}`);
    if (entry?.pending)
      throw new HttpError(
        409,
        "This Space is still being created. Retry create_space with the same idempotency_key and payload.",
        "space_pending",
      );
    const response = await this.env.SPACES.getByName(spaceId).fetch(
      forwarded(request, "/internal/space/read", { space_id: spaceId }),
    );
    if (!response.ok) return response;
    const space = await response.json();
    if (entry && entry.updated_at < space.updated_at) {
      await this.ctx.storage.put(`space/${spaceId}`, {
        ...entry,
        title: space.title,
        description: space.description,
        updated_at: space.updated_at,
      });
      await markSpaceIndexDirty(this.ctx.storage);
    }
    return json(space);
  }

  /** Spaces this account owns, newest change first. D1 rows choose
   * candidates; each must match this account's own `space/` entry, which
   * supplies what is returned. */
  async listSpaces(request, identity, args) {
    const storage = this.ctx.storage;
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new HttpError(400, "Invalid list arguments", "invalid_list_arguments");
    let limit = 50;
    if (args.limit !== undefined) {
      if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100)
        throw new HttpError(
          400,
          "limit must be an integer from 1 to 100",
          "invalid_list_arguments",
        );
      limit = args.limit;
    }
    if (args.cursor !== undefined && args.cursor !== null && typeof args.cursor !== "string")
      throw new HttpError(400, "Invalid cursor; restart from the first page", "invalid_cursor");
    const context = {
      principal: identity.principal,
      needle: null,
      inTrash: false,
      scope: "spaces",
    };
    const after = args.cursor ? await openCursor(this.env, context, args.cursor) : null;
    let source;
    const epoch = catalogIndexEpoch(this.env);
    if (epoch) {
      try {
        const db = await withTimeout(catalogIndexDatabase(this.env), catalogIndexTimeouts.read);
        await reconcileSpaceIndex({ db, storage, principal: identity.principal, epoch });
        source = spaceIndexSource(db, { principal: identity.principal });
      } catch (error) {
        logFailure(error, "catalog-index");
      }
    }
    const scan = async (candidates) => {
      const spaces = [];
      let position = after;
      // Stale candidates are skipped; an account has at most SPACE_LIMIT.
      for (let scanned = 0; scanned < SPACE_LIMIT * 4; ) {
        const want = limit + 1 - spaces.length;
        const rows = await candidates.next(position, want);
        scanned += rows.length;
        for (const row of rows) {
          const entry = await storage.get(`space/${row.page_id}`);
          if (!entry || entry.pending) continue;
          spaces.push({
            row,
            space: {
              space_id: entry.space_id,
              title: entry.title,
              description: entry.description ?? "",
              home_page_id: entry.home_page_id,
              created_at: entry.created_at,
              updated_at: entry.updated_at,
            },
          });
        }
        if (rows.length) position = rows.at(-1);
        if (spaces.length > limit || rows.length < want) return spaces;
      }
      return spaces;
    };
    let found;
    if (source) {
      try {
        found = await scan(source);
      } catch (error) {
        if (!(error instanceof CatalogIndexUnavailable)) throw error;
        logFailure(error, "catalog-index");
      }
    }
    found ??= await scan(await spaceCatalogSource(storage));
    const more = found.length > limit;
    return json({
      spaces: found.slice(0, limit).map(({ space }) => space),
      limit,
      next_cursor: more ? await sealCursor(this.env, context, found[limit - 1].row) : null,
      ...(await issueRetryToken(storage, {
        scope: `catalog:${identity.principal}`,
        principal: identity.principal,
      })),
    });
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
    if (options.inTrash) await pruneTombstonedTrash(storage);
    if (options.spaceId) {
      // Only the owner can see a Space in this build, and the owner's own
      // entry records it. A Space the caller can't see looks missing.
      const space = await storage.get(`space/${options.spaceId}`);
      if (!space || space.pending) throw spaceNotFound();
    }
    if (typeof options.parentId === "string") {
      const parent = await storage.get(`page/${options.parentId}`);
      if (parent && !parent.pending && !parent.reservation) {
        if (options.spaceId && entryPlacement(parent).space_id !== options.spaceId)
          throw new HttpError(400, "parent_id is not in that Space", "placement_mismatch");
      } else {
        // Children of a Page shared with this account: the caller must be
        // able to read the parent before learning what sits under it.
        const shared = await this.verifyShared(request, options.parentId);
        if (shared.status === "unavailable")
          throw new HttpError(503, "Shared Pages are temporarily unavailable");
        if (shared.status !== "ok" || (shared.page.state && shared.page.state !== "active"))
          throw new HttpError(404, "Parent Page not found", "parent_unavailable");
      }
    }
    const context = {
      principal: identity.principal,
      needle: options.needle,
      inTrash: options.inTrash,
      scope: listScope(options),
    };
    // Every item is a Page today; other kinds list nothing until they exist.
    if (options.kind && options.kind !== "page")
      return json({
        pages: [],
        limit: options.limit,
        next_cursor: null,
        ...(await issueRetryToken(storage, {
          scope: `catalog:${identity.principal}`,
          principal: identity.principal,
        })),
      });
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
            spaceId: options.spaceId,
            parentId: options.parentId,
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
            // Index rows carry the access row's time; a newer write survives.
            ...(row.revision !== undefined && { updated_at: row.updated_at }),
          });
        }
        if (!entry || entry.pending) return null;
        const title = catalogTitle(entry.title);
        if (!titleMatches(title, options.needle)) return null;
        // This entry copied the Page's placement; D1's copy only chose it.
        const placement = entryPlacement(entry);
        if (!placementMatches(placement, options)) return null;
        return {
          page_id: row.page_id,
          title,
          created_at: entry.created_at ?? row.created_at,
          updated_at: row.updated_at,
          ...(entry.trashed_at ? { trashed_at: entry.trashed_at } : {}),
          ...(options.inTrash && trashFields({ ...entry, page_id: row.page_id })),
          // Top-level Pages in Your items keep the original row shape.
          ...((placement.space_id || placement.parent_id) && {
            space_id: placement.space_id,
            parent_id: placement.parent_id,
            position: placement.position,
            ...(placement.home && { home: true }),
          }),
        };
      }
      // Pages in a Space belong to its owner in this build.
      if (options.inTrash || options.spaceId) return null;
      const result = await this.verifyShared(request, row.page_id);
      if (result.status === "unavailable")
        throw new HttpError(503, "Shared Pages are temporarily unavailable");
      if (result.status === "denied" || (result.page.state && result.page.state !== "active")) {
        pruned.push({
          page_id: row.page_id,
          principal: identity.principal,
          revision: row.revision,
          ...(row.revision !== undefined && { updated_at: row.updated_at }),
        });
        await storage.delete(`shared/${row.page_id}`);
        return null;
      }
      const title = catalogTitle(result.page.title);
      if (!titleMatches(title, options.needle)) return null;
      // A shared Page's placement shows only under a parent the caller can
      // already read; its Space never shows.
      const placement = pagePlacement({ placement: result.page });
      if (options.parentId !== undefined && placement.parent_id !== options.parentId) return null;
      return {
        page_id: row.page_id,
        title,
        created_at: row.created_at,
        updated_at: row.updated_at,
        shared: true,
        ...(options.parentId !== undefined && { parent_id: placement.parent_id }),
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
      // Trashed Pages keep their document for owner preview and restore.
      if (!this.handle && this.metadata?.documentId && pageState(this.metadata) !== "deleted")
        await this.loadDocument();
    });
  }

  /** Load the serving document. A trashed record whose document cannot be
   * loaded is treated as transiently unavailable: startup completes, requests
   * answer 503, and the next request tries again. Permanent absence is only
   * established by a deleted record or the owner Catalog's tombstone.
   */
  async loadDocument() {
    try {
      this.handle = await this.repo.find(this.metadata.documentId);
    } catch (error) {
      if (pageState(this.metadata) !== "trashed") throw error;
      logFailure(error, "trashed-document-load");
      return;
    }
    logIncompleteHistory(this.handle.doc());
    this.observeActivity();
    try {
      await recoverDocumentMutations(
        this.ctx.storage,
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
    // A trashed Page must not relist itself in owner or member catalogs.
    if (pageState(this.metadata) !== "active") return;
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
      // Host-only routes for the owner's Catalog. The gateway never forwards
      // /internal/* paths, so only the host namespace reaches them.
      if (url.pathname === "/internal/lifecycle-state") {
        // Report only settled state: a pending transition completes first, or
        // the Catalog keeps counting the slot while this answers 503.
        if (this.pendingLifecycle) {
          try {
            await this.completeLifecycle();
          } catch (error) {
            logFailure(error, "lifecycle-state");
            return json({ error: "Page lifecycle is settling" }, 503);
          }
        }
        return json(this.metadata ? this.lifecycleCurrent() : { state: "missing" });
      }
      if (url.pathname === "/internal/tombstone") return await this.acceptTombstone();
      identity = await authenticate(request, this.env);
      // An ambiguous storage failure retains the exact proposed ACL/receipt.
      // Normal HTTP work retries that barrier before reading or changing it.
      if (this.pendingAccess && !["/api/sync", "/api/saved"].includes(url.pathname))
        await this.installAccess(this.pendingAccess);
      // Likewise a lifecycle transition whose barrier failed completes first.
      if (this.pendingLifecycle && !["/api/sync", "/api/saved"].includes(url.pathname))
        await this.completeLifecycle();
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
        const placement =
          args.placement === undefined ? undefined : validatePlacement(args.placement);
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
              // Set by the owner's Catalog from a resolved placement.
              ...(placement && { placement }),
              createdReceipt: {
                page_id: args.page_id,
                title: doc.title,
                heads: A.getHeads(doc),
                ...(warning ? { warnings: [warning] } : {}),
                ...(placement && {
                  space_id: placement.space_id,
                  parent_id: placement.parent_id,
                  ...(placement.home && { home: true }),
                }),
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
      // Anyone without a current grant cannot tell a trashed Page from a
      // missing one. Only the owner and current members learn it exists.
      if (!this.metadata || this.hiddenWhileTrashed(identity)) {
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
      if (pageState(this.metadata) === "trashed" && !this.handle) {
        await this.loadDocument();
        if (!this.handle) throw new HttpError(503, "Page is temporarily unavailable");
      }
      const lifecycle = {
        "/internal/trash": () => this.trash(request, identity),
        "/internal/restore": () => this.restore(request, identity),
        "/internal/purge": () => this.purge(request, identity),
      }[url.pathname];
      if (lifecycle) {
        try {
          return await lifecycle();
        } catch (error) {
          // Every 4xx is raised before the lifecycle record changes. The
          // Catalog can release its reservation, as for a rejected creation.
          if (!(error.status >= 400 && error.status < 500) || error.status === 404) throw error;
          const response = errorResponse(error, "page-lifecycle");
          response.headers.set("x-pages-lifecycle-rejected", "before-change");
          return response;
        }
      }
      if (pageState(this.metadata) === "deleted") {
        // Only the owner and current grant holders learn that it was deleted.
        if (admissionRoute && !this.disclosesDeletion(identity.principal))
          throw withAdmissionReason(new PermissionDenied(), "page_deleted", "page_access_denied");
        throw withAdmissionReason(new HttpError(404, "Page not found"), "page_deleted");
      }
      const state = pageState(this.metadata);
      // claimInvitation ignores trashed records, so the ACL stays unchanged.
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
          lifecycle_revision: this.metadata.lifecycleRevision ?? 0,
          state: indexedState(this.metadata),
          title_observed_at: this.titleObservedAt,
          // For the caller's Catalog and the gateway, which decide what of the
          // placement the caller may see.
          ...pagePlacement(this.metadata),
        });
      }
      if (url.pathname === "/internal/access") {
        const args = await readJson(request);
        if (args.read) return json(await sharingProjection(this.metadata, identity, this.env));
        if (state === "trashed")
          throw new HttpError(409, "Restore this Page before changing access", "page_trashed");
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
          ...(await sharingProjection(this.metadata, identity, this.env)),
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
          ...(incompleteHistory(this.handle.doc()) && {
            historyIncomplete: incompleteHistory(this.handle.doc()),
          }),
          ...(state === "trashed" && { trash: publicTrash(this.metadata) }),
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
            historyIncomplete: incompleteHistory(this.handle.doc()),
            getPresence: (doc) => this.activityState().read(doc),
            // A trashed Page cannot be edited, so it issues no edit authority.
            issueAuthority: () =>
              state === "trashed"
                ? {}
                : issueRetryToken(this.ctx.storage, {
                    scope: `page:${this.metadata.pageId}`,
                    principal: identity.principal,
                  }),
          };
          const result =
            body.operation === "read_page_changes"
              ? await readChangesTool(this.handle.doc(), body.arguments ?? {}, options)
              : await readTool(this.handle.doc(), body.operation, body.arguments ?? {}, options);
          if (state === "trashed" && result.body && typeof result.body === "object")
            result.body.trash = publicTrash(this.metadata);
          // The gateway turns this into what the caller may see of it.
          if (body.operation === "read_page" && result.status === 200 && result.body)
            result.body._placement = pagePlacement(this.metadata);
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

  /** A trashed Page is disclosed like a deleted one: only to its owner and
   * current viewer/editor grant holders. */
  hiddenWhileTrashed(identity) {
    return pageState(this.metadata) === "trashed" && !this.disclosesDeletion(identity?.principal);
  }

  /** Validate an owner lifecycle request and return its journal identity.
   * `recorded` is this key's receipt from an earlier attempt, if any.
   */
  async lifecycleRequest(request, identity, operation) {
    requireWrite(identity);
    if (this.metadata.owner !== identity.principal)
      throw new HttpError(403, "Document access denied");
    const args = await readJson(request);
    if (args.page_id !== this.metadata.pageId) throw new HttpError(400, "Invalid page_id");
    if (operation === "purge_page" && args.action === "preview") return { args };
    const key = mutationKey(args);
    // The Catalog adds compare-and-set controls; they never change identity.
    // restore_position depends on where the parent is at each attempt.
    const {
      expected_revision: _expected,
      replay_only: _replay,
      restore_position: _position,
      ...requested
    } = args;
    const digest = await fingerprint(operation, requested, identity);
    const recorded = await this.ctx.storage.get(lifecycleReceiptKey(key));
    if (recorded && recorded.fingerprint !== digest)
      throw new HttpError(409, "idempotency_key was used for a different request");
    return { args, key, digest, recorded };
  }

  /** The Page's current lifecycle state, projected into the owner's Catalog
   * even when a retry replays an older receipt.
   */
  lifecycleCurrent() {
    const state = pageState(this.metadata);
    return {
      page_id: this.metadata.pageId,
      state,
      revision: this.metadata.lifecycleRevision ?? 0,
      ...(state !== "deleted" && this.handle && { title: catalogTitle(this.handle.doc().title) }),
      ...(state === "trashed" && publicTrash(this.metadata)),
      ...(this.metadata.placement && pagePlacement(this.metadata)),
    };
  }

  lifecycleResponse(receipt) {
    return json({ receipt, current: this.lifecycleCurrent() });
  }

  /** The owner's Catalog holds a permanent-deletion tombstone for this Page.
   * Only a trashed record can disagree with it: a build without Trash deleted
   * the document but left the record. Record that deletion so the Page answers
   * like a missing one instead of retrying an absent document.
   */
  async acceptTombstone() {
    if (pageState(this.metadata) === "trashed") {
      this.metadata = {
        ...this.metadata,
        lifecycleRevision: (this.metadata.lifecycleRevision ?? 0) + 1,
        purged: { purged_at: new Date().toISOString(), reason: "deleted_by_earlier_build" },
      };
      this.handle = undefined;
      await this.ctx.storage.put("host/document", this.metadata);
      await this.ctx.storage.sync();
      await this.retireIndex();
    }
    return json({ state: pageState(this.metadata) });
  }

  /** Commit a lifecycle transition and its receipt, then finish its barriers.
   * Trash and purge withdraw access in memory before this runs; restore grants
   * nothing until the record is durable. If a barrier fails, the transition
   * stays pending and the next request completes it before doing anything
   * else, so a retry never replays a receipt for an unfinished transition.
   */
  async completeLifecycle(pending = this.pendingLifecycle) {
    this.pendingLifecycle = pending;
    if (pending.operation === "purge_page") {
      const response = await this.finishPermanentDeletion(pending.record);
      this.pendingLifecycle = undefined;
      return response;
    }
    const restoring = this.metadata !== pending.metadata;
    // Trash removes non-owner listing rows before its record is durable.
    if (!restoring && catalogIndexEpoch(this.env)) await this.restrictIndex(pending.metadata);
    await this.commitLifecycle(pending.key, pending.record, pending.metadata);
    await this.ctx.storage.sync();
    this.metadata = pending.metadata;
    await this.policy.refreshAccess();
    this.activity?.prune();
    if (!restoring) await this.retireIndex();
    if (restoring) {
      this.cachedTitle = undefined;
      this.cacheTitle();
    }
    this.pendingLifecycle = undefined;
    return this.lifecycleResponse(pending.record.receipt);
  }

  lifecycleRecord(operation, digest, receipt, revision = this.metadata.lifecycleRevision ?? 0) {
    return { operation, fingerprint: digest, revision, receipt, at: Date.now() };
  }

  /** Persist a lifecycle receipt, optionally with the new record, in one
   * multi-key write. Receipts are bounded: the Catalog's expected revision,
   * not receipt retention, prevents an old request from applying again.
   */
  async commitLifecycle(key, record, metadata) {
    await this.ctx.storage.put({
      [lifecycleReceiptKey(key)]: record,
      ...(metadata && { "host/document": metadata }),
    });
    const records = await this.ctx.storage.list({ prefix: "host/lifecycle/" });
    if (records.size <= LIFECYCLE_RECEIPT_LIMIT) return;
    const oldest = [...records]
      .sort(([, a], [, b]) => a.at - b.at)
      .slice(0, records.size - LIFECYCLE_RECEIPT_LIMIT);
    for (const [name] of oldest) await this.ctx.storage.delete(name);
  }

  /** The Catalog reserved this request against an older lifecycle revision,
   * or could not hold its slot on resume. Report the current state instead of
   * applying it.
   */
  superseded(args) {
    const revision = this.metadata.lifecycleRevision ?? 0;
    return (
      args.replay_only === true ||
      (args.expected_revision !== undefined && args.expected_revision !== revision)
    );
  }
  supersededResponse() {
    // Not recorded: the revision only grows, so a stale expectation stays
    // stale, and the Catalog may retarget a request it has just reserved.
    return this.lifecycleResponse({
      page_id: this.metadata.pageId,
      superseded: true,
      applied: false,
      state: pageState(this.metadata),
    });
  }

  /** Move the Page to Trash. The document, comments and ACL are retained.
   * Access is withdrawn before the record is durable, like an ACL reduction.
   */
  async trash(request, identity) {
    const { args, key, digest, recorded } = await this.lifecycleRequest(
      request,
      identity,
      "trash_page",
    );
    const revision = this.metadata.lifecycleRevision ?? 0;
    const state = pageState(this.metadata);
    // run() already finished any pending transition, so a receipt is final.
    if (recorded) return this.lifecycleResponse(recorded.receipt);
    if (state === "deleted") throw new HttpError(404, "Page not found");
    if (this.superseded(args)) return this.supersededResponse();
    let receipt = this.metadata.trash?.receipt;
    if (state === "active") {
      if (pagePlacement(this.metadata).home)
        throw new HttpError(
          409,
          "A Space's home Page stays with its Space; it can't move to Trash on its own",
          "home_page_protected",
        );
      requireHeads(this.handle.doc(), args.base_heads);
      const now = new Date().toISOString();
      const pageId = this.metadata.pageId;
      receipt = {
        page_id: pageId,
        state: "trashed",
        trashed: true,
        title: catalogTitle(this.handle.doc().title),
        trashed_at: now,
        trashed_by: identity.principal,
        trash_root_id: pageId,
      };
      // No await between the head guard and the policy-visible record.
      this.metadata = {
        ...this.metadata,
        deleted: true,
        lifecycleRevision: revision + 1,
        trash: trashRecord({ pageId, principal: identity.principal, now, receipt }),
        // Builds that predate Trash read only `deletion`: their delete retry
        // conflicts, and a fresh key completes an ordinary permanent deletion.
        deletion: { key, fingerprint: digest, receipt: { page_id: pageId, deleted: true } },
      };
    }
    // Disconnected peers rebroadcast profiles as their sockets close.
    return this.completeLifecycle({
      operation: "trash_page",
      key,
      record: this.lifecycleRecord("trash_page", digest, receipt),
      metadata: this.metadata,
    });
  }

  /** Restore a trashed Page with its ID, content, comments and ACL. Like an
   * access increase, nothing is granted before the record is durable.
   */
  async restore(request, identity) {
    const { args, key, digest, recorded } = await this.lifecycleRequest(
      request,
      identity,
      "restore_page",
    );
    const revision = this.metadata.lifecycleRevision ?? 0;
    const state = pageState(this.metadata);
    if (recorded) return this.lifecycleResponse(recorded.receipt);
    if (state === "deleted") throw new HttpError(404, "Page not found");
    if (this.superseded(args)) return this.supersededResponse();
    if (state === "active") {
      const record = this.lifecycleRecord("restore_page", digest, {
        page_id: this.metadata.pageId,
        state: "active",
        restored: false,
        title: catalogTitle(this.handle.doc().title),
      });
      await this.commitLifecycle(key, record);
      await this.ctx.storage.sync();
      return this.lifecycleResponse(record.receipt);
    }
    const { trash: _trash, deletion: _deletion, ...rest } = this.metadata;
    const next = { ...rest, deleted: false, lifecycleRevision: revision + 1 };
    // The Catalog supplies a position when this Page's parent is gone; the
    // Page then returns to the top level of its Space (or Your items).
    if (args.restore_position !== undefined && this.metadata.placement) {
      const current = pagePlacement(this.metadata);
      next.placement = validatePlacement({
        space_id: current.space_id,
        parent_id: null,
        position: args.restore_position,
        placement_epoch: current.placement_epoch + 1,
        ...(current.home && { home: true }),
      });
    }
    const receipt = {
      page_id: this.metadata.pageId,
      state: "active",
      restored: true,
      title: catalogTitle(this.handle.doc().title),
      restored_at: new Date().toISOString(),
      ...(next.placement && {
        space_id: next.placement.space_id,
        parent_id: next.placement.parent_id,
      }),
    };
    // Owner sessions reconnect writable and members may reconnect once the
    // restored record is durable and installed.
    return this.completeLifecycle({
      operation: "restore_page",
      key,
      record: this.lifecycleRecord("restore_page", digest, receipt, revision + 1),
      metadata: next,
    });
  }

  /** Preview, then permanently delete, a trashed Page. Confirmation requires
   * the unchanged preview token; new heads, ACL or lifecycle revision
   * invalidate it.
   */
  async purge(request, identity) {
    const { args, key, digest, recorded } = await this.lifecycleRequest(
      request,
      identity,
      "purge_page",
    );
    const state = pageState(this.metadata);
    if (key && state === "deleted" && this.deletionFinished && this.metadata.deletion)
      return this.lifecycleResponse(recorded?.receipt ?? this.metadata.deletion.receipt);
    // After a restart, a durable purge record may still own document storage.
    if (recorded && state === "deleted") return this.finishPermanentDeletion();
    if (recorded) return this.lifecycleResponse(recorded.receipt);
    if (state === "deleted") {
      // A new retry key still completes the original deletion barriers.
      if (!key || !this.metadata.deletion) throw new HttpError(404, "Page not found");
      return this.finishPermanentDeletion();
    }
    if (state !== "trashed")
      throw new HttpError(
        409,
        "Move this Page to Trash with delete_page before deleting it permanently",
        "page_not_in_trash",
      );
    const doc = this.handle.doc();
    if (args.action === "preview")
      return json({
        page_id: this.metadata.pageId,
        ...publicTrash(this.metadata),
        ...purgeImpact(this.metadata, doc),
        heads: A.getHeads(doc),
        ...(await issuePurgePreview(this.ctx.storage, this.metadata, doc, identity.principal)),
      });
    if (this.superseded(args)) return this.supersededResponse();
    const verified = this.metadata;
    await verifyPurgePreview(
      this.ctx.storage,
      verified,
      doc,
      identity.principal,
      args.preview_token,
    );
    // Verification awaited crypto and storage. Recheck the live document and
    // record in the same synchronous step that tombstones the Page. While
    // trashed the policy refuses every native write, so this only catches a
    // change accepted before Trash that applied late.
    if (this.metadata !== verified || !sameHeads(A.getHeads(this.handle.doc()), A.getHeads(doc)))
      throw new HttpError(
        409,
        "The Page changed after its preview; preview the permanent deletion again",
        "purge_preview_invalid",
      );
    const receipt = { page_id: this.metadata.pageId, deleted: true, purged: true };
    this.metadata = {
      ...this.metadata,
      lifecycleRevision: (this.metadata.lifecycleRevision ?? 0) + 1,
      purged: { purged_at: new Date().toISOString(), purged_by: identity.principal },
      deletion: { key, fingerprint: digest, receipt },
    };
    return this.completeLifecycle({
      operation: "purge_page",
      key,
      record: this.lifecycleRecord("purge_page", digest, receipt),
    });
  }

  async finishPermanentDeletion(record) {
    this.recordMaintenance?.stop();
    this.activity?.close();
    if (catalogIndexEpoch(this.env)) await this.restrictIndex(this.metadata);
    // Persist again on retry: a previous storage failure may have occurred
    // after admission stopped, but before the record reached storage.
    if (record) await this.commitLifecycle(this.metadata.deletion.key, record, this.metadata);
    else await this.ctx.storage.put("host/document", this.metadata);
    await this.policy.close();
    for (const wire of this.wires) await wire.disconnect();
    await this.repo.delete(this.metadata.documentId);
    await this.backend.flush();
    await this.recordStore?.flush?.();
    await this.ctx.storage.sync();
    await this.retireIndex();
    // Barriers are complete for this process; a restart repeats them.
    this.deletionFinished = true;
    return this.lifecycleResponse(this.metadata.deletion.receipt);
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
        // A completed registration still replays after trashing; the browser
        // treats "Page was deleted" as permanent and forgets its local copy.
        if (pageState(metadata) === "deleted") throw new HttpError(409, "Page was deleted");
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
