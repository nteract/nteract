// Called after the pinned backend source hash is verified by patch-upstream.
// Snapshot admission is separate from ordinary store/replay batch limits.
export function patchSnapshotStore(source) {
  const replacements = [
    [
      `  private storeRecords(
    input: SedimentreeId,
    batch: RecordBatch,
    creating = false
`,
      `  /** Import a bounded local checkpoint, including into an existing tree.
   * The complete union is checked before one native operation. Failure may
   * persist a prefix; callers must await success before opening the document
   * and may retry the same snapshot. Ordinary store/replay limits are unchanged.
   */
  storeSnapshot(input: SedimentreeId, records: RecordBatch): Promise<void> {
    return this.storeRecords(input, records, false, true)
  }
  private storeRecords(
    input: SedimentreeId,
    batch: RecordBatch,
    creating = false,
    snapshot = false
`,
    ],
    [
      `          records.length > this.limits.batchRecords ||`,
      `          records.length > (snapshot ? this.limits.maxRecords : this.limits.batchRecords) ||`,
    ],
  ];
  for (const [needle, replacement] of replacements) {
    if (source.split(needle).length !== 2) throw new Error(`Snapshot patch mismatch: ${needle}`);
    source = source.replace(needle, replacement);
  }
  return source;
}
