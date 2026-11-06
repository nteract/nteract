import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Two source-hash-checked changes to the pinned Repo 3 DocumentDelegate, for
// a backend whose stored history may lack a change its checkpoint names:
// 1. Readiness is the guarantee. A lookup over a complete local snapshot whose
//    checkpoint names changes that cannot materialize becomes ready on the
//    document's materialized frontier, or unavailable when nothing applied.
// 2. An incoming batch rescans the document's record metadata only when it
//    moved the heads. The covering representation is a function of the
//    applied history and the heads name that history, so records the replica
//    already holds, or that wait on a missing dependency, cannot change it.
// The TypeScript below uses no template literals.

export function patchDocumentDelegate(root) {
  const changed = [];
  function patch(path, expected, replacements) {
    let source = readFileSync(`${root}/${path}`, "utf8");
    const before = createHash("sha256").update(source).digest("hex");
    if (before !== expected) throw Error(`Unexpected DocumentDelegate source hash: ${path}`);
    for (const [needle, replacement] of replacements) {
      if (source.split(needle).length !== 2)
        throw Error(`DocumentDelegate patch mismatch: ${needle}`);
      source = source.replace(needle, replacement);
    }
    writeFileSync(`${root}/${path}`, source);
    changed.push({ path, before, after: createHash("sha256").update(source).digest("hex") });
  }
  patch(
    "packages/automerge-repo/src/DocumentDelegate.ts",
    "9c529b2bd424837397ba735085a01992edf1ed46c2c61fca2d68bdc027159240",
    [
      [
        `      case "local-load-complete":
        this.#checkpoint("local", event.checkpoint)`,
        `      case "local-load-complete":
        this.#checkpoint("local", this.#buildable(event.checkpoint))`,
      ],
      [
        `          this.#targets.size === 0 &&
          checkpoint.heads.length === 0 &&`,
        `          // Nothing applied and no source can supply more. A target whose
          // heads cannot materialize does not keep the lookup loading.
          !checkpoint.heads.some(head =>
            satisfiesCheckpoint(this.document.doc, [head])
          ) &&`,
      ],
      [
        `  #checkTargets(): void {`,
        `  /** The local snapshot is complete when local-load-complete arrives: its
   * records were all applied first. A checkpoint head that has not
   * materialized needs a change this replica does not store, and waiting for
   * it hangs. Become ready on the materialized frontier instead (empty when
   * nothing applied, which leaves availability to the other sources). The
   * unapplied changes stay queued and apply if a later source supplies their
   * dependencies. Network checkpoints keep upstream semantics.
   */
  #buildable(checkpoint: HistoryCheckpoint): HistoryCheckpoint {
    if (
      checkpoint.heads.length === 0 ||
      satisfiesCheckpoint(this.document.doc, checkpoint.heads)
    )
      return checkpoint
    const heads = A.getHeads(this.document.doc) as unknown as HistoryCheckpoint["heads"]
    try {
      this.document.log.error(
        "local history is incomplete: " +
          checkpoint.heads.filter(head => !satisfiesCheckpoint(this.document.doc, [head])).length +
          " checkpoint heads cannot materialize; " +
          (heads.length ? "ready at " + heads.length + " materialized heads" : "nothing materialized")
      )
    } catch {
      // Application logging must not interrupt durable observation.
    }
    return { ...checkpoint, heads }
  }

  #checkTargets(): void {`,
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
