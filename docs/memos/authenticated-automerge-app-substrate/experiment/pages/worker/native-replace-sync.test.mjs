// A Page host replaces a signing key's connection when the same tab connects
// again (native-session-machine.mjs). The native engine tracks connections by
// peer, and its addConnection reports whether the peer was "already
// connected". These tests run the real engine to show changes keep flowing on
// the replacement, in both directions, however the old connection's close
// interleaves with the new one's addConnection.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as N from "@automerge/subduction";
import { closePeers, connectPeers, createPeer, eventually } from "../../backend.mjs";

/** A byte wire pair like backend.mjs's, closed from either end. */
function wirePair() {
  const make = () => ({
    frames: [],
    waiters: [],
    callbacks: new Set(),
    closed: false,
    async sendBytes(bytes) {
      if (this.closed) throw new Error("Wire closed");
      const copy = new Uint8Array(bytes);
      const waiter = this.other.waiters.shift();
      if (waiter) waiter.resolve(copy);
      else this.other.frames.push(copy);
    },
    async recvBytes() {
      if (this.closed) throw new Error("Wire closed");
      if (this.frames.length) return this.frames.shift();
      return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    },
    onDisconnect(callback) {
      if (this.closed) callback();
      else this.callbacks.add(callback);
    },
    async disconnect() {
      if (this.closed) return;
      for (const wire of [this, this.other]) wire.closed = true;
      for (const wire of [this, this.other]) {
        wire.frames.length = 0;
        for (const waiter of wire.waiters.splice(0)) waiter.reject(new Error("Wire closed"));
        for (const callback of wire.callbacks) callback();
        wire.callbacks.clear();
      }
    },
  });
  const left = make(),
    right = make();
  left.other = right;
  right.other = left;
  return [left, right];
}

/** Connect `client` to `host`, with `beforeHostAdd` awaited after both
 * handshakes and the client's addConnection, and `duringHostAdd` run once the
 * host's addConnection has started. Returns the wire and both added flags. */
async function connectReplacement(client, host, { beforeHostAdd, duringHostAdd } = {}) {
  const wire = wirePair();
  const expected = host.signer.peerId();
  try {
    const [a, b] = await Promise.all([
      N.AuthenticatedTransport.setup(wire[0], client.signer, expected),
      N.AuthenticatedTransport.accept(wire[1], host.signer),
    ]);
    try {
      const clientAdded = await client.backend.addConnection(a);
      await beforeHostAdd?.();
      const adding = host.backend.addConnection(b);
      const during = duringHostAdd?.();
      const hostAdded = await adding;
      await during;
      return { wire, clientAdded, hostAdded };
    } finally {
      a.free();
      b.free();
    }
  } finally {
    expected.free();
  }
}

const ticks = async (count) => {
  for (let i = 0; i < count; i++) await Promise.resolve();
};
// "during" closes the old connection after a number of microtasks, or a
// macrotask, from the moment the host's addConnection starts, to land inside
// its inventory read, the engine's own addConnection, and the sync it starts.
const TIMINGS = [
  ["before", { beforeHostAdd: true }],
  ...[0, 1, 4, 16, 64].map((count) => [
    `during (${count} microtasks in)`,
    { duringHostAdd: () => ticks(count) },
  ]),
  ["during (a macrotask in)", { duringHostAdd: () => new Promise(setImmediate) }],
  ["after", {}],
];

for (const [timing, { beforeHostAdd, duringHostAdd }] of TIMINGS) {
  test(
    `a same-key replacement keeps syncing when the old connection closes ${timing} its addConnection`,
    { timeout: 20_000 },
    async (t) => {
      const keepAlive = setInterval(() => {}, 1000);
      t.after(() => clearInterval(keepAlive));
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const host = createPeer();
      const other = createPeer();
      // One tab's signing key, before and after its reconnect.
      const stale = createPeer({ seed });
      const tab = createPeer({ seed });
      assert.equal(tab.keyId, stale.keyId);
      const peers = [host, other, stale, tab],
        wires = [];
      try {
        const source = await other.repo.create({ text: "Garden" });
        wires.push(await connectPeers(other, host));
        const hosted = await host.repo.find(source.documentId);
        assert.equal(hosted.doc().text, "Garden");
        const staleWire = await connectPeers(stale, host);
        wires.push(staleWire);
        const staleDoc = await stale.repo.find(source.documentId);
        assert.equal(staleDoc.doc().text, "Garden");

        const closeStale = () => staleWire[0].disconnect();
        const replacement = await connectReplacement(tab, host, {
          ...(beforeHostAdd && { beforeHostAdd: closeStale }),
          ...(duringHostAdd && { duringHostAdd: () => duringHostAdd().then(closeStale) }),
        });
        wires.push(replacement.wire);
        if (!beforeHostAdd && !duringHostAdd) await closeStale();
        t.diagnostic(
          `client added ${replacement.clientAdded}, host added ${replacement.hostAdded}`,
        );

        // The host's edit reaches the replacement.
        const tabDoc = await tab.repo.find(source.documentId);
        await eventually(() => assert.equal(tabDoc.doc().text, "Garden"), 8000);
        await source.change((doc) => {
          doc.fromOther = `after the stale connection closed ${timing}`;
        });
        await other.repo.flush();
        await eventually(
          () => assert.equal(tabDoc.doc().fromOther, `after the stale connection closed ${timing}`),
          8000,
        );

        // The replacement's edit reaches the other peer through the host.
        await tabDoc.change((doc) => {
          doc.fromTab = timing;
        });
        await tab.repo.flush();
        await eventually(() => assert.equal(hosted.doc().fromTab, timing), 8000);
        await eventually(() => assert.equal(source.doc().fromTab, timing), 8000);
      } finally {
        assert.deepEqual(await closePeers(peers, wires), []);
      }
    },
  );
}
