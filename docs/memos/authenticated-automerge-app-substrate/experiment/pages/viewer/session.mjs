import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import {
  asapScheduler,
  asyncScheduler,
  filter,
  firstValueFrom,
  fromEventPattern,
  merge,
  observeOn,
  race,
  take,
  timer,
} from "rxjs";
import { Repo, documentIdToBinary } from "@automerge/automerge-repo";
import { SubductionBackend, IndexedDBByteStore } from "@automerge/automerge-repo-subduction";
import { applyComment, commentsMigrated, threadsOf } from "../model/comments.mjs";
import { createPageData, initializePage, projectPage } from "../model/page.mjs";
import { commentDraftsMarkdown, unsentCommentsMarkdown } from "../model/markdown-export.mjs";
import {
  BUILD_FEATURES,
  SCHEMA_GATE_INITIAL,
  schemaGateStep,
  stampFeatures,
} from "../model/schema-features.mjs";
import {
  decodeSnapshot,
  encodeSnapshot,
  readLocalPage,
  writeLocalPage,
  prepareLocalPageReload,
  listLocalRecoveries,
  retireLocalPage,
} from "./local-pages.mjs";
export { listLocalPages, retireLocalPage } from "./local-pages.mjs";
import { entryStanding } from "./local-catalog.mjs";
import { BACKEND_LIMITS } from "../model/limits.mjs";
import { retryKey } from "../model/retry-key.mjs";
import { MISSING_EDITS_MESSAGE } from "../shared/receipts.mjs";
import { ADMISSION_CAPABILITY, admissionCloseOutcome } from "../shared/admission.mjs";
import { isTransientFailure, request } from "./request.mjs";
import { requestConnect } from "./early-session.mjs";
import { SERVER_UNREACHABLE } from "./alerts.mjs";
import { monotonicNow } from "./monotonic.mjs";
import { activitySnapshot, presenceLabel } from "./activity.mjs";
import { checkpointRecords } from "./checkpoint-records.mjs";
import { guardSocketSend } from "./socket-send.mjs";
import { preservedBlockEdits } from "../model/raw-migration.mjs";
import { Store } from "./store.mjs";
import { OutboundSync } from "./outbound-sync.mjs";
import { REJECT, isLive, pauseOf, retirementOf, viewerSessionMachine } from "./session-machine.mjs";
import {
  OUTAGE_ATTEMPTS,
  OUTAGE_MS,
  backoffStep,
  reconnectDelay,
  viewerReconnectMachine,
} from "./reconnect-machine.mjs";
import { commentsOpenMachine } from "./comments-open-machine.mjs";
import { fullStatus, overlayStatus, viewerSyncStatusMachine } from "./sync-status-machine.mjs";
import {
  acknowledgedHeads,
  afterAcknowledgement,
  emptyLocalEdits,
  hasUnconfirmedLocalEdits,
  readLocalEdits,
  retireReplica,
  withActor,
} from "./local-edits.mjs";
export { request, tool } from "./request.mjs";
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const ownerAccess = () => ({
  role: "owner",
  revision: 0,
  generation: 0,
  canRead: true,
  canWrite: true,
  canComment: true,
  canManageAccess: true,
  canDelete: true,
});
/** The native replica for an access fact. A key's authority is fixed when the
 * host first admits it: writer (edits the Page and comments), commenter
 * (comments only) or reader. */
const replicaKey = (access, credentialCanWrite) =>
  `${access?.generation ?? 0}:${
    credentialCanWrite && access?.canWrite
      ? "writer"
      : credentialCanWrite && access?.canComment
        ? "commenter"
        : "reader"
  }`;
// A trashed Page previews on a reader replica. The host binds any key first
// admitted there as a reader, so restore reloads onto the writer replica and
// never promotes preview history.
const READER_REPLICA = ":reader";
const accessFailure = () =>
  Object.assign(Error("Page access changed; reload its current version"), {
    code: "PAGE_ACCESS_CHANGED",
    status: 409,
  });
const bytes = (value) => Uint8Array.from(value.match(/../g), (v) => parseInt(v, 16));
/** Which host refusal retires this account's local copy: `access` for
 * `page_access_denied` (access removed, or a Page missing to this account,
 * purged included), `deleted` for a 404 (`page_deleted`, or the legacy
 * missing-Page answer). Anything else, a transient failure included, leaves
 * the copy where it is. */
export function refusalOf(error) {
  const refusal = classifyRefusal(error);
  return refusal === "deleted" || refusal === "access" ? refusal : undefined;
}
/** One host refusal, classified once for every path that can see it:
 * discovery, reconnect, open and receipts.
 * - `deleted`: the Page is gone (404). markDeleted retires the copy.
 * - `access`: page_access_denied (access removed, or a Page missing to this
 *   account, purged included). revoke retires and hides the copy.
 * - `trash`: page_trashed. The Trash notice; the copy stays for restore.
 * - `denied`: any other 403. Paused; the copy stays, since the host didn't
 *   say why. A refused signing key is a native refusal, handled apart.
 * Anything else is not a refusal. `legacyMissing: false` reads only
 * `page_deleted` as a deletion, for routes where a bare 404 isn't one. */
export function classifyRefusal(error, { legacyMissing = true } = {}) {
  if (error?.status === 404)
    return legacyMissing || error.code === "page_deleted" ? "deleted" : undefined;
  if (error?.status !== 403) return undefined;
  if (error.code === "page_access_denied") return "access";
  if (error.code === "page_trashed") return "trash";
  if (error.code === "signing_key_rejected") return undefined;
  return "denied";
}
export const ACCESS_REVOKED = "You no longer have access to this Page.";
export const TRASHED_COPY =
  "This Page is in its owner's Trash. Your local copy is kept on this device.";
export const DENIED_COPY =
  "You no longer have access to this Page. Your local copy is kept on this device.";
export const PAGE_DELETED = "This Page was deleted.";
/** Stands in for the Markdown of a copy that couldn't be projected. */
export const MARKDOWN_UNAVAILABLE =
  "This copy couldn't be shown as Markdown. Its Automerge snapshots are in this download.";
/** One comment draft's identity, for merging drafts read at different times. */
const draftKey = (draft) =>
  JSON.stringify([draft.kind, draft.body, draft.quote ?? null, draft.thread_id ?? null]);
/** A document's heads, or undefined when it can't report them. */
const headsOf = (doc) => {
  try {
    return A.getHeads(doc);
  } catch {
    return undefined;
  }
};
/** A recovery record's raw copy, as it was archived. */
const recordBytes = (record) => ({
  snapshot: record.snapshot,
  ...(record.comments_snapshot && {
    comments_snapshot: record.comments_snapshot,
    ...(record.comments_document_id && { comments_document_id: record.comments_document_id }),
  }),
});
// Longer than the host's 10-second native admission deadline. A socket that
// closes sooner never proved admission, so it must not reset reconnect backoff,
// and an admission close code on it counts as a refusal.
export const STABLE_CONNECTION_MS = 15_000;
// A Page being left keeps syncing this long for its receipt before closing.
export const CLOSE_DRAIN_MS = 10_000;
// Status ids (STATUS_IDS in sync-status-machine.mjs) in which a Page being
// left may still save. These read ids, never labels.
const DRAINING_STATES = new Set(["connecting", "reconnecting", "syncing", "saving"]);
const STALLED_STATES = new Set(["unsaved", "offline", "saved-locally"]);
/** A status id as the reload gate reads it. */
export const saveStateOf = (id) =>
  id === "local-failed" ? "failed" : STALLED_STATES.has(id) ? "stalled" : "saving";
/** Settles once every promise has settled, then rejects with the first
 * failure. Later work never starts before earlier work finishes. */
const allSettledThen = (...promises) =>
  Promise.allSettled(promises).then((results) => {
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  });
/** Whether a Page being left may still save with this status id. */
export const drainingStatus = (id) => DRAINING_STATES.has(id);
const SIGNING_KEY_REFUSED =
  "This Page refused this tab's signing key. Your edits stay on this device. Retry, or open the Page in a new tab.";
const SYNC_PAUSED =
  "Sync paused: the host kept refusing this connection. Your edits stay on this device. Retry to reconnect.";
const admissionHeaders = { [ADMISSION_CAPABILITY.header]: ADMISSION_CAPABILITY.value };
// Receipt retries after a failure the host may fix (409 missing edits, 500).
const RECEIPT_RETRY_DELAYS = [500, 1000, 2000];
/** The wait before receipt retry `attempt`, or undefined once the retries are
 * spent. A transient failure retries on the reconnect backoff until the
 * failure that reports an outage, so a host restart never spends them. */
const receiptRetryDelay = (attempt, transient) =>
  transient
    ? attempt < OUTAGE_ATTEMPTS - 1
      ? backoffStep(attempt)
      : undefined
    : RECEIPT_RETRY_DELAYS[attempt];
// Not retryable by openPageWithRetry: the same tab key cannot succeed.
export const signingKeyRefused = (admission, cause) =>
  Object.assign(Error(SIGNING_KEY_REFUSED, cause === undefined ? undefined : { cause }), {
    code: "SIGNING_KEY_REFUSED",
    admission,
  });
/** `features` is this build's schema features. The host refuses native edits
 * from a tab whose build lacks an id the Page is stamped with; no parameter
 * means the baseline, as for builds from before the stamp. */
export function pageSyncAddress(pageId, href, activityEpoch, features = [], { converting } = {}) {
  const address = new URL(`/api/sync?page=${encodeURIComponent(pageId)}`, href);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  if (activityEpoch) address.searchParams.set("activity_epoch", activityEpoch);
  // Discovery reported the preserved-block conversion. If it finished before
  // this upgrade, the host refuses the socket so the tab rediscovers.
  if (converting) address.searchParams.set("converting", "1");
  if (features.length) address.searchParams.set("schema_features", [...features].sort().join(","));
  return address;
}
/** Shown when reopening set aside edits an older build made to a preserved
 * Markdown block (recoverPreservedBlockEdits). */
export const PRESERVED_EDITS_RECOVERED =
  "Edits this browser made with an older version of Pages changed a block Pages has since converted. They weren't synced, so the block isn't duplicated. Download them from the Page menu: Download previous local draft.";
/** `fresh` starts a new native replica instead of reopening this tab's. */
async function exclusiveIdentity(scope, { fresh = false } = {}) {
  const key = `pages-native:${scope}`;
  let seed =
    (!fresh && sessionStorage.getItem(key)) || hex(crypto.getRandomValues(new Uint8Array(32)));
  let release = () => {};
  if (navigator.locks) {
    for (;;) {
      let ready;
      const acquired = new Promise((resolve) => (ready = resolve));
      void navigator.locks.request(`pages-native:${seed}`, { ifAvailable: true }, (lock) => {
        ready(!!lock);
        if (lock) return new Promise((resolve) => (release = resolve));
      });
      if (await acquired) break;
      // Duplicated tabs inherit sessionStorage; give each backend exclusive
      // ownership rather than concurrently opening one database/signing key.
      seed = hex(crypto.getRandomValues(new Uint8Array(32)));
    }
  } else seed = hex(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(key, seed);
  return { seed, release, reloadRecovery: !!navigator.locks };
}
const ACTOR_ID = /^[0-9a-f]{1,128}$/;
const MAX_ACTOR_PROFILES = 1024;
const CHANGE_HASH = /^[0-9a-f]{64}$/;
const MAX_ATTESTED_CHANGES = 4096;
const plainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
/** A host actor profile, null for a removal, or undefined when malformed. */
function actorProfile(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const { principal, displayName, driver } = value;
  if (
    typeof principal !== "string" ||
    principal.length > 256 ||
    typeof displayName !== "string" ||
    displayName.length > 256 ||
    typeof driver !== "string" ||
    driver.length > 64
  )
    return undefined;
  return { principal, displayName, driver };
}
export class PageSession {
  listeners = new Set();
  draftSources = new Set();
  observers = new Set();
  presenceObservers = new Set();
  peers = new Map();
  agentProgress = new Map();
  agentPresence = new Map();
  activityEpoch = null;
  activityRevision = -1;
  presencePaused = false;
  profiles = {};
  actorNames = new Map();
  // Who made a change, by hash, from the host's tool-edit hints. The host
  // writes every API agent's edits, so a change hash, not an actor, names the
  // author.
  changeIdentities = new Map();
  // Who wrote a browser's changes, by Automerge actor, and which change
  // hashes the host read from their own signed commit records. A person is
  // named only for an attested hash whose actor has a profile. Only the
  // host's connect response and its actor-profiles messages fill these maps.
  actorProfiles = new Map();
  attestedChanges = new Map();
  toolHints = [];
  composing = 0;
  localDepth = 0;
  status = "Connecting";
  statusId = "connecting";
  // How `status` is drawn (STATUS_KEYS in sync-status-machine.mjs). Set only
  // with `status`, through showStatus.
  statusKey = "connecting";
  // The current status is a stalled receipt that Retry can move.
  statusRetry = false;
  problem = "";
  // Why the last connection attempt failed, when the person should see it.
  // It shows as `problem` unless a local save failure is in front of it.
  connectionProblem = "";
  // The last connection attempt failed transiently (isTransientFailure). The
  // status says Offline while retries continue; no banner until the reconnect
  // machine reports an outage. A connection admitted later clears it.
  unreachable = false;
  // When the current run of transient receipt failures began, on this.now's
  // monotonic clock, or null. It spans receipt revisions, so edits made during an outage don't
  // restart the quiet window; only a successful receipt ends the run.
  receiptOutageSince = null;
  savedHeads = [];
  // The comments document's heads the host last acknowledged.
  savedCommentHeads = [];
  authProblem = "";
  accessProblem = "";
  sockets = new Set();
  socketOutcomes = new WeakMap();
  socketAdmittedAt = new WeakMap();
  // Reasons edits are held while the session keeps syncing: the reload gate's
  // "reload" and the build floor's "protocol". They are not lifecycle phases.
  editPauses = new Set();
  /** The schema gate (schemaGateStep in model/schema-features.mjs):
   * `editable: false` when the Page is stamped with a feature this build
   * lacks, or the host refused this tab's edits for that reason. Content is
   * then read-only while sync continues; access and Trash actions are
   * unaffected. Stamps only grow, so it never reopens. */
  schemaGate = SCHEMA_GATE_INITIAL;
  /** The session's phase (see session-machine.mjs). Every lifecycle flag
   * below derives from it, and effects run from its transitions. */
  phase$ = new Store(viewerSessionMachine.initial);
  /** Automatic reconnects (see reconnect-machine.mjs): a deadline on each
   * socket's handshake, backoff, a refused signing key, or a pause after
   * repeated admission refusals. `retryTimer` is pending exactly while it is
   * `waiting`; `handshakeTimer` and `handshake` (the socket whose handshake
   * is pending, with the function that abandons it) exactly while it is
   * `handshaking`. */
  reconnect$ = new Store(viewerReconnectMachine.initial);
  // Opening the comments document (comments-open-machine.mjs).
  commentsOpen$ = new Store(commentsOpenMachine.initial);
  /** What the status line says about receipts and the connection (see
   * sync-status-machine.mjs). `status` renders it with the phase's pauses. */
  sync$ = new Store(viewerSyncStatusMachine.initial);
  // The close's work: checkpoint, release, and a late deletion's forget. It
  // can grow while it runs, so only closeSettled() waits on it.
  #closing;
  #released;
  /** Advances when this session's local copy stops being its own: a
   * retirement starts, or the replica is released or replaced. */
  #localEpoch = 0;
  /** A fence for one local write that spans awaits. The returned check
   * passes while the replica, its backend and its copy are still this
   * session's: no retirement, release or replacement since. */
  #localFence() {
    const epoch = this.#localEpoch;
    const backend = this.backend;
    return () => epoch === this.#localEpoch && backend === this.backend && !this.hidden;
  }
  /** Whether the stored entry still holds `grant`'s copy (entryStanding):
   * read now, after every earlier await. */
  async #storedStanding(grant) {
    const stored = await readLocalPage(this.identity, this.pageId, { markers: true }).catch(
      () => undefined,
    );
    return entryStanding(stored, grant);
  }
  #archiving;
  static async open(pageId, options) {
    const session = new PageSession(pageId, options);
    try {
      await session.start();
      return session;
    } catch (cause) {
      // close() invalidates the session immediately, but draining native I/O can
      // outlast a failed lookup. Surface the opening error while cleanup keeps
      // ownership of the replica and its identity lock until it has finished.
      // Automatic retries must await this drain rather than treating its held
      // lock as another tab and rotating the native signing/storage identity.
      const error = cause instanceof Error ? cause : Error(String(cause));
      error.cleanupPromise = session.close();
      void error.cleanupPromise.catch(() => {});
      throw error;
    }
  }
  static async create({ title = "Untitled" } = {}, options = {}) {
    const session = new PageSession(crypto.randomUUID(), options);
    try {
      await session.start({ title });
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  constructor(
    pageId,
    {
      refreshSession = () => request("/api/auth/session"),
      authentication,
      scheduler = asyncScheduler,
      random = Math.random,
      now = monotonicNow,
      buildFeatures = BUILD_FEATURES,
    } = {},
  ) {
    this.pageId = pageId;
    // The schema features this viewer can edit. Tests inject their own.
    this.buildFeatures = buildFeatures;
    this.refreshSession = refreshSession;
    this.authentication = authentication;
    this.scheduler = scheduler;
    this.random = random;
    // The monotonic clock (monotonic.mjs) every elapsed-time rule here reads:
    // receipt outages, reconnect stability, and presence and agent-progress
    // lifetimes. Readers of `peers` and `agentProgress` use it too.
    this.now = now;
    // When local edits and the caret go out (outbound-sync-machine.mjs): a
    // run of keystrokes shares one native sync round instead of one each.
    // Every backend this session opens schedules its local rounds here.
    this.outbound = new OutboundSync({
      scheduler,
      onError: (error) => {
        this.problem = error instanceof Error ? error.message : String(error);
        this.emit();
      },
    });
  }
  get doc() {
    return this.handle?.doc();
  }
  /** The Page's comments document (model/comments-doc.mjs), once open. */
  get commentsDoc() {
    return this.commentsHandle?.doc();
  }
  /** The comments document readers use: the Page's once its comments have
   * moved there (model/comments.mjs threadsOf). Before that the Page's own
   * legacy threads show, read-only. */
  get commentsView() {
    const doc = this.doc;
    return doc && commentsMigrated(doc) ? this.commentsDoc : undefined;
  }
  /** Every thread as stored, by id. A hidden Page shows none. */
  get commentThreads() {
    return this.hidden ? {} : threadsOf(this.doc, this.commentsView);
  }
  /** One stored message, for rich rendering, or undefined. */
  commentMessage(threadId, messageId) {
    const thread = Object.hasOwn(this.commentThreads, threadId)
      ? this.commentThreads[threadId]
      : undefined;
    return thread?.messages && Object.hasOwn(thread.messages, messageId)
      ? thread.messages[messageId]
      : undefined;
  }
  get alive() {
    return isLive(this.phase$.snapshot());
  }
  /** The Page is gone; its local copy is retiring or retired. */
  get deleted() {
    return retirementOf(this.phase$.snapshot()) === "deleted";
  }
  /** The host refused this account; its local copy is retiring or retired. */
  get revoked() {
    return retirementOf(this.phase$.snapshot()) === "access";
  }
  /** Deleted or revoked: nothing renders the local copy. */
  get hidden() {
    return retirementOf(this.phase$.snapshot()) !== undefined;
  }
  /** The recovery archive holds this tab's copy. */
  get recoveryArchived() {
    return this.phase$.snapshot().name === "retired";
  }
  /** The archive write failed: the copy is only in `closedRecovery`. */
  get retireFailed() {
    return this.phase$.snapshot().name === "retireFailed";
  }
  get authRequired() {
    return pauseOf(this.phase$.snapshot()).auth;
  }
  get accessDenied() {
    const phase = this.phase$.snapshot();
    // While opening, the cached access fact decides; a host answer pauses.
    if (phase.name === "opening") return this.access?.role === "none";
    if (retirementOf(phase) === "access") return true;
    const { access } = pauseOf(phase);
    return access === "access" || access === "trash";
  }
  /** A reload-required pause, or an archived replica whose replacement has
   * not installed yet: Reload current Page stays available to retry it. */
  get accessReloadRequired() {
    const phase = this.phase$.snapshot();
    return pauseOf(phase).access === "reload" || (phase.name === "closed" && !!phase.archived);
  }
  /** The receipt as the reload gate reads it: a failed local save blocks a
   * reload, a stalled save retries like the Retry button, anything else is
   * still saving. */
  get saveState() {
    return saveStateOf(this.statusId);
  }
  /** The host refused this tab's signing key; only an explicit attempt
   * retries. */
  get nativeRefused() {
    return this.reconnect$.snapshot().name === "refused";
  }
  /** Repeated admission refusals paused automatic reconnects. */
  get syncPaused() {
    return this.reconnect$.snapshot().name === "paused";
  }
  /** Retries scheduled since the last stable connection or resume. */
  get retryAttempts() {
    return this.reconnect$.snapshot().attempts;
  }
  /** An IndexedDB record holds every edit this replica accepted, so
   * reopening the Page imports it. An access reload wrote its own. */
  get checkpointWritten() {
    const phase = this.phase$.snapshot();
    return phase.name === "closed" && phase.checkpointWritten;
  }
  /** Step the phase machine. A rejected event changes nothing. Otherwise the
   * new phase is committed, `apply` updates what the effects and listeners
   * read, and the effects start in order. `done` settles with the last one. */
  dispatch(event, apply, context) {
    const before = this.phase$.snapshot();
    const result = viewerSessionMachine.step(before, event);
    if (result.rejected) return result;
    this.phase$.update(() => result.state);
    // A retirement ends every local write this replica had in flight.
    if (retirementOf(result.state) && !retirementOf(before)) this.#localEpoch++;
    apply?.();
    let done = Promise.resolve();
    for (const effect of result.effects) done = Promise.resolve(this.#perform(effect, context));
    done.catch(() => {});
    return { ...result, done };
  }
  #perform(effect, context) {
    switch (effect.type) {
      case "disconnect":
        void this.disconnectSockets();
        return undefined;
      case "persistLocal":
        // Recovery stays local, even when the host no longer permits publication.
        void this.persistLocal({ access: this.access, pending: this.recoveryPending }).catch(
          (error) => {
            // Another tab saw the host's refusal; this copy is archived too.
            if (error.code === "LOCAL_PAGE_REVOKED") return void this.revoke();
            this.localProblem = this.problem = error.message;
            this.emit();
          },
        );
        return undefined;
      case "drain":
        return this.drainBeforeClose();
      case "checkpoint":
        return this.#checkpoint();
      case "archive":
        return (this.#archiving = this.#archive());
      case "release":
        this.#released = this.#release();
        this.#closing ??= this.#released;
        return this.#released;
      case "reopen":
        // Opening can fail while offline. A retry reuses the prepared reset
        // marker without touching the released backend or archiving again.
        // It waits for the release step, assigned once per session, not the
        // whole close: leaving during an access reload makes the close wait
        // for this open. A failed release doesn't block the open or its retry.
        return Promise.allSettled([this.#released]).then(() =>
          PageSession.open(this.pageId, {
            authentication: { identity: this.identity, canWrite: this.credentialCanWrite },
            refreshSession: this.refreshSession,
            scheduler: this.scheduler,
            random: this.random,
            now: this.now,
          }),
        );
      case "retire": {
        const retiring = this.#retire();
        // The close covers the archive from the start, so a leave or a reload
        // waits for it. One already under way settles only once both have.
        this.#closing = this.#closing ? allSettledThen(this.#closing, retiring) : retiring;
        return retiring;
      }
      case "rekey":
        return this.#rekey(context);
    }
    throw new Error(`unknown effect ${effect.type}`);
  }
  #saved() {
    if (this.hidden) return true;
    try {
      return !this.recoveryPending;
    } catch {
      return false;
    }
  }
  /** The drain effect. Keep syncing while a Page being left may still save:
   * until its receipt, a pause or a non-saving receipt state, or
   * CLOSE_DRAIN_MS. Offline or failed states end the wait; the final
   * checkpoint keeps the edits. */
  drainBeforeClose() {
    const settled = () => {
      const phase = this.phase$.snapshot();
      if (phase.name !== "draining" || phase.reason) return true;
      return this.#saved() || !drainingStatus(this.statusId);
    };
    const changes$ = merge(
      this.phase$.state$,
      fromEventPattern(
        (handler) => this.subscribe(handler),
        (_, unsubscribe) => unsubscribe(),
      ),
    );
    // The drain ends after the change that settled it, never inside it: a
    // pause or receipt finishes its own update before the close begins.
    return new Promise((resolve) => {
      race(changes$.pipe(filter(settled)), timer(CLOSE_DRAIN_MS, this.scheduler))
        .pipe(take(1), observeOn(asapScheduler))
        .subscribe(() => resolve(this.#drained()));
    });
  }
  #drained() {
    if (this.phase$.snapshot().name !== "draining") return this.#whenReleased();
    return this.dispatch({ type: "drained", saved: this.#saved() }, () => this.#recordLeave()).done;
  }
  /** What the reload gate keeps if the final checkpoint fails, read while the
   * document is still live: at the end of the drain, or when a close skips
   * it. */
  #recordLeave() {
    const saved = this.#saved();
    this.leaveRecord = { saved };
    if (!saved)
      try {
        this.leaveRecord.title = this.doc?.title;
        this.leaveRecord.recovery = this.exportRecovery();
      } catch {}
  }
  /** Settles once the backend is released, whichever path closed it. */
  #whenReleased() {
    return firstValueFrom(
      this.phase$.state$.pipe(
        filter(
          (phase) =>
            phase.name === "closed" ||
            phase.name === "retired" ||
            (phase.name === "retireFailed" && !phase.held),
        ),
      ),
    ).then(() => this.#released);
  }
  #stop() {
    // Anything still waiting goes out before the backend is released; a
    // store after this point starts its round at once. A retiring session
    // disconnected before its archive, so its rounds reach no host.
    this.outbound.close();
    this.unwatchPageLifecycle();
    this.clearPresence();
    this.cancelReceiptRetry();
    clearTimeout(this.savedTimer);
    clearTimeout(this.slowSaveTimer);
    this.reconnect({ type: "halt" });
    clearInterval(this.presenceTimer);
    globalThis.removeEventListener?.("online", this.onlineListener);
  }
  async #checkpoint() {
    this.#stop();
    let written = false;
    let deleted = false;
    try {
      // skipCloseCheckpoint: the caller already keeps its own recovery record.
      if (this.skipCloseCheckpoint) written = true;
      else {
        await this.repo?.flush();
        // With no unconfirmed edit, nothing this replica's actors authored
        // can be unacknowledged, and they can't author again. Decide from
        // the document and the recorded acknowledgements, never from the
        // sync machine: a close can run before start() classified the
        // replica, for example when an open fails partway.
        let edits,
          retire = false;
        try {
          edits = this.handle ? this.localEditsWithActor() : undefined;
          retire = !!edits && !hasUnconfirmedLocalEdits(this.doc, edits);
        } catch {
          // Keeping every actor is always safe.
        }
        await this.persistLocal(
          {
            pending: this.statusId !== "saved",
            ...(retire && { localEdits: retireReplica(edits, this.replicaId) }),
          },
          { allowClosed: true },
        );
        written = !!this.localPage && !!this.handle;
      }
    } catch (error) {
      if (error.code === "LOCAL_PAGE_DELETED") deleted = true;
      // Both archived this replica's snapshot before refusing it.
      else if (error.code !== "LOCAL_PAGE_ACCESS_CHANGED" && error.code !== "LOCAL_PAGE_REVOKED") {
        this.problem = error.message;
        this.showStatus(overlayStatus("localFailed"));
      }
    }
    if (this.phase$.snapshot().name !== "checkpointing") return this.#whenReleased();
    const event = written ? { type: "checkpointOk" } : { type: "checkpointFail", deleted };
    return this.dispatch(event, () => {
      if (!deleted) return;
      this.canWrite = false;
      this.showStatus(overlayStatus("deleted"));
      this.problem = "This Page was deleted.";
    }).done;
  }
  /** Keep a separate account-scoped recovery record before retiring a key.
   * The replacement fetches server history; it never re-signs this draft. */
  async #archive() {
    const archiving = () => {
      const phase = this.phase$.snapshot();
      return phase.name === "checkpointing" && phase.archive === true;
    };
    try {
      await this.repo.flush();
      this.outbound.flush();
      await this.persistLocal({ pending: this.recoveryPending });
      await prepareLocalPageReload(
        this.identity,
        this.localPage,
        this.access,
        replicaKey(this.access, this.credentialCanWrite),
      );
      this.closedRecovery = this.exportRecovery();
    } catch (error) {
      if (archiving()) this.dispatch({ type: "checkpointFail", deleted: false });
      if (error.code === "LOCAL_PAGE_REVOKED") void this.revoke();
      throw error;
    }
    if (!archiving()) throw Error("Page closed");
    return this.dispatch({ type: "checkpointOk" }).done;
  }
  #release() {
    this.#stop();
    this.checkpointSnapshot = this.checkpointHeads = undefined;
    this.commentsCheckpointSnapshot = this.commentsCheckpointHeads = undefined;
    return this.releaseLocal();
  }
  /** Register a source of unsent comment drafts, which live only in the UI.
   * `read()` returns `{ kind, body, quote?, thread_id? }` entries; a
   * retirement reads every source before the UI resets. Returns a function
   * that removes the source. */
  watchCommentDrafts(read) {
    this.draftSources.add(read);
    return () => this.draftSources.delete(read);
  }
  /** The UI's comment drafts for a retirement, merged with every draft an
   * earlier attempt read, without duplicates. The first read happens before
   * the hidden Page resets the composer and unmounts the panel, so a retry
   * still carries drafts whose sources are gone. */
  #retirementDrafts() {
    const merged = [...(this.retiredDrafts ?? [])];
    const seen = new Set(merged.map(draftKey));
    for (const draft of this.#commentDrafts()) {
      const key = draftKey(draft);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(draft);
    }
    this.retiredDrafts = merged;
    return merged;
  }
  #commentDrafts() {
    const drafts = [];
    for (const read of this.draftSources)
      try {
        for (const draft of read() ?? [])
          if (typeof draft?.body === "string" && draft.body.trim())
            drafts.push({
              kind: draft.kind === "reply" ? "reply" : "comment",
              body: draft.body,
              ...(draft.quote && { quote: String(draft.quote) }),
              ...(draft.thread_id && { thread_id: String(draft.thread_id) }),
            });
      } catch {}
    return drafts;
  }
  /** The retire effect. Read the live replica and the UI's comment drafts
   * before anything releases or resets them, write them to the recovery
   * archive under this session's grant, then report the result. The release
   * follows unless a close already ran it. A failed archive keeps
   * `closedRecovery` for the notice and the reload gate, and leaves the
   * stored checkpoint as it was: the next open reaches the host, and another
   * refusal retires it again. A retry reuses `closedRecovery`. Resolves once
   * the release settles.
   *
   * Capturing the live copy is part of the retirement: if serializing either
   * document fails, nothing is archived, closed or released (#captureFailed),
   * and Try again captures again. */
  async #retire() {
    const { reason, released } = this.phase$.snapshot();
    let live = this.closedRecovery;
    if (!live) {
      try {
        live = this.#captureLive();
      } catch (error) {
        return this.#captureFailed(error, released);
      }
      if (live) this.closedRecovery = live;
    }
    this.unarchivedCopy = undefined;
    // Both documents are captured. A comments lookup still running would
    // only reopen what is being archived, so it stops here and its late
    // result never installs (comments-open-machine.mjs).
    this.commentsOpen({ type: "close" });
    let archived = false;
    try {
      await this.retireLocal(reason, live);
      archived = true;
      this.retireProblem = undefined;
    } catch (error) {
      this.retireProblem = error instanceof Error ? error.message : String(error);
    }
    if (this.phase$.snapshot().name !== "retiring") return this.#whenReleased();
    const { done } = this.dispatch({ type: archived ? "retireOk" : "retireFail" });
    this.emit();
    return done;
  }
  /** The live copy a retirement archives: both documents' snapshots, their
   * Markdown and the UI's comment drafts, or the drafts alone without a
   * replica. Throws when a document can't be serialized. */
  #captureLive() {
    const drafts = this.#retirementDrafts();
    if (this.handle && this.doc)
      return this.exportRecovery(undefined, { drafts, allComments: true });
    if (drafts.length)
      return {
        page_id: this.pageId,
        title: "",
        heads: [],
        comment_drafts: drafts,
        markdown: commentDraftsMarkdown(drafts),
      };
    return undefined;
  }
  /** Capturing the live copy failed, so the retirement fails before it
   * archives anything. The stored checkpoint stays as it was; the backend,
   * both handles and the comments lookup stay for Try again (`held` unless a
   * close already released the backend), and so do the drafts already read
   * (`retiredDrafts`), whatever the UI does with its sources meanwhile. The notice
   * and the reload gate get `unarchivedCopy`: whatever Markdown the replica
   * still projects, with the drafts. */
  #captureFailed(error, released) {
    const message = error instanceof Error ? error.message : String(error);
    this.retireProblem = `This browser couldn't copy the Page for the recovery archive: ${message}`;
    this.unarchivedCopy = this.#unarchivedCopy();
    if (this.phase$.snapshot().name !== "retiring") return this.#whenReleased();
    const { done } = this.dispatch({ type: "retireFail", ...(!released && { held: true }) });
    this.emit();
    return done;
  }
  /** A best-effort copy of a replica that couldn't be serialized: its
   * Markdown projection and drafts, without snapshots. Never throws. */
  #unarchivedCopy() {
    const drafts = this.#retirementDrafts();
    const projected = this.doc
      ? this.#projectCopy(
          this.#liveCommentsDoc() ? {} : { comments_snapshot: this.localPage?.comments_snapshot },
          { commentDrafts: drafts, allComments: true },
        )
      : { title: "", markdown: commentDraftsMarkdown(drafts), heads: [] };
    return {
      page_id: this.pageId,
      title: projected.title,
      markdown: projected.markdown,
      heads: projected.heads ?? [],
      ...(drafts.length && { comment_drafts: drafts }),
      unarchived: true,
    };
  }
  /** What this tab still holds that the archive doesn't: its export, or a
   * failed capture's best-effort copy. The reload gate keeps it. */
  get retainedCopy() {
    return this.closedRecovery ?? this.unarchivedCopy;
  }
  /** Try a failed archive again (the notice's Try again). Resolves once it
   * settles; a retry that fails again stays in retireFailed. */
  async retryRetirement() {
    const { rejected } = this.dispatch({ type: "retireRetry" });
    if (rejected) return;
    this.emit();
    await this.closeSettled().catch(() => {});
  }
  /** Write `live` and the stored checkpoint to the recovery archive and leave
   * the marker for `reason` (retireLocalPage). The grant is the replica key
   * this session opened under and the access revision it last held, or the
   * refusal's own revision when the host sent one: a checkpoint from a newer
   * grant stays. The live copy carries both documents: the Page and its
   * comments, unsent comments included. */
  retireLocal(reason, live) {
    return retireLocalPage(this.identity, this.pageId, {
      reason,
      grant: this.replicaKey,
      revision: Number.isSafeInteger(this.access?.revision) ? this.access.revision : undefined,
      snapshot: live?.snapshot,
      title: live?.title,
      drafts: live?.comment_drafts,
      comments_snapshot: live?.comments_snapshot,
      comments_document_id: live?.comments_document_id,
    });
  }
  async #rekey({ access, key }) {
    if (this.localPage?.resetReplica) {
      // Another grant change can race the replacement's fetch. Advance only
      // its empty reset marker, never import retired history into this key.
      this.localPage = await prepareLocalPageReload(this.identity, this.localPage, access, key);
    }
    await this.releaseLocal();
    if (!this.alive) return;
    await this.initializeLocal(key);
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  notify(listeners, value) {
    for (const fn of listeners) {
      try {
        fn(value);
      } catch (error) {
        // A stale editor or subscriber must not interrupt sync or durability.
        this.problem = error instanceof Error ? error.message : String(error);
      }
    }
  }
  emit() {
    this.notify(this.listeners);
  }
  /** Re-derive the schema gate from the replica. Runs before observers see a
   * change, so an editor never applies a local edit over content it can't
   * express. */
  /** The reload gate's view of a schema hold (reload-gate-machine.mjs):
   * undefined unless the schema gate holds edits the host won't accept;
   * otherwise `refused` until a checkpoint for the reload is written, then
   * `writing`, `written` or `failed`. */
  get schemaHold() {
    if (this.schemaGate.editable || !this.recoveryPending) return undefined;
    return this.schemaCheckpoint ?? "refused";
  }
  /** Write every local edit to this browser's store so a reload can go ahead
   * without the host's receipt. The schema gate keeps the replica read-only,
   * so no later local edit can escape the checkpoint. */
  checkpointForSchema() {
    if (this.schemaCheckpoint === "writing") return this.schemaCheckpointing;
    this.schemaCheckpoint = "writing";
    this.emit();
    this.schemaCheckpointing = (async () => {
      let written = false;
      try {
        await this.repo?.flush();
        await this.persistLocal({ pending: true });
        written = !!this.localPage && !!this.handle;
      } catch {
        // Reported as failed below; the edits stay in this tab.
      }
      if (!this.alive) return;
      this.schemaCheckpoint = written ? "written" : "failed";
      this.emit();
    })();
    return this.schemaCheckpointing;
  }
  /** Both documents gate edits: the Page's stamp, and the comments
   * document's stamp for the rich content comments carry. */
  observeSchema() {
    this.stepSchema({ type: "observe", doc: this.doc });
    if (this.commentsDoc) this.stepSchema({ type: "observe", doc: this.commentsDoc });
  }
  stepSchema(event) {
    const { gate } = schemaGateStep(this.schemaGate, event, this.buildFeatures);
    if (gate === this.schemaGate) return;
    const editable = this.schemaGate.editable;
    this.schemaGate = gate;
    if (gate.editable !== editable) this.updateCapabilities();
    this.emit();
  }
  receiveChange(event) {
    if (!this.alive) return;
    this.observeSchema();
    // The Page's stamp says whether its comments moved yet.
    this.updateCapabilities();
    this.resolveToolHints();
    const change = { ...event, remote: this.localDepth === 0 };
    if (this.composing && change.remote) this.deferredBefore ??= event.patchInfo.before;
    else this.notify(this.observers, change);
    if (change.remote) this.queueSaved();
    this.emit();
  }
  /** A change to the comments document. Comments render from snapshot(),
   * so listeners are enough; editor observers only follow the Page. */
  receiveCommentsChange() {
    if (!this.alive) return;
    this.observeSchema();
    if (this.localDepth === 0) this.queueSaved();
    this.emit();
  }
  snapshot() {
    return this.doc && !this.hidden ? projectPage(this.doc, this.commentsView) : null;
  }
  requireSignIn(message = "Sign in again to sync this Page. Keep it open while you sign in.") {
    const { rejected } = this.dispatch({ type: "signIn", ok: false }, () => {
      this.cancelReceiptRetry();
      // Sync waits for sign-in now; a sync problem from before it is stale.
      // The next attempt after sign-in shows it again if it still applies.
      if (this.problem === this.connectionProblem || this.problem === this.receiptState?.problem)
        this.problem = this.localProblem;
      this.receiptRevision = (this.receiptRevision ?? 0) + 1;
      this.authProblem = message;
      this.showStatus(overlayStatus("authRequired"));
      this.reconnect({ type: "halt" });
    });
    if (!rejected) this.emit();
  }
  acceptAuthentication(result) {
    if (!this.alive) return false;
    if (!result?.identity) {
      this.requireSignIn();
      return false;
    }
    if (this.identity && result.identity.principal !== this.identity.principal) {
      this.requireSignIn(
        "Sign in with this Page's original account to resume syncing. Keep this Page open.",
      );
      return false;
    }
    const resuming = this.authRequired && !this.accessDenied && !this.accessReloadRequired;
    if (resuming) this.syncStatus({ type: "retrying" });
    this.dispatch({ type: "signIn", ok: true });
    if (resuming) this.renderStatus();
    this.authProblem = "";
    this.identity = result.identity;
    this.credentialCanWrite = !!result.canWrite;
    if (
      this.handle &&
      this.access &&
      this.replicaKey &&
      !this.accessDenied &&
      this.replicaKey !== replicaKey(this.access, this.credentialCanWrite)
    )
      this.pauseForAccess(
        "Your permissions changed. Reload the current Page; unsynced edits remain available as a local draft.",
      );
    this.updateCapabilities();
    this.emit();
    return true;
  }
  updateCapabilities() {
    const enabled = !this.accessDenied && !this.accessReloadRequired && !this.editsPaused;
    // Content and comments are document writes; the schema gate holds both.
    const content = enabled && this.schemaGate.editable && !this.converting;
    this.canWrite = content && !!this.credentialCanWrite && !!this.access?.canWrite;
    // Comments are written to the comments document, so they wait for it and
    // for the Page's stamp saying the comments moved there.
    this.canComment =
      content && !!this.credentialCanWrite && !!this.access?.canComment && !!this.commentsView;
    this.canManageAccess = enabled && !!this.credentialCanWrite && !!this.access?.canManageAccess;
    this.canDelete = enabled && !!this.credentialCanWrite && !!this.access?.canDelete;
    this.canRestore = enabled && !!this.credentialCanWrite && !!this.access?.canRestore;
  }
  get recoveryPending() {
    // A reader replica cannot author changes the host accepts, so it has no
    // draft to recover when access grows.
    if (this.replicaKey?.endsWith(READER_REPLICA)) return false;
    return (
      !!this.localPage?.pending ||
      (!!this.doc && !A.getHeads(this.doc).every((head) => this.savedHeads.includes(head))) ||
      (!!this.commentsDoc &&
        !A.getHeads(this.commentsDoc).every((head) => this.savedCommentHeads.includes(head)))
    );
  }
  disconnectSockets() {
    this.clearPresence();
    const sockets = [...this.sockets];
    this.sockets.clear();
    for (const socket of sockets) socket.close();
    return Promise.resolve();
  }
  socketDisconnected(socket) {
    // Intentional teardown removes the socket before close() can fire. A late
    // callback from that retired connection must not reconnect its successor.
    if (!this.sockets.delete(socket)) return;
    this.clearPresence();
    const admittedAt = this.socketAdmittedAt.get(socket);
    const stable = admittedAt !== undefined && this.now() - admittedAt >= STABLE_CONNECTION_MS;
    if (stable) this.reconnect({ type: "stable" });
    if (!this.alive || this.authRequired || this.accessDenied || this.accessReloadRequired) return;
    const outcome = this.socketOutcomes.get(socket);
    if (outcome?.code === "page_deleted") {
      void this.markDeleted();
      return;
    }
    if (outcome?.retry === "stop") {
      this.refuseNative(outcome);
      return;
    }
    // The host's admission closes a socket that never proved stable: count it,
    // so a host that keeps refusing pauses instead of retrying forever.
    if (this.scheduleReconnect({ refused: !!outcome && !stable }) === "paused") return;
    this.syncStatus({ type: "retrying" });
    this.renderStatus();
    this.emit();
  }
  /** Step the reconnect machine and run its effects. A rejected event
   * changes nothing. */
  reconnect(event) {
    const result = viewerReconnectMachine.step(this.reconnect$.snapshot(), event);
    if (result.rejected) return result;
    this.reconnect$.update(() => result.state);
    for (const effect of result.effects) {
      switch (effect.type) {
        case "schedule":
          this.retryTimer = setTimeout(
            () => {
              this.retryTimer = undefined;
              if (!this.reconnect({ type: "timer" }).rejected) void this.attemptConnection();
            },
            reconnectDelay(effect.step, this.random()),
          );
          break;
        case "cancel":
          clearTimeout(this.retryTimer);
          this.retryTimer = undefined;
          break;
        case "armHandshake":
          this.handshakeTimer = setTimeout(() => {
            this.handshakeTimer = undefined;
            this.reconnect({ type: "handshakeTimeout" });
          }, effect.ms);
          break;
        case "disarmHandshake":
          clearTimeout(this.handshakeTimer);
          this.handshakeTimer = undefined;
          break;
        case "abandonHandshake": {
          // Ends the pending connect() and closes the socket; a late handshake
          // result on it is freed, not used.
          const handshake = this.handshake;
          this.handshake = undefined;
          handshake?.abandon(effect.reason);
          break;
        }
        case "pauseSync":
          this.showConnectionProblem(SYNC_PAUSED);
          break;
        case "reportOutage":
          // A specific failure the person can act on stays in front.
          if (!this.connectionProblem) this.showConnectionProblem(SERVER_UNREACHABLE);
          break;
      }
    }
    return result;
  }
  /** Show a connection failure in the receipt status, keeping a local save
   * failure in front of it. */
  showConnectionProblem(message) {
    this.connectionProblem = message;
    if (!this.localProblem) this.problem = message;
    this.showConnectionStatus();
  }
  /** A connection attempt failed transiently: show Offline without a banner
   * while the reconnect backoff retries. */
  showUnreachable() {
    this.unreachable = true;
    this.showConnectionStatus();
  }
  showConnectionStatus() {
    this.syncStatus({ type: "unreachable" });
    if (this.receiptState) this.showReceiptState();
    else {
      this.renderStatus();
      this.emit();
    }
  }
  /** The host refused this tab's signing key. Reconnecting with the same key
   * cannot succeed, so wait for an explicit Retry or a new tab. */
  refuseNative(admission) {
    this.reconnect({ type: "keyRefused" });
    this.refusal = admission;
    // A first open may still be waiting for the document over this socket.
    this.rejectLookup?.(signingKeyRefused(admission));
    this.showConnectionProblem(SIGNING_KEY_REFUSED);
  }
  /** Stop syncing while keeping the local draft. `denied` removes access,
   * `trashed` says the Page is in its owner's Trash, and otherwise the
   * replica must be archived and reloaded. `checkpoint: false` when another
   * tab already wrote the access fact. */
  /** Apply one classified host refusal (classifyRefusal). Returns whether
   * it was one. */
  async applyRefusal(refusal) {
    switch (refusal) {
      case "deleted":
        await this.markDeleted();
        return true;
      case "access":
        await this.revoke();
        return true;
      case "trash":
        // A trashed Page can be restored, so the copy stays.
        if (this.alive) this.pauseForAccess(TRASHED_COPY, { trashed: true });
        return true;
      case "denied":
        if (this.alive) this.pauseForAccess(DENIED_COPY, { denied: true });
        return true;
    }
    return false;
  }
  pauseForAccess(message, { denied = false, checkpoint = true, trashed = false } = {}) {
    // An opening replica has no checkpoint yet, so a changed grant only pauses.
    const local = !checkpoint || (!denied && this.phase$.snapshot().name === "opening");
    const event = trashed
      ? { type: "trash" }
      : {
          type: "accessChanged",
          grant: denied ? "denied" : "changed",
          ...(local && { tab: true }),
        };
    const { rejected } = this.dispatch(event, () => {
      this.accessProblem = message;
      if (denied || trashed)
        this.access = {
          ...this.access,
          role: "none",
          canRead: false,
          canWrite: false,
          canComment: false,
          canManageAccess: false,
          canDelete: false,
        };
      this.updateCapabilities();
      this.cancelReceiptRetry();
      this.receiptRevision = (this.receiptRevision ?? 0) + 1;
      this.reconnect({ type: "halt" });
      this.showStatus(overlayStatus(denied || trashed ? "accessDenied" : "accessReloadRequired"));
    });
    if (!rejected) this.emit();
  }
  async localAccessChanged() {
    const latest = await readLocalPage(this.identity, this.pageId, { markers: true });
    if (latest?.revoked) return this.revoke();
    if (latest?.access) this.access = latest.access;
    this.pauseForAccess(
      "Your permissions changed in another tab. Your local draft is kept on this device.",
      {
        denied: this.access?.role === "none",
        checkpoint: false,
      },
    );
  }
  async acceptPageAccess(access) {
    if (
      !access ||
      !["owner", "editor", "commenter", "viewer", "none"].includes(access.role) ||
      !Number.isSafeInteger(access.generation) ||
      access.generation < 0 ||
      !Number.isSafeInteger(access.revision) ||
      access.revision < 0
    )
      throw Error("Invalid Page access response");
    this.access = { ...access };
    const nextKey = replicaKey(access, this.credentialCanWrite);
    if (!access.canRead) {
      await this.revoke();
      throw Object.assign(Error(ACCESS_REVOKED), { status: 403 });
    }
    if (this.replicaKey !== nextKey) {
      if (this.handle) {
        this.pauseForAccess(
          access.trashed
            ? "This Page was moved to Trash. Reload to preview it read-only; unsynced edits remain available as a local draft."
            : "Your permissions changed. Reload the current Page; unsynced edits remain available as a local draft.",
        );
        throw accessFailure();
      }
      const { rejected, done } = this.dispatch(
        { type: "accessChanged", grant: "changed" },
        undefined,
        { access, key: nextKey },
      );
      if (!rejected) await done;
      if (!this.alive) return;
    } else this.dispatch({ type: "accessChanged", grant: "same" });
    this.accessProblem = "";
    this.updateCapabilities();
  }
  listRecoveries() {
    return listLocalRecoveries(this.identity, this.pageId);
  }
  /** Every copy of this Page the person can download, as one bundle: every
   * recovery record, plus this tab's own export while the archive doesn't
   * hold it (it is still writing, or failed). Records are never merged: two
   * with the same snapshot can carry different comment drafts. */
  exportRecoveries(records = []) {
    const copies = [];
    if (this.closedRecovery && !this.recoveryArchived) copies.push(this.exportRecovery());
    else if (this.unarchivedCopy && !this.recoveryArchived) {
      // A failed capture holds the replica. Drafts the UI changed since then
      // join the retained copy the reload gate keeps, whatever happens next.
      this.unarchivedCopy = this.#unarchivedCopy();
      // Try its snapshots again, or fall back to the Markdown it projects.
      try {
        copies.push(
          this.exportRecovery(undefined, { drafts: this.retiredDrafts, allComments: true }),
        );
      } catch {
        copies.push({ ...this.unarchivedCopy });
      }
    }
    for (const record of records)
      copies.push({ ...this.exportRecovery(record), archived_at: record.archived_at });
    return { page_id: this.pageId, copies };
  }
  /** One copy as `{ title, markdown, snapshot, heads, page_id }`: a recovery
   * record, or this tab's replica. `drafts` adds the UI's unsent comment
   * drafts to a live export. `allComments` lists every comment, as for a
   * retired copy whose host this account can no longer read.
   *
   * The raw snapshots of both documents are what the archive and the
   * download keep, so serializing a live replica must succeed: a failure
   * throws. The Markdown is a projection of them; if it fails, the copy
   * still carries its snapshots and a note says the Markdown is missing. */
  exportRecovery(record, { drafts, allComments = false } = {}) {
    if (!record && this.closedRecovery) return { ...this.closedRecovery };
    const commentDrafts = record ? record.comment_drafts : drafts;
    if (record && !record.snapshot)
      return {
        title: record.title ?? "",
        markdown: commentDraftsMarkdown(commentDrafts),
        heads: [],
        page_id: this.pageId,
        ...(commentDrafts?.length && { comment_drafts: commentDrafts }),
      };
    const bytes = record ? recordBytes(record) : this.#liveBytes();
    const projected = this.#projectCopy(bytes, { record, commentDrafts, allComments });
    return {
      title: projected.title,
      markdown: projected.markdown,
      snapshot: bytes.snapshot,
      heads: bytes.heads ?? projected.heads ?? [],
      ...(bytes.comments_snapshot && {
        comments_snapshot: bytes.comments_snapshot,
        ...((bytes.comment_heads ?? projected.comment_heads) && {
          comment_heads: bytes.comment_heads ?? projected.comment_heads,
        }),
        ...(bytes.comments_document_id && { comments_document_id: bytes.comments_document_id }),
      }),
      page_id: this.pageId,
      ...(commentDrafts?.length && { comment_drafts: commentDrafts }),
      ...(projected.degraded && { markdown_unavailable: true }),
    };
  }
  /** The live replica's raw copy: both documents serialized now. A
   * comments document that isn't open yet contributes the stored
   * checkpoint's bytes, as they are. Throws when serializing fails. */
  #liveBytes() {
    const doc = this.doc;
    if (!doc) throw Error("No local Page to export");
    const comments = this.#liveCommentsDoc();
    const storedComments = comments ? undefined : this.localPage?.comments_snapshot;
    const commentsId =
      this.commentsHandle?.documentId ??
      this.pendingComments?.documentId ??
      this.localPage?.comments_document_id;
    return {
      snapshot: encodeSnapshot(A.save(doc)),
      heads: A.getHeads(doc),
      ...(comments && {
        comments_snapshot: encodeSnapshot(A.save(comments)),
        comment_heads: A.getHeads(comments),
      }),
      ...(storedComments && { comments_snapshot: storedComments }),
      ...((comments || storedComments) && commentsId && { comments_document_id: commentsId }),
    };
  }
  /** The comments document a live copy carries: the installed one, or one a
   * lookup found that is still waiting for its install checks. Nothing
   * renders from a waiting document; only copies read it. */
  #liveCommentsDoc() {
    return this.commentsDoc ?? this.pendingComments?.doc();
  }
  /** The Markdown projection of a copy's documents, with its title and
   * heads. It never throws: a copy it can't project gets a note instead. */
  #projectCopy(bytes, { record, commentDrafts, allComments }) {
    let doc, loadedComments;
    try {
      doc = record ? A.load(decodeSnapshot(bytes.snapshot)) : this.doc;
      // An archived record carries its own comments checkpoint. A live
      // replica whose comments document isn't open yet uses the stored one.
      const live = !record && this.#liveCommentsDoc();
      if (!live && bytes.comments_snapshot)
        loadedComments = A.load(decodeSnapshot(bytes.comments_snapshot));
      const commentsSource = live || loadedComments;
      // Comments render once the Page says they moved to their own document.
      const comments = commentsSource && commentsMigrated(doc) ? commentsSource : undefined;
      const page = projectPage(doc, comments);
      // Comments are part of the draft: list the ones the host never
      // acknowledged. An archived record has no receipt, so it lists them all.
      const savedCommentHeads = loadedComments
        ? (this.localPage?.comment_saved_heads ?? [])
        : this.savedCommentHeads;
      let saved = null;
      if (!record && !allComments && (this.savedHeads.length || savedCommentHeads.length))
        try {
          saved = projectPage(
            this.savedHeads.length ? A.view(doc, this.savedHeads) : doc,
            comments &&
              (savedCommentHeads.length ? A.view(comments, savedCommentHeads) : { threads: {} }),
          );
        } catch {}
      return {
        title: page.title,
        markdown: `# ${page.title}\n\n${page.blocks.map((block) => block.markdown).join("\n\n")}\n${unsentCommentsMarkdown(page, saved)}${commentDraftsMarkdown(commentDrafts)}`,
        heads: headsOf(doc),
        ...(commentsSource && { comment_heads: headsOf(commentsSource) }),
      };
    } catch {
      let title = record?.title ?? "";
      try {
        title = String(doc?.title ?? title);
      } catch {}
      return {
        title,
        markdown: `# ${title}\n\n${MARKDOWN_UNAVAILABLE}\n${commentDraftsMarkdown(commentDrafts)}`,
        degraded: true,
      };
    } finally {
      if (record && doc) A.free(doc);
      if (loadedComments) A.free(loadedComments);
    }
  }
  /** Store a record's comments checkpoint in this replica's native storage,
   * before the comments document is looked up, so an offline reopen still
   * holds comments the host never acknowledged.
   *
   * A retired copy's comments stay in the recovery archive. Two fences guard
   * the native write, checked at the start and again after the last await,
   * right before the write: this session's local fence (no retirement,
   * release or replacement here), and the stored entry, read again, still
   * holding `record`'s grant (no marker, no other replica key, no greater
   * grant revision). Either failing stores nothing. */
  async restoreCommentsCheckpoint(record) {
    if (!record?.comments_snapshot || !record.comments_document_id || !this.backend) return;
    const current = this.#localFence();
    const grant = { grant: record.replicaKey, revision: record.grant_revision };
    const holds = async () =>
      current() && (await this.#storedStanding(grant)) === "current" && current();
    if (!(await holds())) return;
    const backend = this.backend;
    const checkpoint = A.load(decodeSnapshot(record.comments_snapshot));
    try {
      const id = documentIdToBinary(record.comments_document_id);
      const records = await checkpointRecords(backend, id, checkpoint);
      if (!(await holds())) return;
      await backend.storeSnapshot(id, records);
    } finally {
      A.free(checkpoint);
    }
  }
  /** Archive this reload-required replica, release it and open the
   * replacement. Resolves with the replacement session. */
  async reloadForAccess() {
    const phase = this.phase$.snapshot().name;
    if (phase === "opening" || phase === "draining" || !this.access?.canRead) throw accessFailure();
    const { rejected, done } = this.dispatch({ type: "reloadAccess" });
    if (rejected === REJECT.noReload) throw accessFailure();
    if (rejected) throw Error("Page closed");
    return done;
  }
  async refreshAuthentication() {
    try {
      const result = await this.refreshSession();
      if (!this.alive) return;
      if (!this.acceptAuthentication(result))
        throw Object.assign(Error(this.authProblem), { status: 401 });
    } catch (error) {
      if (this.alive && (error.status === 401 || error.status === 403) && !this.authRequired)
        this.requireSignIn();
      throw error;
    }
  }
  async start(creation) {
    // A known browser identity lets us open its local replica without a network
    // round trip. Every remote connection still refreshes and verifies account
    // access, including before publishing a previously offline creation.
    if (this.authentication) {
      if (!this.acceptAuthentication(this.authentication)) throw Error(this.authProblem);
    } else await this.refreshAuthentication();
    const stored = await readLocalPage(this.identity, this.pageId, { markers: true });
    // A marker (retireLocalPage) means this browser's copy is in the recovery
    // archive. Nothing local renders: the host decides, and a host-verified
    // open replaces an access marker.
    const retired = !!stored && (!!stored.deleted || !!stored.revoked);
    this.localPage = retired ? null : stored;
    if (creation && !this.credentialCanWrite) throw Error("This account cannot create Pages");
    this.access =
      this.localPage?.access ?? (creation || this.localPage ? ownerAccess() : undefined);
    this.updateCapabilities();
    await this.initializeLocal(
      this.localPage?.replicaKey ?? replicaKey(this.access, this.credentialCanWrite),
    );
    // Whether this replica opens with edits of its own the host hasn't
    // confirmed (local-edits.mjs). Only that, never a receipt that was merely
    // outstanding, makes the status say Saving.
    let unconfirmed;
    if (creation) {
      const doc = A.change(
        A.from(createPageData({ pageId: this.pageId, title: creation.title })),
        (draft) => initializePage(draft),
      );
      this.handle = await this.repo.import(A.save(doc));
      await this.repo.flush();
      const now = new Date().toISOString();
      const snapshot = encodeSnapshot(A.save(this.doc));
      this.localPage = {
        principal: this.identity.principal,
        page_id: this.pageId,
        document_id: this.handle.documentId,
        title: this.doc.title,
        created_at: now,
        updated_at: now,
        canWrite: true,
        access: this.access,
        replicaKey: this.replicaKey,
        registered: false,
        pending: true,
        snapshot,
        registrationProtocol: 1,
        // The bootstrap and everything after it are this browser's own edits.
        localEdits: withActor(
          withActor(emptyLocalEdits(), A.getActorId(doc), this.replicaId),
          this.actor(),
          this.replicaId,
        ),
        registration: {
          expected_principal: this.identity.principal,
          page_id: this.pageId,
          document_id: this.handle.documentId,
          initial_snapshot_base64: snapshot,
          title: this.doc.title,
          idempotency_key: `v1_${crypto.randomUUID()}`,
        },
      };
      await writeLocalPage(this.identity, this.localPage, { replica: this.replicaId });
      unconfirmed = true;
    } else if (this.localPage && !this.localPage.resetReplica) {
      // A checkpoint can contain more history than an ordinary edit batch.
      // Merge its bounded complete record set before exposing a handle; this
      // also retries any prefix left by an interrupted local import.
      const checkpoint = A.load(decodeSnapshot(this.localPage.snapshot));
      try {
        const id = documentIdToBinary(this.localPage.document_id);
        await this.backend.storeSnapshot(id, await checkpointRecords(this.backend, id, checkpoint));
      } finally {
        A.free(checkpoint);
      }
      await this.restoreCommentsCheckpoint(this.localPage);
      this.handle = await this.repo.find(this.localPage.document_id);
      this.canWrite = !!this.canWrite && !!this.localPage.canWrite;
      // Native storage can hold an edit the checkpoint never saw, so decide
      // from the restored document. A record without localEdits predates
      // them; its receipt flag is all there is.
      let edits = readLocalEdits(this.localPage.localEdits);
      unconfirmed = edits ? hasUnconfirmedLocalEdits(this.doc, edits) : !!this.localPage.pending;
      if (unconfirmed && (await this.recoverPreservedBlockEdits(edits))) {
        edits = readLocalEdits(this.localPage.localEdits);
        unconfirmed = edits ? hasUnconfirmedLocalEdits(this.doc, edits) : false;
      }
      // Without unconfirmed local edits, every change here is acknowledged or
      // came from the host.
      if (!unconfirmed) this.savedHeads = A.getHeads(this.doc);
      else if (edits) this.savedHeads = acknowledgedHeads(this.doc, edits);
      await this.recordActor(edits ?? { ...emptyLocalEdits(), unattributed: unconfirmed });
    } else {
      try {
        await this.connect(false);
      } catch (error) {
        // A browser that held a copy shows why it's gone, with its recovery
        // archive. One that never held the Page reports the error.
        if (stored && this.hidden) return;
        throw error;
      }
      if (this.nativeRefused) throw signingKeyRefused(this.refusal);
      const lookupDeadline = AbortSignal.timeout(15000);
      // The document arrives over the native socket. If the host refuses this
      // tab's key, end the lookup with that diagnosis instead of a timeout.
      const refused = new Promise((_, reject) => {
        this.rejectLookup = reject;
      });
      try {
        this.handle = await Promise.race([
          this.repo.find(this.connection.documentId, { signal: lookupDeadline }),
          refused,
        ]);
      } catch (cause) {
        // DOMException.code is the readonly numeric legacy code, so wrap only
        // this lookup's own deadline instead of broadly retrying TimeoutErrors.
        if (lookupDeadline.aborted && cause === lookupDeadline.reason)
          throw Object.assign(Error("Page loading timed out. Please try again.", { cause }), {
            name: "TimeoutError",
            code: "REQUEST_TIMEOUT",
          });
        // /api/connect already admitted this reader, so the host has the
        // document. Repo reports it unavailable when the only peer's socket
        // closes first, e.g. a native refusal while an ACL change commits
        // (access_changed, retry "recheck"). Reopening is safe; let the open
        // loop retry instead of showing a permanent error.
        if (/^Document \S+ is unavailable$/.test(cause?.message ?? ""))
          throw Object.assign(
            Error("The Page connection closed before the document arrived. Please try again.", {
              cause,
            }),
            { code: "NETWORK_ERROR" },
          );
        throw cause;
      } finally {
        this.rejectLookup = undefined;
      }
      const now = new Date().toISOString();
      this.localPage = {
        principal: this.identity.principal,
        page_id: this.pageId,
        document_id: this.handle.documentId,
        title: this.doc.title,
        created_at: now,
        updated_at: now,
        canWrite: this.canWrite,
        access: this.access,
        replicaKey: this.replicaKey,
        registered: true,
        pending: false,
        snapshot: encodeSnapshot(A.save(this.doc)),
        localEdits: withActor(emptyLocalEdits(), this.actor(), this.replicaId),
      };
      await writeLocalPage(this.identity, this.localPage, {
        replica: this.replicaId,
        regrant: retired,
      });
      unconfirmed = false;
    }
    this.observeSchema();
    this.handle.on("change", (event) => this.receiveChange(event));
    this.handle.on("ephemeral-message", (event) => this.ephemeral(event));
    this.openComments();
    // A Trash pause keeps its own notice.
    if (this.accessDenied && pauseOf(this.phase$.snapshot()).access !== "trash")
      this.accessProblem = DENIED_COPY;
    this.syncStatus({ type: "opened", pending: unconfirmed });
    this.renderStatus();
    // A pause while opening has already failed start().
    if (this.phase$.snapshot().name === "opening")
      this.dispatch({ type: "opened", denied: this.access?.role === "none" });
    this.presenceTimer = setInterval(() => {
      if (this.presenceValue) this.publishPresence(this.presenceValue);
    }, 10000);
    this.watchOnline();
    this.watchPageLifecycle();
    if (this.connection) this.queueSaved();
    else {
      // Reopening a denied local copy must check the host once: the owner may
      // have restored access since this checkpoint. The draft stays read-only
      // until acceptPageAccess verifies the new grant and replica generation.
      void this.retryConnection({ recheckDeniedAccess: this.accessDenied });
    }
  }
  /** Coming back online resumes reconnects, even after a refusal or a
   * pause. Closing the session removes the listener. */
  watchOnline() {
    globalThis.removeEventListener?.("online", this.onlineListener);
    this.onlineListener = () => void this.retryConnection();
    globalThis.addEventListener?.("online", this.onlineListener);
  }
  /** Send waiting edits and the caret at once when the person may be about
   * to stop looking. Blur and `beforeunload` flush; a hidden tab or
   * `pagehide` also stops batching until the tab shows again, because a
   * hidden tab's timers may be throttled or frozen while saves still finish.
   * Delivery before an unload is best effort: the round starts, and the
   * browser decides whether it completes. Closing the session removes the
   * listeners. Tests pass their own window and document. */
  watchPageLifecycle({ page = globalThis, document = globalThis.document } = {}) {
    this.unwatchPageLifecycle();
    const flush = () => this.outbound.flush();
    const hide = () => this.outbound.hide();
    const show = () => this.outbound.show();
    const visibility = () => (document?.visibilityState === "hidden" ? hide() : show());
    const listeners = [
      [page, "blur", flush],
      [page, "beforeunload", flush],
      [page, "pagehide", hide],
      [page, "pageshow", visibility],
      [document, "visibilitychange", visibility],
    ];
    for (const [target, type, listener] of listeners) target?.addEventListener?.(type, listener);
    this.lifecycleListeners = listeners;
    if (document?.visibilityState === "hidden") hide();
  }
  unwatchPageLifecycle() {
    for (const [target, type, listener] of this.lifecycleListeners ?? [])
      target?.removeEventListener?.(type, listener);
    this.lifecycleListeners = undefined;
  }
  /**
   * Set aside unconfirmed history that rewrote a preserved Markdown block,
   * before this replica connects. Only a build from before the conversion
   * could make them (its Edit table action). The host converts every
   * preserved block itself, and Automerge keeps both conversions, so
   * publishing them would duplicate the block's content. Native admission
   * can't refuse them by content: it sees only the signing keys.
   *
   * The whole replica becomes a recovery record (Download previous local
   * draft), and this session reopens on a fresh native replica holding only
   * history the host already has. Returns whether it did.
   */
  async recoverPreservedBlockEdits(edits) {
    // Without a record of acknowledged heads, the whole history is read.
    const found = preservedBlockEdits(this.doc, edits ? acknowledgedHeads(this.doc, edits) : []);
    if (!found) return false;
    const base = A.clone(A.view(this.doc, found.baseHeads));
    try {
      const canWrite = this.localPage.canWrite;
      const retired = this.replicaId;
      this.localPage = await prepareLocalPageReload(
        this.identity,
        { ...this.localPage, snapshot: encodeSnapshot(A.save(this.doc)) },
        this.access,
        this.replicaKey,
      );
      this.handle = undefined;
      const database = this.databaseName;
      await this.releaseLocal();
      try {
        globalThis.indexedDB?.deleteDatabase(database);
      } catch {}
      await this.initializeLocal(this.replicaKey, { fresh: true });
      const id = documentIdToBinary(this.localPage.document_id);
      await this.backend.storeSnapshot(id, await checkpointRecords(this.backend, id, base));
      // Comments can't rewrite a preserved block: they move to the fresh
      // replica whole.
      await this.restoreCommentsCheckpoint(this.localPage);
      this.handle = await this.repo.find(this.localPage.document_id);
      this.localPage = await writeLocalPage(
        this.identity,
        {
          ...this.localPage,
          resetReplica: undefined,
          canWrite,
          pending: false,
          snapshot: encodeSnapshot(A.save(base)),
          // Other replicas keep their entries, so a tab that holds the same
          // edits sets them aside when it reopens too.
          localEdits: {
            ...(edits ? retireReplica(edits, retired) : emptyLocalEdits()),
            unattributed: false,
          },
        },
        { replica: this.replicaId },
      );
    } finally {
      A.free(base);
    }
    this.recoveredPreservedEdits = true;
    this.problem = PRESERVED_EDITS_RECOVERED;
    return true;
  }
  async initializeLocal(
    key = replicaKey(this.access, this.credentialCanWrite),
    { fresh = false } = {},
  ) {
    this.replicaKey = key;
    const scope = hex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            `${this.identity.principal}\0${this.pageId}${key === "0:writer" ? "" : `\0${key}`}`,
          ),
        ),
      ),
    );
    this.local = await exclusiveIdentity(scope, { fresh });
    // Names this native replica in localEdits without exposing its seed.
    this.replicaId = hex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`pages-native-replica\0${this.local.seed}`),
        ),
      ),
    ).slice(0, 32);
    this.signer = N.MemorySigner.fromBytes(bytes(this.local.seed));
    const peer = this.signer.peerId();
    this.senderId = peer.toString();
    peer.free();
    this.databaseName = `pages-native-${scope}-${this.local.seed.slice(0, 16)}`;
    this.storage = new IndexedDBByteStore({ database: this.databaseName });
    this.backend = new SubductionBackend({
      signer: this.signer,
      storage: this.storage,
      syncTimeoutMilliseconds: 1000,
      ...BACKEND_LIMITS,
      scheduleLocalSync: this.outbound.scheduleLocalSync,
    });
    this.repo = new Repo({ backend: this.backend });
  }
  /** This session's Automerge actor: every local edit it makes carries it. */
  actor() {
    return A.getActorId(this.doc);
  }
  /** The checkpoint's localEdits with this session's actor recorded. A
   * checkpoint without valid localEdits predates them: its receipt flag
   * stands for edits that can't be attributed. */
  localEditsWithActor() {
    return withActor(
      readLocalEdits(this.localPage?.localEdits) ?? {
        ...emptyLocalEdits(),
        unattributed: !!this.localPage?.pending,
      },
      this.actor(),
      this.replicaId,
    );
  }
  /** Record this session's actor in the checkpoint before it can edit, so a
   * crash before the debounced checkpoint still reads its edits as local. */
  async recordActor(edits) {
    const recorded = withActor(edits, this.actor(), this.replicaId);
    if (recorded === edits && this.localPage.localEdits) return;
    this.localPage = await writeLocalPage(
      this.identity,
      { ...this.localPage, localEdits: recorded },
      { replica: this.replicaId },
    );
  }
  persistLocal(patch = {}, { allowClosed = false } = {}) {
    if (this.hidden || (!this.alive && !allowClosed) || !this.localPage || !this.handle)
      return Promise.resolve();
    const heads = A.getHeads(this.doc).join(",");
    if (this.checkpointHeads !== heads) {
      this.checkpointSnapshot = encodeSnapshot(A.save(this.doc));
      this.checkpointHeads = heads;
    }
    // The comments document checkpoints beside the Page, with its own heads,
    // so a comment typed offline survives a reload or a recovery archive.
    const comments = this.commentsDoc;
    const commentHeads = comments ? A.getHeads(comments).join(",") : "";
    if (comments && this.commentsCheckpointHeads !== commentHeads) {
      this.commentsCheckpointSnapshot = encodeSnapshot(A.save(comments));
      this.commentsCheckpointHeads = commentHeads;
    }
    const value = {
      title: this.doc.title,
      updated_at: new Date().toISOString(),
      snapshot: this.checkpointSnapshot,
      ...(comments && {
        comments_snapshot: this.commentsCheckpointSnapshot,
        comments_document_id: this.commentsHandle.documentId,
      }),
      access: this.access,
      replicaKey: this.replicaKey,
      ...patch,
    };
    const work = (this.cacheTail ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        this.localPage = { ...this.localPage, ...value };
        this.localPage = await writeLocalPage(this.identity, this.localPage, {
          replica: this.replicaId,
        });
      });
    this.cacheTail = work;
    return work;
  }
  async registerDraft() {
    if (!this.localPage?.registration || this.localPage.registered) return;
    let result;
    try {
      // New drafts prepare once in the background. Persist the token before
      // sending registration, so a lost response/reload retries identical bytes.
      // Old drafts stay on their original protocol: they may already be accepted.
      if (this.localPage.registrationProtocol === 1 && !this.localPage.registration.retry_token) {
        const prepared = await this.requestWithRenewal("/api/tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation: "list_pages", arguments: {} }),
        });
        if (!this.alive) return;
        if (typeof prepared.retry_token !== "string")
          throw Error("Could not prepare Page registration");
        const key = await retryKey(prepared.retry_token);
        if (!this.alive || this.authRequired) return;
        await this.persistLocal({
          registration: {
            ...this.localPage.registration,
            retry_token: prepared.retry_token,
            idempotency_key: key,
          },
        });
        if (!this.alive) return;
      }
      result = await this.requestWithRenewal("/api/pages/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.localPage.registration),
      });
    } catch (error) {
      if (error.status === 410 && error.code === "retry_expired") {
        result = await this.reconcileExpiredRegistration();
      } else {
        if (error.status === 409 && error.message === "Page was deleted") await this.markDeleted();
        throw error;
      }
    }
    if (!this.alive || this.authRequired || !result) return;
    if (result.page_id !== this.pageId || result.document_id !== this.localPage.document_id)
      throw Error("Registered Page identity does not match its local document");
    await this.persistLocal({ registered: true });
  }
  async reconcileExpiredRegistration() {
    const registration = this.localPage.registration;
    const principal = this.identity.principal;
    const current = () =>
      this.alive &&
      !this.deleted &&
      !this.authRequired &&
      !this.accessDenied &&
      !this.accessReloadRequired &&
      this.identity?.principal === principal &&
      this.localPage?.document_id === registration.document_id;
    let connection;
    try {
      // A lost registration response can outlive its retry receipt. Reconcile
      // the exact Page/document identity before considering another request.
      connection = await this.requestWithRenewal(
        `/api/connect?page=${encodeURIComponent(this.pageId)}`,
        { headers: admissionHeaders },
      );
    } catch (error) {
      if (!current()) return;
      // Missing and unreadable Pages share one response. Registration
      // independently checks ownership and deletion tombstones.
      const absent =
        (error.status === 404 && error.message === "Page not found") ||
        (error.status === 403 && error.code === "page_access_denied");
      if (!absent) throw error;
      const prepared = await this.requestWithRenewal("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "list_pages", arguments: {} }),
      });
      if (!current()) return;
      if (typeof prepared.retry_token !== "string")
        throw Error("Could not prepare Page registration");
      const key = await retryKey(prepared.retry_token);
      if (!current()) return;
      // The expired token cannot execute again. Keep the original bootstrap and
      // UUID, and replace only its retry authority. IndexedDB compare-and-swap
      // makes simultaneous tabs adopt the first replacement rather than race.
      await this.persistLocal({
        registrationSupersedes: registration.idempotency_key,
        registration: { ...registration, retry_token: prepared.retry_token, idempotency_key: key },
      });
      if (!current()) return;
      if (this.localPage.registered)
        return { page_id: this.pageId, document_id: registration.document_id };
      // Server-side registration still checks ownership, exact document ID,
      // pending creation and deletion tombstones; a 404 never clears them.
      return this.requestWithRenewal("/api/pages/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.localPage.registration),
      });
    }
    if (!current()) return;
    if (connection.identity?.principal !== principal)
      throw Object.assign(
        Error("Sign in with this Page's original account to recover its registration"),
        { status: 401 },
      );
    if (connection.page_id !== this.pageId || connection.documentId !== registration.document_id)
      throw Error("Connected Page identity does not match its local document");
    if (!connection.access?.canRead)
      throw Object.assign(Error("This Page is not accessible; your draft is kept locally"), {
        status: 403,
      });
    return { page_id: this.pageId, document_id: connection.documentId };
  }
  /** The Page is gone: forget the local copy, then close. */
  async markDeleted() {
    const { rejected, done } = this.dispatch({ type: "accessChanged", grant: "deleted" }, () => {
      this.canWrite = false;
      this.showStatus(overlayStatus("deleted"));
      this.problem = PAGE_DELETED;
      this.cancelReceiptRetry();
    });
    if (rejected) return;
    this.emit();
    await done;
  }
  /** The host refused this account: archive the local copy, stop rendering
   * it, then close. */
  async revoke() {
    const { rejected, done } = this.dispatch({ type: "accessChanged", grant: "revoked" }, () => {
      this.accessProblem = ACCESS_REVOKED;
      this.access = {
        ...this.access,
        role: "none",
        canRead: false,
        canWrite: false,
        canComment: false,
        canManageAccess: false,
        canDelete: false,
      };
      this.updateCapabilities();
      this.cancelReceiptRetry();
      this.receiptRevision = (this.receiptRevision ?? 0) + 1;
      this.reconnect({ type: "halt" });
      this.showStatus(overlayStatus("accessDenied"));
    });
    if (rejected) return;
    this.emit();
    await done;
  }
  clearConnectionProblem() {
    if (this.problem === this.connectionProblem) this.problem = "";
    this.connectionProblem = "";
    this.unreachable = false;
  }
  connect(refresh = true, recheckDeniedAccess = false) {
    if (!this.alive || this.accessReloadRequired) return Promise.resolve();
    if (!this.connecting)
      this.connecting = this.openConnection(refresh, recheckDeniedAccess).finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
  async openConnection(refresh, recheckDeniedAccess = false) {
    if (refresh) await this.refreshAuthentication();
    if (!this.alive || this.accessReloadRequired) return;
    await this.disconnectSockets();
    if (!this.alive) return;
    await this.registerDraft();
    if (
      !this.alive ||
      this.authRequired ||
      (this.accessDenied && !recheckDeniedAccess) ||
      this.accessReloadRequired
    )
      return;
    try {
      // The first discovery for this Page takes the head script's request
      // (early-session.mjs), which started beside the session check.
      const connection = await requestConnect(this.pageId, request);
      if (!this.alive) return;
      if (
        !this.acceptAuthentication({
          identity: connection.identity,
          canWrite: this.credentialCanWrite,
        })
      )
        throw Object.assign(Error(this.authProblem), { status: 401 });
      if (this.localPage && connection.documentId !== this.localPage.document_id)
        throw Error("Connected Page identity does not match its local document");
      await this.acceptPageAccess(connection.access);
      if (!this.alive) return;
      this.connection = connection;
      // Only the owner can open a trashed Page; it is a read-only preview.
      this.trash = connection.trash ?? null;
      if (connection.recovery?.code === "page_recovery_blocked")
        this.problem = connection.recovery.message;
      // The host is converting Markdown an older build saved: read-only
      // until it finishes. Access is unchanged, so the writer key stays; the
      // host closes the socket when it's done and the next discovery clears
      // this.
      const converting = connection.converting?.code === "preserved_markdown_converting";
      if (converting !== !!this.converting) {
        if (converting)
          this.problem = this.convertingNotice = String(connection.converting.message);
        else if (this.problem === this.convertingNotice) this.problem = "";
        this.converting = converting;
        this.updateCapabilities();
      }
      if (this.localPage && !this.localPage.resetReplica)
        await this.persistLocal({ canWrite: this.canWrite });
      if (this.accessDenied || this.accessReloadRequired) return;
    } catch (error) {
      if (!(await this.applyRefusal(classifyRefusal(error))))
        if (this.alive && error.status === 401 && !this.authRequired) this.requireSignIn();
      throw error;
    }
    if (!this.alive) return;
    this.replacePeerProfiles(this.connection.peerProfiles);
    this.receiveActorProfiles(this.connection, { replace: true });
    this.presencePaused = false;
    this.receiveActivity(this.connection.activity, { initial: true });
    const expected = new N.PeerId(bytes(this.connection.serverPeerId));
    // Pin admission to the host snapshot we just discovered. If that host
    // restarts before the upgrade, reconnect must discover its new epoch.
    const address = pageSyncAddress(
      this.pageId,
      location.href,
      this.activityEpoch,
      this.buildFeatures,
      { converting: this.converting },
    );
    // Keep the browser socket itself: toTransport consumes the native wrapper,
    // whereas the raw socket remains cancellable when account/page access changes.
    // Subduction sends on this socket itself; no send leaves unless it is OPEN.
    const socket = guardSocketSend(new WebSocket(address));
    socket.binaryType = "arraybuffer";
    // Registered before the native wrapper's own listener, so the host's
    // admission outcome is known when the disconnect callback runs.
    socket.addEventListener("close", (event) => {
      const outcome = admissionCloseOutcome(event);
      if (outcome) this.socketOutcomes.set(socket, outcome);
    });
    this.sockets.add(socket);
    try {
      const authenticated = await this.handshakeWithDeadline(socket, expected);
      if (
        !this.alive ||
        this.authRequired ||
        this.accessDenied ||
        this.accessReloadRequired ||
        !this.sockets.has(socket)
      ) {
        authenticated.free();
        socket.close();
        this.sockets.delete(socket);
        this.reconnect({ type: "handshakeEnded" });
        return;
      }
      // The host admitted this socket in time. Joining the backend can still
      // fail; that is a failed attempt on the ready path.
      this.reconnect({ type: "admitted" });
      const transport = authenticated.toTransport();
      try {
        await this.backend.addConnection(transport);
      } finally {
        transport.free();
      }
      if (
        !this.alive ||
        this.authRequired ||
        this.accessDenied ||
        this.accessReloadRequired ||
        !this.sockets.has(socket)
      )
        return;
      this.socketAdmittedAt.set(socket, this.now());
      if (this.handle) {
        this.openComments();
        this.commentsOpen({ type: "reconnected" });
      }
      this.clearConnectionProblem();
      this.syncStatus({ type: "admitted" });
      // A receipt that outlasted its transient retries starts over now that
      // the host answers; any other receipt keeps its own retry budget.
      if (this.handle) this.queueSaved({ restart: !!this.receiptState?.outage });
      else {
        this.renderStatus();
        this.emit();
      }
    } catch (error) {
      const current = this.sockets.delete(socket);
      socket.close();
      if (!current) return;
      this.clearPresence();
      const admission = this.socketOutcomes.get(socket);
      if (admission?.retry === "stop") throw signingKeyRefused(admission, error);
      if (admission)
        throw Object.assign(Error(error?.message ?? String(error), { cause: error }), {
          admission,
        });
      throw error;
    } finally {
      expected.free();
    }
  }
  /** The authenticated handshake on `socket`, under the reconnect machine's
   * deadline. The machine's `abandonHandshake` effect (a timeout, or Retry
   * during the handshake) rejects this with a transient failure and closes
   * the socket, so the attempt ends like one whose socket closed. A
   * handshake that finishes after that is freed and never used. Any other
   * failure ends the handshake state here; the caller classifies it. */
  handshakeWithDeadline(socket, expected) {
    let abandoned = false;
    const setup = N.SubductionWebSocket.setup(socket, this.signer, expected, () => {
      this.socketDisconnected(socket);
    });
    const deadline = new Promise((_, reject) => {
      this.handshake = {
        socket,
        // A timeout is a transient failure, so the attempt takes the backoff.
        // Resume, halt and a socket outcome already decided what follows, so
        // the attempt only settles (HANDSHAKE_ABANDONED) and schedules nothing.
        abandon: (reason) => {
          abandoned = true;
          reject(
            reason === "timeout"
              ? Object.assign(Error("The sync connection didn't answer. Retrying."), {
                  code: "NETWORK_ERROR",
                  reason: "handshake_timeout",
                })
              : Object.assign(Error(`The sync handshake was abandoned (${reason})`), {
                  code: "HANDSHAKE_ABANDONED",
                  reason,
                }),
          );
          socket.close();
        },
      };
    });
    this.reconnect({ type: "handshake" });
    return Promise.race([
      setup.then((authenticated) => {
        if (abandoned) authenticated.free();
        return authenticated;
      }),
      deadline,
    ]).then(
      (authenticated) => {
        if (this.handshake?.socket === socket) this.handshake = undefined;
        return authenticated;
      },
      (error) => {
        if (this.handshake?.socket === socket) this.handshake = undefined;
        if (!abandoned) this.reconnect({ type: "handshakeEnded" });
        throw error;
      },
    );
  }
  /** Retry after a failed attempt or socket, unless the phase stops sync.
   * `refused` says the host's admission closed a socket that never proved
   * stable. Returns the reconnect state's name. */
  scheduleReconnect({ refused = false } = {}) {
    if (this.alive && !this.authRequired && !this.accessDenied && !this.accessReloadRequired)
      this.reconnect({ type: "failed", refused });
    return this.reconnect$.snapshot().name;
  }
  /** An explicit Retry, an online event, a re-authentication or a first
   * open: clear the backoff and any refusal or pause, then attempt now. A
   * stalled handshake is abandoned first, and the new attempt waits for that
   * connect() to settle so it gets its own socket rather than the stuck one. */
  async retryConnection(options) {
    this.reconnect({ type: "resume" });
    if (this.connecting) await this.connecting.catch(() => {});
    return this.attemptConnection(options);
  }
  /** One connection attempt. A failure that may pass schedules the next. */
  async attemptConnection({ recheckDeniedAccess = false, retryReceipt = false } = {}) {
    try {
      await this.connect(true, recheckDeniedAccess);
    } catch (error) {
      if (!this.alive || this.accessReloadRequired || this.accessDenied) return;
      if (error.code === "PAGE_ACCESS_CHANGED") return;
      // Resume or halt ended this attempt; what follows was decided there.
      if (error.code === "HANDSHAKE_ABANDONED") return;
      if (error.admission?.code === "page_deleted") {
        await this.markDeleted();
        return;
      }
      if (error.admission?.retry === "stop") {
        this.refuseNative(error.admission);
        return;
      }
      // Discovery classified its own answer; a bare 404 from another request
      // here (registration, tools) isn't a deletion.
      const refusal = classifyRefusal(error, { legacyMissing: false });
      if (refusal) await this.applyRefusal(refusal);
      else if (error.status === 401) this.requireSignIn(this.authProblem || undefined);
      else if (isTransientFailure(error)) {
        // The host may be restarting. Retry quietly; the reconnect machine
        // reports an outage if this lasts.
        this.showUnreachable();
        this.scheduleReconnect({ refused: !!error.admission });
      } else {
        this.showConnectionProblem(error.message);
        // An admission close during the handshake is a refusal; the next
        // attempt's discovery still stops on 401, 403 or 404.
        if (!error.status || error.status >= 500)
          this.scheduleReconnect({ refused: !!error.admission });
      }
    } finally {
      // HTTP receipts can recover even if native sync still cannot reconnect.
      if (
        retryReceipt &&
        this.alive &&
        !this.authRequired &&
        !this.accessDenied &&
        !this.accessReloadRequired
      )
        this.queueSaved({ restart: true });
    }
  }
  get editsPaused() {
    return this.editPauses.size > 0;
  }
  /** Stop or resume local edits for one reason without touching sync. Edits
   * already made keep saving, so a reload can wait for them. Edits resume only
   * when every reason is released. */
  pauseEdits(reason, paused = true) {
    if (this.editPauses.has(reason) === paused) return;
    if (paused) this.editPauses.add(reason);
    else this.editPauses.delete(reason);
    this.updateCapabilities();
    this.emit();
  }
  observeChange(fn) {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }
  holdRemote() {
    this.composing++;
    return () => {
      this.composing = Math.max(0, this.composing - 1);
      if (!this.composing && this.deferredBefore) {
        const before = this.deferredBefore,
          after = this.doc;
        this.deferredBefore = null;
        const event = {
          doc: after,
          handle: this.handle,
          remote: true,
          patches: A.diff(after, A.getHeads(before), A.getHeads(after)),
          patchInfo: { before, after, source: "change" },
        };
        this.notify(this.observers, event);
        this.emit();
      }
    };
  }
  change(fn) {
    if (!this.alive) throw Error("Page closed");
    if (!this.canWrite) throw Error("This Page is read only");
    return this.#write(this.handle, fn);
  }
  /** One local change to `handle`, with its receipt. */
  #write(handle, fn) {
    this.localDepth++;
    try {
      const stored = handle.change((doc) => {
        fn(doc);
        // Every local write repairs a stamp left incomplete by concurrent
        // first stamps, in the same change.
        stampFeatures(doc);
      });
      this.queueSaved({ edit: true });
      const receipt = this.receiptState;
      Promise.resolve(stored).catch((error) => {
        if (
          !this.alive ||
          !receipt ||
          receipt !== this.receiptState ||
          receipt.revision !== this.receiptRevision
        )
          return;
        this.localProblem = error.message;
        this.problem = error.message;
        this.showReceiptState();
      });
      return stored;
    } finally {
      this.localDepth--;
    }
  }
  /** Write one comment action to the comments document. The Page is never
   * written; anchors resolve against it as this replica holds it now. */
  comment(input, nativeSpans) {
    if (!this.alive) throw Error("Page closed");
    if (!this.canComment) throw Error("Commenting is not available on this Page right now");
    const page = this.doc;
    // The reader's own draft: Markdown it can't represent stays as text.
    return this.#write(this.commentsHandle, (doc) =>
      applyComment(doc, input, this.identity, nativeSpans, {
        literal: true,
        page,
        role: this.access?.role,
      }),
    );
  }
  /**
   * Open the Page's comments document on this replica: the comments-open
   * machine (comments-open-machine.mjs) drives lookups, retries and failure.
   * It syncs over the same socket as the Page. The document ID comes from
   * discovery, or from the local record once a discovery named it, so an
   * offline reopen finds the copy this browser stored.
   */
  openComments(
    documentId = this.connection?.commentsDocumentId ?? this.localPage?.comments_document_id,
  ) {
    // A hidden Page's comments document stays closed.
    if (!documentId || !this.repo || this.hidden) return;
    this.commentsOpen({ type: "open", id: documentId });
  }
  /** How long one comments lookup may take before it counts as failed. */
  commentsLookupTimeout = 15000;
  /** Step the comments-open machine and run its effects at the edge. */
  commentsOpen(event) {
    const result = commentsOpenMachine.step(this.commentsOpen$.snapshot(), event);
    if (result.rejected) return result;
    const before = this.commentsOpen$.snapshot();
    this.commentsOpen$.update(() => result.state);
    for (const effect of result.effects) {
      switch (effect.type) {
        case "lookup":
          this.lookupComments(effect.attempt, effect.id);
          break;
        case "cancel":
          this.commentsLookup?.abort();
          this.commentsLookup = undefined;
          break;
        case "schedule":
          clearTimeout(this.commentsTimer);
          this.commentsTimer = setTimeout(() => {
            this.commentsTimer = undefined;
            this.commentsOpen({ type: "timer", attempt: effect.attempt });
          }, effect.delay);
          break;
        case "clearTimer":
          clearTimeout(this.commentsTimer);
          this.commentsTimer = undefined;
          break;
        case "install":
          void this.installComments(this.commentsFound);
          break;
      }
    }
    // A replaced or closed document is no longer this replica's.
    if (before.name === "ready" && result.state.name !== "ready") this.commentsHandle = undefined;
    if (result.state.name !== before.name) {
      this.updateCapabilities();
      this.emit();
    }
    return result;
  }
  /** One lookup in this replica's repo. Its result reaches the machine only
   * as an event naming its attempt, so a cancelled lookup can't install. */
  lookupComments(attempt, documentId) {
    const repo = this.repo;
    const controller = new AbortController();
    this.commentsLookup = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.commentsLookupTimeout),
    ]);
    Promise.resolve()
      .then(() => repo.find(documentId, { signal }))
      .then(
        (handle) => {
          if (this.repo !== repo || controller.signal.aborted) return;
          this.commentsFound = handle;
          this.commentsOpen({ type: "opened", attempt });
        },
        () => {
          if (this.repo !== repo || controller.signal.aborted) return;
          this.commentsOpen({ type: "lookupFailed", attempt });
        },
      );
  }
  /** Adopt the comments document a lookup found. */
  async installComments(handle) {
    this.commentsFound = undefined;
    if (!handle || !this.alive || this.hidden) return;
    // While its checks run, the found document waits where a retirement's
    // capture reads it (#liveCommentsDoc), and nothing renders from it.
    this.pendingComments = handle;
    // Another tab may have retired or replaced this copy since this one
    // opened. Check the stored entry before the handle is adopted or anything
    // renders from it, on every install.
    const current = this.#localFence();
    const standing = await this.#storedStanding({
      grant: this.replicaKey,
      revision: this.access?.revision,
    });
    // A retirement in this tab captured the waiting document. It stays there
    // for Try again until the release lets it go.
    if (this.hidden) return;
    if (this.pendingComments === handle) this.pendingComments = undefined;
    const opened = this.commentsOpen$.snapshot();
    // A replaced lookup or replica, or a closed session, installs nothing.
    if (!current() || !this.alive || opened.name !== "ready" || opened.id !== handle.documentId)
      return;
    if (standing === "revoked" || standing === "deleted") {
      // Retire this tab too. The retirement captures the found document in
      // the same step that hides the Page, so its unsent comments reach the
      // archive and nothing renders them.
      this.pendingComments = handle;
      if (standing === "deleted") await this.markDeleted();
      else await this.revoke();
      if (!this.hidden && this.pendingComments === handle) this.pendingComments = undefined;
      return;
    }
    if (standing === "replaced") {
      // Another grant's entry: pause as a checkpoint write would.
      if (["open", "paused"].includes(this.phase$.snapshot().name)) await this.localAccessChanged();
      return;
    }
    this.commentsHandle = handle;
    this.savedCommentHeads = this.localPage?.comment_saved_heads ?? [];
    handle.on("change", () => {
      if (this.commentsHandle === handle) this.receiveCommentsChange();
    });
    if (this.localPage && this.localPage.comments_document_id !== handle.documentId)
      try {
        await this.persistLocal({ comments_document_id: handle.documentId });
      } catch (error) {
        // Another tab retired the copy since this one opened: the write
        // archived this replica's copy, and this tab retires too.
        if (error.code === "LOCAL_PAGE_REVOKED") return void (await this.revoke());
        if (error.code === "LOCAL_PAGE_DELETED") return void (await this.markDeleted());
        if (error.code === "LOCAL_PAGE_ACCESS_CHANGED")
          return void (await this.localAccessChanged());
        this.localProblem = this.problem = error.message;
      }
    if (!this.alive || this.commentsHandle !== handle) return;
    this.observeSchema();
    this.updateCapabilities();
    this.queueSaved();
    this.emit();
  }
  /** Whether the comments document failed to open; the Page says so. */
  get commentsUnavailable() {
    return this.commentsOpen$.snapshot().name === "failed";
  }
  /** Try opening the comments document again, after a visible failure. */
  retryComments() {
    return this.commentsOpen({ type: "retry" });
  }
  actorDisplayName(actor) {
    return this.actorNames.get(actor) ?? "Collaborator";
  }
  changeIdentity(hash) {
    return this.changeIdentities.get(hash) ?? null;
  }
  actorIdentity(actor) {
    return this.actorProfiles.get(actor) ?? null;
  }
  /** The actor the host attested for this change hash, or null. */
  attestedActor(hash) {
    return this.attestedChanges.get(hash) ?? null;
  }
  /** Apply host-attested `actorProfiles` and `attestedChanges`. A snapshot
   * (the connect response, or a host message with `snapshot: true`) replaces
   * both maps; a delta adds entries, and a null profile retracts its actor and
   * every hash attested to it. A hash names only the profile it was attested
   * under: a profile that changes, or leaves the capped map, drops its actor's
   * earlier hashes. Malformed entries are dropped one by one. */
  receiveActorProfiles({ actorProfiles, attestedChanges } = {}, { replace = false } = {}) {
    const profiles = replace ? new Map() : this.actorProfiles;
    const changes = replace ? new Map() : this.attestedChanges;
    const retracted = new Set();
    const dropped = new Set();
    if (plainObject(actorProfiles))
      for (const [actor, value] of Object.entries(actorProfiles)) {
        const profile = actorProfile(value);
        if (!ACTOR_ID.test(actor) || profile === undefined) continue;
        const previous = profiles.get(actor);
        profiles.delete(actor);
        if (profile) profiles.set(actor, profile);
        else retracted.add(actor);
        if (
          !profile ||
          (previous &&
            (previous.principal !== profile.principal ||
              previous.displayName !== profile.displayName ||
              previous.driver !== profile.driver))
        )
          dropped.add(actor);
        if (profiles.size > MAX_ACTOR_PROFILES) {
          const oldest = profiles.keys().next().value;
          profiles.delete(oldest);
          dropped.add(oldest);
        }
      }
    if (dropped.size)
      for (const [hash, actor] of changes) if (dropped.has(actor)) changes.delete(hash);
    if (plainObject(attestedChanges))
      for (const [hash, actor] of Object.entries(attestedChanges)) {
        if (!CHANGE_HASH.test(hash) || typeof actor !== "string" || !ACTOR_ID.test(actor)) continue;
        if (retracted.has(actor)) continue;
        changes.delete(hash);
        changes.set(hash, actor);
        if (changes.size > MAX_ATTESTED_CHANGES) changes.delete(changes.keys().next().value);
      }
    this.actorProfiles = profiles;
    this.attestedChanges = changes;
    this.notify(this.presenceObservers);
  }
  watchPresence(fn) {
    this.presenceObservers.add(fn);
    return () => this.presenceObservers.delete(fn);
  }
  /** Share this tab's caret. It goes out with the next outbound send, after
   * the edits waiting with it, and only the newest value goes. */
  publishPresence(value) {
    this.presenceValue = value;
    this.outbound.publish(() => this.broadcastPresence());
  }
  broadcastPresence() {
    const value = this.presenceValue;
    if (
      this.handle &&
      this.alive &&
      !this.authRequired &&
      !this.presencePaused &&
      !this.accessDenied &&
      !this.accessReloadRequired
    )
      try {
        this.handle.broadcast({ kind: "selection", value });
      } catch (error) {
        this.problem = error.message;
        this.emit();
      }
  }
  clearPresence() {
    this.presencePaused = true;
    this.peers.clear();
    this.profiles = {};
    this.agentProgress.clear();
    this.agentPresence.clear();
    this.activityEpoch = null;
    this.activityRevision = -1;
    clearTimeout(this.activityTimer);
    this.activityTimer = undefined;
    this.notify(this.presenceObservers);
  }
  receiveActivity(message, { initial = false } = {}) {
    if (
      !this.alive ||
      this.authRequired ||
      this.presencePaused ||
      this.accessDenied ||
      this.accessReloadRequired
    )
      return false;
    const snapshot = activitySnapshot(message, this.now());
    if (
      !snapshot ||
      (!initial &&
        (snapshot.epoch !== this.activityEpoch || snapshot.revision <= this.activityRevision))
    )
      return false;
    this.activityEpoch = snapshot.epoch;
    this.activityRevision = snapshot.revision;
    this.agentProgress = snapshot.progress;
    this.agentPresence = snapshot.agents;
    this.expireActivity();
    this.notify(this.presenceObservers);
    return true;
  }
  expireActivity() {
    clearTimeout(this.activityTimer);
    this.activityTimer = undefined;
    const now = this.now();
    let removed = false;
    for (const items of [this.agentProgress, this.agentPresence])
      for (const [id, item] of items) {
        if (item.until <= now) {
          items.delete(id);
          removed = true;
        }
      }
    if (removed) this.notify(this.presenceObservers);
    const pending = [...this.agentProgress.values(), ...this.agentPresence.values()];
    if (pending.length) {
      const next = Math.min(...pending.map((item) => item.until));
      this.activityTimer = setTimeout(() => this.expireActivity(), Math.max(1, next - now));
      this.activityTimer.unref?.();
    }
  }
  replacePeerProfiles(profiles) {
    this.profiles = { ...profiles };
    let removed = false;
    for (const peer of this.peers.keys())
      if (!Object.hasOwn(this.profiles, peer)) {
        this.peers.delete(peer);
        removed = true;
      }
    if (removed) this.notify(this.presenceObservers);
  }
  ephemeral({ senderId, message }) {
    if (
      !this.alive ||
      this.authRequired ||
      this.presencePaused ||
      this.accessDenied ||
      this.accessReloadRequired ||
      !message ||
      typeof message !== "object"
    )
      return;
    // The sender id is the peer id the native backend reports for the
    // message. The host's id names the signing key this session's transport
    // handshake verified against the connect response's serverPeerId, and a
    // message sent directly over that transport carries it. Relayed messages
    // keep the publishing peer's id, but whether native authenticates the
    // origin of each relayed message is not shown here; it rests on the
    // native ephemeral guarantee, which the memo still lists as untested for
    // multi-hop presence.
    if (senderId === this.connection?.serverSenderId) {
      if (message.kind === "page-activity") {
        this.receiveActivity(message);
        return;
      }
      if (message.kind === "identity-profiles") {
        this.replacePeerProfiles(message.peerProfiles);
        return;
      }
      if (message.kind === "actor-profiles") {
        this.receiveActorProfiles(message, { replace: message.snapshot === true });
        return;
      }
      if (message.kind === "tool-edit" && Array.isArray(message.heads)) {
        this.toolHints.push(message);
        this.toolHints = this.toolHints.slice(-64);
        this.resolveToolHints();
        return;
      }
    }
    if (message.kind !== "selection" || senderId === this.senderId) return;
    const profile = this.profiles[senderId];
    if (!profile) return;
    const value = message.value;
    if (
      value &&
      typeof value.block_id === "string" &&
      value.block_id.length <= 128 &&
      typeof value.start === "string" &&
      value.start.length <= 512 &&
      typeof value.end === "string" &&
      value.end.length <= 512 &&
      Array.isArray(value.heads) &&
      value.heads.length <= 100 &&
      value.heads.every((head) => typeof head === "string" && /^[0-9a-f]{64}$/.test(head))
    ) {
      this.peers.set(senderId, {
        value,
        at: this.now(),
        displayName: presenceLabel(profile),
        profile: {
          principal: profile.principal,
          displayName: profile.displayName,
          driver: profile.driver,
        },
      });
    } else if (value === null) this.peers.delete(senderId);
    this.notify(this.presenceObservers);
  }
  resolveToolHints() {
    this.toolHints = this.toolHints.filter((message) => {
      let pending = false;
      const display = [message.identity?.displayName, message.identity?.driver]
        .filter(Boolean)
        .join(" · ");
      for (const head of message.heads) {
        try {
          const meta = A.inspectChange(this.doc, head);
          if (meta && display) {
            this.actorNames.set(meta.actor, display);
            const who = {
              principal: message.identity?.principal,
              displayName: message.identity?.displayName,
              driver: message.identity?.driver,
              agent: typeof message.identity?.agent === "string" ? message.identity.agent : null,
              session:
                typeof message.identity?.session === "string" &&
                /^[0-9a-f]{16}$/.test(message.identity.session)
                  ? message.identity.session
                  : null,
            };
            this.changeIdentities.set(head, who);
            if (this.changeIdentities.size > 512)
              this.changeIdentities.delete(this.changeIdentities.keys().next().value);
          } else pending = true;
        } catch {
          pending = true;
        }
      }
      return pending;
    });
  }
  /** Start a receipt for the current heads. `edit` when a local edit moved
   * them; remote changes, reconnects and retries only sync. */
  queueSaved({ restart = false, edit = false } = {}) {
    if (!this.alive || this.deleted) return;
    const heads = this.handle ? A.getHeads(this.doc) : [];
    const commentHeads = this.commentsHandle ? A.getHeads(this.commentsDoc) : [];
    const blocked = !!(this.authRequired || this.accessDenied || this.accessReloadRequired);
    // Native reconnects and duplicate change events don't create new edits.
    // Keep their in-flight HTTP receipt and bounded retry budget intact.
    if (
      !restart &&
      this.receiptState &&
      this.receiptState.revision === this.receiptRevision &&
      this.receiptState.blocked === blocked &&
      !(this.receiptState.localOnly && this.connection) &&
      this.sameReceiptHeads(this.receiptState.heads, heads) &&
      this.sameReceiptHeads(this.receiptState.commentHeads ?? [], commentHeads)
    ) {
      this.showReceiptState();
      return;
    }
    this.cancelReceiptRetry();
    this.receiptRetryAttempts = 0;
    this.receiptRevision = (this.receiptRevision ?? 0) + 1;
    clearTimeout(this.savedTimer);
    // A reported outage stays on screen through new edits until a receipt
    // succeeds; any other receipt problem belongs to the frontier it was for.
    const outage = !!this.receiptState?.outage;
    if (!outage && !blocked && !this.localProblem && this.problem === this.receiptState?.problem)
      this.problem = "";
    this.receiptState = {
      revision: this.receiptRevision,
      heads,
      commentHeads,
      blocked,
      problem: outage ? SERVER_UNREACHABLE : "",
      outage,
    };
    this.syncStatus({ type: "queued", revision: this.receiptRevision, edit });
    this.showReceiptState();
    this.savedTimer = setTimeout(() => {
      this.savedTimer = undefined;
      void this.saveReceipt();
    }, 300);
  }
  sameReceiptHeads(left, right) {
    return left.length === right.length && left.every((head) => right.includes(head));
  }
  /** Step the sync-status machine and run its slow-save timer effects. A
   * rejected event changes nothing. */
  syncStatus(event) {
    const result = viewerSyncStatusMachine.step(this.sync$.snapshot(), event);
    if (result.rejected) return result;
    this.sync$.update(() => result.state);
    for (const effect of result.effects) {
      clearTimeout(this.slowSaveTimer);
      this.slowSaveTimer = undefined;
      if (effect.type === "startTimer")
        this.slowSaveTimer = setTimeout(() => {
          this.slowSaveTimer = undefined;
          if (!this.alive) return;
          if (this.syncStatus({ type: "elapsed", revision: effect.revision }).rejected) return;
          this.renderStatus();
          this.emit();
        }, effect.ms);
    }
    return result;
  }
  /** Show a `{ label, key, id, retry }` status from sync-status-machine.mjs. */
  showStatus({ label, key, id, retry = false }) {
    this.status = label;
    this.statusKey = key;
    this.statusId = id;
    this.statusRetry = retry;
  }
  /** Render `status` from the sync-status machine and the phase's pauses. */
  renderStatus() {
    this.showStatus(
      fullStatus(this.sync$.snapshot(), {
        deleted: this.deleted,
        accessDenied: this.accessDenied,
        accessReloadRequired: this.accessReloadRequired,
        authRequired: this.authRequired,
        localFailed: !!this.localProblem,
        localCopy: !!this.localPage,
      }),
    );
  }
  showReceiptState() {
    this.renderStatus();
    if (
      !this.authRequired &&
      !this.accessDenied &&
      !this.accessReloadRequired &&
      (this.localProblem || this.receiptState.problem || this.connectionProblem)
    )
      this.problem = this.localProblem || this.receiptState.problem || this.connectionProblem;
    this.emit();
  }
  cancelReceiptRetry() {
    clearTimeout(this.receiptRetryTimer);
    this.receiptRetryTimer = undefined;
  }
  /** Retry the receipt for `revision` after its bounded wait. `transient`
   * failures wait on the reconnect backoff (receiptRetryDelay). */
  scheduleReceiptRetry(revision, synchronize = false, transient = false) {
    const attempt = this.receiptRetryAttempts ?? 0;
    const delay = receiptRetryDelay(attempt, transient);
    if (
      !this.alive ||
      this.authRequired ||
      this.accessDenied ||
      this.accessReloadRequired ||
      this.deleted ||
      revision !== this.receiptRevision ||
      this.receiptRetryTimer ||
      delay === undefined
    )
      return;
    this.receiptRetryAttempts = attempt + 1;
    this.receiptRetryTimer = setTimeout(() => {
      this.receiptRetryTimer = undefined;
      if (
        this.alive &&
        !this.authRequired &&
        !this.accessDenied &&
        !this.accessReloadRequired &&
        !this.deleted &&
        revision === this.receiptRevision
      )
        void this.saveReceipt({ synchronize });
    }, delay);
  }
  async requestWithRenewal(url, options) {
    try {
      return await request(url, options);
    } catch (error) {
      if (error.status !== 401) throw error;
      await this.refreshAuthentication();
      if (!this.alive) throw Error("Page closed");
      try {
        return await request(url, options);
      } catch (retryError) {
        if (retryError.status === 401) this.requireSignIn();
        throw retryError;
      }
    }
  }
  /** Whether `state` names both documents' current heads. */
  receiptCurrent(state) {
    return (
      this.sameReceiptHeads(state.heads, A.getHeads(this.doc)) &&
      this.sameReceiptHeads(
        state.commentHeads ?? [],
        this.commentsHandle ? A.getHeads(this.commentsDoc) : [],
      )
    );
  }
  saveReceipt(options = {}) {
    if (!this.alive || !this.handle) return Promise.resolve();
    const heads = A.getHeads(this.doc);
    if (!this.receiptState || this.receiptState.revision !== this.receiptRevision) {
      this.receiptState = {
        revision: this.receiptRevision,
        heads,
        commentHeads: this.commentsHandle ? A.getHeads(this.commentsDoc) : [],
        blocked: !!(this.authRequired || this.accessDenied || this.accessReloadRequired),
        problem: "",
      };
      this.syncStatus({ type: "queued", revision: this.receiptRevision ?? 0, edit: false });
    } else if (!this.receiptCurrent(this.receiptState)) {
      this.queueSaved();
      return Promise.resolve();
    }
    const state = this.receiptState;
    // Debounce, reconnect, and retry callbacks can meet at the same frontier.
    if (this.activeReceipt?.state === state) return this.activeReceipt.promise;
    const promise = this.performSaveReceipt(state, options).finally(() => {
      if (this.activeReceipt?.state === state) this.activeReceipt = undefined;
    });
    this.activeReceipt = { state, promise };
    return promise;
  }
  async performSaveReceipt(state, { synchronize = false } = {}) {
    const revision = this.receiptRevision;
    const receipt = revision ?? 0;
    const isCurrent = () => {
      if (
        !this.alive ||
        this.deleted ||
        this.authRequired ||
        this.accessDenied ||
        this.accessReloadRequired ||
        revision !== this.receiptRevision ||
        state !== this.receiptState
      )
        return false;
      if (!this.receiptCurrent(state)) {
        // A change can reach the handle before its notification reaches us.
        this.queueSaved();
        return false;
      }
      return true;
    };
    try {
      await this.repo.flush();
      // Every store the flush waited for has asked to be sent. The host can
      // only acknowledge heads it has, so start their rounds now.
      this.outbound.flush();
      await this.persistLocal({ pending: true });
      if (!isCurrent()) return;
      if (this.problem === this.localProblem) this.problem = "";
      this.localProblem = "";
    } catch (error) {
      if (error.code === "LOCAL_PAGE_DELETED") {
        await this.markDeleted();
        return;
      }
      if (error.code === "LOCAL_PAGE_REVOKED") {
        await this.revoke();
        return;
      }
      if (error.code === "LOCAL_PAGE_ACCESS_CHANGED") {
        await this.localAccessChanged();
        return;
      }
      if (!isCurrent()) return;
      this.localProblem = this.problem = error.message;
      state.problem = error.message;
      this.renderStatus();
      this.emit();
      return;
    }
    try {
      if (!isCurrent()) return;
      if (this.localPage && !this.connection) {
        state.localOnly = true;
        this.syncStatus({ type: "stalled", revision: receipt, localCopy: true });
        this.renderStatus();
        this.emit();
        return;
      }
      if (synchronize) {
        // A native request can time out while its WebSocket stays open. Re-arm
        // catch-up on that authenticated connection without replacing the live
        // document or resetting this receipt's bounded retry budget.
        for (const handle of [this.handle, this.commentsHandle].filter(Boolean)) {
          const native = this.backend.open(documentIdToBinary(handle.documentId));
          try {
            await native.synchronize();
            if (!isCurrent()) return;
          } finally {
            await native.close();
          }
        }
        if (!isCurrent()) return;
      }
      // Native catch-up is not a durability receipt; the host must still
      // acknowledge these exact heads after its storage barrier.
      const heads = state.heads;
      const commentHeads = state.commentHeads ?? [];
      const result = await this.requestWithRenewal(
        `/api/saved?page=${encodeURIComponent(this.pageId)}`,
        {
          // A lost response must not leave the UI at Saving forever. The host
          // retains ownership of any persistence already in progress.
          signal: AbortSignal.timeout(30_000),
          method: "POST",
          headers: { "Content-Type": "application/json", ...admissionHeaders },
          // The host refuses a receipt for edits it won't accept because this
          // build lacks a feature the Page is stamped with.
          body: JSON.stringify({
            heads,
            ...(commentHeads.length && { comment_heads: commentHeads }),
            schema_features: this.buildFeatures,
          }),
        },
      );
      if (!isCurrent()) return;
      if (
        !Array.isArray(result?.durableHeads) ||
        (heads.length > 0 && result.durableHeads.length === 0) ||
        !result.durableHeads.every(
          (head) => typeof head === "string" && /^[0-9a-f]{64}$/.test(head),
        )
      )
        throw Error("Invalid durability receipt");
      // A successful receipt waits for these requested heads and flushes them.
      // The host frontier may already descend from them, so exact membership
      // in its newer durableHeads cannot decide whether this client is saved.
      this.savedHeads = heads;
      this.savedCommentHeads = commentHeads;
      if (this.problem === state.problem) this.problem = "";
      state.problem = "";
      state.outage = false;
      this.receiptOutageSince = null;
      this.syncStatus({ type: "acknowledged", revision: receipt });
      this.cancelReceiptRetry();
      this.receiptRetryAttempts = 0;
      await this.persistLocal({
        pending: false,
        ...(commentHeads.length && { comment_saved_heads: commentHeads }),
        localEdits: afterAcknowledgement(this.doc, this.localEditsWithActor(), heads, {
          replica: this.replicaId,
          actor: this.actor(),
        }),
      });
      if (!isCurrent()) return;
      this.showReceiptState();
    } catch (error) {
      if (isCurrent()) {
        if (error.code === "LOCAL_PAGE_DELETED") {
          await this.markDeleted();
          return;
        }
        if (error.code === "LOCAL_PAGE_REVOKED") {
          await this.revoke();
          return;
        }
        // The receipt route answers a missing Page as page_access_denied;
        // page_deleted reaches only the owner and current members.
        const refusal = classifyRefusal(error, { legacyMissing: false });
        if (refusal === "access" || refusal === "deleted") {
          await this.applyRefusal(refusal);
          return;
        }
        if (refusal) await this.applyRefusal(refusal);
        if (error.code === "schema_unsupported") {
          // Retrying can't help: these edits need a build with the feature.
          // The schema notice explains it; no second banner.
          this.stepSchema({ type: "refused" });
          this.syncStatus({ type: "stalled", revision: receipt, localCopy: !!this.localPage });
          this.renderStatus();
          this.showReceiptState();
          return;
        }
        if (error.status === 401) this.requireSignIn();
        if (!this.authRequired && !this.accessDenied && !this.accessReloadRequired) {
          this.syncStatus({ type: "stalled", revision: receipt, localCopy: !!this.localPage });
          this.renderStatus();
          if (isTransientFailure(error)) {
            // The host may be restarting: retry without a banner. It is an
            // outage once the run of transient failures has lasted
            // OUTAGE_MS, or this receipt's retries are spent; the next
            // admitted connection then restarts the receipt.
            const now = this.now();
            this.receiptOutageSince ??= now;
            state.outage =
              now - this.receiptOutageSince >= OUTAGE_MS ||
              receiptRetryDelay(this.receiptRetryAttempts ?? 0, true) === undefined;
            if (this.problem === state.problem) this.problem = "";
            state.problem = state.outage ? SERVER_UNREACHABLE : "";
            if (state.outage && !this.localProblem) this.problem = state.problem;
            this.scheduleReceiptRetry(revision, synchronize, true);
          } else {
            state.outage = false;
            state.problem = error.message;
            if (!this.localProblem) this.problem = error.message;
            if (!error.status || error.status === 409 || error.status >= 500)
              this.scheduleReceiptRetry(
                revision,
                synchronize || (error.status === 409 && error.message === MISSING_EDITS_MESSAGE),
              );
          }
        }
        this.showReceiptState();
      }
    }
  }
  /** Settles once the close and everything later added to it have settled,
   * then rejects with the close's failure, if any. This is the only way to
   * wait for a close: a late deletion can extend it after it starts, so it
   * reads the close again after each settle until the close stops changing.
   * Settles at once when nothing is closing. */
  async closeSettled() {
    for (;;) {
      const closing = this.#closing;
      const [result] = await Promise.allSettled([closing]);
      if (this.#closing !== closing) continue;
      if (result.status === "rejected") throw result.reason;
      return;
    }
  }
  /** Leave the session. Through the drain it keeps syncing until its
   * receipt or CLOSE_DRAIN_MS; otherwise it writes its final checkpoint at
   * once. Either way it then releases the backend. Returns closeSettled(). */
  leave({ drain = true } = {}) {
    // A retired copy's sockets are closed: nothing it queued may go out.
    if (this.alive) this.outbound.flush();
    const phase = this.phase$.snapshot();
    // An access reload owns this close: it ends after archiving and the
    // replacement open. If archiving fails, the replica is live again, so
    // leave it then.
    if (phase.name === "checkpointing" && phase.archive)
      this.#closing = this.#archiving.then(
        () => this.#released,
        () => {
          // This leave replaces #closing, so closeSettled() callers see its
          // failure. The returned promise is a second handle on it.
          if (this.alive) this.leave({ drain }).catch(() => {});
        },
      );
    // The host leaves a session once; a draining session is already leaving.
    else if (phase.name !== "draining") {
      const { rejected, done } = this.dispatch(
        { type: "leave", drain },
        drain ? undefined : () => this.#recordLeave(),
      );
      if (!rejected) this.#closing = done;
    }
    return this.closeSettled();
  }
  close() {
    return this.leave({ drain: false });
  }
  /** The owner restored this previewed Page: the reader preview leaves
   * through the drain so the writer replica can open. Returns the close, or
   * undefined when a paused preview can't restore. */
  restore() {
    const phase = this.phase$.snapshot().name;
    if (phase !== "open" && phase !== "paused") return undefined;
    this.outbound.flush();
    const { rejected, done } = this.dispatch({ type: "restore" });
    if (rejected) return undefined;
    this.#closing = done;
    return this.closeSettled();
  }
  async releaseLocal() {
    this.#localEpoch++;
    await this.disconnectSockets();
    try {
      await this.repo?.shutdown();
    } catch {}
    try {
      await this.backend?.close();
    } catch {}
    try {
      await this.storage?.close();
    } finally {
      try {
        this.signer?.free();
      } finally {
        this.local?.release();
        // The replica goes, and with it any comments lookup.
        this.commentsOpen({ type: "close" });
        this.repo = this.backend = this.storage = this.signer = this.local = undefined;
        this.commentsHandle = this.pendingComments = undefined;
      }
    }
  }
}
