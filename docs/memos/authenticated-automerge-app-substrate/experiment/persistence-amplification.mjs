import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { closePeers } from "./backend.mjs";
import { measuredPeer } from "./persistence-benchmark.mjs";
import { assertSameIdentity, buildPersistenceFixture, MiB } from "./persistence-workload.mjs";
import {
  BufferedRecordStore,
  PageRecords,
  RemoteRecordSink,
} from "./pages/worker/record-persistence.mjs";

const valueBytes = (value) =>
  typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
const totals = (entries) =>
  entries.reduce(
    (sum, [key, value]) => ({
      entries: sum.entries + 1,
      keyBytes: sum.keyBytes + Buffer.byteLength(key),
      valueBytes: sum.valueBytes + valueBytes(value),
    }),
    { entries: 0, keyBytes: 0, valueBytes: 0 },
  );
const keyKind = (key) =>
  key.includes("/commits/") ? "commits" : key.includes("/fragments/") ? "fragments" : "metadata";

/** Counts logical provider API calls/values. It makes no claim about SQL pages,
 * physical object writes, transaction coalescing, billing units or cloud durability. */
class CountedOwnerStorage {
  values = new Map();
  counters = {
    gets: 0,
    lists: 0,
    putCalls: 0,
    deleteCalls: 0,
    syncs: 0,
    readEntries: 0,
    readKeyBytes: 0,
    readValueBytes: 0,
    writtenEntries: 0,
    writtenKeyBytes: 0,
    writtenValueBytes: 0,
    deletedEntries: 0,
    deletedKeyBytes: 0,
  };
  reads(entries) {
    const n = totals(entries);
    this.counters.readEntries += n.entries;
    this.counters.readKeyBytes += n.keyBytes;
    this.counters.readValueBytes += n.valueBytes;
  }
  async get(key) {
    this.counters.gets++;
    const value = this.values.get(key);
    if (value !== undefined) this.reads([[key, value]]);
    return structuredClone(value);
  }
  async put(values) {
    this.counters.putCalls++;
    const entries = Object.entries(values),
      n = totals(entries);
    this.counters.writtenEntries += n.entries;
    this.counters.writtenKeyBytes += n.keyBytes;
    this.counters.writtenValueBytes += n.valueBytes;
    for (const [key, value] of entries) this.values.set(key, structuredClone(value));
  }
  async delete(keys) {
    this.counters.deleteCalls++;
    this.counters.deletedEntries += keys.length;
    this.counters.deletedKeyBytes += keys.reduce((n, key) => n + Buffer.byteLength(key), 0);
    for (const key of keys) this.values.delete(key);
  }
  async sync() {
    this.counters.syncs++;
  }
  async list({ prefix, startAfter = "", limit = Infinity }) {
    this.counters.lists++;
    const entries = [...this.values]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .filter(([key]) => key.startsWith(prefix) && key > startAfter)
      .slice(0, limit);
    this.reads(entries);
    return new Map(structuredClone(entries));
  }
  snapshot() {
    const groups = Object.fromEntries(
      ["commits", "fragments", "metadata"].map((kind) => [
        kind,
        totals([...this.values].filter(([key]) => keyKind(key) === kind)),
      ]),
    );
    return { ...this.counters, stored: totals([...this.values]), groups };
  }
  restart() {
    const next = new CountedOwnerStorage();
    next.values = structuredClone(this.values);
    return next;
  }
}

class CountedBuffer extends BufferedRecordStore {
  calls = {
    loads: 0,
    lists: 0,
    saves: 0,
    removes: 0,
    readValueBytes: 0,
    writtenValueBytes: 0,
    writtenKeyBytes: 0,
  };
  async load(key) {
    this.calls.loads++;
    const value = await super.load(key);
    this.calls.readValueBytes += value?.byteLength ?? 0;
    return value;
  }
  async list(prefix) {
    this.calls.lists++;
    return super.list(prefix);
  }
  async save(key, value) {
    this.calls.saves++;
    this.calls.writtenValueBytes += value.byteLength;
    this.calls.writtenKeyBytes += Buffer.byteLength(key);
    return super.save(key, value);
  }
  async remove(key) {
    this.calls.removes++;
    return super.remove(key);
  }
}

function protocol(storage = new CountedOwnerStorage()) {
  const owner = new PageRecords({ storage });
  const transport = {
    leaseRequests: 0,
    readRequests: 0,
    writeRequests: 0,
    requestBodyBytes: 0,
    responseBodyBytes: 0,
  };
  const sink = new RemoteRecordSink({
    fetch: async (request) => {
      const route = new URL(request.url).pathname;
      transport[
        route === "/lease"
          ? "leaseRequests"
          : request.method === "GET"
            ? "readRequests"
            : "writeRequests"
      ]++;
      transport.requestBodyBytes += (await request.clone().arrayBuffer()).byteLength;
      const response = await owner.fetch(request);
      transport.responseBodyBytes += (await response.clone().arrayBuffer()).byteLength;
      return response;
    },
  });
  const buffer = new CountedBuffer(sink);
  return {
    storage,
    buffer,
    snapshot() {
      return {
        localByteStore: { ...buffer.calls },
        owner: storage.snapshot(),
        transport: { ...transport },
      };
    },
  };
}

export async function measureAmplification({
  capacityMiB = 0,
  compact = false,
  label = "candidate",
} = {}) {
  const fixture = buildPersistenceFixture({ capacityMiB });
  let persistence = protocol();
  await persistence.buffer.ready;
  let peer = measuredPeer(persistence.buffer, { maxSnapshotBytes: 64 * MiB });
  const id = interpretAsDocumentId(generateAutomergeUrl()),
    tree = documentIdToBinary(id);
  const report = {
    label,
    nativeVersion: JSON.parse(
      readFileSync(
        new URL("../../package.json", import.meta.resolve("@automerge/subduction")),
        "utf8",
      ),
    ).version,
    evidence:
      "Actual PageRecords/RemoteRecordSink/BufferedRecordStore in one Node process; logical API calls and payload bytes, not provider billing, physical writes or network overhead. Values include metadata; keys include repo/ prefixes. Request/response bytes are binary bodies only. One explicit flush per workload phase; production debounce/bursts change batching.",
    fixture: { ...fixture.description, ...fixture.metrics },
    phases: { initialized: persistence.snapshot() },
  };
  const flush = async () => {
    await peer.backend.flush();
    await persistence.buffer.flush();
  };
  try {
    await peer.backend.storeSnapshot(tree, fixture.loose);
    await flush();
    report.phases.loose = persistence.snapshot();
    await peer.backend.storeSnapshot(
      tree,
      fixture.covering.filter((r) => r.kind === "fragment"),
    );
    await flush();
    report.phases.fragments = persistence.snapshot();
    const recordValue = [...persistence.storage.values].find(([key]) =>
      key.includes("/commits/"),
    )[1];
    report.codec =
      recordValue[0] === 123
        ? "legacy-json-hex"
        : Buffer.from(recordValue.subarray(0, 4)).toString("hex");
    await peer.backend.storeSnapshot(tree, fixture.loose);
    await flush();
    report.phases.exactRetry = persistence.snapshot();
    if (compact)
      report.maintenance = await peer.backend.compact(tree, {
        durable: () => persistence.buffer.flush(),
      });
    await flush();
    report.phases.maintenance = persistence.snapshot();
    assert.deepEqual(await closePeers([peer]), []);
    peer = undefined;
    persistence = protocol(persistence.storage.restart());
    await persistence.buffer.ready;
    peer = measuredPeer(persistence.buffer, { maxSnapshotBytes: 64 * MiB });
    const handle = await peer.repo.find(id, { signal: AbortSignal.timeout(30_000) });
    assertSameIdentity(handle.doc(), fixture.doc);
    report.coldOpen = persistence.snapshot();
    await peer.repo.flush();
    await flush();
    report.unchangedBarrier = persistence.snapshot();
    return report;
  } finally {
    if (peer) assert.deepEqual(await closePeers([peer]), []);
    fixture.free();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const report = await measureAmplification({
    capacityMiB: Number(arg("--capacity-mib", 0)),
    compact: args.includes("--compact"),
    label: arg("--label", "candidate"),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.includes("--output")) await writeFile(arg("--output"), json);
  else process.stdout.write(json);
}
