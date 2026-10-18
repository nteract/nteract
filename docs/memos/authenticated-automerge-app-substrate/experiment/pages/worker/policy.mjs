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
 * This prototype has one private account grant. The CRDT never grants access.
 */
export class DocumentPolicy {
  constructor({ storage, metadata, serverKey, now = Date.now }) {
    this.storage = storage;
    this.metadata = metadata;
    this.serverKey = serverKey;
    this.now = now;
    this.bindings = new Map();
    this.sessions = new Map();
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
    const metadata = this.metadata();
    if (
      !metadata ||
      metadata.deleted ||
      identity.principal !== metadata.owner ||
      identity.expiresAt <= this.now()
    )
      throw new PermissionDenied();
    if (write && !identity.canWrite) throw new PermissionDenied("Credential is read-only");
  }

  async bind(key, senderId, identity, { reauthenticate, disconnect }) {
    this.account(identity);
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
    if (!previous && this.bindings.size >= 256)
      throw new PermissionDenied("This prototype permits 256 signing keys per document");
    const binding = {
      principal: identity.principal,
      displayName: identity.displayName,
      driver: identity.driver,
      senderId,
      writer: previous?.writer || identity.canWrite,
      revoked: false,
    };
    const session = {
      identity,
      reauthenticate,
      disconnect,
      checkedAt: this.now(),
      checking: undefined,
    };
    // Reserve synchronously before storage yields, so a concurrent handshake
    // cannot overwrite a different account/driver or adopt this live lease.
    this.sessions.set(key, session);
    this.bindings.set(key, binding);
    try {
      await this.storage.put(`host/binding/${key}`, binding);
    } catch (error) {
      this.sessions.delete(key);
      if (previous) this.bindings.set(key, previous);
      else this.bindings.delete(key);
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
      return binding;
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
    if (
      !binding ||
      binding.revoked ||
      !binding.writer ||
      binding.principal !== this.metadata().owner
    )
      throw new PermissionDenied("Unknown document author");
  }

  profiles() {
    return Object.fromEntries(
      [...this.bindings.values()]
        .filter((binding) => !binding.revoked)
        .map(({ senderId, principal, displayName, driver }) => [
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
