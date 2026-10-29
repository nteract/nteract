import { pageAccess, pageGrant } from "./access.mjs";

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

export function admissionCancelled(code = "native_admission_cancelled") {
  return Object.assign(new Error("Native admission ended; reconnect"), { status: 503, code });
}

/** Durable authorship admission is distinct from a connection's live credential.
 * Host-owned grants and credential ceilings apply together. The CRDT never grants access.
 */
export class DocumentPolicy {
  constructor({ storage, metadata, serverKey, now = Date.now }) {
    this.storage = storage;
    this.metadata = metadata;
    this.serverKey = serverKey;
    this.now = now;
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

  account(identity, write = false) {
    const access = pageAccess(this.metadata(), identity, { now: this.now() });
    if (!access.canRead) throw new PermissionDenied();
    if (write && this.metadata()?.recoveryBlocked)
      throw Object.assign(
        new Error("Page recovery is blocked; accepted content is available read-only"),
        { status: 409, code: "page_recovery_blocked" },
      );
    if (write && !identity.canWrite) throw new PermissionDenied("Credential is read-only");
    if (write && !access.canWrite) throw new PermissionDenied("Page is read-only");
    return access;
  }

  leaseExpiresAt(identity) {
    const access = this.account(identity);
    return access.source === "domain"
      ? Math.min(identity.expiresAt, identity.domainAccess.expiresAt)
      : identity.expiresAt;
  }

  bindingGeneration(binding) {
    // Pre-ACL deployments admitted only the immutable owner.
    return binding.generation ?? (binding.principal === this.metadata()?.owner ? 0 : -1);
  }

  authorAllowed(binding) {
    if (!binding || binding.pending || binding.revoked || binding.retired || !binding.writer)
      return false;
    const grant = pageGrant(this.metadata(), binding.principal);
    return (
      ["owner", "editor"].includes(grant.role) &&
      this.bindingGeneration(binding) === grant.generation
    );
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
        (binding.writer && !["owner", "editor"].includes(grant.role));
      if (retire && !binding.retired) {
        const retired = { ...binding, writer: false, retired: true };
        this.bindings.set(key, retired);
        this.dirtyBindings.add(key);
      }
      const session = this.sessions.get(key);
      if (!session) continue;
      const access = pageAccess(this.metadata(), session.identity, { now: this.now() });
      if (
        !access.canRead ||
        session.generation !== access.generation ||
        session.role !== access.role ||
        session.canWrite !== (access.canWrite && this.authorAllowed(this.bindings.get(key)))
      ) {
        this.sessions.delete(key);
        disconnects.push(session.disconnect);
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
        access.canWrite !== claim.access.canWrite
      ) {
        claim.cancel(
          new PermissionDenied("Page access changed during connection", "native_access_changed"),
        );
        disconnects.push(claim.disconnect);
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
    { reauthenticate, disconnect, onRenewal = () => {}, signal, waitUntil = () => {} },
  ) {
    const access = this.account(identity);
    if (this.closed || signal?.aborted) throw signal?.reason ?? admissionCancelled();
    if (this.metadata()?.aclCommitting)
      throw new PermissionDenied(
        "Page access is being updated; reconnect",
        "native_acl_committing",
      );
    if (!/^[0-9a-f]{64}$/.test(key) || key === this.serverKey)
      throw new PermissionDenied("Invalid peer key");
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
        throw new PermissionDenied("This prototype permits 256 signing keys per document");
      if (identity.principal !== this.metadata()?.owner) {
        const bindings = [...this.bindings.values()];
        if (bindings.filter((binding) => binding.principal === identity.principal).length >= 32)
          throw new PermissionDenied("This prototype permits 32 signing keys per member");
        // Preserve owner admission even if several members fill their quotas.
        // Reader/retired bindings remain permanent: deleting them would let an
        // old key be admitted afresh and publish records it authored as a reader.
        if (
          bindings.filter((binding) => binding.principal !== this.metadata()?.owner).length >= 224
        )
          throw new PermissionDenied("Member signing-key capacity reached");
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
    const abort = () => claim.cancel(signal.reason ?? admissionCancelled());
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
        current.canWrite !== access.canWrite
      )
        throw new PermissionDenied(
          "Page access changed during connection",
          "native_access_changed",
        );
      const session = {
        identity,
        generation: current.generation,
        role: current.role,
        canWrite: current.canWrite && this.authorAllowed(this.bindings.get(key)),
        reauthenticate,
        disconnect,
        onRenewal,
        checkedAt: this.now(),
        checking: undefined,
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

  async active(key, write = false) {
    const session = this.sessions.get(key);
    const binding = this.bindings.get(key);
    if (!session || !binding || binding.revoked) throw new PermissionDenied("Unknown peer");
    try {
      this.account(session.identity, write);
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
          for (const access of [this.account(previous, write), this.account(renewed, write)]) {
            if (
              access.generation !== session.generation ||
              access.role !== session.role ||
              (access.canWrite && this.authorAllowed(binding)) !== session.canWrite
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
      this.account(session.identity, write);
      const current = this.bindings.get(key);
      if (write && !this.authorAllowed(current))
        throw new PermissionDenied("Signing key is read-only; reconnect with a new key");
      return current;
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      await session.disconnect();
      throw error;
    }
  }

  async access(key, tree, write = false) {
    const metadata = this.metadata();
    if (!metadata || metadata.deleted || metadata.tree !== tree) throw new PermissionDenied();
    if (key === this.serverKey) return;
    await this.active(key, write);
  }

  async put(requestor, author, tree) {
    await this.access(requestor, tree, true);
    if (author === this.serverKey) return;
    const binding = this.bindings.get(author);
    // A current writer may relay previously admitted author history. Author
    // credential expiry is not retroactive deletion; a reader's key or revoked
    // key never gains write authority through relay.
    if (!this.authorAllowed(binding)) throw new PermissionDenied("Unknown document author");
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
    await Promise.allSettled(sessions.map((session) => session.disconnect()));
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
