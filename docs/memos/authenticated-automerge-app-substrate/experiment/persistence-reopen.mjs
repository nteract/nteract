import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import * as N from "@automerge/subduction";
import { Repo } from "@automerge/automerge-repo";
import { SubductionBackend } from "@automerge/automerge-repo-subduction";
import { identityProof } from "./persistence-workload.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const proofDigest = (doc) =>
  digest(JSON.stringify(canonical(JSON.parse(JSON.stringify(identityProof(doc))))));

/** Private test fixture: binary values plus a key-to-file manifest. This is not
 * the production persistence implementation and claims no crash durability. */
export async function exportReopenFixture(root, storage, { documentId, limits, expected }) {
  await mkdir(root, { recursive: true });
  const records = [];
  for (const [key, value] of storage.values) {
    const file = `${digest(key)}.bin`;
    await writeFile(join(root, file), value);
    records.push({ key, file, bytes: value.byteLength, sha256: digest(value) });
  }
  await writeFile(
    join(root, "fixture.json"),
    JSON.stringify({
      version: 1,
      documentId,
      limits,
      expectedDigest: proofDigest(expected),
      records,
    }),
  );
}

class DiskFixtureStore {
  reads = 0;
  readBytes = 0;
  lists = 0;
  constructor(root, records) {
    this.root = root;
    this.records = new Map(records.map((r) => [r.key, r]));
  }
  async load(key) {
    const record = this.records.get(key);
    this.reads++;
    if (!record) return undefined;
    assert.match(record.file, /^[0-9a-f]{64}\.bin$/);
    const bytes = await readFile(join(this.root, record.file));
    assert.equal(bytes.byteLength, record.bytes);
    assert.equal(digest(bytes), record.sha256);
    this.readBytes += bytes.byteLength;
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  async list(prefix) {
    this.lists++;
    return [...this.records.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  async save() {
    throw Error("Read-only reopen unexpectedly wrote data");
  }
  async remove() {
    throw Error("Read-only reopen unexpectedly removed data");
  }
}

export async function reopenFixture(root) {
  const fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
  assert.equal(fixture.version, 1);
  const storage = new DiskFixtureStore(root, fixture.records);
  const baseline = {
    memory: process.memoryUsage(),
    processMaxRssKiB: process.resourceUsage().maxRSS,
  };
  const start = performance.now();
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(61));
  const backend = new SubductionBackend({ signer, storage, ...fixture.limits });
  const repo = new Repo({ backend });
  const constructionMs = performance.now() - start;
  try {
    const findStarted = performance.now();
    const handle = await repo.find(fixture.documentId, { signal: AbortSignal.timeout(30_000) });
    const findMs = performance.now() - findStarted;
    const opened = {
      memory: process.memoryUsage(),
      processMaxRssKiB: process.resourceUsage().maxRSS,
    };
    assert.equal(proofDigest(handle.doc()), fixture.expectedDigest);
    return {
      evidence:
        "Fresh Node child; only a binary fixture and manifest loaded. Disk adapter differs from the deployed buffered DO store. RSS includes JS, WASM, modules, and runtime; it is not per-document heap.",
      runtime: { node: process.version, platform: process.platform, architecture: process.arch },
      baseline,
      opened,
      constructionMs,
      findMs,
      storage: { reads: storage.reads, readBytes: storage.readBytes, lists: storage.lists },
      identityPreserved: true,
      wasmLinearMemoryBytes: null,
      wasmMemoryNote:
        "No private WASM memory introspection used; the tested public APIs do not expose a per-document allocation metric.",
    };
  } finally {
    try {
      await repo.shutdown();
    } finally {
      try {
        await backend.close();
      } finally {
        signer.free();
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) throw Error("Usage: node persistence-reopen.mjs <exported-fixture-directory>");
  process.stdout.write(`${JSON.stringify(await reopenFixture(resolve(root)), null, 2)}\n`);
}
