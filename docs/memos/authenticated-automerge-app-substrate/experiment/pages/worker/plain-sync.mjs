import * as A from "@automerge/automerge";
import { cbor } from "@automerge/automerge-repo";
import { BACKEND_LIMITS, assertStoredSize } from "../model/limits.mjs";
import {
  BUILD_FEATURES,
  documentFeatures,
  missingFeatures,
  schemaUnsupported,
} from "../model/schema-features.mjs";
import { BLOCKING, commentAdmission } from "../sync/comments.mjs";
import { HostRepo, hostTreeOf } from "../sync/host-handle.mjs";
import { Refusal, SyncHost } from "../sync/host.mjs";
import { socketTransport } from "../sync/wire.mjs";
import {
  admissionCloseCode,
  admissionCode,
  logAdmissionDenied,
  withAdmissionReason,
} from "./admission-reasons.mjs";
import { ROUNDS_EMPTY, roundsStep } from "./plain-sync-log.mjs";
import { PermissionDenied, credentialExpired } from "./policy.mjs";

// The Page host's sync: plain Automerge sync, `recordStorage: "automerge"`.
// Browsers connect to a SyncHost (sync/host.mjs). The
// HostRepo facade gives worker code handles over that same live document.
// Trusted edits and durability barriers use SyncHost's admission queue.
// History and actor claims live in the Page's own storage under `plain/`.
//
// Access comes from DocumentPolicy.account(identity): the ACL, trash,
// recovery and credential rules, checked on every frame and every delivery.

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

/** Delete every key plain sync stores for a Page: history, orphaned parts,
 * actor claims and comment blocks. Idempotent. */
async function clearPlainStorage(storage) {
  await clearPrefixes(storage, [PREFIX, BLOCKED]);
}

/** Delete every key under each prefix, 128 at a time. Idempotent. */
export async function clearPrefixes(storage, prefixes) {
  for (const prefix of prefixes) {
    let keys;
    do {
      keys = [...(await storage.list({ prefix, limit: 128 })).keys()];
      if (keys.length) await storage.delete(keys);
    } while (keys.length === 128);
  }
}

export const treeOf = hostTreeOf;

const SENDER_ID = /^b-[0-9a-f-]{36}$/;

/**
 * The presence id for a new browser socket, and the open connection it
 * replaces. A tab keeps its `sender` across reconnects, so a socket that asks
 * for an id held by the same principal and driver is that tab reconnecting,
 * usually after its old socket died without the close reaching the host: the
 * new socket takes the id and the old one is replaced. A missing, malformed or foreign-held id is
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
   * `policy` is the Page's DocumentPolicy. `pageFeatures()` is the Page's
   * schema stamp. `onActors(delta)` publishes actor profiles and attested
   * changes.
   *
   * Reporting: `onRefused(conn, refusal, { doc, repeats })` for a refused
   * frame; a browser connection reports each reason once at once, and its
   * repeats once when the closed connection has nothing left running, so a
   * refusal for a frame still in flight at close is counted too. `onRounds(conn, summary)` reports a browser
   * connection's sync-round latency (plain-sync-log.mjs roundsStep).
   * `onCompactionFailed(doc, error)` reports a compaction that failed after
   * its frame was stored and acked.
   */
  constructor({
    storage,
    policy,
    now = Date.now,
    pageFeatures = () => [],
    commentAssertionsEnabled = () => false,
    onRefused = () => {},
    onRounds = () => {},
    onCompactionFailed = () => {},
    onActors = () => {},
    onJoined = () => {},
    onWrite = () => {},
  }) {
    this.storage = storage;
    this.pageFeatures = pageFeatures;
    this.policy = policy;
    this.now = now;
    this.onRefused = onRefused;
    this.onRounds = onRounds;
    this.onActors = onActors;
    this.onWrite = onWrite;
    this.blocked = new Set();
    this.recent = new Map();
    const guardComments = commentAdmission({
      isBlocked: (conn) => this.blocked.has(conn.principal),
      allowNewAssertions: commentAssertionsEnabled,
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
        admitTrusted: (doc, live, fresh, preview, context, conn, origin) => {
          if (!conn.trusted || !["mutate", "replay", "retry", "bridge"].includes(origin))
            throw new Refusal("request_rejected", "Invalid trusted admission context");
          // Host writers support BUILD_FEATURES, not a browser's advertised set.
          // Keep the history cap, and refuse unknown stored schema features so
          // an older host cannot edit a newer document blindly.
          // Already-admitted relays have no fresh bytes and never reach this
          // gate.
          this.#gate({ features: BUILD_FEATURES }, doc, live, fresh);
          return preview;
        },
        admitted: (conn, doc, fresh, claims) => this.#admitted(conn, doc, fresh, claims),
        joined: (conn, doc) => {
          if (!conn.trusted) onJoined(conn, doc);
        },
        refused: (conn, doc, refusal) => this.#refused(conn, doc, refusal),
        synced: (conn, _doc, round) => {
          if (!conn.trusted) this.#rounds(conn, { type: "round", ...round });
        },
        compactionFailed: (doc, error, attempt) => onCompactionFailed(doc, error, attempt),
        released: (conn) => this.#released(conn),
      },
    });
  }

  /** Load claims and blocks, serve `documentIds`, and expose the host handles. */
  async load(documentIds, { deleted = false } = {}) {
    const bytes = new PlainByteStore(this.storage);
    const savedPrefix = await bytes.load("host-actor-prefix");
    this.hostActorPrefix = savedPrefix
      ? cbor.decode(savedPrefix)
      : deleted
        ? undefined
        : Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
    if (!savedPrefix && !deleted)
      await bytes.saveMany([["host-actor-prefix", cbor.encode(this.hostActorPrefix)]]);
    this.host.hostActorPrefix = this.hostActorPrefix;
    await this.host.load();
    for (const key of (await this.storage.list({ prefix: BLOCKED })).keys())
      this.blocked.add(key.slice(BLOCKED.length));
    this.repo = new HostRepo(this.host);
    for (const [documentId, kind] of documentIds) this.serve(documentId, kind);
    return this;
  }

  serve(documentId, kind) {
    this.host.register(treeOf(documentId), kind);
  }

  /** Every admitted host edit to `documentIds` is stored. */
  async flush(documentIds) {
    await this.repo.flush(documentIds);
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
    const conn = this.host.accept(transport, {
      identity,
      principal: identity.principal,
      displayName: identity.displayName,
      driver: identity.driver,
      senderId,
      features,
      access: accessShape(access),
      role: access.role,
      expiresAt: this.policy.leaseExpiresAt(identity),
      rounds: ROUNDS_EMPTY,
      refusals: new Map(),
    });
    return conn;
  }

  #rounds(conn, event) {
    const { state, emit } = roundsStep(conn.rounds, event);
    conn.rounds = state;
    if (emit) this.onRounds(conn, emit);
  }

  /** A closed browser connection with nothing left running: its last rounds
   * and repeated refusals. */
  #released(conn) {
    conn.released = true;
    this.#rounds(conn, { type: "close" });
    for (const { count, refusal, doc } of conn.refusals.values())
      if (count > 1) this.onRefused(conn, refusal, { doc, repeats: count - 1 });
    conn.refusals.clear();
  }

  /**
   * A successful credential renewal. Access must be unchanged. An API key's
   * lease moves to the renewed credential's deadline; OIDC keeps its original
   * absolute deadline.
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
    await clearPlainStorage(this.storage);
    this.blocked.clear();
  }

  /** Close every browser connection. Host handles keep running. */
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
    // Any change to what this connection may do (losing
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

  /** Schema gate and history capacity, before comment rules. */
  #gate(conn, doc, live, fresh) {
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

  /** Send a host message to readers synchronously, ahead of queued sync frames. */
  publish(doc, message) {
    this.host.broadcast(doc.id, {
      messageId: crypto.randomUUID(),
      origin: { kind: "repo", id: HOST_SENDER_ID },
      payload: new Uint8Array(cbor.encode(message)),
    });
  }

  #admitted(conn, doc, fresh, claims) {
    if (conn.trusted) return;
    try {
      if (fresh.length) this.onWrite(conn, doc);
    } catch {
      // Usage reporting must not interrupt attestation or publication.
    }
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
    // receive them; comment authors aren't named.
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
    // A client that retries a refused frame refuses again; log the first,
    // count the rest until the closed connection is released.
    const counted = !conn.trusted && !conn.released && conn.refusals;
    const seen = counted && conn.refusals.get(refusal.code);
    if (seen) {
      seen.count++;
      return;
    }
    if (counted) conn.refusals.set(refusal.code, { count: 1, refusal, doc });
    this.onRefused(conn, refusal, { doc, repeats: 0 });
  }
}
