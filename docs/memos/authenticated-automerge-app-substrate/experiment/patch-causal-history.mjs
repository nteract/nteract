import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Two changes for histories whose storage can persist a prefix of one flush:
// 1. Readiness is the guarantee. A lookup over a complete local snapshot whose
//    checkpoint names changes that cannot materialize becomes ready on the
//    document's materialized frontier, or unavailable when nothing applied.
// 2. Ordering is best effort but correct. The bridge orders a native batch by
//    the changes each record actually holds and needs, decoded from fragment
//    bundles, and writes records that depend on each other through one atomic
//    multi-key save when the byte store offers it.
// The TypeScript below is embedded in this module so the setup fingerprint
// covers it; it uses no template literals.

const causalGroups = `/** Order one native batch so that every persisted prefix is causally closed.
 * Storage may persist a prefix of the sequential writes (a byte store that
 * splits a flush into batches, or a crash between saves). A record must not
 * become durable before the batch records that hold the changes it needs.
 *
 * A loose commit holds its own change and needs its parents. A fragment holds
 * every change in its bundle and needs the bundle's external dependencies,
 * decoded from the payload: sedimentree boundaries are not a dependency set.
 * A need held by no batch record is already stored or missing, so it adds no
 * edge. Each need is attributed to one holder, preferring a loose commit.
 * Records in one strongly connected component cannot be ordered and form one
 * group, which the caller writes atomically. Groups keep native order,
 * fragments first, where dependencies allow. An undecodable fragment falls
 * back to its metadata: it holds its head and needs its boundary.
 */
function causalGroups(values: Prepared[]): Prepared[][] {
  const order = [
    ...values.filter(v => v.record.kind === "fragment"),
    ...values.filter(v => v.record.kind === "commit"),
  ]
  const n = order.length
  if (n < 2) return order.map(v => [v])
  const holds: string[][] = []
  const needs: string[][] = []
  for (const { record } of order) {
    if (record.kind === "commit") {
      holds.push([record.id])
      needs.push([...record.parents])
      continue
    }
    try {
      const changes = A.readBundle(record.blob).changes
      const members = new Set(changes.map(change => change.hash))
      const external = new Set<string>()
      for (const change of changes)
        for (const dep of change.deps) if (!members.has(dep)) external.add(dep)
      holds.push([...members])
      needs.push([...external])
    } catch {
      holds.push([record.head])
      needs.push([...record.boundary])
    }
  }
  const holder = new Map<string, number>()
  order.forEach((value, index) => {
    if (value.record.kind === "commit") holder.set(value.record.id, index)
  })
  order.forEach((value, index) => {
    if (value.record.kind !== "fragment") return
    for (const hash of holds[index]) {
      const current = holder.get(hash)
      if (current === undefined || (order[current].record.kind === "fragment" && holds[current].length > holds[index].length))
        holder.set(hash, index)
    }
  })
  const out: number[][] = order.map(() => [])
  order.forEach((_, index) => {
    const seen = new Set<number>()
    for (const need of needs[index]) {
      const from = holder.get(need)
      if (from !== undefined && from !== index && !seen.has(from)) {
        seen.add(from)
        out[from].push(index)
      }
    }
  })
  // Iterative Tarjan: native batches can hold thousands of records.
  const visit = new Array<number>(n).fill(-1)
  const low = new Array<number>(n).fill(0)
  const onStack = new Array<boolean>(n).fill(false)
  const component = new Array<number>(n).fill(-1)
  const stack: number[] = []
  let counter = 0
  let components = 0
  for (let root = 0; root < n; root++) {
    if (visit[root] !== -1) continue
    const work: number[][] = [[root, 0]]
    while (work.length) {
      const frame = work[work.length - 1]
      const v = frame[0]
      if (frame[1] === 0 && visit[v] === -1) {
        visit[v] = low[v] = counter++
        stack.push(v)
        onStack[v] = true
      }
      if (frame[1] < out[v].length) {
        const w = out[v][frame[1]++]
        if (visit[w] === -1) work.push([w, 0])
        else if (onStack[w]) low[v] = Math.min(low[v], visit[w])
        continue
      }
      work.pop()
      if (work.length) {
        const parent = work[work.length - 1][0]
        low[parent] = Math.min(low[parent], low[v])
      }
      if (low[v] === visit[v]) {
        for (;;) {
          const w = stack.pop()!
          onStack[w] = false
          component[w] = components
          if (w === v) break
        }
        components++
      }
    }
  }
  const members: number[][] = Array.from({ length: components }, () => [])
  order.forEach((_, index) => members[component[index]].push(index))
  const indegree = new Array<number>(components).fill(0)
  const next: number[][] = Array.from({ length: components }, () => [])
  out.forEach((targets, from) => {
    for (const to of targets)
      if (component[from] !== component[to]) {
        next[component[from]].push(component[to])
        indegree[component[to]]++
      }
  })
  // Kahn's algorithm; a min-heap on each component's first index keeps native
  // order among independent groups.
  const first = members.map(list => list[0])
  const heap: number[] = []
  const less = (a: number, b: number) => first[a] < first[b]
  const push = (value: number) => {
    heap.push(value)
    for (let child = heap.length - 1; child > 0; ) {
      const parent = (child - 1) >> 1
      if (!less(heap[child], heap[parent])) break
      ;[heap[parent], heap[child]] = [heap[child], heap[parent]]
      child = parent
    }
  }
  const pop = (): number => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      for (let parent = 0; ; ) {
        const left = 2 * parent + 1
        let least = parent
        if (left < heap.length && less(heap[left], heap[least])) least = left
        if (left + 1 < heap.length && less(heap[left + 1], heap[least])) least = left + 1
        if (least === parent) break
        ;[heap[parent], heap[least]] = [heap[least], heap[parent]]
        parent = least
      }
    }
    return top
  }
  indegree.forEach((count, c) => count === 0 && push(c))
  const groups: Prepared[][] = []
  while (heap.length) {
    const c = pop()
    groups.push(members[c].map(index => order[index]))
    for (const to of next[c]) if (--indegree[to] === 0) push(to)
  }
  return groups
}

`;

const saveGroup = `  /** One causal group that cannot be ordered: write it through a single
   * atomic multi-key save when the byte store offers one. Otherwise its saves
   * stay sequential, and lookup readiness covers an interrupted prefix.
   */
  private async savePreparedGroup(values: Prepared[]): Promise<void> {
    if (values.length === 1 || !this.storage.saveMany) {
      for (const value of values) await this.savePrepared(value)
      return
    }
    const { tree, sid } = values[0]
    const index = await this.recordIndex(tree)
    const fresh: Prepared[] = []
    for (const value of values) {
      const old = index.records.get(recordPath(tree, value.record.kind, value.key))?.record
      if (!old) fresh.push(value)
      else if (!equalRecords(old, value.record))
        throw new BackendError(
          "store",
          "conflict",
          "Different representation for an existing " + value.record.kind + " key"
        )
      else this.saved(sid, value.record)
    }
    if (fresh.length < 2) {
      for (const value of fresh) await this.savePrepared(value)
      return
    }
    const size = fresh.reduce((n, value) => n + recordBytes(value.record), index.bytes)
    if (this.reservations.get(tree)?.size)
      await this.reservedUnion(tree, fresh.map(value => value.record))
    else {
      if (index.records.size + fresh.length > this.limits.maxRecords)
        throw new HistoryCapacityError("Document history record count limit exceeded")
      if (size > this.limits.maxSnapshotBytes)
        throw new HistoryCapacityError("Document history byte limit exceeded")
    }
    await this.storage.saveMany(
      fresh.map(value => [recordPath(tree, value.record.kind, value.key), value.frame] as [string, Uint8Array])
    )
    for (const value of fresh)
      index.records.set(recordPath(tree, value.record.kind, value.key), {
        record: copyRecord(value.record),
        encoded: value.encoded,
      })
    index.bytes = size
    for (const value of fresh) this.saved(sid, value.record)
  }

`;

export function patchCausalHistory(root) {
  const changed = [];
  function patch(path, expected, replacements) {
    let source = readFileSync(`${root}/${path}`, "utf8");
    const before = createHash("sha256").update(source).digest("hex");
    if (before !== expected) throw Error(`Unexpected causal history source hash: ${path}`);
    for (const [needle, replacement] of replacements) {
      if (source.split(needle).length !== 2)
        throw Error(`Causal history patch mismatch: ${needle}`);
      source = source.replace(needle, replacement);
    }
    writeFileSync(`${root}/${path}`, source);
    changed.push({ path, before, after: createHash("sha256").update(source).digest("hex") });
  }
  patch(
    "packages/automerge-repo-subduction/src/storage.ts",
    "070bf534188442d664b7e5066d9a4490fa8c998b257d7a700909059bd9b9a951",
    [
      [
        `import * as N from "@automerge/subduction/slim"\n`,
        `import * as N from "@automerge/subduction/slim"\nimport * as A from "@automerge/automerge/slim"\n`,
      ],
      [
        `  list(prefix: string): Promise<string[]>
}`,
        `  list(prefix: string): Promise<string[]>
  /** Optional: persist every entry or none of them, as one write. The bridge
   * uses it for records that depend on each other and cannot be ordered. */
  saveMany?(entries: [string, Uint8Array][]): Promise<void>
}`,
      ],
      [
        `/** Private authoritative compound-record bridge; opt-in lossless reclamation only.`,
        `${causalGroups}/** Private authoritative compound-record bridge; opt-in lossless reclamation only.`,
      ],
      [`  async saveCommit(\n`, `${saveGroup}  async saveCommit(\n`],
      [
        `        for (const value of copies) await this.savePrepared(value)
        return copies.length`,
        `        for (const group of causalGroups(copies)) await this.savePreparedGroup(group)
        return copies.length`,
      ],
    ],
  );
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
  return changed;
}
