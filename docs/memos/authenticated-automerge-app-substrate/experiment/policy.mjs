// Experimental host policy. Only the trusted host calls enrollment/ACL methods.
// Native Subduction verifies signatures before invoking these policy callbacks.
export class PermissionDenied extends Error {}

const roles = new Set(["none", "reader", "writer"]);
const profiles = new Set(["generic", "typed", "runtime"]);
const encoder = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
function keyBytes(key) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new PermissionDenied("Invalid signing key");
  return Uint8Array.from(key.match(/../g), (b) => Number.parseInt(b, 16));
}

export class AccessRegistry {
  #clock;
  #origin;
  #leaseMs;
  #isVerifiedIdentity;
  #challenges = new Map();
  #bindings = new Map();
  #revokedKeys = new Set();
  #documents = new Map();

  constructor({
    now = Date.now,
    origin = "https://spike.invalid",
    leaseMs = 60_000,
    isVerifiedIdentity = () => false,
  } = {}) {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Invalid lease");
    this.#clock = now;
    this.#origin = origin;
    this.#leaseMs = leaseMs;
    this.#isVerifiedIdentity = isVerifiedIdentity;
  }

  // identity must be returned by the host's verifier, never decoded request JSON.
  // The signed challenge binds a public key to that verified account and driver.
  beginBinding(identity, key) {
    keyBytes(key);
    if (this.#revokedKeys.has(key)) throw new PermissionDenied("Signing key was revoked");
    const now = this.#clock();
    if (
      !this.#isVerifiedIdentity(identity) ||
      !identity ||
      typeof identity.principal !== "string" ||
      !identity.principal ||
      typeof identity.driver !== "string" ||
      !identity.driver ||
      typeof identity.displayName !== "string" ||
      typeof identity.canWrite !== "boolean" ||
      !["oidc", "api-key"].includes(identity.credentialKind) ||
      !Number.isFinite(identity.expiresAt) ||
      identity.expiresAt <= now
    )
      throw new PermissionDenied("A current verified identity is required");
    for (const [id, entry] of this.#challenges) {
      if (entry.expiresAt <= now) this.#challenges.delete(id);
    }
    if (this.#challenges.size >= 256) throw new PermissionDenied("Too many enrollment challenges");
    const id = hex(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = Math.min(identity.expiresAt, now + 30_000);
    const leaseUntil = Math.min(identity.expiresAt, now + this.#leaseMs);
    const admitted = Object.freeze({ ...identity, expiresAt: leaseUntil, key });
    const message = encoder.encode(
      JSON.stringify({
        protocol: "nteract-authenticated-automerge-spike-v1",
        origin: this.#origin,
        id,
        key,
        principal: admitted.principal,
        driver: admitted.driver,
        expiresAt,
      }),
    );
    this.#challenges.set(id, {
      admitted,
      message,
      expiresAt,
    });
    return { id, message: message.slice() };
  }

  async finishBinding(id, signature) {
    const pending = this.#challenges.get(id);
    this.#challenges.delete(id); // Single-use even when proof is invalid.
    if (!pending || pending.expiresAt <= this.#clock())
      throw new PermissionDenied("Expired or consumed enrollment challenge");
    const publicKey = await crypto.subtle.importKey(
      "raw",
      keyBytes(pending.admitted.key),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, pending.message)))
      throw new PermissionDenied("Signing key possession was not proved");
    if (pending.expiresAt <= this.#clock()) throw new PermissionDenied("Enrollment expired");
    if (this.#revokedKeys.has(pending.admitted.key))
      throw new PermissionDenied("Signing key was revoked during enrollment");
    const previous = this.#bindings.get(pending.admitted.key);
    if (previous && previous.expiresAt > this.#clock())
      throw new PermissionDenied("Use a distinct signing key for each active driver session");
    this.#bindings.set(pending.admitted.key, pending.admitted);
    return pending.admitted;
  }

  getBinding(key) {
    const binding = this.#bindings.get(key);
    if (!binding || binding.expiresAt <= this.#clock())
      throw new PermissionDenied("Unknown, revoked, or expired signing key");
    return binding;
  }

  revokeKey(key) {
    this.#bindings.delete(key);
    this.#revokedKeys.add(key);
    for (const [id, pending] of this.#challenges)
      if (pending.admitted.key === key) this.#challenges.delete(id);
  }

  setDocument(id, { profile = "generic", grants = {}, runtimeWriters = [] } = {}) {
    // Native IDs with a zeroed final 16 bytes are the adapter's encoding of a
    // short legacy ID. Register that short ID, not an unreachable 32-byte alias.
    if (
      !/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(id) ||
      (id.length === 64 && id.endsWith("0".repeat(32))) ||
      !profiles.has(profile)
    )
      throw new Error("Invalid host document registration");
    if (this.#documents.has(id)) throw new Error("Document profile is already registered");
    const acl = new Map(grants instanceof Map ? grants : Object.entries(grants));
    for (const role of acl.values()) if (!roles.has(role)) throw new Error("Invalid role");
    this.#documents.set(id, { profile, acl, runtimeWriters: new Set(runtimeWriters) });
  }

  setRole(id, principal, role) {
    if (!roles.has(role)) throw new Error("Invalid role");
    const doc = this.#documents.get(id);
    if (!doc) throw new Error("Unknown document");
    doc.acl.set(principal, role);
  }

  #access(key, id, write = false) {
    const binding = this.getBinding(key);
    const doc = this.#documents.get(id);
    const role = doc?.acl.get(binding.principal) ?? "none";
    if (!doc || role === "none") throw new PermissionDenied("No access to document");
    if (write && (role !== "writer" || !binding.canWrite))
      throw new PermissionDenied("Document write is not permitted");
    if (write && doc.profile === "runtime" && !doc.runtimeWriters.has(binding.principal))
      throw new PermissionDenied("Runtime authority is required");
    return binding;
  }

  // Projection ignores all caller-supplied name/account/driver fields. The caller
  // must pass the signature-verified sender, not the envelope's claimed origin.
  presence(sender, documentId, payload) {
    const binding = this.#access(sender, documentId);
    const encoded = JSON.stringify(payload);
    if (!encoded || encoder.encode(encoded).byteLength > 4096)
      throw new PermissionDenied("Presence payload is too large");
    const anchor =
      payload && typeof payload.anchor === "string" ? payload.anchor.slice(0, 512) : null;
    return Object.freeze({
      principal: binding.principal,
      displayName: binding.displayName,
      driver: binding.driver,
      key: sender,
      anchor,
      expiresAt: Math.min(binding.expiresAt, this.#clock() + 10_000),
    });
  }

  policy() {
    return {
      authorizeConnect: (peer) => {
        this.getBinding(peer);
      },
      authorizeFetch: (peer, id) => {
        this.#access(peer, id);
      },
      authorizePut: (requestor, author, id) => {
        // Deliberately conservative: this cannot distinguish already-admitted
        // history from newly signed writes by an expired/revoked author. It
        // blocks both. Historical relay needs a separate durable admission
        // record or causal capability; current session leases are insufficient.
        this.#access(requestor, id, true);
        this.#access(author, id, true);
      },
      filterAuthorizedFetch: (peer, ids) =>
        ids.filter((id) => {
          try {
            this.#access(peer, id);
            return true;
          } catch (error) {
            if (error instanceof PermissionDenied) return false;
            throw error;
          }
        }),
    };
  }

  ephemeralPolicy() {
    return {
      authorizeSubscribe: (peer, topic) => {
        this.#access(peer, topic);
      },
      // Read-only collaborators can publish presence; content writes stay denied.
      authorizePublish: (peer, topic) => {
        this.#access(peer, topic);
      },
      filterAuthorizedSubscribers: (topic, peers) =>
        peers.filter((peer) => {
          try {
            this.#access(peer, topic);
            return true;
          } catch (error) {
            if (error instanceof PermissionDenied) return false;
            throw error;
          }
        }),
    };
  }
}
