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
import { readTargets, writeTargets } from "../model/agent-presence.mjs";
import { BACKEND_LIMITS, assertDocumentLimits, assertIntentSize } from "../model/limits.mjs";
import { handleMcp } from "../mcp.mjs";
import { invokeProjectApi } from "./project-api.mjs";
import { agentGuideResponse } from "../agent-guide.mjs";
import { connectAgentResponse } from "../connect-agent.mjs";
import { handleOAuth, mcpAuthChallenge } from "./oauth.mjs";
import { sessionStoreReady } from "./isolate-setup.mjs";
import { localOidcStore } from "./local-oidc-store.mjs";
import { WebSocketByteTransport } from "../shared/byte-transport.mjs";
import { MISSING_EDITS_MESSAGE } from "../shared/receipts.mjs";
import { openingTitleWarning } from "../model/title-warning.mjs";
import {
  authenticate,
  agentLabel,
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
import {
  bufferedResponse,
  readResponseJson,
  untilAborted,
  withinToolDeadline,
} from "./tool-deadline.mjs";

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
import { pageAccess, pageRelation, pageState, restrictAccessDuringCommit } from "./access.mjs";

import {
  capacityFor,
  catalogTitle,
  countCapacity,
  countedStorage,
  countSlot,
  intentState,
  listAll,
  knownRevision,
  lifecycleSlot,
  lifecycleSlotKey,
  observedLifecycleRevision,
  projectLifecycle,
  pruneTombstonedTrash,
  refreshCatalogTitle,
  releaseLifecycleSlot,
  runSlot,
  trashFields,
} from "./catalog.mjs";
import { holdsSlot, operationIntent, replies } from "./operation-intent.mjs";
import {
  CatalogIndexUnavailable,
  catalogIndexDatabase,
  catalogIndexEpoch,
  catalogIndexTimeouts,
  catalogSource,
  childIdSource,
  indexSource,
  indexedState,
  listScope,
  listingRestricted,
  markCatalogIndexDirty,
  markSpaceIndexDirty,
  openCursor,
  parseListArguments,
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
import { handleImageAssets, requireStoredImageAsset } from "./image-assets.mjs";
import {
  appendPosition,
  childrenOf,
  locationAnswer,
  locationEntries,
  locationScan,
  projectOf,
  publicLocation,
  receiptLocation,
  rekeyedEntries,
  restoreTarget,
} from "./catalog-location.mjs";
import { MAX_DEPTH, deriveLocation } from "../model/location.mjs";
import {
  SPACE_LIMIT,
  homePageMarkdown,
  newSpaceId,
  requirePageIdArgument,
  requireSpaceIdArgument,
  spaceNotFound,
  validateSpaceInput,
} from "./spaces.mjs";
// The class name is the storage identity for Projects; see spaces.mjs.
export { Space } from "./spaces.mjs";
import { spaceCreationEffect, spaceCreationTransition } from "./space-lifecycle.mjs";
import { handleImportPageImage } from "./import-image.mjs";
import { forwardedPageLimit, quotaError, quotaRefusal, resolvePageQuota } from "./page-quota.mjs";
import { serialQueue, serialQueueBounds } from "./serial-queue.mjs";
import { holdUntilSettled } from "./request-hold.mjs";
import { readTool } from "./tool-reads.mjs";
import { readChangesTool } from "./tool-changes.mjs";
import { PageActivity } from "./page-activity.mjs";
import {
  checkPurgePreview,
  issuePurgePreview,
  publicTrash,
  purgeImpact,
  trashRecord,
} from "./trash.mjs";
import {
  CREATION_COMMIT,
  CREATION_REPLAY,
  creationIntentConflict,
  hostState,
  isSuperseded,
  pageLifecycle,
  recordOf,
  summarizeReceipt,
} from "./page-lifecycle.mjs";

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
/** Project operations under their stored Space names. Each goes through the
 * caller's own Catalog, which calls the Project with the caller's credentials.
 * Storage keeps the Space name so a rollback build reads the same records;
 * project-api.mjs maps callers' Project names onto these. */
const spaceOperations = ["create_space", "list_spaces", "get_space", "update_space"];
/** Catalog-owned Page lifecycle operations and the Page route each one uses. */
const lifecycleRoutes = {
  delete_page: "/internal/trash",
  restore_page: "/internal/restore",
  purge_page: "/internal/purge",
};
/** Where a pending Trash or restore keeps its destination slot. */
const slotPrefix = { delete_page: "trash/", restore_page: "page/" };
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
/** Complete the upgrade and close at once with the refusal's admission code.
 * A browser reads a refused HTTP upgrade only as close 1006, which its
 * reconnect treats as transient; the close code lets it count the refusal. */
function refuseSocket(error, identity) {
  logAdmissionDenied(error, { stage: "page", identity });
  const pair = new WebSocketPair();
  const socket = pair[1];
  socket.accept();
  socket.close(admissionCloseCode(error), admissionCode(error));
  return new Response(null, { status: 101, webSocket: pair[0] });
}
/** The most children of one shared parent a listing checks. Each is a Page
 * host read made while the caller's Catalog queue waits, so this stays fixed
 * whatever the owner's Page limit is. */
const SHARED_CHILDREN_LIMIT = 100;
/** Budgets for reading Page lifecycles while the Catalog queue waits. */
export const lifecycleBounds = { readMs: 2000, passMs: 5000, concurrency: 4 };
const lifecycleUnsettled = () =>
  new HttpError(
    replies.unsettled.status,
    replies.unsettled.body.error,
    replies.unsettled.body.code,
  );
const hasChildren = () =>
  new HttpError(
    409,
    "This Page has sub-pages. Trash its sub-pages first; subtree Trash is not available yet.",
    "page_has_children",
  );
/** The reply for a leaf guard that refused a Trash, or undefined for any
 * other failure. */
const leafRefusalOf = (error) =>
  ["page_has_children", "home_page_protected"].includes(error.code)
    ? { status: error.status, body: { error: error.message, code: error.code } }
    : undefined;
/** A home Page's Catalog location: a root of its Project, before every
 * other Page at the Project's top level. */
const homeLocation = (spaceId) => ({
  parent_id: null,
  position: "a0",
  space_id: spaceId,
  home: true,
});
/** A Page's owner Catalog, reached with a host request. It answers IDs
 * only; callers filter them with the caller's access. */
const locationRequest = (query) =>
  new Request("https://pages.internal/internal/location", {
    method: "POST",
    body: JSON.stringify(query),
  });
const INDEX_REPORT_PENDING = "host/index/report-pending";
/** Lifecycle receipts kept per Page for retries; older ones are pruned. */
const LIFECYCLE_RECEIPT_LIMIT = 256;
const lifecycleReceiptKey = (operationKey) =>
  `host/lifecycle/${operationKey.slice("host/operation/".length)}`;
/** One structured line when a creation intent disagrees with the installed
 * record. The installed record wins; DEPLOYMENT.md describes the audit. It
 * names the fields that differ, never their values. */
function logCreationIntentConflict(intent, installed) {
  const fields = creationIntentConflict(intent, installed);
  if (!fields.length) return;
  console.warn(
    JSON.stringify({
      service: "nteract-pages-native",
      event: "page.creation_intent_conflict",
      page_id: installed.pageId,
      fields,
      timestamp: new Date().toISOString(),
    }),
  );
}
/** One structured line when a listing finds a Catalog's stored Page counts
 * wrong and rewrites them. Expected after a rollback build wrote Catalog
 * entries; anything else points at a write path that skips countedStorage. */
function logCountRepair(counts) {
  console.warn(
    JSON.stringify({
      service: "nteract-pages-native",
      event: "catalog.count_repaired",
      active: counts["page/"],
      trash: counts["trash/"],
      timestamp: new Date().toISOString(),
    }),
  );
}
/** Journal operation names for the Catalog's lifecycle routes. */
const LIFECYCLE_OPERATIONS = { trash: "trash_page", restore: "restore_page", purge: "purge_page" };
/** A request's base_heads as requireHeads judges them. */
function headsCheck(doc, heads) {
  try {
    requireHeads(doc, heads);
    return "match";
  } catch (error) {
    if (error.status === 400) return "invalid";
    if (error.status === 409) return "mismatch";
    throw error;
  }
}
const sameHeads = (left, right) =>
  left.length === right.length && [...left].sort().join() === [...right].sort().join();
const publicIdentity = ({ principal, displayName, driver }) => ({ principal, displayName, driver });
/** Lifecycle arguments as the caller sent them. The Catalog alone sets the
 * compare-and-set controls it forwards to a Page. */
const callerLifecycleArguments = ({
  expected_revision: _expected,
  replay_only: _replay,
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
  // The MCP session travels only from /mcp; internal routes trust their forwards.
  if (new URL(request.url).pathname === "/mcp" && request.headers.has("mcp-session-id"))
    headers.set("mcp-session-id", request.headers.get("mcp-session-id"));
  if (request.headers.has("x-pages-driver") || new URL(request.url).searchParams.has("driver"))
    headers.set("x-pages-driver", driverLabel(request));
  const agent = agentLabel(request);
  if (agent) headers.set("x-pages-agent", agent);
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

/** Catalog operations that apply the account's Page limit, or report it. */
const QUOTA_OPERATIONS = new Set([
  "list_pages",
  "create_page",
  "register_page",
  "create_space",
  "delete_page",
  "restore_page",
]);
/** The resolved Page limit for a Catalog forward (page-quota.mjs). It sits
 * beside `arguments`, never inside them, so a caller can't set it, and
 * /internal/catalog is reachable only through the host. */
async function quotaFields(env, identity, operation) {
  if (!QUOTA_OPERATIONS.has(operation)) return {};
  return { page_limit: (await resolvePageQuota(env, identity)).limit };
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
    const body = { operation, arguments: args, ...(await quotaFields(env, identity, operation)) };
    return withinToolDeadline(async (signal) =>
      bufferedResponse(
        await untilAborted(
          env.CATALOGS.getByName(identity.principal).fetch(
            forwarded(request, "/internal/catalog", body),
            { signal },
          ),
          signal,
        ),
        signal,
      ),
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
  // One deadline covers the Page fetch, its body and read_page's location
  // view, so a timeout never returns an unfiltered body.
  return withinToolDeadline(async (signal) => {
    const response = await untilAborted(
      env.PAGES.getByName(args.page_id).fetch(
        forwarded(request, "/internal/tool", { operation, arguments: args }),
        { signal },
      ),
      signal,
    );
    if (operation !== "read_page" || !response.ok) return bufferedResponse(response, signal);
    const body = await readResponseJson(response, signal);
    await locationView(request, env, body, signal);
    return json(body, response.status);
  });
}

/**
 * Add what the caller may see of a read_page result's location. The Page
 * admitted the caller's read and names its owner. The owner's Catalog, the
 * only record of location, answers the Page's ancestor IDs and Project in
 * one call. Each ancestor and the Project then answer with the caller's own
 * credentials, so a breadcrumb or ID appears only when the caller could open
 * it: the chain stops at the first Page the caller cannot read, and space_id
 * appears only when the Project is readable. Direct access to a Page never
 * reveals its Project. This runs in the stateless gateway: a Page never calls
 * its owner's Catalog.
 */
async function locationView(request, env, body, signal) {
  const owner = body._owner;
  delete body._owner;
  body.kind = "page";
  body.breadcrumbs = [];
  // Each read, body included, is bounded by its own timeout and by the
  // request's deadline. Only the request deadline ends the whole view.
  const readable = async (namespace, name, outbound) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Location read timed out")),
      catalogIndexTimeouts.verify,
    );
    try {
      const response = await untilAborted(
        namespace.getByName(name).fetch(outbound, { signal: controller.signal }),
        controller.signal,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      return await readResponseJson(response, controller.signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      logFailure(error, "breadcrumbs");
      return null;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };
  const location =
    typeof owner === "string"
      ? await readable(env.CATALOGS, owner, locationRequest({ page_id: body.page_id }))
      : null;
  if (!location) return;
  // Top-level Pages in Your items.
  if (!location.space_id && !location.parent_id) {
    body.space_id = null;
    body.parent_id = null;
    return;
  }
  const ancestors = location.ancestors.slice(0, MAX_DEPTH);
  const parents = await Promise.all(
    ancestors.map((pageId) =>
      readable(env.PAGES, pageId, forwarded(request, "/internal/catalog", {})),
    ),
  );
  const chain = [];
  for (const [index, parent] of parents.entries()) {
    if (!parent || (parent.state && parent.state !== "active")) break;
    chain.unshift({ kind: "page", page_id: ancestors[index], title: catalogTitle(parent.title) });
  }
  const reachedRoot = location.complete && chain.length === location.ancestors.length;
  if (location.parent_id && chain.at(-1)?.page_id === location.parent_id)
    body.parent_id = location.parent_id;
  const space = location.space_id
    ? await readable(
        env.PROJECTS,
        location.space_id,
        forwarded(request, "/internal/space/read", { space_id: location.space_id }),
      )
    : null;
  if (space) {
    body.space_id = location.space_id;
    if (!location.parent_id) body.parent_id = null;
    if (location.home) body.home = true;
    // The whole chain is visible to whoever can read the Project in this build.
    if (reachedRoot) chain.unshift({ kind: "space", space_id: space.space_id, title: space.title });
    // The home Page stands for its Project; viewers may fold its crumb into
    // the Project's.
    for (const crumb of chain)
      if (crumb.kind === "page" && crumb.page_id === space.home_page_id) crumb.home = true;
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
        const local = await handleLocalOidcRequest(request, env, {
          store: localOidcStore(env.DB),
        });
        if (local) return local;
      }
      if (url.pathname === "/connect") return connectAgentResponse(request, env);
      if (url.pathname === "/llms.txt") return agentGuideResponse(request, env);
      if (url.pathname === "/health")
        return json({ ok: true, prototype: "pages-celld-native", ...buildAdvertisement() });
      try {
        await sessionStoreReady(request, env);
      } catch (error) {
        if (!ADMISSION_ROUTES.includes(url.pathname)) throw error;
        if ((error.status ?? 500) >= 500) logFailure(error, "gateway");
        return admissionErrorResponse(error, { stage: "gateway" });
      }
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
              return await invokeProjectApi(
                (internal, internalArgs) => invoke(request, env, internal, internalArgs),
                operation,
                args,
              );
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
        const quota = await quotaFields(env, identity, "register_page");
        return await withinToolDeadline(async (signal) =>
          bufferedResponse(
            await untilAborted(
              env.CATALOGS.getByName(identity.principal).fetch(
                forwarded(request, "/internal/catalog", {
                  operation: "register_page",
                  arguments: args,
                  ...quota,
                }),
                { signal },
              ),
              signal,
            ),
            signal,
          ),
        );
      }
      if (url.pathname === "/api/tools" && request.method === "POST") {
        const body = await readJson(request);
        return await invokeProjectApi(
          (internal, internalArgs) => invoke(request, env, internal, internalArgs),
          body.operation,
          body.arguments,
        );
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
    this.queue = serialQueue(ctx, "catalog-queue");
  }
  /** Storage that keeps the `page/` and `trash/` key counts (catalog.mjs). */
  get storage() {
    return (this.counted ??= countedStorage(this.ctx.storage));
  }
  fetch(request) {
    // Location reads write nothing, so they never wait behind the queue. A
    // Catalog listing a shared parent asks the owner's Catalog from inside
    // its own queue; two Catalogs doing that to each other must not wait on
    // each other.
    if (new URL(request.url).pathname === "/internal/location") return this.location(request);
    return this.queue(() => this.run(request));
  }
  /**
   * Host-only location route: the gateway never forwards /internal/* paths.
   * It answers IDs only, for a Page's ancestors or a parent's children, and
   * its callers filter them with the caller's access. Host requests carry no
   * credential. A request that carries one answers only to this Catalog's
   * own account, like every other Catalog route.
   */
  async location(request) {
    try {
      if (request.headers.has("authorization") || request.headers.has("cookie")) {
        const identity = await authenticate(request, this.env);
        if (this.ctx.id.name && this.ctx.id.name !== identity.principal)
          throw new HttpError(403, "Account access denied");
      }
      const query = await readJson(request);
      const entries = await locationEntries(this.storage);
      if (query?.children_of !== undefined) {
        if (!validPageId(query.children_of)) throw new HttpError(400, "Invalid children_of");
        return json({ children: childrenOf(entries, query.children_of) });
      }
      if (!validPageId(query?.page_id)) throw new HttpError(400, "Invalid page_id");
      const answer = locationAnswer(entries, query.page_id);
      if (!answer) throw new HttpError(404, "Page not found");
      return json(answer);
    } catch (error) {
      return errorResponse(error, "catalog-location");
    }
  }
  async countEntries(prefix) {
    return countCapacity(this.storage, prefix, {
      current: (pageId) => this.pageLifecycle(pageId),
    });
  }
  /** Room for one more entry under `prefix` within `limit`: `{ room, count }`.
   * `slotKey` names the caller's own reservation slot, which is counted (and
   * released when stale) first, as a full count would. */
  async capacity(prefix, limit, slotKey) {
    return capacityFor(this.storage, prefix, limit, {
      slotKey,
      current: (pageId) => this.pageLifecycle(pageId),
    });
  }
  /** Refuse a new Page when the account is at its limit. */
  async requirePageRoom(limit) {
    const { room, count } = await this.capacity("page/", limit);
    if (!room) throw quotaError("page/", { limit, count });
  }
  /** Read a Page's current lifecycle state. The Catalog may call its Pages;
   * a Page never calls its owner's Catalog.
   */
  /**
   * Read a Page's lifecycle, waiting at most `ms`. Every Catalog request
   * shares one queue, so reads are shared and capped: a pass reuses the read
   * already in flight for the same Page, and no more than
   * `lifecycleBounds.concurrency` underlying reads run at once across passes.
   * A read counts against that cap until it settles, not when a caller stops
   * waiting. At the cap the call fails at once and the caller treats the Page
   * as unsettled.
   */
  async pageLifecycle(pageId, ms = lifecycleBounds.readMs) {
    this.lifecycleReads ??= new Map();
    let read = this.lifecycleReads.get(pageId);
    if (!read) {
      if (this.lifecycleReads.size >= lifecycleBounds.concurrency)
        throw Error("Page lifecycle reads are at capacity");
      read = this.readLifecycle(pageId);
      // Later passes reuse this read after its request stops waiting.
      holdUntilSettled(this.ctx, read);
      this.lifecycleReads.set(pageId, read);
      const clear = () => {
        if (this.lifecycleReads.get(pageId) === read) this.lifecycleReads.delete(pageId);
      };
      read.then(clear, clear);
    }
    return withTimeout(read, Math.max(1, ms), "Page lifecycle read timed out");
  }

  /**
   * One underlying lifecycle read, aborted after `lifecycleBounds.readMs`.
   * celld 0.6.3 honors an AbortSignal on a Durable Object stub fetch: the
   * call rejects and the Page sees its request signal abort. An abort after
   * the headers does not interrupt a body read, so the body is read through
   * a reader that the abort cancels.
   */
  async readLifecycle(pageId) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Page lifecycle read timed out")),
      lifecycleBounds.readMs,
    );
    try {
      const response = await this.env.PAGES.getByName(pageId).fetch(
        new Request("https://pages.internal/internal/lifecycle-state"),
        { signal: controller.signal },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw Error(`Page lifecycle state unavailable: ${response.status}`);
      }
      const reader = response.body.getReader();
      const cancel = () => reader.cancel(controller.signal.reason).catch(() => {});
      if (controller.signal.aborted) cancel();
      controller.signal.addEventListener("abort", cancel, { once: true });
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      return JSON.parse(new TextDecoder().decode(await new Blob(chunks).arrayBuffer()));
    } finally {
      clearTimeout(timer);
    }
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
        const previous = await this.storage.get(key);
        if (value.remove) await this.storage.delete(key);
        else if (
          !previous?.pending &&
          !(await this.storage.get(`host/deleted/${value.page_id}`)) &&
          // A projection observed before trashing must not relist the Page.
          (value.shared || !(await this.storage.get(`trash/${value.page_id}`))) &&
          (!previous?.updated_at || previous.updated_at <= value.observed_at)
        ) {
          // A new discovery entry may not have reached D1; reconcile on next listing.
          if (!previous) await markCatalogIndexDirty(this.storage);
          await this.storage.put(key, {
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
        await refreshCatalogTitle(this.storage, body);
        return json({ ok: true });
      }
      const args = body.arguments ?? {};
      const limit = forwardedPageLimit(body.page_limit, this.env);
      if (body.operation === "list_pages")
        return await this.listPages(request, identity, args, limit);
      if (body.operation === "list_spaces") return await this.listSpaces(request, identity, args);
      if (body.operation === "get_space") return await this.getSpace(request, args);
      requireWrite(identity);
      if (body.operation === "create_space")
        return await this.createSpace(request, identity, args, limit);
      if (body.operation === "update_space") return await this.updateSpace(request, identity, args);
      const lifecycle = lifecycleRoutes[body.operation];
      if (!["create_page", "register_page"].includes(body.operation) && !lifecycle)
        throw new HttpError(400, "Unknown catalog operation");
      // Reject deterministic input errors before reserving an intent or page.
      const registering = body.operation === "register_page";
      if (
        lifecycle &&
        args.expected_principal !== undefined &&
        args.expected_principal !== identity.principal
      )
        throw new HttpError(403, "Sign in with this Page's original account to change it");
      if (lifecycle) requirePageIdArgument(args.page_id);
      if (body.operation === "purge_page") {
        if (!["preview", "confirm"].includes(args.action))
          throw new HttpError(400, "action must be preview or confirm");
        // A preview is an owner read of the trashed Page; it reserves nothing.
        if (args.action === "preview") {
          if (await this.storage.get(`host/deleted/${args.page_id}`)) {
            await this.storage.delete(`trash/${args.page_id}`);
            await this.notifyTombstone(args.page_id);
            throw new HttpError(404, "Page not found");
          }
          return this.env.PAGES.getByName(args.page_id).fetch(forwarded(request, lifecycle, args));
        }
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
        if (await this.storage.get(`host/deleted/${args.page_id}`))
          throw new HttpError(409, "Page was deleted");
      }
      const key = mutationKey(args);
      const digest = await fingerprint(
        lifecycleFingerprint[body.operation] ?? body.operation,
        args,
        identity,
      );
      const inspected = await inspectOperation(this.storage, {
        key,
        digest,
        retryToken: args.retry_token,
        scope: `catalog:${identity.principal}`,
        principal: identity.principal,
      });
      if (lifecycle)
        return await this.runLifecycle(request, body.operation, args, {
          key,
          digest,
          inspected,
          limit,
        });
      let intent = inspected.entry;
      if (intent && !intent.pending) {
        // A previous attempt may have stored its receipt before sync failed.
        await this.storage.sync();
        return json(intent.receipt);
      }
      if (!intent) {
        await this.requirePageRoom(limit);
        if (
          registering &&
          ((await this.storage.get(`page/${args.page_id}`)) ||
            (await this.storage.get(`trash/${args.page_id}`)))
        )
          throw new HttpError(409, "Page already has another creation request");
        const { location, rekeyed } = await this.resolveLocation(request, registering ? {} : args);
        intent = {
          fingerprint: digest,
          pending: true,
          pageId: body.operation === "create_page" ? crypto.randomUUID() : args.page_id,
          createdAt: new Date().toISOString(),
        };
        intent = await reserveOperation(this.storage, {
          key,
          entry: intent,
          retry: inspected.retry,
        });
        // The intent and the pending entry, which alone records the new
        // Page's location, commit together. A retry reads the location back.
        await this.storage.put({
          ...(await rekeyedEntries(this.storage, rekeyed)),
          [key]: intent,
          [`page/${intent.pageId}`]: {
            page_id: intent.pageId,
            title: catalogTitle(args.title),
            created_at: intent.createdAt,
            updated_at: intent.createdAt,
            pending: true,
            ...location,
          },
        });
      }
      const pageId = intent.pageId;
      const pending = await this.storage.get(`page/${pageId}`);
      if (!pending) throw new Error("A pending creation has no Catalog entry");
      // A resumed creation checks its parent again: the parent may have
      // moved to Trash since the intent was reserved. The intent stays
      // pending; restoring the parent and retrying finishes it.
      if (inspected.entry && pending.parent_id) await this.activeParent(pending.parent_id);
      // The Page learns its content and owner, never its location.
      const response = await this.env.PAGES.getByName(pageId).fetch(
        forwarded(
          request,
          registering ? "/internal/register" : "/internal/create",
          registering
            ? { ...args, page_id: pageId }
            : { title: args.title, markdown: args.markdown, page_id: pageId },
        ),
      );
      if (!response.ok && response.headers.get("x-pages-create-rejected") === "before-intent") {
        // Only this explicit pre-intent rejection proves there is no Page
        // creation to recover. Ambiguous failures retain their reservation.
        await this.storage.delete(`page/${pageId}`);
        await this.storage.delete(key);
        await this.storage.sync();
      }
      if (!response.ok) return response;
      // The receipt reports the location this Catalog recorded.
      intent.receipt = {
        ...(await response.json()),
        ...receiptLocation(await locationEntries(this.storage), pageId),
      };
      intent.pending = false;
      const { pending: _pending, ...created } = pending;
      await markCatalogIndexDirty(this.storage);
      await this.storage.put({
        [key]: intent,
        [`page/${pageId}`]: { ...created, title: catalogTitle(intent.receipt.title) },
      });
      await this.storage.sync();
      return json(intent.receipt);
    } catch (error) {
      return errorResponse(error, "catalog");
    }
  }

  /**
   * Run one delete_page, restore_page or purge_page confirmation through the
   * operation-intent machine. The machine decides each transition. This
   * method reads the facts it needs, runs its effects against storage and the
   * Page in order, and feeds the Page's answers back in until it replies.
   * Requests reach it one at a time through this Catalog's queue.
   */
  async runLifecycle(request, operation, args, { key, digest, inspected, limit }) {
    const storage = this.storage;
    const pageId = args.page_id;
    const run = { request, operation, args, pageId, key, digest, retry: inspected.retry, limit };
    run.row = inspected.entry;
    let state = await intentState(storage, key, operation, pageId);
    let outcome;
    // A permanent deletion this account observed is terminal, even when a
    // build without Trash wrote the tombstone. A completed request replays
    // first; any other checks here, so a Page never has to ask its owner's
    // Catalog.
    if (
      !["completed", "superseded"].includes(state.name) &&
      (await storage.get(`host/deleted/${pageId}`))
    ) {
      outcome = await this.stepIntent(run, state, { type: "tombstone" });
      if (outcome.reply) return outcome.reply;
      state = outcome.state;
    }
    if (state.name === "absent") {
      outcome = await this.stepIntent(run, state, await this.newIntentFacts(run));
      if (outcome.reply) return outcome.reply;
      state = outcome.state;
    }
    let event = { type: "request" };
    if (["reserved", "forwarded"].includes(state.name))
      ({ event, state } = await this.pendingIntentFacts(run, state));
    for (;;) {
      outcome = await this.stepIntent(run, state, event);
      if (outcome.reply) return outcome.reply;
      if (!outcome.next) throw new Error("An operation intent stopped without a reply");
      ({ state, next: event } = outcome);
    }
  }

  /** Step the machine and run its effects. `next` is the event the last
   * effect produced (the Page's reply to a forward); `reply` is the HTTP
   * response when the machine answered. */
  async stepIntent(run, state, event) {
    const result = operationIntent.step(state, event);
    if (result.rejected !== undefined && result.response === undefined)
      throw new Error(`An operation intent refused ${event.type}: ${result.rejected}`);
    let next;
    for (const effect of result.effects) next = await this.runIntentEffect(run, effect);
    const { response } = result;
    return {
      state: result.state,
      next,
      reply:
        response === undefined
          ? undefined
          : response.source === "page"
            ? run.reply
            : this.intentReply(run, response),
    };
  }

  /** A reply the machine gave. A full destination's reply names its code
   * only; the message, limit and count come from the capacity check. */
  intentReply(run, response) {
    if ([replies.trashFull.body.code, replies.pageQuota.body.code].includes(response.body?.code)) {
      const prefix = slotPrefix[run.operation];
      // Every path to a full reply runs a capacity check first.
      const { status, body } = quotaRefusal(prefix, run.capacity);
      return json(body, status);
    }
    return json(response.body, response.status);
  }

  async runIntentEffect(run, effect) {
    const storage = this.storage;
    const { operation, pageId, key } = run;
    switch (effect.type) {
      case "persist":
        if (effect.state === "reserved") {
          run.row = await reserveOperation(storage, {
            key,
            retry: run.retry,
            entry: {
              fingerprint: run.digest,
              pending: true,
              pageId,
              createdAt: new Date().toISOString(),
              // The Page applies a lifecycle request only at this revision.
              expectedRevision: effect.expectedRevision,
            },
          });
          // The capacity check holds while the slot stays reserved. The
          // intent and its slot commit in one write.
          if (effect.slot)
            await storage.put({
              [key]: run.row,
              ...lifecycleSlot(
                operation,
                pageId,
                key,
                undefined,
                await this.slotPlacement(operation, pageId),
              ),
            });
          else await storage.put(key, run.row);
          return;
        }
        // Once forwarded, the Page may apply the request, so its slot can no
        // longer simply expire. The output gate holds the Page request until
        // this write is durable.
        if (effect.state === "forwarded") run.row.forwarded = true;
        if (effect.expectedRevision !== undefined)
          run.row.expectedRevision = effect.expectedRevision;
        if (effect.receipt) {
          run.row.receipt = effect.receipt;
          run.row.pending = false;
        }
        await storage.put(key, run.row);
        return;
      case "reserve_slot":
        await storage.put(
          lifecycleSlot(
            operation,
            pageId,
            key,
            undefined,
            await this.slotPlacement(operation, pageId),
          ),
        );
        return;
      case "release_slot":
        await releaseLifecycleSlot(storage, operation, pageId, key);
        return;
      case "delete_intent":
        await storage.delete(key);
        return;
      case "sync":
        await storage.sync();
        return;
      case "project":
        // A replayed receipt may be older than the Page's current state.
        await projectLifecycle(storage, pageId, effect.current);
        return;
      case "forget_trash":
        await storage.delete(`trash/${pageId}`);
        return;
      case "notify_tombstone":
        await this.notifyTombstone(pageId);
        return;
      case "forward":
        return this.forwardIntent(run, effect);
      case "check_leaf":
        return this.checkLeaf(pageId);
    }
    throw new Error(`An operation intent can't run ${effect.type}`);
  }

  /** The leaf guard as a `leaf` event. It runs requireLeafPage whatever the
   * Page's revision, settling children's unsettled reservations first. */
  async checkLeaf(pageId) {
    try {
      await this.requireLeafPage(pageId);
      return { type: "leaf" };
    } catch (error) {
      if (error.code === replies.unsettled.body.code) return { type: "leaf", unavailable: true };
      const refusal = leafRefusalOf(error);
      if (!refusal) throw error;
      return { type: "leaf", refusal };
    }
  }

  /** Forward the request to its Page and return the Page's answer as a
   * `page_reply`. An unread failure is kept to pass through unchanged. */
  async forwardIntent(run, effect) {
    const { request, operation, args, pageId } = run;
    if (operation === "restore_page") await this.settleRestoreParent(pageId);
    let response;
    try {
      response = await this.env.PAGES.getByName(pageId).fetch(
        forwarded(request, lifecycleRoutes[operation], {
          ...callerLifecycleArguments(args),
          page_id: pageId,
          ...(effect.expectedRevision !== undefined && {
            expected_revision: effect.expectedRevision,
          }),
          ...(effect.replayOnly && { replay_only: true }),
        }),
      );
    } catch (error) {
      logFailure(error, "catalog");
      return { type: "page_reply", unavailable: true };
    }
    run.reply = response;
    if (!response.ok) {
      const rejected = response.headers.get("x-pages-lifecycle-rejected");
      return {
        type: "page_reply",
        status: response.status,
        ...(rejected === "before-change" && { rejected }),
      };
    }
    const { receipt, current } = await response.json();
    // A restore's receipt reports where this Catalog's projection, the next
    // effect, puts the Page.
    if (operation === "restore_page" && receipt?.restored === true && current?.state === "active") {
      const { location } = await restoreTarget(this.storage, pageId);
      const spaceId = location.parent_id
        ? projectOf(await locationEntries(this.storage), location.parent_id)
        : (location.space_id ?? null);
      if (spaceId || location.parent_id)
        Object.assign(receipt, { space_id: spaceId, parent_id: location.parent_id });
    }
    const known = await knownRevision(this.storage, pageId);
    return {
      type: "page_reply",
      status: response.status,
      receipt,
      current,
      ...(known !== undefined && { known }),
    };
  }

  /** What a new lifecycle request needs before it is reserved: the leaf
   * guard for Trash, room at its destination, and the lifecycle revision
   * this account last observed for the Page. */
  async newIntentFacts(run) {
    const { operation, pageId } = run;
    const storage = this.storage;
    if (operation === "delete_page") await this.requireLeafPage(pageId);
    const slotKey = lifecycleSlotKey(operation, pageId);
    let destination = "none";
    if (slotKey) {
      // The check counts this Page's own slot first, removing it when stale.
      run.capacity = await this.capacity(slotPrefix[operation], run.limit, slotKey);
      run.capacity.limit = run.limit;
      const entry = await storage.get(slotKey);
      destination = !entry
        ? run.capacity.room
          ? "room"
          : "full"
        : entry.reservation
          ? "taken"
          : "entry";
    }
    const revision = await observedLifecycleRevision(storage, pageId);
    return { type: "request", operation, pageId, destination, revision };
  }

  /** What a pending request needs before it continues. Capacity, and for
   * Trash the leaf guard, are read only when it no longer holds its slot. */
  async pendingIntentFacts(run, state) {
    const storage = this.storage;
    const { operation, pageId, key } = run;
    const entry = state.slot === "live" ? await storage.get(slotPrefix[operation] + pageId) : null;
    const event = { type: "request", expired: entry ? !(entry.expires_at > Date.now()) : false };
    if (holdsSlot(state, event.expired)) return { event, state };
    const slotKey = lifecycleSlotKey(operation, pageId);
    run.capacity = await this.capacity(slotPrefix[operation], run.limit, slotKey);
    run.capacity.limit = run.limit;
    event.capacity = run.capacity.room;
    // Counting may have removed this intent's own expired slot.
    state = { ...state, slot: (await intentState(storage, key, operation, pageId)).slot };
    // A trash that lost its slot never applied (an applied one leaves a real
    // Trash entry), so it runs the leaf guard again before it may apply: a
    // child can have arrived since.
    if (event.capacity && operation === "delete_page") {
      const refusal = await this.leafRefusal(pageId, state);
      event.leaf = refusal ? "refused" : "ok";
      if (refusal) event.refusal = refusal;
    }
    return { event, state };
  }

  /** The leaf guard for a resumed trash that lost its slot. If the Page's
   * lifecycle is still at the intent's revision, forwarding would apply the
   * request, so a new child refuses it here. If the lifecycle moved,
   * forwarding replays a recorded receipt or comes back superseded, and the
   * machine runs the guard again before any retarget. */
  async leafRefusal(pageId, state) {
    const current = await this.boundedLifecycle(pageId, Date.now() + lifecycleBounds.passMs);
    if (current.state !== "active" || (current.revision ?? 0) !== state.expectedRevision) return;
    try {
      await this.requireLeafPage(pageId);
    } catch (error) {
      const refusal = leafRefusalOf(error);
      if (!refusal) throw error;
      return refusal;
    }
  }

  /** A new Page's Catalog location from create_page's space_id and
   * parent_id: `{ location, rekeyed }`. A parent implies its Project, which
   * is derived from the parent's root; naming a different Project is an
   * error. Without a parent the Page is a root, in the named Project or in
   * Your items. Only Pages and Projects this account owns can hold new Pages
   * in this build, so this account's own entries settle parent, depth and
   * sibling order, and the Project record confirms the Project.
   */
  async resolveLocation(request, args) {
    const storage = this.storage;
    const spaceArg =
      args.space_id === undefined || args.space_id === null
        ? null
        : requireSpaceIdArgument(args.space_id);
    const parentId =
      args.parent_id === undefined || args.parent_id === null
        ? null
        : requirePageIdArgument(args.parent_id, "parent_id");
    if (parentId) await this.activeParent(parentId);
    const entries = await locationEntries(storage);
    if (parentId) {
      const parent = deriveLocation(entries, parentId);
      if (!parent.ok)
        throw new HttpError(
          409,
          "The parent Page's location can't be resolved",
          "parent_unavailable",
        );
      if (spaceArg && parent.space_id !== spaceArg)
        throw new HttpError(
          400,
          "parent_id is not in that Project. Omit project_id: a parent implies its Project.",
          "placement_mismatch",
        );
      // Depth is the model's: a root is at depth 1, and the new Page sits one
      // below its parent. Project top-level Pages are roots until they move
      // under the home Page, so today a Project chain also starts at depth 1;
      // once the home Page is the Project's root, its top-level Pages are at
      // depth 2 and that chain holds one level fewer.
      if (parent.depth + 1 > MAX_DEPTH)
        throw new HttpError(
          400,
          `Pages nest at most ${MAX_DEPTH} levels deep`,
          "nesting_depth_exceeded",
        );
      const { position, rekeyed } = appendPosition(entries, parentId, null);
      return { location: { parent_id: parentId, position }, rekeyed };
    }
    if (spaceArg) {
      const entry = await storage.get(`space/${spaceArg}`);
      if (!entry || entry.pending) throw spaceNotFound();
      const response = await this.env.PROJECTS.getByName(spaceArg).fetch(
        forwarded(request, "/internal/space/read", { space_id: spaceArg }),
      );
      if (response.status === 404) throw spaceNotFound();
      if (!response.ok) throw new HttpError(503, "Project is temporarily unavailable");
    }
    const { position, rekeyed } = appendPosition(entries, null, spaceArg);
    return {
      location: { parent_id: null, position, ...(spaceArg && { space_id: spaceArg }) },
      rekeyed,
    };
  }

  /** The parent's Catalog entry when it can take a new child: owned, created
   * and not in Trash. A trash slot (even one still being reserved) counts as
   * Trash, so a child is never created under a Page that is leaving. The slot
   * is counted first, so one that went stale no longer holds the parent. */
  async activeParent(parentId) {
    const storage = this.storage;
    await countSlot(storage, `trash/${parentId}`, {
      current: (pageId) => this.pageLifecycle(pageId),
    });
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
    const storage = this.storage;
    const entry = await storage.get(`page/${pageId}`);
    if (!entry) return;
    if (entry.home)
      throw new HttpError(
        409,
        "A Project's home Page stays with its Project; it can't move to Trash on its own",
        "home_page_protected",
      );
    const unsettled = [];
    for (const child of (await listAll(storage, "page/")).values()) {
      if (!child?.page_id || child.page_id === pageId) continue;
      const trashed = await storage.get(`trash/${child.page_id}`);
      const parent =
        child.parent_id ?? (child.reservation && trashed ? (trashed.parent_id ?? null) : null);
      if (parent !== pageId) continue;
      if (child.reservation || trashed?.reservation) unsettled.push(child.page_id);
      else throw hasChildren();
    }
    await this.settleReservations(unsettled);
    for (const childId of unsettled) {
      const child = await storage.get(`page/${childId}`);
      if (child && !child.reservation) throw hasChildren();
    }
  }

  /** Settle several Pages' reservations within one budget: at most
   * `lifecycleBounds.concurrency` reads at a time, each bounded, and no read
   * starts after the pass deadline. An exhausted budget refuses the request
   * as retryable instead of holding the Catalog queue. */
  async settleReservations(pageIds, deadline = Date.now() + lifecycleBounds.passMs) {
    const queue = [...pageIds];
    const failures = [];
    const worker = async () => {
      while (queue.length && !failures.length) {
        try {
          await this.settleReservation(queue.shift(), deadline);
        } catch (error) {
          failures.push(error);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(lifecycleBounds.concurrency, queue.length) }, worker),
    );
    if (failures.length) throw failures[0];
  }

  /** Reconcile a Page's pending Trash or restore reservation with the Page,
   * the authority for its lifecycle. A transition the Page already applied is
   * projected into this account's entries; an unapplied one keeps its
   * reservation, since its intent may still apply on retry. A reservation
   * whose intent is no longer pending is stale and removed. When the Page
   * can't answer, the caller is refused rather than left to guess. Each
   * reservation is a `settle` event for its operation intent. */
  async settleReservation(pageId, deadline = Date.now() + lifecycleBounds.passMs) {
    const storage = this.storage;
    for (const key of [`page/${pageId}`, `trash/${pageId}`]) {
      const entry = await storage.get(key);
      if (!entry?.reservation) continue;
      const { response } = await runSlot(storage, key, entry, { type: "settle" }, (id) =>
        this.boundedLifecycle(id, deadline),
      );
      if (response) throw new HttpError(response.status, response.body.error, response.body.code);
    }
  }

  /** A Page's lifecycle read within `deadline`, or a retryable refusal. */
  async boundedLifecycle(pageId, deadline) {
    const left = deadline - Date.now();
    if (left <= 0) throw lifecycleUnsettled();
    try {
      return await this.pageLifecycle(pageId, Math.min(lifecycleBounds.readMs, left));
    } catch (error) {
      logFailure(error, "lifecycle-state");
      throw lifecycleUnsettled();
    }
  }

  /** Where a pending restore returns its Page: the parent (or a root's
   * Project) its Trash entry records. */
  async slotPlacement(operation, pageId) {
    if (operation !== "restore_page") return undefined;
    const entry = await this.storage.get(`trash/${pageId}`);
    return entry && !entry.reservation
      ? { space_id: entry.space_id ?? null, parent_id: entry.parent_id ?? null }
      : undefined;
  }

  /** Settle the restoring Page's parent's Trash reservation, so a trash that
   * already applied is projected before this restore's projection decides
   * whether the parent can still hold it. */
  async settleRestoreParent(pageId) {
    const storage = this.storage;
    const parentId = (await storage.get(`trash/${pageId}`))?.parent_id;
    if (parentId && (await storage.get(`trash/${parentId}`))?.reservation)
      await this.settleReservation(parentId);
  }

  async createSpace(request, identity, args, limit) {
    const storage = this.storage;
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
          `This prototype permits ${SPACE_LIMIT} Projects per account`,
          "project_capacity",
        );
      await this.requirePageRoom(limit);
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
          ...homeLocation(intent.spaceId),
        },
      });
    }
    return this.completeSpaceCreation(request, key, intent);
  }

  /** Run the creation lifecycle from its persisted state. Each effect is
   * idempotent; its outcome is persisted with the next state before the
   * following effect starts, so a retry resumes where the last one stopped. */
  async completeSpaceCreation(request, key, intent) {
    const storage = this.storage;
    intent.phase ??= "reserved";
    for (let effect = spaceCreationEffect(intent.phase); effect; ) {
      let event;
      if (effect === "create_space_record") {
        const response = await this.env.PROJECTS.getByName(intent.spaceId).fetch(
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
            ...homeLocation(intent.spaceId),
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
    const storage = this.storage;
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
    const response = await this.env.PROJECTS.getByName(intent.spaceId).fetch(
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
      if (inspected.entry && failure.code === "project_revision_conflict") {
        const current = await this.env.PROJECTS.getByName(intent.spaceId).fetch(
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
      throw new HttpError(400, "get_project takes only project_id");
    const entry = await this.storage.get(`space/${spaceId}`);
    if (entry?.pending)
      throw new HttpError(
        409,
        "This Project is still being created. Retry create_project with the same idempotency_key and payload.",
        "project_pending",
      );
    const response = await this.env.PROJECTS.getByName(spaceId).fetch(
      forwarded(request, "/internal/space/read", { space_id: spaceId }),
    );
    if (!response.ok) return response;
    const space = await response.json();
    if (entry && entry.updated_at < space.updated_at) {
      await this.storage.put(`space/${spaceId}`, {
        ...entry,
        title: space.title,
        description: space.description,
        updated_at: space.updated_at,
      });
      await markSpaceIndexDirty(this.storage);
    }
    return json(space);
  }

  /** Spaces this account owns, newest change first. D1 rows choose
   * candidates; each must match this account's own `space/` entry, which
   * supplies what is returned. */
  async listSpaces(request, identity, args) {
    const storage = this.storage;
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
        const db = await withTimeout(
          catalogIndexDatabase(this.env, this.ctx),
          catalogIndexTimeouts.read,
        );
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

  /** Child IDs of a Page another account owns, from that account's
   * Catalog. Only its owner's Catalog records what sits under it. */
  async childIdsFromOwner(owner, parentId) {
    try {
      if (typeof owner !== "string") throw Error("Shared Page check named no owner");
      const response = await withTimeout(
        this.env.CATALOGS.getByName(owner).fetch(locationRequest({ children_of: parentId })),
        catalogIndexTimeouts.verify,
        "Owner location read timed out",
      );
      if (!response.ok) throw Error(`Owner location read failed: ${response.status}`);
      const { children } = await response.json();
      // An exhaustive child listing checks each child with its Page host, so
      // it reads at most SHARED_CHILDREN_LIMIT of them.
      return Array.isArray(children)
        ? children.filter(validPageId).slice(0, SHARED_CHILDREN_LIMIT)
        : [];
    } catch (error) {
      logFailure(error, "catalog-location");
      throw new HttpError(503, "Shared Pages are temporarily unavailable");
    }
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
  async listPages(request, identity, args, limit) {
    const options = parseListArguments(args);
    const storage = this.storage;
    if (options.inTrash) await pruneTombstonedTrash(storage);
    if (options.spaceId) {
      // Only the owner can see a Space in this build, and the owner's own
      // entry records it. A Space the caller can't see looks missing.
      const space = await storage.get(`space/${options.spaceId}`);
      if (!space || space.pending) throw spaceNotFound();
    }
    // This account's entries record where each owned Page is, and its
    // Project is derived from them. A listing builds the map once. The same
    // scan counts every key, which checks the stored counts: a build that
    // wrote keys without them leaves them wrong until this repairs them.
    const { entries: locations, counts } = await locationScan(storage);
    if (await storage.verifyCounts(counts)) logCountRepair(counts);
    const quota = { limit, count: counts["page/"], trash_count: counts["trash/"] };
    // Child IDs of a shared parent, from its owner's Catalog.
    let sharedChildren;
    if (typeof options.parentId === "string") {
      if (locations.get(options.parentId)?.state === "active") {
        if (options.spaceId && projectOf(locations, options.parentId) !== options.spaceId)
          throw new HttpError(400, "parent_id is not in that Project", "placement_mismatch");
      } else {
        // Children of a Page shared with this account: the caller must be
        // able to read the parent before learning what sits under it.
        const shared = await this.verifyShared(request, options.parentId);
        if (shared.status === "unavailable")
          throw new HttpError(503, "Shared Pages are temporarily unavailable");
        if (shared.status !== "ok" || (shared.page.state && shared.page.state !== "active"))
          throw new HttpError(404, "Parent Page not found", "parent_unavailable");
        sharedChildren = await this.childIdsFromOwner(shared.page.owner, options.parentId);
      }
    }
    const located = (pageId) => {
      const entry = locations.get(pageId);
      if (!entry) return false;
      if (options.spaceId && projectOf(locations, pageId) !== options.spaceId) return false;
      if (options.parentId === null && entry.parent_id !== null) return false;
      if (options.parentId && entry.parent_id !== options.parentId) return false;
      return true;
    };
    const filtered = options.spaceId !== null || options.parentId !== undefined;
    // Children of a shared parent come from its owner's Catalog, so a
    // rejected one may be a Page the caller can't see at all. That listing
    // checks every child before it paginates; see scanCandidates.
    const scope = { locations, located, sharedChildren, exhaustive: !!sharedChildren };
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
        quota,
        ...(await issueRetryToken(storage, {
          scope: `catalog:${identity.principal}`,
          principal: identity.principal,
        })),
      });
    const after = options.cursor ? await openCursor(this.env, context, options.cursor) : null;
    const epoch = catalogIndexEpoch(this.env);
    let db;
    let source;
    // D1 rows don't carry the location derived from this account's entries,
    // so a listing filtered by Project or parent reads the entries.
    if (epoch && !filtered) {
      try {
        db = await withTimeout(catalogIndexDatabase(this.env, this.ctx), catalogIndexTimeouts.read);
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
        result = await this.scanCandidates(request, identity, source, options, scope, after, db);
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
        // Children of a shared parent are the IDs its owner's Catalog
        // returned, whether or not this account has discovered them.
        sharedChildren
          ? childIdSource(sharedChildren)
          : await catalogSource(storage, {
              inTrash: options.inTrash,
              needle: options.needle,
              owned: (entry) => located(entry.page_id),
              // Shared Pages are never in a Project here, and never under a
              // parent this account owns.
              shared: !options.spaceId && options.parentId === undefined,
            }),
        options,
        scope,
        after,
        null,
      )),
      source: "catalog",
    };
    const response = json({
      pages: result.pages,
      limit: options.limit,
      next_cursor: result.next ? await sealCursor(this.env, context, result.next) : null,
      quota,
      ...(await issueRetryToken(storage, {
        scope: `catalog:${identity.principal}`,
        principal: identity.principal,
      })),
    });
    response.headers.set("x-pages-catalog-source", result.source);
    return response;
  }

  async scanCandidates(request, identity, source, options, scope, after, db) {
    const storage = this.storage;
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
        // This account's entries record location; a candidate row only chose it.
        if (!options.inTrash && !scope.located(row.page_id)) return null;
        return {
          page_id: row.page_id,
          title,
          created_at: entry.created_at ?? row.created_at,
          updated_at: row.updated_at,
          ...(entry.trashed_at ? { trashed_at: entry.trashed_at } : {}),
          ...(options.inTrash && trashFields({ ...entry, page_id: row.page_id })),
          // Top-level Pages in Your items keep the original row shape.
          ...publicLocation(scope.locations, row.page_id),
        };
      }
      // Pages in a Project belong to its owner in this build, and only owned
      // Pages hold sub-pages: a shared Page is listed under a parent only
      // when that parent's owner lists it as a child.
      if (options.inTrash || options.spaceId) return null;
      if (options.parentId !== undefined && !scope.sharedChildren?.includes(row.page_id))
        return null;
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
      // A shared Page's parent shows only under a parent the caller can
      // already read; its Project never shows.
      // A child found through its parent's owner has no discovery time; the
      // host's title observation stands in.
      const observed = row.updated_at || result.page.title_observed_at;
      return {
        page_id: row.page_id,
        title,
        created_at: row.created_at ?? observed,
        updated_at: observed,
        shared: true,
        ...(options.parentId !== undefined && { parent_id: options.parentId }),
      };
    };
    const limit = options.limit;
    // A bounded scan may stop on rejected candidates and return a cursor
    // over them. That is safe only when every candidate is already disclosed
    // to the caller: its own entries, or Pages it discovered. Candidates from
    // another account's Catalog are not, so an exhaustive scan checks them
    // all (at most one owner's Catalog limit, 8 at a time) and returns a
    // cursor only when another authorized result follows the page.
    const scanBound = scope.exhaustive ? Infinity : limit * 2 + 16;
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
      if (creation && this.metadata) logCreationIntentConflict(creation.metadata, this.metadata);
      await this.initializeRepo(this.metadata ?? creation?.metadata);
      // The commit phase lived only in memory: the durable record and any
      // creation intent decide what boot installs or loads.
      const { effects } = pageLifecycle.step(this.lifecycleState(), {
        type: "boot",
        record: recordOf(this.metadata),
        creation: creation ? recordOf(creation.metadata) : null,
      });
      await this.applyLifecycle(effects, { intent: creation });
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

  /** Finish a recorded creation intent. An installed record wins over it, so
   * a replay never undoes a later Trash, restore or ACL change. */
  async finishCreation(intent) {
    await this.applyLifecycle(this.metadata ? CREATION_REPLAY : CREATION_COMMIT, { intent });
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
      readAccess: (identity) => this.policy.account(identity),
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

  /** Presence describes a call that already succeeded; it never fails it. */
  publishAgentPresence(identity, type, targetsOf, observedHeads) {
    try {
      const doc = this.handle.doc();
      const heads = observedHeads ?? A.getHeads(doc);
      const targets = targetsOf(doc).map((target) =>
        target.kind === "block" || target.heads ? target : { ...target, heads },
      );
      this.activityState().agentEvent(identity, type, targets);
    } catch (error) {
      logFailure(error, "agent-presence");
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
    // A projection that times out clears the cached title below, so the next
    // request to this Page sends it again.
    const tasks = recipients.map((principal) =>
      withTimeout(
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
        serialQueueBounds.projectionMs,
        "Catalog projection timed out",
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
          reportPageIndex(this.env, this.ctx, { metadata: this.metadata, ...details }),
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
        restrictPageIndex(this.env, this.ctx, metadata, revision),
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
      await withTimeout(
        retirePageIndex(this.env, this.ctx, this.metadata),
        catalogIndexTimeouts.write,
      );
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
    // Both paths hold the request until it settles (request-hold.mjs): a save
    // waits for heads and drains the record store's own serialized flush.
    if (["/api/sync", "/api/saved"].includes(new URL(request.url).pathname)) {
      const running = this.run(request);
      holdUntilSettled(this.ctx, running);
      return running;
    }
    const next = this.tail.then(() => this.run(request));
    this.tail = next.catch(() => {});
    holdUntilSettled(this.ctx, next);
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
            await this.settleLifecycle();
          } catch (error) {
            logFailure(error, "lifecycle-state");
            const failed = pageLifecycle.step(this.lifecycleState(), { type: "commitFailed" });
            return this.lifecycleReply(failed.response);
          }
        }
        return json(this.metadata ? this.lifecycleCurrent() : { state: "missing" });
      }
      if (url.pathname === "/internal/tombstone") {
        // A pending trash or restore would otherwise rewrite its record over
        // the tombstone when it settles.
        if (this.pendingLifecycle) await this.settleLifecycle();
        return await this.acceptTombstone();
      }
      identity = await authenticate(request, this.env);
      // An ambiguous storage failure retains the exact proposed ACL/receipt.
      // Normal HTTP work retries that barrier before reading or changing it.
      if (this.pendingAccess && !["/api/sync", "/api/saved"].includes(url.pathname))
        await this.installAccess(this.pendingAccess);
      // Likewise a lifecycle transition whose barrier failed completes first.
      if (this.pendingLifecycle && !["/api/sync", "/api/saved"].includes(url.pathname))
        await this.settleLifecycle();
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
              // Location lives in the owner's Catalog; the receipt there adds it.
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
        "/internal/trash": "trash",
        "/internal/restore": "restore",
        "/internal/purge": "purge",
      }[url.pathname];
      if (lifecycle) {
        try {
          return await this.lifecycle(request, identity, lifecycle);
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
          if (
            body.operation === "read_page" &&
            result.status === 200 &&
            state !== "trashed" &&
            Array.isArray(result.body?.heads)
          ) {
            // Native edits can land while authority is issued. Capture the
            // targets on the revision the agent read; cursors carry them forward.
            const heads = result.body.heads;
            this.publishAgentPresence(
              identity,
              "read",
              (doc) => readTargets(A.view(doc, heads), body.arguments ?? {}, result.body),
              heads,
            );
          }
          if (state === "trashed" && result.body && typeof result.body === "object")
            result.body.trash = publicTrash(this.metadata);
          // The gateway asks the owner's Catalog where this Page is and shows
          // the caller what they may see of it.
          if (body.operation === "read_page" && result.status === 200 && result.body)
            result.body._owner = this.metadata.owner;
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
        // Where this batch landed, captured inside the change so the cursors
        // name the characters it wrote. A replayed receipt has no caret.
        let caret = null;
        const receipt = await documentMutation({
          storage: this.ctx.storage,
          admission: this.admission,
          handle: this.handle,
          operation: body.operation,
          args: body.arguments,
          identity,
          prepare: images.length
            ? async () => {
                if (images.length > 100)
                  throw new HttpError(400, "Provide up to 100 operations", "invalid_edit_selector");
                for (const image of images) {
                  try {
                    validateImageInsertion(image);
                  } catch (error) {
                    throw new HttpError(400, error.message, "invalid_edit_selector");
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
              const trace = [];
              const result = applyPageOperation(doc, {
                operation: body.operation,
                arguments: effectiveArgs,
                identity: publicIdentity(identity),
                trace,
              });
              if (["edit_page", "patch_page"].includes(body.operation)) {
                try {
                  caret = writeTargets(doc, trace);
                } catch (error) {
                  logFailure(error, "agent-presence");
                }
              }
              return result;
            } catch (error) {
              // The batch cannot apply as written: zero or multiple matches, an
              // unknown block, operation or mark, or an invalid comment target.
              throw new HttpError(
                400,
                error.message,
                error.code ??
                  (body.operation === "edit_page" || body.operation === "patch_page"
                    ? "invalid_edit_selector"
                    : "invalid_comment_selector"),
              );
            }
          },
          flush: () => this.flush(),
        });
        this.cacheTitle();
        this.handle.broadcast({
          kind: "tool-edit",
          identity: {
            ...publicIdentity(identity),
            ...(identity.agent && { agent: identity.agent }),
            ...(identity.session && { session: identity.session }),
          },
          heads: receipt.heads,
        });
        if (caret)
          this.publishAgentPresence(identity, "write", () =>
            caret.map((target) =>
              target.kind === "block" ? target : { ...target, heads: receipt.heads },
            ),
          );
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
   * who never had access, so it discloses nothing. Company view discloses
   * nothing either. */
  disclosesDeletion(principal) {
    return pageRelation(this.metadata, principal) !== "none";
  }

  /** A trashed Page is disclosed like a deleted one: only to its owner and
   * current viewer/editor grant holders. */
  hiddenWhileTrashed(identity) {
    return pageState(this.metadata) === "trashed" && !this.disclosesDeletion(identity?.principal);
  }

  /** The state page-lifecycle.mjs reads: the installed record, the
   * memory-only commit phase and the deletion barrier flag.
   */
  lifecycleState() {
    return hostState({
      metadata: this.metadata,
      pending: this.pendingLifecycle,
      deletionFinished: this.deletionFinished,
    });
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
    };
  }

  lifecycleResponse(receipt) {
    return json({ receipt, current: this.lifecycleCurrent() });
  }

  /** Interpret an owner Catalog's trash, restore or purge request. run() has
   * settled any pending commit, hidden a trashed Page from everyone without a
   * grant, and loaded a trashed Page's document. This observes what the
   * transition reads, steps page-lifecycle, and runs its effects in order.
   */
  async lifecycle(request, identity, route) {
    requireWrite(identity);
    const owner = pageRelation(this.metadata, identity.principal) === "owner";
    const actor = owner
      ? "owner"
      : this.disclosesDeletion(identity.principal)
        ? "member"
        : "stranger";
    // A non-owner is refused before the body is read.
    if (!owner) {
      const type = route === "purge" ? "purgeConfirm" : route;
      return this.lifecycleReply(
        pageLifecycle.step(this.lifecycleState(), { type, actor }).response,
      );
    }
    const args = await readJson(request);
    if (args.page_id !== this.metadata.pageId) throw new HttpError(400, "Invalid page_id");
    const type =
      route !== "purge" ? route : args.action === "preview" ? "purgePreview" : "purgeConfirm";
    const event = { type, actor };
    const context = { args, identity };
    if (type !== "purgePreview") {
      const key = mutationKey(args);
      // The Catalog adds compare-and-set controls; they never change identity.
      const { expected_revision: _expected, replay_only: _replay, ...requested } = args;
      const digest = await fingerprint(LIFECYCLE_OPERATIONS[route], requested, identity);
      const recorded = await this.ctx.storage.get(lifecycleReceiptKey(key));
      Object.assign(context, { key, digest, recorded });
      event.key = !recorded ? "fresh" : recorded.fingerprint === digest ? "recorded" : "conflict";
      if (event.key === "recorded") event.recorded = summarizeReceipt(recorded.receipt);
      if (args.expected_revision !== undefined) {
        // A malformed revision never matches, so it is superseded like a
        // request whose slot the Catalog could not hold.
        if (Number.isSafeInteger(args.expected_revision) && args.expected_revision >= 0)
          event.expected = args.expected_revision;
        else event.replayOnly = true;
      }
      if (args.replay_only === true) event.replayOnly = true;
      if (
        type === "purgeConfirm" &&
        pageState(this.metadata) === "deleted" &&
        this.metadata.deletion
      )
        event.deletion = summarizeReceipt(this.metadata.deletion.receipt);
    }
    let state = this.lifecycleState();
    if (
      type === "purgeConfirm" &&
      event.key === "fresh" &&
      state.name === "trashed" &&
      !isSuperseded(state, event)
    ) {
      const verified = this.metadata;
      const doc = this.handle.doc();
      event.preview = await checkPurgePreview(
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
      if (
        event.preview === "valid" &&
        (this.metadata !== verified || !sameHeads(A.getHeads(this.handle.doc()), A.getHeads(doc)))
      )
        event.preview = "changed";
      state = this.lifecycleState();
    }
    // No await from the head guard to the policy-visible record.
    if (type === "trash")
      event.heads = this.handle ? headsCheck(this.handle.doc(), args.base_heads) : "invalid";
    const result = pageLifecycle.step(state, event);
    if (result.effects.length) {
      this.prepareLifecycle(type, state, context);
      await this.applyLifecycle(result.effects, context);
    }
    return this.lifecycleReply(result.response, context);
  }

  /** Build the records a transition commits: the next record, its receipt,
   * and the pending commit that `begin` installs.
   */
  prepareLifecycle(type, state, context) {
    const { key, digest, identity } = context;
    const metadata = this.metadata;
    const pageId = metadata.pageId;
    const revision = metadata.lifecycleRevision ?? 0;
    if (type === "trash") {
      if (state.name === "trashed") {
        context.record = this.lifecycleRecord("trash_page", digest, metadata.trash.receipt);
        context.receipt = context.record.receipt;
        return;
      }
      const now = new Date().toISOString();
      const receipt = {
        page_id: pageId,
        state: "trashed",
        trashed: true,
        title: catalogTitle(this.handle.doc().title),
        trashed_at: now,
        trashed_by: identity.principal,
        trash_root_id: pageId,
      };
      const next = {
        ...metadata,
        deleted: true,
        lifecycleRevision: revision + 1,
        trash: trashRecord({ pageId, principal: identity.principal, now, receipt }),
        // Builds that predate Trash read only `deletion`: their delete retry
        // conflicts, and a fresh key completes an ordinary permanent deletion.
        deletion: { key, fingerprint: digest, receipt: { page_id: pageId, deleted: true } },
      };
      context.next = next;
      context.pending = {
        operation: "trash_page",
        key,
        record: this.lifecycleRecord("trash_page", digest, receipt, revision + 1),
        metadata: next,
      };
      context.receipt = receipt;
      return;
    }
    if (type === "restore") {
      const title = catalogTitle(this.handle.doc().title);
      if (state.name === "active") {
        context.record = this.lifecycleRecord("restore_page", digest, {
          page_id: pageId,
          state: "active",
          restored: false,
          title,
        });
        context.receipt = context.record.receipt;
        return;
      }
      const { trash: _trash, deletion: _deletion, ...rest } = metadata;
      const next = { ...rest, deleted: false, lifecycleRevision: revision + 1 };
      // Where the Page returns is the owner's Catalog's decision; it adds the
      // location to this receipt.
      const receipt = {
        page_id: pageId,
        state: "active",
        restored: true,
        title,
        restored_at: new Date().toISOString(),
      };
      context.pending = {
        operation: "restore_page",
        key,
        record: this.lifecycleRecord("restore_page", digest, receipt, revision + 1),
        metadata: next,
      };
      context.receipt = receipt;
      return;
    }
    // A deleted record repeats its barriers; nothing new is recorded.
    if (type === "purgeConfirm" && state.name === "trashed") {
      const receipt = { page_id: pageId, deleted: true, purged: true };
      context.next = {
        ...metadata,
        lifecycleRevision: revision + 1,
        purged: { purged_at: new Date().toISOString(), purged_by: identity.principal },
        deletion: { key, fingerprint: digest, receipt },
      };
      context.pending = {
        operation: "purge_page",
        key,
        record: this.lifecycleRecord("purge_page", digest, receipt, revision + 1),
      };
      context.receipt = receipt;
    }
  }

  /** Run page-lifecycle effects in order. If one fails, a begun phase stays in
   * `pendingLifecycle` and the next request repeats its sequence (commitOk).
   */
  async applyLifecycle(effects, context = {}) {
    for (const effect of effects) await this.lifecycleEffect(effect, context);
  }

  async lifecycleEffect(effect, context) {
    const pending = this.pendingLifecycle;
    switch (effect.type) {
      case "withdrawAccess":
        // Access is withdrawn before the record is durable, like an ACL
        // reduction. Disconnected peers rebroadcast profiles as they close.
        this.metadata = context.next;
        return;
      case "begin":
        this.pendingLifecycle = context.pending;
        return;
      case "restrictIndex":
        // Removes non-owner listing rows before the record is durable.
        if (catalogIndexEpoch(this.env)) await this.restrictIndex(this.metadata);
        return;
      case "putRecord":
        if (!effect.receipt) await this.ctx.storage.put("host/document", this.metadata);
        else if (pending)
          await this.commitLifecycle(
            pending.key,
            pending.record,
            effect.record ? (pending.metadata ?? this.metadata) : undefined,
          );
        else await this.commitLifecycle(context.key, context.record);
        return;
      case "sync":
        await this.ctx.storage.sync();
        return;
      case "install":
        if (context.intent) {
          this.metadata = context.intent.metadata;
          this.observeActivity();
          this.admission ??= new DocumentAdmission(
            this.backend,
            documentIdToBinary(this.metadata.documentId),
          );
        } else this.metadata = pending.metadata;
        return;
      case "refreshAccess":
        await this.policy.refreshAccess();
        this.activity?.prune();
        return;
      case "projectTitle":
        this.cachedTitle = undefined;
        this.cacheTitle();
        return;
      case "retireIndex":
        await this.retireIndex();
        return;
      case "closePolicy":
        this.recordMaintenance?.stop();
        this.activity?.close();
        await this.policy.close();
        for (const wire of this.wires) await wire.disconnect();
        return;
      case "deleteDocument":
        await this.repo.delete(this.metadata.documentId);
        return;
      case "flush":
        // A deleted document has nothing left in the repo to flush.
        if (pageState(this.metadata) !== "deleted")
          await this.repo.flush([this.metadata.documentId]);
        await this.backend.flush();
        await this.recordStore?.flush?.();
        return;
      case "finishDeletion":
        // Barriers are complete for this process; a restart repeats them.
        this.deletionFinished = true;
        return;
      case "dropDocument":
        this.handle = undefined;
        return;
      case "loadDocument":
        await this.loadDocument();
        return;
      case "importDocument":
        this.handle = await this.repo.import(context.intent.bytes, {
          docId: context.intent.metadata.documentId,
        });
        // Before its record is installed, `install` starts presence instead.
        if (this.metadata) this.observeActivity();
        return;
      case "deleteCreation":
        await this.ctx.storage.delete("host/creation");
        return;
      case "end":
        this.pendingLifecycle = undefined;
        return;
      default:
        throw new Error(`Unknown lifecycle effect ${effect.type}`);
    }
  }

  /** Repeat a pending commit's sequence from its first step (commitOk). A
   * failure leaves the phase for the next request.
   */
  async settleLifecycle() {
    const { effects } = pageLifecycle.step(this.lifecycleState(), { type: "commitOk" });
    await this.applyLifecycle(effects);
  }

  /** The HTTP reply a page-lifecycle response describes. */
  async lifecycleReply(response, context = {}) {
    if (response.status >= 500) return json({ error: response.error }, response.status);
    if (response.status !== 200) {
      const reply = errorResponse(
        new HttpError(response.status, response.error, response.code),
        "page-lifecycle",
      );
      // Every refusal before the record changes lets the Catalog release its
      // reservation, as for a rejected creation.
      if (response.beforeChange) reply.headers.set("x-pages-lifecycle-rejected", "before-change");
      return reply;
    }
    switch (response.reply) {
      case "receipt":
        return this.lifecycleResponse(context.receipt);
      case "recorded":
        return this.lifecycleResponse(context.recorded.receipt);
      case "deletion":
        return this.lifecycleResponse(this.metadata.deletion.receipt);
      case "superseded":
        return this.supersededResponse();
      case "preview": {
        const doc = this.handle.doc();
        return json({
          page_id: this.metadata.pageId,
          ...publicTrash(this.metadata),
          ...purgeImpact(this.metadata, doc),
          heads: A.getHeads(doc),
          ...(await issuePurgePreview(
            this.ctx.storage,
            this.metadata,
            doc,
            context.identity.principal,
          )),
        });
      }
      case "current":
        return json(this.metadata ? this.lifecycleCurrent() : { state: "missing" });
      case "state":
        return json({ state: response.state });
    }
    throw new Error(`Unknown lifecycle reply ${response.reply}`);
  }

  /** The owner's Catalog holds a permanent-deletion tombstone for this Page.
   * Only a trashed record can disagree with it: a build without Trash deleted
   * the document but left the record. Record that deletion so the Page answers
   * like a missing one instead of retrying an absent document.
   */
  async acceptTombstone() {
    const result = pageLifecycle.step(this.lifecycleState(), { type: "tombstone" });
    const context = {};
    if (result.effects.length)
      context.next = {
        ...this.metadata,
        lifecycleRevision: (this.metadata.lifecycleRevision ?? 0) + 1,
        purged: { purged_at: new Date().toISOString(), reason: "deleted_by_earlier_build" },
      };
    await this.applyLifecycle(result.effects, context);
    return this.lifecycleReply(result.response);
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

  /** The Page, account and member socket quotas. Returns the refusal for a
   * connection over one, or undefined. */
  connectionCapacity(identity) {
    const full = (message) =>
      withAdmissionReason(new HttpError(429, message), "connection_capacity");
    if (this.wires.size >= 24) return full("Too many connected peers");
    const principals = [...this.wirePrincipals.values()];
    if (principals.filter((principal) => principal === identity.principal).length >= 4)
      return full("Too many connections for this account");
    if (
      identity.principal !== this.metadata.owner &&
      principals.filter((principal) => principal !== this.metadata.owner).length >= 20
    )
      return full("Member connection capacity reached");
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
    const capacity = this.connectionCapacity(identity);
    if (capacity) return refuseSocket(capacity, identity);
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
