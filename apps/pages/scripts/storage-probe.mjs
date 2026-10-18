import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { serialize } from "node:v8";
import * as A from "@automerge/automerge/slim";
import { PagesWorkspace } from "../src/workspace.ts";
import { actorPrefix, newActor } from "../src/sync.ts";
import { RICH_FORMAT, textPath } from "../src/richtext.mjs";
import { checkpoint, recoveryCheck, restore } from "./storage-model.mjs";

// Generated content, real Pages operation/sync admission, in-memory storage.
// There are no network calls, credentials, private Pages, or bucket writes.
await A.initializeWasm(
  await readFile(new URL(import.meta.resolve("@automerge/automerge/automerge.wasm"))),
);
const principal = "storage-probe:generated";
const commits = 160;
const blockCount = 96;
const repetitions = 3;
const maxChunks = 64;
const maxTailBytes = 64 * 1024;

async function fixture(kind) {
  const records = [];
  const values = new Map();
  let id;
  const workspace = new PagesWorkspace({
    storage: {
      async get(key) {
        return structuredClone(values.get(key));
      },
      async put(entries) {
        for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value));
        if (id && entries[id]) records.push(structuredClone(entries));
      },
    },
  });
  const call = (operation, args) => workspace.call(principal, { operation, arguments: args });
  const created = await call("create_page", {
    title: "Generated storage probe",
    idempotency_key: "storage-probe-creation",
    block_units: Array.from({ length: blockCount }, (_, i) => ({
      format: RICH_FORMAT,
      markdown: `## Section ${i + 1}\n\nRevision 0. Café 🌊 日本語.\n\n${Array.from(
        { length: 6 },
        (_, j) =>
          `Observation ${j + 1}: ${createHash("sha256").update(`${i}:${j}`).digest("hex")} describes this block.`,
      ).join("\n\n")}`,
    })),
  });
  id = created.page_id;
  const blockId = created.content.blocks[0].id;
  const initial = structuredClone(values.get(id));
  let doc;
  let local = A.initSyncState();
  let remote = A.initSyncState();
  async function sync() {
    for (let i = 0; i < 20; i++) {
      const out = await workspace.generateSync(id, remote);
      remote = out.state;
      if (out.message) [doc, local] = A.receiveSyncMessage(doc, local, out.message);
      const [state, message] = A.generateSyncMessage(doc, local);
      local = state;
      if (message) remote = await workspace.receiveSync(principal, id, remote, message);
      if (!message && !out.message) return;
    }
    throw Error("sync failed to settle");
  }
  let threadId;
  if (kind === "typing") {
    doc = A.init({ actor: newActor(await actorPrefix(principal)) });
    await sync();
  }
  try {
    for (let i = 0; i < commits; i++) {
      const args = {
        page_id: id,
        base_sequence: values.get(id).sequence,
        idempotency_key: `probe-${kind}-${i}`,
      };
      if (kind === "typing") {
        const token = ["a", "é", "🌊", "日"][i % 4];
        doc = A.change(doc, (d) => {
          const length = d.blocks[blockId].richText.length;
          // A backspace after every nine insertions; UTF-16-safe code point length.
          const remove = i % 10 === 9 ? Array.from(d.blocks[blockId].richText).at(-1).length : 0;
          A.splice(d, textPath(blockId), length - remove, remove, remove ? "" : token);
        });
        await sync();
      } else if (kind === "semantic") {
        const page = await call("read_page", { page_id: id, block_ids: [blockId] });
        await call("patch_page", {
          ...args,
          operations: [
            {
              op: "patch_block_markdown",
              block_id: blockId,
              expected_hash: page.content.blocks[0].hash,
              replacements: [{ old: `Revision ${i}.`, new: `Revision ${i + 1}.` }],
            },
          ],
        });
      } else {
        const action = ["add", "reply", "resolve", "reopen"][i % 4];
        const result = await call("manage_page_comment", {
          ...args,
          action,
          block_id: blockId,
          thread_id: threadId,
          selected_text: action === "add" ? "Café 🌊 日本語" : undefined,
          body: `Generated comment ${i}: preserve Unicode 🌊 and its author.`,
        });
        threadId = result.thread_id;
      }
    }
  } finally {
    if (doc) A.free(doc);
  }
  assert.equal(records.length, commits);
  const final = records.at(-1)[id];
  assert.equal(final.events.length, 128);
  assert.equal(Object.keys(final.receipts).length, kind === "typing" ? 1 : 129);
  const resync = await call("read_page_changes", { page_id: id, since_sequence: 0 });
  assert.equal(resync.resync_required, true);
  return { id, initial, records };
}

function timed(fn, samples) {
  const start = performance.now();
  const cpu = process.cpuUsage();
  const value = fn();
  const used = process.cpuUsage(cpu);
  samples.wall.push(performance.now() - start);
  samples.cpuMs += (used.user + used.system) / 1000;
  return value;
}
const samples = () => ({ wall: [], cpuMs: 0 });
const rounded = (n) => Math.round(n * 1000) / 1000;
function summary(s) {
  const wall = [...s.wall].sort((a, b) => a - b);
  return {
    calls: wall.length,
    wallTotalMs: rounded(wall.reduce((a, b) => a + b, 0)),
    wallMedianMs: rounded(wall[Math.floor(wall.length / 2)]),
    cpuMs: rounded(s.cpuMs),
  };
}

function measure(fixture, policy, verify) {
  const { id, initial, records } = fixture;
  let doc = A.load(initial.bytes);
  let record = { snapshot: initial.bytes, tail: [], heads: A.getHeads(doc) };
  let persistedBytes = initial.bytes.byteLength;
  let metadataBytes = 0;
  let peakTailBytes = 0;
  let peakTailChunks = 0;
  let tailBytes = 0;
  let compactions = 0;
  const encoding = samples();
  const recovery = samples();
  // Compare identical committed histories; generation, load/admission and validation
  // cost are outside encoding timings. All policies start with the same snapshot.
  for (let i = 0; i < records.length; i++) {
    const saved = records[i][id];
    const beforeHeads = A.getHeads(doc);
    const next = A.load(saved.bytes);
    A.free(doc);
    doc = next;
    const bytes = timed(
      () => (policy === "snapshot" ? A.save(doc) : A.saveSince(doc, beforeHeads)),
      encoding,
    );
    persistedBytes += bytes.byteLength;
    const { bytes: _bytes, ...metadata } = saved;
    // Keep metadata/catalog unchanged to avoid attributing a second redesign to
    // the Automerge encoding. Node V8 is a proxy, not celld's exact row encoding.
    metadataBytes += serialize(metadata).byteLength + serialize(records[i].catalog).byteLength;
    if (policy === "snapshot") record = { snapshot: bytes, tail: [], heads: A.getHeads(doc) };
    else {
      record.tail.push(bytes);
      record.heads = A.getHeads(doc);
      tailBytes += bytes.byteLength;
      peakTailBytes = Math.max(peakTailBytes, tailBytes);
      peakTailChunks = Math.max(peakTailChunks, record.tail.length);
      if (
        policy === "checkpoint" &&
        (record.tail.length >= maxChunks || tailBytes >= maxTailBytes)
      ) {
        // Freshly load the durable generation before compacting: no live save
        // cursor is required after an activation restart.
        const restarted = restore(record);
        try {
          if (verify) recoveryCheck(record, doc); // before publishing checkpoint
          const compacted = timed(() => checkpoint(record, restarted), encoding);
          persistedBytes += compacted.snapshot.byteLength;
          if (verify) {
            recoveryCheck(compacted, doc); // after publish and prune
            recoveryCheck({ ...compacted, tail: record.tail }, doc); // publish before prune
          }
          record = compacted;
          tailBytes = 0;
          compactions++;
        } finally {
          A.free(restarted);
        }
      }
    }
    if (verify && (i === 0 || i === records.length - 1)) recoveryCheck(record, doc);
  }
  for (let i = 0; i < 5; i++) {
    const loaded = timed(() => restore(record), recovery);
    A.free(loaded);
  }
  const finalHistoryChanges = A.getAllChanges(doc).length;
  const final = records.at(-1)[id];
  A.free(doc);
  return {
    policy,
    persistedAutomergeBytes: persistedBytes,
    metadataAndCatalogV8Bytes: metadataBytes,
    finalRetainedAutomergeBytes:
      record.snapshot.byteLength + record.tail.reduce((n, b) => n + b.byteLength, 0),
    finalSnapshotBytes: final.bytes.byteLength,
    finalHistoryChanges,
    compactions,
    peakTailChunks,
    peakTailBytes,
    finalTailChunks: record.tail.length,
    retainedEvents: final.events.length,
    retainedReceiptsIncludingCreation: Object.keys(final.receipts).length,
    encoding: summary(encoding),
    recovery: summary(recovery),
  };
}

const results = [];
for (const workload of ["typing", "semantic", "comments"]) {
  const data = await fixture(workload);
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    // Rotate order to reduce systematic warmup bias, retaining every sample.
    const policies = ["snapshot", "incremental", "checkpoint"];
    for (let p = 0; p < policies.length; p++)
      runs.push({
        repetition,
        ...measure(data, policies[(p + repetition) % policies.length], repetition === 0),
      });
  }
  results.push({ workload, initialSnapshotBytes: data.initial.bytes.byteLength, runs });
  console.error(`Measured ${workload}: ${commits} commits, ${repetitions} repetitions`);
}
console.log(
  JSON.stringify(
    {
      environment: {
        node: process.version,
        automerge: "3.4.1",
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0].model,
      },
      config: { blockCount, commits, repetitions, maxChunks, maxTailBytes },
      checks:
        "Exact heads, materialized content and change hashes; pre/post checkpoint, redundant chunks, restart before compaction; 128 event/receipt windows",
      memory: {
        wholeProbePeakRssKiB: process.resourceUsage().maxRSS,
        caveat:
          "Whole-process high water includes generated fixtures, Node, WASM and verification; not per-document or per-policy memory.",
      },
      caveat:
        "Application encoding and Node V8 metadata only. No disk/S3/R2/SQLite/LTX traffic, request costs, durability latency, or runtime crash qualification. Checkpoint bounds replay tail, not CRDT history. Random IDs, actors, timestamps and timings vary.",
      results,
    },
    null,
    2,
  ),
);
