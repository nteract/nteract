import * as A from "@automerge/automerge";
import { Repo, cbor, documentIdToBinary } from "@automerge/automerge-repo";
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree";
import { BACKEND_LIMITS, assertStoredSize } from "../model/limits.mjs";
import { documentFeatures, missingFeatures, schemaUnsupported } from "../model/schema-features.mjs";
import { AutomergeSyncBackend } from "../sync/backend.mjs";
import { BLOCKING, commentAdmission } from "../sync/comments.mjs";
import { DocStore, MemoryByteStore } from "../sync/doc-store.mjs";
import { Refusal, SyncHost } from "../sync/host.mjs";
import { framePipe, socketTransport } from "../sync/wire.mjs";
import {
  admissionCloseCode,
  admissionCode,
  logAdmissionDenied,
  withAdmissionReason,
} from "./admission-reasons.mjs";
import { PermissionDenied, credentialExpired } from "./policy.mjs";

// The Page host for `recordStorage: "automerge"` Pages: plain Automerge sync
// in place of Subduction. Browsers connect to a SyncHost (sync/host.mjs). The
// host's own Repo, which the rest of the Page host uses through its handles,
// runs AutomergeSyncBackend over memory and reaches the SyncHost through an
// in-process trusted connection, so its edits take the same admission queue
// and its durability barrier is a completed sync round. History and actor
// claims live in the Page's own storage under `plain/`.
//
// Access comes from DocumentPolicy.account(identity): the same ACL, trash,
// recovery and credential rules as native connections, checked on every frame
// and every delivery instead of through signing-key bindings.

const PREFIX = "plain/";
const BLOCKED = "host/comments-blocked/";
export const HOST_SENDER_ID = "pages-host";
const PUT_KEYS = 128;

/** SyncHost byte store over Durable Object storage, under `plain/`. */
export class PlainByteStore {
  constructor(storage) {
    this.storage = storage;
  }
  async load(key) {
    const value = await this.storage.get(PREFIX + key);
    return value === undefined ? undefined : new Uint8Array(value);
  }
  /** One put per 128 keys, in order. DocStore puts its manifest last, so a
   * split write never commits a manifest before the objects it names. */
  async saveMany(entries) {
    for (const [key, value] of entries) assertStoredSize(PREFIX + key, value.byteLength);
    for (let i = 0; i < entries.length; i += PUT_KEYS)
      await this.storage.put(
        Object.fromEntries(
          entries.slice(i, i + PUT_KEYS).map(([k, v]) => [PREFIX + k, new Uint8Array(v)]),
        ),
      );
  }
  async remove(key) {
    await this.storage.delete(PREFIX + key);
  }
  async list(prefix) {
    const result = [];
    let startAfter;
    do {
      const page = await this.storage.list({
        prefix: PREFIX + prefix,
        limit: 256,
        ...(startAfter && { startAfter }),
      });
      result.push(...[...page.keys()].map((key) => key.slice(PREFIX.length)));
      startAfter = page.size === 256 ? [...page.keys()].at(-1) : undefined;
    } while (startAfter);
    return result;
  }
}

const transportReason = (reason) =>
  reason === "frame_too_large" ? "native_frame_too_large" : "native_frame_unsupported";

/** The parts of pageAccess a live connection depends on. */
const accessShape = (access) => ({
  generation: access.generation,
  role: access.role,
  canWrite: access.canWrite,
  canComment: access.canComment,
  trashed: !!access.trashed,
});

export const treeOf = (documentId) => sedimentreeId(documentIdToBinary(documentId));

const SENDER_ID = /^b-[0-9a-f-]{36}$/;

/**
 * The presence id for a new browser socket, and the open connection it
 * replaces. A tab keeps its `sender` across reconnects, so a socket that asks
 * for an id held by the same principal and driver is that tab reconnecting,
 * usually after its old socket died without the close reaching the host: the
 * new socket takes the id and the old one is replaced, as a native signing
 * key replaces its stale session. A missing, malformed or foreign-held id is
 * replaced by a fresh one; ids are visible to every reader, so only the
 * holder's own principal and driver can claim one.
 */
export function plainSender(connections, identity, requested, mint) {
  if (typeof requested !== "string" || !SENDER_ID.test(requested))
    return { senderId: mint(), replaces: null };
  const holder = connections.find(
    (conn) => !conn.trusted && !conn.closed && conn.senderId === requested,
  );
  if (!holder) return { senderId: requested, replaces: null };
  if (holder.principal === identity.principal && holder.driver === identity.driver)
    return { senderId: requested, replaces: holder };
  return { senderId: mint(), replaces: null };
}

/** The close for a connection a newer socket from the same tab replaced. */
export function plainSessionReplaced() {
  return withAdmissionReason(
    new PermissionDenied("This tab connected again on another socket", "plain_session_replaced"),
    "plain_session_replaced",
  );
}

/** The close a refused connection gets, from an admission error. */
function refusalFrom(error, code = admissionCode(error)) {
  return new Refusal(code, error.message, {
    fatal: true,
    close: { code: admissionCloseCode(error), reason: admissionCode(error) },
  });
}

export class PlainSync {
  /**
   * `policy` is the Page's DocumentPolicy. `features(doc)` is that document's
   * schema stamp; `writeFence()` returns the refusal while the host holds peer
   * writes. `onRefused(conn, refusal)` logs; `onActors(delta)` publishes actor
   * profiles and attested changes.
   */
  constructor({
    storage,
    policy,
    now = Date.now,
    pageFeatures = () => [],
    writeFence = () => undefined,
    onRefused = () => {},
    onActors = () => {},
    onJoined = () => {},
  }) {
    this.storage = storage;
    this.pageFeatures = pageFeatures;
    this.policy = policy;
    this.now = now;
    this.writeFence = writeFence;
    this.onRefused = onRefused;
    this.onActors = onActors;
    this.blocked = new Set();
    this.recent = new Map();
    const guardComments = commentAdmission({
      isBlocked: (conn) => this.blocked.has(conn.principal),
    });
    this.host = new SyncHost({
      bytes: new PlainByteStore(storage),
      hostId: HOST_SENDER_ID,
      now,
      policy: {
        denied: (conn, at) => this.#denied(conn, at),
        canRead: () => true,
        canWrite: (conn, doc) => this.#canWrite(conn, doc),
        admit: async (conn, doc, live, fresh, preview, actorPrincipal) => {
          this.#gate(conn, doc, live, fresh);
          return guardComments(conn, doc, live, fresh, preview, actorPrincipal);
        },
        admitted: (conn, doc, fresh, claims) => this.#admitted(conn, doc, fresh, claims),
        joined: (conn, doc) => {
          if (!conn.trusted) onJoined(conn, doc);
        },
        refused: (conn, doc, refusal) => this.#refused(conn, doc, refusal),
      },
    });
  }

  /** Load claims and blocks, serve `documentIds`, and start the host's Repo. */
  async load(documentIds) {
    await this.host.load();
    for (const key of (await this.storage.list({ prefix: BLOCKED })).keys())
      this.blocked.add(key.slice(BLOCKED.length));
    this.backend = await AutomergeSyncBackend.load({
      store: new DocStore(new MemoryByteStore()),
      ...BACKEND_LIMITS,
    });
    this.repo = new Repo({ backend: this.backend });
    for (const [documentId, kind] of documentIds) this.serve(documentId, kind);
    const link = framePipe();
    this.host.accept(link.host, {
      trusted: true,
      principal: "service:pages",
      senderId: HOST_SENDER_ID,
    });
    this.backend.addConnection(link.client, { hostId: HOST_SENDER_ID });
    return this;
  }

  serve(documentId, kind) {
    this.host.register(treeOf(documentId), kind);
  }

  /**
   * Bring the host's Repo up to date with stored history for `documentId`.
   * Call before `repo.import` of a document that may already exist, so the
   * import merges into it instead of creating a second history.
   */
  async prime(documentId) {
    await this.#round(documentId, { create: true });
  }

  /** Every edit the host's Repo made to `documentIds` is stored. */
  async flush(documentIds) {
    await this.repo.flush(documentIds);
    await this.backend.flush();
    for (const documentId of documentIds) await this.#round(documentId);
  }

  async #round(documentId, { create = false } = {}) {
    const result = await this.backend.synchronizeTree(documentIdToBinary(documentId), { create });
    // A tree the host's Repo never touched has nothing to flush.
    if (result.outcome === "complete" || (!create && result.outcome === "no-peers")) return;
    throw Object.assign(new Error("The Page host couldn't store its edit; try again"), {
      status: 503,
    });
  }

  /** Durable heads of a document, from its stored manifest. */
  durableHeads(documentId) {
    return this.host.durableHeads(treeOf(documentId));
  }

  /** plainSender over this host's connections. */
  sender(identity, requested, mint = () => `b-${crypto.randomUUID()}`) {
    return plainSender(this.host.connections(), identity, requested, mint);
  }

  /** Accept an authenticated browser socket. Returns the connection. */
  accept(socket, identity, { features = [], senderId }) {
    const transport = socketTransport(socket, {
      onRejected: (reason) =>
        logAdmissionDenied(
          withAdmissionReason(
            Object.assign(new Error("Unsupported sync frame"), { status: 400 }),
            transportReason(reason),
          ),
          { stage: "native", identity },
        ),
    });
    const access = this.policy.account(identity);
    return this.host.accept(transport, {
      identity,
      principal: identity.principal,
      displayName: identity.displayName,
      driver: identity.driver,
      senderId,
      features,
      access: accessShape(access),
      role: access.role,
      expiresAt: this.policy.leaseExpiresAt(identity),
    });
  }

  /**
   * A successful credential renewal. Access must be unchanged. An API key's
   * lease moves to the renewed credential's deadline; OIDC keeps its original
   * absolute deadline, as native sessions do.
   */
  renew(conn, renewed) {
    const access = accessShape(this.policy.account(renewed));
    if (Object.keys(access).some((key) => access[key] !== conn.access[key]))
      throw new PermissionDenied("Page access changed during renewal", "native_access_changed");
    if (conn.identity.credentialKind === "api-key") {
      conn.identity = renewed;
      conn.expiresAt = this.policy.leaseExpiresAt(renewed);
    }
  }

  /** Re-check every browser connection now (after an ACL change). */
  refresh() {
    const now = this.now();
    for (const conn of this.host.connections()) {
      const denied = !conn.trusted && this.#denied(conn, now);
      if (denied) conn.transport.close(denied.close.code, denied.close.reason);
    }
  }

  /** `senderId → profile` for connected browsers, for presence labels. */
  profiles() {
    const now = this.now();
    const result = {};
    for (const conn of this.host.connections())
      if (!conn.trusted && !conn.closed && !this.#denied(conn, now))
        result[conn.senderId] = {
          principal: conn.principal,
          displayName: conn.displayName,
          driver: conn.driver,
        };
    return result;
  }

  /** Claimed actors and recently attested change hashes. */
  actorSnapshot() {
    const actorProfiles = {};
    for (const [actor, claim] of this.host.actors())
      if (typeof claim.principal === "string")
        actorProfiles[actor] = {
          principal: claim.principal,
          displayName: claim.displayName,
          driver: claim.driver,
        };
    return { actorProfiles, attestedChanges: Object.fromEntries(this.recent) };
  }

  /**
   * Purge: wait for the host's queued writes on `documentIds`, then delete
   * every key this mode stores for the Page (history, orphaned parts, actor
   * claims, comment blocks). Each delete is idempotent, so a retry after a
   * crash or a failed delete finishes the job.
   */
  async forget(documentIds) {
    for (const documentId of documentIds) await this.host.durableHeads(treeOf(documentId));
    for (const prefix of [PREFIX, BLOCKED]) {
      let keys;
      do {
        keys = [...(await this.storage.list({ prefix, limit: 128 })).keys()];
        if (keys.length) await this.storage.delete(keys);
      } while (keys.length === 128);
    }
    this.blocked.clear();
  }

  /** Close every browser connection. The host's Repo keeps running. */
  disconnectAll(code = 1001, reason = "Going away") {
    for (const conn of this.host.connections())
      if (!conn.trusted) conn.transport.close(code, reason);
  }

  async close() {
    this.disconnectAll();
    await this.repo?.shutdown();
  }

  #denied(conn, now) {
    if (conn.trusted) return null;
    if (conn.expiresAt !== undefined && conn.expiresAt <= now)
      return refusalFrom(credentialExpired());
    // As native sessions: any change to what this connection may do (losing
    // access, trash, a role or generation change, recovery) ends it with
    // access_changed, and the browser's rediscovery reports the new state.
    let access;
    try {
      access = accessShape(this.policy.account(conn.identity));
    } catch {
      access = null;
    }
    if (!access || Object.keys(access).some((key) => access[key] !== conn.access[key]))
      return refusalFrom(
        new PermissionDenied("Page access changed during connection", "native_access_changed"),
      );
    return null;
  }

  #canWrite(conn, doc) {
    try {
      this.policy.account(conn.identity, doc.kind === "comments" ? "comment" : true);
      return true;
    } catch {
      return false;
    }
  }

  /** Conversion fence, schema gate and history capacity, before comment rules. */
  #gate(conn, doc, live, fresh) {
    const fence = this.writeFence();
    if (fence) throw new Refusal(admissionCode(fence), fence.message);
    const stamps = [this.pageFeatures()];
    if (doc.kind === "comments") stamps.push(documentFeatures(live));
    for (const stamp of stamps) {
      const missing = missingFeatures(stamp, conn.features);
      if (missing.length) throw refusalFrom(schemaUnsupported(missing));
    }
    const manifest = this.host.store.manifest(doc.id);
    const stored =
      (manifest?.snapshot?.bytes ?? 0) + (manifest?.chunks ?? []).reduce((n, c) => n + c.bytes, 0);
    const added = fresh.reduce((n, c) => n + c.byteLength, 0);
    if (stored + added > BACKEND_LIMITS.maxSnapshotBytes)
      throw new Refusal("history_capacity", "This prototype limits document history to 16 MiB");
  }

  /** Send a host message on `doc` to its readers, as DocHandle.broadcast would
   * from the host's Repo, but synchronously, ahead of queued sync frames. */
  publish(doc, message) {
    this.host.broadcast(doc.id, {
      messageId: crypto.randomUUID(),
      origin: { kind: "repo", id: HOST_SENDER_ID },
      payload: new Uint8Array(cbor.encode(message)),
    });
  }

  #admitted(conn, doc, fresh, claims) {
    if (conn.trusted) return;
    const attested = {};
    for (const bytes of fresh) {
      const { hash, actor } = A.decodeChange(bytes);
      this.recent.delete(hash);
      this.recent.set(hash, actor);
      attested[hash] = actor;
    }
    while (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value);
    // Every actor these changes carry, not only new claims: a browser that
    // joined after an actor's claim has no profile for it yet.
    const actorProfiles = {};
    for (const actor of new Set(Object.values(attested))) {
      const claim = claims.get(actor) ?? this.host.actor(actor);
      if (typeof claim?.principal === "string")
        actorProfiles[actor] = {
          principal: claim.principal,
          displayName: claim.displayName,
          driver: claim.driver,
        };
    }
    // The Page document's readers hear who wrote its changes before they
    // receive them, as with native admission; comment authors aren't named.
    if (doc.kind === "page")
      this.publish(doc, {
        kind: "actor-profiles",
        actorProfiles,
        attestedChanges: attested,
      });
    this.onActors({ actorProfiles, attestedChanges: attested });
  }

  #refused(conn, doc, refusal) {
    if (
      doc.kind === "comments" &&
      BLOCKING.has(refusal.code) &&
      !this.blocked.has(conn.principal)
    ) {
      this.blocked.add(conn.principal);
      void this.storage
        .put(BLOCKED + conn.principal, { code: refusal.code, at: this.now() })
        .catch(() => {});
    }
    this.onRefused(conn, refusal);
  }
}
