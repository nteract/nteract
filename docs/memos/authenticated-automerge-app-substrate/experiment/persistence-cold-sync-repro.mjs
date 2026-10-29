import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as A from "@automerge/automerge";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { createPeer, connectPeers, closePeers, synchronize, eventually } from "./backend.mjs";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { buildPersistenceFixture, assertSameIdentity } from "./persistence-workload.mjs";

async function storedRecords(peer, tree) {
  const session = peer.backend.open(tree);
  const records = [];
  try {
    for await (const event of session.events) {
      if (event.type === "records") records.push(...event.records);
      else if (event.type === "failure") throw event.error;
      else if (event.type === "local-load-complete") return records;
    }
    throw Error("No local-load-complete event");
  } finally {
    await session.close();
  }
}
const changes = (record) =>
  record.kind === "commit" ? [A.decodeChange(record.blob)] : A.readBundle(record.blob).changes;

function counterFixture() {
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
  return {
    doc,
    loose,
    covering: extractRecords(doc),
    metrics: { changes: loose.length },
    free() {
      for (const d of [...retained, doc]) A.free(d);
    },
  };
}
const assertComplete = (actual, expected) => {
  if (expected.blocks) return assertSameIdentity(actual, expected);
  assert.deepEqual(actual, expected);
  assert.deepEqual(A.getHeads(actual), A.getHeads(expected));
  assert.deepEqual(
    A.getAllChanges(actual)
      .map((b) => A.decodeChange(b).hash)
      .sort(),
    A.getAllChanges(expected)
      .map((b) => A.decodeChange(b).hash)
      .sort(),
  );
};
export async function runColdSync({
  includeFragments = false,
  kind = "prose",
  repair = false,
} = {}) {
  const fixture = kind === "counter" ? counterFixture() : buildPersistenceFixture({ rounds: 80 });
  const host = createPeer(),
    receiver = createPeer();
  const id = interpretAsDocumentId(generateAutomergeUrl());
  const tree = documentIdToBinary(id),
    wires = [];
  const report = {
    includeFragments,
    fixtureHeads: A.getHeads(fixture.doc),
    fixture: fixture.metrics,
  };
  try {
    await host.backend.storeSnapshot(tree, fixture.loose);
    if (includeFragments)
      await host.backend.storeSnapshot(
        tree,
        fixture.covering.filter((r) => r.kind === "fragment"),
      );
    const local = await host.repo.find(id, { signal: AbortSignal.timeout(5000) });
    assertComplete(local.doc(), fixture.doc);
    wires.push(await connectPeers(receiver, host));
    try {
      const handle = await receiver.repo.find(id, { signal: AbortSignal.timeout(2000) });
      report.initialFindHeads = A.getHeads(handle.doc());
      // find() exposes a usable document, not a claim that the remote history is complete.
      await eventually(() => assertComplete(handle.doc(), fixture.doc));
      report.loaded = true;
    } catch (error) {
      report.loaded = false;
      report.loadError = { name: error.name, message: error.message };
    }
    const records = await storedRecords(receiver, tree);
    const have = new Set(records.flatMap(changes).map((c) => c.hash));
    const missing = fixture.loose.filter((r) => !have.has(r.id));
    report.receivedRecords = records.map((r) => ({
      kind: r.kind,
      id: r.id ?? r.head,
      bytes: r.blob.length,
      changes: changes(r).map((c) => c.hash),
    }));
    report.missingChanges = missing.map((r) => {
      const c = A.decodeChange(r.blob);
      return {
        hash: c.hash,
        actor: c.actor,
        sequence: c.seq,
        message: c.message,
        dependencies: c.deps,
      };
    });
    let receivedDoc = A.init();
    try {
      for (const r of records) receivedDoc = A.loadIncremental(receivedDoc, r.blob);
      report.receivedHeads = A.getHeads(receivedDoc);
      report.missingDependencies = A.getMissingDeps(receivedDoc);
    } finally {
      A.free(receivedDoc);
    }
    report.nativeSynchronize = await synchronize(receiver, id);
    try {
      const handle = await receiver.repo.find(id, { signal: AbortSignal.timeout(1000) });
      assertComplete(handle.doc(), fixture.doc);
      report.loadedAfterExplicitRound = true;
    } catch {
      report.loadedAfterExplicitRound = false;
    }
    report.wire = {
      receiverSentBytes: wires[0][0].sentBytes,
      hostSentBytes: wires[0][1].sentBytes,
    };
    if (repair && missing.length) {
      await receiver.backend.storeSnapshot(tree, missing);
      const repaired = await receiver.repo.find(id, { signal: AbortSignal.timeout(5000) });
      assertComplete(repaired.doc(), fixture.doc);
      report.supplyingMissingLooseChangesRestoresExactIdentity = true;
    }
    return report;
  } finally {
    assert.deepEqual(await closePeers([host, receiver], wires), []);
    fixture.free();
  }
}

const nativeVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.resolve("@automerge/subduction")), "utf8"),
).version;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const results = [];
    const kind = process.argv.includes("--counter") ? "counter" : "prose";
    for (const includeFragments of [false, true])
      results.push(await runColdSync({ includeFragments, kind, repair: true }));
    process.stdout.write(
      `${JSON.stringify({ nativeVersion, note: "No compaction invoked. Real native in-process authenticated wire; no remote service.", results }, null, 2)}\n`,
    );
    if (results.some((r) => !r.loaded)) process.exitCode = 1;
  } finally {
    clearInterval(keepAlive);
  }
}
