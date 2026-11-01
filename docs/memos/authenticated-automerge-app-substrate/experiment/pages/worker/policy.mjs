import { pageAccess, pageDecision, pageGrant, pageState } from "./access.mjs";
import { withAdmissionReason } from "./admission-reasons.mjs";
import { missingFeatures, schemaUnsupported } from "../model/schema-features.mjs";
import { COMMENTING_ROLES } from "../model/comment-rules.mjs";

/** The two documents a Page host serves. The Page document takes `edit`;
 * its comments document takes `comment`. One ACL governs both. */
export const PAGE_SCOPE = "page";
export const COMMENTS_SCOPE = "comments";
const EDITING_ROLES = ["owner", "editor"];

export const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export const logicalId = (bytes) => {
  const id = hex(bytes);
  return id.length === 64 && id.endsWith("0".repeat(32)) ? id.slice(0, 32) : id;
};
export class PermissionDenied extends Error {
  constructor(message = "Document access denied", code = "page_access_denied") {
    super(message);
    this.status = 403;
    this.code = code;
  }
}

export function credentialExpired() {
  const error = new PermissionDenied(
    "Document access denied: credential expired",
    "credential_expired",
  );
  error.status = 401;
  return error;
}

/** The owner gets a conflict for writes. Members learn only that the Page is
 * in Trash; anyone without a grant sees an ordinary denial.
 */
export function pageTrashed(access, grant) {
  if (access.canRead)
    return Object.assign(new Error("This Page is in Trash; restore it before changing it"), {
      status: 409,
      code: "page_trashed",
    });
  return ["viewer", "commenter", "editor"].includes(grant?.role)
    ? withAdmissionReason(
        new PermissionDenied("This Page is in its owner's Trash", "page_trashed"),
        "page_trashed",
      )
    : withAdmissionReason(new PermissionDenied(), "page_no_grant");
}

export function admissionCancelled(code = "native_admission_cancelled") {
  return Object.assign(new Error("Native admission ended; reconnect"), { status: 503, code });
}

/** Durable authorship admission is distinct from a connection's live credential.
 * Host-owned grants and credential ceilings apply together. The CRDT never grants access.
 *
 * A Page host serves two trees: the Page document (`metadata.tree`) and its
 * comments document (`commentsTree()`, once the Page record names one).
 * Reading either needs `read`. Writing the Page needs `edit`; writing the
 * comments document needs `comment`. A signing key's binding records what it
 * was admitted to author: `writer` for the Page, `commenter` for comments
 * (a writer may comment too). `commentsBlocked` marks a key whose comment
 * change failed the per-author check; it never authors comments again.
 */
export class DocumentPolicy {
  /** `schemaFeatures(scope)` reads that document's current schema stamp
   * (model/schema-features.mjs) for the native schema gate in put().
   * `commentsTree()` is the comments document's tree, or undefined. */
  constructor({
    storage,
    metadata,
    serverKey,
    now = Date.now,
    schemaFeatures = () => [],
    writeFence = () => undefined,
    commentsTree = () => undefined,
  }) {
    this.storage = storage;
    this.metadata = metadata;
    this.serverKey = serverKey;
    this.now = now;
    this.schemaFeatures = schemaFeatures;
    this.commentsTree = commentsTree;
    // Returns the refusal while the host holds peer writes, or undefined.
    this.writeFence = writeFence;
    this.bindings = new Map();
    this.sessions = new Map();
    this.admissions = new Map();
    this.bindingWrites = new Map();
    this.dirtyBindings = new Set();
  }

  async load() {
    this.bindings = new Map(
      [...(await this.storage.list({ prefix: "host/binding/" }))].map(([key, value]) => [
        key.slice(13),
        value,
      ]),
    );
  }

  /** `write` is false to read, true to edit the Page, or "comment" to write
   * its comments document. */
  account(identity, write = false) {
    const access = pageAccess(this.metadata(), identity, { now: this.now() });
    if (access.trashed && (!access.canRead || write))
      throw pageTrashed(access, pageGrant(this.metadata(), identity?.principal));
    if (!access.canRead) throw this.readDenied(identity);
    const comment = write === "comment";
    if (write && !comment && this.metadata()?.recoveryBlocked)
      throw Object.assign(
        new Error("Page recovery is blocked; accepted content is available read-only"),
        { status: 409, code: "page_recovery_blocked" },
      );
    if (write && !identity.canWrite) throw new PermissionDenied("Credential is read-only");
    if (comment && !access.canComment)
      throw new PermissionDenied("Commenting is not allowed on this Page");
    if (write && !comment && !access.canWrite) throw new PermissionDenied("Page is read-only");
    return access;
  }

  /** Which document `tree` names: PAGE_SCOPE, COMMENTS_SCOPE, or undefined. */
  scopeOf(tree) {
    const metadata = this.metadata();
    if (tree === metadata?.tree) return PAGE_SCOPE;
    const comments = this.commentsTree();
    if (comments && tree === comments) return COMMENTS_SCOPE;
    return undefined;
  }

  /** Classify a read denial for logs. Expiry is the only case with a distinct
   * client outcome; grant removal and no grant share the same response. */
  readDenied(identity) {
    if (!(Number.isFinite(identity?.expiresAt) && identity.expiresAt > this.now()))
      return credentialExpired();
    const members = this.metadata()?.acl?.members;
    return withAdmissionReason(
      new PermissionDenied(),
      members && Object.hasOwn(members, identity.principal)
        ? "page_access_removed"
        : "page_no_grant",
    );
  }

  /** The decision's own bound: the credential's expiry, or an earlier lease
   * (company view's email-domain proof) whose loss would change access. */
  leaseExpiresAt(identity) {
    this.account(identity);
    return pageDecision(this.metadata(), identity, { now: this.now() }).valid_until;
  }

  bindingGeneration(binding) {
    // Pre-ACL deployments admitted only the immutable owner.
    return binding.generation ?? (binding.principal === this.metadata()?.owner ? 0 : -1);
  }

  /** Whether `binding` may author records in `scope` now. */
  authorAllowed(binding, scope = PAGE_SCOPE) {
    if (!binding || binding.pending || binding.revoked || binding.retired) return false;
    const grant = pageGrant(this.metadata(), binding.principal);
    if (this.bindingGeneration(binding) !== grant.generation) return false;
    if (scope === COMMENTS_SCOPE)
      return (
        !binding.commentsBlocked &&
        (!!binding.writer || !!binding.commenter) &&
        COMMENTING_ROLES.includes(grant.role)
      );
    return !!binding.writer && EDITING_ROLES.includes(grant.role);
  }

  /** A session's write flags for `access`. */
  sessionWrites(access, binding) {
    return {
      canWrite: access.canWrite && this.authorAllowed(binding),
      canComment: access.canComment && this.authorAllowed(binding, COMMENTS_SCOPE),
    };
  }

  /** Retire lost writer authority synchronously, then persist and close leases.
   * Failed persistence never restores an in-memory writer. Grant generations
   * also reject old persisted bindings after an interrupted refresh/restart.
   */
  async refreshAccess({ persist = true } = {}) {
    const writes = [];
    const disconnects = [];
    for (const [key, binding] of this.bindings) {
      const grant = pageGrant(this.metadata(), binding.principal);
      const retire =
        this.bindingGeneration(binding) !== grant.generation ||
        (binding.writer && !EDITING_ROLES.includes(grant.role)) ||
        (binding.commenter && !COMMENTING_ROLES.includes(grant.role));
      if (retire && !binding.retired) {
        const retired = { ...binding, writer: false, retired: true };
        this.bindings.set(key, retired);
        this.dirtyBindings.add(key);
      }
      const session = this.sessions.get(key);
      if (!session) continue;
      const access = pageAccess(this.metadata(), session.identity, { now: this.now() });
      const writes = this.sessionWrites(access, this.bindings.get(key));
      if (
        !access.canRead ||
        session.generation !== access.generation ||
        session.role !== access.role ||
        session.canWrite !== writes.canWrite ||
        session.canComment !== writes.canComment
      ) {
        this.sessions.delete(key);
        disconnects.push(() =>
          session.disconnect(
            new PermissionDenied("Page access changed during connection", "native_access_changed"),
          ),
        );
      }
    }
    for (const admission of this.admissions.values()) {
      const claim = admission.claim;
      if (!claim) continue;
      const access = pageAccess(this.metadata(), claim.identity, { now: this.now() });
      if (
        !access.canRead ||
        access.generation !== claim.access.generation ||
        access.role !== claim.access.role ||
        access.canWrite !== claim.access.canWrite ||
        access.canComment !== claim.access.canComment
      ) {
        const changed = new PermissionDenied(
          "Page access changed during connection",
          "native_access_changed",
        );
        claim.cancel(changed);
        disconnects.push(() => claim.disconnect(changed));
      }
    }
    if (persist) {
      for (const key of this.dirtyBindings) writes.push([key, this.bindings.get(key)]);
    }
    const results = await Promise.allSettled([
      ...writes.map(([key, binding]) =>
        Promise.resolve().then(async () => {
          await this.writeBinding(key, { ...binding, pending: false });
          if (this.bindings.get(key) === binding) this.dirtyBindings.delete(key);
        }),
      ),
      ...disconnects.map((disconnect) => Promise.resolve().then(disconnect)),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Access refresh failed",
      );
  }

  writeBinding(key, binding) {
    // Retirement must follow an earlier admission write for this key. Access
    // restrictions apply synchronously, independently of this storage queue.
    const write = (this.bindingWrites.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.storage.put(`host/binding/${key}`, binding));
    const tracked = write.finally(() => {
      if (this.bindingWrites.get(key) === tracked) this.bindingWrites.delete(key);
    });
    this.bindingWrites.set(key, tracked);
    return tracked;
  }

  persistAdmission(admission, waitUntil) {
    admission.state = "pending";
    // bind has already fenced aclCommitting. Capture any prior retirement now:
    // an exact retry must not leave its original writer payload over that row.
    // Do not capture restrictions installed while this write is in flight,
    // because their host ACL may not have committed yet.
    const current = this.bindings.get(admission.key);
    const retirement =
      current.retired && !admission.payload.retired ? { ...current, pending: false } : undefined;
    if (retirement) this.dirtyBindings.add(admission.key);
    const persisted = this.writeBinding(admission.key, admission.payload).then(async () => {
      if (!retirement) return;
      await this.writeBinding(admission.key, retirement);
      if (this.bindings.get(admission.key) === current) this.dirtyBindings.delete(admission.key);
    });
    admission.promise = persisted.then(
      () => {
        admission.state = "persisted";
        // Finalize even if the socket that started the write is gone. Preserve
        // a retirement installed during the write instead of restoring authority.
        if (this.admissions.get(admission.key) === admission) {
          const current = this.bindings.get(admission.key);
          this.bindings.set(admission.key, { ...current, pending: false });
          if (!admission.claim) this.admissions.delete(admission.key);
        }
      },
      () => {
        // A rejected put does not prove that storage had no effect. Retain the
        // immutable identity, original author ceiling and quota reservation. A
        // later compatible attempt may retry this exact payload, never a new one.
        admission.state = "failed";
        throw Object.assign(new Error("Signing-key persistence failed; reconnect to retry"), {
          status: 503,
          code: "native_binding_persistence_failed",
        });
      },
    );
    // Socket cancellation must not abandon the outstanding persistence work.
    const observed = admission.promise.catch(() => {});
    waitUntil(observed);
  }

  async bind(
    key,
    senderId,
    identity,
    {
      reauthenticate,
      disconnect,
      onRenewal = () => {},
      signal,
      waitUntil = () => {},
      features = [],
    },
  ) {
    const access = this.account(identity);
    if (this.closed || signal?.aborted) throw signal?.reason ?? admissionCancelled();
    if (this.metadata()?.aclCommitting)
      throw new PermissionDenied(
        "Page access is being updated; reconnect",
        "native_acl_committing",
      );
    if (!/^[0-9a-f]{64}$/.test(key) || key === this.serverKey)
      throw withAdmissionReason(new PermissionDenied("Invalid peer key"), "native_invalid_key");
    const previous = this.bindings.get(key);
    if (
      previous &&
      (previous.revoked ||
        previous.principal !== identity.principal ||
        previous.driver !== identity.driver)
    )
      throw new PermissionDenied("Signing key has another binding", "native_binding_mismatch");
    if (this.sessions.has(key))
      throw new PermissionDenied("Signing key is already connected", "native_already_connected");
    let admission = this.admissions.get(key);
    if (admission?.claim)
      throw new PermissionDenied("Signing key admission is pending", "native_binding_pending");
    if (!previous) {
      if (this.bindings.size >= 256)
        throw withAdmissionReason(
          new PermissionDenied("This prototype permits 256 signing keys per document"),
          "native_key_capacity",
        );
      if (identity.principal !== this.metadata()?.owner) {
        const bindings = [...this.bindings.values()];
        if (bindings.filter((binding) => binding.principal === identity.principal).length >= 32)
          throw withAdmissionReason(
            new PermissionDenied("This prototype permits 32 signing keys per member"),
            "native_key_capacity",
          );
        // Preserve owner admission even if several members fill their quotas.
        // Reader/retired bindings remain permanent: deleting them would let an
        // old key be admitted afresh and publish records it authored as a reader.
        if (
          bindings.filter((binding) => binding.principal !== this.metadata()?.owner).length >= 224
        )
          throw withAdmissionReason(
            new PermissionDenied("Member signing-key capacity reached"),
            "native_key_capacity",
          );
      }
    }
    if (!admission) {
      const binding = {
        principal: identity.principal,
        displayName: identity.displayName,
        driver: identity.driver,
        senderId,
        generation: previous ? this.bindingGeneration(previous) : access.generation,
        // A key first admitted as a reader, or under an earlier grant, cannot
        // later publish the records it authored without write authority.
        writer: previous ? !!previous.writer && this.authorAllowed(previous) : access.canWrite,
        // The same rule for the comments document: a key admitted without
        // comment authority never gains it.
        commenter: previous
          ? !!(previous.commenter || previous.writer) &&
            this.authorAllowed(previous, COMMENTS_SCOPE)
          : access.canComment,
        ...(previous?.commentsBlocked && { commentsBlocked: true }),
        retired:
          !!previous?.retired ||
          (!!previous && this.bindingGeneration(previous) !== access.generation),
        revoked: false,
        pending: true,
      };
      admission = {
        key,
        payload: Object.freeze({ ...binding, pending: false }),
        state: "new",
        claim: null,
      };
      this.admissions.set(key, admission);
      this.bindings.set(key, binding);
    }
    let rejectCancelled;
    const cancelled = new Promise((_, reject) => {
      rejectCancelled = reject;
    });
    const claim = {
      identity,
      access,
      disconnect,
      cancel: (error) => {
        if (admission.claim !== claim) return;
        admission.claim = null;
        rejectCancelled(error);
      },
    };
    admission.claim = claim;
    const abort = () => {
      const reason = signal.reason ?? admissionCancelled();
      // A handshake deadline that expires while this key's binding write is
      // still unsettled is a storage stall, not a slow client.
      claim.cancel(
        reason?.code === "native_admission_timeout" && admission.state === "pending"
          ? admissionCancelled("native_binding_stalled")
          : reason,
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (admission.state !== "pending" && admission.state !== "persisted")
        this.persistAdmission(admission, waitUntil);
      await Promise.race([admission.promise, cancelled]);
      const current = this.account(identity);
      if (
        this.closed ||
        signal?.aborted ||
        admission.claim !== claim ||
        this.metadata()?.aclCommitting ||
        current.generation !== access.generation ||
        current.role !== access.role ||
        current.canWrite !== access.canWrite ||
        current.canComment !== access.canComment
      )
        throw new PermissionDenied(
          "Page access changed during connection",
          "native_access_changed",
        );
      const session = {
        identity,
        generation: current.generation,
        role: current.role,
        ...this.sessionWrites(current, this.bindings.get(key)),
        reauthenticate,
        disconnect,
        onRenewal,
        checkedAt: this.now(),
        checking: undefined,
        // The schema features this connection's build declared. They live on
        // the session, not the persisted binding: a tab keeps its signing key
        // across a reload, and the reloaded build declares its own features.
        features: Object.freeze([...features]),
      };
      this.sessions.set(key, session);
      return () => {
        if (this.sessions.get(key) === session) this.sessions.delete(key);
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      if (admission.claim === claim) admission.claim = null;
      if (
        admission.state === "persisted" &&
        !admission.claim &&
        this.admissions.get(key) === admission
      )
        this.admissions.delete(key);
    }
  }

  /** `write` is false, PAGE_SCOPE or COMMENTS_SCOPE (true means the Page). */
  async active(key, write = false) {
    const scope = write === true ? PAGE_SCOPE : write;
    const session = this.sessions.get(key);
    const binding = this.bindings.get(key);
    if (!session || !binding || binding.revoked) throw new PermissionDenied("Unknown peer");
    try {
      this.account(session.identity, scope === COMMENTS_SCOPE ? "comment" : !!scope);
      if (this.now() - session.checkedAt >= 15_000) {
        session.checking ??= (async () => {
          // Count cadence from the start so verifier latency cannot cause the
          // next fixed-interval tick to skip its check.
          const checkedAt = this.now();
          const previous = session.identity;
          const renewed = await session.reauthenticate();
          if (
            renewed.principal !== previous.principal ||
            renewed.canWrite !== previous.canWrite ||
            renewed.namespace !== previous.namespace ||
            renewed.driver !== previous.driver ||
            renewed.credentialKind !== previous.credentialKind
          )
            throw new PermissionDenied("Credential changed");
          // A verifier completing after expiry, disconnect, or an ACL change
          // cannot revive this lease or update a replacement connection.
          if (
            this.sessions.get(key) !== session ||
            this.bindings.get(key) !== binding ||
            binding.revoked
          )
            throw new PermissionDenied("Connection ended");
          const need = scope === COMMENTS_SCOPE ? "comment" : !!scope;
          for (const access of [this.account(previous, need), this.account(renewed, need)]) {
            const writes = this.sessionWrites(access, binding);
            if (
              access.generation !== session.generation ||
              access.role !== session.role ||
              writes.canWrite !== session.canWrite ||
              writes.canComment !== session.canComment
            )
              throw new PermissionDenied("Page access changed during renewal");
          }
          if (previous.credentialKind === "api-key") {
            session.identity = renewed;
            session.onRenewal(this.leaseExpiresAt(renewed));
          }
          // OIDC retains the original absolute session deadline.
          session.checkedAt = checkedAt;
        })().finally(() => {
          session.checking = undefined;
        });
        await session.checking;
      }
      if (this.sessions.get(key) !== session || this.bindings.get(key)?.revoked)
        throw new PermissionDenied("Connection ended");
      this.account(session.identity, scope === COMMENTS_SCOPE ? "comment" : !!scope);
      const current = this.bindings.get(key);
      if (scope && !this.authorAllowed(current, scope))
        throw new PermissionDenied("Signing key is read-only; reconnect with a new key");
      return current;
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      await session.disconnect(error);
      throw error;
    }
  }

  /** Check `key` against `tree`; resolves with the tree's scope. A write to
   * the comments tree needs `comment`, to the Page tree `edit`. */
  async access(key, tree, write = false) {
    const metadata = this.metadata();
    const scope = this.scopeOf(tree);
    // The owner may still read a trashed Page; account() denies everyone else.
    if (!metadata || pageState(metadata) === "deleted" || !scope) throw new PermissionDenied();
    if (key === this.serverKey) return scope;
    await this.active(key, write ? scope : false);
    return scope;
  }

  async put(requestor, author, tree) {
    const scope = await this.access(requestor, tree, true);
    if (author === this.serverKey) return;
    const binding = this.bindings.get(author);
    // A current writer may relay previously admitted author history. Author
    // credential expiry is not retroactive deletion; a reader's key or revoked
    // key never gains write authority through relay. A commenter's key
    // authors only the comments document.
    if (!this.authorAllowed(binding, scope)) throw new PermissionDenied("Unknown document author");
    // While the host converts preserved Markdown blocks, no peer record lands,
    // relayed or self-authored: either could be a competing conversion.
    const fence = this.writeFence();
    if (fence) throw fence;
    // The native schema gate. A peer's own edits arrive with itself as the
    // author; refuse them while its build lacks an id in the current stamp.
    // Records signed by another key are relayed history: the relay rule above
    // governs them, and the gate does not apply. Peers sync only with this
    // host, so such a record is one the host already accepted or one its
    // author published while admitted. Refusing every self-authored put is
    // acceptable: edits a stale tab made before the stamp stay in its local
    // store and sync after it reloads, because a reload keeps the tab's key
    // and the new build declares the feature. The one exception is an edit
    // to a preserved Markdown block, which the host converts itself. This
    // gate sees keys, not records, so the reloaded viewer sets such edits
    // aside before it connects (PageSession.recoverPreservedBlockEdits).
    if (requestor === author) {
      // The Page's stamp gates both documents: a build without the
      // comments-doc feature must not write either. The comments document's
      // own stamp gates its rich content.
      this.requireSchemaSupport(author, PAGE_SCOPE);
      if (scope === COMMENTS_SCOPE) this.requireSchemaSupport(author, COMMENTS_SCOPE);
    }
  }

  /** Throw `schema_unsupported` when the document's stamp names an id the
   * build connected as `key` didn't declare. A declaration is the client's
   * claim: this stops stale clients from writing what they can't express, not
   * hostile ones, whose edits write authority already bounds. */
  requireSchemaSupport(key, scope = PAGE_SCOPE) {
    const missing = missingFeatures(
      this.schemaFeatures(scope),
      this.sessions.get(key)?.features ?? [],
    );
    if (missing.length) throw withAdmissionReason(schemaUnsupported(missing), "schema_unsupported");
  }

  /** The principal and Page role a signing key was admitted as, or undefined
   * for an unknown key. The native comment check reads this for each record. */
  signer(key) {
    const binding = this.bindings.get(key);
    if (!binding) return undefined;
    return {
      principal: binding.principal,
      role: pageGrant(this.metadata(), binding.principal).role,
    };
  }

  /** A key whose comment change failed the per-author check authors no more
   * comments. Applied at once; the write persists it for restarts. Its
   * session closes on the next access refresh or the engine reset the
   * refusal causes. */
  async blockComments(key) {
    const binding = this.bindings.get(key);
    if (!binding || binding.commentsBlocked) return;
    const blocked = { ...binding, commentsBlocked: true };
    this.bindings.set(key, blocked);
    this.dirtyBindings.add(key);
    await this.writeBinding(key, { ...blocked, pending: false });
    if (this.bindings.get(key) === blocked) this.dirtyBindings.delete(key);
  }

  profiles() {
    return Object.fromEntries(
      [...this.bindings.entries()]
        .filter(([key, binding]) => {
          const session = this.sessions.get(key);
          if (!session || binding.pending || binding.retired || binding.revoked) return false;
          const access = pageAccess(this.metadata(), session.identity, { now: this.now() });
          return (
            access.canRead &&
            access.generation === session.generation &&
            access.role === session.role
          );
        })
        .map(([, { senderId, principal, displayName, driver }]) => [
          senderId,
          { principal, displayName, driver },
        ]),
    );
  }

  async close() {
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const admission of this.admissions.values()) {
      const claim = admission.claim;
      if (!claim) continue;
      claim.cancel(admissionCancelled());
      sessions.push(claim);
    }
    await Promise.allSettled(sessions.map((session) => session.disconnect(admissionCancelled())));
  }

  native() {
    return {
      authorizeConnect: async (peer) => {
        try {
          await this.active(hex(peer.toBytes()));
        } finally {
          peer.free();
        }
      },
      authorizeFetch: async (peer, tree) => {
        try {
          await this.access(hex(peer.toBytes()), logicalId(tree.toBytes()));
        } finally {
          peer.free();
          tree.free();
        }
      },
      authorizePut: async (requestor, author, tree) => {
        try {
          await this.put(
            hex(requestor.toBytes()),
            hex(author.toBytes()),
            logicalId(tree.toBytes()),
          );
        } finally {
          requestor.free();
          author.free();
          tree.free();
        }
      },
      filterAuthorizedFetch: async (peer, trees) => {
        try {
          const key = hex(peer.toBytes());
          const allowed = [];
          for (const tree of trees) {
            try {
              await this.access(key, logicalId(tree.toBytes()));
              allowed.push(tree);
            } catch {
              tree.free();
            }
          }
          return allowed;
        } finally {
          peer.free();
        }
      },
    };
  }

  ephemeral() {
    const access = async (peer, topic) => {
      try {
        await this.access(hex(peer.toBytes()), logicalId(topic.toBytes()));
      } finally {
        peer.free();
        topic.free();
      }
    };
    return {
      authorizeSubscribe: access,
      authorizePublish: access,
      filterAuthorizedSubscribers: async (topic, peers) => {
        try {
          const tree = logicalId(topic.toBytes());
          const allowed = [];
          for (const peer of peers) {
            try {
              await this.access(hex(peer.toBytes()), tree);
              allowed.push(peer);
            } catch {
              peer.free();
            }
          }
          return allowed;
        } finally {
          topic.free();
        }
      },
    };
  }
}
