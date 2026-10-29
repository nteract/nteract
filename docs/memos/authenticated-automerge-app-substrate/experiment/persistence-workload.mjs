import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as A from "@automerge/automerge";
import { recordBytes } from "@automerge/automerge-repo/sedimentree";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { selectionContext } from "./pages/model/comments.mjs";
import { RICH_FORMAT, setRichMarkdown } from "./pages/model/richtext.mjs";

export const MiB = 1024 * 1024;
export const actors = Object.freeze({
  human: "11".repeat(16),
  agent: "22".repeat(16),
  phone: "33".repeat(16),
});
const textPath = ["blocks", "foundation", "richText"];
const passage = "The Parquet file remains the bulk data source.";
const block = (id, position) => ({
  id,
  position,
  kind: "markdown",
  format: RICH_FORMAT,
  markdown: "",
  richText: "",
  metadata: {},
});

function changeAs(doc, actor, message, fn, retained) {
  if (A.getActorId(doc) === actor) return A.change(doc, { time: 0, message }, fn);
  retained.push(doc);
  return A.change(A.clone(doc, actor), { time: 0, message }, fn);
}

function bytes(length, seed) {
  return Uint8Array.from({ length }, () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed & 255;
  });
}

/** Deterministic prose workload. Capacity ballast is separately labeled typed data,
 * not a claim about normal prose size, and never changes production limits. */
export function buildPersistenceFixture({ rounds = 320, capacityMiB = 0 } = {}) {
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 8 && rounds <= 4000);
  assert.ok(Number.isFinite(capacityMiB) && capacityMiB >= 0 && capacityMiB <= 64);
  const retained = [];
  let doc = A.change(A.init(actors.human), { time: 0, message: "human: initial proposal" }, (d) => {
    d.page_id = "page7-persistence-fixture";
    d.title = "A shared document foundation";
    d.blocks = {
      foundation: block("foundation", "a0"),
      notes: block("notes", "a1"),
      rich: block("rich", "a2"),
    };
    d.comments = {};
    d.extensions = { futureType: { retained: true, version: 1 } };
    setRichMarkdown(
      d,
      "foundation",
      `${passage} The shared document stores filters, selections, and the view.\n\nPeople and agents can edit together. 👩🏽‍💻`,
    );
    setRichMarkdown(d, "notes", "## Working notes\n\nWe are testing the storage boundary.");
    setRichMarkdown(
      d,
      "rich",
      "| Capability | State |\n| --- | --- |\n| Shared editing | Ready |\n\n```mermaid\ngraph LR\n A[Document] --> B[Collaborators]\n```",
    );
  });
  const target = {
    kind: "selection",
    anchor: {
      blockId: "foundation",
      textObjectId: A.getObjectId(doc.blocks.foundation, "richText"),
      relativePositionBase64: btoa(
        A.getCursor(doc, textPath, doc.blocks.foundation.richText.indexOf(passage)),
      ),
    },
    head: {
      blockId: "foundation",
      textObjectId: A.getObjectId(doc.blocks.foundation, "richText"),
      relativePositionBase64: btoa(
        A.getCursor(
          doc,
          textPath,
          doc.blocks.foundation.richText.indexOf(passage) + passage.length - 1,
        ),
      ),
    },
  };
  doc = A.change(doc, { time: 0, message: "human: anchor a comment" }, (d) => {
    d.comments.discussion = {
      target,
      author: { principal: "fixture:human", displayName: "Fixture human", driver: "Browser" },
      createdAt: "2026-10-26T00:00:00.000Z",
      status: { value: "open", at: "2026-10-26T00:00:00.000Z" },
      messages: {
        first: {
          body: "Keep this distinction clear.",
          createdAt: "2026-10-26T00:00:00.000Z",
          deletedAt: null,
        },
      },
    };
  });
  const initial = A.load(A.save(doc), "44".repeat(16));
  let dormant = A.change(
    A.load(A.save(doc), actors.phone),
    { time: 0, message: "phone: offline concurrent edit" },
    (d) => {
      A.splice(d, textPath, 1, 0, "Offline note: ");
      A.splice(
        d,
        ["blocks", "notes", "richText"],
        d.blocks.notes.richText.length,
        0,
        "\nPhone draft retained.",
      );
    },
  );
  for (let i = 0; i < rounds; i++) {
    const agent = i % 8 === 7;
    doc = changeAs(
      doc,
      agent ? actors.agent : actors.human,
      `${agent ? "agent" : "human"}: revision ${i}`,
      (d) => {
        if (agent) {
          setRichMarkdown(
            d,
            "notes",
            `## Working notes\n\nRevision ${i}: preserve document identities, comments, and concurrent edits. ${i % 16 === 7 ? "Measure reopening and stored bytes." : "Check recovery before publishing results."}`,
          );
        } else {
          A.splice(
            d,
            ["blocks", "notes", "richText"],
            d.blocks.notes.richText.length,
            0,
            ` ${i % 2 ? "Review" : "Check"} ${i}.`,
          );
        }
      },
      retained,
    );
  }
  const payloadVersions = Math.ceil((capacityMiB * MiB) / (256 * 1024));
  for (let i = 0; i < payloadVersions; i++) {
    doc = changeAs(
      doc,
      actors.agent,
      `capacity-only: opaque typed payload ${i}`,
      (d) => {
        d.extensions.capacityFixture = bytes(256 * 1024, 701 + i);
      },
      retained,
    );
  }
  // Clones may retain JS object metadata pointing at their ancestor handle.
  // Rehydrate before retiring those handles so identity inspection is independent.
  const source = doc;
  doc = A.load(A.save(source));
  for (const old of [...retained, source]) A.free(old);
  const changes = A.getAllChanges(doc);
  const loose = changes.map((blob) => {
    const decoded = A.decodeChange(blob);
    return { kind: "commit", id: decoded.hash, parents: decoded.deps, blob };
  });
  const covering = extractRecords(doc);
  return {
    initial,
    doc,
    dormant,
    loose,
    covering,
    description: {
      rounds,
      payloadVersions,
      capacityBallast: payloadVersions
        ? "High-entropy binary typed field, overwritten in 256 KiB versions; not representative prose."
        : null,
    },
    metrics: {
      changes: changes.length,
      heads: A.getHeads(doc),
      historySha256: createHash("sha256")
        .update(
          loose
            .map((r) => r.id)
            .sort()
            .join("\n"),
        )
        .digest("hex"),
      rawLooseRecordBytes: loose.reduce((sum, r) => sum + recordBytes(r), 0),
      coveringRecords: covering.length,
      coveringFragments: covering.filter((r) => r.kind === "fragment").length,
      coveringRecordBytes: covering.reduce((sum, r) => sum + recordBytes(r), 0),
      snapshotBytes: A.save(doc).byteLength,
    },
    free() {
      A.free(initial);
      A.free(doc);
      A.free(dormant);
    },
  };
}

export function identityProof(doc) {
  const changes = A.getAllChanges(doc).map((b) => A.decodeChange(b));
  return {
    heads: A.getHeads(doc).sort(),
    changeHashes: changes.map((c) => c.hash).sort(),
    actors: [...new Set(changes.map((c) => c.actor))].sort(),
    blockObjects: Object.fromEntries(
      Object.entries(doc.blocks).map(([id, value]) => [
        id,
        {
          object: A.getObjectId(value),
          text: A.getObjectId(value, "richText"),
          spans: A.spans(doc, ["blocks", id, "richText"]),
        },
      ]),
    ),
    comment: selectionContext(doc, doc.comments.discussion.target),
    target: structuredClone(doc.comments.discussion.target),
    extension: {
      retained: doc.extensions.futureType.retained,
      version: doc.extensions.futureType.version,
    },
  };
}

export function assertSameIdentity(actual, expected) {
  assert.deepEqual(identityProof(actual), identityProof(expected));
}

/** Copies model one atomic key write. Hooks permit a failure before or after the
 * write, modeling an ambiguous response without manufacturing partial values. */
export class MeasuredByteStore {
  values = new Map();
  hook;
  operations = [];
  counters = { loads: 0, saves: 0, deletes: 0, lists: 0, readBytes: 0, writtenBytes: 0 };
  async load(key) {
    this.counters.loads++;
    const value = this.values.get(key);
    if (value) this.counters.readBytes += value.byteLength;
    return value && new Uint8Array(value);
  }
  async save(key, value) {
    await this.hook?.({ type: "save", phase: "before", key, bytes: value.byteLength });
    this.values.set(key, new Uint8Array(value));
    this.counters.saves++;
    this.counters.writtenBytes += value.byteLength;
    this.operations.push({ type: "save", key, bytes: value.byteLength });
    await this.hook?.({ type: "save", phase: "after", key, bytes: value.byteLength });
  }
  async remove(key) {
    await this.hook?.({ type: "remove", phase: "before", key });
    this.values.delete(key);
    this.counters.deletes++;
    this.operations.push({ type: "remove", key });
    await this.hook?.({ type: "remove", phase: "after", key });
  }
  async list(prefix) {
    this.counters.lists++;
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  copy() {
    const result = new MeasuredByteStore();
    result.values = new Map([...this.values].map(([key, value]) => [key, new Uint8Array(value)]));
    return result;
  }
  measure() {
    return {
      ...this.counters,
      entries: this.values.size,
      storedValueBytes: [...this.values.values()].reduce((n, v) => n + v.byteLength, 0),
      storedKeyBytes: [...this.values.keys()].reduce((n, k) => n + Buffer.byteLength(k), 0),
    };
  }
  digest() {
    const hash = createHash("sha256");
    for (const [key, value] of [...this.values].sort(([a], [b]) => a.localeCompare(b)))
      hash.update(key).update(value);
    return hash.digest("hex");
  }
}
