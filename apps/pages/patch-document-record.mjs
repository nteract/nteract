import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Repo 3 accepts history as loose changes or fragment bundles. A backend that
// speaks Automerge sync (pages/sync) holds whole documents as `A.save()`
// chunks, and turning one into a bundle costs more than the cold sync itself:
// Repo decodes every change of a bundle to validate it, then replays it. On
// Feedback Oct 31 that was 65 + 77 ms against 21 ms to load the save chunk.
//
// This adds a third record kind that only a backend delivers to Repo:
// `{ kind: "document", heads, blob }`, where blob is one complete document
// chunk (chunk type 0). Validation checks framing and checksum; applyRecords
// loads it like any chunk and then requires the claimed heads to be in the
// resulting history. Repo never stores document records: extractRecords still
// produces only commits and fragments, and the public RecordBatch and
// SedimentreeRecord types are unchanged, so the Subduction bridge and its
// stored records are untouched. The TypeScript below uses no template literals.

const FILES = {
  "packages/automerge-repo/src/sedimentree/records.ts":
    "dc4cdb4aafebf92ed8849383ed24a5d04ce766d0315ad628a513d2808a94b4b2",
  "packages/automerge-repo/src/sedimentree/automerge/index.ts":
    "486268bdce7b4c197c510f3b8f72851d6b7e2eec96df00bc4a8b8529e6759977",
};

const RECORDS = [
  [
    `export type SedimentreeRecord = LooseCommitRecord | FragmentRecord
export type RecordBatch = readonly SedimentreeRecord[]

/** Scoped to one sedimentree. This is NOT a representation/content fingerprint. */
export function recordKey(record: SedimentreeRecord): string {
  return \`\${record.kind}:\${record.kind === "commit" ? record.id : record.head}\`
}

export function recordHead(record: SedimentreeRecord): CommitId {
  return record.kind === "commit" ? record.id : record.head
}`,
    `export type SedimentreeRecord = LooseCommitRecord | FragmentRecord
export type RecordBatch = readonly SedimentreeRecord[]

/**
 * A whole document as one Automerge document chunk (A.save()). Only backends
 * deliver these to Repo; Repo never stores them. Not part of SedimentreeRecord,
 * so record stores keyed by commit or fragment are unaffected.
 */
export interface DocumentRecord {
  readonly kind: "document"
  readonly heads: readonly CommitId[]
  readonly blob: Uint8Array
}
export type DeliveredRecord = SedimentreeRecord | DocumentRecord

/** Scoped to one sedimentree. This is NOT a representation/content fingerprint. */
export function recordKey(record: DeliveredRecord): string {
  if (record.kind === "document") return "document:" + record.heads.join(",")
  return \`\${record.kind}:\${record.kind === "commit" ? record.id : record.head}\`
}

export function recordHead(record: DeliveredRecord): CommitId {
  if (record.kind === "document") return record.heads[0]
  return record.kind === "commit" ? record.id : record.head
}`,
  ],
  [
    `export function copyRecord(record: SedimentreeRecord): SedimentreeRecord {
  if (`,
    `/** copyRecord for every kind a backend may deliver, document records included. */
export function copyDeliveredRecord(record: DeliveredRecord): DeliveredRecord {
  return copyRecord(record as SedimentreeRecord) as DeliveredRecord
}

/** Also copies document records at runtime; see copyDeliveredRecord for the type. */
export function copyRecord(record: SedimentreeRecord): SedimentreeRecord {
  if (`,
  ],
  [
    `  throw new TypeError("Unknown sedimentree record kind")
}`,
    `  const delivered = record as DeliveredRecord
  if (delivered.kind === "document") {
    const heads = [...new Set(delivered.heads.map(commitId))].sort()
    if (!heads.length) throw new TypeError("A document record requires heads")
    return { kind: "document", heads, blob } as DeliveredRecord as SedimentreeRecord
  }
  throw new TypeError("Unknown sedimentree record kind")
}`,
  ],
  [
    `export function recordBytes(record: SedimentreeRecord): number {
  return (
    record.blob.byteLength +
    32 +
    (record.kind === "commit"`,
    `export function recordBytes(record: DeliveredRecord): number {
  if (record.kind === "document")
    return record.blob.byteLength + 32 + record.heads.length * 32
  return (
    record.blob.byteLength +
    32 +
    (record.kind === "commit"`,
  ],
];

const AUTOMERGE = [
  [
    `export function validateRecord(record: SedimentreeRecord): SedimentreeRecord {
  const owned = copyRecord(record)
  assertSingleChunk(`,
    `/** validateRecord for every kind a backend may deliver, document records included. */
export function validateDeliveredRecord(record: DeliveredRecord): DeliveredRecord {
  const copied = copyDeliveredRecord(record)
  if (copied.kind === "document") {
    // Framing and checksum here; applyRecords checks the claimed heads after
    // loading, so the chunk is decoded once.
    assertSingleChunk(copied.blob, [0])
    assertChecksum(copied.blob, sha256(copied.blob.subarray(8)))
    return copied
  }
  return validateRecord(copied)
}

export function validateRecord(record: SedimentreeRecord): SedimentreeRecord {
  const owned = copyRecord(record)
  assertSingleChunk(`,
  ],
  [
    `  records: RecordBatch,
  options: ApplyRecordsOptions = {}
): A.Doc<T> {`,
    `  records: readonly DeliveredRecord[],
  options: ApplyRecordsOptions = {}
): A.Doc<T> {`,
  ],
  [
    `  flush()
  return current
}`,
    `  flush()
  for (const record of owned) {
    if (record.kind === "document" && !A.hasHeads(current, [...record.heads]))
      throw new TypeError("Document record heads are not in its history")
  }
  return current
}`,
  ],
  [
    `  type CommitId,
  type FragmentRecord,`,
    `  type CommitId,
  type DeliveredRecord,
  type FragmentRecord,`,
  ],
  [
    `  copyRecord,
`,
    `  copyDeliveredRecord,
  copyRecord,
`,
  ],
  [
    `  const owned = records.map(validateRecord)
  let current = doc`,
    `  const owned = records.map(validateDeliveredRecord)
  let current = doc`,
  ],
];

export function patchDocumentRecord(root) {
  const result = {};
  for (const [path, edits] of [
    ["packages/automerge-repo/src/sedimentree/records.ts", RECORDS],
    ["packages/automerge-repo/src/sedimentree/automerge/index.ts", AUTOMERGE],
  ]) {
    let source = readFileSync(`${root}/${path}`, "utf8");
    const before = createHash("sha256").update(source).digest("hex");
    if (before !== FILES[path]) throw Error(`Unexpected document record source hash: ${path}`);
    for (const [needle, replacement] of edits) {
      if (source.split(needle).length !== 2)
        throw Error(`Document record patch mismatch: ${needle}`);
      source = source.replace(needle, replacement);
    }
    writeFileSync(`${root}/${path}`, source);
    result[path] = {
      before,
      after: createHash("sha256").update(source).digest("hex"),
    };
  }
  return result;
}
