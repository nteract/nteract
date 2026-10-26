import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { Repo, documentIdToBinary } from "@automerge/automerge-repo";
import { SubductionBackend, IndexedDBByteStore } from "@automerge/automerge-repo-subduction";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { applyComment } from "../model/comments.mjs";
import { createPageData, initializePage, projectPage } from "../model/page.mjs";
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
const accessFailure = () =>
  Object.assign(Error("Page access changed; reload its current version"), {
    code: "PAGE_ACCESS_CHANGED",
    status: 409,
  });
const bytes = (value) => Uint8Array.from(value.match(/../g), (v) => parseInt(v, 16));
export async function request(url, options = {}) {
  const response = await fetch(url, options),
    body = await response.json();
  if (!response.ok)
    throw Object.assign(
      Error(body.error?.message ?? body.error ?? `Request failed (${response.status})`),
      { status: response.status, code: body.code },
    );
  return body;
}
export function tool(operation, args = {}) {
  return request("/api/tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, arguments: args }),
  });
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
  profiles = {};
  actorNames = new Map();
  toolHints = [];
  alive = true;
  composing = 0;
  localDepth = 0;
  status = "Connecting";
  problem = "";
  savedHeads = [];
  authRequired = false;
  authProblem = "";
  accessProblem = "";
  accessDenied = false;
  accessReloadRequired = false;
  sockets = new Set();
  static async open(pageId, options) {
    const session = new PageSession(pageId, options);
    try {
      await session.start();
      return session;
    } catch (e) {
      // close() invalidates the session immediately, but draining native I/O can
      // outlast a failed lookup. Surface the opening error while cleanup keeps
      // ownership of the replica and its identity lock until it has finished.
      void session.close().catch(() => {});
      throw e;
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
    { refreshSession = () => request("/api/auth/session"), authentication } = {},
  ) {
    this.pageId = pageId;
    this.refreshSession = refreshSession;
    this.authentication = authentication;
  }
  get doc() {
    return this.handle?.doc();
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
    if (this.deleted || !this.alive) return;
    this.authRequired = true;
    void this.disconnectSockets();
    this.cancelReceiptRetry();
    this.receiptRevision = (this.receiptRevision ?? 0) + 1;
    this.authProblem = message;
    this.status = "Sign in to sync";
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.emit();
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
    if (this.authRequired && !this.accessDenied && !this.accessReloadRequired)
      this.status = "Reconnecting";
    this.authRequired = false;
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
    const enabled = !this.accessDenied && !this.accessReloadRequired;
    this.canWrite = enabled && !!this.credentialCanWrite && !!this.access?.canWrite;
    this.canComment = enabled && !!this.credentialCanWrite && !!this.access?.canComment;
    this.canManageAccess = enabled && !!this.credentialCanWrite && !!this.access?.canManageAccess;
    this.canDelete = enabled && !!this.credentialCanWrite && !!this.access?.canDelete;
  }
  get recoveryPending() {
    return (
      !!this.localPage?.pending ||
      (!!this.doc && !A.getHeads(this.doc).every((head) => this.savedHeads.includes(head)))
    );
  }
  disconnectSockets() {
    const sockets = [...this.sockets];
    this.sockets.clear();
    for (const socket of sockets) socket.close();
    return Promise.resolve();
  }
  socketDisconnected(socket) {
    // Intentional teardown removes the socket before close() can fire. A late
    // callback from that retired connection must not reconnect its successor.
    if (!this.sockets.delete(socket)) return;
    if (!this.alive || this.authRequired || this.accessDenied || this.accessReloadRequired) return;
    this.status = "Reconnecting";
    this.emit();
    this.scheduleReconnect();
  }
  pauseForAccess(message, { denied = false, checkpoint = true } = {}) {
    if (!this.alive || this.deleted) return;
    this.accessDenied = denied;
    this.accessReloadRequired = !denied;
    this.accessProblem = message;
    if (denied)
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
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.status = denied ? "Access removed" : "Access changed";
    void this.disconnectSockets();
    // Recovery stays local, even when the host no longer permits publication.
    if (checkpoint)
      void this.persistLocal({ access: this.access, pending: this.recoveryPending }).catch(
        (error) => {
          this.localProblem = this.problem = error.message;
          this.emit();
        },
      );
    this.emit();
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
          "Your permissions changed. Reload the current Page; unsynced edits remain available as a local draft.",
        );
        throw accessFailure();
      }
      if (this.localPage?.resetReplica) {
        // Another grant change can race the replacement's fetch. Advance only
        // its empty reset marker, never import retired history into this key.
        this.localPage = await prepareLocalPageReload(
          this.identity,
          this.localPage,
          access,
          nextKey,
        );
      }
      await this.releaseLocal();
      if (!this.alive) return;
      await this.initializeLocal(nextKey);
    }
    this.accessDenied = false;
    this.accessReloadRequired = false;
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
      return {
        title: page.title,
        markdown: `# ${page.title}\n\n${page.blocks.map((block) => block.markdown).join("\n\n")}\n`,
        snapshot: record?.snapshot ?? encodeSnapshot(A.save(doc)),
        page_id: this.pageId,
      };
    } finally {
      if (record) A.free(doc);
    }
  }
  async reloadForAccess() {
    if (!this.accessReloadRequired || !this.access?.canRead) throw accessFailure();
    if (!this.skipCloseCheckpoint) {
      if (!this.alive) throw Error("Page closed");
      // Keep a separate account-scoped recovery record before retiring any key.
      // The replacement fetches server history; it never re-signs this draft.
      await this.repo.flush();
      await this.persistLocal({ pending: this.recoveryPending });
      await prepareLocalPageReload(
        this.identity,
        this.localPage,
        this.access,
        replicaKey(this.access, this.credentialCanWrite && this.access.canWrite),
      );
      this.closedRecovery = this.exportRecovery();
      this.skipCloseCheckpoint = true;
      await this.close();
    }
    // Opening can fail while offline. Retry against the already-prepared reset
    // marker without touching the drained old backend or archiving again.
    return PageSession.open(this.pageId, {
      authentication: { identity: this.identity, canWrite: this.credentialCanWrite },
      refreshSession: this.refreshSession,
    });
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
    this.accessDenied = this.access?.role === "none";
    this.updateCapabilities();
    await this.initializeLocal(
      this.localPage?.replicaKey ?? replicaKey(this.access, this.canWrite),
    );
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
    } else if (this.localPage && !this.localPage.resetReplica) {
      // A checkpoint can contain more history than an ordinary edit batch.
      // Merge its bounded complete record set before exposing a handle; this
      // also retries any prefix left by an interrupted local import.
      const checkpoint = A.load(decodeSnapshot(this.localPage.snapshot));
      try {
        await this.backend.storeSnapshot(
          documentIdToBinary(this.localPage.document_id),
          extractRecords(checkpoint),
        );
      } finally {
        A.free(checkpoint);
      }
      this.handle = await this.repo.find(this.localPage.document_id);
      this.canWrite = !!this.canWrite && !!this.localPage.canWrite;
      if (!this.localPage.pending) this.savedHeads = A.getHeads(this.doc);
    } else {
      await this.connect(false);
      this.handle = await this.repo.find(this.connection.documentId, {
        signal: AbortSignal.timeout(15000),
      });
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
      };
      await writeLocalPage(this.identity, this.localPage);
    }
    this.handle.on("change", (event) => this.receiveChange(event));
    this.handle.on("ephemeral-message", (event) => this.ephemeral(event));
    if (this.accessDenied)
      this.accessProblem =
        "You no longer have access to this Page. Your local copy is kept on this device.";
    this.status = this.accessDenied
      ? "Access removed"
      : this.connection
        ? "Connected"
        : "Saved locally";
    this.presenceTimer = setInterval(() => {
      if (this.presenceValue) this.publishPresence(this.presenceValue);
    }, 10000);
    this.onlineListener = () => void this.retryConnection();
    globalThis.addEventListener?.("online", this.onlineListener);
    if (this.connection) this.queueSaved();
    else void this.retryConnection();
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
      );
    } catch (error) {
      if (!current()) return;
      // A denied/failed lookup is not evidence that this Page never existed.
      // Keep its local history and original request for a later attempt.
      if (error.status !== 404 || error.message !== "Page not found") throw error;
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
  async markDeleted() {
    if (this.deleted) return;
    this.deleted = true;
    this.canWrite = false;
    this.authRequired = false;
    this.status = "Deleted";
    this.problem = "This Page was deleted.";
    this.cancelReceiptRetry();
    this.emit();
    try {
      await forgetLocalPage(this.identity, this.pageId);
    } finally {
      await this.close();
    }
  }
  clearConnectionProblem() {
    if (this.problem === this.connectionProblem) this.problem = "";
    this.connectionProblem = "";
  }
  connect(refresh = true) {
    if (!this.alive || this.accessReloadRequired) return Promise.resolve();
    if (!this.connecting)
      this.connecting = this.openConnection(refresh).finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }
  async openConnection(refresh) {
    if (refresh) await this.refreshAuthentication();
    if (!this.alive || this.accessReloadRequired) return;
    await this.disconnectSockets();
    if (!this.alive) return;
    await this.registerDraft();
    if (!this.alive || this.authRequired || this.accessDenied || this.accessReloadRequired) return;
    try {
      const connection = await request(`/api/connect?page=${encodeURIComponent(this.pageId)}`);
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
      if (connection.recovery?.code === "page_recovery_blocked")
        this.problem = connection.recovery.message;
      if (this.localPage && !this.localPage.resetReplica)
        await this.persistLocal({ canWrite: this.canWrite });
      if (this.accessDenied || this.accessReloadRequired) return;
    } catch (error) {
      if (error.status === 404) await this.markDeleted();
      else if (this.alive && error.status === 401 && !this.authRequired) this.requireSignIn();
      else if (this.alive && error.status === 403)
        this.pauseForAccess(
          "You no longer have access to this Page. Your local copy is kept on this device.",
          { denied: true },
        );
      throw error;
    }
    if (!this.alive) return;
    this.replacePeerProfiles(this.connection.peerProfiles);
    const expected = new N.PeerId(bytes(this.connection.serverPeerId));
    const address = new URL(`/api/sync?page=${encodeURIComponent(this.pageId)}`, location.href);
    address.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    // Keep the browser socket itself: toTransport consumes the native wrapper,
    // whereas the raw socket remains cancellable when account/page access changes.
    const socket = new WebSocket(address);
    socket.binaryType = "arraybuffer";
    this.sockets.add(socket);
    try {
      const authenticated = await N.SubductionWebSocket.setup(socket, this.signer, expected, () => {
        this.socketDisconnected(socket);
      });
      if (!this.alive || this.accessDenied || this.accessReloadRequired) {
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
      if (!this.alive || this.accessDenied || this.accessReloadRequired) return;
      this.retryAttempts = 0;
      this.clearConnectionProblem();
      this.status = "Connected";
      this.emit();
      if (this.handle) this.queueSaved();
    } catch (error) {
      socket.close();
      this.sockets.delete(socket);
      throw error;
    } finally {
      expected.free();
    }
  }
  scheduleReconnect() {
    if (
      !this.alive ||
      this.authRequired ||
      this.accessDenied ||
      this.accessReloadRequired ||
      this.retryTimer
    )
      return;
    const delay = Math.min(10000, 500 * 2 ** (this.retryAttempts ?? 0));
    this.retryAttempts = (this.retryAttempts ?? 0) + 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.retryConnection();
    }, delay);
  }
  async retryConnection() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    try {
      await this.connect();
    } catch (error) {
      if (!this.alive || this.accessReloadRequired || this.accessDenied) return;
      if (error.code === "PAGE_ACCESS_CHANGED") return;
      if (error.status === 401) this.requireSignIn(this.authProblem || undefined);
      else if (error.status === 403)
        this.pauseForAccess(
          "You no longer have access to this Page. Your local copy is kept on this device.",
          { denied: true },
        );
      else {
        this.connectionProblem = error.message;
        if (!this.localProblem) this.problem = error.message;
        this.status = "Offline";
        this.emit();
        if (!error.status || error.status >= 500) this.scheduleReconnect();
      }
    }
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
      this.queueSaved();
      Promise.resolve(stored).catch((error) => {
        this.localProblem = error.message;
        this.problem = error.message;
        this.status = "Local save failed";
        this.emit();
      });
      return stored;
    } finally {
      this.localDepth--;
    }
  }
  comment(input) {
    return this.change((doc) => applyComment(doc, input, this.identity));
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
    if (this.handle && !this.accessDenied && !this.accessReloadRequired)
      try {
        this.handle.broadcast({ kind: "selection", value });
      } catch (error) {
        this.problem = error.message;
        this.emit();
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
    if (!message || typeof message !== "object") return;
    if (senderId === this.connection?.serverSenderId) {
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
        at: Date.now(),
        displayName: [profile.displayName, profile.driver].filter(Boolean).join(" · "),
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
  queueSaved() {
    if (!this.alive || this.deleted) return;
    this.cancelReceiptRetry();
    this.receiptRetryAttempts = 0;
    this.receiptRevision = (this.receiptRevision ?? 0) + 1;
    clearTimeout(this.savedTimer);
    this.status = this.accessDenied
      ? "Access removed"
      : this.accessReloadRequired
        ? "Access changed"
        : this.authRequired
          ? "Sign in to sync"
          : "Saving";
    this.emit();
    this.savedTimer = setTimeout(() => void this.saveReceipt(), 300);
  }
  cancelReceiptRetry() {
    clearTimeout(this.receiptRetryTimer);
    this.receiptRetryTimer = undefined;
  }
  scheduleReceiptRetry(revision, synchronize = false) {
    const delays = [500, 1000, 2000];
    const attempt = this.receiptRetryAttempts ?? 0;
    if (
      !this.alive ||
      this.authRequired ||
      this.accessDenied ||
      this.accessReloadRequired ||
      this.deleted ||
      revision !== this.receiptRevision ||
      this.receiptRetryTimer ||
      attempt >= delays.length
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
    }, delays[attempt]);
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
  async saveReceipt({ synchronize = false } = {}) {
    if (!this.alive || !this.handle) return;
    const revision = this.receiptRevision;
    const isCurrent = () =>
      this.alive &&
      !this.deleted &&
      !this.authRequired &&
      !this.accessDenied &&
      !this.accessReloadRequired &&
      revision === this.receiptRevision;
    try {
      await this.repo.flush();
      await this.persistLocal({ pending: true });
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
      if (!this.alive || revision !== this.receiptRevision) return;
      this.localProblem = this.problem = error.message;
      this.status = "Local save failed";
      this.emit();
      return;
    }
    try {
      if (!isCurrent()) return;
      if (this.localPage && !this.connection) {
        this.status = "Saved locally";
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
      const heads = A.getHeads(this.doc);
      const result = await this.requestWithRenewal(
        `/api/saved?page=${encodeURIComponent(this.pageId)}`,
        {
          // A lost response must not leave the UI at Saving forever. The host
          // retains ownership of any persistence already in progress.
          signal: AbortSignal.timeout(30_000),
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
      this.clearConnectionProblem();
      this.status = A.getHeads(this.doc).every((h) => this.savedHeads.includes(h))
        ? "Saved"
        : "Saving";
      if (this.status === "Saved") {
        this.cancelReceiptRetry();
        this.receiptRetryAttempts = 0;
        await this.persistLocal({ pending: false });
      }
      if (!isCurrent()) return;
      this.emit();
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
          this.connectionProblem = error.message;
          if (!this.localProblem) this.problem = error.message;
          this.status = this.localPage ? "Saved locally" : "Unsaved";
          if (!error.status || error.status === 409 || error.status >= 500)
            this.scheduleReceiptRetry(
              revision,
              synchronize || (error.status === 409 && error.message === MISSING_EDITS_MESSAGE),
            );
        }
        this.emit();
      }
    }
  }
  close() {
    this.closing ??= this.finishClose();
    return this.closing;
  }
  async finishClose() {
    this.alive = false;
    this.cancelReceiptRetry();
    clearTimeout(this.savedTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.presenceTimer);
    globalThis.removeEventListener?.("online", this.onlineListener);
    try {
      if (!this.deleted && !this.skipCloseCheckpoint) {
        await this.repo?.flush();
        await this.persistLocal({ pending: this.status !== "Saved" }, { allowClosed: true });
      }
    } catch (error) {
      if (error.code === "LOCAL_PAGE_DELETED") {
        this.deleted = true;
        this.canWrite = false;
        this.status = "Deleted";
        this.problem = "This Page was deleted.";
      } else if (error.code !== "LOCAL_PAGE_ACCESS_CHANGED") {
        this.problem = error.message;
        this.status = "Local save failed";
      }
    }
    await this.releaseLocal();
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
