// Client cost of reopening a Page whose local copy is far behind the host.
//
// node scripts/catch-up-benchmark.mjs [--runs 3] [base+behind ...]
//
// Each run is a fresh Node process: a host holds base + behind changes, and a
// receiver starts from an IndexedDB-equivalent store holding only the base. The
// receiver pays checkpointRecords and repo.find as a reopen does, then catches
// up over the in-process authenticated wire against the same WASM and vendored
// automerge-repo the viewer ships. Catch-up is timed from connection to the
// host's heads. Each run checks that the receiver ends with the host's heads,
// changes and document. Medians are printed per workload; LAT=<ms> adds one-way
// wire latency.
//
// These are Node numbers with MemoryByteStore. The browser also pays an
// IndexedDB transaction per saved record and editor/React work per change
// event; this script measures neither.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { MemoryByteStore } from "@automerge/automerge-repo-subduction";
import { createPeer, closePeers } from "../../backend.mjs";
import { checkpointRecords } from "../viewer/checkpoint-records.mjs";
import { createPageData, initializePage } from "../model/page.mjs";

const script = fileURLToPath(import.meta.url);
const ms = (start) => Math.round(performance.now() - start);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

class DelayWire {
  frames = [];
  waiters = [];
  callbacks = new Set();
  closed = false;
  sent = 0;
  tail = Promise.resolve();
  constructor(latency) {
    this.latency = latency;
  }
  static pair(latency) {
    const left = new DelayWire(latency);
    const right = new DelayWire(latency);
    left.other = right;
    right.other = left;
    return [left, right];
  }
  async sendBytes(bytes) {
    if (this.closed) throw new Error("Wire closed");
    const copy = new Uint8Array(bytes);
    this.sent++;
    const deliver = () => {
      const waiter = this.other.waiters.shift();
      if (waiter) waiter.resolve(copy);
      else this.other.frames.push(copy);
    };
    if (!this.latency) return deliver();
    const at = performance.now() + this.latency;
    this.tail = this.tail.then(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => {
              deliver();
              resolve();
            },
            Math.max(0, at - performance.now()),
          ),
        ),
    );
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
      for (const waiter of wire.waiters.splice(0)) waiter.reject(new Error("Wire closed"));
      for (const callback of wire.callbacks) callback();
    }
  }
}

async function connect(left, right, latency) {
  const wire = DelayWire.pair(latency);
  const expected = right.signer.peerId();
  const [a, b] = await Promise.all([
    N.AuthenticatedTransport.setup(wire[0], left.signer, expected),
    N.AuthenticatedTransport.accept(wire[1], right.signer),
  ]);
  await Promise.all([left.backend.addConnection(a), right.backend.addConnection(b)]);
  a.free();
  b.free();
  expected.free();
  return wire;
}

const words = "the quick brown fox jumps over a lazy dog while agents edit pages".split(" ");
const actors = ["aa", "bb", "cc", "dd"].map((x) => x.repeat(16));

// Change hashes decide where sedimentree fragment boundaries fall, and so how
// many records a catch-up carries. Fixed actors, block ID and timestamps, root
// change included, make each seed one reproducible history; seeds vary the
// layout between runs. Native batching and generated keys still vary per run.
function edit(doc, i, seed) {
  if (i % 50 === 0) doc = A.clone(doc, actors[(i / 50) % 4]);
  return A.change(doc, { time: seed * 1_000_000 + i }, (d) => {
    const text = d.title ?? "";
    A.splice(d, ["title"], (i * 7) % (text.length + 1), 0, `${words[i % words.length]} `);
  });
}

function history(base, behind, seed) {
  const data = createPageData({ pageId: "bench", title: "Bench" });
  const blockId = "00000000-0000-4000-8000-000000000000";
  data.blocks = { [blockId]: { ...Object.values(data.blocks)[0], id: blockId } };
  let doc = A.change(A.init({ actor: "ee".repeat(16) }), { time: seed * 1_000_000 }, (d) => {
    Object.assign(d, data);
    initializePage(d);
  });
  for (let i = 0; i < base; i++) doc = edit(doc, i, seed);
  const baseDoc = A.clone(doc);
  for (let i = base; i < base + behind; i++) doc = edit(doc, i, seed);
  return { doc, baseDoc };
}

const headsId = (doc) =>
  createHash("sha256").update(A.getHeads(doc).sort().join()).digest("hex").slice(0, 12);

async function run(base, behind, seed, latency) {
  const { doc, baseDoc } = history(base, behind, seed);
  // One seed must name one history, or runs on different builds don't compare.
  const again = history(base, behind, seed);
  assert.equal(headsId(again.doc), headsId(doc), "history is not reproducible");
  assert.equal(headsId(again.baseDoc), headsId(baseDoc), "base history is not reproducible");
  const report = { base, behind, seed, latency, heads: headsId(doc), baseHeads: headsId(baseDoc) };

  const id = interpretAsDocumentId(generateAutomergeUrl());
  const tree = documentIdToBinary(id);
  const host = createPeer();
  await host.backend.storeSnapshot(tree, extractRecords(doc));

  // The receiver's IndexedDB: the base history, as the last session left it.
  const storage = new MemoryByteStore();
  const seeder = createPeer({ storage });
  await seeder.backend.storeSnapshot(tree, extractRecords(baseDoc));
  await closePeers([seeder]);
  const snapshot = A.save(baseDoc);

  const receiver = createPeer({ storage });
  let start = performance.now();
  const checkpoint = A.load(snapshot);
  report.loadMs = ms(start);
  start = performance.now();
  await checkpointRecords(receiver.backend, tree, checkpoint);
  report.checkpointRecordsMs = ms(start);
  A.free(checkpoint);
  start = performance.now();
  const handle = await receiver.repo.find(id);
  report.findMs = ms(start);

  let changeEvents = 0;
  let patches = 0;
  handle.on("change", (event) => {
    changeEvents++;
    patches += event.patches.length;
  });
  const target = A.getHeads(doc).sort().join();
  start = performance.now();
  const wire = await connect(receiver, host, latency);
  while (A.getHeads(handle.doc()).sort().join() !== target) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (performance.now() - start > 120_000) throw Error("catch-up timed out");
  }
  report.catchUpMs = ms(start);
  report.changeEvents = changeEvents;
  report.patches = patches;

  const caught = handle.doc();
  assert.deepEqual(A.getHeads(caught).sort(), A.getHeads(doc).sort());
  assert.equal(A.getAllChanges(caught).length, A.getAllChanges(doc).length);
  assert.deepEqual(A.toJS(caught), A.toJS(doc));
  await closePeers([host, receiver], [wire]);
  return report;
}

const args = process.argv.slice(2);
if (args[0] === "--child") {
  const [base, behind, seed] = args.slice(1).map(Number);
  console.log(JSON.stringify(await run(base, behind, seed, Number(process.env.LAT ?? 0))));
} else {
  let runs = 3;
  const runsAt = args.indexOf("--runs");
  if (runsAt >= 0) runs = Number(args.splice(runsAt, 2)[1]);
  assert.ok(Number.isSafeInteger(runs) && runs > 0, "--runs must be a positive integer");
  const workloads = args.length ? args : ["2000+1000", "2000+2000"];
  for (const workload of workloads) {
    const [base, behind] = workload.split("+").map(Number);
    assert.ok(
      Number.isSafeInteger(base) && Number.isSafeInteger(behind),
      `bad workload ${workload}`,
    );
    const reports = [];
    for (let seed = 1; seed <= runs; seed++) {
      const child = [script, "--child", String(base), String(behind), String(seed)];
      let output;
      try {
        // Native logs connection teardown on stderr; show it only on failure.
        output = execFileSync(process.execPath, child, { encoding: "utf8", stdio: "pipe" });
      } catch (error) {
        process.stderr.write(error.stderr ?? "");
        throw error;
      }
      const report = JSON.parse(output.trim().split("\n").pop());
      reports.push(report);
      console.log(JSON.stringify(report));
    }
    const summary = { workload, runs };
    for (const key of ["loadMs", "checkpointRecordsMs", "findMs", "catchUpMs", "changeEvents"])
      summary[key] = median(reports.map((report) => report[key]));
    summary.catchUpRangeMs = [
      Math.min(...reports.map((r) => r.catchUpMs)),
      Math.max(...reports.map((r) => r.catchUpMs)),
    ];
    console.log(`median ${JSON.stringify(summary)}`);
  }
}
