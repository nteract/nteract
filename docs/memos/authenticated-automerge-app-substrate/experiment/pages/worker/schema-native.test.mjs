import assert from "node:assert/strict";
import { test } from "node:test";
import { documentIdToBinary } from "@automerge/automerge-repo";
import { closePeers, connectPeers, createPeer, eventually, synchronize } from "../../backend.mjs";
import { documentFeatures } from "../model/schema-features.mjs";
import { DocumentPolicy, logicalId } from "./policy.mjs";

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async list({ prefix = "" } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)));
  }
}

const owner = "user:owner";
const identity = {
  principal: owner,
  displayName: "Owner",
  driver: "Browser",
  canWrite: true,
  expiresAt: Date.now() + 600_000,
};

function documentPolicy(metadata, stamp) {
  return new DocumentPolicy({
    storage: new Storage(),
    metadata: () => metadata,
    serverKey: "f".repeat(64),
    schemaFeatures: stamp,
  });
}
const bind = (policy, key, features) =>
  policy.bind(key, key, identity, {
    reauthenticate: async () => identity,
    disconnect: async () => {},
    features,
  });

test("the policy refuses self-authored puts from a build that lacks a stamped feature", async () => {
  let stamp = [];
  const metadata = { owner, tree: "a".repeat(32), deleted: false };
  const policy = documentPolicy(metadata, () => stamp);
  const stale = "1".repeat(64),
    fresh = "2".repeat(64);
  await bind(policy, stale, []);
  await bind(policy, fresh, ["future"]);
  // Unstamped: every writer may put.
  await policy.put(stale, stale, metadata.tree);
  await policy.put(fresh, fresh, metadata.tree);
  stamp = ["future"];
  await assert.rejects(policy.put(stale, stale, metadata.tree), (error) => {
    assert.equal(error.code, "schema_unsupported");
    assert.equal(error.reason, "schema_unsupported");
    assert.deepEqual(error.details.features, ["future"]);
    assert.equal(
      error.message,
      "This Page uses features this version doesn't support. Reload to update.",
    );
    return true;
  });
  await policy.put(fresh, fresh, metadata.tree);
  // History another key authored and a current writer relays is not gated.
  await policy.put(fresh, stale, metadata.tree);
  // An already-connected peer is refused once the stamp outgrows its build.
  stamp = ["future", "later"];
  await assert.rejects(policy.put(fresh, fresh, metadata.tree), { code: "schema_unsupported" });
  // The refusal never touches the binding: the key keeps its read access.
  await policy.access(stale, metadata.tree);
});

test(
  "native peers: a stale build's edit to a stamped Page is refused; a current build's is accepted",
  { timeout: 20_000 },
  async (t) => {
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const metadata = { owner, tree: "", deleted: false };
    let source;
    const policy = documentPolicy(metadata, () => documentFeatures(source?.doc()));
    const host = createPeer({
      policy: {
        authorizeConnect: (key) => policy.active(key),
        authorizeFetch: (key, tree) => policy.access(key, tree),
        authorizePut: (requestor, author, tree) => policy.put(requestor, author, tree),
        filterAuthorizedFetch: async (key, trees) => {
          const allowed = [];
          for (const tree of trees)
            try {
              await policy.access(key, tree);
              allowed.push(tree);
            } catch {}
          return allowed;
        },
      },
    });
    policy.serverKey = host.keyId;
    const stale = createPeer(),
      fresh = createPeer();
    const peers = [host, stale, fresh],
      wires = [];
    try {
      source = await host.repo.create({ title: "Plan", body: "start" });
      metadata.tree = logicalId(documentIdToBinary(source.documentId));
      await bind(policy, stale.keyId, []);
      await bind(policy, fresh.keyId, ["e2e-future"]);
      wires.push(await connectPeers(stale, host), await connectPeers(fresh, host));
      const staleDoc = await stale.repo.find(source.documentId);
      const freshDoc = await fresh.repo.find(source.documentId);

      // Unstamped, the stale build writes like anyone else.
      await staleDoc.change((doc) => {
        doc.body = "stale before stamp";
      });
      await stale.repo.flush();
      await synchronize(stale, source.documentId);
      await eventually(() => assert.equal(source.doc().body, "stale before stamp"));

      // A newer build stamps the Page.
      await freshDoc.change((doc) => {
        doc.schema = { features: ["e2e-future"] };
      });
      await fresh.repo.flush();
      await synchronize(fresh, source.documentId);
      await eventually(() => assert.deepEqual(documentFeatures(source.doc()), ["e2e-future"]));
      await eventually(() => assert.deepEqual(documentFeatures(staleDoc.doc()), ["e2e-future"]));

      // The stale build's next edit is refused; the host's document is unchanged.
      const before = JSON.stringify(source.doc());
      const refusedBefore = host.policyEvents.filter((event) => !event.allowed).length;
      await staleDoc.change((doc) => {
        doc.body = "stale after stamp";
      });
      await stale.repo.flush();
      await synchronize(stale, source.documentId).catch(() => {});
      await eventually(() =>
        assert.ok(
          host.policyEvents
            .slice(refusedBefore)
            .some(
              (event) =>
                event.method === "authorizePut" &&
                event.args[0] === stale.keyId &&
                !event.allowed &&
                /doesn't support/.test(event.error),
            ),
        ),
      );
      assert.equal(JSON.stringify(source.doc()), before);
      assert.equal(source.doc().body, "stale before stamp");

      // A build that has the feature still writes.
      await freshDoc.change((doc) => {
        doc.body = "fresh after stamp";
      });
      await fresh.repo.flush();
      await synchronize(fresh, source.documentId);
      await eventually(() => assert.equal(source.doc().body, "fresh after stamp"));
    } finally {
      await closePeers(peers, wires);
    }
  },
);
