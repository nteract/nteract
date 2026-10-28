import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// The bridge exclusively owns its byte-store namespace. Cache validated records
// and signed envelope bytes under its existing queue, constructing fresh native
// wrappers for each caller. Invalidate before deletes and after failed writes.
export function patchStorageIndex(root) {
  const path = "packages/automerge-repo-subduction/src/storage.ts";
  let source = readFileSync(`${root}/${path}`, "utf8");
  const before = createHash("sha256").update(source).digest("hex");
  if (before !== "00169b3a71473e01c00cd37298ffcf4bc2b7c8d6f8f7f8bcce90ada9c23d4029")
    throw new Error("Unexpected upstream storage bridge source hash");
  const replacements = [
    [
      `  | { kind: "commit"; signed: N.SignedLooseCommit; record: LooseCommitRecord }
  | { kind: "fragment"; signed: N.SignedFragment; record: FragmentRecord }
`,
      `  | { kind: "commit"; signed: N.SignedLooseCommit; record: LooseCommitRecord; encoded: Uint8Array }
  | { kind: "fragment"; signed: N.SignedFragment; record: FragmentRecord; encoded: Uint8Array }
`,
    ],
    [
      `  record: SedimentreeRecord
  frame: Uint8Array
`,
      `  record: SedimentreeRecord
  encoded: Uint8Array
  frame: Uint8Array
`,
    ],
    [
      `return { kind, signed, record: plainFragment(tree, key, signed, blob) }`,
      `return { kind, signed, record: plainFragment(tree, key, signed, blob), encoded }`,
    ],
    [
      `return { kind, signed, record: plain(id, key, signed, blob) }`,
      `return { kind, signed, record: plain(id, key, signed, blob), encoded }`,
    ],
    [
      `      record,
      frame: this.encode(tree, record, encoded),`,
      `      record,
      encoded,
      frame: this.encode(tree, record, encoded),`,
    ],
    [
      `  private async loadCommits(tree: string): Promise<N.CommitWithBlob[]> {
    const values = await this.snapshot(tree)`,
      `  private async loadCommits(tree: string): Promise<N.CommitWithBlob[]> {
    const values = await this.nativeRecords(tree, "commit")`,
    ],
    [
      `  private async loadFragments(tree: string): Promise<N.FragmentWithBlob[]> {
    const values = await this.snapshot(tree)`,
      `  private async loadFragments(tree: string): Promise<N.FragmentWithBlob[]> {
    const values = await this.nativeRecords(tree, "fragment")`,
    ],
    [
      `  private tail: Promise<void> = Promise.resolve()
`,
      `  private tail: Promise<void> = Promise.resolve()
  // LocalByteStore grants this bridge exclusive namespace ownership. Keep only
  // validated plain records and signed bytes, never native wrappers or frames.
  // All access uses this queue; native readers receive newly decoded wrappers.
  private readonly recordIndexes = new Map<string, {
    records: Map<string, { record: SedimentreeRecord; encoded: Uint8Array }>
    bytes: number
  }>()
`,
    ],
    [
      "    const work = this.tail.then(run)",
      `    const work = this.tail.then(run).catch(cause => {
      // A failed read may reveal corruption after an index was warmed.
      this.recordIndexes.clear()
      throw cause
    })`,
    ],
    [
      `    prepare: (tree: string) => () => Promise<T>
`,
      `    prepare: (tree: string) => () => Promise<T>,
    invalidate = false
`,
    ],
    [
      `    const sid = logicalId(id)
    let run:`,
      `    const sid = logicalId(id)
    const tree = treeHex(id)
    let run:`,
    ],
    ["      run = prepare(treeHex(id))", "      run = prepare(tree)"],
    [
      `    const work = this.enqueue(async () => {
      try {
        return await run()
      } catch (cause) {
        // A notification`,
      `    const work = this.enqueue(async () => {
      if (invalidate) this.recordIndexes.delete(tree)
      try {
        return await run()
      } catch (cause) {
        // A failed write/remove can already have reached storage. Recovery must
        // re-read its actual prefix before notifying or accepting another write.
        this.recordIndexes.delete(tree)
        // A notification`,
    ],
    [
      `  private async recordsFor(tree: string): Promise<SedimentreeRecord[]> {
    const values = await this.snapshot(tree)
    return values.map(v => {
      v.signed.free()
      return v.record
    })
  }
`,
      `  private async recordIndex(tree: string) {
    const cached = this.recordIndexes.get(tree)
    if (cached) return cached
    const values = await this.snapshot(tree)
    const records = new Map<string, { record: SedimentreeRecord; encoded: Uint8Array }>()
    let size = 0
    for (const value of values) {
      value.signed.free()
      const record = value.record
      const key = record.kind === "commit" ? record.id : record.head
      records.set(recordPath(tree, record.kind, key), { record, encoded: value.encoded })
      size += recordBytes(record)
    }
    const index = { records, bytes: size }
    this.recordIndexes.set(tree, index)
    return index
  }

  private async recordsFor(tree: string): Promise<SedimentreeRecord[]> {
    const index = await this.recordIndex(tree)
    // Preserve storage ordering and give every observer its own mutable bytes.
    return [...index.records.entries()]
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([, value]) => copyRecord(value.record))
  }

  private async nativeRecords(tree: string, kind: Kind): Promise<Stored[]> {
    const index = await this.recordIndex(tree)
    const values: Stored[] = []
    try {
      for (const [, { record, encoded }] of [...index.records.entries()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        if (record.kind !== kind) continue
        // These bytes were validated together on load or before a resolved save.
        // Native constructors consume their wrappers, so never share one.
        values.push(record.kind === "commit"
          ? { kind: "commit", signed: N.SignedLooseCommit.tryDecode(encoded), record, encoded }
          : { kind: "fragment", signed: N.SignedFragment.tryDecode(encoded), record, encoded })
      }
      return values
    } catch (error) {
      values.forEach(value => value.signed.free())
      throw error
    }
  }
`,
    ],
    [
      `    const values = await this.snapshot(tree)
    let old: SedimentreeRecord | undefined
    let size = recordBytes(record)
    for (const v of values) {
      v.signed.free()
      size += recordBytes(v.record)
      if (
        v.kind === record.kind &&
        (v.record.kind === "commit" ? v.record.id : v.record.head) === key
      )
        old = v.record
    }
`,
      `    const index = await this.recordIndex(tree)
    const path = recordPath(tree, record.kind, key)
    const old = index.records.get(path)?.record
    const size = index.bytes + recordBytes(record)
`,
    ],
    [
      "    if (values.length + 1 > this.limits.maxRecords)",
      "    if (index.records.size + 1 > this.limits.maxRecords)",
    ],
    [
      `    await this.storage.save(recordPath(tree, record.kind, key), frame)
    // Only resolved saves`,
      `    await this.storage.save(path, frame)
    index.records.set(path, { record: copyRecord(record), encoded: value.encoded })
    index.bytes = size
    // Only resolved saves`,
    ],
    [
      `      tree => () => this.storage.remove(\`\${prefix(tree)}id\`)
`,
      `      tree => () => this.storage.remove(\`\${prefix(tree)}id\`),
      true
`,
    ],
    [
      `      return () => this.storage.remove(path)
    })`,
      `      return () => this.storage.remove(path)
    }, true)`,
    ],
    [
      `      tree => () => this.removeKeys(\`\${prefix(tree)}commits/\`)
`,
      `      tree => () => this.removeKeys(\`\${prefix(tree)}commits/\`),
      true
`,
    ],
    [
      `      tree => () => this.removeKeys(\`\${prefix(tree)}fragments/\`)
`,
      `      tree => () => this.removeKeys(\`\${prefix(tree)}fragments/\`),
      true
`,
    ],
    [
      "return this.mutate(id, tree => () => this.removeKeys(prefix(tree)))",
      "return this.mutate(id, tree => () => this.removeKeys(prefix(tree)), true)",
    ],
  ];
  for (const [needle, replacement] of replacements) {
    const expected = needle.includes("this.storage.remove(path)") ? 2 : 1;
    if (source.split(needle).length !== expected + 1)
      throw new Error("Storage index patch mismatch");
    source = source.replaceAll(needle, replacement);
  }
  writeFileSync(`${root}/${path}`, source);
  const after = createHash("sha256").update(source).digest("hex");
  return { path, before, after };
}
