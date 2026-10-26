import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Ordered exact-record reservations extend the existing native storage writer.
// Their durable authority is the host's immutable intent journal: a host must
// restore reservations before accepting connections and sync its dependency base
// before persisting an intent. The callback must not call back into the backend.
export function patchAdmission(root) {
  const changed = [];
  function patch(path, expected, replacements) {
    let source = readFileSync(`${root}/${path}`, "utf8");
    const before = createHash("sha256").update(source).digest("hex");
    if (before !== expected) throw Error(`Unexpected admission source hash: ${path}`);
    for (const [needle, replacement] of replacements) {
      if (source.split(needle).length !== 2) throw Error(`Admission patch mismatch: ${needle}`);
      source = source.replace(needle, replacement);
    }
    writeFileSync(`${root}/${path}`, source);
    changed.push({ path, before, after: createHash("sha256").update(source).digest("hex") });
  }
  patch(
    "packages/automerge-repo-subduction/src/storage.ts",
    "bb66b237dcfb10bcd0a56340e13137b658d8812acb0c582b2855c38c962389f1",
    [
      [
        `export interface ReadLimits {`,
        `/** Capacity rejection is distinct from corruption or storage I/O. */
export class HistoryCapacityError extends BackendError {
  readonly status = 413
  readonly capacity = true
  constructor(message: string) {
    super("store", "invalid-record", message, false)
  }
}

export interface ReadLimits {`,
      ],
      [
        `  private readonly attempts = new Set<{`,
        `  private readonly reservations = new Map<string, Map<string, Map<string, SedimentreeRecord>>>()
  private readonly attempts = new Set<{`,
      ],
      [
        `  /** Preparation is synchronous and precedes queue reservation. Only owned JS`,
        `  private async reservedUnion(tree: string, additions: readonly SedimentreeRecord[]) {
    const index = await this.recordIndex(tree)
    const union = new Map([...index.records].map(([key, value]) => [key, value.record]))
    const add = (record: SedimentreeRecord) => {
      const path = recordPath(tree, record.kind, record.kind === "commit" ? record.id : record.head)
      const old = union.get(path)
      if (old && !equalRecords(old, record))
        throw new BackendError("store", "conflict", "Different reserved record representation")
      if (!old) union.set(path, record)
    }
    for (const reservation of this.reservations.get(tree)?.values() ?? [])
      for (const record of reservation.values()) add(record)
    for (const record of additions) add(record)
    if (union.size > this.limits.maxRecords)
      throw new HistoryCapacityError("Document history record count limit exceeded")
    if ([...union.values()].reduce((size, record) => size + recordBytes(record), 0) > this.limits.maxSnapshotBytes)
      throw new HistoryCapacityError("Document history byte limit exceeded")
    return union
  }

  /** Reserve exact identities under the SAME writer as incoming native records.
   * Install before awaiting the journal barrier and retain on ambiguous failure.
   * The callback must persist + sync the intent, and must never await this bridge.
   * A restart must restore every pending intent before opening native connections.
   */
  reserveRecords(id: N.SedimentreeId, key: string, input: readonly SedimentreeRecord[], persist: () => Promise<void>): Promise<void> {
    const tree = treeHex(id)
    if (!key || key.length > 512) return Promise.reject(new Error("Invalid reservation key"))
    const records = input.map(copyRecord)
    if (records.some(record => recordBytes(record) + 512 > this.limits.maxRecordBytes))
      return Promise.reject(new HistoryCapacityError("Document history record byte limit exceeded"))
    return this.enqueue(async () => {
      const union = await this.reservedUnion(tree, records)
      const index = await this.recordIndex(tree)
      const all = this.reservations.get(tree) ?? new Map<string, Map<string, SedimentreeRecord>>()
      const old = all.get(key)
      const next = new Map(records.map(record => [recordPath(tree, record.kind, record.kind === "commit" ? record.id : record.head), record]))
      if (old && [...old].some(([path, record]) => !next.has(path) || !equalRecords(record, next.get(path)!)))
        throw new BackendError("store", "conflict", "Reservation changed its exact record identities")
      if (!old && all.size >= 1000)
        throw new HistoryCapacityError("Too many pending history reservations")
      // Store only missing records and share canonical objects across reservations.
      // The actual bytes retained are bounded by the unique history budget.
      all.set(key, new Map([...next].filter(([path]) => !index.records.has(path)).map(([path]) => [path, union.get(path)!])))
      this.reservations.set(tree, all)
      await persist()
    })
  }

  /** Release only once all reserved records are present; the host also owes its
   * record and terminal-receipt durability barriers before calling this method. */
  releaseReservation(id: N.SedimentreeId, key: string): Promise<void> {
    const tree = treeHex(id)
    return this.enqueue(async () => {
      const all = this.reservations.get(tree)
      const reservation = all?.get(key)
      if (!reservation) return
      const index = await this.recordIndex(tree)
      if ([...reservation].some(([path, record]) => !index.records.has(path) || !equalRecords(record, index.records.get(path)!.record)))
        throw new Error("Reserved history is not yet stored")
      all!.delete(key)
      if (!all!.size) this.reservations.delete(tree)
    })
  }

  /** Preparation is synchronous and precedes queue reservation. Only owned JS`,
      ],
      [
        `    if (index.records.size + 1 > this.limits.maxRecords)
      throw new Error("Record count limit exceeded")
    if (size > this.limits.maxSnapshotBytes)
      throw new Error("Snapshot byte limit exceeded")`,
        `    if (this.reservations.get(tree)?.size) await this.reservedUnion(tree, [record])
    else {
      if (index.records.size + 1 > this.limits.maxRecords)
        throw new HistoryCapacityError("Document history record count limit exceeded")
      if (size > this.limits.maxSnapshotBytes)
        throw new HistoryCapacityError("Document history byte limit exceeded")
    }`,
      ],
    ],
  );
  patch(
    "packages/automerge-repo-subduction/src/index.ts",
    "a4a66198ed646497f2831483300a3a7279880a02170cbb957bc3b2828be1d5b3",
    [
      [
        `export type { LocalByteStore } from "./storage.js"`,
        `export type { LocalByteStore } from "./storage.js"
export { HistoryCapacityError } from "./storage.js"`,
      ],
      [
        `  store(input: SedimentreeId, batch: RecordBatch): Promise<void> {`,
        `  /** Host intent admission uses the bridge writer shared with native ingress.
   * No native engine call is made while its storage callback queue is held. */
  reserveRecords(input: SedimentreeId, key: string, records: RecordBatch, persist: () => Promise<void>): Promise<void> {
    const id = sedimentreeId(input)
    this.check("store", id)
    const native = nativeId(id)
    try { return this.bridge.reserveRecords(native, key, records, persist) }
    finally { native.free() }
  }
  releaseReservation(input: SedimentreeId, key: string): Promise<void> {
    const id = sedimentreeId(input)
    this.check("store", id)
    const native = nativeId(id)
    try { return this.bridge.releaseReservation(native, key) }
    finally { native.free() }
  }
  store(input: SedimentreeId, batch: RecordBatch): Promise<void> {`,
      ],
    ],
  );
  return changed;
}
