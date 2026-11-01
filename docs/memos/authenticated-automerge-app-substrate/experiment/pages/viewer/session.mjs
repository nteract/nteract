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
import { applyComment } from "../model/comments.mjs";
import { createPageData, initializePage, projectPage } from "../model/page.mjs";
import { unsentCommentsMarkdown } from "../model/markdown-export.mjs";
import {
  decodeSnapshot,
  encodeSnapshot,
  forgetLocalPage,
  readLocalPage,
  writeLocalPage,
  prepareLocalPageReload,
  listLocalRecoveries,
} from "./local-pages.mjs";
export { listLocalPages, forgetLocalPage } from "./local-pages.mjs";
import { BACKEND_LIMITS } from "../model/limits.mjs";
import { retryKey } from "../model/retry-key.mjs";
import { MISSING_EDITS_MESSAGE } from "../shared/receipts.mjs";
import { ADMISSION_CAPABILITY, admissionCloseOutcome } from "../shared/admission.mjs";
import { isTransientFailure, request } from "./request.mjs";
import { SERVER_UNREACHABLE } from "./alerts.mjs";
import { monotonicNow } from "./monotonic.mjs";
import { activitySnapshot } from "./activity.mjs";
import { checkpointRecords } from "./checkpoint-records.mjs";
import { Store } from "./store.mjs";
import { REJECT, isLive, pauseOf, viewerSessionMachine } from "./session-machine.mjs";
import {
  OUTAGE_ATTEMPTS,
  OUTAGE_MS,
  backoffStep,
  reconnectDelay,
  viewerReconnectMachine,
} from "./reconnect-machine.mjs";
import { statusLabel, viewerSyncStatusMachine } from "./sync-status-machine.mjs";
import {
  acknowledgedHeads,
  afterAcknowledgement,
  emptyLocalEdits,
  hasUnconfirmedLocalEdits,
  readLocalEdits,
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
const replicaKey = (access, writer) => `${access?.generation ?? 0}:${writer ? "writer" : "reader"}`;
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
// Longer than the host's 10-second native admission deadline. A socket that
// closes sooner never proved admission, so it must not reset reconnect backoff,
// and an admission close code on it counts as a refusal.
export const STABLE_CONNECTION_MS = 15_000;
// A Page being left keeps syncing this long for its receipt before closing.
export const CLOSE_DRAIN_MS = 10_000;
// Receipt states in which a Page being left may still save.
const DRAINING_STATES = new Set(["Connecting", "Reconnecting", "Syncing", "Saving"]);
const STALLED_STATES = new Set(["Unsaved", "Offline", "Saved locally"]);
/** A receipt status as the reload gate reads it. */
export const saveStateOf = (status) =>
  status === "Local save failed" ? "failed" : STALLED_STATES.has(status) ? "stalled" : "saving";
/** Settles once every promise has settled, then rejects with the first
 * failure. Later work never starts before earlier work finishes. */
const allSettledThen = (...promises) =>
  Promise.allSettled(promises).then((results) => {
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  });
/** Whether a Page being left may still save in this receipt state. */
export const drainingStatus = (status) => DRAINING_STATES.has(status);
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
export function pageSyncAddress(pageId, href, activityEpoch) {
  const address = new URL(`/api/sync?page=${encodeURIComponent(pageId)}`, href);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  if (activityEpoch) address.searchParams.set("activity_epoch", activityEpoch);
  return address;
}
async function exclusiveIdentity(scope) {
  const key = `pages-native:${scope}`;
  let seed = sessionStorage.getItem(key) || hex(crypto.getRandomValues(new Uint8Array(32)));
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
export class PageSession {
  listeners = new Set();
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
  toolHints = [];
  composing = 0;
  localDepth = 0;
  status = "Connecting";
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
  authProblem = "";
  accessProblem = "";
  sockets = new Set();
  socketOutcomes = new WeakMap();
  socketAdmittedAt = new WeakMap();
  // Reasons edits are held while the session keeps syncing: the reload gate's
  // "reload" and the build floor's "protocol". They are not lifecycle phases.
  editPauses = new Set();
  /** The session's phase (see session-machine.mjs). Every lifecycle flag
   * below derives from it, and effects run from its transitions. */
  phase$ = new Store(viewerSessionMachine.initial);
  /** Automatic reconnects (see reconnect-machine.mjs): backoff, a refused
   * signing key, or a pause after repeated admission refusals. `retryTimer`
   * is pending exactly while it is `waiting`. */
  reconnect$ = new Store(viewerReconnectMachine.initial);
  /** What the status line says about receipts and the connection (see
   * sync-status-machine.mjs). `status` renders it with the phase's pauses. */
  sync$ = new Store(viewerSyncStatusMachine.initial);
  // The close's work: checkpoint, release, and a late deletion's forget. It
  // can grow while it runs, so only closeSettled() waits on it.
  #closing;
  #released;
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
    } = {},
  ) {
    this.pageId = pageId;
    this.refreshSession = refreshSession;
    this.authentication = authentication;
    this.scheduler = scheduler;
    this.random = random;
    // The monotonic clock (monotonic.mjs) every elapsed-time rule here reads:
    // receipt outages, reconnect stability, and presence and agent-progress
    // lifetimes. Readers of `peers` and `agentProgress` use it too.
    this.now = now;
  }
  get doc() {
    return this.handle?.doc();
  }
  get alive() {
    return isLive(this.phase$.snapshot());
  }
  get deleted() {
    return this.phase$.snapshot().name === "deleted";
  }
  get authRequired() {
    return pauseOf(this.phase$.snapshot()).auth;
  }
  get accessDenied() {
    const phase = this.phase$.snapshot();
    // While opening, the cached access fact decides; a host answer pauses.
    if (phase.name === "opening") return this.access?.role === "none";
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
    return saveStateOf(this.status);
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
    const result = viewerSessionMachine.step(this.phase$.snapshot(), event);
    if (result.rejected) return result;
    this.phase$.update(() => result.state);
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
      case "forget": {
        const forgetting = this.forgetLocal();
        // Deleted after its release started: the close settles only once both
        // the forget and the release have, whichever fails.
        if (!this.phase$.snapshot().closing) return forgetting;
        this.#closing = allSettledThen(forgetting, this.#closing);
        return this.#closing;
      }
      case "rekey":
        return this.#rekey(context);
    }
    throw new Error(`unknown effect ${effect.type}`);
  }
  #saved() {
    if (this.deleted) return true;
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
      return this.#saved() || !drainingStatus(this.status);
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
        filter((phase) => phase.name === "closed" || (phase.name === "deleted" && phase.closing)),
      ),
    ).then(() => this.#released);
  }
  #stop() {
    this.clearPresence();
    this.cancelReceiptRetry();
    clearTimeout(this.savedTimer);
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
        await this.persistLocal({ pending: this.status !== "Saved" }, { allowClosed: true });
        written = !!this.localPage && !!this.handle;
      }
    } catch (error) {
      if (error.code === "LOCAL_PAGE_DELETED") deleted = true;
      else if (error.code !== "LOCAL_PAGE_ACCESS_CHANGED") {
        this.problem = error.message;
        this.status = "Local save failed";
      }
    }
    if (this.phase$.snapshot().name !== "checkpointing") return this.#whenReleased();
    const event = written ? { type: "checkpointOk" } : { type: "checkpointFail", deleted };
    return this.dispatch(event, () => {
      if (!deleted) return;
      this.canWrite = false;
      this.status = "Deleted";
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
      await this.persistLocal({ pending: this.recoveryPending });
      await prepareLocalPageReload(
        this.identity,
        this.localPage,
        this.access,
        replicaKey(this.access, this.credentialCanWrite && this.access.canWrite),
      );
      this.closedRecovery = this.exportRecovery();
    } catch (error) {
      if (archiving()) this.dispatch({ type: "checkpointFail", deleted: false });
      throw error;
    }
    if (!archiving()) throw Error("Page closed");
    return this.dispatch({ type: "checkpointOk" }).done;
  }
  #release() {
    this.#stop();
    this.checkpointSnapshot = this.checkpointHeads = undefined;
    return this.releaseLocal();
  }
  /** The forget effect: drop the local copy of a deleted Page, then close. */
  async forgetLocal() {
    const releasing = this.phase$.snapshot().closing === true;
    try {
      await forgetLocalPage(this.identity, this.pageId);
    } finally {
      if (!releasing) await this.close();
    }
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
  receiveChange(event) {
    if (!this.alive) return;
    this.resolveToolHints();
    const change = { ...event, remote: this.localDepth === 0 };
    if (this.composing && change.remote) this.deferredBefore ??= event.patchInfo.before;
    else this.notify(this.observers, change);
    if (change.remote) this.queueSaved();
    this.emit();
  }
  snapshot() {
    return this.doc ? projectPage(this.doc) : null;
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
      this.status = "Sign in to sync";
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
      this.replicaKey !== replicaKey(this.access, this.credentialCanWrite && this.access.canWrite)
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
    this.canWrite = enabled && !!this.credentialCanWrite && !!this.access?.canWrite;
    this.canComment = enabled && !!this.credentialCanWrite && !!this.access?.canComment;
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
      (!!this.doc && !A.getHeads(this.doc).every((head) => this.savedHeads.includes(head)))
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
      this.status = denied || trashed ? "Access removed" : "Access changed";
    });
    if (!rejected) this.emit();
  }
  async localAccessChanged() {
    const latest = await readLocalPage(this.identity, this.pageId);
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
      !["owner", "editor", "viewer", "none"].includes(access.role) ||
      !Number.isSafeInteger(access.generation) ||
      access.generation < 0 ||
      !Number.isSafeInteger(access.revision) ||
      access.revision < 0
    )
      throw Error("Invalid Page access response");
    this.access = { ...access };
    const nextKey = replicaKey(access, this.credentialCanWrite && access.canWrite);
    if (!access.canRead) {
      this.pauseForAccess(
        "You no longer have access to this Page. Your local copy is kept on this device.",
        { denied: true },
      );
      throw Object.assign(Error(this.accessProblem), { status: 403 });
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
  exportRecovery(record) {
    if (!record && this.closedRecovery) return { ...this.closedRecovery };
    const doc = record ? A.load(decodeSnapshot(record.snapshot)) : this.doc;
    if (!doc) throw Error("No local Page to export");
    try {
      const page = projectPage(doc);
      // Comments are part of the draft: list the ones the host never
      // acknowledged. An archived record has no receipt, so it lists them all.
      let saved = null;
      if (!record && this.savedHeads.length)
        try {
          saved = projectPage(A.view(doc, this.savedHeads));
        } catch {}
      return {
        title: page.title,
        markdown: `# ${page.title}\n\n${page.blocks.map((block) => block.markdown).join("\n\n")}\n${unsentCommentsMarkdown(page, saved)}`,
        snapshot: record?.snapshot ?? encodeSnapshot(A.save(doc)),
        heads: A.getHeads(doc),
        page_id: this.pageId,
      };
    } finally {
      if (record) A.free(doc);
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
    this.localPage = await readLocalPage(this.identity, this.pageId);
    if (creation && !this.credentialCanWrite) throw Error("This account cannot create Pages");
    this.access =
      this.localPage?.access ?? (creation || this.localPage ? ownerAccess() : undefined);
    this.updateCapabilities();
    await this.initializeLocal(
      this.localPage?.replicaKey ?? replicaKey(this.access, this.canWrite),
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
        localEdits: withActor(withActor(emptyLocalEdits(), A.getActorId(doc)), this.actor()),
        registration: {
          expected_principal: this.identity.principal,
          page_id: this.pageId,
          document_id: this.handle.documentId,
          initial_snapshot_base64: snapshot,
          title: this.doc.title,
          idempotency_key: `v1_${crypto.randomUUID()}`,
        },
      };
      await writeLocalPage(this.identity, this.localPage);
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
      this.handle = await this.repo.find(this.localPage.document_id);
      this.canWrite = !!this.canWrite && !!this.localPage.canWrite;
      // Native storage can hold an edit the checkpoint never saw, so decide
      // from the restored document. A record without localEdits predates
      // them; its receipt flag is all there is.
      const edits = readLocalEdits(this.localPage.localEdits);
      unconfirmed = edits ? hasUnconfirmedLocalEdits(this.doc, edits) : !!this.localPage.pending;
      // Without unconfirmed local edits, every change here is acknowledged or
      // came from the host.
      if (!unconfirmed) this.savedHeads = A.getHeads(this.doc);
      else if (edits) this.savedHeads = acknowledgedHeads(this.doc, edits);
      await this.recordActor(edits ?? { ...emptyLocalEdits(), unattributed: unconfirmed });
    } else {
      await this.connect(false);
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
        localEdits: withActor(emptyLocalEdits(), this.actor()),
      };
      await writeLocalPage(this.identity, this.localPage);
      unconfirmed = false;
    }
    this.handle.on("change", (event) => this.receiveChange(event));
    this.handle.on("ephemeral-message", (event) => this.ephemeral(event));
    if (this.accessDenied)
      this.accessProblem =
        "You no longer have access to this Page. Your local copy is kept on this device.";
    this.syncStatus({ type: "opened", pending: unconfirmed });
    this.renderStatus();
    // A pause while opening has already failed start().
    if (this.phase$.snapshot().name === "opening")
      this.dispatch({ type: "opened", denied: this.access?.role === "none" });
    this.presenceTimer = setInterval(() => {
      if (this.presenceValue) this.publishPresence(this.presenceValue);
    }, 10000);
    this.watchOnline();
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
  async initializeLocal(key = replicaKey(this.access, this.canWrite)) {
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
    this.local = await exclusiveIdentity(scope);
    this.signer = N.MemorySigner.fromBytes(bytes(this.local.seed));
    const peer = this.signer.peerId();
    this.senderId = peer.toString();
    peer.free();
    this.storage = new IndexedDBByteStore({
      database: `pages-native-${scope}-${this.local.seed.slice(0, 16)}`,
    });
    this.backend = new SubductionBackend({
      signer: this.signer,
      storage: this.storage,
      syncTimeoutMilliseconds: 1000,
      ...BACKEND_LIMITS,
    });
    this.repo = new Repo({ backend: this.backend });
  }
  /** This session's Automerge actor: every local edit it makes carries it. */
  actor() {
    return A.getActorId(this.doc);
  }
  /** Record this session's actor in the checkpoint before it can edit, so a
   * crash before the debounced checkpoint still reads its edits as local. */
  async recordActor(edits) {
    const recorded = withActor(edits, this.actor());
    if (recorded === edits && this.localPage.localEdits) return;
    this.localPage = await writeLocalPage(this.identity, {
      ...this.localPage,
      localEdits: recorded,
    });
  }
  persistLocal(patch = {}, { allowClosed = false } = {}) {
    if (this.deleted || (!this.alive && !allowClosed) || !this.localPage || !this.handle)
      return Promise.resolve();
    const heads = A.getHeads(this.doc).join(",");
    if (this.checkpointHeads !== heads) {
      this.checkpointSnapshot = encodeSnapshot(A.save(this.doc));
      this.checkpointHeads = heads;
    }
    const value = {
      title: this.doc.title,
      updated_at: new Date().toISOString(),
      snapshot: this.checkpointSnapshot,
      access: this.access,
      replicaKey: this.replicaKey,
      ...patch,
    };
    const work = (this.cacheTail ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        this.localPage = { ...this.localPage, ...value };
        this.localPage = await writeLocalPage(this.identity, this.localPage);
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
      this.status = "Deleted";
      this.problem = "This Page was deleted.";
      this.cancelReceiptRetry();
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
      const connection = await request(`/api/connect?page=${encodeURIComponent(this.pageId)}`, {
        headers: admissionHeaders,
      });
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
      if (this.localPage && !this.localPage.resetReplica)
        await this.persistLocal({ canWrite: this.canWrite });
      if (this.accessDenied || this.accessReloadRequired) return;
    } catch (error) {
      if (error.status === 404) await this.markDeleted();
      else if (this.alive && error.status === 401 && !this.authRequired) this.requireSignIn();
      else if (this.alive && error.status === 403)
        // A trashed Page can be restored, so keep the local copy either way.
        this.pauseForAccess(
          error.code === "page_trashed"
            ? "This Page is in its owner's Trash. Your local copy is kept on this device."
            : "You no longer have access to this Page. Your local copy is kept on this device.",
          error.code === "page_trashed" ? { trashed: true } : { denied: true },
        );
      throw error;
    }
    if (!this.alive) return;
    this.replacePeerProfiles(this.connection.peerProfiles);
    this.presencePaused = false;
    this.receiveActivity(this.connection.activity, { initial: true });
    const expected = new N.PeerId(bytes(this.connection.serverPeerId));
    // Pin admission to the host snapshot we just discovered. If that host
    // restarts before the upgrade, reconnect must discover its new epoch.
    const address = pageSyncAddress(this.pageId, location.href, this.activityEpoch);
    // Keep the browser socket itself: toTransport consumes the native wrapper,
    // whereas the raw socket remains cancellable when account/page access changes.
    const socket = new WebSocket(address);
    socket.binaryType = "arraybuffer";
    // Registered before the native wrapper's own listener, so the host's
    // admission outcome is known when the disconnect callback runs.
    socket.addEventListener("close", (event) => {
      const outcome = admissionCloseOutcome(event);
      if (outcome) this.socketOutcomes.set(socket, outcome);
    });
    this.sockets.add(socket);
    try {
      const authenticated = await N.SubductionWebSocket.setup(socket, this.signer, expected, () => {
        this.socketDisconnected(socket);
      });
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
        return;
      }
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
  /** Retry after a failed attempt or socket, unless the phase stops sync.
   * `refused` says the host's admission closed a socket that never proved
   * stable. Returns the reconnect state's name. */
  scheduleReconnect({ refused = false } = {}) {
    if (this.alive && !this.authRequired && !this.accessDenied && !this.accessReloadRequired)
      this.reconnect({ type: "failed", refused });
    return this.reconnect$.snapshot().name;
  }
  /** An explicit Retry, an online event, a re-authentication or a first
   * open: clear the backoff and any refusal or pause, then attempt now. */
  retryConnection(options) {
    this.reconnect({ type: "resume" });
    return this.attemptConnection(options);
  }
  /** One connection attempt. A failure that may pass schedules the next. */
  async attemptConnection({ recheckDeniedAccess = false, retryReceipt = false } = {}) {
    try {
      await this.connect(true, recheckDeniedAccess);
    } catch (error) {
      if (!this.alive || this.accessReloadRequired || this.accessDenied) return;
      if (error.code === "PAGE_ACCESS_CHANGED") return;
      if (error.admission?.retry === "stop") {
        this.refuseNative(error.admission);
        return;
      }
      if (error.status === 401) this.requireSignIn(this.authProblem || undefined);
      else if (error.status === 403)
        this.pauseForAccess(
          "You no longer have access to this Page. Your local copy is kept on this device.",
          { denied: true },
        );
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
    this.localDepth++;
    try {
      const stored = this.handle.change(fn);
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
  comment(input, nativeSpans) {
    return this.change((doc) => applyComment(doc, input, this.identity, nativeSpans));
  }
  actorDisplayName(actor) {
    return this.actorNames.get(actor) ?? "Collaborator";
  }
  watchPresence(fn) {
    this.presenceObservers.add(fn);
    return () => this.presenceObservers.delete(fn);
  }
  publishPresence(value) {
    this.presenceValue = value;
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
    if (senderId === this.connection?.serverSenderId) {
      if (message.kind === "page-activity") {
        this.receiveActivity(message);
        return;
      }
      if (message.kind === "identity-profiles") {
        this.replacePeerProfiles(message.peerProfiles);
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
        displayName: [profile.displayName, profile.driver].filter(Boolean).join(" · "),
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
          if (meta && display) this.actorNames.set(meta.actor, display);
          else pending = true;
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
    const blocked = !!(this.authRequired || this.accessDenied || this.accessReloadRequired);
    // Native reconnects and duplicate change events don't create new edits.
    // Keep their in-flight HTTP receipt and bounded retry budget intact.
    if (
      !restart &&
      this.receiptState &&
      this.receiptState.revision === this.receiptRevision &&
      this.receiptState.blocked === blocked &&
      !(this.receiptState.localOnly && this.connection) &&
      this.sameReceiptHeads(this.receiptState.heads, heads)
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
  /** Step the sync-status machine. A rejected event changes nothing. */
  syncStatus(event) {
    const result = viewerSyncStatusMachine.step(this.sync$.snapshot(), event);
    if (!result.rejected) this.sync$.update(() => result.state);
    return result;
  }
  /** Render `status` from the sync-status machine and the phase's pauses. */
  renderStatus() {
    this.status = statusLabel(this.sync$.snapshot(), {
      deleted: this.deleted,
      accessDenied: this.accessDenied,
      accessReloadRequired: this.accessReloadRequired,
      authRequired: this.authRequired,
      localFailed: !!this.localProblem,
      localCopy: !!this.localPage,
    });
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
  saveReceipt(options = {}) {
    if (!this.alive || !this.handle) return Promise.resolve();
    const heads = A.getHeads(this.doc);
    if (!this.receiptState || this.receiptState.revision !== this.receiptRevision) {
      this.receiptState = {
        revision: this.receiptRevision,
        heads,
        blocked: !!(this.authRequired || this.accessDenied || this.accessReloadRequired),
        problem: "",
      };
      this.syncStatus({ type: "queued", revision: this.receiptRevision ?? 0, edit: false });
    } else if (!this.sameReceiptHeads(this.receiptState.heads, heads)) {
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
      if (!this.sameReceiptHeads(state.heads, A.getHeads(this.doc))) {
        // A change can reach the handle before its notification reaches us.
        this.queueSaved();
        return false;
      }
      return true;
    };
    try {
      await this.repo.flush();
      await this.persistLocal({ pending: true });
      if (!isCurrent()) return;
      if (this.problem === this.localProblem) this.problem = "";
      this.localProblem = "";
    } catch (error) {
      if (error.code === "LOCAL_PAGE_DELETED") {
        await this.markDeleted();
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
        const native = this.backend.open(documentIdToBinary(this.handle.documentId));
        try {
          await native.synchronize();
          if (!isCurrent()) return;
        } finally {
          await native.close();
        }
        if (!isCurrent()) return;
      }
      // Native catch-up is not a durability receipt; the host must still
      // acknowledge these exact heads after its storage barrier.
      const heads = state.heads;
      const result = await this.requestWithRenewal(
        `/api/saved?page=${encodeURIComponent(this.pageId)}`,
        {
          // A lost response must not leave the UI at Saving forever. The host
          // retains ownership of any persistence already in progress.
          signal: AbortSignal.timeout(30_000),
          method: "POST",
          headers: { "Content-Type": "application/json", ...admissionHeaders },
          body: JSON.stringify({ heads }),
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
      if (this.problem === state.problem) this.problem = "";
      state.problem = "";
      state.outage = false;
      this.receiptOutageSince = null;
      this.syncStatus({ type: "acknowledged", revision: receipt });
      this.cancelReceiptRetry();
      this.receiptRetryAttempts = 0;
      await this.persistLocal({
        pending: false,
        localEdits: afterAcknowledgement(
          this.doc,
          withActor(readLocalEdits(this.localPage?.localEdits) ?? emptyLocalEdits(), this.actor()),
          heads,
        ),
      });
      if (!isCurrent()) return;
      this.showReceiptState();
    } catch (error) {
      if (isCurrent()) {
        if (error.code === "LOCAL_PAGE_DELETED") {
          await this.markDeleted();
          return;
        }
        if (error.status === 401) this.requireSignIn();
        if (error.status === 403)
          this.pauseForAccess(
            "You no longer have access to this Page. Your local copy is kept on this device.",
            { denied: true },
          );
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
    const { rejected, done } = this.dispatch({ type: "restore" });
    if (rejected) return undefined;
    this.#closing = done;
    return this.closeSettled();
  }
  async releaseLocal() {
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
        this.repo = this.backend = this.storage = this.signer = this.local = undefined;
      }
    }
  }
}
