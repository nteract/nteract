import { pageAccess, pageGrant } from "./access.mjs";

export const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export const logicalId = (bytes) => {
  const id = hex(bytes);
  return id.length === 64 && id.endsWith("0".repeat(32)) ? id.slice(0, 32) : id;
};
export class PermissionDenied extends Error {
  constructor(message = "Document access denied") {
    super(message);
    this.status = 403;
  }
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
    if (write && !identity.canWrite) throw new PermissionDenied("Credential is read-only");
    if (write && !access.canWrite) throw new PermissionDenied("Page is read-only");
    return access;
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
    if (persist) {
      for (const key of this.dirtyBindings) writes.push([key, this.bindings.get(key)]);
    }
    const results = await Promise.allSettled([
      ...writes.map(([key, binding]) =>
        Promise.resolve().then(async () => {
          await this.storage.put(`host/binding/${key}`, binding);
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

  async bind(key, senderId, identity, { reauthenticate, disconnect }) {
    const access = this.account(identity);
    if (this.metadata()?.aclCommitting)
      throw new PermissionDenied("Page access is being updated; reconnect");
    if (!/^[0-9a-f]{64}$/.test(key) || key === this.serverKey)
      throw new PermissionDenied("Invalid peer key");
    const previous = this.bindings.get(key);
    if (
      previous &&
      (previous.revoked ||
        previous.principal !== identity.principal ||
        previous.driver !== identity.driver)
    )
      throw new PermissionDenied("Signing key has another binding");
    if (this.sessions.has(key)) throw new PermissionDenied("Signing key is already connected");
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
    const session = {
      identity,
      generation: access.generation,
      role: access.role,
      canWrite: access.canWrite && binding.writer && !binding.retired,
      reauthenticate,
      disconnect,
      checkedAt: this.now(),
      checking: undefined,
    };
    // Reserve synchronously before storage yields, so a concurrent handshake
    // cannot overwrite a different account/driver or adopt this live lease.
    this.sessions.set(key, session);
    this.bindings.set(key, binding);
    let persisted = false;
    try {
      await this.storage.put(`host/binding/${key}`, { ...binding, pending: false });
      persisted = true;
      const current = this.account(identity);
      if (this.sessions.get(key) !== session || current.generation !== access.generation)
        throw new PermissionDenied("Page access changed during connection");
      binding.pending = false;
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      if (!persisted && this.bindings.get(key) === binding) {
        if (previous) this.bindings.set(key, previous);
        else this.bindings.delete(key);
      }
      throw error;
    }
    return () => {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    };
  }

  async active(key, write = false) {
    const session = this.sessions.get(key);
    const binding = this.bindings.get(key);
    if (!session || !binding || binding.revoked) throw new PermissionDenied("Unknown peer");
    try {
      this.account(session.identity, write);
      if (this.now() - session.checkedAt >= 15_000) {
        session.checking ??= (async () => {
          const renewed = await session.reauthenticate();
          if (
            renewed.principal !== session.identity.principal ||
            renewed.canWrite !== session.identity.canWrite
          )
            throw new PermissionDenied("Credential changed");
          this.account(renewed, write);
          session.checkedAt = this.now();
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
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
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
