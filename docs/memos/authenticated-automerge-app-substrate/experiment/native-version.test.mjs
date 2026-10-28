import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as A from "@automerge/automerge";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { createPeer, connectPeers, closePeers, eventually, synchronize } from "./backend.mjs";
import { nativeId } from "./upstream/packages/automerge-repo-subduction/dist/storage.js";
import { pinSubductionDependency, subductionRelease } from "./native-version.mjs";

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));

test("setup pins one published native runtime across every workspace", () => {
  const pkg = { dependencies: { "@automerge/subduction": "0.23.0" } };
  pinSubductionDependency(pkg);
  assert.equal(pkg.dependencies["@automerge/subduction"], subductionRelease.version);
  assert.throws(() =>
    pinSubductionDependency({ dependencies: { "@automerge/subduction": "0.99.0" } }),
  );
  for (const path of [
    "./package.json",
    "./pages/package.json",
    "./upstream/packages/automerge-repo-subduction/package.json",
  ]) {
    assert.equal(json(path).dependencies["@automerge/subduction"], subductionRelease.version, path);
  }
  const entries = Object.entries(json("./package-lock.json").packages).filter(([path]) =>
    path.endsWith("node_modules/@automerge/subduction"),
  );
  assert.equal(entries.length, 1, "no nested old native runtime");
  assert.equal(entries[0][1].version, subductionRelease.version);
  assert.equal(entries[0][1].integrity, subductionRelease.tarballIntegrity);
  const wasm = readFileSync(
    new URL("./node_modules/@automerge/subduction/dist/subduction.wasm", import.meta.url),
  );
  assert.equal(createHash("sha256").update(wasm).digest("hex"), subductionRelease.wasmSha256);
});

// Opaque native records isolate the range-walk bug; these are not Automerge
// payload fixtures. Hash ordering makes DFS visit the A boundary via B before C.
const ids = {
  A: "00".repeat(31) + "01",
  B: "ff".repeat(32),
  C: "11".repeat(32),
  D: "22".repeat(32),
};
for (const [name, graph] of [
  [
    "simple diamond",
    [
      ["A", []],
      ["B", ["A"]],
      ["C", ["A"]],
      ["D", ["B", "C"]],
    ],
  ],
  [
    "redundant parent",
    [
      ["A", []],
      ["B", ["A"]],
      ["C", ["B"]],
      ["D", ["B", "C"]],
    ],
  ],
]) {
  test(`native minimization preserves the uncovered sibling in a ${name}`, async () => {
    const peer = createPeer();
    const tree = documentIdToBinary(interpretAsDocumentId(generateAutomergeUrl()));
    const native = nativeId(Buffer.from(tree).toString("hex"));
    try {
      await peer.backend.storeSnapshot(
        tree,
        graph.map(([label, parents], i) => ({
          kind: "commit",
          id: ids[label],
          parents: parents.map((p) => ids[p]),
          blob: Uint8Array.of(i + 1),
        })),
      );
      await peer.backend.storeSnapshot(tree, [
        {
          kind: "fragment",
          head: ids.A,
          boundary: [],
          checkpoints: [],
          blob: Uint8Array.of(1),
        },
      ]);
      const commits = await peer.backend.engine.getCommits(native);
      try {
        const actual = commits.map((commit) => {
          const id = commit.commitId;
          try {
            return id.toHexString();
          } finally {
            id.free();
          }
        });
        assert.deepEqual(actual.sort(), [ids.B, ids.C, ids.D].sort());
      } finally {
        commits.forEach((commit) => commit.free());
      }
    } finally {
      native.free();
      assert.deepEqual(await closePeers([peer]), []);
    }
  });
}

test(
  "a cold peer receives complete mixed-actor history covered by native fragments",
  { timeout: 15000 },
  async () => {
    let doc = A.change(A.init("11".repeat(16)), { time: 0 }, (d) => {
      d.count = 0;
    });
    const retained = [];
    for (let i = 1; i <= 600; i++) {
      const actor = (i % 8 === 0 ? "22" : "11").repeat(16);
      if (A.getActorId(doc) !== actor) {
        retained.push(doc);
        doc = A.clone(doc, actor);
      }
      doc = A.change(doc, { time: 0 }, (d) => {
        d.count = i;
      });
    }
    const loose = A.getAllChanges(doc).map((blob) => {
      const c = A.decodeChange(blob);
      return { kind: "commit", id: c.hash, parents: c.deps, blob };
    });
    const fragments = extractRecords(doc).filter((r) => r.kind === "fragment");
    assert.ok(fragments.length > 0, "the deterministic fixture must exercise fragment coverage");
    const host = createPeer(),
      receiver = createPeer(),
      wires = [];
    const id = interpretAsDocumentId(generateAutomergeUrl()),
      tree = documentIdToBinary(id);
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await host.backend.storeSnapshot(tree, loose);
      await host.backend.storeSnapshot(tree, fragments);
      wires.push(await connectPeers(receiver, host));
      const handle = await receiver.repo.find(id, { signal: AbortSignal.timeout(8000) });
      await synchronize(receiver, id);
      // find() may return an already usable ancestor before all remote changes
      // arrive. Wait for convergence, then check identities rather than JSON alone.
      await eventually(() => {
        assert.deepEqual(A.getHeads(handle.doc()), A.getHeads(doc));
        assert.deepEqual(A.getMissingDeps(handle.doc()), []);
        assert.deepEqual(
          A.getAllChanges(handle.doc())
            .map((b) => A.decodeChange(b).hash)
            .sort(),
          loose.map((r) => r.id).sort(),
        );
        assert.equal(handle.doc().count, 600);
      }, 5000);
    } finally {
      clearInterval(keepAlive);
      assert.deepEqual(await closePeers([host, receiver], wires), []);
      for (const retainedDoc of [...retained, doc]) A.free(retainedDoc);
    }
  },
);
