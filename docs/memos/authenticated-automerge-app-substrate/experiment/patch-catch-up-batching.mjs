import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Two changes so a far-behind replica catches up in a few document loads:
// 1. The bridge notifies a native batch's saved records together. It persists
//    the batch one record at a time and each save became its own live
//    `records` event. The consumer drained every event before the next save
//    resolved, so nothing queued for a consumer to merge. Notifications now
//    carry chunks bounded by the backend's batchRecords/batchBytes limits, the
//    bounds initial replay uses. Every resolved save still notifies exactly
//    once, in save order, before the batch's transaction ends, including the
//    prefix saved before a failure. Single commit and fragment saves notify
//    alone, as before.
// 2. DocumentDelegate rescans the document's record metadata only when an
//    incoming batch moved its heads. The covering representation is a function
//    of the applied history and the heads name that history, so records the
//    replica already holds, or that wait on a missing dependency, cannot
//    change it.
// The TypeScript below uses no template literals.

export function patchCatchUpBatching(root) {
  const changed = [];
  function patch(path, expected, replacements) {
    let source = readFileSync(`${root}/${path}`, "utf8");
    const before = createHash("sha256").update(source).digest("hex");
    if (before !== expected) throw Error(`Unexpected catch-up batching source hash: ${path}`);
    for (const [needle, replacement] of replacements) {
      if (source.split(needle).length !== 2)
        throw Error(`Catch-up batching patch mismatch: ${needle}`);
      source = source.replace(needle, replacement);
    }
    writeFileSync(`${root}/${path}`, source);
    changed.push({ path, before, after: createHash("sha256").update(source).digest("hex") });
  }
  patch(
    "packages/automerge-repo-subduction/src/storage.ts",
    "3a335064a7741c16677f374b67957b5033479a7a6168631c54cbea2f1a9005ec",
    [
      [
        `  maxRecords: number
}
`,
        `  maxRecords: number
  /** Notification chunk bounds for one native batch; default 128 / 1 MiB. */
  batchRecords?: number
  batchBytes?: number
}

/** Resolved saves of one native batch that have not been notified yet. */
type PendingNotification = {
  sid: SedimentreeId
  records: SedimentreeRecord[]
  bytes: number
}
`,
      ],
      [
        `    private readonly saved: (
      id: SedimentreeId,
      record: SedimentreeRecord
    ) => void,
    private readonly failed?: (id: SedimentreeId, cause: unknown) => void
  ) {}
`,
        `    private readonly notify: (
      id: SedimentreeId,
      records: SedimentreeRecord[]
    ) => void,
    private readonly failed?: (id: SedimentreeId, cause: unknown) => void
  ) {}

  /** Resolved saves of the native batch in progress, not yet notified. The
   * bridge queue runs one mutation at a time, so one collector suffices. */
  private notifying?: PendingNotification

  /** A resolved save. Outside a native batch it notifies now. Inside one it
   * joins the batch's next notification, sent when a chunk fills or the batch
   * ends, so a consumer applies a catch-up in a few loads instead of one per
   * record. A chunk never crosses the byte bound: a record that would cross it
   * starts the next chunk, and a record larger than the bound goes alone. */
  private saved(sid: SedimentreeId, record: SedimentreeRecord): void {
    const batch = this.notifying
    if (!batch) {
      this.notify(sid, [record])
      return
    }
    const maxBytes = this.limits.batchBytes ?? 1024 * 1024
    const bytes = recordBytes(record)
    if (batch.sid !== sid || batch.bytes + bytes > maxBytes) this.release(batch)
    batch.sid = sid
    batch.records.push(record)
    batch.bytes += bytes
    if (batch.records.length >= (this.limits.batchRecords ?? 128) || batch.bytes >= maxBytes)
      this.release(batch)
  }

  private release(batch: PendingNotification): void {
    if (!batch.records.length) return
    const records = batch.records
    batch.records = []
    batch.bytes = 0
    this.notify(batch.sid, records)
  }
`,
      ],
      [
        `      return async () => {
        await this.storage.save(\`\${prefix(tree)}id\`, new Uint8Array([1]))
        for (const group of causalGroups(copies)) await this.savePreparedGroup(group)
        return copies.length`,
        `      // Native may free id once this call returns.
      const sid = logicalId(id)
      return async () => {
        await this.storage.save(\`\${prefix(tree)}id\`, new Uint8Array([1]))
        const batch: PendingNotification = { sid, records: [], bytes: 0 }
        this.notifying = batch
        try {
          for (const group of causalGroups(copies)) await this.savePreparedGroup(group)
        } finally {
          // A failure still notifies the prefix that resolved, before the
          // owner sees the failure.
          this.notifying = undefined
          this.release(batch)
        }
        return copies.length`,
      ],
    ],
  );
  patch(
    "packages/automerge-repo-subduction/src/index.ts",
    "2797c8191d7b0bea2992f75e8da27b952591b38310b7f44f4dea69b2341dc107",
    [
      [
        `      (id, record) => this.persisted(id, record),`,
        `      (id, records) => this.persisted(id, records),`,
      ],
      [
        `  private persisted(id: SedimentreeId, record: SedimentreeRecord): void {
    if (this.closed || this.deleting.has(id)) return
    const sequence = ++this.sequence
    for (const [watch, tree] of this.watches)
      if (tree === id)
        watch.push(
          { type: "records", sequence, phase: "live", records: [record] },
          recordBytes(record)
        )`,
        `  private persisted(id: SedimentreeId, records: SedimentreeRecord[]): void {
    if (this.closed || this.deleting.has(id) || !records.length) return
    const sequence = ++this.sequence
    const bytes = records.reduce((size, record) => size + recordBytes(record), 0)
    for (const [watch, tree] of this.watches)
      if (tree === id)
        watch.push({ type: "records", sequence, phase: "live", records }, bytes)`,
      ],
    ],
  );
  patch(
    "packages/automerge-repo/src/DocumentDelegate.ts",
    "25bb4f4bb9471ecd22ed59784b9f7055bc87e3163ccc2271f6ff28e14c2247f0",
    [
      [
        `        const next = applyRecords(this.document.doc, event.records)
        // Inbound representation must be known before listeners can make edits.
        this.#remember(next)
`,
        `        const heads = new Set(A.getHeads(this.document.doc))
        const next = applyRecords(this.document.doc, event.records)
        // Inbound representation must be known before listeners can make edits.
        // It is a function of the applied history, and the heads name that
        // history: records already held, or queued behind a missing
        // dependency, leave it unchanged and skip the whole-document rescan.
        const after = A.getHeads(next)
        if (after.length !== heads.size || after.some(head => !heads.has(head)))
          this.#remember(next)
`,
      ],
    ],
  );
  return changed;
}
