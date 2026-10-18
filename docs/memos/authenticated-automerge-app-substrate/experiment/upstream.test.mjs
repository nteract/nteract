import test from "node:test";
import assert from "node:assert/strict";
import {
  createPeer,
  connectPeers,
  closePeers,
  eventually,
  synchronize,
  treeId,
} from "./backend.mjs";
import { createAuthenticator } from "./auth.mjs";
import { createAuthFixture } from "./auth-fixtures.mjs";
import { AccessRegistry } from "./policy.mjs";

test(
  "real Repo3/Subduction peers converge unknown fields and preserve signed ephemeral origin",
  { timeout: 15000 },
  async () => {
    const left = createPeer(),
      right = createPeer();
    const wires = [];
    try {
      const first = await left.repo.create({
        title: "Open document",
        blocks: [{ kind: "future-chart", payload: { series: [1, 2] } }],
        extensions: { future: { retained: true } },
      });
      wires.push(await connectPeers(left, right));
      const second = await right.repo.find(first.documentId);
      assert.deepEqual(second.doc(), first.doc());
      await Promise.all([
        first.change((doc) => {
          doc.title = "Edited by old client";
        }),
        second.change((doc) => {
          doc.extensions.future.newField = "Edited by new client";
        }),
      ]);
      await Promise.all([left.repo.flush(), right.repo.flush()]);
      await eventually(() => assert.deepEqual(first.doc(), second.doc()));
      assert.equal(first.doc().extensions.future.retained, true);
      assert.equal(first.doc().extensions.future.newField, "Edited by new client");
      assert.equal(first.doc().blocks[0].kind, "future-chart");
      const received = [];
      second.on("ephemeral-message", (event) => received.push(event));
      first.broadcast({ cursor: 2, claimedName: "Forged name", claimedDriver: "Forged driver" });
      await eventually(() => assert.equal(received.length, 1));
      assert.equal(received[0].senderId, left.senderId);
      assert.equal(received[0].message.claimedName, "Forged name");
      // Account/driver display must be resolved from signed sender identity by
      // our credential bridge. The upstream payload itself remains untrusted.
      assert.equal(first.doc().title, "Edited by old client");
      assert.ok(wires[0][0].sentBytes > 0);
    } finally {
      assert.deepEqual(await closePeers([left, right], wires), []);
    }
  },
);

test(
  "native policy enforces OIDC/API-key writer, reader, none, runtime authority, and live revocation",
  { timeout: 25000 },
  async (t) => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const fixture = await createAuthFixture();
    t.mock.method(globalThis, "fetch", fixture.fetch);
    const auth = await createAuthenticator({ env: fixture.env });
    const registry = new AccessRegistry({ isVerifiedIdentity: auth.isVerifiedIdentity });
    const mobileIdentity = await auth.authenticateOidcIdToken(await fixture.sign(), {
      nonce: fixture.nonce,
      driver: "mobile",
    });
    const agentIdentity = await auth.authenticateApiKey(fixture.apiKey(), {
      driver: "ChatGPT",
      write: true,
    });
    const readerIdentity = await auth.authenticateApiKey(fixture.apiKey({ userId: "reader" }), {
      driver: "reader",
      write: true,
    });
    const noneIdentity = await auth.authenticateApiKey(fixture.apiKey({ userId: "none" }), {
      driver: "none",
      write: true,
    });
    const host = createPeer({
      policy: registry.policy(),
      ephemeralPolicy: registry.ephemeralPolicy(),
    });
    const mobile = createPeer(),
      agent = createPeer(),
      reader = createPeer(),
      none = createPeer();
    const peers = [host, mobile, agent, reader, none],
      wires = [];
    async function bind(peer, identity) {
      const challenge = registry.beginBinding(identity, peer.keyId);
      await registry.finishBinding(challenge.id, await peer.signer.sign(challenge.message));
    }
    try {
      await bind(host, mobileIdentity);
      await bind(mobile, mobileIdentity);
      await bind(agent, agentIdentity);
      await bind(reader, readerIdentity);
      await bind(none, noneIdentity);
      const source = await host.repo.create({
        title: "Start",
        extensions: { future: true },
        blocks: [{ kind: "unknown", payload: "preserved" }],
      });
      const id = treeId(source.documentId);
      registry.setDocument(id, {
        profile: "typed",
        grants: { [mobileIdentity.principal]: "writer", [readerIdentity.principal]: "reader" },
      });
      for (const peer of [mobile, agent, reader, none]) wires.push(await connectPeers(peer, host));
      const [mobileDoc, agentDoc, readerDoc] = await Promise.all(
        [mobile, agent, reader].map((peer) => peer.repo.find(source.documentId)),
      );
      const deniedLookup = none.repo.find(source.documentId, { signal: AbortSignal.timeout(1000) });
      const lookupRejection = assert.rejects(deniedLookup);
      await eventually(() =>
        assert.ok(
          host.policyEvents.some(
            (event) =>
              event.method === "authorizeFetch" && event.args[0] === none.keyId && !event.allowed,
          ),
        ),
      );
      await lookupRejection;
      assert.equal(none.repo.findWithProgress(source.documentId).peek().state, "loading");
      assert.deepEqual(await none.storage.list("subduction-v1/"), []);
      await Promise.all([
        mobileDoc.change((doc) => {
          doc.title = "Mobile edit";
        }),
        agentDoc.change((doc) => {
          doc.extensions.agent = "Agent edit";
        }),
      ]);
      await Promise.all([mobile.repo.flush(), agent.repo.flush()]);
      await eventually(() => {
        assert.equal(source.doc().title, "Mobile edit");
        assert.equal(source.doc().extensions.agent, "Agent edit");
        assert.deepEqual(readerDoc.doc(), source.doc());
      });
      assert.equal(source.doc().blocks[0].kind, "unknown");
      assert.equal(source.doc().extensions.future, true);

      const seen = [];
      const bySender = new Map(peers.map((peer) => [peer.senderId, peer.keyId]));
      source.on("ephemeral-message", (event) => {
        seen.push(registry.presence(bySender.get(event.senderId), id, event.message));
      });
      agentDoc.broadcast({
        anchor: "block:1",
        displayName: "Fake Administrator",
        principal: "system",
        driver: "spoofed",
      });
      await eventually(() => assert.equal(seen.length, 1));
      assert.equal(seen[0].principal, mobileIdentity.principal);
      assert.equal(seen[0].displayName, "Fixture Person");
      assert.equal(seen[0].driver, "ChatGPT");
      readerDoc.broadcast({ anchor: "block:2" });
      await eventually(() => assert.equal(seen.length, 2));
      assert.equal(seen[1].principal, readerIdentity.principal);

      await readerDoc.change((doc) => {
        doc.title = "Reader attempted mutation";
      });
      await reader.repo.flush();
      await synchronize(reader, source.documentId);
      await eventually(() =>
        assert.ok(
          host.policyEvents.some(
            (event) =>
              event.method === "authorizePut" && event.args[0] === reader.keyId && !event.allowed,
          ),
        ),
      );
      assert.equal(source.doc().title, "Mobile edit");
      // The denied optimistic edit remains local; no client rollback is implied.
      assert.equal(readerDoc.doc().title, "Reader attempted mutation");

      const readerPresence = [],
        mobilePresence = [];
      readerDoc.on("ephemeral-message", (event) => readerPresence.push(event));
      mobileDoc.on("ephemeral-message", (event) => mobilePresence.push(event));
      source.broadcast({ anchor: "before-read-revocation" });
      await eventually(() => assert.equal(readerPresence.length, 1));
      registry.setRole(id, readerIdentity.principal, "none");
      const policyStart = host.policyEvents.length;
      const presenceStart = host.presencePolicyEvents.length;
      await source.change((doc) => {
        doc.afterReadRevocation = "authorized peers only";
      });
      await host.repo.flush();
      await eventually(() =>
        assert.equal(mobileDoc.doc().afterReadRevocation, "authorized peers only"),
      );
      assert.equal(readerDoc.doc().afterReadRevocation, undefined);
      await eventually(() =>
        assert.ok(
          host.policyEvents
            .slice(policyStart)
            .some(
              (event) =>
                event.args[0] === reader.keyId &&
                ((event.method === "filterAuthorizedFetch" && event.result.length === 0) ||
                  (event.method === "authorizeFetch" && !event.allowed)),
            ),
          JSON.stringify(host.policyEvents.slice(policyStart)),
        ),
      );
      source.broadcast({ anchor: "after-read-revocation" });
      await eventually(() =>
        assert.ok(mobilePresence.some((event) => event.message.anchor === "after-read-revocation")),
      );
      await eventually(() =>
        assert.ok(
          host.presencePolicyEvents
            .slice(presenceStart)
            .some(
              (event) =>
                event.method === "filterAuthorizedSubscribers" &&
                event.args[1].includes(reader.keyId) &&
                !event.result.includes(reader.keyId),
            ),
        ),
      );
      assert.equal(readerPresence.length, 1);

      const runtime = await host.repo.create({ kernelState: "idle" });
      registry.setDocument(treeId(runtime.documentId), {
        profile: "runtime",
        grants: { [mobileIdentity.principal]: "writer" },
        runtimeWriters: [],
      });
      const runtimeClient = await agent.repo.find(runtime.documentId);
      await runtimeClient.change((doc) => {
        doc.kernelState = "forged-running";
      });
      await agent.repo.flush();
      await synchronize(agent, runtime.documentId);
      await eventually(() =>
        assert.ok(
          host.policyEvents.some(
            (event) =>
              event.method === "authorizePut" &&
              event.args[2] === treeId(runtime.documentId) &&
              !event.allowed,
          ),
        ),
      );
      assert.equal(runtime.doc().kernelState, "idle");

      // The initial mobile write is a positive control for this exact peer/doc.
      assert.ok(
        host.policyEvents.some(
          (event) =>
            event.method === "authorizePut" &&
            event.allowed &&
            event.args[0] === mobile.keyId &&
            event.args[1] === mobile.keyId &&
            event.args[2] === id,
        ),
      );
      registry.revokeKey(mobile.keyId);
      const revokedWriteStart = host.policyEvents.length;
      await mobileDoc.change((doc) => {
        doc.extensions.revoked = "must stay local";
      });
      await mobile.repo.flush();
      const revokedSync = await synchronize(mobile, source.documentId);
      assert.equal(revokedSync.outcome, "failed");
      // Native sync negotiation checks fetch admission before transferring this
      // pending write. A revoked peer is denied there, before authorizePut.
      // Match the exact peer and document so unrelated retries cannot satisfy it.
      await eventually(() =>
        assert.ok(
          host.policyEvents
            .slice(revokedWriteStart)
            .some(
              (event) =>
                event.method === "authorizeFetch" &&
                !event.allowed &&
                event.args[0] === mobile.keyId &&
                event.args[1] === id &&
                event.error.includes("revoked"),
            ),
        ),
      );
      assert.equal(source.doc().extensions.revoked, undefined);
      assert.equal(mobileDoc.doc().extensions.revoked, "must stay local");
      // The same host and document still accept a current writer after this
      // denial; absence of the revoked edit is not a stalled transport assertion.
      await agentDoc.change((doc) => {
        doc.extensions.afterMobileRevocation = "accepted current writer";
      });
      await agent.repo.flush();
      await eventually(() => {
        assert.equal(source.doc().extensions.afterMobileRevocation, "accepted current writer");
        assert.ok(
          host.policyEvents
            .slice(revokedWriteStart)
            .some(
              (event) =>
                event.method === "authorizePut" &&
                event.allowed &&
                event.args[0] === agent.keyId &&
                event.args[1] === agent.keyId &&
                event.args[2] === id,
            ),
        );
      });
      assert.equal(source.doc().extensions.revoked, undefined);
      mobileDoc.broadcast({ anchor: "revoked" });
      await eventually(() =>
        assert.ok(
          host.presencePolicyEvents.some(
            (event) =>
              event.method === "authorizePublish" &&
              event.args[0] === mobile.keyId &&
              !event.allowed,
          ),
        ),
      );
      assert.equal(seen.length, 2);
    } finally {
      assert.deepEqual(await closePeers(peers, wires), []);
    }
  },
);
