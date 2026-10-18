import test from "node:test";
import assert from "node:assert/strict";
import { createPeer, connectPeers, closePeers, eventually, treeId } from "./backend.mjs";
import { createAuthenticator } from "./auth.mjs";
import { createAuthFixture } from "./auth-fixtures.mjs";
import { AccessRegistry } from "./policy.mjs";

test(
  "native relay preserves the original signer and cannot admit history after that author's lease expires",
  { timeout: 15000 },
  async (t) => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const fixture = await createAuthFixture();
    t.mock.method(globalThis, "fetch", fixture.fetch);
    const auth = await createAuthenticator({ env: fixture.env });
    let now = Date.now();
    const registry = new AccessRegistry({
      now: () => now,
      isVerifiedIdentity: auth.isVerifiedIdentity,
    });
    const authorIdentity = await auth.authenticateOidcIdToken(
      await fixture.sign({ exp: fixture.now + 30 }),
      { nonce: fixture.nonce, driver: "mobile" },
    );
    const relayIdentity = await auth.authenticateApiKey(
      fixture.apiKey({ userId: "relay-writer" }),
      { driver: "relay", write: true },
    );
    const author = createPeer();
    const relay = createPeer();
    const host = createPeer({
      policy: registry.policy(),
      ephemeralPolicy: registry.ephemeralPolicy(),
    });
    const peers = [author, relay, host],
      wires = [];
    const bind = async (peer, identity) => {
      const challenge = registry.beginBinding(identity, peer.keyId);
      return registry.finishBinding(challenge.id, await peer.signer.sign(challenge.message));
    };
    try {
      const authorBinding = await bind(author, authorIdentity);
      const relayBinding = await bind(relay, relayIdentity);
      assert.ok(authorBinding.expiresAt < relayBinding.expiresAt);
      const source = await author.repo.create({ text: "Accepted while the author is current" });
      const id = treeId(source.documentId);
      registry.setDocument(id, {
        grants: {
          [authorIdentity.principal]: "writer",
          [relayIdentity.principal]: "writer",
        },
      });
      const authorWire = await connectPeers(author, relay);
      wires.push(authorWire);
      const relayDoc = await relay.repo.find(source.documentId);
      assert.deepEqual(relayDoc.doc(), source.doc());
      const firstRelayWire = await connectPeers(relay, host);
      wires.push(firstRelayWire);
      const hosted = await host.repo.find(source.documentId);
      await eventually(() =>
        assert.ok(
          host.policyEvents.some(
            (event) =>
              event.method === "authorizePut" &&
              event.allowed &&
              event.args[0] === relay.keyId &&
              event.args[1] === author.keyId &&
              event.args[2] === id,
          ),
        ),
      );
      assert.notEqual(author.keyId, relay.keyId);
      assert.deepEqual(hosted.doc(), source.doc());

      await firstRelayWire[0].disconnect();
      await source.change((doc) => {
        doc.queuedBeforeExpiry = "Historical author-signed edit";
      });
      await author.repo.flush();
      await eventually(() =>
        assert.equal(relayDoc.doc().queuedBeforeExpiry, "Historical author-signed edit"),
      );
      await relay.repo.flush();
      assert.equal(hosted.doc().queuedBeforeExpiry, undefined);
      await authorWire[0].disconnect();

      // The data was already signed and stored by the relay before this clock
      // step. Only the original author's admission lease expires; the relaying
      // writer remains current and the document still grants both accounts write.
      now = authorBinding.expiresAt + 1;
      assert.ok(now < relayBinding.expiresAt);
      assert.throws(() => registry.getBinding(author.keyId), /expired/);
      assert.equal(registry.getBinding(relay.keyId).principal, relayIdentity.principal);
      const eventStart = host.policyEvents.length;
      wires.push(await connectPeers(relay, host));
      await eventually(() =>
        assert.ok(
          host.policyEvents
            .slice(eventStart)
            .some(
              (event) =>
                event.method === "authorizePut" &&
                !event.allowed &&
                event.args[0] === relay.keyId &&
                event.args[1] === author.keyId &&
                event.args[2] === id &&
                event.error.includes("expired"),
            ),
        ),
      );
      assert.equal(hosted.doc().queuedBeforeExpiry, undefined);
      assert.equal(relayDoc.doc().queuedBeforeExpiry, "Historical author-signed edit");
    } finally {
      assert.deepEqual(await closePeers(peers, wires), []);
    }
  },
);
