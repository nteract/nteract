import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Two changes for histories whose storage can persist a prefix of one write:
// 1. The bridge writes a native batch in causal order, so every persisted
//    prefix holds the parents of each record it holds.
// 2. Document readiness targets only checkpoint heads that the delivered
//    records can materialize. Stored history whose parents never became durable
//    cannot block a lookup forever; its changes stay queued in the document.
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
        `/** Private authoritative compound-record bridge; opt-in lossless reclamation only.`,
        `/** Order one native batch so that every prefix is causally closed.
 * Storage may persist a prefix of the sequential writes (a byte store that
 * splits batches, or a crash between saves). A record must not become durable
 * before the records in the same batch that hold its parents.
 *
 * Loose-commit parents are exact. A parent that is not a loose commit in the
 * batch is attributed to a fragment by head or checkpoint prefix. A parent that
 * neither identifies waits for every batch fragment, since only a fragment can
 * hold it. Fragment boundaries order fragments and commits beneath them. Ties
 * keep native order, with fragments first. Boundary metadata is not
 * authenticated: if conservative edges form a cycle they are dropped, and if
 * exact edges still cycle the batch keeps fragments-first native order.
 */
function causalOrder(values: Prepared[]): Prepared[] {
  const order = [
    ...values.filter(v => v.record.kind === "fragment"),
    ...values.filter(v => v.record.kind === "commit"),
  ]
  const commits = new Map<string, number>()
  const heads = new Map<string, number>()
  const checkpoints = new Map<string, number[]>()
  const fragments: number[] = []
  order.forEach((value, index) => {
    const record = value.record
    if (record.kind === "commit") commits.set(record.id, index)
    else {
      fragments.push(index)
      heads.set(record.head, index)
      for (const c of record.checkpoints) {
        const holders = checkpoints.get(c)
        if (holders) holders.push(index)
        else checkpoints.set(c, [index])
      }
    }
  })
  const holders = (commit: string): number[] | undefined => {
    const loose = commits.get(commit)
    if (loose !== undefined) return [loose]
    const head = heads.get(commit)
    if (head !== undefined) return [head]
    return checkpoints.get(commit.slice(0, 24))
  }
  const exact = order.map(() => new Set<number>())
  // Commits with a parent no metadata names wait behind one barrier node that
  // itself waits for every fragment, which keeps the edge count linear.
  const waitsForFragments = new Set<number>()
  order.forEach((value, index) => {
    const record = value.record
    const deps = record.kind === "commit" ? record.parents : record.boundary
    for (const dep of deps) {
      const found = holders(dep)
      if (found) found.forEach(h => h !== index && exact[index].add(h))
      else if (record.kind === "commit") waitsForFragments.add(index)
    }
  })
  // Kahn's algorithm. A min-heap of ready indices keeps native order, with
  // fragments first, among records that do not depend on each other.
  const sort = (barrier: boolean): Prepared[] | undefined => {
    const node = order.length
    const indegree = new Array<number>(node + 1).fill(0)
    const dependents: number[][] = Array.from({ length: node + 1 }, () => [])
    const edge = (from: number, to: number) => {
      dependents[from].push(to)
      indegree[to]++
    }
    exact.forEach((deps, index) => deps.forEach(dep => edge(dep, index)))
    if (barrier) {
      fragments.forEach(f => edge(f, node))
      waitsForFragments.forEach(index => edge(node, index))
    }
    const heap: number[] = []
    const push = (value: number) => {
      heap.push(value)
      for (let child = heap.length - 1; child > 0; ) {
        const parent = (child - 1) >> 1
        if (heap[parent] <= heap[child]) break
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
          if (left < heap.length && heap[left] < heap[least]) least = left
          if (left + 1 < heap.length && heap[left + 1] < heap[least]) least = left + 1
          if (least === parent) break
          ;[heap[parent], heap[least]] = [heap[least], heap[parent]]
          parent = least
        }
      }
      return top
    }
    indegree.forEach((count, index) => count === 0 && push(index))
    const result: Prepared[] = []
    let visited = 0
    while (heap.length) {
      const index = pop()
      visited++
      if (index < node) result.push(order[index])
      for (const next of dependents[index]) if (--indegree[next] === 0) push(next)
    }
    return visited === node + 1 ? result : undefined
  }
  return sort(true) ?? sort(false) ?? order
}

/** Private authoritative compound-record bridge; opt-in lossless reclamation only.`,
      ],
      [
        `      const copies = [
        ...commits.map(c =>
          this.prepareCommit(id, c.commitId, c.signedCommit, c.blob)
        ),
        ...fragments.map(f =>
          this.prepareFragment(id, f.fragmentHead, f.signedFragment, f.blob)
        ),
      ]`,
        `      const copies = causalOrder([
        ...commits.map(c =>
          this.prepareCommit(id, c.commitId, c.signedCommit, c.blob)
        ),
        ...fragments.map(f =>
          this.prepareFragment(id, f.fragmentHead, f.signedFragment, f.blob)
        ),
      ])`,
      ],
    ],
  );
  patch(
    "packages/automerge-repo/src/DocumentDelegate.ts",
    "9c529b2bd424837397ba735085a01992edf1ed46c2c61fca2d68bdc027159240",
    [
      [
        `      case "synchronized": {
        this.#checkpoint("sync", event.result.checkpoint)
        const { outcome, peers, checkpoint } = event.result
        if (
          this.query.snapshotPending &&
          this.#targets.size === 0 &&
          checkpoint.heads.length === 0 &&`,
        `      case "synchronized": {
        this.#checkpoint("sync", event.result.checkpoint)
        const { outcome, peers, checkpoint } = event.result
        if (
          this.query.snapshotPending &&
          this.#targets.size === 0 &&
          this.#reachable(checkpoint.heads).length === 0 &&`,
      ],
      [
        `    if (!this.#targets.has(source)) this.#targets.set(source, checkpoint)
    this.#checkTargets()
  }`,
        `    if (!this.#targets.has(source)) {
      // A checkpoint describes records this replica stores, and the backend
      // delivers every one of them before the checkpoint. A head missing now
      // depends on a change this replica does not hold, so waiting for it can
      // hang forever. Target the materialized heads instead; the unapplied
      // changes stay queued and apply if their dependencies arrive later.
      const heads = this.#reachable(checkpoint.heads)
      if (heads.length === 0) return
      if (heads.length < checkpoint.heads.length)
        try {
          this.document.log.error(
            \`\${source} history cannot materialize \${checkpoint.heads.length - heads.length} of \${checkpoint.heads.length} checkpoint heads\`
          )
        } catch {
          // Application logging must not interrupt durable observation.
        }
      this.#targets.set(source, { ...checkpoint, heads })
    }
    this.#checkTargets()
  }

  #reachable(heads: HistoryCheckpoint["heads"]) {
    return heads.filter(head => satisfiesCheckpoint(this.document.doc, [head]))
  }`,
      ],
    ],
  );
  return changed;
}
