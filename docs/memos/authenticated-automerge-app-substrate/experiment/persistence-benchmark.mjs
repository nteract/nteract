import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportReopenFixture } from "./persistence-reopen.mjs";
import { pathToFileURL } from "node:url";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import {
  Repo,
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { SubductionBackend } from "@automerge/automerge-repo-subduction";
import { closePeers } from "./backend.mjs";
import {
  assertSameIdentity,
  buildPersistenceFixture,
  MeasuredByteStore,
  MiB,
} from "./persistence-workload.mjs";

export function measuredPeer(storage, options = {}) {
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(61));
  const backend = new SubductionBackend({ signer, storage, ...options });
  const repo = new Repo({ backend });
  return { signer, backend, repo, storage };
}

export async function runPersistenceBenchmark({
  rounds = 320,
  capacityMiB = 0,
  maxSnapshotMiB = 64,
  compact,
} = {}) {
  const generatedAt = performance.now();
  const fixture = buildPersistenceFixture({ rounds, capacityMiB });
  const generationMs = performance.now() - generatedAt;
  const storage = new MeasuredByteStore();
  const limits = { maxSnapshotBytes: maxSnapshotMiB * MiB };
  let peer = measuredPeer(storage, limits);
  const id = interpretAsDocumentId(generateAutomergeUrl());
  const tree = documentIdToBinary(id);
  const reopenRoot = await mkdtemp(join(tmpdir(), "page7-reopen-"));
  const report = {
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      nativeVersion: JSON.parse(
        readFileSync(
          new URL("../../package.json", import.meta.resolve("@automerge/subduction")),
          "utf8",
        ),
      ).version,
    },
    evidence:
      "In-process real Automerge/Subduction WASM with an instrumented byte store. Not a Worker, S3/R2, power-loss, or cost measurement.",
    fixture: { ...fixture.description, ...fixture.metrics, generationMs },
    benchmarkOnlyLimits: limits,
    memoryBeforeStorage: process.memoryUsage(),
  };
  try {
    let started = performance.now();
    await peer.backend.storeSnapshot(tree, fixture.loose);
    await peer.backend.flush();
    report.writeLooseMs = performance.now() - started;
    report.afterLoose = storage.measure();
    started = performance.now();
    await peer.backend.storeSnapshot(
      tree,
      fixture.covering.filter((record) => record.kind === "fragment"),
    );
    await peer.backend.flush();
    report.writeCoveringMs = performance.now() - started;
    report.beforeMaintenance = storage.measure();
    if (compact) {
      started = performance.now();
      report.maintenance = await compact({ peer, storage, tree, documentId: id, fixture });
      report.maintenanceMs = performance.now() - started;
      await peer.backend.flush();
    }
    report.afterMaintenance = storage.measure();
    report.memoryAfterStorage = process.memoryUsage();
    await exportReopenFixture(reopenRoot, storage, {
      documentId: id,
      limits,
      expected: fixture.doc,
    });
    const child = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        new URL("./persistence-reopen.mjs", import.meta.url).pathname,
        reopenRoot,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    report.freshProcessReopen = JSON.parse(child.stdout);
    assert.deepEqual(await closePeers([peer]), []);
    peer = undefined;
    const reopenedStore = storage.copy();
    peer = measuredPeer(reopenedStore, limits);
    started = performance.now();
    const handle = await peer.repo.find(id, { signal: AbortSignal.timeout(30_000) });
    report.reopenMs = performance.now() - started;
    assertSameIdentity(handle.doc(), fixture.doc);
    report.reopen = reopenedStore.measure();
    const dormantChanges = A.getChanges(fixture.initial, fixture.dormant);
    const expected = A.merge(A.clone(fixture.doc), fixture.dormant);
    try {
      const records = dormantChanges.map((blob) => {
        const c = A.decodeChange(blob);
        return { kind: "commit", id: c.hash, parents: c.deps, blob };
      });
      started = performance.now();
      await peer.backend.storeSnapshot(tree, records);
      await peer.backend.flush();
      assertSameIdentity(handle.doc(), expected);
      report.dormantPeerMergeMs = performance.now() - started;
      report.dormantPeerIdentityPreserved = true;
    } finally {
      A.free(expected);
    }
    report.memoryAfterReopenAndMerge = process.memoryUsage();
    report.processMaxRssKiB = process.resourceUsage().maxRSS;
    return report;
  } finally {
    if (peer) assert.deepEqual(await closePeers([peer]), []);
    fixture.free();
    await rm(reopenRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => {
    const at = args.indexOf(flag);
    return at < 0 ? fallback : args[at + 1];
  };
  const adapter = value("--maintenance", null);
  const compact = adapter ? (await import(pathToFileURL(adapter))).compact : undefined;
  if (adapter && typeof compact !== "function")
    throw Error("Maintenance module must export compact(context)");
  const report = await runPersistenceBenchmark({
    rounds: Number(value("--rounds", 320)),
    capacityMiB: Number(value("--capacity-mib", 0)),
    maxSnapshotMiB: Number(value("--max-snapshot-mib", 64)),
    compact,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const output = value("--output", null);
  if (output) await writeFile(output, json);
  else process.stdout.write(json);
}
