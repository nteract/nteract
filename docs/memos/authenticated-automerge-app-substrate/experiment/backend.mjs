import * as N from "@automerge/subduction";
import { Repo, documentIdToBinary } from "@automerge/automerge-repo";
import { SubductionBackend, MemoryByteStore } from "@automerge/automerge-repo-subduction";

export const hex = (bytes) => Buffer.from(bytes).toString("hex");
export const treeId = (documentId) => hex(documentIdToBinary(documentId));
const logicalId = (object) => {
  const id = hex(object.toBytes());
  return id.endsWith("0".repeat(32)) ? id.slice(0, 32) : id;
};

// Upstream passes owned WASM wrappers to policies. Release scalar arguments
// promptly. Allowed filter return values stay alive for native to inspect;
// upstream's generated finalizers reclaim those wrappers after use.
export function nativePolicy(policy, events = []) {
  const call = async (method, args) => {
    try {
      const value = await policy[method](...args);
      events.push({ method, args, allowed: true, result: value });
      return value;
    } catch (error) {
      events.push({ method, args, allowed: false, error: String(error) });
      throw error;
    }
  };
  return {
    async authorizeConnect(peer) {
      try {
        await call("authorizeConnect", [hex(peer.toBytes())]);
      } finally {
        peer.free();
      }
    },
    async authorizeFetch(peer, tree) {
      try {
        await call("authorizeFetch", [hex(peer.toBytes()), logicalId(tree)]);
      } finally {
        peer.free();
        tree.free();
      }
    },
    async authorizePut(requestor, author, tree) {
      try {
        await call("authorizePut", [
          hex(requestor.toBytes()),
          hex(author.toBytes()),
          logicalId(tree),
        ]);
      } finally {
        requestor.free();
        author.free();
        tree.free();
      }
    },
    async filterAuthorizedFetch(peer, ids) {
      try {
        const allowed = new Set(
          await call("filterAuthorizedFetch", [hex(peer.toBytes()), ids.map(logicalId)]),
        );
        return ids.filter((id) => {
          if (allowed.has(logicalId(id))) return true;
          id.free();
          return false;
        });
      } catch (error) {
        ids.forEach((id) => id.free());
        throw error;
      } finally {
        peer.free();
      }
    },
  };
}

export function nativeEphemeralPolicy(policy, events = []) {
  const call = async (method, args) => {
    try {
      const value = await policy[method](...args);
      events.push({ method, args, allowed: true, result: value });
      return value;
    } catch (error) {
      events.push({ method, args, allowed: false, error: String(error) });
      throw error;
    }
  };
  return {
    async authorizeSubscribe(peer, topic) {
      try {
        await call("authorizeSubscribe", [hex(peer.toBytes()), logicalId(topic)]);
      } finally {
        peer.free();
        topic.free();
      }
    },
    async authorizePublish(peer, topic) {
      try {
        await call("authorizePublish", [hex(peer.toBytes()), logicalId(topic)]);
      } finally {
        peer.free();
        topic.free();
      }
    },
    async filterAuthorizedSubscribers(topic, peers) {
      try {
        const allowed = new Set(
          await call("filterAuthorizedSubscribers", [
            logicalId(topic),
            peers.map((peer) => hex(peer.toBytes())),
          ]),
        );
        return peers.filter((peer) => {
          if (allowed.has(hex(peer.toBytes()))) return true;
          peer.free();
          return false;
        });
      } catch (error) {
        peers.forEach((peer) => peer.free());
        throw error;
      } finally {
        topic.free();
      }
    },
  };
}

// Transport alone is in process. Every handshake, signed record, CRDT update,
// authorization decision, and presence message runs through upstream WASM.
class ByteWire {
  frames = [];
  waiters = [];
  callbacks = new Set();
  closed = false;
  sentBytes = 0;
  static pair() {
    const left = new ByteWire(),
      right = new ByteWire();
    left.other = right;
    right.other = left;
    return [left, right];
  }
  async sendBytes(bytes) {
    if (this.closed) throw new Error("Wire closed");
    const copy = new Uint8Array(bytes);
    this.sentBytes += copy.length;
    const waiter = this.other.waiters.shift();
    if (waiter) waiter.resolve(copy);
    else this.other.frames.push(copy);
  }
  async recvBytes() {
    if (this.closed) throw new Error("Wire closed");
    if (this.frames.length) return this.frames.shift();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  onDisconnect(callback) {
    if (this.closed) callback();
    else this.callbacks.add(callback);
  }
  async disconnect() {
    if (this.closed) return;
    for (const wire of [this, this.other]) wire.closed = true;
    for (const wire of [this, this.other]) {
      wire.frames.length = 0;
      for (const waiter of wire.waiters.splice(0)) waiter.reject(new Error("Wire closed"));
      for (const callback of wire.callbacks) callback();
      wire.callbacks.clear();
    }
  }
}

export function createPeer({
  policy,
  ephemeralPolicy,
  storage = new MemoryByteStore(),
  seed,
} = {}) {
  const signer = seed ? N.MemorySigner.fromBytes(seed) : N.MemorySigner.generate();
  const nativeId = signer.peerId();
  const keyId = hex(signer.verifyingKey());
  const senderId = nativeId.toString();
  nativeId.free();
  const policyEvents = [],
    presencePolicyEvents = [];
  const backend = new SubductionBackend({
    signer,
    storage,
    syncTimeoutMilliseconds: 500,
    ...(policy && { policy: nativePolicy(policy, policyEvents) }),
    ...(ephemeralPolicy && {
      ephemeralPolicy: nativeEphemeralPolicy(ephemeralPolicy, presencePolicyEvents),
    }),
  });
  const repo = new Repo({ backend });
  return { signer, keyId, senderId, backend, repo, storage, policyEvents, presencePolicyEvents };
}

export async function connectPeers(left, right) {
  const wire = ByteWire.pair();
  const expected = right.signer.peerId();
  const wrappers = [];
  async function handshake(work) {
    try {
      const result = await work;
      wrappers.push(result);
      return result;
    } catch (error) {
      await wire[0].disconnect();
      throw error;
    }
  }
  try {
    const results = await Promise.allSettled([
      handshake(N.AuthenticatedTransport.setup(wire[0], left.signer, expected)),
      handshake(N.AuthenticatedTransport.accept(wire[1], right.signer)),
    ]);
    const [a, b] = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const added = await Promise.allSettled([
      left.backend.addConnection(a),
      right.backend.addConnection(b),
    ]);
    for (const result of added) if (result.status === "rejected") throw result.reason;
    return wire;
  } catch (error) {
    await wire[0].disconnect();
    throw error;
  } finally {
    wrappers.forEach((wrapper) => wrapper.free());
    expected.free();
  }
}

export async function closePeers(peers, wires = []) {
  await Promise.allSettled(wires.flat().map((wire) => wire.disconnect()));
  const repos = await Promise.allSettled(peers.map((peer) => peer.repo.shutdown()));
  const backends = await Promise.allSettled(peers.map((peer) => peer.backend.close()));
  peers.forEach((peer) => peer.signer.free());
  return [...repos, ...backends].filter((result) => result.status === "rejected");
}

export async function eventually(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  let error;
  do {
    try {
      const result = await check();
      if (result !== false) return result;
    } catch (caught) {
      error = caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw error ?? new Error("Condition did not become true");
}

export async function synchronize(peer, documentId) {
  const session = peer.backend.open(treeId(documentId));
  try {
    return await session.synchronize();
  } finally {
    await session.close();
  }
}
