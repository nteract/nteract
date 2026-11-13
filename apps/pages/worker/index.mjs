import { hasNonce } from "../model/nonce.mjs";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import {
  beginServerOidcLogin,
  completeServerOidcLogin,
  deleteServerOidcSession,
  serverOidcSessionStatus,
} from "@cloud/server-oidc.ts";
import { handleLocalOidcRequest } from "@cloud/dev-oidc.ts";
import { loadServerSession } from "@cloud/oidc-session-store.ts";
import { assertSessionKeyring } from "@cloud/session-keyring.ts";
import { sessionKeysFailure } from "./session-keys.mjs";
import { httpsRedirect, withTransportSecurity } from "./transport-security.mjs";
import { logAuthEvent, recordOidcEvent, sessionRowPrincipal } from "./auth-events.mjs";
import {
  createPageData,
  initializePage,
  applyPageOperation,
  insertedAssets,
  insertedViews,
  orderedBlockIds,
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
import { unsupportedMarkdown, unsupportedMarkdownError } from "../model/markdown-scan.mjs";
import { applyComment, commentsMigrated } from "../model/comments.mjs";
import { guardCommentIntent, passageComment } from "../model/comment-guard.mjs";
import { authorOf } from "../model/author.mjs";
import { checkSources, setSources, validateSourceBatch } from "../model/sources-doc.mjs";
import { checkView, setView, validateViewOperation } from "../model/view-doc.mjs";
import { MAX_VIEWS, validViewId } from "../shared/views.mjs";
import { CHART_WORKER_CSP, CHUNK_PATH } from "../shared/chart-worker-csp.mjs";
import { setResponseHeaders } from "./response-headers.mjs";
import { viewDocUuid } from "../shared/document-ids.mjs";
import {
  commentsDocUuid,
  commentsDocumentId,
  derivedDocUuid,
  derivedDocumentId,
} from "./comments-store.mjs";
import { SOURCES_ABSENT, sourcesStep } from "./sources-lifecycle.mjs";
import { VIEW_ABSENT, viewStep } from "./view-lifecycle.mjs";
import {
  MEMBER_FORMATS,
  MEMBER_TYPES,
  WRITTEN_FORMATS,
  documentFormatsUnsupported,
  formatPairs,
  missingFormats,
  pageDocuments,
  parseDeclaredFormats,
  recordDocumentFormats,
  recordFormatsWritten,
} from "../model/document-types.mjs";
import { storedFormUnsupported } from "../model/stored-form.mjs";
import { readTargets, writeTargets } from "../model/agent-presence.mjs";
import { assertDocumentLimits, assertIntentSize } from "../model/limits.mjs";
import { MAX_PAGE_TITLE } from "../shared/page-title.mjs";
import { RECORD_STORAGE_MODES } from "../shared/record-storage.mjs";
import { handleMcp } from "../mcp.mjs";
import {
  agentFromProvenance,
  forwardClientProvenance,
  withMcpAgent,
} from "./client-provenance.mjs";
import { normalizeAgentAssertions } from "../shared/client-provenance.mjs";
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
import { flushUsage } from "./usage-store.mjs";
import { runScheduled } from "./scheduled.mjs";
import { BrowserWrites, UsageSession } from "./usage-session.mjs";
import {
  RENAMED_TOOLS,
  invalidArguments,
  invokeProjectApi,
  unknownOperation,
  withRefusalCode,
} from "./project-api.mjs";
import { agentGuideResponse, pagesPublicOrigin } from "../agent-guide.mjs";
import { connectAgentResponse } from "../connect-agent.mjs";
import { handleOAuth, mcpAuthChallenge } from "./oauth.mjs";
import { oauthGrantActive } from "./oauth-store.mjs";
import { handleAccountAuth } from "./account-auth.mjs";
import {
  ASSET_AUTHORIZE_PATH,
  ASSET_UPLOAD_OPERATION,
  ASSET_UPLOAD_SCHEME,
  UPLOAD_CREDENTIAL,
  hostUploadCapability,
  issueAssetUpload,
  openUploadCapability,
  uploadCapabilityToken,
  uploadIdentity,
  uploaderEditUntil,
  uploadRefusal,
  uploadScreen,
  verifyAssetUpload,
} from "./asset-uploads.mjs";
import { sessionStoreReady } from "./isolate-setup.mjs";
import { handleKiloSignIn, kiloSessionProvider } from "./kilo-handoff.mjs";
import { signInCallbackOptions } from "./sign-in-failure.mjs";
import { localOidcStore } from "./local-oidc-store.mjs";
import { MISSING_EDITS_MESSAGE } from "../shared/receipts.mjs";
import { openingTitleWarning } from "../model/title-warning.mjs";
import { blockAddress, nodeAddresses } from "../model/addresses.mjs";
import { pagePreview } from "../model/page-preview.mjs";
import { cardKey, pageCard } from "../model/page-card.mjs";
import {
  authenticate,
  accountIdentity,
  agentLabel,
  driverLabel,
  requireSameOrigin,
  requireWrite,
  HttpError,
  errorResponse,
  logFailure,
  json,
  readJson,
  withDomainAccess,
} from "./auth.mjs";
import {
  incompleteHistory,
  isHistoryCapacityError,
  logIncompleteHistory,
} from "./history-admission.mjs";
import {
  inspectOperation,
  journalTime,
  operationEntryBytes,
  raiseHorizon,
  readRevisions,
  requireJournalRoom,
  reserveOperation,
  revisionClock,
} from "./operation-journal.mjs";
import { fencedHeads, headsFor, revisionPlan } from "./revisions.mjs";
import { STORAGE_KEYS_PER_CALL, guardContext } from "./storage-guard.mjs";
import { pageRecordsCall } from "./page-records.mjs";
export { PageRecords } from "./page-records.mjs";
import {
  COMMENTS_MODULE,
  PAGE_MODULE,
  SOURCES_MODULE,
  VIEW_MODULE,
  keyedDoc,
} from "./document-modules.mjs";
import {
  HOST_SENDER_ID,
  PlainSync,
  clearPrefixes,
  plainSessionReplaced,
  treeOf,
} from "./plain-sync.mjs";
import { logSyncRefused, logSyncRounds } from "./plain-sync-log.mjs";
import { BLOCKING as BLOCKING_COMMENT_CODES } from "../sync/comments.mjs";
import { DocumentPolicy, PermissionDenied, leaseExpiryError } from "./policy.mjs";
import {
  ADMISSION_ROUTES,
  admissionCloseCode,
  admissionCloseReason,
  admissionCode,
  admissionErrorResponse,
  admissionReason,
  logAdmissionDenied,
  withAdmissionReason,
} from "./admission-reasons.mjs";
import { buildAdvertisement } from "../shared/build-identity.mjs";
import { advertiseBuild } from "./build-advertisement.mjs";
import {
  bufferedResponse,
  readResponseJson,
  untilAborted,
  withinToolDeadline,
} from "./tool-deadline.mjs";

import {
  COMMENTS_DOC,
  PAGE_DOC,
  SOURCES_DOC,
  documentMutation,
  recoverDocumentMutations,
  operationKey,
  requireNonce,
  fingerprint,
  requireHeads,
} from "./mutations.mjs";

import { claimInvitation, proposeSharingMutation, sharingProjection } from "./sharing.mjs";
import { identityAudienceKeys, openedAudienceKey } from "./organization-access.mjs";
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
  CARD_IMAGE_REVISION_KEY,
  CardImageGuard,
  authorizeCardImageUpload,
  cardImageRefusal,
  deleteCardImages,
  handleCardImage,
  cardImageView,
  readCardImagePointer,
} from "./card-images.mjs";
import { MAX_TAGS_PER_PAGE, TagError, normalizeTag } from "./page-tags.mjs";
import {
  deletePageTags,
  pageTagsDatabase as openPageTags,
  readPageTags,
  tagMatchingIds,
  writePageTags,
} from "./page-tags-store.mjs";
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
  authenticateAssets,
  deleteUploadedAssets,
  handleImageAssets,
  privateImageResponse,
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
  locationAnswer,
  locationEntries,
  locationScan,
  parentActive,
  projectHoldsPages,
  projectOf,
  publicLocation,
  receiptLocation,
  movedTrashEntries,
  rekeyedEntries,
  restoreTarget,
} from "./catalog-location.mjs";
import { migrateLocationShape } from "./location-shape.mjs";
import { LOCATION_REVISION_KEY, movePage } from "./move-page.mjs";
import {
  PROJECT_ACCESS_EMPTY,
  projectAccessStep,
  resolveProjectAccess,
} from "./project-access.mjs";
import { invitedProjects } from "./project-invitations.mjs";
import { openedProjects, recordOpenedProject } from "./project-opened.mjs";
import {
  FORWARD_REJECTED_HEADER,
  PROJECT_CREATE_PATH,
  fenceMoved,
  forwardAnswer,
  forwardKey,
  forwardedCreationState,
  forwardedCreationTransition,
  projectOwnerQuotaError,
  requireCreateItems,
  validForwardId,
} from "./project-create.mjs";
import {
  MAX_DEPTH,
  deriveLocation,
  planMove,
  subtreeOf,
  validPosition,
} from "../model/location.mjs";
import {
  SPACE_LIMIT,
  projectContentMarkdown,
  newSpaceId,
  requirePageIdArgument,
  requireSpaceIdArgument,
  spaceNotFound,
  validSpaceId,
  validateSpaceDeletion,
  validateSpaceInput,
} from "./spaces.mjs";
// The class name is the storage identity for Projects; see spaces.mjs.
export { Space } from "./spaces.mjs";
import {
  PROJECT_NOT_EMPTY,
  spaceCreationEffect,
  spaceCreationTransition,
  spaceDeletion,
} from "./space-lifecycle.mjs";
import { handleImportPageImage } from "./import-image.mjs";
import {
  PROJECT_CONTENT_OPERATIONS,
  contentSelector,
  resolveProjectContent,
} from "./project-content.mjs";
import { countedStorage } from "./catalog-counts.mjs";
import {
  forwardedPageLimit,
  quotaError,
  quotaRefusal,
  resolvePageQuota,
  validPageLimit,
} from "./page-quota.mjs";
import { serialQueue, serialQueueBounds } from "./serial-queue.mjs";
import { opensIndex } from "./account-index-machine.mjs";
import { holdUntilSettled } from "./request-hold.mjs";
import { boundedMap } from "./bounded-map.mjs";
import { legibleEnv, overloadRetryAfterMs, withRepeatSafety } from "./host-busy.mjs";
import { readTool } from "./tool-reads.mjs";
import { DatasetSummaries } from "./dataset-summary.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { checkArguments } from "./tool-arguments.mjs";
import { readChangesTool } from "./tool-changes.mjs";
import { resolveWriters } from "./host-writers.mjs";
import { PageActivity } from "./page-activity.mjs";
import {
  checkPurgePreview,
  discussionOf,
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
import {
  pageStartup,
  recordAnswerable,
  recordCommentsUuid,
  recordFallback,
  startupOf,
  storedTitleProjection,
} from "./page-startup.mjs";
import {
  LINK_PREVIEW_PATH,
  PAGE_UNAVAILABLE,
  handleLinkPreview,
  linkUnavailable,
  readLinkRoute,
} from "./link-previews.mjs";
import { pageShellSlug, slugShellResponse } from "./page-shell.mjs";
import { titleProjection } from "./title-projection.mjs";

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
  ASSET_UPLOAD_OPERATION,
  "edit_page",
  "manage_page_comment",
  "reply_page_comment",
  "update_page_tags",
  "delete_page",
  "restore_page",
  "purge_page",
  "move_page",
  "create_space",
  "list_spaces",
  "get_space",
  "update_space",
  "delete_project",
  "get_project_access",
  "manage_project_access",
  "get_page_access",
  "manage_page_access",
]);
/** Refuse unless the caller can read Project `spaceId`, with the caller's
 * own credentials, as every Project read is. A project_id content address
 * never widens access: a direct grant on the document alone is not a
 * Project reader and gets not-found. */
async function requireProjectReader(request, env, spaceId) {
  requireSpaceIdArgument(spaceId);
  const response = await env.PROJECTS.getByName(spaceId).fetch(
    forwarded(request, "/internal/space/read", { space_id: spaceId, claim: false }),
  );
  if (response.ok) return void (await response.body?.cancel());
  if (response.status === 404 || response.status === 403) throw spaceNotFound();
  const body = await response.json().catch(() => ({}));
  throw new HttpError(
    response.status,
    body.error ?? "Project is temporarily unavailable",
    body.code,
  );
}
/** Project operations, under their stored Space names where a rollback build
 * reads the same records (project-api.mjs maps callers' Project names onto
 * these); delete_project has no older name. Each goes through the caller's
 * own Catalog, which calls the Project with the caller's credentials. */
const spaceOperations = [
  "create_space",
  "list_spaces",
  "get_space",
  "update_space",
  "delete_project",
];
/** The Page limit this Catalog's own gateway last resolved (rememberPageLimit). */
const PAGE_LIMIT_KEY = "host/page-limit";
/** Catalog-owned Page lifecycle operations and the Page route each one uses. */
const lifecycleRoutes = {
  delete_page: "/internal/trash",
  restore_page: "/internal/restore",
  purge_page: "/internal/purge",
};
/** The Page route that reports a Project content document's heads and
 * discussion to its owner's Catalog for delete_project. */
const CONTENT_IMPACT_PATH = "/internal/content-impact";
/** Throw when a host answered with a server error: the step's outcome is
 * open, and the retry repeats it. */
async function requireAnswer(response) {
  if (response.status < 500) return;
  await response.body?.cancel();
  throw new HttpError(503, "Project deletion is temporarily unavailable; retry the same request");
}
/** A host's refusal as an error to throw. A server error leaves the outcome
 * open and says to retry. */
async function refusalOf(response) {
  await requireAnswer(response);
  const body = await response.json().catch(() => ({}));
  return new HttpError(response.status, body.error ?? "Project deletion was refused", body.code);
}
/** Where a pending Trash or restore keeps its destination slot. */
const slotPrefix = { delete_page: "trash/", restore_page: "page/" };
/** delete_page moves a Page to Trash. Its journal fingerprint uses a distinct
 * name so a build that predates Trash cannot replay the receipt as a
 * permanent deletion: it reports an nonce conflict instead.
 */
const lifecycleFingerprint = {
  delete_page: "trash_page",
  restore_page: "restore_page",
  purge_page: "purge_page",
};
/** Whether `metadata`'s Page has a PageRecords object, and whether it may be
 * cleared: `clear` for a Page converted from `buffered` storage or a deleted
 * `buffered` Page, `held` for a live `buffered` one (its records are its only
 * history), undefined for a Page that never had one. */
function pageRecordsHolder(metadata) {
  if (metadata?.recordStorageMigratedFrom === "buffered") return "clear";
  if (metadata?.recordStorage !== "buffered") return undefined;
  return pageState(metadata) === "deleted" ? "clear" : "held";
}
const noop = async () => {};
/** A listing that met a shared Page (or its owner's Catalog) that did not
 * answer. A listing is a read, so it is retryable; an overloaded host asks
 * for the longer, jittered wait page_busy uses. */
const sharedPagesUnavailable = ({ overloaded = false } = {}) =>
  Object.assign(
    new HttpError(
      503,
      "Shared Pages are temporarily unavailable: a shared Page or its owner's Catalog did not answer. Retry the listing after retry_after_ms, backing off exponentially if it repeats.",
      "shared_page_unavailable",
    ),
    { retryAfterMs: overloaded ? overloadRetryAfterMs() : 1000 },
  );
/** A tag filter or a tag write needs D1: the `page_tags` table is the only
 * record of tags (no Durable Object, Catalog entry or Page record holds a
 * copy), so a listing never falls back to the Catalog entries for one. Coded
 * server failures are retryable. */
const tagsUnavailable = () =>
  new HttpError(
    503,
    "Page tags are temporarily unavailable: the tag database did not answer. Retry the request.",
    "tags_unavailable",
  );
/** The D1 binding for a request that needs tags, or `tags_unavailable`. D1 is
 * reached through the catalog index's binding and its `PAGES_CATALOG_INDEX`
 * gate; that makes the database available to tags, not an index of them. The
 * tag table's own schema is brought current here (page-tags-store.mjs). */
async function pageTagsDatabase(env, ctx) {
  if (!catalogIndexEpoch(env)) throw tagsUnavailable();
  try {
    return await openPageTags(env, ctx);
  } catch (error) {
    logFailure(error, "page-tags");
    throw tagsUnavailable();
  }
}
/** `value` as distinct normalized tags: an array of at most 32 valid tags, or
 * nothing. Refuses with `invalid_arguments` or `invalid_tag`, naming `field`. */
function tagList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TAGS_PER_PAGE)
    throw new HttpError(
      400,
      `${field} must be an array of at most ${MAX_TAGS_PER_PAGE} tags`,
      "invalid_arguments",
    );
  try {
    return [...new Set(value.map(normalizeTag))];
  } catch (error) {
    if (!(error instanceof TagError)) throw error;
    throw new HttpError(400, `${field}: ${error.message}`, "invalid_tag");
  }
}
const requestedTags = (value) => tagList(value, "tags");
/** What a Page's or a Catalog's `run` returns for a request whose queue work
 * is done: `work` answers the request once the queue has released it (Page
 * `enqueue`, Catalog `fetch`). */
class AfterQueue {
  constructor(work) {
    this.work = work;
  }
  finish() {
    return this.work();
  }
}
/** The error an abandoned object refuses with when its reset gave no reason. */
const abandonedError = () => Object.assign(Error("Page object was reset"), { status: 503 });
/** Viewer builds that speak plain Automerge sync send `sync=automerge` on
 * the socket. An older build is refused an `automerge` Page's socket as
 * schema_unsupported, which it shows as "Reload to update". Discovery stays
 * open to every reader: scripts use it as an access probe. */
function requirePlainSyncClient(request) {
  if (new URL(request.url).searchParams.get("sync") === "automerge") return;
  throw withAdmissionReason(schemaUnsupported(["automerge-sync"]), "schema_unsupported");
}

/** A socket's client declares the document formats it reads as `formats`;
 * `record` is the formats the Page's host record names. Every member type
 * the record names is required of every socket, including a comments
 * document the Page gains while the socket is open. A client that lacks one
 * is refused as schema_unsupported, which its viewer shows as "Reload to
 * update". A type a Page may hold beside them, such as `pages.sources`, is
 * not required: a socket that doesn't declare it opens the Page and its
 * comments, and is not served that document (plain-sync.mjs). */
function requireReadableDocuments(declared, record) {
  const members = formatPairs(record).filter(({ type }) => MEMBER_TYPES.includes(type));
  if (!missingFormats(declared, members).length) return;
  throw withAdmissionReason(schemaUnsupported(["document-formats"]), "schema_unsupported");
}

/** Whether a Page's host record names its sources document: the record
 * names `pages.sources` once the host created it (sources-lifecycle.mjs). */
const recordNamesSources = (record) =>
  Object.hasOwn(recordDocumentFormats(record ?? {}) ?? {}, SOURCES_MODULE.type);

/** A sources document refusal (model/sources-doc.mjs) as the agent edge
 * answers it, with its source_id and current source_revision. */
const sourceRefusal = (error) =>
  Object.assign(
    new HttpError(error.status ?? 400, error.message, error.code ?? "invalid_source"),
    error.details && { details: error.details },
  );
/** A view refusal (model/view-doc.mjs) as the agent edge answers it, with
 * its view_id and current view_revision where it has them. */
const viewRefusal = (error) =>
  Object.assign(
    new HttpError(error.status ?? 400, error.message, error.code ?? "invalid_view"),
    error.details && { details: error.details },
  );

/** The Page host's list of its views: one key per view whose document the
 * host created, `host/view/<view_id>` → `{ format }`. Normative: written in
 * the same put as the record step of the view's lifecycle
 * (view-lifecycle.mjs), read at boot, for /api/connect, the view cap and
 * purge, so the host never reads the Page body to find its views. */
const VIEW_KEY_PREFIX = "host/view/";
const viewKey = (viewId) => `${VIEW_KEY_PREFIX}${viewId}`;

/** Page host routes a record in a format this build doesn't write still
 * answers once the caller may read it: the shared-Page check and sharing
 * read the record alone, and the socket refuses in connect(). Trash,
 * restore and permanent deletion run before that check. */
const RECORD_ROUTES = Object.freeze(["/internal/catalog", "/internal/access", "/api/sync"]);

/** One structured line when the comments document's per-author check
 * refuses a comment change: the Page, the rule it broke, never content. */
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
/** How long a permanent deletion waits for its uploaded assets to go. */
const ASSET_DELETE_TIMEOUT_MS = 10_000;
/** How long a read waits on a dataset's summary before leaving it out. */
const DATASET_SUMMARY_TIMEOUT_MS = 5_000;
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
  ["page_has_children", "project_content_protected"].includes(error.code)
    ? { status: error.status, body: { error: error.message, code: error.code } }
    : undefined;
/** A Project content document's Catalog marker. It has no location: it is
 * not a Page in the tree (catalog-location.mjs). */
const contentMarker = (spaceId) => ({ project_content: spaceId });
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
 * holding that title keep their own time (`title-projection.mjs`). */
const TITLE_PROJECTION_KEY = "host/title-projection";
/** `true` while a projection of the title to the owner's and members'
 * Catalogs hasn't been seen to land everywhere. Written before the title it
 * sends is stored, removed once every Catalog took it. A check from the host
 * record boots while it is set, so the loaded host's first check sends the
 * title again (`cacheTitle`). */
const PROJECTION_PENDING = "host/title-projection/pending";
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
/** A trash's base heads as requireHeads judges them, or `absent` when the
 * request named none. The lifecycle machine decides what absence means. */
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
/** A delete_project trash's `base_comment_heads` against the comments
 * document (`[]` when the Page has none), judged like headsCheck. */
function commentHeadsCheck(commentsDoc, heads) {
  if (heads === undefined) return "absent";
  if (!Array.isArray(heads) || heads.some((head) => typeof head !== "string")) return "invalid";
  return sameHeads(commentsDoc ? A.getHeads(commentsDoc) : [], heads) ? "match" : "mismatch";
}
const publicIdentity = ({ principal, displayName, driver }) => ({ principal, displayName, driver });
/** A new Page's first block, as create_page reports it: the block's id and
 * its nodes' ids (model/addresses.mjs). */
const firstBlockAddresses = (doc) => {
  const key = orderedBlockIds(doc)[0];
  return { node_id: blockAddress(doc, key), nodes: nodeAddresses(doc, key) };
};
/** Lifecycle arguments as the caller sent them. The Catalog alone sets the
 * compare-and-set controls it forwards to a Page, and only delete_project's
 * own trash, a host-to-host call, sends `base_comment_heads`. A caller's
 * trash names a `revision`, or, from a browser session only, the heads it
 * shows as `base_heads` (BROWSER_TRASH_GUARD in tool-arguments.mjs). */
const callerLifecycleArguments = ({
  expected_revision: _expected,
  replay_only: _replay,
  base_comment_heads: _commentHeads,
  ...requested
}) => requested;

function validateCreateInput(args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new HttpError(400, "Invalid create arguments");
  if (
    args.title !== undefined &&
    (typeof args.title !== "string" || args.title.length > MAX_PAGE_TITLE)
  )
    throw new HttpError(400, `title is a string of at most ${MAX_PAGE_TITLE} characters`);
  if (args.markdown !== undefined && typeof args.markdown !== "string")
    throw new HttpError(400, "Invalid markdown");
  // Refused before any reservation, so the agent can rewrite and retry.
  const unsupported = args.markdown && unsupportedMarkdown(args.markdown);
  if (unsupported) throw unsupportedMarkdownError(unsupported);
}

/** move_page's place among its new siblings, as the catalog's position value:
 * `position` is "first" or "last", `before` and `after` name a sibling Page,
 * and none of them means last. A caller gives at most one. */
function requestedPosition(args) {
  const named = ["position", "before", "after"].filter((key) => args[key] !== undefined);
  if (named.length > 1)
    throw new HttpError(400, "Give at most one of position, before or after", "invalid_position");
  const [key] = named;
  if (key === undefined) return "last";
  const position = key === "position" ? args.position : { [key]: args[key] };
  if ((key === "position" && typeof position !== "string") || !validPosition(position))
    throw new HttpError(
      400,
      'position is "first" or "last"; before and after take a sibling page_id',
      "invalid_position",
    );
  return position;
}

/**
 * move_page's arguments as the Catalog runs them: `{ pageId, parentId,
 * spaceId, position }`. Every refusal here is deterministic input, so it
 * consumes no key and runs no shape pass. The destination is any of:
 * - `parent_id`: under that Page, in whichever container it sits (a Project
 *   or Your items);
 * - `space_id` (the API's `project_id`, mapped by the Project API) naming a
 *   Project: its top level, a root carrying its space_id;
 * - `space_id: null`: a root in Your items.
 * Both together must agree (`placement_mismatch`). Naming neither is
 * `move_destination_required`, the one destination this tool can't place.
 * `spaceId` is undefined when no Project was named. The nonce is required:
 * a move's lost answer is reconciled by replaying its receipt.
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
  const position = requestedPosition(args);
  requireNonce(args);
  return { pageId, parentId, spaceId, position };
}

/** The `_meta.agent` assertions of an /api/tools body, in the bounds an MCP
 * request's are. Other `_meta` keys are ignored. */
function bodyAgent(body) {
  const meta = body?._meta;
  if (meta === undefined) return undefined;
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new HttpError(400, "Invalid _meta", "invalid_arguments");
  return normalizeAgentAssertions(meta.agent);
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
  forwardClientProvenance(request, headers);
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

/** authorizeImage for an upload capability (asset-uploads.mjs). The host
 * request carries only the capability: no cookie, bearer credential or label
 * of the caller's. The Page host verifies it with its own key and decides
 * access for the principal it names, on each call. */
function authorizeUpload(request, env, pageId, capability) {
  const url = new URL(request.url);
  url.pathname = ASSET_AUTHORIZE_PATH;
  url.search = "";
  return env.PAGES.getByName(pageId).fetch(
    new Request(url, {
      method: "POST",
      headers: {
        authorization: `${ASSET_UPLOAD_SCHEME} ${capability}`,
        origin: new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ page_id: pageId, write: true }),
    }),
  );
}

/** The Page host's card image upload check (card-images.mjs). Like
 * authorizeImage, a short host-created request; the bytes stay here. */
function authorizeCardImage(request, env, pageId, { hash, theme }) {
  const internal = forwarded(request, "/internal/card-image/authorize", {
    page_id: pageId,
    hash,
    theme,
  });
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
  "get_project_access",
  "get_page_access",
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
 * progress renewal or clear (the lease names its session), or a write with a
 * valid nonce, whose receipt a repeat with the same nonce and arguments
 * returns. A progress creation is not: a repeat mints a second session and
 * the first one's lease is lost, so it gets lease advice. */
const safeToRepeat = (operation, args) => {
  // Issuing an upload URL changes nothing; a repeat issues another one.
  if (operation === ASSET_UPLOAD_OPERATION) return true;
  // Tags are a set: adding or removing one twice changes nothing.
  if (operation === "update_page_tags") return true;
  if (operation === "report_page_progress")
    return typeof args?.progress_id === "string" && typeof args?.lease_token === "string"
      ? true
      : "lease";
  return READ_OPERATIONS.includes(operation) || hasNonce(args);
};

/** Run one public tool call. `call` is the call as its caller sent it,
 * `{ transport, operation, args }` in the API's names, checked against the
 * arguments its operation takes (tool-arguments.mjs) once the credential may
 * make the call: a credential that can't learns that first. */
async function invoke(request, env, operation, args = {}, seen, call) {
  if (!operations.has(operation)) throw unknownOperation(operation, operations);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw invalidArguments();
  const identity = await authenticate(request, env);
  if (seen) seen.identity = identity;
  if (
    [
      "get_project_access",
      "manage_project_access",
      "get_page_access",
      "manage_page_access",
    ].includes(operation)
  ) {
    if (identity.credentialKind === "oauth" && !identity.canShare)
      throw new HttpError(403, "Pages sharing permission is required", "oauth_insufficient_scope");
    const read = operation.startsWith("get_");
    if (!read) requireWrite(identity);
    if (call) checkArguments(call, identity);
    if (operation.endsWith("project_access")) {
      requireSpaceIdArgument(args.space_id);
      return env.CATALOGS.getByName(identity.principal).fetch(
        forwarded(request, "/internal/catalog", { operation, arguments: { ...args, read } }),
      );
    }
    requirePageIdArgument(args.page_id);
    return env.PAGES.getByName(args.page_id).fetch(
      forwarded(request, "/internal/access", { ...args, read }),
    );
  }
  if (!READ_OPERATIONS.includes(operation)) requireWrite(identity);
  if (call) checkArguments(call, identity);
  if (["get_space", "update_space", "delete_project"].includes(operation))
    requireSpaceIdArgument(args.space_id);
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
    const safe = safeToRepeat(operation, args);
    return withinToolDeadline(
      async (signal) =>
        bufferedResponse(
          await withRepeatSafety(
            await untilAborted(
              env.CATALOGS.getByName(identity.principal).fetch(
                forwarded(request, "/internal/catalog", body),
                { signal },
              ),
              signal,
            ),
            safe,
            signal,
          ),
          signal,
        ),
      { safe },
    );
  }
  const projectId = PROJECT_CONTENT_OPERATIONS.has(operation) ? contentSelector(args) : null;
  if (!projectId) requirePageIdArgument(args.page_id);
  // Mapping, Page admission and response projection share one deadline.
  const safe = safeToRepeat(operation, args);
  return withinToolDeadline(
    async (signal) => {
      if (projectId) {
        await untilAborted(requireProjectReader(request, env, projectId), signal);
        args = await resolveProjectContent(env, args, signal);
      }
      if (operation === "import_page_image") {
        if (Object.keys(args).some((key) => !["page_id", "file"].includes(key)))
          throw new HttpError(400, "Invalid image import arguments");
        // Transfer bytes at the Worker edge; access stays with the Page host.
        const imported = await untilAborted(
          handleImportPageImage(request, env, {
            pageId: args.page_id,
            file: args.file,
            authorize: (write) => authorizeImage(request, env, args.page_id, write),
          }),
          signal,
        );
        if (!projectId || !imported.ok) return bufferedResponse(imported, signal);
        // Named as every Project-addressed answer is, below.
        const body = await readResponseJson(imported, signal);
        return json({ ...body, kind: "project", project_id: projectId }, imported.status);
      }
      // Transient and storage failures use this request's repeat safety,
      // as a timeout does.
      const response = await withRepeatSafety(
        await untilAborted(
          env.PAGES.getByName(args.page_id).fetch(
            forwarded(request, "/internal/tool", { operation, arguments: args }),
            { signal },
          ),
          signal,
        ),
        safe,
        signal,
      );
      if (!response.ok || (operation !== "read_page" && !projectId))
        return bufferedResponse(response, signal);
      const body = await readResponseJson(response, signal);
      // A project_id address answers only to a caller who can read the
      // Project; locationView then reports it as Project content. A direct
      // grant alone reads by document ID and is never told the Project.
      // Every other tool's answer names it as read_page does: kind project
      // beside project_id, so its link is the Project's, not the document's.
      if (projectId && operation !== "read_page") {
        delete body._owner;
        body.kind = "project";
        body.project_id = projectId;
      } else await locationView(request, env, body, signal);
      return json(body, response.status);
    },
    { safe },
  );
}

/** Which of `ids` the caller's Catalog allows cards for (page-cards.mjs
 * allowedPageCards): `{ body: { allowed, principal } }`, or `{ refused }`
 * with the Catalog's own refusal. No Page document loads. */
async function allowedCards(request, env, identity, ids) {
  const internal = forwarded(request, "/internal/catalog", {
    operation: "page_cards",
    arguments: { page_ids: ids },
  });
  // An <img> fetch sends no Origin; this request is the gateway's own.
  if (!internal.headers.has("origin"))
    internal.headers.set("origin", new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin);
  return withinToolDeadline(async (signal) => {
    const response = await untilAborted(
      env.CATALOGS.getByName(identity.principal).fetch(internal, { signal }),
      signal,
    );
    // A refusal passes through as the Catalog wrote it, JSON or not.
    if (response.status !== 200) return { refused: await bufferedResponse(response, signal) };
    return { body: await readResponseJson(response, signal) };
  });
}

/**
 * page_cards (page-cards.mjs). The caller's Catalog answers which IDs it
 * allows, from inside its serial queue; the card objects are read here,
 * after that queue has moved on, so a slow bucket never holds the account's
 * listings or writes. Only the allowed IDs reach the bucket.
 */
async function pageCards(request, env, identity, args) {
  const ids = parsePageCardIds(args.page_ids);
  const decided = await allowedCards(request, env, identity, ids);
  if (decided.refused) return decided.refused;
  const allowed = Array.isArray(decided.body?.allowed) ? decided.body.allowed : [];
  const bucket = env.PAGES_ASSETS;
  const cards = await readPageCards(ids, bucket ? allowed : [], {
    readObject: async (key) => {
      const object = await bucket.get(key);
      return object ? await object.text() : null;
    },
    readImage: async (id) => cardImageView(id, await readCardImagePointer(bucket, id)),
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
    chain.unshift({ kind: "page", page_id: ancestors[index], title: catalogTitle(parent.title) });
  }
  const reachedRoot = location.complete && chain.length === location.ancestors.length;
  if (location.parent_id && chain.at(-1)?.page_id === location.parent_id)
    body.parent_id = location.parent_id;
  const space = location.space_id
    ? await readable(
        env.PROJECTS,
        location.space_id,
        // Decorating a response never claims an invitation.
        forwarded(request, "/internal/space/read", {
          space_id: location.space_id,
          claim: false,
        }),
      )
    : null;
  if (space) {
    body.space_id = location.space_id;
    if (!location.parent_id) body.parent_id = null;
    // A Project's content document reads as the Project itself, only for a
    // caller who can read the Project.
    if (location.content) body.kind = "project";
    // The whole chain is visible to whoever can read the Project in this build.
    if (reachedRoot) chain.unshift({ kind: "space", space_id: space.space_id, title: space.title });
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
function toolUsage(request, surface, operation, args, kind = "tool", env) {
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
        logUsage({ action: "tool.call", ...common, bytes: length || undefined }, env);
        if (name === "create_page" && response.ok && !replayed) {
          const body = await response.clone().json();
          logUsage(
            {
              action: "page.create",
              ...common,
              pageId: body?.page_id,
              projectId: body?.project_id ?? common.projectId,
            },
            env,
          );
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
  async fetch(request, env, ctx) {
    // celld answers a stub fetch to a saturated object itself, with a plain
    // 503; the gateway is the first code that can name it (host-busy.mjs).
    try {
      // Plain HTTP through Cloudflare is redirected before anything else runs
      // (transport-security.mjs).
      const insecure = httpsRedirect(request, env);
      if (insecure) return insecure;
      const misconfigured = sessionKeysFailure(env);
      if (misconfigured) return withTransportSecurity(request, misconfigured);
      return withTransportSecurity(
        request,
        advertiseBuild(request, await gateway.fetch(request, legibleEnv(env))),
      );
    } finally {
      flushUsage(env, ctx);
    }
  },
  async scheduled(controller, env) {
    assertSessionKeyring(env);
    await runScheduled(controller, env);
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
        const local = await handleLocalOidcRequest(request, env, { store: localOidcStore(env.DB) });
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
      if (url.pathname === "/whoami") {
        if (request.method !== "GET") {
          const response = json({ error: "Use GET" }, 405);
          response.headers.set("allow", "GET");
          return response;
        }
        const identity = await authenticate(request, env);
        return json({
          account: accountIdentity(identity),
          credential: { kind: identity.credentialKind, can_write: identity.canWrite },
        });
      }
      const kilo = await handleKiloSignIn(request, env);
      if (kilo) return kilo;
      if (url.pathname === "/api/auth/login" && request.method === "GET")
        return beginServerOidcLogin(request, env);
      if (url.pathname === "/oidc")
        return completeServerOidcLogin(request, env, noop, signInCallbackOptions);
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        requireSameOrigin(request, env);
        // The audit line names who signed out; a missing or unreadable
        // session still signs out.
        const signedIn = await loadServerSession(env, request, Math.floor(Date.now() / 1000)).catch(
          () => null,
        );
        const signedOut = await deleteServerOidcSession(request, env);
        if (signedIn)
          await logAuthEvent({
            action: "sign_out",
            principal: sessionRowPrincipal(signedIn),
            credential: "oidc",
          });
        return signedOut;
      }
      const account = await handleAccountAuth(request, env);
      if (account) return account;
      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        let refreshed;
        if (!request.headers.has("authorization")) {
          refreshed = await serverOidcSessionStatus(request, env, noop, {
            onAuthEvent: recordOidcEvent,
            provider: kiloSessionProvider(env, request),
          });
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
                canWrite: identity.canWrite,
                expiresAt: identity.expiresAt,
                // This host serves account-auth.mjs, which only a browser
                // session may call. A viewer shows Connected agents and Sign
                // out everywhere only when this is true.
                accountControls: identity.credentialKind === "oidc",
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
          async (operation, args, { kind = "tool", agent } = {}) => {
            const invocationRequest = withMcpAgent(request, agent);
            const usage = toolUsage(request, "mcp", operation, args, kind, env);
            // A refusal before invoke() authenticates still names the caller.
            usage.seen.identity = identity;
            let response;
            try {
              response = await invokeProjectApi(
                (internal, internalArgs) =>
                  invoke(invocationRequest, env, internal, internalArgs, usage.seen, {
                    transport: "mcp",
                    operation,
                    args,
                  }),
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
              logUsage(
                {
                  action: "mcp.initialize",
                  surface: "mcp",
                  identity,
                  labels: {
                    ...declared,
                    ...(!declared.client && mcpClient && { client: mcpClient }),
                    ...(mcpClient && { mcp_client: mcpClient }),
                  },
                  protocolVersion: params.protocolVersion,
                },
                env,
              );
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
          logUsage(
            {
              action: "page.create",
              surface: "browser-sync",
              identity,
              labels: requestClient(request),
              operation: "register_page",
              pageId: args?.page_id,
              status: response.status,
              outcome: "ok",
              latencyMs: Date.now() - started,
            },
            env,
          );
        return response;
      }
      if (url.pathname === "/api/tools" && request.method === "POST") {
        let response;
        let usage = toolUsage(request, "http-tools", undefined, undefined, "tool", env);
        try {
          const body = await readJson(request);
          usage = toolUsage(request, "http-tools", body?.operation, body?.arguments, "tool", env);
          const invocationRequest = withMcpAgent(request, bodyAgent(body));
          response = await invokeProjectApi(
            (internal, internalArgs) =>
              invoke(invocationRequest, env, internal, internalArgs, usage.seen, {
                transport: "http-tools",
                operation: body.operation,
                args: body.arguments,
              }),
            body.operation,
            body.arguments,
            { env },
          );
        } catch (error) {
          response = errorResponse(error, "gateway");
        }
        return await withRefusalCode(await usage.finish(response));
      }
      const imageRoute = url.pathname.match(
        /^\/api\/(pages|projects)\/([^/]+)\/assets(?:\/([^/]+))?$/,
      );
      if (imageRoute) {
        const [, container, id, assetId] = imageRoute;
        // An upload capability from create_page_asset_upload authorizes one
        // thing: a POST of file bytes to its own Page's asset route. It never
        // reaches authenticate(), so it is never sent to the API-key verifier
        // or read as an OAuth token, and no other route accepts its scheme.
        const capability = uploadCapabilityToken(request);
        if (capability !== undefined) {
          if (container !== "pages" || assetId !== undefined || request.method !== "POST")
            return await withRefusalCode(
              privateImageResponse(errorResponse(uploadRefusal("misused"), "image-assets")),
            );
          return await withRefusalCode(
            await handleImageAssets(request, env, {
              pageId: id,
              identify: () => requireSameOrigin(request, env),
              authorize: () => authorizeUpload(request, env, id, capability),
            }),
          );
        }
        // A Project's assets belong to its content document.
        let pageId = id;
        if (container === "projects") {
          try {
            // The route's own credential check comes before the Project
            // lookup, which forwards the bearer to the Project host.
            await authenticateAssets(
              request,
              env,
              assetId === undefined && request.method === "POST",
            );
            await requireProjectReader(request, env, id);
            pageId = (
              await resolveProjectContent(env, { project_id: id }, new AbortController().signal)
            ).page_id;
          } catch (error) {
            return await withRefusalCode(
              privateImageResponse(errorResponse(error, "image-assets")),
            );
          }
        }
        // API-key clients upload here too; their refusals get a code as on /api/tools.
        return await withRefusalCode(
          await handleImageAssets(request, env, {
            pageId,
            assetId,
            authorize: (write) => authorizeImage(request, env, pageId, write),
            // A dataset copied from another Page: the source's own read check,
            // exactly as a read of its asset URL asks it.
            authorizeSource: (sourceId) => authorizeImage(request, env, sourceId, false),
          }),
        );
      }
      const cardImageRoute = url.pathname.match(
        /^\/api\/pages\/([^/]+)\/card-image(?:\/([^/]+))?$/,
      );
      if (cardImageRoute) {
        const [, pageId, file] = cardImageRoute;
        return await handleCardImage(request, env, {
          pageId,
          file,
          authorizeUpload: (args) => authorizeCardImage(request, env, pageId, args),
          // A card image is read where its card is: page_cards' decision.
          authorizeRead: async (identity) => {
            const decided = await allowedCards(request, env, identity, [pageId]);
            return !decided.refused && decided.body?.allowed?.includes(pageId) === true;
          },
          recheckUpload: () => authorizeImage(request, env, pageId, false),
        });
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
      // What a link to a Page or a Project shows its reader
      // (link-previews.mjs). Only /p/<id>/{meta,card}.json and
      // /project/<id>/{meta,card}.json; everything else under /p/, /project/
      // and /s/ is the app's.
      const linkRoute = readLinkRoute(url.pathname);
      if (linkRoute) return await handleLinkPreview(request, env, linkRoute, { logFailure });
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/"))
        return json({ error: "Not found" }, 404);
      // A chart Worker runs under the CSP delivered with its own script, so
      // every viewer chunk carries one that allows nothing. Set here, not in
      // public/_headers, so it holds wherever this Worker serves the assets.
      if (CHUNK_PATH.test(url.pathname))
        return setResponseHeaders(await env.ASSETS.fetch(request), [
          ["Content-Security-Policy", CHART_WORKER_CSP],
        ]);
      // A Page link with a slug: the shell titled with the slug's words, for
      // link previews (page-shell.mjs).
      const slug = pageShellSlug(request, url);
      if (slug) return await slugShellResponse(request, env.ASSETS, slug);
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
    return (this.counted ??= countedStorage(this.ctx.storage, { ctx: this.ctx }));
  }
  fetch(request) {
    // Location reads write nothing, so they never wait behind the queue. A
    // Catalog listing a shared parent asks the owner's Catalog from inside
    // its own queue; two Catalogs doing that to each other must not wait on
    // each other.
    if (new URL(request.url).pathname === "/internal/location") return this.location(request);
    if (new URL(request.url).pathname === "/internal/project-discovery") return this.run(request);
    // A request whose `run` returns `AfterQueue` finishes after the queue has
    // released it, and holds itself open until then (request-hold.mjs).
    const answer = this.queue(() => this.run(request)).then((result) =>
      result instanceof AfterQueue ? result.finish() : result,
    );
    holdUntilSettled(this.ctx, answer);
    return answer;
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
      if (query?.creation_of !== undefined) {
        // A Page host checking a forwarded creation (Page
        // requireDelegatedCreation): the creator this Catalog reserved the
        // Page for, while the creation is still pending. Host only.
        if (request.headers.has("authorization") || request.headers.has("cookie"))
          throw new HttpError(403, "Host only");
        if (!validPageId(query.creation_of)) throw new HttpError(400, "Invalid creation_of");
        const entry = await this.storage.get(`page/${query.creation_of}`);
        if (!entry?.pending || typeof entry.creator !== "string")
          throw new HttpError(404, "No pending creation");
        return json({
          page_id: entry.page_id,
          creator: entry.creator,
          owner_name: typeof entry.owner_name === "string" ? entry.owner_name : null,
        });
      }
      const { entries, contents } = await locationScan(this.storage);
      if (query?.project_content !== undefined) {
        if (request.headers.has("authorization") || request.headers.has("cookie"))
          throw spaceNotFound();
        requireSpaceIdArgument(query.project_content);
        const record = await this.storage.get(`space/${query.project_content}`);
        const content = contents.get(query.page_id);
        if (
          !record ||
          record.pending ||
          record.deletion ||
          record.space_id !== query.project_content ||
          record.document_id !== query.page_id ||
          content?.state !== "active" ||
          content.space_id !== query.project_content
        )
          throw spaceNotFound();
        await this.storage.sync();
        return json({ page_id: query.page_id });
      }
      if (query?.project_pages !== undefined) {
        requireSpaceIdArgument(query.project_pages);
        return json({
          pages: [...entries.values()]
            .filter(
              (entry) =>
                entry.state === "active" &&
                projectOf(entries, entry.page_id) === query.project_pages,
            )
            .map((entry) => ({ ...entry, space_id: query.project_pages })),
        });
      }
      if (query?.children_of !== undefined) {
        if (!validPageId(query.children_of)) throw new HttpError(400, "Invalid children_of");
        return json({ children: childrenOf(entries, query.children_of) });
      }
      if (!validPageId(query?.page_id)) throw new HttpError(400, "Invalid page_id");
      const answer = locationAnswer(entries, query.page_id, contents);
      if (!answer) throw new HttpError(404, "Page not found");
      return json(answer);
    } catch (error) {
      return errorResponse(error, "catalog-location");
    }
  }
  async countEntries(prefix) {
    return countCapacity(this.storage, prefix, { current: (pageId) => this.pageLifecycle(pageId) });
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
        new Request("https://pages.internal/internal/tombstone", { method: "POST" }),
      );
    } catch (error) {
      logFailure(error, "catalog-tombstone");
    }
  }
  /**
   * The Catalog's location shape, brought up to date. Every queued write
   * runs this once its input is sound and before it reserves or writes
   * anything; a `migrated` record costs one read (location-shape.mjs).
   */
  async locationShape() {
    return migrateLocationShape(this.storage);
  }
  async run(request) {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/internal/project-discovery") {
        if (request.headers.has("authorization") || request.headers.has("cookie"))
          throw new HttpError(403, "Host only");
        const value = await readJson(request);
        requireSpaceIdArgument(value.space_id);
        // An opened hint (project-opened.mjs) is written with storage
        // operations only: this route runs outside the queue, inside the
        // Project host's read, so it never awaits another host. A body that
        // also says `remove` drops the member hint in the same request, for a
        // member removed from a Project with an organization grant. The
        // opened hint goes first: a failure after it leaves the member hint,
        // which the list re-checks and the member reclaim drops, never
        // neither.
        if (value.opened === true) {
          await recordOpenedProject(this.storage, value);
          if (value.remove === true)
            await this.storage.delete(`project-discovery/${value.space_id}`);
          return json({ ok: true });
        }
        if (value.remove === true) {
          await this.storage.delete(`project-discovery/${value.space_id}`);
          return json({ ok: true });
        }
        const known = await this.storage.get(`project-discovery/${value.space_id}`);
        if (
          !known &&
          (await this.storage.list({ prefix: "project-discovery/", limit: 500 })).size >= 500
        ) {
          for (const [key, hint] of await this.storage.list({ prefix: "project-discovery/" })) {
            const response = await this.env.PROJECTS.getByName(hint.space_id).fetch(
              new Request("https://pages.internal/internal/space/policy", {
                method: "POST",
                body: JSON.stringify({ space_id: hint.space_id, owner: hint.owner }),
              }),
            );
            if (
              response.status === 404 ||
              (response.ok &&
                !["viewer", "commenter", "editor"].includes(
                  (await response.json()).acl?.members?.[this.ctx.id.name]?.role,
                ))
            )
              await this.storage.delete(key);
          }
          if ((await this.storage.list({ prefix: "project-discovery/", limit: 500 })).size >= 500)
            throw new HttpError(409, "This account already has 500 shared Projects");
        }
        await this.storage.put(`project-discovery/${value.space_id}`, {
          space_id: value.space_id,
          owner: value.owner,
        });
        return json({ ok: true });
      }
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
            await this.storage.put(key, { ...previous, content_updated_at: content });
        } else if (
          value.keep_time === true &&
          previous &&
          !previous.pending &&
          previous.title === catalogTitle(value.title)
        ) {
          // The host repeats an observation of the title this entry holds
          // (a restart, a retry): `updated_at` keeps its time.
          if (contentMoved)
            await this.storage.put(key, { ...previous, content_updated_at: content });
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
          await this.storage.put(key, { ...previous, content_updated_at: content });
        return json({ ok: true });
      }
      // A Project member's create_page, forwarded by the member's Catalog.
      // It runs as the member, so it comes before the own-account check.
      if (pathname === PROJECT_CREATE_PATH) return await this.projectCreate(request);
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
      if (body.operation === "list_pages") {
        // The owner's listing is where a forwarded creation learns its limit.
        await this.rememberPageLimit(body.page_limit);
        return await this.listPages(request, identity, args, limit);
      }
      if (body.operation === "page_cards") return await this.pageCards(request, identity, args);
      if (body.operation === "list_spaces") return await this.listSpaces(request, identity, args);
      if (body.operation === "get_space") return await this.getSpace(request, args);
      if (["get_project_access", "manage_project_access"].includes(body.operation)) {
        requireSpaceIdArgument(args.space_id);
        return this.env.PROJECTS.getByName(args.space_id).fetch(
          forwarded(request, "/internal/space/access", args),
        );
      }
      requireWrite(identity);
      if (body.operation === "create_space")
        return await this.createSpace(request, identity, args, limit);
      if (body.operation === "update_space") return await this.updateSpace(request, identity, args);
      if (body.operation === "delete_project")
        return await this.deleteSpace(request, identity, args);
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
      // A Project's content leaves Trash or storage only through
      // delete_project, which trashes and purges it itself.
      if (
        ["restore_page", "purge_page"].includes(body.operation) &&
        (await this.storage.get(`page/${args.page_id}`))?.project_content
      )
        throw new HttpError(
          409,
          "This is a Project's content. It belongs to its Project and can't be restored or purged on its own; delete_project removes it",
          "project_content_protected",
        );
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
      // The tags a create_page asks for are checked before anything is
      // reserved: an invalid tag creates nothing. They are written once the
      // receipt exists, after the queue has released the request (tagCreated).
      let createTags = [];
      if (body.operation === "create_page") {
        validateCreateInput(args);
        createTags = requestedTags(args.tags);
      }
      const withTags = (response) =>
        createTags.length
          ? new AfterQueue(() => this.tagCreated(request, response, createTags))
          : response;
      if (registering) {
        requireRegistrationAccount(args, identity);
        // A retry of a registration this Catalog already recorded resends the
        // bytes the browser saved with the draft, which this build may no
        // longer accept fresh. Its receipt, or for a pending one the Page
        // host's record, answers it, so only a new request is validated.
        const recorded = await this.storage.get(await operationKey(args, identity, "catalog"));
        const digest =
          recorded &&
          (await fingerprint(
            lifecycleFingerprint[body.operation] ?? body.operation,
            args,
            identity,
          ));
        if (recorded?.fingerprint !== digest || !digest) A.free(readRegistration(args).doc);
        // The browser knows its UUID before the Page host has an intent. A
        // successful deletion must also cancel retries of that local creation.
        if (await this.storage.get(`host/deleted/${args.page_id}`))
          throw new HttpError(409, "Page was deleted");
      }
      // Input is sound: this write runs the shape pass first.
      await this.locationShape();
      const key = await operationKey(args, identity, "catalog");
      const digest = await fingerprint(
        lifecycleFingerprint[body.operation] ?? body.operation,
        args,
        identity,
      );
      const inspected = await inspectOperation(this.storage, { key, digest });
      if (lifecycle)
        return await this.runLifecycle(request, body.operation, args, {
          key,
          digest,
          inspected,
          limit,
          principal: identity.principal,
        });
      // A placement in a Project another account owns goes to that owner's
      // Catalog; this Catalog keeps only the forwarding record.
      if (
        body.operation === "create_page" &&
        (inspected.entry ? !!inspected.entry.forward : await this.placedElsewhere(args))
      )
        return withTags(
          await this.forwardCreate(request, identity, args, { key, digest, inspected }),
        );
      let intent = inspected.entry;
      if (intent && !intent.pending) {
        // A previous attempt may have stored its receipt before sync failed.
        await this.storage.sync();
        const replay = json(intent.receipt);
        replay.headers.set(REPLAYED_RECEIPT_HEADER, "1");
        return withTags(replay);
      }
      if (!intent) {
        await this.requirePageRoom(limit);
        if (
          registering &&
          ((await this.storage.get(`page/${args.page_id}`)) ||
            (await this.storage.get(`trash/${args.page_id}`)))
        )
          throw new HttpError(
            409,
            "Page already has another creation request",
            "creation_conflict",
          );
        const { location, rekeyed } = await this.resolveLocation(request, registering ? {} : args);
        intent = {
          fingerprint: digest,
          pending: true,
          pageId: body.operation === "create_page" ? crypto.randomUUID() : args.page_id,
          createdAt: new Date().toISOString(),
        };
        intent = await reserveOperation(this.storage, { key, entry: intent });
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
      return withTags(
        await this.completeCreation(request, {
          key,
          intent,
          args,
          registering,
          resumed: !!inspected.entry,
          owner: identity.principal,
        }),
      );
    } catch (error) {
      return errorResponse(error, "catalog");
    }
  }

  /**
   * Tag the Page a create_page made, once its receipt exists and this
   * Catalog's queue has released the request. `response` is the receipt
   * (fresh, replayed or forwarded); a failed one passes through. The tags are
   * an update_page_tags call to the Page host with the caller's own
   * credential, so the host decides edit access and Trash state now, as for a
   * direct call, on every attempt including a replay. A caller who can no
   * longer edit the Page gets the receipt with the host's refusal code and no
   * tags. The Page exists by now and the receipt is recorded, so a write that
   * fails doesn't undo the creation: the receipt says `tags_applied: false`,
   * and repeating the same call (same nonce) replays the receipt and writes
   * the tags again, which is safe because tags are a set.
   */
  async tagCreated(request, response, add) {
    if (!response.ok) return response;
    const receipt = await response.clone().json();
    let outcome;
    try {
      const reply = await this.env.PAGES.getByName(receipt.page_id).fetch(
        forwarded(request, "/internal/tool", {
          operation: "update_page_tags",
          arguments: { page_id: receipt.page_id, add },
        }),
      );
      const answer = await reply.json().catch(() => ({}));
      if (!reply.ok) throw new HttpError(reply.status, answer.error, answer.code);
      outcome = { tags: answer.tags };
    } catch (error) {
      if (!(error instanceof HttpError)) logFailure(error, "page-tags");
      // The refusal a direct update_page_tags call would get: its status, and
      // its code when it has one. A failure with no answer is an outage.
      const refusal = error instanceof HttpError && error.status < 500;
      outcome = {
        tags_applied: false,
        tags_error: refusal
          ? {
              status: error.status,
              ...(error.code && { code: error.code }),
              message: `The Page was created but its tags were not written: ${error.message}`,
            }
          : {
              status: 503,
              code: "tags_unavailable",
              message:
                "The Page was created but its tags were not written. Send the same create_page again to retry them, or use update_page_tags.",
            },
      };
    }
    const tagged = json({ ...receipt, ...outcome }, response.status);
    if (response.headers.has(REPLAYED_RECEIPT_HEADER))
      tagged.headers.set(REPLAYED_RECEIPT_HEADER, response.headers.get(REPLAYED_RECEIPT_HEADER));
    return tagged;
  }

  /** Finish a reserved create_page or register_page: the Page host creates
   * the document, then this Catalog commits the entry and the receipt. A
   * pending entry with a `creator` is a forwarded creation (projectCreate):
   * the Page host learns this Catalog's account as its owner and checks the
   * creator with this Catalog before it accepts. */
  async completeCreation(request, { key, intent, args, registering = false, resumed, owner }) {
    const pageId = intent.pageId;
    const pending = await this.storage.get(`page/${pageId}`);
    if (!pending) throw new Error("A pending creation has no Catalog entry");
    // A resumed creation checks its parent again: the parent may have
    // moved to Trash since the intent was reserved. The intent stays
    // pending; restoring the parent and retrying finishes it.
    if (resumed && pending.parent_id) await this.activeParent(pending.parent_id);
    const delegated = typeof pending.creator === "string";
    // The Page learns its content and owner, never its location.
    const response = await this.env.PAGES.getByName(pageId).fetch(
      forwarded(
        request,
        registering ? "/internal/register" : "/internal/create",
        registering
          ? { ...args, page_id: pageId }
          : {
              title: args.title,
              markdown: args.markdown,
              page_id: pageId,
              ...(delegated && { owner }),
            },
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
    // The owner's display name only served the Page host's check.
    const { pending: _pending, owner_name: _ownerName, ...created } = pending;
    const entry = { ...created, title: catalogTitle(intent.receipt.title) };
    // The mark lands before the entry, so no listing reads D1 without the
    // new Page; the owner's row is written after the response.
    const marks = await markPagesForIndex(this.env, this.storage, [pageId]);
    await this.storage.put({ [key]: intent, [`page/${pageId}`]: entry });
    await this.storage.sync();
    this.indexInBackground(owner, [{ entry, state: "active" }], marks);
    return json(intent.receipt);
  }

  /** Remember the Page limit this account's gateway resolved for its own
   * listing, so a Project member's forwarded creation applies the owner's
   * limit (projectCreate). The owner's verified email never reaches a
   * member's request. Written only when it changes. */
  async rememberPageLimit(limit) {
    if (!validPageLimit(limit)) return;
    if ((await this.storage.get(PAGE_LIMIT_KEY))?.limit === limit) return;
    await this.storage.put(PAGE_LIMIT_KEY, { limit, at: Date.now() });
  }

  /** The limit a forwarded creation applies: the last one this account's
   * gateway resolved for a listing, or the target default before then. */
  async ownerPageLimit() {
    return forwardedPageLimit((await this.storage.get(PAGE_LIMIT_KEY))?.limit, this.env);
  }

  /** Whether create_page's placement names a Project or parent this account
   * doesn't hold: a parent with no entry of its own, or a Project with no
   * `space/` record. Such a placement is a Project member's request. */
  async placedElsewhere(args) {
    if (args.parent_id !== undefined && args.parent_id !== null) {
      const parentId = requirePageIdArgument(args.parent_id, "parent_id");
      if (args.space_id !== undefined && args.space_id !== null)
        requireSpaceIdArgument(args.space_id);
      return (
        !(await this.storage.get(`page/${parentId}`)) &&
        !(await this.storage.get(`trash/${parentId}`))
      );
    }
    if (args.space_id === undefined || args.space_id === null) return false;
    return !(await this.storage.get(`space/${requireSpaceIdArgument(args.space_id)}`));
  }

  /** The policy snapshot of Project `spaceId` as its owner `owner` holds it:
   * `{ space_id, owner, owner_name, acl }`. Host only, never the caller's
   * credential. */
  async projectPolicy(spaceId, owner) {
    const response = await this.env.PROJECTS.getByName(spaceId).fetch(
      new Request("https://pages.internal/internal/space/policy", {
        method: "POST",
        body: JSON.stringify({ space_id: spaceId, owner }),
      }),
    );
    if (response.status === 404) throw spaceNotFound();
    if (!response.ok) throw new HttpError(503, "Project is temporarily unavailable");
    return response.json();
  }

  /** Where a member's create_page goes: `{ owner, space_id, parent_id,
   * fence }`. A parent names its owner (the Page host answers to a reader)
   * and its Project (the owner's Catalog derives it). The caller must hold
   * create_items on that Project at ACL revision `fence`. A Project or
   * parent the caller can't open looks missing, as it does today. */
  async projectCreateTarget(request, identity, args) {
    const spaceArg =
      args.space_id === undefined || args.space_id === null
        ? null
        : requireSpaceIdArgument(args.space_id);
    const parentId =
      args.parent_id === undefined || args.parent_id === null
        ? null
        : requirePageIdArgument(args.parent_id, "parent_id");
    const parentMissing = () =>
      new HttpError(
        404,
        "Parent Page not found. Sub-pages go under Pages you own, or Pages in a Project where you're an editor.",
        "parent_unavailable",
      );
    let owner;
    let spaceId = spaceArg;
    if (parentId) {
      const page = await this.env.PAGES.getByName(parentId).fetch(
        forwarded(request, "/internal/catalog", {}),
      );
      if (!page.ok) throw parentMissing();
      owner = (await page.json()).owner;
      if (typeof owner !== "string" || owner === identity.principal) throw parentMissing();
      const located = await this.env.CATALOGS.getByName(owner).fetch(
        new Request("https://pages.internal/internal/location", {
          method: "POST",
          body: JSON.stringify({ page_id: parentId }),
        }),
      );
      if (!located.ok) throw parentMissing();
      const location = await located.json();
      if (location.state === "trashed")
        throw new HttpError(
          409,
          "The parent Page is in Trash; restore it before adding Pages under it",
          "parent_unavailable",
        );
      if (location.state !== "active" || location.content || !location.complete)
        throw parentMissing();
      if (!location.space_id) throw parentMissing();
      if (spaceArg && location.space_id !== spaceArg)
        throw new HttpError(
          400,
          "parent_id is not in that Project. Omit project_id: a parent implies its Project.",
          "placement_mismatch",
        );
      spaceId = location.space_id;
    } else {
      const read = await this.env.PROJECTS.getByName(spaceArg).fetch(
        forwarded(request, "/internal/space/read", { space_id: spaceArg }),
      );
      if (read.status === 404) throw spaceNotFound();
      if (!read.ok) throw new HttpError(503, "Project is temporarily unavailable");
      owner = (await read.json()).owner;
      if (typeof owner !== "string" || owner === identity.principal) throw spaceNotFound();
    }
    const record = await this.projectPolicy(spaceId, owner);
    requireCreateItems(record, identity, parentId ? parentMissing : spaceNotFound);
    return { owner, space_id: spaceId, parent_id: parentId, fence: record.acl?.revision ?? 0 };
  }

  /**
   * A Project member's create_page from this Catalog, driven by the
   * forwarding-record machine (project-create.mjs). The record lives under
   * the caller's nonce and names the owner-side forward_id, so a
   * retry resumes the creation the owner's Catalog reserved. The caller's
   * own Page limit is untouched; the owner's Catalog applies its owner's.
   */
  async forwardCreate(request, identity, args, { key, digest, inspected }) {
    const storage = this.storage;
    let record = inspected.entry;
    let state = forwardedCreationState(record);
    let event = { type: "request" };
    let target;
    let fence = null;
    let fences = 0;
    for (;;) {
      const step = forwardedCreationTransition(state, event.type);
      state = step.state;
      switch (step.effect) {
        case "replay": {
          // A previous attempt may have stored its receipt before sync failed.
          await storage.sync();
          const replay = json(record.receipt);
          replay.headers.set(REPLAYED_RECEIPT_HEADER, "1");
          return replay;
        }
        case "resolve":
          try {
            target = await this.projectCreateTarget(request, identity, args);
            event = { type: "authorized" };
          } catch (error) {
            event = { type: "denied", error };
          }
          break;
        case "reserve":
          record = await reserveOperation(storage, {
            key,
            entry: {
              fingerprint: digest,
              pending: true,
              forward: {
                forward_id: crypto.randomUUID(),
                owner: target.owner,
                space_id: target.space_id,
                ...(target.parent_id && { parent_id: target.parent_id }),
              },
            },
          });
          await storage.put(key, record);
          fence = target.fence;
          event = { type: "reserved" };
          break;
        case "fence": {
          // The revision this attempt carries. A forward the owner already
          // reserved ignores it; a new one is refused unless it is current.
          const { owner, space_id } = record.forward;
          fence = await this.projectPolicy(space_id, owner).then(
            (policy) => policy.acl?.revision ?? 0,
            (error) => {
              if (error.code !== "project_not_found") throw error;
              return null;
            },
          );
          event = { type: "fenced" };
          break;
        }
        case "forward": {
          const { forward_id, owner, space_id, parent_id } = record.forward;
          const response = await this.env.CATALOGS.getByName(owner).fetch(
            forwarded(request, PROJECT_CREATE_PATH, {
              forward_id,
              fence,
              space_id,
              ...(parent_id && { parent_id }),
              title: args.title,
              markdown: args.markdown,
            }),
          );
          const body = await response
            .clone()
            .json()
            .catch(() => null);
          event = { ...forwardAnswer(response, body, ++fences), response };
          break;
        }
        case "complete":
          record = { ...record, pending: false, receipt: event.receipt };
          await storage.put(key, record);
          await storage.sync();
          return json(record.receipt);
        case "release":
          // The owner's Catalog reserved nothing: this key is free again.
          await storage.delete(key);
          await storage.sync();
          return event.response;
        case "reply":
          if (event.error) throw event.error;
          return event.response;
        default:
          throw new Error(`Unknown forwarded creation effect ${step.effect}`);
      }
    }
  }

  /**
   * The owner's side of a Project member's create_page (forwardCreate). It
   * runs in this Catalog's queue as the member, whose credential the Page
   * host needs to issue the member's edit authority. The new Page is this
   * account's: it takes a slot of this account's Page limit and its entry
   * records the member as `creator`.
   *
   * A new forward is checked here before anything is reserved: the ACL
   * revision fence the member decided at, create_items for the member,
   * this account's limit, and the placement. Each refusal says it reserved
   * nothing (FORWARD_REJECTED_HEADER). A reserved forward resumes or
   * replays without deciding again: reservation was the authorized moment,
   * so a creation completes once even if the member's role changes after.
   */
  async projectCreate(request) {
    const storage = this.storage;
    const owner = this.ctx.id.name;
    let reserved = false;
    try {
      const identity = await authenticate(request, this.env);
      requireWrite(identity);
      if (!owner || identity.principal === owner)
        throw new HttpError(400, "A forwarded creation comes from a Project member");
      const body = await readJson(request);
      if (!validForwardId(body?.forward_id)) throw new HttpError(400, "Invalid forward_id");
      requireSpaceIdArgument(body.space_id);
      const parentId =
        body.parent_id === undefined ? null : requirePageIdArgument(body.parent_id, "parent_id");
      if (body.fence !== null && !Number.isSafeInteger(body.fence))
        throw new HttpError(400, "Invalid fence");
      validateCreateInput(body);
      await this.locationShape();
      const key = forwardKey(body.forward_id);
      const digest = await fingerprint(
        "create_page_forwarded",
        {
          forward_id: body.forward_id,
          space_id: body.space_id,
          parent_id: parentId,
          title: body.title,
          markdown: body.markdown,
        },
        identity,
      );
      let intent = await storage.get(key);
      if (intent && intent.fingerprint !== digest)
        throw new HttpError(409, "This nonce was used for a different request", "nonce_conflict");
      reserved = !!intent;
      if (intent && !intent.pending) {
        await storage.sync();
        return json(intent.receipt);
      }
      if (!intent) {
        const policy = await this.forwardedPolicy(identity, body, parentId);
        const limit = await this.ownerPageLimit();
        const { room } = await this.capacity("page/", limit);
        if (!room) throw projectOwnerQuotaError(limit);
        const { location, rekeyed } = await this.resolveLocation(
          request,
          parentId ? { parent_id: parentId } : { space_id: body.space_id },
        );
        intent = {
          fingerprint: digest,
          pending: true,
          pageId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        intent = await reserveOperation(storage, { key, entry: intent });
        reserved = true;
        await storage.put({
          ...(await rekeyedEntries(storage, rekeyed)),
          [key]: intent,
          [`page/${intent.pageId}`]: {
            page_id: intent.pageId,
            title: catalogTitle(body.title),
            created_at: intent.createdAt,
            updated_at: intent.createdAt,
            pending: true,
            creator: identity.principal,
            ...(typeof policy.owner_name === "string" && { owner_name: policy.owner_name }),
            ...location,
          },
        });
      }
      return await this.completeCreation(request, {
        key,
        intent,
        args: body,
        resumed: reserved,
        owner,
      });
    } catch (error) {
      const response = errorResponse(error, "catalog");
      if (!reserved && response.status < 500)
        response.headers.set(FORWARD_REJECTED_HEADER, "before-intent");
      return response;
    }
  }

  /** The checks a new forward passes before it reserves anything: the
   * Project is this account's and live, a parent is still in it, the ACL is
   * still at the member's fence, and the member holds create_items. Returns
   * the Project policy snapshot. */
  async forwardedPolicy(identity, body, parentId) {
    const storage = this.storage;
    if (parentId) {
      const entries = await locationEntries(storage);
      const derived = entries.get(parentId) ? deriveLocation(entries, parentId) : null;
      if (!derived?.ok || derived.space_id !== body.space_id)
        throw new HttpError(
          409,
          "The parent Page is no longer in that Project",
          "parent_unavailable",
        );
    }
    const space = await storage.get(`space/${body.space_id}`);
    if (!space || space.pending || space.deletion) throw spaceNotFound();
    const policy = await this.projectPolicy(body.space_id, this.ctx.id.name);
    if ((policy.acl?.revision ?? 0) !== body.fence) throw fenceMoved();
    requireCreateItems(policy, identity, spaceNotFound);
    return policy;
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
    const event = { type: "request", expired: entry ? !(entry.expires_at > Date.now()) : false };
    if (holdsSlot(state, event.expired)) return { event, state };
    const slotKey = lifecycleSlotKey(operation, pageId);
    run.capacity = await this.destinationCapacity(run, slotKey);
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
   * error. A Project alone means its top level: a root carrying its
   * space_id. Neither means a root in Your items. Only Pages and
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
      if (!entry || entry.pending || entry.deletion) throw spaceNotFound();
      const response = await this.env.PROJECTS.getByName(spaceArg).fetch(
        forwarded(request, "/internal/space/read", { space_id: spaceArg }),
      );
      if (response.status === 404) throw spaceNotFound();
      if (!response.ok) throw new HttpError(503, "Project is temporarily unavailable");
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
      // below its parent.
      if (parent.depth + 1 > MAX_DEPTH)
        throw new HttpError(
          400,
          `Pages nest at most ${MAX_DEPTH} levels deep`,
          "nesting_depth_exceeded",
        );
      const { position, rekeyed } = appendPosition(entries, parentId);
      return { location: { parent_id: parentId, position }, rekeyed };
    }
    const { position, rekeyed } = appendPosition(entries, null, undefined, spaceArg);
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
   * so no Page is ever active under a trashed parent. A Project's content
   * document stays with its Project. Both checks run before anything is
   * reserved.
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
    if (entry.project_content)
      throw new HttpError(
        409,
        "This is a Project's content. It belongs to its Project and can't move to Trash",
        "project_content_protected",
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
    await this.locationShape();
    const run = {
      identity,
      pageId,
      parentId,
      spaceId,
      position,
      key: await operationKey(args, identity, "catalog"),
      digest: await fingerprint("move_page", args, identity),
    };
    let state = { name: "received" };
    let event = await this.inspectMove(run);
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

  /** The journal's answer for this key as an `inspected` event. */
  async inspectMove(run) {
    let inspected;
    try {
      inspected = await inspectOperation(this.storage, { key: run.key, digest: run.digest });
    } catch (error) {
      if (error.code === "nonce_conflict") return { type: "inspected", row: "conflict" };
      throw error;
    }
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
    const refuse = (code, message) => ({ type: "planned", ok: false, code, message });
    const { entries, contents } = await locationScan(storage);
    if (contents.has(pageId))
      return refuse(
        "project_content_protected",
        "This is a Project's content. It belongs to its Project and can't be moved",
      );
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
    // Placement supplies inherited access. Keep direct grants unchanged, but
    // refuse cross-boundary moves after membership or invitation history;
    // within-Project moves preserve the audience and remain available.
    const destinationSpace =
      typeof spaceId === "string"
        ? spaceId
        : parentId
          ? deriveLocation(entries, parentId).space_id
          : null;
    if (typeof destinationSpace === "string") {
      const record = await storage.get(`space/${destinationSpace}`);
      if (!record || record.pending || record.deletion)
        return refuse("project_not_found", "Project not found");
    }
    const sourceSpace = projectOf(entries, pageId);
    if (sourceSpace !== destinationSpace) {
      for (const id of [sourceSpace, destinationSpace].filter(Boolean)) {
        const response = await this.env.PROJECTS.getByName(id).fetch(
          new Request("https://pages.internal/internal/space/policy", {
            method: "POST",
            body: JSON.stringify({ space_id: id, owner: this.ctx.id.name }),
          }),
        );
        if (!response.ok)
          return refuse("project_policy_unavailable", "Project access cannot be verified");
        const policy = await response.json();
        // A Project with members, invitations or an organization grant is
        // shared: someone besides its owner reaches the Pages in it.
        if (
          Object.keys(policy.acl?.members ?? {}).length ||
          Object.keys(policy.acl?.invites ?? {}).length ||
          policy.acl?.organizationAccess
        )
          return refuse(
            "shared_project_move_unsupported",
            "Moving across a shared Project boundary is not available; move within the Project instead",
          );
      }
    }
    const destination = {
      ...(spaceId !== undefined && { project_id: spaceId }),
      ...(parentId && { parent_id: parentId }),
    };
    const revision = (await storage.get(LOCATION_REVISION_KEY)) ?? 0;
    const projects = [...(await listAll(storage, "space/")).values()]
      .filter((record) => record?.space_id && !record.pending && !record.deletion)
      .map((record) => record.space_id);
    const plan = planMove({ revision, entries, contents, projects }, pageId, destination, position);
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
      const { space_id: _space, ...kept } = current;
      const puts = Object.entries({
        ...(await rekeyedEntries(target, rekeyed)),
        [`page/${pageId}`]: {
          ...kept,
          parent_id: plan.moved.parent_id,
          position: plan.moved.position,
          // Only a root carries its Project.
          ...(plan.moved.parent_id === null &&
            plan.moved.space_id && { space_id: plan.moved.space_id }),
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
    // Input is sound: the shape pass runs first, as for every queued write.
    await this.locationShape();
    const key = await operationKey(args, identity, "catalog");
    const digest = await fingerprint("create_space", args, identity);
    const inspected = await inspectOperation(storage, { key, digest });
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
      // The intent, the Space entry and the content document's quota slot
      // commit together. A crash after this resumes from the same IDs.
      await storage.put({
        [key]: intent,
        [`space/${intent.spaceId}`]: {
          space_id: intent.spaceId,
          title,
          description: intent.description,
          document_id: intent.pageId,
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
          ...contentMarker(intent.spaceId),
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
            document_id: intent.pageId,
          }),
        );
        if (!response.ok) return response;
        intent.space = await response.json();
        event = "space_recorded";
      } else if (effect === "create_content_document") {
        const response = await this.env.PAGES.getByName(intent.pageId).fetch(
          forwarded(request, "/internal/create", {
            page_id: intent.pageId,
            title: intent.title,
            markdown: projectContentMarkdown(intent.description),
          }),
        );
        if (!response.ok) return response;
        intent.contentTitle = (await response.json()).title;
        event = "content_created";
      } else {
        const space = intent.space;
        intent.receipt = { ...space };
        const content = {
          page_id: intent.pageId,
          title: catalogTitle(intent.contentTitle),
          created_at: intent.createdAt,
          updated_at: intent.createdAt,
          ...contentMarker(intent.spaceId),
        };
        // Marked before its entry, as a creation is.
        const marks = await markPagesForIndex(this.env, storage, [intent.pageId]);
        await storage.put({
          [`space/${intent.spaceId}`]: {
            space_id: intent.spaceId,
            title: space.title,
            description: space.description,
            document_id: intent.pageId,
            created_at: space.created_at,
            updated_at: space.updated_at,
          },
          [`page/${intent.pageId}`]: content,
        });
        this.indexInBackground(principal, [{ entry: content, state: "active" }], marks);
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
    const key = await operationKey(args, identity, "catalog");
    const digest = await fingerprint("update_space", args, identity);
    const inspected = await inspectOperation(storage, { key, digest });
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
        // The Space keys its receipt as this Catalog does: by account and nonce.
        nonce: args.nonce,
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

  /**
   * delete_project. Only the owner's Catalog holds the Project's `space/`
   * entry; anyone else is refused as update_project refuses them. A Project
   * that still holds a Page, active, being created or in Trash, is refused.
   * A preview reads and reserves nothing. A confirm runs the spaceDeletion
   * machine (space-lifecycle.mjs) from its intent's persisted phase, so an
   * exact retry resumes or replays it.
   */
  async deleteSpace(request, identity, args) {
    const storage = this.storage;
    const action = validateSpaceDeletion(args);
    const spaceId = args.space_id;
    let key;
    let digest;
    let inspected;
    if (action === "confirm") {
      await this.locationShape();
      key = await operationKey(args, identity, "catalog");
      digest = await fingerprint("delete_project", args, identity);
      inspected = await inspectOperation(storage, { key, digest });
      const recorded = inspected.entry;
      if (recorded && !recorded.pending) {
        await storage.sync();
        return json(recorded.receipt);
      }
      if (recorded) return await this.runSpaceDeletion(request, key, recorded);
    }
    const entry = await storage.get(`space/${spaceId}`);
    if (!entry || entry.deletion) return await this.spaceDeletionRefusal(request, spaceId);
    if (entry.pending)
      throw new HttpError(
        409,
        "This Project is still being created. Retry create_project with the same nonce and arguments.",
        "project_pending",
      );
    if (await projectHoldsPages(storage, spaceId)) {
      const { status, body } = PROJECT_NOT_EMPTY;
      return json(body, status);
    }
    if (action === "preview") return await this.previewSpaceDeletion(request, entry);
    const intent = await reserveOperation(storage, {
      key,
      entry: {
        fingerprint: digest,
        pending: true,
        spaceId,
        documentId: entry.document_id,
        // Names this deletion to the Space, which holds it while it runs.
        deletionId: crypto.randomUUID(),
        previewToken: args.preview_token,
        // The content's Trash request key, fixed so a resumed trash replays.
        trashKey: `pd_${crypto.randomUUID()}`,
        phase: "reserved",
        createdAt: new Date().toISOString(),
      },
    });
    await storage.put(key, intent);
    return await this.runSpaceDeletion(request, key, intent);
  }

  /** The refusal for a Project this Catalog doesn't own: the owner-only
   * refusal for a member, and a missing Project for everyone else. */
  async spaceDeletionRefusal(request, spaceId) {
    const response = await this.env.PROJECTS.getByName(spaceId).fetch(
      forwarded(request, "/internal/space/read", { space_id: spaceId, claim: false }),
    );
    await response.body?.cancel();
    if (response.ok) throw new HttpError(403, "Only the Project owner can delete it");
    if (response.status >= 500) throw new HttpError(503, "Project is temporarily unavailable");
    throw spaceNotFound();
  }

  /** What the owner's content document holds now: its heads and discussion. */
  contentImpact(request, documentId) {
    return this.env.PAGES.getByName(documentId).fetch(
      forwarded(request, CONTENT_IMPACT_PATH, { page_id: documentId }),
    );
  }

  /** delete_project's preview: what the deletion removes, from the Space and
   * the content document, and the Space's token bound to both. */
  async previewSpaceDeletion(request, entry) {
    const content = await this.contentImpact(request, entry.document_id);
    if (!content.ok) return content;
    const { revision, heads, comment_heads, comment_threads, comment_count } = await content.json();
    const response = await this.env.PROJECTS.getByName(entry.space_id).fetch(
      forwarded(request, "/internal/space/delete", {
        space_id: entry.space_id,
        step: "preview",
        content_revision: revision,
        heads,
        comment_heads,
      }),
    );
    if (!response.ok) return response;
    const { preview_token, preview_expires_at, ...space } = await response.json();
    // The preview token binds the content's heads; the agent needs none.
    return json({
      ...space,
      comment_threads,
      comment_count,
      preview_token,
      preview_expires_at,
    });
  }

  /** Step the spaceDeletion machine from the intent's phase and run its
   * effects until it answers. A failure that leaves the outcome open throws,
   * and the intent stays at its last persisted phase for the retry. */
  async runSpaceDeletion(request, key, intent) {
    const run = { request, key, intent, principal: this.ctx.id.name ?? null };
    let state = { name: intent.phase };
    let event = { type: "resume" };
    for (;;) {
      const result = spaceDeletion.step(state, event);
      let next;
      for (const effect of result.effects)
        next = (await this.runDeletionEffect(run, effect)) ?? next;
      if (result.response) {
        if (result.response.reply === "receipt") return json(intent.receipt);
        if (result.response.reply === "refusal") return run.reply;
        return json(result.response.body, result.response.status);
      }
      if (!next) throw new Error("A Project deletion stopped without an answer");
      ({ state } = result);
      event = next;
    }
  }

  async runDeletionEffect(run, effect) {
    const storage = this.storage;
    const { request, key, intent } = run;
    const spaceKey = `space/${intent.spaceId}`;
    const page = this.env.PAGES.getByName(intent.documentId);
    const space = (body) =>
      this.env.PROJECTS.getByName(intent.spaceId).fetch(
        forwarded(request, "/internal/space/delete", {
          space_id: intent.spaceId,
          deletion_id: intent.deletionId,
          ...body,
        }),
      );
    switch (effect.type) {
      case "close_space": {
        // Resumed after a crash, the Project may have gained a Page.
        if (await projectHoldsPages(storage, intent.spaceId))
          return { type: "closed", ok: false, refusal: "not_empty" };
        const content = await this.contentImpact(request, intent.documentId);
        if (!content.ok) {
          await requireAnswer(content);
          run.reply = content;
          return { type: "closed", ok: false, refusal: "space" };
        }
        const { revision, heads, comment_heads } = await content.json();
        const closed = await space({
          step: "close",
          content_revision: revision,
          heads,
          comment_heads,
          preview_token: intent.previewToken,
        });
        if (!closed.ok) {
          await requireAnswer(closed);
          run.reply = closed;
          return { type: "closed", ok: false, refusal: "space" };
        }
        // The heads the Space recorded when it closed, which a repeated close
        // answers too: the trash compares against exactly these.
        const recorded = await closed.json();
        intent.heads = recorded.heads;
        intent.commentHeads = recorded.comment_heads;
        return { type: "closed", ok: true };
      }
      case "hide_project": {
        const entry = await storage.get(spaceKey);
        if (entry && entry.deletion !== intent.deletionId)
          await storage.put(spaceKey, { ...entry, deletion: intent.deletionId });
        await markSpaceIndexDirty(storage);
        return;
      }
      case "show_project": {
        const entry = await storage.get(spaceKey);
        if (entry?.deletion === intent.deletionId) {
          const { deletion: _deletion, ...shown } = entry;
          await storage.put(spaceKey, shown);
          await markSpaceIndexDirty(storage);
        }
        return;
      }
      case "persist":
        intent.phase = effect.state;
        if (effect.state === "deleted") {
          intent.pending = false;
          intent.receipt = { space_id: intent.spaceId, deleted: true };
        }
        await storage.put(key, intent);
        return;
      case "trash_content": {
        const response = await page.fetch(
          forwarded(request, "/internal/trash", {
            page_id: intent.documentId,
            nonce: intent.trashKey,
            // Null heads: the content's documents weren't opened, and the
            // trash applies only while that holds.
            ...(intent.heads && { base_heads: intent.heads }),
            base_comment_heads: intent.commentHeads,
          }),
        );
        if (response.ok) {
          // The purge applies only at the revision this trash reached.
          intent.contentRevision = (await response.json()).current.revision;
          return { type: "trashed", outcome: "trashed" };
        }
        if (response.status === 404) return { type: "trashed", outcome: "missing" };
        const failure = await refusalOf(response);
        if (failure.code === "stale_revision") return { type: "trashed", outcome: "changed" };
        throw failure;
      }
      case "reopen_space": {
        const response = await space({ step: "reopen" });
        if (!response.ok) throw await refusalOf(response);
        return { type: "reopened" };
      }
      case "purge_content":
        for (let previewed = false; ; previewed = true) {
          if (!intent.purge) {
            const preview = await page.fetch(
              forwarded(request, "/internal/purge", {
                page_id: intent.documentId,
                action: "preview",
              }),
            );
            if (preview.status === 404) return { type: "purged" };
            if (!preview.ok) throw await refusalOf(preview);
            // Kept with the intent: a resumed confirm repeats the same
            // payload, so the Page replays a purge it already applied.
            intent.purge = {
              key: `pd_${crypto.randomUUID()}`,
              token: (await preview.json()).preview_token,
            };
            await storage.put(key, intent);
          }
          const confirmed = await page.fetch(
            forwarded(request, "/internal/purge", {
              page_id: intent.documentId,
              action: "confirm",
              preview_token: intent.purge.token,
              nonce: intent.purge.key,
              expected_revision: intent.contentRevision,
            }),
          );
          if (confirmed.status === 404) return { type: "purged" };
          if (confirmed.ok) {
            if ((await confirmed.json()).current?.state === "deleted") return { type: "purged" };
            throw new HttpError(503, "The Project's content was not deleted; retry");
          }
          const failure = await refusalOf(confirmed);
          // A stored preview that expired was refused before anything
          // changed: preview once more under a new key.
          if (failure.code !== "purge_preview_invalid" || previewed) throw failure;
          delete intent.purge;
          await storage.put(key, intent);
        }
      case "forget_catalog": {
        const now = new Date().toISOString();
        const current = { state: "deleted", revision: (intent.contentRevision ?? 0) + 1 };
        const item = await lifecycleIndexItem(storage, intent.documentId, current, now);
        const marks = item ? await markPagesForIndex(this.env, storage, [intent.documentId]) : [];
        // The deletion tombstone lands with the content's entry removal, so a
        // late title projection never lists the content again.
        await projectLifecycle(storage, intent.documentId, current, { marked: true, now });
        await storage.delete(spaceKey);
        await markSpaceIndexDirty(storage);
        if (item) this.indexInBackground(run.principal, [item], marks);
        return { type: "forgotten" };
      }
      case "remove_space": {
        const response = await space({ step: "delete" });
        if (!response.ok) throw await refusalOf(response);
        return { type: "removed" };
      }
      case "release":
        await storage.delete(key);
        await storage.sync();
        return;
      case "sync":
        await storage.sync();
        return;
    }
    throw new Error(`A Project deletion can't run ${effect.type}`);
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
        "This Project is still being created. Retry create_project with the same nonce and arguments.",
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
    const limit = args.limit ?? 50;
    if ((args.limit !== undefined && !Number.isSafeInteger(args.limit)) || limit < 1 || limit > 100)
      throw new HttpError(400, "limit must be an integer from 1 to 100", "invalid_list_arguments");
    if (args.cursor !== undefined && args.cursor !== null && typeof args.cursor !== "string")
      throw new HttpError(400, "Invalid cursor; restart from the first page", "invalid_cursor");
    for (const spaceId of await invitedProjects(this.env, identity)) {
      // An invitation is an untrusted candidate, not an existing membership.
      // Capacity conflicts or unavailable candidate hosts must not prevent
      // this account from listing unrelated Projects. The next listing retries.
      try {
        const response = await this.env.PROJECTS.getByName(spaceId).fetch(
          forwarded(request, "/internal/space/read", { space_id: spaceId }),
        );
        await response.body?.cancel();
      } catch {
        // Nothing from a failed candidate, including its title, is disclosed.
      }
    }
    const discovered = await storage.list({ prefix: "project-discovery/" });
    const opened = await openedProjects(storage);
    if (discovered.size || opened.length) {
      // Owned Projects, member hints and opened hints, one candidate per
      // Project, so a Project with more than one is read once.
      const candidates = new Map();
      for (const candidate of [
        ...(await storage.list({ prefix: "space/" })).values(),
        ...discovered.values(),
        ...opened,
      ])
        if (!candidates.has(candidate.space_id)) candidates.set(candidate.space_id, candidate);
      const spaces = [];
      for (const candidate of candidates.values()) {
        if (candidate.pending || candidate.deletion) continue;
        const response = await this.env.PROJECTS.getByName(candidate.space_id).fetch(
          forwarded(request, "/internal/space/read", { space_id: candidate.space_id }),
        );
        if (response.ok) spaces.push(await response.json());
        else if (![403, 404, 409].includes(response.status))
          throw new HttpError(503, "Project access is temporarily unavailable");
      }
      const context = {
        principal: identity.principal,
        needle: null,
        inTrash: false,
        scope: "spaces",
      };
      const after = args.cursor
        ? await openCursor(this.env, context, args.cursor, undefined, {
            maxLength: SHORT_CURSOR_MAX_LENGTH,
          })
        : null;
      const sorted = [...new Map(spaces.map((space) => [space.space_id, space])).values()]
        .sort(
          (a, b) =>
            b.updated_at.localeCompare(a.updated_at) || b.space_id.localeCompare(a.space_id),
        )
        .filter(
          (space) =>
            !after ||
            space.updated_at < after.updated_at ||
            (space.updated_at === after.updated_at && space.space_id < after.page_id),
        );
      const last = sorted[limit - 1];
      return json({
        spaces: sorted.slice(0, limit),
        limit,
        next_cursor:
          sorted.length > limit
            ? await sealCursor(this.env, context, {
                updated_at: last.updated_at,
                page_id: last.space_id,
              })
            : null,
        principal: identity.principal,
      });
    }
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
          if (!entry || entry.pending || entry.deletion) continue;
          spaces.push({
            row,
            space: {
              space_id: entry.space_id,
              role: "owner",
              owner: identity.principal,
              title: entry.title,
              description: entry.description ?? "",
              document_id: entry.document_id,
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
      // Cloudflare throws from the stub fetch of an overloaded object.
      if (error?.overloaded === true) return { status: "unavailable", overloaded: true };
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
      throw sharedPagesUnavailable({ overloaded: error?.overloaded === true });
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
    const tagDb = options.tags ? await this.tagDatabase() : null;
    const keep = this.tagKeep(options, tagDb);
    if (options.inTrash) await pruneTombstonedTrash(storage);
    if (options.spaceId) {
      // Only the owner can see a Space in this build, and the owner's own
      // entry records it. A Space the caller can't see looks missing.
      const space = await storage.get(`space/${options.spaceId}`);
      if (!space) return this.listSharedProjectPages(request, identity, options);
      if (space.pending || space.deletion) throw spaceNotFound();
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
        if (shared.status === "unavailable") throw sharedPagesUnavailable(shared);
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
    // A Project's top level (`project_id` with `parent_id: null`) is its
    // roots. Its content document is not in `locations`, so never listed.
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
    // checks every child before it paginates or filters by tag; see
    // scanCandidates.
    const scope = {
      locations,
      located,
      sharedChildren: sharedChildren && new Set(sharedChildren),
      exhaustive: !!sharedChildren,
      // The owner's Catalog names these children whether or not the caller
      // can read them, so the tag filter runs only on the ones that passed
      // the access check (scanCandidates).
      keepVerified: sharedChildren ? keep : null,
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
        account: accountIdentity(identity),
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
            audiences: identityAudienceKeys(identity),
            inTrash: options.inTrash,
            needle: options.needle,
            access: options.access,
            sort: options.sort,
            tags: options.tags?.ast ?? null,
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
              keep,
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
    if (options.tags || options.includeTags)
      await this.attachTags(result.pages, tagDb, !!options.tags);
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
      account: accountIdentity(identity),
      ...(options.tags && { tag_filter: options.tags.canonical }),
    });
    response.headers.set("x-pages-catalog-source", result.source);
    return response;
  }

  async tagDatabase() {
    return pageTagsDatabase(this.env, this.ctx);
  }

  /** For a listing with a tag filter, `keep(pageIds)` answers the Set of IDs
   * that satisfy it, read from the `page_tags` table in D1. A failure is `tags_unavailable`: the
   * Catalog entries have no tags, so the listing can't answer without it. */
  tagKeep(options, db) {
    if (!options.tags) return null;
    return async (pageIds) => {
      try {
        return await tagMatchingIds(db, options.tags.ast, pageIds);
      } catch (error) {
        logFailure(error, "page-tags");
        throw tagsUnavailable();
      }
    };
  }

  /** Set `tags` on each listed Page: an array, empty when it has none. Best
   * effort without a tag filter: a listing never fails for want of tags, and
   * a Page with no `tags` field means they could not be read. A tag filter
   * promises `tags` on every Page it returns, so when it can't read them the
   * listing is `tags_unavailable`, never Pages without their tags (`strict`).
   * `tagDb` is a handle from `tagDatabase`, or null to open one here: either
   * way the tag schema is current before the read. */
  async attachTags(pages, tagDb, strict = false) {
    if (!pages.length) return;
    try {
      const handle =
        tagDb ?? (catalogIndexEpoch(this.env) ? await openPageTags(this.env, this.ctx) : null);
      if (!handle) {
        if (strict) throw tagsUnavailable();
        return;
      }
      const tags = await readPageTags(
        handle,
        pages.map((page) => page.page_id),
      );
      for (const page of pages) page.tags = tags.get(page.page_id) ?? [];
    } catch (error) {
      logFailure(error, "page-tags");
      if (strict) throw tagsUnavailable();
    }
  }

  /** Up to `options.limit` verified Pages after the position `after`, and the
   * position the next page resumes from, or null. Every position here is
   * `positionOf(options.sort, row)`: the refetch after a rejected candidate
   * and the next cursor resume from the order's key, never a row's own
   * `updated_at`. */
  async listSharedProjectPages(request, identity, options) {
    const tagDb = options.tags ? await this.tagDatabase() : null;
    const keep = this.tagKeep(options, tagDb);
    const response = await this.env.PROJECTS.getByName(options.spaceId).fetch(
      forwarded(request, "/internal/space/read", { space_id: options.spaceId }),
    );
    if (!response.ok) throw spaceNotFound();
    const project = await response.json();
    const locations = await this.env.CATALOGS.getByName(project.owner).fetch(
      locationRequest({ project_pages: options.spaceId }),
    );
    if (!locations.ok) throw new HttpError(503, "Project Pages are temporarily unavailable");
    const entries = (await locations.json()).pages;
    if (options.parentId && !entries.some((entry) => entry.page_id === options.parentId))
      throw new HttpError(400, "parent_id is not in that Project", "placement_mismatch");
    const ids = entries.filter(
      (entry) =>
        options.parentId === undefined ||
        (options.parentId === null
          ? entry.parent_id === null
          : entry.parent_id === options.parentId),
    );
    const context = {
      principal: identity.principal,
      needle: options.needle,
      inTrash: options.inTrash,
      scope: listScope(options),
    };
    const { position: after } = options.cursor
      ? await openListingCursor(this.env, context, options.cursor, options.sort)
      : { position: null };
    const candidates =
      options.inTrash || options.access === "owned" ? [] : ids.map((e) => e.page_id);
    const result = await this.scanCandidates(
      request,
      identity,
      childIdSource(candidates, options.sort),
      { ...options, spaceId: null },
      {
        locations: new Map(),
        located: () => false,
        sharedChildren: new Set(ids.map((entry) => entry.page_id)),
        exhaustive: true,
        // Filtered after each Page's access check, never before it.
        keepVerified: keep,
      },
      after,
      null,
    );
    const pages = result.pages.map((page) => ({
      ...page,
      space_id: options.spaceId,
      parent_id: entries.find((entry) => entry.page_id === page.page_id)?.parent_id,
    }));
    if (options.tags || options.includeTags) await this.attachTags(pages, tagDb, !!options.tags);
    return json({
      pages,
      limit: options.limit,
      next_cursor: result.next
        ? await sealPosition(this.env, { ...context, source: "catalog" }, options.sort, result.next)
        : null,
      principal: identity.principal,
      ...(options.tags && { tag_filter: options.tags.canonical }),
    });
  }

  async scanCandidates(request, identity, source, options, scope, after, db) {
    const storage = this.storage;
    const resumeAt = (row) => positionOf(options.sort, row);
    const pruned = [];
    let stale = false;
    const check = async (row) => {
      // A D1 row that matched only the cut search pattern (likePattern): it
      // counts as scanned and moves the position, but its snapshot lacks
      // the needle, so it lists nothing and asks no Page host.
      if (row.unmatched) return null;
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
      if (result.status === "unavailable") throw sharedPagesUnavailable(result);
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
    // the caller: its own entries, or Pages it discovered. A D1 row a cut
    // search pattern matched without the whole needle is the caller's own
    // row too, and the position after it carries only its own snapshot.
    // Candidates from another account's Catalog are not. An exhaustive scan checks up to
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
      let checked = await boundedMap(rows, sharedCheckBounds.concurrency, check);
      // A tag filter on candidates the caller may not be able to see runs on
      // the ones that passed their check, so a tag never decides what a
      // refused Page reveals, and a Page that fails the filter still counts
      // as scanned.
      if (scope.keepVerified && checked.some(Boolean)) {
        const matched = await scope.keepVerified(
          checked.filter(Boolean).map((page) => page.page_id),
        );
        checked = checked.map((page) => (page && matched.has(page.page_id) ? page : null));
      }
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
    return { pages: verified.map(({ page }) => page), next: exhausted ? null : position };
  }
}

/** A shared-Page check's answer. A check answered from the host record and
 * one answered by the loaded host both build it here. Fields after title let
 * the caller's Catalog index this grant; the listing returns only page_id,
 * title and content_updated_at from it. `observed` is the title's observation
 * (`{ at, keep }`). */
function catalogAnswer(metadata, identity, { title, observed, contentUpdatedAt }) {
  const access = pageAccess(metadata, identity);
  const audience = openedAudienceKey(metadata, identity, access);
  return {
    page_id: metadata.pageId,
    title: catalogTitle(title),
    shared: true,
    owner: metadata.owner,
    role: access.role,
    source: audience ? "domain_opened" : "member",
    ...(audience && { domain: audience }),
    revision: metadata.acl?.revision ?? 0,
    lifecycle_revision: metadata.lifecycleRevision ?? 0,
    state: indexedState(metadata),
    title_observed_at: observed?.at,
    // A member's reconcile pass keeps its row's time for this title when the
    // observation lets writers keep theirs.
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
   * at once; plain sync closes once bootHost, which may still be building
   * it, has returned or thrown
   * (`bootFinished`). That can be long after a request's
   * `blockConcurrencyWhile` rejected, since initializeRepo assigns them only
   * at its end. The storage guard already refuses their writes. */
  retireAbandoned() {
    const stop = () => {
      this.contentActivity?.stop();
      this.pageCard?.stop();
      this.unwatchContent();
    };
    stop();
    void (async () => {
      await this.bootFinished;
      // A boot that ran on may have built more since the reset.
      stop();
      await Promise.resolve()
        .then(() => this.plain?.close?.())
        .catch((error) => logFailure(error, "abandoned-close"));
    })();
  }

  /** The error this object's storage writes are refused with: the reset's,
   * once it is abandoned. Never a falsy value then, which the guard would
   * read as "allowed". */
  storageRefusal() {
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
    // Looking up an unknown page must not create plain storage or a repo.
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
  }

  /** Wait until the host is booted, starting the boot if nothing has. Throws
   * the boot's error when it failed. Every request except a check answered
   * from the record passes through here before it reads host state. */
  async documentReady() {
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
      recordFallback({ record: metadata, creation, projection, reportPending, projectionPending })
    )
      return null;
    const identity = await this.identify(request);
    const projectAccess =
      identity.principal === metadata?.owner
        ? null
        : await resolveProjectAccess(this.env, metadata).catch(() => null);
    const effective = { ...metadata, projectAccess };
    const hidden = this.hiddenRefusal(identity, false, metadata);
    if (hidden) throw hidden;
    const deleted = this.deletedRefusal(identity, false, metadata);
    if (deleted) throw deleted;
    if (pageState(metadata) === "trashed") return null;
    if (await claimInvitation(metadata, identity, this.env)) return null;
    new DocumentPolicy({ storage, metadata: () => effective }).account(identity);
    const stored = storedTitleProjection(projection);
    return json(
      catalogAnswer(effective, identity, {
        title: stored.title,
        observed: { at: stored.observed_at, keep: stored.keep !== false },
        contentUpdatedAt: acceptedTime(activity?.content_updated_at),
      }),
    );
  }

  /** linkPreview's answer, or the one refusal for every reason it has. */
  async linkPreviewResponse(request) {
    try {
      return await this.linkPreview(request);
    } catch (error) {
      if (!(error?.status < 500)) logFailure(error, "link-preview-host");
      return Response.json(PAGE_UNAVAILABLE, { status: 404 });
    }
  }

  /**
   * A link preview's check (link-previews.mjs): `{ page_id, title, state,
   * role, content_updated_at }` for a caller who may open this Page, or
   * linkUnavailable for anyone else.
   *
   * It decides as a shared-Page check from the record does
   * (catalogFromRecord), with the host record as the authority, except:
   *
   * - It claims no invitation. A pending invitee is refused like a
   *   stranger; opening the Page still claims it.
   * - It decides every refusal from the record without starting a boot
   *   itself. It starts or waits for one only for a reader it admitted
   *   whose title the record can't supply (no stored projection, or one not
   *   yet seen to land), and then decides again over the loaded record.
   * - It records no usage and writes no title projection, index report or
   *   Catalog entry. `identify` isn't used, so not even the cached Project
   *   access changes.
   *
   * Like every route, it can't stop the constructor booting a cold host
   * whose record starts eagerly, nor run()'s shared cleanup flushing
   * content activity that earlier requests deferred.
   *
   * State is `active`, or `trashed` for a caller who may restore it; anyone
   * else is refused for a Page in Trash. A Page whose recovery is blocked
   * answers as usual: its readers can still open it read only.
   */
  async linkPreview(request) {
    // Only the caller's own credentials: an upload capability opens nothing.
    if (hostUploadCapability(request) !== undefined) throw linkUnavailable();
    // Who asks comes first, so a missing Page and a refused one do the same
    // work before they answer.
    const identity = await this.linkIdentity(request);
    for (;;) {
      const { serve } = this.stepStartup({ type: "catalog" }).response;
      if (serve === "record" || serve === "document") break;
      if (serve === "failed") throw linkUnavailable();
      await this.settledBoot();
    }
    const loaded = this.startup.name === "ready";
    const storage = this.ctx.storage;
    const [stored, creation, projection, activity, projectionPending] = await Promise.all([
      loaded ? (this.policyMetadata ?? this.metadata) : storage.get("host/document"),
      storage.get("host/creation"),
      storage.get(TITLE_PROJECTION_KEY),
      storage.get(CONTENT_ACTIVITY_KEY),
      storage.get(PROJECTION_PENDING),
    ]);
    // A record this build can't answer from (recordAnswerable) is one the
    // boot refuses: refused here, without the boot.
    if (!stored || creation || this.pendingLifecycle || (!loaded && !recordAnswerable(stored)))
      throw linkUnavailable();
    const projectAccess =
      identity.principal === stored.owner
        ? null
        : await resolveProjectAccess(this.env, stored).catch(() => null);
    const admit = (metadata) => {
      const effective = { ...metadata, projectAccess };
      if (
        this.hiddenRefusal(identity, false, effective) ||
        this.deletedRefusal(identity, false, effective)
      )
        throw linkUnavailable();
      let access;
      try {
        access = new DocumentPolicy({ storage, metadata: () => effective }).account(identity);
      } catch {
        throw linkUnavailable();
      }
      if (access.trashed && !access.canRestore) throw linkUnavailable();
      return effective;
    };
    let effective = admit(stored);
    let title, contentUpdatedAt;
    const projected = projectionPending === true ? null : storedTitleProjection(projection);
    if (loaded && this.handle) {
      title = this.handle.doc().title;
      contentUpdatedAt = this.contentActivity?.value ?? null;
    } else if (projected) {
      title = projected.title;
      contentUpdatedAt = acceptedTime(activity?.content_updated_at);
    } else {
      // An admitted reader whose title the record can't name. The startup
      // state is read now, not before the reads above: another request
      // (/api/sync and /api/saved skip the queue) may have started the boot,
      // or finished it, meanwhile. Start it, or wait for it, unless it
      // failed or the object is going away.
      if (this.startup.name === "failed" || this.startup.name === "abandoned")
        throw linkUnavailable();
      await this.documentReady();
      if (this.pendingLifecycle || !this.handle) throw linkUnavailable();
      effective = admit(this.policyMetadata ?? this.metadata);
      title = this.handle.doc().title;
      contentUpdatedAt = this.contentActivity?.value ?? null;
    }
    const answer = catalogAnswer(effective, identity, { title, contentUpdatedAt });
    return json({
      page_id: answer.page_id,
      title: answer.title,
      state: answer.state,
      role: answer.role,
      content_updated_at: answer.content_updated_at,
    });
  }

  /** The caller of a link preview's check: its own session or API key,
   * authenticated as every host route does. */
  linkIdentity(request) {
    return authenticate(request, this.env);
  }

  /** Authenticate a request's caller with its own credentials. The asset
   * authorization route alone also takes an upload capability, which this
   * Page verifies with its own key (asset-uploads.mjs); the identity it
   * stands for then meets the same checks as any other. */
  async identify(request) {
    const capability = hostUploadCapability(request);
    const identity =
      capability === undefined
        ? await authenticate(request, this.env)
        : await withDomainAccess(
            uploadIdentity(
              await verifyAssetUpload(this.ctx.storage, capability, {
                pageId: this.metadata?.pageId,
                grantActive: (grantId) => oauthGrantActive(this.env, grantId),
              }),
            ),
            this.env,
          );
    if (identity.principal !== this.metadata?.owner) {
      const metadata = this.metadata;
      const observed = this.projectAccessState ?? PROJECT_ACCESS_EMPTY;
      const snapshot = await resolveProjectAccess(this.env, metadata).catch(() => null);
      if (metadata?.owner === this.metadata?.owner && metadata?.pageId === this.metadata?.pageId)
        this.projectAccessState = projectAccessStep(
          this.projectAccessState ?? PROJECT_ACCESS_EMPTY,
          {
            observed,
            owner: metadata?.owner,
            snapshot,
          },
        );
    }
    return identity;
  }

  get projectAccess() {
    return this.projectAccessState?.snapshot ?? null;
  }

  /** Load the serving document. A trashed record whose document cannot be
   * loaded is treated as transiently unavailable: startup completes, requests
   * answer 503, and the next request tries again. Permanent absence is only
   * established by a deleted record or the owner Catalog's tombstone.
   *
   * A record in a format this build doesn't write (formatRefusal) loads
   * neither document, only the title this host last projected, which its
   * lifecycle receipts and listings carry.
   */
  async loadDocument() {
    if (this.formatRefusal()) {
      await this.restoreTitleProjection();
      return;
    }
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
      await recoverDocumentMutations(this.ctx.storage, this.handle, () => this.flush());
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
      } else throw error;
    }
    await this.loadComments();
    await this.sourcesEvent({ type: "boot", recorded: recordNamesSources(this.metadata) });
    for (const [viewId, format] of await this.storedViews()) {
      // A view in a format this build doesn't write is never opened: not
      // served, replayed, rewritten or released. It still counts toward the
      // cap, and purge still removes it.
      if (format !== WRITTEN_FORMATS[VIEW_MODULE.type]) continue;
      // A key whose document a release already removed: importing would
      // create its genesis, which SyncHost's gate refuses while the Page's
      // stamp names a feature this build lacks, failing the boot. The slot
      // stays, unserved, until a build that supports the stamp boots.
      if (
        !this.pageEditable() &&
        this.views?.get(viewId) === undefined &&
        !(await this.plain.stored(
          derivedDocumentId(await viewDocUuid(this.metadata.pageId, viewId)),
        ))
      )
        continue;
      const opened = this.views?.get(viewId)?.state.name === "ready";
      // A slot no write landed in: the host stopped between the key and the
      // journal entry, or the write failed after the key. Released only by
      // the boot that opened it, before any socket can hold the document,
      // and not while its journal can't replay (a pending intent may fill
      // it). A release that fails leaves the slot `releasing`, unserved and
      // unlisted, and the Page boots; the next boot or write to the id runs
      // it again.
      await this.releasingTolerated(viewId, { type: "boot", recorded: true });
      const doc = this.viewDoc(viewId);
      if (!opened && doc && doc.revision === undefined && this.pageEditable())
        await this.releasingTolerated(viewId, { type: "release" });
      this.forgetIdleView(viewId);
    }
    await this.restoreTitleProjection();
    // After recovery: a replayed journal entry was accepted before the
    // restart, not now.
    await this.watchContent();
  }

  /** Record content changes on the serving document (content-activity.mjs).
   * The stored time is restored first, so this host's next report carries
   * it. A change counts when its patches touch the title or blocks; the
   * comments document isn't observed.
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
      if (changesContent(patches)) this.contentActivity.changed();
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
            ? {
                etag: object.etag,
                card_hash: object.customMetadata?.card_hash ?? null,
                content_updated_at: object.customMetadata?.content_updated_at ?? null,
              }
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
              // The ordering fence (page-card-writer.mjs); head() reads both
              // fields back.
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
      // A newer host's card stays: one line, no Page ID or content.
      onSkip: () =>
        console.info(
          JSON.stringify({
            service: "nteract-pages-native",
            event: "page_card.superseded",
            timestamp: new Date().toISOString(),
          }),
        ),
    });
  }

  /** Remove this Page's card object and card images (card-images.mjs),
   * under a short deadline so bucket trouble never holds a purge or
   * tombstone. Best-effort: page_cards serves a card only to a caller its
   * Catalog check admits, and a deleted Page admits no one, so a missed
   * delete leaves an orphan no one reads. */
  async deleteCard() {
    const pageId = this.metadata?.pageId ?? this.ctx.id?.name;
    if (!this.env.PAGES_ASSETS || !validPageId(pageId)) return;
    try {
      await withTimeout(
        Promise.all([
          this.env.PAGES_ASSETS.delete(cardKey(pageId)),
          deleteCardImages(this.env.PAGES_ASSETS, pageId),
        ]),
        PAGE_CARD_DELETE_TIMEOUT_MS,
        "Page card delete timed out",
      );
    } catch (error) {
      logFailure(error, "page-card");
    }
  }

  /** The summary of one of this Page's datasets (dataset-summary.mjs), or
   * null. A summary is advisory: a missing bucket, a failure or a slow read
   * leaves it out rather than failing what asked for it. One store per host
   * keeps summaries in memory between reads; a purge closes it for good. */
  async datasetSummary(assetId) {
    const bucket = this.env.PAGES_ASSETS;
    if (!bucket || this.datasetSummariesClosed) return null;
    this.datasetSummaries ??= new DatasetSummaries({ bucket, pageId: this.metadata.pageId });
    try {
      return await withTimeout(
        this.datasetSummaries.summary(assetId),
        DATASET_SUMMARY_TIMEOUT_MS,
        "Dataset summary timed out",
      );
    } catch (error) {
      logFailure(error, "dataset-summary");
      return null;
    }
  }

  /** Remove this Page's uploaded images and datasets (image-assets.mjs
   * `deleteUploadedAssets`) under a deadline, so bucket trouble never holds
   * a purge. Best-effort: a deleted Page authorizes no asset read, so a
   * missed delete leaves bytes no one is served. */
  async deleteAssets() {
    const pageId = this.metadata?.pageId;
    if (!this.env.PAGES_ASSETS || !validPageId(pageId)) return;
    try {
      await withTimeout(
        deleteUploadedAssets(this.env.PAGES_ASSETS, pageId),
        ASSET_DELETE_TIMEOUT_MS,
        "Page asset delete timed out",
      );
    } catch (error) {
      logFailure(error, "page-assets");
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
              body: JSON.stringify({ page_id: pageId, content_updated_at: value }),
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
          reportContentActivity(this.env, this.ctx, { pageId, contentUpdatedAt: value }),
          catalogIndexTimeouts.write,
        ),
      );
    await Promise.all(tasks);
  }

  /** Open the Page's comments document (model/comments-doc.mjs) and finish
   * any journaled write to it. Importing its deterministic genesis is a
   * no-op once it exists, so this also creates it the first time. */
  async loadComments() {
    if (this.commentsHandle || !this.commentsUuid) return;
    this.commentsHandle = await this.importDerived(COMMENTS_MODULE, this.commentsUuid);
    this.assertNotAbandoned();
    await recoverDocumentMutations(
      this.ctx.storage,
      this.commentsHandle,
      () => this.flush(),
      COMMENTS_DOC,
    );
  }

  /** Serve the document `module` derives for this Page (`module.derived`)
   * under UUID `uuid`, and import its fixed genesis. Importing is a no-op
   * once the document is stored, so this also creates it. Returns its
   * handle; the caller replays its journal. */
  async importDerived(module, uuid) {
    const documentId = derivedDocumentId(uuid);
    this.plain.serve(documentId, module.kind);
    return this.repo.import(A.save(module.derived.genesis(uuid)), { docId: documentId });
  }

  /** The id of this Page's sources document, derived from the Page id
   * whether or not the document exists. */
  async sourcesDocumentId() {
    this.sourcesUuid ??= await derivedDocUuid(SOURCES_MODULE.derived.label, this.metadata.pageId);
    return derivedDocumentId(this.sourcesUuid);
  }

  /** Step the sources lifecycle (sources-lifecycle.mjs) and run its effects
   * in order. A failed effect leaves the lifecycle where the next write
   * starts over, and throws. */
  async sourcesEvent(event) {
    const result = sourcesStep(this.sourcesState ?? SOURCES_ABSENT, event);
    if (result.rejected)
      throw Error(`The sources lifecycle refused ${event.type} in ${this.sourcesState?.name}`);
    this.sourcesState = result.state;
    for (const effect of result.effects) {
      let done;
      try {
        done = await this.sourcesEffect(effect);
      } catch (error) {
        this.sourcesState = sourcesStep(this.sourcesState, { type: "failed" }).state;
        throw error;
      }
      await this.sourcesEvent(done);
    }
  }

  /** One sources lifecycle effect. Returns the event that reports it. */
  async sourcesEffect(effect) {
    switch (effect) {
      case "load":
      case "store": {
        const documentId = await this.sourcesDocumentId();
        this.sourcesHandle = await this.importDerived(SOURCES_MODULE, this.sourcesUuid);
        this.assertNotAbandoned();
        if (effect === "load") {
          if (this.pageEditable())
            await recoverDocumentMutations(
              this.ctx.storage,
              this.sourcesHandle,
              () => this.flush(),
              SOURCES_DOC,
            );
          return { type: "loaded" };
        }
        await this.plain.flush([documentId]);
        await this.ctx.storage.sync();
        return { type: "stored" };
      }
      case "record": {
        const metadata = {
          ...this.metadata,
          documentFormats: {
            ...recordDocumentFormats(this.metadata),
            [SOURCES_MODULE.type]: WRITTEN_FORMATS[SOURCES_MODULE.type],
          },
        };
        await this.ctx.storage.put("host/document", metadata);
        await this.ctx.storage.sync();
        this.metadata = metadata;
        return { type: "recorded" };
      }
      default:
        throw Error(`Unknown sources effect ${effect}`);
    }
  }

  /** Whether this build can write the Page's documents: the Page's schema
   * stamp names no feature it lacks. While it does, a pending intent for
   * the sources or a view document isn't replayed (SyncHost's gate would
   * refuse it, and the boot with it); it stays pending for a build that
   * supports the stamp, and the document loads at its stored state. */
  pageEditable() {
    return !unsupportedFeatures(this.handle.doc()).length;
  }

  /** Forget the sources document: the Page's documents are gone. */
  dropSources() {
    this.sourcesHandle = undefined;
    this.sourcesState = sourcesStep(this.sourcesState ?? SOURCES_ABSENT, { type: "drop" }).state;
  }

  /** The Page's sources document, or undefined while it doesn't exist. */
  sourcesView() {
    return this.sourcesState?.name === "ready" ? this.sourcesHandle?.doc() : undefined;
  }

  /** The views the host lists (VIEW_KEY_PREFIX), `[view_id, format]` by
   * id, whatever their format. At most MAX_VIEWS, so one list call reads
   * them all. */
  async storedViews() {
    const keys = await this.ctx.storage.list({ prefix: VIEW_KEY_PREFIX });
    return [...keys]
      .map(([key, value]) => [key.slice(VIEW_KEY_PREFIX.length), value?.format])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** The ids of the views the host lists, whatever their format. */
  async storedViewIds() {
    return (await this.storedViews()).map(([viewId]) => viewId);
  }

  /** The refusal for a write to view `viewId` when its key names a format
   * this build doesn't write, or undefined. */
  async viewFormatRefusal(viewId) {
    const stored = await this.ctx.storage.get(viewKey(viewId));
    if (stored === undefined || stored?.format === WRITTEN_FORMATS[VIEW_MODULE.type]) return;
    return Object.assign(
      new HttpError(
        409,
        `The view "${viewId}" is stored in a format this version of Pages doesn't open.`,
        "document_format_unsupported",
      ),
      { details: { view_id: viewId } },
    );
  }

  /** The host's entry for view `viewId`: its document UUID, handle,
   * lifecycle state (view-lifecycle.mjs) and the queue its events run in.
   * `views` is keyed by view id. An entry is made by boot or by a write that
   * passed its checks, in the slot queue, and dropped there once it is
   * absent (forgetIdleView). */
  async viewEntry(viewId) {
    this.views ??= new Map();
    let entry = this.views.get(viewId);
    if (!entry) {
      entry = {
        uuid: await viewDocUuid(this.metadata.pageId, viewId),
        handle: undefined,
        state: VIEW_ABSENT,
        queue: Promise.resolve(),
      };
      // Another caller may have made it while the UUID was hashed.
      if (this.views.has(viewId)) return this.views.get(viewId);
      this.views.set(viewId, entry);
    }
    return entry;
  }

  /** Drop view `viewId`'s entry once it is absent. */
  forgetIdleView(viewId) {
    if (this.views?.get(viewId)?.state.name === "absent") this.views.delete(viewId);
  }

  /** Step view `viewId` with `event`; a failed release, which leaves the
   * view `releasing`, is logged instead of thrown. Any other failure throws. */
  async releasingTolerated(viewId, event) {
    try {
      await this.viewEvent(viewId, event);
    } catch (error) {
      if (this.views?.get(viewId)?.state.name !== "releasing") throw error;
      logFailure(error, "view-release");
    }
  }

  /** Run `step` after every earlier one. A write takes its view slot here,
   * so the view cap is read and the key written as one step. */
  viewSlot(step) {
    const run = (this.viewSlots ?? Promise.resolve()).then(step);
    this.viewSlots = run.catch(() => {});
    return run;
  }

  /** Step view `viewId`'s lifecycle and run its effects in order, after its
   * earlier events. A failed effect steps `failed` and throws. */
  async viewEvent(viewId, event) {
    const entry = await this.viewEntry(viewId);
    const run = entry.queue.then(() => this.stepView(viewId, entry, event));
    entry.queue = run.catch(() => {});
    return run;
  }

  async stepView(viewId, entry, event) {
    const result = viewStep(entry.state, event);
    if (result.rejected)
      throw Error(`The view lifecycle refused ${event.type} in ${entry.state.name}`);
    entry.state = result.state;
    for (const effect of result.effects) {
      let done;
      try {
        done = await this.viewEffect(viewId, entry, effect);
      } catch (error) {
        entry.state = viewStep(entry.state, { type: "failed" }).state;
        throw error;
      }
      await this.stepView(viewId, entry, done);
    }
  }

  /** One view lifecycle effect. Returns the event that reports it. */
  async viewEffect(viewId, entry, effect) {
    switch (effect) {
      case "load":
      case "store": {
        // Served from here on: a tab the Page body tells about the view can
        // sync it at once.
        entry.handle = await this.importDerived(VIEW_MODULE, entry.uuid);
        this.assertNotAbandoned();
        if (effect === "load") {
          if (this.pageEditable())
            await recoverDocumentMutations(
              this.ctx.storage,
              entry.handle,
              () => this.flush(),
              keyedDoc(VIEW_MODULE, viewId),
            );
          return { type: "loaded" };
        }
        await this.plain.flush([derivedDocumentId(entry.uuid)]);
        await this.ctx.storage.sync();
        return { type: "stored" };
      }
      case "record":
        // The key alone records the view. The Page record never names
        // `pages.view`, so a host that predates views opens the Page.
        await this.ctx.storage.put(viewKey(viewId), {
          format: WRITTEN_FORMATS[VIEW_MODULE.type],
        });
        await this.ctx.storage.sync();
        return { type: "recorded" };
      case "release":
        // The document first, then the key: until the key is gone, the next
        // boot or create finds the view `releasing` and runs this again.
        // Each step is idempotent.
        entry.handle = undefined;
        await this.repo.delete(derivedDocumentId(entry.uuid));
        await this.ctx.storage.delete(viewKey(viewId));
        await this.ctx.storage.sync();
        return { type: "released" };
      default:
        throw Error(`Unknown view effect ${effect}`);
    }
  }

  /** Forget every view: the Page's documents are gone. */
  dropViews() {
    for (const entry of this.views?.values() ?? []) {
      entry.handle = undefined;
      entry.state = viewStep(entry.state, { type: "drop" }).state;
    }
  }

  /** View `viewId`'s document, or undefined while it doesn't exist. */
  viewDoc(viewId) {
    const entry = this.views?.get(viewId);
    return entry?.state.name === "ready" ? entry.handle?.doc() : undefined;
  }

  /** `[viewId, entry]` of each view whose document is served, by id. */
  servedViews() {
    return [...(this.views ?? [])]
      .filter(([, entry]) => entry.handle)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** `{ [view_id]: documentId }` of each view that holds a write. A slot
   * with no revision is never advertised. */
  viewDocumentIds() {
    return Object.fromEntries(
      this.servedViews()
        .filter(([viewId]) => this.viewDoc(viewId)?.revision !== undefined)
        .map(([viewId, entry]) => [viewId, derivedDocumentId(entry.uuid)]),
    );
  }

  /** What a read sees of the Page's views: the ids of the views that hold
   * one, and each one's document. */
  viewReads() {
    return {
      ids: () =>
        this.servedViews()
          .map(([viewId]) => viewId)
          .filter((viewId) => this.viewDoc(viewId)?.revision !== undefined),
      doc: (viewId) => this.viewDoc(viewId),
    };
  }

  /** Boot plain Automerge sync for the Page: DocumentPolicy for access, and
   * PlainSync for history, admission and the host's Repo
   * (worker/plain-sync.mjs). A Page record that names other storage (a
   * Subduction Page from before every Page was plain) is refused unless the
   * Page is deleted. */
  initializeRepo(metadata = this.metadata) {
    if (this.repo) return Promise.resolve();
    if (this.initializing) return this.initializing;
    const attempt = (async () => {
      const deleted = pageState(metadata) === "deleted";
      if (metadata && !RECORD_STORAGE_MODES.includes(metadata.recordStorage) && !deleted)
        throw Error("Unsupported Page record storage mode");
      await this.initializePlain(metadata, { deleted });
    })();
    this.initializing = attempt;
    const clear = () => {
      if (this.initializing === attempt) this.initializing = undefined;
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  async initializePlain(metadata, { deleted }) {
    const ctx = this.ctx;
    const commentsUuid = recordCommentsUuid(metadata);
    const policy = new DocumentPolicy({
      metadata: () =>
        this.recoveryBlocked
          ? {
              ...(this.policyMetadata ?? this.metadata),
              projectAccess: this.projectAccess,
              recoveryBlocked: true,
            }
          : { ...(this.policyMetadata ?? this.metadata), projectAccess: this.projectAccess },
    });
    const plain = new PlainSync({
      storage: ctx.storage,
      policy,
      pageFeatures: () => (this.handle ? documentFeatures(this.handle.doc()) : []),
      onRefused: (conn, refusal, { doc, repeats }) => {
        if (conn.trusted) return logFailure(refusal, "plain-host-write");
        logSyncRefused({
          pageId: metadata?.pageId,
          kind: doc.kind,
          refusal,
          credential: conn.identity?.credentialKind,
          repeats,
        });
        // Comment queries read this event.
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
      onWrite: (conn, doc) => this.browserWrite(conn, conn.identity, doc.kind),
      // A browser receives host messages once it has joined the document
      // that carries them, the Page document (document-modules.mjs).
      onJoined: () => {
        this.broadcastProfiles();
        this.broadcastActivity();
        this.broadcastActorSnapshot();
      },
    });
    // A deleted Page serves nothing: its documents are gone, and a record
    // from a Subduction Page may name one plain sync can't address. A record
    // in a format this build doesn't write serves nothing either; a purge
    // still deletes its stored documents by id.
    const documents = [];
    const serving = !deleted && !this.formatRefusal(metadata);
    if (serving && metadata?.documentId) documents.push([metadata.documentId, PAGE_MODULE.kind]);
    if (serving && commentsUuid)
      documents.push([commentsDocumentId(commentsUuid), COMMENTS_MODULE.kind]);
    await plain.load(documents, { deleted });
    Object.assign(this, {
      serverSenderId: HOST_SENDER_ID,
      policy,
      plain,
      repo: plain.repo,
      ...(commentsUuid && { commentsUuid }),
    });
  }

  /** Finish a recorded creation intent. An installed record wins over it, so
   * a replay never undoes a later Trash, restore or ACL change. */
  async finishCreation(intent) {
    await this.applyLifecycle(this.metadata ? CREATION_REPLAY : CREATION_COMMIT, { intent });
  }

  profiles() {
    return {
      ...this.plain.profiles(),
      [this.serverSenderId]: { principal: "service:pages", displayName: "Pages", driver: "API" },
    };
  }

  activityState() {
    this.activity ??= new PageActivity({
      pageId: this.metadata.pageId,
      access: (identity) => this.policy.account(identity, true),
      readAccess: (identity) => this.policy.account(identity),
      profiles: () => this.plain.profiles(),
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

  browserWrite(session, identity, kind) {
    this.browserWrites ??= new BrowserWrites();
    this.browserWrites.admitted(session, identity, kind, this.metadata?.pageId, this.env);
  }

  /** Attested actors and their recent attested change hashes, now. */
  actorSnapshot() {
    return this.plain.actorSnapshot();
  }

  /** Resend the whole snapshot once a socket subscribes: an attestation made
   * after its /api/connect response reached only earlier subscribers. */
  broadcastActorSnapshot() {
    if (!this.handle || !this.plain) return;
    try {
      this.handle.broadcast({ kind: "actor-profiles", ...this.actorSnapshot(), snapshot: true });
    } catch (error) {
      logFailure(error, "actor-profiles");
    }
  }

  /** Read the title this host last projected and when it observed it. Call
   * once the serving document is loaded, before the first projection. */
  async restoreTitleProjection() {
    const stored = storedTitleProjection(await this.ctx.storage.get(TITLE_PROJECTION_KEY));
    this.advanceTitleProjection({ type: "restore", record: stored });
  }

  /** Advance before effects. Local writes run in order, including clears:
   * a delete already awaiting storage cannot overtake a newer mark. Queued
   * obsolete effects are skipped; completions are fenced again by the machine.
   * Catalog delivery is started by cacheTitle and never waits on this queue. */
  advanceTitleProjection(event) {
    const { state, effects } = titleProjection(this.titleProjection, event);
    this.titleProjection = state;
    for (const effect of effects) {
      if (effect.type === "deliver") continue;
      const run = async () => {
        const current = this.titleProjection;
        if ((effect.type === "clear" ? current.token : current.storage?.token) !== effect.token)
          return;
        let ok = true;
        try {
          if (effect.type === "clear") await this.ctx.storage.delete(PROJECTION_PENDING);
          else if (effect.type === "mark") await this.ctx.storage.put(PROJECTION_PENDING, true);
          else await this.ctx.storage.put(TITLE_PROJECTION_KEY, effect.record);
        } catch (error) {
          ok = false;
          logFailure(
            error,
            effect.type === "store" ? "title-projection" : "title-projection-pending",
          );
        }
        this.advanceTitleProjection({ ...effect, type: `${effect.type}Finished`, ok });
      };
      this.titleStorageTail = (this.titleStorageTail ?? Promise.resolve()).then(run);
      this.ctx.waitUntil(this.titleStorageTail);
    }
    return effects;
  }

  /** Project this Page's title to the Catalogs that list it, and report its
   * row to the index. `observe` marks a new observation of an unchanged
   * title: an ACL commit or a restore. */
  cacheTitle(identity, { observe = false } = {}) {
    // A trashed Page must not relist itself in owner or member catalogs.
    if (pageState(this.metadata) !== "active") return;
    // A Page whose documents this host doesn't open sends the title it last
    // projected, and nothing when it never projected one.
    if (!this.handle && this.pageTitle() === undefined) return;
    const title = catalogTitle(this.pageTitle());
    // A link audience's reader: someone who opened the Page through company
    // view or its organization grant.
    const audience = identity
      ? openedAudienceKey(this.metadata, identity, pageAccess(this.metadata, identity))
      : null;
    const observedReader = audience ? identity.principal : null;
    const effects = this.advanceTitleProjection({
      type: "project",
      title,
      observe,
      now: Date.now(),
    });
    const fanout = effects.find((effect) => effect.type === "deliver");
    if (!fanout && !observedReader) return;
    const recipients = !fanout
      ? [observedReader]
      : [
          this.metadata.owner,
          ...Object.entries(this.metadata.acl?.members ?? {})
            .filter(([, value]) => ["viewer", "commenter", "editor"].includes(value.role))
            .map(([principal]) => principal),
          ...(observedReader ? [observedReader] : []),
        ];
    // A domain reader's open alone is that reader's discovery, observed now.
    const record = this.titleProjection.record;
    const observedAt = fanout ? record.observed_at : new Date().toISOString();
    const keepTime = fanout ? record.keep !== false : false;
    const contentUpdatedAt = this.contentActivity?.value ?? null;
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
    this.ctx.waitUntil(
      Promise.allSettled(projections).then((results) => {
        if (fanout)
          this.advanceTitleProjection({
            ...fanout,
            type: "deliverFinished",
            ok: results.every(
              (result, index) =>
                recipients[index] === observedReader ||
                (result.status === "fulfilled" && result.value.ok),
            ),
          });
      }),
    );
    if (catalogIndexEpoch(this.env)) {
      // A domain reader's row is rewritten when the reader opens the Page for
      // the first time in this host's life, after a title change, and after
      // the content time moved past the one its last report carried. A flush
      // never rewrites these rows (reportContentActivity).
      if (fanout) this.indexedReaders = new Map();
      this.indexedReaders ??= new Map();
      const reported = this.indexedReaders.get(observedReader);
      const reader =
        observedReader &&
        (reported === undefined || (contentUpdatedAt !== null && contentUpdatedAt !== reported))
          ? { principal: observedReader, domain: audience }
          : undefined;
      if (fanout || reader) {
        if (reader) this.indexedReaders.set(reader.principal, contentUpdatedAt);
        const readers = this.indexedReaders;
        this.ctx.waitUntil(
          this.reportIndex({
            title,
            observedAt,
            reader,
            readerOnly: !fanout,
            contentUpdatedAt,
            keepTime,
          }).catch((error) => {
            logFailure(error, "catalog-index-report");
            if (reader && readers.get(reader.principal) === contentUpdatedAt)
              readers.delete(reader.principal);
          }),
        );
      }
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
          reportPageIndex(this.env, this.ctx, { metadata: this.metadata, ...details }),
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
    this.advanceTitleProjection({ type: "observe", title, now: Date.now() });
    const record = this.titleProjection.record;
    this.ctx.waitUntil(
      this.reportIndex({
        title,
        observedAt: record.observed_at,
        keepTime: record.keep !== false,
        contentUpdatedAt: this.contentActivity?.value ?? null,
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
    if (catalogIndexEpoch(this.env)) {
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
    // A permanent deletion deletes the Page's tag rows itself, after the
    // tombstone above fences late tag writes, and whether or not the catalog
    // index is on. Unlike the projection it is not best-effort: the rows are
    // the only record, so a failure fails this step and the lifecycle repeats
    // it. Trash keeps tags.
    if (pageState(this.metadata) === "deleted")
      await deletePageTags(this.env, this.ctx, this.metadata.pageId);
  }

  async installAccess(metadata) {
    // Restrict immediately, but make no new grant visible before the single
    // host record containing the ACL and receipt has crossed durability.
    this.pendingAccess = metadata;
    const previous = this.policyMetadata ?? this.metadata;
    const restricted = restrictAccessDuringCommit(previous, metadata);
    this.policyMetadata = { ...restricted, aclCommitting: true };
    this.activity?.prune();
    this.plain.refresh();
    if (catalogIndexEpoch(this.env) && listingRestricted(previous, restricted, this.env))
      await this.restrictIndex(restricted, metadata.acl?.revision ?? 0);
    await this.ctx.storage.put("host/document", metadata);
    await this.ctx.storage.sync();
    this.metadata = metadata;
    this.policyMetadata = undefined;
    this.plain.refresh();
    this.activity?.prune();
    this.pendingAccess = undefined;
    this.cacheTitle(undefined, { observe: true });
  }

  /** The refusal for opening this Page's documents, or undefined. A record
   * whose `documentFormats` aren't the ones this build writes opens neither
   * document (recordFormatsWritten); the owner still manages the Page from
   * its record. A deleted Page serves nothing either way, so it never gets
   * this refusal. */
  formatRefusal(metadata = this.metadata) {
    if (!metadata || pageState(metadata) === "deleted" || recordFormatsWritten(metadata))
      return undefined;
    return documentFormatsUnsupported();
  }

  /** The Page's title: its document's, or for a Page whose documents this
   * host doesn't open, the one it last projected. Undefined without either. */
  pageTitle() {
    return this.handle ? this.handle.doc().title : this.titleProjection?.record?.title;
  }

  /** The Page's comments document. The Page's `comments-doc` stamp says its
   * comments live there; a Page without the stamp fails closed. */
  commentsView() {
    if (this.handle && !commentsMigrated(this.handle.doc()))
      throw storedFormUnsupported("this Page's comments");
    return this.commentsHandle?.doc();
  }

  /** The repo document IDs this Page host holds: the Page and, once open,
   * its comments and sources documents and its views. A record in a format this build
   * doesn't write holds none. */
  documentIds() {
    if (this.formatRefusal()) return [];
    return [
      this.metadata.documentId,
      ...(this.commentsHandle ? [commentsDocumentId(this.commentsUuid)] : []),
      ...(this.sourcesHandle ? [derivedDocumentId(this.sourcesUuid)] : []),
      ...this.servedViews().map(([, entry]) => derivedDocumentId(entry.uuid)),
    ];
  }

  async flush() {
    await this.plain.flush(this.documentIds());
    await this.ctx.storage.sync();
  }

  fetch(request) {
    // Permission changes/claims and HTTP mutations share one admission order.
    // Sync frames run directly through SyncHost's own queue. Both paths hold
    // the request until it settles (request-hold.mjs): a save waits for heads
    // and the host's flush.
    const settle = (work) => {
      holdUntilSettled(this.ctx, work.then(noop, noop));
      return work;
    };
    if (["/api/sync", "/api/saved"].includes(new URL(request.url).pathname)) {
      const running = this.run(request);
      return settle(running);
    }
    // An upload capability is the one credential the gateway doesn't check
    // first (asset-uploads.mjs), so it is screened before it may queue.
    const capability = hostUploadCapability(request);
    if (capability !== undefined) return settle(this.screenUpload(request, capability));
    return settle(this.enqueue(request));
  }

  /** Run `request` in admission order. A request that returns `AfterQueue`
   * has decided its admission in the queue and finishes its work here, after
   * the queue has moved on, so a slow dependency can't hold later requests. */
  enqueue(request) {
    const next = this.tail.then(() => this.run(request));
    this.tail = next.catch(() => {});
    return next.then((result) => (result instanceof AfterQueue ? result.finish() : result));
  }

  /** An upload capability's screen (asset-uploads.mjs uploadScreen): only the
   * host record and this Page's key, never the queue or the document. A
   * forged, foreign or expired token is refused here; a valid one queues,
   * and run() decides it against current state (identify). */
  async screenUpload(request, token) {
    let refusal;
    try {
      await this.ready;
      refusal = uploadScreen(await openUploadCapability(this.ctx.storage, token), {
        pageId: this.metadata?.pageId,
        now: Date.now(),
      });
    } catch (error) {
      return errorResponse(error, "page");
    }
    return refusal ? errorResponse(refusal, "page") : this.enqueue(request);
  }

  /** What a Page converted from Subduction still holds of it, which the
   * plain host never reads: native records, actor entries, signing-key
   * bindings, the signer seed, and its PageRecords object when
   * pageRecordsHolder says `clear`. A live or trashed `buffered` Page's
   * records are its only history (`held`), so they stay. Deleting the Page
   * deletes the rest. Each step is idempotent, so a repeated deletion
   * finishes the job. */
  async purgeConvertedRecords() {
    if (pageRecordsHolder(this.metadata) === "clear") await this.pageRecords("clear");
    await clearPrefixes(this.ctx.storage, ["repo/", "host/actor/", "host/binding/"]);
    await this.ctx.storage.delete("host/signer");
  }

  /** `inspect` or `clear` this Page's PageRecords object
   * (worker/page-records.mjs). The abandoned-object gate refuses it like any
   * other storage write. */
  async pageRecords(action) {
    const refusal = this.storageRefusal();
    if (refusal) throw refusal;
    return pageRecordsCall(this.env.PAGE_RECORDS.getByName(this.metadata.pageId), action);
  }

  async run(request) {
    const url = new URL(request.url);
    const admissionRoute = ADMISSION_ROUTES.includes(url.pathname);
    let identity;
    try {
      await this.ready;
      // A link preview's check (link-previews.mjs) never reaches the code
      // below: it records no usage, claims no invitation, writes no
      // projection or Catalog entry, and boots only for a reader it admitted.
      if (url.pathname === LINK_PREVIEW_PATH) return await this.linkPreviewResponse(request);
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
      flushUsage(this.env, this.ctx);
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
      if (url.pathname === "/internal/content-target") {
        if (request.headers.has("authorization") || request.headers.has("cookie"))
          throw spaceNotFound();
        const args = await readJson(request);
        if (
          !this.metadata ||
          this.metadata.pageId !== args.page_id ||
          this.metadata.owner !== args.owner ||
          pageState(this.metadata) !== "active" ||
          this.pendingLifecycle
        )
          throw spaceNotFound();
        await this.ctx.storage.sync();
        return json({ page_id: this.metadata.pageId });
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
        const args = await readJson(request);
        // A Project member's creation names the Project owner. Only the
        // owner's Catalog can vouch for it (requireDelegatedCreation).
        const delegated = args?.owner !== undefined && args.owner !== identity.principal;
        if (this.metadata) {
          if (delegated) {
            if (this.metadata.owner !== args.owner)
              throw new HttpError(403, "Document access denied");
            await this.requireDelegatedCreation(args.owner, this.metadata.pageId, identity);
          } else this.policy.account(identity);
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
        if (!validPageId(args?.page_id) || (this.ctx.id.name && args.page_id !== this.ctx.id.name))
          throw new HttpError(400, "Invalid page_id");
        validateCreateInput(args);
        const creation = delegated
          ? await this.requireDelegatedCreation(args.owner, args.page_id, identity)
          : null;
        let intent = await this.ctx.storage.get("host/creation");
        let created;
        if (intent) {
          // Catalog handles argument replay; this DO independently pins ownership.
          if (
            intent.metadata.owner !== (delegated ? args.owner : identity.principal) ||
            (delegated && intent.metadata.creator?.principal !== identity.principal)
          )
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
              recordStorage: "automerge",
              pageId: args.page_id,
              owner: delegated ? args.owner : identity.principal,
              ...(delegated
                ? typeof creation.owner_name === "string" && { ownerName: creation.owner_name }
                : { ownerName: identity.displayName }),
              // Who asked for the Page when that isn't its owner: a Project
              // member adding a Page the Project owner owns.
              ...(delegated && {
                creator: { principal: identity.principal, displayName: identity.displayName },
              }),
              documentId,
              // The Page's comments document, by its deployment-relative id.
              comments_doc: await commentsDocUuid(args.page_id),
              // The format of each document type the Page holds. The comments
              // document is created at boot, in the format named here.
              documentFormats: { ...MEMBER_FORMATS },
              deleted: false,
              // Location lives in the owner's Catalog; the receipt there adds it.
              // The first block's id and its nodes' ids, so the first edit
              // needs no read.
              createdReceipt: {
                page_id: args.page_id,
                title: doc.title,
                heads: A.getHeads(doc),
                ...firstBlockAddresses(doc),
                ...(warning ? { warnings: [warning] } : {}),
              },
            };
            // The receipt's revision is minted in the put that records the
            // intent, so every reply to this creation names the same one.
            const clock = await revisionClock(this.ctx.storage);
            created = revisionPlan(this.ctx.storage, clock.at, clock.horizon);
            metadata.createdReceipt.revision = await created.handle(PAGE_DOC, A.getHeads(doc));
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
          await this.ctx.storage.put({ "host/creation": intent, ...created.writes });
          await created.settle();
        }
        await this.initializeRepo(intent.metadata);
        await this.finishCreation(intent);
        return json(await this.createdReply(intent.metadata.createdReceipt, identity), 201);
      }
      const hidden = this.hiddenRefusal(identity, admissionRoute);
      if (hidden) throw hidden;
      if (pageState(this.metadata) === "trashed" && !this.handle && !this.formatRefusal()) {
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
      if (url.pathname === CONTENT_IMPACT_PATH) {
        // The owner's Catalog previewing or confirming a Project's deletion:
        // what this content document holds, and the heads it holds them at.
        // Like Trash and purge it runs from the record, before the format
        // refusal: a record in a format this build doesn't write reports its
        // lifecycle revision only, with null heads and counts, and nothing
        // opens its documents.
        if (pageRelation(this.metadata, identity.principal) !== "owner")
          throw new HttpError(403, "Document access denied");
        if (pageState(this.metadata) !== "active")
          throw new HttpError(404, "Page not found", "page_not_found");
        const revision = this.metadata.lifecycleRevision ?? 0;
        if (this.formatRefusal())
          return json({
            page_id: this.metadata.pageId,
            revision,
            heads: null,
            comment_heads: null,
            ...discussionOf(null),
          });
        await this.loadComments();
        const doc = this.handle.doc();
        const comments = this.commentsView();
        return json({
          page_id: this.metadata.pageId,
          revision,
          heads: A.getHeads(doc),
          comment_heads: comments ? A.getHeads(comments) : [],
          ...discussionOf(doc, comments),
        });
      }
      const state = pageState(this.metadata);
      // claimInvitation ignores trashed records, so the ACL stays unchanged.
      if (!["/api/sync", "/api/saved"].includes(url.pathname)) {
        await this.repairIndex();
        const claimed = await claimInvitation(this.metadata, identity, this.env);
        if (claimed) await this.installAccess(claimed);
      }
      this.policy.account(identity);
      // A record in a format this build doesn't write opens no document. The
      // shared-Page check and sharing answer from the record; the socket
      // closes with this refusal (connect); every other route is refused.
      const unopened = this.formatRefusal();
      if (unopened && !RECORD_ROUTES.includes(url.pathname)) throw unopened;
      if (url.pathname === ASSET_AUTHORIZE_PATH) {
        const args = await readJson(request);
        if (args.page_id !== this.metadata.pageId || typeof args.write !== "boolean")
          throw new HttpError(400, "Invalid image access request");
        const capability = identity.credentialKind === UPLOAD_CREDENTIAL;
        // An upload capability authorizes uploads, never reads.
        if (capability && !args.write) throw uploadRefusal("misused");
        // Uploads need edit access. Asset storage has no per-Page aggregate
        // quota, so comment access alone doesn't open it: commenters comment
        // in text, and can't attach images until that quota exists.
        this.policy.account(identity, args.write);
        // A capability's binding goes back to the gateway, which checks the
        // bytes against it before storing them.
        return json({
          page_id: this.metadata.pageId,
          ...(capability && { upload: identity.upload }),
        });
      }
      if (url.pathname === "/internal/card-image/authorize") {
        // The owner's grid card image (card-images.mjs): this host's policy
        // and its loaded document decide, never D1.
        try {
          const accepted = await authorizeCardImageUpload({
            args: await readJson(request),
            pageId: this.metadata.pageId,
            owner: this.metadata.owner,
            identity,
            account: () => this.policy.account(identity, true),
            currentHash: async () =>
              this.handle ? (await pageCard(this.handle.doc())).card_hash : null,
            guard: (this.cardImageGuard ??= new CardImageGuard()),
          });
          // Admitted uploads are numbered in order, durably, so the bucket can
          // refuse an older first screen that lands late (card-images.mjs).
          const revision = ((await this.ctx.storage.get(CARD_IMAGE_REVISION_KEY)) ?? 0) + 1;
          await this.ctx.storage.put(CARD_IMAGE_REVISION_KEY, revision);
          // The JSON card the grid compares against catches up from this
          // live request, so a Page untouched since cards shipped gets both.
          this.pageCard?.request();
          this.pageCard?.pump();
          return json({ ...accepted, revision });
        } catch (error) {
          return cardImageRefusal(error, "card-image");
        }
      }
      if (url.pathname === "/internal/catalog") {
        // A loaded host's first check reports this Page's current row and
        // fixes the time its title was observed.
        this.cacheTitle();
        return json(
          catalogAnswer({ ...this.metadata, projectAccess: this.projectAccess }, identity, {
            title: this.pageTitle(),
            observed: {
              at: this.titleProjection?.record?.observed_at,
              keep: this.titleProjection?.record?.keep !== false,
            },
            contentUpdatedAt: this.contentActivity?.value ?? null,
          }),
        );
      }
      if (url.pathname === "/internal/access") {
        const args = await readJson(request);
        if (identity.principal !== this.metadata.owner && identity.credentialKind === "oauth")
          throw new HttpError(403, "Only the Page owner can manage sharing");
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
        const commentsId = this.commentsHandle ? commentsDocumentId(this.commentsUuid) : undefined;
        return json({
          page_id: this.metadata.pageId,
          documentId: this.metadata.documentId,
          // The comments document syncs on the same socket.
          ...(this.commentsHandle && { commentsDocumentId: commentsId }),
          // The sources document and each view, once they exist, sync on
          // the same socket to a client that declares their formats.
          documents: pageDocuments(
            recordDocumentFormats(this.metadata),
            this.metadata.documentId,
            commentsId,
            this.sourcesView() ? derivedDocumentId(this.sourcesUuid) : undefined,
            this.viewDocumentIds(),
          ),
          recordStorage: "automerge",
          serverSenderId: this.serverSenderId,
          identity: publicIdentity(identity),
          canWrite: !this.recoveryBlocked && this.policy.account(identity).canWrite,
          access: {
            ...this.policy.account(identity),
            ...(this.recoveryBlocked && { canWrite: false, canComment: false }),
          },
          ...(this.recoveryBlocked && { recovery: this.recoveryBlocked }),
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
            this.policy.account(identity).canRead && { preview: pagePreview(this.handle.doc()) }),
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
        return json({ durableHeads, ...(durableCommentHeads && { durableCommentHeads }) });
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
          // Who is on the Page, resolved against it now. It names no revision
          // and writes nothing; read_page names the revision an edit uses.
          return json(this.activityState().read(this.handle.doc()));
        }
        if (["read_page", "read_page_changes", "list_page_comments"].includes(body.operation)) {
          this.cacheTitle(identity);
          const options = {
            recovery: this.recoveryBlocked,
            historyIncomplete: incompleteHistory(this.handle.doc()),
            getPresence: (doc) => this.activityState().read(doc),
            commentsDoc: this.commentsView(),
            sourcesDoc: this.sourcesView(),
            datasetSummary: (assetId) => this.datasetSummary(assetId),
            views: this.viewReads(),
            revisions: this.revisionTable(),
            writers: (changes) =>
              resolveWriters(
                {
                  storage: this.ctx.storage,
                  prefix: this.plain.hostActorPrefix,
                  claim: (actor) => this.plain.claim(actor),
                },
                changes,
              ),
          };
          const result =
            body.operation === "read_page_changes"
              ? await readChangesTool(this.handle.doc(), body.arguments ?? {}, options)
              : await readTool(this.handle.doc(), body.operation, body.arguments ?? {}, options);
          if (
            body.operation === "read_page" &&
            result.status === 200 &&
            state !== "trashed" &&
            Array.isArray(result.heads)
          ) {
            // Browser edits can land while the revision is named. Capture the
            // targets on the revision the agent read; cursors carry them forward.
            const heads = result.heads;
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
        if (body.operation === "update_page_tags") {
          if (state === "trashed")
            throw new HttpError(409, "Restore this Page before changing its tags", "page_trashed");
          // Access and Trash state are decided here, in the queue. The write
          // is D1 work, so it runs after the queue releases this request
          // (updateTags).
          const change = this.tagChange(body.arguments);
          const pageId = this.metadata.pageId;
          return new AfterQueue(async () => {
            try {
              return json(await this.updateTags(identity, pageId, change));
            } catch (error) {
              if ((error.status ?? 500) >= 500) logFailure(error, "page");
              return errorResponse(await this.agentRefusal(error), "page");
            }
          });
        }
        if (body.operation === "report_page_progress") {
          const revision = body.arguments?.revision;
          // The targets' revision resolves before the snapshot it is checked in.
          const heads =
            revision === undefined
              ? undefined
              : await headsFor(this.ctx.storage, PAGE_DOC, revision);
          return json(
            this.activityState().report(this.handle.doc(), identity, body.arguments, heads),
          );
        }
        // An upload URL needs what an upload needs: write scope (checked by
        // the gateway) and current edit access (just above). It lasts no
        // longer than the access of the identity the upload will stand for.
        if (body.operation === ASSET_UPLOAD_OPERATION)
          return json(
            await issueAssetUpload(this.ctx.storage, {
              pageId: this.metadata.pageId,
              identity,
              args: body.arguments,
              origin: pagesPublicOrigin(this.env),
              accessUntil: (claims) => uploaderEditUntil(this.policy.metadata(), claims, this.env),
            }),
          );
        if (body.operation !== "edit_page") throw new HttpError(400, "Unknown document operation");
        const ops = Array.isArray(body.arguments?.operations) ? body.arguments.operations : [];
        // One journal entry writes one document: a batch with a set_source
        // writes the sources document and nothing else.
        const sourceOps = ops.filter((op) => op?.op === "set_source").length;
        if (sourceOps && sourceOps !== ops.length)
          throw new HttpError(
            400,
            "A batch with set_source holds only set_source operations. Send the other operations in a second edit_page request.",
            "invalid_arguments",
          );
        if (sourceOps) return json(await this.writeSources(request, identity, body));
        // A set_view writes one view's document: its batch holds it alone.
        if (ops.some((op) => op?.op === "set_view")) {
          if (ops.length !== 1)
            throw new HttpError(
              400,
              "A batch with set_view holds only that one operation. Send the other operations in a second edit_page request.",
              "invalid_arguments",
            );
          return json(await this.writeView(request, identity, body));
        }
        // Ops that create a node naming a stored asset (model/node-registry.mjs).
        const inserts = ops.filter((op) => insertOperation(op?.op) || op?.op === "set_image");
        // Where this batch landed, captured inside the change so the cursors
        // name the characters it wrote. A replayed receipt has no caret.
        let caret = null;
        let applied;
        const receipt = await documentMutation({
          storage: this.ctx.storage,
          hostActorPrefix: this.plain.hostActorPrefix,
          handle: this.handle,
          operation: body.operation,
          args: body.arguments,
          identity,
          // The edit's writer keeps what the client said about itself. The
          // labels stay out of the fingerprint: a retry under the same nonce
          // replays the first attempt and keeps its writer.
          writerAgent: agentFromProvenance(identity.clientProvenance),
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
                // Each view node names a view this Page holds.
                for (const viewId of insertedViews(inserts))
                  if (this.viewDoc(viewId)?.revision === undefined)
                    throw new HttpError(
                      400,
                      `No view "${viewId}" on this Page. Create it with set_view, then insert its node.`,
                      "unknown_view",
                    );
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
              if (body.operation === "edit_page") {
                try {
                  caret = writeTargets(doc, trace);
                } catch (error) {
                  logFailure(error, "agent-presence");
                }
              }
              return result;
            } catch (error) {
              // The batch cannot apply as written: zero or multiple matches, or
              // an unknown block, operation or mark (400). An edit to a node
              // this build can't read is refused with 409 (newer_content), as
              // a target-scoped edit does.
              const status = error.code === "newer_content" ? 409 : 400;
              throw Object.assign(
                new HttpError(status, error.message, error.code ?? "invalid_edit_selector"),
                error.details && { details: error.details },
              );
            }
          },
          flush: () => this.flush(),
          onHeads: (heads) => (applied = heads),
        });
        this.cacheTitle();
        this.handle.broadcast({
          kind: "tool-edit",
          identity: {
            ...publicIdentity(identity),
            ...(identity.agent && { agent: identity.agent }),
            ...(identity.session && { session: identity.session }),
          },
          heads: applied,
        });
        if (caret)
          this.publishAgentPresence(identity, "write", () =>
            caret.map((target) =>
              target.kind === "block" ? target : { ...target, heads: applied },
            ),
          );
        return json(receipt);
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (!admissionRoute) return errorResponse(await this.agentRefusal(error), "page");
      if ((error.status ?? 500) >= 500) logFailure(error, "page");
      return admissionErrorResponse(error, { stage: "page", identity });
    } finally {
      // Still live: a change this request made (a tool edit, a save that
      // waited for a peer's heads) was observed by now, and its flush runs
      // on this request's hold.
      this.contentActivity?.pump();
      flushUsage(this.env, this.ctx);
    }
  }

  /**
   * A creation that names an owner other than its caller: a Project member
   * adding a Page to a Project another account owns (project-create.mjs).
   * The owner's Catalog vouches for it only while it holds the Page's
   * pending entry with this caller as creator, which it reserves after
   * deciding create_items for the caller. A forged owner, a Page reserved
   * for someone else, or a finished creation is refused.
   */
  async requireDelegatedCreation(owner, pageId, identity) {
    if (typeof owner !== "string" || !owner) throw new HttpError(400, "Invalid owner");
    const response = await this.env.CATALOGS.getByName(owner).fetch(
      new Request("https://pages.internal/internal/location", {
        method: "POST",
        body: JSON.stringify({ creation_of: pageId }),
      }),
    );
    if (!response.ok) throw new HttpError(403, "Document access denied");
    const creation = await response.json();
    if (creation?.page_id !== pageId || creation.creator !== identity.principal)
      throw new HttpError(403, "Document access denied");
    return creation;
  }

  /** The create_page receipt as an agent reads it: the created revision as a
   * handle, so the first edit needs no read. The stored receipt keeps its
   * heads beside the handle minted with the creation intent; every reply,
   * and the owner's Catalog journal, names that handle. */
  async createdReply({ heads, revision, ...receipt }) {
    return {
      ...receipt,
      revision: revision ?? (await this.revisionTable().handle(PAGE_DOC, heads)),
    };
  }

  /** This Page's revision handles, as the agent-edge reads use them:
   * `handles([[doc, heads], ...])` names revisions, minting in one put when
   * needed, `handle(doc, heads)` names one, and `heads(doc, handle, name)`
   * resolves one. Runs in the Page's queue. */
  revisionTable() {
    const storage = this.ctx.storage;
    const handles = (requests) => readRevisions(storage, requests);
    return {
      handles,
      handle: async (doc, heads) => (await handles([[doc, heads]]))[0],
      heads: (doc, handle, name) => headsFor(storage, doc, handle, name),
    };
  }

  /** `error` as an agent receives it. A revision refusal (stale_revision,
   * edit_conflict, resync_required) carries the live Page heads in
   * `details.current_heads`; they become `current_revision`, beside the
   * comments document's `comment_revision`, so the caller holds both
   * baselines without a read. Heads never leave the host: if a handle can't
   * be minted, the refusal goes without one. Other errors pass through. */
  async agentRefusal(error) {
    if (
      !["stale_revision", "edit_conflict", "resync_required"].includes(error?.code) ||
      !error.details ||
      typeof error.details !== "object"
    )
      return error;
    const { current_heads, comment_heads: _comments, ...details } = error.details;
    try {
      const comments = this.commentsView();
      const [current_revision, comment_revision] = Array.isArray(current_heads)
        ? await this.revisionTable().handles([
            [PAGE_DOC, current_heads],
            ...(comments ? [[COMMENTS_DOC, A.getHeads(comments)]] : []),
          ])
        : [];
      error.details = {
        ...details,
        ...(current_revision && { current_revision }),
        ...(comment_revision && { comment_revision }),
      };
    } catch (failure) {
      logFailure(failure, "page-revision");
      error.details = details;
    }
    return error;
  }

  /**
   * The validated change of one update_page_tags call: `{ add, remove }`,
   * normalized sets that don't overlap. Pure, so it runs in the Page's queue.
   */
  tagChange(args = {}) {
    const add = tagList(args.add, "add");
    const remove = tagList(args.remove, "remove");
    if (!add.length && !remove.length)
      throw new HttpError(
        400,
        "update_page_tags needs a tag to add or remove",
        "invalid_arguments",
      );
    if (add.some((tag) => remove.includes(tag)))
      throw new HttpError(400, "A tag can't be in both add and remove", "invalid_arguments");
    return { add, remove };
  }

  /**
   * One update_page_tags call, after the queue has released it. The caller has
   * edit access and the Page was not in Trash when the queue admitted it. The
   * Page host only authorizes the call; it keeps no tag state, and no Durable
   * Object does. Tags are rows in the D1 `page_tags` table, the only record of
   * them (page-tags-store.mjs), and never part of the document: this changes
   * neither the Page's content nor its revision. `add` and `remove` are sets,
   * so a repeat changes nothing and needs no receipt. A Trash or purge between
   * the admission and the write is fenced in D1 (writePageTags); a timeout
   * answers `tags_unavailable`, which doesn't say whether the write landed, and
   * the same call is safe to repeat.
   */
  async updateTags(identity, pageId, { add, remove }) {
    const db = await pageTagsDatabase(this.env, this.ctx);
    try {
      const tags = await writePageTags(db, {
        pageId,
        principal: identity.principal,
        add,
        remove,
        now: new Date().toISOString(),
      });
      return { page_id: pageId, tags };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      logFailure(error, "page-tags");
      throw tagsUnavailable();
    }
  }

  /**
   * One manage_page_comment or reply_page_comment call, written to the
   * comments document. It needs `comment`, never `edit`, and never changes
   * the Page document. The receipt's `comment_revision` names the comments
   * document after the write, and `revision` the Page revision it was based
   * on, journaled with it: a browser edit landing meanwhile stays after it,
   * so read_page_changes from it still returns that edit, and an exact retry
   * returns the same handles. Only a comment on selected text names a Page
   * `revision` in its request, to find the text.
   */
  async writeComment(request, identity, body) {
    this.policy.account(identity, "comment");
    this.commentsView();
    const role = this.policy.account(identity).role;
    const operation = body.operation;
    const args = body.arguments ?? {};
    // A new message keeps what the client said about itself; an edit, resolve
    // or delete stores none, so a changed label never conflicts with one.
    const creates =
      operation === "reply_page_comment" || ["add", "reply"].includes(args.action ?? "add");
    const agent = creates ? agentFromProvenance(identity.clientProvenance) : undefined;
    // The Page snapshot a new comment anchors in. The guard captures it and
    // the edit uses it, with no await between them.
    let page;
    let applied;
    const receipt = await documentMutation({
      storage: this.ctx.storage,
      hostActorPrefix: this.plain.hostActorPrefix,
      handle: this.commentsHandle,
      doc: COMMENTS_DOC,
      pageId: this.metadata.pageId,
      operation,
      args,
      identity,
      agent,
      baseRevision: (input) => (passageComment(operation, input) ? input.revision : undefined),
      // Receipts carry no image prerequisites; this only re-checks access
      // after the journal inspection awaited storage.
      prepare: async () => {
        this.policy.account(await authenticate(request, this.env), "comment");
      },
      guard: (input, baseHeads) => {
        page = this.handle.doc();
        // The Page's stamp gates both documents, as SyncHost's gate does. A
        // recorded receipt still replays; this runs for new intents only.
        requireSupportedSchema(page);
        return guardCommentIntent(page, operation, input, baseHeads);
      },
      // The Page revision this write read, journaled with its receipt.
      receiptFields: async (plan) => ({ revision: await plan.handle(PAGE_DOC, A.getHeads(page)) }),
      onHeads: (heads) => (applied = heads),
      pageHeads: () => A.getHeads(this.handle.doc()),
      apply: (draft, effectiveArgs) => {
        try {
          return applyComment(
            draft,
            operation === "reply_page_comment"
              ? { ...effectiveArgs, action: "reply" }
              : effectiveArgs,
            publicIdentity(identity),
            undefined,
            { page, role, agent },
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
    this.commentsHandle.broadcast({
      kind: "tool-edit",
      identity: {
        ...publicIdentity(identity),
        ...(identity.agent && { agent: identity.agent }),
        ...(identity.session && { session: identity.session }),
      },
      heads: applied,
      comments: true,
    });
    return receipt;
  }

  /**
   * One edit_page batch of set_source operations, written to the sources
   * document (model/sources-doc.mjs) through the journal. The caller holds
   * edit access. The request names the Page `revision` it read, fenced like
   * any edit_page write, but a source write never conflicts with a Page
   * change: a Page revision that isn't current still writes. Each operation
   * names the source revision its caller saw instead.
   *
   * A journaled source write whose apply didn't finish (its barrier failed)
   * is replayed first, so a new write checks source revisions against every
   * write that has a receipt. For a new intent, `prepare` checks the batch
   * against the sources the Page holds (none before its document exists),
   * checks that every named asset is a dataset stored on this Page, takes its
   * media type from the stored record, and only then creates the sources
   * document when the Page has none (sources-lifecycle.mjs), so a refused
   * write creates nothing. Until then the journal reads the fixed genesis.
   * The receipt's `sources_revision` names the sources document after the
   * write; an exact retry replays it.
   */
  async writeSources(request, identity, body) {
    const args = body.arguments ?? {};
    const mediaTypes = new Map();
    // Stored on the source as its writer's agent, so the retry fingerprint
    // covers it, as a comment's does.
    const agent = agentFromProvenance(identity.clientProvenance);
    await this.sourcesDocumentId();
    if (this.sourcesView() && this.pageEditable())
      await recoverDocumentMutations(
        this.ctx.storage,
        this.sourcesHandle,
        () => this.flush(),
        SOURCES_DOC,
      );
    let genesis;
    const handle = {
      doc: () =>
        this.sourcesView() ?? (genesis ??= SOURCES_MODULE.derived.genesis(this.sourcesUuid)),
      update: (fn, options) => this.sourcesHandle.update(fn, options),
    };
    try {
      const receipt = await documentMutation({
        storage: this.ctx.storage,
        hostActorPrefix: this.plain.hostActorPrefix,
        handle,
        doc: SOURCES_DOC,
        // edit_page's nonces share one lane, whichever document a batch writes.
        lane: PAGE_DOC,
        pageId: this.metadata.pageId,
        operation: body.operation,
        args,
        identity,
        agent,
        // The Page's stamp gates every document of the Page, as SyncHost's
        // gate does, so it is checked before the intent is journaled. A
        // recorded receipt still replays.
        guard: (input) => {
          requireSupportedSchema(this.handle.doc());
          return input;
        },
        schemaDoc: () => this.handle.doc(),
        pageHeads: () => A.getHeads(this.handle.doc()),
        prepare: async () => {
          let assetIds;
          try {
            assetIds = validateSourceBatch(args.operations);
            checkSources(handle.doc(), args.operations);
          } catch (error) {
            throw sourceRefusal(error);
          }
          for (const assetId of assetIds) {
            const dataset = await requireStoredDatasetAsset(this.env.PAGES_ASSETS, {
              pageId: this.metadata.pageId,
              assetId,
            });
            mediaTypes.set(assetId, dataset.mime_type);
          }
          // Access can change while the asset records are read.
          this.policy.account(await authenticate(request, this.env), true);
          await this.sourcesEvent({ type: "create", recorded: recordNamesSources(this.metadata) });
        },
        apply: (draft, effectiveArgs) => {
          try {
            return {
              edits: setSources(draft, effectiveArgs.operations, {
                mediaTypes,
                by: authorOf(publicIdentity(identity), agent),
              }),
            };
          } catch (error) {
            throw sourceRefusal(error);
          }
        },
        flush: () => this.flush(),
      });
      // Summarize each named dataset now, so the first read of the source
      // finds its summary stored. A replayed receipt names no new asset.
      for (const [assetId, mediaType] of mediaTypes)
        if (mediaType === PARQUET_MEDIA_TYPE) this.ctx.waitUntil(this.datasetSummary(assetId));
      return receipt;
    } finally {
      if (genesis) A.free(genesis);
    }
  }

  /** The pre-slot checks of set_view `op`, then its view slot: the Page's
   * stamp, the operation against the view as it stands, the cap, room in
   * the journal and the caller's access, then the view's document (created
   * when the Page has none under this id). Every refusal known in advance
   * comes before the slot is taken, so a write that fails after it fails
   * from I/O or a crash; its slot stays, unlisted until a write lands, and
   * the next boot releases it if none does. Returns false, having taken
   * nothing, when it first finished a release a boot or an earlier write
   * left unfinished: the caller runs it again, since the release awaited
   * storage. */
  async takeViewSlot(request, identity, op, args, handle) {
    const viewId = op.view_id;
    requireSupportedSchema(this.handle.doc());
    try {
      checkView(handle.doc(), op, { sourcesDoc: this.sourcesView() });
    } catch (error) {
      throw viewRefusal(error);
    }
    return this.viewSlot(async () => {
      const listed = await this.storedViewIds();
      if (!listed.includes(viewId) && listed.length >= MAX_VIEWS)
        throw Object.assign(
          new HttpError(
            400,
            `A Page holds up to ${MAX_VIEWS} views, and this one holds ${listed.join(", ")}. Rewrite one of them with set_view and its view_revision.`,
            "view_limit",
          ),
          { details: { view_ids: listed } },
        );
      // The journal's own check stays the check of record; this one is
      // generous, so it refuses before the slot.
      await requireJournalRoom(this.ctx.storage, {
        bytes: 2 * operationEntryBytes("", args) + 4096,
      });
      // Access can change while the view list is read. The credential is the
      // request's own, so it names the principal the write is attributed to,
      // or the write is refused.
      const current = await authenticate(request, this.env);
      if (current.principal !== identity.principal)
        throw new HttpError(403, "Document access denied");
      this.policy.account(current, true);
      const entry = await this.viewEntry(viewId);
      try {
        // Until a release a boot or an earlier write left unfinished ends,
        // the id takes no write.
        if (entry.state.name === "releasing") {
          try {
            await this.viewEvent(viewId, { type: "release" });
          } catch (error) {
            logFailure(error, "view-release");
            throw new HttpError(
              503,
              `The view "${viewId}" is still being cleared after a failed write. Try again shortly.`,
              "view_unavailable",
            );
          }
          return false;
        }
        await this.viewEvent(viewId, { type: "create", recorded: listed.includes(viewId) });
        return true;
      } finally {
        this.forgetIdleView(viewId);
      }
    });
  }

  /**
   * One edit_page set_view: the view's document (model/view-doc.mjs),
   * written through the journal. The caller holds edit access. Like a source
   * write, it names the Page `revision` it read, fenced like any edit_page
   * write, and never conflicts with a Page change; the operation's
   * `view_revision` is the revision it checks instead.
   *
   * A journaled write to this view whose apply didn't finish is replayed
   * first. For a new intent, `prepare` checks the operation, its spec
   * (shared/view-spec.mjs) and its bindings against the Page's sources,
   * then, in the slot queue, the view cap and the caller's access, and only
   * then creates the view's document when the Page has none under this id
   * (view-lifecycle.mjs). Until then the journal reads the fixed genesis
   * and the host holds no entry for the view. The journal's room is checked
   * before the slot too, so a write that fails after it fails from I/O or a
   * crash: its slot stays unlisted until a write lands, and the next boot
   * releases it if none does. A view whose key names a format this build
   * doesn't write is refused first. The receipt's `view_revision` is the
   * view's revision after the write; an exact retry replays it.
   */
  async writeView(request, identity, body) {
    const args = body.arguments ?? {};
    const op = args.operations[0];
    // The view id names the document, so it is checked before anything
    // else; the rest is checked in `prepare`, against the stored view.
    try {
      if (!validViewId(op?.view_id)) validateViewOperation(op);
    } catch (error) {
      throw viewRefusal(error);
    }
    const viewId = op.view_id;
    const doc = keyedDoc(VIEW_MODULE, viewId);
    const unsupported = await this.viewFormatRefusal(viewId);
    if (unsupported) throw unsupported;
    // Stored as the view's producer, so the retry fingerprint covers it, as
    // a source's does.
    const agent = agentFromProvenance(identity.clientProvenance);
    const uuid = this.views?.get(viewId)?.uuid ?? (await viewDocUuid(this.metadata.pageId, viewId));
    if (this.viewDoc(viewId) && this.pageEditable())
      await recoverDocumentMutations(
        this.ctx.storage,
        this.views.get(viewId).handle,
        () => this.flush(),
        doc,
      );
    let genesis;
    let viewRevision;
    const handle = {
      doc: () => this.viewDoc(viewId) ?? (genesis ??= VIEW_MODULE.derived.genesis(uuid)),
      update: (fn, options) => this.views.get(viewId).handle.update(fn, options),
    };
    try {
      return await documentMutation({
        storage: this.ctx.storage,
        hostActorPrefix: this.plain.hostActorPrefix,
        handle,
        doc,
        // edit_page's nonces share one lane, whichever document a batch writes.
        lane: PAGE_DOC,
        pageId: this.metadata.pageId,
        operation: body.operation,
        args,
        identity,
        agent,
        // The Page's stamp gates every document of the Page, as SyncHost's
        // gate does, so it is checked before the intent is journaled. A
        // recorded receipt still replays.
        guard: (input) => {
          requireSupportedSchema(this.handle.doc());
          return input;
        },
        schemaDoc: () => this.handle.doc(),
        pageHeads: () => A.getHeads(this.handle.doc()),
        prepare: async () => {
          // A release this write finishes first awaits storage, so every
          // check runs again after it, from the top. A release only runs
          // from `releasing`, so the second pass takes the slot or refuses.
          while (!(await this.takeViewSlot(request, identity, op, args, handle)));
        },
        apply: (draft, effectiveArgs) => {
          try {
            const edit = setView(draft, effectiveArgs.operations[0], {
              sourcesDoc: this.sourcesView(),
              by: authorOf(publicIdentity(identity), agent),
            });
            viewRevision = edit.view_revision;
            return { edits: [edit] };
          } catch (error) {
            throw viewRefusal(error);
          }
        },
        receiptFields: async () => ({ view_revision: viewRevision }),
        flush: () => this.flush(),
      });
    } finally {
      if (genesis) A.free(genesis);
    }
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
  hiddenRefusal(identity, admissionRoute, metadata = this.metadata) {
    if (metadata && !this.hiddenWhileTrashed(identity, metadata)) return undefined;
    // Admission routes answer a missing Page exactly as an unreadable one.
    if (admissionRoute) return withAdmissionReason(new PermissionDenied(), "page_not_found");
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
      ...(state !== "deleted" &&
        (this.handle || this.pageTitle() !== undefined) && {
          title: catalogTitle(this.pageTitle()),
        }),
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
      const key = await operationKey(args, identity, "lifecycle");
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
    // A comments guard compares against the loaded comments document, which
    // a record in a format this build doesn't write never opens.
    if (type === "trash" && Array.isArray(args.base_comment_heads) && !this.formatRefusal())
      await this.loadComments();
    // A caller's trash may name a revision handle, resolved here through the
    // same fence as an edit, before the head guard: a malformed one is
    // invalid, and one that is unknown, pruned, or minted at or before the
    // receipt horizon needs a fresh read. A browser session names the heads it
    // shows instead (BROWSER_TRASH_GUARD; the gateway refuses them from any
    // other credential), never both. delete_project's own trash sends heads
    // with base_comment_heads.
    let callerHeads;
    if (type === "trash" && args.base_comment_heads === undefined && args.base_heads !== undefined)
      callerHeads = args.revision === undefined ? args.base_heads : "invalid";
    else if (
      type === "trash" &&
      args.base_comment_heads === undefined &&
      args.revision !== undefined
    )
      try {
        const { horizon } = await revisionClock(this.ctx.storage);
        callerHeads = await fencedHeads(this.ctx.storage, PAGE_DOC, args.revision, horizon);
      } catch (error) {
        if (error.code === "invalid_revision") callerHeads = "invalid";
        else if (error.code === "resync_required") callerHeads = "unknown";
        else throw error;
      }
    const callerCheck = (doc) =>
      callerHeads === "invalid"
        ? "invalid"
        : callerHeads === "unknown"
          ? "unknown"
          : headsCheck(doc, callerHeads);
    let state = this.lifecycleState();
    if (
      type === "purgeConfirm" &&
      event.key === "fresh" &&
      state.name === "trashed" &&
      !isSuperseded(state, event)
    ) {
      const verified = this.metadata;
      // Null for a Page whose documents this host doesn't open.
      const doc = this.handle?.doc() ?? null;
      event.preview = await checkPurgePreview(
        this.ctx.storage,
        verified,
        doc,
        identity.principal,
        args.preview_token,
      );
      // Verification awaited crypto and storage. Recheck the live document and
      // record in the same synchronous step that tombstones the Page. While
      // trashed the policy refuses every sync write, so this only catches a
      // change accepted before Trash that applied late.
      if (
        event.preview === "valid" &&
        (this.metadata !== verified ||
          (doc && !sameHeads(A.getHeads(this.handle.doc()), A.getHeads(doc))))
      )
        event.preview = "changed";
      state = this.lifecycleState();
    }
    // No await from the head guard to the policy-visible record.
    if (type === "trash") {
      const unopened = Boolean(this.formatRefusal());
      // A caller's trash: a Page whose documents this host doesn't open has
      // no revision to match, so a trash without one proceeds and one with
      // it is invalid. delete_project's own trash sends base_comment_heads,
      // null when the deletion read a record whose documents this host
      // doesn't open; it applies only while the host still opens exactly
      // what the deletion read, at those heads.
      const checks =
        args.base_comment_heads === undefined
          ? [
              this.handle
                ? callerCheck(this.handle.doc())
                : unopened && callerHeads === undefined
                  ? "absent"
                  : "invalid",
            ]
          : (args.base_comment_heads === null) !== unopened
            ? ["mismatch"]
            : unopened
              ? ["absent"]
              : [
                  this.handle ? headsCheck(this.handle.doc(), args.base_heads) : "invalid",
                  commentHeadsCheck(this.commentsHandle?.doc(), args.base_comment_heads),
                ];
      event.heads = checks.includes("invalid")
        ? "invalid"
        : checks.includes("mismatch")
          ? "mismatch"
          : checks[0];
    }
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
        title: catalogTitle(this.pageTitle()),
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
      const title = catalogTitle(this.pageTitle());
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
        } else this.metadata = pending.metadata;
        return;
      case "refreshAccess":
        this.plain.refresh();
        this.activity?.prune();
        return;
      case "projectTitle":
        // A restore is a lifecycle observation: listings move it now.
        this.cacheTitle(undefined, { observe: true });
        return;
      case "retireIndex":
        await this.retireIndex();
        return;
      case "closePolicy":
        this.contentActivity?.stop();
        this.pageCard?.stop();
        this.unwatchContent();
        this.activity?.close();
        this.plain.disconnectAll();
        return;
      case "deleteDocument": {
        await this.forgetContent();
        // Every document goes together: the Page, its comments, its sources
        // and its views. From metadata and the view list, not loaded
        // handles: a deleted Page boots without them.
        const sourcesId =
          (recordNamesSources(this.metadata) || this.sourcesHandle) &&
          (await this.sourcesDocumentId());
        // Every listed view, and any served whose record step didn't finish.
        const viewIds = new Set([
          ...(await this.storedViewIds()),
          ...this.servedViews().map(([viewId]) => viewId),
        ]);
        const viewDocumentIds = [];
        for (const viewId of viewIds)
          viewDocumentIds.push(
            derivedDocumentId(
              this.views?.get(viewId)?.uuid ?? (await viewDocUuid(this.metadata.pageId, viewId)),
            ),
          );
        await this.repo.delete(this.metadata.documentId);
        if (this.commentsUuid) await this.repo.delete(commentsDocumentId(this.commentsUuid));
        if (sourcesId) await this.repo.delete(sourcesId);
        for (const documentId of viewDocumentIds) await this.repo.delete(documentId);
        this.dropSources();
        this.dropViews();
        // Before the asset prefix goes, so no summary lands after it.
        this.datasetSummariesClosed = true;
        this.datasetSummaries?.close();
        await this.deleteAssets();
        await this.plain.forget(
          [
            this.metadata.documentId,
            this.commentsUuid && commentsDocumentId(this.commentsUuid),
            sourcesId,
            ...viewDocumentIds,
          ].filter(Boolean),
        );
        // After the documents: a restart that still finds the list repeats
        // the deletes above.
        await clearPrefixes(this.ctx.storage, [VIEW_KEY_PREFIX]);
        if (this.metadata.recordStorageMigratedFrom) await this.purgeConvertedRecords();
        return;
      }
      case "flush":
        // A deleted document has nothing left to flush; the barrier stays.
        await this.plain.flush(pageState(this.metadata) === "deleted" ? [] : this.documentIds());
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
        this.dropSources();
        this.dropViews();
        return;
      case "loadDocument":
        await this.loadDocument();
        return;
      case "importDocument":
        // An intent whose record names formats this build doesn't write
        // imports nothing: its record installs and the host refuses it.
        if (!recordFormatsWritten(context.intent.metadata)) return;
        // A replayed creation may find the document stored already.
        this.plain.serve(context.intent.metadata.documentId, PAGE_MODULE.kind);
        this.handle = await this.repo.import(context.intent.bytes, {
          docId: context.intent.metadata.documentId,
        });
        await this.loadComments();
        await this.watchContent();
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
      const error = new HttpError(response.status, response.error, response.code);
      // A trash refused for a stale or unknown revision names the live one, as
      // an edit refusal does.
      if (["stale_revision", "resync_required"].includes(response.code) && this.handle)
        error.details = { current_heads: A.getHeads(this.handle.doc()) };
      const reply = errorResponse(await this.agentRefusal(error), "page-lifecycle");
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
        // A Page whose documents this host doesn't open is described from
        // its record and the title it last projected. The preview_token
        // binds the content it describes; the preview names no revision.
        const doc = this.handle?.doc() ?? null;
        return json({
          page_id: this.metadata.pageId,
          ...publicTrash(this.metadata),
          ...(doc
            ? purgeImpact(this.metadata, doc, this.commentsView())
            : purgeImpact(this.metadata, null, undefined, this.pageTitle())),
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
   * multi-key write. Receipts are bounded: the Catalog's expected revision
   * keeps an old request from applying again. A receipt is stamped with the
   * journal time, and pruning raises the receipt horizon to the newest
   * pruned stamp first, so a trash that names a revision handle meets the
   * same fence as an edit once its receipt is gone.
   */
  async commitLifecycle(key, record, metadata) {
    const storage = this.ctx.storage;
    await storage.put({
      [lifecycleReceiptKey(key)]: { ...record, at: await journalTime(storage) },
      ...(metadata && { "host/document": metadata }),
    });
    const records = await storage.list({ prefix: "host/lifecycle/" });
    if (records.size <= LIFECYCLE_RECEIPT_LIMIT) return;
    const oldest = [...records]
      .sort(([, a], [, b]) => a.at - b.at)
      .slice(0, records.size - LIFECYCLE_RECEIPT_LIMIT);
    await raiseHorizon(storage, Math.max(...oldest.map(([, value]) => value.at ?? 0)));
    for (const [name] of oldest) await storage.delete(name);
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
      requireNonce(args);
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
          throw new HttpError(
            409,
            "Page already has another creation request",
            "creation_conflict",
          );
      } else {
        const { doc, bytes } = readRegistration(args);
        try {
          // The Page's comments and sources documents derive their ids from
          // the Page id. A draft under one of those ids would be served
          // under two kinds, and its initialization would fail on every
          // boot, so it is refused before the intent is stored. A view's id
          // is open-ended; the view write refuses that collision itself.
          const derived = [
            commentsDocumentId(await commentsDocUuid(args.page_id)),
            derivedDocumentId(await derivedDocUuid(SOURCES_MODULE.derived.label, args.page_id)),
          ];
          if (derived.some((id) => treeOf(id) === treeOf(args.document_id)))
            throw new HttpError(
              409,
              "This document_id is one the Page derives for its own comments or sources. Register the draft under a new document id.",
              "document_conflict",
            );
          const metadata = {
            recordStorage: "automerge",
            pageId: args.page_id,
            owner: identity.principal,
            ownerName: identity.displayName,
            documentId: args.document_id,
            comments_doc: await commentsDocUuid(args.page_id),
            // readRegistration admitted the draft in the format this build writes.
            documentFormats: { ...MEMBER_FORMATS },
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
   * heads are missing and that build lacks a stamped id, the schema gate has
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
    // A record in a format this build doesn't write serves no document.
    const unopened = this.formatRefusal();
    if (unopened) return refuseSocket(unopened, identity);
    const epochs = new URL(request.url).searchParams.getAll("activity_epoch");
    if (epochs.length) {
      if (
        epochs.length !== 1 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(epochs[0])
      )
        throw new HttpError(400, "Invalid activity_epoch");
      // Discovery and the socket must refer to the same resident host.
      // Reject before allocating a socket so the browser rediscovers after a
      // restart instead of permanently rejecting the new host's snapshots.
      if (epochs[0] !== this.activityState().epoch)
        throw withAdmissionReason(
          new HttpError(409, "Page activity session changed; reconnect"),
          "activity_epoch_changed",
        );
    }
    // The build's schema features, for SyncHost's schema gate. A viewer from
    // before the stamp sends none: the baseline.
    const declared = new URL(request.url).searchParams.getAll("schema_features");
    const features = declared.length > 1 ? null : parseDeclaredFeatures(declared[0]);
    if (!features) throw new HttpError(400, "Invalid schema_features");
    // The document formats the client reads, for requireReadableDocuments.
    const formats = new URL(request.url).searchParams.getAll("formats");
    const readable = formats.length > 1 ? null : parseDeclaredFormats(formats[0]);
    if (!readable) throw new HttpError(400, "Invalid formats");
    // A plain socket from a tab that already holds one replaces it, so the
    // stale socket's slot is free for this one.
    const sender = this.plain.sender(identity, new URL(request.url).searchParams.get("sender"));
    const capacity = this.connectionCapacity(identity, sender.replaces?.wire);
    if (capacity) return refuseSocket(capacity, identity);
    try {
      requirePlainSyncClient(request);
      requireReadableDocuments(readable, recordDocumentFormats(this.metadata));
    } catch (error) {
      return refuseSocket(error, identity);
    }
    return this.connectPlain(request, identity, features, sender, readable);
  }

  /** connect()'s socket. HTTP authentication already named the
   * principal; the socket speaks plain Automerge sync (sync/wire.mjs), and
   * PlainSync checks access on every frame. No handshake, no signing key.
   * `sender` is PlainSync.sender's decision for this socket's presence id, and
   * `formats` the document formats its client declared it reads. */
  connectPlain(request, identity, features, sender, formats) {
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
        formats,
        senderId: sender.senderId,
      });
    } catch (error) {
      logAdmissionDenied(error, { stage: "native", identity });
      logUsage(
        {
          action: "sync.open",
          ...syncUsage,
          admitted: false,
          outcome: admissionReason(error),
          latencyMs: 0,
        },
        this.env,
      );
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
                admissionCloseCode(leaseExpiryError(conn.identity, conn.expiresAt)),
                admissionCloseReason(leaseExpiryError(conn.identity, conn.expiresAt)),
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
    const usageSession = new UsageSession({
      ...syncUsage,
      owner: this.metadata.owner,
      env: this.env,
      ctx: this.ctx,
    });
    usageSession.event("admit");
    conn.transport.onClose(() => {
      usageSession.event("close");
      clearTimeout(expiry);
      clearInterval(renewal);
      this.wires.delete(wire);
      this.wirePrincipals.delete(wire);
      this.activity?.prune();
      this.broadcastProfiles();
      logUsage({ action: "sync.close", ...syncUsage, latencyMs: Date.now() - started }, this.env);
    });
    logUsage(
      {
        action: "sync.open",
        ...syncUsage,
        admitted: true,
        outcome: "ok",
        latencyMs: Date.now() - started,
      },
      this.env,
    );
    this.broadcastProfiles();
    this.broadcastActivity();
    this.broadcastActorSnapshot();
    this.ctx.waitUntil(
      Promise.all([
        disconnected,
        this.contentActivity?.serve(disconnected),
        usageSession.serve(disconnected),
      ]),
    );
    return new Response(null, { status: 101, webSocket: client });
  }
}
