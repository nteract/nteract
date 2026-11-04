import * as N from "@automerge/subduction";
import { isTokenedRequest } from "../model/retry-key.mjs";
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
  insertedAssets,
} from "../model/page.mjs";
import { insertOperation } from "../model/node-registry.mjs";
import {
  documentFeatures,
  missingFeatures,
  parseDeclaredFeatures,
  requireSupportedSchema,
  schemaUnsupported,
  unsupportedFeatures,
} from "../model/schema-features.mjs";
import { unsupportedMarkdown, unsupportedMarkdownError } from "../model/richtext.mjs";
import { convertPreservedBlocks, hasPreservedBlocks } from "../model/raw-migration.mjs";
import { commentsGenesis } from "../model/comments-doc.mjs";
import { applyComment, commentsMigrated } from "../model/comments.mjs";
import { guardCommentIntent } from "../model/comment-guard.mjs";
import {
  copyLegacyThreads,
  detachLegacyComments,
  needsCommentsMigration,
} from "../model/comments-migration.mjs";
import { CommentAdmission } from "./comment-admission.mjs";
import { commentsDocUuid, commentsDocumentId, commentsTreeOf } from "./comments-store.mjs";
import {
  conversionFenceError,
  conversionFenced,
  conversionNotice,
  conversionRetryDelay,
  permanentFailure,
  preservedConversionMachine,
} from "./preserved-conversion.mjs";
import { readTargets, writeTargets } from "../model/agent-presence.mjs";
import { BACKEND_LIMITS, assertDocumentLimits, assertIntentSize } from "../model/limits.mjs";
import { handleMcp } from "../mcp.mjs";
import {
  REPLAYED_RECEIPT_HEADER,
  declaredLabels,
  logUsage,
  mcpClientLabel,
  requestClient,
  takeReplayedReceipt,
  usageDropped,
  usageOperation,
} from "./usage.mjs";
import {
  RENAMED_TOOLS,
  invalidArguments,
  invokeProjectApi,
  unknownOperation,
  withRefusalCode,
} from "./project-api.mjs";
import { agentGuideResponse } from "../agent-guide.mjs";
import { connectAgentResponse } from "../connect-agent.mjs";
import { handleOAuth, mcpAuthChallenge } from "./oauth.mjs";
import { sessionStoreReady } from "./isolate-setup.mjs";
import { signInCallbackOptions } from "./sign-in-failure.mjs";
import { localOidcStore } from "./local-oidc-store.mjs";
import { WebSocketByteTransport } from "../shared/byte-transport.mjs";
import { MISSING_EDITS_MESSAGE } from "../shared/receipts.mjs";
import { openingTitleWarning } from "../model/title-warning.mjs";
import { pagePreview } from "../model/page-preview.mjs";
import { cardKey, pageCard } from "../model/page-card.mjs";
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
import {
  INTERNAL_PREFIX,
  listOperationEntries,
  issueRetryToken,
  inspectOperation,
  reserveOperation,
} from "./operation-journal.mjs";
import { BufferedRecordStore, RemoteRecordSink } from "./record-persistence.mjs";
import { RecordMaintenance } from "./record-maintenance.mjs";
import { guardContext, guardStub } from "./storage-guard.mjs";
import {
  HOST_SENDER_ID,
  PlainSync,
  clearPlainStorage,
  clearPrefixes,
  plainSessionReplaced,
  writeMigratedHistory,
} from "./plain-sync.mjs";
import {
  migrationSlot,
  migrationStart,
  recordStorageMigrated,
  recordStorageMigration,
} from "./record-storage-migration.mjs";
import { logSyncRefused, logSyncRounds } from "./plain-sync-log.mjs";
import { BLOCKING as BLOCKING_COMMENT_CODES } from "../sync/comments.mjs";
import {
  ActorAuthorship,
  commitAuthor,
  loadActorEntries,
  observeRecordSaves,
  ActorPersistence,
  MAX_ATTESTED_CHANGES,
  STORAGE_KEYS_PER_CALL,
  loadCommitAuthors,
  replayAuthor,
} from "./actor-authorship.mjs";
export { PageRecords } from "./record-persistence.mjs";
import {
  COMMENTS_SCOPE,
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
import { RECORD_STORAGE_MODES } from "../shared/record-storage.mjs";
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
  COMMENTS_DOC,
  PAGE_DOC,
  documentMutation,
  recoverDocumentMutations,
  replayRecordedMutation,
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
  countSlot,
  intentState,
  listAll,
  knownRevision,
  lifecycleSlot,
  lifecycleSlotKey,
  observedLifecycleRevision,
  lifecycleIndexItem,
  projectLifecycle,
  pruneTombstonedTrash,
  refreshCatalogTitle,
  releaseLifecycleSlot,
  runSlot,
  trashFields,
} from "./catalog.mjs";
import { holdsSlot, operationIntent, replies } from "./operation-intent.mjs";
import {
  CONTENT_ACTIVITY_KEY,
  ContentActivity,
  acceptedTime,
  changesContent,
  laterTime,
  validTime,
} from "./content-activity.mjs";
import { PAGE_CARD_KEY, PageCardWriter } from "./page-card-writer.mjs";
import { allowedPageCards, parsePageCardIds, readPageCards } from "./page-cards.mjs";
import {
  CatalogIndexUnavailable,
  SHORT_CURSOR_MAX_LENGTH,
  catalogIndexDatabase,
  catalogIndexEpoch,
  catalogIndexTimeouts,
  catalogSource,
  childIdSource,
  indexOwnedEntries,
  indexSource,
  indexedState,
  listScope,
  listingRestricted,
  markCatalogIndexDirty,
  coolIndex,
  markPagesForIndex,
  markSpaceIndexDirty,
  openCursor,
  openListingCursor,
  positionOf,
  parseListArguments,
  reconcileSpaceIndex,
  spaceCatalogSource,
  spaceIndexSource,
  pruneIndexRows,
  readIndexCooldown,
  reconcileAccountIndex,
  reportContentActivity,
  reportPageIndex,
  restrictPageIndex,
  retirePageIndex,
  sealCursor,
  sealPosition,
  settlePageMark,
  titleMatches,
  withTimeout,
} from "./catalog-index.mjs";
import { readRegistration, requireRegistrationAccount, validPageId } from "./registration.mjs";
import {
  handleImageAssets,
  requireStoredDatasetAsset,
  requireStoredImageAsset,
} from "./image-assets.mjs";
// The host check for each stored asset kind a node can name
// (INSERT_OPERATIONS in model/node-registry.mjs).
const ASSET_CHECKS = Object.freeze({
  image: requireStoredImageAsset,
  dataset: requireStoredDatasetAsset,
});
import {
  appendPosition,
  childrenOf,
  homeEntry,
  locationAnswer,
  locationEntries,
  locationScan,
  parentActive,
  projectOf,
  publicLocation,
  receiptLocation,
  movedTrashEntries,
  rekeyedEntries,
  restoreTarget,
} from "./catalog-location.mjs";
import {
  LOCATION_SHAPE_KEY,
  MIGRATION_REQUIRED,
  migrateLocationShape,
  shapeState,
} from "./location-shape.mjs";
import { LOCATION_REVISION_KEY, movePage } from "./move-page.mjs";
import {
  MAX_DEPTH,
  deriveLocation,
  planMove,
  subtreeOf,
  validPosition,
} from "../model/location.mjs";
import {
  SPACE_LIMIT,
  homePageMarkdown,
  newSpaceId,
  requirePageIdArgument,
  requireSpaceIdArgument,
  spaceNotFound,
  validSpaceId,
  validateSpaceInput,
} from "./spaces.mjs";
// The class name is the storage identity for Projects; see spaces.mjs.
export { Space } from "./spaces.mjs";
import { spaceCreationEffect, spaceCreationTransition } from "./space-lifecycle.mjs";
import { handleImportPageImage } from "./import-image.mjs";
import { countedStorage } from "./catalog-counts.mjs";
import { forwardedPageLimit, quotaError, quotaRefusal, resolvePageQuota } from "./page-quota.mjs";
import { serialQueue, serialQueueBounds } from "./serial-queue.mjs";
import { opensIndex } from "./account-index-machine.mjs";
import { holdUntilSettled } from "./request-hold.mjs";
import { boundedMap } from "./bounded-map.mjs";
import { legibleEnv } from "./host-busy.mjs";
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
import { pageStartup, recordFallback, startupOf, storedTitleProjection } from "./page-startup.mjs";

const operations = new Set([
  "list_pages",
  // The library grid's cards. /api/tools only: no MCP tool describes it.
  "page_cards",
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
  "move_page",
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
/** The error an abandoned object refuses with when its reset gave no reason. */
const abandonedError = () => Object.assign(Error("Page object was reset"), { status: 503 });
/** Complete the upgrade and close at once with the refusal's admission code.
 * A browser reads a refused HTTP upgrade only as close 1006, which its
 * reconnect treats as transient; the close code lets it count the refusal. */
/** A bounded, content-free reason for a failed conversion run. */
function failureReason(error) {
  if (isHistoryCapacityError(error)) return "history_capacity";
  if (error?.conversion) return "conversion_error";
  if (typeof error?.code === "string") return error.code.slice(0, 64);
  if (Number.isInteger(error?.status)) return `status_${error.status}`;
  return "storage_or_runtime";
}
/** One structured line when a Page's preserved blocks can't be converted:
 * its Page ID, like `page.creation_intent_conflict`, and a bounded reason,
 * never content. DEPLOYMENT.md describes the recovery. */
function logPreservedStuck(pageId, reason) {
  console.error(
    JSON.stringify({
      service: "nteract-pages-native",
      event: "page.preserved_markdown_stuck",
      page_id: pageId,
      reason,
      timestamp: new Date().toISOString(),
    }),
  );
}
/** The record storage a new Page gets. `PAGES_RECORD_STORAGE=automerge` selects
 * plain Automerge sync (worker/plain-sync.mjs); existing Pages keep the mode
 * they were created with. */
export function recordStorageFor(env) {
  if (env.PAGES_RECORD_STORAGE === "automerge") return "automerge";
  return nativeRecordStorage(env);
}

const nativeRecordStorage = (env) =>
  env.PAGES_ASYNC_PERSISTENCE === "true" ? "buffered" : "local";

/** A registered draft keeps the storage its browser replica already uses.
 * A plain Automerge draft registers only where `PAGES_RECORD_STORAGE` allows
 * plain storage: a build without plain sync refuses such a Page at boot, so a
 * host with the flag off must stay rollback-safe. The refusal comes before
 * any creation is recorded, and the browser re-creates the draft natively. */
export function registeredRecordStorage(env, args) {
  if (args.record_storage !== "automerge") return nativeRecordStorage(env);
  if (recordStorageFor(env) === "automerge") return "automerge";
  throw new HttpError(
    409,
    "This host doesn't accept plain Automerge Pages",
    "record_storage_unsupported",
  );
}

/** Viewer builds that speak plain Automerge sync send `sync=automerge` on
 * the socket. An older build is refused an `automerge` Page's socket as
 * schema_unsupported, which it shows as "Reload to update". Discovery stays
 * open to every reader: scripts use it as an access probe. */
function requirePlainSyncClient(request) {
  if (new URL(request.url).searchParams.get("sync") === "automerge") return;
  throw withAdmissionReason(schemaUnsupported(["automerge-sync"]), "schema_unsupported");
}

/** One structured line when the native per-author check refuses a comment
 * change: the Page, the rule it broke, never content. */
function logCommentRefused(pageId, reason) {
  console.error(
    JSON.stringify({
      service: "nteract-pages-native",
      event: "page.comment_change_refused",
      page_id: pageId,
      code: reason?.code,
      timestamp: new Date().toISOString(),
    }),
  );
}
/** Keys of journal entries for document `doc` still pending with changes. */
async function pendingEntryKeys(storage, doc) {
  return [...(await listOperationEntries(storage))]
    .filter(([, entry]) => entry.pending && entry.changes && (entry.doc ?? PAGE_DOC) === doc)
    .map(([key]) => key);
}
function refuseSocket(error, identity) {
  logAdmissionDenied(error, { stage: "page", identity });
  const pair = new WebSocketPair();
  const socket = pair[1];
  socket.accept();
  socket.close(admissionCloseCode(error), admissionCode(error));
  return new Response(null, { status: 101, webSocket: pair[0] });
}
/** The most children of a shared parent one listing request checks. Each is
 * a Page host read made while the caller's Catalog queue waits, so this stays
 * fixed whatever the owner's Page limit is; a cursor reaches the rest. */
export const sharedChildBounds = { scan: 100 };
/** Shared-Page checks one listing runs at once, each to a different Page
 * host. The caller's Catalog queue waits on the whole listing, so its checks
 * overlap; this bounds how many requests one Catalog has out at a time. */
export const sharedCheckBounds = { concurrency: 16 };
/** How long a Page host waits on one card object read or write. */
const PAGE_CARD_STORE_TIMEOUT_MS = 10_000;
/** How long a deletion waits on the card object's delete. */
const PAGE_CARD_DELETE_TIMEOUT_MS = 2_000;
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
/** `{ title, observed_at, keep }`: the title this Page host last projected to
 * the Catalogs and the index, when it first observed it, and whether writers
 * holding that title keep their own time (`titleObservation`). */
const TITLE_PROJECTION_KEY = "host/title-projection";
/** `true` while a projection of the title to the owner's and members'
 * Catalogs hasn't been seen to land everywhere. Written before the title it
 * sends is stored, removed once every Catalog took it. A check from the host
 * record boots while it is set, so the loaded host's first check sends the
 * title again (`cacheTitle`). */
const PROJECTION_PENDING = "host/title-projection/pending";
/** The least time between two stores of the same title projection after a
 * failed one (retryTitleStore). */
const TITLE_STORE_RETRY_MS = 30_000;
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
const LIFECYCLE_OPERATIONS = {
  trash: "trash_page",
  restore: "restore_page",
  purge: "purge_page",
};
/** A request's base_heads as requireHeads judges them, or `absent` when the
 * request omitted them. The lifecycle machine decides what absence means. */
function headsCheck(doc, heads) {
  if (heads === undefined) return "absent";
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
const publicIdentity = ({ principal, displayName, driver }) => ({
  principal,
  displayName,
  driver,
});
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
  // Refused before any reservation, so the agent can rewrite and retry.
  const unsupported = args.markdown && unsupportedMarkdown(args.markdown);
  if (unsupported) throw unsupportedMarkdownError(unsupported);
}

/**
 * move_page's arguments as the Catalog runs them: `{ pageId, parentId,
 * spaceId, position }`. Every refusal here is deterministic input, so it
 * consumes no key and runs no shape pass. The destination is any of:
 * - `parent_id`: under that Page, in whichever container it sits (a Project
 *   or Your items);
 * - `space_id` (the API's `project_id`, mapped by the Project API) naming a
 *   Project: its top level, under its home Page;
 * - `space_id: null`: a root in Your items.
 * Both together must agree (`placement_mismatch`). Naming neither is
 * `move_destination_required`, the one destination this tool can't place.
 * `spaceId` is undefined when no Project was named. The retry_token is
 * required: a move's lost answer is reconciled by replaying its receipt.
 */
function validateMoveInput(args) {
  const pageId = requirePageIdArgument(args.page_id);
  const hasParent = args.parent_id !== undefined && args.parent_id !== null;
  const hasSpace = Object.hasOwn(args, "space_id") && args.space_id !== undefined;
  if (!hasParent && !hasSpace)
    throw new HttpError(
      400,
      "Name a destination: parent_id (a Page to move under), project_id (a Project's top level), or project_id: null (Your items).",
      "move_destination_required",
    );
  if (hasParent && validSpaceId(args.parent_id))
    throw new HttpError(
      400,
      "parent_id expects a Page ID, but this is a Project ID. To move a Page to the Project's top level, pass it as project_id instead.",
      "project_id_as_page_id",
    );
  const parentId = hasParent ? requirePageIdArgument(args.parent_id, "parent_id") : null;
  const spaceId = !hasSpace
    ? undefined
    : args.space_id === null
      ? null
      : requireSpaceIdArgument(args.space_id);
  const position = args.position === undefined ? "last" : args.position;
  if (!validPosition(position))
    throw new HttpError(
      400,
      'position is "first", "last", {"before": page_id} or {"after": page_id}',
      "invalid_position",
    );
  if (typeof args.retry_token !== "string")
    throw new HttpError(
      400,
      "move_page needs the retry_token from list_pages and a v1_ idempotency_key built from its retry_key_prefix",
      "invalid_retry_token",
    );
  return { pageId, parentId, spaceId, position };
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
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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
  const internal = forwarded(request, "/internal/assets/authorize", {
    page_id: pageId,
    write,
  });
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

const READ_OPERATIONS = [
  "list_pages",
  "page_cards",
  "read_page",
  "read_page_changes",
  "list_page_comments",
  "read_page_presence",
  "list_spaces",
  "get_space",
];

/** Whether repeating `operation` after a lost answer is safe: a read, a
 * progress renewal or clear (the lease names its session), or a write whose
 * retry_token holds its receipt. A progress creation is not: a repeat mints a
 * second session and the first one's lease is lost, so it gets lease advice. */
const safeToRepeat = (operation, args) => {
  if (operation === "report_page_progress")
    return typeof args?.progress_id === "string" && typeof args?.lease_token === "string"
      ? true
      : "lease";
  return READ_OPERATIONS.includes(operation) || isTokenedRequest(args);
};

async function invoke(request, env, operation, args = {}, seen) {
  if (!operations.has(operation)) throw unknownOperation(operation, operations);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw invalidArguments();
  const identity = await authenticate(request, env);
  if (seen) seen.identity = identity;
  if (!READ_OPERATIONS.includes(operation)) requireWrite(identity);
  if (["get_space", "update_space"].includes(operation)) requireSpaceIdArgument(args.space_id);
  if (operation === "page_cards") return await pageCards(request, env, identity, args);
  if (
    [
      "list_pages",
      "create_page",
      "move_page",
      ...Object.keys(lifecycleRoutes),
      ...spaceOperations,
    ].includes(operation)
  ) {
    const body = {
      operation,
      arguments: args,
      ...(await quotaFields(env, identity, operation)),
    };
    return withinToolDeadline(
      async (signal) =>
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
      { safe: safeToRepeat(operation, args) },
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
  return withinToolDeadline(
    async (signal) => {
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
    },
    { safe: safeToRepeat(operation, args) },
  );
}

/**
 * page_cards (page-cards.mjs). The caller's Catalog answers which IDs it
 * allows, from inside its serial queue; the card objects are read here,
 * after that queue has moved on, so a slow bucket never holds the account's
 * listings or writes. Only the allowed IDs reach the bucket.
 */
async function pageCards(request, env, identity, args) {
  const ids = parsePageCardIds(args.page_ids);
  const body = { operation: "page_cards", arguments: { page_ids: ids } };
  const decided = await withinToolDeadline(async (signal) => {
    const response = await untilAborted(
      env.CATALOGS.getByName(identity.principal).fetch(
        forwarded(request, "/internal/catalog", body),
        { signal },
      ),
      signal,
    );
    return { status: response.status, body: await readResponseJson(response, signal) };
  });
  if (decided.status !== 200) return json(decided.body, decided.status);
  const allowed = Array.isArray(decided.body?.allowed) ? decided.body.allowed : [];
  const bucket = env.PAGES_ASSETS;
  const cards = await readPageCards(ids, bucket ? allowed : [], {
    readObject: async (key) => {
      const object = await bucket.get(key);
      return object ? await object.text() : null;
    },
    onError: (error) => logFailure(error, "page-cards"),
  });
  return json({ cards, principal: decided.body.principal ?? identity.principal });
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
    chain.unshift({
      kind: "page",
      page_id: ancestors[index],
      title: catalogTitle(parent.title),
    });
  }
  const reachedRoot = location.complete && chain.length === location.ancestors.length;
  if (location.parent_id && chain.at(-1)?.page_id === location.parent_id)
    body.parent_id = location.parent_id;
  const space = location.space_id
    ? await readable(
        env.PROJECTS,
        location.space_id,
        forwarded(request, "/internal/space/read", {
          space_id: location.space_id,
        }),
      )
    : null;
  if (space) {
    body.space_id = location.space_id;
    if (!location.parent_id) body.parent_id = null;
    if (location.home) body.home = true;
    // The whole chain is visible to whoever can read the Project in this build.
    if (reachedRoot)
      chain.unshift({
        kind: "space",
        space_id: space.space_id,
        title: space.title,
      });
    // The home Page stands for its Project; viewers may fold its crumb into
    // the Project's.
    for (const crumb of chain)
      if (crumb.kind === "page" && crumb.page_id === space.home_page_id) crumb.home = true;
  }
  body.breadcrumbs = chain;
}

/** Operation names a usage event may record: internal operations, the
 * public tool names that map onto them, and browser registration. */
const USAGE_OPERATIONS = new Set([...operations, ...Object.values(RENAMED_TOOLS), "register_page"]);

/** Records one usage event for a tool call (or, for MCP, a resource list or
 * read) on `surface` once its response is known. `seen` collects the identity
 * the caller authenticated. A create_page that created a Page also records
 * page.create with its id; a replayed receipt records only the call. */
function toolUsage(request, surface, operation, args, kind = "tool") {
  const started = Date.now();
  const seen = {};
  const labels = requestClient(request);
  return {
    seen,
    async finish(received) {
      const { response, replayed } = takeReplayedReceipt(received);
      try {
        const name = usageOperation(operation, USAGE_OPERATIONS);
        const length = Number(response.headers.get("content-length"));
        const common = {
          surface,
          identity: seen.identity,
          labels,
          operation: name,
          kind,
          pageId: args?.page_id,
          projectId: args?.project_id,
          status: response.status,
          outcome: response.ok ? "ok" : `http_${response.status}`,
          latencyMs: Date.now() - started,
        };
        logUsage({
          action: "tool.call",
          ...common,
          bytes: length || undefined,
        });
        if (name === "create_page" && response.ok && !replayed) {
          const body = await response.clone().json();
          logUsage({
            action: "page.create",
            ...common,
            pageId: body?.page_id,
            projectId: body?.project_id ?? common.projectId,
          });
        }
      } catch {
        // Usage telemetry never fails the request.
        usageDropped();
      }
      return response;
    },
  };
}

export default {
  async fetch(request, env) {
    // celld answers a stub fetch to a saturated object itself, with a plain
    // 503; the gateway is the first code that can name it (host-busy.mjs).
    return advertiseBuild(request, await gateway.fetch(request, legibleEnv(env)));
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
        return json({
          ok: true,
          prototype: "pages-celld-native",
          ...buildAdvertisement(),
        });
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
      if (url.pathname === "/oidc")
        return completeServerOidcLogin(request, env, noop, signInCallbackOptions);
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
                // The storage a Page created in this browser should use.
                ...(recordStorageFor(env) === "automerge" && {
                  recordStorage: "automerge",
                }),
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
        const identity = await authenticate(request, env);
        return await handleMcp(
          request,
          async (operation, args, { kind = "tool" } = {}) => {
            const usage = toolUsage(request, "mcp", operation, args, kind);
            // A refusal before invoke() authenticates still names the caller.
            usage.seen.identity = identity;
            let response;
            try {
              response = await invokeProjectApi(
                (internal, internalArgs) =>
                  invoke(request, env, internal, internalArgs, usage.seen),
                operation,
                args,
              );
            } catch (error) {
              response = errorResponse(error, "mcp-operation");
            }
            return usage.finish(response);
          },
          env,
          {
            onInitialize: (params) => {
              const declared = declaredLabels(request);
              const mcpClient = mcpClientLabel(params.clientInfo);
              logUsage({
                action: "mcp.initialize",
                surface: "mcp",
                identity,
                labels: {
                  ...declared,
                  ...(!declared.client && mcpClient && { client: mcpClient }),
                  ...(mcpClient && { mcp_client: mcpClient }),
                },
                protocolVersion: params.protocolVersion,
              });
            },
          },
        );
      }
      if (url.pathname === "/api/pages/register" && request.method === "POST") {
        const started = Date.now();
        const identity = await authenticate(request, env);
        requireWrite(identity);
        const args = await readJson(request);
        const quota = await quotaFields(env, identity, "register_page");
        const { response, replayed } = takeReplayedReceipt(
          await withinToolDeadline(async (signal) =>
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
          ),
        );
        // The browser creates a Page by registering it; a retry that replays
        // the stored receipt created nothing.
        if (response.ok && !replayed)
          logUsage({
            action: "page.create",
            surface: "browser-sync",
            identity,
            labels: requestClient(request),
            operation: "register_page",
            pageId: args?.page_id,
            status: response.status,
            outcome: "ok",
            latencyMs: Date.now() - started,
          });
        return response;
      }
      if (url.pathname === "/api/tools" && request.method === "POST") {
        let response;
        let usage = toolUsage(request, "http-tools");
        try {
          const body = await readJson(request);
          usage = toolUsage(request, "http-tools", body?.operation, body?.arguments);
          response = await invokeProjectApi(
            (internal, internalArgs) => invoke(request, env, internal, internalArgs, usage.seen),
            body.operation,
            body.arguments,
            { env },
          );
        } catch (error) {
          response = errorResponse(error, "gateway");
        }
        return await withRefusalCode(await usage.finish(response));
      }
      const imageRoute = url.pathname.match(/^\/api\/pages\/([^/]+)\/assets(?:\/([^/]+))?$/);
      if (imageRoute) {
        const [, pageId, assetId] = imageRoute;
        // API-key clients upload here too; their refusals get a code as on /api/tools.
        return await withRefusalCode(
          await handleImageAssets(request, env, {
            pageId,
            assetId,
            authorize: (write) => authorizeImage(request, env, pageId, write),
          }),
        );
      }
      if (url.pathname === "/api/access") {
        await authenticate(request, env);
        const pageId = url.searchParams.get("page");
        if (!validPageId(pageId)) throw new HttpError(400, "Invalid page_id", "invalid_page_id");
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
    return (this.counted ??= countedStorage(this.ctx.storage, {
      ctx: this.ctx,
    }));
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
  /** Room at a lifecycle request's destination: `{ room, count, limit }`.
   * Restore applies the account's Page limit, and Trash the same limit, except
   * that a paused account (limit 0) can always move Pages to Trash. Its Trash
   * then holds at most the Pages it already had, since it can't create more. */
  async destinationCapacity(run, slotKey) {
    const limit = run.limit;
    const exempt = run.operation === "delete_page" && limit === 0;
    const capacity = await this.capacity(
      slotPrefix[run.operation],
      exempt ? Infinity : limit,
      slotKey,
    );
    return { ...capacity, limit };
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
        new Request("https://pages.internal/internal/tombstone", {
          method: "POST",
        }),
      );
    } catch (error) {
      logFailure(error, "catalog-tombstone");
    }
  }
  /**
   * The Catalog's location shape, brought up to date. Every queued write
   * runs this once its input is sound and before it reserves or writes
   * anything; a `migrated` record costs one read (location-shape.mjs).
   * Location writes need `migrated`; other writes and every read run in
   * either shape, because a Page's Project is derived from its root in both.
   */
  async locationShape() {
    return migrateLocationShape(this.storage);
  }
  /** Refuse a location write while this Catalog isn't in the current shape.
   * A blocked pass names the Project and Page in its way, in the message and
   * as `reason`, `page_id` and `space_id`; the next write tries again. */
  static requireMigrated(shape) {
    if (shape.name === "migrated") return;
    const detail =
      shape.name === "blocked"
        ? shape.reason === "home_pending"
          ? ` Project ${shape.space_id} is still being created; retry create_project with its original idempotency_key, then retry this. Page ${shape.page_id} waits on it.`
          : ` Page ${shape.page_id} in Project ${shape.space_id} nests too deep to sit under the Project's home Page; trash and purge its deepest sub-page, then retry.`
        : " Retry shortly.";
    throw Object.assign(
      new HttpError(
        503,
        `This account's Pages are being reorganized into their Projects.${detail}`,
        MIGRATION_REQUIRED,
      ),
      shape.name === "blocked" && {
        details: {
          reason: shape.reason,
          page_id: shape.page_id,
          space_id: shape.space_id,
        },
      },
    );
  }
  async run(request) {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/internal/projection" || pathname === "/internal/content-activity") {
        // Reachable only through the host's CATALOGS namespace, never the gateway.
        const value = await readJson(request);
        if (!validPageId(value.page_id)) throw new HttpError(400, "Invalid page_id");
        // A content report never names a title. The projection route also
        // reads a title-less body as one: the first content-activity build's
        // Page hosts send their reports there.
        const contentOnly = pathname === "/internal/content-activity" || value.title === undefined;
        if (
          pathname === "/internal/content-activity" &&
          (value.title !== undefined || value.remove)
        )
          throw new HttpError(400, "A content report carries only page_id and content_updated_at");
        await this.locationShape();
        const key = `${value.shared ? "shared/" : "page/"}${value.page_id}`;
        const previous = await this.storage.get(key);
        // The Page host's newest content time. It only moves forward, and
        // it never moves `updated_at`, which keeps its own meaning. A time
        // further ahead of this clock than nodes skew is dropped.
        const content = laterTime(
          previous?.content_updated_at,
          acceptedTime(value.content_updated_at),
        );
        const contentMoved = content !== null && content !== (previous?.content_updated_at ?? null);
        if (value.remove) await this.storage.delete(key);
        else if (contentOnly) {
          // A content-only report updates an entry that's already listed.
          if (previous && !previous.pending && contentMoved)
            await this.storage.put(key, {
              ...previous,
              content_updated_at: content,
            });
        } else if (
          value.keep_time === true &&
          previous &&
          !previous.pending &&
          previous.title === catalogTitle(value.title)
        ) {
          // The host repeats an observation of the title this entry holds
          // (a restart, a retry): `updated_at` keeps its time.
          if (contentMoved)
            await this.storage.put(key, {
              ...previous,
              content_updated_at: content,
            });
        } else if (
          !previous?.pending &&
          !(await this.storage.get(`host/deleted/${value.page_id}`)) &&
          // A projection observed before trashing must not relist the Page.
          (value.shared || !(await this.storage.get(`trash/${value.page_id}`))) &&
          (!previous?.updated_at || previous.updated_at <= value.observed_at)
        ) {
          // A new entry D1 may not hold, such as a discovery whose host
          // report hasn't landed: the next listing settles its Page's mark.
          if (!previous) await markPagesForIndex(this.env, this.storage, [value.page_id]);
          await this.storage.put(key, {
            ...previous,
            page_id: value.page_id,
            title: catalogTitle(value.title),
            created_at: previous?.created_at ?? value.observed_at,
            updated_at: value.observed_at,
            ...(content && { content_updated_at: content }),
            shared: value.shared === true,
          });
        } else if (previous && !previous.pending && contentMoved)
          // An older title observation still carries a newer content time.
          await this.storage.put(key, {
            ...previous,
            content_updated_at: content,
          });
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
        await this.locationShape();
        await refreshCatalogTitle(this.storage, body);
        return json({ ok: true });
      }
      const args = body.arguments ?? {};
      const limit = forwardedPageLimit(body.page_limit, this.env);
      if (body.operation === "list_pages")
        return await this.listPages(request, identity, args, limit);
      if (body.operation === "page_cards") return await this.pageCards(request, identity, args);
      if (body.operation === "list_spaces") return await this.listSpaces(request, identity, args);
      if (body.operation === "get_space") return await this.getSpace(request, args);
      requireWrite(identity);
      if (body.operation === "create_space")
        return await this.createSpace(request, identity, args, limit);
      if (body.operation === "update_space") return await this.updateSpace(request, identity, args);
      if (body.operation === "move_page") return await this.movePage(identity, args);
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
            throw new HttpError(404, "Page not found", "page_not_found");
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
      // Input is sound: this write runs the shape pass first. Creating,
      // trashing and restoring place a Page, so they also wait for the
      // current shape. Purging removes a Trash entry in either shape.
      const shape = await this.locationShape();
      if (body.operation !== "purge_page") Catalog.requireMigrated(shape);
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
          principal: identity.principal,
        });
      let intent = inspected.entry;
      if (intent && !intent.pending) {
        // A previous attempt may have stored its receipt before sync failed.
        await this.storage.sync();
        const replay = json(intent.receipt);
        replay.headers.set(REPLAYED_RECEIPT_HEADER, "1");
        return replay;
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
      const entry = { ...created, title: catalogTitle(intent.receipt.title) };
      // The mark lands before the entry, so no listing reads D1 without the
      // new Page; the owner's row is written after the response.
      const marks = await markPagesForIndex(this.env, this.storage, [pageId]);
      await this.storage.put({ [key]: intent, [`page/${pageId}`]: entry });
      await this.storage.sync();
      this.indexInBackground(identity.principal, [{ entry, state: "active" }], marks);
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
  async runLifecycle(request, operation, args, { key, digest, inspected, limit, principal }) {
    const storage = this.storage;
    const pageId = args.page_id;
    const run = {
      request,
      operation,
      args,
      pageId,
      key,
      digest,
      retry: inspected.retry,
      limit,
      principal,
    };
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
      case "project": {
        // A replayed receipt may be older than the Page's current state.
        // The mark lands before the projection, so it survives a projection
        // that fails: the next listing settles the Page from whatever entry
        // it has. The owner's row is written after the response.
        const now = new Date().toISOString();
        const item = await lifecycleIndexItem(storage, pageId, effect.current, now);
        const marks = item ? await markPagesForIndex(this.env, storage, [pageId]) : [];
        await projectLifecycle(storage, pageId, effect.current, { marked: true, now });
        if (item) this.indexInBackground(run.principal, [item], marks);
        return;
      }
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
        Object.assign(receipt, {
          space_id: spaceId,
          parent_id: location.parent_id,
        });
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
      run.capacity = await this.destinationCapacity(run, slotKey);
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
    const event = {
      type: "request",
      expired: entry ? !(entry.expires_at > Date.now()) : false,
    };
    if (holdsSlot(state, event.expired)) return { event, state };
    const slotKey = lifecycleSlotKey(operation, pageId);
    run.capacity = await this.destinationCapacity(run, slotKey);
    event.capacity = run.capacity.room;
    // Counting may have removed this intent's own expired slot.
    state = {
      ...state,
      slot: (await intentState(storage, key, operation, pageId)).slot,
    };
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
   * error. A Project alone means its top level: under its home Page, the
   * Project's one root. Neither means a root in Your items. Only Pages and
   * Projects this account owns can hold new Pages in this build, so this
   * account's own entries settle parent, depth and sibling order, and the
   * Project record confirms the Project.
   */
  async resolveLocation(request, args) {
    const storage = this.storage;
    const spaceArg =
      args.space_id === undefined || args.space_id === null
        ? null
        : requireSpaceIdArgument(args.space_id);
    let parentId =
      args.parent_id === undefined || args.parent_id === null
        ? null
        : requirePageIdArgument(args.parent_id, "parent_id");
    if (spaceArg && !parentId) {
      const entry = await storage.get(`space/${spaceArg}`);
      if (!entry || entry.pending) throw spaceNotFound();
      const response = await this.env.PROJECTS.getByName(spaceArg).fetch(
        forwarded(request, "/internal/space/read", { space_id: spaceArg }),
      );
      if (response.status === 404) throw spaceNotFound();
      if (!response.ok) throw new HttpError(503, "Project is temporarily unavailable");
      const home = homeEntry(await locationEntries(storage), spaceArg);
      if (!home) throw spaceNotFound();
      parentId = home.page_id;
    }
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
      // below its parent. A Project's home Page is its root, so its top-level
      // Pages are at depth 2.
      if (parent.depth + 1 > MAX_DEPTH)
        throw new HttpError(
          400,
          `Pages nest at most ${MAX_DEPTH} levels deep`,
          "nesting_depth_exceeded",
        );
      const { position, rekeyed } = appendPosition(entries, parentId);
      return { location: { parent_id: parentId, position }, rekeyed };
    }
    const { position, rekeyed } = appendPosition(entries, null);
    return { location: { parent_id: null, position }, rekeyed };
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

  /**
   * Run one move_page through the move-page machine (move-page.mjs). This
   * method validates the input, runs the shape pass, then feeds the machine
   * what it reads: the journal row, the settled reservations, the plan and
   * the barrier. The machine decides every step; the plan it approves is kept
   * here for the one put. Requests reach this one at a time through the
   * Catalog's queue.
   */
  async movePage(identity, args) {
    const { pageId, parentId, spaceId, position } = validateMoveInput(args);
    // Input is sound: the shape pass runs first, as for every queued write.
    Catalog.requireMigrated(await this.locationShape());
    const run = {
      identity,
      pageId,
      parentId,
      spaceId,
      position,
      key: mutationKey(args),
      digest: await fingerprint("move_page", args, identity),
    };
    let state = { name: "received" };
    let event = await this.inspectMove(run, args.retry_token);
    for (;;) {
      const result = movePage.step(state, event);
      if (result.rejected !== undefined)
        throw new Error(`move_page refused ${event.type}: ${result.rejected}`);
      let next;
      for (const effect of result.effects) next = await this.runMoveEffect(run, effect);
      if (result.response !== undefined) return json(result.response.body, result.response.status);
      if (!next) throw new Error("move_page stopped without a reply");
      ({ state } = result);
      event = next;
    }
  }

  /** The journal's answer for this key as an `inspected` event. Only the
   * two outcomes the machine decides are events; a malformed or expired
   * token is a deterministic input error and throws as every write's does. */
  async inspectMove(run, retryToken) {
    let inspected;
    try {
      inspected = await inspectOperation(this.storage, {
        key: run.key,
        digest: run.digest,
        retryToken,
        scope: `catalog:${run.identity.principal}`,
        principal: run.identity.principal,
      });
    } catch (error) {
      if (error.code === "idempotency_conflict") return { type: "inspected", row: "conflict" };
      throw error;
    }
    run.retry = inspected.retry;
    const row = inspected.entry;
    if (!row) return { type: "inspected", row: "absent" };
    if (row.pending) return { type: "inspected", row: "pending" };
    return { type: "inspected", row: "completed", receipt: row.receipt };
  }

  async runMoveEffect(run, effect) {
    const storage = this.storage;
    switch (effect.type) {
      case "settle":
        try {
          await this.settleReservations([...new Set([run.pageId, run.parentId].filter(Boolean))]);
          return { type: "settled", ok: true };
        } catch (error) {
          if (error.code === replies.unsettled.body.code) return { type: "settled", ok: false };
          throw error;
        }
      case "plan":
        return this.planMoveEvent(run);
      case "write":
        await this.writeMove(run);
        return undefined;
      case "sync":
        try {
          await storage.sync();
          return { type: "synced", ok: true };
        } catch (error) {
          logFailure(error, "catalog-move");
          return { type: "synced", ok: false };
        }
    }
    throw new Error(`move_page can't run ${effect.type}`);
  }

  /**
   * Plan the move as a `planned` event. The model's `planMove` decides over
   * this Catalog's location entries; what it can't see is checked here first:
   * a Page this account only has shared (`not_page_owner`), one still being
   * created (`page_not_found`, as listings hide it), a parent leaving for
   * Trash (its reservation, which the entries skip), and a named Project
   * this account doesn't own (`project_not_found`). A Page can move between
   * containers: from Your items into a Project, out of one to Your items, or
   * from one Project to another. Trashed descendants move with the subtree
   * and are reported apart from the active ones.
   */
  async planMoveEvent(run) {
    const storage = this.storage;
    const { pageId, parentId, spaceId, position } = run;
    const refuse = (code, message) => ({
      type: "planned",
      ok: false,
      code,
      message,
    });
    const { entries } = await locationScan(storage);
    const entry = entries.get(pageId);
    if (!entry) {
      if (await storage.get(`shared/${pageId}`))
        return refuse(
          "not_page_owner",
          "Only the Page's owner can move it; this Page is shared with you",
        );
      return refuse("page_not_found", "Page not found");
    }
    if (entry.state === "pending") return refuse("page_not_found", "Page not found");
    if (parentId && !(await parentActive(storage, parentId)))
      return refuse("parent_unavailable", "The parent Page is missing, pending or in Trash");
    // Access guard for cross-container moves. Where a Page sits decides
    // nothing about who can open it today: Projects are owner-only, and this
    // Catalog holds only its owner's Pages and Projects, so a destination
    // found here is one the caller owns, and the Page's sharing travels with
    // it unchanged. If Project membership ever grants access, a move into,
    // out of or between Projects changes who can open the Page and its
    // sub-pages, and this guard has to re-check that access before planning.
    const destinationSpace =
      typeof spaceId === "string"
        ? spaceId
        : parentId
          ? deriveLocation(entries, parentId).space_id
          : null;
    if (typeof destinationSpace === "string") {
      const record = await storage.get(`space/${destinationSpace}`);
      if (!record || record.pending) return refuse("project_not_found", "Project not found");
    }
    const destination = {
      ...(spaceId !== undefined && { project_id: spaceId }),
      ...(parentId && { parent_id: parentId }),
    };
    const revision = (await storage.get(LOCATION_REVISION_KEY)) ?? 0;
    const plan = planMove({ revision, entries }, pageId, destination, position);
    if (!plan.ok) return refuse(plan.code, plan.message);
    const trashedIds = subtreeOf(entries, pageId)
      .filter(({ page_id }) => entries.get(page_id).state === "trashed")
      .map(({ page_id }) => page_id);
    const trashed = trashedIds.length;
    run.plan = plan;
    run.trashedDescendants = trashedIds;
    run.receipt = {
      page_id: pageId,
      space_id: plan.moved.space_id,
      parent_id: plan.moved.parent_id,
      position: plan.moved.position,
      location_revision: plan.revision,
      descendants: plan.moved.descendants - trashed,
      trashed_descendants: trashed,
    };
    return { type: "planned", ok: true, receipt: run.receipt };
  }

  /**
   * The one put: the moved entry with its new parent and position, the
   * destination siblings the plan rekeyed, the location revision, the
   * completed journal row with its receipt. D1 rows carry no location, so
   * a move writes no index mark.
   * `reserveOperation` checks capacity and writes nothing, so the row goes
   * in with the rest. Storage takes at most STORAGE_KEYS_PER_CALL keys per
   * put, so a large rebalance is several puts inside one transaction; a
   * counted put may add the two count keys to a chunk, so chunks leave room.
   * Trashed descendants' `trash/` entries are rewritten in the same
   * transaction and count toward the same per-put limit.
   */
  async writeMove(run) {
    const storage = this.storage;
    const { pageId, key, plan } = run;
    const row = await reserveOperation(storage, {
      key,
      retry: run.retry,
      entry: {
        fingerprint: run.digest,
        pending: true,
        pageId,
        createdAt: new Date().toISOString(),
      },
    });
    row.pending = false;
    row.receipt = run.receipt;
    const rekeyed = {};
    for (const [id, entry] of Object.entries(plan.entries))
      if (id !== pageId) rekeyed[id] = entry.position;
    const transact = (work) =>
      typeof storage.transaction === "function" ? storage.transaction(work) : work(storage);
    await transact(async (target) => {
      const current = await target.get(`page/${pageId}`);
      if (!current || current.reservation) throw new Error("The moved Page lost its entry");
      const { space_id: _space, home: _home, ...kept } = current;
      const puts = Object.entries({
        ...(await rekeyedEntries(target, rekeyed)),
        [`page/${pageId}`]: {
          ...kept,
          parent_id: plan.moved.parent_id,
          position: plan.moved.position,
        },
        // Trashed sub-pages record the Project they would restore to if
        // their parent is gone by then; after a move that is the
        // destination's Project, or none for Your items.
        ...(await movedTrashEntries(target, run.trashedDescendants ?? [], plan.moved.space_id)),
        [LOCATION_REVISION_KEY]: plan.revision,
        [key]: row,
      });
      // D1 rows carry no location, so a move leaves the account index as it
      // was. Location filters read these entries.
      const perPut = STORAGE_KEYS_PER_CALL - 2;
      for (let at = 0; at < puts.length; at += perPut)
        await target.put(Object.fromEntries(puts.slice(at, at + perPut)));
    });
  }

  async createSpace(request, identity, args, limit) {
    const storage = this.storage;
    const { title, description } = validateSpaceInput(args, { creating: true });
    // A Project write isn't a location write, but it is a queued write: the
    // shape pass runs first. Its home Page is a root in either shape.
    await this.locationShape();
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
      const spaces = await storage.list({
        prefix: "space/",
        limit: SPACE_LIMIT + 1,
      });
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
    return this.completeSpaceCreation(request, key, intent, identity.principal);
  }

  /** Run the creation lifecycle from its persisted state. Each effect is
   * idempotent; its outcome is persisted with the next state before the
   * following effect starts, so a retry resumes where the last one stopped. */
  async completeSpaceCreation(request, key, intent, principal) {
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
        const home = {
          page_id: intent.pageId,
          title: catalogTitle(intent.homeTitle),
          created_at: intent.createdAt,
          updated_at: intent.createdAt,
          ...homeLocation(intent.spaceId),
        };
        // Marked before its entry, as a creation is.
        const marks = await markPagesForIndex(this.env, storage, [intent.pageId]);
        await storage.put({
          [`space/${intent.spaceId}`]: {
            space_id: intent.spaceId,
            title: space.title,
            description: space.description,
            home_page_id: intent.pageId,
            created_at: space.created_at,
            updated_at: space.updated_at,
          },
          [`page/${intent.pageId}`]: home,
        });
        this.indexInBackground(principal, [{ entry: home, state: "active" }], marks);
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
    await this.locationShape();
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
        ...(args.description !== undefined && {
          description: args.description,
        }),
      }),
    );
    if (response.status >= 400 && response.status < 500) {
      const failure = await response.json();
      // A retry past its fence may already have applied before its receipt
      // was evicted, or lost to a newer change. Either way it must not apply
      // now; the outcome is the Space as it is.
      if (inspected.entry && failure.code === "project_revision_conflict") {
        const current = await this.env.PROJECTS.getByName(intent.spaceId).fetch(
          forwarded(request, "/internal/space/read", {
            space_id: intent.spaceId,
          }),
        );
        if (!current.ok) return current;
        intent.receipt = {
          superseded: true,
          applied: false,
          space: await current.json(),
        };
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
    // Project positions are an update time and a Project ID, never a title
    // key, so their cursors keep the short bound.
    const after = args.cursor
      ? await openCursor(this.env, context, args.cursor, undefined, {
          maxLength: SHORT_CURSOR_MAX_LENGTH,
        })
      : null;
    let source;
    const epoch = catalogIndexEpoch(this.env);
    if (epoch) {
      try {
        const db = await withTimeout(
          catalogIndexDatabase(this.env, this.ctx),
          catalogIndexTimeouts.read,
        );
        await reconcileSpaceIndex({
          db,
          storage,
          principal: identity.principal,
          epoch,
        });
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
      next_cursor: more
        ? await sealCursor(this.env, context, {
            updated_at: found[limit - 1].row.updated_at,
            page_id: found[limit - 1].row.page_id,
          })
        : null,
      principal: identity.principal,
      ...(await issueRetryToken(storage, {
        scope: `catalog:${identity.principal}`,
        principal: identity.principal,
      })),
    });
  }

  /** Write owned entries' D1 rows (catalog-index.mjs `indexOwnedEntries`)
   * after this request responds, and settle their Pages' `marks` once they
   * land. Started in the live request and held with waitUntil, so celld
   * runs its I/O to the end (request-hold.mjs). A failed write leaves the
   * marks, which the next listing settles. */
  indexInBackground(principal, items, marks) {
    if (!marks.length) return;
    const work = (async () => {
      try {
        if (!(await indexOwnedEntries(this.env, this.ctx, principal, items))) return;
      } catch (error) {
        logFailure(error, "catalog-index-write");
        return;
      }
      for (const mark of marks) await settlePageMark(this.storage, mark, "indexed");
    })();
    holdUntilSettled(this.ctx, work);
  }

  /** The access step of page_cards (page-cards.mjs): which of up to
   * PAGE_CARDS_MAX IDs the caller may read, each checked as list_pages
   * checks its row. Answers IDs only; the gateway reads the objects outside
   * this queue. Read-only: a refused shared entry is pruned by the next
   * listing that meets it. */
  async pageCards(request, identity, args) {
    const ids = parsePageCardIds(args.page_ids);
    const allowed = await allowedPageCards(ids, {
      storage: this.storage,
      verifyShared: (pageId) => this.verifyShared(request, pageId),
      map: boundedMap,
      checks: sharedCheckBounds.concurrency,
    });
    return json({ allowed, principal: identity.principal });
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
      return Array.isArray(children) ? children.filter(validPageId) : [];
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
   * The cursor is sealed to the caller, query, in_trash and filters (location,
   * kind, access and sort), and rejected rows are pruned on encounter. Rows
   * come back in the candidate source's order; a title sort orders by the
   * source's title snapshot, not the verified title shown.
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
    const quota = {
      limit,
      count: counts["page/"],
      trash_count: counts["trash/"],
    };
    // A listing is a read and runs in either shape. A blocked pass shows
    // here, so a caller refused `location_migration_required` can see what
    // stands in the way without another write.
    const shape = shapeState(await storage.get(LOCATION_SHAPE_KEY));
    const migration =
      shape.name === "blocked"
        ? {
            location_migration: {
              state: "blocked",
              reason: shape.reason,
              page_id: shape.page_id,
              space_id: shape.space_id,
            },
          }
        : {};
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
        // Only a Page's owner places Pages under it, so no child of a shared
        // parent is the caller's own: an owned-only listing of one is empty.
        sharedChildren =
          options.access === "owned"
            ? []
            : await this.childIdsFromOwner(shared.page.owner, options.parentId);
      }
    }
    // A Project's top level (`project_id` with `parent_id: null`) is its home
    // Page and the home Page's children. A Catalog not yet migrated still
    // holds top-level Pages as roots; they list here too.
    const projectHome = options.spaceId
      ? homeEntry(locations, options.spaceId)?.page_id
      : undefined;
    const located = (pageId) => {
      const entry = locations.get(pageId);
      if (!entry) return false;
      if (options.spaceId && projectOf(locations, pageId) !== options.spaceId) return false;
      if (
        options.parentId === null &&
        entry.parent_id !== null &&
        (projectHome === undefined || entry.parent_id !== projectHome)
      )
        return false;
      if (options.parentId && entry.parent_id !== options.parentId) return false;
      return true;
    };
    const filtered = options.spaceId !== null || options.parentId !== undefined;
    // Children of a shared parent come from its owner's Catalog, so a
    // rejected one may be a Page the caller can't see at all. That listing
    // checks every child before it paginates; see scanCandidates.
    const scope = {
      locations,
      located,
      sharedChildren: sharedChildren && new Set(sharedChildren),
      exhaustive: !!sharedChildren,
    };
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
        principal: identity.principal,
        ...(await issueRetryToken(storage, {
          scope: `catalog:${identity.principal}`,
          principal: identity.principal,
        })),
      });
    // A position in this sort's shape (positionOf); the scan and the next
    // cursor keep that shape. `pinned` is the source that issued the cursor,
    // or null for a first page or a cursor from an earlier build.
    const { position: after, source: pinned } = options.cursor
      ? await openListingCursor(this.env, context, options.cursor, options.sort)
      : { position: null, source: null };
    const epoch = catalogIndexEpoch(this.env);
    let db;
    let source;
    // While D1 is cooling after failing a D1 walk, only that kind of walk
    // opens it, so a restart can't pin D1 again (opensIndex).
    const opens = opensIndex({ pinned, cooldown: await readIndexCooldown(storage) });
    // D1 rows don't carry the location derived from this account's entries,
    // so a listing filtered by Project or parent reads the entries.
    if (epoch && !filtered && opens) {
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
        // While D1 may miss a Catalog write, a walk over it would end
        // early with no cursor; the Catalog entries serve while the pass
        // and the Page marks settle. A walk continues on the source that
        // issued its cursor, whatever the account's state now: the two order
        // shared rows differently (LIST_SOURCES). A walk that began on a
        // ready D1 misses at most rows written since it began. If D1 can't
        // serve a walk that began there, it restarts (below).
        if (pinned === "index" || (pinned === null && ready))
          source = indexSource(db, {
            principal: identity.principal,
            domain: evidence?.expiresAt > Date.now() ? evidence.domain : null,
            inTrash: options.inTrash,
            needle: options.needle,
            access: options.access,
            sort: options.sort,
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
    // A walk that began on D1 never continues on the Catalog entries: its
    // position is in D1's order. When D1 can't serve it (the database, the
    // pass or the scan failed, or the index is off), the walk restarts from
    // its first page. The refusal starts a cooldown, during which first
    // pages read the Catalog, so the restart lands there and stays there
    // even if D1 serves first pages and fails later ones. A Catalog walk
    // never needs D1.
    if (!result && pinned === "index") {
      await coolIndex(storage);
      throw new HttpError(
        400,
        "This listing's source is unavailable; restart from the first page",
        "invalid_cursor",
      );
    }
    result ??= {
      ...(await this.scanCandidates(
        request,
        identity,
        // Children of a shared parent are the IDs its owner's Catalog
        // returned, whether or not this account has discovered them.
        sharedChildren
          ? childIdSource(sharedChildren, options.sort)
          : await catalogSource(storage, {
              inTrash: options.inTrash,
              needle: options.needle,
              sort: options.sort,
              owned: options.access === "shared" ? () => false : (entry) => located(entry.page_id),
              // Shared Pages are never in a Project here, and never under a
              // parent this account owns.
              shared:
                options.access !== "owned" && !options.spaceId && options.parentId === undefined,
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
      next_cursor: result.next
        ? await sealPosition(
            this.env,
            { ...context, source: result.source },
            options.sort,
            result.next,
          )
        : null,
      quota,
      principal: identity.principal,
      ...migration,
      ...(await issueRetryToken(storage, {
        scope: `catalog:${identity.principal}`,
        principal: identity.principal,
      })),
    });
    response.headers.set("x-pages-catalog-source", result.source);
    return response;
  }

  /** Up to `options.limit` verified Pages after the position `after`, and the
   * position the next page resumes from, or null. Every position here is
   * `positionOf(options.sort, row)`: the refetch after a rejected candidate
   * and the next cursor resume from the order's key, never a row's own
   * `updated_at`. */
  async scanCandidates(request, identity, source, options, scope, after, db) {
    const storage = this.storage;
    const resumeAt = (row) => positionOf(options.sort, row);
    const pruned = [];
    let stale = false;
    const check = async (row) => {
      // Sources already apply `access`; these guards keep the other kind of
      // row out even if one doesn't, and keep owned-only listings from ever
      // asking a Page host about a shared row.
      if (row.owned ? options.access === "shared" : options.access === "owned") return null;
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
          // D1 indexes an entry with no listing time at '', where the
          // Catalog fallback has no key: both leave the field out.
          created_at: entry.created_at ?? (row.created_at || undefined),
          updated_at: row.updated_at || undefined,
          // Both are this owner's observations of its own Page.
          content_updated_at: laterTime(entry.content_updated_at, row.content_updated_at),
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
      if (options.parentId !== undefined && !scope.sharedChildren?.has(row.page_id)) return null;
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
        created_at: row.created_at || observed,
        updated_at: observed,
        // From the check, never from the candidate row: the caller can read
        // the Page, so when it last changed is theirs to see.
        content_updated_at: validTime(result.page.content_updated_at)
          ? result.page.content_updated_at
          : null,
        shared: true,
        ...(options.parentId !== undefined && { parent_id: options.parentId }),
      };
    };
    const limit = options.limit;
    // A bounded scan may stop on rejected candidates and return a cursor
    // over them. That is safe when every candidate is already disclosed to
    // the caller: its own entries, or Pages it discovered. Candidates from
    // another account's Catalog are not. An exhaustive scan checks up to
    // sharedChildBounds.scan of them per request, sharedCheckBounds at a time. Within that
    // bound it returns a cursor only when another authorized result follows
    // the page. Past it, the sealed cursor continues from the last child
    // checked; it shows the caller only that the parent has more children.
    const scanBound = scope.exhaustive ? sharedChildBounds.scan : limit * 2 + 16;
    const verified = [];
    let position = after;
    let scanned = 0;
    let exhausted = false;
    while (verified.length <= limit && scanned < scanBound) {
      const want = Math.min(limit + 1 - verified.length, scanBound - scanned);
      const rows = await source.next(position, want);
      const checked = await boundedMap(rows, sharedCheckBounds.concurrency, check);
      for (const [index, page] of checked.entries())
        if (page) verified.push({ page, row: rows[index] });
      scanned += rows.length;
      if (rows.length) position = resumeAt(rows.at(-1));
      if (rows.length < want) {
        exhausted = true;
        break;
      }
    }
    // An exhaustive scan that stopped at its bound continues only if another
    // child remains. Its source is in memory, so the check is free.
    if (scope.exhaustive && !exhausted && verified.length <= limit)
      exhausted = (await source.next(position, 1)).length === 0;
    if (db) {
      // A rejected owner row means D1 missed a lifecycle change; reconcile it.
      if (stale) await markCatalogIndexDirty(storage);
      await pruneIndexRows(db, pruned).catch((error) => logFailure(error, "catalog-index-prune"));
    }
    if (verified.length > limit)
      return {
        pages: verified.slice(0, limit).map(({ page }) => page),
        next: resumeAt(verified[limit - 1].row),
      };
    // Only a scan stopped by its bound, not by the end of the candidates,
    // continues from the last scanned row.
    return {
      pages: verified.map(({ page }) => page),
      next: exhausted ? null : position,
    };
  }
}

/** A shared-Page check's answer. A check answered from the host record and
 * one answered by the loaded host both build it here. Fields after title let
 * the caller's Catalog index this grant; the listing returns only page_id,
 * title and content_updated_at from it. `observed` is the title's observation
 * (`{ at, keep }`, titleObservation). */
function catalogAnswer(metadata, identity, { title, observed, contentUpdatedAt }) {
  const access = pageAccess(metadata, identity);
  const domain = access.source === "domain";
  return {
    page_id: metadata.pageId,
    title: catalogTitle(title),
    shared: true,
    owner: metadata.owner,
    role: access.role,
    source: domain ? "domain_opened" : "member",
    ...(domain && { domain: identity.domainAccess?.domain }),
    revision: metadata.acl?.revision ?? 0,
    lifecycle_revision: metadata.lifecycleRevision ?? 0,
    state: indexedState(metadata),
    title_observed_at: observed?.at,
    // A member's reconcile pass keeps its row's time for this title when the
    // observation lets writers keep theirs (titleObservation).
    ...(observed?.keep && { title_keep_time: true }),
    // When this host last accepted a content change, or null.
    content_updated_at: contentUpdatedAt ?? null,
  };
}

export class Page {
  constructor(ctx, env) {
    // Every storage user this host builds reaches storage through this one
    // context, whose writes are refused once the object is abandoned
    // (storage-guard.mjs, resetBoot).
    this.ctx = guardContext(ctx, () => this.storageRefusal());
    this.env = env;
    this.wires = new Set();
    this.wirePrincipals = new Map();
    this.tail = Promise.resolve();
    this.startupState = pageStartup.initial;
    // `ready` means the host record is read. Booting the repo and loading the
    // document is page-startup's `boot`: here for a record that needs it at
    // once, otherwise on the first request that needs the document.
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const metadata = await this.ctx.storage.get("host/document");
      const creation = await this.ctx.storage.get("host/creation");
      this.metadata = metadata;
      this.stepStartup({ type: "loaded", start: startupOf(metadata, creation) }, creation);
      if (this.booting) await this.booting;
      // A failed boot fails construction, so the runtime resets the object.
      if (this.startup.name === "failed") throw this.bootError;
    });
    // At the runtime's 30 s limit this rejects while the record read or the
    // boot inside it runs on, and the object is abandoned (resetBoot).
    this.ready.catch((error) => this.resetBoot(error));
  }

  /** page-startup's state. A host built without the constructor (a test
   * fixture over a loaded document) is booted. */
  get startup() {
    return this.startupState ?? { name: "ready" };
  }

  /** Step page-startup and run its effect. `creation` is the creation intent
   * the constructor read; only its boot can have one (startupOf). */
  stepStartup(event, creation) {
    const result = pageStartup.step(this.startup, event);
    this.startupState = result.state;
    for (const effect of result.effects)
      if (effect.type === "boot") this.startBoot(effect.within, creation);
    return result;
  }

  /**
   * Run the one boot, ending it with a page-startup event. `booting` and
   * `bootError` are the effect's handles (machine state is JSON): `booting`
   * settles when the boot does and never rejects, and each waiter then asks
   * the machine again.
   *
   * Both boots run inside `blockConcurrencyWhile`: the constructor's own, or
   * one the request that needs the document opens. A throw there resets the
   * object, so the next request reaches a new object that starts from storage
   * again. So does the runtime's 30 s limit, but that doesn't stop this
   * object: on celld 0.6.3 its boot runs on, and so do its timers and
   * requests, all writing the storage the new object boots from
   * (scripts/celld-boot-probe.mjs). A `blockConcurrencyWhile` that rejects
   * while the boot still runs leaves the object `abandoned` (resetBoot). From
   * then on its storage refuses every write (storage-guard.mjs), its
   * background work stops, and the boot ends at its next checkpoint
   * (assertNotAbandoned) or at the first write it tries. The request that
   * opened the boot awaits it and holds it, so a caller that goes away
   * doesn't strand it (request-hold.mjs).
   */
  startBoot(within, creation) {
    let started = false;
    let finish;
    // Settles when bootHost itself has returned or thrown. A request's
    // `blockConcurrencyWhile` can reject at the runtime's limit while
    // bootHost runs on, so `booting` may settle first.
    this.bootFinished = new Promise((resolve) => (finish = resolve));
    const boot = async () => {
      started = true;
      try {
        await this.bootHost(creation);
      } catch (error) {
        if (this.startup.name === "booting") this.bootError = error;
        this.stepStartup({ type: "bootFailed" });
        throw error;
      } finally {
        finish();
      }
      this.stepStartup({ type: "booted" });
    };
    const run = within === "request" ? this.ctx.blockConcurrencyWhile(boot) : boot();
    // Settles once a rejection is recorded, so a waiter sees `abandoned`.
    this.booting = run.then(noop, (error) => this.resetBoot(error));
    // A `blockConcurrencyWhile` that never ran the boot has nothing to wait for.
    void this.booting.then(() => started || finish());
    if (within === "request") holdUntilSettled(this.ctx, run);
  }

  /** A `blockConcurrencyWhile` that held the record read or the boot
   * rejected. While either still runs, the runtime has reset this object
   * under it: the object is abandoned, its storage refuses writes from here
   * on, and every request still here gets `error`. After the boot's own
   * throw, or once it finished, page-startup changes nothing. */
  resetBoot(error) {
    if (this.stepStartup({ type: "reset" }).rejected) return;
    this.bootError = error || abandonedError();
    this.retireAbandoned();
  }

  /** Stop what an abandoned object would go on doing. Background work stops
   * at once; the policy, plain sync and native backend close once bootHost,
   * which may still be building them, has returned or thrown
   * (`bootFinished`). That can be long after a request's
   * `blockConcurrencyWhile` rejected, since initializeRepo assigns them only
   * at its end. The storage guard already refuses their writes. */
  retireAbandoned() {
    const stop = () => {
      clearTimeout(this.conversionRetry);
      this.conversionRetry = undefined;
      this.recordMaintenance?.stop();
      this.actorPersistence?.stop?.();
      this.contentActivity?.stop();
      this.pageCard?.stop();
      this.unwatchContent();
    };
    stop();
    void (async () => {
      await this.bootFinished;
      // A boot that ran on may have built more since the reset.
      stop();
      const closes = [
        () => this.policy?.close?.(),
        () => this.plain?.close?.(),
        async () => {
          // The backend borrows its signer until close finishes.
          await this.backend?.close?.();
          this.signer?.free?.();
        },
      ];
      for (const close of closes)
        await Promise.resolve()
          .then(close)
          .catch((error) => logFailure(error, "abandoned-close"));
    })();
  }

  /** The error this object's storage writes are refused with: the reset's,
   * once it is abandoned. Never a falsy value then, which the guard would
   * read as "allowed". */
  storageRefusal() {
    if (this.migrationAbandoned) return this.migrationAbandoned;
    if (this.migration?.name === "retired") return (this.migratedError ||= recordStorageMigrated());
    if (this.startup.name !== "abandoned") return undefined;
    return (this.bootError ||= abandonedError());
  }

  /** Throw when this object was abandoned (page-startup's `abandoned`). The
   * storage guard refuses every write anyway; these checks end the boot early,
   * before work whose writes would only be refused. */
  assertNotAbandoned() {
    const error = this.storageRefusal();
    if (error) throw error;
  }

  /** Boot the repo and run the lifecycle's boot effects over the durable
   * record and any creation intent the constructor read. A lazy start has no
   * creation intent (startupOf), and only this host writes its record, which
   * nothing does before the boot. */
  async bootHost(creation) {
    // Looking up an unknown page must not create a persisted signer or repo.
    if (!this.metadata && !creation) return;
    if (creation && this.metadata) logCreationIntentConflict(creation.metadata, this.metadata);
    await this.initializeRepo(this.metadata ?? creation?.metadata);
    this.assertNotAbandoned();
    // The commit phase lived only in memory: the durable record and any
    // creation intent decide what boot installs or loads.
    const { effects } = pageLifecycle.step(this.lifecycleState(), {
      type: "boot",
      record: recordOf(this.metadata),
      creation: creation ? recordOf(creation.metadata) : null,
    });
    await this.applyLifecycle(effects, { intent: creation });
    // Only a host booted on Subduction can convert (record-storage-migration.mjs).
    if (!this.plain) this.migration = migrationStart(this.env, this.metadata);
  }

  /** Wait until the host is booted, starting the boot if nothing has. Throws
   * the boot's error when it failed. Every request except a check answered
   * from the record passes through here before it reads host state. */
  async documentReady() {
    if (this.migrationAbandoned) throw this.migrationAbandoned;
    if (this.migration?.name === "retired") throw (this.migratedError ||= recordStorageMigrated());
    for (;;) {
      const { response } = this.stepStartup({ type: "document" });
      if (response.serve === "document") return;
      if (response.serve === "failed") throw this.bootError;
      await this.settledBoot();
    }
  }

  /** Wait for the running boot. Its end, or a reset of the object under it,
   * is a page-startup event recorded before `booting` settles, so the state
   * has moved on when this returns. The throw guards that invariant: without
   * it, a waiter would ask the machine again forever. */
  async settledBoot() {
    await this.booting;
    if (this.startup.name === "booting") throw Error("Page startup did not settle");
  }

  /**
   * Answer a shared-Page check (`/internal/catalog`) from the host record,
   * without booting the repo, or return null to answer from the loaded host.
   *
   * Only in page-startup's `metadata`, or `failed` while the runtime replaces
   * the object; a running boot is awaited first. Storage is read again: the host
   * record is the access authority, and its current value decides. The
   * order and refusals are run()'s: authenticate, refuse a Page hidden in
   * Trash or deleted, claim an invitation, then `policy.account`. Anything
   * the record can't answer the same way returns null (recordFallback, a
   * grant holder's check of a trashed Page, a claimable invitation).
   *
   * The title is the one this host last projected to the Catalogs and the
   * index (`host/title-projection`), with its observation, and the content
   * time is the stored one, as the loaded host's first check reports them.
   * The projection follows each `cacheTitle`, so it can trail the document
   * only by a title change no booted request has projected yet; it is the
   * title every member's Catalog was last sent.
   *
   * It projects nothing and reports nothing to the index. A loaded host's
   * first check does both, and that stays the repair for a lost projection:
   * a projection or index report not yet seen to land leaves a mark that
   * boots this check instead, and each reader's reconcile pass rewrites its
   * own row from this answer.
   */
  async catalogFromRecord(request) {
    for (;;) {
      const { serve } = this.stepStartup({ type: "catalog" }).response;
      if (serve === "document") return null;
      if (serve === "record") break;
      if (serve === "failed") throw this.bootError;
      await this.settledBoot();
    }
    const storage = this.ctx.storage;
    const [metadata, creation, projection, activity, reportPending, projectionPending] =
      await Promise.all([
        storage.get("host/document"),
        storage.get("host/creation"),
        storage.get(TITLE_PROJECTION_KEY),
        storage.get(CONTENT_ACTIVITY_KEY),
        storage.get(INDEX_REPORT_PENDING),
        storage.get(PROJECTION_PENDING),
      ]);
    if (
      recordFallback({
        record: metadata,
        creation,
        projection,
        reportPending,
        projectionPending,
      })
    )
      return null;
    const identity = await this.identify(request);
    const hidden = this.hiddenRefusal(identity, request, false, metadata);
    if (hidden) throw hidden;
    const deleted = this.deletedRefusal(identity, false, metadata);
    if (deleted) throw deleted;
    if (pageState(metadata) === "trashed") return null;
    if (await claimInvitation(metadata, identity, this.env)) return null;
    new DocumentPolicy({ storage, metadata: () => metadata }).account(identity);
    const stored = storedTitleProjection(projection);
    return json(
      catalogAnswer(metadata, identity, {
        title: stored.title,
        observed: { at: stored.observed_at, keep: stored.keep !== false },
        contentUpdatedAt: acceptedTime(activity?.content_updated_at),
      }),
    );
  }

  /** Authenticate a request's caller with its own credentials. */
  identify(request) {
    return authenticate(request, this.env);
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
    // Journal recovery writes; a boot the runtime gave up on stops here.
    this.assertNotAbandoned();
    try {
      await recoverDocumentMutations(
        this.ctx.storage,
        this.handle,
        () => this.flush(),
        this.admission,
      );
    } catch (error) {
      if (isHistoryCapacityError(error)) {
        // Capacity is checked on a clone before any pending edit reaches the
        // serving handle. Preserve accepted history and the unresolved intent.
        this.recoveryBlocked = {
          code: "page_recovery_blocked",
          pending: true,
          message:
            "A pending edit exceeds this Page's history capacity. Accepted content is available read-only.",
        };
      } else {
        // A pending host migration whose records still can't be stored (a
        // 413 on record capacity, say) mustn't stop the Page from starting:
        // it stays readable, fenced, and the conversion machine retries the
        // same journal entries with backoff. A pending client edit still
        // rejects startup, as before.
        const pending = await pendingEntryKeys(this.ctx.storage, PAGE_DOC);
        if (!pending.length || !pending.every((key) => key.startsWith(INTERNAL_PREFIX)))
          throw error;
        logFailure(error, "preserved-markdown-recovery");
        this.conversionIntent = {
          replayKeys: pending.map((key) => ({ key, doc: PAGE_DOC })),
        };
      }
    }
    await this.loadComments();
    await this.restoreTitleProjection();
    // After recovery: a replayed journal entry was accepted before the
    // restart, not now.
    await this.watchContent();
    // Before native connections open, so peers sync the converted content.
    await this.convertPreservedMarkdown();
  }

  /** Record content changes on the serving document (content-activity.mjs).
   * The stored time is restored first, so this host's next report carries
   * it. A change counts when its patches touch the title or blocks and the
   * conversion machine isn't `converting`; the comments document isn't
   * observed.
   *
   * The listener runs on the repository's scheduler loop, in a request that
   * may have responded long ago, so it only records: requests pump the
   * effects (`run`), and so does each resident socket (`serve`). */
  async watchContent() {
    if (!this.handle) return;
    if (typeof this.handle.on !== "function" || typeof this.handle.off !== "function") {
      // A host without the event API never records content activity. Tests
      // and the local E2E fixture fail at once; a deployed host logs once.
      const error = TypeError("The serving document handle has no event API");
      if (globalThis.process?.env?.NODE_TEST_CONTEXT || this.env.PAGES_E2E_ONLY === "true")
        throw error;
      if (!this.contentUnobservable) logFailure(error, "content-activity");
      this.contentUnobservable = true;
      return;
    }
    // Deletion stops the recorder for good; nothing loads a deleted Page.
    if (this.contentActivity?.state.name === "stopped") return;
    this.contentActivity ??= new ContentActivity({
      storage: this.ctx.storage,
      report: (value) => {
        // Beside each flush, from this live request: the card, if its first
        // screen changed (page-card-writer.mjs). A card failure is logged
        // there and never fails the flush.
        this.pageCard?.request();
        this.pageCard?.pump();
        return this.reportContent(value);
      },
      hold: (work) => holdUntilSettled(this.ctx, work),
      onError: (error) => logFailure(error, "content-activity"),
    });
    this.pageCard ??= this.cardWriter();
    await this.contentActivity.restore();
    await this.pageCard?.restore();
    if (this.contentHandle === this.handle) return;
    this.unwatchContent();
    this.contentHandle = this.handle;
    this.contentListener ??= ({ patches }) => {
      // While `converting`, the fence holds every other writer, so each Page
      // change is the host's own migration.
      if (this.conversion.name === "converting" || !changesContent(patches)) return;
      this.contentActivity.changed();
    };
    this.handle.on("change", this.contentListener);
  }

  /** The card writer for this host, or null without a Page assets bucket. */
  cardWriter() {
    const bucket = this.env.PAGES_ASSETS;
    if (!bucket) return null;
    return new PageCardWriter({
      storage: this.ctx.storage,
      build: async () => {
        if (!this.handle || pageState(this.metadata) !== "active") return null;
        return pageCard(this.handle.doc(), {
          contentUpdatedAt: this.contentActivity?.value ?? null,
        });
      },
      store: {
        head: async () => {
          const object = await withTimeout(
            bucket.head(cardKey(this.metadata.pageId)),
            PAGE_CARD_STORE_TIMEOUT_MS,
            "Page card read timed out",
          );
          return object
            ? { etag: object.etag, card_hash: object.customMetadata?.card_hash ?? null }
            : null;
        },
        put: async (bundle, { etag }) => {
          const object = await withTimeout(
            bucket.put(cardKey(this.metadata.pageId), JSON.stringify(bundle), {
              httpMetadata: { contentType: "application/json" },
              customMetadata: {
                card_hash: bundle.card_hash,
                content_updated_at: bundle.content_updated_at ?? "",
              },
              // The ordering fence (page-card-writer.mjs).
              onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
            }),
            PAGE_CARD_STORE_TIMEOUT_MS,
            "Page card write timed out",
          );
          return object ? { etag: object.etag } : null;
        },
        delete: () => this.deleteCard(),
      },
      hold: (work) => holdUntilSettled(this.ctx, work),
      onError: (error) => logFailure(error, "page-card"),
    });
  }

  /** Remove this Page's card object, under a short deadline so bucket
   * trouble never holds a purge or tombstone. Best-effort: page_cards serves
   * a card only to a caller its Catalog check admits, and a deleted Page
   * admits no one, so a missed delete leaves an orphan no one reads. */
  async deleteCard() {
    const pageId = this.metadata?.pageId ?? this.ctx.id?.name;
    if (!this.env.PAGES_ASSETS || !validPageId(pageId)) return;
    try {
      await withTimeout(
        this.env.PAGES_ASSETS.delete(cardKey(pageId)),
        PAGE_CARD_DELETE_TIMEOUT_MS,
        "Page card delete timed out",
      );
    } catch (error) {
      logFailure(error, "page-card");
    }
  }

  /** Detach the content listener from the handle it was attached to. */
  unwatchContent() {
    this.contentHandle?.off?.("change", this.contentListener);
    this.contentHandle = undefined;
  }

  /** Stop recording for good and forget the stored content time, title
   * projection and card: the Page is being deleted. A flush already storing
   * its time lands before this delete. A card write still running when it
   * stops deletes the object again as it ends, whether its put landed or
   * timed out (page-card-writer.mjs); a delete that still misses leaves an
   * object page_cards never serves. */
  async forgetContent() {
    this.contentActivity?.stop();
    this.pageCard?.stop({ deleting: true });
    this.unwatchContent();
    await this.ctx.storage.delete(CONTENT_ACTIVITY_KEY);
    await this.ctx.storage.delete(TITLE_PROJECTION_KEY);
    await this.ctx.storage.delete(PROJECTION_PENDING);
    await this.ctx.storage.delete(PAGE_CARD_KEY);
    await this.deleteCard();
  }

  /** Report a stored content time: one D1 batch and one call to the owner's
   * Catalog. Members' Catalogs get it with the next title projection; their
   * listings read it from this host's check. A Page that isn't active has
   * nothing to list, so it reports nothing. Rejects if either write fails.
   *
   * The Catalog call has its own route. A Catalog without it answers non-OK,
   * and the flush retries with backoff until that node runs this build; a
   * Catalog from before content activity would read a title-less projection
   * as a title, "Untitled". */
  async reportContent(value) {
    if (!this.metadata || pageState(this.metadata) !== "active") return;
    const pageId = this.metadata.pageId;
    const tasks = [];
    if (this.env.CATALOGS)
      tasks.push(
        withTimeout(
          this.env.CATALOGS.getByName(this.metadata.owner).fetch(
            new Request("https://pages.internal/internal/content-activity", {
              method: "POST",
              body: JSON.stringify({
                page_id: pageId,
                content_updated_at: value,
              }),
            }),
          ),
          serialQueueBounds.projectionMs,
          "Catalog projection timed out",
        ).then((response) => {
          if (!response.ok) throw Error(`Content projection failed with ${response.status}`);
        }),
      );
    if (catalogIndexEpoch(this.env))
      tasks.push(
        withTimeout(
          reportContentActivity(this.env, this.ctx, {
            pageId,
            contentUpdatedAt: value,
          }),
          catalogIndexTimeouts.write,
        ),
      );
    await Promise.all(tasks);
  }

  /** Open the Page's comments document (model/comments-doc.mjs) and finish
   * any journaled write to it. Importing its deterministic genesis is a
   * no-op once it exists, so this also creates it the first time. */
  async loadComments(metadata = this.metadata) {
    if (this.commentsHandle || !this.commentsUuid) return;
    const documentId = commentsDocumentId(this.commentsUuid);
    if (this.plain) {
      this.plain.serve(documentId, "comments");
      await this.plain.prime(documentId);
    }
    this.commentsHandle = await this.repo.import(A.save(commentsGenesis(this.commentsUuid)), {
      docId: documentId,
    });
    this.commentAdmission?.reset();
    this.assertNotAbandoned();
    try {
      await recoverDocumentMutations(
        this.ctx.storage,
        this.commentsHandle,
        () => this.flush(),
        this.commentsAdmission,
        COMMENTS_DOC,
      );
    } catch (error) {
      // As for the Page document: a pending host migration retries under the
      // conversion machine; a pending client comment stops startup.
      const pending = await pendingEntryKeys(this.ctx.storage, COMMENTS_DOC);
      if (!pending.length || !pending.every((key) => key.startsWith(INTERNAL_PREFIX))) throw error;
      logFailure(error, "comments-migration-recovery");
      this.conversionIntent = {
        replayKeys: [
          ...(this.conversionIntent?.replayKeys ?? []),
          ...pending.map((key) => ({ key, doc: COMMENTS_DOC })),
        ],
      };
    }
    // The Page record names its comments document. Derivation gives the same
    // ID, so a record written without it loses nothing.
    if (
      metadata &&
      metadata === this.metadata &&
      !metadata.comments_doc &&
      !this.pendingAccess &&
      !this.pendingLifecycle
    ) {
      this.metadata = { ...metadata, comments_doc: this.commentsUuid };
      await this.ctx.storage.put("host/document", this.metadata);
    }
  }

  /** Replace the Page's preserved Markdown blocks with native rich text, and
   * hold the write fence until that's done (worker/preserved-conversion.mjs).
   * The host is the only writer of this conversion (model/raw-migration.mjs).
   * Resolves when no run is in flight. A failed run leaves the Page fenced,
   * read-only, with a scheduled retry. */
  async convertPreservedMarkdown() {
    this.assertNotAbandoned();
    this.observeConversion({ due: true });
    while (this.conversionRun) await this.conversionRun;
  }

  /** The conversion machine's state; fenced until the first observation. */
  get conversion() {
    return this.conversionState ?? preservedConversionMachine.initial;
  }

  /** Whether peer writes are refused now. */
  conversionFenced() {
    return conversionFenced(this.conversion);
  }

  /** The refusal for a native put or connection while the fence is up on an
   * active Page, or undefined. A trashed Page keeps its own rules. */
  conversionWriteFence() {
    return this.conversionFenced() && pageState(this.metadata) === "active"
      ? withAdmissionReason(conversionFenceError(), "preserved_markdown_converting")
      : undefined;
  }

  /** Feed what the host sees now into the conversion machine. Without a
   * document there is nothing to observe, and the state stays as it is. */
  observeConversion({ due = false } = {}) {
    // An abandoned object starts no run; its retry timer is cleared.
    if (this.startup.name === "abandoned") return;
    const doc = typeof this.handle?.doc === "function" ? this.handle.doc() : undefined;
    if (!doc) return;
    // The host's migrations share one fence: preserved blocks to rich text,
    // then legacy comments into the comments document.
    const preserved =
      hasPreservedBlocks(doc) || (!!this.commentsHandle && needsCommentsMigration(doc));
    const unfinished = !!this.conversionIntent;
    this.conversionEvent({
      type: "observe",
      due,
      preserved,
      unfinished,
      eligible:
        (preserved || unfinished) &&
        !this.recoveryBlocked &&
        pageState(this.metadata) === "active" &&
        !unsupportedFeatures(doc).length,
    });
  }

  conversionEvent(event) {
    const wasFenced = this.conversionFenced();
    const result = preservedConversionMachine.step(this.conversion, event);
    this.conversionState = result.state;
    // Peers connected read-only while fenced. Once the fence drops, close
    // their sockets with a transient code: they reconnect, discovery no
    // longer reports `converting`, and editing resumes.
    if (wasFenced && !this.conversionFenced() && this.wires?.size) {
      const done = withAdmissionReason(
        Object.assign(Error("Preserved Markdown converted"), { status: 503 }),
        "preserved_markdown_converting",
      );
      for (const wire of this.wires)
        void wire.disconnect(admissionCloseCode(done), admissionCode(done));
    }
    for (const effect of result.effects) {
      if (effect.type === "observe") this.observeConversion({ due: true });
      else if (effect.type === "scheduleRetry") {
        clearTimeout(this.conversionRetry);
        // A run that failed because its object was abandoned retries nowhere.
        if (this.startup.name === "abandoned") continue;
        this.conversionRetry = setTimeout(
          () => this.observeConversion({ due: true }),
          conversionRetryDelay(effect.attempt),
        );
        // Node keeps no process alive for it; a Durable Object stays resident.
        this.conversionRetry?.unref?.();
      } else if (effect.type === "logStuck")
        logPreservedStuck(this.metadata?.pageId ?? this.handle.doc().page_id, effect.reason);
      else if (effect.type === "convert") {
        // `converting` until this run's outcome steps the machine: the content
        // listener ignores every Page change in between (watchContent).
        const run = this.convertPreservedOnce(effect.mode).then(
          () => ({ type: "succeeded" }),
          (error) => {
            logFailure(error, "preserved-markdown");
            return {
              type: "failed",
              permanent: permanentFailure(error, { isHistoryCapacityError }),
              // Whether the run's journal entry is still reserved.
              unfinished: !!this.conversionIntent,
              reason: failureReason(error),
            };
          },
        );
        this.conversionRun = run.then((outcome) => {
          this.conversionRun = undefined;
          this.conversionEvent(outcome);
        });
      }
    }
  }

  /** Before an HTTP edit: while fenced, try the conversion once more, then
   * refuse with `preserved_markdown_converting` if the fence stays. */
  async requireConverted() {
    if (this.conversion.name === "unchecked") await this.convertPreservedMarkdown();
    else if (this.conversionFenced()) {
      // A nudge: it may clear the fence, but a retry waits for its backoff.
      this.observeConversion();
      while (this.conversionRun) await this.conversionRun;
    }
    if (this.conversionFenced()) throw conversionFenceError();
  }

  /** One journaled conversion run. A run is a host intent in the journal's
   * internal key space, keyed by the heads it converted, so a restart replays
   * the recorded change instead of converting again. The intent is kept
   * until its journal entry is terminal: a run that applied but failed to
   * finish replays under the same key, so its reservation completes. Throws
   * on failure; an error from the conversion itself carries `conversion`. */
  async convertPreservedOnce(mode) {
    if (this.conversionIntent?.replayKeys) {
      // Entries startup recovery couldn't finish: replay them as recorded.
      for (const { key, doc } of this.conversionIntent.replayKeys) {
        const comments = doc === COMMENTS_DOC;
        await replayRecordedMutation({
          storage: this.ctx.storage,
          handle: comments ? this.commentsHandle : this.handle,
          key,
          flush: () => this.flush(),
          admission: comments ? this.commentsAdmission : this.admission,
        });
      }
      this.conversionIntent = undefined;
      return;
    }
    // Preserved blocks convert first; legacy comments move once they're done.
    // A conversion run past its first step finishes before comments move.
    const converting = !!this.conversionIntent && !this.conversionIntent.comments;
    if (this.conversionIntent?.comments || (!converting && !hasPreservedBlocks(this.handle.doc())))
      return this.migrateCommentsOnce(mode === "literal" ? "drop" : "copy");
    if (!this.conversionIntent) {
      const heads = A.getHeads(this.handle.doc()).sort();
      const digest = hex(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(heads.join(","))),
        ),
      );
      const literal = mode === "literal";
      this.conversionIntent = {
        operation: literal ? "convert_preserved_markdown_literal" : "convert_preserved_markdown",
        literal,
        args: {
          idempotency_key: `preserved_${literal ? "literal" : "markdown"}_${digest.slice(0, 32)}`,
          base_heads: heads,
        },
      };
    }
    const intent = this.conversionIntent;
    try {
      await documentMutation({
        storage: this.ctx.storage,
        hostActorPrefix: this.plain?.hostActorPrefix,
        admission: this.admission,
        handle: this.handle,
        operation: intent.operation,
        args: intent.args,
        identity: { principal: "service:pages", driver: "API" },
        internal: true,
        apply: (draft) => {
          try {
            return {
              converted: convertPreservedBlocks(draft, {
                literal: intent.literal,
              }),
            };
          } catch (error) {
            throw Object.assign(error, { conversion: true });
          }
        },
        flush: () => this.flush(),
      });
      this.conversionIntent = undefined;
    } catch (error) {
      // Keep the intent while its journal entry is pending: the next run
      // replays it. Without one, the next run starts over from current heads.
      const key = `${INTERNAL_PREFIX}${intent.args.idempotency_key}`;
      const entry = await this.ctx.storage.get(key).catch(() => ({ pending: true }));
      if (!entry?.pending && !this.admission?.pending(key)) this.conversionIntent = undefined;
      throw error;
    }
  }

  /**
   * Move legacy comments out of the Page document (model/comments-migration.mjs),
   * as two journaled host intents under the conversion fence:
   *
   * 1. copy: every legacy thread into the comments document, keyed by the
   *    Page heads it read. Threads already there are skipped.
   * 2. detach: drop the Page's legacy map and stamp `comments-doc`, at
   *    exactly those heads.
   *
   * The fence holds peer writes, so the heads can't move between the steps.
   * If they do anyway, detach fails with stale heads and the next run copies
   * again from the new heads. A run that fails after reserving its entry
   * replays that entry. `mode` is `copy`, or `drop` after a copy keeps
   * failing for good: then no thread moves and the Page still detaches.
   */
  async migrateCommentsOnce(mode) {
    if (!this.conversionIntent?.comments) {
      const heads = A.getHeads(this.handle.doc()).sort();
      const digest = hex(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(heads.join(","))),
        ),
      ).slice(0, 32);
      this.conversionIntent = {
        comments: { mode, heads, digest, step: "copy" },
      };
    }
    const intent = this.conversionIntent.comments;
    const identity = { principal: "service:pages", driver: "API" };
    try {
      if (intent.step === "copy") {
        const page = this.handle.doc();
        await documentMutation({
          storage: this.ctx.storage,
          hostActorPrefix: this.plain?.hostActorPrefix,
          admission: this.commentsAdmission,
          handle: this.commentsHandle,
          doc: COMMENTS_DOC,
          pageId: this.metadata.pageId,
          operation: "migrate_comments_copy",
          args: {
            idempotency_key: `comments_copy_${intent.mode}_${intent.digest}`,
            base_heads: intent.heads,
          },
          identity,
          internal: true,
          // The copy reads the Page at the heads it names, never later.
          guard: (args) => {
            requireHeads(this.handle.doc(), intent.heads);
            return args;
          },
          apply: (draft) => {
            try {
              return copyLegacyThreads(draft, page, { mode: intent.mode });
            } catch (error) {
              throw Object.assign(error, { conversion: true });
            }
          },
          flush: () => this.flush(),
        });
        intent.step = "detach";
      }
      await documentMutation({
        storage: this.ctx.storage,
        hostActorPrefix: this.plain?.hostActorPrefix,
        admission: this.admission,
        handle: this.handle,
        operation: "migrate_comments_detach",
        args: {
          idempotency_key: `comments_detach_${intent.mode}_${intent.digest}`,
          base_heads: intent.heads,
        },
        identity,
        internal: true,
        apply: (draft) => detachLegacyComments(draft),
        flush: () => this.flush(),
      });
      this.conversionIntent = undefined;
    } catch (error) {
      // Keep the intent while its journal entry is pending: the next run
      // replays it. Without one, the next run starts over from current heads.
      const key = `${INTERNAL_PREFIX}comments_${intent.step}_${intent.mode}_${intent.digest}`;
      const admission = intent.step === "copy" ? this.commentsAdmission : this.admission;
      const entry = await this.ctx.storage.get(key).catch(() => ({ pending: true }));
      if (!entry?.pending && !admission?.pending(key)) this.conversionIntent = undefined;
      throw error;
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
        if (
          metadata?.recordStorage !== undefined &&
          !RECORD_STORAGE_MODES.includes(metadata.recordStorage)
        )
          throw Error("Unsupported Page record storage mode");
        if (metadata?.recordStorage === "automerge") return await this.initializePlain(metadata);
        signer = N.MemorySigner.fromBytes(await persistentSeed(ctx.storage));
        const serverKey = hex(signer.verifyingKey());
        // The comments document is named before any peer can connect, so the
        // policy serves its tree from the first frame.
        const commentsUuid = metadata?.pageId
          ? (metadata.comments_doc ?? (await commentsDocUuid(metadata.pageId)))
          : undefined;
        const commentsTree = commentsUuid && commentsTreeOf(commentsUuid);
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
              ? {
                  ...(this.policyMetadata ?? this.metadata),
                  recoveryBlocked: true,
                }
              : (this.policyMetadata ?? this.metadata),
          serverKey,
          schemaFeatures: (scope) => {
            const handle = scope === COMMENTS_SCOPE ? this.commentsHandle : this.handle;
            return handle ? documentFeatures(handle.doc()) : [];
          },
          // Peer puts wait for the host's own migrations.
          writeFence: () => this.conversionWriteFence(),
          commentsTree: () => commentsTree,
        });
        await policy.load();
        // The comments document's per-author check, at the byte store: the
        // one place that sees each record's signer and its change.
        const commentAdmission = new CommentAdmission({
          tree: () => commentsTree,
          serverKey,
          signer: (key) => policy.signer(key),
          seed: () => this.commentsHandle?.doc(),
          // Off the save path: block and disconnect the signer, never wait.
          onRefused: (key, reason) => {
            logCommentRefused(metadata?.pageId, reason);
            policy.refuseComments(key).catch((error) => logFailure(error, "comment-refusal"));
          },
          // Retryable: close the submitter's connection, keep its key.
          onThrottled: (key) => policy.throttleComments(key),
          maxRecordBytes: BACKEND_LIMITS.maxRecordBytes,
        });
        const recordStore =
          metadata?.recordStorage === "buffered"
            ? new BufferedRecordStore(
                new RemoteRecordSink(
                  // PageRecords is this host's record storage: the same
                  // gate refuses its writes once the object is abandoned.
                  guardStub(this.env.PAGE_RECORDS.getByName(metadata.pageId), () =>
                    this.storageRefusal(),
                  ),
                ),
                {
                  onDirty: (record) => {
                    this.recordMaintenance?.recordWrite(record);
                    this.schedulePersistence();
                  },
                },
              )
            : new DurableByteStore(ctx.storage);
        if (recordStore.ready) await recordStore.ready;
        const actorAuthorship = new ActorAuthorship({
          serverKey,
          binding: (key) => policy.bindings.get(key),
          entries: await loadActorEntries(ctx.storage),
        });
        // Retries wait on a held timer, as schedulePersistence does from the
        // same save callback; saves and connects also retry sooner.
        const actorPersistence = new ActorPersistence(ctx.storage, {
          hold: (work) => holdUntilSettled(ctx, work),
          onError: (error) => logFailure(error, "actor-authorship"),
        });
        // Before the backend can save or anything is published, rebuild
        // bindings and conflicts the persisted entries may lack.
        actorPersistence.enqueue(
          actorAuthorship.replay(
            await loadCommitAuthors(recordStore, (key, value) =>
              replayAuthor(key, value, BACKEND_LIMITS.maxRecordBytes),
            ),
          ),
        );
        backend = new SubductionBackend({
          signer,
          // Only the backend's saves attest authors; maintenance and flushes
          // use recordStore itself.
          storage: commentAdmission.guard(
            observeRecordSaves(recordStore, (key, value) =>
              this.recordSaved(actorAuthorship, key, value, actorPersistence),
            ),
          ),
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
          ...(commentsUuid && {
            commentsUuid,
            commentsAdmission: new DocumentAdmission(
              backend,
              documentIdToBinary(commentsDocumentId(commentsUuid)),
            ),
          }),
          commentAdmission,
          repo,
          recordStore,
          actorAuthorship,
          actorPersistence,
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
              // Removed commit records are replay's evidence: their actor
              // effects must be stored first.
              durable: async () => {
                await recordStore.flush();
                await actorPersistence.durable();
              },
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

  /** initializeRepo for an `automerge` Page: DocumentPolicy for access, and
   * PlainSync for history, admission and the host's Repo. No signer, record
   * store, native admission or actor replay: claims are made at admission. */
  async initializePlain(metadata) {
    const ctx = this.ctx;
    const commentsUuid = metadata?.pageId
      ? (metadata.comments_doc ?? (await commentsDocUuid(metadata.pageId)))
      : undefined;
    const policy = new DocumentPolicy({
      storage: ctx.storage,
      metadata: () =>
        this.recoveryBlocked
          ? { ...(this.policyMetadata ?? this.metadata), recoveryBlocked: true }
          : (this.policyMetadata ?? this.metadata),
      serverKey: undefined,
      schemaFeatures: (scope) => {
        const handle = scope === COMMENTS_SCOPE ? this.commentsHandle : this.handle;
        return handle ? documentFeatures(handle.doc()) : [];
      },
      writeFence: () => this.conversionWriteFence(),
      commentsTree: () => undefined,
    });
    await policy.load();
    const plain = new PlainSync({
      storage: ctx.storage,
      policy,
      pageFeatures: () => (this.handle ? documentFeatures(this.handle.doc()) : []),
      writeFence: () => this.conversionWriteFence(),
      onRefused: (conn, refusal, { doc, repeats }) => {
        if (conn.trusted) return logFailure(refusal, "plain-host-write");
        logSyncRefused({
          pageId: metadata?.pageId,
          kind: doc.kind,
          refusal,
          credential: conn.identity?.credentialKind,
          repeats,
        });
        // Native admission logs this event too; keep it for comment queries.
        if (!repeats && BLOCKING_COMMENT_CODES.has(refusal.code))
          logCommentRefused(metadata?.pageId, { code: refusal.code });
      },
      onRounds: (conn, summary) =>
        logSyncRounds({
          pageId: metadata?.pageId,
          summary,
          credential: conn.identity?.credentialKind,
        }),
      onCompactionFailed: (_doc, error) => logFailure(error, "plain-compaction"),
      // PlainSync already published the delta to the Page's readers.
      onActors: () => {},
      // A browser receives host messages once it has joined the Page document.
      onJoined: (_conn, doc) => {
        if (doc.kind !== "page") return;
        this.broadcastProfiles();
        this.broadcastActivity();
        this.broadcastActorSnapshot();
      },
    });
    const documents = [];
    if (metadata?.documentId) documents.push([metadata.documentId, "page"]);
    if (commentsUuid) documents.push([commentsDocumentId(commentsUuid), "comments"]);
    await plain.load(documents, { deleted: pageState(metadata) === "deleted" });
    Object.assign(this, {
      serverKey: undefined,
      serverSenderId: HOST_SENDER_ID,
      policy,
      plain,
      backend: plain.backend,
      repo: plain.repo,
      ...(commentsUuid && { commentsUuid }),
    });
  }

  /** Finish a recorded creation intent. An installed record wins over it, so
   * a replay never undoes a later Trash, restore or ACL change. */
  async finishCreation(intent) {
    await this.applyLifecycle(this.metadata ? CREATION_REPLAY : CREATION_COMMIT, { intent });
    // A registered draft from an older build can hold preserved blocks.
    await this.convertPreservedMarkdown();
  }

  profiles() {
    return {
      ...(this.plain ? this.plain.profiles() : this.policy.profiles()),
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
      profiles: () => (this.plain ? this.plain.profiles() : this.policy.profiles()),
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
      this.handle.broadcast({
        kind: "identity-profiles",
        peerProfiles: this.profiles(),
      });
    } catch (error) {
      // Cleanup must still release socket capacity if the document is closing.
      logFailure(error, "presence-profiles");
    }
  }

  /** Attest the author of a commit record the backend just stored. Storage
   * and broadcast run after the save and never fail it. Actor writes go
   * through ActorPersistence, which retries a failed write until it lands. */
  recordSaved(actorAuthorship, key, value, persistence = this.actorPersistence) {
    persistence?.nudge();
    const author = commitAuthor(key, value, BACKEND_LIMITS.maxRecordBytes);
    if (!author) return;
    const effects = actorAuthorship.observe({ ...author, now: Date.now() });
    if (effects.put.length || effects.remove.length) persistence?.enqueue(effects);
    if (effects.delta || effects.attested)
      this.queueActorDelta(effects.delta ?? {}, effects.attested ?? {});
  }

  /** Coalesce actor deltas into one broadcast per microtask, so a batch of
   * saves reported together goes out once. It uses no timer: under celld an
   * unheld timer set from a native save callback did not deliver. A
   * retraction drops that actor's pending hashes, so no hash outlives its
   * actor's retraction. Pending hashes keep the newest MAX_ATTESTED_CHANGES. */
  queueActorDelta(actorProfiles, attestedChanges) {
    const pending = (this.actorDelta ??= {
      actorProfiles: {},
      attestedChanges: {},
    });
    for (const [actor, profile] of Object.entries(actorProfiles)) {
      pending.actorProfiles[actor] = profile;
      if (profile === null)
        for (const [hash, owner] of Object.entries(pending.attestedChanges))
          if (owner === actor) delete pending.attestedChanges[hash];
    }
    for (const [hash, actor] of Object.entries(attestedChanges)) {
      delete pending.attestedChanges[hash];
      pending.attestedChanges[hash] = actor;
    }
    const hashes = Object.keys(pending.attestedChanges);
    for (const hash of hashes.slice(0, Math.max(0, hashes.length - MAX_ATTESTED_CHANGES)))
      delete pending.attestedChanges[hash];
    if (this.actorDeltaQueued) return;
    this.actorDeltaQueued = true;
    queueMicrotask(() => this.flushActorDelta());
  }

  flushActorDelta() {
    this.actorDeltaQueued = false;
    const delta = this.actorDelta;
    this.actorDelta = undefined;
    if (!delta || !this.handle) return;
    try {
      this.handle.broadcast({ kind: "actor-profiles", ...delta });
    } catch (error) {
      logFailure(error, "actor-profiles");
    }
  }

  /** Attested actors and their recent attested change hashes, now. */
  actorSnapshot() {
    if (this.plain) return this.plain.actorSnapshot();
    const now = Date.now();
    const actorProfiles = this.actorAuthorship?.profiles(now) ?? {};
    return {
      actorProfiles,
      attestedChanges: this.actorAuthorship?.attestedChanges(now, actorProfiles) ?? {},
    };
  }

  /** Resend the whole snapshot once a socket subscribes: an attestation made
   * after its /api/connect response reached only earlier subscribers. */
  broadcastActorSnapshot() {
    if (!this.handle || !(this.actorAuthorship || this.plain)) return;
    this.flushActorDelta();
    try {
      this.handle.broadcast({
        kind: "actor-profiles",
        ...this.actorSnapshot(),
        snapshot: true,
      });
    } catch (error) {
      logFailure(error, "actor-profiles");
    }
  }

  /** Read the title this host last projected and when it observed it. Call
   * once the serving document is loaded, before the first projection. */
  async restoreTitleProjection() {
    const stored = storedTitleProjection(await this.ctx.storage.get(TITLE_PROJECTION_KEY));
    if (stored) this.titleProjection ??= stored;
  }

  /** When `title` was observed, for a projection or report about to send it,
   * and whether writers may keep their own time.
   *
   * A title this host already projected keeps the time it was first observed
   * (`TITLE_PROJECTION_KEY`), so a restart, a retried projection or a repeated
   * report carries the same time, and so does `title_observed_at` on this
   * host's checks. Any other title, and every `observe` (an ACL commit or a
   * restore), is observed now and stored.
   *
   * `keepTime` lets a writer whose stored title already equals this one keep
   * its own `updated_at`. A title observation sets it: that covers a host with
   * no record, such as one from a build without it, and a writer that never
   * got an earlier projection. An `observe` clears it, because an ACL commit
   * and a restore move every writer's time. The record stores it as `keep`,
   * so a retry or repair of an `observe` still moves the writers it missed; a
   * resent stored time changes nothing for writers that already took it,
   * since each takes the later time. A stored record without `keep` keeps:
   * the build that wrote it stored no flag. */
  titleObservation(title, { observe = false } = {}) {
    const known = this.titleProjection;
    if (!observe && known?.title === title) {
      const observation = {
        observedAt: known.observed_at,
        keepTime: known.keep !== false,
      };
      // A record whose store failed is stored again, with the same time, at
      // most once per retry interval (retryTitleStore).
      return this.titleUnstored === known
        ? {
            ...observation,
            stored: this.retryTitleStore() ?? Promise.resolve({ ok: false }),
          }
        : observation;
    }
    const record = {
      title,
      observed_at: new Date().toISOString(),
      keep: !observe,
    };
    this.titleProjection = record;
    return {
      observedAt: record.observed_at,
      keepTime: record.keep,
      stored: this.storeTitleProjection(record),
    };
  }

  /** Store `record` as the title projection, after its mark: a stored title
   * the Catalogs may lack always has the mark. Without the mark the title
   * stays unstored, a check from the record answers the last stored title,
   * and `titleUnstored` holds `record` until a later store lands
   * (retryTitleStore).
   * Resolves `{ ok }`. */
  storeTitleProjection(record) {
    this.titleStoreAttemptAt = Date.now();
    const failed = () => {
      this.titleUnstored = record;
      return { ok: false };
    };
    return this.markProjection().then((marked) =>
      marked
        ? this.ctx.storage.put(TITLE_PROJECTION_KEY, record).then(
            () => {
              if (this.titleUnstored === record) this.titleUnstored = undefined;
              return { ok: true };
            },
            (error) => {
              logFailure(error, "title-projection");
              return failed();
            },
          )
        : failed(),
    );
  }

  /** Store the current title projection again, alone, if its last store
   * failed and the last attempt is at least TITLE_STORE_RETRY_MS old.
   * Returns the store's `{ ok }` promise, or undefined when there is nothing
   * to retry yet. While storage keeps failing, this bounds the retries; a
   * failed store never resends the title to the Catalogs (cacheTitle).
   *
   * When the Catalogs already got this title (`titleDelivered`), a store
   * that lands clears the pending mark it wrote, unless a newer mark or
   * projection started since (settleProjection). */
  retryTitleStore() {
    const record = this.titleUnstored;
    if (!record || record !== this.titleProjection) return undefined;
    if (Date.now() - (this.titleStoreAttemptAt ?? -Infinity) < TITLE_STORE_RETRY_MS)
      return undefined;
    const stored = this.storeTitleProjection(record);
    // storeTitleProjection's mark moved the sequence on, synchronously.
    const marked = this.projectionSeq;
    return stored.then(async (result) => {
      if (result.ok && this.titleDelivered === record) await this.settleProjection(marked, true);
      return result;
    });
  }

  /** Project this Page's title to the Catalogs that list it, and report its
   * row to the index. `observe` marks a new observation of an unchanged
   * title: an ACL commit or a restore. */
  cacheTitle(identity, { observe = false } = {}) {
    // A trashed Page must not relist itself in owner or member catalogs.
    if (pageState(this.metadata) !== "active") return;
    const title = catalogTitle(this.handle.doc().title);
    const observedReader =
      identity && pageAccess(this.metadata, identity).source === "domain"
        ? identity.principal
        : null;
    if (this.cachedTitle === title) {
      // The Catalogs have this title; only its store may be left to retry.
      const retry = this.retryTitleStore();
      if (retry) this.ctx.waitUntil(retry);
      if (!observedReader) return;
    }
    const titleChanged = this.cachedTitle !== title;
    const recipients = !titleChanged
      ? [observedReader]
      : [
          this.metadata.owner,
          ...Object.entries(this.metadata.acl?.members ?? {})
            .filter(([, value]) => ["viewer", "commenter", "editor"].includes(value.role))
            .map(([principal]) => principal),
          ...(observedReader ? [observedReader] : []),
        ];
    this.cachedTitle = title;
    // A domain reader's open alone is that reader's discovery, observed now.
    const observation = titleChanged
      ? this.titleObservation(title, { observe })
      : { observedAt: new Date().toISOString(), keepTime: false };
    // A projection to the owner and members clears the pending mark once it
    // lands everywhere (settleProjection). A domain reader's own projection
    // doesn't: a loaded host's check sends readers nothing.
    const fanout = titleChanged ? (this.projectionSeq = (this.projectionSeq ?? 0) + 1) : undefined;
    const { observedAt, keepTime } = observation;
    // `{ at, keep }`: the title's observation, as the host's check reports it.
    if (titleChanged) this.titleObserved = { at: observedAt, keep: keepTime };
    const contentUpdatedAt = this.contentActivity?.value ?? null;
    // A projection that times out clears the cached title below, so the next
    // request to this Page sends it again, with the same observation time.
    // A failed title store doesn't: the request path retries the store alone
    // (retryTitleStore).
    const record = this.titleProjection;
    const projections = recipients.map((principal) =>
      withTimeout(
        this.env.CATALOGS.getByName(principal).fetch(
          new Request("https://pages.internal/internal/projection", {
            method: "POST",
            body: JSON.stringify({
              page_id: this.metadata.pageId,
              title,
              observed_at: observedAt,
              ...(keepTime && { keep_time: true }),
              ...(contentUpdatedAt && { content_updated_at: contentUpdatedAt }),
              shared: principal !== this.metadata.owner,
            }),
          }),
        ),
        serialQueueBounds.projectionMs,
        "Catalog projection timed out",
      ),
    );
    const tasks = [...projections];
    if (fanout)
      this.ctx.waitUntil(
        Promise.all([Promise.all(projections), observation.stored ?? { ok: true }]).then(
          ([results, stored]) => {
            const delivered = results.every((result) => result.ok);
            // A later store of this record can clear the mark (retryTitleStore).
            if (delivered && !stored.ok) this.titleDelivered = record;
            return this.settleProjection(fanout, delivered && stored.ok);
          },
          () => this.settleProjection(fanout, false),
        ),
      );
    if (catalogIndexEpoch(this.env)) {
      // A domain reader's row is rewritten when the reader opens the Page for
      // the first time in this host's life, after a title change, and after
      // the content time moved past the one its last report carried. A flush
      // never rewrites these rows (reportContentActivity).
      if (titleChanged) this.indexedReaders = new Map();
      this.indexedReaders ??= new Map();
      const reported = this.indexedReaders.get(observedReader);
      const reader =
        observedReader &&
        identity.domainAccess &&
        (reported === undefined || (contentUpdatedAt !== null && contentUpdatedAt !== reported))
          ? { principal: observedReader, domain: identity.domainAccess.domain }
          : undefined;
      if (titleChanged || reader) {
        if (reader) this.indexedReaders.set(reader.principal, contentUpdatedAt);
        tasks.push(
          this.reportIndex({
            title,
            observedAt,
            reader,
            readerOnly: !titleChanged,
            contentUpdatedAt,
            keepTime,
          }).then(
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

  /** Mark the stored title as not yet projected everywhere. Resolves true
   * once the mark is written, false if the write failed; the title it marks
   * is written only after true (titleObservation). It moves the sequence on,
   * so a projection already running can't clear it. */
  markProjection() {
    this.projectionSeq = (this.projectionSeq ?? 0) + 1;
    return Promise.resolve()
      .then(() => this.ctx.storage.put(PROJECTION_PENDING, true))
      .then(
        () => true,
        (error) => {
          logFailure(error, "title-projection-pending");
          return false;
        },
      );
  }

  /** Clear the mark once the latest projection reached every Catalog and the
   * title it sent is stored. An earlier projection finishing late clears
   * nothing, and a failure leaves the mark for the next boot's first check. */
  async settleProjection(fanout, delivered) {
    if (!delivered || fanout !== this.projectionSeq) return;
    try {
      await this.ctx.storage.delete(PROJECTION_PENDING);
    } catch (error) {
      logFailure(error, "title-projection-pending");
    }
  }

  /** Post-commit catalog index reconcile. Writes start in order per Page; one
   * that outlives its timeout carries an older ACL revision, which the index
   * ignores once a newer report has landed. A failed report leaves a durable
   * marker, and the next request to this Page repeats it. */
  reportIndex(details) {
    const run = async () => {
      try {
        await withTimeout(
          reportPageIndex(this.env, this.ctx, {
            metadata: this.metadata,
            ...details,
          }),
          catalogIndexTimeouts.write,
        );
      } catch (error) {
        this.indexReportPending = true;
        // Synced: a check from the host record reads it to decide whether
        // to boot and repeat the report (recordFallback).
        await this.ctx.storage.put(INDEX_REPORT_PENDING, true);
        await this.ctx.storage.sync();
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
    const title = catalogTitle(this.handle.doc().title);
    // A repeat observes nothing new: the title keeps its observation time.
    const { observedAt, keepTime, stored } = this.titleObservation(title);
    this.ctx.waitUntil(
      Promise.all([
        stored,
        this.reportIndex({
          title,
          observedAt,
          keepTime,
          contentUpdatedAt: this.contentActivity?.value ?? null,
        }),
      ])
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
    this.plain?.refresh();
    if (catalogIndexEpoch(this.env) && listingRestricted(previous, restricted, this.env))
      await this.restrictIndex(restricted, metadata.acl?.revision ?? 0);
    await this.ctx.storage.put("host/document", metadata);
    await this.ctx.storage.sync();
    this.metadata = metadata;
    this.policyMetadata = undefined;
    await this.policy.refreshAccess();
    this.plain?.refresh();
    this.activity?.prune();
    this.pendingAccess = undefined;
    this.cachedTitle = undefined;
    this.cacheTitle(undefined, { observe: true });
  }

  schedulePersistence() {
    // An abandoned object's flushes are refused; it schedules none.
    if (this.persistenceScheduled || this.startup.name === "abandoned") return;
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

  /** The comments document readers use: the Page's once its comments have
   * moved there. Before that, readers fall back to the Page's legacy map
   * (model/comments.mjs threadsOf) and comment writes wait. */
  commentsView() {
    return this.commentsHandle && this.handle && commentsMigrated(this.handle.doc())
      ? this.commentsHandle.doc()
      : undefined;
  }

  /** The repo document IDs this Page host holds: the Page and, once open,
   * its comments document. */
  documentIds() {
    return [
      this.metadata.documentId,
      ...(this.commentsHandle ? [commentsDocumentId(this.commentsUuid)] : []),
    ];
  }

  async flush() {
    if (this.plain) {
      await this.plain.flush(this.documentIds());
      await this.ctx.storage.sync();
      return;
    }
    await this.repo.flush(this.documentIds());
    await this.backend.flush();
    await this.recordStore?.flush?.();
    await this.ctx.storage.sync();
  }

  fetch(request) {
    // Permission changes/claims and HTTP mutations share one admission order.
    // Native frames still run directly through the current DocumentPolicy.
    // Both paths hold the request until it settles (request-hold.mjs): a save
    // waits for heads and drains the record store's own serialized flush.
    this.requestsRunning = (this.requestsRunning ?? 0) + 1;
    this.reportActivity();
    const settle = (work) => {
      const settled = work.then(noop, noop).then(() => {
        this.requestsRunning--;
        this.reportActivity();
      });
      // reportActivity may arm a quiet hold. Keep its originating request
      // live until that handoff has completed, not just until run() settles.
      holdUntilSettled(this.ctx, settled);
      return work;
    };
    if (["/api/sync", "/api/saved"].includes(new URL(request.url).pathname)) {
      const running = this.run(request);
      return settle(running);
    }
    const next = this.tail.then(() => this.run(request));
    this.tail = next.catch(() => {});
    return settle(next);
  }

  /** Tell the migration machine how many sockets and requests are live. */
  reportActivity() {
    if (!this.migration) return;
    this.stepMigration({
      type: "activity",
      sockets: this.wires.size,
      requests: this.requestsRunning ?? 0,
    });
  }

  /** Step record-storage-migration and run its effects. */
  stepMigration(event) {
    if (this.migrationAbandoned) return { state: this.migration, effects: [] };
    const result = recordStorageMigration.step(this.migration, event);
    if (result.rejected) return result;
    this.migration = result.state;
    for (const effect of result.effects) {
      if (effect.type === "arm") {
        this.disarmMigration();
        if (this.migration.name === "quiet") {
          const held = new Promise((resolve) => (this.migrationRelease = resolve));
          holdUntilSettled(this.ctx, held);
        }
        this.migrationTimer = setTimeout(() => {
          const release = this.migrationRelease;
          this.migrationTimer = undefined;
          this.migrationRelease = undefined;
          // Register the next hold before releasing this request's quiet hold.
          this.stepMigration({ type: "elapsed" });
          release?.();
        }, effect.ms);
        // Backoff is best-effort: no hold keeps an unused native host resident.
      } else if (effect.type === "disarm") {
        this.disarmMigration();
      } else if (effect.type === "convert") {
        const run = this.runMigration();
        holdUntilSettled(this.ctx, run);
        this.disarmMigration();
      }
      // `retire` runs inside runMigration's blockConcurrencyWhile.
    }
    return result;
  }

  /** Clear the migration timer and settle the hold it kept. */
  disarmMigration() {
    clearTimeout(this.migrationTimer);
    this.migrationTimer = undefined;
    this.migrationRelease?.();
    this.migrationRelease = undefined;
  }

  /**
   * Convert this Subduction Page to plain Automerge sync, in place, while
   * nobody uses it (record-storage-migration.mjs). Runs inside
   * blockConcurrencyWhile, so no request or socket starts meanwhile, and one
   * at a time per isolate (the module's shared slot). After the flip the
   * object retires: its storage refuses writes, its native host closes, and
   * the throw resets it, so the next request boots plain.
   */
  async runMigration() {
    // Wait for the isolate's slot outside blockConcurrencyWhile, so the wait
    // can't run into the runtime's deadline; activity is checked again inside.
    let callbackSettled;
    let callbackStarted = false;
    try {
      const result = await migrationSlot(() => {
        let settle;
        callbackSettled = new Promise((resolve) => (settle = resolve));
        return this.ctx.blockConcurrencyWhile(async () => {
          callbackStarted = true;
          const started = Date.now();
          try {
            if (this.migrationAbandoned) return;
            const event = await this.convertRecordStorage(started);
            const { effects } = this.stepMigration(event);
            if (effects?.some((effect) => effect.type === "retire")) {
              await this.retireMigratedHost();
              throw (this.migratedError ||= recordStorageMigrated());
            }
          } finally {
            settle();
          }
        });
      });
      if (result?.reason === "slot_timeout") {
        console.log(
          JSON.stringify({
            event: "record_storage.migration",
            outcome: "skipped",
            from: this.metadata?.recordStorage ?? "local",
            reason: result.reason,
          }),
        );
        this.stepMigration(result);
      }
    } catch (error) {
      if (error === this.migratedError) {
        // The throw resets the object; abort makes the reset explicit.
        try {
          this.ctx.abort?.(error);
        } catch {}
        return;
      }
      // The runtime gave up on the conversion (its deadline) while it may
      // still run, and a new object may already serve the Page. Fence this
      // one: its storage refuses every write from here, so the stale
      // conversion can't write a snapshot or flip the record.
      this.migrationAbandoned ||= error || recordStorageMigrated();
      this.disarmMigration();
      // The runtime's deadline is not the callback's settlement. Its borrowed
      // native resources remain live until the callback has finished with them.
      // An unstarted callback borrows nothing; a late start sees the fence.
      if (callbackStarted) await callbackSettled;
      await this.retireMigratedHost();
    }
  }

  /** The conversion itself. Returns `skipped`, `failed` or `converted`. */
  async convertRecordStorage(started = Date.now()) {
    const storage = this.ctx.storage;
    const from = this.metadata?.recordStorage ?? "local";
    const log = (outcome, fields = {}) =>
      console.log(
        JSON.stringify({
          event: "record_storage.migration",
          outcome,
          from,
          ...fields,
        }),
      );
    const skip = (reason, retryMs) => {
      log("skipped", { reason });
      return { type: "skipped", reason, ...(retryMs && { retryMs }) };
    };
    if (this.wires.size || (this.requestsRunning ?? 0) > 0) return skip("busy");
    if (!this.handle || this.plain || this.migration?.name !== "converting")
      return skip("not_native");
    if (this.recoveryBlocked) return skip("recovery_blocked");
    // An access or lifecycle commit whose barrier failed: the stored record
    // may be newer than this.metadata, and the flip would overwrite it.
    if (this.pendingAccess || this.pendingLifecycle) return skip("record_pending");
    // The flip spreads this.metadata: only when storage holds exactly it.
    // Nothing writes the record meanwhile: this runs in blockConcurrencyWhile.
    const stored = await storage.get("host/document");
    if (JSON.stringify(stored) !== JSON.stringify(this.metadata)) return skip("record_pending");
    if (this.conversionIntent) return skip("conversion_pending");
    if (
      (await pendingEntryKeys(storage, PAGE_DOC)).length ||
      (await pendingEntryKeys(storage, COMMENTS_DOC)).length
    )
      return skip("journal_pending");
    let flipping = false;
    try {
      // Everything the native host accepted, in its record store (and the
      // PageRecords sink for a buffered Page).
      await this.flush();
      const complete = (doc) => A.getHeads(doc).length > 0 && !A.getMissingDeps(doc, []).length;
      const page = this.handle.doc();
      if (!complete(page)) return skip("page_incomplete");
      const commentsId = this.commentsUuid && commentsDocumentId(this.commentsUuid);
      const comments = commentsId && this.commentsHandle?.doc();
      if (commentsId && !(comments && complete(comments))) return skip("comments_incomplete");
      await this.actorPersistence?.durable();
      const actors = await loadActorEntries(storage);
      const blocked = [...(this.policy?.bindings?.values() ?? [])]
        .filter((binding) => binding.commentsBlocked && typeof binding.principal === "string")
        .map((binding) => binding.principal);
      const { claims, bytes } = await writeMigratedHistory(storage, {
        documents: [
          { documentId: this.metadata.documentId, doc: page },
          ...(comments ? [{ documentId: commentsId, doc: comments }] : []),
        ],
        actors,
        blocked,
      });
      // Leave ten seconds of the runtime's 30 s block deadline for the selector
      // write and barrier; a late flip could strand edits on a fresh native host.
      if (Date.now() - started > 20_000) return skip("deadline_margin");
      flipping = true;
      await storage.put("host/document", {
        ...this.metadata,
        recordStorage: "automerge",
        recordStorageMigratedFrom: from,
        recordStorageMigratedAt: new Date().toISOString(),
      });
      await storage.sync();
      log("converted", {
        claims,
        blocked: blocked.length,
        comments: !!comments,
        bytes,
        latencyMs: Date.now() - started,
      });
      return { type: "converted" };
    } catch (error) {
      logFailure(error, "record-storage-migration");
      // The selector write may have landed even though it, or the barrier
      // after it, reported failure. The object resets either way, and the
      // next boot reads the record.
      if (flipping) return { type: "converted" };
      return { type: "failed" };
    }
  }

  /** A converted Page's Subduction history, which the plain host never reads:
   * its records, actor entries, signing-key bindings and signer seed here,
   * and for a buffered Page the PageRecords object's records.
   * Deleting the Page deletes them too.
   * Each step is idempotent, so a repeated deletion finishes the job. */
  async purgeMigratedRecords() {
    if (this.metadata.recordStorageMigratedFrom === "buffered" && this.env.PAGE_RECORDS) {
      const records = new BufferedRecordStore(
        new RemoteRecordSink(
          guardStub(this.env.PAGE_RECORDS.getByName(this.metadata.pageId), () =>
            this.storageRefusal(),
          ),
        ),
      );
      await records.ready;
      for (const key of await records.list("")) await records.remove(key);
      await records.flush();
    }
    await clearPrefixes(this.ctx.storage, ["repo/", "host/actor/", "host/binding/"]);
    await this.ctx.storage.delete("host/signer");
  }

  /** Stop and close the native host of a retired object. Its storage already
   * refuses writes (storageRefusal), so a close that tries one only logs. */
  async retireMigratedHost() {
    if (this.migrationRetiring) return;
    this.migrationRetiring = true;
    this.disarmMigration();
    clearTimeout(this.conversionRetry);
    this.conversionRetry = undefined;
    this.recordMaintenance?.stop();
    this.actorPersistence?.stop?.();
    this.contentActivity?.stop();
    // The card object and host/card stay: the plain host serves the same
    // Page and its first flush compares against the stored hash.
    this.pageCard?.stop();
    this.unwatchContent();
    for (const close of [
      () => this.policy?.close?.(),
      () => this.repo?.shutdown?.(),
      async () => {
        // The backend borrows its signer until close finishes.
        await this.backend?.close?.();
        this.signer?.free?.();
      },
    ])
      await Promise.resolve()
        .then(close)
        .catch((error) => logFailure(error, "record-storage-migration-retire"));
  }

  async run(request) {
    const url = new URL(request.url);
    const admissionRoute = ADMISSION_ROUTES.includes(url.pathname);
    let identity;
    try {
      await this.ready;
      // A shared-Page check of a host that hasn't booted answers from its
      // record when it can (page-startup.mjs).
      if (url.pathname === "/internal/catalog") {
        const answer = await this.catalogFromRecord(request);
        if (answer) return answer;
      }
      await this.documentReady();
      // This request is live: content effects deferred from the repository's
      // loop, or a coalesced time whose timer never fired, run now.
      this.contentActivity?.pump();
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
            const failed = pageLifecycle.step(this.lifecycleState(), {
              type: "commitFailed",
            });
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
      identity = await this.identify(request);
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
            await this.createdReply(
              this.metadata.createdReceipt ?? {
                page_id: this.metadata.pageId,
                title: this.handle.doc().title,
                heads: A.getHeads(this.handle.doc()),
              },
              identity,
            ),
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
              recordStorage: recordStorageFor(this.env),
              pageId: args.page_id,
              owner: identity.principal,
              ownerName: identity.displayName,
              documentId,
              tree: logicalId(documentIdToBinary(documentId)),
              // The Page's comments document, by its deployment-relative id.
              comments_doc: await commentsDocUuid(args.page_id),
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
            if (error.code === "unsupported_markdown") {
              const response = errorResponse(error, "page-create");
              response.headers.set("x-pages-create-rejected", "before-intent");
              return response;
            }
            if (error.status !== 413) throw error;
            const response = json({ error: error.message }, 413);
            response.headers.set("x-pages-create-rejected", "before-intent");
            return response;
          }
          await this.ctx.storage.put("host/creation", intent);
        }
        await this.initializeRepo(intent.metadata);
        await this.finishCreation(intent);
        return json(await this.createdReply(intent.metadata.createdReceipt, identity), 201);
      }
      const hidden = this.hiddenRefusal(identity, request, admissionRoute);
      if (hidden) throw hidden;
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
      const deleted = this.deletedRefusal(identity, admissionRoute);
      if (deleted) throw deleted;
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
        // Uploads need edit access. Asset storage has no per-Page aggregate
        // quota, so comment access alone doesn't open it: commenters comment
        // in text, and can't attach images until that quota exists.
        this.policy.account(identity, args.write);
        return json({ page_id: this.metadata.pageId });
      }
      if (url.pathname === "/internal/catalog") {
        // A loaded host's first check reports this Page's current row and
        // fixes the time its title was observed.
        this.cacheTitle();
        return json(
          catalogAnswer(this.metadata, identity, {
            title: this.handle.doc().title,
            observed: this.titleObserved,
            contentUpdatedAt: this.contentActivity?.value ?? null,
          }),
        );
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
        this.actorPersistence?.nudge();
        this.cacheTitle(identity);
        return json({
          page_id: this.metadata.pageId,
          documentId: this.metadata.documentId,
          // The comments document syncs on the same socket.
          ...(this.commentsHandle && {
            commentsDocumentId: commentsDocumentId(this.commentsUuid),
          }),
          ...(this.plain ? { recordStorage: "automerge" } : { serverPeerId: this.serverKey }),
          serverSenderId: this.serverSenderId,
          identity: publicIdentity(identity),
          // Access is the grant; `converting` is a temporary hold the viewer
          // shows as read-only without retiring its writer key.
          canWrite: !this.recoveryBlocked && pageAccess(this.metadata, identity).canWrite,
          access: {
            ...pageAccess(this.metadata, identity),
            ...(this.recoveryBlocked && { canWrite: false, canComment: false }),
          },
          ...(this.recoveryBlocked && { recovery: this.recoveryBlocked }),
          ...(this.conversionWriteFence() && {
            converting: conversionNotice(),
          }),
          ...(incompleteHistory(this.handle.doc()) && {
            historyIncomplete: incompleteHistory(this.handle.doc()),
          }),
          ...(state === "trashed" && { trash: publicTrash(this.metadata) }),
          peerProfiles: this.profiles(),
          ...this.actorSnapshot(),
          activity: this.activityState().snapshot(),
          // The head script asks for this on a Page route, so the viewer can
          // show the Page read-only before its runtimes load and it syncs.
          // Admission above already refused anyone who can't read the Page;
          // a Page in Trash gets none, so its notice isn't hidden.
          ...(url.searchParams.get("preview") === "1" &&
            state !== "trashed" &&
            pageAccess(this.metadata, identity).canRead && {
              preview: pagePreview(this.handle.doc()),
            }),
        });
      }
      if (url.pathname === "/api/sync" && request.method === "GET")
        return this.connect(request, identity);
      if (url.pathname === "/api/saved" && request.method === "POST") {
        const { heads, comment_heads, schema_features } = await readJson(request);
        await this.waitForHeads(heads, schema_features);
        // A viewer that wrote comments waits for those heads too.
        if (comment_heads !== undefined && this.commentsHandle)
          await this.waitForHeads(comment_heads, schema_features, this.commentsHandle);
        this.policy.account(await authenticate(request, this.env));
        const durableHeads = A.getHeads(this.handle.doc());
        const durableCommentHeads = this.commentsHandle && A.getHeads(this.commentsHandle.doc());
        await this.flush();
        this.cacheTitle();
        return json({
          durableHeads,
          ...(durableCommentHeads && { durableCommentHeads }),
        });
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
            commentsDoc: this.commentsView(),
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
        if (["manage_page_comment", "reply_page_comment"].includes(body.operation))
          return json(await this.writeComment(request, identity, body));
        this.policy.account(identity, true);
        if (body.operation === "report_page_progress")
          return json(this.activityState().report(this.handle.doc(), identity, body.arguments));
        if (!["edit_page", "patch_page"].includes(body.operation))
          throw new HttpError(400, "Unknown document operation");
        const ops = Array.isArray(body.arguments?.operations) ? body.arguments.operations : [];
        // Ops that create a node naming a stored asset (model/node-registry.mjs).
        const inserts = ops.filter((op) => insertOperation(op?.op ?? op?.type));
        // Where this batch landed, captured inside the change so the cursors
        // name the characters it wrote. A replayed receipt has no caret.
        let caret = null;
        await this.requireConverted();
        const receipt = await documentMutation({
          storage: this.ctx.storage,
          hostActorPrefix: this.plain?.hostActorPrefix,
          admission: this.admission,
          handle: this.handle,
          operation: body.operation,
          args: body.arguments,
          identity,
          prepare: inserts.length
            ? async () => {
                if (inserts.length > 100)
                  throw new HttpError(400, "Provide up to 100 operations", "invalid_edit_selector");
                let assets;
                try {
                  assets = insertedAssets(inserts, this.metadata.pageId);
                } catch (error) {
                  throw new HttpError(400, error.message, "invalid_edit_selector");
                }
                // Each names an asset stored on this Page, of its kind.
                for (const { asset, assetId, mediaType } of assets)
                  await ASSET_CHECKS[asset](this.env.PAGES_ASSETS, {
                    pageId: this.metadata.pageId,
                    assetId,
                    ...(mediaType && { mediaType }),
                  });
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
              // The batch cannot apply as written: zero or multiple matches, or
              // an unknown block, operation or mark.
              throw Object.assign(
                new HttpError(400, error.message, error.code ?? "invalid_edit_selector"),
                error.details && { details: error.details },
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
      if (!admissionRoute) return errorResponse(this.withCommentHeads(error), "page");
      if ((error.status ?? 500) >= 500) logFailure(error, "page");
      return admissionErrorResponse(error, { stage: "page", identity });
    } finally {
      // Still live: a change this request made (a tool edit, a save that
      // waited for a peer's heads) was observed by now, and its flush runs
      // on this request's hold.
      this.contentActivity?.pump();
    }
  }

  /** The create_page receipt with this Page's edit authority: the Page-scoped
   * retry_token, retry_key_prefix and retry_until that read_page would issue,
   * so the first edit needs no read. The stored receipt stays as recorded;
   * the token is minted per reply and journaled by the owner's Catalog with
   * the rest of the receipt, so an exact retry returns the same one. */
  async createdReply(receipt, identity) {
    return {
      ...receipt,
      ...(await issueRetryToken(this.ctx.storage, {
        scope: `page:${this.metadata.pageId}`,
        principal: identity.principal,
      })),
    };
  }

  /** A revision refusal (stale_heads, edit_conflict, resync_required) names
   * the live Page revision in `details.current_heads`. Add the comments
   * document's revision beside it, so the caller holds both baselines
   * without a read. Other errors pass through unchanged. */
  withCommentHeads(error) {
    if (
      !["stale_heads", "edit_conflict", "resync_required"].includes(error?.code) ||
      !Array.isArray(error.details?.current_heads) ||
      error.details.comment_heads !== undefined
    )
      return error;
    const comments = this.commentsView();
    if (comments) error.details = { ...error.details, comment_heads: A.getHeads(comments) };
    return error;
  }

  /**
   * One manage_page_comment or reply_page_comment call, written to the
   * comments document. It needs `comment`, never `edit`, and never changes
   * the Page document or its heads. The receipt's `comment_heads` are the
   * comments document's revision after the write.
   */
  async writeComment(request, identity, body) {
    this.policy.account(identity, "comment");
    await this.requireConverted();
    if (!this.commentsView())
      throw new HttpError(
        503,
        "This Page's comments are moving to their own document; try again shortly",
        "comments_migrating",
      );
    const role = pageAccess(this.metadata, identity).role;
    const operation = body.operation;
    const args = body.arguments ?? {};
    // The Page snapshot a new comment anchors in. The guard captures it and
    // the edit uses it, with no await between them.
    let page;
    const receipt = await documentMutation({
      storage: this.ctx.storage,
      hostActorPrefix: this.plain?.hostActorPrefix,
      admission: this.commentsAdmission,
      handle: this.commentsHandle,
      doc: COMMENTS_DOC,
      pageId: this.metadata.pageId,
      operation,
      args,
      identity,
      // Receipts carry no image prerequisites; this only re-checks access
      // after the journal inspection awaited storage.
      prepare: async () => {
        this.policy.account(await authenticate(request, this.env), "comment");
      },
      guard: (input) => {
        page = this.handle.doc();
        // The Page's stamp gates both documents, as the native gate does. A
        // recorded receipt still replays; this runs for new intents only.
        requireSupportedSchema(page);
        return guardCommentIntent(page, operation, input);
      },
      // The Page revision this write read, journaled with its receipt.
      receiptFields: () => ({ page_heads: A.getHeads(page) }),
      apply: (draft, effectiveArgs) => {
        try {
          return applyComment(
            draft,
            operation === "reply_page_comment"
              ? { ...effectiveArgs, action: "reply" }
              : effectiveArgs,
            publicIdentity(identity),
            undefined,
            { page, role },
          );
        } catch (error) {
          throw Object.assign(
            new HttpError(
              error.status ?? 400,
              error.message,
              error.code ?? "invalid_comment_selector",
            ),
            error.details && { details: error.details },
          );
        }
      },
      flush: () => this.flush(),
    });
    return this.commentReceipt(receipt, identity);
  }

  /**
   * The tool receipt for a comment write. `heads` are Page heads and
   * `comment_heads` comments-document heads; neither ever holds the other's.
   *
   * - A receipt journaled on the comments document carries `page_heads`, the
   *   Page revision its write was based on, recorded with it. `heads` is that
   *   baseline, not the live Page: a browser edit landing meanwhile stays
   *   after it, so `read_page_changes` from these heads still returns it, and
   *   an exact retry returns the same heads.
   * - A receipt a build before the comments document journaled on the Page
   *   (`recorded_doc: "page"`) keeps its Page heads and has no comment heads;
   *   `legacy_receipt` says so.
   */
  commentReceipt(receipt, identity) {
    const { recorded_doc, page_heads, ...rest } = receipt;
    if (recorded_doc === PAGE_DOC) return { ...rest, legacy_receipt: true };
    this.commentsHandle.broadcast({
      kind: "tool-edit",
      identity: {
        ...publicIdentity(identity),
        ...(identity.agent && { agent: identity.agent }),
        ...(identity.session && { session: identity.session }),
      },
      heads: rest.heads,
      comments: true,
    });
    return { ...rest, heads: page_heads, comment_heads: rest.heads };
  }

  /** Owner or a valid viewer/editor grant on the deleted metadata. A role
   * "none" row is a deny tombstone, which an owner can create for a principal
   * who never had access, so it discloses nothing. Company view discloses
   * nothing either. */
  disclosesDeletion(principal, metadata = this.metadata) {
    return pageRelation(metadata, principal) !== "none";
  }

  /** A trashed Page is disclosed like a deleted one: only to its owner and
   * current viewer/editor grant holders. */
  hiddenWhileTrashed(identity, metadata = this.metadata) {
    return (
      pageState(metadata) === "trashed" && !this.disclosesDeletion(identity?.principal, metadata)
    );
  }

  /** The refusal for a Page this caller can't know about, or undefined:
   * there is no record, or it is in Trash and the caller holds no grant.
   * Anyone without a current grant cannot tell a trashed Page from a missing
   * one. Only the owner and current members learn it exists. */
  hiddenRefusal(identity, request, admissionRoute, metadata = this.metadata) {
    if (metadata && !this.hiddenWhileTrashed(identity, metadata)) return undefined;
    // Admission routes answer a missing Page exactly as an unreadable one,
    // for clients that declare it. The deployed viewer renews an expired
    // draft registration only on this 404, so other clients keep it.
    // Remove the legacy branch once older viewers must reload before
    // reconnecting and every supported viewer handles the unified 403.
    if (admissionRoute && unifiedMissing(request))
      return withAdmissionReason(new PermissionDenied(), "page_not_found");
    if (admissionRoute)
      return withAdmissionReason(new HttpError(404, "Page not found"), "page_not_found_legacy");
    return new HttpError(404, "Page not found", "page_not_found");
  }

  /** The refusal for a deleted Page, or undefined. Only the owner and current
   * grant holders learn that it was deleted. */
  deletedRefusal(identity, admissionRoute, metadata = this.metadata) {
    if (pageState(metadata) !== "deleted") return undefined;
    if (admissionRoute && !this.disclosesDeletion(identity.principal, metadata))
      return withAdmissionReason(new PermissionDenied(), "page_deleted", "page_access_denied");
    return withAdmissionReason(new HttpError(404, "Page not found"), "page_deleted");
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
        trash: trashRecord({
          pageId,
          principal: identity.principal,
          now,
          receipt,
        }),
        // Builds that predate Trash read only `deletion`: their delete retry
        // conflicts, and a fresh key completes an ordinary permanent deletion.
        deletion: {
          key,
          fingerprint: digest,
          receipt: { page_id: pageId, deleted: true },
        },
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
        purged: {
          purged_at: new Date().toISOString(),
          purged_by: identity.principal,
        },
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
          if (!this.plain)
            this.admission ??= new DocumentAdmission(
              this.backend,
              documentIdToBinary(this.metadata.documentId),
            );
        } else this.metadata = pending.metadata;
        return;
      case "convertPreserved":
        // Journaled and idempotent, so a repeated commit sequence is safe.
        await this.convertPreservedMarkdown();
        return;
      case "refreshAccess":
        await this.policy.refreshAccess();
        this.plain?.refresh();
        this.activity?.prune();
        return;
      case "projectTitle":
        // A restore is a lifecycle observation: listings move it now.
        this.cachedTitle = undefined;
        this.cacheTitle(undefined, { observe: true });
        return;
      case "retireIndex":
        await this.retireIndex();
        return;
      case "closePolicy":
        this.recordMaintenance?.stop();
        this.contentActivity?.stop();
        this.pageCard?.stop();
        this.unwatchContent();
        this.activity?.close();
        await this.policy.close();
        for (const wire of this.wires) await wire.disconnect();
        this.plain?.disconnectAll();
        return;
      case "deleteDocument":
        await this.forgetContent();
        // Both documents go together: the Page and its comments.
        await this.repo.delete(this.metadata.documentId);
        if (this.commentsUuid) {
          this.commentAdmission?.reset();
          await this.repo.delete(commentsDocumentId(this.commentsUuid));
        }
        // From metadata, not loaded handles: a deleted Page boots without them.
        await this.plain?.forget(
          [
            this.metadata.documentId,
            this.commentsUuid && commentsDocumentId(this.commentsUuid),
          ].filter(Boolean),
        );
        if (this.metadata.recordStorageMigratedFrom) await this.purgeMigratedRecords();
        // A Subduction Page may hold plain history from a conversion that
        // failed before its flip.
        if (!this.plain) await clearPlainStorage(this.ctx.storage);
        return;
      case "flush":
        if (this.plain) {
          if (pageState(this.metadata) !== "deleted") await this.plain.flush(this.documentIds());
          return;
        }
        // A deleted document has nothing left in the repo to flush.
        if (pageState(this.metadata) !== "deleted") await this.repo.flush(this.documentIds());
        await this.backend.flush();
        await this.recordStore?.flush?.();
        return;
      case "finishDeletion":
        // Barriers are complete for this process; a restart repeats them.
        this.deletionFinished = true;
        return;
      case "dropDocument":
        // A tombstone deletes the Page as a purge does.
        await this.forgetContent();
        this.handle = undefined;
        this.commentsHandle = undefined;
        this.commentAdmission?.reset();
        return;
      case "loadDocument":
        await this.loadDocument();
        return;
      case "importDocument":
        // A replayed creation may find the document stored already.
        if (this.plain) {
          this.plain.serve(context.intent.metadata.documentId, "page");
          await this.plain.prime(context.intent.metadata.documentId);
        }
        this.handle = await this.repo.import(context.intent.bytes, {
          docId: context.intent.metadata.documentId,
        });
        await this.loadComments(context.intent.metadata);
        await this.watchContent();
        // Not active yet: preserved blocks are held, fenced, until
        // finishCreation observes again after the record is installed.
        this.observeConversion();
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
    const { effects } = pageLifecycle.step(this.lifecycleState(), {
      type: "commitOk",
    });
    await this.applyLifecycle(effects);
  }

  /** The HTTP reply a page-lifecycle response describes. */
  async lifecycleReply(response, context = {}) {
    if (response.status >= 500) return json({ error: response.error }, response.status);
    if (response.status !== 200) {
      const error = new HttpError(response.status, response.error, response.code);
      // A trash refused for stale base_heads names the live revision, as an
      // edit refusal does.
      if (response.code === "stale_heads" && this.handle)
        error.details = { current_heads: A.getHeads(this.handle.doc()) };
      const reply = errorResponse(this.withCommentHeads(error), "page-lifecycle");
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
          ...purgeImpact(this.metadata, doc, this.commentsView()),
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
    const result = pageLifecycle.step(this.lifecycleState(), {
      type: "tombstone",
    });
    const context = {};
    if (result.effects.length)
      context.next = {
        ...this.metadata,
        lifecycleRevision: (this.metadata.lifecycleRevision ?? 0) + 1,
        purged: {
          purged_at: new Date().toISOString(),
          reason: "deleted_by_earlier_build",
        },
      };
    await this.applyLifecycle(result.effects, context);
    return this.lifecycleReply(result.response);
  }

  lifecycleRecord(operation, digest, receipt, revision = this.metadata.lifecycleRevision ?? 0) {
    return {
      operation,
      fingerprint: digest,
      revision,
      receipt,
      at: Date.now(),
    };
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
            recordStorage: registeredRecordStorage(this.env, args),
            pageId: args.page_id,
            owner: identity.principal,
            ownerName: identity.displayName,
            documentId: args.document_id,
            tree: logicalId(documentIdToBinary(args.document_id)),
            comments_doc: await commentsDocUuid(args.page_id),
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

  /** `declared` is the schema features the tab's build declared with this
   * receipt; a build from before the stamp sends none, the baseline. When
   * heads are missing and that build lacks a stamped id, the native gate has
   * refused, or will refuse, those edits: answer `schema_unsupported` rather
   * than wait for heads that can't arrive. */
  async waitForHeads(heads, declared, handle = this.handle) {
    if (
      !Array.isArray(heads) ||
      heads.length < 1 ||
      heads.length > 128 ||
      heads.some((head) => typeof head !== "string" || !/^[0-9a-f]{64}$/.test(head))
    )
      throw new HttpError(400, "Invalid heads");
    if (A.hasHeads(handle.doc(), heads)) return;
    const features =
      declared === undefined
        ? []
        : Array.isArray(declared) && declared.every((id) => typeof id === "string")
          ? parseDeclaredFeatures(declared.join(","))
          : null;
    if (!features) throw new HttpError(400, "Invalid schema_features");
    const refusal = () => {
      // The Page's stamp gates both documents.
      const missing = missingFeatures(documentFeatures(this.handle.doc()), features);
      return missing.length
        ? withAdmissionReason(schemaUnsupported(missing), "schema_unsupported")
        : null;
    };
    const refused = refusal();
    if (refused) throw refused;
    await new Promise((resolve, reject) => {
      const changed = () => {
        if (A.hasHeads(handle.doc(), heads)) {
          clearTimeout(timer);
          handle.off("heads-changed", changed);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        handle.off("heads-changed", changed);
        reject(
          refusal() ??
            withAdmissionReason(new HttpError(409, MISSING_EDITS_MESSAGE), "receipt_heads_missing"),
        );
      }, 10_000);
      handle.on("heads-changed", changed);
      changed();
    });
  }

  /** The Page, account and member socket quotas. Returns the refusal for a
   * connection over one, or undefined. `replacing` is a wire the new
   * connection will close once admitted; it doesn't count. */
  connectionCapacity(identity, replacing) {
    const full = (message) =>
      withAdmissionReason(new HttpError(429, message), "connection_capacity");
    const held = this.wires.size - (replacing && this.wires.has(replacing) ? 1 : 0);
    if (held >= 24) return full("Too many connected peers");
    const principals = [...this.wirePrincipals]
      .filter(([wire]) => wire !== replacing)
      .map(([, principal]) => principal);
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
    // The build's schema features, for the native schema gate in policy.put().
    // A viewer from before the stamp sends none: the baseline.
    const declared = new URL(request.url).searchParams.getAll("schema_features");
    const features = declared.length > 1 ? null : parseDeclaredFeatures(declared[0]);
    if (!features) throw new HttpError(400, "Invalid schema_features");
    // While the preserved-block conversion holds the fence, peers still
    // connect and sync down, read-only: the policy refuses every put, relayed
    // or self-authored, so no competing conversion lands. Discovery tells the
    // viewer it's converting. Each connection retries a failed conversion.
    // A plain socket from a tab that already holds one replaces it, so the
    // stale socket's slot is free for this one.
    const sender = this.plain?.sender(identity, new URL(request.url).searchParams.get("sender"));
    const capacity = this.connectionCapacity(identity, sender?.replaces?.wire);
    if (capacity) return refuseSocket(capacity, identity);
    // A first observation is due; afterwards a connection only nudges, which
    // never starts a retry before its backoff.
    this.observeConversion({ due: this.conversion.name === "unchecked" });
    // The viewer discovered `converting` but the fence dropped before this
    // upgrade, so it would miss the completion close: send it back to
    // discovery. Synchronous with the wire's registration below, so the
    // fence can't drop between this check and the socket joining `wires`.
    if (new URL(request.url).searchParams.get("converting") === "1" && !this.conversionWriteFence())
      return refuseSocket(
        withAdmissionReason(
          Object.assign(Error("Preserved Markdown converted"), { status: 503 }),
          "preserved_markdown_converting",
        ),
        identity,
      );
    if (this.plain) {
      try {
        requirePlainSyncClient(request);
      } catch (error) {
        return refuseSocket(error, identity);
      }
      return this.connectPlain(request, identity, features, sender);
    }
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
    const syncUsage = {
      surface: "browser-sync",
      identity,
      labels: requestClient(request),
      pageId: this.metadata?.pageId,
    };
    // sync.open records the admission decision once: admitted after
    // addConnection, or refused with its reason. Only an admitted session
    // records sync.close, with its duration.
    const syncStarted = Date.now();
    let syncAdmittedAt;
    wire.onDisconnect(() => {
      if (syncAdmittedAt !== undefined)
        logUsage({
          action: "sync.close",
          ...syncUsage,
          latencyMs: Date.now() - syncAdmittedAt,
        });
    });
    this.wires.add(wire);
    this.reportActivity();
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
      this.reportActivity();
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
                Object.assign(new Error("Native handshake failed", { cause }), {
                  status: 400,
                }),
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
            disconnect: (error) => {
              // A replaced connection ends without a failure, so nothing
              // else logs it; log it here so replacements show in the host log.
              if (admissionReason(error) === "native_session_replaced")
                logAdmissionDenied(error, { stage: "native", identity });
              return close(error ?? admissionCancelled());
            },
            onRenewal: (expiresAt) => {
              if (identity.credentialKind === "api-key") armExpiry(expiresAt);
            },
            features,
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
              Object.assign(new Error("Native connection failed", { cause }), {
                status: 503,
              }),
              "native_connection_failed",
            );
          }
          syncAdmittedAt = Date.now();
          logUsage({
            action: "sync.open",
            ...syncUsage,
            admitted: true,
            outcome: "ok",
            latencyMs: syncAdmittedAt - syncStarted,
          });
          this.broadcastProfiles();
          this.broadcastActivity();
          this.broadcastActorSnapshot();
        } finally {
          transport.free();
        }
        // Native callbacks retain this request's I/O context. Keep it alive
        // while the resident socket can trigger authorization and storage work,
        // and run content effects for the edits it brings (watchContent).
        await Promise.all([disconnected, this.contentActivity?.serve(disconnected)]);
      })().catch((error) => {
        if (syncAdmittedAt === undefined)
          logUsage({
            action: "sync.open",
            ...syncUsage,
            admitted: false,
            outcome: admissionReason(error),
            latencyMs: Date.now() - syncStarted,
          });
        if (error !== refusal) logAdmissionDenied(error, { stage: "native", identity });
        if (admissionReason(error) === "server_error") logFailure(error, "native-admission");
        void close(error);
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  /** connect() for an `automerge` Page. HTTP authentication already named the
   * principal; the socket speaks plain Automerge sync (sync/wire.mjs), and
   * PlainSync checks access on every frame. No handshake, no signing key.
   * `sender` is PlainSync.sender's decision for this socket's presence id. */
  connectPlain(request, identity, features, sender) {
    const pair = new WebSocketPair();
    const client = pair[0],
      socket = pair[1];
    socket.accept();
    const syncUsage = {
      surface: "browser-sync",
      identity,
      labels: requestClient(request),
      pageId: this.metadata?.pageId,
    };
    const started = Date.now();
    let conn;
    try {
      // The tab's presence id (plainSender): it keys presence labels, and the
      // host stamps every relay with it.
      conn = this.plain.accept(socket, identity, {
        features,
        senderId: sender.senderId,
      });
    } catch (error) {
      logAdmissionDenied(error, { stage: "native", identity });
      logUsage({
        action: "sync.open",
        ...syncUsage,
        admitted: false,
        outcome: admissionReason(error),
        latencyMs: 0,
      });
      try {
        socket.close(admissionCloseCode(error), admissionCode(error));
      } catch {
        /* Already closed. */
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    const wire = {
      disconnect: async (code, reason) =>
        conn.transport.close(code ?? 1000, reason ?? "Disconnected"),
    };
    conn.wire = wire;
    // After the new socket is in: the replaced one's close releases its slot.
    if (sender.replaces && !sender.replaces.closed) {
      const replaced = plainSessionReplaced();
      logAdmissionDenied(replaced, { stage: "native", identity });
      sender.replaces.transport.close(admissionCloseCode(replaced), admissionCode(replaced));
    }
    this.wires.add(wire);
    this.reportActivity();
    this.wirePrincipals.set(wire, identity.principal);
    // Lease: the credential's deadline, re-armed when an API key renews, and
    // a renewal check every 15 s. A deadline past setTimeout's range re-arms
    // in steps, since a longer delay fires at once.
    let expiry;
    const armExpiry = () => {
      clearTimeout(expiry);
      if (!Number.isFinite(conn.expiresAt)) return;
      const left = conn.expiresAt - Date.now();
      expiry = setTimeout(
        () =>
          left > 2 ** 30
            ? armExpiry()
            : void wire.disconnect(
                admissionCloseCode(credentialExpired()),
                admissionCode(credentialExpired()),
              ),
        Math.max(1, Math.min(left, 2 ** 30)),
      );
    };
    armExpiry();
    const renewal = setInterval(() => {
      void (async () => {
        const renewed = await authenticate(request, this.env);
        if (renewed.principal !== identity.principal || renewed.canWrite !== identity.canWrite)
          throw new PermissionDenied("Credential changed");
        this.plain.renew(conn, renewed);
        armExpiry();
      })().catch((error) => wire.disconnect(admissionCloseCode(error), admissionCode(error)));
    }, 15_000);
    const disconnected = new Promise((resolve) => conn.transport.onClose(resolve));
    conn.transport.onClose(() => {
      clearTimeout(expiry);
      clearInterval(renewal);
      this.wires.delete(wire);
      this.reportActivity();
      this.wirePrincipals.delete(wire);
      this.activity?.prune();
      this.broadcastProfiles();
      logUsage({
        action: "sync.close",
        ...syncUsage,
        latencyMs: Date.now() - started,
      });
    });
    logUsage({
      action: "sync.open",
      ...syncUsage,
      admitted: true,
      outcome: "ok",
      latencyMs: Date.now() - started,
    });
    this.broadcastProfiles();
    this.broadcastActivity();
    this.broadcastActorSnapshot();
    this.ctx.waitUntil(Promise.all([disconnected, this.contentActivity?.serve(disconnected)]));
    return new Response(null, { status: 101, webSocket: client });
  }
}
