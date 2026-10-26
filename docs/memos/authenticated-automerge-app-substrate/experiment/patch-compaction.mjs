import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Local, opt-in reclamation of redundant representations. This does not prune
// Automerge changes, replace a document, or infer coverage from native metadata.
const helper = String.raw`import * as A from "@automerge/automerge/slim"
import { validateRecord } from "@automerge/automerge-repo/sedimentree/automerge"
import { equalRecords, recordKey, type CommitId, type SedimentreeRecord } from "@automerge/automerge-repo/sedimentree"

export interface CompactionOptions {
  /** Must acknowledge all preceding byte-store saves/removes durably. Called
   * outside the native storage writer. Never call backend/repo.flush: the
   * owner queue is held to preserve exact local store acknowledgments.
   * Buffered Pages supplies recordStore.flush; direct DO supplies storage.sync.
   */
  durable: () => Promise<void>
}
export interface CompactionResult {
  beforeRecords: number
  afterRecords: number
  removedRecords: number
  removedBytes: number
  skipped?: "reservations"
}

function changeHashes(record: SedimentreeRecord): Set<string> {
  const checked = validateRecord(record)
  const changes = checked.kind === "commit"
    ? [A.decodeChange(checked.blob)]
    : A.readBundle(checked.blob).changes
  const hashes = new Set<string>()
  for (const change of changes) {
    // Recompute identity from complete operations/actor/dependencies, rather
    // than trusting the declared fragment head, boundaries or checkpoints.
    // Unsupported future encodings fail closed before any record is removed.
    if (A.decodeChange(A.encodeChange(change)).hash !== change.hash)
      throw new Error("Cannot authenticate a bundled change identity")
    hashes.add(change.hash)
  }
  if (!hashes.size || hashes.size !== changes.length)
    throw new Error("Invalid fragment change coverage")
  return hashes
}

/** A record is reclaimable only when the native minimized tree omitted it AND
 * one retained fragment contains every original Automerge change. Do not use a
 * union of partial fragments or metadata-only native coverage as the proof.
 * The captured snapshot prevents concurrent ingress from becoming a target.
 */
export function reclaimableRecords(
  current: readonly SedimentreeRecord[],
  captured: readonly SedimentreeRecord[],
  keep: ReadonlySet<string>
): SedimentreeRecord[] {
  const present = new Map(current.map(record => [recordKey(record), record]))
  const retained = current.filter(record => record.kind === "fragment" && keep.has(recordKey(record)))
  if (!retained.length) return []
  const coverage = retained.map(changeHashes)
  const remove: SedimentreeRecord[] = []
  for (const original of captured) {
    const key = recordKey(original)
    if (keep.has(key)) continue
    const record = present.get(key)
    if (!record || !equalRecords(original, record)) continue
    const members = changeHashes(record)
    if (coverage.some(hashes => [...members].every(hash => hashes.has(hash))))
      remove.push(record)
  }
  // Delete ancestors before descendants. Native minimization infers ranges by
  // walking backward from fragment-boundary heads through loose parent links.
  // Removing a range head first can strand redundant interior commits after a
  // crash (safe history, but no further native reclamation candidates).
  const commits = remove.filter(record => record.kind === "commit")
  const byId = new Map(commits.map(record => [record.id, record]))
  const waiting = new Map<CommitId, number>()
  const children = new Map<CommitId, CommitId[]>()
  for (const record of commits) {
    const parents = record.parents.filter(parent => byId.has(parent))
    waiting.set(record.id, parents.length)
    for (const parent of parents) children.set(parent, [...(children.get(parent) ?? []), record.id])
  }
  const ready = commits.filter(record => waiting.get(record.id) === 0)
  const ordered: SedimentreeRecord[] = []
  for (let next = 0; next < ready.length; next++) {
    const record = ready[next]
    ordered.push(record)
    for (const child of children.get(record.id) ?? []) {
      const remaining = waiting.get(child)! - 1
      waiting.set(child, remaining)
      if (!remaining) ready.push(byId.get(child)!)
    }
  }
  if (ordered.length !== commits.length) throw new Error("Cyclic compaction proof")
  return [...ordered, ...remove.filter(record => record.kind === "fragment")]
}
`;

export function patchCompaction(root) {
  const changed = [];
  function patch(path, replacements) {
    let source = readFileSync(`${root}/${path}`, "utf8");
    const before = createHash("sha256").update(source).digest("hex");
    const expected = {
      "packages/automerge-repo-subduction/src/storage.ts":
        "5e39c87bd46818ea836e9e6fd64ef61bc43ac038ced2741d07bcccf1ee1a1b79",
      "packages/automerge-repo-subduction/src/index.ts":
        "84077f9440ca9a3d90000596e1da9dea0ac6cd6912c84f9c5f99bb60a798a312",
    };
    if (before !== expected[path]) throw Error(`Unexpected compaction source hash: ${path}`);
    for (const [needle, replacement] of replacements) {
      if (source.split(needle).length !== 2) throw Error(`Compaction patch mismatch: ${needle}`);
      source = source.replace(needle, replacement);
    }
    writeFileSync(`${root}/${path}`, source);
    changed.push({ path, before, after: createHash("sha256").update(source).digest("hex") });
  }
  const helperPath = "packages/automerge-repo-subduction/src/compaction.ts";
  writeFileSync(`${root}/${helperPath}`, helper);
  changed.push({ path: helperPath, after: createHash("sha256").update(helper).digest("hex") });
  patch("packages/automerge-repo-subduction/src/storage.ts", [
    [
      'import * as N from "@automerge/subduction/slim"',
      'import * as N from "@automerge/subduction/slim"\nimport { reclaimableRecords, type CompactionResult } from "./compaction.js"',
    ],
    [
      "/** Private authoritative compound-record bridge; never compacts history.",
      "/** Private authoritative compound-record bridge; opt-in lossless reclamation only.",
    ],
    [
      `  /** Preparation is synchronous and precedes queue reservation. Only owned JS`,
      `  /** All retained fragment envelopes came through verified native ingress (or
   * local signing) and remain byte-for-byte intact. Storage decoding checks their
   * envelope checksum and signed tree/metadata/blob binding, not new authority.
   * Native minimum is only a candidate filter; decoded change coverage is the
   * deletion proof. The durable callback must not call back into this bridge.
   */
  async compact(id: N.SedimentreeId, captured: readonly SedimentreeRecord[], keep: readonly string[], durable: () => Promise<void>): Promise<CompactionResult> {
    const snapshot = captured.map(copyRecord)
    const retained = new Set(keep)
    const tree = treeHex(id)
    const base = (count: number): CompactionResult => ({ beforeRecords: count, afterRecords: count, removedRecords: 0, removedBytes: 0 })
    const prepared = await this.enqueue(async () => {
      const index = await this.recordIndex(tree)
      const current = [...index.records.values()].map(value => value.record)
      if (this.reservations.get(tree)?.size)
        return { result: { ...base(index.records.size), skipped: "reservations" as const } }
      const remove = reclaimableRecords(current, snapshot, retained).map(copyRecord)
      if (!remove.length) return { result: base(index.records.size) }
      const fragments = current.filter(record => record.kind === "fragment" && retained.has("fragment:" + record.head)).map(copyRecord)
      return { remove, fragments }
    })
    if (prepared.result) return prepared.result
    // save() may mean RAM acceptance only. Freeze the complete proof BEFORE
    // this barrier. Native writes may continue while the remote sink is slow.
    await durable()
    const result = await this.mutate(id, () => async () => {
      const index = await this.recordIndex(tree)
      if (this.reservations.get(tree)?.size)
        return { ...base(index.records.size), skipped: "reservations" as const }
      const remove = prepared.remove!
      for (const original of [...prepared.fragments!, ...remove]) {
        const path = recordPath(tree, original.kind, original.kind === "commit" ? original.id : original.head)
        const current = index.records.get(path)?.record
        if (!current || !equalRecords(original, current))
          throw new Error("Compaction proof changed during durability barrier")
      }
      const beforeRecords = index.records.size
      let removedBytes = 0
      for (const record of remove) {
        const path = recordPath(tree, record.kind, record.kind === "commit" ? record.id : record.head)
        await this.storage.remove(path)
        index.records.delete(path)
        const size = recordBytes(record)
        index.bytes -= size
        removedBytes += size
      }
      // Every interrupted deletion prefix is safe: the frozen fragments were
      // durable before the first remove. mutate invalidates on remove failure.
      return { beforeRecords, afterRecords: index.records.size, removedRecords: remove.length, removedBytes }
    })
    // Native ingress remains independent of this remote deletion acknowledgment.
    if (result.removedRecords) await durable()
    return result
  }

  /** Preparation is synchronous and precedes queue reservation. Only owned JS`,
    ],
  ]);
  patch("packages/automerge-repo-subduction/src/index.ts", [
    [
      'import * as N from "@automerge/subduction/slim"',
      'import * as N from "@automerge/subduction/slim"\nimport type { CompactionOptions, CompactionResult } from "./compaction.js"',
    ],
    [
      'export type { LocalByteStore } from "./storage.js"',
      'export type { LocalByteStore } from "./storage.js"\nexport type { CompactionOptions, CompactionResult } from "./compaction.js"',
    ],
    [
      `  store(input: SedimentreeId, batch: RecordBatch): Promise<void> {`,
      `  /** Reclaim already-covered representations without discarding CRDT history.
   * Explicitly opt-in: callers supply the real byte-store durability barrier.
   * The owner queue preserves exact local store acknowledgments; the bridge
   * writer serializes this with native ingress and intent reservations.
   */
  compact(input: SedimentreeId, options: CompactionOptions): Promise<CompactionResult> {
    if (typeof options?.durable !== "function")
      return Promise.reject(new TypeError("Compaction requires a durability barrier"))
    const id = sedimentreeId(input)
    this.check("store", id)
    return this.enqueue("store", async () => {
      this.check("store", id)
      const native = nativeId(id)
      try {
        const captured = await this.bridge.records(native)
        let commits: N.LooseCommit[] | undefined
        let fragments: N.Fragment[] | undefined
        const keep: string[] = []
        try {
          commits = await this.engine.getCommits(native)
          fragments = await this.engine.getFragments(native)
          if (!commits || !fragments)
            throw new Error("Native tree unavailable for compaction")
          for (const commit of commits) {
            const key = commit.commitId
            try { keep.push("commit:" + key.toHexString()) }
            finally { key.free() }
          }
          for (const fragment of fragments) {
            const key = fragment.head
            try { keep.push("fragment:" + key.toHexString()) }
            finally { key.free() }
          }
        } finally {
          commits?.forEach(commit => commit.free())
          fragments?.forEach(fragment => fragment.free())
        }
        return await this.bridge.compact(native, captured, keep, options.durable)
      } finally { native.free() }
    })
  }
  store(input: SedimentreeId, batch: RecordBatch): Promise<void> {`,
    ],
  ]);
  return changed;
}
